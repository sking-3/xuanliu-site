"""Offline fixtures only: SQLite simulates a durable external CAS adapter."""
import json
import sqlite3
import socket
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from tools import tdx_source_guard as g
from tools.stock_research import a_share_sources as old
from tools.mootdx_feed import collector as new


class SQLiteFixture:
    """Test adapter, never instantiated by a production entrypoint."""
    def __init__(self, path):
        self.path = str(path)
        with sqlite3.connect(self.path) as db:
            db.execute("CREATE TABLE IF NOT EXISTS state (source TEXT PRIMARY KEY, revision INTEGER, body TEXT)")
        self.fail_write = False

    def seed(self, record):
        with sqlite3.connect(self.path) as db:
            db.execute("INSERT INTO state VALUES (?, 1, ?)", (g.SOURCE, json.dumps(record)))

    def read(self, source):
        with sqlite3.connect(self.path) as db:
            row = db.execute("SELECT revision, body FROM state WHERE source=?", (source,)).fetchone()
        return (row[0], json.loads(row[1])) if row else (None, None)

    def compare_and_swap(self, source, expected, record):
        if self.fail_write:
            raise OSError("synthetic storage outage")
        with sqlite3.connect(self.path) as db:
            result = db.execute("UPDATE state SET revision=revision+1, body=? WHERE source=? AND revision=?",
                                (json.dumps(record), source, expected))
            return result.rowcount == 1


def refusal_examples():
    for status in (401, 403, 429):
        yield RuntimeError("HTTP " + str(status))
        for name in ("status", "status_code", "code"):
            error = RuntimeError("synthetic opaque refusal")
            setattr(error, name, status)
            yield error
        error = RuntimeError("synthetic opaque response")
        error.response = SimpleNamespace(status_code=status)
        yield error


class SharedGuardTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.path = Path(temp.name) / "synthetic.sqlite"
        self.store = SQLiteFixture(self.path)
        self.store.seed({"schema": g.SCHEMA, "source": g.SOURCE, "state": "ready"})
        self.first = g.Guard(self.store, migration_complete=True)
        self.second = g.Guard(SQLiteFixture(self.path), migration_complete=True)
        network = patch.object(socket.socket, "connect", side_effect=AssertionError("network forbidden"))
        network.start()
        self.addCleanup(network.stop)

    def test_unknown_migration_does_not_read_store(self):
        store = Mock()
        with self.assertRaisesRegex(g.SourceStopped, "legacy_source_stops_unverified"):
            g.Guard(store).run("mootdx", Mock())
        store.read.assert_not_called()

    def test_missing_record_is_not_initialized(self):
        store = Mock()
        store.read.return_value = (None, None)
        with self.assertRaisesRegex(g.SourceStopped, "source_state_unverified"):
            g.Guard(store, migration_complete=True).run("tdx", Mock())
        store.compare_and_swap.assert_not_called()

    def test_unknown_identity_does_not_access_state(self):
        store = Mock()
        with self.assertRaisesRegex(g.SourceStopped, "source_identity_unverified"):
            g.Guard(store, migration_complete=True).run("tencent", Mock())
        store.read.assert_not_called()

    def test_denial_shared_between_two_runners_and_aliases(self):
        denied = Mock(side_effect=PermissionError("403 synthetic"))
        with self.assertRaises(PermissionError):
            self.first.run("mootdx", denied)
        for alias in g.ALIASES:
            callback = Mock()
            with self.assertRaises(g.SourceStopped):
                self.second.run(alias, callback)
            callback.assert_not_called()
        self.assertEqual(self.store.read(g.SOURCE)[1]["reason"], "provider_access_denied")

    def test_new_process_sees_stop(self):
        with self.assertRaises(PermissionError):
            self.first.run("mootdx", Mock(side_effect=PermissionError("403 synthetic")))
        code = (
            "import sys; from tools.test_tdx_source_guard import SQLiteFixture; "
            "from tools.tdx_source_guard import Guard, SourceStopped\n"
            "guard=Guard(SQLiteFixture(sys.argv[1]), migration_complete=True)\n"
            "try: guard.run('tdxpy', lambda: sys.exit(99))\n"
            "except SourceStopped: sys.exit(0)\n"
            "sys.exit(98)\n"
        )
        result = subprocess.run([sys.executable, "-c", code, str(self.path)],
                                capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_pending_never_expires_or_allows_second_runner(self):
        revision, _ = self.store.read(g.SOURCE)
        self.store.compare_and_swap(g.SOURCE, revision, {
            "schema": g.SCHEMA, "source": g.SOURCE, "state": "pending", "token": "abandoned"})
        callback = Mock()
        with self.assertRaises(g.SourceStopped):
            self.second.run("pytdx", callback)
        callback.assert_not_called()

    def test_concurrent_reservation_and_success(self):
        rejected = Mock()
        def operation():
            with self.assertRaises(g.SourceStopped):
                self.second.run("tdx", rejected)
            return 7
        self.assertEqual(self.first.run("mootdx", operation), 7)
        rejected.assert_not_called()
        self.assertEqual(self.second.run("tdxpy", lambda: 8), 8)

    def test_cas_conflict_prevents_request(self):
        self.store.compare_and_swap = Mock(return_value=False)
        callback = Mock()
        with self.assertRaisesRegex(g.SourceStopped, "source_state_conflict"):
            self.first.run("mootdx", callback)
        callback.assert_not_called()

    def test_reservation_write_failure_prevents_request(self):
        self.store.fail_write = True
        callback = Mock()
        with self.assertRaises(g.SourceStopped):
            self.first.run("mootdx", callback)
        callback.assert_not_called()

    def test_denial_write_failure_leaves_pending_for_next_runner(self):
        def denied():
            self.store.fail_write = True
            raise PermissionError("429 synthetic")
        with self.assertRaises(g.SourceStopped):
            self.first.run("mootdx", denied)
        self.assertEqual(self.second.store.read(g.SOURCE)[1]["state"], "pending")
        with self.assertRaises(g.SourceStopped):
            self.second.run("tdx", Mock())

    def test_interruption_stops_next_runner(self):
        with self.assertRaises(KeyboardInterrupt):
            self.first.run("mootdx", Mock(side_effect=KeyboardInterrupt))
        with self.assertRaises(g.SourceStopped):
            self.second.run("pytdx", Mock())

    def test_revoke_during_request_is_not_overwritten(self):
        def revoke():
            revision, record = self.store.read(g.SOURCE)
            self.store.compare_and_swap(g.SOURCE, revision, dict(record, state="stopped", reason="revoked"))
        with self.assertRaises(g.SourceStopped):
            self.first.run("mootdx", revoke)
        self.assertEqual(self.store.read(g.SOURCE)[1]["reason"], "revoked")

    def test_nested_calls_recheck_reservation(self):
        self.assertEqual(self.first.run("mootdx", lambda: self.first.run("tdx", lambda: 4)), 4)

    def test_nested_denial_cannot_be_swallowed_into_success(self):
        def outer():
            try:
                self.first.run("tdx", Mock(side_effect=PermissionError("403 synthetic")))
            except PermissionError:
                pass
        with self.assertRaises(g.SourceStopped):
            self.first.run("mootdx", outer)
        with self.assertRaises(g.SourceStopped):
            self.second.run("tdx", Mock())

    def test_malformed_or_unreadable_state_prevents_request(self):
        for value in ((1, {}), (1, {"schema": g.SCHEMA, "source": "tencent", "state": "ready"})):
            with patch.object(self.store, "read", return_value=value):
                with self.assertRaises(g.SourceStopped):
                    self.first.run("mootdx", Mock())
        with patch.object(self.store, "read", side_effect=OSError):
            with self.assertRaises(g.SourceStopped):
                self.first.run("mootdx", Mock())

    def test_new_denial_blocks_legacy_factory(self):
        factory = Mock(side_effect=PermissionError("403 synthetic"))
        with patch.object(g, "PRODUCTION_GUARD", self.first), patch.object(new, "require_source_access"):
            with self.assertRaises(new.FeedError):
                new._collect_guarded("quotes", ["000001.SZ"], 5, None, {}, factory, None)
        legacy = Mock()
        module = SimpleNamespace(quotes=SimpleNamespace(Quotes=SimpleNamespace(factory=legacy)))
        with patch.object(g, "PRODUCTION_GUARD", self.second):
            with self.assertRaises(g.SourceStopped):
                old._call(module, "tdx.fixed_server")
        legacy.assert_not_called()

    def test_legacy_denial_blocks_new_factory(self):
        denied = Mock(side_effect=PermissionError("403 synthetic"))
        module = SimpleNamespace(quotes=SimpleNamespace(Quotes=SimpleNamespace(factory=denied)))
        with patch.object(g, "PRODUCTION_GUARD", self.first), \
                patch.dict(old.os.environ, {"BOOKS_TDX_SERVER": "192.0.2.1:7709"}), \
                patch.object(new, "fixed_server_factory", denied):
            with self.assertRaises(old.ProviderError):
                old._call(module, "tdx.fixed_server")
        factory = Mock()
        with patch.object(g, "PRODUCTION_GUARD", self.second), patch.object(new, "require_source_access"):
            with self.assertRaises(new.FeedError):
                new._collect_guarded("quotes", ["000001.SZ"], 5, None, {}, factory, None)
        factory.assert_not_called()

    def test_legacy_each_batch_checks_same_source(self):
        raw = SimpleNamespace(bars=Mock(return_value=[]), stocks=Mock(return_value=[]))
        wrapped = old._GuardedTdxClient(raw)
        with patch.object(g, "PRODUCTION_GUARD", self.first):
            wrapped.bars()
        revision, record = self.store.read(g.SOURCE)
        self.store.compare_and_swap(g.SOURCE, revision, dict(record, state="stopped", reason="synthetic"))
        with patch.object(g, "PRODUCTION_GUARD", self.second):
            with self.assertRaises(g.SourceStopped):
                wrapped.stocks()
        raw.stocks.assert_not_called()

    def test_production_legacy_import_stays_closed(self):
        with patch.object(old.importlib, "import_module") as imports:
            with self.assertRaisesRegex(g.SourceStopped, "legacy_source_stops_unverified"):
                old.Provider("mootdx")
        imports.assert_not_called()

    def test_denial_is_not_swallowed_by_fallback(self):
        for error in refusal_examples():
            with self.subTest(error=repr(error), fields=vars(error)):
                first, second = Mock(side_effect=error), Mock()
                module = SimpleNamespace(first=first, second=second)
                with self.assertRaisesRegex(old.ProviderError, "first") as raised:
                    old._try_calls(module, (("first", (), {}), ("second", (), {})))
                self.assertEqual(raised.exception.code, "provider_access_denied")
                second.assert_not_called()

    def test_structured_refusal_is_persisted(self):
        for error in refusal_examples():
            # Independent synthetic database per subcase; never resets a real stop.
            with tempfile.TemporaryDirectory() as directory:
                store = SQLiteFixture(Path(directory) / "synthetic.sqlite")
                store.seed({"schema": g.SCHEMA, "source": g.SOURCE, "state": "ready"})
                guard = g.Guard(store, migration_complete=True)
                with self.assertRaises(type(error)):
                    guard.run("tdx", Mock(side_effect=error))
                self.assertEqual(store.read(g.SOURCE)[1]["reason"], "provider_access_denied")

    def test_daily_and_intraday_loops_stop_after_first_denial(self):
        from datetime import datetime, timezone
        for mode in ("daily", "intraday"):
            for error in refusal_examples():
                source = Mock()
                source.directory.return_value = [
                    {"代码": "600519", "名称": "synthetic"}, {"代码": "600036", "名称": "synthetic"}]
                source.spot.return_value = []
                module = SimpleNamespace(read=Mock(side_effect=error))
                source.daily.side_effect = lambda *a, **k: old._call(module, "read")
                with patch.object(old, "provider", return_value=source):
                    with self.assertRaises(old.ProviderError) as raised:
                        if mode == "daily":
                            old.build_stock_input(now=datetime(2026, 11, 16, tzinfo=timezone.utc))
                        else:
                            old.build_a14_input(now=datetime(2026, 11, 16, tzinfo=timezone.utc))
                self.assertEqual(raised.exception.code, "provider_access_denied")
                self.assertEqual(source.daily.call_count, 1)
                source.minute.assert_not_called()
                source.benchmark.assert_not_called()


    def test_ready_legacy_missing_or_invalid_server_has_no_sdk_import(self):
        for server in ("", "example.invalid:7709", "192.0.2.1:0", "192.0.2.1:7709,192.0.2.2:7709"):
            with self.subTest(server=server), patch.object(g, "PRODUCTION_GUARD", self.first), \
                    patch.dict(old.os.environ, {"BOOKS_TDX_SERVER": server}), \
                    patch.object(old.importlib, "import_module") as imports, \
                    patch.object(new, "fixed_server_factory") as factory:
                with self.assertRaises(g.SourceStopped):
                    old.Provider("mootdx")
                with self.assertRaises(g.SourceStopped):
                    old._call(None, "tdx.fixed_server")
                imports.assert_not_called()
                factory.assert_not_called()

    def test_ready_legacy_fixed_endpoint_bypasses_original_sdk_constructor(self):
        transport = Mock()
        transport.connect.return_value = True
        transport.get_security_bars.return_value = [{"date": "2026-11-16"}]
        bootstrap = Mock(side_effect=AssertionError("original bootstrap forbidden"))
        class FakeStdQuotes:
            def __init__(self):
                bootstrap()
            def bars(self, **kwargs):
                return self.client.get_security_bars(**kwargs)
        sdk = SimpleNamespace(StdQuotes=FakeStdQuotes, TdxHq_API=Mock(return_value=transport),
                              Quotes=SimpleNamespace(factory=bootstrap))
        with patch.object(g, "PRODUCTION_GUARD", self.first), \
                patch.dict(old.os.environ, {"BOOKS_TDX_SERVER": "192.0.2.1:7709"}), \
                patch.dict(sys.modules, {"mootdx": SimpleNamespace(), "mootdx.quotes": sdk}):
            source = old.Provider("mootdx")
            self.assertEqual(source.daily("600519.SH", "2026-11-01", "2026-11-16"),
                             [{"date": "2026-11-16"}])
        sdk.TdxHq_API.assert_called_once_with(heartbeat=False, auto_retry=False, raise_exception=True)
        transport.connect.assert_called_once_with("192.0.2.1", 7709, time_out=10)
        transport.get_security_bars.assert_called_once_with(symbol="600519", frequency=9, offset=1000)
        bootstrap.assert_not_called()
        self.assertEqual(self.store.read(g.SOURCE)[1]["state"], "ready")

    def test_fixed_factory_rejects_bad_options_before_sdk_import(self):
        import builtins
        original = builtins.__import__
        sdk_imports = []
        def intercept(name, *args, **kwargs):
            if name.startswith("mootdx"):
                sdk_imports.append(name)
                raise AssertionError("SDK import forbidden")
            return original(name, *args, **kwargs)
        safe = dict(market="std", server=("192.0.2.1", 7709), timeout=10,
                    bestip=False, heartbeat=False, auto_retry=False, raise_exception=True)
        for change in ({"server": None}, {"server": ("example.invalid", 7709)},
                       {"server": ("192.0.2.1", True)}, {"timeout": float("nan")},
                       {"heartbeat": True}, {"auto_retry": True}, {"bestip": True}):
            with self.subTest(change=change), patch.object(g, "PRODUCTION_GUARD", self.first), \
                    patch.object(builtins, "__import__", side_effect=intercept):
                with self.assertRaises(new.FeedError):
                    new.fixed_server_factory(**dict(safe, **change))
        self.assertEqual(sdk_imports, [])



    def test_direct_fixed_factory_false_connect_persists_stop_before_retry(self):
        transport = Mock()
        transport.connect.return_value = False
        class FakeStdQuotes:
            def __init__(self):
                raise AssertionError("bootstrap forbidden")
        api = Mock(return_value=transport)
        sdk = SimpleNamespace(StdQuotes=FakeStdQuotes, TdxHq_API=api)
        options = dict(market="std", server=("192.0.2.1", 7709), timeout=10,
                       bestip=False, heartbeat=False, auto_retry=False, raise_exception=True)
        with patch.object(g, "PRODUCTION_GUARD", self.first), \
                patch.dict(sys.modules, {"mootdx": SimpleNamespace(), "mootdx.quotes": sdk}):
            with self.assertRaisesRegex(new.FeedError, "provider_connection_failed"):
                new.fixed_server_factory(**options)
            self.assertEqual(self.store.read(g.SOURCE)[1]["state"], "stopped")
        with patch.object(g, "PRODUCTION_GUARD", self.second), \
                patch.dict(sys.modules, {"mootdx": SimpleNamespace(), "mootdx.quotes": sdk}):
            with self.assertRaises(g.SourceStopped):
                new.fixed_server_factory(**options)
        api.assert_called_once()
        transport.connect.assert_called_once_with("192.0.2.1", 7709, time_out=10)
        transport.close.assert_called_once()


if __name__ == "__main__":
    unittest.main()
