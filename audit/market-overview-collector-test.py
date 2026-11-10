#!/usr/bin/env python3
"""Offline fixtures only. Never writes production market-overview.json."""
import copy
from datetime import datetime, timedelta, timezone
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock
import urllib.error

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('market_collector', ROOT / 'scripts/collect_market_overview.py')
c = importlib.util.module_from_spec(spec)
spec.loader.exec_module(c)
NOW = datetime(2026, 11, 10, 8, 0, tzinfo=timezone.utc)
LAYOUT = '''2026年10月30日
沪深300指数 000300
3年波动率 1.3
     1年年化                  17.39%               滚动市盈率                  12.61
     3年年化                  17.88%                市净率                    1.3
     5年年化                  17.51%                股息率                   2.73%
'''


def fixtures(now=NOW):
    stamp = int((now - timedelta(minutes=2)).timestamp())
    fng = {'metadata': {'error': None}, 'data': [
        {'value': '32', 'value_classification': 'Fear', 'timestamp': str(int(now.replace(hour=0, minute=0, second=0).timestamp()))},
        {'value': '29', 'value_classification': 'Fear', 'timestamp': str(int(now.replace(hour=0, minute=0, second=0).timestamp())-86400)}]}
    active = {'metadata': {'error': None, 'num_cryptocurrencies': 190, 'timestamp': 1793652343}, 'data': [
        {'name': 'Tether', 'symbol': 'USDT', 'last_updated': stamp, 'quotes': {'USD': {'volume_24h': 43685047200, 'percentage_change_24h': 0.01}}},
        {'name': 'Bitcoin', 'symbol': 'BTC', 'last_updated': stamp, 'quotes': {'USD': {'volume_24h': 25843332715, 'percentage_change_24h': 2.1}}},
        {'name': 'Ethereum', 'symbol': 'ETH', 'last_updated': stamp, 'quotes': {'USD': {'volume_24h': 10517711302}}}]}
    tic = '\n'.join(['Synthetic fixture notice', 'Not production data',
        'country\tcountry_code\tdate\tfor_lt_total_net\tfor_lt_treas_net\tfor_lt_agcy_net\tfor_lt_corp_net\tfor_lt_eqty_net',
        'Other\t12345\t2026-09\t1\t1\t0\t0\t0',
        'Grand Total\t99996\t2026-07\t100\t100\t0\t0\t0',
        'Grand Total\t99996\t2026-08\t300724\t108908\t-3746\t41620\t153942'])
    atom = '''<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><entry>
      <title>Payroll employment rises by 165,000 in October; unemployment rate changes little at 4.1%</title>
      <published>2026-11-06T07:50:31.965-05:00</published><updated>2026-11-06T07:50:31.965-05:00</updated>
      <link href="https://www.bls.gov/news.release/archives/empsit_11062026.htm"/>
      </entry></feed>'''
    ics = '''BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
DTSTART;TZID=US-Eastern:20261110T083000
SUMMARY:Consumer Price Index
END:VEVENT
BEGIN:VEVENT
DTSTART;TZID=US-Eastern:20261113T083000
SUMMARY:Producer Price Index
END:VEVENT
BEGIN:VEVENT
DTSTART;TZID=US-Eastern:20261106T083000
SUMMARY:Employment Situation
END:VEVENT
END:VCALENDAR
'''
    return {c.FNG: (json.dumps(fng).encode(), {}), c.CSI: (b'%PDF-fixture', {}),
            c.TIC: (tic.encode(), {'last-modified': 'Fri, 16 Oct 2026 20:06:51 GMT'}),
            c.TICKER: (json.dumps(active).encode(), {}), c.BLS_FEED: (atom.encode(), {}), c.BLS_CAL: (ics.encode(), {})}


def run(previous=None, now=NOW, errors=None, payloads=None):
    data = fixtures(now) if payloads is None else payloads
    calls = []
    def fetch(url):
        calls.append(url)
        if errors and url in errors:
            raise c.SourceError(errors[url])
        return data[url]
    with mock.patch.object(c, 'parse_valuation', side_effect=lambda body, n: c.parse_valuation_text(LAYOUT, n)):
        result = c.collect(previous, fetch=fetch, clock=lambda: now)
    return result, calls


class CollectorTests(unittest.TestCase):
    def test_all_five_sources_normalize_without_price_or_performance_invention(self):
        result, calls = run()
        self.assertEqual(len(calls), 6)
        self.assertEqual([r['status'] for r in result['cards'].values()], ['ready']*5)
        self.assertEqual(result['cards']['sentiment']['data']['value'], 32)
        self.assertEqual(result['cards']['valuation']['data']['pb'], 1.3)
        self.assertEqual(result['cards']['flows']['data']['netMillions'], 300724)
        self.assertEqual(result['cards']['active']['data']['items'][0]['symbol'], 'USDT')
        self.assertEqual(result['cards']['macro']['data']['events'][0]['startAt'], '2026-11-10T13:30:00Z')
        self.assertEqual(result['sourceStops'], {})

    def test_factsheet_layout_uses_named_metrics_not_neighboring_columns(self):
        data, as_of = c.parse_valuation_text(LAYOUT, NOW)
        self.assertEqual(data['pe'], 12.61)
        self.assertEqual(data['pb'], 1.3)
        self.assertEqual(data['dividendYield'], 2.73)
        self.assertEqual(as_of, '2026-10-29T16:00:00Z')
        for bad in [LAYOUT.replace('000300', '000001'), LAYOUT.replace('沪深300指数', '其他指数'), LAYOUT+'市净率 2.4\n', LAYOUT.replace('2026年10月30日', '2027年10月30日')]:
            with self.assertRaises(c.SourceError): c.parse_valuation_text(bad, NOW)

    def test_pdf_reader_requires_layout_mode_and_rejects_bad_bodies(self):
        page = mock.Mock(); page.extract_text.return_value = LAYOUT
        reader = mock.Mock(is_encrypted=False, pages=[page])
        with mock.patch('pypdf.PdfReader', return_value=reader):
            self.assertEqual(c.parse_valuation(b'%PDF-mock', NOW)[0]['pe'], 12.61)
        page.extract_text.assert_called_once_with(extraction_mode='layout')
        with self.assertRaises(c.SourceError): c.parse_valuation(b'<html>blocked</html>', NOW)

    def test_sentiment_rejects_bad_classification_future_order_and_nonfinite(self):
        original = json.loads(fixtures()[c.FNG][0])
        for mutate in [lambda p: p['data'][0].update(value='NaN'), lambda p: p['data'][0].update(value='101'),
                       lambda p: p['data'][0].update(value_classification='Buy now'),
                       lambda p: p['data'][0].update(timestamp='99999999999'),
                       lambda p: p['data'][1].update(timestamp=p['data'][0]['timestamp']),
                       lambda p: p['metadata'].update(error='denied')]:
            p = copy.deepcopy(original); mutate(p)
            with self.assertRaises(c.SourceError): c.parse_sentiment(json.dumps(p).encode(), NOW)

    def test_tic_uses_latest_grand_total_and_preserves_units_and_release_time(self):
        result, _ = run()
        card = result['cards']['flows']
        self.assertEqual(card['data']['period'], '2026-08')
        self.assertEqual(card['data']['netMillions']/100, 3007.24)
        self.assertEqual(card['data']['agencyMillions'], -3746)
        self.assertEqual(card['asOf'], '2026-08-31T00:00:00Z')
        self.assertEqual(card['sourceUpdatedAt'], '2026-10-16T20:06:51Z')
        self.assertNotEqual(card['fetchedAt'], card['sourceUpdatedAt'])

    def test_tic_rejects_duplicate_total_wrong_fields_and_inconsistent_units(self):
        body = fixtures()[c.TIC][0].decode()
        for bad in [body+'\n'+body.splitlines()[-1], body.replace('for_lt_total_net', 'position_change'),
                    body.replace('300724', '300.724'), body.replace('2026-08', '2026-13')]:
            with self.assertRaises(c.SourceError): c.parse_flows(bad.encode(), NOW)
        data, _ = c.parse_flows(body.replace('-3746', 'n.a.').encode(), NOW)
        self.assertIsNone(data['agencyMillions'])

    def test_active_uses_individual_update_times_and_includes_stablecoins(self):
        data, as_of, updated = c.parse_active(fixtures()[c.TICKER][0], NOW)
        self.assertEqual(data['items'][0]['symbol'], 'USDT')
        self.assertEqual(as_of, '2026-11-10T07:58:00Z')
        self.assertEqual(updated, as_of)
        self.assertIsNone(data['items'][2]['change24h'])
        self.assertIn('前10样本', data['universe'])
        self.assertIn('含稳定币', data['universe'])

    def test_active_excludes_old_samples_without_filling_fake_ranks(self):
        p = json.loads(fixtures()[c.TICKER][0]); p['data'][0]['last_updated'] -= 86400
        data, _, _ = c.parse_active(json.dumps(p).encode(), NOW)
        self.assertEqual([x['symbol'] for x in data['items']], ['BTC', 'ETH'])
        p['data'][1]['quotes']['USD']['volume_24h'] = 9e14
        with self.assertRaisesRegex(c.SourceError, 'unsorted'): c.parse_active(json.dumps(p).encode(), NOW)

    def test_active_all_old_or_invalid_numbers_cannot_look_fresh(self):
        original = json.loads(fixtures()[c.TICKER][0])
        p = copy.deepcopy(original)
        for row in p['data']: row['last_updated'] -= 86400
        with self.assertRaisesRegex(c.SourceError, 'no_fresh'): c.parse_active(json.dumps(p).encode(), NOW)
        for value in [float('nan'), -1, None]:
            p = copy.deepcopy(original); p['data'][0]['quotes']['USD']['volume_24h'] = value
            with self.assertRaises(c.SourceError): c.parse_active(json.dumps(p).encode(), NOW)

    def test_calendar_uses_real_dst_filters_past_and_unfolds_lines(self):
        calendar_body = fixtures()[c.BLS_CAL][0]
        self.assertEqual(len(c.parse_calendar(calendar_body, NOW)), 2)
        summer = calendar_body.decode().replace('20261110', '20260710').replace('20261113', '20260713').replace('20261106', '20260706')
        events = c.parse_calendar(summer.encode(), datetime(2026, 7, 1, tzinfo=timezone.utc))
        self.assertEqual(events[0]['startAt'], '2026-07-06T12:30:00Z')
        # RFC 5545 unfolding removes CRLF and the first continuation whitespace;
        # the space between words must remain in the preceding physical line.
        folded = calendar_body.replace(b'Consumer Price Index', b'Consumer Price \r\n Index')
        self.assertEqual(c.parse_calendar(folded, NOW)[0]['title'], 'Consumer Price Index')
        with self.assertRaises(c.SourceError): c.parse_calendar(calendar_body.replace(b'US-Eastern', b'Unknown-Zone'), NOW)

    def test_bls_atom_preserves_publication_not_collection_time_and_blocks_external_links(self):
        body = fixtures()[c.BLS_FEED][0]
        data = c.parse_employment(body, NOW)
        self.assertEqual(data['publishedAt'], '2026-11-06T12:50:31Z')
        for bad in [body.replace(b'https://www.bls.gov/', b'https://untrusted.example/'), body.replace(b'<feed ', b'<!DOCTYPE x><feed ')]:
            with self.assertRaises(c.SourceError): c.parse_employment(bad, NOW)

    def test_fresh_cards_reuse_existing_times_and_make_no_requests(self):
        before, _ = run()
        after, calls = run(before, NOW+timedelta(minutes=20))
        self.assertEqual(calls, [])
        self.assertEqual(before['cards'], after['cards'])
        self.assertNotEqual(before['generatedAt'], after['generatedAt'])

    def test_per_card_intervals_refresh_only_due_sources(self):
        before, _ = run()
        after, calls = run(before, NOW+timedelta(minutes=46))
        self.assertEqual(calls, [c.TICKER])
        self.assertEqual(after['cards']['flows'], before['cards']['flows'])
        after, calls = run(before, NOW+timedelta(hours=7))
        self.assertEqual(set(calls), {c.FNG, c.TICKER, c.BLS_FEED, c.BLS_CAL})

    def test_first_source_refusal_blocks_other_same_host_requests(self):
        result, calls = run(errors={c.FNG: 'http_403'})
        self.assertNotIn(c.TICKER, calls)
        self.assertEqual(result['sourceStops']['api.alternative.me']['code'], 'http_403')
        self.assertEqual(result['cards']['active']['status'], 'unavailable')
        self.assertIsNone(result['cards']['active']['lastAttemptAt'])
        self.assertEqual(result['cards']['valuation']['status'], 'ready')

    def test_persisted_403_and_429_block_before_cache_age_and_never_clear(self):
        for code in ['http_403', 'http_429']:
            first, _ = run(errors={c.FNG: code})
            second, calls = run(first, NOW+timedelta(days=2))
            self.assertNotIn(c.FNG, calls); self.assertNotIn(c.TICKER, calls)
            self.assertEqual(second['sourceStops'], first['sourceStops'])
            self.assertEqual(second['cards']['sentiment']['lastAttemptAt'], first['cards']['sentiment']['lastAttemptAt'])

    def test_network_failure_retains_last_good_values_and_source_times(self):
        before, _ = run()
        after, _ = run(before, NOW+timedelta(hours=7), errors={c.FNG: 'network_error'})
        a, b = after['cards']['sentiment'], before['cards']['sentiment']
        for key in ['data', 'asOf', 'fetchedAt', 'sourceUpdatedAt']: self.assertEqual(a[key], b[key])
        self.assertEqual(a['status'], 'stale'); self.assertEqual(a['errorCode'], 'network_error')
        self.assertNotEqual(a['lastAttemptAt'], b['lastAttemptAt'])
        self.assertEqual(after['sourceStops'], {})

    def test_macro_second_request_failure_keeps_whole_previous_card(self):
        before, _ = run()
        after, _ = run(before, NOW+timedelta(hours=7), errors={c.BLS_CAL: 'http_429'})
        self.assertEqual(after['cards']['macro']['data'], before['cards']['macro']['data'])
        self.assertEqual(after['cards']['macro']['fetchedAt'], before['cards']['macro']['fetchedAt'])
        self.assertEqual(after['sourceStops']['www.bls.gov']['code'], 'http_429')

    def test_first_failure_is_unavailable_not_zero_or_fake_dates(self):
        after, _ = run(errors={c.TIC: 'network_error'})
        card = after['cards']['flows']
        self.assertEqual(card['status'], 'unavailable')
        for key in ['data', 'asOf', 'fetchedAt', 'sourceUpdatedAt']: self.assertIsNone(card[key])

    def test_malformed_previous_or_missing_stop_fails_before_any_fetch(self):
        before, _ = run()
        for mutation in [lambda p: p.pop('sourceStops'), lambda p: p.update(cards=[]),
                         lambda p: p['sourceStops'].update({'unknown.example': {'code': 'http_403', 'at': c.iso(NOW)}}),
                         lambda p: p['cards']['sentiment'].update(errorCode='http_403', status='stale'),
                         lambda p: p['cards']['valuation'].update(asOf='2027-01-01T00:00:00Z')]:
            bad = copy.deepcopy(before); mutation(bad); fetch = mock.Mock()
            with self.assertRaises(c.SourceError): c.collect(bad, fetch=fetch, clock=lambda: NOW)
            fetch.assert_not_called()

    def test_source_regression_cannot_replace_newer_last_good(self):
        before, _ = run()
        payloads = fixtures(NOW+timedelta(hours=7))
        p = json.loads(payloads[c.FNG][0])
        for row in p['data']: row['timestamp'] = str(int(row['timestamp'])-86400)
        payloads[c.FNG] = (json.dumps(p).encode(), {})
        after, _ = run(before, NOW+timedelta(hours=7), payloads=payloads)
        self.assertEqual(after['cards']['sentiment']['errorCode'], 'source_time_regressed')
        self.assertEqual(after['cards']['sentiment']['data'], before['cards']['sentiment']['data'])

    def test_fetch_rejects_unapproved_url_without_opening_network(self):
        with mock.patch.object(c.urllib.request, 'build_opener') as opener:
            for url in ['http://api.alternative.me/fng/?limit=2', 'https://api.alternative.me/fng/?limit=2000', 'https://evil.example/']:
                with self.assertRaises(c.SourceError): c.fetch_url(url)
            opener.assert_not_called()

    def test_http_refusal_body_size_and_redirects_are_bounded_and_not_retried(self):
        for status in [403, 429]:
            opener = mock.Mock(); opener.open.side_effect = urllib.error.HTTPError(c.FNG, status, 'denied', {}, None)
            with mock.patch.object(c.urllib.request, 'build_opener', return_value=opener):
                with self.assertRaisesRegex(c.SourceError, 'http_'+str(status)): c.fetch_url(c.FNG)
            self.assertEqual(opener.open.call_count, 1)
        response = mock.MagicMock(status=200, headers={'Content-Length': str(c.MAX_BYTES+1)})
        response.__enter__.return_value = response
        opener = mock.Mock(); opener.open.return_value = response
        with mock.patch.object(c.urllib.request, 'build_opener', return_value=opener):
            with self.assertRaisesRegex(c.SourceError, 'response_too_large'): c.fetch_url(c.FNG)
        response.read.assert_not_called()
        with self.assertRaisesRegex(c.SourceError, 'redirect_refused'):
            c.NoRedirect().redirect_request(None, None, 302, '', {}, 'https://other.example/')

    def test_stream_size_limit_applies_even_when_content_length_is_missing(self):
        response = mock.MagicMock(status=200, headers={}); response.__enter__.return_value=response
        response.read.return_value=b'x'*(c.MAX_BYTES+1)
        opener=mock.Mock();opener.open.return_value=response
        with mock.patch.object(c.urllib.request, 'build_opener', return_value=opener):
            with self.assertRaisesRegex(c.SourceError, 'response_too_large'): c.fetch_url(c.FNG)
        response.read.assert_called_once_with(c.MAX_BYTES+1)

    def test_receipts_are_optional_strict_and_never_carried_to_a_new_local_run(self):
        self.assertEqual(c.collection_receipt({}), {})
        receipt=c.collection_receipt({'GITHUB_RUN_ID':'12345','GITHUB_RUN_ATTEMPT':'2'})
        self.assertEqual(receipt, {'collectionRunId':'12345','collectionRunAttempt':2,'collectionState':'completed'})
        for env in [{'GITHUB_RUN_ID':'12345'}, {'GITHUB_RUN_ID':'0','GITHUB_RUN_ATTEMPT':'1'}, {'GITHUB_RUN_ID':'1','GITHUB_RUN_ATTEMPT':'-1'}]:
            with self.assertRaises(c.SourceError): c.collection_receipt(env)
        before,_=run();before.update(receipt)
        after,_=run(before,NOW+timedelta(minutes=1))
        self.assertNotIn('collectionRunId',after)
        for mutation in [lambda p:p.pop('collectionRunAttempt'),lambda p:p.update(collectionState='in_progress'),lambda p:p.update(collectionRunAttempt=True)]:
            bad=copy.deepcopy(before);mutation(bad)
            with self.assertRaises(c.SourceError): c.validate_snapshot(bad,NOW)

    def test_atomic_write_and_invalid_old_file_never_touch_production_snapshot(self):
        before,_=run()
        with tempfile.TemporaryDirectory(prefix='books-market-overview-test-') as directory:
            path=Path(directory)/'fixture.json'
            self.assertIsNone(c.load_previous(path,NOW))
            c.write_atomic(path,before)
            self.assertEqual(c.load_previous(path,NOW),before)
            old=path.read_bytes()
            with mock.patch.object(c.os,'replace',side_effect=OSError('test failure')):
                with self.assertRaises(OSError): c.write_atomic(path,dict(before,generatedAt=c.iso(NOW+timedelta(minutes=1))))
            self.assertEqual(path.read_bytes(),old)
            self.assertEqual(list(Path(directory).glob('*.tmp')),[])
            path.write_text('{not valid')
            with self.assertRaises(c.SourceError): c.load_previous(path,NOW)


if __name__ == '__main__':
    unittest.main(verbosity=2)
