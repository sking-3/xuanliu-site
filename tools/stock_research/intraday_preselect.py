"""Offline A-share 14:00 research preselection, never orders or a probability.

Input books.a14.input.v1, market='a', strategyVersion='research_v0', audience
owner/public, units={price:CNY, volume:shares, turnover:CNY}. No tunable overrides.
session: date, cutoff (exactly 14:00 Asia/Shanghai), calendarVerified, isOpen,
previousSessionDate, historyTradingDates (61+ complete sessions ending at the
previous session), nextSession={date,openTime,closeTime,calendarVerified}.
source: id, permissionsVerified, accessScope, redistributionAllowed (for public),
coverage='full_universe', paginationComplete, expectedCount, dataAsOf,
sourceTime/receivedAt. universe: scope='all_listed_a_shares', asOf, complete,
knownAt/receivedAt, symbols. A complete directory is an upstream attestation,
not proof that the program independently knows every listed security.
benchmark: symbol='SSE:000001', historyComplete/adjustmentVerified/priceBasis,
priceAnchorDate=the current session, adjustmentKnownAt<=cutoff, history=[date,close],
snapshot={last,priceBasis,priceAnchorDate,adjustmentVerified,sourceTime,receivedAt}.
securities: symbol (six digits .SH/.SZ/.BJ), name/nameVerified, eligibility as in
engine.qualification plus scopeVerified=True and knownAt/receivedAt. Eligibility
must have been known by cutoff and received by invocation time. Only ordinary
mainboard prefixes SH600/601/603/605 and SZ000/001/002/003 can qualify, with
matching verified assetType/board/exchange; other directory securities stay
excluded or pending. historyComplete/adjustmentVerified/priceBasis, history
(the exact historyTradingDates, OHLC/volume/turnover), snapshot (last/open/
highSoFar/lowSoFar/cumulativeVolume/cumulativeTurnover plus benchmark snapshot
evidence), sameCutoffTurnover=[date,cutoffTime='14:00:00',complete,turnover].
The latter must cover the latest 10..20 consecutive supplied prior sessions.
Security histories also require priceAnchorDate/adjustmentKnownAt. Price bases
must identify a causal adjustment anchor and corporate actions; daily prices
must be converted to current quoted units. Turnover is actual CNY. R2 compares
historical turnover, not unadjusted share counts across splits/consolidations.
Optional sectors: asOf/knownAt/receivedAt, membershipComplete,
quoteCoverageComplete, scope='qualified_mainboard', members={id:[symbols]}.
Its union must equal the current qualified mainboard universe, with no overlap.
Missing sector evidence only holds A14-R3; other branches remain independent.

All quote source times must be <= cutoff and no more than 120 seconds old at
cutoff. Receipts must follow their source and be <= actual invocation time.
Metadata knownAt must also be <= cutoff. Later full-day values are never read.
generatedAt is actual invocation time; a cutoff label is not publication proof.
All parameters below are unvalidated research defaults, not an established edge.

CLI: python3 -m tools.stock_research.intraday_preselect --input INPUT --output
OUTPUT. It uses the actual UTC clock, writes JSON atomically, and returns 1 for
blocked evidence (0 for ready/closed). It performs no network or scheduling.
"""
import argparse
from datetime import date, datetime, timezone
import json
from math import ceil
import os
from pathlib import Path
from statistics import mean, median
import re
import tempfile
from zoneinfo import ZoneInfo

from .engine import finite, qualification
from .next_session import _day, _time

VERSION = 'research_v0'
RULES = ('A14-R1', 'A14-R2', 'A14-R3')
ZONE = ZoneInfo('Asia/Shanghai')
PARAMETERS = dict(minMeanTurnover=100_000_000, minBaselineDays=10,
                  benchmarkSymbol='SSE:000001',
                  maxQuoteAgeSeconds=120, breakoutTurnoverRatio=1.5,
                  minBreakoutRangePosition=.7,
                  recoveryTurnoverRatio=1.2, sectorTurnoverRatio=1.2,
                  maxBreakoutExtension=.12, maxRecoveryExtension=.08,
                  benchmarkMinDayChange=-.005, minSectorMembers=5,
                  sectorMedianExcess=.01, sectorAdvancingFraction=.6,
                  sectorTopFraction=.2)
SYMBOL = re.compile(r'[0-9]{6}\.(SH|SZ|BJ)')
ORDINARY_MAINBOARD_SYMBOL = re.compile(r'(?:60[0135][0-9]{3}\.SH|00[0-3][0-9]{3}\.SZ)')


def _require(condition, code):
    if not condition:
        raise ValueError(code)


def _reason(error, fallback):
    code = str(error)
    return code if re.fullmatch(r'[a-z][a-z0-9_]{0,79}', code) else fallback


def _instant(value):
    return _time(value).astimezone(timezone.utc)


def _known(value, cutoff, clock):
    _require(isinstance(value, dict), 'metadata_missing')
    known, received = _instant(value.get('knownAt')), _instant(value.get('receivedAt'))
    _require(known <= cutoff and known <= received <= clock, 'metadata_time_invalid')


def _quote(value, cutoff, clock, batch_received):
    _require(isinstance(value, dict), 'snapshot_missing')
    source, received = _instant(value.get('sourceTime')), _instant(value.get('receivedAt'))
    _require(source <= cutoff and (cutoff-source).total_seconds() <= PARAMETERS['maxQuoteAgeSeconds'],
             'snapshot_after_cutoff_or_stale')
    _require(source <= received <= batch_received <= clock, 'snapshot_receipt_invalid')
    _require(finite(value.get('last')) and value['last'] > 0, 'snapshot_price_invalid')


def _qualification(security, day, cutoff, clock):
    """A14 adds causal identity checks without changing the existing engine."""
    e = security.get('eligibility')
    _known(e, cutoff, clock)
    _require(e.get('scopeVerified') is True, 'eligibility_scope_unverified')
    _require(e.get('exchange') == {'SH':'SSE', 'SZ':'SZSE', 'BJ':'BSE'}[security['symbol'][-2:]],
             'symbol_exchange_mismatch')
    q, reasons = qualification(security, 'a', day)
    if q == 'qualified' and not ORDINARY_MAINBOARD_SYMBOL.fullmatch(security['symbol']):
        return 'excluded', ['symbol_not_ordinary_mainboard']
    return q, reasons


def _history(value, dates, cutoff, daily=False):
    _require(isinstance(value, dict) and value.get('historyComplete') is True,
             'complete_history_unverified')
    basis = value.get('priceBasis')
    _require(value.get('adjustmentVerified') is True and isinstance(basis, str) and basis.strip(),
             'history_price_basis_unverified')
    anchor = cutoff.astimezone(ZONE).date().isoformat()
    _require(value.get('priceAnchorDate') == anchor
             and _instant(value.get('adjustmentKnownAt')) <= cutoff, 'price_anchor_or_knowledge_unverified')
    rows = value.get('history')
    _require(isinstance(rows, list) and all(isinstance(x, dict) for x in rows)
             and [x.get('date') for x in rows] == dates, 'history_calendar_mismatch')
    for bar in rows:
        keys = ('open', 'high', 'low', 'close', 'volume', 'turnover') if daily else ('close',)
        _require(all(finite(bar.get(k)) for k in keys) and bar['close'] > 0, 'history_values_invalid')
        if daily:
            _require(min(bar['open'], bar['high'], bar['low']) > 0
                     and min(bar['volume'], bar['turnover']) >= 0
                     and (bar['volume'] == 0) == (bar['turnover'] == 0)
                     and bar['low'] <= min(bar['open'], bar['close'])
                     and bar['high'] >= max(bar['open'], bar['close']), 'history_values_invalid')
    snap = value.get('snapshot')
    _require(isinstance(snap, dict) and snap.get('adjustmentVerified') is True
             and snap.get('priceBasis') == basis and snap.get('priceAnchorDate') == anchor,
             'snapshot_price_basis_unverified')
    return rows


def _same_cutoff_turnover(security, dates, current):
    baseline = security.get('sameCutoffTurnover')
    _require(isinstance(baseline, list) and PARAMETERS['minBaselineDays'] <= len(baseline) <= 20
             and all(isinstance(x, dict) for x in baseline)
             and [x.get('date') for x in baseline] == dates[-len(baseline):], 'same_cutoff_history_incomplete')
    _require(all(x.get('cutoffTime') == '14:00:00' and x.get('complete') is True
                 and finite(x.get('turnover')) and x['turnover'] > 0 for x in baseline),
             'same_cutoff_history_unverified')
    ratio = current/median(x['turnover'] for x in baseline)
    _require(finite(ratio), 'same_cutoff_ratio_invalid')
    return ratio, len(baseline)


def _metrics(security, dates, cutoff, clock, batch_received):
    rows = _history(security, dates, cutoff, daily=True)
    snap = security['snapshot']
    _quote(snap, cutoff, clock, batch_received)
    keys = ('open', 'highSoFar', 'lowSoFar', 'cumulativeVolume', 'cumulativeTurnover')
    _require(all(finite(snap.get(k)) for k in keys)
             and min(snap['open'], snap['lowSoFar'], snap['cumulativeVolume']) > 0
             and snap['cumulativeTurnover'] > 0
             and snap['lowSoFar'] <= min(snap['open'], snap['last'])
             and snap['highSoFar'] >= max(snap['open'], snap['last']), 'intraday_values_invalid')
    vwap = snap['cumulativeTurnover']/snap['cumulativeVolume']
    tolerance = max(1, snap['highSoFar'])*1e-8
    _require(snap['lowSoFar']-tolerance <= vwap <= snap['highSoFar']+tolerance,
             'intraday_units_or_vwap_invalid')
    baseline_reason = None
    try:
        ratio, baseline_days = _same_cutoff_turnover(security, dates, snap['cumulativeTurnover'])
    except (ValueError, TypeError, KeyError, OverflowError, OSError) as error:
        ratio, baseline_days = None, None
        baseline_reason = _reason(error, 'same_cutoff_history_unverified')
    closes = [x['close'] for x in rows]
    spread = snap['highSoFar']-snap['lowSoFar']
    result = dict(price=snap['last'], previousClose=closes[-1], previousHigh=rows[-1]['high'],
                high20=max(x['high'] for x in rows[-20:]), ma20=mean(closes[-20:]),
                ma50=mean(closes[-50:]), ma50Up=mean(closes[-50:]) > mean(closes[-51:-1]),
                meanTurnover=mean(x['turnover'] for x in rows[-20:]),
                pullbackTurnover=mean(x['turnover'] for x in rows[-3:]) < mean(x['turnover'] for x in rows[-20:]),
                vwap=vwap, turnoverRatio=ratio,
                rangePosition=(snap['last']-snap['lowSoFar'])/spread if spread > 0 else None,
                dayChange=snap['last']/closes[-1]-1, baselineDays=baseline_days)
    _require(all(value is None or isinstance(value, bool) or finite(value) for value in result.values()),
             'derived_metrics_invalid')
    return result, baseline_reason


def _branch(conditions):
    failed = [code for ok, code in conditions if not ok]
    return dict(status='miss' if failed else 'hit', reasons=failed)


def _sector_evidence(batch, rows, eligible, cutoff, clock):
    try:
        sector = batch.get('sectors')
        _known(sector, cutoff, clock)
        _require(sector.get('asOf') == batch['session']['date']
                 and sector.get('membershipComplete') is True and sector.get('quoteCoverageComplete') is True
                 and sector.get('scope') == 'qualified_mainboard', 'sector_scope_or_coverage_unverified')
        members = sector.get('members')
        _require(isinstance(members, dict) and members, 'sector_members_missing')
        flattened = []
        for key, values in members.items():
            _require(isinstance(key, str) and re.fullmatch(r'[A-Za-z0-9_.:-]{1,80}', key)
                     and isinstance(values, list) and values and all(isinstance(s, str) for s in values),
                     'sector_members_invalid')
            flattened.extend(values)
        _require(len(flattened) == len(set(flattened)) and set(flattened) == set(eligible),
                 'sector_member_directory_mismatch')
        available = {r['symbol']:r['metrics'] for r in rows if r['metrics'] is not None}
        _require(all(s in available for s in eligible), 'sector_quotes_or_reference_incomplete')
        market_median = median(available[s]['dayChange'] for s in eligible)
        result = {}
        for key, symbols in members.items():
            returns = [available[s]['dayChange'] for s in symbols]
            values = dict(id=key, memberCount=len(symbols), medianChange=median(returns),
                          marketMedianChange=market_median,
                          advancingFraction=sum(x > 0 for x in returns)/len(returns))
            for s in symbols:
                result[s] = {**values, 'topMember':sum(x > available[s]['dayChange'] for x in returns)
                             < ceil(len(returns)*PARAMETERS['sectorTopFraction'])}
        return result, None
    except (ValueError, TypeError, KeyError, OverflowError, OSError) as error:
        return {}, _reason(error, 'sector_evidence_incomplete')


def preselect(batch, now=None):
    """Return research preselection or an explicit block; never a trade or forecast rate."""
    out = dict(schema='books.a14.preselection.v1', strategyVersion=VERSION, market='a',
               stage='research_unvalidated', validatedEdge=False, timestampEvidenceOnly=True,
               units=dict(price='CNY', volume='shares', turnover='CNY'),
               status='blocked', sessionDate=None, cutoff=None, generatedAt=None, nextSessionDate=None,
               audience=None, parameters=PARAMETERS.copy(), source=None, coverage=None,
               rows=[], counts=None, reasons=[])
    try:
        _require(isinstance(batch, dict) and batch.get('schema') == 'books.a14.input.v1'
                 and batch.get('market') == 'a' and batch.get('strategyVersion') == VERSION
                 and 'parameters' not in batch, 'input_schema_or_version_invalid')
        clock = datetime.now(timezone.utc) if now is None else now
        if finite(clock):
            clock = datetime.fromtimestamp(clock, timezone.utc)
        _require(isinstance(clock, datetime) and clock.tzinfo is not None, 'clock_invalid')
        clock = clock.astimezone(timezone.utc)
        session = batch.get('session')
        _require(isinstance(session, dict), 'session_missing')
        day, cutoff = _day(session.get('date')), _instant(session.get('cutoff'))
        _require(cutoff.astimezone(ZONE).isoformat() == day+'T14:00:00+08:00' and cutoff <= clock,
                 'cutoff_not_exact_1400_or_future')
        out.update(sessionDate=day, cutoff=cutoff.astimezone(ZONE).isoformat(), generatedAt=clock.isoformat())
        _require(session.get('calendarVerified') is True, 'calendar_unverified')
        if session.get('isOpen') is False:
            out.update(status='closed', reasons=['exchange_closed'])
            return out
        _require(session.get('isOpen') is True and date.fromisoformat(day).weekday() < 5,
                 'trading_session_unverified')
        dates = session.get('historyTradingDates')
        _require(isinstance(dates, list) and len(dates) >= 61 and all(isinstance(x, str) for x in dates),
                 'history_calendar_incomplete')
        for d in dates:
            _day(d)
        _require(dates == sorted(set(dates)) and dates[-1] < day
                 and all(date.fromisoformat(d).weekday() < 5 for d in dates)
                 and dates[-1] == session.get('previousSessionDate'), 'history_calendar_invalid')
        following = session.get('nextSession')
        _require(isinstance(following, dict) and following.get('calendarVerified') is True,
                 'next_session_unverified')
        next_day = _day(following.get('date'))
        opened, closed = _instant(following.get('openTime')), _instant(following.get('closeTime'))
        _require(next_day > day and date.fromisoformat(next_day).weekday() < 5
                 and opened.astimezone(ZONE).date().isoformat() == next_day
                 and closed.astimezone(ZONE).date().isoformat() == next_day
                 and cutoff < opened < closed, 'next_session_invalid')
        out['nextSessionDate'] = next_day
        source = batch.get('source')
        _require(isinstance(source, dict) and source.get('permissionsVerified') is True
                 and not source.get('stopped') and not source.get('errorCode'), 'source_permission_or_stop')
        audience = batch.get('audience')
        _require(audience in ('owner', 'public') and source.get('accessScope') in ('owner', 'personal', 'public')
                 and (audience != 'public' or source.get('accessScope') == 'public'
                      and source.get('redistributionAllowed') is True), 'source_audience_not_permitted')
        _require(isinstance(source.get('id'), str) and re.fullmatch(r'[A-Za-z0-9_.:-]{1,80}', source['id']),
                 'source_identity_missing')
        received, source_time = _instant(source.get('receivedAt')), _instant(source.get('sourceTime'))
        _require(source_time <= cutoff and (cutoff-source_time).total_seconds() <= PARAMETERS['maxQuoteAgeSeconds']
                 and source_time <= received <= clock and source.get('dataAsOf') == day,
                 'batch_time_not_cutoff_evidence')
        _require(batch.get('units') == dict(price='CNY', volume='shares', turnover='CNY'), 'units_unverified')
        securities, universe = batch.get('securities'), batch.get('universe')
        _require(isinstance(securities, list) and securities and all(isinstance(s, dict) for s in securities),
                 'security_batch_missing')
        _known(universe, cutoff, clock)
        symbols = [s.get('symbol') for s in securities]
        _require(all(isinstance(s, str) and SYMBOL.fullmatch(s) for s in symbols)
                 and len(symbols) == len(set(symbols)), 'security_identifiers_invalid_or_duplicate')
        directory = universe.get('symbols')
        _require(source.get('coverage') == 'full_universe' and source.get('paginationComplete') is True
                 and type(source.get('expectedCount')) is int and source['expectedCount'] == len(symbols)
                 and universe.get('complete') is True and universe.get('asOf') == day
                 and universe.get('scope') == 'all_listed_a_shares' and isinstance(directory, list)
                 and all(isinstance(s, str) for s in directory) and len(directory) == len(set(directory))
                 and set(directory) == set(symbols), 'full_universe_coverage_unverified')
        benchmark = batch.get('benchmark')
        _require(isinstance(benchmark, dict) and benchmark.get('symbol') == PARAMETERS['benchmarkSymbol'],
                 'benchmark_identity_unverified')
        index_history = _history(benchmark, dates, cutoff)
        _quote(benchmark['snapshot'], cutoff, clock, received)
        index_price = benchmark['snapshot']['last']
        _require(finite(index_price/index_history[-1]['close']-1), 'benchmark_derived_values_invalid')
        market_ok = (index_price >= mean(x['close'] for x in index_history[-20:])
                     and index_price/index_history[-1]['close']-1 >= PARAMETERS['benchmarkMinDayChange'])
        out.update(audience=audience, source=dict(id=source['id'], sourceTime=source_time.isoformat(),
                   receivedAt=received.isoformat(), permissionsVerified=True, accessScope=source['accessScope'],
                   redistributionAllowed=source.get('redistributionAllowed') is True),
                   coverage=dict(scope='all_listed_a_shares', expectedCount=source['expectedCount'],
                                 receivedCount=len(symbols), directoryCount=len(directory), paginationComplete=True))
        rows, eligible = [], []
        for security in securities:
            name = security.get('name')
            named = (security.get('nameVerified') is True and isinstance(name, str)
                     and 0 < len(name.strip()) <= 80 and re.search(r'[\u3400-\u9fff]', name)
                     and not re.search(r'[\x00-\x1f\x7f]', name))
            row = dict(symbol=security['symbol'], name=name.strip() if named else '名称待核',
                       nameStatus='verified_source' if named else 'pending', status='pending',
                       qualification='pending', hits=[], branches={k:dict(status='pending', reasons=[]) for k in RULES},
                       reasons=[], price=None, sourceTime=None, receivedAt=None, metrics=None)
            rows.append(row)
            try:
                q, reasons = _qualification(security, day, cutoff, clock)
                row.update(qualification=q, reasons=reasons)
                if q != 'qualified':
                    row['status'] = 'excluded' if q == 'excluded' else 'pending'
                    continue
                eligible.append(security['symbol'])
                m, baseline_reason = _metrics(security, dates, cutoff, clock, received)
                row.update(metrics=m, price=m['price'], sourceTime=security['snapshot']['sourceTime'],
                           receivedAt=security['snapshot']['receivedAt'])
                if baseline_reason:
                    row['reasons'].append(baseline_reason)
                    for branch in row['branches'].values():
                        branch['reasons'] = [baseline_reason]
                    continue
                common = [(market_ok, 'market_environment_weak'),
                          (m['meanTurnover'] >= PARAMETERS['minMeanTurnover'], 'historical_liquidity_below_floor')]
                trend = m['previousClose'] > m['ma20'] > m['ma50'] and m['ma50Up']
                row['branches']['A14-R1'] = _branch(common+[(trend, 'prior_trend_not_confirmed'),
                    (m['price'] > m['high20'], 'prior_20_high_not_broken'),
                    (m['turnoverRatio'] >= PARAMETERS['breakoutTurnoverRatio'], 'same_cutoff_turnover_below_breakout'),
                    (m['rangePosition'] is not None and m['rangePosition'] >= PARAMETERS['minBreakoutRangePosition'],
                     'intraday_range_position_weak'),
                    (m['price']/m['ma20']-1 <= PARAMETERS['maxBreakoutExtension'], 'price_too_extended')])
                row['branches']['A14-R2'] = _branch(common+[(trend, 'prior_trend_not_confirmed'),
                    (m['pullbackTurnover'], 'prior_pullback_turnover_not_contracted'),
                    (m['price'] > m['previousHigh'] and m['price'] >= m['vwap'], 'recovery_not_confirmed'),
                    (m['turnoverRatio'] >= PARAMETERS['recoveryTurnoverRatio'], 'same_cutoff_turnover_below_recovery'),
                    (m['price']/m['ma20']-1 <= PARAMETERS['maxRecoveryExtension'], 'price_too_extended')])
            except (ValueError, TypeError, KeyError, OverflowError, OSError) as error:
                row['reasons'].append(_reason(error, 'security_evidence_incomplete'))
        sectors, sector_reason = _sector_evidence(batch, rows, eligible, cutoff, clock)
        for row in rows:
            m = row['metrics']
            if row['qualification'] != 'qualified' or m is None or m['turnoverRatio'] is None:
                continue
            if sector_reason:
                row['branches']['A14-R3']['reasons'] = [sector_reason]
            else:
                sector = sectors[row['symbol']]
                row['sectorEvidence'] = sector
                row['branches']['A14-R3'] = _branch([
                    (market_ok, 'market_environment_weak'),
                    (m['meanTurnover'] >= PARAMETERS['minMeanTurnover'], 'historical_liquidity_below_floor'),
                    (m['price'] > m['ma20'] > m['ma50'] and m['ma50Up'], 'current_trend_not_confirmed'),
                    (m['dayChange'] > 0 and sector['topMember'], 'not_positive_top_sector_member'),
                    (m['turnoverRatio'] >= PARAMETERS['sectorTurnoverRatio'], 'same_cutoff_turnover_below_sector'),
                    (sector['memberCount'] >= PARAMETERS['minSectorMembers'], 'sector_sample_too_small'),
                    (sector['medianChange']-sector['marketMedianChange'] >= PARAMETERS['sectorMedianExcess'],
                     'sector_relative_strength_weak'),
                    (sector['advancingFraction'] >= PARAMETERS['sectorAdvancingFraction'], 'sector_breadth_weak')])
            row['hits'] = [k for k in RULES if row['branches'][k]['status'] == 'hit']
            row['status'] = 'preselection' if row['hits'] else 'pending' if any(
                x['status'] == 'pending' for x in row['branches'].values()) else 'unmatched'
        out.update(status='ready', rows=rows, counts={state:sum(r['status'] == state for r in rows)
                   for state in ('preselection', 'pending', 'excluded', 'unmatched')})
        return out
    except (ValueError, TypeError, KeyError, OverflowError, OSError) as error:
        out['reasons'] = [_reason(error, 'batch_evidence_incomplete')]
        return out


def _write_atomic(path, value):
    """Never leave a partially written result or replace it on serialization failure."""
    target = Path(path)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=target.parent,
                                         prefix='.'+target.name+'.', suffix='.tmp', delete=False) as handle:
            temporary = handle.name
            json.dump(value, handle, ensure_ascii=False, allow_nan=False, indent=2)
            handle.write('\n')
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, target)
    finally:
        if temporary is not None and os.path.exists(temporary):
            os.unlink(temporary)


def main(argv=None):
    parser = argparse.ArgumentParser(description='Offline A14 research preselection; no network or orders.')
    parser.add_argument('--input', required=True, type=Path, help='books.a14.input.v1 JSON file')
    parser.add_argument('--output', required=True, type=Path, help='Atomically replaced result JSON file')
    args = parser.parse_args(argv)
    try:
        if args.input.resolve() == args.output.resolve():
            parser.error('input and output must be different files')
        with args.input.open(encoding='utf-8') as handle:
            batch = json.load(handle)
        result = preselect(batch)
        _write_atomic(args.output, result)
    except (OSError, ValueError, TypeError, OverflowError) as error:
        parser.exit(2, 'A14 input/output failed: '+type(error).__name__+'\n')
    return 1 if result['status'] == 'blocked' else 0


if __name__ == '__main__':
    raise SystemExit(main())
