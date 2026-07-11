#!/usr/bin/env python3
"""Deterministic, allowlisted ccc-node three-node rollout runbook.

Installed root-owned as /usr/local/libexec/a2a-ccc-node-rollout. The worker
adapter supplies only validated arguments; this runbook uses a fixed node set,
repository, service, test set, and SSH client. Each mutating phase is idempotent
by task/run/phase state. It prints exactly one structured JSON result.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import sys
import tempfile
from typing import Any

SCHEMA = "a2a.live-runbook-phase-result.v1"
RUNBOOK_ID = "ccc-node-3node-rollout-v1"
NODES = ("dungae", "nosuk", "soonwook")
REPO = "/opt/ccc-node"
SERVICE = "ccc-telegram-bridge.service"
SSH = "/usr/bin/ssh"
BASH = "/bin/bash"
STATE_ROOT = Path("/var/lib/a2a-live-runbooks/ccc-node-3node-rollout-v1")
SAFE_ID = re.compile(r"^[A-Za-z0-9._:-]{1,160}$")
SHA40 = re.compile(r"^[a-f0-9]{40}$")
TARGET = re.compile(r"^ccc-node:fleet:([a-f0-9]{40})$")


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--phase", required=True, choices=("preflight", "apply", "verify", "rollback"))
    parser.add_argument("--task-id", required=True)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--action", required=True, choices=("promote_to_live_apply", "promote_to_live_rollback"))
    parser.add_argument("--runbook-id", required=True)
    parser.add_argument("--target", required=True)
    parser.add_argument("--target-sha", required=True)
    parser.add_argument("--worker-id", required=True)
    parser.add_argument("--receipt-mac", required=True)
    args = parser.parse_args(argv)
    if not SAFE_ID.fullmatch(args.task_id) or not SAFE_ID.fullmatch(args.run_id):
        parser.error("task-id and run-id must be canonical identifiers")
    if args.runbook_id != RUNBOOK_ID or args.worker_id != "nosuk":
        parser.error("runbook or worker is not allowlisted")
    target = TARGET.fullmatch(args.target)
    if not target or not SHA40.fullmatch(args.target_sha) or target.group(1) != args.target_sha:
        parser.error("target must bind the exact full target SHA")
    if not re.fullmatch(r"[a-f0-9]{64}", args.receipt_mac):
        parser.error("receipt MAC must be 64 lowercase hex characters")
    if args.action == "promote_to_live_apply" and args.phase == "rollback":
        parser.error("apply approval cannot invoke rollback")
    if args.action == "promote_to_live_rollback" and args.phase in ("apply",):
        parser.error("rollback approval cannot invoke apply")
    return args


def remote_script(phase: str, target_sha: str, action: str) -> str:
    common = f"""
set -euo pipefail
cd {REPO}
remote=$(git remote get-url origin)
case "$remote" in *github.com/jinwon-int/ccc-node*) ;; *) echo BAD_REMOTE >&2; exit 41;; esac
tracked=$(git status --porcelain --untracked-files=no)
[ -z "$tracked" ] || {{ echo TRACKED_DIRTY >&2; exit 42; }}
git fetch origin main --quiet
git cat-file -e {target_sha}^{{commit}}
old=$(git rev-parse HEAD)
"""
    probes = f"""
state=$(systemctl is-active {SERVICE} 2>/dev/null || true)
pid=$(systemctl show -p MainPID --value {SERVICE} 2>/dev/null || true)
restarts=$(systemctl show -p NRestarts --value {SERVICE} 2>/dev/null || true)
head=$(git rev-parse HEAD)
origin=$(git rev-parse origin/main)
printf 'old=%s\nhead=%s\norigin=%s\nservice=%s\npid=%s\nrestarts=%s\n' "$old" "$head" "$origin" "$state" "$pid" "$restarts"
"""
    if phase == "preflight":
        apply_gate = f'[ "$(git rev-parse origin/main)" = "{target_sha}" ] || {{ echo TARGET_NOT_ORIGIN_MAIN >&2; exit 43; }}\n' if action == "promote_to_live_apply" else ""
        return common + apply_gate + f"systemctl is-active --quiet {SERVICE}\n" + probes
    if phase in ("apply", "rollback"):
        mutation = (
            f"git merge --ff-only {target_sha}\n"
            if phase == "apply"
            else f"git reset --hard {target_sha}\n"
        )
        return common + mutation + f"""
python3 -m py_compile bridge/core/*.py bridge/utils/*.py bridge/session/*.py bridge/interaction/*.py
if [ -x bridge/venv/bin/python ] && bridge/venv/bin/python -c 'import pytest' >/dev/null 2>&1; then PY=bridge/venv/bin/python; else PY=python3; fi
$PY -c 'import pytest' >/dev/null 2>&1
$PY -m pytest -q bridge/tests/test_revert.py bridge/tests/test_watchdog.py bridge/tests/test_project_chat_retry.py
command -v shellcheck >/dev/null
command -v jq >/dev/null
bash scripts/validate-harness.sh
systemctl restart {SERVICE}
for i in 1 2 3 4 5; do systemctl is-active --quiet {SERVICE} && break; sleep 1; done
systemctl is-active --quiet {SERVICE}
[ "$(git rev-parse HEAD)" = "{target_sha}" ]
""" + probes
    if phase == "verify":
        return common + f"""
[ "$(git rev-parse HEAD)" = "{target_sha}" ]
systemctl is-active --quiet {SERVICE}
[ "$(systemctl show -p NRestarts --value {SERVICE} 2>/dev/null || echo 1)" = "0" ]
""" + probes
    raise ValueError(f"unsupported phase: {phase}")


def run_node(node: str, script: str) -> dict[str, str]:
    local_names = {socket.gethostname().split(".")[0], os.environ.get("A2A_NODE_ID", "")}
    if node in local_names:
        command = [BASH, "-s"]
    else:
        command = [SSH, "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", node, BASH, "-s"]
    completed = subprocess.run(
        command,
        input=script,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=900,
        check=False,
    )
    if completed.returncode != 0:
        excerpt = completed.stderr.strip().replace("\n", " ")[-1000:]
        raise RuntimeError(f"{node} failed rc={completed.returncode}: {excerpt}")
    evidence: dict[str, str] = {"node": node}
    for line in completed.stdout.splitlines():
        if "=" in line:
            key, value = line.split("=", 1)
            if key in {"old", "head", "origin", "service", "pid", "restarts"}:
                evidence[key] = value
    if evidence.get("head") is None or evidence.get("service") != "active":
        raise RuntimeError(f"{node} returned incomplete evidence")
    return evidence


def state_path(args: argparse.Namespace) -> Path:
    return STATE_ROOT / args.task_id / f"{args.run_id}.json"


def load_state(args: argparse.Namespace) -> dict[str, Any]:
    path = state_path(args)
    if not path.exists():
        return {"schema": "a2a.live-runbook-state.v1", "taskId": args.task_id, "runId": args.run_id,
                "action": args.action, "target": args.target, "targetSha": args.target_sha, "phases": {}}
    data = json.loads(path.read_text())
    expected = (args.task_id, args.run_id, args.action, args.target, args.target_sha)
    actual = (data.get("taskId"), data.get("runId"), data.get("action"), data.get("target"), data.get("targetSha"))
    if actual != expected:
        raise RuntimeError("persisted runbook state does not match task scope")
    return data


def save_state(args: argparse.Namespace, state: dict[str, Any]) -> None:
    path = state_path(args)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(path.parent, 0o700)
    fd, tmp = tempfile.mkstemp(prefix=".state-", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as handle:
            json.dump(state, handle, sort_keys=True)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def execute(args: argparse.Namespace) -> dict[str, Any]:
    state = load_state(args)
    cached = state["phases"].get(args.phase)
    if cached and args.phase in {"apply", "rollback"}:
        evidence = cached
    else:
        script = remote_script(args.phase, args.target_sha, args.action)
        evidence = [run_node(node, script) for node in NODES]
        state["phases"][args.phase] = evidence
        save_state(args, state)
    result: dict[str, Any] = {
        "schema": SCHEMA,
        "ok": True,
        "phase": args.phase,
        "taskId": args.task_id,
        "runId": args.run_id,
        "target": args.target,
        "sentinel": f"{args.phase}:{args.task_id}:{args.run_id}",
        "evidence": {"nodes": evidence},
    }
    if args.phase == "verify":
        result["verification"] = {
            "done": all(row.get("head") == args.target_sha and row.get("service") == "active" and row.get("restarts") == "0" for row in evidence),
            "targetSha": args.target_sha,
            "nodes": evidence,
        }
    return result


def main(argv: list[str] | None = None) -> int:
    try:
        args = parse_args(sys.argv[1:] if argv is None else argv)
        print(json.dumps(execute(args), sort_keys=True, separators=(",", ":")))
        return 0
    except Exception as exc:
        print(json.dumps({"schema": SCHEMA, "ok": False, "error": str(exc)[:1500]}, sort_keys=True), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
