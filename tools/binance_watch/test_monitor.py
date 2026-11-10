"""Offline contract tests. No Binance connection is made by this suite."""
import copy
import io
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch
import urllib.error

import monitor as m


PROFILE = {"leadPortfolioId": m.PORTFOLIO_ID, "status": "ACTIVE", "positionShow": True}


def position(quantity="1", **changes):
    return {"symbol": "ETHUSDT", "positionSide": "LONG", "positionAmount": quantity,
            "collateral": "USDT", "entryPrice": "2000.0", "markPrice": "2001.00",
            "unrealizedProfit": "1.00", "leverage": 5, **changes}


class Clock:
    def __init__(self):
        self.now = 0.0

    def monotonic(self):
        return self.now

    def wall(self):
        return 1800000000 + self.now

    def sleep(self, seconds):
        assert seconds >= 0
        self.now += seconds


class FakeSource:
    def __init__(self, clock, snapshots=None, profiles=None, durations=None):
        self.clock = clock
        self.snapshots = iter(snapshots or [[]])
        self.profiles = iter(profiles) if profiles is not None else None
        self.durations = iter(durations or [])
        self.calls = []

    def get(self, route):
        self.calls.append((route, self.clock.now))
        self.clock.sleep(next(self.durations, 0))
        value = next(self.profiles) if route.endswith("detail") and self.profiles is not None else (
            PROFILE if route.endswith("detail") else next(self.snapshots))
        if isinstance(value, Exception):
            raise value
        return copy.deepcopy(value)


class Fixture(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / "watch.sqlite3"
        self.store = m.Store(self.path)
        self.clock, self.logs = Clock(), []

    def tearDown(self):
        self.store.close()
        self.temp.cleanup()

    def runner(self, source, guard=lambda: None):
        return m.Monitor(self.store, source, guard, clock=self.clock.monotonic, wall=self.clock.wall,
                         sleep=self.clock.sleep, logger=lambda kind, **fields: self.logs.append({"kind": kind, **fields}))

    def events(self):
        return [json.loads(row[0]) for row in self.store.db.execute("SELECT payload FROM events ORDER BY rowid")]


class CadenceTests(Fixture):
    def test_five_second_target_and_two_second_spacing(self):
        source = FakeSource(self.clock, [[], [], []])
        self.assertEqual(self.runner(source).run(max_cycles=3), 0)
        self.assertEqual([at for _, at in source.calls], [0, 2, 5, 7, 10, 12])
        self.assertFalse(self.store.state["runActive"])

    def test_slow_cycle_skips_ticks_without_catchup(self):
        source = FakeSource(self.clock, [[], []], durations=[6, 1])
        self.runner(source).run(max_cycles=2)
        self.assertEqual([at for _, at in source.calls], [0, 6, 10, 12])
        self.assertEqual([x["count"] for x in self.logs if x["kind"] == "missed_ticks"], [1])

    def test_transient_backoff_and_rebaseline(self):
        source = FakeSource(self.clock, [[position()], [position("2")]],
                            profiles=[PROFILE, m.Temporary("http_503"), PROFILE])
        self.runner(source).run(max_cycles=3)
        self.assertEqual([at for route, at in source.calls if route.endswith("detail")], [0, 5, 15])
        self.assertEqual(self.events(), [])
        self.assertEqual(self.store.state["positions"]["ETHUSDT:LONG:USDT"]["quantity"], "2")

    def test_duration_bounds_backoff(self):
        source = FakeSource(self.clock, profiles=[m.Temporary("http_503")])
        self.assertEqual(self.runner(source).run(duration=6), 1)
        self.assertEqual(len(source.calls), 1)
        self.assertFalse(self.store.state["runActive"])

    def test_duration_does_not_start_second_request_at_deadline(self):
        source = FakeSource(self.clock)
        self.runner(source).run(duration=2)
        self.assertEqual(len(source.calls), 1)
        self.assertFalse(self.store.state["initialized"])

    def test_duration_ends_at_last_completed_cycle(self):
        source = FakeSource(self.clock, [[], []])
        self.runner(source).run(duration=10)
        self.assertEqual([at for _, at in source.calls], [0, 2, 5, 7])

    def test_slow_guard_cannot_bypass_deadline(self):
        source = FakeSource(self.clock)
        self.runner(source, lambda: self.clock.sleep(10)).run(duration=5)
        self.assertEqual(source.calls, [])


class ObservationTests(Fixture):
    def test_first_empty_is_baseline_then_appearance(self):
        source = FakeSource(self.clock, [[], [position()]])
        self.runner(source).run(max_cycles=2)
        self.assertTrue(self.store.state["initialized"])
        self.assertEqual([e["kind"] for e in self.events()], ["position_appeared"])
        self.assertIsNone(self.events()[0]["sourceUpdatedAt"])
        self.assertEqual(self.events()[0]["meaning"], "snapshot_change_not_execution")

    def test_first_nonempty_no_invented_open(self):
        self.runner(FakeSource(self.clock, [[position()]])).run(max_cycles=1)
        self.assertEqual(self.events(), [])

    def test_decimal_equivalent_and_increase_decrease(self):
        source = FakeSource(self.clock, [[position("1")], [position("1.000")], [position("1.1")], [position("0.1")]])
        self.runner(source).run(max_cycles=4)
        self.assertEqual([e["kind"] for e in self.events()], ["position_increased", "position_decreased"])

    def test_two_absence_confirmations_emit_once(self):
        source = FakeSource(self.clock, [[position()], [], [], []])
        self.runner(source).run(max_cycles=4)
        self.assertEqual([e["kind"] for e in self.events()], ["position_absent_twice"])
        self.assertEqual(self.events()[0]["firstMissingAt"], m.iso(self.clock.wall() - 10))

    def test_one_absence_then_return_is_not_new_position(self):
        self.runner(FakeSource(self.clock, [[position()], [], [position()]])).run(max_cycles=3)
        self.assertEqual(self.events(), [])
        self.assertEqual(self.store.state["pendingAbsent"], {})

    def test_restart_rebaselines_not_invented_changes(self):
        self.runner(FakeSource(self.clock, [[position()]])).run(max_cycles=1)
        self.clock.sleep(3)
        self.runner(FakeSource(self.clock, [[position("5")]])).run(max_cycles=1)
        self.assertEqual(self.events(), [])

    def test_gap_rebaselines(self):
        source = FakeSource(self.clock, [[position()], [position("5")]], durations=[0, 0, 15])
        self.runner(source).run(max_cycles=2)
        self.assertEqual(self.events(), [])

    def test_failed_cycle_discards_pending_absence(self):
        source = FakeSource(self.clock, [[position()], [], []], profiles=[PROFILE, PROFILE, m.Temporary("http_503"), PROFILE])
        self.runner(source).run(max_cycles=4)
        self.assertEqual(self.events(), [])


class SafetyTests(Fixture):
    def test_hidden_profile_stops_without_positions(self):
        for visible in (False, None, 1):
            with self.subTest(visible=visible):
                self.store.save(m.initial_state())
                source = FakeSource(self.clock, profiles=[{**PROFILE, "positionShow": visible}])
                self.assertEqual(self.runner(source).run(max_cycles=5), 2)
                self.assertEqual(len(source.calls), 1)
                self.assertTrue(self.store.state["stopped"])

    def test_identity_and_inactive_stop_before_positions(self):
        for profile in ({**PROFILE, "leadPortfolioId": "wrong"}, {**PROFILE, "status": "INACTIVE"}):
            self.store.save(m.initial_state())
            source = FakeSource(self.clock, profiles=[profile])
            self.runner(source).run(max_cycles=2)
            self.assertEqual(len(source.calls), 1)

    def test_refusal_persists_across_reopen(self):
        source = FakeSource(self.clock, profiles=[m.Stop("http_429")])
        self.runner(source).run(max_cycles=3)
        self.store.close()
        self.store = m.Store(self.path)
        empty = FakeSource(self.clock)
        self.assertEqual(self.runner(empty).run(max_cycles=1), 2)
        self.assertEqual(empty.calls, [])
        self.assertEqual(self.store.state["errorCode"], "http_429")

    def test_guard_checked_before_each_request(self):
        checks = []
        def guard():
            checks.append(True)
            if len(checks) == 2:
                raise m.Stop("repository_source_stopped")
        source = FakeSource(self.clock)
        self.runner(source, guard).run(max_cycles=1)
        self.assertEqual(len(source.calls), 1)
        self.assertTrue(self.store.state["stopped"])

    def test_malformed_positions_never_become_empty_success(self):
        self.runner(FakeSource(self.clock, [[position()], None])).run(max_cycles=2)
        self.assertTrue(self.store.state["stopped"])
        self.assertEqual(len(self.store.state["positions"]), 1)
        self.assertEqual(self.events(), [])

    def test_unexpected_crash_leaves_active_checkpoint(self):
        source = FakeSource(self.clock, profiles=[RuntimeError("synthetic crash")])
        with self.assertRaises(RuntimeError):
            self.runner(source).run(max_cycles=1)
        self.assertTrue(m.inspect_checkpoint(self.path)["runActive"])
        source = FakeSource(self.clock)
        with self.assertRaisesRegex(m.Stop, "incomplete_previous_run"):
            self.runner(source).run(max_cycles=1)
        self.assertEqual(source.calls, [])

    def test_single_writer_lock(self):
        with self.assertRaisesRegex(m.Stop, "another_writer_running"):
            m.Store(self.path)

    def test_state_transaction_and_event_dedup(self):
        event = {"id": "abc", "kind": "test"}
        self.store.save(self.store.state, [event, event])
        self.assertEqual(len(self.events()), 1)
        invalid = {**self.store.state, "portfolioId": "wrong"}
        with self.assertRaises(m.Stop):
            self.store.save(invalid, [{"id": "other"}])
        self.assertEqual(len(self.events()), 1)
        self.assertEqual(m.inspect_checkpoint(self.path)["portfolioId"], m.PORTFOLIO_ID)

    def test_corrupt_state_rejected_readonly(self):
        self.store.db.execute("UPDATE state SET payload=?", ('{"schemaVersion":1}',))
        self.store.db.commit()
        with self.assertRaises(m.Stop):
            m.inspect_checkpoint(self.path)

    def test_refusal_code_cannot_hide_behind_false_stop_flag(self):
        corrupt = {**m.initial_state(), "errorCode": "http_429"}
        with self.assertRaises(m.Stop):
            m.validate_state(corrupt)

    def test_missing_event_table_rejected(self):
        self.store.db.execute("DROP TABLE events")
        self.store.db.commit()
        with self.assertRaises(m.Stop):
            m.inspect_checkpoint(self.path)

    def test_sqlite_handles_close_and_checkpoint_has_no_sidecars(self):
        for _ in range(3):
            m.inspect_checkpoint(self.path)
        self.store.close()
        self.assertFalse(Path(str(self.path) + "-wal").exists())
        self.assertFalse(Path(str(self.path) + "-shm").exists())
        self.store = m.Store(self.path)

    def test_event_retention_is_bounded(self):
        with patch.object(m, "MAX_EVENTS", 2):
            self.store.save(self.store.state, [{"id": str(n)} for n in range(5)])
        self.assertEqual([e["id"] for e in self.events()], ["3", "4"])

    def test_status_no_transport_or_mutation(self):
        original = self.path.read_bytes()
        with patch.object(m, "Transport", side_effect=AssertionError("network forbidden")), patch("sys.stdout", new=io.StringIO()):
            self.assertEqual(m.main(["--status", "--state-db", str(self.path)]), 0)
        self.assertEqual(original, self.path.read_bytes())


class DataTests(unittest.TestCase):
    def test_decimal_precision_and_direction(self):
        quantity = "-1.1234567890123456789012345678901234567890"
        row = m.normalize_positions([position(quantity, positionSide="BOTH")])["ETHUSDT:SHORT:USDT"]
        self.assertEqual(row["quantity"], quantity[1:-1])

    def test_duplicate_and_invalid_values(self):
        for rows in ([position(), position()], [position("NaN")], [position("Infinity")], [position("1e2")],
                     [position(leverage=True)], [position(entryPrice="-1")], [position(positionSide="foo")]):
            with self.subTest(rows=rows), self.assertRaises(m.Stop):
                m.normalize_positions(rows)

    def test_zero_position_ignored(self):
        self.assertEqual(m.normalize_positions([{"positionAmount": "-0.000"}]), {})


class Response:
    def __init__(self, raw, status=200, content_type="application/json", headers=None):
        self.status = status
        self.headers = {"Content-Type": content_type, **(headers or {})}
        self.body = io.BytesIO(raw)

    def read1(self, size):
        return self.body.read(size)

    def __enter__(self):
        return self

    def __exit__(self, *_):
        pass


class Opener:
    def __init__(self, response):
        self.response, self.requests = response, []

    def open(self, request, timeout):
        self.requests.append(request)
        return self.response


class TransportTests(unittest.TestCase):
    def get(self, value, **kwargs):
        raw = value if isinstance(value, bytes) else json.dumps(value).encode()
        self.opener = Opener(Response(raw, **kwargs))
        return m.Transport(opener=self.opener).get("lead-data/positions")

    def test_route_and_valid_empty(self):
        self.assertEqual(self.get({"code": "000000", "success": True, "data": []}), [])
        request = self.opener.requests[0]
        self.assertEqual(request.full_url, m.BASE + "lead-data/positions?portfolioId=" + m.PORTFOLIO_ID)
        self.assertIsNone(request.get_header("Cookie"))
        self.assertIsNone(request.get_header("Authorization"))

    def test_http200_failure_and_missing_data(self):
        for value in ({"code": "000000", "success": 1, "data": []}, {"code": "x", "success": False, "data": []},
                      {"code": "000000", "success": True, "data": None}, {}, [], b"<html>challenge</html>", b'{"data":NaN}'):
            with self.subTest(value=value), self.assertRaises(m.Stop):
                self.get(value)

    def test_all_hard_statuses_and_redirect(self):
        for status in (202, 301, 302, 401, 403, 418, 429, 451):
            with self.subTest(status=status), self.assertRaises(m.Stop):
                self.get({}, status=status)
        with self.assertRaisesRegex(m.Stop, "redirect_refused"):
            m.NoRedirect().redirect_request(None, None, 302, "", {}, "https://other.invalid")

    def test_transient_http(self):
        for status in (408, 500, 503):
            with self.assertRaises(m.Temporary):
                self.get({}, status=status)

    def test_content_type_and_size_guard(self):
        with self.assertRaises(m.Stop):
            self.get({}, content_type="text/html")
        with self.assertRaises(m.Stop):
            self.get({}, headers={"Content-Length": str(m.MAX_BYTES + 1)})
        with self.assertRaises(m.Stop):
            self.get(b"x" * (m.MAX_BYTES + 1))


class RepositoryGuardTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / "portfolios.json"
        self.rows = [{"schemaVersion": 1, "portfolioId": i, "profile": {"id": i, "visibility": "public"},
                      "source": {"refreshStopped": False, "errorCode": None, "status": "ready"}} for i in sorted(m.GUARD_IDS)]
        self.collection = {"schemaVersion": 1, "portfolios": self.rows, "source": {"refreshStopped": False, "errorCode": None}}
        self.legacy = copy.deepcopy(next(row for row in self.rows if row["portfolioId"] == "5156287639231681792"))

    def tearDown(self):
        self.temp.cleanup()

    def write(self):
        self.path.write_text(json.dumps(self.collection))
        self.path.with_name("snapshot.json").write_text(json.dumps(self.legacy))

    def test_valid_guard_and_legacy_refusal(self):
        self.write()
        m.check_repository(self.path)
        self.legacy["source"]["errorCode"] = "http_429"
        self.write()
        with self.assertRaisesRegex(m.Stop, "repository_source_stopped"):
            m.check_repository(self.path)

    def test_source_business_refusal_even_without_halt_flag(self):
        self.rows[0]["source"]["errorCode"] = "source_error_test"
        self.write()
        with self.assertRaises(m.Stop):
            m.check_repository(self.path)

    def test_missing_malformed_guard_failclosed(self):
        with self.assertRaises(m.Stop):
            m.check_repository(self.path)
        self.collection["source"]["refreshStopped"] = 0
        self.write()
        with self.assertRaises(m.Stop):
            m.check_repository(self.path)

    def test_restricted_even_when_stop_flag_inconsistent(self):
        self.rows[0]["profile"]["visibility"] = "restricted"
        self.write()
        with self.assertRaisesRegex(m.Stop, "invalid_repository_guard"):
            m.check_repository(self.path)

    def test_other_account_private_stop_does_not_become_global(self):
        self.rows[0]["profile"]["visibility"] = "restricted"
        self.rows[0]["source"] = {"refreshStopped": True, "errorCode": "restricted", "status": "restricted"}
        self.write()
        m.check_repository(self.path)

    def test_other_account_inactive_stop_does_not_become_global(self):
        self.legacy["profile"]["status"] = "CLOSED"
        self.legacy["source"] = {"refreshStopped": True, "errorCode": "inactive", "status": "stale"}
        self.write()
        m.check_repository(self.path)

    def test_aggregate_unknown_stop_remains_global(self):
        self.collection["source"] = {"refreshStopped": True, "errorCode": "previous_run_unverified"}
        self.write()
        with self.assertRaisesRegex(m.Stop, "repository_source_stopped"):
            m.check_repository(self.path)

    def test_boolean_schema_version_is_not_version_one(self):
        self.collection["schemaVersion"] = True
        self.write()
        with self.assertRaises(m.Stop):
            m.check_repository(self.path)


if __name__ == "__main__":
    unittest.main()
