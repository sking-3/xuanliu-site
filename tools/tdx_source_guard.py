"""Shared TDX request guard. No transport, credentials, reset, or production store.

Store contract: read(source) -> (opaque revision, JSON record); compare_and_swap
must atomically replace only that revision and return an actual bool. Missing
records are never initialized by this module. Durable adapters must preserve
pending records across processes; a pending record never expires into ready.
"""
from contextvars import ContextVar
from copy import deepcopy
from uuid import uuid4
import re

SOURCE = "tdx.marketdata.cn"
ALIASES = frozenset((SOURCE, "tdx", "mootdx", "pytdx", "tdxpy"))
SCHEMA = "books.source.guard.v1"


class SourceStopped(RuntimeError):
    pass


def source_id(alias):
    if alias not in ALIASES:
        raise SourceStopped("source_identity_unverified")
    return SOURCE


def access_denied(error):
    """Recognize explicit HTTP refusal fields without depending on message text."""
    if isinstance(error, PermissionError):
        return True
    try:
        response = getattr(error, "response", None)
        for value in (error, response):
            if value is None:
                continue
            for name in ("status", "status_code", "code"):
                status = getattr(value, name, None)
                if not isinstance(status, bool) and str(status) in ("401", "403", "429"):
                    return True
        text = str(error).lower()
    except Exception:
        # An unreadable error must not become permission to try another request.
        return True
    return bool(re.search(r"(?<!\d)(401|403|429)(?!\d)", text)) or any(
        word in text for word in ("forbidden", "denied", "rate limit", "permission"))


class Guard:
    def __init__(self, store, *, migration_complete=False):
        self.store = store
        self.migration_complete = migration_complete
        self.active = ContextVar("tdx_request_reservation", default=None)

    def _read(self):
        try:
            revision, record = self.store.read(SOURCE)
        except Exception:
            raise SourceStopped("source_state_unavailable") from None
        if (revision is None or not isinstance(record, dict)
                or record.get("schema") != SCHEMA or record.get("source") != SOURCE
                or record.get("state") not in ("ready", "pending", "stopped")):
            raise SourceStopped("source_state_unverified")
        state = record["state"]
        if state == "ready" and set(record) != {"schema", "source", "state"}:
            raise SourceStopped("source_state_unverified")
        if state == "pending" and (set(record) != {"schema", "source", "state", "token"}
                or not isinstance(record.get("token"), str) or not record["token"]):
            raise SourceStopped("source_state_unverified")
        if state == "stopped" and not isinstance(record.get("reason"), str):
            raise SourceStopped("source_state_unverified")
        return revision, deepcopy(record)

    def _cas(self, revision, record):
        try:
            result = self.store.compare_and_swap(SOURCE, revision, deepcopy(record))
        except Exception:
            raise SourceStopped("source_state_write_uncertain") from None
        if result is not True:
            raise SourceStopped("source_state_conflict")

    def check(self, alias="mootdx"):
        source_id(alias)
        if self.migration_complete is not True:
            raise SourceStopped("legacy_source_stops_unverified")
        revision, record = self._read()
        token = self.active.get()
        if token is None:
            if record["state"] != "ready":
                raise SourceStopped("source_stopped_or_unfinished")
        elif record["state"] != "pending" or record.get("token") != token:
            raise SourceStopped("source_reservation_revoked")
        return revision, record

    def _failed(self, error):
        revision, current = self._read()
        if current["state"] == "pending" and current.get("token") == self.active.get():
            stopped = dict(current, state="stopped", reason="request_failed_or_interrupted")
            if access_denied(error):
                stopped["reason"] = "provider_access_denied"
            self._cas(revision, stopped)

    def run(self, alias, operation):
        revision, record = self.check(alias)
        if self.active.get() is not None:
            # Nested factory internals share the reservation, but must re-read it.
            try:
                return operation()
            except BaseException as error:
                self._failed(error)
                raise
        token = uuid4().hex
        pending = {"schema": SCHEMA, "source": SOURCE, "state": "pending", "token": token}
        self._cas(revision, pending)  # Persist before any SDK constructor/request.
        context = self.active.set(token)
        try:
            self.check(alias)
            try:
                result = operation()
            except BaseException as error:
                # Never overwrite an independently recorded stop/revocation.
                self._failed(error)
                raise
            revision, current = self.check(alias)
            self._cas(revision, {"schema": SCHEMA, "source": SOURCE, "state": "ready"})
            return result
        finally:
            self.active.reset(context)


# Deliberately no state adapter or migration attestation configured in production.
# Tests construct separate Guard instances over one synthetic CAS store.
PRODUCTION_GUARD = Guard(None)


def require_tdx_access():
    PRODUCTION_GUARD.check()


def source_call(operation, *args, **kwargs):
    return PRODUCTION_GUARD.run("mootdx", lambda: operation(*args, **kwargs))
