"""Dated stock research and anomaly analysis. No network or trading capability."""
from datetime import datetime, timezone, date
from statistics import median, mean
import hashlib
import math
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo

A_MODES = ['M1', 'M2', 'M3', 'M4', 'M5']
US_MODES = ['U1', 'U2', 'U3']
US_RULES_VERSION = 'books.stock.us.causal.v2'
PARAMS = dict(min_price=5, min_turnover=10_000_000, event_gap=.04,
              event_volume=2, break_volume=1.5, max_extension=.15, near_high=.03)


def stamp(v):
    if not isinstance(v, str):
        raise ValueError('timestamp_required')
    d = datetime.fromisoformat(v.replace('Z', '+00:00'))
    if d.tzinfo is None:
        raise ValueError('timezone_required')
    return d.timestamp()


def finite(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def benchmark_lookup(benchmark):
    """A dated benchmark is a series, not a last-write-wins dictionary."""
    if not isinstance(benchmark, list):
        raise ValueError('benchmark_shape_invalid')
    lookup = {}
    for bar in benchmark:
        if not isinstance(bar, dict) or not isinstance(bar.get('date'), str):
            raise ValueError('benchmark_date_invalid')
        day = bar.get('date')
        try:
            date.fromisoformat(day)
        except ValueError:
            raise ValueError('benchmark_date_invalid') from None
        if day in lookup:
            raise ValueError('duplicate_benchmark_date')
        if not finite(bar.get('close')) or bar['close'] <= 0:
            raise ValueError('benchmark_values_invalid')
        lookup[day] = bar['close']
    return lookup


def qualification(s, market, day):
    """Unknown evidence cannot qualify a formal candidate."""
    e = s.get('eligibility', {})
    if e.get('asOf') != day:
        return 'pending', ['eligibility_date_missing']
    if any(e.get(k) is True for k in ['isST', 'riskWarning', 'delisted', 'suspended']):
        return 'excluded', ['security_excluded']
    if market == 'a':
        if e.get('exchange') not in ['SSE', 'SZSE'] or e.get('board') != 'main' or e.get('assetType') != 'ordinary_stock':
            return 'excluded' if e.get('scopeVerified') is True else 'pending', ['scope_unverified']
        keys = ['isST', 'riskWarning', 'delisted', 'suspended']
        if any(e.get(k) is not False for k in keys) or e.get('normalLimitVerified') is not True or e.get('limitPct') != 10:
            return 'pending', ['normal_10pct_eligibility_unverified']
    elif e.get('assetType') != 'ordinary_stock' or e.get('exchange') not in ['NYSE', 'NASDAQ', 'AMEX']:
        return 'pending', ['us_security_type_unverified']
    elif e.get('delisted') is not False or e.get('suspended') is not False:
        return 'pending', ['us_trading_status_unverified']
    return 'qualified', []


def event_evidence(security, session, received_at):
    """Validate input attestations for a pre-open earnings/guidance catalyst.

    security.event requires symbol, kind=earnings/guidance, officialVerified=True,
    sourceType=sec/issuer, sourceUrl (HTTPS original), publishedAt, firstSeenAt,
    receivedAt. session.openTime must be a verified regular-session opening.
    Event publication precedes that open; discovery/receipt precede the batch
    receipt. A URL and boolean do not independently verify an official source.
    No current market-data adapter supplies events: missing evidence stays pending.
    """
    event = security.get('event')
    if not isinstance(event, dict):
        return False, 'event_catalyst_requires_evidence'
    if (event.get('symbol') != security['symbol'] or event.get('kind') not in ['earnings', 'guidance']
            or event.get('officialVerified') is not True or event.get('sourceType') not in ['sec', 'issuer']):
        return False, 'event_identity_or_official_source_unverified'
    url = event.get('sourceUrl')
    try:
        if not isinstance(url, str) or len(url) > 2048 or any(ord(c) <= 32 or ord(c) == 127 for c in url):
            raise ValueError('invalid_event_url')
        parsed = urlsplit(url)
        parsed.port  # A malformed/overflowing port is not a valid original URL.
        if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password:
            raise ValueError('invalid_event_url')
    except ValueError:
        return False, 'event_identity_or_official_source_unverified'
    try:
        opened, closed = stamp(session.get('openTime')), stamp(session.get('closeTime'))
        if (session.get('calendarVerified') is not True or not opened < closed
                or datetime.fromtimestamp(opened, ZoneInfo('America/New_York')).date().isoformat() != session['date']):
            raise ValueError('invalid_event_open')
    except (ValueError, TypeError, OverflowError, OSError):
        return False, 'event_regular_open_unverified'
    try:
        published, seen, received = (stamp(event.get(k)) for k in ['publishedAt', 'firstSeenAt', 'receivedAt'])
        if not published < opened or not published <= seen <= received <= received_at:
            raise ValueError('invalid_event_times')
    except (ValueError, TypeError, OverflowError, OSError):
        return False, 'event_publication_or_discovery_not_causal'
    return True, None


def metrics(s, benchmark, day, trading_dates):
    bars = s.get('bars', [])
    if s.get('adjustmentVerified') is not True or len(bars) < 61:
        raise ValueError('adjustment_or_history_incomplete')
    dates = [b.get('date') for b in bars]
    for value in dates:
        date.fromisoformat(value)
    if dates != sorted(set(dates)) or dates[-1] != day:
        raise ValueError('bar_dates_incomplete')
    if len(trading_dates) < 61 or dates[-61:] != trading_dates[-61:]:
        raise ValueError('trading_calendar_history_incomplete')
    for b in bars:
        if not all(finite(b.get(k)) for k in ['open', 'high', 'low', 'close', 'volume', 'turnover']):
            raise ValueError('bar_fields_incomplete')
        if min(b[k] for k in ['open', 'high', 'low', 'close']) <= 0 or min(b['volume'], b['turnover']) < 0 or b['low'] > min(b['open'], b['close']) or b['high'] < max(b['open'], b['close']):
            raise ValueError('bar_values_invalid')
    last, previous = bars[-1], bars[-2]
    ma20, ma50 = mean(b['close'] for b in bars[-20:]), mean(b['close'] for b in bars[-50:])
    vol = mean(b['volume'] for b in bars[-21:-1])
    if vol <= 0:
        raise ValueError('volume_baseline_missing')
    lookup = benchmark_lookup(benchmark)
    excess = None
    if dates[-1] in lookup and dates[-21] in lookup:
        excess = last['close'] / bars[-21]['close'] - lookup[dates[-1]] / lookup[dates[-21]]
    result = dict(close=last['close'], turnover=mean(b['turnover'] for b in bars[-20:]),
                gap=last['open'] / previous['close'] - 1, dayret=last['close'] / previous['close'] - 1,
                rvol=last['volume'] / vol, ma20=ma20, ma50=ma50,
                ma50_up=ma50 > mean(b['close'] for b in bars[-51:-1]),
                high20=max(b['high'] for b in bars[-21:-1]), excess=excess)
    if not all(value is None or isinstance(value, bool) or finite(value) for value in result.values()):
        raise ValueError('derived_metrics_invalid')
    return result


def screen(batch, now=None):
    now = datetime.now(timezone.utc).timestamp() if now is None else now
    if not finite(now):
        raise ValueError('invalid_now')
    market, day = batch['market'], batch['session']['date']
    date.fromisoformat(day)
    if market not in ['a', 'us']:
        raise ValueError('invalid_market')
    source = batch['source']
    close_at = stamp(batch['session']['closeTime'])
    received_at = stamp(source.get('receivedAt'))
    close_day = datetime.fromtimestamp(close_at, ZoneInfo('Asia/Shanghai' if market == 'a' else 'America/New_York')).date().isoformat()
    timing_reasons = []
    if close_day != day:
        timing_reasons.append('market_close_date_mismatch')
    if close_at > now:
        timing_reasons.append('market_close_in_future')
    if received_at > now:
        timing_reasons.append('source_received_in_future')
    if received_at < close_at:
        timing_reasons.append('source_received_before_close')
    if batch['session'].get('calendarVerified') is not True:
        timing_reasons.append('complete_close_or_calendar_unverified')
    # Reject contradictory batch-level source data before considering any stock.
    benchmark_lookup(batch.get('benchmark', []))
    trading_dates = batch['session'].get('tradingDates', [])
    if trading_dates:
        for value in trading_dates:
            date.fromisoformat(value)
        if trading_dates != sorted(set(trading_dates)) or trading_dates[-1] != day:
            raise ValueError('invalid_trading_calendar')
    complete = (not timing_reasons and batch['session'].get('calendarVerified') is True
                and source.get('paginationComplete') is True and source.get('coverage') == 'full_universe'
                and type(source.get('expectedCount')) is int and source['expectedCount'] > 0
                and source.get('expectedCount') == len(batch['securities']) and source.get('permissionsVerified') is True
                and source.get('dataAsOf') == day and (market != 'us' or source.get('feed') == 'sip'))
    symbols = [x.get('symbol') for x in batch['securities']]
    if len(symbols) != len(set(symbols)):
        raise ValueError('duplicate_security')
    p = {**PARAMS, **batch.get('parameters', {})}
    if set(p) != set(PARAMS) or not all(finite(v) and v >= 0 for v in p.values()) or p['near_high'] >= 1:
        raise ValueError('invalid_parameters')
    rows = []
    for s in batch['securities']:
        status, reasons = qualification(s, market, day)
        r = dict(symbol=s['symbol'], name=s.get('name', s['symbol']), exchange=s.get('eligibility', {}).get('exchange'),
                 status='excluded' if status == 'excluded' else 'pending', qualification=status,
                 hits=[], pending=A_MODES[:] if market == 'a' else [], reasons=reasons, close=None,
                 currency='CNY' if market == 'a' else 'USD', asOf=day, metrics=None, bars=[])
        rows.append(r)
        if market == 'us':
            r['eligibleHits'] = []
        if status == 'excluded':
            continue
        if timing_reasons:
            r['reasons'].extend(timing_reasons)
            r['reasons'].append('batch_coverage_or_close_unverified')
            continue
        try:
            m = metrics(s, batch.get('benchmark', []), day, trading_dates)
            r.update(close=m['close'], metrics=m, bars=[{k:b[k] for k in ['date','open','high','low','close','volume','turnover']} for b in s['bars'][-100:]])
        except ValueError as e:
            r['reasons'].append(str(e)); continue
        if not complete:
            r['reasons'].append('batch_coverage_or_close_unverified')
        if market == 'a':
            r['reasons'].append('five_mode_definitions_pending')
            # Do not substitute an invented branch for the user's five original modes.
            continue
        if m['close'] < p['min_price'] or m['turnover'] < p['min_turnover']:
            r.update(status='excluded', reasons=['price_or_liquidity_below_threshold']); continue
        eligible_hits = []
        if m['gap'] >= p['event_gap'] and m['rvol'] >= p['event_volume'] and m['dayret'] > 0:
            r['hits'].append('U1')
            verified, reason = event_evidence(s, batch['session'], received_at)
            if verified:
                eligible_hits.append('U1')
            else:
                r['pending'].append('U1')
                r['reasons'].append(reason)
        trend = m['close'] > m['ma20'] > m['ma50'] and m['ma50_up'] and m['excess'] is not None and m['excess'] > 0
        if trend and m['close'] / m['ma20'] - 1 <= p['max_extension']:
            if m['close'] > m['high20'] and m['rvol'] >= p['break_volume']:
                r['hits'].append('U2')
                eligible_hits.append('U2')
            if 1 - p['near_high'] <= m['close'] / m['high20'] <= 1:
                r['hits'].append('U3')
                r['pending'].append('U3')
                r['reasons'].append('near_breakout_watch_only')
        if m['excess'] is None:
            r['reasons'].append('same_date_spy_benchmark_missing')
        if complete and status == 'qualified':
            r['eligibleHits'] = eligible_hits
            r['status'] = 'candidate' if eligible_hits else 'pending' if r['hits'] else 'unmatched'
        r['falsifier'] = 'Breakout failure, weakening relative strength, or revised adjustment requires review.'
    # The public index is a result list, not a full market historical price dump.
    for r in rows:
        r['bars'] = r['bars'][-8:] if r['hits'] else []
        if not r['hits'] and r['metrics']:
            r['metrics'] = {'rvol': r['metrics']['rvol']}
    result = dict(status='ready' if complete else 'partial', asOf=day, source=source,
                  parameters=p, rows=rows, completeUniverse=complete)
    if market == 'us':
        result['rulesVersion'] = US_RULES_VERSION
    return result


def anomalies(observations, now=None):
    """Minute observations compared with the same session/minute on prior days."""
    now = now or datetime.now(timezone.utc).timestamp()
    result, seen = [], set()
    for x in observations:
        date.fromisoformat(x['date'])
        if x.get('market') not in ['a', 'us'] or not x.get('source') or not x.get('session') or not x.get('minute'):
            raise ValueError('observation_identity_missing')
        at, received = stamp(x['sourceTime']), stamp(x['receivedAt'])
        local = datetime.fromtimestamp(at, ZoneInfo('Asia/Shanghai' if x['market']=='a' else 'America/New_York'))
        if local.date().isoformat()!=x['date'] or local.strftime('%H:%M')!=x['minute']:
            raise ValueError('minute_timestamp_mismatch')
        if at > received + 1 or received > now + 1 or now - at > 120 or received - at > 120:
            continue
        baseline = sorted([b for b in x.get('baseline', [])
                if b.get('minute') == x.get('minute') and b.get('session') == x.get('session')
                and b.get('date', '') < x.get('date', '') and finite(b.get('turnover')) and b['turnover'] > 0], key=lambda b:b['date'])
        for b in baseline:
            date.fromisoformat(b['date'])
        base = [b['turnover'] for b in baseline]
        # One observation per prior trading day; duplicates are not an independent baseline.
        dates = [b['date'] for b in baseline]
        if len(set(dates)) != len(dates) or len(base) < 10 or not finite(x.get('turnover')) or not finite(x.get('priceChange1m')) or x['turnover'] < 0:
            continue
        ratio = x['turnover'] / median(base[-20:])
        if not finite(ratio) or ratio < 3:
            continue
        key = hashlib.sha256((x['market']+'|'+x['symbol']+'|'+x['sourceTime']).encode()).hexdigest()
        if key in seen:
            continue
        seen.add(key)
        result.append(dict(id=key, market=x['market'], symbol=x['symbol'], name=x.get('name', x['symbol']),
                           sourceTime=x['sourceTime'], receivedAt=x['receivedAt'], detectedAt=datetime.fromtimestamp(now, timezone.utc).isoformat(),
                           turnover=x['turnover'], currency=x['currency'], ratio=round(ratio, 3),
                           priceChange1m=x['priceChange1m'], level='confirmed' if abs(x['priceChange1m']) >= .01 else 'watch',
                           source=x['source'], kind='volume_acceleration', baselineDays=min(len(base),20),
                           note='Activity observation; not institutional cash inflow or a trading instruction.'))
    return sorted(result, key=lambda r: r['sourceTime'], reverse=True)
