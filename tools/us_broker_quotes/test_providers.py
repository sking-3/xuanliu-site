"""Offline contract fixtures only; no real SDK, account, key or network."""
import importlib
import io
import json
import logging
import os
from pathlib import Path
import tempfile
import unittest
from datetime import datetime, timezone
from decimal import Decimal
from types import SimpleNamespace
from unittest.mock import Mock, patch
from urllib.error import HTTPError

from tools.us_broker_quotes import providers as p


NOW = datetime(2026, 11, 13, 15, 31, 10, tzinfo=timezone.utc)
SOURCE = 1794583860000  # 2026-11-13T15:31:00Z
TOKEN = 'SYNTHETIC_ONLY_TOKEN'
KEY = 'A' * 128


class Frame:
    def __init__(self, rows):
        self.rows = rows
    def to_dict(self, orient):
        assert orient == 'records'
        return self.rows


class Response(io.BytesIO):
    def __init__(self, value):
        super().__init__(json.dumps(value).encode())
    def __enter__(self):
        return self
    def __exit__(self, *args):
        self.close()


def rest_row(**updates):
    return {'code': 'US.AAPL', 'name': 'Apple', 'sc_name': '苹果',
            'last_price': '200.5', 'data_time': SOURCE, 'volume': 12345,
            'after_market': {'last_price': 0}, **updates}


class ProviderTests(unittest.TestCase):
    def test_import_and_factory_are_lazy_and_configs_do_not_accept_paths_or_urls(self):
        with patch.object(p.importlib, 'import_module', side_effect=AssertionError('no SDK imports')):
            adapters = [p.create_provider('futu'),
                        p.create_provider('futu', {'transport': 'rest', 'accessToken': TOKEN}),
                        p.create_provider('longbridge', {'appKey': 'a', 'appSecret': 'b', 'accessToken': TOKEN}),
                        p.create_provider('tiger', {'tigerId': '123', 'account': '456', 'privateKey': KEY})]
            for adapter in adapters:
                self.assertNotIn(TOKEN, repr(adapter.metadata))
                adapter.close()
        for name, credentials in [('futu', {'host': 'remote', 'port': 11111}),
                                  ('futu', {'transport': 'rest', 'accessToken': TOKEN, 'url': 'https://evil.test'}),
                                  ('longbridge', {'appKey': 'a', 'appSecret': 'b', 'accessToken': TOKEN, 'logPath': '/tmp/key'}),
                                  ('tiger', {'tigerId': '1', 'account': '2', 'privateKeyPath': '/tmp/key'})]:
            with self.assertRaises(p.BrokerError):
                p.create_provider(name, credentials)

    def test_invalid_symbols_fail_before_any_read(self):
        adapter = p.create_provider('futu')
        with patch.object(adapter, '_read', side_effect=AssertionError('no reads')):
            for values in [[], ['AAPL', 'AAPL'], ['HK.700/evil'], ['AAPL\n'], 'AAPL', [True], ['F' + str(i) for i in range(31)]]:
                with self.assertRaises(p.BrokerError) as caught:
                    adapter.quotes(values)
                self.assertEqual(caught.exception.code, 'broker_invalid_symbols')

    def test_futu_rest_exact_read_post_preserves_source_ms_and_chinese_name(self):
        adapter = p.create_provider('futu', {'transport': 'rest', 'accessToken': TOKEN})
        opener = Mock()
        opener.open.return_value = Response({'ret_code': 0, 'data': {'quote_list': [rest_row()]}})
        with patch.object(p, 'build_opener', return_value=opener), patch.object(p, '_now', return_value=NOW):
            result = adapter.quotes(['AAPL'])[0]
        request = opener.open.call_args.args[0]
        self.assertEqual(request.full_url, p.FUTU_URL)
        self.assertEqual(request.get_method(), 'POST')
        self.assertEqual(json.loads(request.data), {'code_list': ['US.AAPL']})
        self.assertEqual(request.get_header('Authorization'), 'Bearer ' + TOKEN)
        self.assertEqual(result['sourceTime'], '2026-11-13T15:31:00.000Z')
        self.assertEqual(result['rawtime'], SOURCE)
        self.assertEqual(result['receivedAt'], '2026-11-13T15:31:10.000Z')
        self.assertEqual(result['name'], '苹果')
        self.assertEqual(result['price'], 200.5)
        self.assertEqual(result['volumeScope'], 'cumulative_session')
        self.assertFalse(result['minuteBaselineVerified'])
        self.assertIsNone(result['delaySeconds'])
        self.assertNotIn(TOKEN, json.dumps(result))

    def test_missing_fields_and_partial_result_do_not_fabricate_prices_or_times(self):
        adapter = p.create_provider('futu', {'transport': 'rest', 'accessToken': TOKEN})
        opener = Mock()
        opener.open.return_value = Response({'ret_code': 0, 'data': {'quote_list': [rest_row(last_price=0, data_time=0, volume=None)]}})
        with patch.object(p, 'build_opener', return_value=opener), patch.object(p, '_now', return_value=NOW):
            first, missing = adapter.quotes(['AAPL', 'MSFT'])
        self.assertIsNone(first['price'])
        self.assertIsNone(first['sourceTime'])
        self.assertEqual(first['status'], 'pending')
        self.assertIsNone(missing['sourceTime'])
        self.assertIsNone(missing['price'])
        self.assertIn('symbol_not_returned', missing['reasons'])

    def test_unrequested_duplicate_or_malformed_rows_stop_instead_of_switching_source(self):
        for rows in [[rest_row(code='HK.00700')], [rest_row(), rest_row()], [{'code': 'US.AAPL', 'data_time': True}]]:
            adapter = p.create_provider('futu', {'transport': 'rest', 'accessToken': TOKEN})
            opener = Mock()
            opener.open.return_value = Response({'ret_code': 0, 'data': {'quote_list': rows}})
            with patch.object(p, 'build_opener', return_value=opener), patch.object(p, '_now', return_value=NOW):
                if rows[0].get('data_time') is True:
                    self.assertIsNone(adapter.quotes(['AAPL'])[0]['sourceTime'])
                else:
                    with self.assertRaises(p.BrokerError):
                        adapter.quotes(['AAPL'])
                    with self.assertRaises(p.BrokerError):
                        adapter.quotes(['AAPL'])
                    self.assertEqual(opener.open.call_count, 1)

    def test_real_http_403_429_are_sanitized_and_hold_provider(self):
        for status in (403, 429):
            adapter = p.create_provider('futu', {'transport': 'rest', 'accessToken': TOKEN})
            opener = Mock()
            opener.open.side_effect = HTTPError(p.FUTU_URL, status, TOKEN, {}, None)
            with patch.object(p, 'build_opener', return_value=opener):
                for _ in range(2):
                    with self.assertRaises(p.BrokerError) as caught:
                        adapter.quotes(['AAPL'])
                    self.assertEqual(caught.exception.http_status, status)
                    self.assertNotIn(TOKEN, str(caught.exception))
                self.assertEqual(opener.open.call_count, 1)

    def test_business_errors_are_not_reported_as_fake_http_status(self):
        for code, expected in [(-9, 'broker_permission_denied'), (-11, 'broker_rate_limited'), (-7, 'broker_invalid_upstream_symbol')]:
            adapter = p.create_provider('futu', {'transport': 'rest', 'accessToken': TOKEN})
            opener = Mock()
            opener.open.return_value = Response({'ret_code': code, 'ret_msg': TOKEN})
            with patch.object(p, 'build_opener', return_value=opener):
                with self.assertRaises(p.BrokerError) as caught:
                    adapter.quotes(['AAPL'])
                self.assertEqual(caught.exception.code, expected)
                self.assertIsNone(caught.exception.http_status)

    def test_redirect_and_oversize_responses_cannot_forward_credentials(self):
        redirect = p._NoRedirect()
        with self.assertRaises(p.BrokerError):
            redirect.redirect_request(None, None, 302, TOKEN, {}, 'https://evil.test')
        adapter = p.create_provider('futu', {'transport': 'rest', 'accessToken': TOKEN})
        opener = Mock()
        opener.open.return_value = io.BytesIO(b'X' * (p.MAX_RESPONSE + 1))
        with patch.object(p, 'build_opener', return_value=opener):
            with self.assertRaises(p.BrokerError) as caught:
                adapter.quotes(['AAPL'])
            self.assertEqual(caught.exception.code, 'broker_response_too_large')

    def test_futu_opend_is_loopback_fixed_port_and_requires_quote_login(self):
        ctx = Mock()
        ctx.get_global_state.return_value = (0, {'qot_logined': True, 'trd_logined': True, 'user_id': TOKEN})
        ctx.get_market_snapshot.return_value = (0, Frame([{'code': 'US.AAPL', 'name': 'Apple', 'last_price': 200,
                                                         'update_time': '2026-11-13 10:31:00', 'volume': 20}]))
        sdk = SimpleNamespace(OpenQuoteContext=Mock(return_value=ctx))
        with patch.object(p.importlib, 'import_module', return_value=sdk), patch.object(p, '_now', return_value=NOW):
            adapter = p.create_provider('futu')
            row = adapter.quotes(['AAPL'])[0]
            sdk.OpenQuoteContext.assert_called_once_with(host='127.0.0.1', port=11111)
            ctx.get_market_snapshot.assert_called_once_with(['US.AAPL'])
            self.assertEqual(row['sourceTime'], '2026-11-13T15:31:00.000Z')
            self.assertNotIn(TOKEN, json.dumps(row))
            adapter.close()
            ctx.close.assert_called_once()
        ctx = Mock()
        ctx.get_global_state.return_value = (0, {'qot_logined': False})
        sdk.OpenQuoteContext = Mock(return_value=ctx)
        with patch.object(p.importlib, 'import_module', return_value=sdk):
            with self.assertRaises(p.BrokerError):
                p.create_provider('futu').quotes(['AAPL'])
            ctx.get_market_snapshot.assert_not_called()

    def test_longbridge_fixed_signed_http_quote_ignores_ambient_settings_without_sdk(self):
        opener = Mock()
        opener.open.return_value = Response({'code': 0, 'data': {'secu_quote': [
            {'symbol': 'AAPL.US', 'last_done': '200.50', 'timestamp': SOURCE // 1000, 'volume': 123}]}})
        with patch.dict(os.environ, {'LONGBRIDGE_HTTP_URL': 'https://evil.test'}), patch.object(p.importlib, 'import_module', side_effect=AssertionError('no SDK')), patch.object(p, 'build_opener', return_value=opener) as builder, patch.object(p, '_now', return_value=NOW):
            row = p.create_provider('longbridge', {'appKey': 'k', 'appSecret': 's', 'accessToken': TOKEN}).quotes(['AAPL'])[0]
        self.assertEqual(builder.call_args.args[0].proxies, {})
        self.assertIsInstance(builder.call_args.args[1], p._NoRedirect)
        request = opener.open.call_args.args[0]
        self.assertEqual(request.full_url, 'https://openapi.longbridge.cn/quote/quotes')
        self.assertEqual(request.get_method(), 'POST')
        self.assertEqual(request.data, b'{"symbol":["AAPL.US"]}')
        self.assertEqual(request.get_header('Authorization'), TOKEN)  # legacy raw token, no Bearer
        self.assertEqual(request.get_header('X-dc-region'), 'ap')
        self.assertEqual(request.get_header('X-timestamp'), '1794583870')
        self.assertEqual(request.get_header('X-api-signature'),
                         'HMAC-SHA256 SignedHeaders=authorization;x-api-key;x-timestamp, '
                         'Signature=4577bd3c4ead9302adba0d8e037862cbbaa47737fcb2ea99f87ab312b42d53ac')
        self.assertEqual(row['sourceTime'], '2026-11-13T15:31:00.000Z')
        self.assertEqual(row['rawtime'], SOURCE // 1000)
        self.assertEqual(row['receivedAt'], '2026-11-13T15:31:10.000Z')
        self.assertEqual(row['price'], 200.5)
        self.assertEqual(row['volumeScope'], 'cumulative_session')
        self.assertIsNone(row['name'])  # quote response has no name
        self.assertNotIn(TOKEN, json.dumps(row))

    def test_longbridge_signature_matches_official_canonical_bytes_openssl_vector(self):
        # Independent OpenSSL SHA1/SHA256-HMAC oracle over official v5.4.0
        # signature.rs canonical bytes; all credentials here are synthetic.
        credentials = {'appKey': 'k', 'appSecret': 's', 'accessToken': TOKEN}
        signature = p._longbridge_signature(credentials, b'{"symbol":["AAPL.US"]}', '1794583870')
        self.assertTrue(signature.endswith('4577bd3c4ead9302adba0d8e037862cbbaa47737fcb2ea99f87ab312b42d53ac'))
        self.assertNotEqual(signature, p._longbridge_signature(credentials, b'{"symbol":["MSFT.US"]}', '1794583870'))

    def test_longbridge_proto_json_aliases_strings_and_missing_rows_are_preserved(self):
        opener = Mock()
        opener.open.return_value = Response({'code': 0, 'data': {'secuQuote': [
            {'symbol': 'AAPL.US', 'lastDone': '200.50', 'timestamp': str(SOURCE // 1000), 'volume': '123'}]}})
        with patch.object(p, 'build_opener', return_value=opener), patch.object(p, '_now', return_value=NOW):
            first, missing = p.create_provider('longbridge', {'appKey': 'k', 'appSecret': 's', 'accessToken': TOKEN}).quotes(['AAPL', 'MSFT'])
        self.assertEqual(first['sourceTime'], '2026-11-13T15:31:00.000Z')
        self.assertEqual(first['rawtime'], str(SOURCE // 1000))
        self.assertEqual(first['volume'], 123)
        self.assertIsNone(missing['sourceTime'])
        self.assertIsNone(missing['price'])
        self.assertIn('symbol_not_returned', missing['reasons'])

    def test_longbridge_business_permission_and_rate_errors_hold_without_retry_or_fake_http(self):
        for code, expected in [(301604, 'broker_permission_denied'), (301606, 'broker_rate_limited'),
                               (301607, 'broker_rate_limited')]:
            adapter = p.create_provider('longbridge', {'appKey': 'k', 'appSecret': 's', 'accessToken': TOKEN})
            opener = Mock()
            opener.open.return_value = Response({'code': code, 'message': TOKEN})
            with patch.object(p, 'build_opener', return_value=opener):
                for _ in range(2):
                    with self.assertRaises(p.BrokerError) as caught:
                        adapter.quotes(['AAPL'])
                    self.assertEqual(caught.exception.code, expected)
                    self.assertIsNone(caught.exception.http_status)
                    self.assertNotIn(TOKEN, str(caught.exception))
            self.assertEqual(opener.open.call_count, 1)

    def test_longbridge_proto_default_empty_list_and_missing_fields_stay_pending(self):
        fixtures = [{}, {'secuQuote': None}, {'secu_quote': [
            {'symbol': 'AAPL.US', 'last_done': None, 'timestamp': '0', 'volume': None}]}]
        for data in fixtures:
            opener = Mock()
            opener.open.return_value = Response({'code': 0, 'data': data})
            with patch.object(p, 'build_opener', return_value=opener), patch.object(p, '_now', return_value=NOW):
                row = p.create_provider('longbridge', {'appKey': 'k', 'appSecret': 's', 'accessToken': TOKEN}).quotes(['AAPL'])[0]
            self.assertEqual(row['status'], 'pending')
            self.assertIsNone(row['price'])
            self.assertIsNone(row['sourceTime'])

    def test_longbridge_native_http_kind_maps_status_without_guessing_business_codes(self):
        http_kind, openapi_kind = object(), object()
        class OpenApiException(Exception):
            def __init__(self, kind, code):
                super().__init__(TOKEN)
                self.kind, self.code = kind, code
        sdk = SimpleNamespace(OpenApiException=OpenApiException,
                              ErrorKind=SimpleNamespace(Http=http_kind))
        with patch.dict('sys.modules', {'longbridge.openapi': sdk}):
            for status, expected in [(401, 'broker_auth_failed'),
                                     (403, 'broker_permission_denied'),
                                     (429, 'broker_rate_limited')]:
                mapped = p._error(OpenApiException(http_kind, status))
                self.assertEqual((mapped.code, mapped.http_status), (expected, status))
                self.assertNotIn(TOKEN, str(mapped))
            for code, expected in [(301604, 'broker_permission_denied'),
                                   (301606, 'broker_rate_limited'),
                                   (301607, 'broker_rate_limited'),
                                   (403, 'broker_read_failed')]:
                mapped = p._error(OpenApiException(openapi_kind, code))
                self.assertEqual(mapped.code, expected)
                self.assertIsNone(mapped.http_status)
            unrelated = Exception(TOKEN)
            unrelated.kind, unrelated.code = http_kind, 403
            self.assertIsNone(p._error(unrelated).http_status)

    def test_longbridge_single_http_403_429_persist_source_stop_through_bridge_restart(self):
        from tools.us_broker_quotes.server import BridgeError, QuoteBridge
        with tempfile.TemporaryDirectory() as directory:
            for status in (403, 429):
                stop_file = Path(directory) / (str(status) + '.json')
                adapter = p.create_provider('longbridge', {'appKey': 'k', 'appSecret': 's', 'accessToken': TOKEN})
                opener = Mock()
                opener.open.side_effect = HTTPError(p.LONGBRIDGE_URL, status, TOKEN, {}, None)
                bridge = QuoteBridge(stop_file, factory=lambda *_: adapter)
                bridge.connect('longbridge', {})
                with patch.object(p, 'build_opener', return_value=opener), self.assertRaises(BridgeError) as caught:
                    bridge.quotes('longbridge', ['AAPL'])
                self.assertEqual(caught.exception.code, 'provider_source_stopped')
                self.assertEqual(opener.open.call_count, 1)
                self.assertEqual(adapter._credentials, {})
                self.assertNotIn(TOKEN, stop_file.read_text())
                restarted = QuoteBridge(stop_file, factory=Mock(side_effect=AssertionError('no retry')))
                with self.assertRaises(BridgeError) as held:
                    restarted.connect('longbridge', {})
                self.assertEqual(held.exception.code, 'provider_source_stopped')
                self.assertEqual(restarted.stops['longbridge']['reason'], 'http_' + str(status))

    def test_longbridge_mainland_adapter_rejects_foreign_region_and_oauth_without_fallback(self):
        credentials = {'appKey': 'k', 'appSecret': 's', 'accessToken': TOKEN}
        for key in credentials:
            with self.assertRaises(p.BrokerError) as caught:
                p.create_provider('longbridge', {**credentials, key: 'us_synthetic'})
            self.assertEqual(caught.exception.code, 'broker_invalid_credentials')
        with self.assertRaises(p.BrokerError):
            p.create_provider('longbridge', {**credentials, 'accessToken': 'Bearer ' + TOKEN})

    def test_tiger_ram_config_disables_loading_permissions_retries_and_calls_only_delayed(self):
        calls, created = [], []

        class Config:
            def __init__(self, enable_dynamic_domain=True):
                self.enable_dynamic_domain = enable_dynamic_domain
                self._load_env_vars()
                self._load_props()
                self.load_token()
            def _load_env_vars(self):
                raise AssertionError('must not read environment credentials')
            def _load_props(self):
                raise AssertionError('must not read disk config')
            def load_token(self):
                raise AssertionError('must not read disk token')

        class Quote:
            def __init__(self, config, logger, is_grab_permission):
                self.config = config
                created.append(self)
                self.assertions = (logger.disabled, is_grab_permission)
            def _TigerOpenClient__do_post(self, *args):
                raise AssertionError('transport must be replaced')
            def get_stock_delay_briefs(self, symbols):
                calls.append(symbols)
                return Frame([{'symbol': 'AAPL', 'time': SOURCE - 900000, 'close': 200, 'volume': 50}])
            def get_stock_briefs(self, *args):
                raise AssertionError('paid method is forbidden')

        modules = {'tigeropen.tiger_open_config': SimpleNamespace(TigerOpenClientConfig=Config),
                   'tigeropen.quote.quote_client': SimpleNamespace(QuoteClient=Quote, QUOTE_DELAY='quote_delay')}
        pem = '-----BEGIN PRIVATE KEY-----\n' + KEY + '\n-----END PRIVATE KEY-----'
        with patch.object(p.importlib, 'import_module', side_effect=lambda name: modules[name]), patch.object(p, '_now', return_value=NOW):
            adapter = p.create_provider('tiger', {'tigerId': '123', 'account': '456', 'privateKey': pem})
            row = adapter.quotes(['AAPL'])[0]
            client = created[0]
            self.assertEqual(client.assertions, (True, False))
            self.assertFalse(client.config.enable_dynamic_domain)
            self.assertEqual(client.config.retry_max_tries, 0)
            self.assertEqual(client.config.token_refresh_duration, 0)
            self.assertEqual(client.config.private_key, KEY)
            self.assertIsNone(client.config.log_path)
            self.assertEqual(calls, [['AAPL']])
            self.assertEqual(row['delaySeconds'], 900)
            self.assertEqual(row['sourceTime'], '2026-11-13T15:16:00.000Z')
            self.assertNotIn(KEY, json.dumps(row))
            with self.assertRaises(p.BrokerError):
                client._TigerOpenClient__do_post(SimpleNamespace(_method='place_order'), p.TIGER_URL, None, {}, {})
            adapter.close()
            self.assertEqual(client.config.private_key, '')
            self.assertEqual(adapter._credentials, {})

    def test_all_adapters_clear_ram_and_reject_after_close(self):
        adapter = p.create_provider('futu', {'transport': 'rest', 'accessToken': TOKEN})
        adapter.close()
        adapter.close()
        self.assertEqual(adapter._credentials, {})
        with self.assertRaises(p.BrokerError) as caught:
            adapter.quotes(['AAPL'])
        self.assertEqual(caught.exception.code, 'broker_closed')

    def test_time_ambiguity_future_and_missing_volume_remain_pending(self):
        self.assertEqual(p._source_time('2026-11-01 01:30:00', 'eastern'), (None, '2026-11-01 01:30:00'))
        adapter = p.create_provider('futu')
        row = adapter._record('AAPL', 'NaN', SOURCE + 600000, 'ms', None, float('inf'), NOW)
        self.assertIsNone(row['price'])
        self.assertIsNone(row['volume'])
        self.assertEqual(row['status'], 'pending')
        self.assertIn('source_time_future', row['reasons'])


if __name__ == '__main__':
    unittest.main()
