"""Offline next-session direction checks; timestamp claims are not proof of publication.

signal: market(a/us), symbol, strategy, strategyVersion, direction(up/down/watch), sessionDate,
closeTime, closeComplete, calendarVerified, close, createdAt, sourceReceivedAt,
adjustmentVerified, priceBasis; nextSession contains date/openTime/closeTime and
calendarVerified (attests the immediate next regular trading session).
outcome: matching market/symbol, sessionDate/openTime/closeTime, closeComplete,
calendarVerified, open/close, sourceReceivedAt, adjustmentVerified/priceBasis.
All timestamps need offsets. priceBasis must identify the adjustment anchor and
corporate-action treatment (splits, dividends, etc.); a generic "adjusted" label
is insufficient. Equality checks input attestations, not the underlying factors.
No network, calendar inference, trade fills, portfolio returns or win rates.
"""
from datetime import date, datetime, timezone
import math
import re
from zoneinfo import ZoneInfo


def _time(value):
    if not isinstance(value, str):
        raise ValueError('timestamp_missing')
    value = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if value.tzinfo is None or value.utcoffset() is None:
        raise ValueError('timezone_missing')
    return value


def _day(value):
    if not isinstance(value, str) or date.fromisoformat(value).isoformat() != value:
        raise ValueError('date_invalid')
    return value


def _price(value):
    return type(value) in (int, float) and math.isfinite(value) and value > 0


def evaluate_direction(signal, outcome, now=None):
    """Return pending evidence or hit/miss/tie/watch, never an inferred trade."""
    signal = signal if isinstance(signal, dict) else {}
    outcome = outcome if isinstance(outcome, dict) else {}
    market = signal.get('market') if signal.get('market') in ('a', 'us') else None
    symbol = signal.get('symbol') if isinstance(signal.get('symbol'), str) else None
    strategy = signal.get('strategy') if isinstance(signal.get('strategy'), str) else None
    version = signal.get('strategyVersion') if isinstance(signal.get('strategyVersion'), str) else None
    result = dict(schema='books.next-session.evaluation.v1', market=market,
                  symbol=symbol, strategy=strategy, strategyVersion=version,
                  signalDate=None, outcomeDate=None, requestedDirection=signal.get('direction') if signal.get('direction') in ('up', 'down', 'watch') else None,
                  observedDirection=None, directionHit=None, verdict='evidence_pending', evidenceClass='unverified',
                  publishedBeforeNextOpen=None, timestampEvidenceOnly=True,
                  signalTradingDayVerified=False, returns=None, reasons=[],
                  executionNotSimulated=True, executionStatus='intraday_verification_required',
                  aShareResaleConstraint='following_session_after_entry_required' if market == 'a' else None)
    reasons = result['reasons']
    if (market not in ('a', 'us') or not isinstance(result['symbol'], str)
            or not re.fullmatch(r'[A-Za-z0-9._:-]{1,40}', result['symbol'])
            or not isinstance(result['strategy'], str)
            or not re.fullmatch(r'[A-Za-z0-9_-]{1,40}', result['strategy'])):
        reasons.append('signal_identity_invalid')
        return result
    if version is None or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._+-]{0,79}', version):
        reasons.append('strategy_version_missing_invalid')
        return result
    if outcome.get('market') != market or outcome.get('symbol') != result['symbol']:
        reasons.append('outcome_identity_mismatch')
    if result['requestedDirection'] not in ('up', 'down', 'watch'):
        reasons.append('direction_invalid')
    zone = ZoneInfo('Asia/Shanghai' if market == 'a' else 'America/New_York')
    try:
        clock = datetime.now(timezone.utc) if now is None else now
        if type(clock) in (int, float) and math.isfinite(clock):
            clock = datetime.fromtimestamp(clock, timezone.utc)
        if not isinstance(clock, datetime) or clock.tzinfo is None:
            raise ValueError('invalid_now')
        signal_day = _day(signal.get('sessionDate'))
        close_at = _time(signal.get('closeTime'))
        created = _time(signal.get('createdAt'))
        received = _time(signal.get('sourceReceivedAt'))
        next_session = signal.get('nextSession')
        if not isinstance(next_session, dict):
            raise ValueError('next_session_missing_invalid')
        next_day = _day(next_session.get('date'))
        next_open, next_close = map(_time, (next_session.get('openTime'), next_session.get('closeTime')))
        result.update(signalDate=signal_day, outcomeDate=next_day)
        local_day = lambda instant: instant.astimezone(zone).date().isoformat()
        signal_verified = (signal.get('calendarVerified') is True and signal.get('closeComplete') is True
                           and local_day(close_at) == signal_day)
        result['signalTradingDayVerified'] = signal_verified
        if not signal_verified:
            reasons.append('signal_close_or_calendar_unverified')
        if (next_session.get('calendarVerified') is not True or next_day <= signal_day
                or local_day(next_open) != next_day or local_day(next_close) != next_day
                or not close_at < next_open < next_close):
            reasons.append('next_session_unverified')
        if not close_at <= received <= created <= clock:
            reasons.append('signal_timing_invalid')
        if signal_verified and 'next_session_unverified' not in reasons and 'signal_timing_invalid' not in reasons:
            before = created < next_open
            result.update(publishedBeforeNextOpen=before,
                          evidenceClass='prospective_timestamp_claim' if before else 'historical_replay')
        if (_day(outcome.get('sessionDate')) != next_day
                or _time(outcome.get('openTime')) != next_open
                or _time(outcome.get('closeTime')) != next_close):
            reasons.append('outcome_session_mismatch')
        if outcome.get('calendarVerified') is not True or outcome.get('closeComplete') is not True:
            reasons.append('outcome_close_or_calendar_unverified')
        if not next_close <= _time(outcome.get('sourceReceivedAt')) <= clock:
            reasons.append('outcome_timing_invalid')
    except (ValueError, TypeError, OverflowError, OSError):
        reasons.append('dates_or_timezone_missing_invalid')
    if (signal.get('adjustmentVerified') is not True or outcome.get('adjustmentVerified') is not True
            or not isinstance(signal.get('priceBasis'), str) or not signal['priceBasis'].strip()
            or signal.get('priceBasis') != outcome.get('priceBasis')):
        reasons.append('price_basis_unverified')
    if not all(_price(value) for value in (signal.get('close'), outcome.get('open'), outcome.get('close'))):
        reasons.append('prices_missing_invalid')
    if reasons:
        return result
    c, o, n = signal['close'], outcome['open'], outcome['close']
    returns = dict(closeToClose=n/c-1, openToClose=n/o-1, overnightGap=o/c-1)
    if not all(math.isfinite(value) for value in returns.values()):
        reasons.append('derived_returns_invalid')
        return result
    observed = 'up' if n > c else 'down' if n < c else 'tie'
    expected = result['requestedDirection']
    verdict = 'watch' if expected == 'watch' else 'tie' if observed == 'tie' else 'hit' if observed == expected else 'miss'
    result.update(observedDirection=observed, verdict=verdict, returns=returns,
                  directionHit=True if verdict == 'hit' else False if verdict == 'miss' else None)
    return result


def summarize_direction(results):
    """Deduplicate identical evaluations; separate late replay from timestamp-based claims."""
    seen, grouped, days = {}, {}, {}
    for row in results:
        if not isinstance(row, dict) or row.get('schema') != 'books.next-session.evaluation.v1':
            raise ValueError('evaluation_schema_invalid')
        version = row.get('strategyVersion')
        if not isinstance(version, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._+-]{0,79}', version):
            raise ValueError('evaluation_strategy_version_missing_invalid')
        key = tuple(row.get(k) for k in ('market', 'symbol', 'strategy', 'strategyVersion', 'signalDate'))
        if key in seen:
            if row != seen[key]:
                raise ValueError('conflicting_signal_evaluation')
            continue
        seen[key] = row
        strategy = str(row.get('market')) + ':' + str(row.get('strategy')) + ':' + version
        kind = row.get('evidenceClass', 'unverified')
        if kind not in ('prospective_timestamp_claim', 'historical_replay', 'unverified'):
            raise ValueError('evaluation_class_invalid')
        bucket = grouped.setdefault(strategy, {}).setdefault(kind, dict(
            signals=0, directionSamples=0, hits=0, misses=0, ties=0, watch=0, unresolved=0))
        bucket['signals'] += 1
        verdict = row.get('verdict')
        if verdict in ('hit', 'miss', 'tie'):
            bucket['directionSamples'] += 1
            bucket[{'hit': 'hits', 'miss': 'misses', 'tie': 'ties'}[verdict]] += 1
        elif verdict == 'watch':
            bucket['watch'] += 1
        else:
            bucket['unresolved'] += 1
        if row.get('signalTradingDayVerified') is True and row.get('signalDate'):
            days.setdefault((strategy, kind), set()).add(row['signalDate'])
    for strategy, kinds in grouped.items():
        for kind, bucket in kinds.items():
            bucket['distinctTradingDays'] = len(days.get((strategy, kind), set()))
    return dict(schema='books.next-session.summary.v1', timestampEvidenceOnly=True,
                executionNotSimulated=True, byStrategy=grouped)
