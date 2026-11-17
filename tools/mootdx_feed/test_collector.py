import copy
from datetime import datetime, timezone
import json
import os
import subprocess
import sys
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch
from tools.mootdx_feed import collector as c

NOW = datetime(2026, 11, 17, 2, tzinfo=timezone.utc)
BAR = {"datetime": "2026-11-16 15:00", "open": 10.0, "high": 12.0,
       "low": 9.0, "close": 11.0, "vol": 100.0, "amount": 1100.0}
QUOTE = {"code": "000001", "market": 0, "price": 11.0,
         "vol": 100.0, "amount": 1100.0, "servertime": "09:51:03"}

class CollectorTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.state = patch.object(c, "STATE_DIR", self.root / "state")
        self.data = patch.object(c, "DATA_DIR", self.root / "data")
        self.state.start()
        self.data.start()
        self.addCleanup(self.state.stop)
        self.addCleanup(self.data.stop)
        # Only these offline behavior tests substitute the unfinished access gate.
        # SourceAccessTests below exercise the real gate with no such patch.
        access = patch.object(c, "require_source_access")
        access.start()
        self.addCleanup(access.stop)
        # Existing parser/local-filesystem cases bypass both closed gates.
        # Shared CAS and cross-entry integration are tested in test_tdx_source_guard.
        transport = patch.object(c, "source_call", side_effect=lambda fn, *a, **k: fn(*a, **k))
        transport.start()
        self.addCleanup(transport.stop)
        # Every test blocks raw sockets even when testing the real pinned parser.
        self.socket = patch("socket.socket.connect", side_effect=AssertionError("Unexpected network"))
        self.socket.start()
        self.addCleanup(self.socket.stop)

    def fresh_state(self):
        self.state.stop()
        self.state = patch.object(c, "STATE_DIR", self.root / ("state-" + str(len(list(self.root.iterdir())))))
        self.state.start()
        self.addCleanup(self.state.stop)

    def collect(self, *args, **kwargs):
        kwargs.setdefault("server", "192.0.2.1:7709")
        kwargs.setdefault("network_enabled", True)
        return c.collect(*args, **kwargs)

    def client(self):
        client = Mock()
        client.bars.return_value = [copy.deepcopy(BAR)]
        client.quotes.return_value = [copy.deepcopy(QUOTE)]
        client.transactions.return_value = [{"time": "09:31", "price": 11.0, "vol": 10.0}]
        return client

    def test_shenzhen_and_shanghai_symbol_mapping(self):
        self.assertEqual(c.symbols(["000001", "600519.SH", "300750.SZ", "688981"]),
                         ["000001.SZ", "600519.SH", "300750.SZ", "688981.SH"])

    def test_invalid_universes_rejected(self):
        for values in ([], ["000001", "000001.SZ"], ["600519.SZ"], ["000001.SH"],
                       ["920001.BJ"], ["510300"], ["399001"], ["600519;DROP"], ["600519"] * 51):
            with self.subTest(values=values), self.assertRaises(c.FeedError):
                c.symbols(values)

    def test_daily_api_contract_and_connection_cleanup(self):
        client = self.client()
        factory = Mock(return_value=client)
        batch = self.collect("daily", ["600519"], rows=5, factory=factory, now=NOW)
        factory.assert_called_once_with(market="std", bestip=False, heartbeat=False,
                                       auto_retry=False, raise_exception=True, timeout=10,
                                       server=("192.0.2.1", 7709))
        client.bars.assert_called_once_with(symbol="600519", frequency=9, start=0, offset=5)
        client.close.assert_called_once()
        self.assertEqual(batch["rows"][0]["date"], "2026-11-16")
        self.assertEqual(batch["status"], "collected_unverified")
        self.assertFalse(batch["redistributionAllowed"])
        self.assertFalse(batch["calendarVerified"])
        self.assertIsNone(batch["rows"][0]["sessionComplete"])
        self.assertEqual(batch["units"]["amountRaw"], "provider_native_unverified")

    def test_explicit_server_not_replaced_or_scanned(self):
        factory = Mock(return_value=self.client())
        self.collect("daily", ["600519"], server="192.0.2.1:7709", factory=factory, now=NOW)
        self.assertEqual(factory.call_args.kwargs["server"], ("192.0.2.1", 7709))
        self.assertFalse(factory.call_args.kwargs["bestip"])

    def test_input_validation_precedes_connection(self):
        for change in [{"requested": ["bad"]}, {"mode": "intraday"}, {"rows": 801},
                       {"rows": 0}, {"rows": True}, {"timeout": float("inf")},
                       {"timeout": 0}, {"timeout": True}, {"server": "example.com:7709"},
                       {"server": "192.0.2.1:70000"}, {"historical_date": "2026-11-16"},
                       {"now": datetime(2026, 11, 17)}]:
            factory = Mock()
            args = dict(mode="daily", requested=["600519"], factory=factory, now=NOW)
            args.update(change)
            with self.subTest(change=change), self.assertRaises(c.FeedError):
                self.collect(**args)
            factory.assert_not_called()

    def test_timeout_or_access_denial_does_not_retry(self):
        for exception, code in [(TimeoutError("private"), "provider_timeout"),
                                (PermissionError("private"), "provider_access_denied"),
                                (RuntimeError("HTTP 429 raw data"), "provider_access_denied")]:
            self.fresh_state()
            client = self.client()
            client.bars.side_effect = exception
            factory = Mock(return_value=client)
            with self.subTest(code=code), self.assertRaisesRegex(c.FeedError, "^" + code + "$"):
                self.collect("daily", ["600519", "000001"], factory=factory, now=NOW)
            self.assertEqual(client.bars.call_count, 1)
            self.assertEqual(factory.call_count, 1)
            client.close.assert_called_once()

    def test_connection_failure_sanitized(self):
        factory = Mock(side_effect=RuntimeError("private detail"))
        with self.assertRaisesRegex(c.FeedError, "^provider_request_failed$"):
            self.collect("daily", ["600519"], factory=factory, now=NOW)
        factory.assert_called_once()

    def test_no_partial_result_after_second_symbol_fails(self):
        client = self.client()
        client.bars.side_effect = [[BAR], TimeoutError()]
        with self.assertRaises(c.FeedError):
            self.collect("daily", ["600519", "000001"], factory=lambda **kw: client, now=NOW)
        client.close.assert_called_once()

    def test_empty_responses_never_become_zero_data(self):
        for mode in ("quotes", "daily", "transactions"):
            self.fresh_state()
            client = self.client()
            client.quotes.return_value = client.bars.return_value = client.transactions.return_value = []
            with self.subTest(mode=mode), self.assertRaisesRegex(c.FeedError, "empty_or_invalid"):
                self.collect(mode, ["000001"], factory=lambda **kw: client, now=NOW,
                          historical_date="2026-11-16" if mode == "transactions" else None)
            client.close.assert_called_once()

    def test_quote_clock_is_not_full_source_timestamp(self):
        client = self.client()
        batch = self.collect("quotes", ["000001"], factory=lambda **kw: client, now=NOW)
        self.assertIsNone(batch["sourceAsOf"])
        self.assertIsNone(batch["rows"][0]["sourceAsOf"])
        self.assertEqual(batch["rows"][0]["sourceClock"], "09:51:03")
        self.assertEqual(batch["rows"][0]["tvSymbol"], "SZSE:000001")

    def test_quotes_match_requested_codes_and_exchange(self):
        for raw in ([QUOTE, QUOTE], [dict(QUOTE, market=1)], [dict(QUOTE, code="600519")]):
            with self.subTest(raw=raw), self.assertRaises(c.FeedError):
                c.normalize_quotes(raw, ["000001.SZ"])
        with self.assertRaisesRegex(c.FeedError, "incomplete_quotes"):
            c.normalize_quotes([QUOTE], ["000001.SZ", "600519.SH"])

    def test_unreliable_quote_clock_unknown(self):
        row = c.normalize_quotes([dict(QUOTE, servertime="tomorrow")], ["000001.SZ"])[0]
        self.assertIsNone(row["sourceClock"])

    def test_invalid_numbers_rejected(self):
        for value in (True, "1100", None, float("nan"), float("inf"), -1):
            with self.subTest(value=value), self.assertRaises(c.FeedError):
                c.normalize_daily([dict(BAR, amount=value)], "600519.SH", NOW)

    def test_zero_amount_preserved(self):
        row = c.normalize_daily([dict(BAR, amount=0, vol=0)], "600519.SH", NOW)[0]
        self.assertEqual(row["amountRaw"], 0)
        self.assertIsNone(row["sessionComplete"])

    def test_future_duplicate_impossible_dates_rejected(self):
        for raw in ([dict(BAR, datetime="2026-11-18 15:00")], [BAR, BAR],
                    [dict(BAR, datetime="2026-02-30 15:00")],
                    [dict(BAR, datetime="2026-11-16 25:00")]):
            with self.subTest(raw=raw), self.assertRaises(c.FeedError):
                c.normalize_daily(raw, "600519.SH", NOW)

    def test_current_day_not_claimed_complete(self):
        row = c.normalize_daily([dict(BAR, datetime="2026-11-17 09:59")], "600519.SH", NOW)[0]
        self.assertTrue(row["isCurrentDate"])
        self.assertIsNone(row["sessionComplete"])

    def test_sort_without_filling_missing_sessions(self):
        rows = c.normalize_daily([BAR, dict(BAR, datetime="2026-11-12")], "600519.SH", NOW)
        self.assertEqual([row["date"] for row in rows], ["2026-11-12", "2026-11-16"])

    def test_bad_ohlc_rejected(self):
        for raw in (dict(BAR, low=11), dict(BAR, high=10), dict(BAR, close=0)):
            with self.subTest(raw=raw), self.assertRaises(c.FeedError):
                c.normalize_daily([raw], "600519.SH", NOW)

    def test_unknown_fields_not_serialized(self):
        rows = c.normalize_daily([dict(BAR, private_account="secret")], "600519.SH", NOW)
        self.assertNotIn("private_account", rows[0])

    def test_historical_transaction_api_and_date_provenance(self):
        client = self.client()
        batch = self.collect("transactions", ["000001"], rows=10, historical_date="2025-06-24",
                          factory=lambda **kw: client, now=NOW)
        client.transactions.assert_called_once_with(symbol="000001", start=0, offset=10, date="20250624")
        self.assertEqual(batch["rows"][0]["requestedDate"], "2025-06-24")
        self.assertFalse(batch["rows"][0]["sourceDateVerified"])

    def test_invalid_transaction_dates_before_network(self):
        for day in (None, "20260230", "2026-02-30", "2026-11-18"):
            factory = Mock()
            with self.subTest(day=day), self.assertRaises(c.FeedError):
                self.collect("transactions", ["000001"], historical_date=day, factory=factory, now=NOW)
            factory.assert_not_called()

    def test_transaction_fields_checked(self):
        for raw in ({"time": "25:01", "price": 1, "vol": 1},
                    {"time": "09:31", "price": 1, "vol": -1}):
            with self.subTest(raw=raw), self.assertRaises(c.FeedError):
                c.normalize_transactions([raw], "000001.SZ", "2026-11-16")

    def test_response_limit_enforced(self):
        client = self.client()
        client.bars.return_value = [BAR, dict(BAR, datetime="2026-11-13")]
        with self.assertRaisesRegex(c.FeedError, "response_exceeds"):
            self.collect("daily", ["600519"], rows=1, factory=lambda **kw: client, now=NOW)

    def test_dataframe_preserves_source_dates(self):
        import pandas as pd
        rows = c.normalize_daily(pd.DataFrame([BAR]), "600519.SH", NOW)
        self.assertEqual(rows[0]["date"], "2026-11-16")

    def test_close_error_does_not_mask_result(self):
        client = self.client()
        client.close.side_effect = RuntimeError("cleanup")
        batch = self.collect("daily", ["600519"], factory=lambda **kw: client, now=NOW)
        self.assertEqual(len(batch["rows"]), 1)

    def test_public_output_rejected_before_connection(self):
        with patch.object(c, "collect") as collect, patch("builtins.print"):
            code = c.main(["--enable-network", "--server", "192.0.2.1:7709",
                           "--symbols", "600519", "--output", str(c.ROOT / "research-data/new.json")])
        self.assertEqual(code, 2)
        collect.assert_not_called()

    def sample(self, **extra):
        return {"schema": "books.mootdx.sample.v1", "provider": "mootdx", "rows": [], **extra}

    def test_private_atomic_write_permissions_and_schema(self):
        path = c.DATA_DIR / "daily-new.json"
        c.write_private(path, self.sample())
        self.assertEqual(json.loads(path.read_text()), self.sample())
        self.assertEqual(path.stat().st_mode & 0o077, 0)
        self.assertEqual(c.DATA_DIR.stat().st_mode & 0o077, 0)
        self.assertEqual(list(c.DATA_DIR.iterdir()), [path])

    def test_arbitrary_external_file_never_overwritten(self):
        path = self.root / "credentials.json"
        path.write_text("private existing content")
        with self.assertRaises(c.FeedError):
            c.write_private(path, self.sample())
        self.assertEqual(path.read_text(), "private existing content")

    def test_any_existing_file_refused_even_own_schema(self):
        for name, before in [("daily-foreign.json", "not tool format"),
                             ("daily-old.json", json.dumps(self.sample(fetchedAt="2026-11-13")))]:
            c.DATA_DIR.mkdir(mode=0o700, exist_ok=True)
            path = c.DATA_DIR / name
            path.write_text(before)
            with self.subTest(name=name), self.assertRaisesRegex(c.FeedError, "output_already_exists"):
                c.write_private(path, self.sample())
            self.assertEqual(path.read_text(), before)

    def test_symlink_and_hardlink_outputs_refused(self):
        c.DATA_DIR.mkdir(mode=0o700)
        target = self.root / "secret"
        target.write_text("keep")
        (c.DATA_DIR / "daily-link.json").symlink_to(target)
        os.link(target, c.DATA_DIR / "daily-hard.json")
        for name in ("daily-link.json", "daily-hard.json"):
            with self.subTest(name=name), self.assertRaises(c.FeedError):
                c.write_private(c.DATA_DIR / name, self.sample())
        self.assertEqual(target.read_text(), "keep")

    def test_symlink_directory_refused(self):
        target = self.root / "real"
        target.mkdir(mode=0o700)
        c.DATA_DIR.symlink_to(target, target_is_directory=True)
        with self.assertRaises(OSError):
            c.write_private(c.DATA_DIR / "daily.json", self.sample())
        self.assertEqual(list(target.iterdir()), [])

    def test_nonprivate_directory_refused(self):
        c.DATA_DIR.mkdir(mode=0o755)
        c.DATA_DIR.chmod(0o755)
        with self.assertRaisesRegex(c.FeedError, "private_directory_required"):
            c.write_private(c.DATA_DIR / "daily.json", self.sample())

    def test_output_name_rejects_traversal_and_arbitrary_files(self):
        for name in ("../daily.json", "child/daily.json", ".ssh", "config.json", "daily.json/../quotes.json"):
            with self.subTest(name=name), self.assertRaises(c.FeedError):
                c.output_path(name)

    def test_atomic_publish_race_does_not_clobber_target(self):
        path = c.DATA_DIR / "daily.json"
        real_link = os.link
        def collision(source, target, **kwargs):
            path.write_text("arrived between preflight and publication")
            return real_link(source, target, **kwargs)
        with patch.object(c.os, "link", side_effect=collision), self.assertRaises(FileExistsError):
            c.write_private(path, self.sample())
        self.assertEqual(path.read_text(), "arrived between preflight and publication")
        self.assertEqual(list(c.DATA_DIR.iterdir()), [path])

    def test_bad_serialization_creates_no_snapshot(self):
        with self.assertRaises(ValueError):
            c.write_private(c.DATA_DIR / "daily.json", self.sample(bad=float("nan")))
        self.assertEqual(list(c.DATA_DIR.iterdir()), [])

    def test_foreign_schema_creates_no_snapshot(self):
        with self.assertRaisesRegex(c.FeedError, "invalid_output_schema"):
            c.write_private(c.DATA_DIR / "daily.json", {"rows": []})
        self.assertEqual(list(c.DATA_DIR.iterdir()), [])

    def test_failed_refresh_keeps_previous_file_and_date(self):
        old = c.DATA_DIR / "daily-old.json"
        c.write_private(old, self.sample(fetchedAt="2026-11-13T08:00:00Z"))
        before = old.read_text()
        with patch.object(c, "collect", side_effect=c.FeedError("provider_timeout")), patch("builtins.print"):
            code = c.main(["--enable-network", "--server", "192.0.2.1:7709",
                           "--symbols", "600519", "--output", "daily-new.json"])
        self.assertEqual(code, 2)
        self.assertEqual(old.read_text(), before)
        self.assertFalse((c.DATA_DIR / "daily-new.json").exists())

    def test_default_disabled_before_factory_or_filesystem(self):
        factory = Mock()
        with self.assertRaisesRegex(c.FeedError, "network_disabled"):
            c.collect("daily", ["600519"], factory=factory)
        factory.assert_not_called()
        with patch.object(c, "collect") as collect, patch("builtins.print"):
            self.assertEqual(c.main(["--symbols", "600519"]), 2)
        collect.assert_not_called()
        self.assertEqual(list(self.root.iterdir()), [])

    def test_explicit_server_required(self):
        factory = Mock()
        with self.assertRaisesRegex(c.FeedError, "explicit_server_required"):
            self.collect("daily", ["600519"], server=None, factory=factory)
        factory.assert_not_called()
        self.assertFalse(c.STATE_DIR.exists())

    def test_failure_persists_and_blocks_all_modes_hosts_and_symbols(self):
        factory = Mock(side_effect=PermissionError("forbidden private detail"))
        with self.assertRaisesRegex(c.FeedError, "provider_access_denied"):
            self.collect("daily", ["600519"], factory=factory, now=NOW)
        marker = c.STATE_DIR / "source-state.json"
        stopped = json.loads(marker.read_text())
        self.assertEqual(stopped["state"], "stopped")
        self.assertEqual(stopped["reason"], "provider_access_denied")
        self.assertNotIn("private detail", marker.read_text())
        self.assertEqual(marker.stat().st_mode & 0o077, 0)
        for mode in ("daily", "quotes", "transactions"):
            with self.subTest(mode=mode), self.assertRaisesRegex(c.FeedError, "source_stopped_or_busy"):
                self.collect(mode, ["000001"], server="192.0.2.2:7710", factory=factory, now=NOW,
                             historical_date="2026-11-16" if mode == "transactions" else None)
        factory.assert_called_once()

    def test_stop_survives_a_new_python_process(self):
        with self.assertRaises(c.FeedError):
            self.collect("daily", ["600519"], factory=Mock(side_effect=TimeoutError()))
        script = (
            "import sys; from pathlib import Path; from unittest.mock import Mock, patch\n"
            "from tools.mootdx_feed import collector as c\n"
            "c.STATE_DIR = Path(sys.argv[1]); factory = Mock(side_effect=AssertionError('factory called'))\n"
            "with patch.object(c, 'require_source_access'), patch('socket.socket.connect', side_effect=AssertionError('network')):\n"
            " try:\n"
            "  c.collect('quotes', ['000001'], server='192.0.2.2:7709', network_enabled=True, factory=factory)\n"
            " except c.FeedError as e:\n"
            "  assert str(e) == 'source_stopped_or_busy', str(e)\n"
            " else:\n"
            "  raise AssertionError('stop not enforced')\n"
            " factory.assert_not_called()\n"
        )
        result = subprocess.run([sys.executable, "-c", script, str(c.STATE_DIR)],
                                cwd=c.ROOT, text=True, capture_output=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_malformed_inprogress_and_linked_markers_block(self):
        for kind in ("malformed", "in_progress", "symlink", "hardlink"):
            self.fresh_state()
            c.STATE_DIR.mkdir(mode=0o700)
            marker = c.STATE_DIR / "source-state.json"
            if kind == "symlink":
                marker.symlink_to(self.root / "missing")
            elif kind == "hardlink":
                target = self.root / "marker-target"
                target.write_text("keep")
                os.link(target, marker)
            else:
                marker.write_text("{" if kind == "malformed" else '{"state":"in_progress"}')
            factory = Mock()
            with self.subTest(kind=kind), self.assertRaisesRegex(c.FeedError, "source_stopped_or_busy"):
                self.collect("daily", ["600519"], factory=factory)
            factory.assert_not_called()

    def test_state_persistence_failure_prevents_factory(self):
        factory = Mock()
        with patch.object(c, "write_record", side_effect=OSError("disk full")), self.assertRaises(OSError):
            self.collect("daily", ["600519"], factory=factory)
        factory.assert_not_called()
        self.assertTrue((c.STATE_DIR / "source-state.json").exists())
        with self.assertRaisesRegex(c.FeedError, "source_stopped_or_busy"):
            self.collect("daily", ["600519"], factory=factory)
        factory.assert_not_called()

    def test_interrupt_leaves_stop_and_no_retry(self):
        factory = Mock(side_effect=KeyboardInterrupt)
        with self.assertRaises(KeyboardInterrupt):
            self.collect("daily", ["600519"], factory=factory)
        self.assertEqual(json.loads((c.STATE_DIR / "source-state.json").read_text())["state"], "stopped")
        with self.assertRaisesRegex(c.FeedError, "source_stopped_or_busy"):
            self.collect("daily", ["600519"], factory=factory)
        factory.assert_called_once()

    def test_concurrent_request_blocked_before_second_factory(self):
        inner = Mock()
        client = self.client()
        def outer(**options):
            with self.assertRaisesRegex(c.FeedError, "source_stopped_or_busy"):
                self.collect("quotes", ["000001"], factory=inner)
            return client
        self.collect("daily", ["600519"], factory=outer, now=NOW)
        inner.assert_not_called()
        self.assertFalse((c.STATE_DIR / "source-state.json").exists())

    def test_success_releases_guard_for_next_manual_call(self):
        factory = Mock(return_value=self.client())
        self.collect("daily", ["600519"], factory=factory, now=NOW)
        self.collect("daily", ["600519"], factory=factory, now=NOW)
        self.assertEqual(factory.call_count, 2)
        self.assertEqual(list(c.STATE_DIR.iterdir()), [])

    def test_no_cli_reset_or_state_override(self):
        for flag in ("--reset", "--force", "--state-dir"):
            with self.subTest(flag=flag), patch("sys.stderr"), self.assertRaises(SystemExit):
                c.main(["--symbols", "600519", flag])

    def safe_options(self):
        return dict(market="std", server=("192.0.2.1", 7709), timeout=10,
                    bestip=False, heartbeat=False, auto_retry=False, raise_exception=True)

    def test_upstream_constructor_attempts_scan_for_missing_or_corrupt_config(self):
        from mootdx import config
        from mootdx.quotes import Quotes
        for kind in ("missing", "corrupt"):
            conf = self.root / (kind + "-config.json")
            if kind == "corrupt":
                conf.write_text("{")
            with self.subTest(kind=kind), patch.object(config, "CONF", conf), \
                    patch.object(config, "bestip", side_effect=RuntimeError("scan intercepted")) as scan:
                with self.assertRaises((FileNotFoundError, json.JSONDecodeError, RuntimeError)):
                    Quotes.factory(**self.safe_options())
                scan.assert_called_once()

    def test_fixed_factory_uses_real_parsers_without_config_bootstrap_or_scan(self):
        from mootdx import config, quotes
        for kind in ("missing", "corrupt", "other_server"):
            conf = self.root / (kind + "-safe-config.json")
            if kind != "missing":
                conf.write_text("{" if kind == "corrupt" else '{"BESTIP":{"HQ":["192.0.2.99",1234]}}')
            before = conf.read_bytes() if conf.exists() else None
            transport = Mock()
            transport.connect.return_value = True
            transport.get_security_bars.return_value = [BAR]
            transport.get_security_quotes.return_value = [QUOTE]
            transport.get_history_transaction_data.return_value = [{"time": "09:31", "price": 11.0, "vol": 10.0}]
            with self.subTest(kind=kind), patch.object(config, "CONF", conf), \
                    patch.object(config, "setup", side_effect=AssertionError("bootstrap")) as setup, \
                    patch.object(config, "bestip", side_effect=AssertionError("scan")) as scan, \
                    patch.object(quotes, "check_server", side_effect=AssertionError("scan")) as check, \
                    patch.object(quotes, "TdxHq_API", return_value=transport) as api:
                client = c.default_factory(**self.safe_options())
                api.assert_called_once_with(heartbeat=False, auto_retry=False, raise_exception=True)
                transport.connect.assert_called_once_with("192.0.2.1", 7709, time_out=10)
                c.normalize_daily(client.bars(symbol="600519", frequency=9, start=0, offset=5), "600519.SH", NOW)
                c.normalize_quotes(client.quotes(symbol=["000001"]), ["000001.SZ"])
                c.normalize_transactions(client.transactions(symbol="000001", start=0, offset=10, date="20250624"),
                                         "000001.SZ", "2025-06-24")
                transport.get_security_bars.assert_called_once_with(9, 1, "600519", 0, 5)
                with self.assertRaisesRegex(c.FeedError, "automatic_reconnect_disabled"):
                    client.reconnect()
                client.close()
                client.close()
                transport.close.assert_called_once()
                setup.assert_not_called()
                scan.assert_not_called()
                check.assert_not_called()
            self.assertEqual(conf.read_bytes() if conf.exists() else None, before)

    def test_fixed_factory_failure_closes_transport_and_stops_source(self):
        from mootdx import quotes
        for result in (False, TimeoutError("private")):
            self.fresh_state()
            transport = Mock()
            if isinstance(result, Exception):
                transport.connect.side_effect = result
            else:
                transport.connect.return_value = result
            with self.subTest(result=result), patch.object(quotes, "TdxHq_API", return_value=transport) as api:
                with self.assertRaises(c.FeedError):
                    self.collect("daily", ["600519"], now=NOW)
                transport.connect.assert_called_once()
                transport.close.assert_called_once()
                with self.assertRaisesRegex(c.FeedError, "source_stopped_or_busy"):
                    self.collect("daily", ["600519"], now=NOW)
                api.assert_called_once()

    def test_connected_transport_with_empty_market_data_stops_without_probe_or_fallback(self):
        from mootdx import quotes
        for mode in ("daily", "quotes", "transactions"):
            self.fresh_state()
            transport = Mock()
            transport.connect.return_value = True
            transport.get_security_bars.return_value = []
            transport.get_security_quotes.return_value = []
            transport.get_history_transaction_data.return_value = []
            transport.get_security_list.return_value = [{"code": "600519"}]
            with self.subTest(mode=mode), patch.object(quotes, "TdxHq_API", return_value=transport) as api:
                with self.assertRaisesRegex(c.FeedError, "empty_or_invalid_response"):
                    self.collect(mode, ["600519"], now=NOW,
                                 historical_date="2026-11-16" if mode == "transactions" else None)
                transport.connect.assert_called_once_with("192.0.2.1", 7709, time_out=10)
                transport.get_security_list.assert_not_called()
                transport.close.assert_called_once()
                marker = json.loads((c.STATE_DIR / "source-state.json").read_text())
                self.assertEqual(marker["reason"], "empty_or_invalid_response")
                with self.assertRaisesRegex(c.FeedError, "source_stopped_or_busy"):
                    self.collect("daily", ["600519"], now=NOW, server="192.0.2.2:7709")
                api.assert_called_once()

    def test_real_package_imports_without_connecting(self):
        with patch("socket.socket.connect", side_effect=AssertionError("Unexpected network")):
            from mootdx.quotes import Quotes
            from mootdx.reader import Reader
            self.assertTrue(callable(Quotes.factory))
            self.assertTrue(callable(Reader.factory))


class SourceAccessTests(unittest.TestCase):
    """No test here replaces the real access gate or connects to a provider."""

    def setUp(self):
        from tools.binance_watch import source_holds
        self.holds = source_holds
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        for module, name, value in (
            (c, "STATE_DIR", self.root / "new-state"),
            (c, "DATA_DIR", self.root / "new-output"),
            (source_holds, "POLICY", self.root / "source-holds.json"),
        ):
            guard = patch.object(module, name, value)
            guard.start()
            self.addCleanup(guard.stop)
        network = patch("socket.socket.connect", side_effect=AssertionError("Unexpected network"))
        network.start()
        self.addCleanup(network.stop)

    def policy(self, value):
        self.holds.POLICY.write_text(json.dumps(value))

    def attempt(self, **extra):
        args = dict(mode="daily", requested=["600519"], server="192.0.2.1:7709",
                    network_enabled=True, factory=Mock(), now=NOW)
        args.update(extra)
        try:
            with self.assertRaises(c.FeedError) as failure:
                c.collect(**args)
            return str(failure.exception)
        finally:
            args["factory"].assert_not_called()

    def test_shared_permission_missing_stops_before_factory_or_new_state(self):
        self.assertEqual(self.attempt(), "source_permission_unverified")
        self.assertFalse(c.STATE_DIR.exists())
        self.assertFalse(c.DATA_DIR.exists())

    def test_other_operation_approval_cannot_authorize_tdx(self):
        self.policy({"binancePublicCollector": "approved", "githubRunInventory": "approved"})
        self.assertEqual(self.attempt(), "source_permission_unverified")

    def test_stopped_paused_unknown_and_malformed_permissions_deny(self):
        for value in ("stopped_after_403", "stopped_after_429", "paused", "", True, None,
                      {"approved": True}):
            with self.subTest(value=value):
                self.policy({c.SOURCE_OPERATION: value})
                self.assertEqual(self.attempt(), "source_permission_unverified")
        for raw in ("{", "null", "[]"):
            with self.subTest(raw=raw):
                self.holds.POLICY.write_text(raw)
                self.assertEqual(self.attempt(), "source_permission_unverified")

    def test_approval_alone_cannot_bypass_unreconciled_legacy_stops(self):
        self.policy({c.SOURCE_OPERATION: "approved"})
        self.assertEqual(self.attempt(), "legacy_source_stops_unverified")
        self.assertFalse(c.STATE_DIR.exists())

    def test_empty_new_namespace_does_not_authorize_any_mode_or_server(self):
        self.policy({c.SOURCE_OPERATION: "approved"})
        c.STATE_DIR.mkdir(mode=0o700)
        for mode in ("daily", "quotes", "transactions"):
            with self.subTest(mode=mode):
                self.assertEqual(self.attempt(
                    mode=mode, server="192.0.2.2:7710", requested=["000001"],
                    historical_date="2026-11-16" if mode == "transactions" else None,
                ), "legacy_source_stops_unverified")
        self.assertEqual(list(c.STATE_DIR.iterdir()), [])

    def test_real_cli_enable_flag_cannot_create_files_or_client(self):
        self.policy({c.SOURCE_OPERATION: "approved"})
        with patch.object(c, "default_factory") as factory, patch.object(c, "collect") as collect, \
                patch("builtins.print") as output:
            code = c.main(["--enable-network", "--server", "192.0.2.1:7709", "--symbols", "600519"])
        self.assertEqual(code, 2)
        self.assertEqual(json.loads(output.call_args.args[0])["error"], "legacy_source_stops_unverified")
        factory.assert_not_called()
        collect.assert_not_called()
        self.assertFalse(c.STATE_DIR.exists())
        self.assertFalse(c.DATA_DIR.exists())

    def test_direct_factory_call_is_blocked_before_provider_import(self):
        import builtins
        self.policy({c.SOURCE_OPERATION: "approved"})
        real_import = builtins.__import__
        attempted = []
        def inspect(name, *args, **kwargs):
            if name == "mootdx" or name.startswith("mootdx."):
                attempted.append(name)
                raise AssertionError("Provider imported before access gate")
            return real_import(name, *args, **kwargs)
        with patch("builtins.__import__", side_effect=inspect), \
                self.assertRaisesRegex(c.FeedError, "legacy_source_stops_unverified"):
            c.default_factory()
        self.assertEqual(attempted, [])

    def test_internal_helper_is_also_blocked(self):
        self.policy({c.SOURCE_OPERATION: "approved"})
        factory = Mock()
        with self.assertRaisesRegex(c.FeedError, "legacy_source_stops_unverified"):
            c._collect_guarded("daily", ["600519.SH"], 5, None, {}, factory, NOW)
        factory.assert_not_called()

    def test_checked_in_policy_does_not_authorize_live_collection(self):
        with patch.object(self.holds, "POLICY", c.ROOT / "scripts/source-holds.json"):
            with self.assertRaises(c.FeedError):
                c.require_source_access()

    def test_policy_and_previous_local_stop_are_never_modified(self):
        self.policy({c.SOURCE_OPERATION: "approved", "other": "stopped_after_403"})
        before = self.holds.POLICY.read_bytes()
        c.STATE_DIR.mkdir(mode=0o700)
        marker = c.STATE_DIR / "source-state.json"
        marker.write_text('{"state":"stopped","reason":"provider_access_denied"}')
        previous = marker.read_bytes()
        self.assertEqual(self.attempt(), "legacy_source_stops_unverified")
        self.assertEqual(self.holds.POLICY.read_bytes(), before)
        self.assertEqual(marker.read_bytes(), previous)

    def test_new_process_cannot_enable_with_approved_key_and_empty_namespace(self):
        self.policy({c.SOURCE_OPERATION: "approved"})
        script = (
            "import sys; from pathlib import Path; from unittest.mock import Mock, patch\n"
            "from tools.mootdx_feed import collector as c\n"
            "from tools.binance_watch import source_holds\n"
            "source_holds.POLICY = Path(sys.argv[1]); c.STATE_DIR = Path(sys.argv[2])\n"
            "factory = Mock(side_effect=AssertionError('factory called'))\n"
            "with patch('socket.socket.connect', side_effect=AssertionError('network')):\n"
            " try:\n"
            "  c.collect('quotes', ['000001'], server='192.0.2.1:7709', network_enabled=True, factory=factory)\n"
            " except c.FeedError as e:\n"
            "  assert str(e) == 'legacy_source_stops_unverified', str(e)\n"
            " else:\n"
            "  raise AssertionError('gate bypassed')\n"
            " factory.assert_not_called()\n"
            " assert not c.STATE_DIR.exists()\n"
        )
        result = subprocess.run([sys.executable, "-c", script, str(self.holds.POLICY), str(c.STATE_DIR)],
                                cwd=c.ROOT, text=True, capture_output=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr)

if __name__ == "__main__":
    unittest.main()
