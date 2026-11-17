"""Collect a supplied stock sample; never publish it or infer real-time freshness."""
from __future__ import annotations

import argparse
from contextlib import contextmanager
from datetime import date, datetime, timezone
import ipaddress
import json
import math
import os
from pathlib import Path
import re
import stat
import uuid
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[2]
SHANGHAI = ZoneInfo("Asia/Shanghai")
MAX_SYMBOLS = 50
SOURCE_OPERATION = "aShareTdxCollector"
STATE_DIR = Path.home() / '.local/state/books/mootdx-feed'
DATA_DIR = Path.home() / '.local/share/books/mootdx-feed'


class FeedError(ValueError):
    """An error code safe to show without provider payloads."""


def require_source_access():
    """Consult shared holds, then fail closed until legacy TDX stops are reconciled.

    The private mootdx-feed lease is only an additional local lock. It is not
    source authorization and cannot override another collector's stop record.
    No runtime flag, empty directory, mock factory or approval string can lift
    the unfinished legacy migration. See SOURCE_ACCESS.md.
    """
    from tools.binance_watch import source_holds

    if source_holds.reason(SOURCE_OPERATION) is not None:
        raise FeedError("source_permission_unverified")
    # The latest legacy A-share guard and its deployed state paths/schema are
    # not available in this branch. Do not guess paths, synthesize a clean
    # record, or treat an approved key as proof of a completed migration.
    raise FeedError("legacy_source_stops_unverified")


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
        ipaddress.IPv4Address(host)
        port = int(port)
        if not 1 <= port <= 65535:
            raise ValueError()
        return host, port
    except (ValueError, AttributeError):
        raise FeedError("invalid_server_address") from None


def default_factory(**options):
    """Use mootdx parsing methods without its configuration/bootstrap constructor."""
    require_source_access()
    from mootdx.quotes import StdQuotes, TdxHq_API

    if set(options) != {"market", "server", "timeout", "bestip", "heartbeat",
                        "auto_retry", "raise_exception"} or (
        options["market"] != "std" or options["bestip"] is not False or
        options["heartbeat"] is not False or options["auto_retry"] is not False or
        options["raise_exception"] is not True
    ):
        raise FeedError("unsafe_provider_options")

    class FixedServerQuotes(StdQuotes):
        def __init__(self):
            # Do not invoke StdQuotes/BaseQuotes: config.setup() can scan on
            # missing/corrupt config even when bestip=False and server is explicit.
            self.server = options["server"]
            self.client = TdxHq_API(heartbeat=False, auto_retry=False, raise_exception=True)
            try:
                connected = self.client.connect(*self.server, time_out=options["timeout"])
                if not connected:
                    raise FeedError("provider_connection_failed")
            except BaseException:
                self.close()
                raise

        def close(self):
            client, self.client = self.client, None
            if client is not None:
                client.close()

        def reconnect(self):
            raise FeedError("automatic_reconnect_disabled")

    return FixedServerQuotes()


@contextmanager
def private_directory(path):
    """Open an owner-only directory without traversing symlinks (POSIX)."""
    if os.name != "posix":
        raise FeedError("posix_required")
    path = Path(path).absolute()
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    descriptor = os.open("/", flags)
    try:
        for part in path.parts[1:]:
            try:
                os.mkdir(part, 0o700, dir_fd=descriptor)
            except FileExistsError:
                pass
            child = os.open(part, flags, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = child
        info = os.fstat(descriptor)
        if info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise FeedError("private_directory_required")
        yield descriptor
    finally:
        os.close(descriptor)


def write_record(descriptor, value):
    payload = (json.dumps(value, allow_nan=False) + "\n").encode("utf-8")
    os.lseek(descriptor, 0, os.SEEK_SET)
    position = 0
    while position < len(payload):
        written = os.write(descriptor, payload[position:])
        if written <= 0:
            raise OSError("short write")
        position += written
    os.ftruncate(descriptor, len(payload))
    os.fsync(descriptor)


@contextmanager
def source_guard():
    """One source-wide lease; any failed/interrupted request leaves a stop record."""
    with private_directory(STATE_DIR) as directory:
        try:
            descriptor = os.open("source-state.json",
                                 os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                                 0o600, dir_fd=directory)
        except FileExistsError:
            # Includes stopped, in-progress, malformed, symlink and hardlink records.
            # No reset/force option and no host-, output- or mode-specific bypass.
            raise FeedError("source_stopped_or_busy") from None
        try:
            write_record(descriptor, {"schema": "books.mootdx.guard.v1",
                                     "source": "mootdx", "state": "in_progress",
                                     "at": datetime.now(timezone.utc).isoformat()})
            os.fsync(directory)
            try:
                yield
            except BaseException as error:
                write_record(descriptor, {"schema": "books.mootdx.guard.v1",
                                         "source": "mootdx", "state": "stopped",
                                         "reason": error_code(error),
                                         "at": datetime.now(timezone.utc).isoformat()})
                os.fsync(directory)
                raise
            else:
                held = os.fstat(descriptor)
                named = os.stat("source-state.json", dir_fd=directory, follow_symlinks=False)
                if not stat.S_ISREG(named.st_mode) or named.st_nlink != 1 or (
                    held.st_dev, held.st_ino
                ) != (named.st_dev, named.st_ino):
                    raise FeedError("guard_record_replaced")
                os.unlink("source-state.json", dir_fd=directory)
                os.fsync(directory)
        finally:
            os.close(descriptor)


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
            server=None, factory=default_factory, now=None, network_enabled=False):
    if network_enabled is not True:
        raise FeedError("network_disabled")
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
    if server is None:
        raise FeedError("explicit_server_required")
    options["server"] = server_address(server)
    require_source_access()
    with source_guard():
        return _collect_guarded(mode, requested, rows, historical_date, options, factory, now)


def _collect_guarded(mode, requested, rows, historical_date, options, factory, now):
    require_source_access()
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
    path = Path(value)
    if not path.is_absolute():
        if len(path.parts) != 1:
            raise FeedError("invalid_output_name")
        path = DATA_DIR / path
    if path.parent != DATA_DIR or not re.fullmatch(
        r"(?:daily|quotes|transactions)(?:-[A-Za-z0-9_-]{1,80})?\.json", path.name
    ):
        raise FeedError("output_must_be_in_private_data_directory")
    with private_directory(DATA_DIR) as directory:
        try:
            os.stat(path.name, dir_fd=directory, follow_symlinks=False)
        except FileNotFoundError:
            return path
        raise FeedError("output_already_exists")


def write_private(path, value):
    path = output_path(path)
    if value.get("schema") != "books.mootdx.sample.v1" or value.get("provider") != "mootdx":
        raise FeedError("invalid_output_schema")
    payload = json.dumps(value, ensure_ascii=False, allow_nan=False, indent=2) + "\n"
    with private_directory(DATA_DIR) as directory:
        temporary = ".pending-" + uuid.uuid4().hex
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                             0o600, dir_fd=directory)
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
                stream.write(payload)
                stream.flush()
                os.fsync(stream.fileno())
            # link() publishes a complete file atomically and refuses ALL existing
            # targets, including valid old snapshots, unrelated files and links.
            os.link(temporary, path.name, src_dir_fd=directory, dst_dir_fd=directory,
                    follow_symlinks=False)
            os.fsync(directory)
        finally:
            os.unlink(temporary, dir_fd=directory)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mode", choices=("quotes", "daily", "transactions"), default="daily")
    parser.add_argument("--symbols", required=True, help="Comma-separated A-share stock codes, at most 50")
    parser.add_argument("--rows", type=int, default=60, help="Most recent rows per stock, 1..800")
    parser.add_argument("--date", help="Historical transaction date, YYYY-MM-DD")
    parser.add_argument("--timeout", type=float, default=10)
    parser.add_argument("--server", help="Explicit authorized IPv4:port; required when enabling network")
    parser.add_argument("--enable-network", action="store_true", help="Request network use; remains blocked pending source authorization and legacy-stop integration")
    parser.add_argument("--output", help="New snapshot basename within the dedicated private data directory")
    args = parser.parse_args(argv)
    try:
        if not args.enable_network:
            raise FeedError("network_disabled")
        require_source_access()
        name = args.output or args.mode + "-" + uuid.uuid4().hex + ".json"
        destination = output_path(name)
        batch = collect(args.mode, args.symbols.split(","), rows=args.rows,
                        historical_date=args.date, timeout=args.timeout, server=args.server,
                        network_enabled=args.enable_network)
        write_private(destination, batch)
    except (FeedError, OSError) as error:
        print(json.dumps({"status": "failed", "error": error_code(error)}))
        return 2
    print(json.dumps({"status": batch["status"], "symbols": batch["requestedCount"],
                      "rows": len(batch["rows"]), "published": False}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
