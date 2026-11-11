"""Observe only anonymous public execution records. Never request current positions."""
import argparse
import base64
import copy
import datetime as dt
from decimal import Decimal, InvalidOperation
import hashlib
import json
import math
import os
from pathlib import Path
import re
import signal
import sys
import time
import urllib.error
import urllib.request
import fcntl
import monitor
import source_holds

PORTFOLIO = monitor.PORTFOLIO_ID
ENDPOINT = monitor.BASE + 'lead-portfolio/order-history'
REPOSITORY = 'sking-3/xuanliu-site'
STATE_BRANCH = 'binance-public-orders-state'
STATE_PATH = 'monitor-state/5075281354358777856.json'
MAX_BYTES = 900000
MAX_RECORDS = 500
MAX_EVENTS = 200
MAX_PAGES = 10
INTERVAL = 5
ROOT = Path(__file__).resolve().parents[2]


class Halt(RuntimeError):
    pass


class BudgetEnd(Exception):
    pass


def require(value, code):
    if not value:
        raise Halt(code)


def stamp(value):
    try:
        return monitor.timestamp(value)
    except monitor.Stop:
        raise Halt('invalid_state_time') from None


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()).hexdigest()


def initial_state():
    return {'schemaVersion': 1, 'scope': 'public_execution_records_only', 'portfolioId': PORTFOLIO,
            'initialized': False, 'activeRun': None, 'stopped': False, 'errorCode': None,
            'lastSuccessAt': None, 'lastAttemptAt': None, 'records': {}, 'events': [],
            'lastCoverage': None, 'lastRun': None, 'hiddenPositionsRequested': False}


def validate_state(state):
    require(isinstance(state, dict) and state.get('schemaVersion') == 1 and
            state.get('scope') == 'public_execution_records_only' and state.get('portfolioId') == PORTFOLIO,
            'checkpoint_identity_mismatch')
    require(type(state.get('initialized')) is bool and type(state.get('stopped')) is bool and
            state.get('hiddenPositionsRequested') is False and
            (state.get('activeRun') is None or isinstance(state.get('activeRun'), dict)), 'invalid_checkpoint')
    require(isinstance(state.get('records'), dict) and len(state['records']) <= MAX_RECORDS and
            isinstance(state.get('events'), list) and len(state['events']) <= MAX_EVENTS, 'invalid_checkpoint')
    for key, row in state['records'].items():
        require(isinstance(row, dict) and re.fullmatch('[a-f0-9]{64}', row.get('fingerprint', '')) and
                re.fullmatch('[a-f0-9]{64}', row.get('identity', '')), 'invalid_checkpoint_record')
        require(key == row['fingerprint'] and type(row.get('orderTime')) is int and
                type(row.get('orderUpdateTime')) is int and 0 < row['orderTime'] <= row['orderUpdateTime'], 'invalid_checkpoint_record')
        core_keys = ('symbol', 'baseAsset', 'quoteAsset', 'side', 'positionSide', 'type', 'orderTime',
                     'orderUpdateTime', 'executedQty', 'avgPrice', 'totalPnl', 'sourceOrderId', 'identity')
        require(all(k in row for k in core_keys) and digest({k: row[k] for k in core_keys}) == row['fingerprint'], 'checkpoint_fingerprint_mismatch')
        stamp(row.get('firstSeenAt'))
    for field in ('lastSuccessAt', 'lastAttemptAt'):
        if state.get(field) is not None:
            stamp(state[field])
    require(state.get('errorCode') is None or isinstance(state['errorCode'], str) and
            re.fullmatch('[a-zA-Z0-9_]{1,80}', state['errorCode']), 'invalid_checkpoint')
    require(len(json.dumps(state).encode()) <= MAX_BYTES, 'checkpoint_too_large')
    return state


def policy():
    require(source_holds.reason('binanceOrders' + PORTFOLIO) is None, 'public_orders_not_approved')
    # Position privacy does not govern independently public execution records.
    # Source-wide refusals in the old collector still stop this observer.
    global_hold = source_holds.reason('binancePublicCollector')
    require(global_hold in (None, 'paused_pending_permission_and_frequency'), 'source_wide_stop')
    try:
        monitor.check_repository(ROOT / 'trader/binance/portfolios.json')
    except monitor.Stop:
        raise Halt('legacy_source_stop') from None


class PublicSource:
    def __init__(self, clock=time.monotonic, wall=time.time, sleep=time.sleep):
        self.clock, self.wall, self.sleep = clock, wall, sleep
        self.opener = monitor.Transport(timeout=8).opener
        self.last_start = None
        self.calls = []
        self.deadline = math.inf

    def page(self, start, end, cursor=None):
        policy()
        wait = max(0, INTERVAL - (self.clock() - self.last_start)) if self.last_start is not None else 0
        if self.clock() + wait + 0.1 >= self.deadline:
            raise BudgetEnd()
        self.sleep(wait)
        policy()
        payload = {'portfolioId': PORTFOLIO, 'startTime': start, 'endTime': end, 'pageSize': 20}
        if cursor is not None:
            require(isinstance(cursor, str) and re.fullmatch('[0-9]{1,20}', cursor), 'invalid_cursor')
            payload['indexValue'] = cursor
        request = urllib.request.Request(ENDPOINT, data=json.dumps(payload).encode(), headers={
            'Content-Type': 'application/json', 'Accept': 'application/json', 'User-Agent': 'BooksReadOnlyMonitor/1.0'})
        self.last_start = self.clock()
        info = {'requestStartedAt': monitor.iso(self.wall()), 'cursor': cursor}
        try:
            with self.opener.open(request, timeout=8) as response:
                info['httpStatus'] = response.status
                raw = response.read(2 * 1024 * 1024 + 1)
                require(len(raw) <= 2 * 1024 * 1024, 'source_response_too_large')
                info.update(receivedAt=monitor.iso(self.wall()), responseSha256=hashlib.sha256(raw).hexdigest(),
                            sourceDateHeader=response.headers.get('Date'))
                require(response.status == 200, 'http_' + str(response.status))
                require('application/json' in response.headers.get('Content-Type', '').lower(), 'source_challenge')
                envelope = json.loads(raw, parse_float=Decimal, parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
        except urllib.error.HTTPError as error:
            info['httpStatus'] = error.code
            refusal = error.read(65536)
            info.update(receivedAt=monitor.iso(self.wall()), responseSha256=hashlib.sha256(refusal).hexdigest(),
                        responseBytes=len(refusal), sourceDateHeader=error.headers.get('Date'), retryAfter=error.headers.get('Retry-After'))
            error.close()
            raise Halt('http_' + str(info['httpStatus'])) from None
        except (urllib.error.URLError, TimeoutError, OSError):
            # A finite observation stops on uncertainty; no denial retries.
            raise Halt('source_network_or_timeout') from None
        except (monitor.Stop, ValueError, UnicodeError):
            raise Halt('invalid_source_json') from None
        finally:
            self.calls.append(info)
        require(isinstance(envelope, dict) and envelope.get('success') is True and envelope.get('code') == '000000', 'source_business_refusal')
        page = envelope.get('data')
        require(isinstance(page, dict) and isinstance(page.get('list'), list) and len(page['list']) <= 20 and
                type(page.get('total')) is int and page['total'] >= len(page['list']), 'invalid_public_page')
        return page


def record(raw, observed_at):
    require(isinstance(raw, dict), 'invalid_public_record')
    fields = ('symbol', 'baseAsset', 'quoteAsset', 'side', 'positionSide', 'type')
    out = {key: raw.get(key) for key in fields}
    require(all(isinstance(out[k], str) and re.fullmatch('[A-Z0-9_]{1,50}', out[k]) for k in fields), 'invalid_public_record')
    require(out['side'] in ('BUY', 'SELL') and out['positionSide'] in ('LONG', 'SHORT', 'BOTH'), 'invalid_public_direction')
    for key in ('orderTime', 'orderUpdateTime'):
        require(type(raw.get(key)) is int and 0 < raw[key] <= round(stamp(observed_at) * 1000) + 300000, 'invalid_public_time')
        out[key] = raw[key]
    require(out['orderTime'] <= out['orderUpdateTime'], 'invalid_public_time')
    for key in ('executedQty', 'avgPrice', 'totalPnl'):
        try:
            number = raw.get(key)
            require(type(number) in (str, int, float, Decimal) and len(str(number)) <= 100, 'invalid_public_number')
            value = Decimal(str(number))
            require(value.is_finite() and abs(value) < Decimal('1e30'), 'invalid_public_number')
        except (InvalidOperation, monitor.Stop):
            raise Halt('invalid_public_number') from None
        require(key == 'totalPnl' or value >= 0, 'invalid_public_number')
        out[key] = '0' if value == 0 else monitor.canonical(value)
    out['sourceOrderId'] = None  # This public source exposes no stable order ID.
    out['identity'] = digest({key: out[key] for key in (*fields, 'orderTime')})
    out['fingerprint'] = digest(out)
    out['firstSeenAt'] = observed_at
    out['versionFirstSeenAt'] = observed_at
    out['sourceCreatedAt'] = monitor.iso(out['orderTime'] / 1000)
    out['sourceUpdatedAt'] = monitor.iso(out['orderUpdateTime'] / 1000)
    directions = {('BUY', 'LONG'): 'opening_or_increasing_long', ('SELL', 'SHORT'): 'opening_or_increasing_short',
                  ('SELL', 'LONG'): 'reducing_or_closing_long', ('BUY', 'SHORT'): 'reducing_or_closing_short'}
    out['direction'] = directions.get((out['side'], out['positionSide']), 'one_way_direction_unresolved')
    return out


def collect(source, state, observed_at):
    end = round(stamp(observed_at) * 1000)
    start = end - 7 * 86400000
    rows, cursors, cursor, complete, total = {}, set(), None, False, None
    for page_number in range(MAX_PAGES):
        page = source.page(start, end, cursor)
        total = page['total']
        overlap = False
        before = len(rows)
        for raw in page['list']:
            page_at = source.calls[-1].get('receivedAt', observed_at)
            r = record(raw, page_at)
            rows.setdefault(r['fingerprint'], r)
            overlap |= r['fingerprint'] in state['records']
        if len(rows) >= total:
            complete = True
            break
        # During ongoing observation only the recent prefix is checked, with a
        # backfill to a known fingerprint when a whole page is new.
        if state['initialized'] and overlap:
            break
        next_cursor = page.get('indexValue')
        require(len(rows) > before and isinstance(next_cursor, str) and re.fullmatch('[0-9]{1,20}', next_cursor) and
                next_cursor not in cursors, 'pagination_not_advancing')
        cursors.add(next_cursor)
        cursor = next_cursor
    require(rows or total == 0, 'public_history_disappeared')
    if not rows and any(r['orderUpdateTime'] >= start for r in state['records'].values()):
        raise Halt('public_history_disappeared')
    return rows, {'windowStart': monitor.iso(start / 1000), 'windowEnd': observed_at,
                  'pages': page_number + 1, 'uniqueRows': len(rows), 'sourceTotal': total,
                  'fullWindowRead': complete, 'sourceOrderIdsAvailable': False,
                  'scope': 'public_execution_records_not_pending_orders_or_positions'}


def apply(state, rows, observed_at, coverage):
    previous = state['records']
    identities = {r['identity']: r for r in previous.values()}
    gap = state['lastSuccessAt'] is not None and stamp(observed_at) - stamp(state['lastSuccessAt']) > 2 * INTERVAL + 8
    events = []
    for key, row in rows.items():
        if key in previous:
            row['firstSeenAt'] = previous[key]['firstSeenAt']
            row['versionFirstSeenAt'] = previous[key].get('versionFirstSeenAt', previous[key]['firstSeenAt'])
            continue
        prior = identities.get(row['identity'])
        if prior:
            row['firstSeenAt'] = prior['firstSeenAt']
        if state['initialized']:
            kind = 'public_record_updated' if prior else 'gap_public_record_seen' if gap else 'public_record_first_seen'
            if not prior and row['orderUpdateTime'] <= round(stamp(state['lastSuccessAt']) * 1000):
                kind = 'late_public_record_first_seen'
            events.append({'id': key, 'kind': kind, 'observedAt': observed_at, 'record': copy.deepcopy(row),
                           'meaning': 'public_record_observation_not_a_confirmed_new_order_or_new_position'})
    merged = {**previous, **rows}
    cutoff = stamp(observed_at) * 1000 - 7 * 86400000
    merged = {k: r for k, r in merged.items() if r['orderUpdateTime'] >= cutoff}
    merged = dict(sorted(merged.items(), key=lambda item: item[1]['orderUpdateTime'], reverse=True)[:MAX_RECORDS])
    state.update(initialized=True, records=merged, lastSuccessAt=observed_at, lastAttemptAt=observed_at,
                 lastCoverage=coverage, events=(state['events'] + events)[-MAX_EVENTS:])
    return events


class LocalStore:
    def __init__(self, path):
        self.path = Path(path)
        self.lock = self.path.with_suffix('.lock').open('a')
        fcntl.flock(self.lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        self.state = validate_state(monitor.load_json(self.path.read_bytes()))
    def assert_current(self):
        require(self.path.read_bytes() == self.raw, 'checkpoint_changed')
    def save(self, state):
        validate_state(state)
        raw = json.dumps(state, sort_keys=True, allow_nan=False).encode()
        tmp = self.path.with_suffix('.tmp')
        with tmp.open('wb') as out:
            out.write(raw);out.flush();os.fsync(out.fileno())
        tmp.replace(self.path)
        self.raw = raw
    def close(self):
        self.lock.close()


class GitHubStore:
    def __init__(self):
        require(os.environ.get('GITHUB_REPOSITORY') == REPOSITORY and os.environ.get('GITHUB_REF') == 'refs/heads/main', 'untrusted_github_context')
        require(os.environ.get('GITHUB_EVENT_NAME') in ('push', 'schedule', 'workflow_dispatch'), 'untrusted_github_context')
        self.token = os.environ.get('GITHUB_TOKEN')
        require(self.token, 'missing_github_token')
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), monitor.NoRedirect())
        self.sha, self.etag = None, None
        body = self.get()
        self.state = validate_state(monitor.load_json(base64.b64decode(body['content'].replace('\n', ''), validate=True)))
    def api(self, method, payload=None, conditional=False):
        url = f'https://api.github.com/repos/{REPOSITORY}/contents/{STATE_PATH}'
        if method == 'GET':
            url += '?ref=' + STATE_BRANCH
        headers = {'Authorization': 'Bearer ' + self.token, 'Accept': 'application/vnd.github+json',
                   'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'BooksPublicExecutionWatch/1.0'}
        if conditional and self.etag:
            headers['If-None-Match'] = self.etag
        data = None if payload is None else json.dumps(payload).encode()
        request = urllib.request.Request(url, data=data, method=method, headers=headers)
        try:
            with self.opener.open(request, timeout=20) as response:
                raw = response.read(2 * MAX_BYTES + 1)
                require(len(raw) <= 2 * MAX_BYTES, 'github_response_too_large')
                etag = response.headers.get('ETag')
                return monitor.load_json(raw), etag
        except urllib.error.HTTPError as error:
            code = error.code;error.close()
            if code == 304 and conditional:
                return None, self.etag
            raise Halt('github_http_' + str(code)) from None
        except (urllib.error.URLError, TimeoutError, OSError, monitor.Stop):
            raise Halt('github_state_unavailable') from None
    def get(self):
        body, etag = self.api('GET')
        require(isinstance(body, dict) and body.get('path') == STATE_PATH and body.get('encoding') == 'base64' and
                type(body.get('size')) is int and body['size'] <= MAX_BYTES and
                re.fullmatch('[a-f0-9]{40}', body.get('sha', '')), 'invalid_github_state_response')
        self.sha, self.etag = body['sha'], etag
        return body
    def assert_current(self):
        body, etag = self.api('GET', conditional=True)
        if body is not None:
            require(body.get('sha') == self.sha, 'checkpoint_changed')
            self.etag = etag
    def save(self, state):
        validate_state(state)
        body, _ = self.api('PUT', {'branch': STATE_BRANCH, 'sha': self.sha,
            'message': 'monitor: public execution checkpoint [skip ci]',
            'content': base64.b64encode(json.dumps(state, sort_keys=True, allow_nan=False).encode()).decode()})
        new_sha = (body.get('content') or {}).get('sha') if isinstance(body, dict) else None
        require(isinstance(new_sha, str) and re.fullmatch('[a-f0-9]{40}', new_sha), 'invalid_checkpoint_write_response')
        self.sha, self.etag = new_sha, None
    def close(self):
        pass


def run(store, source, duration, run_id, trigger, clock=time.monotonic, wall=time.time, sleep=time.sleep):
    state = copy.deepcopy(store.state)
    require(not state['stopped'], 'persisted_source_stop')
    require(state['activeRun'] is None, 'previous_run_incomplete')
    policy()
    state['activeRun'] = {'id': run_id, 'trigger': trigger, 'startedAt': monitor.iso(wall())}
    store.save(state)  # Durable claim before the first exchange request.
    started, deadline, target = clock(), clock() + duration, clock()
    source.deadline = deadline
    cycles, event_count = 0, 0
    code = None
    try:
        while target < deadline:
            sleep(max(0, target - clock()))
            if clock() >= deadline:
                break
            store.assert_current()
            policy()
            at = monitor.iso(wall())
            state['lastAttemptAt'] = at
            rows, coverage = collect(source, state, at)
            baseline = not state['initialized']
            events = apply(state, rows, monitor.iso(wall()), coverage)
            cycles += 1;event_count += len(events)
            state['activeRun'].update(checkedCycles=cycles, sourceRequests=len(source.calls), lastCheckAt=state['lastSuccessAt'],
                                      lastSourceResponse=copy.deepcopy(source.calls[-1]))
            if baseline or events or cycles % 12 == 0:
                store.save(state)
            monitor.emit('baseline' if baseline else 'public_records_checked', observedAt=state['lastSuccessAt'],
                         returnedRecords=len(rows), newObservations=len(events), sourceTotal=coverage['sourceTotal'],
                         pages=coverage['pages'], hiddenPositionsRequested=False)
            for event in events:
                monitor.emit('public_execution_observation', event=event)
            target += INTERVAL
            while target <= clock():
                target += INTERVAL
    except BudgetEnd:
        pass
    except (Halt, monitor.Stop) as error:
        code = str(error)
        state.update(stopped=True, errorCode=code)
        monitor.emit('public_order_watch_stopped', reason=code)
    except KeyboardInterrupt:
        code = 'interrupted_run'
        state.update(stopped=True, errorCode=code)
    # Unexpected failures intentionally leave the durable activeRun claim intact.
    result = {'runId': run_id, 'trigger': trigger, 'startedAt': state['activeRun']['startedAt'],
              'endedAt': monitor.iso(wall()), 'durationSeconds': round(clock() - started, 3),
              'cycles': cycles, 'sourceRequests': len(source.calls), 'observations': event_count,
              'errorCode': code, 'positionsRequested': False, 'sourceCalls': source.calls}
    result['checkpointSealed'] = not (code and (code.startswith('github_') or code == 'checkpoint_changed'))
    if result['checkpointSealed']:
        state.update(activeRun=None, lastRun=result)
        store.save(state)
    # A GitHub denial/conflict leaves the durable active claim untouched. No
    # alternative endpoint or credential is tried to seal it.
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--github', action='store_true')
    parser.add_argument('--state', type=Path)
    parser.add_argument('--duration-seconds', type=int, default=60)
    parser.add_argument('--report', type=Path)
    args = parser.parse_args(argv)
    require(1 <= args.duration_seconds <= 840, 'invalid_duration')
    require(args.github != (args.state is not None), 'choose_exactly_one_state_store')
    store = None
    try:
        policy()
        store = GitHubStore() if args.github else LocalStore(args.state)
        # No transport is created for a stopped or incomplete checkpoint.
        require(not store.state['stopped'] and store.state['activeRun'] is None, 'checkpoint_requires_review')
        signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt()))
        source = PublicSource()
        run_id = os.environ.get('GITHUB_RUN_ID', 'local-' + str(int(time.time())))
        trigger = os.environ.get('GITHUB_EVENT_NAME', 'local_bounded_verification')
        result = run(store, source, args.duration_seconds, run_id, trigger)
        if args.report:
            args.report.write_text(json.dumps(result, indent=2) + '\n')
        monitor.emit('public_order_watch_result', **{k: v for k, v in result.items() if k != 'sourceCalls'})
        if path := os.environ.get('GITHUB_STEP_SUMMARY'):
            with Path(path).open('a') as out:
                out.write('## Public execution-record watch\n\n' + json.dumps({k: v for k, v in result.items() if k != 'sourceCalls'}, indent=2) + '\n\nSource records have no order IDs. Direction does not distinguish opening from adding. Hidden positions and pending orders are not requested.\n')
        return 2 if result['errorCode'] else 0
    except (Halt, monitor.Stop, OSError, ValueError) as error:
        code = str(error) if isinstance(error, (Halt, monitor.Stop)) else type(error).__name__
        monitor.emit('public_order_watch_not_started', reason=code)
        return 2
    finally:
        if store:
            store.close()


if __name__ == '__main__':
    raise SystemExit(main())
