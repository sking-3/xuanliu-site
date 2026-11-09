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


def good():
    return c.normalize(payload(),NOW,MODIFIED,'a'*64)


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

    def test_top_200_month_pnl_and_stable_ties(self):
        rows=[account(i+1,pnl=str(i//2)) for i in range(205)]
        result=c.normalize(payload(*rows),NOW)
        self.assertEqual(len(result['traders']),200)
        self.assertEqual(result['source']['totalAccounts'],205)
        self.assertEqual(result['source']['selectedAccounts'],200)
        self.assertEqual(result['traders'][0]['accountId'],account(205)['ethAddress'])
        self.assertGreaterEqual(result['traders'][0]['windows']['30D']['pnl'],result['traders'][-1]['windows']['30D']['pnl'])
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
