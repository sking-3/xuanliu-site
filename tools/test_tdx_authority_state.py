"""Offline protocol fixtures. SQLite is NOT a rollback-proof production service."""
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
import json
from pathlib import Path
import socket
import sqlite3
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import Mock, patch

from tools import tdx_authority_state as a
from tools import tdx_source_guard as g
from tools.test_tdx_github_state import FakeContents, READY, encoded
from tools import tdx_github_state as m

BINDING = a.Binding("synthetic-authority", "immutable-fixture-stream-1", "a" * 64)


class AuthorityFixture:
    """A synthetic authority; only tests may initialize or administratively edit."""
    def __init__(self, path):
        self.path = str(path)
        self.calls = []
        self.lose_pending_reply = False
        self.fail_stop_write = False
        self.transform_reply = None

    def seed(self):
        with sqlite3.connect(self.path) as db:
            db.execute("CREATE TABLE authority (revision INTEGER NOT NULL, body TEXT NOT NULL)")
            db.execute("INSERT INTO authority VALUES (1, ?)", (json.dumps(READY),))

    def snapshot(self):
        with sqlite3.connect(self.path) as db:
            row = db.execute("SELECT revision, body FROM authority").fetchone()
        return {"revision": row[0], "record": json.loads(row[1])}

    def administrative_state(self, record):
        with sqlite3.connect(self.path) as db:
            db.execute("UPDATE authority SET revision=revision+1, body=?", (json.dumps(record),))

    def exchange(self, request):
        self.calls.append(deepcopy(request))
        matches = (request["authority_id"] == BINDING.authority_id
                   and request["stream_id"] == BINDING.stream_id
                   and request["migration_digest"] == BINDING.migration_digest
                   and request["source"] == g.SOURCE)
        status = "ok" if matches else "refused"
        with sqlite3.connect(self.path, timeout=5) as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT revision, body FROM authority").fetchone()
            snapshot = {"revision": row[0], "record": json.loads(row[1])}
            if matches and request["operation"] == "cas":
                if self.fail_stop_write and request["record"]["state"] == "stopped":
                    raise OSError("synthetic unavailable authority")
                if (row[0] != request["expected_revision"]
                        or a._digest(snapshot["record"]) != request["expected_digest"]
                        or not a._transition(snapshot["record"], request["record"])):
                    status = "conflict"
                else:
                    snapshot = {"revision": row[0] + 1, "record": deepcopy(request["record"])}
                    db.execute("UPDATE authority SET revision=?, body=?",
                               (snapshot["revision"], json.dumps(snapshot["record"])))
        reply = {key: request[key] for key in (
            "schema", "source", "authority_id", "stream_id", "migration_digest", "operation", "challenge")}
        reply.update(request_digest=a._digest(request), status=status, snapshot=snapshot)
        if (self.lose_pending_reply and request["operation"] == "cas"
                and request["record"]["state"] == "pending" and status == "ok"):
            raise TimeoutError("synthetic response loss after commit")
        return self.transform_reply(reply) if self.transform_reply else reply


class AuthorityTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.path = Path(temp.name) / "fixture.sqlite"
        self.authority = AuthorityFixture(self.path)
        self.authority.seed()
        network = patch.object(socket.socket, "connect", side_effect=AssertionError("network forbidden"))
        network.start()
        self.addCleanup(network.stop)

    def store(self, **options):
        return a.AuthorityStore(binding=options.pop("binding", BINDING),
                                exchange=options.pop("exchange", self.authority.exchange), **options)

    def guard(self, **options):
        return g.Guard(self.store(**options), migration_complete=True)

    def stopped(self):
        return dict(READY, state="stopped", reason="operator_paused")

    def assert_closed(self, guard):
        callback = Mock()
        with self.assertRaises(g.SourceStopped):
            guard.run("mootdx", callback)
        callback.assert_not_called()

    def test_construction_and_missing_authority_are_inert(self):
        store = a.AuthorityStore(binding=BINDING)
        self.assertEqual(self.authority.calls, [])
        self.assert_closed(g.Guard(store, migration_complete=True))
        self.assertEqual(self.authority.calls, [])

    def test_unknown_migration_does_not_contact_authority(self):
        self.assert_closed(g.Guard(self.store()))
        self.assertEqual(self.authority.calls, [])

    def test_binding_mismatch_or_unknown_stream_cannot_initialize(self):
        for binding in (a.Binding("other", BINDING.stream_id, BINDING.migration_digest),
                        a.Binding(BINDING.authority_id, "unknown-stream", BINDING.migration_digest),
                        a.Binding(BINDING.authority_id, BINDING.stream_id, "b" * 64)):
            self.assert_closed(self.guard(binding=binding))
        self.assertEqual(self.authority.snapshot(), {"revision": 1, "record": READY})
        self.assertEqual([r["operation"] for r in self.authority.calls], ["read"] * 3)

    def test_unavailable_authority_latches_instance_without_retry(self):
        exchange = Mock(side_effect=OSError("synthetic outage"))
        store = self.store(exchange=exchange)
        self.assert_closed(g.Guard(store, migration_complete=True))
        self.assert_closed(g.Guard(store, migration_complete=True))
        exchange.assert_called_once()

    def test_success_reserves_and_completes_authoritatively(self):
        def source():
            self.assertEqual(self.authority.snapshot()["record"]["state"], "pending")
            return 5
        self.assertEqual(self.guard().run("tdx", source), 5)
        self.assertEqual(self.authority.snapshot(), {"revision": 3, "record": READY})

    def test_stopped_authority_defeats_github_rollback_in_a_fresh_runner(self):
        github = FakeContents()
        old_ready = github.raw
        with self.assertRaises(PermissionError):
            self.guard().run("mootdx", Mock(side_effect=PermissionError("403 synthetic")))
        github.raw = encoded({"schema": m.ENVELOPE, "source": g.SOURCE, "generation": 3,
                              "record": self.authority.snapshot()["record"]})
        github.raw = old_ready
        self.assertEqual(json.loads(github.raw)["record"], READY)
        self.assert_closed(self.guard())
        self.assertEqual(github.calls, [])

    def test_stop_persists_to_an_independent_process(self):
        self.authority.administrative_state(self.stopped())
        code = (
            "import sys; from tools.test_tdx_authority_state import AuthorityFixture, BINDING; "
            "from tools.tdx_authority_state import AuthorityStore; "
            "from tools.tdx_source_guard import Guard, SourceStopped\n"
            "store=AuthorityStore(binding=BINDING, exchange=AuthorityFixture(sys.argv[1]).exchange)\n"
            "try: Guard(store, migration_complete=True).run('tdx', lambda: sys.exit(99))\n"
            "except SourceStopped: sys.exit(0)\n"
            "sys.exit(98)\n"
        )
        result = subprocess.run([sys.executable, "-B", "-c", code, str(self.path)],
                                capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_stop_between_read_and_reserve_rejects_old_revision(self):
        store = self.store()
        old, _ = store.read(g.SOURCE)
        self.authority.administrative_state(self.stopped())
        self.assertFalse(store.compare_and_swap(g.SOURCE, old, dict(READY, state="pending", token="fixture")))
        self.assert_closed(self.guard())

    def test_two_runners_race_only_one_calls_source(self):
        barrier = threading.Barrier(2)
        calls = []
        def run():
            seen = False
            def exchange(request):
                nonlocal seen
                result = self.authority.exchange(request)
                if request["operation"] == "read" and not seen:
                    seen = True
                    barrier.wait(timeout=5)
                return result
            try:
                return self.guard(exchange=exchange).run("tdx", lambda: calls.append("source"))
            except g.SourceStopped:
                return "closed"
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda _: run(), range(2)))
        self.assertEqual(calls, ["source"])
        self.assertEqual(results.count("closed"), 1)

    def test_lost_reservation_reply_prevents_source_and_future_runner(self):
        self.authority.lose_pending_reply = True
        self.assert_closed(self.guard())
        self.authority.lose_pending_reply = False
        self.assertEqual(self.authority.snapshot()["record"]["state"], "pending")
        self.assert_closed(self.guard())

    def test_denial_stop_write_failure_leaves_pending(self):
        self.authority.fail_stop_write = True
        with self.assertRaises(g.SourceStopped):
            self.guard().run("tdx", Mock(side_effect=PermissionError("429 synthetic")))
        self.assertEqual(self.authority.snapshot()["record"]["state"], "pending")
        self.assert_closed(self.guard())

    def test_false_and_interrupt_cannot_complete_to_ready(self):
        for operation in (lambda: False, Mock(side_effect=KeyboardInterrupt())):
            self.authority.administrative_state(READY)  # Synthetic operator only.
            with self.assertRaises((g.SourceStopped, KeyboardInterrupt)):
                self.guard().run("tdx", operation)
            self.assertEqual(self.authority.snapshot()["record"]["state"], "stopped")
            self.assert_closed(self.guard())

    def test_operator_pause_during_request_cannot_be_overwritten(self):
        def source():
            self.authority.administrative_state(self.stopped())
            return 1
        with self.assertRaises(g.SourceStopped):
            self.guard().run("tdx", source)
        self.assertEqual(self.authority.snapshot()["record"], self.stopped())

    def test_old_token_cannot_complete_after_controlled_resume(self):
        store = self.store()
        rev, _ = store.read(g.SOURCE)
        store.compare_and_swap(g.SOURCE, rev, dict(READY, state="pending", token="old"))
        pending, _ = store.read(g.SOURCE)
        self.authority.administrative_state(self.stopped())
        self.authority.administrative_state(READY)
        self.assertFalse(store.compare_and_swap(g.SOURCE, pending, READY))
        self.assertEqual(self.authority.snapshot()["revision"], 4)

    def test_old_read_reply_replayed_to_new_runner_is_rejected(self):
        captured = []
        def capture(reply):
            captured.append(deepcopy(reply))
            return reply
        self.authority.transform_reply = capture
        self.store().read(g.SOURCE)
        self.authority.administrative_state(self.stopped())
        self.assert_closed(self.guard(exchange=lambda request: deepcopy(captured[0])))

    def test_receipt_for_different_operation_or_request_is_rejected(self):
        for field, value in (("operation", "cas"), ("request_digest", "0" * 64),
                             ("source", "tencent"), ("stream_id", "old-stream"),
                             ("migration_digest", "c" * 64)):
            self.authority.transform_reply = lambda reply, f=field, v=value: dict(reply, **{f: v})
            self.assert_closed(self.guard())
        self.assertEqual(self.authority.snapshot()["revision"], 1)

    def test_old_cas_receipt_with_fresh_challenge_is_rejected(self):
        def stale(reply):
            if reply["operation"] == "cas":
                reply["snapshot"]["revision"] -= 1
            return reply
        self.authority.transform_reply = stale
        self.assert_closed(self.guard())
        self.assertEqual(self.authority.snapshot()["record"]["state"], "pending")
        self.authority.transform_reply = None
        self.assert_closed(self.guard())

    def test_runner_cannot_resume_stopped_or_write_ready_without_pending(self):
        store = self.store()
        revision, _ = store.read(g.SOURCE)
        with self.assertRaises(a.AuthorityError):
            store.compare_and_swap(g.SOURCE, revision, READY)
        self.authority.administrative_state(self.stopped())
        revision, _ = store.read(g.SOURCE)
        with self.assertRaises(a.AuthorityError):
            store.compare_and_swap(g.SOURCE, revision, READY)
        self.assertEqual([r["operation"] for r in self.authority.calls], ["read", "read"])

    def test_malformed_or_exhausted_revision_is_not_usable(self):
        for revision in (0, True, "1", a.MAX_REVISION + 1):
            self.authority.transform_reply = lambda reply, r=revision: dict(
                reply, snapshot=dict(reply["snapshot"], revision=r))
            self.assert_closed(self.guard())
        self.authority.transform_reply = lambda reply: dict(
            reply, snapshot=dict(reply["snapshot"], revision=a.MAX_REVISION))
        self.assert_closed(self.guard())

    def test_default_production_has_no_authority(self):
        self.assertIsNone(g.PRODUCTION_GUARD.store)
        self.assertFalse(g.PRODUCTION_GUARD.migration_complete)
        self.assert_closed(g.PRODUCTION_GUARD)


if __name__ == "__main__":
    unittest.main()
