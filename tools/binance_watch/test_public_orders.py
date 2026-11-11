import copy
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import public_orders as p


class Clock:
    def __init__(self): self.t=0
    def now(self): return self.t
    def wall(self): return 1794389352+self.t
    def sleep(self,seconds): self.t+=seconds


def raw(n=0,**changes):
    r={'symbol':'TESTUSDT','baseAsset':'TEST','quoteAsset':'USDT','side':'SELL','positionSide':'SHORT',
       'type':'MARKET','executedQty':1,'avgPrice':10,'totalPnl':0,
       'orderTime':1794389351000-n*1000,'orderUpdateTime':1794389351000-n*1000}
    r.update(changes);return r


class Store:
    def __init__(self,state=None): self.state=copy.deepcopy(state or p.initial_state());self.writes=[];self.checked=0;self.conflict=False
    def save(self,state): p.validate_state(state);self.state=copy.deepcopy(state);self.writes.append(copy.deepcopy(state))
    def assert_current(self):
        self.checked+=1
        if self.conflict: raise p.Halt('checkpoint_changed')


class Source:
    def __init__(self,clock,pages=None,error=None): self.clock=clock;self.pages=pages;self.error=error;self.calls=[];self.deadline=float('inf')
    def page(self,start,end,cursor=None):
        if self.calls:self.clock.sleep(max(0,5-(self.clock.now()-self.calls[-1]['at'])))
        if self.clock.now()>=self.deadline:raise p.BudgetEnd()
        self.calls.append({'at':self.clock.now(),'receivedAt':p.monitor.iso(self.clock.wall()),'cursor':cursor})
        if self.error:raise p.Halt(self.error)
        if self.pages:return copy.deepcopy(self.pages[len(self.calls)-1] if len(self.calls)<=len(self.pages) else self.pages[-1])
        return {'list':[raw()], 'total':1,'indexValue':'1'}


class PublicOrderTests(unittest.TestCase):
    def setUp(self): self.policy=patch.object(p,'policy',lambda:None);self.policy.start();self.addCleanup(self.policy.stop)
    def run_watch(self,source=None,store=None,duration=31):
        c=Clock();source=source or Source(c);store=store or Store()
        with patch.object(p.monitor,'emit'):
            result=p.run(store,source,duration,'test-run','unit',clock=source.clock.now,wall=source.clock.wall,sleep=source.clock.sleep)
        return result,store,source
    def test_five_second_serial_cadence_and_initial_baseline(self):
        result,store,source=self.run_watch();self.assertEqual([x['at'] for x in source.calls],[0,5,10,15,20,25,30]);self.assertEqual(result['cycles'],7);self.assertEqual(result['observations'],0);self.assertIsNone(store.state['activeRun']);self.assertTrue(store.writes[0]['activeRun']);self.assertFalse(store.writes[0]['initialized'])
    def test_cursor_is_inclusive_and_boundary_is_deduplicated(self):
        c=Clock();source=Source(c,[{'list':[raw(0),raw(1)],'total':3,'indexValue':'123'}, {'list':[raw(1),raw(2)],'total':3,'indexValue':'122'}]);rows,coverage=p.collect(source,p.initial_state(),p.monitor.iso(c.wall()));self.assertEqual(len(rows),3);self.assertTrue(coverage['fullWindowRead']);self.assertEqual(source.calls[1]['cursor'],'123');self.assertEqual(source.calls[1]['at'],5)
    def test_pagination_cannot_loop_or_guess_cursor(self):
        c=Clock();source=Source(c,[{'list':[raw()],'total':3,'indexValue':'123'}]);self.assertRaises(p.Halt,p.collect,source,p.initial_state(),p.monitor.iso(c.wall()))
    def test_gap_and_periodic_backfill_continue_after_known_first_page(self):
        for delta,recent_success in ((25,0),(301,296)):
            with self.subTest(delta=delta):
                c=Clock();at=p.monitor.iso(c.wall());s=p.initial_state();r=p.record(raw(),at)
                p.apply(s,{r['fingerprint']:r},at,{'fullWindowRead':True})
                s['lastSuccessAt']=p.monitor.iso(c.wall()+recent_success);c.t=delta
                source=Source(c,[{'list':[raw()], 'total':2,'indexValue':'123'}, {'list':[raw(20)],'total':2,'indexValue':'122'}])
                rows,coverage=p.collect(source,s,p.monitor.iso(c.wall()))
                self.assertEqual(len(rows),2);self.assertEqual(len(source.calls),2);self.assertTrue(coverage['fullWindowRead']);self.assertEqual(coverage['scanMode'],'bounded_window_backfill')
                events=p.apply(s,rows,p.monitor.iso(c.wall()),coverage)
                self.assertEqual(events[0]['kind'],'late_public_record_first_seen');self.assertEqual(s['lastFullScanAt'],s['lastSuccessAt'])
    def test_recent_prefix_stays_small_between_full_scans(self):
        c=Clock();at=p.monitor.iso(c.wall());s=p.initial_state();r=p.record(raw(),at);p.apply(s,{r['fingerprint']:r},at,{'fullWindowRead':True});c.t=5
        source=Source(c,[{'list':[raw()],'total':2,'indexValue':'123'}]);rows,coverage=p.collect(source,s,p.monitor.iso(c.wall()))
        self.assertEqual(len(source.calls),1);self.assertFalse(coverage['fullWindowRead']);self.assertEqual(coverage['scanMode'],'recent_prefix')
    def test_no_order_id_records_are_observed_without_calling_them_new_orders(self):
        s=p.initial_state();at=p.monitor.iso(1794389352);r=p.record(raw(),at);self.assertEqual(p.apply(s,{r['fingerprint']:r},at,{}),[]);at2=p.monitor.iso(1794389357);r2=p.record(raw(orderTime=1794389356000,orderUpdateTime=1794389356000),at2);events=p.apply(s,{r2['fingerprint']:r2},at2,{});self.assertEqual(events[0]['kind'],'public_record_first_seen');self.assertIsNone(events[0]['record']['sourceOrderId']);self.assertEqual(events[0]['record']['direction'],'opening_or_increasing_short');self.assertIn('not_a_confirmed_new_order',events[0]['meaning']);self.assertEqual(p.apply(s,{r2['fingerprint']:r2},at2,{}),[])
    def test_possible_revision_preserves_each_fingerprints_first_seen_without_claiming_order_identity(self):
        s=p.initial_state();at=p.monitor.iso(1794389352);r=p.record(raw(),at);p.apply(s,{r['fingerprint']:r},at,{});at2=p.monitor.iso(1794389357);changed=p.record(raw(executedQty='2.0',orderUpdateTime=1794389356000),at2);event=p.apply(s,{changed['fingerprint']:changed},at2,{})[0];self.assertEqual(event['kind'],'public_record_possible_revision');self.assertEqual(event['record']['firstSeenAt'],at2);self.assertEqual(event['record']['sharedIdentityFirstSeenAt'],at);self.assertFalse(event['sourceIdentityIsOrderId']);self.assertIn('distinct_public_record',event['meaning']);self.assertEqual(len(s['records']),2)
    def test_late_record_is_not_a_newly_created_order(self):
        s=p.initial_state();at=p.monitor.iso(1794389352);p.apply(s,{},at,{});later=p.monitor.iso(1794389357);r=p.record(raw(20),later);self.assertEqual(p.apply(s,{r['fingerprint']:r},later,{})[0]['kind'],'late_public_record_first_seen')
    def test_equal_source_times_do_not_collapse_distinct_baseline_records(self):
        s=p.initial_state();at=p.monitor.iso(1794389352)
        records=[p.record(raw(executedQty=n),at) for n in (1,2,3)]
        rows={r['fingerprint']:r for r in records}
        self.assertEqual(len({r['identity'] for r in records}),1)
        self.assertEqual(p.apply(s,rows,at,{}),[])
        self.assertEqual(len(s['records']),3)
        self.assertEqual(p.apply(s,copy.deepcopy(rows),p.monitor.iso(1794389357),{}),[])
    def test_gap_is_reported_without_rewriting_source_times(self):
        s=p.initial_state();at=p.monitor.iso(1794389352);p.apply(s,{},at,{});later=p.monitor.iso(1794389400);r=p.record(raw(orderTime=1794389399000,orderUpdateTime=1794389399000),later);event=p.apply(s,{r['fingerprint']:r},later,{})[0];self.assertEqual(event['kind'],'gap_public_record_seen');self.assertEqual(r['sourceUpdatedAt'],p.monitor.iso(1794389399))
    def test_decimal_variants_and_negative_zero_do_not_create_duplicates(self):
        at=p.monitor.iso(1794389352);a=p.record(raw(executedQty='1.00',totalPnl='-0.0'),at);b=p.record(raw(executedQty=1,totalPnl=0),at);self.assertEqual(a['fingerprint'],b['fingerprint'])
    def test_http_denial_is_persisted_and_no_second_source_request(self):
        c=Clock();source=Source(c,error='http_403');result,s,source=self.run_watch(source=source);self.assertEqual(len(source.calls),1);self.assertTrue(s.state['stopped']);self.assertEqual(s.state['errorCode'],'http_403');self.assertIsNone(s.state['activeRun']);self.assertRaises(p.Halt,self.run_watch,store=s)
    def test_incomplete_run_or_saved_stop_cannot_request_source(self):
        for changes in ({'activeRun':{'id':'prior'}},{'stopped':True,'errorCode':'http_429'}):
            s=Store();s.state.update(changes);c=Clock();source=Source(c)
            with self.assertRaises(p.Halt):self.run_watch(source,s)
            self.assertEqual(source.calls,[])
    def test_checkpoint_conflict_leaves_durable_claim_and_never_requests_source(self):
        s=Store();s.conflict=True;result,s,source=self.run_watch(store=s);self.assertEqual(source.calls,[]);self.assertFalse(result['checkpointSealed']);self.assertIsNotNone(s.state['activeRun'])
    def test_old_and_new_lock_claim_race_allows_only_one_source_reader(self):
        shared={'revision':0,'state':p.initial_state()}
        class CAS(Store):
            def __init__(self):super().__init__(shared['state']);self.revision=shared['revision']
            def save(self,state):
                if self.revision!=shared['revision']:raise p.Halt('github_http_409')
                super().save(state);shared['revision']+=1;self.revision=shared['revision'];shared['state']=copy.deepcopy(state)
            def assert_current(self):
                if self.revision!=shared['revision']:raise p.Halt('checkpoint_changed')
        winner,loser=CAS(),CAS();clock=Clock();source=Source(clock);blocked_source=Source(Clock());page=source.page
        def first_page(*args,**kwargs):
            if not source.calls:
                with self.assertRaisesRegex(p.Halt,'github_http_409'):
                    p.run(loser,blocked_source,5,'obsolete-lock','unit',clock=clock.now,wall=clock.wall,sleep=clock.sleep)
                self.assertEqual(shared['state']['activeRun']['id'],'test-run')
            return page(*args,**kwargs)
        source.page=first_page
        result,_,_=self.run_watch(source,winner,11)
        self.assertEqual(blocked_source.calls,[]);self.assertEqual(result['sourceRequests'],3);self.assertIsNone(shared['state']['activeRun'])
    def test_empty_result_cannot_erase_visible_history(self):
        c=Clock();s=p.initial_state();r=p.record(raw(),p.monitor.iso(c.wall()));p.apply(s,{r['fingerprint']:r},p.monitor.iso(c.wall()),{});source=Source(c,[{'list':[],'total':0,'indexValue':None}]);self.assertRaises(p.Halt,p.collect,source,s,p.monitor.iso(c.wall()));self.assertEqual(len(s['records']),1)
    def test_invalid_source_fields_fail_closed(self):
        at=p.monitor.iso(1794389352)
        for change in ({'executedQty':float('nan')},{'avgPrice':-1},{'side':'bad'},{'orderTime':1794389351001,'orderUpdateTime':1794389351000},{'orderTime':None}):
            with self.subTest(change=change):self.assertRaises((p.Halt,p.monitor.Stop),p.record,raw(**change),at)
    def test_corrupt_checkpoint_fingerprint_fails_validation(self):
        s=p.initial_state();at=p.monitor.iso(1794389352);r=p.record(raw(),at);p.apply(s,{r['fingerprint']:r},at,{});r=s['records'][r['fingerprint']];r['executedQty']='999';self.assertRaises(p.Halt,p.validate_state,s)
    def test_local_store_never_reinitializes_existing_stops(self):
        with tempfile.TemporaryDirectory() as d:
            path=Path(d)/'state.json';s=p.initial_state();s.update(stopped=True,errorCode='http_403');path.write_text(json.dumps(s));store=p.LocalStore(path);self.assertTrue(store.state['stopped']);store.close()
    def test_github_store_only_uses_contents_api_and_compare_and_swap(self):
        env={'GITHUB_REPOSITORY':p.REPOSITORY,'GITHUB_REF':'refs/heads/main','GITHUB_EVENT_NAME':'push','GITHUB_TOKEN':'unit-secret','BINANCE_LOCK_PROTOCOL':'public-records-v2'}
        state=p.initial_state();body={'path':p.STATE_PATH,'encoding':'base64','size':100,'sha':'a'*40,'content':p.base64.b64encode(json.dumps(state).encode()).decode()}
        with patch.dict(os.environ,env),patch.object(p.GitHubStore,'api',return_value=(body,'etag')) as api:
            store=p.GitHubStore();self.assertEqual(store.sha,'a'*40);api.return_value=({'content':{'sha':'b'*40}},None);store.save(state);payload=api.call_args.args[1];self.assertEqual(payload['sha'],'a'*40);self.assertEqual(payload['branch'],p.STATE_BRANCH);self.assertEqual(store.sha,'b'*40)
    def test_obsolete_queued_lock_protocol_never_reads_state_or_source(self):
        env={'GITHUB_REPOSITORY':p.REPOSITORY,'GITHUB_REF':'refs/heads/main','GITHUB_EVENT_NAME':'schedule','GITHUB_TOKEN':'unit-secret','BINANCE_LOCK_PROTOCOL':''}
        with patch.dict(os.environ,env),patch.object(p.GitHubStore,'api') as api:
            with self.assertRaisesRegex(p.Halt,'obsolete_source_lock_protocol'):p.GitHubStore()
            api.assert_not_called()

    def test_github_denial_does_not_retry_or_clear_the_active_claim(self):
        s=Store();s.assert_current=lambda:(_ for _ in ()).throw(p.Halt('github_http_403'));result,s,source=self.run_watch(store=s);self.assertEqual(source.calls,[]);self.assertFalse(result['checkpointSealed']);self.assertIsNotNone(s.state['activeRun']);self.assertEqual(len(s.writes),1)


if __name__=='__main__':unittest.main()

# Workflow assertions deliberately inspect the source gate and state destination,
# not the forbidden Actions run/queue inventory.
class DeploymentContractTests(unittest.TestCase):
    def test_no_queue_inventory_and_only_public_order_endpoint(self):
        source=Path(p.__file__).read_text()
        self.assertNotIn('/actions/runs',source)
        self.assertNotIn('actions_state',source)
        self.assertNotIn('lead-data/positions',source)
        self.assertIn("ENDPOINT = monitor.BASE + 'lead-portfolio/order-history'",source)
    def test_workflow_serializes_source_and_has_no_trade_secrets(self):
        root=Path(__file__).resolve().parents[2]
        workflow=(root/'.github/workflows/binance-public-orders.yml').read_text()
        self.assertIn('group: binance-public-records-source',workflow)
        self.assertIn('cancel-in-progress: false',workflow)
        self.assertIn('contents: write',workflow)
        self.assertIn('persist-credentials: false',workflow)
        self.assertNotIn('secrets.',workflow)
        self.assertNotIn('actions_state.py',workflow)
    def test_policy_keeps_hidden_positions_and_old_queue_refusal(self):
        self.assertIsNone(p.source_holds.reason('binanceOrders'+p.PORTFOLIO))
        self.assertEqual(p.source_holds.reason('binancePositions'+p.PORTFOLIO),'positions_not_public')
        self.assertEqual(p.source_holds.reason('githubRunInventory'),'stopped_after_queue_403')
        p.policy()

class PublicTransportTests(unittest.TestCase):
    def test_transport_only_posts_public_records_and_paces_all_pages(self):
        from unittest.mock import Mock
        clock=Clock();source=p.PublicSource(clock.now,clock.wall,clock.sleep)
        payload=json.dumps({'code':'000000','success':True,'data':{'list':[raw(executedQty=1e-8)],'total':1,'indexValue':'1'}}).encode()
        class Response:
            status=200;headers={'Content-Type':'application/json','Date':'test'}
            def read(self,n):return payload
            def __enter__(self):return self
            def __exit__(self,*_):pass
        source.opener.open=Mock(return_value=Response())
        with patch.object(p,'policy',lambda:None):
            first=source.page(1,2);source.page(1,2,'1')
        request=source.opener.open.call_args.args[0]
        self.assertEqual(request.full_url,p.ENDPOINT)
        self.assertEqual(request.get_method(),'POST')
        self.assertIsNone(request.get_header('Authorization'));self.assertIsNone(request.get_header('Cookie'))
        self.assertEqual(json.loads(request.data)['indexValue'],'1')
        self.assertEqual(clock.t,5)
        self.assertEqual(first['list'][0]['executedQty'],p.Decimal('1e-8'))
    def test_source_denial_keeps_evidence_and_never_retries(self):
        from unittest.mock import Mock
        source=p.PublicSource();source.opener.open=Mock(side_effect=p.urllib.error.HTTPError(p.ENDPOINT,403,'denied',{'Date':'source-date'},io.BytesIO(b'public endpoint denial')))
        with patch.object(p,'policy',lambda:None):self.assertRaisesRegex(p.Halt,'http_403',source.page,1,2)
        self.assertEqual(source.opener.open.call_count,1)
        self.assertEqual(source.calls[0]['httpStatus'],403)
        self.assertEqual(source.calls[0]['responseSha256'],p.hashlib.sha256(b'public endpoint denial').hexdigest())
