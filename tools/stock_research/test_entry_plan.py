"""Synthetic offline evidence only; no real prices, orders or claimed results."""
import copy
import unittest
from tools.stock_research.entry_plan import observe_entry_plan, summarize_entry_plans

NOW = 1794690000


def fixture():
    opened, closed = '2026-11-13T09:30:00+08:00', '2026-11-13T15:00:00+08:00'
    plan = dict(market='a', symbol='600001', strategy='A1', strategyVersion='synthetic-v1', direction='up',
                sessionDate='2026-11-12', signalCloseTime='2026-11-12T15:00:00+08:00',
                sourceReceivedAt='2026-11-12T19:00:00+08:00', createdAt='2026-11-12T20:00:00+08:00',
                calendarVerified=True, closeComplete=True, trigger=101, invalidation=98, maxEntryPrice=102,
                adjustmentVerified=True, priceBasis='SYNTHETIC actual-quote-units@2026-11-13;corporate-actions=none',
                nextSession=dict(date='2026-11-13', openTime=opened, closeTime=closed, calendarVerified=True))
    def tick(stamp, price):
        return dict(sourceTime=stamp, receivedAt=stamp, quoteTime=stamp, price=price, bid=price-.1,
                    ask=price+.1, tradingNormal=True, limitStateVerified=True, lockedLimit=False)
    events = [tick(opened, 100), tick('2026-11-13T09:31:00+08:00', 101), tick(closed, 101.5)]
    events[0]['isOpeningPrice'] = True
    observation = dict(market='a', symbol='600001', kind='ticks', coverageVerified=True,
                       adjustmentVerified=True, priceBasis=plan['priceBasis'],
                       coverageStart=opened, coverageEnd=closed, events=events)
    return plan, observation


class EntryPlan(unittest.TestCase):
    def test_quoted_conditions_are_observed_without_fills_or_pnl(self):
        plan, observation = fixture()
        row = observe_entry_plan(plan, observation, NOW)
        self.assertEqual(row['status'], 'quoted_opportunity_observed')
        self.assertEqual(row['quotedAsk'], 101.1)
        self.assertTrue(row['executionNotSimulated'])
        self.assertTrue(row['timestampEvidenceOnly'])
        self.assertFalse(any(key in row for key in ('fills', 'entryPrice', 'PnL', 'profit', 'winRate')))

    def test_invalidation_before_later_rise_cannot_become_an_opportunity(self):
        plan, observation = fixture()
        observation['events'][1]['price'] = 97
        observation['events'][-1]['price'] = 105
        row = observe_entry_plan(plan, observation, NOW)
        self.assertEqual(row['status'], 'invalidation_before_trigger')
        self.assertIsNone(row['quotedAsk'])

    def test_missing_price_basis_cannot_make_an_otherwise_valid_quote_opportunity(self):
        for target in ('plan', 'observation'):
            for value in (None, '', ' '):
                plan, observation = fixture()
                (plan if target == 'plan' else observation)['priceBasis'] = value
                with self.subTest(target=target, value=value):
                    row = observe_entry_plan(plan, observation, NOW)
                    self.assertEqual(row['status'], 'evidence_pending')
                    self.assertIn('entry_price_basis_unverified', row['reasons'])
                    self.assertIsNone(row['quotedAsk'])

    def test_pre_action_levels_cannot_be_compared_to_post_action_raw_quotes(self):
        plan, observation = fixture()
        plan['priceBasis'] = 'SYNTHETIC raw@2026-11-12;split-units=pre-action'
        observation['priceBasis'] = 'SYNTHETIC raw@2026-11-13;split-units=post-action'
        row = observe_entry_plan(plan, observation, NOW)
        self.assertEqual(row['status'], 'evidence_pending')
        self.assertIn('entry_price_basis_unverified', row['reasons'])
        self.assertIsNone(row['observedAt'])
        self.assertIsNone(row['quotedAsk'])

    def test_unverified_conversion_on_either_side_blocks_quote_classification(self):
        for target in ('plan', 'observation'):
            for value in (False, None, 'verified'):
                plan, observation = fixture()
                (plan if target == 'plan' else observation)['adjustmentVerified'] = value
                with self.subTest(target=target, value=value):
                    row = observe_entry_plan(plan, observation, NOW)
                    self.assertEqual(row['status'], 'evidence_pending')
                    self.assertIn('entry_price_basis_unverified', row['reasons'])
                    self.assertIsNone(row['quotedAsk'])

    def test_verified_opening_gap_above_frozen_maximum_cancels_the_plan(self):
        plan, observation = fixture()
        observation['events'][0]['price'] = 103
        self.assertEqual(observe_entry_plan(plan, observation, NOW)['status'], 'opening_out_of_entry_range')

    def test_minute_ohlc_cannot_establish_event_order(self):
        plan, observation = fixture()
        observation.update(kind='minute_ohlc', events=[dict(open=100, high=105, low=97, close=101)])
        row = observe_entry_plan(plan, observation, NOW)
        self.assertEqual(row['status'], 'intraday_verification_required')
        self.assertIsNone(row['quotedAsk'])

    def test_full_day_coverage_is_needed_to_assert_no_trigger(self):
        plan, observation = fixture()
        for tick in observation['events']:
            tick['price'] = 100
        self.assertEqual(observe_entry_plan(plan, observation, NOW)['status'], 'not_triggered')
        observation['coverageVerified'] = False
        self.assertEqual(observe_entry_plan(plan, observation, NOW)['status'], 'intraday_verification_required')
        observation['coverageVerified'] = True
        observation['events'] = observation['events'][:2]
        observation['coverageEnd'] = observation['events'][-1]['sourceTime']
        self.assertEqual(observe_entry_plan(plan, observation, NOW)['status'], 'intraday_verification_required')
        observation['events'] = []
        self.assertEqual(observe_entry_plan(plan, observation, NOW)['status'], 'intraday_verification_required')

    def test_full_prefix_can_observe_positive_quote_conditions_without_claiming_the_rest_of_day(self):
        plan, observation = fixture()
        observation['events'] = observation['events'][:2]
        observation['coverageEnd'] = observation['events'][-1]['sourceTime']
        row = observe_entry_plan(plan, observation, NOW)
        self.assertEqual(row['status'], 'quoted_opportunity_observed')
        self.assertIn('full_session_coverage_not_verified', row['reasons'])
        observation['coverageVerified'] = False
        self.assertEqual(observe_entry_plan(plan, observation, NOW)['status'], 'trigger_touched_quote_unverified')

    def test_missing_stale_locked_or_abnormal_quotes_never_qualify(self):
        changes = [('bid', None), ('ask', None), ('ask', 103), ('quoteTime', None),
                   ('quoteTime', '2026-11-13T09:30:50+08:00'), ('quoteTime', '2026-12-01T09:31:00+08:00'),
                   ('bid', 102), ('bid', 101.1), ('bid', 97), ('tradingNormal', False), ('limitStateVerified', False), ('lockedLimit', True),
                   ('receivedAt', '2026-11-13T09:31:10+08:00')]
        for key, value in changes:
            plan, observation = fixture()
            observation['events'] = observation['events'][:2]
            observation['coverageEnd'] = observation['events'][-1]['sourceTime']
            observation['events'][-1][key] = value
            with self.subTest(key=key, value=value):
                self.assertEqual(observe_entry_plan(plan, observation, NOW)['status'], 'trigger_touched_quote_unverified')
        plan, observation = fixture()
        observation['events'][0].pop('isOpeningPrice')
        self.assertEqual(observe_entry_plan(plan, observation, NOW)['status'], 'trigger_touched_quote_unverified')

    def test_bad_identity_future_times_and_wrong_session_fail_closed_without_echoing_errors(self):
        changes = [('market', 'us'), ('symbol', 'OTHER'), ('coverageStart', '2026-11-13T09:31:00+08:00')]
        for key, value in changes:
            plan, observation = fixture(); observation[key] = value
            self.assertEqual(observe_entry_plan(plan, observation, NOW)['status'], 'evidence_pending')
        for key, value in [('sourceTime', '2026-12-01T09:31:00+08:00'), ('receivedAt', '2026-12-01T09:31:00+08:00'),
                           ('sourceTime', 'SYNTHETIC_PRIVATE_VALUE'), ('symbol', 'OTHER')]:
            plan, observation = fixture(); observation['events'][1][key] = value
            row = observe_entry_plan(plan, observation, NOW)
            self.assertEqual(row['status'], 'evidence_pending')
            self.assertNotIn('SYNTHETIC_PRIVATE_VALUE', str(row))
        plan, observation = fixture(); plan['direction'] = 'down'
        self.assertEqual(observe_entry_plan(plan, observation, NOW)['status'], 'evidence_pending')

    def test_identical_tick_duplicates_are_idempotent_but_conflicts_and_reordering_are_not(self):
        plan, observation = fixture()
        observation['events'].insert(2, copy.deepcopy(observation['events'][1]))
        row = observe_entry_plan(plan, observation, NOW)
        self.assertEqual(row['status'], 'quoted_opportunity_observed')
        self.assertEqual(row['eventCount'], 3)
        observation['events'][2]['ask'] = 101.2
        self.assertEqual(observe_entry_plan(plan, observation, NOW)['status'], 'evidence_pending')
        plan, observation = fixture(); observation['events'].reverse()
        self.assertEqual(observe_entry_plan(plan, observation, NOW)['status'], 'evidence_pending')

    def test_later_invalidation_is_recorded_without_erasing_prior_quote_observation(self):
        plan, observation = fixture(); observation['events'][-1]['price'] = 97
        row = observe_entry_plan(plan, observation, NOW)
        self.assertEqual(row['status'], 'quoted_opportunity_observed')
        self.assertTrue(row['invalidatedAfterOpportunity'])

    def test_summary_separates_version_replay_and_observed_trading_days(self):
        plan, observation = fixture(); first = observe_entry_plan(plan, observation, NOW)
        plan['symbol'] = observation['symbol'] = '600002'
        second = observe_entry_plan(plan, observation, NOW)
        plan['strategyVersion'] = 'synthetic-v2'; newer = observe_entry_plan(plan, observation, NOW)
        plan['symbol'] = observation['symbol'] = '600003'
        plan['createdAt'] = plan['nextSession']['openTime']; replay = observe_entry_plan(plan, observation, NOW)
        summary = summarize_entry_plans([first, first, second, newer, replay])['byStrategy']
        bucket = summary['a:A1:synthetic-v1']['prospective_timestamp_claim']
        self.assertEqual(bucket['quoted_opportunity_observed'], 2)
        self.assertEqual(bucket['distinctTradingDays'], 1)
        self.assertEqual(summary['a:A1:synthetic-v2']['historical_replay']['signals'], 1)
        changed = copy.deepcopy(first); changed['status'] = 'not_triggered'
        with self.assertRaisesRegex(ValueError, 'conflicting_entry_evaluation'):
            summarize_entry_plans([first, changed])
        self.assertEqual(summarize_entry_plans([])['byStrategy'], {})


if __name__ == '__main__':
    unittest.main()
