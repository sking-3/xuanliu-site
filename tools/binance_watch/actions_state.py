"""Fail-closed, exact-run checkpoint handoff for the bounded Actions monitor.

Only the GitHub API is used here. This module never requests exchange data.
"""
from __future__ import annotations

import argparse
import source_holds
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
from datetime import datetime, timezone
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import HTTPRedirectHandler, Request, build_opener

REPOSITORY = "sking-3/xuanliu-site"
WORKFLOW = ".github/workflows/binance-python-watch.yml"
JOB = "Monitor public positions"
STEP = "Poll public positions"
ARTIFACT = "binance-watch-state"
PORTFOLIO = "5075281354358777856"
DB_NAME = "state.sqlite3"
MANIFEST = "checkpoint.json"
MAX_DB_BYTES = 64 * 1024 * 1024


class HandoffError(RuntimeError):
    pass


def require(condition, message):
    if not condition:
        raise HandoffError(message)


def positive_int(value):
    return isinstance(value, int) and not isinstance(value, bool) and value > 0


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise HandoffError("GitHub API redirect refused")


class GitHub:
    def __init__(self, token):
        require(bool(token), "Actions token is missing")
        self.token = token
        self.opener = build_opener(NoRedirect())

    def get(self, path):
        require(path.startswith(f"/repos/{REPOSITORY}/actions/"), "Unexpected GitHub API path")
        request = Request("https://api.github.com" + path, headers={
            "Authorization": "Bearer " + self.token,
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "xuanliu-binance-watch-checkpoint",
        })
        try:
            with self.opener.open(request, timeout=20) as response:
                body = response.read(4 * 1024 * 1024 + 1)
                require(len(body) <= 4 * 1024 * 1024, "GitHub response is too large")
                result = json.loads(body)
        except (HTTPError, URLError, TimeoutError, ValueError) as error:
            # Do not print response bodies, request headers, or the token.
            raise HandoffError(f"GitHub API request failed ({type(error).__name__})") from None
        require(isinstance(result, dict), "Invalid GitHub response")
        return result


def run_identity(run, workflow_id=None, repository_id=None, workflow_path=WORKFLOW):
    require(isinstance(run, dict), "Invalid run metadata")
    repo = run.get("repository") or {}
    head_repo = run.get("head_repository") or {}
    require(repo.get("full_name") == REPOSITORY and head_repo.get("full_name") == REPOSITORY,
            "Run repository does not match")
    require(positive_int(repo.get("id")) and head_repo.get("id") == repo["id"], "Invalid repository identity")
    require(repository_id is None or repo["id"] == repository_id, "Repository identity changed")
    for field in ("id", "run_number", "workflow_id"):
        require(positive_int(run.get(field)), f"Invalid run {field}")
    require(run.get("run_attempt") == 1, "Rerun checkpoint handoff requires review")
    require(run.get("path") == workflow_path, "Unexpected workflow path")
    require(workflow_id is None or run["workflow_id"] == workflow_id, "Workflow identity changed")
    require(run.get("head_branch") == "main", "Monitor runs must use main")
    require(run.get("event") in {"push", "schedule", "workflow_dispatch"}, "Unexpected monitor event")
    require(isinstance(run.get("head_sha"), str) and re.fullmatch(r"[0-9a-f]{40}", run["head_sha"]),
            "Invalid run commit")
    return {"repository": REPOSITORY, "repository_id": repo["id"], "run_id": run["id"],
            "run_attempt": 1, "workflow_id": run["workflow_id"], "head_sha": run["head_sha"]}


def source_step_started(api, run):
    data = api.get(f"/repos/{REPOSITORY}/actions/runs/{run['id']}/jobs?per_page=100")
    jobs = data.get("jobs")
    require(isinstance(jobs, list) and data.get("total_count") == len(jobs), "Incomplete job history")
    matching = [job for job in jobs if job.get("name") == JOB]
    if run.get("status") != "completed":
        # Both callers hold the same source job lock. Complete job metadata may
        # prove the source job is still waiting, or only offline tests exist.
        if not matching and jobs and all(job.get("name") == "Offline monitor tests" and
                                        job.get("run_id") == run["id"] for job in jobs):
            return False
        if len(matching) == 1:
            waiting = matching[0]
            if (waiting.get("run_id") == run["id"] and waiting.get("status") in {"queued", "waiting", "pending"}
                    and waiting.get("started_at") is None and not waiting.get("steps")):
                return False
        raise HandoffError("Earlier monitor run is not terminal and no safe waiting proof exists")
    require(len(matching) == 1, "Cannot prove whether the earlier monitor ran")
    job = matching[0]
    require(job.get("run_id") == run["id"] and job.get("status") == "completed", "Invalid prior job identity")
    if job.get("conclusion") == "skipped":
        return False
    steps = [step for step in job.get("steps", []) if step.get("name") == STEP]
    require(len(steps) == 1, "Earlier source step state is unknown")
    step = steps[0]
    if step.get("conclusion") == "skipped":
        return False
    require(step.get("status") == "completed" and step.get("conclusion") in
            {"success", "failure", "cancelled", "timed_out"}, "Earlier source step is not terminal")
    return True


def prior_artifact(api, run, identity):
    data = api.get(f"/repos/{REPOSITORY}/actions/runs/{run['id']}/artifacts?per_page=100")
    artifacts = data.get("artifacts")
    require(isinstance(artifacts, list) and data.get("total_count") == len(artifacts), "Incomplete artifact listing")
    matches = [artifact for artifact in artifacts if artifact.get("name") == ARTIFACT]
    require(len(matches) == 1, "Previous run has no unique durable checkpoint; monitoring stopped")
    artifact = matches[0]
    require(positive_int(artifact.get("id")) and artifact.get("expired") is False,
            "Previous checkpoint expired or has invalid identity")
    size = artifact.get("size_in_bytes")
    require(positive_int(size) and size <= MAX_DB_BYTES + 65536, "Invalid checkpoint artifact size")
    origin = artifact.get("workflow_run") or {}
    require(origin.get("id") == run["id"] and origin.get("head_sha") == identity["head_sha"] and
            origin.get("head_branch") == "main" and origin.get("repository_id") == identity["repository_id"] and
            origin.get("head_repository_id") == identity["repository_id"], "Checkpoint artifact belongs to another run")
    return artifact["id"]


def select_checkpoint(api, current_id, current=None):
    base = f"/repos/{REPOSITORY}/actions"
    current = current or api.get(f"{base}/runs/{current_id}")
    identity = run_identity(current)
    require(current["id"] == current_id and current.get("status") == "in_progress", "Current run is not active")
    previous_number = float("inf")
    seen = set()
    total = None
    observed = 0
    for page in range(1, 11):
        query = urlencode({"branch": "main", "exclude_pull_requests": "true", "per_page": 100, "page": page})
        data = api.get(f"{base}/workflows/binance-python-watch.yml/runs?{query}")
        runs = data.get("workflow_runs")
        count = data.get("total_count")
        require(isinstance(runs, list) and isinstance(count, int) and count >= 0, "Invalid workflow history")
        if total is None:
            total = count
        require(total == count, "Workflow history changed during selection; try a later scheduled run")
        observed += len(runs)
        for run in runs:
            require(positive_int(run.get("id")) and positive_int(run.get("run_number")), "Invalid history entry")
            require(run["id"] not in seen and run["run_number"] < previous_number, "Unordered or repeated workflow history")
            previous_number = run["run_number"]
            seen.add(run["id"])
            if run["id"] == current_id:
                continue
            if run.get("event") == "pull_request":
                continue
            prior = run_identity(run, identity["workflow_id"], identity["repository_id"])
            if run["run_number"] >= current["run_number"]:
                # Concurrency serializes jobs but does not promise FIFO. An old
                # delayed run must never roll back a newer source checkpoint.
                require(run["run_number"] > current["run_number"], "Conflicting run number")
                require(not source_step_started(api, run),
                        "Newer run already attempted the source; delayed run stopped")
                continue
            if not source_step_started(api, run):
                continue  # Job/step evidence proves no source request began.
            prior["artifact_id"] = prior_artifact(api, run, prior)
            return {"schemaVersion": 1, "current": identity, "previous": prior, "first_run": False}
        if observed == total:
            require(current_id in seen, "Current run missing from complete workflow history")
            return {"schemaVersion": 1, "current": identity, "previous": None, "first_run": True}
        require(len(runs) == 100 and observed < total, "Truncated workflow history; cannot start empty")
    raise HandoffError("Workflow history exceeds verification limit; cannot start empty")


def select_peer(api, current_id):
    """Read the watch's last source checkpoint before the other collector runs."""
    base = f"/repos/{REPOSITORY}/actions"
    caller = api.get(f"{base}/runs/{current_id}")
    identity = run_identity(caller, workflow_path=".github/workflows/refresh-traders.yml")
    require(caller["id"] == current_id and caller.get("status") == "in_progress", "Peer caller is not active")
    seen, total, observed, previous_number, workflow_id = set(), None, 0, float("inf"), None
    for page in range(1, 11):
        query = urlencode({"branch": "main", "exclude_pull_requests": "true", "per_page": 100, "page": page})
        data = api.get(f"{base}/workflows/binance-python-watch.yml/runs?{query}")
        runs, count = data.get("workflow_runs"), data.get("total_count")
        require(isinstance(runs, list) and isinstance(count, int) and count >= 0, "Invalid peer workflow history")
        if total is None:
            total = count
        require(total == count, "Peer workflow history changed during selection")
        observed += len(runs)
        for run in runs:
            require(positive_int(run.get("id")) and positive_int(run.get("run_number")), "Invalid peer history entry")
            require(run["id"] not in seen and run["run_number"] < previous_number, "Unordered peer history")
            seen.add(run["id"])
            previous_number = run["run_number"]
            if run.get("event") == "pull_request":
                continue
            previous = run_identity(run, workflow_id, identity["repository_id"])
            workflow_id = previous["workflow_id"]
            if not source_step_started(api, run):
                continue
            previous["artifact_id"] = prior_artifact(api, run, previous)
            return {"schemaVersion": 1, "current": identity, "previous": previous, "first_run": False}
        if observed == total:
            return {"schemaVersion": 1, "current": identity, "previous": None, "first_run": True}
        require(len(runs) == 100 and observed < total, "Truncated peer history")
    raise HandoffError("Peer workflow history exceeds verification limit")


def budget_seconds(event, minutes, created_at, now=None):
    require(event in {"push", "schedule", "workflow_dispatch"}, "Unexpected execution event")
    require(str(minutes).isdecimal() and 1 <= int(minutes) <= 14, "Duration must be 1–14 minutes")
    if event != "schedule":
        return 60 if event == "push" else int(minutes) * 60
    try:
        created = datetime.fromisoformat(created_at.replace("Z", "+00:00"))
        require(created.tzinfo is not None, "Run creation time lacks timezone")
        now = now or datetime.now(timezone.utc)
        remaining = 840 - (now - created).total_seconds()
    except (ValueError, TypeError, AttributeError):
        raise HandoffError("Invalid scheduled run creation time") from None
    require(remaining <= 870, "Run creation time is in the future")
    return max(0, min(840, int(remaining)))


def checked_file(path, limit):
    require(path.exists() and not path.is_symlink(), f"Checkpoint file missing or unsafe: {path.name}")
    info = path.stat()
    require(stat.S_ISREG(info.st_mode) and 0 < info.st_size <= limit, f"Invalid checkpoint file: {path.name}")
    return path


def file_hash(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def inspect(path):
    from monitor import inspect_checkpoint
    return inspect_checkpoint(path)


def validate_checkpoint(directory, selection, inspector=inspect):
    db = directory / DB_NAME
    manifest_path = directory / MANIFEST
    if selection.get("first_run") is True:
        require(selection.get("previous") is None and not db.exists() and not manifest_path.exists(),
                "First-run state must be empty")
        return
    previous = selection.get("previous")
    require(isinstance(previous, dict), "Previous checkpoint identity missing")
    manifest = json.loads(checked_file(manifest_path, 16384).read_text())
    require(manifest.get("schemaVersion") == 1 and manifest.get("portfolio_id") == PORTFOLIO,
            "Checkpoint schema or target mismatch")
    for key in ("repository", "run_id", "run_attempt", "workflow_id", "head_sha"):
        require(manifest.get(key) == previous.get(key), f"Checkpoint {key} mismatch")
    checked_file(db, MAX_DB_BYTES)
    require(manifest.get("sha256") == file_hash(db), "Checkpoint checksum mismatch")
    state = inspector(db)
    require(state.get("portfolioId") == PORTFOLIO, "Database portfolio mismatch")
    require(state.get("runActive") is False and manifest.get("terminal") is True,
            "Previous monitor was interrupted; checkpoint requires review")
    require(state.get("stopped") == manifest.get("stopped"), "Stop-state metadata mismatch")
    require(isinstance(manifest.get("checkout_sha"), str) and re.fullmatch(r"[0-9a-f]{40}", manifest["checkout_sha"]),
            "Actual checkout identity missing")
    return state


def peer_allowed(directory, selection):
    state = validate_checkpoint(directory, selection)
    if state is None or not state["stopped"]:
        return True
    code = state.get("errorCode") or ""
    if re.fullmatch(r"http_(202|401|403|418|429|451)", code) or code.startswith("source_error_"):
        return False
    if code in {"positions_not_public", "inactive", "identity_mismatch"}:
        return True
    raise HandoffError("Stopped peer checkpoint has unknown source scope; no request allowed")


def seal_checkpoint(directory, selection, inspector=inspect):
    db = checked_file(directory / DB_NAME, MAX_DB_BYTES)
    # A read-only inspection of a WAL-mode database can leave a zero-byte WAL
    # and an SHM index. Neither contains uncheckpointed transactions.
    for suffix in ("-wal", "-journal"):
        sidecar = Path(str(db) + suffix)
        require(not sidecar.is_symlink() and (not sidecar.exists() or sidecar.stat().st_size == 0),
                "Uncheckpointed SQLite sidecar exists")
    state = inspector(db)
    require(state.get("portfolioId") == PORTFOLIO, "Cannot seal a different portfolio")
    manifest = dict(selection["current"])
    checkout_sha = selection.get("checkout_sha")
    require(isinstance(checkout_sha, str) and re.fullmatch(r"[0-9a-f]{40}", checkout_sha), "Actual checkout identity missing")
    manifest.update(schemaVersion=1, portfolio_id=PORTFOLIO, sha256=file_hash(db),
                    terminal=state.get("runActive") is False, stopped=state.get("stopped"),
                    sealed_at=datetime.now(timezone.utc).isoformat(), checkout_sha=checkout_sha)
    (directory / MANIFEST).write_text(json.dumps(manifest, sort_keys=True) + "\n")
    require(manifest["terminal"], "Interrupted state preserved; future monitoring will stop")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("select", "validate", "seal", "budget", "select-peer", "validate-peer"))
    parser.add_argument("--directory", type=Path, required=True)
    parser.add_argument("--selection", type=Path, required=True)
    args = parser.parse_args()
    try:
        require(os.environ.get("GITHUB_REPOSITORY") == REPOSITORY, "This workflow is restricted to its owning repository")
        if args.command in {"select", "select-peer"}:
            hold = source_holds.reason("githubRunInventory")
            require(hold is None, f"Run inventory disabled: {hold}")
            run_id = os.environ.get("GITHUB_RUN_ID", "")
            require(run_id.isdecimal() and int(run_id) > 0, "Invalid current run ID")
            require(os.environ.get("GITHUB_RUN_ATTEMPT") == "1", "Reruns cannot reset checkpoint state")
            api = GitHub(os.environ.get("GH_TOKEN", ""))
            duration = None
            if args.command == "select-peer":
                selection = select_peer(api, int(run_id))
            else:
                current = api.get(f"/repos/{REPOSITORY}/actions/runs/{run_id}")
                identity = run_identity(current)
                require(current["id"] == int(run_id) and current.get("status") == "in_progress", "Current run is not active")
                event, minutes = os.environ.get("GITHUB_EVENT_NAME"), os.environ.get("WATCH_MINUTES", "14")
                require(event == current["event"], "Execution event mismatch")
                duration = budget_seconds(event, minutes, current.get("created_at"))
                selection = (select_checkpoint(api, int(run_id), current) if duration else
                             {"schemaVersion": 1, "current": identity, "previous": None, "first_run": False})
                selection.update(event=event, minutes=minutes, created_at=current.get("created_at"),
                                 checkout_sha=os.environ.get("WATCH_CHECKOUT_SHA"))
                require(isinstance(selection["checkout_sha"], str) and re.fullmatch(r"[0-9a-f]{40}", selection["checkout_sha"]),
                        "Actual checkout commit is missing")
            args.directory.mkdir(parents=True, exist_ok=True)
            args.selection.write_text(json.dumps(selection))
            previous = selection["previous"]
            with open(os.environ["GITHUB_OUTPUT"], "a") as output:
                output.write(f"restore_run_id={previous['run_id'] if previous else ''}\n")
                output.write(f"restore_artifact_id={previous['artifact_id'] if previous else ''}\n")
                if duration is not None:
                    output.write(f"duration_seconds={duration}\n")
            print("Scheduled run budget expired; source step will be skipped" if duration == 0 else
                  "Verified no prior source attempt" if previous is None else f"Restore exact checkpoint from run {previous['run_id']}")
        else:
            selection = json.loads(checked_file(args.selection, 16384).read_text())
            if args.command == "validate":
                validate_checkpoint(args.directory, selection)
                print("Checkpoint handoff validated")
            elif args.command == "validate-peer":
                allowed = peer_allowed(args.directory, selection)
                with open(os.environ["GITHUB_OUTPUT"], "a") as output:
                    output.write(f"allowed={'true' if allowed else 'false'}\n")
                print("Peer checkpoint allows other portfolios" if allowed else "Global source refusal preserved; other collector must skip")
            elif args.command == "budget":
                duration = budget_seconds(selection["event"], selection["minutes"], selection["created_at"])
                with open(os.environ["GITHUB_OUTPUT"], "a") as output:
                    output.write(f"duration_seconds={duration}\n")
                print(f"Remaining monitor budget: {duration} seconds")
            else:
                seal_checkpoint(args.directory, selection)
                print("Terminal checkpoint sealed")
    except Exception as error:
        print(f"Checkpoint handoff stopped: {error}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
