"""Explicit synthetic fixtures only; no real market success claims."""
import copy
import unittest
from tools.stock_research.next_session import evaluate_direction, summarize_direction


def fixture(market='a'):
    zone, close, opened = ('+08:00', '15:00', '09:30') if market == 'a' else ('-05:00', '16:00', '09:30')
    signal = dict(market=market, symbol='600001' if market == 'a' else 'FIXTURE', strategy='A1' if market == 'a' else 'U1',
                  strategyVersion='research-v1', direction='up', sessionDate='2026-11-12', closeTime=f'2026-11-12T{close}:00{zone}', close=100,
                  createdAt=f'2026-11-12T20:00:00{zone}', sourceReceivedAt=f'2026-11-12T19:00:00{zone}',
                  calendarVerified=True, closeComplete=True, adjustmentVerified=True, priceBasis='synthetic_same_basis',
                  nextSession=dict(date='2026-11-13', openTime=f'2026-11-13T{opened}:00{zone}',
                                   closeTime=f'2026-11-13T{close}:00{zone}', calendarVerified=True))
    outcome = dict(market=market, symbol=signal['symbol'], sessionDate='2026-11-13',
                   openTime=signal['nextSession']['openTime'], closeTime=signal['nextSession']['closeTime'],
                   sourceReceivedAt=f'2026-11-13T20:00:00{zone}', open=110, close=105,
                   calendarVerified=True, closeComplete=True, adjustmentVerified=True, priceBasis='synthetic_same_basis')
    return signal, outcome


NOW = 1794690000  # 2026-11-14 21:00 UTC, after both synthetic sessions.


class NextSession(unittest.TestCase):
    def test_direction_is_not_execution_profit(self):
        signal, outcome = fixture()
        row = evaluate_direction(signal, outcome, NOW)
        self.assertEqual(row['verdict'], 'hit')
        self.assertTrue(row['directionHit'])
        self.assertAlmostEqual(row['returns']['closeToClose'], .05)
        self.assertAlmostEqual(row['returns']['openToClose'], 105/110-1)
        self.assertAlmostEqual(row['returns']['overnightGap'], .1)
        self.assertTrue(row['executionNotSimulated'])
        self.assertEqual(row['executionStatus'], 'intraday_verification_required')
        self.assertEqual(row['aShareResaleConstraint'], 'following_session_after_entry_required')
        self.assertTrue(row['timestampEvidenceOnly'])

    def test_up_down_watch_tie_and_late_replay(self):
        signal, outcome = fixture('us')
        for direction, close, verdict in [('up', 90, 'miss'), ('down', 90, 'hit'), ('watch', 110, 'watch'), ('up', 100, 'tie')]:
            signal['direction'], outcome['close'] = direction, close
            with self.subTest(direction=direction, close=close):
                self.assertEqual(evaluate_direction(signal, outcome, NOW)['verdict'], verdict)
        signal['createdAt'] = signal['nextSession']['openTime']
        row = evaluate_direction(signal, outcome, NOW)
        self.assertFalse(row['publishedBeforeNextOpen'])
        self.assertEqual(row['evidenceClass'], 'historical_replay')

    def test_missing_or_contradictory_evidence_never_produces_returns(self):
        changes = [('outcome', 'market', 'us'), ('outcome', 'symbol', 'OTHER'), ('outcome', 'sessionDate', '2026-11-16'),
                   ('outcome', 'closeComplete', False), ('outcome', 'calendarVerified', False), ('outcome', 'close', float('nan')),
                   ('signal', 'createdAt', '2026-11-12T14:00:00+08:00'), ('signal', 'createdAt', '2026-11-12T17:00:00+08:00'),
                   ('signal', 'createdAt', '2026-11-12T20:00:00'), ('outcome', 'sourceReceivedAt', '2026-12-01T20:00:00+08:00'),
                   ('signal', 'sourceReceivedAt', '2026-12-01T20:00:00+08:00'), ('outcome', 'priceBasis', 'another_basis'),
                   ('outcome', 'sourceReceivedAt', '2026-11-13T14:00:00+08:00'), ('signal', 'closeTime', '2026-11-13T01:00:00+08:00')]
        for target, field, value in changes:
            signal, outcome = fixture()
            (signal if target == 'signal' else outcome)[field] = value
            with self.subTest(target=target, field=field):
                row = evaluate_direction(signal, outcome, NOW)
                self.assertEqual(row['verdict'], 'evidence_pending')
                self.assertIsNone(row['returns'])
        signal, outcome = fixture()
        signal['nextSession']['calendarVerified'] = False
        self.assertEqual(evaluate_direction(signal, outcome, NOW)['evidenceClass'], 'unverified')

    def test_malformed_identity_calendar_and_extreme_prices_fail_closed(self):
        signal, outcome = fixture()
        signal['nextSession'] = ['not', 'a', 'calendar']
        self.assertEqual(evaluate_direction(signal, outcome, NOW)['verdict'], 'evidence_pending')
        signal, outcome = fixture()
        signal['symbol'] = {'unknown': 'not echoed'}
        self.assertIsNone(evaluate_direction(signal, outcome, NOW)['symbol'])
        signal, outcome = fixture()
        signal['close'], outcome['close'] = 1e-300, 1e300
        self.assertEqual(evaluate_direction(signal, outcome, NOW)['reasons'], ['derived_returns_invalid'])

    def test_future_and_wrong_timezone_dates_fail_closed(self):
        signal, outcome = fixture('us')
        outcome['closeTime'] = '2026-11-14T02:00:00-05:00'
        self.assertEqual(evaluate_direction(signal, outcome, NOW)['verdict'], 'evidence_pending')
        signal, outcome = fixture()
        self.assertEqual(evaluate_direction(signal, outcome, 1794530000)['verdict'], 'evidence_pending')

    def test_verified_weekend_gap_is_not_replaced_by_a_calendar_day_guess(self):
        signal, outcome = fixture()
        signal.update(sessionDate='2026-11-13', closeTime='2026-11-13T15:00:00+08:00',
                      createdAt='2026-11-13T20:00:00+08:00', sourceReceivedAt='2026-11-13T19:00:00+08:00')
        signal['nextSession'] = dict(date='2026-11-16', openTime='2026-11-16T09:30:00+08:00',
                                     closeTime='2026-11-16T15:00:00+08:00', calendarVerified=True)
        outcome.update(sessionDate='2026-11-16', openTime=signal['nextSession']['openTime'],
                       closeTime=signal['nextSession']['closeTime'], sourceReceivedAt='2026-11-16T20:00:00+08:00')
        self.assertEqual(evaluate_direction(signal, outcome, NOW+3*86400)['verdict'], 'hit')

    def test_intraday_high_is_never_substituted_for_close_or_a_trade_profit(self):
        signal, outcome = fixture()
        outcome.update(close=90, high=10000, low=1)
        row = evaluate_direction(signal, outcome, NOW)
        self.assertEqual(row['verdict'], 'miss')
        self.assertAlmostEqual(row['returns']['closeToClose'], -.1)
        self.assertTrue(row['executionNotSimulated'])

    def test_summary_separates_replays_and_counts_days_not_rows(self):
        signal, outcome = fixture()
        a = evaluate_direction(signal, outcome, NOW)
        signal['symbol'] = outcome['symbol'] = '600002'
        b = evaluate_direction(signal, outcome, NOW)
        signal['symbol'] = outcome['symbol'] = '600003'
        signal['createdAt'] = signal['nextSession']['openTime']
        replay = evaluate_direction(signal, outcome, NOW)
        summary = summarize_direction([a, a, b, replay])['byStrategy']['a:A1:research-v1']
        self.assertEqual(summary['prospective_timestamp_claim']['directionSamples'], 2)
        self.assertEqual(summary['prospective_timestamp_claim']['distinctTradingDays'], 1)
        self.assertEqual(summary['historical_replay']['directionSamples'], 1)
        changed = copy.deepcopy(a); changed['verdict'] = 'miss'
        with self.assertRaisesRegex(ValueError, 'conflicting_signal_evaluation'):
            summarize_direction([a, changed])

    def test_strategy_versions_are_preserved_and_never_mixed(self):
        signal, outcome = fixture()
        first = evaluate_direction(signal, outcome, NOW)
        signal.update(strategyVersion='research-v2', direction='down')
        second = evaluate_direction(signal, outcome, NOW)
        self.assertEqual(second['strategyVersion'], 'research-v2')
        summary = summarize_direction([first, second])['byStrategy']
        self.assertEqual(summary['a:A1:research-v1']['prospective_timestamp_claim']['hits'], 1)
        self.assertEqual(summary['a:A1:research-v2']['prospective_timestamp_claim']['misses'], 1)
        for version in (None, '', ' ', 'version with spaces', {}):
            signal['strategyVersion'] = version
            with self.subTest(version=version):
                row = evaluate_direction(signal, outcome, NOW)
                self.assertEqual(row['verdict'], 'evidence_pending')
                self.assertIn('strategy_version_missing_invalid', row['reasons'])
                with self.assertRaisesRegex(ValueError, 'evaluation_strategy_version_missing_invalid'):
                    summarize_direction([row])

    def test_empty_summary_invents_no_samples_or_rates(self):
        summary = summarize_direction([])
        self.assertEqual(summary['byStrategy'], {})
        self.assertTrue(summary['executionNotSimulated'])
        self.assertNotIn('winRate', summary)


if __name__ == '__main__':
    unittest.main()
