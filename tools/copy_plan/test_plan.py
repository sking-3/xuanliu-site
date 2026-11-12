"""Synthetic offline fixtures; these tests never read Binance or a real exchange account."""
import copy
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
import urllib.error
import plan as p

NOW=1794474000

def config(target='Bitget'):
    return {'schemaVersion':1,'mode':'dry_run','liveTradingEnabled':False,'source':{'exchange':'Binance','accountId':'5075281354358777856'},'target':{'exchange':target,'accountRef':'SYNTHETIC_MAIN'},'copyRatio':.5,'notionalPerIncrease':100,'maxOrderNotional':100,'maxTotalNotional':300,'leverage':5,'slippageBps':10,'direction':'both','symbols':[],'signalMaxAgeSeconds':60}

def record(at,**changes):
    raw={'symbol':'ETHUSDT','baseAsset':'ETH','quoteAsset':'USDT','side':'SELL','positionSide':'SHORT','type':'MARKET','executedQty':1,'avgPrice':100,'totalPnl':0,'orderTime':int(at*1000),'orderUpdateTime':int(at*1000)}
    raw.update(changes)
    return p.public.record(raw,p.public.monitor.iso(at+.1))

def checkpoint(at=NOW,rows=None):
    s=p.public.initial_state();s.update(initialized=True,lastSuccessAt=p.public.monitor.iso(at))
    s['records']={r['fingerprint']:r for r in (rows or [])}
    return s

class PlanTests(unittest.TestCase):
    def baseline(self,c=None):return p.advance(c or config(),None,checkpoint(NOW,[record(NOW-1)]),NOW)[0]
    def test_three_targets_are_dry_run_only(self):
        for target in p.TARGETS:
            c=config(target);s=self.baseline(c);_,plans,_=p.advance(c,s,checkpoint(NOW+5,[record(NOW+4)]),NOW+5)
            self.assertEqual(plans[0]['requestedNotional'],50);self.assertFalse(plans[0]['executable']);self.assertEqual(plans[0]['ordersSent'],0)
            self.assertIsNone(plans[0]['quantity']);self.assertIsNone(plans[0]['price']);self.assertEqual(plans[0]['quoteUnit'],'USDC' if target=='Hyperliquid' else 'USDT')
    def test_initial_history_only_establishes_baseline(self):
        s,plans,report=p.advance(config(),None,checkpoint(NOW,[record(NOW-1)]),NOW)
        self.assertEqual(plans,[]);self.assertEqual(report['status'],'baseline');self.assertEqual(len(s['seen']),1)
    def test_identical_repeated_checkpoint_does_not_duplicate_intents(self):
        c=config();s=self.baseline();cp=checkpoint(NOW+5,[record(NOW+4)]);s,plans,_=p.advance(c,s,cp,NOW+5)
        self.assertEqual(len(plans),1);self.assertEqual(p.advance(c,s,cp,NOW+6)[1],[])
    def test_old_newly_discovered_record_is_skipped(self):
        _,plans,_=p.advance(config(),self.baseline(),checkpoint(NOW+5,[record(NOW-20)]),NOW+5)
        self.assertEqual(plans[0]['reason'],'historical_or_late')
    def test_stale_and_future_records_are_skipped(self):
        for at in (NOW+1,NOW+110):
            _,plans,_=p.advance(config(),self.baseline(),checkpoint(NOW+70,[record(at)]),NOW+70)
            self.assertEqual(plans[0]['reason'],'signal_time_invalid_or_stale')
    def test_gap_over_two_minutes_rebaselines_without_catchup_orders(self):
        _,plans,report=p.advance(config(),self.baseline(),checkpoint(NOW+130,[record(NOW+129)]),NOW+130)
        self.assertEqual(plans,[]);self.assertEqual(report['status'],'baseline')
    def test_clock_rollback_rebaselines(self):
        _,plans,report=p.advance(config(),self.baseline(),checkpoint(NOW-5,[record(NOW-6)]),NOW-5)
        self.assertEqual(plans,[]);self.assertEqual(report['status'],'baseline')
    def test_zero_quantity_or_price_is_not_a_signal(self):
        for changes in ({'executedQty':0},{'avgPrice':0}):
            _,plans,_=p.advance(config(),self.baseline(),checkpoint(NOW+5,[record(NOW+4,**changes)]),NOW+5)
            self.assertEqual(plans[0]['reason'],'no_executed_quantity_or_price')
    def test_revision_cannot_become_another_increase(self):
        c=config();s=self.baseline();a=record(NOW+4);s,_,_=p.advance(c,s,checkpoint(NOW+5,[a]),NOW+5)
        b=record(NOW+4,executedQty=2,orderUpdateTime=int((NOW+8)*1000))
        _,plans,_=p.advance(c,s,checkpoint(NOW+10,[b]),NOW+10)
        self.assertEqual(plans[0]['reason'],'ambiguous_record_version')
    def test_same_identity_with_multiple_versions_is_ambiguous(self):
        a=record(NOW+4);b=record(NOW+4,executedQty=2)
        _,plans,_=p.advance(config(),self.baseline(),checkpoint(NOW+5,[a,b]),NOW+5)
        self.assertEqual([r['reason'] for r in plans],['ambiguous_record_version']*2)
    def test_reduction_never_guesses_target_position_size(self):
        _,plans,_=p.advance(config(),self.baseline(),checkpoint(NOW+5,[record(NOW+4,side='BUY')]),NOW+5)
        self.assertEqual(plans[0]['intent'],'reduce_owned_fragment_only');self.assertIsNone(plans[0]['requestedNotional']);self.assertFalse(plans[0]['executable'])
    def test_one_way_direction_is_unresolved(self):
        _,plans,_=p.advance(config(),self.baseline(),checkpoint(NOW+5,[record(NOW+4,positionSide='BOTH')]),NOW+5)
        self.assertEqual(plans[0]['reason'],'direction_unresolved')
    def test_direction_and_symbol_filters(self):
        for changes,reason in (({'direction':'long'},'direction_filtered'),({'symbols':['BTCUSDT']},'symbol_filtered')):
            c=config();c.update(changes);_,plans,_=p.advance(c,self.baseline(c),checkpoint(NOW+5,[record(NOW+4)]),NOW+5)
            self.assertEqual(plans[0]['reason'],reason)
    def test_source_stopped_uninitialized_stale_or_future_is_rejected(self):
        for changes in ({'stopped':True},{'initialized':False},{'lastSuccessAt':p.public.monitor.iso(NOW-121)},{'lastSuccessAt':p.public.monitor.iso(NOW+2)}):
            cp=checkpoint();cp.update(changes)
            with self.assertRaisesRegex(ValueError,'source_not_healthy'):p.advance(config(),None,cp,NOW)
    def test_source_time_rollback_and_corrupt_metadata_stop(self):
        s=self.baseline()
        with self.assertRaisesRegex(ValueError,'source_time_rollback'):p.advance(config(),s,checkpoint(NOW-1),NOW+5)
        r=record(NOW+4);r['direction']='opening_or_increasing_long'
        with self.assertRaisesRegex(ValueError,'metadata_mismatch'):p.advance(config(),s,checkpoint(NOW+5,[r]),NOW+5)
    def test_state_is_not_mutated_on_error_or_success(self):
        s=self.baseline();before=copy.deepcopy(s);p.advance(config(),s,checkpoint(NOW+5,[record(NOW+4)]),NOW+5);self.assertEqual(s,before)
    def test_config_change_or_damaged_state_is_rejected(self):
        s=self.baseline()
        for changes in ({'configId':'changed'},{'lastTick':float('nan')},{'identities':None}):
            damaged={**s,**changes}
            with self.assertRaisesRegex(ValueError,'invalid_dry_run_state'):p.advance(config(),damaged,checkpoint(),NOW)
    def test_unknown_fields_credentials_live_mode_and_risk_overflow_rejected(self):
        for changes in ({'apiSecret':'NEVER_REAL'},{'mode':'live'},{'liveTradingEnabled':True},{'schemaVersion':True},{'copyRatio':True},{'leverage':5.5},{'notionalPerIncrease':1000},{'maxTotalNotional':10},{'symbols':['eth/usdt']},{'source':{'exchange':'Binance','accountId':'other'}}):
            c=config();c.update(changes)
            with self.assertRaises((ValueError,TypeError)):p.validate_config(c)
    def test_persisted_stop_prevents_network_before_first_read(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);(root/'copy-config').mkdir();(root/'copy-config/test.json').write_text(json.dumps(config()));state=root/'state.json';state.write_text(json.dumps({'stopped':True}))
            with patch.object(sys,'argv',['plan','--config',str(root/'copy-config/test.json'),'--state',str(state),'--report',str(root/'report.json')]),patch.object(Path,'cwd',return_value=root),patch.object(p,'read_checkpoint') as read,patch('sys.stdout',new_callable=io.StringIO):
                self.assertEqual(p.main(),2);read.assert_not_called();self.assertEqual(json.loads((root/'report.json').read_text())['errorCode'],'persisted_dry_run_stop')
    def test_first_http_denial_saves_stop_tombstone_without_retry_or_payload(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);(root/'copy-config').mkdir();(root/'copy-config/test.json').write_text(json.dumps(config()));state=root/'state/state.json'
            with patch.object(sys,'argv',['plan','--config',str(root/'copy-config/test.json'),'--state',str(state),'--report',str(root/'report.json')]),patch.object(Path,'cwd',return_value=root),patch.dict(os.environ,{'GITHUB_TOKEN':'SYNTHETIC_TOKEN'}),patch.object(p,'read_checkpoint',side_effect=ValueError('github_checkpoint_http_403')) as read,patch('sys.stdout',new_callable=io.StringIO) as output:
                self.assertEqual(p.main(),2);self.assertEqual(read.call_count,1);self.assertTrue(json.loads(state.read_text())['stopped']);self.assertNotIn('SYNTHETIC_TOKEN',output.getvalue());self.assertEqual(json.loads((root/'report.json').read_text())['ordersSent'],0)
    def test_http_error_body_never_leaks_or_retries(self):
        fake=unittest.mock.Mock();fake.open.side_effect=urllib.error.HTTPError(p.CHECKPOINT,429,'Denied',{},io.BytesIO(b'SENSITIVE_PAYLOAD'))
        with patch.object(p.urllib.request,'build_opener',return_value=fake):
            with self.assertRaisesRegex(ValueError,'^github_checkpoint_http_429$'):p.read_checkpoint('SYNTHETIC_TOKEN')
        self.assertEqual(fake.open.call_count,1)

if __name__=='__main__':unittest.main()
