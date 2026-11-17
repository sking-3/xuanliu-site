"""GitHub Contents API CAS adapter; construction is inert and never creates state.

Production wiring is deliberately absent. Configure one exact repository, branch,
path and token only after legacy migration is reconciled. No queues, run inventory,
redirects, retries, source traffic or state initialization exist in this module.
"""
import base64
from dataclasses import dataclass
import hashlib
import json
import re
import urllib.error
import urllib.parse
import urllib.request

from tools.tdx_source_guard import SCHEMA, SOURCE, SourceStopped

ENVELOPE = "books.source.cas.v1"
MAX_BYTES = 65536
MAX_RESPONSE = 131072
MAX_GENERATION = 9007199254740991


class StateBackendError(SourceStopped):
    pass


@dataclass(frozen=True)
class Revision:
    blob_sha: str
    generation: int


@dataclass(frozen=True)
class HttpResponse:
    status: int
    body: bytes


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def request_once(method, url, headers, body, timeout):
    """One ordinary HTTPS request. No retry or alternate transport."""
    request = urllib.request.Request(url, data=body, headers=headers, method=method)
    opener = urllib.request.build_opener(NoRedirect())
    try:
        with opener.open(request, timeout=timeout) as response:
            return HttpResponse(response.status, response.read(MAX_RESPONSE + 1))
    except urllib.error.HTTPError as error:
        # Response bodies/headers can contain sensitive diagnostics; never retain.
        status = error.code
        error.close()
        return HttpResponse(status, b"")


def _pairs(items):
    result = {}
    for key, value in items:
        if key in result:
            raise ValueError("duplicate key")
        result[key] = value
    return result


def _json(raw):
    return json.loads(raw.decode("utf-8"), object_pairs_hook=_pairs,
                      parse_constant=lambda _: (_ for _ in ()).throw(ValueError("nonfinite")))


def _encode(value):
    return (json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False) + "\n").encode()


def _sha(raw):
    return hashlib.sha1(b"blob " + str(len(raw)).encode() + b"\0" + raw).hexdigest()


def _generation(value):
    return type(value) is int and 1 <= value <= MAX_GENERATION


def _sha_value(value):
    return isinstance(value, str) and re.fullmatch(r"[0-9a-f]{40}", value) is not None


def _record(value):
    if (not isinstance(value, dict) or value.get("schema") != SCHEMA
            or value.get("source") != SOURCE):
        return False
    fields = set(value)
    if value.get("state") == "ready":
        return fields == {"schema", "source", "state"}
    if value.get("state") == "pending":
        return (fields == {"schema", "source", "state", "token"}
                and isinstance(value["token"], str) and bool(value["token"]))
    if value.get("state") == "stopped":
        return (fields in ({"schema", "source", "state", "reason"},
                           {"schema", "source", "state", "reason", "token"})
                and isinstance(value["reason"], str) and bool(value["reason"])
                and ("token" not in value or isinstance(value["token"], str) and bool(value["token"])))
    return False


class GitHubContentsStore:
    def __init__(self, *, repository, branch, path, token, transport=request_once, timeout=10):
        # Each segment must be literal, not an URL, traversal, query or fragment.
        segment = r"[A-Za-z0-9_-][A-Za-z0-9._-]*"
        if (not isinstance(repository, str) or not re.fullmatch(segment + "/" + segment, repository)
                or any(x in (".", "..") or x.endswith(".") for x in repository.split("/"))):
            raise StateBackendError("state_location_invalid")
        for value in (branch, path):
            if (not isinstance(value, str) or len(value) > 200
                    or not all(re.fullmatch(segment, part) and ".." not in part
                               and not part.endswith((".", ".lock")) for part in value.split("/"))):
                raise StateBackendError("state_location_invalid")
        if (not isinstance(token, str) or not token or len(token) > 4096
                or re.search(r"[\s\x00-\x1f\x7f]", token)):
            raise StateBackendError("state_credentials_invalid")
        if type(timeout) not in (int, float) or not 1 <= timeout <= 30:
            raise StateBackendError("state_timeout_invalid")
        self._url = "https://api.github.com/repos/" + repository + "/contents/" + urllib.parse.quote(path, safe="/")
        self._branch, self._path, self._token = branch, path, token
        self._transport, self._timeout = transport, timeout
        self._blocked = False
        self._last_revision = None
        self._watermark = None

    def _request(self, method, body=None):
        if self._blocked:
            raise StateBackendError("state_backend_stopped")
        url = self._url
        if method == "GET":
            url += "?" + urllib.parse.urlencode({"ref": self._branch})
        headers = {"Accept": "application/vnd.github+json", "Authorization": "Bearer " + self._token,
                   "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json",
                   "User-Agent": "Books-TDX-State/1", "Cache-Control": "no-cache"}
        try:
            response = self._transport(method, url, headers, body, self._timeout)
        except Exception:
            self._blocked = True
            raise StateBackendError("state_write_uncertain" if method == "PUT" else "state_read_failed") from None
        if not isinstance(response, HttpResponse) or type(response.status) is not int:
            self._blocked = True
            raise StateBackendError("state_response_invalid")
        if response.status != 200:
            self._blocked = True
            if response.status in (401, 403, 429):
                raise StateBackendError("state_access_denied")
            if method == "PUT" and response.status in (409, 422):
                return None
            raise StateBackendError("state_write_uncertain" if method == "PUT" else "state_read_failed")
        try:
            if not isinstance(response.body, bytes) or len(response.body) > MAX_RESPONSE:
                raise ValueError()
            value = _json(response.body)
            if not isinstance(value, dict):
                raise ValueError()
            return value
        except Exception:
            self._blocked = True
            raise StateBackendError("state_response_invalid") from None

    def read(self, source):
        if source != SOURCE:
            raise StateBackendError("source_identity_unverified")
        value = self._request("GET")
        try:
            if (value.get("type") != "file" or value.get("path") != self._path
                    or value.get("encoding") != "base64" or not _sha_value(value.get("sha"))
                    or not isinstance(value.get("content"), str)):
                raise ValueError()
            # GitHub inserts newlines in base64; no other non-alphabet bytes accepted.
            raw = base64.b64decode(value["content"].replace("\n", ""), validate=True)
            if len(raw) > MAX_BYTES or _sha(raw) != value["sha"]:
                raise ValueError()
            envelope = _json(raw)
            if (not isinstance(envelope, dict) or set(envelope) != {"schema", "source", "generation", "record"}
                    or envelope["schema"] != ENVELOPE or envelope["source"] != SOURCE
                    or not _generation(envelope["generation"]) or not _record(envelope["record"])):
                raise ValueError()
            revision = Revision(value["sha"], envelope["generation"])
            if self._watermark is not None and (
                    revision.generation < self._watermark.generation
                    or revision.generation == self._watermark.generation
                    and revision.blob_sha != self._watermark.blob_sha):
                raise ValueError()
            self._last_revision = self._watermark = revision
            return revision, envelope["record"]
        except Exception:
            self._blocked = True
            raise StateBackendError("state_document_invalid") from None

    def compare_and_swap(self, source, expected, record):
        if source != SOURCE:
            raise StateBackendError("source_identity_unverified")
        if (not isinstance(expected, Revision) or expected != self._last_revision
                or not _sha_value(expected.blob_sha)
                or not _generation(expected.generation) or expected.generation >= MAX_GENERATION
                or not _record(record)):
            raise StateBackendError("state_update_invalid")
        try:
            raw = _encode({"schema": ENVELOPE, "source": SOURCE,
                           "generation": expected.generation + 1, "record": record})
            if len(raw) > MAX_BYTES:
                raise ValueError()
            body = _encode({"message": "Advance TDX guard generation " + str(expected.generation + 1),
                            "branch": self._branch, "sha": expected.blob_sha,
                            "content": base64.b64encode(raw).decode("ascii")})
        except Exception:
            raise StateBackendError("state_update_invalid") from None
        result = self._request("PUT", body)
        if result is None:
            return False
        content = result.get("content")
        if (not isinstance(content, dict) or content.get("path") != self._path
                or content.get("sha") != _sha(raw)):
            self._blocked = True
            raise StateBackendError("state_write_uncertain")
        self._last_revision = None
        self._watermark = Revision(_sha(raw), expected.generation + 1)
        return True
