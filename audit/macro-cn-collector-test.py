"""Read-only regression tests for the Chinese releases collector."""
from datetime import datetime, timezone
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import collect_macro_cn as c

NOW = datetime(2026, 11, 16, 4, tzinfo=timezone.utc)
PATH = "./202611/t20261116_1965844.html"
URL = "https://www.stats.gov.cn/sj/zxfb/202611/t20261116_1965844.html"
TITLE = "测试发布"
LIST = f'<a href="/">首页</a><a href="{PATH}">{TITLE}</a>'.encode()
ARTICLE = f'<title>{TITLE} - 国家统计局</title><meta name="PubDate" content="2026-11-16"><p>2026/11/16 10:00</p>'.encode()


class MacroTests(unittest.TestCase):
    def test_local_rss_dates_and_absolute_https_links(self):
        rss = f'<rss><channel><item><title>{TITLE}</title><link>{PATH}</link><pubDate>2026-11-16 10:00:00</pubDate></item></channel></rss>'.encode()
        row = c.parse_feed(rss, NOW)["latest"]
        self.assertEqual(row["url"], URL)
        self.assertEqual(row["publishedAt"], "2026-11-16T02:00:00Z")

    def test_directory_fallback_uses_article_clock(self):
        with patch.object(c, "fetch", side_effect=[(b"<xml/>", {}), (LIST, {}), (ARTICLE, {})]) as fetch:
            card = c.build_card(NOW)
        self.assertEqual([call.args[0] for call in fetch.call_args_list], [c.RSS_URL, c.SOURCE_PAGE, URL])
        self.assertEqual(card["sourceUrl"], c.SOURCE_PAGE)
        self.assertEqual(card["data"]["latest"]["title"], TITLE)
        self.assertEqual(card["asOf"], "2026-11-16T02:00:00Z")

    def test_access_denied_stops_after_one_request(self):
        for code in ("http_403", "http_429"):
            with patch.object(c, "fetch", side_effect=c.SourceError(code)) as fetch:
                with self.assertRaisesRegex(c.SourceError, code):
                    c.build_card(NOW)
                self.assertEqual(fetch.call_count, 1)

    def test_invalid_or_older_data_leaves_last_good_intact(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "macro-cn.json"
            original = json.dumps({"card": {"asOf": "2026-11-16T02:00:00Z"}})
            out.write_text(original)
            with patch.object(sys, "argv", ["collector", "--output", str(out)]), patch.object(c, "build_card", return_value={"asOf": "2026-11-14T01:30:00Z"}):
                with self.assertRaisesRegex(c.SourceError, "older_than_saved_release"):
                    c.main()
            self.assertEqual(out.read_text(), original)


if __name__ == "__main__":
    unittest.main()
