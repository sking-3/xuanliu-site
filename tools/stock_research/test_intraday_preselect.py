"""Synthetic offline research fixtures; never production market data or returns."""
from copy import deepcopy
from datetime import date, datetime, timedelta, timezone
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from .intraday_preselect import preselect, VERSION, _write_atomic

DAY = '2026-11-13'
CUTOFF = DAY+'T14:00:00+08:00'
NOW = datetime.fromisoformat(DAY+'T14:00:05+08:00')


def fixture():
    # Intentionally synthetic weekday calendar, not an attestation of exchange holidays.
    dates, d = [], date(2026, 11, 12)
    while len(dates) < 61:
        if d.weekday() < 5:
            dates.append(d.isoformat())
        d -= timedelta(days=1)
    dates.reverse()
    securities = []
    for i in range(10):
        symbol = f'{600001+i:06d}.SH' if i < 5 else f'{i:06d}.SZ'
        bars = []
        for j, day in enumerate(dates):
            close = round(10+j*.05, 4)
            bars.append(dict(date=day, open=close-.02, high=close+.1, low=close-.1,
                             close=close, volume=10_000_000, turnover=close*10_000_000))
        change = .05 if i == 0 else .04 if i < 5 else 0
        price = bars[-1]['close']*(1+change)
        basis = 'SYNTHETIC current-quote-units@2026-11-13;actions-known-before-cutoff'
        securities.append(dict(symbol=symbol, name='合成股票'+str(i), nameVerified=True,
            eligibility=dict(asOf=DAY, exchange='SSE' if i < 5 else 'SZSE', board='main',
                assetType='ordinary_stock', scopeVerified=True, isST=False, riskWarning=False,
                knownAt=DAY+'T09:00:00+08:00', receivedAt=DAY+'T09:00:01+08:00',
                delisted=False, suspended=False, normalLimitVerified=True, limitPct=10),
            historyComplete=True, adjustmentVerified=True, priceBasis=basis, priceAnchorDate=DAY,
            adjustmentKnownAt=DAY+'T09:00:00+08:00', history=bars,
            snapshot=dict(last=price, open=13, highSoFar=price+.05, lowSoFar=12.9,
                cumulativeVolume=10_000_000, cumulativeTurnover=(price+13)/2*10_000_000,
                priceBasis=basis, priceAnchorDate=DAY, adjustmentVerified=True, sourceTime=DAY+'T13:59:50+08:00',
                receivedAt=DAY+'T14:00:01+08:00'),
            sameCutoffTurnover=[dict(date=d, cutoffTime='14:00:00', complete=True,
                                     turnover=60_000_000) for d in dates[-20:]]))
    benchmark_basis = 'SYNTHETIC index-quote-units@2026-11-13;no-corporate-actions'
    return dict(schema='books.a14.input.v1', market='a', strategyVersion=VERSION, audience='owner',
        units=dict(price='CNY', volume='shares', turnover='CNY'),
        session=dict(date=DAY, cutoff=CUTOFF, calendarVerified=True, isOpen=True,
            previousSessionDate=dates[-1], historyTradingDates=dates,
            nextSession=dict(date='2026-11-16', openTime='2026-11-16T09:30:00+08:00',
                             closeTime='2026-11-16T15:00:00+08:00', calendarVerified=True)),
        source=dict(id='SYNTHETIC_TEST_ONLY', permissionsVerified=True, accessScope='personal',
            redistributionAllowed=False, coverage='full_universe', paginationComplete=True,
            expectedCount=10, dataAsOf=DAY, sourceTime=CUTOFF, receivedAt=DAY+'T14:00:02+08:00'),
        universe=dict(scope='all_listed_a_shares', asOf=DAY, complete=True,
            knownAt=DAY+'T09:00:00+08:00', receivedAt=DAY+'T09:00:01+08:00',
            symbols=[s['symbol'] for s in securities]),
        benchmark=dict(symbol='SSE:000001', historyComplete=True, adjustmentVerified=True,
            priceAnchorDate=DAY, adjustmentKnownAt=DAY+'T09:00:00+08:00',
            priceBasis=benchmark_basis, history=[dict(date=d, close=100+i*.1) for i, d in enumerate(dates)],
            snapshot=dict(last=107, priceBasis=benchmark_basis, priceAnchorDate=DAY, adjustmentVerified=True,
                sourceTime=DAY+'T13:59:50+08:00', receivedAt=DAY+'T14:00:01+08:00')),
        securities=securities,
        sectors=dict(asOf=DAY, membershipComplete=True, quoteCoverageComplete=True,
            scope='qualified_mainboard', knownAt=DAY+'T09:00:00+08:00',
            receivedAt=DAY+'T09:00:01+08:00',
            members=dict(HIGH=[s['symbol'] for s in securities[:5]],
                         LOW=[s['symbol'] for s in securities[5:]])))


def row(result, index=0):
    return result['rows'][index]


def rename_security(value, symbol):
    old = value['securities'][0]['symbol']
    value['securities'][0]['symbol'] = symbol
    value['universe']['symbols'][0] = symbol
    for members in value['sectors']['members'].values():
        if old in members:
            members[members.index(old)] = symbol
    value['securities'][0]['eligibility']['exchange'] = {'SH':'SSE', 'SZ':'SZSE', 'BJ':'BSE'}[symbol[-2:]]


class IntradayPreselection(unittest.TestCase):
    def assert_blocked(self, value):
        result = preselect(value, NOW)
        self.assertEqual(result['status'], 'blocked')
        self.assertEqual(result['rows'], [])
        self.assertIsNone(result['counts'])
        return result

    def test_independent_hits_merge_as_research_preselection_without_probability(self):
        result = preselect(fixture(), NOW)
        self.assertEqual(result['status'], 'ready')
        self.assertEqual(row(result)['hits'], ['A14-R1', 'A14-R3'])
        self.assertEqual(row(result)['status'], 'preselection')
        self.assertEqual(row(result)['branches']['A14-R2']['status'], 'miss')
        self.assertEqual(result['nextSessionDate'], '2026-11-16')
        self.assertEqual(result['generatedAt'], NOW.astimezone(timezone.utc).isoformat())
        self.assertTrue(result['timestampEvidenceOnly'])
        self.assertFalse(result['validatedEdge'])
        for forbidden in ('probability', 'expectedReturn', 'PnL', 'orders', 'winRate'):
            self.assertNotIn(forbidden, json.dumps(result))

    def test_recovery_can_hit_without_a_twenty_day_breakout_or_sector_data(self):
        value = fixture()
        s = value['securities'][0]
        for b in s['history'][-3:]:
            b['volume'] = 2_000_000
            b['turnover'] = b['close']*b['volume']
        last = s['history'][-1]
        last.update(open=12.68, high=12.8, low=12.6, close=12.7, turnover=25_400_000)
        s['snapshot'].update(last=13, open=12.8, highSoFar=13.1, lowSoFar=12.7,
                             cumulativeVolume=6_000_000, cumulativeTurnover=77_700_000)
        value.pop('sectors')
        result = preselect(value, NOW)
        self.assertEqual(row(result)['hits'], ['A14-R2'])
        self.assertEqual(row(result)['status'], 'preselection')
        self.assertEqual(row(result)['branches']['A14-R3']['status'], 'pending')

    def test_sector_branch_can_hit_without_the_two_price_breakout_branches(self):
        value = fixture()
        value['securities'][0]['history'][-1]['high'] = 14
        result = preselect(value, NOW)
        self.assertEqual(row(result)['hits'], ['A14-R3'])
        self.assertTrue(row(result)['sectorEvidence']['topMember'])

    def test_share_count_changes_alone_cannot_fake_recovery_turnover_contraction(self):
        value = fixture()
        s = value['securities'][0]
        # Historical prices can be in current units while historical share counts
        # remain unadjusted; raw CNY turnover does not contract in this fixture.
        for b in s['history'][-3:]:
            b['volume'] = 1_000_000
        s['history'][-1]['high'] = 13.01
        s['snapshot'].update(last=13.02, open=13, highSoFar=13.07, lowSoFar=12.9,
                             cumulativeVolume=6_000_000, cumulativeTurnover=78_000_000)
        r = row(preselect(value, NOW))
        self.assertEqual(r['branches']['A14-R2']['status'], 'miss')
        self.assertIn('prior_pullback_turnover_not_contracted', r['branches']['A14-R2']['reasons'])

    def test_verified_weak_market_can_report_no_preselection_without_a_missing_data_claim(self):
        value = fixture(); value['benchmark']['snapshot']['last'] = 100
        result = preselect(value, NOW)
        self.assertEqual(result['status'], 'ready')
        self.assertEqual(result['counts']['preselection'], 0)
        self.assertEqual(result['counts']['pending'], 0)
        self.assertEqual(result['counts']['unmatched'], 10)
        self.assertEqual(result['coverage']['receivedCount'], 10)

    def test_permissions_refusals_and_unreconciled_coverage_block_the_whole_batch(self):
        changes = [lambda v:v['source'].update(permissionsVerified=False),
                   lambda v:v['source'].update(permissionsVerified=1),
                   lambda v:v['source'].pop('permissionsVerified'),
                   lambda v:v['source'].update(stopped=True),
                   lambda v:v['source'].update(errorCode='http_429'),
                   lambda v:v['source'].update(paginationComplete=False),
                   lambda v:v['source'].update(coverage='watchlist'),
                   lambda v:v['source'].update(expectedCount=True),
                   lambda v:v['source'].update(expectedCount=11),
                   lambda v:v['universe'].update(complete=False),
                   lambda v:v['universe']['symbols'].pop(),
                   lambda v:v['securities'].append(deepcopy(v['securities'][0])),
                   lambda v:v['universe']['symbols'].append(v['universe']['symbols'][0])]
        for index, change in enumerate(changes):
            with self.subTest(index=index):
                value = fixture(); change(value); self.assert_blocked(value)

    def test_publication_requires_separate_public_rights_not_just_personal_access(self):
        value = fixture()
        self.assertEqual(preselect(value, NOW)['status'], 'ready')
        value['audience'] = 'public'
        self.assert_blocked(value)
        value['source'].update(accessScope='public', redistributionAllowed=True)
        self.assertEqual(preselect(value, NOW)['status'], 'ready')
        value['source']['redistributionAllowed'] = 1
        self.assert_blocked(value)

    def test_strict_cutoff_and_batch_times_do_not_relabel_later_or_yesterday_data(self):
        for key, stamp in [('sourceTime', DAY+'T14:00:01+08:00'),
                           ('sourceTime', DAY+'T13:57:59+08:00'),
                           ('sourceTime', '2026-11-12T14:00:00+08:00'),
                           ('receivedAt', DAY+'T14:00:06+08:00')]:
            with self.subTest(key=key, stamp=stamp):
                value = fixture(); value['source'][key] = stamp; self.assert_blocked(value)
        value = fixture(); value['session']['cutoff'] = DAY+'T14:00:01+08:00'; self.assert_blocked(value)
        value = fixture(); value['session']['cutoff'] = DAY+'T06:00:00Z'
        self.assertEqual(preselect(value, NOW)['cutoff'], CUTOFF)
        self.assertEqual(preselect(fixture(), NOW-timedelta(seconds=6))['status'], 'blocked')

    def test_per_stock_age_boundary_late_quotes_and_future_receipts_stay_pending(self):
        value = fixture(); value['securities'][0]['snapshot']['sourceTime'] = DAY+'T13:58:00+08:00'
        self.assertIn('A14-R1', row(preselect(value, NOW))['hits'])
        for stamp in [DAY+'T13:57:59+08:00', DAY+'T14:00:01+08:00', DAY+'T13:59:00Z',
                      DAY+'T13:59:00']:
            with self.subTest(stamp=stamp):
                value = fixture(); value['securities'][0]['snapshot']['sourceTime'] = stamp
                result = preselect(value, NOW)
                self.assertEqual(result['status'], 'ready')
                self.assertEqual(row(result)['status'], 'pending')
                self.assertEqual(row(result)['hits'], [])
                self.assertIsNone(row(result)['price'])
                self.assertIn('A14-R1', row(result, 1)['hits'])
        value = fixture(); value['securities'][0]['snapshot']['receivedAt'] = DAY+'T14:00:06+08:00'
        self.assertEqual(row(preselect(value, NOW))['status'], 'pending')

    def test_same_cutoff_baseline_is_consecutive_unique_complete_and_never_full_day(self):
        for change in [lambda s:s.update(sameCutoffTurnover=s['sameCutoffTurnover'][-9:]),
                       lambda s:s['sameCutoffTurnover'][0].update(date=s['sameCutoffTurnover'][1]['date']),
                       lambda s:s['sameCutoffTurnover'][0].update(cutoffTime='15:00:00'),
                       lambda s:s['sameCutoffTurnover'][0].update(complete=False),
                       lambda s:s['sameCutoffTurnover'][0].update(turnover=True),
                       lambda s:s['sameCutoffTurnover'][-1].update(date=DAY)]:
            value = fixture(); change(value['securities'][0])
            self.assertEqual(row(preselect(value, NOW))['status'], 'pending')
        value = fixture(); value['securities'][0]['sameCutoffTurnover'] = value['securities'][0]['sameCutoffTurnover'][-10:]
        result = preselect(value, NOW)
        self.assertIn('A14-R1', row(result)['hits'])
        self.assertEqual(row(result)['metrics']['baselineDays'], 10)

    def test_today_daily_bar_and_missing_history_never_become_intraday_evidence(self):
        for change in [lambda s:s['history'][-1].update(date=DAY),
                       lambda s:s['history'].append({**s['history'][-1], 'date':DAY, 'close':999}),
                       lambda s:s.update(history=s['history'][1:]),
                       lambda s:s.update(historyComplete=False),
                       lambda s:s['history'][0].update(close=float('nan'))]:
            value = fixture(); change(value['securities'][0])
            self.assertEqual(row(preselect(value, NOW))['status'], 'pending')

    def test_price_basis_corporate_action_and_unit_ambiguity_are_not_guessed(self):
        for change in [lambda s:s.update(adjustmentVerified=False),
                       lambda s:s['snapshot'].update(adjustmentVerified=False),
                       lambda s:s.update(priceAnchorDate='2026-11-16'),
                       lambda s:s.update(adjustmentKnownAt=DAY+'T14:00:01+08:00'),
                       lambda s:s['snapshot'].update(priceAnchorDate='2026-11-16'),
                       lambda s:s['snapshot'].update(priceBasis='SYNTHETIC post-split-different-anchor'),
                       lambda s:s['snapshot'].update(cumulativeTurnover=133_000),
                       lambda s:s['snapshot'].update(cumulativeVolume=True),
                       lambda s:s['history'][0].update(volume=0)]:
            value = fixture(); change(value['securities'][0])
            self.assertEqual(row(preselect(value, NOW))['status'], 'pending')
        value = fixture(); value['units']['volume'] = 'hands'; self.assert_blocked(value)

    def test_sector_missing_future_or_inconsistent_evidence_does_not_hold_other_rules(self):
        changes = [lambda v:v.pop('sectors'),
                   lambda v:v['sectors'].update(quoteCoverageComplete=False),
                   lambda v:v['sectors'].update(asOf='2026-11-12'),
                   lambda v:v['sectors'].update(knownAt=DAY+'T14:00:01+08:00'),
                   lambda v:v['sectors']['members']['LOW'].append(v['sectors']['members']['HIGH'][0]),
                   lambda v:v['sectors']['members']['LOW'].pop()]
        for index, change in enumerate(changes):
            with self.subTest(index=index):
                value = fixture(); change(value); r = row(preselect(value, NOW))
                self.assertEqual(r['hits'], ['A14-R1'])
                self.assertEqual(r['status'], 'preselection')
                self.assertEqual(r['branches']['A14-R3']['status'], 'pending')

    def test_one_missing_flow_baseline_does_not_erase_other_stocks_valid_sector_prices(self):
        value = fixture()
        value['securities'][1]['sameCutoffTurnover'] = []
        result = preselect(value, NOW)
        self.assertEqual(row(result, 1)['status'], 'pending')
        self.assertIsNone(row(result, 1)['metrics']['turnoverRatio'])
        self.assertIn('A14-R3', row(result)['hits'])

    def test_qualification_is_independent_of_ten_percent_and_whole_market_identity(self):
        value = fixture()
        value['securities'][0]['eligibility']['isST'] = True
        value['securities'][1]['eligibility']['isST'] = None
        value['securities'][2]['eligibility']['board'] = 'chinext'
        value['securities'][3]['symbol'] = '920001.BJ'
        value['securities'][3]['eligibility'].update(exchange='BSE', board='beijing')
        value['universe']['symbols'] = [s['symbol'] for s in value['securities']]
        result = preselect(value, NOW)
        self.assertEqual(result['status'], 'ready')
        self.assertEqual([r['status'] for r in result['rows'][:4]],
                         ['excluded', 'pending', 'excluded', 'excluded'])
        self.assertTrue(all(not r['hits'] for r in result['rows'][:4]))

    def test_eligibility_cannot_be_backfilled_from_later_knowledge_or_future_receipts(self):
        late_clock = NOW.replace(hour=16)
        for fields in [dict(knownAt=DAY+'T15:30:00+08:00', receivedAt=DAY+'T15:30:01+08:00'),
                       dict(knownAt=DAY+'T14:00:00.000001+08:00', receivedAt=DAY+'T14:00:01+08:00'),
                       dict(knownAt=DAY+'T09:00:02+08:00', receivedAt=DAY+'T09:00:01+08:00'),
                       dict(receivedAt=DAY+'T16:00:06+08:00'),
                       dict(knownAt=DAY+'T09:00:00')]:
            with self.subTest(fields=fields):
                value = fixture(); value['securities'][0]['eligibility'].update(fields)
                result = preselect(value, late_clock)
                self.assertEqual(result['status'], 'ready')
                self.assertEqual(row(result)['status'], 'pending')
                self.assertEqual(row(result)['hits'], [])
                self.assertIsNone(row(result)['metrics'])
                self.assertIn('A14-R1', row(result, 1)['hits'])
        for missing in ('knownAt', 'receivedAt'):
            value = fixture(); value['securities'][0]['eligibility'].pop(missing)
            self.assertEqual(row(preselect(value, NOW))['status'], 'pending')
        # Knowledge at the cutoff is causal; transport may finish after cutoff,
        # but never after the actual invocation clock.
        value = fixture()
        value['securities'][0]['eligibility'].update(knownAt=CUTOFF, receivedAt=DAY+'T14:00:05+08:00')
        self.assertIn('A14-R1', row(preselect(value, NOW))['hits'])
        value['securities'][0]['eligibility']['receivedAt'] = DAY+'T14:00:06+08:00'
        self.assertEqual(row(preselect(value, NOW))['status'], 'pending')

    def test_scope_attestation_is_required_even_for_an_apparently_mainboard_stock(self):
        for scope in (None, False, 1, 'true'):
            with self.subTest(scope=scope):
                value = fixture(); value['securities'][0]['eligibility']['scopeVerified'] = scope
                r = row(preselect(value, NOW))
                self.assertEqual(r['status'], 'pending')
                self.assertEqual(r['hits'], [])
                self.assertIn('eligibility_scope_unverified', r['reasons'])
        value = fixture(); value['securities'][0]['eligibility'].pop('scopeVerified')
        self.assertEqual(row(preselect(value, NOW))['status'], 'pending')

    def test_ordinary_mainboard_codes_require_matching_verified_security_metadata(self):
        for symbol in ('600001.SH', '601001.SH', '603001.SH', '605001.SH',
                       '000001.SZ', '001001.SZ', '002001.SZ', '003001.SZ'):
            with self.subTest(symbol=symbol):
                value = fixture(); rename_security(value, symbol)
                r = row(preselect(value, NOW))
                self.assertEqual(r['qualification'], 'qualified')
                self.assertIn('A14-R1', r['hits'])
        for fields, expected in [(dict(assetType='etf'), 'excluded'),
                                 (dict(board='chinext'), 'excluded'),
                                 (dict(exchange='SZSE'), 'pending'),
                                 (dict(assetType=None), 'excluded')]:
            with self.subTest(fields=fields):
                value = fixture(); value['securities'][0]['eligibility'].update(fields)
                r = row(preselect(value, NOW))
                self.assertEqual(r['status'], expected)
                self.assertFalse(r['hits'])

    def test_other_code_families_cannot_qualify_by_claiming_mainboard_and_ordinary(self):
        for symbol in ('900901.SH', '688001.SH', '300001.SZ', '200001.SZ',
                       '510001.SH', '000001.SH', '920001.BJ'):
            with self.subTest(symbol=symbol):
                value = fixture(); rename_security(value, symbol)
                result = preselect(value, NOW)
                self.assertEqual(result['status'], 'ready')
                r = row(result)
                self.assertEqual(r['status'], 'excluded')
                self.assertEqual(r['qualification'], 'excluded')
                self.assertFalse(r['hits'])

    def test_unknown_chinese_name_is_explicit_without_inventing_an_issuer(self):
        value = fixture(); value['securities'][0]['name'] = 'SYNTHETIC ENGLISH ONLY'
        r = row(preselect(value, NOW))
        self.assertEqual(r['name'], '名称待核')
        self.assertEqual(r['nameStatus'], 'pending')
        self.assertEqual(r['symbol'], '600001.SH')
        self.assertEqual(r['status'], 'preselection')

    def test_calendar_and_benchmark_evidence_are_not_inferred_or_overwritten(self):
        changes = [lambda v:v['session'].update(calendarVerified=False),
                   lambda v:v['session']['nextSession'].update(calendarVerified=False),
                   lambda v:v['session']['historyTradingDates'].append(DAY),
                   lambda v:v['session']['historyTradingDates'].append(v['session']['historyTradingDates'][-1]),
                   lambda v:v['benchmark']['history'].append(deepcopy(v['benchmark']['history'][-1])),
                   lambda v:v['benchmark'].update(historyComplete=False),
                   lambda v:v['benchmark'].update(symbol='UNVERIFIED:INDEX'),
                   lambda v:v['benchmark']['snapshot'].update(priceBasis='OTHER'),
                   lambda v:v['benchmark']['snapshot'].update(sourceTime=DAY+'T14:00:01+08:00')]
        for index, change in enumerate(changes):
            with self.subTest(index=index):
                value = fixture(); change(value); self.assert_blocked(value)
        value = fixture(); value['session']['isOpen'] = False
        self.assertEqual(preselect(value, NOW)['status'], 'closed')

    def test_extreme_derived_ratios_and_untrusted_extra_fields_never_leak(self):
        value = fixture()
        for b in value['securities'][0]['sameCutoffTurnover']:
            b['turnover'] = 1e-310
        result = preselect(value, NOW)
        self.assertEqual(row(result)['status'], 'pending')
        json.dumps(result, allow_nan=False)
        value = fixture(); value['apiSecret'] = 'SYNTHETIC_PRIVATE_SENTINEL'
        value['source']['unknownProviderField'] = 'SYNTHETIC_PRIVATE_SENTINEL'
        value['securities'][0]['unknownProviderField'] = 'SYNTHETIC_PRIVATE_SENTINEL'
        self.assertNotIn('SYNTHETIC_PRIVATE_SENTINEL', json.dumps(preselect(value, NOW)))

    def test_input_is_unchanged_and_unread_future_outcomes_cannot_change_selection(self):
        value = fixture(); before = deepcopy(value)
        result = preselect(value, NOW)
        self.assertEqual(value, before)
        value['todayCompleteDailyBar'] = dict(close=999999, volume=999999999999)
        value['nextSessionOutcome'] = dict(close=.00001, high=999999)
        self.assertEqual(preselect(value, NOW), result)
        value['parameters'] = dict(breakoutTurnoverRatio=.01)
        self.assert_blocked(value)


class IntradayCLI(unittest.TestCase):
    def run_cli(self, *args):
        return subprocess.run([sys.executable, '-B', '-m', 'tools.stock_research.intraday_preselect',
                               *map(str, args)], cwd=Path(__file__).resolve().parents[2],
                              capture_output=True, text=True, timeout=20)

    def test_cli_uses_actual_utc_and_has_no_clock_override(self):
        # A past synthetic closed session needs no invented quote/calendar history.
        value = dict(schema='books.a14.input.v1', market='a', strategyVersion=VERSION,
                     session=dict(date='2000-01-03', cutoff='2000-01-03T14:00:00+08:00',
                                  calendarVerified=True, isOpen=False))
        with tempfile.TemporaryDirectory() as directory:
            source, output = Path(directory)/'input.json', Path(directory)/'result.json'
            source.write_text(json.dumps(value), encoding='utf-8')
            before = datetime.now(timezone.utc)
            process = self.run_cli('--input', source, '--output', output)
            after = datetime.now(timezone.utc)
            self.assertEqual(process.returncode, 0, process.stderr)
            result = json.loads(output.read_text(encoding='utf-8'))
            self.assertEqual(result['status'], 'closed')
            self.assertLessEqual(before, datetime.fromisoformat(result['generatedAt']))
            self.assertLessEqual(datetime.fromisoformat(result['generatedAt']), after)
            self.assertEqual(json.loads(source.read_text(encoding='utf-8')), value)
            original = output.read_bytes()
            process = self.run_cli('--input', source, '--output', output, '--now', CUTOFF)
            self.assertEqual(process.returncode, 2)
            self.assertEqual(output.read_bytes(), original)

    def test_cli_writes_blocked_result_but_preserves_existing_output_on_bad_input(self):
        with tempfile.TemporaryDirectory() as directory:
            source, output = Path(directory)/'input.json', Path(directory)/'result.json'
            source.write_text('{}', encoding='utf-8')
            process = self.run_cli('--input', source, '--output', output)
            self.assertEqual(process.returncode, 1, process.stderr)
            self.assertEqual(json.loads(output.read_text())['status'], 'blocked')
            original = output.read_bytes()
            source.write_text('{malformed SYNTHETIC_PRIVATE_SENTINEL', encoding='utf-8')
            process = self.run_cli('--input', source, '--output', output)
            self.assertEqual(process.returncode, 2)
            self.assertNotIn('SYNTHETIC_PRIVATE_SENTINEL', process.stderr)
            self.assertEqual(output.read_bytes(), original)
            process = self.run_cli('--input', source, '--output', source)
            self.assertEqual(process.returncode, 2)
            self.assertEqual(source.read_text(), '{malformed SYNTHETIC_PRIVATE_SENTINEL')

    def test_atomic_output_preserves_original_and_removes_temporary_files_on_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)/'result.json'
            output.write_text('original', encoding='utf-8')
            with self.assertRaises(ValueError):
                _write_atomic(output, dict(nonfinite=float('nan')))
            self.assertEqual(output.read_text(), 'original')
            with patch('tools.stock_research.intraday_preselect.os.replace', side_effect=OSError('denied')):
                with self.assertRaises(OSError):
                    _write_atomic(output, dict(status='ready'))
            self.assertEqual(output.read_text(), 'original')
            self.assertEqual(sorted(p.name for p in Path(directory).iterdir()), ['result.json'])


if __name__ == '__main__':
    unittest.main()
