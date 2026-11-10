"""Offline fixtures only: no GitHub or exchange requests."""
import copy
import json
import os
from pathlib import Path
from datetime import datetime, timedelta, timezone
import sqlite3
import tempfile
import unittest
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

import actions_state as handoff
from monitor import Store, initial_state, inspect_checkpoint


def run(number, *, status="completed", conclusion="success"):
    return {"id": number * 10, "run_number": number, "run_attempt": 1,
            "workflow_id": 99, "path": handoff.WORKFLOW, "head_sha": f"{number:040x}",
            "head_branch": "main", "event": "schedule", "status": status,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "conclusion": conclusion, "repository": {"id": 7, "full_name": handoff.REPOSITORY},
            "head_repository": {"id": 7, "full_name": handoff.REPOSITORY}}


def jobs(previous, conclusion="success"):
    return {"total_count": 1, "jobs": [{"name": handoff.JOB, "run_id": previous["id"],
            "status": "completed", "conclusion": "success", "steps": [{
                "name": handoff.STEP, "status": "completed", "conclusion": conclusion}]}]}


def artifacts(previous):
    return {"total_count": 1, "artifacts": [{"id": previous["id"] + 1,
            "name": handoff.ARTIFACT, "size_in_bytes": 8192, "expired": False,
            "workflow_run": {"id": previous["id"], "head_sha": previous["head_sha"],
                "head_branch": "main", "repository_id": 7, "head_repository_id": 7}}]}


class FakeAPI:
    def __init__(self, history):
        self.history = history
        self.job_data = {row["id"]: jobs(row) for row in history}
        self.artifact_data = {row["id"]: artifacts(row) for row in history}
        self.calls = []
        self.page_override = {}
        self.exact_runs = {row["id"]: row for row in history}

    def get(self, path):
        self.calls.append(path)
        self.assert_scope(path)
        parsed = urlsplit(path)
        if "/workflows/" in path:
            page = int(parse_qs(parsed.query)["page"][0])
            return copy.deepcopy(self.page_override.get(page, {
                "total_count": len(self.history),
                "workflow_runs": self.history[(page - 1) * 100:page * 100]}))
        parts = parsed.path.split("/")
        if parts[-1].isdecimal():
            return copy.deepcopy(self.exact_runs[int(parts[-1])])
        run_id = int(parts[-2])
        return copy.deepcopy(self.job_data[run_id] if parts[-1] == "jobs" else self.artifact_data[run_id])

    @staticmethod
    def assert_scope(path):
        if not path.startswith(f"/repos/{handoff.REPOSITORY}/actions/") or "status=queued" in path:
            raise AssertionError("Unexpected API target")


class SelectionTests(unittest.TestCase):
    def setUp(self):
        self.current = run(3, status="in_progress", conclusion=None)
        self.previous = run(2)
        self.api = FakeAPI([self.current, self.previous])

    def select(self):
        return handoff.select_checkpoint(self.api, self.current["id"])

    def test_genuine_first_source_run(self):
        self.api = FakeAPI([self.current])
        selected = self.select()
        self.assertTrue(selected["first_run"])
        self.assertIsNone(selected["previous"])

    def test_restore_exact_successful_run_and_artifact(self):
        selected = self.select()
        self.assertFalse(selected["first_run"])
        self.assertEqual(selected["previous"]["run_id"], 20)
        self.assertEqual(selected["previous"]["artifact_id"], 21)
        self.assertTrue(any("/runs/20/artifacts?" in call for call in self.api.calls))

    def test_failed_source_step_can_preserve_durable_refusal(self):
        self.previous["conclusion"] = "failure"
        self.api.job_data[20] = jobs(self.previous, "failure")
        self.assertEqual(self.select()["previous"]["run_id"], 20)

    def test_missing_artifact_after_source_failure_stops(self):
        self.api.job_data[20] = jobs(self.previous, "failure")
        self.api.artifact_data[20] = {"total_count": 0, "artifacts": []}
        with self.assertRaisesRegex(handoff.HandoffError, "no unique"):
            self.select()

    def test_cancelled_source_missing_artifact_stops(self):
        self.previous["conclusion"] = "cancelled"
        self.api.job_data[20] = jobs(self.previous, "cancelled")
        self.api.artifact_data[20] = {"total_count": 0, "artifacts": []}
        with self.assertRaises(handoff.HandoffError):
            self.select()

    def test_skip_proven_unstarted_source_step(self):
        older = run(1)
        self.api = FakeAPI([self.current, self.previous, older])
        self.api.job_data[20] = jobs(self.previous, "skipped")
        self.assertEqual(self.select()["previous"]["run_id"], 10)
        self.assertFalse(any("/runs/20/artifacts?" in call for call in self.api.calls))

    def test_only_proven_skipped_jobs_permit_first_source_run(self):
        self.api.job_data[20]["jobs"][0].update(conclusion="skipped", steps=[])
        self.assertTrue(self.select()["first_run"])

    def test_missing_job_evidence_is_not_empty_state_permission(self):
        self.api.job_data[20] = {"total_count": 0, "jobs": []}
        with self.assertRaisesRegex(handoff.HandoffError, "Cannot prove"):
            self.select()

    def test_unknown_or_nonterminal_step_stops(self):
        for steps in ([], [{"name": handoff.STEP, "status": "in_progress", "conclusion": None}]):
            with self.subTest(steps=steps):
                self.api.job_data[20]["jobs"][0]["steps"] = steps
                with self.assertRaises(handoff.HandoffError):
                    self.select()

    def test_previous_in_progress_stops_without_inflight_assumption(self):
        self.previous["status"] = "in_progress"
        with self.assertRaisesRegex(handoff.HandoffError, "not terminal"):
            self.select()

    def test_future_queued_run_is_not_assumed_unstarted(self):
        future = run(4, status="queued", conclusion=None)
        self.api = FakeAPI([future, self.current, self.previous])
        with self.assertRaisesRegex(handoff.HandoffError, "not terminal"):
            self.select()
        self.assertTrue(any("/runs/40/jobs" in call for call in self.api.calls))

    def test_delayed_old_run_cannot_rollback_newer_source_checkpoint(self):
        future = run(4)
        self.api = FakeAPI([future, self.current, self.previous])
        with self.assertRaisesRegex(handoff.HandoffError, "Newer run already"):
            self.select()
        self.assertFalse(any("/runs/20/artifacts" in call for call in self.api.calls))

    def test_later_run_proven_source_skipped_does_not_change_checkpoint(self):
        future = run(4)
        self.api = FakeAPI([future, self.current, self.previous])
        self.api.job_data[40] = jobs(future, "skipped")
        self.assertEqual(self.select()["previous"]["run_id"], 20)

    def test_waiting_source_job_proven_unstarted_under_shared_lock(self):
        future = run(4, status="in_progress", conclusion=None)
        self.api = FakeAPI([future, self.current, self.previous])
        self.api.job_data[40]["jobs"][0].update(status="queued", started_at=None, steps=[])
        self.assertEqual(self.select()["previous"]["run_id"], 20)

    def test_repository_branch_workflow_and_attempt_must_match(self):
        changes = ({"repository": {"id": 7, "full_name": "stranger/repo"}},
                   {"head_repository": {"id": 7, "full_name": "stranger/repo"}},
                   {"head_branch": "other"}, {"path": ".github/workflows/other.yml"},
                   {"workflow_id": 98}, {"run_attempt": 2}, {"head_sha": "invalid"})
        for change in changes:
            with self.subTest(change=change):
                self.previous = run(2)
                self.previous.update(change)
                self.api = FakeAPI([self.current, self.previous])
                with self.assertRaises(handoff.HandoffError):
                    self.select()

    def test_expired_wrong_duplicate_and_unrelated_artifacts_stop(self):
        for kind in ("expired", "wrong-run", "wrong-sha", "wrong-name", "duplicate", "partial"):
            with self.subTest(kind=kind):
                data = artifacts(self.previous)
                artifact = data["artifacts"][0]
                if kind == "expired":
                    artifact["expired"] = True
                elif kind == "wrong-run":
                    artifact["workflow_run"]["id"] = 10
                elif kind == "wrong-sha":
                    artifact["workflow_run"]["head_sha"] = "0" * 40
                elif kind == "wrong-name":
                    artifact["name"] = "other"
                elif kind == "duplicate":
                    data["artifacts"].append(copy.deepcopy(artifact))
                    data["total_count"] = 2
                else:
                    data["total_count"] = 2
                self.api.artifact_data[20] = data
                with self.assertRaises(handoff.HandoffError):
                    self.select()

    def test_truncated_history_never_starts_empty(self):
        self.api = FakeAPI([self.current])
        self.api.page_override[1] = {"total_count": 101, "workflow_runs": [self.current]}
        with self.assertRaisesRegex(handoff.HandoffError, "Truncated"):
            self.select()

    def test_duplicate_or_out_of_order_history_stops(self):
        self.api = FakeAPI([self.current, self.current])
        with self.assertRaises(handoff.HandoffError):
            self.select()

    def test_missing_current_history_cannot_authorize_first_run(self):
        self.api.page_override[1] = {"total_count": 0, "workflow_runs": []}
        with self.assertRaisesRegex(handoff.HandoffError, "Current run missing"):
            self.select()


class CheckpointTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.directory = Path(self.temp.name)
        self.previous = handoff.run_identity(run(2))
        self.selection = {"first_run": False, "previous": self.previous, "current": handoff.run_identity(run(3))}
        self.seal_selection = {"current": self.previous, "checkout_sha": "a" * 40}
        self.state = initial_state()

    def tearDown(self):
        self.temp.cleanup()

    def write_db(self):
        db_path = self.directory / handoff.DB_NAME
        if db_path.exists():
            db_path.unlink()
        with sqlite3.connect(db_path) as connection:
            connection.execute("CREATE TABLE state (id INTEGER PRIMARY KEY, payload TEXT NOT NULL)")
            connection.execute("CREATE TABLE events (id TEXT PRIMARY KEY, payload TEXT NOT NULL)")
            connection.execute("INSERT INTO state VALUES (1, ?)", (json.dumps(self.state),))
        connection.close()
        return db_path

    def prepare(self):
        self.write_db()
        handoff.seal_checkpoint(self.directory, self.seal_selection)

    def test_roundtrip_uses_core_integrity_and_schema_validation(self):
        self.prepare()
        handoff.validate_checkpoint(self.directory, self.selection)

    def test_core_wal_store_to_seal_to_restore_normal_and_stopped(self):
        for stopped in (False, True):
            with self.subTest(stopped=stopped), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                db_path = root / handoff.DB_NAME
                store = Store(db_path)
                state = dict(store.state)
                state.update(stopped=stopped, status="stopped" if stopped else "unavailable",
                             errorCode="http_403" if stopped else None)
                store.save(state)
                store.close()
                self.assertEqual(inspect_checkpoint(db_path)["stopped"], stopped)
                handoff.seal_checkpoint(root, self.seal_selection)
                handoff.validate_checkpoint(root, self.selection)
                restored = Store(db_path)
                self.assertEqual(restored.state["stopped"], stopped)
                self.assertFalse(restored.state["runActive"])
                restored.close()

    def test_durable_stop_restores_without_reset(self):
        self.state.update(stopped=True, status="stopped", errorCode="http_403")
        self.prepare()
        handoff.validate_checkpoint(self.directory, self.selection)
        self.assertTrue(json.loads((self.directory / handoff.MANIFEST).read_text())["stopped"])

    def test_interrupted_checkpoint_is_preserved_but_rejected(self):
        self.state["runActive"] = True
        self.write_db()
        with self.assertRaisesRegex(handoff.HandoffError, "Interrupted"):
            handoff.seal_checkpoint(self.directory, self.seal_selection)
        self.assertTrue((self.directory / handoff.MANIFEST).exists())
        with self.assertRaisesRegex(handoff.HandoffError, "interrupted"):
            handoff.validate_checkpoint(self.directory, self.selection)

    def test_old_or_wrong_manifest_identity_stops(self):
        self.prepare()
        path = self.directory / handoff.MANIFEST
        original = json.loads(path.read_text())
        for key in ("run_id", "run_attempt", "repository", "workflow_id", "head_sha", "portfolio_id"):
            with self.subTest(key=key):
                changed = dict(original, **{key: "wrong"})
                path.write_text(json.dumps(changed))
                with self.assertRaises(handoff.HandoffError):
                    handoff.validate_checkpoint(self.directory, self.selection)

    def test_changed_database_hash_stops(self):
        self.prepare()
        with (self.directory / handoff.DB_NAME).open("ab") as stream:
            stream.write(b"tamper")
        with self.assertRaisesRegex(handoff.HandoffError, "checksum"):
            handoff.validate_checkpoint(self.directory, self.selection)

    def test_missing_files_never_reset(self):
        with self.assertRaises(handoff.HandoffError):
            handoff.validate_checkpoint(self.directory, self.selection)

    def test_first_run_allows_only_empty_directory(self):
        first = {"first_run": True, "previous": None}
        handoff.validate_checkpoint(self.directory, first)
        self.write_db()
        with self.assertRaises(handoff.HandoffError):
            handoff.validate_checkpoint(self.directory, first)

    def test_sqlite_journal_cannot_be_omitted_from_artifact(self):
        self.write_db()
        (self.directory / (handoff.DB_NAME + "-wal")).write_bytes(b"pending")
        with self.assertRaisesRegex(handoff.HandoffError, "sidecar"):
            handoff.seal_checkpoint(self.directory, self.seal_selection)

    def test_symlink_state_rejected(self):
        actual = self.directory / "other"
        actual.write_bytes(b"not a database")
        (self.directory / handoff.DB_NAME).symlink_to(actual)
        with self.assertRaises(handoff.HandoffError):
            handoff.seal_checkpoint(self.directory, self.seal_selection)

    def test_malformed_database_rejected_even_with_matching_hash(self):
        self.prepare()
        db = self.directory / handoff.DB_NAME
        db.write_bytes(b"invalid sqlite")
        path = self.directory / handoff.MANIFEST
        manifest = json.loads(path.read_text())
        manifest["sha256"] = handoff.file_hash(db)
        path.write_text(json.dumps(manifest))
        with self.assertRaises(Exception):
            handoff.validate_checkpoint(self.directory, self.selection)

    def test_peer_target_only_stops_do_not_stop_other_portfolios(self):
        for code in ("positions_not_public", "inactive", "identity_mismatch"):
            with self.subTest(code=code):
                self.state.update(stopped=True, status="stopped", errorCode=code)
                self.prepare()
                self.assertTrue(handoff.peer_allowed(self.directory, self.selection))

    def test_peer_propagates_global_refusals(self):
        for code in ("http_202", "http_401", "http_403", "http_418", "http_429", "http_451", "source_error_123"):
            with self.subTest(code=code):
                self.state.update(stopped=True, status="stopped", errorCode=code)
                self.prepare()
                self.assertFalse(handoff.peer_allowed(self.directory, self.selection))

    def test_peer_unknown_stop_is_not_ignored(self):
        self.state.update(stopped=True, status="stopped", errorCode="schema_changed")
        self.prepare()
        with self.assertRaisesRegex(handoff.HandoffError, "unknown source scope"):
            handoff.peer_allowed(self.directory, self.selection)

    def test_peer_proven_no_source_history_allows_existing_collector(self):
        self.assertTrue(handoff.peer_allowed(self.directory, {"first_run": True, "previous": None}))


class PeerSelectionTests(unittest.TestCase):
    def setUp(self):
        self.caller = run(100, status="in_progress", conclusion=None)
        self.caller.update(path=".github/workflows/refresh-traders.yml", workflow_id=98)
        self.prior = run(2)
        self.api = FakeAPI([self.prior])
        self.api.exact_runs[self.caller["id"]] = self.caller

    def select(self):
        return handoff.select_peer(self.api, self.caller["id"])

    def test_peer_restores_exact_latest_source_run(self):
        selected = self.select()
        self.assertEqual(selected["previous"]["run_id"], 20)
        self.assertEqual(selected["previous"]["artifact_id"], 21)

    def test_peer_zero_history_is_proven(self):
        self.api.history = []
        self.assertTrue(self.select()["first_run"])

    def test_peer_disabled_monitor_job_does_not_block_existing_accounts(self):
        self.api.job_data[20]["jobs"][0].update(conclusion="skipped", steps=[])
        self.api.artifact_data[20] = {"total_count": 0, "artifacts": []}
        self.assertTrue(self.select()["first_run"])
        self.assertFalse(any("/artifacts?" in path for path in self.api.calls))

    def test_peer_waiting_new_monitor_does_not_hide_older_stop(self):
        waiting = run(3, status="in_progress", conclusion=None)
        self.api = FakeAPI([waiting, self.prior])
        self.api.exact_runs[self.caller["id"]] = self.caller
        self.api.job_data[30]["jobs"][0].update(status="queued", started_at=None, steps=[])
        self.assertEqual(self.select()["previous"]["run_id"], 20)

    def test_peer_offline_tests_only_proves_source_job_not_created(self):
        self.prior["status"] = "in_progress"
        self.api.job_data[20] = {"total_count": 1, "jobs": [{"name": "Offline monitor tests",
            "run_id": 20, "status": "in_progress", "steps": []}]}
        self.assertTrue(self.select()["first_run"])

    def test_peer_inprogress_source_is_not_assumed_safe(self):
        self.prior["status"] = "in_progress"
        self.api.job_data[20]["jobs"][0]["status"] = "in_progress"
        with self.assertRaises(handoff.HandoffError):
            self.select()

    def test_peer_missing_artifact_and_truncated_history_stop(self):
        self.api.artifact_data[20] = {"total_count": 0, "artifacts": []}
        with self.assertRaises(handoff.HandoffError):
            self.select()
        self.api.page_override[1] = {"total_count": 101, "workflow_runs": []}
        with self.assertRaises(handoff.HandoffError):
            self.select()

    def test_peer_caller_must_be_exact_existing_collector(self):
        self.caller["path"] = handoff.WORKFLOW
        with self.assertRaises(handoff.HandoffError):
            self.select()


class BudgetTests(unittest.TestCase):
    def test_scheduled_budget_shrinks_and_expires(self):
        now = datetime(2026, 11, 10, 17, 0, tzinfo=timezone.utc)
        for elapsed, expected in ((0, 840), (40, 800), (839, 1), (840, 0), (3600, 0)):
            with self.subTest(elapsed=elapsed):
                created = (now - timedelta(seconds=elapsed)).isoformat()
                self.assertEqual(handoff.budget_seconds("schedule", "14", created, now), expected)

    def test_push_and_manual_runtime_remain_bounded(self):
        self.assertEqual(handoff.budget_seconds("push", "14", None), 60)
        self.assertEqual(handoff.budget_seconds("workflow_dispatch", "1", None), 60)
        self.assertEqual(handoff.budget_seconds("workflow_dispatch", "14", None), 840)
        for minutes in ("0", "15", "1.5", "oops"):
            with self.subTest(minutes=minutes), self.assertRaises(handoff.HandoffError):
                handoff.budget_seconds("workflow_dispatch", minutes, None)

    def test_invalid_or_future_schedule_time_stops(self):
        now = datetime(2026, 11, 10, 17, 0, tzinfo=timezone.utc)
        for created in (None, "bad", "2026-11-10T17:00:00", (now + timedelta(minutes=2)).isoformat()):
            with self.subTest(created=created), self.assertRaises(handoff.HandoffError):
                handoff.budget_seconds("schedule", "14", created, now)


class CommandTests(unittest.TestCase):
    def test_active_hold_never_constructs_api(self):
        with tempfile.TemporaryDirectory() as temp:
            for command in ("select", "select-peer"):
                argv = ["actions_state.py", command, "--directory", temp, "--selection", str(Path(temp) / "selection.json")]
                with patch.dict(os.environ, {"GITHUB_REPOSITORY": handoff.REPOSITORY}), patch("sys.argv", argv), patch.object(handoff, "GitHub") as api:
                    self.assertEqual(handoff.main(), 2)
                    api.assert_not_called()

    def test_runtime_selection_is_bounded(self):
        for event, minutes, expected in (("push", "14", 60), ("schedule", "14", 840),
                                          ("workflow_dispatch", "2", 120)):
            with self.subTest(event=event), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                current = run(1, status="in_progress", conclusion=None)
                current["event"] = event
                environment = {"GITHUB_REPOSITORY": handoff.REPOSITORY, "GITHUB_RUN_ID": "10",
                    "GITHUB_RUN_ATTEMPT": "1", "GITHUB_EVENT_NAME": event, "WATCH_MINUTES": minutes,
                    "GITHUB_OUTPUT": str(root / "output"), "GH_TOKEN": "fixture-only",
                    "WATCH_CHECKOUT_SHA": "a" * 40}
                argv = ["actions_state.py", "select", "--directory", str(root / "state"),
                        "--selection", str(root / "selection.json")]
                with patch.dict(os.environ, environment), patch("sys.argv", argv), \
                        patch.object(handoff.source_holds, "reason", return_value=None), patch.object(handoff, "GitHub", return_value=FakeAPI([current])):
                    self.assertEqual(handoff.main(), 0)
                output = (root / "output").read_text()
                if event == "schedule":
                    self.assertRegex(output, r"duration_seconds=8(39|40)\n")
                else:
                    self.assertIn(f"duration_seconds={expected}\n", output)

    def test_workflow_pr_is_offline_and_no_pages_or_writes(self):
        workflow = Path(__file__).resolve().parents[2] / ".github/workflows/binance-python-watch.yml"
        text = workflow.read_text()
        self.assertIn("github.event_name != 'pull_request'", text)
        self.assertIn("needs: test", text)
        self.assertIn("--interval 5", text)
        self.assertNotIn("\n  schedule:", text)
        self.assertIn("Proposed schedule for later code review: 3,18,33,48 * * * *", text)
        self.assertIn("if: ${{ false && github.event_name != 'pull_request'", text)
        self.assertNotIn("contents: write", text)
        self.assertNotIn("group: pages", text)
        self.assertIn("$RUNNER_TEMP/binance-watch", text)
        self.assertIn("run-id: ${{ steps.prior.outputs.restore_run_id }}", text)
        self.assertIn("group: binance-public-source", text)
        self.assertIn("node scripts/binance_run_guard.cjs", text)
        self.assertIn("steps.budget.outputs.duration_seconds", text)
        self.assertLess(text.index("Recheck remaining schedule budget"), text.index("- name: Poll public positions"))

    def test_runner_context_is_not_used_in_job_environment(self):
        workflow = Path(__file__).resolve().parents[2] / ".github/workflows/binance-python-watch.yml"
        text = workflow.read_text()
        in_job_env = False
        for line in text.splitlines():
            if line == "    env:":
                in_job_env = True
            elif line.strip() and not line.startswith("      "):
                in_job_env = False
            if in_job_env:
                self.assertNotIn("runner.", line, "Runner context is unavailable in job-level env")
        initialization = text.split("- name: Initialize runner state paths", 1)[1].split("\n      - ", 1)[0]
        self.assertIn('"$RUNNER_TEMP/binance-watch" >> "$GITHUB_ENV"', initialization)
        self.assertIn('"$RUNNER_TEMP/binance-watch-selection.json" >> "$GITHUB_ENV"', initialization)
        self.assertLess(text.index("Initialize runner state paths"), text.index("Select exact prior checkpoint"))

    def test_old_collector_shares_lock_and_skips_binance_if_peer_not_allowed(self):
        workflow = Path(__file__).resolve().parents[2] / ".github/workflows/refresh-traders.yml"
        text = workflow.read_text()
        self.assertIn("|| 'binance-public-source'", text)
        self.assertIn("format('binance-ui-only-{0}-{1}'", text)
        for step_name in ("Select the latest Python Binance source checkpoint", "Restore the exact Python Binance source checkpoint",
                          "Validate the Python Binance global source-stop state", "Collect the public Binance lead sample"):
            section = text.split(f"- name: {step_name}", 1)[1].split("\n      - ", 1)[0]
            self.assertIn("steps.refresh-mode.outputs.mode != 'skip'", section)
            if step_name == "Collect the public Binance lead sample":
                self.assertIn("steps.binance-peer-validate.outputs.allowed == 'true'", section)
            else:
                self.assertIn("continue-on-error: true", section)
        report = text.split("- name: Report blocked Binance collection", 1)[1].split("\n      - ", 1)[0]
        self.assertNotIn("BINANCE_PREVIOUS_RUN_UNVERIFIED", report)


if __name__ == "__main__":
    unittest.main()
