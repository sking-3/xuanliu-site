"""Explicit, quote-only broker adapters. No SDK imports or requests at import time.

Source contracts (checked 2026-11-15):
* https://open.futunn.com/zh-cn/api/quote/realtime/stock-quote
* https://openapi.futunn.com/futu-api-doc/en/quote/get-market-snapshot.html
* https://open.longbridge.com/docs/quote/pull/quote
* https://github.com/longbridge/openapi/blob/v5.4.0/rust/src/quote/cmd_code.rs
* https://github.com/longbridge/openapi/blob/v5.4.0/rust/crates/httpclient/src/signature.rs
* https://quant.itigerup.com/openapi/en/python/operation/quotation/stock.html
SDK hardening follows the vendors' public Python/Rust source. It deliberately
fails closed on unsupported SDK APIs rather than switching hosts or products.
Published bindings checked: futu-api 10.12.7208, longbridge 5.4.0 and
tigeropen 3.9.1; no account queried.
Longbridge uses that release's documented HTTP contract, not its SDK transport
(which automatically retries HTTP 429). Its API credentials are mainland/AP only.
"""
import base64
import hashlib
import hmac
import importlib
import json
import logging
import math
import re
import sys
import threading
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from urllib.error import HTTPError
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener
from zoneinfo import ZoneInfo


FUTU_URL = 'https://webapi.futunn.com/api/v1.0/quote/stock-quote'
TIGER_URL = 'https://openapi.tigerfintech.com/gateway'
LONGBRIDGE_PATH = '/quote/quotes'
LONGBRIDGE_URL = 'https://openapi.longbridge.cn' + LONGBRIDGE_PATH
MAX_SYMBOLS = 30
MAX_RESPONSE = 2_000_000
UTC = timezone.utc
PUBLIC_ERROR_CODES = frozenset({
    'broker_invalid_symbols', 'broker_invalid_credentials', 'broker_schema',
    'broker_permission_denied', 'broker_rate_limited', 'broker_auth_failed',
    'broker_sdk_missing', 'broker_read_failed', 'broker_closed',
    'broker_response_too_large', 'broker_redirect_refused',
    'broker_invalid_upstream_symbol', 'broker_opend_not_logged_in',
    'broker_quote_unavailable', 'broker_sdk_environment_override',
    'broker_sdk_dotenv_present', 'broker_sdk_unsupported',
    'broker_token_persistence_refused', 'broker_operation_refused',
    'broker_invalid_provider',
})


class BrokerError(Exception):
    """Only the stable code and a known HTTP status may cross the local API."""
    def __init__(self, code, http_status=None):
        if code not in PUBLIC_ERROR_CODES:
            code = 'broker_read_failed'
        super().__init__(code)
        self.code = code
        self.http_status = http_status
        self.status_code = http_status


def _now():
    return datetime.now(UTC)


def _iso(value):
    return value.astimezone(UTC).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def _symbols(values):
    if not isinstance(values, list) or not 1 <= len(values) <= MAX_SYMBOLS:
        raise BrokerError('broker_invalid_symbols')
    if any(not isinstance(s, str) or not re.fullmatch(r'[A-Z][A-Z0-9.-]{0,14}', s)
           for s in values) or len(set(values)) != len(values):
        raise BrokerError('broker_invalid_symbols')
    return values


def _text(value, maximum=200):
    if not isinstance(value, str) or not value or len(value) > maximum:
        return None
    if any(ord(c) < 32 for c in value):
        return None
    return value


def _number(value, positive=False):
    if isinstance(value, bool) or not isinstance(value, (int, float, Decimal, str)):
        return None
    if isinstance(value, str) and (not value or len(value) > 64):
        return None
    try:
        number = float(Decimal(str(value)))
    except (InvalidOperation, ValueError, OverflowError):
        return None
    return number if math.isfinite(number) and number >= 0 and (number > 0 or not positive) else None


def _credential(value, multiline=False):
    if not isinstance(value, str) or not value.strip() or len(value) > (16384 if multiline else 4096):
        raise BrokerError('broker_invalid_credentials')
    if any(ord(c) < 32 and (not multiline or c not in '\n\r') for c in value):
        raise BrokerError('broker_invalid_credentials')
    return value.strip()


def _fields(values, names):
    if not isinstance(values, dict) or set(values) != set(names):
        raise BrokerError('broker_invalid_credentials')
    return {key: _credential(values[key], key == 'privateKey') for key in names}


def _source_time(value, kind):
    """Convert source timestamps only; receipt time is never a fallback."""
    raw = value.isoformat() if isinstance(value, datetime) else value
    if not isinstance(raw, (str, int, float)) or isinstance(raw, bool):
        return None, None
    if isinstance(raw, (float, int)) and not math.isfinite(raw):
        return None, None
    if isinstance(raw, str) and len(raw) > 128:
        return None, None
    try:
        if kind == 'ms':
            seconds = _number(value, positive=True)
            stamp = datetime.fromtimestamp(seconds / 1000, UTC) if seconds is not None else None
        elif kind == 'seconds':
            seconds = _number(value, positive=True)
            stamp = datetime.fromtimestamp(seconds, UTC) if seconds is not None else None
        elif kind == 'eastern':
            stamp = datetime.strptime(value, '%Y-%m-%d %H:%M:%S')
            eastern = ZoneInfo('America/New_York')
            # An ambiguous/nonexistent wall clock has no unique source instant.
            early, late = stamp.replace(tzinfo=eastern, fold=0), stamp.replace(tzinfo=eastern, fold=1)
            if early.utcoffset() != late.utcoffset():
                return None, raw
            stamp = early
        else:
            return None, raw
        if stamp is None or not 2000 <= stamp.year <= 2099:
            return None, raw
        return _iso(stamp), raw
    except (ValueError, TypeError, OverflowError, OSError):
        return None, raw


def _error(error):
    if isinstance(error, BrokerError):
        return error
    status = error.code if isinstance(error, HTTPError) else None
    if status is None:
        for field in ('http_status', 'status_code', 'status'):
            try:
                value = getattr(error, field, None)
            except Exception:
                continue
            if isinstance(value, int) and not isinstance(value, bool) and 100 <= value <= 599:
                status = value
                break
    try:
        code = getattr(error, 'code', None)
    except Exception:
        code = None
    # The official native Longbridge exception exposes HTTP status in `code`,
    # distinguished from business codes by ErrorKind.Http. Inspect an already
    # loaded SDK only; error handling must not import or initialize an SDK.
    sdk = sys.modules.get('longbridge.openapi')
    exception_type = getattr(sdk, 'OpenApiException', None)
    http_kind = getattr(getattr(sdk, 'ErrorKind', None), 'Http', None)
    try:
        if (status is None and isinstance(exception_type, type)
                and isinstance(error, exception_type) and http_kind is not None
                and error.kind == http_kind and type(code) is int and 100 <= code <= 599):
            status = code
    except Exception:
        pass
    if status == 403 or code in (-9, 301604):
        return BrokerError('broker_permission_denied', status)
    if status == 429 or code in (-11, 301606, 301607):
        return BrokerError('broker_rate_limited', status)
    if status == 401:
        return BrokerError('broker_auth_failed', status)
    if isinstance(error, ImportError):
        return BrokerError('broker_sdk_missing')
    return BrokerError('broker_read_failed', status)


def _rows(value):
    if isinstance(value, list):
        rows = value
    elif hasattr(value, 'to_dict'):
        rows = value.to_dict(orient='records')
    else:
        raise BrokerError('broker_schema')
    if not isinstance(rows, list) or len(rows) > MAX_SYMBOLS:
        raise BrokerError('broker_schema')
    return rows


def _get(row, field):
    return row.get(field) if isinstance(row, dict) else getattr(row, field, None)


class _Provider:
    def __init__(self, provider, label, feed, delay, credentials):
        self.metadata = {'provider': provider, 'label': label, 'feed': feed,
                         'coverage': 'broker_us_quote_unverified_venues', 'delaySeconds': delay}
        self._credentials = credentials
        self._context = None
        self._config = None
        self._closed = False
        self._stopped = None
        self._lock = threading.RLock()

    def quotes(self, symbols):
        symbols = _symbols(symbols)
        with self._lock:
            if self._closed:
                raise BrokerError('broker_closed')
            if self._stopped:
                raise self._stopped
            try:
                rows = self._read(symbols)
                received = _now()
                output, found = [], set()
                for row in _rows(rows):
                    symbol, price, timestamp, kind, name, volume = self._values(row)
                    if symbol not in symbols or symbol in found:
                        raise BrokerError('broker_schema')
                    found.add(symbol)
                    output.append(self._record(symbol, price, timestamp, kind, name, volume, received))
                for symbol in symbols:
                    if symbol not in found:
                        output.append(self._record(symbol, None, None, 'ms', None, None, received,
                                                   ['symbol_not_returned']))
                by_symbol = {row['symbol']: row for row in output}
                return [by_symbol[symbol] for symbol in symbols]
            except Exception as error:
                self._stopped = _error(error)
                raise self._stopped from None

    def _record(self, symbol, price, rawtime, kind, name, volume, received, reasons=None):
        source, raw = _source_time(rawtime, kind)
        price, volume = _number(price, True), _number(volume)
        reasons = list(reasons or [])
        if price is None:
            reasons.append('price_missing')
        if source is None:
            reasons.append('source_time_missing_or_ambiguous')
        elif (datetime.fromisoformat(source.replace('Z', '+00:00')) - received).total_seconds() > 5:
            reasons.append('source_time_future')
        elif (received - datetime.fromisoformat(source.replace('Z', '+00:00'))).total_seconds() > (self.metadata['delaySeconds'] or 0) + 120:
            reasons.append('historical_or_stale_quote')
        if volume is None:
            reasons.append('cumulative_volume_missing')
        return {**self.metadata, 'market': 'us', 'symbol': symbol, 'currency': 'USD',
                'price': price, 'name': _text(name), 'volume': volume,
                'volumeScope': 'cumulative_session', 'sourceTime': source, 'rawtime': raw,
                'receivedAt': _iso(received), 'kind': 'broker_snapshot',
                'status': 'pending' if reasons else 'ok', 'reasons': reasons,
                'minuteBaselineVerified': False}

    def close(self):
        with self._lock:
            self._closed = True
            self._credentials.clear()
            self._stopped = None
            context, self._context = self._context, None
            self._config = None
            if context is not None and callable(getattr(context, 'close', None)):
                try:
                    context.close()
                except Exception:
                    pass


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise BrokerError('broker_redirect_refused')


class _FutuRest(_Provider):
    def __init__(self, credentials):
        super().__init__('futu', '富途 · 官方 REST 快照', 'futu_rest_stock_quote', None, credentials)

    def _read(self, symbols):
        request = Request(FUTU_URL, method='POST',
                          data=json.dumps({'code_list': ['US.' + s for s in symbols]}).encode(),
                          headers={'Content-Type': 'application/json',
                                   'Authorization': 'Bearer ' + self._credentials['accessToken']})
        # No environment proxy, redirect, retry or alternate origin.
        opener = build_opener(ProxyHandler({}), _NoRedirect())
        with opener.open(request, timeout=15) as response:
            data = response.read(MAX_RESPONSE + 1)
            if len(data) > MAX_RESPONSE:
                raise BrokerError('broker_response_too_large')
        try:
            value = json.loads(data, parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
        except (ValueError, UnicodeError):
            raise BrokerError('broker_schema') from None
        if not isinstance(value, dict) or type(value.get('ret_code')) is not int:
            raise BrokerError('broker_schema')
        if value['ret_code'] != 0:
            code = { -9: 'broker_permission_denied', -11: 'broker_rate_limited',
                     -7: 'broker_invalid_upstream_symbol' }.get(value['ret_code'], 'broker_read_failed')
            raise BrokerError(code)
        if not isinstance(value.get('data'), dict):
            raise BrokerError('broker_schema')
        return value['data'].get('quote_list')

    def _values(self, row):
        if not isinstance(row, dict):
            raise BrokerError('broker_schema')
        code = row.get('code')
        symbol = code[3:] if isinstance(code, str) and code.startswith('US.') else None
        return symbol, row.get('last_price'), row.get('data_time'), 'ms', \
            row.get('sc_name') or row.get('name'), row.get('volume')


class _FutuOpenD(_Provider):
    def __init__(self):
        super().__init__('futu', '富途 · 本机 OpenD 快照', 'futu_opend_snapshot', None, {})

    def _read(self, symbols):
        if self._context is None:
            sdk = importlib.import_module('futu')
            # The vendor SDK creates its logger during import. Disable it before
            # connecting; the adapter never passes a password or trading key.
            for name in ('FTFileLog', 'FTConsoleLog'):
                logging.getLogger(name).disabled = True
            self._context = sdk.OpenQuoteContext(host='127.0.0.1', port=11111)
        ret, state = self._context.get_global_state()
        if ret != 0 or not isinstance(state, dict) or state.get('qot_logined') is not True:
            raise BrokerError('broker_opend_not_logged_in')
        ret, value = self._context.get_market_snapshot(['US.' + s for s in symbols])
        if ret != 0:
            raise BrokerError('broker_quote_unavailable')
        return value

    def _values(self, row):
        code = _get(row, 'code')
        symbol = code[3:] if isinstance(code, str) and code.startswith('US.') else None
        return symbol, _get(row, 'last_price'), _get(row, 'update_time'), 'eastern', \
            _get(row, 'name'), _get(row, 'volume')


def _longbridge_signature(credentials, body, timestamp):
    # Byte-for-byte legacy API-key signing from official v5.4.0
    # rust/crates/httpclient/src/signature.rs. No token refresh or disk cache.
    signed_headers = 'authorization;x-api-key;x-timestamp'
    signed_values = ('authorization:' + credentials['accessToken'] + '\n'
                     'x-api-key:' + credentials['appKey'] + '\n'
                     'x-timestamp:' + timestamp + '\n')
    canonical = ('POST|' + LONGBRIDGE_PATH + '||' + signed_values + '|'
                 + signed_headers + '|' + hashlib.sha1(body).hexdigest())
    payload = 'HMAC-SHA256|' + hashlib.sha1(canonical.encode('utf-8')).hexdigest()
    signature = hmac.new(credentials['appSecret'].encode('utf-8'),
                         payload.encode('ascii'), hashlib.sha256).hexdigest()
    return 'HMAC-SHA256 SignedHeaders=' + signed_headers + ', Signature=' + signature


class _Longbridge(_Provider):
    def __init__(self, credentials):
        super().__init__('longbridge', '长桥 · 基础美股快照', 'longbridge_basic_quote', None, credentials)

    def _read(self, symbols):
        # The official SDK's HTTP transport retries 429 five times. Use the
        # same documented quote request/signature with strict one-attempt I/O.
        body = json.dumps({'symbol': [s + '.US' for s in symbols]}, separators=(',', ':')).encode('utf-8')
        timestamp = str(int(_now().timestamp()))
        request = Request(LONGBRIDGE_URL, method='POST', data=body,
                          headers={'Content-Type': 'application/json; charset=utf-8',
                                   'Authorization': self._credentials['accessToken'],
                                   'X-Api-Key': self._credentials['appKey'],
                                   'X-Timestamp': timestamp,
                                   'X-DC-Region': 'ap',
                                   'X-Api-Signature': _longbridge_signature(self._credentials, body, timestamp)})
        # Fixed official mainland gateway; no proxy, redirect, retry, SDK/env
        # loading, subscriptions, account APIs, region fallback or token refresh.
        with build_opener(ProxyHandler({}), _NoRedirect()).open(request, timeout=15) as response:
            data = response.read(MAX_RESPONSE + 1)
            if len(data) > MAX_RESPONSE:
                raise BrokerError('broker_response_too_large')
        try:
            value = json.loads(data, parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
        except (ValueError, UnicodeError):
            raise BrokerError('broker_schema') from None
        if not isinstance(value, dict) or type(value.get('code')) is not int:
            raise BrokerError('broker_schema')
        if value['code'] != 0:
            code = {301604: 'broker_permission_denied', 301606: 'broker_rate_limited',
                    301607: 'broker_rate_limited'}.get(value['code'], 'broker_read_failed')
            raise BrokerError(code)
        data = value.get('data')
        if not isinstance(data, dict) or 'secu_quote' in data and 'secuQuote' in data:
            raise BrokerError('broker_schema')
        # Proto-JSON may omit/null a default empty repeated field. Missing
        # symbols then remain pending, with no invented quote or source time.
        rows = data.get('secu_quote', data.get('secuQuote', []))
        return [] if rows is None else rows

    def _values(self, row):
        code = _get(row, 'symbol')
        symbol = code[:-3] if isinstance(code, str) and code.endswith('.US') else None
        if not isinstance(row, dict) or 'last_done' in row and 'lastDone' in row:
            raise BrokerError('broker_schema')
        return symbol, row.get('last_done', row.get('lastDone')), row.get('timestamp'), 'seconds', None, row.get('volume')


def _tiger_key(value):
    text = _credential(value, multiline=True).replace('\r\n', '\n')
    for label in ('RSA PRIVATE KEY', 'PRIVATE KEY'):
        begin, end = '-----BEGIN ' + label + '-----', '-----END ' + label + '-----'
        if text.startswith(begin) and text.endswith(end):
            text = text[len(begin):-len(end)]
            break
    text = ''.join(text.split())
    if not 64 <= len(text) <= 16384:
        raise BrokerError('broker_invalid_credentials')
    try:
        base64.b64decode(text, validate=True)
    except ValueError:
        raise BrokerError('broker_invalid_credentials') from None
    return text


class _Tiger(_Provider):
    def __init__(self, credentials):
        credentials['privateKey'] = _tiger_key(credentials['privateKey'])
        super().__init__('tiger', '老虎 · 免费15分钟延迟快照', 'tiger_free_delayed', 900, credentials)

    def _read(self, symbols):
        if self._context is None:
            config_sdk = importlib.import_module('tigeropen.tiger_open_config')
            quote_sdk = importlib.import_module('tigeropen.quote.quote_client')
            base = config_sdk.TigerOpenClientConfig
            if not all(hasattr(base, name) for name in ('_load_env_vars', '_load_props', 'load_token')):
                raise BrokerError('broker_sdk_unsupported')

            class RamConfig(base):
                def _load_env_vars(self):
                    pass
                def _load_props(self):
                    pass
                def load_token(self):
                    return None
                def store_token(self, token):
                    raise BrokerError('broker_token_persistence_refused')

            config = RamConfig(enable_dynamic_domain=False)
            config.tiger_id = self._credentials['tigerId']
            config.account = self._credentials['account']
            config.private_key = self._credentials['privateKey']
            config.server_url = 'https://openapi.tigerfintech.com/gateway'
            config.quote_server_url = config.server_url
            config.retry_max_tries = 0
            config.retry_max_time = 0
            config.token_refresh_duration = 0
            config.timeout = 15
            config.log_path = None
            config.log_level = None
            quiet = logging.Logger('books_tiger_no_output')
            quiet.addHandler(logging.NullHandler())
            quiet.disabled = True
            quiet.propagate = False
            self._config = config
            if not hasattr(quote_sdk.QuoteClient, '_TigerOpenClient__do_post'):
                raise BrokerError('broker_sdk_unsupported')

            class QuoteOnlyClient(quote_sdk.QuoteClient):
                # Keep the official request model, signing and response verifier;
                # replace only transport to prohibit SDK retries/redirects.
                def _TigerOpenClient__do_post(self, request, url, query_string, headers, params):
                    if (url != TIGER_URL or query_string is not None
                            or getattr(request, '_method', None) != quote_sdk.QUOTE_DELAY):
                        raise BrokerError('broker_operation_refused')
                    req = Request(TIGER_URL, method='POST', headers=headers,
                                  data=json.dumps(params).encode('utf-8'))
                    with build_opener(ProxyHandler({}), _NoRedirect()).open(req, timeout=15) as response:
                        payload = response.read(MAX_RESPONSE + 1)
                        if len(payload) > MAX_RESPONSE:
                            raise BrokerError('broker_response_too_large')
                        return payload

            self._context = QuoteOnlyClient(config, logger=quiet, is_grab_permission=False)
        return self._context.get_stock_delay_briefs(symbols)

    def _values(self, row):
        return _get(row, 'symbol'), _get(row, 'close'), _get(row, 'time'), 'ms', None, _get(row, 'volume')

    def close(self):
        with self._lock:
            if self._config is not None:
                self._config.private_key = ''
                self._config.tiger_id = ''
                self._config.account = ''
            super().close()
            # Official signing helper caches parsed private keys by their contents.
            # Do not import it just for cleanup when the SDK was never loaded.
            module = sys.modules.get('tigeropen.common.util.signature_utils')
            clear = getattr(getattr(module, 'load_private_key', None), 'cache_clear', None)
            if callable(clear):
                clear()


def create_provider(provider, credentials=None):
    """Validate a RAM-only configuration; SDK initialization waits for quotes()."""
    credentials = {} if credentials is None else credentials
    if provider == 'futu':
        if not isinstance(credentials, dict):
            raise BrokerError('broker_invalid_credentials')
        transport = credentials.get('transport', 'opend')
        if transport == 'rest':
            values = _fields(credentials, ('transport', 'accessToken'))
            return _FutuRest({'accessToken': values['accessToken']})
        if transport == 'opend' and set(credentials) <= {'transport'}:
            return _FutuOpenD()
        raise BrokerError('broker_invalid_credentials')
    if provider == 'longbridge':
        values = _fields(credentials, ('appKey', 'appSecret', 'accessToken'))
        if (any(not value.isascii() or value.startswith('us_') for value in values.values())
                or values['accessToken'].startswith('Bearer ')):
            # This explicit mainland/AP adapter does not route foreign-region
            # credentials elsewhere or turn a legacy-key form into OAuth.
            raise BrokerError('broker_invalid_credentials')
        return _Longbridge(values)
    if provider == 'tiger':
        return _Tiger(_fields(credentials, ('tigerId', 'account', 'privateKey')))
    raise BrokerError('broker_invalid_provider')
