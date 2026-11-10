#!/usr/bin/env python3
"""Offline collector invariants; no exchange requests, credentials, or fixtures."""
import copy
from datetime import datetime, timedelta, timezone
from email.message import Message
import importlib.util
import json
import math
from pathlib import Path
import tempfile
import subprocess
import sys
import time
import unittest
from unittest.mock import patch
import urllib.error

MODULE = Path(__file__).resolve().parents[1] / 'scripts' / 'collect_hyperliquid.py'
spec = importlib.util.spec_from_file_location('collect_hyperliquid', MODULE)
c = importlib.util.module_from_spec(spec);spec.loader.exec_module(c)
NOW = c.iso(datetime.now(timezone.utc) - timedelta(minutes=5))
ATTEMPT = c.iso(datetime.now(timezone.utc) - timedelta(minutes=1))
MODIFIED = (datetime.now(timezone.utc)-timedelta(minutes=10)).strftime('%a, %d %b %Y %H:%M:%S GMT')


def account(index=1, pnl='25.5', roi='0.1', name=None):
    return {'ethAddress':'0x'+format(index,'040x'),'accountValue':'0',
        'displayName':name,'windowPerformances':[
        [period,{'pnl':pnl,'roi':roi,'vlm':'0'}] for period in ('day','week','month','allTime')]}


def payload(*rows):
    return {'leaderboardRows':list(rows or [account()])}


CHECKED = c.iso(c.parse_time(NOW) + timedelta(seconds=20))
COMPLETED = c.iso(c.parse_time(NOW) + timedelta(seconds=21))


def state(size='0.25', coin='BTC', checked_at=CHECKED):
    positions = [] if size is None else [{'type':'oneWay','position':{
        'coin':coin,'szi':size,'entryPx':'50000','positionValue':'12500',
        'unrealizedPnl':'25','marginUsed':'1250','liquidationPx':None,
        'leverage':{'type':'cross','value':10}}}]
    return {'time':int(c.parse_time(checked_at).timestamp()*1000),'assetPositions':positions}


def good():
    candidates=c.normalize(payload(),NOW,MODIFIED,'a'*64)
    address=candidates['traders'][0]['accountId']
    return c.qualify_positions(candidates,{address:('ok',c.validate_positions(state(),CHECKED))},COMPLETED)


class FakeClock:
    def __init__(self):self.now=0.0
    def clock(self):return self.now
    def sleep(self,amount):self.now+=amount


class FakeTasks:
    def __init__(self,clock,delay=0.1,errors=None):
        self.clock=clock;self.delay=delay;self.errors=errors or {}
        self.starts=[];self.active=0;self.maximum=0;self.closed=[]
    def __call__(self,address):
        owner=self;launched=self.clock.now
        self.starts.append((address,launched));self.active+=1;self.maximum=max(self.maximum,self.active)
        class Task:
            def poll(self):
                if owner.clock.now-launched<owner.delay:return None
                error=owner.errors.get(address)
                return ('error',error) if error else ('ok',c.validate_positions(state(),CHECKED))
            def close(self):
                owner.active-=1;owner.closed.append(address)
        return Task()


class CollectorTests(unittest.TestCase):
    def test_direct_source_numbers_and_no_invented_metrics(self):
        feed=good();row=feed['traders'][0];w=row['windows']['30D']
        self.assertEqual((w['roi'],w['pnl']),(10.0,25.5))
        self.assertEqual(row['accountValue'],0.0)
        self.assertEqual(row['sourceKind'],'public_account')
        self.assertEqual(row['currency'],'USD')
        self.assertEqual(w['sourcePeriod'],'month')
        self.assertEqual(w['asOf'],feed['source']['snapshotAt'])
        self.assertEqual(w['asOfType'],'source')
        self.assertIsNone(w['mdd']);self.assertIsNone(w['wins']);self.assertIsNone(w['closedTrades'])
        self.assertEqual(w['curve'],[])
        for key in ('positions','points','orders'):self.assertEqual(row[key],[])

    def test_zero_negative_and_decimal_ratio(self):
        self.assertEqual(c.number('0'),0)
        self.assertEqual(c.number('-4.25'),-4.25)
        self.assertEqual(c.number('0.123456789',100),12.3456789)
        row=c.normalize(payload(account(roi='0',pnl='-10')),NOW)['traders'][0]
        self.assertEqual(row['windows']['7D']['roi'],0)
        self.assertEqual(row['windows']['ALL']['pnl'],-10)

    def test_reject_nonfinite_and_non_numeric(self):
        for value in ('NaN','Infinity','-inf','',True,None,{},[],float('nan'),float('inf'),'0x10','1e999','1e15'):
            with self.subTest(value=str(value)):
                with self.assertRaises(c.SourceError):c.number(value)
        with self.assertRaises(c.SourceError):c.number('1e14',100)
        with self.assertRaises(c.SourceError):c.decode(b'{"n":NaN}')

    def test_unique_normalized_addresses(self):
        row=account(10);mixed=copy.deepcopy(row);mixed['ethAddress']=mixed['ethAddress'].upper().replace('0X','0x')
        with self.assertRaises(c.SourceError):c.normalize(payload(row,mixed),NOW)
        row['ethAddress']='not-an-address'
        with self.assertRaises(c.SourceError):c.normalize(payload(row),NOW)

    def test_names_are_source_names_or_short_addresses(self):
        rows=c.normalize(payload(account(1,name='  Alice  '),account(2,name='x'*120),account(3)),NOW)['traders']
        self.assertEqual(rows[0]['name'],'Alice');self.assertEqual(len(rows[1]['name']),100)
        self.assertIn('…',rows[2]['name']);self.assertEqual(rows[2]['note'],'')

    def test_top_200_month_roi_and_stable_ties(self):
        rows=[account(i+1,pnl=str(205-i),roi=str(i//2)) for i in range(205)]
        result=c.normalize(payload(*rows),NOW)
        self.assertEqual(len(result['traders']),200)
        self.assertEqual(result['source']['totalAccounts'],205)
        self.assertEqual(result['source']['selectedAccounts'],200)
        self.assertEqual(result['traders'][0]['accountId'],account(205)['ethAddress'])
        self.assertGreaterEqual(result['traders'][0]['windows']['30D']['roi'],result['traders'][-1]['windows']['30D']['roi'])
        self.assertIn('收益率',result['source']['selection'])
        self.assertLess(result['traders'][1]['accountId'],result['traders'][2]['accountId'])

    def test_empty_or_malformed_source_is_not_success(self):
        for body in ({},{'leaderboardRows':[]},{'leaderboardRows':{}},[],{'leaderboardRows':[None]}):
            with self.subTest(body=body):
                with self.assertRaises(c.SourceError):c.normalize(body,NOW)
        with self.assertRaises(c.SourceError):c.decode(b'<html>Site Unavailable</html>')

    def test_missing_or_duplicate_windows_fail(self):
        missing=account();missing['windowPerformances']=missing['windowPerformances'][:-1]
        duplicate=account();duplicate['windowPerformances'].append(['month',{'pnl':'1','roi':'1'}])
        for row in (missing,duplicate):
            with self.assertRaises(c.SourceError):c.normalize(payload(row),NOW)

    def test_snapshot_clock_is_separate_from_read_clock(self):
        feed=good();self.assertNotEqual(feed['source']['snapshotAt'],feed['source']['fetchedAt'])
        self.assertEqual(feed['traders'][0]['observedAt'],feed['source']['fetchedAt'])
        self.assertRegex(feed['source']['fetchedAt'],r'\.\d{3}Z$')
        for value in (None,'not-a-date','Mon, 09 Nov 2099 19:25:26 GMT'):
            without=c.normalize(payload(),NOW,value)
            self.assertIsNone(without['source']['snapshotAt'])
            self.assertEqual(without['traders'][0]['windows']['30D']['asOfType'],'observed')
        with self.assertRaises(c.SourceError):c.normalize(payload(),'2099-01-01T00:00:00Z')
        with self.assertRaises(c.SourceError):c.normalize(payload(),'2026-02-30T00:00:00Z')

    def test_last_good_rows_and_timestamps_survive_failure(self):
        previous=good();unchanged=copy.deepcopy(previous)
        stale=c.failed_snapshot(previous,ATTEMPT,'http_403')
        self.assertEqual(previous,unchanged)
        self.assertEqual(stale['status'],'ready');self.assertEqual(stale['source']['status'],'stale')
        self.assertEqual(stale['traders'],previous['traders'])
        self.assertEqual(stale['source']['fetchedAt'],previous['source']['fetchedAt'])
        self.assertEqual(stale['source']['snapshotAt'],previous['source']['snapshotAt'])
        self.assertEqual(stale['source']['lastAttemptAt'],ATTEMPT)
        c.validate_feed(stale)

    def test_absent_or_corrupt_cache_never_invents_rows(self):
        for previous in (None,{}, {'schemaVersion':1,'status':'unavailable','traders':[]}):
            result=c.failed_snapshot(previous,ATTEMPT,'invalid_schema')
            self.assertEqual(result['status'],'unavailable');self.assertEqual(result['traders'],[])
            self.assertIsNone(result['source']['fetchedAt']);self.assertEqual(result['source']['status'],'error')
        broken=good();broken['traders'][0]['windows']['30D']['roi']=float('nan')
        self.assertEqual(c.failed_snapshot(broken,ATTEMPT,'http_429')['traders'],[])

    def test_cache_schema_rejects_identity_numbers_and_time_tampering(self):
        for mutation in (
            lambda f:f['traders'][0].update(sourceUrl='https://example.com'),
            lambda f:f['traders'][0].update(observedAt='2099-01-01T00:00:00Z'),
            lambda f:f['traders'][0]['windows']['30D'].update(mdd=12),
            lambda f:f['source'].update(fetchedAt='2099-01-01T00:00:00Z'),
            lambda f:f['source'].update(selectedAccounts=7),
            lambda f:f['traders'].append(copy.deepcopy(f['traders'][0])),
        ):
            bad=good();mutation(bad)
            with self.assertRaises(c.SourceError):c.validate_feed(bad)

    def test_public_failure_code_does_not_leak_exception_details(self):
        failure=c.failed_snapshot(good(),ATTEMPT,'secret /private/path details')
        self.assertEqual(failure['source']['errorCode'],'source_error')

    def test_verified_holdings_only_and_separate_times(self):
        candidates=c.normalize(payload(account(1),account(2),account(3),account(4)),NOW)
        results={
            account(1)['ethAddress']:('ok',c.validate_positions(state(),CHECKED)),
            account(2)['ethAddress']:('ok',c.validate_positions(state(None),CHECKED)),
            account(3)['ethAddress']:('error','network_error'),
        }
        feed=c.qualify_positions(candidates,results,COMPLETED)
        self.assertEqual([row['accountId'] for row in feed['traders']],[account(1)['ethAddress']])
        self.assertEqual(feed['source']['selectedAccounts'],1)
        self.assertEqual(feed['source']['fetchedAt'],NOW)
        self.assertEqual(feed['traders'][0]['observedAt'],NOW)
        self.assertEqual(feed['traders'][0]['positionCheck']['checkedAt'],CHECKED)
        verification=feed['source']['positionVerification']
        self.assertEqual([verification[k] for k in ('candidateAccounts','checkedAccounts','holdingAccounts','emptyAccounts','failedAccounts','unattemptedAccounts')],[4,2,1,1,1,1])
        self.assertEqual(verification['scope'],'default_perp_dex')
        self.assertEqual(verification['maxAgeMinutes'],60)
        c.validate_feed(feed)

    def test_successful_all_empty_is_ready_but_all_failed_is_failure(self):
        candidates=c.normalize(payload(),NOW);address=account()['ethAddress']
        empty=c.qualify_positions(candidates,{address:('ok',c.validate_positions(state(None),CHECKED))},COMPLETED)
        self.assertEqual(empty['status'],'ready');self.assertEqual(empty['traders'],[])
        c.validate_feed(empty)
        with self.assertRaisesRegex(c.SourceError,'positions_unavailable'):
            c.qualify_positions(candidates,{address:('error','network_error')},COMPLETED)
        previous=good();stale=c.failed_snapshot(previous,ATTEMPT,'positions_unavailable')
        self.assertEqual(stale['traders'][0]['positionCheck'],previous['traders'][0]['positionCheck'])
        self.assertEqual(stale['source']['positionVerification'],previous['source']['positionVerification'])

    def test_unverified_old_feed_cannot_be_last_good(self):
        unverified=c.normalize(payload(),NOW)
        with self.assertRaises(c.SourceError):c.validate_feed(unverified)
        self.assertEqual(c.failed_snapshot(unverified,ATTEMPT,'http_403')['status'],'unavailable')

    def test_position_state_validation_and_nonzero_count(self):
        self.assertEqual(c.validate_positions(state('0'),CHECKED)['count'],0)
        self.assertEqual(c.validate_positions(state('-0.5'),CHECKED)['count'],1)
        valid=state();valid['assetPositions'][0]['position']['entryPx']=None
        self.assertEqual(c.validate_positions(valid,CHECKED)['count'],1)
        valid['assetPositions'][0]['position']['entryPx']=''
        self.assertEqual(c.validate_positions(valid,CHECKED)['count'],1)
        for mutate in (
            lambda p:p.update(time=True),
            lambda p:p.update(time=p['time']-120001),
            lambda p:p.update(time=p['time']+5001),
            lambda p:p.update(assetPositions={}),
            lambda p:p['assetPositions'].append(copy.deepcopy(p['assetPositions'][0])),
            lambda p:p['assetPositions'][0]['position'].update(szi='NaN'),
            lambda p:p['assetPositions'][0]['position'].update(szi=True),
            lambda p:p['assetPositions'][0]['position'].update(positionValue='-1'),
            lambda p:p['assetPositions'][0]['position'].update(leverage={'type':'other','value':1}),
        ):
            invalid=state();mutate(invalid)
            with self.assertRaises(c.SourceError):c.validate_positions(invalid,CHECKED)

    def test_position_metadata_cache_tampering_rejected(self):
        for mutate in (
            lambda f:f['traders'][0]['positionCheck'].update(count=0),
            lambda f:f['traders'][0]['positionCheck'].update(count=True),
            lambda f:f['traders'][0]['positionCheck'].update(scope='all_dexes'),
            lambda f:f['traders'][0]['positionCheck'].update(sourceTime=c.iso(c.parse_time(NOW)-timedelta(minutes=3))),
            lambda f:f['source']['positionVerification'].update(checkedAccounts=2),
            lambda f:f['source']['positionVerification'].update(completedAt=NOW),
        ):
            invalid=good();mutate(invalid)
            with self.assertRaises(c.SourceError):c.validate_feed(invalid)

    def test_batch_rate_concurrency_and_top200_bound(self):
        clock=FakeClock();tasks=FakeTasks(clock,delay=3)
        rows=c.normalize(payload(*[account(i+1,pnl=str(i)) for i in range(205)]),NOW)['traders']
        results,stop=c.collect_position_checks(rows,tasks,clock.clock,clock.sleep)
        self.assertIsNone(stop);self.assertEqual(len(results),200)
        self.assertEqual(len(tasks.starts),200);self.assertLessEqual(tasks.maximum,4)
        self.assertEqual(tasks.active,0)
        self.assertTrue(all(b[1]-a[1]>=0.5-1e-8 for a,b in zip(tasks.starts,tasks.starts[1:])))
        self.assertLessEqual(clock.now,240)

    def test_403_429_stop_without_retries_or_further_starts(self):
        for error in ('http_403','http_429'):
            clock=FakeClock();rows=c.normalize(payload(account(1),account(2),account(3)),NOW)['traders']
            tasks=FakeTasks(clock,delay=0.1,errors={rows[0]['accountId']:error})
            results,stop=c.collect_position_checks(rows,tasks,clock.clock,clock.sleep)
            self.assertEqual(stop,error);self.assertEqual(len(tasks.starts),1)
            self.assertEqual(results[rows[0]['accountId']],('error',error));self.assertEqual(tasks.active,0)

    def test_request_timeout_and_batch_deadline_cancel_active_work(self):
        clock=FakeClock();tasks=FakeTasks(clock,delay=1000)
        rows=c.normalize(payload(*[account(i+1) for i in range(200)]),NOW)['traders']
        results,stop=c.collect_position_checks(rows,tasks,clock.clock,clock.sleep)
        self.assertEqual(stop,'position_batch_timeout');self.assertLess(len(tasks.starts),200)
        self.assertEqual(len(results),len(tasks.starts));self.assertEqual(tasks.active,0)
        self.assertTrue(all(value[0]=='error' for value in results.values()))
        self.assertLessEqual(clock.now,240.001)

    def test_position_request_is_one_post_default_dex_no_credentials(self):
        response=unittest.mock.MagicMock();response.__enter__.return_value=response;response.status=200
        response.headers=Message();response.headers['Content-Type']='application/json'
        response.read.return_value=json.dumps(state(checked_at=c.iso(datetime.now(timezone.utc)))).encode()
        opener=unittest.mock.Mock();opener.open.return_value=response
        with patch.object(c.urllib.request,'build_opener',return_value=opener):
            check=c.fetch_position_state(account()['ethAddress'])
        self.assertEqual(check['count'],1);self.assertEqual(opener.open.call_count,1)
        request=opener.open.call_args.args[0]
        self.assertEqual(request.full_url,c.INFO_URL);self.assertEqual(request.get_method(),'POST')
        self.assertEqual(json.loads(request.data),{'type':'clearinghouseState','user':account()['ethAddress'],'dex':''})
        self.assertNotIn('Authorization',request.headers)
        for code in (403,429,500):
            opener.open.reset_mock();opener.open.side_effect=urllib.error.HTTPError(c.INFO_URL,code,'denied',{},None)
            with patch.object(c.urllib.request,'build_opener',return_value=opener):
                with self.assertRaisesRegex(c.SourceError,'http_'+str(code)):c.fetch_position_state(account()['ethAddress'])
            self.assertEqual(opener.open.call_count,1)

    @unittest.skipUnless('fork' in c.multiprocessing.get_all_start_methods(),'Fork-only mock inheritance')
    def test_worker_process_returns_metadata_and_can_be_terminated(self):
        expected=c.validate_positions(state(),CHECKED)
        with patch.object(c,'fetch_position_state',return_value=expected):
            task=c.PositionTask(account()['ethAddress'])
            try:
                until=time.monotonic()+2
                result=None
                while result is None and time.monotonic()<until:
                    result=task.poll();time.sleep(0.005)
                self.assertEqual(result,('ok',expected))
            finally:task.close()
            self.assertFalse(task.process.is_alive())
        with patch.object(c,'fetch_position_state',side_effect=lambda address:time.sleep(30)):
            task=c.PositionTask(account()['ethAddress'])
            start=time.monotonic();task.close()
            self.assertLess(time.monotonic()-start,1)
            self.assertFalse(task.process.is_alive())

    def test_offline_captures_do_not_request_network(self):
        candidates=c.normalize(payload(),NOW);address=account()['ethAddress']
        with tempfile.TemporaryDirectory() as root:
            directory=Path(root)
            (directory/(address+'.json')).write_text(json.dumps({'checkedAt':CHECKED,'payload':state()}))
            with patch.object(c.urllib.request,'build_opener',side_effect=AssertionError('network forbidden')):
                results=c.read_position_captures(candidates['traders'],directory)
                qualified=c.qualify_positions(candidates,results,COMPLETED)
            self.assertEqual(len(qualified['traders']),1)
        result=subprocess.run([sys.executable,'-B',str(MODULE),'--input','missing','--metadata','missing'],capture_output=True,text=True)
        self.assertEqual(result.returncode,2);self.assertIn('--positions-dir',result.stderr)

    def test_atomic_write_and_size_guard_preserve_old(self):
        with tempfile.TemporaryDirectory() as root:
            path=Path(root)/'feed.json';original=good();c.atomic_write(path,original)
            self.assertEqual(c.read_previous(path),original)
            before=path.read_bytes()
            with self.assertRaises(c.SourceError):c.atomic_write(path,{'huge':'x'*(c.MAX_FEED_BYTES+1)})
            self.assertEqual(path.read_bytes(),before)
            self.assertEqual(list(Path(root).glob('*.tmp')),[])

    def test_single_http_request_no_retries_on_access_or_rate_limit(self):
        for status in (403,429,500):
            mock=unittest.mock.Mock();mock.open.side_effect=urllib.error.HTTPError(c.SOURCE_URL,status,'denied',{},None)
            with patch.object(c.urllib.request,'build_opener',return_value=mock):
                with self.assertRaisesRegex(c.SourceError,'http_'+str(status)):c.fetch_source()
            self.assertEqual(mock.open.call_count,1)

    def test_redirect_is_rejected(self):
        with self.assertRaisesRegex(c.SourceError,'redirect_rejected'):
            c.NoRedirect().redirect_request(None,None,302,None,{},'https://other.example')

    def test_http_200_html_is_rejected(self):
        response=unittest.mock.MagicMock();response.__enter__.return_value=response;response.status=200
        response.headers=Message();response.headers['Content-Type']='text/html'
        opener=unittest.mock.Mock();opener.open.return_value=response
        with patch.object(c.urllib.request,'build_opener',return_value=opener):
            with self.assertRaisesRegex(c.SourceError,'unexpected_content_type'):c.fetch_source()
        response.read.assert_not_called()

    def test_success_response_is_bounded_and_timestamped(self):
        response=unittest.mock.MagicMock();response.__enter__.return_value=response;response.status=200
        response.headers=Message();response.headers['Content-Type']='application/json';response.headers['Last-Modified']=MODIFIED
        response.read.side_effect=[b'{}',b'']
        opener=unittest.mock.Mock();opener.open.return_value=response
        with patch.object(c.urllib.request,'build_opener',return_value=opener):
            raw,last_modified,fetched_at=c.fetch_source()
        self.assertEqual(raw,b'{}');self.assertEqual(last_modified,MODIFIED);c.parse_time(fetched_at)
        request=opener.open.call_args.args[0]
        self.assertEqual(request.full_url,c.SOURCE_URL);self.assertEqual(request.get_method(),'GET')
        self.assertNotIn('Authorization',request.headers)


if __name__=='__main__':
    unittest.main(verbosity=2)
