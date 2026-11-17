"""Collect a supplied stock sample; never publish it or infer real-time freshness."""
from __future__ import annotations

import argparse
from datetime import date, datetime, timezone
import ipaddress
import json
import math
import os
from pathlib import Path
import re
import tempfile
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[2]
SHANGHAI = ZoneInfo("Asia/Shanghai")
MAX_SYMBOLS = 50


class FeedError(ValueError):
    """An error code safe to show without provider payloads."""


def symbols(values):
    if not isinstance(values, (list, tuple)) or not 1 <= len(values) <= MAX_SYMBOLS:
        raise FeedError("invalid_symbol_count")
    result = []
    for value in values:
        match = re.fullmatch(r"(\d{6})(?:\.(SH|SZ))?", str(value).strip().upper())
        if not match:
            raise FeedError("invalid_stock_symbol")
        code, suffix = match.groups()
        if code.startswith(("600", "601", "603", "605", "688")):
            exchange = "SH"
        elif code.startswith(("000", "001", "002", "003", "300", "301")):
            exchange = "SZ"
        else:
            raise FeedError("unsupported_stock_symbol")
        if suffix and suffix != exchange:
            raise FeedError("exchange_mismatch")
        canonical = code + "." + exchange
        if canonical in result:
            raise FeedError("duplicate_symbol")
        result.append(canonical)
    return result


def number(value, *, positive=False):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise FeedError("invalid_number")
    if not math.isfinite(value) or value < 0 or (positive and value == 0):
        raise FeedError("invalid_number")
    return value


def records(value):
    if hasattr(value, "to_dict"):
        value = value.to_dict("records")
    if not isinstance(value, list) or not value or any(not isinstance(v, dict) for v in value):
        raise FeedError("empty_or_invalid_response")
    return value


def trade_date(value):
    if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        raise FeedError("invalid_trade_date")
    try:
        return date.fromisoformat(value)
    except ValueError:
        raise FeedError("invalid_trade_date") from None


def server_address(value):
    try:
        host, port = value.rsplit(":", 1)
        ipaddress.ip_address(host)
        port = int(port)
        if not 1 <= port <= 65535:
            raise ValueError()
        return host, port
    except (ValueError, AttributeError):
        raise FeedError("invalid_server_address") from None


def default_factory(**kwargs):
    # Importing is separate from connecting, so CI can check installation offline.
    from mootdx.quotes import Quotes
    return Quotes.factory(**kwargs)


def error_code(error):
    if isinstance(error, FeedError):
        return str(error)
    if isinstance(error, PermissionError) or any(
        word in str(error).lower() for word in ("403", "429", "forbidden", "rate limit")
    ):
        return "provider_access_denied"
    if isinstance(error, TimeoutError):
        return "provider_timeout"
    return "provider_request_failed"


def normalize_quotes(raw, requested):
    expected = {s[:6]: s for s in requested}
    found = {}
    for row in records(raw):
        code = row.get("code")
        if code not in expected or code in found:
            raise FeedError("unexpected_or_duplicate_quote")
        symbol = expected[code]
        market = row.get("market")
        if type(market) is not int or market != (1 if symbol.endswith(".SH") else 0):
            raise FeedError("quote_exchange_mismatch")
        price = number(row.get("price"), positive=True)
        clock = row.get("servertime")
        # A time-of-day alone does not prove the trading date.
        if not isinstance(clock, str) or not re.fullmatch(r"(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?", clock):
            clock = None
        found[code] = {
            "symbol": symbol, "tvSymbol": ("SSE:" if market == 1 else "SZSE:") + code,
            "price": price, "amountRaw": number(row.get("amount")),
            "volumeRaw": number(row.get("vol")), "sourceClock": clock, "sourceAsOf": None,
        }
    if set(found) != set(expected):
        raise FeedError("incomplete_quotes")
    return [found[s[:6]] for s in requested]


def normalize_daily(raw, symbol, now):
    result, seen = [], set()
    today = now.astimezone(SHANGHAI).date()
    for row in records(raw):
        stamp = row.get("datetime")
        if not isinstance(stamp, str) or not re.fullmatch(
            r"\d{4}-\d{2}-\d{2}(?:[ T](?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?)?", stamp
        ):
            raise FeedError("invalid_bar_date")
        day = trade_date(stamp[:10])
        if day > today or day in seen:
            raise FeedError("future_or_duplicate_bar")
        seen.add(day)
        prices = {k: number(row.get(k), positive=True) for k in ("open", "high", "low", "close")}
        if prices["low"] > min(prices.values()) or prices["high"] < max(prices.values()):
            raise FeedError("invalid_ohlc")
        result.append({
            "symbol": symbol, "date": day.isoformat(), **prices,
            "amountRaw": number(row.get("amount")), "volumeRaw": number(row.get("vol")),
            "isCurrentDate": day == today, "sessionComplete": None,
        })
    return sorted(result, key=lambda row: row["date"])


def normalize_transactions(raw, symbol, requested_date):
    result = []
    for row in records(raw):
        clock = row.get("time")
        if not isinstance(clock, str) or not re.fullmatch(
            r"(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?", clock
        ):
            raise FeedError("invalid_transaction_time")
        result.append({
            "symbol": symbol, "requestedDate": requested_date, "sourceClock": clock,
            "price": number(row.get("price"), positive=True),
            "volumeRaw": number(row.get("vol")),
            "sourceDateVerified": False,
        })
    return result


def collect(mode, requested, *, rows=60, historical_date=None, timeout=10,
            server=None, factory=default_factory, now=None):
    requested = symbols(requested)
    if mode not in ("quotes", "daily", "transactions"):
        raise FeedError("invalid_mode")
    if type(rows) is not int or not 1 <= rows <= 800:
        raise FeedError("invalid_row_limit")
    if type(timeout) not in (int, float) or not math.isfinite(timeout) or not 1 <= timeout <= 30:
        raise FeedError("invalid_timeout")
    now = now or datetime.now(timezone.utc)
    if now.tzinfo is None or now.utcoffset() is None:
        raise FeedError("timezone_required")
    if mode == "transactions":
        day = trade_date(historical_date)
        if day > now.astimezone(SHANGHAI).date():
            raise FeedError("future_trade_date")
    elif historical_date is not None:
        raise FeedError("date_only_for_transactions")
    options = dict(market="std", bestip=False, heartbeat=False,
                   auto_retry=False, raise_exception=True, timeout=timeout)
    if server is not None:
        options["server"] = server_address(server)
    client = None
    try:
        client = factory(**options)
        if mode == "quotes":
            data = normalize_quotes(client.quotes(symbol=[s[:6] for s in requested]), requested)
        else:
            data = []
            for symbol in requested:
                if mode == "daily":
                    raw = client.bars(symbol=symbol[:6], frequency=9, start=0, offset=rows)
                    batch = normalize_daily(raw, symbol, now)
                else:
                    raw = client.transactions(symbol=symbol[:6], start=0, offset=rows,
                                              date=historical_date.replace("-", ""))
                    batch = normalize_transactions(raw, symbol, historical_date)
                if len(batch) > rows:
                    raise FeedError("response_exceeds_row_limit")
                data.extend(batch)
        return {
            "schema": "books.mootdx.sample.v1", "provider": "mootdx", "mode": mode,
            "status": "collected_unverified", "scope": "supplied_stock_sample",
            "requestedCount": len(requested), "fetchedAt": datetime.now(timezone.utc).isoformat(),
            "sourceAsOf": None, "redistributionAllowed": False,
            "units": {"price": "CNY", "amountRaw": "provider_native_unverified",
                      "volumeRaw": "provider_native_unverified"},
            "calendarVerified": False, "adjustment": "provider_default_unadjusted",
            "rows": data,
        }
    except Exception as error:
        raise FeedError(error_code(error)) from None
    finally:
        if client is not None:
            try:
                client.close()
            except Exception:
                pass


def output_path(value):
    path = Path(value).expanduser()
    if path.is_symlink():
        raise FeedError("output_symlink_rejected")
    path = path.resolve()
    if path == ROOT or ROOT in path.parents:
        raise FeedError("output_must_be_outside_repository")
    return path


def write_private(path, value):
    path = output_path(path)
    payload = json.dumps(value, ensure_ascii=False, allow_nan=False, indent=2) + "\n"
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=".mootdx-", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            stream.write(payload)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mode", choices=("quotes", "daily", "transactions"), default="daily")
    parser.add_argument("--symbols", required=True, help="Comma-separated A-share stock codes, at most 50")
    parser.add_argument("--rows", type=int, default=60, help="Most recent rows per stock, 1..800")
    parser.add_argument("--date", help="Historical transaction date, YYYY-MM-DD")
    parser.add_argument("--timeout", type=float, default=10)
    parser.add_argument("--server", help="Optional explicit IPv4:port or IPv6:port; no server scanning")
    parser.add_argument("--output", required=True, help="Owner-only JSON file outside the repository")
    args = parser.parse_args(argv)
    try:
        destination = output_path(args.output)  # Reject public checkout paths before connecting.
        batch = collect(args.mode, args.symbols.split(","), rows=args.rows,
                        historical_date=args.date, timeout=args.timeout, server=args.server)
        write_private(destination, batch)
    except (FeedError, OSError) as error:
        print(json.dumps({"status": "failed", "error": error_code(error)}))
        return 2
    print(json.dumps({"status": batch["status"], "symbols": batch["requestedCount"],
                      "rows": len(batch["rows"]), "published": False}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
