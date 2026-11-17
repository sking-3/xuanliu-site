"""Client protocol for an independent monotonic source authority.

No production endpoint, credentials, initialization, reset or HTTP transport.
The injected exchange must authenticate a separately administered authority with
linearizable reads/CAS and a non-reusable durable stream. A second mutable file
or a signature on old data does not meet that contract. See SHARED_TDX_GUARD.md.
"""
from copy import deepcopy
from dataclasses import dataclass
import hashlib
import json
import re
from uuid import uuid4

from tools.tdx_source_guard import SCHEMA, SOURCE, SourceStopped

PROTOCOL = "books.source.authority.v1"
MAX_REVISION = 9007199254740991
MAX_BYTES = 65536


class AuthorityError(SourceStopped):
    pass


def _digest(value):
    raw = json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()
    if len(raw) > MAX_BYTES:
        raise ValueError("oversized authority message")
    return hashlib.sha256(raw).hexdigest()


def _identifier(value):
    return isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}", value) is not None


def _hash(value):
    return isinstance(value, str) and re.fullmatch(r"[0-9a-f]{64}", value) is not None


def _record(value):
    if (not isinstance(value, dict) or value.get("schema") != SCHEMA
            or value.get("source") != SOURCE):
        return False
    fields = set(value)
    if value.get("state") == "ready":
        return fields == {"schema", "source", "state"}
    if value.get("state") == "pending":
        return (fields == {"schema", "source", "state", "token"}
                and _identifier(value["token"]))
    if value.get("state") == "stopped":
        return (fields in ({"schema", "source", "state", "reason"},
                           {"schema", "source", "state", "reason", "token"})
                and _identifier(value["reason"])
                and ("token" not in value or _identifier(value["token"])))
    return False


def _transition(before, after):
    if not _record(after):
        return False
    if before["state"] == "ready":
        return after["state"] == "pending"
    if before["state"] == "pending":
        return (after["state"] == "ready" or after["state"] == "stopped"
                and after.get("token") == before["token"])
    # Administrative stop/resume is outside the runner credential and protocol.
    return False


@dataclass(frozen=True)
class Binding:
    authority_id: str
    stream_id: str
    migration_digest: str

    def __post_init__(self):
        if (not _identifier(self.authority_id) or not _identifier(self.stream_id)
                or not _hash(self.migration_digest)):
            raise AuthorityError("authority_binding_invalid")


@dataclass(frozen=True)
class Revision:
    binding: Binding
    number: int
    record_digest: str


class AuthorityStore:
    authorizes_source = True

    def __init__(self, *, binding, exchange=None):
        if not isinstance(binding, Binding) or exchange is not None and not callable(exchange):
            raise AuthorityError("authority_configuration_invalid")
        self.binding = binding
        self._exchange = exchange
        self._blocked = False
        self._last = None
        self._watermark = None
        self._record = None

    def _fail(self, reason):
        self._blocked = True
        self._last = self._record = None
        raise AuthorityError(reason)

    def _call(self, operation, **fields):
        if self._blocked:
            raise AuthorityError("authority_instance_stopped")
        if self._exchange is None:
            self._fail("authority_unconfigured")
        request = dict(schema=PROTOCOL, source=SOURCE, authority_id=self.binding.authority_id,
                       stream_id=self.binding.stream_id, migration_digest=self.binding.migration_digest,
                       operation=operation, challenge=uuid4().hex, **fields)
        try:
            request_digest = _digest(request)
            reply = self._exchange(deepcopy(request))
            if (not isinstance(reply, dict)
                    or set(reply) != {"schema", "source", "authority_id", "stream_id", "migration_digest",
                                      "operation", "challenge", "request_digest", "status", "snapshot"}
                    or any(reply.get(key) != request[key] for key in (
                        "schema", "source", "authority_id", "stream_id", "migration_digest", "operation", "challenge"))
                    or reply["request_digest"] != request_digest):
                raise ValueError()
            _digest(reply)
        except Exception:
            self._fail("authority_response_unverified")
        if reply["status"] == "conflict" and operation == "cas":
            self._blocked = True
            self._last = self._record = None
            return None
        if reply["status"] != "ok":
            self._fail("authority_request_refused")
        snapshot = reply["snapshot"]
        try:
            if (not isinstance(snapshot, dict) or set(snapshot) != {"revision", "record"}
                    or type(snapshot["revision"]) is not int
                    or not 1 <= snapshot["revision"] <= MAX_REVISION
                    or not _record(snapshot["record"])):
                raise ValueError()
            revision = Revision(self.binding, snapshot["revision"], _digest(snapshot["record"]))
            if self._watermark is not None and (
                    revision.number < self._watermark.number
                    or revision.number == self._watermark.number and revision != self._watermark):
                raise ValueError()
        except Exception:
            self._fail("authority_snapshot_unverified")
        return revision, deepcopy(snapshot["record"])

    def read(self, source):
        if source != SOURCE:
            raise AuthorityError("source_identity_unverified")
        result = self._call("read")
        self._last, self._record = result
        self._watermark = self._last
        return self._last, deepcopy(self._record)

    def compare_and_swap(self, source, expected, record):
        if source != SOURCE:
            raise AuthorityError("source_identity_unverified")
        if (not isinstance(expected, Revision) or expected != self._last
                or expected.binding != self.binding or expected.number >= MAX_REVISION
                or self._record is None or not _transition(self._record, record)):
            raise AuthorityError("authority_update_invalid")
        result = self._call("cas", expected_revision=expected.number,
                            expected_digest=expected.record_digest, record=deepcopy(record))
        if result is None:
            return False
        revision, actual = result
        if revision.number != expected.number + 1 or actual != record:
            self._fail("authority_write_uncertain")
        self._watermark = revision
        self._last = self._record = None
        return True
