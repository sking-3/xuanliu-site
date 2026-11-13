"""Offline long-entry quote observations, never fills, PnL or direction hit rates.

Plan: market/symbol/strategy/strategyVersion, direction='up', sessionDate,
signalCloseTime/sourceReceivedAt/createdAt, calendarVerified/closeComplete,
nextSession={date,openTime,closeTime,calendarVerified}, trigger/invalidation/
maxEntryPrice; optional frozen maxQuoteAgeMs/maxDataLagMs (default 2000).
Plan and observation require adjustmentVerified=True and identical priceBasis
naming the adjustment anchor and corporate-action treatment. Frozen levels must
be converted to the actual quoted price units. trigger is the frozen quotable
threshold: a breakout caller must convert prior highs and apply its strict tick
step before freezing; >= here means touching trigger, not proving a breakout.
Observation: matching market/symbol, kind='ticks' or 'minute_ohlc',
coverageVerified/coverageStart/coverageEnd, events in source-time order.
Each event: sourceTime/receivedAt/price; quote evidence adds bid/ask/quoteTime,
tradingNormal=True, limitStateVerified=True, lockedLimit=False. The first event
needs isOpeningPrice=True at nextSession.openTime to attest the opening print;
this flag must come from source evidence, not the first row of a partial feed.
Coverage attests a gap-free interval; it cannot be proved from sampled rows.
All timestamps need offsets. Claims are input evidence, not signed publication.
"""
from datetime import datetime, timezone
import math
import re
from zoneinfo import ZoneInfo
from .next_session import _time, _day, _price

STATUSES = ('not_triggered', 'invalidation_before_trigger', 'opening_out_of_entry_range',
            'trigger_touched_quote_unverified', 'quoted_opportunity_observed',
            'intraday_verification_required', 'evidence_pending')


def observe_entry_plan(plan, observation, now=None):
    plan = plan if isinstance(plan, dict) else {}
    observation = observation if isinstance(observation, dict) else {}
    safe = lambda key: plan.get(key) if isinstance(plan.get(key), str) else None
    result = dict(schema='books.entry-observation.v1', market=safe('market'), symbol=safe('symbol'),
                  strategy=safe('strategy'), strategyVersion=safe('strategyVersion'), signalDate=None,
                  sessionDate=None, status='evidence_pending', evidenceClass='unverified',
                  timestampEvidenceOnly=True, executionNotSimulated=True, tradingDayVerified=False,
                  coverageVerified=False, eventCount=0, observedAt=None, receivedAt=None,
                  quotedBid=None, quotedAsk=None, invalidatedAfterOpportunity=False, reasons=[])
    reasons = result['reasons']
    try:
        if (result['market'] not in ('a', 'us') or not result['symbol']
                or not re.fullmatch(r'[A-Za-z0-9._:-]{1,40}', result['symbol'])
                or not result['strategy'] or not re.fullmatch(r'[A-Za-z0-9_-]{1,40}', result['strategy'])
                or not result['strategyVersion'] or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._+-]{0,79}', result['strategyVersion'])):
            raise ValueError('plan_identity_or_version_invalid')
        if any(observation.get(key) != result[key] for key in ('market', 'symbol')):
            raise ValueError('observation_identity_mismatch')
        if plan.get('direction') != 'up':
            raise ValueError('only_long_entry_semantics_supported')
        basis = plan.get('priceBasis')
        if (plan.get('adjustmentVerified') is not True or observation.get('adjustmentVerified') is not True
                or not isinstance(basis, str) or not basis.strip() or basis != observation.get('priceBasis')):
            raise ValueError('entry_price_basis_unverified')
        result['priceBasis'] = basis
        trigger, invalidation, maximum = (plan.get(key) for key in ('trigger', 'invalidation', 'maxEntryPrice'))
        if not all(_price(value) for value in (trigger, invalidation, maximum)) or not invalidation < trigger <= maximum:
            raise ValueError('frozen_price_levels_invalid')
        result['levels'] = dict(trigger=trigger, invalidation=invalidation, maxEntryPrice=maximum)
        quote_age, lag = plan.get('maxQuoteAgeMs', 2000), plan.get('maxDataLagMs', 2000)
        if not all(_price(value) and value <= 60000 for value in (quote_age, lag)):
            raise ValueError('freshness_policy_invalid')
        result['freshnessPolicyMs'] = dict(maxQuoteAgeMs=quote_age, maxDataLagMs=lag)
        clock = datetime.now(timezone.utc) if now is None else now
        if type(clock) in (int, float) and math.isfinite(clock):
            clock = datetime.fromtimestamp(clock, timezone.utc)
        if not isinstance(clock, datetime) or clock.tzinfo is None:
            raise ValueError('clock_invalid')
        signal_day, signal_close = _day(plan.get('sessionDate')), _time(plan.get('signalCloseTime'))
        source, created = _time(plan.get('sourceReceivedAt')), _time(plan.get('createdAt'))
        session = plan.get('nextSession')
        if not isinstance(session, dict):
            raise ValueError('next_session_missing')
        day, opened, closed = _day(session.get('date')), _time(session.get('openTime')), _time(session.get('closeTime'))
        zone = ZoneInfo('Asia/Shanghai' if result['market'] == 'a' else 'America/New_York')
        local_day = lambda instant: instant.astimezone(zone).date().isoformat()
        if (plan.get('calendarVerified') is not True or plan.get('closeComplete') is not True
                or session.get('calendarVerified') is not True or local_day(signal_close) != signal_day
                or local_day(opened) != day or local_day(closed) != day or day <= signal_day
                or not signal_close <= source <= created <= clock or not signal_close < opened < closed):
            raise ValueError('plan_time_or_calendar_unverified')
        result.update(signalDate=signal_day, sessionDate=day, tradingDayVerified=opened <= clock,
                      evidenceClass='prospective_timestamp_claim' if created < opened else 'historical_replay')
        result['status'] = 'intraday_verification_required'
        if observation.get('kind') != 'ticks':
            reasons.append('ordered_ticks_required_not_ohlc')
            return result
        start, end = _time(observation.get('coverageStart')), _time(observation.get('coverageEnd'))
        if not opened <= start <= end <= min(closed, clock):
            raise ValueError('coverage_times_invalid')
        prefix = observation.get('coverageVerified') is True and start == opened
        result['coverageVerified'] = prefix
        raw = observation.get('events')
        if not isinstance(raw, list):
            raise ValueError('tick_events_missing')
        ticks, previous, previous_received, previous_value = [], None, None, None
        fields = ('price', 'bid', 'ask', 'quoteTime', 'tradingNormal', 'limitStateVerified', 'lockedLimit', 'isOpeningPrice')
        for event in raw:
            if not isinstance(event, dict) or not _price(event.get('price')):
                raise ValueError('tick_price_invalid')
            if any(key in event and event[key] != result[key] for key in ('market', 'symbol')):
                raise ValueError('tick_identity_mismatch')
            t, received = _time(event.get('sourceTime')), _time(event.get('receivedAt'))
            if not start <= t <= end or not t <= received <= clock:
                raise ValueError('tick_time_invalid')
            value = (received,) + tuple(event.get(key) for key in fields)
            if previous == t and value == previous_value:
                continue
            if previous is not None and (t <= previous or received < previous_received):
                raise ValueError('ticks_unordered_or_conflicting')
            ticks.append((event, t, received))
            previous, previous_received, previous_value = t, received, value
        result['eventCount'] = len(ticks)
        if not ticks:
            reasons.append('no_tick_observations')
            return result
        first, first_time, _ = ticks[0]
        opening_known = prefix and first_time == opened and first.get('isOpeningPrice') is True
        if opening_known and first['price'] > maximum:
            result['status'] = 'opening_out_of_entry_range'
            return result
        touched = False
        for event, t, received in ticks:
            if event['price'] <= invalidation:
                if result['status'] == 'quoted_opportunity_observed':
                    result['invalidatedAfterOpportunity'] = True
                elif prefix and not touched:
                    result['status'] = 'invalidation_before_trigger'
                reasons.append('invalidation_observed')
                break
            if event['price'] < trigger:
                continue
            touched = True
            try:
                qt, bid, ask = _time(event.get('quoteTime')), event.get('bid'), event.get('ask')
                valid_quote = (prefix and opening_known and _price(bid) and _price(ask) and invalidation < bid < ask
                               and trigger <= ask <= maximum and qt <= t
                               and (received - qt).total_seconds()*1000 <= quote_age
                               and (received - t).total_seconds()*1000 <= lag
                               and event.get('tradingNormal') is True and event.get('limitStateVerified') is True
                               and event.get('lockedLimit') is False)
            except (ValueError, TypeError):
                valid_quote = False
            if valid_quote and result['status'] != 'quoted_opportunity_observed':
                result.update(status='quoted_opportunity_observed', observedAt=event['sourceTime'],
                              receivedAt=event['receivedAt'], quotedBid=bid, quotedAsk=ask)
            elif result['status'] != 'quoted_opportunity_observed':
                result['status'] = 'trigger_touched_quote_unverified'
        if result['status'] == 'intraday_verification_required' and prefix and end == closed:
            result['status'] = 'not_triggered'
        if not prefix or end < closed:
            reasons.append('full_session_coverage_not_verified')
        return result
    except (ValueError, TypeError, OverflowError, OSError) as error:
        code = str(error)
        reasons.append(code if re.fullmatch(r'[a-z][a-z0-9_]{0,79}', code) else 'time_or_structure_invalid')
        result['status'] = 'evidence_pending'
        return result


def summarize_entry_plans(results):
    """Latest evaluation per frozen plan; replay and timestamp claims stay separate."""
    seen, groups, days = {}, {}, {}
    for row in results:
        if not isinstance(row, dict) or row.get('schema') != 'books.entry-observation.v1' or row.get('status') not in STATUSES:
            raise ValueError('entry_evaluation_invalid')
        if not isinstance(row.get('strategyVersion'), str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._+-]{0,79}', row['strategyVersion']):
            raise ValueError('entry_evaluation_version_invalid')
        key = tuple(row.get(key) for key in ('market', 'symbol', 'strategy', 'strategyVersion', 'signalDate', 'sessionDate'))
        if key in seen:
            if row != seen[key]:
                raise ValueError('conflicting_entry_evaluation')
            continue
        seen[key] = row
        strategy = ':'.join(str(row.get(key)) for key in ('market', 'strategy', 'strategyVersion'))
        kind = row.get('evidenceClass', 'unverified')
        if kind not in ('prospective_timestamp_claim', 'historical_replay', 'unverified'):
            raise ValueError('entry_evaluation_class_invalid')
        bucket = groups.setdefault(strategy, {}).setdefault(kind, dict(signals=0, **{s:0 for s in STATUSES}))
        bucket['signals'] += 1
        bucket[row['status']] += 1
        if row.get('tradingDayVerified') is True:
            days.setdefault((strategy, kind), set()).add(row['sessionDate'])
    for strategy, kinds in groups.items():
        for kind, bucket in kinds.items():
            bucket['distinctTradingDays'] = len(days.get((strategy, kind), set()))
    return dict(schema='books.entry-observation-summary.v1', executionNotSimulated=True,
                timestampEvidenceOnly=True, byStrategy=groups)
