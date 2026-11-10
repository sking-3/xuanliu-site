#!/usr/bin/env python3
"""Read-only public position observations; never execution or freshness guarantees."""
import argparse
import source_holds
from contextlib import closing
import datetime as dt
from decimal import Decimal
import fcntl
import hashlib
import json
import math
from pathlib import Path
import re
import signal
import sqlite3
import time
import urllib.error
import urllib.request

PORTFOLIO_ID = "5075281354358777856"
BASE = "https://www.binance.com/bapi/futures/v1/friendly/future/copy-trade/"
ROOT = Path(__file__).resolve().parents[2]
GUARD_IDS = {"5156287639231681792", "5139646755272846081", "5178595252342363392"}
MAX_BYTES = 2 * 1024 * 1024
MAX_EVENTS = 10000


class Stop(Exception):
    """Requires source/operator review; persisted, never automatically reset."""


class Temporary(Exception):
    """Network/5xx failure; retry after backoff and re-establish baseline."""


def iso(epoch):
    return dt.datetime.fromtimestamp(epoch, dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def timestamp(value):
    try:
        parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            raise ValueError()
        return parsed.timestamp()
    except (AttributeError, TypeError, ValueError, OverflowError) as exc:
        raise Stop("invalid_state_timestamp") from exc


def emit(kind, **fields):
    print(json.dumps({"kind": kind, **fields}, ensure_ascii=False, allow_nan=False), flush=True)


def load_json(raw):
    def reject_constant(_):
        raise ValueError()
    try:
        return json.loads(raw, parse_constant=reject_constant)
    except (ValueError, UnicodeError, RecursionError) as exc:
        raise Stop("invalid_json") from exc


def guard_file(path):
    try:
        with Path(path).open("rb") as source:
            raw = source.read(8 * MAX_BYTES + 1)
        if len(raw) > 8 * MAX_BYTES:
            raise Stop("repository_guard_too_large")
        return load_json(raw)
    except OSError as exc:
        raise Stop("repository_guard_missing") from exc


def check_repository(collection_path):
    """Read both existing source-stop stores, never replace or clear either."""
    collection = guard_file(collection_path)
    legacy = guard_file(Path(collection_path).with_name("snapshot.json"))
    if not isinstance(collection, dict) or type(collection.get("schemaVersion")) is not int or collection["schemaVersion"] != 1:
        raise Stop("invalid_repository_guard")
    rows = collection.get("portfolios")
    if not isinstance(rows, list) or len(rows) != 3 or {r.get("portfolioId") for r in rows if isinstance(r, dict)} != GUARD_IDS:
        raise Stop("invalid_repository_guard")
    if not isinstance(legacy, dict) or type(legacy.get("schemaVersion")) is not int or legacy["schemaVersion"] != 1 or legacy.get("portfolioId") != "5156287639231681792":
        raise Stop("invalid_repository_guard")
    for record in [collection, *rows, legacy]:
        source = record.get("source")
        if not isinstance(source, dict) or type(source.get("refreshStopped")) is not bool or "errorCode" not in source:
            raise Stop("invalid_repository_guard")
        code = source.get("errorCode")
        if code is not None and (not isinstance(code, str) or not re.fullmatch(r"[a-zA-Z0-9_]{1,80}", code)):
            raise Stop("invalid_repository_guard")
        if re.fullmatch(r"http_(202|401|403|418|429|451)", code or "") or (code or "").startswith("source_error_"):
            raise Stop("repository_source_stopped")
        if record is collection and (source["refreshStopped"] or code is not None):
            raise Stop("repository_source_stopped")
        if record is not collection:
            if type(record.get("schemaVersion")) is not int or record["schemaVersion"] != 1:
                raise Stop("invalid_repository_guard")
            profile = record.get("profile")
            if not isinstance(profile, dict) or profile.get("id") != record["portfolioId"] or profile.get("visibility") not in ("public", "restricted", "unknown"):
                raise Stop("invalid_repository_guard")
            if source.get("status") not in ("ready", "stale", "unavailable", "restricted"):
                raise Stop("invalid_repository_guard")
            # Privacy/inactivity belongs to each of these other account IDs.
            # Preserve its stop without expanding it into a source-wide refusal.
            private_stop = (code == "restricted" and source["refreshStopped"]
                            and profile["visibility"] == "restricted" and source["status"] == "restricted")
            inactive_stop = (code == "inactive" and source["refreshStopped"] and profile["visibility"] == "public"
                             and isinstance(profile.get("status"), str) and bool(profile["status"])
                             and profile["status"] != "ACTIVE" and source["status"] in ("stale", "unavailable"))
            if source["refreshStopped"] and not (private_stop or inactive_stop):
                raise Stop("repository_source_stopped")
            if (profile["visibility"] == "restricted" or source["status"] == "restricted" or code == "restricted") and not private_stop:
                raise Stop("invalid_repository_guard")
            if code == "inactive" and not inactive_stop:
                raise Stop("invalid_repository_guard")
            if code is not None and not (private_stop or inactive_stop) and not re.fullmatch(r"http_(408|5\d\d)|network_error|timeout", code):
                raise Stop("invalid_repository_guard")


def numeric(value):
    if not isinstance(value, str) or len(value) > 100 or not re.fullmatch(r"[+-]?\d+(?:\.\d+)?", value):
        raise Stop("schema_changed")
    number = Decimal(value)
    if number.copy_abs() >= Decimal("1e30"):
        raise Stop("schema_changed")
    return number


def canonical(number):
    text = format(number, "f")
    return text.rstrip("0").rstrip(".") if "." in text else text


def normalize_positions(data):
    if not isinstance(data, list) or len(data) > 10000:
        raise Stop("schema_changed")
    rows = {}
    for row in data:
        if not isinstance(row, dict):
            raise Stop("schema_changed")
        amount = numeric(row.get("positionAmount"))
        if amount == 0:
            continue
        symbol, source_side, collateral = row.get("symbol"), row.get("positionSide"), row.get("collateral")
        if not isinstance(symbol, str) or not re.fullmatch(r"[A-Z0-9_]{1,50}", symbol) or source_side not in ("LONG", "SHORT", "BOTH"):
            raise Stop("schema_changed")
        if not isinstance(collateral, str) or not re.fullmatch(r"[A-Z0-9_]{1,30}", collateral):
            raise Stop("schema_changed")
        side = ("SHORT" if amount < 0 else "LONG") if source_side == "BOTH" else source_side
        key = f"{symbol}:{side}:{collateral}"
        if key in rows:
            raise Stop("duplicate_position")
        leverage = row.get("leverage")
        if type(leverage) not in (str, int) or not re.fullmatch(r"\d{1,4}", str(leverage)) or not 1 <= int(leverage) <= 1000:
            raise Stop("schema_changed")
        entry, mark, pnl = (numeric(row.get(k)) for k in ("entryPrice", "markPrice", "unrealizedProfit"))
        if entry < 0 or mark < 0:
            raise Stop("schema_changed")
        rows[key] = {"key": key, "symbol": symbol, "side": side, "collateral": collateral,
                     "quantity": canonical(amount.copy_abs()), "entryPrice": canonical(entry),
                     "markPrice": canonical(mark), "unrealizedPnl": canonical(pnl), "leverage": int(leverage)}
    if len(rows) > 300:
        raise Stop("schema_changed")
    return dict(sorted(rows.items()))


def validate_profile(data):
    if not isinstance(data, dict) or str(data.get("leadPortfolioId")) != PORTFOLIO_ID:
        raise Stop("identity_mismatch")
    if data.get("positionShow") is not True:
        raise Stop("positions_not_public")
    if data.get("status") != "ACTIVE":
        raise Stop("inactive")


def order_samples(page, previous, observed_at, baseline):
    """Observe at most the first page. Missing IDs cannot yield identifiable order events."""
    if not isinstance(page, dict) or not isinstance(page.get("list"), list) or len(page["list"]) > 20:
        raise Stop("invalid_order_page")
    seen, events = {}, []
    observed_ms = round(timestamp(observed_at) * 1000)
    prior_ms = round(timestamp(previous["observedAt"]) * 1000) if previous else None
    prior_rows = previous["rows"] if previous and not baseline else {}
    for raw in page["list"]:
        if not isinstance(raw, dict):
            raise Stop("invalid_order_row")
        order_id = raw.get("orderId")
        if order_id is None:
            continue
        if type(order_id) not in (int, str) or not re.fullmatch(r"[0-9]{1,30}", str(order_id)):
            raise Stop("invalid_order_id")
        symbol, created, updated = raw.get("symbol"), raw.get("orderTime"), raw.get("orderUpdateTime")
        if not isinstance(symbol, str) or not re.fullmatch(r"[A-Z0-9_]{1,50}", symbol):
            raise Stop("invalid_order_symbol")
        if type(created) is not int or type(updated) is not int or not 0 < created <= updated <= observed_ms:
            raise Stop("invalid_order_time")
        side, leg = raw.get("side"), raw.get("positionSide")
        if side not in ("BUY", "SELL") or leg not in ("LONG", "SHORT", "BOTH"):
            raise Stop("invalid_order_direction")
        quantity = numeric(raw.get("executedQty"))
        if quantity < 0:
            raise Stop("invalid_order_quantity")
        key = symbol + ":" + str(order_id)
        if key in seen:
            raise Stop("duplicate_order_id")
        old = prior_rows.get(key)
        if old and (old["created"] != created or old["side"] != side or old["leg"] != leg or
                    updated < old["updated"] or quantity < numeric(old["executedQty"])):
            raise Stop("order_history_rollback")
        seen[key] = {"created": created, "updated": updated, "side": side, "leg": leg,
                     "executedQty": canonical(quantity), "firstSeenAt": old["firstSeenAt"] if old else observed_at}
        kind = None
        if not baseline and prior_ms is not None:
            if old is None and created > prior_ms:
                kind = "new_public_order"
            elif old and quantity > numeric(old["executedQty"]):
                kind = "executed_quantity_increased"
        if kind:
            event_id = hashlib.sha256(json.dumps([PORTFOLIO_ID, key, kind, updated, canonical(quantity)]).encode()).hexdigest()
            events.append({"id": event_id, "kind": kind, "symbol": symbol, "orderId": str(order_id),
                           "side": side, "positionSide": leg, "executedQty": canonical(quantity),
                           "sourceCreatedAt": iso(created / 1000), "sourceUpdatedAt": iso(updated / 1000),
                           "firstSeenAt": seen[key]["firstSeenAt"], "observedAt": observed_at})
    return {"observedAt": observed_at, "rows": seen, "pageSize": 20, "received": len(page["list"]),
            "withoutIdentity": len(page["list"]) - len(seen), "complete": False}, events


def validate_order_checkpoint(sample):
    if not isinstance(sample, dict) or not isinstance(sample.get("rows"), dict):
        raise Stop("invalid_order_checkpoint")
    rows = sample["rows"]
    if sample.get("complete") is not False or sample.get("pageSize") != 20 or type(sample.get("received")) is not int or not 0 <= len(rows) <= sample["received"] <= 20 or sample.get("withoutIdentity") != sample["received"] - len(rows):
        raise Stop("invalid_order_checkpoint")
    stamp = round(timestamp(sample.get("observedAt")) * 1000)
    for key, row in rows.items():
        if not re.fullmatch(r"[A-Z0-9_]{1,50}:[0-9]{1,30}", key) or not isinstance(row,dict):
            raise Stop("invalid_order_checkpoint")
        if (type(row.get("created")) is not int or type(row.get("updated")) is not int or
                not 0 < row["created"] <= row["updated"] <= stamp or
                not row["created"] <= round(timestamp(row.get("firstSeenAt")) * 1000) <= stamp or
                row.get("side") not in ("BUY","SELL") or row.get("leg") not in ("LONG","SHORT","BOTH") or
                numeric(row.get("executedQty")) < 0):
            raise Stop("invalid_order_checkpoint")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise Stop("redirect_refused")


class Transport:
    def __init__(self, timeout=4.0, opener=None, monotonic=time.monotonic):
        self.timeout, self.clock = timeout, monotonic
        self.opener = opener or urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())

    @staticmethod
    def http_error(status):
        if status == 408 or 500 <= status <= 599:
            raise Temporary(f"http_{status}")
        raise Stop(f"http_{status}")

    def get(self, route):
        if route == "lead-portfolio/order-history":
            hold = source_holds.reason("binanceOrders5075281354358777856")
            if hold:
                raise Stop(hold)
            end = int(time.time() * 1000)
            payload = {"portfolioId": PORTFOLIO_ID, "startTime": end - 7 * 86400000,
                       "endTime": end, "pageSize": 20}
            request = urllib.request.Request(BASE + route, data=json.dumps(payload).encode(),
                                             headers={"Content-Type":"application/json", "Accept":"application/json",
                                                      "User-Agent":"BooksReadOnlyMonitor/1.0"})
        elif route in ("lead-portfolio/detail", "lead-data/positions"):
            request = urllib.request.Request(BASE + route + "?portfolioId=" + PORTFOLIO_ID,
                                             headers={"Accept":"application/json", "User-Agent":"BooksReadOnlyMonitor/1.0"})
        else:
            raise Stop("unsupported_route")
        deadline = self.clock() + self.timeout
        try:
            with self.opener.open(request, timeout=self.timeout) as response:
                if response.status != 200:
                    self.http_error(response.status)
                if "application/json" not in response.headers.get("Content-Type", "").lower():
                    raise Stop("unexpected_content_type")
                length = response.headers.get("Content-Length")
                if length is not None and (not length.isdecimal() or int(length) > MAX_BYTES):
                    raise Stop("response_too_large")
                chunks, size = [], 0
                while True:
                    if self.clock() >= deadline:
                        raise Temporary("read_deadline")
                    chunk = response.read1(min(65536, MAX_BYTES + 1 - size))
                    if not chunk:
                        break
                    size += len(chunk)
                    if size > MAX_BYTES:
                        raise Stop("response_too_large")
                    chunks.append(chunk)
        except urllib.error.HTTPError as exc:
            try:
                self.http_error(exc.code)
            finally:
                exc.close()
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            raise Temporary("network_or_timeout") from exc
        envelope = load_json(b"".join(chunks))
        if not isinstance(envelope, dict):
            raise Stop("schema_changed")
        if envelope.get("code") != "000000" or envelope.get("success") is not True:
            code = re.sub(r"[^a-zA-Z0-9_]", "", str(envelope.get("code", "unknown")))[:30]
            raise Stop("source_error_" + (code or "unknown"))
        if "data" not in envelope or envelope["data"] is None:
            raise Stop("schema_changed")
        return envelope["data"]


def initial_state():
    return {"schemaVersion": 1, "portfolioId": PORTFOLIO_ID, "initialized": False,
            "runActive": False, "stopped": False, "status": "unavailable", "errorCode": None,
            "lastAttemptAt": None, "lastSuccessAt": None, "sourceUpdatedAt": None,
            "positions": {}, "pendingAbsent": {}, "needsBaseline": True}


def validate_state(state):
    if not isinstance(state, dict) or type(state.get("schemaVersion")) is not int or state["schemaVersion"] != 1 or state.get("portfolioId") != PORTFOLIO_ID:
        raise Stop("invalid_checkpoint")
    if any(type(state.get(k)) is not bool for k in ("initialized", "runActive", "stopped", "needsBaseline")):
        raise Stop("invalid_checkpoint")
    if state.get("status") not in ("ready", "stale", "unavailable", "stopped") or state.get("sourceUpdatedAt") is not None:
        raise Stop("invalid_checkpoint")
    if state["stopped"] != (state["status"] == "stopped"):
        raise Stop("invalid_checkpoint")
    error = state.get("errorCode")
    if error is not None and (not isinstance(error, str) or not re.fullmatch(r"[a-zA-Z0-9_]{1,80}", error)):
        raise Stop("invalid_checkpoint")
    if error is not None and not state["stopped"] and not re.fullmatch(r"http_(408|5\d\d)|network_or_timeout|read_deadline", error):
        raise Stop("invalid_checkpoint")
    for key in ("lastAttemptAt", "lastSuccessAt"):
        if state.get(key) is not None:
            timestamp(state[key])
    if state["initialized"] != (state.get("lastSuccessAt") is not None):
        raise Stop("invalid_checkpoint")
    if state["status"] == "ready" and (not state["initialized"] or error is not None):
        raise Stop("invalid_checkpoint")
    if state["stopped"] and error is None:
        raise Stop("invalid_checkpoint")
    if not isinstance(state.get("positions"), dict) or not isinstance(state.get("pendingAbsent"), dict):
        raise Stop("invalid_checkpoint")
    all_positions = dict(state["positions"])
    for key, pending in state["pendingAbsent"].items():
        if not isinstance(pending, dict) or not isinstance(pending.get("position"), dict) or key in all_positions:
            raise Stop("invalid_checkpoint")
        timestamp(pending.get("firstMissingAt"))
        timestamp(pending.get("lastSeenAt"))
        all_positions[key] = pending["position"]
    if len(all_positions) > 600:
        raise Stop("invalid_checkpoint")
    for key, row in all_positions.items():
        if not isinstance(row, dict) or row.get("key") != key or row.get("side") not in ("LONG", "SHORT"):
            raise Stop("invalid_checkpoint")
        source = {"symbol": row.get("symbol"), "positionSide": row["side"], "collateral": row.get("collateral"),
                  "positionAmount": row.get("quantity"), "entryPrice": row.get("entryPrice"), "markPrice": row.get("markPrice"),
                  "unrealizedProfit": row.get("unrealizedPnl"), "leverage": row.get("leverage")}
        if normalize_positions([source]) != {key: row}:
            raise Stop("invalid_checkpoint")
    if not state["initialized"] and all_positions:
        raise Stop("invalid_checkpoint")
    if "orderSample" in state:
        validate_order_checkpoint(state["orderSample"])
    return state


def inspect_checkpoint(path):
    """Read-only validation for the workflow artifact manifest; no network."""
    try:
        uri = Path(path).resolve().as_uri() + "?mode=ro"
        with closing(sqlite3.connect(uri, uri=True)) as db:
            if db.execute("PRAGMA integrity_check").fetchone() != ("ok",):
                raise Stop("invalid_checkpoint")
            if db.execute("SELECT COUNT(*) FROM state").fetchone() != (1,):
                raise Stop("invalid_checkpoint")
            db.execute("SELECT id,payload FROM events LIMIT 0")
            rows = db.execute("SELECT payload FROM state WHERE id=1").fetchall()
            if len(rows) != 1:
                raise Stop("invalid_checkpoint")
            return validate_state(load_json(rows[0][0]))
    except (sqlite3.Error, OSError) as exc:
        raise Stop("invalid_checkpoint") from exc


class Store:
    def __init__(self, path):
        path = Path(path).expanduser()
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.lock = path.with_name(path.name + ".lock").open("a+")
        self.db = None
        try:
            fcntl.flock(self.lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            existed = path.exists()
            self.db = sqlite3.connect(path)
            self.db.execute("PRAGMA journal_mode=WAL")
            if existed:
                self.state = inspect_checkpoint(path)
            else:
                self.db.execute("CREATE TABLE state (id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL)")
                self.db.execute("CREATE TABLE events (id TEXT PRIMARY KEY, payload TEXT NOT NULL)")
                self.save(initial_state())
        except BlockingIOError as exc:
            self.close()
            raise Stop("another_writer_running") from exc
        except BaseException:
            self.close()
            raise

    def save(self, state, events=()):
        validate_state(state)
        with self.db:
            self.db.execute("INSERT INTO state(id,payload) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload",
                            (json.dumps(state, allow_nan=False),))
            for event in events:
                self.db.execute("INSERT OR IGNORE INTO events(id,payload) VALUES(?,?)", (event["id"], json.dumps(event)))
            self.db.execute("DELETE FROM events WHERE rowid NOT IN (SELECT rowid FROM events ORDER BY rowid DESC LIMIT ?)", (MAX_EVENTS,))
        self.state = state

    def close(self):
        try:
            if self.db is not None:
                try:
                    self.db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
                finally:
                    self.db.close()
                    self.db = None
        finally:
            self.lock.close()


def compare(old, current, observed_at, baseline=False):
    if baseline:
        return [], {}
    events, pending = [], {}

    def record(kind, key, before, after, previous_at):
        event = {"kind": kind, "portfolioId": PORTFOLIO_ID, "positionKey": key,
                 "beforeQuantity": before, "afterQuantity": after, "previousObservationAt": previous_at,
                 "firstDetectedAt": observed_at, "sourceUpdatedAt": None, "meaning": "snapshot_change_not_execution"}
        event["id"] = hashlib.sha256(json.dumps(event, sort_keys=True).encode()).hexdigest()
        events.append(event)

    for key, row in current.items():
        missing = old["pendingAbsent"].get(key)
        before = old["positions"].get(key) or (missing["position"] if missing else None)
        previous_at = missing["lastSeenAt"] if missing else old["lastSuccessAt"]
        if before is None:
            record("position_appeared", key, None, row["quantity"], previous_at)
        elif Decimal(row["quantity"]) != Decimal(before["quantity"]):
            kind = "position_increased" if Decimal(row["quantity"]) > Decimal(before["quantity"]) else "position_decreased"
            record(kind, key, before["quantity"], row["quantity"], previous_at)
    for key, row in old["positions"].items():
        if key not in current:
            pending[key] = {"position": row, "firstMissingAt": observed_at, "lastSeenAt": old["lastSuccessAt"]}
    for key, missing in old["pendingAbsent"].items():
        if key not in current:
            record("position_absent_twice", key, missing["position"]["quantity"], None, missing["lastSeenAt"])
            events[-1]["firstMissingAt"] = missing["firstMissingAt"]
    return events, pending


class DurationEnd(Exception):
    pass


class Monitor:
    def __init__(self, store, transport, repository_guard, interval=5.0, clock=time.monotonic,
                 wall=time.time, sleep=time.sleep, logger=emit, observe_orders=False):
        self.store, self.transport, self.guard = store, transport, repository_guard
        self.observe_orders = observe_orders
        self.interval, self.clock, self.wall, self.sleep, self.log = interval, clock, wall, sleep, logger
        self.last_request, self.deadline, self.first_cycle = None, None, True

    def request(self, route):
        wait = max(0.0, 2.0 - (self.clock() - self.last_request)) if self.last_request is not None else 0
        if self.deadline is not None and self.clock() + wait >= self.deadline:
            raise DurationEnd()
        if wait:
            self.sleep(wait)
        self.guard()
        if self.deadline is not None and self.clock() >= self.deadline:
            raise DurationEnd()
        self.last_request = self.clock()
        return self.transport.get(route)

    def cycle(self):
        old = self.store.state
        attempt = iso(self.wall())
        try:
            validate_profile(self.request("lead-portfolio/detail"))
            current = normalize_positions(self.request("lead-data/positions"))
            observed_at = iso(self.wall())
            gap = self.wall() - timestamp(old["lastSuccessAt"]) if old["lastSuccessAt"] else math.inf
            baseline = self.first_cycle or old["needsBaseline"] or not old["initialized"] or not 0 < gap <= 2 * self.interval + 2
            events, pending = compare(old, current, observed_at, baseline)
            state = {**old, "initialized": True, "status": "ready", "errorCode": None,
                     "lastAttemptAt": attempt, "lastSuccessAt": observed_at, "positions": current,
                     "pendingAbsent": pending, "needsBaseline": False}
            order_events = []
            if self.observe_orders:
                page = self.request("lead-portfolio/order-history")
                read_at = iso(self.wall())
                prev = old.get("orderSample")
                gap = timestamp(read_at) - timestamp(prev["observedAt"]) if prev else math.inf
                state["orderSample"], order_events = order_samples(page, prev, read_at,
                    baseline or not 0 < gap <= self.interval * 2 + 2)
            self.store.save(state, events + order_events)
            self.first_cycle = False
            self.log("baseline" if baseline else "checked", observedAt=observed_at, sourceUpdatedAt=None,
                     positionCount=len(current), changes=len(events), status="ready")
            for event in events:
                self.log("position_change", event=event)
            for event in order_events:
                self.log("order_observation", event=event)
            return "ready"
        except (Stop, Temporary) as exc:
            stopped = isinstance(exc, Stop)
            status = "stopped" if stopped else ("stale" if old["initialized"] else "unavailable")
            self.store.save({**old, "stopped": stopped, "status": status, "errorCode": str(exc),
                             "lastAttemptAt": attempt, "needsBaseline": True, "pendingAbsent": {}})
            self.log(status, observedAt=attempt, errorCode=str(exc), lastSuccessAt=old["lastSuccessAt"])
            return status

    def run(self, max_cycles=None, duration=None):
        old = self.store.state
        if old["stopped"]:
            self.log("stopped", errorCode=old["errorCode"], persisted=True)
            return 2
        if old["runActive"]:
            raise Stop("incomplete_previous_run")
        self.store.save({**old, "runActive": True, "needsBaseline": True, "pendingAbsent": {}})
        target, count, failures = self.clock(), 0, 0
        self.deadline = target + duration if duration is not None else None
        result = old["status"]
        try:
            while max_cycles is None or count < max_cycles:
                if self.deadline is not None and target >= self.deadline:
                    break
                self.sleep(max(0.0, target - self.clock()))
                if self.deadline is not None and self.clock() >= self.deadline:
                    break
                self.log("cycle_started", observedAt=iso(self.wall()), lagSeconds=round(max(0.0, self.clock() - target), 3))
                result = self.cycle()
                count += 1
                if result == "stopped":
                    break
                if result != "ready":
                    failures += 1
                    delay = min(300.0, self.interval * 2 ** min(failures, 8))
                    target = self.clock() + delay
                    self.log("backoff", delaySeconds=delay)
                else:
                    failures = 0
                    target += self.interval
                    if self.clock() > target:
                        missed = math.ceil((self.clock() - target) / self.interval)
                        target += missed * self.interval
                        self.log("missed_ticks", count=missed)
        except DurationEnd:
            pass
        # Only an orderly bounded finish or durable source refusal completes a checkpoint.
        self.store.save({**self.store.state, "runActive": False})
        return 2 if self.store.state["stopped"] else (0 if result == "ready" else 1)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--interval", type=float, default=5.0)
    parser.add_argument("--once", action="store_true")
    parser.add_argument("--max-cycles", type=int)
    parser.add_argument("--duration-seconds", type=float)
    parser.add_argument("--state-db", type=Path, default=Path.home() / ".local/state/books-binance-watch/watch.sqlite3")
    parser.add_argument("--repo-snapshot", type=Path, default=ROOT / "trader/binance/portfolios.json")
    parser.add_argument("--status", action="store_true", help="Inspect the saved checkpoint without any network request")
    args = parser.parse_args(argv)
    if not args.status:
        hold = source_holds.reason("binancePublicCollector") or source_holds.reason("binanceOrders5075281354358777856")
        if hold:
            emit("stopped", reason=hold)
            return 2
    if not math.isfinite(args.interval) or args.interval < 5:
        parser.error("--interval must be at least 5 seconds")
    if args.max_cycles is not None and args.max_cycles < 1:
        parser.error("--max-cycles must be positive")
    if args.duration_seconds is not None and (not math.isfinite(args.duration_seconds) or not 0 < args.duration_seconds <= 3600):
        parser.error("--duration-seconds must be within (0, 3600]")
    if args.once and args.max_cycles is not None:
        parser.error("--once and --max-cycles are mutually exclusive")
    store = None
    try:
        if args.status:
            state = inspect_checkpoint(args.state_db.expanduser())
            emit("status", **state)
            return 2 if state["stopped"] or state["runActive"] else 0
        store = Store(args.state_db)
        monitor = Monitor(store, Transport(), lambda: check_repository(args.repo_snapshot), args.interval, observe_orders=True)
        def interrupt(_signum, _frame):
            raise KeyboardInterrupt()
        signal.signal(signal.SIGTERM, interrupt)
        signal.signal(signal.SIGINT, interrupt)
        emit("starting", portfolioId=PORTFOLIO_ID, intervalSeconds=args.interval,
             guarantee="local_target_cadence_only", sourceUpdatedAt=None)
        return monitor.run(1 if args.once else args.max_cycles, args.duration_seconds)
    except KeyboardInterrupt:
        emit("interrupted", checkpointComplete=False)
        return 130
    except (Stop, sqlite3.Error, OSError, ValueError) as exc:
        emit("fatal", errorCode=str(exc) if isinstance(exc, Stop) else type(exc).__name__, checkpointComplete=False)
        return 2
    except Exception as exc:
        emit("fatal", errorCode=type(exc).__name__, checkpointComplete=False)
        return 2
    finally:
        if store is not None:
            store.close()


if __name__ == "__main__":
    raise SystemExit(main())
