"""Offline security/contract tests. No broker SDKs, sockets or live requests."""
import contextlib
from datetime import datetime, timezone
from email.message import Message
import io
import itertools
import json
from pathlib import Path
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from tools.us_broker_quotes import server as s


NOW = '2026-11-15T10:00:00+00:00'


def quote(symbol='AAPL', **changes):
    row = {'provider': 'futu', 'symbol': symbol, 'feed': 'FUTU_SNAPSHOT',
           'coverage': 'us_quote_entitlement', 'delaySeconds': None, 'price': 100,
           'name': 'Apple', 'currency': 'USD', 'volume': 300,
           'volumeScope': 'cumulative_session', 'sourceTime': '2026-11-15T09:59:59+00:00',
           'rawtime': '2026-11-15 09:59:59', 'receivedAt': NOW,
           'status': 'ok', 'reasons': []}
    return dict(row, **changes)


class BrokerFailure(Exception):
    def __init__(self, code='broker_read_failed', http_status=None):
        self.code, self.http_status = code, http_status
        super().__init__('DO_NOT_ECHO_CREDENTIALS')


class Adapter:
    metadata = {'feed': 'FUTU_SNAPSHOT', 'coverage': 'us_quote_entitlement',
                'delaySeconds': None, 'accessToken': 'DO_NOT_ECHO_CREDENTIALS'}

    def __init__(self, records=None, error=None):
        self.records = [quote()] if records is None else records
        self.error, self.closed, self.calls = error, False, []

    def quotes(self, symbols):
        self.calls.append(symbols)
        if self.error:
            raise self.error
        return self.records

    def close(self):
        self.closed = True


class ServerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / 'source-stops.json'
        self.adapters, self.factory_calls = [], []
        self.factory = lambda provider, credentials: self.make_adapter(provider, credentials)
        self.clock = patch.object(s, 'utc_now', return_value=NOW)
        self.clock.start()
        self.addCleanup(self.clock.stop)
        # Ordinary tests are independent manual reads; rate-limit tests replace
        # this deterministic increasing clock with an explicitly shared instant.
        self.ticks = patch.object(s, 'monotonic', side_effect=itertools.count(1000, 100))
        self.ticks.start()
        self.addCleanup(self.ticks.stop)
        self.bridge = s.QuoteBridge(self.path, factory=self.factory)
        self.addCleanup(lambda: self.bridge.disconnect('all'))

    def make_adapter(self, provider, credentials):
        self.factory_calls.append((provider, dict(credentials)))
        adapter = Adapter()
        self.adapters.append(adapter)
        return adapter

    def call(self, route, body=None, origin=s.PUBLIC_ORIGIN, method=None):
        return self.bridge.api(method or ('GET' if body is None else 'POST'), route,
                               origin, 'Bearer ' + self.bridge.pair_token, body)

    def connect(self, adapter=None):
        if adapter is not None:
            self.bridge.factory = lambda *_args: adapter
        return self.call('/api/connect', {'provider': 'futu', 'freeOnlyConfirmed': True, 'credentials':
                         {'transport': 'rest', 'accessToken': 'DO_NOT_ECHO_CREDENTIALS'}},
                         origin=s.LOCAL_ORIGIN)

    def request(self, path='/api/status', method='GET', origin=s.PUBLIC_ORIGIN,
                auth=True, body=None, headers=None, client='127.0.0.1',
                host='127.0.0.1:19355', raw_body=None):
        handler = object.__new__(s.BridgeHandler)
        handler.command, handler.path = method, path
        handler.requestline, handler.request_version = method + ' ' + path, 'HTTP/1.1'
        handler.client_address = (client, 35000)
        handler.connection = SimpleNamespace(settimeout=lambda _seconds: None)
        handler.server = SimpleNamespace(bridge=self.bridge)
        handler.headers = Message()
        default = [('Host', host)]
        if origin is not None:
            default.append(('Origin', origin))
        if auth:
            default.append(('Authorization', 'Bearer ' + self.bridge.pair_token))
        raw = (b'' if body is None else json.dumps(body).encode()) if raw_body is None else raw_body
        if body is not None or raw_body is not None:
            default += [('Content-Type', 'application/json'), ('Content-Length', str(len(raw)))]
        for key, value in default + list(headers or []):
            handler.headers[key] = value
        handler.rfile, handler.wfile = io.BytesIO(raw), io.BytesIO()
        handler.handle_request()
        head, content = handler.wfile.getvalue().split(b'\r\n\r\n', 1)
        lines = head.decode().split('\r\n')
        values = {key.lower(): value.strip() for line in lines[1:]
                  for key, value in [line.split(':', 1)]}
        status = int(lines[0].split()[1])
        return status, values, content

    def assertCode(self, code, callback):
        with self.assertRaises(s.BridgeError) as caught:
            callback()
        self.assertEqual(caught.exception.code, code)

    def test_token_random_and_origin_exact(self):
        other = s.QuoteBridge(self.path, factory=self.factory)
        self.assertNotEqual(self.bridge.pair_token, other.pair_token)
        self.assertRegex(self.bridge.pair_token, r'^[0-9a-f]{64}$')
        for origin in ('null', None, 'https://sking-3.github.io.evil.test', s.DEV_ORIGIN):
            self.assertCode('origin_not_allowed', lambda: self.bridge.authorize(origin, 'Bearer ' + self.bridge.pair_token))
        for token in (None, '', 'Bearer wrong', 'Bearer 秘密'):
            self.assertCode('pairing_required', lambda: self.bridge.authorize(s.PUBLIC_ORIGIN, token))
        dev = s.QuoteBridge(self.path, allow_dev_origin=True)
        dev.authorize(s.DEV_ORIGIN, 'Bearer ' + dev.pair_token)

    def test_remote_credentials_refused_local_connect_metadata_only(self):
        value = {'provider': 'futu', 'credentials': {'accessToken': 'secret'}, 'freeOnlyConfirmed': True}
        self.assertCode('credentials_require_local_management', lambda: self.call('/api/connect', value))
        self.assertFalse(self.factory_calls)
        result = self.connect()
        self.assertNotIn('DO_NOT_ECHO_CREDENTIALS', json.dumps(result))
        self.assertFalse(result['connected']['quotesVerified'])
        status = self.call('/api/status')
        self.assertEqual(status['ordersSent'], 0)
        self.assertFalse(status['backgroundEnabled'])
        self.assertNotIn('accessToken', json.dumps(status))
        self.assertFalse(self.path.exists())

    def test_local_free_access_attestation_required_before_adapter(self):
        value = {'provider': 'futu', 'credentials': {'transport': 'opend'}}
        self.assertCode('invalid_request', lambda: self.call('/api/connect', value, origin=s.LOCAL_ORIGIN))
        for consent in (False, None, 1, 'true'):
            self.assertCode('free_access_confirmation_required', lambda: self.call('/api/connect',
                            dict(value, freeOnlyConfirmed=consent), origin=s.LOCAL_ORIGIN))
        self.assertFalse(self.factory_calls)
        self.assertIn('id="free-only" type="checkbox" required', s.MANAGEMENT)
        self.assertNotIn('type="checkbox" required checked', s.MANAGEMENT)

    def test_routes_methods_and_input_types_fail_before_sdk(self):
        for value in ({'provider': []}, {'provider': {}}, {'provider': 'unknown'}):
            self.assertCode('invalid_provider', lambda: self.call('/api/quotes', value))
        self.assertCode('method_not_allowed', lambda: self.call('/api/connect', {}, method='GET'))
        self.assertCode('route_not_allowed', lambda: self.call('/api/trade', {}))
        self.assertCode('invalid_request', lambda: self.call('/api/quotes', {'provider': 'futu', 'symbols': ['AAPL'], 'url': 'https://evil.test'}))
        self.assertCode('invalid_credentials', lambda: self.call('/api/connect', {'provider': 'futu', 'freeOnlyConfirmed': True, 'credentials': {'url': 'https://evil.test'}}, origin=s.LOCAL_ORIGIN))
        self.assertFalse(self.factory_calls)

    def test_snapshot_contract_no_fake_minute_baseline_or_missing_values(self):
        adapter = Adapter(records=[quote(minuteBaselineVerified=True, kind='minute_bar')])
        self.connect(adapter)
        result = self.call('/api/quotes', {'provider': 'futu', 'symbols': ['AAPL', 'NVDA']})
        row, missing = result['quotes']
        self.assertEqual(row['kind'], 'broker_snapshot')
        self.assertFalse(row['minuteBaselineVerified'])
        self.assertEqual(row['volumeScope'], 'cumulative_session')
        self.assertEqual(missing['status'], 'pending')
        self.assertIsNone(missing['price'])
        self.assertIsNone(missing['sourceTime'])
        self.assertFalse(missing['minuteBaselineVerified'])
        self.assertTrue(self.call('/api/status')['connectedProviders'][0]['quotesVerified'])
        self.assertEqual(adapter.calls, [['AAPL', 'NVDA']])

    def test_actual_provider_rest_shape_passes_bridge_with_numeric_source_time(self):
        from tools.us_broker_quotes import providers as p
        adapter = p.create_provider('futu', {'transport': 'rest', 'accessToken': 'SYNTHETIC_TOKEN'})
        self.connect(adapter)
        source_ms = int(datetime(2026, 11, 15, 9, 59, 59, tzinfo=timezone.utc).timestamp() * 1000)
        rest_rows = [{'code': 'US.AAPL', 'sc_name': '苹果', 'last_price': '100.25',
                      'data_time': source_ms, 'volume': 300}]
        with patch.object(adapter, '_read', return_value=rest_rows), \
                patch.object(p, '_now', return_value=datetime.fromisoformat(NOW)):
            result = self.call('/api/quotes', {'provider': 'futu', 'symbols': ['AAPL']})
        row = result['quotes'][0]
        self.assertEqual(row['status'], 'ok')
        self.assertEqual(row['market'], 'us')
        self.assertEqual(row['rawtime'], source_ms)
        self.assertEqual(row['sourceTime'], '2026-11-15T09:59:59.000Z')
        self.assertEqual(row['name'], '苹果')
        self.assertFalse(row['minuteBaselineVerified'])
        self.assertNotIn('SYNTHETIC_TOKEN', json.dumps(result))

    def test_missing_or_future_time_stays_pending_not_receipt_as_source(self):
        for changes in ({'sourceTime': None}, {'sourceTime': '2026-11-15T10:00:01Z'},
                        {'receivedAt': '2026-11-15T10:00:01Z'}):
            with self.subTest(changes=changes):
                self.connect(Adapter(records=[quote(**changes)]))
                row = self.call('/api/quotes', {'provider': 'futu', 'symbols': ['AAPL']})['quotes'][0]
                self.assertEqual(row['status'], 'pending')
                self.assertTrue(row['reasons'])
                if changes.get('sourceTime', 'present') is None:
                    self.assertIsNone(row['sourceTime'])

    def test_schema_rejects_wrong_currency_scope_duplicates_and_nonnumeric(self):
        bad_records = [[quote(currency='HKD')], [quote(volumeScope='minute')],
                       [quote(), quote()], [quote(symbol='NVDA')], [quote(price=float('nan'))],
                       [quote(price=10 ** 1000)], [quote(sourceTime='2026-11-15 09:00:00')],
                       [quote(name='line\nsecret')], [quote(feed='credential<script>')]]
        for rows in bad_records:
            with self.subTest(rows=repr(rows)[:80]):
                self.connect(Adapter(records=rows))
                self.assertCode('provider_schema_invalid', lambda: self.call('/api/quotes', {'provider': 'futu', 'symbols': ['AAPL']}))

    def test_symbols_reject_nested_duplicates_routes_and_limits(self):
        self.connect()
        for symbols in ([], [['AAPL']], ['AAPL', 'AAPL'], ['aapl'], ['US.AAPL/../trade'], ['A'] * 31, None):
            self.assertCode('invalid_symbols', lambda: self.call('/api/quotes', {'provider': 'futu', 'symbols': symbols}))
        self.assertFalse(self.adapters[0].calls)

    def test_shared_monotonic_gap_survives_tabs_and_disconnect_without_stop(self):
        for provider, interval in s.MIN_INTERVAL.items():
            adapter = Adapter(records=[quote(provider=provider)])
            self.bridge.factory = lambda *_: adapter
            self.bridge.connect(provider, {})
            with patch.object(s, 'monotonic', return_value=1000) as clock:
                self.bridge.quotes(provider, ['AAPL'])
                with self.assertRaises(s.BridgeError) as caught:
                    self.bridge.quotes(provider, ['AAPL'])
                self.assertEqual(caught.exception.code, 'provider_wait')
                self.assertEqual(caught.exception.wait_ms, interval * 1000)
                self.assertEqual(adapter.calls, [['AAPL']])
                self.bridge.disconnect(provider)
                replacement = Adapter(records=[quote(provider=provider)])
                self.bridge.factory = lambda *_: replacement
                self.bridge.connect(provider, {})
                clock.return_value = 1000 + interval - 0.5
                with self.assertRaises(s.BridgeError) as caught:
                    self.bridge.quotes(provider, ['AAPL'])
                self.assertEqual(caught.exception.wait_ms, 500)
                self.assertFalse(replacement.calls)
                clock.return_value = 1000 + interval
                self.bridge.quotes(provider, ['AAPL'])
                self.assertEqual(replacement.calls, [['AAPL']])
            self.assertNotIn(provider, self.bridge.stops)

    def test_local_wait_response_has_wait_ms_and_no_upstream_call(self):
        self.connect()
        with patch.object(s, 'monotonic', return_value=1000):
            self.call('/api/quotes', {'provider': 'futu', 'symbols': ['AAPL']})
            code, _, body = self.request('/api/quotes', method='POST', body={'provider': 'futu', 'symbols': ['AAPL']})
        self.assertEqual(code, 409)
        self.assertEqual(json.loads(body), {'error': 'provider_wait', 'waitMs': 5000})
        self.assertEqual(len(self.adapters[0].calls), 1)
        self.assertFalse(self.path.exists())

    def test_tiger_metadata_normal_and_missing_rows_always_delayed_900(self):
        adapter = Adapter()
        self.assertEqual(self.bridge.metadata('tiger', adapter)['delaySeconds'], 900)
        for claimed_delay in (None, 0, 1, 900):
            rows = self.bridge.normalized_quotes('tiger', ['AAPL', 'NVDA'],
                        [quote(provider='tiger', delaySeconds=claimed_delay)])
            self.assertTrue(all(row['delaySeconds'] == 900 for row in rows))
            self.assertEqual(rows[1]['status'], 'pending')

    def test_http_and_native_permission_stops_survive_restart(self):
        for reason, status, expected in [('broker_read_failed', 403, 'http_403'),
                                          ('broker_read_failed', 429, 'http_429'),
                                          ('broker_permission_denied', None, 'broker_permission_denied'),
                                          ('broker_rate_limited', None, 'broker_rate_limited')]:
            with self.subTest(expected=expected):
                path = Path(self.tmp.name) / (expected + '.json')
                bridge = s.QuoteBridge(path, factory=lambda *_: Adapter(error=BrokerFailure(reason, status)))
                bridge.connect('futu', {})
                self.assertCode('provider_source_stopped', lambda: bridge.quotes('futu', ['AAPL']))
                persisted = path.read_text()
                self.assertNotIn('CREDENTIALS', persisted)
                self.assertEqual(json.loads(persisted)['stops']['futu']['reason'], expected)
                self.assertEqual(path.stat().st_mode & 0o777, 0o600)
                restarted = s.QuoteBridge(path, factory=lambda *_: self.fail('must not retry stopped source'))
                self.assertCode('provider_source_stopped', lambda: restarted.connect('futu', {}))
                restarted.disconnect('all')
                self.assertEqual(len(restarted.status()['sourceStops']), 1)

    def test_factory_denial_latches_and_raw_error_is_not_echoed(self):
        def denied(*_args):
            raise BrokerFailure('broker_permission_denied')
        self.bridge.factory = denied
        self.assertCode('provider_source_stopped', lambda: self.connect())
        self.assertFalse(self.bridge.connections)
        other = s.QuoteBridge(Path(self.tmp.name) / 'other.json', factory=lambda *_: Adapter(error=BrokerFailure('do_not_echo_credentials')))
        other.connect('futu', {})
        self.assertCode('provider_request_failed', lambda: other.quotes('futu', ['AAPL']))
        self.assertFalse(other.stops)

    def test_corrupt_stop_file_fails_closed_and_write_failure_remains_stopped(self):
        self.path.write_text('{broken')
        self.assertCode('source_stop_store_unreadable', lambda: s.QuoteBridge(self.path))
        parent = Path(self.tmp.name) / 'blocked'
        parent.write_text('not a directory')
        bridge = s.QuoteBridge(parent / 'stops.json')
        bridge.stop_source('futu', 'http_429')
        self.assertTrue(bridge.status()['stopPersistenceFailed'])
        self.assertCode('provider_source_stopped', lambda: bridge.connect('futu', {}))

    def test_disconnect_releases_adapter_and_cancels_late_quote(self):
        started, release = threading.Event(), threading.Event()
        adapter = Adapter()
        def waiting(symbols):
            started.set()
            release.wait(2)
            return [quote()]
        adapter.quotes = waiting
        self.connect(adapter)
        result = []
        def read():
            try:
                result.append(self.bridge.quotes('futu', ['AAPL']))
            except s.BridgeError as error:
                result.append(error.code)
        task = threading.Thread(target=read)
        task.start()
        self.assertTrue(started.wait(1))
        self.assertCode('provider_busy', lambda: self.bridge.quotes('futu', ['AAPL']))
        self.call('/api/disconnect', {'provider': 'futu'})
        self.assertTrue(adapter.closed)
        release.set()
        task.join(2)
        self.assertEqual(result, ['connection_cancelled'])
        self.assertFalse(self.call('/api/status')['connectedProviders'])

    def test_http_strict_host_origin_token_and_route(self):
        for headers, origin, auth, path, client, expected in [
                ([('Host', 'evil.test')], s.PUBLIC_ORIGIN, True, '/api/status', '127.0.0.1', 400),
                ([], 'null', True, '/api/status', '127.0.0.1', 403),
                ([], None, True, '/api/status', '127.0.0.1', 403),
                ([], s.PUBLIC_ORIGIN, False, '/api/status', '127.0.0.1', 401),
                ([], s.PUBLIC_ORIGIN, True, '/api/status?token=bad', '127.0.0.1', 404),
                ([], s.PUBLIC_ORIGIN, True, '/api/status', '127.0.0.2', 403)]:
            response = self.request(path, origin=origin, auth=auth, headers=headers, client=client)
            self.assertEqual(response[0], expected)
            self.assertNotIn(self.bridge.pair_token.encode(), response[2])
        status, headers, _ = self.request()
        self.assertEqual(status, 200)
        self.assertEqual(headers['access-control-allow-origin'], s.PUBLIC_ORIGIN)
        self.assertEqual(headers['cache-control'], 'no-store')
        for host in ('localhost:19355', 'evil.test:19355', '127.0.0.1', '127.0.0.1:19356'):
            self.assertEqual(self.request(host=host)[0], 403)

    def test_preflight_allows_only_explicit_origin_methods_headers_no_action(self):
        headers = [('Access-Control-Request-Method', 'POST'),
                   ('Access-Control-Request-Headers', 'authorization, content-type')]
        code, values, body = self.request('/api/quotes', method='OPTIONS', auth=False, headers=headers)
        self.assertEqual(code, 204)
        self.assertEqual(body, b'')
        self.assertEqual(values['access-control-allow-private-network'], 'true')
        self.assertFalse(self.factory_calls)
        for origin in ('https://evil.test', s.DEV_ORIGIN):
            code, values, _ = self.request('/api/quotes', method='OPTIONS', auth=False, origin=origin, headers=headers)
            self.assertEqual(code, 403)
            self.assertNotIn('access-control-allow-origin', values)
        self.assertEqual(self.request('/api/quotes', method='OPTIONS', auth=False,
                         headers=headers + [('Access-Control-Request-Headers', 'x-remote-url')])[0], 400)

    def test_http_body_encoding_duplicate_headers_and_limits(self):
        for headers, expected in [([('Content-Length', '999999')], 413),
                                  ([('Content-Length', '-1')], 400),
                                  ([('Transfer-Encoding', 'chunked')], 400),
                                  ([('Expect', '100-continue')], 400),
                                  ([('Authorization', 'Bearer secret')], 400)]:
            self.assertEqual(self.request('/api/quotes', method='POST', headers=headers)[0], expected)
        self.assertEqual(self.request('/api/quotes', method='POST')[0], 400)
        self.assertEqual(self.request('/api/quotes', method='PUT')[0], 405)
        for raw in (b'{"provider":"futu","provider":"tiger","symbols":["AAPL"]}',
                    b'{"provider":"futu","symbols":[NaN]}', b'\xff'):
            self.assertEqual(self.request('/api/quotes', method='POST', raw_body=raw)[0], 400)
        self.assertFalse(self.factory_calls)

    def test_management_nonce_csp_fragment_and_no_credentials_in_response(self):
        code, headers, raw = self.request('/', origin=None, auth=False)
        page = raw.decode()
        self.assertEqual(code, 200)
        self.assertIn("connect-src 'self'", headers['content-security-policy'])
        self.assertIn("frame-ancestors 'none'", headers['content-security-policy'])
        self.assertNotIn('__NONCE__', page)
        self.assertNotIn(self.bridge.pair_token, page)
        self.assertIn('location.hash', page)
        self.assertIn("history.replaceState(null,'','/')", page)
        self.assertIn("addEventListener('pagehide'", page)
        self.assertNotIn('setInterval', page)
        self.assertNotIn('localStorage', page)
        self.assertNotIn('sessionStorage', page)
        self.assertNotIn("api('/api/status')", page)
        self.assertIn('Tiger API 签名私钥', page)
        self.assertEqual(self.request('/', origin=s.PUBLIC_ORIGIN)[0], 403)

    def test_server_bind_fixed_no_external_interface_and_shutdown_cleanup(self):
        with patch.object(s.ThreadingHTTPServer, '__init__', return_value=None) as init:
            s.QuoteHTTPServer(self.bridge)
        init.assert_called_once_with(('127.0.0.1', 19355), s.BridgeHandler)
        fake_server = SimpleNamespace(serve_forever=lambda: (_ for _ in ()).throw(KeyboardInterrupt()),
                                      server_close=lambda: None)
        with patch.object(s, 'QuoteBridge', return_value=self.bridge), patch.object(s, 'QuoteHTTPServer', return_value=fake_server), \
                patch('sys.argv', ['server.py', '--state-dir', self.tmp.name]), contextlib.redirect_stdout(io.StringIO()) as output:
            self.connect()
            token = self.bridge.pair_token
            s.main()
        self.assertIn(s.LOCAL_ORIGIN + '/#pair=' + token, output.getvalue())
        self.assertNotIn('DO_NOT_ECHO_CREDENTIALS', output.getvalue())
        self.assertEqual(self.bridge.pair_token, '')
        self.assertTrue(self.adapters[0].closed)
        self.assertFalse(self.bridge.connections)


if __name__ == '__main__':
    unittest.main()
