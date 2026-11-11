"""Synthetic state/transport fixtures only; no network requests."""
import copy
import json
from pathlib import Path
import unittest
import urllib.error
from unittest.mock import Mock, patch
import continuation as c


class Store:
    def __init__(self):
        self.state={'stopped':False,'activeRun':None,'lastRun':{'runId':'100'}}
        c.admit(self.state,'push','100','');self.writes=[];self.conflict=False
    def save(self,state):
        if self.conflict:raise RuntimeError('github_http_409')
        self.state=copy.deepcopy(state);self.writes.append(copy.deepcopy(state))


def result(**changes):
    return {'runId':'100','checkpointSealed':True,'errorCode':None,'sourceRequests':13,**changes}


class ContinuationTests(unittest.TestCase):
    def test_bootstrap_does_not_overwrite_history_or_create_a_second_chain(self):
        s={'records':{'history':'retained'}};c.admit(s,'push','100','')
        self.assertEqual(s['records'],{'history':'retained'})
        with self.assertRaisesRegex(c.monitor.Stop,'continuation_already_active'):c.admit(s,'push','101','')
        self.assertEqual(s['continuation']['rootRunId'],'100')
    def test_successor_must_consume_exact_reserved_ticket_once(self):
        s=Store();c.dispatch_next(s,result(),'synthetic-token',sender=lambda *_:{'httpStatus':204})
        ticket=s.state['continuation']['ticket'];c.admit(s.state,'workflow_dispatch','101',ticket)
        self.assertEqual(s.state['continuation']['parentRunId'],'100');self.assertEqual(s.state['continuation']['rootRunId'],'100')
        self.assertIsNone(s.state['continuation']['ticket'])
        with self.assertRaises(c.monitor.Stop):c.admit(s.state,'workflow_dispatch','102',ticket)
    def test_invalid_or_missing_ticket_never_resets_chain(self):
        for ticket in ('','a'*32,'../../main',None):
            s=Store();before=copy.deepcopy(s.state)
            with self.assertRaises(c.monitor.Stop):c.admit(s.state,'workflow_dispatch','101',ticket)
            self.assertEqual(s.state,before)
    def test_attempt_reserved_before_post_and_never_posted_twice(self):
        s=Store();calls=[]
        def send(ticket,token):
            self.assertEqual(len(s.writes),1);self.assertEqual(s.state['continuation']['ticket'],ticket)
            self.assertEqual(s.state['continuation']['phase'],'attempt_reserved');calls.append(ticket)
            return {'httpStatus':204}
        self.assertEqual(c.dispatch_next(s,result(),'synthetic-token',send)['status'],'accepted')
        with self.assertRaises(c.monitor.Stop):c.dispatch_next(s,result(),'synthetic-token',send)
        self.assertEqual(len(calls),1)
    def test_unsealed_failed_or_active_source_cannot_dispatch(self):
        for field,value in [('checkpointSealed',False),('errorCode','http_403'),('sourceRequests',0)]:
            s=Store();send=Mock()
            with self.assertRaises(c.monitor.Stop):c.dispatch_next(s,result(**{field:value}),'synthetic-token',send)
            send.assert_not_called()
        s=Store();s.state['activeRun']={'id':'another'};send=Mock()
        with self.assertRaises(c.monitor.Stop):c.dispatch_next(s,result(),'synthetic-token',send)
        send.assert_not_called()
    def test_dispatch_refusal_is_persisted_and_not_retried(self):
        for status in (403,429):
            s=Store();send=Mock(return_value={'httpStatus':status,'responseSha256':'a'*64})
            self.assertEqual(c.dispatch_next(s,result(),'synthetic-token',send)['status'],'stopped')
            self.assertTrue(s.state['continuation']['stopped']);self.assertEqual(s.state['continuation']['errorEvidence']['httpStatus'],status)
            with self.assertRaises(c.monitor.Stop):c.dispatch_next(s,result(),'synthetic-token',send)
            with self.assertRaises(c.monitor.Stop):c.admit(s.state,'workflow_dispatch','101',s.state['continuation']['ticket'])
            self.assertEqual(send.call_count,1)
    def test_claim_conflict_before_post_has_no_external_action(self):
        s=Store();s.conflict=True;send=Mock()
        with self.assertRaises(RuntimeError):c.dispatch_next(s,result(),'synthetic-token',send)
        send.assert_not_called()
    def test_unknown_post_outcome_cannot_overwrite_a_successors_claim(self):
        s=Store()
        def send(ticket,_):
            c.admit(s.state,'workflow_dispatch','101',ticket);s.state['activeRun']={'id':'101'};s.conflict=True
            return {'httpStatus':None,'error':'dispatch_outcome_unknown'}
        self.assertEqual(c.dispatch_next(s,result(),'synthetic-token',send)['status'],'uncertain_claim_preserved')
        self.assertEqual(s.state['activeRun']['id'],'101');self.assertFalse(s.state['continuation']['stopped'])
    def test_unknown_post_outcome_stops_when_no_successor_consumed_ticket(self):
        s=Store();send=Mock(return_value={'httpStatus':None,'error':'dispatch_outcome_unknown'})
        self.assertEqual(c.dispatch_next(s,result(),'synthetic-token',send)['status'],'stopped')
        self.assertTrue(s.state['continuation']['stopped']);self.assertEqual(send.call_count,1)
    def test_transport_only_posts_fixed_workflow_with_ticket_not_run_inventory(self):
        response=Mock();response.status=204;response.__enter__=Mock(return_value=response);response.__exit__=Mock(return_value=False)
        opener=Mock();opener.open.return_value=response
        with patch.object(c.urllib.request,'build_opener',return_value=opener):
            self.assertEqual(c.send('a'*32,'synthetic-token')['httpStatus'],204)
        request=opener.open.call_args.args[0]
        self.assertEqual(request.full_url,c.ENDPOINT);self.assertEqual(request.get_method(),'POST')
        self.assertEqual(json.loads(request.data),{'ref':'main','inputs':{'continuation_ticket':'a'*32}})
        self.assertEqual(opener.open.call_count,1);self.assertNotIn('/actions/runs',request.full_url)
    def test_network_error_is_unknown_and_has_no_retry(self):
        opener=Mock();opener.open.side_effect=urllib.error.URLError('offline')
        with patch.object(c.urllib.request,'build_opener',return_value=opener):out=c.send('a'*32,'synthetic-token')
        self.assertIsNone(out['httpStatus']);self.assertEqual(out['error'],'dispatch_outcome_unknown');self.assertEqual(opener.open.call_count,1)
    def test_workflow_has_one_successor_chain_without_cron_or_additional_credentials(self):
        root=Path(__file__).resolve().parents[2];workflow=(root/'.github/workflows/binance-public-orders.yml').read_text()
        self.assertNotIn('\n  schedule:',workflow);self.assertIn('actions: write',workflow)
        self.assertIn('BINANCE_CONTINUATION_TICKET:',workflow);self.assertIn('public-records-v3',workflow)
        self.assertNotIn('secrets.',workflow);self.assertNotIn('/actions/runs',Path(c.__file__).read_text())
