#!/usr/bin/env python3
"""Collect a small, read-only Chinese macro release snapshot.

The collector keeps only RSS metadata and links from the National Bureau of
Statistics. The official release directory supplies publication metadata when
the feed is unavailable. Only the title, URL and source timestamp are stored.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timedelta, timezone
import email.utils
import json
from html.parser import HTMLParser
import re
from pathlib import Path
import tempfile
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

UTC = timezone.utc
RSS_URL = "https://www.stats.gov.cn/sj/zxfb/rss.xml"
SOURCE_PAGE = "https://www.stats.gov.cn/sj/zxfb/"
BEIJING = timezone(timedelta(hours=8))
ALLOWED_HOSTS = {"www.stats.gov.cn", "stats.gov.cn"}
MAX_BYTES = 512 * 1024
DC_DATE = "{http://purl.org/dc/elements/1.1/}date"


class SourceError(Exception):
    pass


def iso(value: datetime) -> str:
    return value.astimezone(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")


def parse_date(value: str) -> datetime:
    value = (value or "").strip()
    try:
        parsed = email.utils.parsedate_to_datetime(value)
    except (TypeError, ValueError):
        parsed = None
    if parsed is None:
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError as exc:
            raise SourceError("invalid_publication_time") from exc
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=BEIJING)
    return parsed.astimezone(UTC)


def safe_url(value: str) -> str:
    if not value.strip():
        raise SourceError("invalid_article_link")
    parsed = urllib.parse.urlsplit(urllib.parse.urljoin(SOURCE_PAGE, value.strip()))
    if parsed.scheme == "http":
        parsed = parsed._replace(scheme="https")
    if parsed.scheme != "https" or parsed.hostname not in ALLOWED_HOSTS or parsed.username or parsed.password or parsed.port:
        raise SourceError("invalid_article_link")
    return parsed.geturl()


def fetch(url: str) -> tuple[bytes, dict[str, str]]:
    request = urllib.request.Request(url, headers={"User-Agent": "Books-Market-Overview/1.0 (public RSS metadata)"})
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            if response.status != 200:
                raise SourceError(f"http_{response.status}")
            body = response.read(MAX_BYTES + 1)
            if not body or len(body) > MAX_BYTES:
                raise SourceError("response_too_large")
            return body, {key.lower(): value for key, value in response.headers.items()}
    except urllib.error.HTTPError as exc:
        raise SourceError(f"http_{exc.code}") from exc
    except SourceError:
        raise
    except Exception as exc:
        raise SourceError("network_error") from exc


def parse_feed(body: bytes, now: datetime) -> dict:
    try:
        root = ET.fromstring(body)
    except ET.ParseError as exc:
        raise SourceError("invalid_rss") from exc
    items = root.findall("./channel/item")
    if not items or len(items) > 100:
        raise SourceError("no_rss_items")
    rows = []
    for item in items:
        title = " ".join((item.findtext("title") or "").split())
        link = safe_url(item.findtext("link") or "")
        stamp = item.findtext("pubDate") or item.findtext("date") or item.findtext(DC_DATE) or ""
        if not re.search(r"[0-9]{1,2}:[0-9]{2}", stamp):
            raise SourceError("rss_missing_publication_clock")
        published = parse_date(stamp)
        if published > now:
            raise SourceError("future_publication_time")
        if not title or len(title) > 300:
            raise SourceError("invalid_title")
        rows.append({"title": title, "url": link, "publishedAt": iso(published), "updatedAt": None})
    rows.sort(key=lambda row: row["publishedAt"], reverse=True)
    return {"latest": rows[0], "events": []}


class ReleaseMetadata(HTMLParser):
    """Read public page metadata and links without keeping article text."""

    def __init__(self):
        super().__init__()
        self.article_url = None
        self.meta = {}
        self.visible_time = None
        self.title_parts = []
        self.in_title = False

    def handle_starttag(self, tag, attrs):
        fields = dict(attrs)
        if tag == "title":
            self.in_title = True
        if tag == "meta":
            name = (fields.get("name") or fields.get("property") or "").lower()
            self.meta[name] = fields.get("content") or ""
        if tag == "a" and not self.article_url:
            href = fields.get("href") or ""
            if re.search(r"/?20[0-9]{4}/t[0-9]{8}_[0-9]+\.html$", href):
                try:
                    url = safe_url(href)
                except SourceError:
                    return
                if urllib.parse.urlsplit(url).path.startswith("/sj/zxfb/"):
                    self.article_url = url

    def handle_endtag(self, tag):
        if tag == "title":
            self.in_title = False

    def handle_data(self, text):
        if self.in_title:
            self.title_parts.append(text)
        if not self.visible_time and re.fullmatch(r"\s*20[0-9]{2}[-/][01][0-9][-/][0-3][0-9] [0-2][0-9]:[0-5][0-9](?::[0-5][0-9])?\s*", text):
            self.visible_time = text.strip()


def read_page(url):
    raw, _ = fetch(url)
    html = ReleaseMetadata()
    html.feed(raw.decode("utf-8-sig"))
    html.close()
    return html


def from_directory(now):
    url = read_page(SOURCE_PAGE).article_url
    if not url:
        raise SourceError("no_release_in_directory")
    article = read_page(url)
    page_title = "".join(article.title_parts).rsplit(" - 国家统计局", 1)[0]
    title = (article.meta.get("articletitle") or article.meta.get("og:title") or page_title).strip()
    times = [article.meta.get("pubdate"), article.meta.get("article:published_time"), article.visible_time]
    time = next((value for value in times if value and re.search(r"[T ][0-9]{2}:[0-9]{2}", value)), None)
    if not title or len(title) > 300 or not time:
        raise SourceError("missing_article_metadata")
    published = parse_date(time.replace("/", "-"))
    if published > now:
        raise SourceError("future_publication_time")
    return {"latest": {"title": title, "url": url, "publishedAt": iso(published), "updatedAt": None}, "events": []}


def build_card(now: datetime) -> dict:
    source = RSS_URL
    try:
        body, _ = fetch(source)
        data = parse_feed(body, now)
    except SourceError as exc:
        if str(exc) in ("http_403", "http_429"):
            raise
        source = SOURCE_PAGE
        data = from_directory(now)
    source_updated = data["latest"]["publishedAt"]
    fetched = iso(now)
    return {
        "status": "ready",
        "sourceName": "国家统计局",
        "sourceUrl": source,
        "sourceUpdatedAt": source_updated,
        "fetchedAt": fetched,
        "lastAttemptAt": fetched,
        "asOf": data["latest"]["publishedAt"],
        "errorCode": None,
        "data": data,
    }


def write_atomic(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    raw = (json.dumps(payload, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent, delete=False) as handle:
            temporary = Path(handle.name)
            handle.write(raw)
            handle.flush()
        temporary.replace(path)
        temporary = None
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=Path(__file__).resolve().parents[1] / "macro-cn.json")
    args = parser.parse_args()
    now = datetime.now(UTC)
    card = build_card(now)
    if args.output.exists():
        previous = json.loads(args.output.read_text(encoding="utf-8"))["card"]
        if previous.get("asOf") and parse_date(previous["asOf"]) > parse_date(card["asOf"]):
            raise SourceError("older_than_saved_release")
    name = "国家统计局 RSS" if card["sourceUrl"] == RSS_URL else "国家统计局数据发布"
    write_atomic(args.output, {"schemaVersion": 1, "generatedAt": iso(now), "source": name, "card": card})
    print(json.dumps({"source": card["sourceUrl"], "asOf": card["asOf"], "title": card["data"]["latest"]["title"]}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
