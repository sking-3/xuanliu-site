#!/usr/bin/env python3
"""Read-only Hyperliquid public leaderboard -> bounded Books research snapshot.

No key, proxy, retries, or private endpoints. Run at most every 30 minutes.
On source failure, publish a stale marker while retaining a validated good snapshot.
HTTP Last-Modified describes the leaderboard file, not each account's update time.
"""
from __future__ import annotations

import argparse
import copy
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from email.utils import parsedate_to_datetime
import hashlib
import json
import math
import os
from pathlib import Path
import re
import signal
import tempfile
import time
import urllib.error
import urllib.request

SOURCE_URL = 'https://stats-data.hyperliquid.xyz/Mainnet/leaderboard'
PAGE_URL = 'https://app.hyperliquid.xyz/leaderboard'
ACCOUNT_URL = 'https://app.hyperliquid.xyz/explorer/address/'
MAX_SOURCE_BYTES = 64 * 1024 * 1024
MAX_FEED_BYTES = 2 * 1024 * 1024
MAX_SECONDS = 50
LIMIT = 200
WINDOWS = {'7D': 'week', '30D': 'month', 'ALL': 'allTime'}
ADDRESS = re.compile(r'^0x[0-9a-fA-F]{40}$')
NUMERIC = re.compile(r'^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$')
UTC = timezone.utc


class SourceError(Exception):
    """Short, public-safe failure code; never contains raw source bodies."""


def iso(value: datetime) -> str:
    return value.astimezone(UTC).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def parse_time(value: str) -> datetime:
    if not isinstance(value, str) or len(value) > 40:
        raise SourceError('invalid_timestamp')
    try:
        result = datetime.fromisoformat(value.replace('Z', '+00:00'))
    except ValueError as exc:
        raise SourceError('invalid_timestamp') from exc
    if result.tzinfo is None:
        raise SourceError('invalid_timestamp')
    return result.astimezone(UTC)


def number(value, multiplier=1) -> float:
    if isinstance(value, bool) or not isinstance(value, (str, int, float)):
        raise SourceError('invalid_numeric_field')
    text = str(value)
    if len(text) > 80 or not NUMERIC.fullmatch(text):
        raise SourceError('invalid_numeric_field')
    try:
        value = float(Decimal(text) * multiplier)
    except (InvalidOperation, OverflowError, ValueError) as exc:
        raise SourceError('invalid_numeric_field') from exc
    if not math.isfinite(value) or abs(value) >= 1e15:
        raise SourceError('invalid_numeric_field')
    return value


def snapshot_time(last_modified, fetched_at):
    if not last_modified:
        return None
    try:
        stamp = parsedate_to_datetime(last_modified)
        if stamp.tzinfo is None or stamp > parse_time(fetched_at):
            return None
        return iso(stamp)
    except (TypeError, ValueError, OverflowError):
        return None


def reject_constant(_):
    raise SourceError('invalid_json_number')


def decode(raw: bytes):
    try:
        return json.loads(raw, parse_constant=reject_constant)
    except (UnicodeError, json.JSONDecodeError) as exc:
        raise SourceError('invalid_json') from exc


def normalize(payload, fetched_at, last_modified=None, raw_sha256=None, limit=LIMIT):
    if not 1 <= limit <= LIMIT:
        raise SourceError('invalid_limit')
    fetched_at = iso(parse_time(fetched_at))
    if parse_time(fetched_at) > datetime.now(UTC):
        raise SourceError('future_timestamp')
    if not isinstance(payload, dict) or not isinstance(payload.get('leaderboardRows'), list):
        raise SourceError('invalid_schema')
    raw_rows = payload['leaderboardRows']
    if not raw_rows or len(raw_rows) > 250000:
        raise SourceError('empty_or_oversized_list')
    snapshot_at = snapshot_time(last_modified, fetched_at)
    as_of = snapshot_at or fetched_at
    rows, seen = [], set()
    for item in raw_rows:
        if not isinstance(item, dict):
            raise SourceError('invalid_account')
        address = item.get('ethAddress')
        if not isinstance(address, str) or not ADDRESS.fullmatch(address):
            raise SourceError('invalid_address')
        address = address.lower()
        if address in seen:
            raise SourceError('duplicate_address')
        seen.add(address)
        display_name = item.get('displayName')
        if display_name is not None and not isinstance(display_name, str):
            raise SourceError('invalid_display_name')
        name = (display_name or '').strip()[:100] or address[:8] + '…' + address[-6:]
        performances = item.get('windowPerformances')
        if not isinstance(performances, list) or len(performances) > 20:
            raise SourceError('invalid_windows')
        by_window = {}
        for pair in performances:
            if not isinstance(pair, list) or len(pair) != 2 or not isinstance(pair[0], str) or not isinstance(pair[1], dict) or pair[0] in by_window:
                raise SourceError('invalid_windows')
            by_window[pair[0]] = pair[1]
        windows = {}
        for key, source_period in WINDOWS.items():
            performance = by_window.get(source_period)
            if not isinstance(performance, dict):
                raise SourceError('missing_window')
            windows[key] = {
                'asOf': as_of, 'asOfType': 'source' if snapshot_at else 'observed',
                'sourcePeriod': source_period,
                'roi': number(performance.get('roi'), 100),
                'pnl': number(performance.get('pnl')),
                'mdd': None, 'wins': None, 'closedTrades': None, 'curve': [],
            }
        rows.append({
            'id': 'hl-' + address, 'name': name, 'accountId': address,
            'exchange': 'Hyperliquid', 'currency': 'USD',
            'sourceKind': 'public_account', 'accountValue': number(item.get('accountValue')),
            'featured': False, 'paid': False, 'observedAt': fetched_at,
            'sourceUrl': ACCOUNT_URL + address, 'note': '', 'windows': windows,
            'positions': [], 'points': [], 'orders': [],
        })
    rows.sort(key=lambda row: (-row['windows']['30D']['pnl'], row['accountId']))
    selected = rows[:limit]
    source = {
        'id': 'hyperliquid', 'label': 'Hyperliquid 公开账户', 'url': PAGE_URL,
        'selection': f'按来源月度盈亏选取前 {len(selected)} 个公开账户',
        'totalAccounts': len(rows), 'selectedAccounts': len(selected),
        'fetchedAt': fetched_at, 'snapshotAt': snapshot_at,
        'refreshIntervalMinutes': 30, 'staleAfterMinutes': 120,
        'lastAttemptAt': fetched_at, 'status': 'ok',
    }
    if raw_sha256:
        if not re.fullmatch('[0-9a-f]{64}', raw_sha256):
            raise SourceError('invalid_hash')
        source['rawSha256'] = raw_sha256
    result = {'schemaVersion': 1, 'status': 'ready', 'source': source, 'traders': selected}
    validate_feed(result)
    return result


def validate_feed(feed):
    """Validate collector-owned cache before using it as last-good data."""
    if not isinstance(feed, dict) or feed.get('schemaVersion') != 1 or feed.get('status') != 'ready':
        raise SourceError('invalid_cache')
    rows, source = feed.get('traders'), feed.get('source')
    if not isinstance(rows, list) or not 1 <= len(rows) <= LIMIT or not isinstance(source, dict):
        raise SourceError('invalid_cache')
    if source.get('id') != 'hyperliquid' or source.get('url') != PAGE_URL or source.get('status') not in ('ok', 'stale') or source.get('selectedAccounts') != len(rows):
        raise SourceError('invalid_cache')
    if type(source.get('totalAccounts')) is not int or not len(rows) <= source['totalAccounts'] <= 250000:
        raise SourceError('invalid_cache')
    if source.get('refreshIntervalMinutes') != 30 or source.get('staleAfterMinutes') != 120:
        raise SourceError('invalid_cache')
    for key, maximum in [('label',80),('selection',250)]:
        if not isinstance(source.get(key), str) or not 0 < len(source[key]) <= maximum:
            raise SourceError('invalid_cache')
    fetched_at = parse_time(source.get('fetchedAt'))
    attempted_at = parse_time(source.get('lastAttemptAt'))
    if fetched_at > attempted_at or attempted_at > datetime.now(UTC):
        raise SourceError('invalid_cache')
    snapshot_at = parse_time(source['snapshotAt']) if source.get('snapshotAt') is not None else None
    if snapshot_at and snapshot_at > fetched_at:
        raise SourceError('invalid_cache')
    ids = set()
    for row in rows:
        if not isinstance(row,dict):
            raise SourceError('invalid_cache')
        address = row.get('accountId')
        if not isinstance(address,str) or not ADDRESS.fullmatch(address) or address != address.lower():
            raise SourceError('invalid_cache')
        if row.get('id') != 'hl-' + address or address in ids or row.get('sourceUrl') != ACCOUNT_URL + address:
            raise SourceError('invalid_cache')
        ids.add(address)
        if not isinstance(row.get('name'),str) or not 0 < len(row['name'].strip()) <= 100 or row.get('note') != '':
            raise SourceError('invalid_cache')
        if row.get('exchange') != 'Hyperliquid' or row.get('currency') != 'USD' or row.get('sourceKind') != 'public_account' or row.get('featured') is not False or row.get('paid') is not False:
            raise SourceError('invalid_cache')
        if parse_time(row.get('observedAt')) != fetched_at:
            raise SourceError('invalid_cache')
        if type(row.get('accountValue')) not in (float,int):
            raise SourceError('invalid_cache')
        number(row['accountValue'])
        if not isinstance(row.get('windows'),dict) or set(row['windows']) != set(WINDOWS):
            raise SourceError('invalid_cache')
        for key,source_period in WINDOWS.items():
            window=row['windows'][key]
            if not isinstance(window,dict) or window.get('sourcePeriod') != source_period or parse_time(window.get('asOf')) != (snapshot_at or fetched_at) or window.get('asOfType') != ('source' if snapshot_at else 'observed'):
                raise SourceError('invalid_cache')
            for metric in ('roi','pnl'):
                if type(window.get(metric)) not in (float,int):
                    raise SourceError('invalid_cache')
                number(window[metric])
            if any(window.get(key) is not None for key in ('mdd','wins','closedTrades')) or window.get('curve') != []:
                raise SourceError('invalid_cache')
        if any(row.get(key) != [] for key in ('positions','points','orders')):
            raise SourceError('invalid_cache')
    return feed


def failed_snapshot(previous, attempt_at, code):
    attempt_at=iso(parse_time(attempt_at))
    if not isinstance(code,str) or not re.fullmatch('[a-z0-9_]{1,80}',code):
        code='source_error'
    try:
        validate_feed(previous)
        result=copy.deepcopy(previous)
        if parse_time(attempt_at) < parse_time(result['source']['fetchedAt']):
            raise SourceError('invalid_timestamp')
        result['source'].update(status='stale',lastAttemptAt=attempt_at,errorCode=code)
        return result
    except (SourceError,TypeError,KeyError,ValueError):
        return {'schemaVersion':1,'status':'unavailable','reason':'公开账户数据暂不可用。','source':{
            'id':'hyperliquid','label':'Hyperliquid 公开账户','url':PAGE_URL,
            'selection':'按来源月度盈亏选取前 200 个公开账户',
            'totalAccounts':0,'selectedAccounts':0,'fetchedAt':None,'snapshotAt':None,
            'refreshIntervalMinutes':30,'staleAfterMinutes':120,
            'lastAttemptAt':attempt_at,'status':'error','errorCode':code,
        },'traders':[]}


def read_previous(path):
    try:
        if path.stat().st_size > MAX_FEED_BYTES:
            return None
        return decode(path.read_bytes())
    except (OSError,SourceError):
        return None


def atomic_write(path, value):
    raw=(json.dumps(value,ensure_ascii=False,allow_nan=False,separators=(',',':'))+'\n').encode('utf-8')
    if len(raw)>MAX_FEED_BYTES:
        raise SourceError('feed_too_large')
    path.parent.mkdir(parents=True,exist_ok=True)
    temporary=None
    try:
        with tempfile.NamedTemporaryFile(dir=path.parent,prefix='.'+path.name+'.',suffix='.tmp',delete=False) as out:
            temporary=out.name
            out.write(raw);out.flush();os.fsync(out.fileno())
        os.replace(temporary,path)
    finally:
        if temporary and os.path.exists(temporary):
            os.unlink(temporary)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs):
        raise SourceError('redirect_rejected')


def deadline(_signum,_frame):
    raise SourceError('source_timeout')


def fetch_source():
    request=urllib.request.Request(SOURCE_URL,headers={'Accept':'application/json'})
    opener=urllib.request.build_opener(NoRedirect())
    old_handler=None
    timer_enabled=hasattr(signal,'setitimer')
    if timer_enabled:
        old_handler=signal.signal(signal.SIGALRM,deadline)
        signal.setitimer(signal.ITIMER_REAL,MAX_SECONDS)
    start=time.monotonic()
    try:
        with opener.open(request,timeout=15) as response:
            if response.status != 200:
                raise SourceError('http_'+str(response.status))
            content_type=response.headers.get_content_type()
            if content_type != 'application/json':
                raise SourceError('unexpected_content_type')
            length=response.headers.get('Content-Length')
            if length:
                try:
                    if int(length)>MAX_SOURCE_BYTES:
                        raise SourceError('source_too_large')
                except ValueError as exc:
                    raise SourceError('invalid_content_length') from exc
            chunks=[];size=0
            while True:
                chunk=response.read(min(512*1024,MAX_SOURCE_BYTES-size+1))
                if not chunk:break
                chunks.append(chunk);size+=len(chunk)
                if size>MAX_SOURCE_BYTES:raise SourceError('source_too_large')
                if time.monotonic()-start>MAX_SECONDS:raise SourceError('source_timeout')
            return b''.join(chunks),response.headers.get('Last-Modified'),iso(datetime.now(UTC))
    except urllib.error.HTTPError as exc:
        # No retry or response body logging, including access blocks and throttling.
        raise SourceError('http_'+str(exc.code)) from exc
    except (urllib.error.URLError,TimeoutError,OSError) as exc:
        raise SourceError('network_error') from exc
    finally:
        if timer_enabled:
            signal.setitimer(signal.ITIMER_REAL,0)
            signal.signal(signal.SIGALRM,old_handler)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output',type=Path,default=Path(__file__).resolve().parents[1]/'trader'/'feed.json')
    parser.add_argument('--input',type=Path,help='Use an already captured, verified response; no network request.')
    parser.add_argument('--metadata',type=Path,help='Probe metadata required with --input.')
    args=parser.parse_args()
    if bool(args.input) != bool(args.metadata):
        parser.error('--input and --metadata must be supplied together')
    previous=read_previous(args.output)
    attempt_at=iso(datetime.now(UTC))
    try:
        if args.input:
            if args.input.stat().st_size>MAX_SOURCE_BYTES:raise SourceError('source_too_large')
            raw=args.input.read_bytes();meta=decode(args.metadata.read_bytes())
            if meta.get('url') != SOURCE_URL or meta.get('httpStatus') != 200 or meta.get('sha256') != hashlib.sha256(raw).hexdigest():
                raise SourceError('invalid_capture_metadata')
            fetched_at=meta['fetchedAt'];last_modified=meta.get('headers',{}).get('last-modified')
        else:
            raw,last_modified,fetched_at=fetch_source()
        result=normalize(decode(raw),fetched_at,last_modified,hashlib.sha256(raw).hexdigest())
    except SourceError as exc:
        result=failed_snapshot(previous,attempt_at,str(exc))
    except (OSError,KeyError,ValueError,TypeError):
        result=failed_snapshot(previous,attempt_at,'invalid_capture_or_storage')
    atomic_write(args.output,result)
    print(json.dumps({'status':result['source']['status'],'accounts':len(result['traders']),
        'fetchedAt':result['source']['fetchedAt'],'snapshotAt':result['source']['snapshotAt'],
        'errorCode':result['source'].get('errorCode')},ensure_ascii=False))
    # A valid stale/unavailable status file must still deploy. I/O failures above
    # remain nonzero; source failures are explicitly represented in the feed.
    return 0


if __name__=='__main__':
    raise SystemExit(main())
