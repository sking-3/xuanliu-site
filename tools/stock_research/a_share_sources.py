"""Local A-share provider adapters for AKShare, adata, and mootdx.

The browser and GitHub Pages never import this module.  It is a Mac/local
collector that turns provider responses into the existing ``books.stock`` and
``books.a14`` input contracts.  Provider data is treated as untrusted input.
Missing permissions, incomplete history, timestamp ambiguity, and API drift
are reported as a blocked/partial batch instead of being guessed.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
import argparse
import importlib
import json
import math
import re
from typing import Any, Iterable
from zoneinfo import ZoneInfo


ZONE = ZoneInfo("Asia/Shanghai")
PROVIDERS = ("akshare", "adata", "mootdx")
SYMBOL_RE = re.compile(r"^(\d{6})(?:\.(SH|SZ|BJ))?$")
DEFAULT_LOOKBACK = 90


class ProviderError(RuntimeError):
    """A safe, short error code suitable for a public result."""

    def __init__(self, code: str, detail: str = "") -> None:
        self.code = code
        super().__init__(detail or code)


@dataclass(frozen=True)
class SourceInfo:
    id: str
    name: str
    package: str
    capabilities: tuple[str, ...]


SOURCE_INFO = {
    "akshare": SourceInfo(
        "akshare", "AKShare", "akshare",
        ("directory", "spot", "daily", "benchmark"),
    ),
    "adata": SourceInfo(
        "adata", "adata", "adata",
        ("directory", "spot", "daily", "minute", "benchmark"),
    ),
    "mootdx": SourceInfo(
        "mootdx", "mootdx", "mootdx",
        ("directory", "spot", "daily", "minute", "benchmark"),
    ),
}


def _now(value: datetime | None = None) -> datetime:
    return (value or datetime.now(timezone.utc)).astimezone(timezone.utc)


def _iso(value: datetime | date | str | None) -> str | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.astimezone(timezone.utc).isoformat()
    if isinstance(value, date):
        return value.isoformat()
    return str(value)


def _finite(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _number(value: Any) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, str):
        value = value.replace(",", "").replace("%", "").strip()
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    return result if math.isfinite(result) else None


def _records(value: Any) -> list[dict[str, Any]]:
    if value is None:
        return []
    if hasattr(value, "to_dict"):
        try:
            value = value.to_dict("records")
        except TypeError:
            value = value.to_dict(orient="records")
    if isinstance(value, dict):
        return [value]
    if not isinstance(value, (list, tuple)):
        raise ProviderError("provider_shape_invalid")
    result = []
    for item in value:
        if hasattr(item, "to_dict"):
            item = item.to_dict()
        if isinstance(item, dict):
            result.append(item)
    return result


def _pick(row: dict[str, Any], *names: str) -> Any:
    for name in names:
        if name in row and row[name] not in (None, "", "-"):
            return row[name]
    folded = {str(key).strip().lower(): value for key, value in row.items()}
    for name in names:
        value = folded.get(name.strip().lower())
        if value not in (None, "", "-"):
            return value
    return None


def _date_value(value: Any) -> str | None:
    if isinstance(value, datetime):
        return value.date().isoformat()
    if isinstance(value, date):
        return value.isoformat()
    if value is None:
        return None
    text = str(value).strip().replace("/", "-")
    if re.fullmatch(r"\d{8}", text):
        text = f"{text[:4]}-{text[4:6]}-{text[6:]}"
    try:
        return date.fromisoformat(text[:10]).isoformat()
    except ValueError:
        return None


def normalize_symbol(value: Any, exchange: str | None = None) -> str:
    text = str(value or "").strip().upper()
    match = SYMBOL_RE.fullmatch(text)
    if not match:
        raise ProviderError("symbol_invalid")
    code, suffix = match.groups()
    suffix = suffix or {"SH": "SH", "SZ": "SZ", "BJ": "BJ"}.get(str(exchange or "").upper())
    if suffix not in {"SH", "SZ", "BJ"}:
        if code.startswith(("6", "68")):
            suffix = "SH"
        elif code.startswith(("0", "2", "3")):
            suffix = "SZ"
        else:
            suffix = "BJ"
    return f"{code}.{suffix}"


def exchange_for(symbol: str) -> str:
    suffix = symbol.rsplit(".", 1)[-1]
    return {"SH": "SSE", "SZ": "SZSE", "BJ": "BSE"}[suffix]


def _mainboard(symbol: str) -> bool:
    code, suffix = symbol.split(".")
    return suffix in {"SH", "SZ"} and (code.startswith(("600", "601", "603", "605"))
                                             or code.startswith(("000", "001", "002", "003")))


def normalize_spot(records: Iterable[dict[str, Any]], provider: str, source_time: datetime) -> list[dict[str, Any]]:
    result = []
    seen: set[str] = set()
    for raw in records:
        raw_code = _pick(raw, "symbol", "代码", "证券代码", "stock_code", "ts_code")
        if raw_code is None:
            continue
        try:
            symbol = normalize_symbol(raw_code, _pick(raw, "exchange", "市场", "交易所"))
        except ProviderError:
            continue
        if symbol in seen:
            raise ProviderError("duplicate_security")
        price = _number(_pick(raw, "price", "最新价", "现价", "最新", "close"))
        turnover = _number(_pick(raw, "turnover", "成交额", "成交金额", "amount"))
        if price is None or price <= 0:
            continue
        seen.add(symbol)
        result.append({
            "market": "a", "symbol": symbol,
            "name": str(_pick(raw, "name", "名称", "证券简称") or symbol)[:80],
            "price": price, "turnover": max(turnover or 0, 0),
            "currency": "CNY", "source": provider,
            "sourceTime": source_time.isoformat(), "receivedAt": source_time.isoformat(),
            "date": source_time.astimezone(ZONE).date().isoformat(),
            "minute": source_time.astimezone(ZONE).strftime("%H:%M"),
            "session": "regular",
        })
    return result


def normalize_bars(records: Iterable[dict[str, Any]], provider: str) -> list[dict[str, Any]]:
    bars: list[dict[str, Any]] = []
    seen: set[str] = set()
    for raw in records:
        day = _date_value(_pick(raw, "date", "日期", "trade_date", "交易日期", "datetime", "time"))
        if not day or day in seen:
            if day in seen:
                raise ProviderError("duplicate_bar")
            continue
        values = {
            "open": _number(_pick(raw, "open", "开盘", "开盘价", "o")),
            "high": _number(_pick(raw, "high", "最高", "最高价", "h")),
            "low": _number(_pick(raw, "low", "最低", "最低价", "l")),
            "close": _number(_pick(raw, "close", "收盘", "收盘价", "c")),
            "volume": _number(_pick(raw, "volume", "成交量", "vol", "v")),
            "turnover": _number(_pick(raw, "turnover", "成交额", "成交金额", "amount")),
        }
        if not all(_finite(v) for v in values.values()) or min(values[k] for k in ("open", "high", "low", "close")) <= 0:
            continue
        if values["turnover"] is None or values["turnover"] < 0:
            continue
        seen.add(day)
        bars.append({"date": day, **values})
    bars.sort(key=lambda item: item["date"])
    return bars


def _import_provider(name: str):
    if name not in PROVIDERS:
        raise ProviderError("provider_unknown")
    try:
        return importlib.import_module(SOURCE_INFO[name].package)
    except ImportError as error:
        raise ProviderError("provider_not_installed", name) from error


def _call(module: Any, path: str, *args: Any, **kwargs: Any) -> Any:
    target = module
    for part in path.split("."):
        target = getattr(target, part, None)
        if target is None:
            raise ProviderError("provider_api_mismatch", path)
    try:
        return target(*args, **kwargs)
    except (PermissionError, TimeoutError) as error:
        raise ProviderError("provider_permission_or_timeout", path) from error
    except Exception as error:  # provider exceptions vary by version
        text = str(error).lower()
        if any(token in text for token in ("403", "429", "forbidden", "rate limit", "permission")):
            raise ProviderError("provider_access_denied", path) from error
        raise ProviderError("provider_request_failed", path) from error


def _try_calls(module: Any, calls: Iterable[tuple[str, tuple[Any, ...], dict[str, Any]]]) -> Any:
    """Try current and alternate provider interfaces, then keep the last safe error."""
    errors: list[ProviderError] = []
    for path, args, kwargs in calls:
        try:
            return _call(module, path, *args, **kwargs)
        except ProviderError as error:
            errors.append(error)
    if errors:
        raise errors[-1]
    raise ProviderError("provider_api_mismatch")


class Provider:
    def __init__(self, name: str):
        self.name = name
        self.info = SOURCE_INFO[name]
        self.module = _import_provider(name)

    def directory(self) -> list[dict[str, Any]]:
        if self.name == "akshare":
            return _records(_try_calls(self.module, (
                ("stock_info_a_code_name", (), {}),
                ("stock_zh_a_spot_em", (), {}),
                ("stock_zh_a_spot_sina", (), {}),
            )))
        if self.name == "adata":
            stock = getattr(self.module, "stock", None)
            return _records(_call(stock, "info.all_code"))
        client = _call(self.module, "quotes.Quotes.factory", market="std", multithread=True, heartbeat=True)
        return _records(_call(client, "stocks", market=0))

    def spot(self) -> list[dict[str, Any]]:
        if self.name == "akshare":
            return _records(_try_calls(self.module, (
                ("stock_zh_a_spot_em", (), {}),
                ("stock_zh_a_spot_sina", (), {}),
            )))
        if self.name == "adata":
            stock = getattr(self.module, "stock", None)
            return _records(_call(stock, "market.list_market_current"))
        client = _call(self.module, "quotes.Quotes.factory", market="std", multithread=True, heartbeat=True)
        return _records(_call(client, "quotes", symbol=["600519", "000001"]))

    def daily(self, code: str, start: str, end: str) -> list[dict[str, Any]]:
        raw_code = code.split(".", 1)[0]
        if self.name == "akshare":
            return _records(_try_calls(self.module, (
                ("stock_zh_a_hist_em", (), {"symbol": raw_code, "period": "daily",
                                             "start_date": start.replace("-", ""),
                                             "end_date": end.replace("-", ""), "adjust": "qfq"}),
                ("stock_zh_a_hist_sina", (), {"symbol": raw_code, "period": "daily",
                                               "start_date": start.replace("-", ""),
                                               "end_date": end.replace("-", ""), "adjust": "qfq"}),
                ("stock_zh_a_hist_tx", (), {"symbol": raw_code, "period": "daily",
                                             "start_date": start.replace("-", ""),
                                             "end_date": end.replace("-", ""), "adjust": "qfq"}),
                ("stock_zh_a_hist", (), {"symbol": raw_code, "period": "daily",
                                          "start_date": start.replace("-", ""),
                                          "end_date": end.replace("-", ""), "adjust": "qfq"}),
            )))
        if self.name == "adata":
            stock = getattr(self.module, "stock", None)
            return _records(_call(stock, "market.get_market", stock_code=raw_code, k_type=1,
                                  start_date=start, end_date=end))
        client = _call(self.module, "quotes.Quotes.factory", market="std", multithread=True, heartbeat=True)
        return _records(_call(client, "bars", symbol=raw_code, frequency=9, offset=1000))

    def benchmark(self, start: str, end: str) -> list[dict[str, Any]]:
        if self.name == "akshare":
            return _records(_try_calls(self.module, (
                ("index_zh_hist_em", (), {"symbol": "000001", "period": "daily",
                                            "start_date": start.replace("-", ""),
                                            "end_date": end.replace("-", "")}),
                ("index_zh_daily_em", (), {"symbol": "sh000001"}),
                ("index_zh_daily_sina", (), {"symbol": "sh000001"}),
                ("index_zh_daily_tx", (), {"symbol": "sh000001",
                                             "start_date": start.replace("-", ""),
                                             "end_date": end.replace("-", "")}),
                ("stock_zh_index_daily_em", (), {"symbol": "sh000001"}),
            )))
        if self.name == "adata":
            stock = getattr(self.module, "stock", None)
            return _records(_call(stock, "market.get_market", stock_code="000001", k_type=1,
                                  start_date=start, end_date=end))
        client = _call(self.module, "quotes.Quotes.factory", market="std", multithread=True, heartbeat=True)
        return _records(_call(client, "index", symbol="000001", frequency=9, offset=1000))

    def minute(self, code: str, day: str) -> list[dict[str, Any]]:
        """Return minute bars when the installed provider exposes them."""
        raw_code = code.split(".", 1)[0]
        if self.name == "akshare":
            return _records(_try_calls(self.module, (
                ("stock_zh_a_hist_min_em", (), {"symbol": raw_code, "period": "1", "adjust": "",
                                                 "start_date": day+" 09:25:00",
                                                 "end_date": day+" 14:00:05"}),
                ("stock_zh_a_hist_min_sina", (), {"symbol": raw_code, "period": "1", "adjust": "",
                                                   "start_date": day+" 09:25:00",
                                                   "end_date": day+" 14:00:05"}),
            )))
        if self.name == "adata":
            stock = getattr(self.module, "stock", None)
            return _records(_call(stock, "market.get_market_min", stock_code=raw_code))
        client = _call(self.module, "quotes.Quotes.factory", market="std", multithread=True, heartbeat=True)
        return _records(_call(client, "minute", symbol=raw_code))


def provider(name: str = "auto") -> Provider:
    candidates = PROVIDERS if name == "auto" else (name,)
    errors = []
    for item in candidates:
        try:
            return Provider(item)
        except ProviderError as error:
            errors.append(error.code)
    raise ProviderError("provider_unavailable", ",".join(errors))


def source_metadata(source: Provider, *, received_at: datetime, data_as_of: str,
                    coverage: str, expected_count: int, pagination_complete: bool,
                    public: bool, redistribution_allowed: bool = False,
                    error_code: str | None = None) -> dict[str, Any]:
    info = getattr(source, "info", source)
    return {
        "id": info.id, "name": info.name,
        "receivedAt": received_at.isoformat(), "dataAsOf": data_as_of,
        "coverage": coverage, "expectedCount": expected_count,
        "paginationComplete": pagination_complete,
        "permissionsVerified": bool(public and redistribution_allowed),
        "redistributionAllowed": bool(redistribution_allowed),
        "accessScope": "public" if public else "owner",
        "feed": "eod", "errorCode": error_code,
    }


def _trading_dates(end: date, count: int) -> list[str]:
    days: list[str] = []
    cursor = end
    while len(days) < count:
        if cursor.weekday() < 5:
            days.append(cursor.isoformat())
        cursor -= timedelta(days=1)
    return list(reversed(days))


def _latest_weekday(day: date) -> date:
    value = day
    while value.weekday() >= 5:
        value -= timedelta(days=1)
    return value


def build_stock_input(source_name: str = "auto", *, as_of: date | None = None,
                      public: bool = False, redistribution_allowed: bool = False,
                      adjustment_attested: bool = False, max_symbols: int | None = None,
                      now: datetime | None = None) -> dict[str, Any]:
    """Collect a daily A-share batch and normalize it to ``books.stock.input.v1``."""
    received = _now(now)
    day = _latest_weekday(as_of or received.astimezone(ZONE).date())
    source = provider(source_name)
    directory = source.directory()
    spot = normalize_spot(source.spot(), source.name, received)
    names: dict[str, str] = {}
    for row in directory:
        try:
            symbol = normalize_symbol(_pick(row, "symbol", "代码", "证券代码", "stock_code", "ts_code"),
                                      _pick(row, "exchange", "市场", "交易所"))
        except ProviderError:
            continue
        names[symbol] = str(_pick(row, "name", "名称", "证券简称") or symbol)[:80]
    available = {row["symbol"]: row for row in spot}
    symbols = sorted(set(names) | set(available))
    if max_symbols is not None:
        symbols = symbols[:max(1, max_symbols)]
    dates = _trading_dates(day, DEFAULT_LOOKBACK)
    securities = []
    for symbol in symbols:
        try:
            bars = normalize_bars(source.daily(symbol, dates[0], dates[-1]), source.name)
        except ProviderError:
            bars = []
        eligibility = {
            "asOf": day.isoformat(), "exchange": exchange_for(symbol), "board": "main",
            "assetType": "ordinary_stock", "scopeVerified": _mainboard(symbol),
            "isST": False, "riskWarning": False, "delisted": False, "suspended": False,
            "normalLimitVerified": False, "limitPct": 10,
            "knownAt": received.isoformat(), "receivedAt": received.isoformat(),
        }
        securities.append({
            "symbol": symbol, "name": names.get(symbol, available.get(symbol, {}).get("name", symbol)),
            "nameVerified": symbol in names, "eligibility": eligibility,
            "adjustmentVerified": bool(adjustment_attested), "bars": bars,
        })
    benchmark = normalize_bars(source.benchmark(dates[0], dates[-1]), source.name)
    market_batch = {
        "market": "a",
        "session": {"date": day.isoformat(), "calendarVerified": False,
                     "closeTime": day.isoformat()+"T15:00:00+08:00", "tradingDates": dates},
        "source": source_metadata(source, received_at=received, data_as_of=day.isoformat(),
                                   coverage="full_universe" if max_symbols is None else "watchlist",
                                   expected_count=len(symbols),
                                   pagination_complete=max_symbols is None and bool(symbols),
                                   public=public, redistribution_allowed=redistribution_allowed),
        "securities": securities,
        "benchmark": benchmark,
    }
    observations = normalize_spot(available.values(), source.name, received)
    return {"schema": "books.stock.input.v1", "audience": "public" if public else "owner",
            "markets": {"a": market_batch}, "observations": observations}


def _minute_snapshot(records: Iterable[dict[str, Any]], cutoff: datetime) -> dict[str, Any] | None:
    """Aggregate verified one-minute bars up to the requested cutoff."""
    bars = []
    for raw in records:
        at = _pick(raw, "datetime", "时间", "time", "timestamp", "日期")
        if isinstance(at, datetime):
            stamp = at
        else:
            try:
                stamp = datetime.fromisoformat(str(at).replace("Z", "+00:00"))
            except (TypeError, ValueError):
                continue
        if stamp.tzinfo is None:
            stamp = stamp.replace(tzinfo=ZONE)
        stamp = stamp.astimezone(timezone.utc)
        if stamp > cutoff:
            continue
        close = _number(_pick(raw, "close", "收盘", "收盘价", "price"))
        high = _number(_pick(raw, "high", "最高", "最高价"))
        low = _number(_pick(raw, "low", "最低", "最低价"))
        open_price = _number(_pick(raw, "open", "开盘", "开盘价"))
        volume = _number(_pick(raw, "volume", "成交量", "vol"))
        turnover = _number(_pick(raw, "turnover", "成交额", "成交金额", "amount"))
        if not all(_finite(v) for v in (close, high, low, open_price, volume, turnover)):
            continue
        bars.append((stamp, open_price, high, low, close, volume, turnover))
    if not bars:
        return None
    bars.sort(key=lambda item: item[0])
    return {
        "last": bars[-1][4], "open": bars[0][1],
        "highSoFar": max(item[2] for item in bars), "lowSoFar": min(item[3] for item in bars),
        "cumulativeVolume": sum(item[5] for item in bars),
        "cumulativeTurnover": sum(item[6] for item in bars),
        "sourceTime": bars[-1][0].isoformat(),
    }


def _next_weekday(day: date) -> date:
    value = day + timedelta(days=1)
    while value.weekday() >= 5:
        value += timedelta(days=1)
    return value


def build_a14_input(source_name: str = "auto", *, cutoff: datetime | None = None,
                    baseline_path: Path | None = None, public: bool = False,
                    redistribution_allowed: bool = False,
                    adjustment_attested: bool = False,
                    calendar_attested: bool = False,
                    max_symbols: int | None = None,
                    now: datetime | None = None) -> dict[str, Any]:
    """Collect a 14:00 batch. Missing minute or calendar evidence stays blocked."""
    received = _now(now)
    cutoff = cutoff or received.astimezone(ZONE).replace(hour=14, minute=0, second=0, microsecond=0)
    if cutoff.tzinfo is None:
        cutoff = cutoff.replace(tzinfo=ZONE)
    cutoff = cutoff.astimezone(timezone.utc)
    day = cutoff.astimezone(ZONE).date()
    source = provider(source_name)
    directory = source.directory()
    names: dict[str, str] = {}
    for raw in directory:
        try:
            symbol = normalize_symbol(_pick(raw, "symbol", "代码", "证券代码", "stock_code", "ts_code"),
                                      _pick(raw, "exchange", "市场", "交易所"))
        except ProviderError:
            continue
        names[symbol] = str(_pick(raw, "name", "名称", "证券简称") or symbol)[:80]
    symbols = sorted(names)
    if max_symbols is not None:
        symbols = symbols[:max(1, max_symbols)]
    history_dates = _trading_dates(day - timedelta(days=1), 61)
    baseline: dict[str, list[dict[str, Any]]] = {}
    if baseline_path and baseline_path.exists():
        try:
            previous = json.loads(baseline_path.read_text(encoding="utf-8"))
            baseline = previous.get("symbols", {}) if previous.get("schema") == "books.a14.baseline.v1" else {}
        except (OSError, ValueError, TypeError):
            baseline = {}
    securities = []
    observations = []
    for symbol in symbols:
        try:
            bars = normalize_bars(source.daily(symbol, history_dates[0], history_dates[-1]), source.name)
        except ProviderError:
            bars = []
        try:
            snapshot = _minute_snapshot(source.minute(symbol, day.isoformat()), cutoff)
        except ProviderError:
            snapshot = None
        if snapshot:
            snapshot.update({"priceBasis": "provider-minute-quote", "priceAnchorDate": day.isoformat(),
                             "adjustmentVerified": bool(adjustment_attested),
                             "receivedAt": received.isoformat()})
            observations.append({"market": "a", "symbol": symbol, "name": names[symbol],
                                 "sourceTime": snapshot["sourceTime"], "receivedAt": received.isoformat(),
                                 "price": snapshot["last"], "turnover": snapshot["cumulativeTurnover"],
                                 "priceChange1m": 0, "currency": "CNY", "source": source.name,
                                 "date": day.isoformat(), "minute": cutoff.astimezone(ZONE).strftime("%H:%M"),
                                 "session": "regular", "baseline": baseline.get(symbol, [])})
        eligibility = {"asOf": day.isoformat(), "exchange": exchange_for(symbol), "board": "main",
                       "assetType": "ordinary_stock", "scopeVerified": _mainboard(symbol),
                       "isST": False, "riskWarning": False, "delisted": False, "suspended": False,
                       "normalLimitVerified": False, "limitPct": 10,
                       "knownAt": received.isoformat(), "receivedAt": received.isoformat()}
        securities.append({"symbol": symbol, "name": names[symbol], "nameVerified": True,
                           "eligibility": eligibility, "historyComplete": len(bars) >= 61,
                           "adjustmentVerified": bool(adjustment_attested),
                           "priceBasis": "provider-daily-qfq", "priceAnchorDate": day.isoformat(),
                           "adjustmentKnownAt": received.isoformat(), "history": bars,
                           "snapshot": snapshot or {"adjustmentVerified": False},
                           "sameCutoffTurnover": baseline.get(symbol, [])})
    benchmark_history = normalize_bars(source.benchmark(history_dates[0], history_dates[-1]), source.name)
    benchmark_snapshot = None
    try:
        benchmark_snapshot = _minute_snapshot(source.minute("000001.SH", day.isoformat()), cutoff)
    except ProviderError:
        benchmark_snapshot = None
    if benchmark_snapshot:
        benchmark_snapshot.update({"priceBasis": "provider-minute-quote", "priceAnchorDate": day.isoformat(),
                                    "adjustmentVerified": bool(adjustment_attested), "receivedAt": received.isoformat()})
    source_meta = source_metadata(source, received_at=received, data_as_of=day.isoformat(),
                                  coverage="full_universe" if max_symbols is None else "watchlist",
                                  expected_count=len(symbols), pagination_complete=max_symbols is None and bool(symbols),
                                  public=public, redistribution_allowed=redistribution_allowed)
    return {"schema": "books.a14.input.v1", "market": "a", "strategyVersion": "research_v0",
            "audience": "public" if public else "owner",
            "units": {"price": "CNY", "volume": "shares", "turnover": "CNY"},
            "session": {"date": day.isoformat(), "cutoff": cutoff.astimezone(ZONE).isoformat(),
                        "calendarVerified": bool(calendar_attested), "isOpen": True,
                        "previousSessionDate": history_dates[-1], "historyTradingDates": history_dates,
                        "nextSession": {"date": _next_weekday(day).isoformat(),
                                         "openTime": _next_weekday(day).isoformat()+"T09:30:00+08:00",
                                         "closeTime": _next_weekday(day).isoformat()+"T15:00:00+08:00",
                                         "calendarVerified": bool(calendar_attested)}},
            "source": {**source_meta, "sourceTime": cutoff.isoformat()},
            "universe": {"scope": "all_listed_a_shares", "asOf": day.isoformat(), "complete": max_symbols is None,
                         "knownAt": received.isoformat(), "receivedAt": received.isoformat(),
                         "symbols": symbols},
            "benchmark": {"symbol": "SSE:000001", "historyComplete": len(benchmark_history) >= 61,
                           "adjustmentVerified": bool(adjustment_attested), "priceAnchorDate": day.isoformat(),
                           "adjustmentKnownAt": received.isoformat(), "priceBasis": "provider-daily-qfq",
                           "history": benchmark_history, "snapshot": benchmark_snapshot or {"adjustmentVerified": False}},
            "securities": securities,
            "sectors": {"asOf": day.isoformat(), "membershipComplete": False,
                        "quoteCoverageComplete": False, "scope": "qualified_mainboard",
                        "knownAt": received.isoformat(), "receivedAt": received.isoformat(), "members": {}},
            "observations": observations}


def update_baseline(path: Path, batch: dict[str, Any]) -> None:
    """Persist only real same-cutoff turnover values for future runs."""
    value = {"schema": "books.a14.baseline.v1", "updatedAt": _now().isoformat(), "symbols": {}}
    if path.exists():
        try:
            old = json.loads(path.read_text(encoding="utf-8"))
            if old.get("schema") == value["schema"] and isinstance(old.get("symbols"), dict):
                value["symbols"] = old["symbols"]
        except (OSError, ValueError, TypeError):
            pass
    day = batch.get("session", {}).get("date")
    cutoff = batch.get("session", {}).get("cutoff", "")
    cutoff_time = cutoff[11:19] if len(cutoff) >= 19 else "14:00:00"
    for observation in batch.get("observations", []):
        symbol = observation.get("symbol")
        turnover = observation.get("turnover")
        if not isinstance(symbol, str) or not _finite(turnover) or turnover <= 0:
            continue
        entries = [x for x in value["symbols"].get(symbol, []) if x.get("date") != day]
        entries.append({"date": day, "cutoffTime": cutoff_time, "complete": True, "turnover": turnover})
        value["symbols"][symbol] = sorted(entries, key=lambda x: x.get("date", ""))[-20:]
    _write_json(path, value)


def _write_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, allow_nan=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--provider", choices=("auto",) + PROVIDERS, default="auto")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--as-of", help="Asia/Shanghai trading date YYYY-MM-DD")
    parser.add_argument("--max-symbols", type=int)
    parser.add_argument("--public", action="store_true", help="mark audience public")
    parser.add_argument("--redistribution-allowed", action="store_true",
                        help="explicitly attest that this provider data may be published")
    parser.add_argument("--adjustment-attested", action="store_true",
                        help="attest that all daily bars use a verified current-price basis")
    args = parser.parse_args(argv)
    if args.public and not args.redistribution_allowed:
        parser.error("--public requires --redistribution-allowed")
    try:
        day = date.fromisoformat(args.as_of) if args.as_of else None
        result = build_stock_input(args.provider, as_of=day, public=args.public,
                                   redistribution_allowed=args.redistribution_allowed,
                                   adjustment_attested=args.adjustment_attested,
                                   max_symbols=args.max_symbols)
        _write_json(args.output, result)
    except (ProviderError, OSError, ValueError, TypeError) as error:
        safe = error.code if isinstance(error, ProviderError) else type(error).__name__
        parser.exit(2, f"A-share collection failed: {safe}\n")
    print(json.dumps({"schema": result["schema"], "provider": result["markets"]["a"]["source"]["id"],
                      "symbols": len(result["markets"]["a"]["securities"]),
                      "observations": len(result["observations"]), "audience": result["audience"]},
                     ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
