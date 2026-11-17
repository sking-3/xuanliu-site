import copy
from datetime import datetime, timezone
import json
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
        batch = c.collect("daily", ["600519"], rows=5, factory=factory, now=NOW)
        factory.assert_called_once_with(market="std", bestip=False, heartbeat=False,
                                       auto_retry=False, raise_exception=True, timeout=10)
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
        c.collect("daily", ["600519"], server="192.0.2.1:7709", factory=factory, now=NOW)
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
                c.collect(**args)
            factory.assert_not_called()

    def test_timeout_or_access_denial_does_not_retry(self):
        for exception, code in [(TimeoutError("private"), "provider_timeout"),
                                (PermissionError("private"), "provider_access_denied"),
                                (RuntimeError("HTTP 429 raw data"), "provider_access_denied")]:
            client = self.client()
            client.bars.side_effect = exception
            factory = Mock(return_value=client)
            with self.subTest(code=code), self.assertRaisesRegex(c.FeedError, "^" + code + "$"):
                c.collect("daily", ["600519", "000001"], factory=factory, now=NOW)
            self.assertEqual(client.bars.call_count, 1)
            self.assertEqual(factory.call_count, 1)
            client.close.assert_called_once()

    def test_connection_failure_sanitized(self):
        factory = Mock(side_effect=RuntimeError("private detail"))
        with self.assertRaisesRegex(c.FeedError, "^provider_request_failed$"):
            c.collect("daily", ["600519"], factory=factory, now=NOW)
        factory.assert_called_once()

    def test_no_partial_result_after_second_symbol_fails(self):
        client = self.client()
        client.bars.side_effect = [[BAR], TimeoutError()]
        with self.assertRaises(c.FeedError):
            c.collect("daily", ["600519", "000001"], factory=lambda **kw: client, now=NOW)
        client.close.assert_called_once()

    def test_empty_responses_never_become_zero_data(self):
        for mode in ("quotes", "daily", "transactions"):
            client = self.client()
            client.quotes.return_value = client.bars.return_value = client.transactions.return_value = []
            with self.subTest(mode=mode), self.assertRaisesRegex(c.FeedError, "empty_or_invalid"):
                c.collect(mode, ["000001"], factory=lambda **kw: client, now=NOW,
                          historical_date="2026-11-16" if mode == "transactions" else None)
            client.close.assert_called_once()

    def test_quote_clock_is_not_full_source_timestamp(self):
        client = self.client()
        batch = c.collect("quotes", ["000001"], factory=lambda **kw: client, now=NOW)
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
        batch = c.collect("transactions", ["000001"], rows=10, historical_date="2025-06-24",
                          factory=lambda **kw: client, now=NOW)
        client.transactions.assert_called_once_with(symbol="000001", start=0, offset=10, date="20250624")
        self.assertEqual(batch["rows"][0]["requestedDate"], "2025-06-24")
        self.assertFalse(batch["rows"][0]["sourceDateVerified"])

    def test_invalid_transaction_dates_before_network(self):
        for day in (None, "20260230", "2026-02-30", "2026-11-18"):
            factory = Mock()
            with self.subTest(day=day), self.assertRaises(c.FeedError):
                c.collect("transactions", ["000001"], historical_date=day, factory=factory, now=NOW)
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
            c.collect("daily", ["600519"], rows=1, factory=lambda **kw: client, now=NOW)

    def test_dataframe_preserves_source_dates(self):
        import pandas as pd
        rows = c.normalize_daily(pd.DataFrame([BAR]), "600519.SH", NOW)
        self.assertEqual(rows[0]["date"], "2026-11-16")

    def test_close_error_does_not_mask_result(self):
        client = self.client()
        client.close.side_effect = RuntimeError("cleanup")
        batch = c.collect("daily", ["600519"], factory=lambda **kw: client, now=NOW)
        self.assertEqual(len(batch["rows"]), 1)

    def test_public_output_rejected_before_connection(self):
        with patch.object(c, "collect") as collect, patch("builtins.print"):
            code = c.main(["--symbols", "600519", "--output", str(c.ROOT / "research-data/new.json")])
        self.assertEqual(code, 2)
        collect.assert_not_called()

    def test_private_atomic_write_and_symlink_rejection(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "result.json"
            c.write_private(path, {"rows": []})
            self.assertEqual(json.loads(path.read_text()), {"rows": []})
            self.assertEqual(path.stat().st_mode & 0o077, 0)
            link = Path(directory) / "link.json"
            link.symlink_to(path)
            with self.assertRaises(c.FeedError):
                c.write_private(link, {"rows": [1]})
            self.assertEqual(json.loads(path.read_text()), {"rows": []})

    def test_failed_refresh_keeps_previous_file_and_date(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "result.json"
            before = '{"fetchedAt":"2026-11-13T08:00:00Z","rows":[]}'
            path.write_text(before)
            with patch.object(c, "collect", side_effect=c.FeedError("provider_timeout")), patch("builtins.print"):
                code = c.main(["--symbols", "600519", "--output", str(path)])
            self.assertEqual(code, 2)
            self.assertEqual(path.read_text(), before)

    def test_bad_serialization_keeps_existing_file(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "result.json"
            path.write_text('{"old":true}')
            with self.assertRaises(ValueError):
                c.write_private(path, {"bad": float("nan")})
            self.assertEqual(path.read_text(), '{"old":true}')

    def test_real_package_imports_without_connecting(self):
        with patch("socket.socket.connect", side_effect=AssertionError("Unexpected network")):
            from mootdx.quotes import Quotes
            from mootdx.reader import Reader
            self.assertTrue(callable(Quotes.factory))
            self.assertTrue(callable(Reader.factory))

if __name__ == "__main__":
    unittest.main()
