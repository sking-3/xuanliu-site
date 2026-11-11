"""One durable successor per successful public observation, without run inventory."""
import copy
import hashlib
import json
import re
import time
import urllib.error
import urllib.request
import uuid
import monitor

ENDPOINT = 'https://api.github.com/repos/sking-3/xuanliu-site/actions/workflows/binance-public-orders.yml/dispatches'


def require(value, reason):
    if not value:
        raise monitor.Stop(reason)


def admit(state, event, run_id, ticket):
    require(isinstance(run_id, str) and re.fullmatch('[A-Za-z0-9_-]{1,80}', run_id), 'invalid_chain_run')
    chain = state.get('continuation')
    if chain is None:
        require(event in ('push', 'workflow_dispatch') and not ticket, 'invalid_chain_bootstrap')
        state['continuation'] = {'rootRunId': run_id, 'ownerRunId': run_id,
                                 'parentRunId': None, 'ticket': None, 'phase': None, 'stopped': False}
        return
    require(isinstance(chain, dict) and chain.get('stopped') is False, 'continuation_requires_review')
    if event == 'push':
        raise monitor.Stop('continuation_already_active')
    require(event == 'workflow_dispatch' and isinstance(ticket, str) and
            re.fullmatch('[a-f0-9]{32}', ticket) and ticket == chain.get('ticket') and
            chain.get('phase') == 'attempt_reserved', 'invalid_continuation_ticket')
    parent = chain.get('ownerRunId')
    require(isinstance(parent, str) and parent != run_id, 'invalid_chain_parent')
    chain.update(ownerRunId=run_id, parentRunId=parent, ticket=None, phase=None,
                 consumedAt=monitor.iso(time.time()))


def send(ticket, token):
    payload = json.dumps({'ref': 'main', 'inputs': {'continuation_ticket': ticket}}).encode()
    request = urllib.request.Request(ENDPOINT, method='POST', data=payload, headers={
        'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json', 'User-Agent': 'BooksReadOnlyMonitor/1.0',
        'X-GitHub-Api-Version': '2022-11-28'})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), monitor.NoRedirect())
    try:
        with opener.open(request, timeout=8) as response:
            return {'httpStatus': response.status, 'receivedAt': monitor.iso(time.time())}
    except urllib.error.HTTPError as error:
        raw = error.read(65536)
        result = {'httpStatus': error.code, 'receivedAt': monitor.iso(time.time()),
                  'responseSha256': hashlib.sha256(raw).hexdigest(), 'responseBytes': len(raw)}
        error.close()
        return result
    except (urllib.error.URLError, TimeoutError, OSError):
        return {'httpStatus': None, 'receivedAt': monitor.iso(time.time()), 'error': 'dispatch_outcome_unknown'}


def dispatch_next(store, result, token, sender=send):
    state = copy.deepcopy(store.state)
    chain = state.get('continuation')
    require(not state['stopped'] and state['activeRun'] is None and
            isinstance(chain, dict) and chain.get('stopped') is False and
            chain.get('ownerRunId') == result['runId'] and chain.get('ticket') is None and
            state['lastRun']['runId'] == result['runId'] and
            result['checkpointSealed'] is True and result['errorCode'] is None and
            result['sourceRequests'] > 0, 'continuation_not_safe')
    ticket = uuid.uuid4().hex  # Public deduplication marker, not a credential.
    chain.update(ticket=ticket, phase='attempt_reserved', requestedAt=monitor.iso(time.time()))
    store.save(state)  # CAS reserves the only attempt before the POST.
    outcome = sender(ticket, token)  # Exactly one request; never retry a refusal.
    if outcome.get('httpStatus') == 204:
        # No post-dispatch write can race the successor's claim. Its admission
        # proves consumption in the next activeRun/checkpoint instead.
        return {'status': 'accepted', **outcome}
    chain.update(stopped=True, errorCode='dispatch_http_' + str(outcome.get('httpStatus')),
                 errorEvidence=outcome)
    try:
        store.save(state)
    except (monitor.Stop, RuntimeError):
        # A successor may already have consumed an uncertain successful POST.
        # Do not overwrite its claim or try a second endpoint/credential.
        return {'status': 'uncertain_claim_preserved', **outcome}
    return {'status': 'stopped', **outcome}
