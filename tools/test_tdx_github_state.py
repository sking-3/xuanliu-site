"""HTTP simulations only. No real repository, token, state or source is accessed."""
import base64
import hashlib
import json
import unittest
from unittest.mock import Mock, patch

from tools import tdx_github_state as b
from tools import tdx_source_guard as g

READY = {"schema": g.SCHEMA, "source": g.SOURCE, "state": "ready"}
PATH = "guards/tdx.json"
BRANCH = "state/tdx"
TOKEN = "synthetic-test-token"


def encoded(value):
    return (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()


def blob(raw):
    return hashlib.sha1(b"blob " + str(len(raw)).encode() + b"\0" + raw).hexdigest()


class FakeContents:
    def __init__(self):
        self.raw = encoded({"schema": b.ENVELOPE, "source": g.SOURCE,
                            "generation": 1, "record": READY})
        self.calls = []
        self.status = None
        self.raise_after_put = False
        self.raise_before_put = False
        self.bad_receipt = False
        self.transform_read = None

    def request(self, method, url, headers, body, timeout):
        self.calls.append((method, url, body))
        if self.status:
            return b.HttpResponse(self.status, b"")
        if method == "GET":
            value = {"type": "file", "path": PATH, "encoding": "base64",
                     "sha": blob(self.raw), "content": base64.b64encode(self.raw).decode()}
            if self.transform_read:
                value = self.transform_read(value)
            return b.HttpResponse(200, encoded(value))
        if self.raise_before_put:
            raise TimeoutError("synthetic private diagnostic")
        payload = json.loads(body)
        if payload["branch"] != BRANCH or payload["sha"] != blob(self.raw):
            return b.HttpResponse(409, b"")
        self.raw = base64.b64decode(payload["content"])
        if self.raise_after_put:
            raise TimeoutError("synthetic ambiguous response")
        sha = "0" * 40 if self.bad_receipt else blob(self.raw)
        return b.HttpResponse(200, encoded({"content": {"path": PATH, "sha": sha}}))


class GitHubStateTests(unittest.TestCase):
    def setUp(self):
        self.server = FakeContents()
        network = patch("urllib.request.OpenerDirector.open", side_effect=AssertionError("network forbidden"))
        network.start()
        self.addCleanup(network.stop)

    def store(self, **options):
        return b.GitHubContentsStore(repository="fixture-owner/fixture-state",
                                     branch=BRANCH, path=PATH, token=TOKEN,
                                     transport=self.server.request, **options)

    def test_construction_is_inert_and_credentials_not_repr(self):
        store = self.store()
        self.assertEqual(self.server.calls, [])
        self.assertNotIn(TOKEN, repr(store))

    def test_fixed_host_exact_location_and_ref(self):
        revision, record = self.store().read(g.SOURCE)
        self.assertEqual(revision.generation, 1)
        self.assertEqual(record, READY)
        self.assertEqual(self.server.calls[0][1],
                         "https://api.github.com/repos/fixture-owner/fixture-state/contents/guards/tdx.json?ref=state%2Ftdx")

    def test_invalid_locations_rejected_before_transport(self):
        base = dict(repository="fixture-owner/fixture-state", branch=BRANCH, path=PATH,
                    token=TOKEN, transport=self.server.request)
        for field, value in (("repository", "https://attacker.invalid/r"), ("repository", "../r"),
                             ("branch", "../main"), ("branch", "main?ref=other"),
                             ("path", "/state.json"), ("path", "guards/../state.json"),
                             ("path", "guards/a#b"), ("token", "bad\nheader")):
            with self.subTest(field=field, value=value), self.assertRaises(b.StateBackendError):
                b.GitHubContentsStore(**dict(base, **{field: value}))
        self.assertEqual(self.server.calls, [])

    def test_unknown_source_is_not_mapped_to_tdx(self):
        with self.assertRaises(b.StateBackendError):
            self.store().read("tencent")
        self.assertEqual(self.server.calls, [])

    def test_successful_cas_always_increments_generation(self):
        store = self.store()
        for expected_generation in (1, 2, 3):
            revision, record = store.read(g.SOURCE)
            self.assertEqual(revision.generation, expected_generation)
            self.assertTrue(store.compare_and_swap(g.SOURCE, revision, record))
        self.assertEqual(json.loads(self.server.raw)["generation"], 4)
        for method, url, body in self.server.calls:
            self.assertNotIn("/actions/", url)
            if method == "PUT":
                payload = json.loads(body)
                self.assertEqual(payload["branch"], BRANCH)
                self.assertEqual(len(payload["sha"]), 40)
                self.assertNotIn(TOKEN, body.decode())

    def test_forged_generation_cannot_roll_back(self):
        store = self.store()
        revision, record = store.read(g.SOURCE)
        with self.assertRaises(b.StateBackendError):
            store.compare_and_swap(g.SOURCE, b.Revision(revision.blob_sha, 9), record)
        self.assertEqual(len(self.server.calls), 1)

    def test_cas_requires_a_prior_read_on_that_adapter(self):
        with self.assertRaises(b.StateBackendError):
            self.store().compare_and_swap(g.SOURCE, b.Revision(blob(self.server.raw), 1), READY)
        self.assertEqual(self.server.calls, [])

    def test_two_instances_conflict_without_retry(self):
        first, second = self.store(), self.store()
        a, record = first.read(g.SOURCE)
        stale, _ = second.read(g.SOURCE)
        self.assertTrue(first.compare_and_swap(g.SOURCE, a, record))
        self.assertFalse(second.compare_and_swap(g.SOURCE, stale, record))
        count = len(self.server.calls)
        with self.assertRaises(b.StateBackendError):
            second.read(g.SOURCE)
        self.assertEqual(len(self.server.calls), count)

    def test_same_record_after_two_writes_does_not_recreate_old_sha(self):
        first, second = self.store(), self.store()
        stale, record = first.read(g.SOURCE)
        for _ in range(2):
            revision, current = second.read(g.SOURCE)
            self.assertTrue(second.compare_and_swap(g.SOURCE, revision, current))
        self.assertEqual(json.loads(self.server.raw)["record"], record)
        self.assertNotEqual(blob(self.server.raw), stale.blob_sha)
        self.assertFalse(first.compare_and_swap(g.SOURCE, stale, record))

    def test_http_refusal_stops_adapter_without_retry(self):
        for status in (401, 403, 429):
            self.server.status = status
            store = self.store()
            with self.assertRaisesRegex(b.StateBackendError, "state_access_denied"):
                store.read(g.SOURCE)
            count = len(self.server.calls)
            with self.assertRaises(b.StateBackendError):
                store.read(g.SOURCE)
            self.assertEqual(len(self.server.calls), count)

    def test_missing_state_is_never_created(self):
        self.server.status = 404
        with self.assertRaises(b.StateBackendError):
            self.store().read(g.SOURCE)
        self.assertEqual([x[0] for x in self.server.calls], ["GET"])

    def test_redirects_are_failures_not_alternate_locations(self):
        for status in (301, 302, 307, 308):
            self.server.status = status
            before = len(self.server.calls)
            with self.assertRaises(b.StateBackendError):
                self.store().read(g.SOURCE)
            self.assertEqual(len(self.server.calls), before + 1)

    def test_write_refusal_does_not_mutate_state(self):
        store = self.store()
        revision, _ = store.read(g.SOURCE)
        self.server.status = 403
        with self.assertRaisesRegex(b.StateBackendError, "state_access_denied"):
            store.compare_and_swap(g.SOURCE, revision, READY)
        self.assertEqual(json.loads(self.server.raw)["generation"], 1)

    def test_uncertain_reservation_write_stops_another_instance(self):
        callback = Mock()
        first = g.Guard(self.store(), migration_complete=True)
        self.server.raise_after_put = True
        with self.assertRaises(g.SourceStopped):
            first.run("mootdx", callback)
        callback.assert_not_called()
        self.assertEqual(json.loads(self.server.raw)["record"]["state"], "pending")
        self.server.raise_after_put = False
        second = g.Guard(self.store(), migration_complete=True)
        with self.assertRaises(g.SourceStopped):
            second.run("pytdx", callback)
        callback.assert_not_called()

    def test_denial_persists_between_independent_adapters(self):
        first = g.Guard(self.store(), migration_complete=True)
        second = g.Guard(self.store(), migration_complete=True)
        with self.assertRaises(PermissionError):
            first.run("mootdx", Mock(side_effect=PermissionError("403 synthetic")))
        callback = Mock()
        with self.assertRaises(g.SourceStopped):
            second.run("tdxpy", callback)
        callback.assert_not_called()
        envelope = json.loads(self.server.raw)
        self.assertEqual(envelope["generation"], 3)
        self.assertEqual(envelope["record"]["reason"], "provider_access_denied")

    def test_failed_denial_write_keeps_persisted_pending(self):
        first = g.Guard(self.store(), migration_complete=True)
        def denied():
            self.server.raise_before_put = True
            raise PermissionError("429 synthetic")
        with self.assertRaises(g.SourceStopped):
            first.run("mootdx", denied)
        self.assertEqual(json.loads(self.server.raw)["record"]["state"], "pending")
        second = g.Guard(self.store(), migration_complete=True)
        with self.assertRaises(g.SourceStopped):
            second.run("tdx", Mock())

    def test_invalid_write_receipt_is_uncertain_and_not_retried(self):
        store = self.store()
        revision, _ = store.read(g.SOURCE)
        self.server.bad_receipt = True
        with self.assertRaisesRegex(b.StateBackendError, "state_write_uncertain"):
            store.compare_and_swap(g.SOURCE, revision, dict(READY, state="pending", token="fixture"))
        count = len(self.server.calls)
        with self.assertRaises(b.StateBackendError):
            store.read(g.SOURCE)
        self.assertEqual(len(self.server.calls), count)

    def test_corrupt_content_and_rollback_generation_are_rejected(self):
        cases = [
            lambda v: dict(v, sha="0" * 40),
            lambda v: dict(v, path="other.json"),
            lambda v: dict(v, type="symlink"),
            lambda v: dict(v, content="%%%bad"),
        ]
        for transform in cases:
            self.server.transform_read = transform
            with self.assertRaises(b.StateBackendError):
                self.store().read(g.SOURCE)
        self.server.transform_read = None
        for generation in (0, -1, True, "1"):
            self.server.raw = encoded({"schema": b.ENVELOPE, "source": g.SOURCE,
                                       "generation": generation, "record": READY})
            with self.assertRaises(b.StateBackendError):
                self.store().read(g.SOURCE)

    def test_generation_exhaustion_prevents_write(self):
        self.server.raw = encoded({"schema": b.ENVELOPE, "source": g.SOURCE,
                                   "generation": b.MAX_GENERATION, "record": READY})
        store = self.store()
        revision, _ = store.read(g.SOURCE)
        with self.assertRaises(b.StateBackendError):
            store.compare_and_swap(g.SOURCE, revision, READY)
        self.assertEqual([x[0] for x in self.server.calls], ["GET"])

    def test_same_instance_rejects_observed_generation_rollback(self):
        store = self.store()
        old_raw = self.server.raw
        revision, record = store.read(g.SOURCE)
        store.compare_and_swap(g.SOURCE, revision, record)
        self.server.raw = old_raw
        with self.assertRaisesRegex(b.StateBackendError, "state_document_invalid"):
            store.read(g.SOURCE)

    def test_default_production_remains_unconfigured(self):
        with self.assertRaisesRegex(g.SourceStopped, "legacy_source_stops_unverified"):
            g.PRODUCTION_GUARD.check()
        self.assertIsNone(g.PRODUCTION_GUARD.store)


if __name__ == "__main__":
    unittest.main()
