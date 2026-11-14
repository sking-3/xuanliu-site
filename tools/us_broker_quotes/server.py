"""Manually started, loopback-only quote bridge. No timers, orders or SDK installs.

Platform credentials are accepted only by the loopback management page and stay
in provider adapters' RAM. Public-origin requests require the separately paired
Bearer token and can only inspect status, request quotes, or disconnect.
"""
import argparse
import hmac
import json
import math
import os
from pathlib import Path
import re
import secrets
import threading
from time import monotonic
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

BIND, PORT = '127.0.0.1', 19355
LOCAL_ORIGIN = f'http://{BIND}:{PORT}'
PUBLIC_ORIGIN = 'https://sking-3.github.io'
DEV_ORIGIN = 'http://127.0.0.1:19346'
BODY_LIMIT = 16384
PROVIDERS = {'futu': '富途 / moomoo', 'longbridge': '长桥', 'tiger': '老虎证券'}
MIN_INTERVAL = {'futu': 5, 'longbridge': 5, 'tiger': 30}
CREDENTIAL_FIELDS = {'futu': {'transport', 'accessToken'},
                     'longbridge': {'appKey', 'appSecret', 'accessToken'},
                     'tiger': {'tigerId', 'account', 'privateKey'}}
ROUTES = {'/': {'GET'}, '/api/status': {'GET'}, '/api/connect': {'POST'},
          '/api/disconnect': {'POST'}, '/api/quotes': {'POST'}}
STOP_REASONS = {'http_403', 'http_429', 'broker_permission_denied', 'broker_rate_limited'}
PUBLIC_ERRORS = {'broker_auth_failed', 'broker_closed', 'broker_invalid_credentials',
                 'broker_invalid_provider', 'broker_invalid_symbols', 'broker_invalid_upstream_symbol',
                 'broker_opend_not_logged_in', 'broker_operation_refused', 'broker_quote_unavailable',
                 'broker_read_failed', 'broker_redirect_refused', 'broker_response_too_large',
                 'broker_schema', 'broker_sdk_dotenv_present', 'broker_sdk_environment_override',
                 'broker_sdk_missing', 'broker_sdk_unsupported', 'broker_token_persistence_refused'}
QUOTE_REASONS = {'symbol_not_returned', 'price_missing', 'source_time_missing_or_ambiguous',
                 'source_time_future', 'historical_or_stale_quote', 'cumulative_volume_missing'}


class BridgeError(Exception):
    def __init__(self, code, status=400, wait_ms=None):
        self.code, self.status, self.wait_ms = code, status, wait_ms
        super().__init__(code)


def utc_now():
    return datetime.now(timezone.utc).isoformat()


def timestamp(value):
    if not isinstance(value, str) or len(value) > 64:
        raise BridgeError('provider_schema_invalid', 502)
    try:
        instant = datetime.fromisoformat(value.replace('Z', '+00:00'))
        if instant.utcoffset() is None:
            raise ValueError()
        return instant
    except (ValueError, TypeError):
        raise BridgeError('provider_schema_invalid', 502) from None


def finite(value):
    try:
        return type(value) in (int, float) and math.isfinite(value)
    except OverflowError:
        return False


def provider_factory(name, credentials):
    # Importing the service never imports or installs an optional SDK.
    if __package__:
        from .providers import create_provider
    else:
        from providers import create_provider
    return create_provider(name, credentials)


def close_adapter(adapter):
    try:
        adapter.close()
    except Exception:
        pass  # Never log SDK exceptions, which may contain credentials.


def load_stops(path):
    if not path.exists():
        return {}
    try:
        if path.stat().st_size > 8192:
            raise ValueError()
        data = json.loads(path.read_text('utf-8'))
        if data.get('schema') != 'books.us-broker.source-stops.v1' or not isinstance(data.get('stops'), dict):
            raise ValueError()
        stops = data['stops']
        if any(name not in PROVIDERS or not isinstance(row, dict)
               or set(row) != {'reason', 'stoppedAt'}
               or row['reason'] not in STOP_REASONS
               for name, row in stops.items()):
            raise ValueError()
        for row in stops.values():
            timestamp(row['stoppedAt'])
        return stops
    except (OSError, ValueError, TypeError, AttributeError, BridgeError):
        raise BridgeError('source_stop_store_unreadable', 503) from None


class QuoteBridge:
    def __init__(self, stop_file=None, factory=provider_factory, allow_dev_origin=False):
        self.pair_token = secrets.token_hex(32)
        self.factory, self.allow_dev_origin = factory, allow_dev_origin
        self.stop_file = Path(stop_file) if stop_file is not None else Path.home() / '.local/state/books-us-broker-quotes/source-stops.json'
        self.stops = load_stops(self.stop_file)
        self.stop_persistence_failed = False
        self.connections, self.generations, self.busy, self.last_attempt = {}, {}, set(), {}
        self.lock = threading.RLock()

    def allowed_origin(self, origin):
        return origin in {LOCAL_ORIGIN, PUBLIC_ORIGIN} or self.allow_dev_origin and origin == DEV_ORIGIN

    def authorize(self, origin, authorization):
        if not self.allowed_origin(origin):
            raise BridgeError('origin_not_allowed', 403)
        expected = 'Bearer ' + self.pair_token
        if not isinstance(authorization, str) or not authorization.isascii() or len(authorization) > 256 or not hmac.compare_digest(authorization, expected):
            raise BridgeError('pairing_required', 401)

    def metadata(self, name, adapter, verified=False):
        raw = getattr(adapter, 'metadata', {})
        raw = raw if isinstance(raw, dict) else {}
        def field(key, fallback):
            value = raw.get(key)
            return value if isinstance(value, str) and re.fullmatch(r'[A-Za-z0-9_.:/ -]{1,80}', value) else fallback
        delay = 900 if name == 'tiger' else raw.get('delaySeconds')
        return {'provider': name, 'label': PROVIDERS[name], 'feed': field('feed', 'unverified'),
                'delaySeconds': delay if finite(delay) and delay >= 0 else None,
                'coverage': field('coverage', 'provider_entitlement_unverified'), 'quotesVerified': verified}

    def status(self):
        with self.lock:
            connected = [self.metadata(name, entry['adapter'], entry['verified']) for name, entry in self.connections.items()]
            return {'connectedProviders': connected, 'sourceStops': [dict(provider=name, **row) for name, row in sorted(self.stops.items())],
                    'stopPersistenceFailed': self.stop_persistence_failed, 'quoteOnly': True,
                    'backgroundEnabled': False, 'ordersSent': 0}

    def held(self, provider):
        if provider in self.stops:
            raise BridgeError('provider_source_stopped', 409)

    def disconnect(self, provider):
        targets = list(PROVIDERS) if provider == 'all' else [provider]
        adapters = []
        with self.lock:
            for name in targets:
                self.generations[name] = self.generations.get(name, 0) + 1
                entry = self.connections.pop(name, None)
                if entry:
                    adapters.append(entry['adapter'])
        for adapter in adapters:
            close_adapter(adapter)
        return {'disconnected': targets, 'credentialsCleared': True, 'quoteOnly': True, 'ordersSent': 0}

    def stop_source(self, provider, reason):
        with self.lock:
            self.stops.setdefault(provider, {'reason': reason, 'stoppedAt': utc_now()})
            try:
                self.stop_file.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                raw = json.dumps({'schema': 'books.us-broker.source-stops.v1', 'stops': self.stops}, separators=(',', ':'))
                temporary = self.stop_file.with_name(self.stop_file.name + '.' + secrets.token_hex(8) + '.tmp')
                fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                try:
                    with os.fdopen(fd, 'w', encoding='utf-8') as stream:
                        stream.write(raw)
                        stream.flush()
                        os.fsync(stream.fileno())
                    os.replace(temporary, self.stop_file)
                finally:
                    temporary.unlink(missing_ok=True)
            except OSError:
                self.stop_persistence_failed = True
            self.disconnect(provider)

    def provider_error(self, provider, exception):
        status = getattr(exception, 'http_status', None)
        if status not in (403, 429):
            status = getattr(exception, 'status_code', None)
        code = getattr(exception, 'code', None)
        if status in (403, 429):
            self.stop_source(provider, 'http_' + str(status))
            return BridgeError('provider_source_stopped', 409)
        if code in ('broker_permission_denied', 'broker_rate_limited'):
            self.stop_source(provider, code)
            return BridgeError('provider_source_stopped', 409)
        return BridgeError(code if isinstance(code, str) and code in PUBLIC_ERRORS else 'provider_request_failed', 502)

    def connect(self, provider, credentials):
        if not isinstance(provider, str) or provider not in PROVIDERS:
            raise BridgeError('invalid_provider')
        if not isinstance(credentials, dict) or set(credentials) - CREDENTIAL_FIELDS[provider] or any(not isinstance(v, str) or len(v) > 8192 for v in credentials.values()):
            raise BridgeError('invalid_credentials')
        with self.lock:
            self.held(provider)
            if provider in self.busy:
                raise BridgeError('provider_busy', 409)
            self.busy.add(provider)
            self.disconnect(provider)
            generation = self.generations[provider]
        adapter = None
        try:
            adapter = self.factory(provider, dict(credentials))
            with self.lock:
                self.held(provider)
                if generation != self.generations.get(provider):
                    raise BridgeError('connection_cancelled', 409)
                self.connections[provider] = {'adapter': adapter, 'verified': False}
                return {'connected': self.metadata(provider, adapter), 'quoteOnly': True, 'ordersSent': 0}
        except BridgeError:
            if adapter:
                close_adapter(adapter)
            raise
        except Exception as exception:
            if adapter:
                close_adapter(adapter)
            raise self.provider_error(provider, exception) from None
        finally:
            with self.lock:
                self.busy.discard(provider)

    def normalized_quotes(self, provider, symbols, records):
        if not isinstance(records, list) or len(records) > len(symbols):
            raise BridgeError('provider_schema_invalid', 502)
        found, received = {}, utc_now()
        for record in records:
            if not isinstance(record, dict) or record.get('provider') != provider or record.get('symbol') not in symbols or record['symbol'] in found:
                raise BridgeError('provider_schema_invalid', 502)
            row = {'provider': provider, 'market': 'us', 'symbol': record['symbol'], 'currency': 'USD',
                   'volumeScope': 'cumulative_session', 'kind': 'broker_snapshot', 'minuteBaselineVerified': False}
            for key in ('feed', 'coverage'):
                value = record.get(key)
                if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9_.:/ -]{1,80}', value):
                    raise BridgeError('provider_schema_invalid', 502)
                row[key] = value
            for key in ('price', 'volume', 'delaySeconds'):
                value = record.get(key)
                if value is not None and (not finite(value) or value < 0 or key == 'price' and value == 0):
                    raise BridgeError('provider_schema_invalid', 502)
                row[key] = value
            if provider == 'tiger':
                row['delaySeconds'] = 900
            name, rawtime = record.get('name'), record.get('rawtime')
            safe_text = lambda value: isinstance(value, str) and len(value) <= 200 and not any(ord(c) < 32 for c in value)
            if name is not None and not safe_text(name) or rawtime is not None and not (safe_text(rawtime) or finite(rawtime)):
                raise BridgeError('provider_schema_invalid', 502)
            row.update(name=name, rawtime=rawtime)
            source, receipt = record.get('sourceTime'), record.get('receivedAt')
            source_at = timestamp(source) if source is not None else None
            receipt_at = timestamp(receipt) if receipt is not None else timestamp(received)
            row.update(sourceTime=source, receivedAt=receipt or received)
            reasons = record.get('reasons', [])
            if not isinstance(reasons, list) or len(reasons) > 20:
                raise BridgeError('provider_schema_invalid', 502)
            row['reasons'] = [v for v in reasons if isinstance(v, str) and v in QUOTE_REASONS]
            row['status'] = 'ok' if record.get('status') == 'ok' and row['price'] is not None and source is not None else 'pending'
            if source_at is not None and source_at > receipt_at or receipt_at > timestamp(received):
                row['status'] = 'pending'
                row['reasons'].append('quote_time_unverified')
            if row['status'] == 'pending' and not row['reasons']:
                row['reasons'] = ['quote_evidence_incomplete']
            if record.get('currency') != 'USD' or record.get('volumeScope') != 'cumulative_session':
                raise BridgeError('provider_schema_invalid', 502)
            found[row['symbol']] = row
        return [found.get(symbol, {'provider': provider, 'market': 'us', 'symbol': symbol, 'currency': 'USD', 'price': None,
                'name': None, 'volume': None, 'volumeScope': 'cumulative_session', 'sourceTime': None,
                'rawtime': None, 'receivedAt': received, 'feed': 'unverified', 'coverage': 'unverified',
                'delaySeconds': 900 if provider == 'tiger' else None, 'status': 'pending', 'reasons': ['quote_missing'],
                'kind': 'broker_snapshot', 'minuteBaselineVerified': False}) for symbol in symbols]

    def quotes(self, provider, symbols):
        if not isinstance(symbols, list) or not 1 <= len(symbols) <= 30 or any(not isinstance(s, str) or not re.fullmatch(r'[A-Z][A-Z0-9.-]{0,14}', s) for s in symbols) or len(set(symbols)) != len(symbols):
            raise BridgeError('invalid_symbols')
        with self.lock:
            self.held(provider)
            if provider not in self.connections:
                raise BridgeError('provider_not_connected', 409)
            now = monotonic()
            previous = self.last_attempt.get(provider)
            remaining = MIN_INTERVAL[provider] - (now - previous) if previous is not None else 0
            if remaining > 0:
                raise BridgeError('provider_wait', 409, math.ceil(remaining * 1000))
            if provider in self.busy:
                raise BridgeError('provider_busy', 409)
            entry = self.connections[provider]
            generation = self.generations[provider]
            self.busy.add(provider)
            self.last_attempt[provider] = now
        try:
            rows = self.normalized_quotes(provider, symbols, entry['adapter'].quotes(list(symbols)))
            with self.lock:
                self.held(provider)
                if self.connections.get(provider) is not entry or generation != self.generations.get(provider):
                    raise BridgeError('connection_cancelled', 409)
                entry['verified'] = any(row['status'] == 'ok' for row in rows)
            return {'provider': provider, 'receivedAt': utc_now(), 'quotes': rows, 'quoteOnly': True, 'ordersSent': 0}
        except BridgeError:
            raise
        except Exception as exception:
            raise self.provider_error(provider, exception) from None
        finally:
            with self.lock:
                self.busy.discard(provider)

    def api(self, method, route, origin, authorization, value=None):
        self.authorize(origin, authorization)
        if route not in ROUTES or not route.startswith('/api/'):
            raise BridgeError('route_not_allowed', 404)
        if method not in ROUTES[route]:
            raise BridgeError('method_not_allowed', 405)
        if route == '/api/status' and method == 'GET':
            return self.status()
        if not isinstance(value, dict):
            raise BridgeError('invalid_json')
        provider = value.get('provider')
        if not isinstance(provider, str) or provider not in PROVIDERS and not (route == '/api/disconnect' and provider == 'all'):
            raise BridgeError('invalid_provider')
        if route == '/api/connect':
            if origin != LOCAL_ORIGIN:
                raise BridgeError('credentials_require_local_management', 403)
            if set(value) != {'provider', 'credentials', 'freeOnlyConfirmed'}:
                raise BridgeError('invalid_request')
            if value['freeOnlyConfirmed'] is not True:
                raise BridgeError('free_access_confirmation_required')
            return self.connect(provider, value['credentials'])
        if route == '/api/disconnect':
            if set(value) != {'provider'}:
                raise BridgeError('invalid_request')
            return self.disconnect(provider)
        if route == '/api/quotes':
            if set(value) != {'provider', 'symbols'}:
                raise BridgeError('invalid_request')
            return self.quotes(provider, value['symbols'])
        raise BridgeError('route_not_allowed', 404)


MANAGEMENT = '''<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>Books 本机行情管理</title><style nonce="__NONCE__">body{font:16px system-ui;max-width:760px;margin:32px auto;padding:0 20px;color:#17313a}label{display:block;margin:12px 0}input,textarea,select,button{font:inherit;max-width:100%;padding:8px}input,textarea{box-sizing:border-box;width:100%}input[type=checkbox]{width:auto}button{margin:4px}pre{white-space:pre-wrap}fieldset{margin:12px 0;border:1px solid #ccd8dd}textarea{height:110px}</style></head><body><h1>本机只读行情管理</h1><p>服务只监听 127.0.0.1:19355。平台凭证只在此本机页面输入并保留 RAM；不读取电脑密钥文件、不下单、不自动采集。关闭此管理页会清空表单与页面令牌；断开全部或退出服务才清除适配器凭证。</p><button id="copy" type="button">复制浏览器配对令牌</button><p id="notice" role="status">请使用终端打印的本机管理链接打开此页。</p><form id="connect" autocomplete="off"><label>行情平台<select id="provider"><option value="futu">富途 / moomoo</option><option value="longbridge">长桥</option><option value="tiger">老虎证券</option></select></label><fieldset data-provider="futu"><legend>富途行情</legend><label>连接方式<select name="transport"><option value="rest">官方 REST 行情</option><option value="opend">本人 OpenD · 固定 127.0.0.1:11111</option></select></label><label>行情 Access Token<input name="accessToken" type="password" autocomplete="off"></label></fieldset><fieldset data-provider="longbridge" hidden><legend>长桥行情</legend><p>此版使用中国接入点的 AP 区 App Key、Secret 与 Access Token；不接受美国区或 OAuth Bearer 凭证，不自动切换地区。</p><label>App Key<input name="appKey" type="password" autocomplete="off"></label><label>App Secret<input name="appSecret" type="password" autocomplete="off"></label><label>Access Token<input name="accessToken" type="password" autocomplete="off"></label></fieldset><fieldset data-provider="tiger" hidden><legend>老虎行情</legend><label>Tiger ID<input name="tigerId" autocomplete="off"></label><label>行情账户标识<input name="account" autocomplete="off"></label><label>Tiger API 签名私钥（本人输入，仅保留 RAM，非钱包私钥）<textarea name="privateKey" autocomplete="off" spellcheck="false"></textarea></label></fieldset><label><input id="free-only" type="checkbox" required>本人确认只使用账号已享有的免费行情；不购买权限、不升级套餐、不启用交易。</label><button type="submit">连接只读行情</button><button id="disconnect" type="button">断开全部并清除服务内存</button></form><p>连接状态不等于已取得实时行情。免费额度、地区及延迟由本人账户权限决定；403/429 会永久停止对应来源，重连不会清除停止记录。</p><pre id="status" aria-live="polite"></pre><script nonce="__NONCE__">'use strict';(()=>{let token=new URLSearchParams(location.hash.slice(1)).get('pair')||'';history.replaceState(null,'','/');const $=id=>document.getElementById(id),form=$('connect'),provider=$('provider');const notice=text=>$('notice').textContent=text,futuTransport=form.querySelector('[name=transport]'),futuToken=form.querySelector('[name=accessToken]');futuTransport.addEventListener('change',()=>{futuToken.value='';futuToken.disabled=futuTransport.value==='opend';futuToken.parentElement.hidden=futuToken.disabled;$('free-only').checked=false;});function clearInputs(){for(const input of form.querySelectorAll('input:not([type=checkbox]),textarea'))input.value='';$('free-only').checked=false;}function choose(){for(const box of form.querySelectorAll('[data-provider]'))box.hidden=box.dataset.provider!==provider.value;}provider.addEventListener('change',()=>{clearInputs();choose();});async function api(path,value){if(!token)throw Error('需要终端管理链接中的配对令牌');const response=await fetch(path,{method:value===undefined?'GET':'POST',headers:{Authorization:'Bearer '+token,...(value===undefined?{}:{'Content-Type':'application/json'})},credentials:'omit',cache:'no-store',redirect:'error',body:value===undefined?undefined:JSON.stringify(value)});const result=await response.json();if(!response.ok)throw Error(result.error||'请求未完成');return result;}function show(result){$('status').textContent=JSON.stringify(result,null,2);}form.addEventListener('submit',async event=>{event.preventDefault();if(!$('free-only').checked){notice('请先确认本人账号只使用已享有的免费行情。');return;}const credentials={},box=form.querySelector('[data-provider="'+provider.value+'"]');for(const input of box.querySelectorAll('input,textarea,select'))if(!input.disabled&&input.value)credentials[input.name]=input.value;clearInputs();try{show(await api('/api/connect',{provider:provider.value,credentials,freeOnlyConfirmed:true}));notice('只读适配器已连接；未验证的行情权限请在公开站主动读取。');}catch(error){notice(error.message);}finally{for(const key of Object.keys(credentials))credentials[key]='';}});$('disconnect').addEventListener('click',async()=>{clearInputs();try{show(await api('/api/disconnect',{provider:'all'}));notice('服务中的平台凭证已清除。');}catch(error){notice(error.message);}});$('copy').addEventListener('click',async()=>{try{if(!token)throw Error();await navigator.clipboard.writeText(token);notice('配对令牌已复制，仅粘贴到本人公开站的本机桥接输入框。');}catch{notice('无法复制；请从终端管理链接的 #pair= 后复制配对令牌。');}});addEventListener('pagehide',()=>{clearInputs();token='';});if(token){notice('配对令牌已读取；平台凭证仅在本机录入。');}choose();})();</script></body></html>'''


def unique(headers, name):
    values = headers.get_all(name, [])
    if len(values) > 1:
        raise BridgeError('duplicate_header')
    return values[0] if values else None


class BridgeHandler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.0'
    server_version, sys_version = '', ''

    def log_message(self, *_args):
        pass

    def send_error(self, code, message=None, explain=None):
        self.reply(code, {'error': 'invalid_http_request'})

    def reply(self, status, value, origin=None, html=False, preflight=False):
        nonce = secrets.token_urlsafe(18)
        body = b'' if status == 204 else value.replace('__NONCE__', nonce).encode('utf-8') if html else json.dumps(value, ensure_ascii=False, allow_nan=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'text/html; charset=utf-8' if html else 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Content-Security-Policy', "default-src 'none'; script-src 'nonce-" + nonce + "'; style-src 'nonce-" + nonce + "'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'")
        if origin:
            self.send_header('Access-Control-Allow-Origin', origin)
            self.send_header('Vary', 'Origin')
        if preflight:
            self.send_header('Access-Control-Allow-Methods', ', '.join(sorted(ROUTES[self.path])))
            self.send_header('Access-Control-Allow-Headers', 'Authorization, Content-Type')
            self.send_header('Access-Control-Allow-Private-Network', 'true')
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def handle_request(self):
        origin = None
        try:
            self.connection.settimeout(10)
            if self.client_address[0] != BIND or unique(self.headers, 'Host') != f'{BIND}:{PORT}':
                raise BridgeError('host_not_allowed', 403)
            if self.path not in ROUTES:
                raise BridgeError('route_not_allowed', 404)
            supplied_origin = unique(self.headers, 'Origin')
            if supplied_origin is not None and self.server.bridge.allowed_origin(supplied_origin):
                origin = supplied_origin
            if unique(self.headers, 'Transfer-Encoding') is not None or unique(self.headers, 'Expect') is not None:
                raise BridgeError('unsupported_body_encoding')
            raw_length = unique(self.headers, 'Content-Length')
            if raw_length is not None and not re.fullmatch(r'[0-9]{1,6}', raw_length):
                raise BridgeError('invalid_content_length')
            length = int(raw_length or 0)
            if length > BODY_LIMIT:
                raise BridgeError('body_too_large', 413)
            if self.command == 'OPTIONS':
                method = unique(self.headers, 'Access-Control-Request-Method')
                requested = unique(self.headers, 'Access-Control-Request-Headers') or ''
                if not self.path.startswith('/api/') or origin is None or method not in ROUTES[self.path] or any(v.strip().lower() not in {'authorization', 'content-type'} for v in requested.split(',') if v.strip()) or length:
                    raise BridgeError('preflight_not_allowed', 403)
                self.reply(204, {}, origin, preflight=True)
                return
            if self.command not in ROUTES[self.path]:
                raise BridgeError('method_not_allowed', 405)
            if self.path == '/':
                if length or supplied_origin is not None and supplied_origin != LOCAL_ORIGIN:
                    raise BridgeError('origin_not_allowed', 403)
                self.reply(200, MANAGEMENT, html=True)
                return
            authorization = unique(self.headers, 'Authorization')
            self.server.bridge.authorize(supplied_origin, authorization)
            value = None
            if self.command == 'POST':
                content_type = unique(self.headers, 'Content-Type')
                if raw_length is None or not length or content_type not in ('application/json', 'application/json; charset=utf-8'):
                    raise BridgeError('json_body_required')
                raw = self.rfile.read(length)
                if len(raw) != length:
                    raise BridgeError('body_incomplete')
                def pairs(values):
                    result = {}
                    for key, item in values:
                        if key in result:
                            raise ValueError()
                        result[key] = item
                    return result
                try:
                    value = json.loads(raw.decode('utf-8'), object_pairs_hook=pairs, parse_constant=lambda _v: (_ for _ in ()).throw(ValueError()))
                except (ValueError, UnicodeError):
                    raise BridgeError('invalid_json') from None
            elif length:
                raise BridgeError('unexpected_body')
            self.reply(200, self.server.bridge.api(self.command, self.path, supplied_origin, authorization, value), origin)
        except BridgeError as error:
            result = {'error': error.code}
            if error.wait_ms is not None:
                result['waitMs'] = error.wait_ms
            self.reply(error.status, result, origin)
        except Exception:
            self.reply(500, {'error': 'bridge_request_failed'}, origin)

    do_GET = do_POST = do_OPTIONS = do_HEAD = do_PUT = do_PATCH = do_DELETE = do_TRACE = do_CONNECT = handle_request


class QuoteHTTPServer(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 8

    def __init__(self, bridge):
        self.bridge = bridge
        super().__init__((BIND, PORT), BridgeHandler)

    def handle_error(self, _request, _client_address):
        pass  # No request/query/header/SDK traceback logging.


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--allow-dev-origin', action='store_true', help='also allow the explicit local preview origin 127.0.0.1:19346')
    parser.add_argument('--state-dir', type=Path, default=Path.home() / '.local/state/books-us-broker-quotes')
    args = parser.parse_args()
    bridge = server = None
    try:
        bridge = QuoteBridge(args.state_dir / 'source-stops.json', allow_dev_origin=args.allow_dev_origin)
        server = QuoteHTTPServer(bridge)
        print('Books quote-only bridge; manually started; no background collection or orders.', flush=True)
        # The only token output is this explicitly requested local management URL.
        print(LOCAL_ORIGIN + '/#pair=' + bridge.pair_token, flush=True)
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    except (OSError, BridgeError):
        print('Bridge not started: check port 19355 and the local source-stop store.', flush=True)
    finally:
        if server:
            server.server_close()
        if bridge:
            bridge.disconnect('all')
            bridge.pair_token = ''


if __name__ == '__main__':
    main()
