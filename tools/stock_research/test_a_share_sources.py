"""Offline tests for provider normalization and evidence boundaries."""
from copy import deepcopy
from datetime import datetime, timezone
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from . import a_share_sources as s


class AShareSources(unittest.TestCase):
    def test_normalize_spot_preserves_names_and_rejects_duplicates(self):
        now = datetime(2026, 11, 16, 6, 0, tzinfo=timezone.utc)
        rows = [{"代码": "600519", "名称": "贵州茅台", "最新价": "1500.50", "成交额": "1000000"}]
        result = s.normalize_spot(rows, "akshare", now)
        self.assertEqual(result[0]["symbol"], "600519.SH")
        self.assertEqual(result[0]["name"], "贵州茅台")
        self.assertEqual(result[0]["price"], 1500.5)
        with self.assertRaisesRegex(s.ProviderError, "duplicate_security"):
            s.normalize_spot(rows + rows, "akshare", now)

    def test_normalize_bars_requires_ohlcv_and_sorts_dates(self):
        rows = [
            {"日期": "2026-11-14", "开盘": 2, "最高": 3, "最低": 1, "收盘": 2.5,
             "成交量": 10, "成交额": 20},
            {"日期": "2026-11-13", "开盘": 1, "最高": 2, "最低": .5, "收盘": 1.5,
             "成交量": 8, "成交额": 12},
        ]
        result = s.normalize_bars(rows, "adata")
        self.assertEqual([x["date"] for x in result], ["2026-11-13", "2026-11-14"])
        self.assertEqual(result[0]["turnover"], 12)

    def test_public_rights_are_explicit_and_local_default_is_owner(self):
        info = s.source_metadata(s.SOURCE_INFO["akshare"], received_at=datetime(2026, 11, 16, tzinfo=timezone.utc),
                                 data_as_of="2026-11-16", coverage="watchlist", expected_count=1,
                                 pagination_complete=False, public=False)
        self.assertEqual(info["accessScope"], "owner")
        self.assertFalse(info["permissionsVerified"])
        public = s.source_metadata(s.SOURCE_INFO["akshare"], received_at=datetime(2026, 11, 16, tzinfo=timezone.utc),
                                   data_as_of="2026-11-16", coverage="full_universe", expected_count=1,
                                   pagination_complete=True, public=True, redistribution_allowed=True)
        self.assertEqual(public["accessScope"], "public")
        self.assertTrue(public["permissionsVerified"])

    def test_baseline_keeps_at_most_twenty_unique_days(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "baseline.json"
            for i in range(22):
                day = f"2026-10-{i+1:02d}"
                batch = {"session": {"date": day, "cutoff": day+"T14:00:00+08:00"},
                         "observations": [{"symbol": "600519.SH", "turnover": i+1}]}
                s.update_baseline(path, batch)
            value = json.loads(path.read_text())
            entries = value["symbols"]["600519.SH"]
            self.assertEqual(len(entries), 20)
            self.assertEqual(entries[-1]["date"], "2026-10-22")

    def test_missing_provider_is_safe(self):
        with patch.object(s.importlib, "import_module", side_effect=ImportError):
            with self.assertRaisesRegex(s.ProviderError, "provider_not_installed"):
                s.provider("akshare")

    def test_provider_interface_fallback_uses_next_available_name(self):
        class Module:
            def old(self):
                raise RuntimeError("old endpoint unavailable")

            def current(self):
                return [{"ok": True}]

        result = s._try_calls(Module(), (("old", (), {}), ("current", (), {})))
        self.assertEqual(result, [{"ok": True}])


if __name__ == "__main__":
    unittest.main()
