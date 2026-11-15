#!/usr/bin/env python3
"""Collect a small, read-only Chinese macro release snapshot.

The collector keeps only RSS metadata and links from the National Bureau of
Statistics. It does not copy article bodies, call a proxy, or publish a
market interpretation. The workflow that invokes it is manual-only until a
separate schedule approval is given.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import email.utils
import json
from pathlib import Path
import tempfile
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

UTC = timezone.utc
RSS_URL = "https://www.stats.gov.cn/sj/zxfb/rss.xml"
SOURCE_PAGE = "https://www.stats.gov.cn/wzgl/rss/"
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
        parsed = parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


def safe_url(value: str) -> str:
    parsed = urllib.parse.urlsplit(value.strip())
    if parsed.scheme != "https" or parsed.hostname not in ALLOWED_HOSTS or parsed.username or parsed.password or parsed.port:
        raise SourceError("invalid_article_link")
    return value.strip()


def fetch() -> tuple[bytes, dict[str, str]]:
    request = urllib.request.Request(RSS_URL, headers={"User-Agent": "Books-Market-Overview/1.0 (public RSS metadata)"})
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
        published = parse_date(item.findtext("pubDate") or item.findtext("date") or item.findtext(DC_DATE) or "")
        if published > now:
            raise SourceError("future_publication_time")
        if not title or len(title) > 300:
            raise SourceError("invalid_title")
        rows.append({"title": title, "url": link, "publishedAt": iso(published), "updatedAt": None})
    rows.sort(key=lambda row: (row["publishedAt"], row["url"]), reverse=True)
    return {"latest": rows[0], "events": []}


def build_card(now: datetime) -> dict:
    body, headers = fetch()
    data = parse_feed(body, now)
    modified = headers.get("last-modified")
    source_updated = None
    if modified:
        try:
            source_updated = iso(parse_date(modified))
        except SourceError:
            source_updated = None
    source_updated = source_updated or data["latest"]["publishedAt"]
    fetched = iso(now)
    return {
        "status": "ready",
        "sourceName": "国家统计局",
        "sourceUrl": RSS_URL,
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
    write_atomic(args.output, {"schemaVersion": 1, "generatedAt": iso(now), "source": "国家统计局 RSS", "card": card})
    print(json.dumps({"source": RSS_URL, "asOf": card["asOf"], "title": card["data"]["latest"]["title"]}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
