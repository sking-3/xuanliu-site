#!/usr/bin/env python3
"""Low-frequency, read-only public statistics for the five overview cards.

No keys, proxies, retries, trading requests, or synthetic production values.
HTTP 403/429 stops are persisted by host and never automatically cleared.
"""
from __future__ import annotations

import argparse
import calendar
import copy
import csv
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from email.utils import parsedate_to_datetime
import io
import json
import math
import os
from pathlib import Path
import re
import tempfile
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from zoneinfo import ZoneInfo

UTC = timezone.utc
CARD_IDS = ('sentiment', 'valuation', 'flows', 'active', 'macro')
MAX_BYTES = 2 * 1024 * 1024
TIMEOUT = 20
FETCH_INTERVALS = {'sentiment': 6*3600, 'valuation': 24*3600, 'flows': 24*3600,
                   'active': 45*60, 'macro': 6*3600}
MAX_SOURCE_AGE = {'sentiment': 3*86400, 'valuation': 45*86400, 'flows': 120*86400,
                  'active': 2*3600, 'macro': 45*86400}
FNG = 'https://api.alternative.me/fng/?limit=2'
CSI = 'https://oss-ch.csindex.com.cn/static/html/csindex/public/uploads/indices/detail/files/zh_CN/000300factsheet.pdf'
TIC = 'https://ticdata.treasury.gov/resource-center/data-chart-center/tic/Documents/slt_table1.txt'
TICKER = 'https://api.alternative.me/v2/ticker/?limit=10&structure=array&sort=volume_24h'
BLS_FEED = 'https://www.bls.gov/feed/empsit.rss'
BLS_CAL = 'https://www.bls.gov/schedule/news_release/bls.ics'
SOURCES = {
    'sentiment': ('Alternative.me', 'https://alternative.me/crypto/fear-and-greed-index/', (FNG,)),
    'valuation': ('中证指数', CSI, (CSI,)),
    'flows': ('美国财政部 TIC', 'https://home.treasury.gov/data/treasury-international-capital-tic-system-home-page/tic-forms-instructions/securities-a-us-transactions-with-foreign-residents-in-long-term-securities', (TIC,)),
    'active': ('Alternative.me', 'https://alternative.me/crypto/', (TICKER,)),
    'macro': ('美国劳工统计局 BLS', 'https://www.bls.gov/', (BLS_FEED, BLS_CAL)),
}
URLS = frozenset(url for _, _, urls in SOURCES.values() for url in urls)
HOSTS = frozenset(urllib.parse.urlsplit(url).hostname for url in URLS)
STOP_CODES = frozenset(('http_403', 'http_429'))
CLASSIFICATIONS = frozenset(('Extreme Fear', 'Fear', 'Neutral', 'Greed', 'Extreme Greed'))
NUMBER = re.compile(r'^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$')


class SourceError(Exception):
    """Only short public-safe codes are emitted, never source bodies."""


def fail(code='invalid_source'):
    raise SourceError(code)


def iso(value):
    return value.astimezone(UTC).isoformat(timespec='seconds').replace('+00:00', 'Z')


def timestamp(value, now, future=False):
    if not isinstance(value, str) or len(value) > 40:
        fail('invalid_timestamp')
    try:
        parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
    except ValueError:
        fail('invalid_timestamp')
    if parsed.tzinfo is None or parsed.year < 1990:
        fail('invalid_timestamp')
    parsed = parsed.astimezone(UTC)
    if not future and parsed > now + timedelta(minutes=5):
        fail('future_timestamp')
    return parsed


def numeric(value, *, nullable=False, lower=-1e15, upper=1e15):
    if nullable and value in (None, '', 'n.a.', 'N.A.', 'NA'):
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float, str)):
        fail('invalid_numeric')
    token = str(value).strip()
    if len(token) > 80 or not NUMBER.fullmatch(token):
        fail('invalid_numeric')
    try:
        result = float(Decimal(token))
    except (InvalidOperation, OverflowError, ValueError):
        fail('invalid_numeric')
    if not math.isfinite(result) or not lower <= result <= upper:
        fail('invalid_numeric')
    return result


def integer(value, low, high):
    result = numeric(value, lower=low, upper=high)
    if not result.is_integer():
        fail('invalid_integer')
    return int(result)


def short_text(value, limit=300):
    if not isinstance(value, str) or not value.strip() or len(value) > limit:
        fail('invalid_text')
    return ' '.join(value.split())


def unix(value, now):
    seconds = numeric(value, lower=631152000, upper=32503680000)
    try:
        result = datetime.fromtimestamp(seconds, UTC)
    except (ValueError, OverflowError, OSError):
        fail('invalid_timestamp')
    timestamp(iso(result), now)
    return result


def decode(body):
    try:
        return body.decode('utf-8-sig')
    except (UnicodeError, AttributeError):
        fail('invalid_encoding')


def parse_json(body):
    try:
        return json.loads(decode(body), parse_constant=lambda _: fail('invalid_json'))
    except (ValueError, TypeError):
        fail('invalid_json')


def last_modified(headers, now):
    value = headers.get('last-modified') or headers.get('Last-Modified')
    if not value:
        return None
    try:
        parsed = parsedate_to_datetime(value)
        if parsed.tzinfo is None:
            return None
        return iso(timestamp(iso(parsed), now))
    except (ValueError, TypeError, SourceError):
        return None


def parse_sentiment(body, now):
    raw = parse_json(body)
    if not isinstance(raw, dict) or not isinstance(raw.get('metadata'), dict) or raw['metadata'].get('error') is not None:
        fail('invalid_sentiment')
    rows = raw.get('data')
    if not isinstance(rows, list) or not 1 <= len(rows) <= 2 or any(not isinstance(x, dict) for x in rows):
        fail('invalid_sentiment')
    current = rows[0]
    value = integer(current.get('value'), 0, 100)
    classification = current.get('value_classification')
    if classification not in CLASSIFICATIONS:
        fail('invalid_classification')
    as_of = unix(current.get('timestamp'), now)
    previous = None
    if len(rows) > 1:
        previous = integer(rows[1].get('value'), 0, 100)
        if unix(rows[1].get('timestamp'), now) >= as_of:
            fail('invalid_sample_order')
    return {'value': value, 'previous': previous, 'classification': classification}, iso(as_of), iso(as_of)


def parse_valuation_text(layout, now):
    compact = re.sub(r'\s', '', layout)
    if '沪深300指数' not in compact or '000300' not in compact:
        fail('wrong_index')
    date_match = re.search(r'(20\d{2})年\s*(\d{1,2})月\s*(\d{1,2})日', layout)
    if not date_match:
        fail('missing_factsheet_date')
    try:
        d = datetime(*map(int, date_match.groups()), tzinfo=ZoneInfo('Asia/Shanghai'))
    except ValueError:
        fail('invalid_factsheet_date')
    as_of = iso(timestamp(iso(d), now))
    def field(label, max_value):
        # The factsheet has two columns: valuation labels may follow a return
        # column on the same physical line. Match the exact labelled cell,
        # never the first numeric token or PDF's interleaved reading order.
        matches = re.findall(r'(?:^|[ \t]{2,})' + re.escape(label) + r'[ \t]+([0-9]+(?:\.[0-9]+)?)[ \t]*%?(?:[ \t]|$)', layout, re.M)
        if len(matches) != 1:
            fail('ambiguous_factsheet_metric')
        return numeric(matches[0], lower=0, upper=max_value)
    pe, pb, dividend = field('滚动市盈率', 2000), field('市净率', 100), field('股息率', 100)
    if not pe or not pb:
        fail('invalid_valuation')
    return {'name': '沪深300', 'indexCode': '000300', 'pe': pe, 'pb': pb, 'dividendYield': dividend}, as_of


def parse_valuation(body, now):
    if not body.startswith(b'%PDF-'):
        fail('invalid_pdf')
    try:
        from pypdf import PdfReader
        reader = PdfReader(io.BytesIO(body))
        if reader.is_encrypted or not 1 <= len(reader.pages) <= 10:
            fail('invalid_pdf')
        layout = reader.pages[0].extract_text(extraction_mode='layout')
    except SourceError:
        raise
    except Exception:
        fail('invalid_pdf')
    return parse_valuation_text(layout or '', now)


def parse_flows(body, now):
    lines = decode(body).splitlines()
    headers = [i for i, line in enumerate(lines) if line.startswith('country\tcountry_code\tdate\t')]
    if len(headers) != 1:
        fail('invalid_tic_header')
    reader = csv.DictReader(lines[headers[0]:], delimiter='\t')
    fields = {'netMillions': 'for_lt_total_net', 'treasuryMillions': 'for_lt_treas_net',
              'agencyMillions': 'for_lt_agcy_net', 'corporateMillions': 'for_lt_corp_net',
              'equityMillions': 'for_lt_eqty_net'}
    if not set(fields.values()).issubset(reader.fieldnames or []):
        fail('invalid_tic_fields')
    totals = [r for r in reader if r.get('country_code') == '99996']
    if not totals or len(totals) > 3000:
        fail('missing_tic_total')
    for row in totals:
        if not re.fullmatch(r'(?:19|20)\d{2}-(0[1-9]|1[0-2])', row.get('date', '')):
            fail('invalid_tic_period')
    period = max(r['date'] for r in totals)
    latest = [r for r in totals if r['date'] == period]
    if len(latest) != 1:
        fail('duplicate_tic_total')
    year, month = map(int, period.split('-'))
    as_of = iso(datetime(year, month, calendar.monthrange(year, month)[1], tzinfo=UTC))
    timestamp(as_of, now)
    data = {'period': period}
    for key, field in fields.items():
        data[key] = numeric(latest[0].get(field), nullable=key != 'netMillions', lower=-1e10, upper=1e10)
    components = [data[x] for x in fields if x != 'netMillions']
    if all(x is not None for x in components) and abs(sum(components) - data['netMillions']) > 4:
        fail('inconsistent_tic_total')
    return data, as_of


def parse_active(body, now):
    raw = parse_json(body)
    if not isinstance(raw, dict) or not isinstance(raw.get('metadata'), dict) or raw['metadata'].get('error') is not None:
        fail('invalid_ticker')
    rows = raw.get('data')
    if not isinstance(rows, list) or not 1 <= len(rows) <= 10:
        fail('invalid_ticker')
    count = integer(raw['metadata'].get('num_cryptocurrencies'), 1, 100000)
    result, prior_volume, seen = [], math.inf, set()
    for row in rows:
        if not isinstance(row, dict) or not isinstance(row.get('quotes'), dict) or not isinstance(row['quotes'].get('USD'), dict):
            fail('invalid_ticker')
        quote = row['quotes']['USD']
        volume = numeric(quote.get('volume_24h'), lower=0)
        if volume > prior_volume:
            fail('unsorted_ticker')
        prior_volume = volume
        symbol, name = short_text(row.get('symbol'), 24), short_text(row.get('name'), 100)
        if symbol in seen:
            fail('duplicate_ticker')
        seen.add(symbol)
        updated = unix(row.get('last_updated'), now)
        if now - updated > timedelta(minutes=30) or not volume:
            continue
        change = numeric(quote.get('percentage_change_24h'), nullable=True, lower=-100, upper=100000)
        result.append({'symbol': symbol, 'name': name, 'volumeUsd': volume, 'change24h': change, 'lastUpdated': iso(updated)})
    result = result[:3]
    if not result:
        fail('no_fresh_ticker_samples')
    as_of = min(x['lastUpdated'] for x in result)
    # Provider metadata.timestamp can be older than individual ticker updates.
    return {'universe': f'Alternative.me 返回的成交额前10样本 · 收录 {count} 币种 · 含稳定币', 'items': result}, as_of, as_of


def bls_url(value):
    value = short_text(value, 1000)
    p = urllib.parse.urlsplit(value)
    if p.scheme != 'https' or p.hostname not in ('www.bls.gov', 'bls.gov') or p.username or p.password or p.port not in (None, 443):
        fail('invalid_bls_link')
    return value


def parse_employment(body, now):
    source = decode(body)
    if '<!DOCTYPE' in source.upper() or '<!ENTITY' in source.upper():
        fail('unsafe_xml')
    try:
        root = ET.fromstring(source)
    except ET.ParseError:
        fail('invalid_atom')
    ns = {'a': 'http://www.w3.org/2005/Atom'}
    if root.tag != '{http://www.w3.org/2005/Atom}feed':
        fail('invalid_atom')
    entries = root.findall('a:entry', ns)
    if not 1 <= len(entries) <= 200:
        fail('invalid_atom')
    result = []
    for entry in entries:
        title = short_text(entry.findtext('a:title', namespaces=ns), 1000)
        published = iso(timestamp(entry.findtext('a:published', namespaces=ns), now))
        updated = entry.findtext('a:updated', namespaces=ns)
        updated = iso(timestamp(updated, now)) if updated else None
        if updated and updated < published:
            fail('invalid_publication_order')
        links = [l.get('href') for l in entry.findall('a:link', ns) if l.get('rel', 'alternate') == 'alternate']
        if len(links) != 1:
            fail('invalid_atom_link')
        result.append({'title': title, 'url': bls_url(links[0]), 'publishedAt': published, 'updatedAt': updated})
    return max(result, key=lambda row: row['publishedAt'])


def parse_calendar(body, now):
    source = decode(body).replace('\r\n', '\n')
    source = re.sub(r'\n[ \t]', '', source)
    if not source.startswith('BEGIN:VCALENDAR') or 'END:VCALENDAR' not in source:
        fail('invalid_calendar')
    events, block = [], None
    for line in source.splitlines():
        if line == 'BEGIN:VEVENT':
            if block is not None:
                fail('invalid_calendar')
            block = []
        elif line == 'END:VEVENT':
            if block is None:
                fail('invalid_calendar')
            events.append(block); block = None
        elif block is not None:
            block.append(line)
    if block is not None or not 1 <= len(events) <= 2000:
        fail('invalid_calendar')
    keep = {'Consumer Price Index', 'Producer Price Index', 'Employment Situation'}
    result, seen = [], set()
    for block in events:
        summaries = [x.partition(':')[2] for x in block if x.startswith('SUMMARY:')]
        if len(summaries) != 1:
            fail('invalid_calendar_event')
        title = summaries[0].replace('\\,', ',').replace('\\n', ' ').strip()
        if title not in keep:
            continue
        starts = [x for x in block if x.startswith('DTSTART')]
        if len(starts) != 1:
            fail('invalid_calendar_start')
        head, _, value = starts[0].partition(':')
        try:
            if head == 'DTSTART' and value.endswith('Z'):
                start = datetime.strptime(value, '%Y%m%dT%H%M%SZ').replace(tzinfo=UTC)
            elif head in ('DTSTART;TZID=US-Eastern', 'DTSTART;TZID=America/New_York'):
                start = datetime.strptime(value, '%Y%m%dT%H%M%S').replace(tzinfo=ZoneInfo('America/New_York'))
                if start.astimezone(UTC).astimezone(start.tzinfo).replace(tzinfo=None) != start.replace(tzinfo=None):
                    fail('invalid_calendar_start')
            else:
                fail('unknown_calendar_timezone')
        except ValueError:
            fail('invalid_calendar_start')
        start = start.astimezone(UTC)
        if now < start <= now + timedelta(days=400) and (title, start) not in seen:
            seen.add((title, start))
            result.append({'title': title, 'startAt': iso(start), 'url': 'https://www.bls.gov/schedule/news_release/'})
    return sorted(result, key=lambda row: row['startAt'])[:3]


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        fail('redirect_refused')


def fetch_url(url):
    if url not in URLS:
        fail('unapproved_url')
    limit = 2 * MAX_BYTES if url == CSI else MAX_BYTES
    request = urllib.request.Request(url, headers={'User-Agent': 'Books-Market-Overview/1.0 (public statistics; no retries)'})
    # Use the environment's normal network route; do not add proxy or impersonation settings.
    opener = urllib.request.build_opener(NoRedirect())
    try:
        with opener.open(request, timeout=TIMEOUT) as response:
            if response.status != 200:
                fail('http_' + str(response.status))
            declared = response.headers.get('Content-Length')
            if declared and (not declared.isdecimal() or int(declared) > limit):
                fail('response_too_large')
            body = response.read(limit + 1)
            if not body or len(body) > limit:
                fail('response_too_large')
            return body, {k.lower(): v for k, v in response.headers.items()}
    except urllib.error.HTTPError as error:
        fail('http_' + str(error.code))
    except SourceError:
        raise
    except Exception:
        fail('network_error')


def empty_card(key):
    name, page, _ = SOURCES[key]
    return {'status': 'unavailable', 'sourceName': name, 'sourceUrl': page, 'sourceUpdatedAt': None,
            'fetchedAt': None, 'lastAttemptAt': None, 'asOf': None, 'errorCode': None, 'data': None}


def validate_data(key, data, now):
    if not isinstance(data, dict):
        fail('invalid_snapshot_data')
    if key == 'sentiment':
        integer(data.get('value'), 0, 100)
        if data.get('previous') is not None: integer(data['previous'], 0, 100)
        if data.get('classification') not in CLASSIFICATIONS: fail('invalid_snapshot_data')
    elif key == 'valuation':
        if data.get('name') != '沪深300' or data.get('indexCode') != '000300': fail('invalid_snapshot_data')
        if numeric(data.get('pe'), lower=0, upper=2000) == 0 or numeric(data.get('pb'), lower=0, upper=100) == 0: fail('invalid_snapshot_data')
        numeric(data.get('dividendYield'), lower=0, upper=100)
    elif key == 'flows':
        if not re.fullmatch(r'20\d{2}-(0[1-9]|1[0-2])', str(data.get('period'))): fail('invalid_snapshot_data')
        for field in ('netMillions', 'treasuryMillions', 'agencyMillions', 'corporateMillions', 'equityMillions'):
            numeric(data.get(field), nullable=field != 'netMillions', lower=-1e10, upper=1e10)
    elif key == 'active':
        short_text(data.get('universe'), 200)
        items = data.get('items')
        if not isinstance(items, list) or not 1 <= len(items) <= 3: fail('invalid_snapshot_data')
        for row in items:
            short_text(row.get('symbol'), 24); short_text(row.get('name'), 100)
            numeric(row.get('volumeUsd'), lower=0); numeric(row.get('change24h'), nullable=True, lower=-100, upper=100000)
            timestamp(row.get('lastUpdated'), now)
    else:
        latest = data.get('latest')
        if not isinstance(latest, dict): fail('invalid_snapshot_data')
        short_text(latest.get('title'), 1000); bls_url(latest.get('url')); timestamp(latest.get('publishedAt'), now)
        if latest.get('updatedAt') is not None: timestamp(latest['updatedAt'], now)
        events = data.get('events')
        if not isinstance(events, list) or len(events) > 3: fail('invalid_snapshot_data')
        for event in events:
            short_text(event.get('title'), 100); bls_url(event.get('url')); timestamp(event.get('startAt'), now, future=True)


def validate_snapshot(value, now):
    if not isinstance(value, dict) or value.get('schemaVersion') != 1 or not isinstance(value.get('cards'), dict) or set(value['cards']) != set(CARD_IDS):
        fail('invalid_previous_snapshot')
    generated = timestamp(value.get('generatedAt'), now)
    receipt = ('collectionRunId', 'collectionRunAttempt', 'collectionState')
    if any(key in value for key in receipt):
        if (not all(key in value for key in receipt) or
                not isinstance(value['collectionRunId'], str) or
                not re.fullmatch(r'[1-9][0-9]{0,19}', value['collectionRunId']) or
                isinstance(value['collectionRunAttempt'], bool) or
                not isinstance(value['collectionRunAttempt'], int) or
                not 1 <= value['collectionRunAttempt'] <= 100000 or
                value['collectionState'] != 'completed'):
            fail('invalid_collection_receipt')
    stops = value.get('sourceStops')
    if not isinstance(stops, dict) or not set(stops).issubset(HOSTS): fail('invalid_previous_stops')
    for record in stops.values():
        if not isinstance(record, dict) or record.get('code') not in STOP_CODES: fail('invalid_previous_stops')
        timestamp(record.get('at'), now)
    for key, card in value['cards'].items():
        if not isinstance(card, dict): fail('invalid_previous_snapshot')
        if card.get('status') not in ('ready', 'stale', 'unavailable') or card.get('sourceName') != SOURCES[key][0] or card.get('sourceUrl') != SOURCES[key][1]: fail('invalid_previous_snapshot')
        for field in ('sourceUpdatedAt', 'fetchedAt', 'lastAttemptAt', 'asOf'):
            if field not in card: fail('invalid_previous_snapshot')
            if card[field] is not None and timestamp(card[field], now) > generated + timedelta(minutes=5): fail('invalid_previous_snapshot')
        code = card.get('errorCode')
        if code is not None and (not isinstance(code, str) or not re.fullmatch(r'[a-z][a-z0-9_]{0,79}', code)): fail('invalid_previous_snapshot')
        if card['status'] == 'unavailable':
            if card.get('data') is not None or card['fetchedAt'] is not None or card['asOf'] is not None: fail('invalid_previous_snapshot')
        else:
            if not card['fetchedAt'] or not card['asOf']: fail('invalid_previous_snapshot')
            if timestamp(card['asOf'], now) > timestamp(card['fetchedAt'], now) + timedelta(minutes=5): fail('invalid_previous_snapshot')
            validate_data(key, card.get('data'), now)
        if code in STOP_CODES:
            hosts = {urllib.parse.urlsplit(url).hostname for url in SOURCES[key][2]}
            if not any(stops.get(host, {}).get('code') in STOP_CODES for host in hosts): fail('missing_previous_stop')
    return copy.deepcopy(value)


def collect(previous=None, *, fetch=fetch_url, clock=lambda: datetime.now(UTC)):
    started = clock()
    previous = validate_snapshot(previous, started) if previous is not None else None
    cards = copy.deepcopy(previous['cards']) if previous else {key: empty_card(key) for key in CARD_IDS}
    stops = copy.deepcopy(previous['sourceStops']) if previous else {}
    for key in CARD_IDS:
        old, now = cards[key], clock()
        urls = SOURCES[key][2]
        blocked = next((stops[urllib.parse.urlsplit(url).hostname] for url in urls if urllib.parse.urlsplit(url).hostname in stops), None)
        if blocked:
            old['status'] = 'stale' if old['data'] is not None else 'unavailable'
            old['errorCode'] = blocked['code']
            continue
        if old['status'] == 'ready' and old['fetchedAt'] and old['asOf'] and (now - timestamp(old['fetchedAt'], now)).total_seconds() < FETCH_INTERVALS[key] and (now - timestamp(old['asOf'], now)).total_seconds() <= MAX_SOURCE_AGE[key]:
            continue
        attempt, current_url = iso(now), urls[0]
        try:
            responses = []
            for current_url in urls:
                body, headers = fetch(current_url)
                if not isinstance(body, bytes) or len(body) > (2*MAX_BYTES if current_url == CSI else MAX_BYTES): fail('response_too_large')
                responses.append((body, headers))
            completed = clock()
            body, headers = responses[0]
            modified = last_modified(headers, completed)
            if key == 'sentiment': data, as_of, modified = parse_sentiment(body, completed)
            elif key == 'valuation': data, as_of = parse_valuation(body, completed)
            elif key == 'flows': data, as_of = parse_flows(body, completed)
            elif key == 'active': data, as_of, modified = parse_active(body, completed)
            else:
                latest = parse_employment(body, completed)
                data = {'latest': latest, 'events': parse_calendar(responses[1][0], completed)}
                as_of, modified = latest['publishedAt'], latest['updatedAt']
            if old['asOf'] and timestamp(as_of, completed) < timestamp(old['asOf'], completed): fail('source_time_regressed')
            card = empty_card(key)
            card.update(status='stale' if (completed-timestamp(as_of, completed)).total_seconds() > MAX_SOURCE_AGE[key] else 'ready',
                        sourceUpdatedAt=modified, fetchedAt=iso(completed), lastAttemptAt=attempt, asOf=as_of, data=data)
            cards[key] = card
        except SourceError as error:
            code = str(error)
            if not re.fullmatch(r'[a-z][a-z0-9_]{0,79}', code): code = 'invalid_source'
            if code in STOP_CODES:
                stops[urllib.parse.urlsplit(current_url).hostname] = {'code': code, 'at': iso(clock())}
            old.update(status='stale' if old['data'] is not None else 'unavailable', lastAttemptAt=attempt, errorCode=code)
        except Exception:
            old.update(status='stale' if old['data'] is not None else 'unavailable', lastAttemptAt=attempt, errorCode='invalid_source')
    result = {'schemaVersion': 1, 'generatedAt': iso(clock()), 'cards': cards, 'sourceStops': stops}
    return validate_snapshot(result, clock())


def load_previous(path, now):
    try:
        with path.open('rb') as handle:
            if os.fstat(handle.fileno()).st_size > MAX_BYTES: fail('previous_snapshot_too_large')
            raw = handle.read(MAX_BYTES + 1)
            if len(raw) > MAX_BYTES: fail('previous_snapshot_too_large')
    except FileNotFoundError:
        return None
    try:
        return validate_snapshot(parse_json(raw), now)
    except SourceError:
        fail('invalid_previous_snapshot')


def write_atomic(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    raw = (json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + '\n').encode('utf-8')
    if len(raw) > MAX_BYTES: fail('snapshot_too_large')
    temp = None
    try:
        with tempfile.NamedTemporaryFile(prefix='.'+path.name+'.', suffix='.tmp', dir=path.parent, delete=False) as handle:
            temp = Path(handle.name)
            handle.write(raw); handle.flush(); os.fsync(handle.fileno())
        os.replace(temp, path); temp = None
    finally:
        if temp is not None: temp.unlink(missing_ok=True)


def collection_receipt(env):
    run, attempt = env.get('GITHUB_RUN_ID'), env.get('GITHUB_RUN_ATTEMPT')
    if run is None and attempt is None:
        return {}
    if (not isinstance(run, str) or not re.fullmatch(r'[1-9][0-9]{0,19}', run) or
            not isinstance(attempt, str) or not re.fullmatch(r'[1-9][0-9]{0,5}', attempt) or int(attempt) > 100000):
        fail('invalid_collection_environment')
    return {'collectionRunId': run, 'collectionRunAttempt': int(attempt), 'collectionState': 'completed'}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=Path(__file__).resolve().parents[1] / 'market-overview.json')
    args = parser.parse_args(argv)
    try:
        receipt = collection_receipt(os.environ)
        previous = load_previous(args.output, datetime.now(UTC))
        result = collect(previous)
        result.update(receipt)
        write_atomic(args.output, result)
        print(json.dumps({'generatedAt': result['generatedAt'], 'cards': {key: {'status': card['status'], 'asOf': card['asOf'], 'errorCode': card['errorCode']} for key, card in result['cards'].items()}, 'stoppedHosts': sorted(result['sourceStops'])}, ensure_ascii=False))
        return 0
    except SourceError as error:
        print('market_overview:' + str(error))
        return 2
    except Exception:
        print('market_overview:local_io_error')
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
