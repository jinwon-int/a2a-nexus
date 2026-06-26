#!/usr/bin/env python3
"""Hermes-style A2A HTTP polling worker reference.

This script is intentionally dependency-free and local-dry-run first. It is a
reference implementation for the broker-agnostic worker contract, not a
production worker service.
"""

from __future__ import annotations

import argparse
from contextlib import contextmanager
import fcntl
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


LOCAL_DRY_RUN_MODES = {"hermes-reference-dry-run", "local-hermes-smoke"}
NO_LIVE_ANALYSIS_MODES = {"analysis-only", "readonly-analysis", "read-only-analysis", "a2ad-analysis"}
SAFE_LOCAL_MODES = LOCAL_DRY_RUN_MODES | NO_LIVE_ANALYSIS_MODES
SUPPORTED_NO_LIVE_INTENTS = {"analyze", "verify"}
LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1"}
LOCAL_EVIDENCE_SCHEMA = "a2a.hermesWorker.localEvidence.v1"


def env(name: str, default: str) -> str:
    value = os.environ.get(name)
    return value if value is not None and value != "" else default


def env_bool(name: str, default: bool = False) -> bool:
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def env_json_object(name: str) -> dict[str, Any]:
    raw = os.environ.get(name)
    if not raw:
        return {}
    parsed = json.loads(raw)
    if not isinstance(parsed, dict):
        raise ValueError(f"{name} must be a JSON object")
    return parsed


def env_json_array(name: str) -> list[Any]:
    raw = os.environ.get(name)
    if not raw:
        return []
    parsed = json.loads(raw)
    if not isinstance(parsed, list):
        raise ValueError(f"{name} must be a JSON array")
    return parsed


def broker_url() -> str:
    return env("A2A_BROKER_URL", "http://127.0.0.1:18787").rstrip("/")


def worker_id() -> str:
    return env("A2A_WORKER_ID", "hermes-agent-reference-worker")


def worker_role() -> str:
    return env("A2A_WORKER_ROLE", "analyst")


def artifact_root() -> Path:
    return Path(env("A2A_HERMES_ARTIFACT_ROOT", "~/.hermes/a2a/artifacts")).expanduser()


def mobile_work_root() -> Path | None:
    configured = os.environ.get("A2A_MOBILE_WORK_ROOT")
    if not configured:
        return None
    return Path(configured).expanduser()


def home_broker_id() -> str:
    return safe_task_dir_name(env("A2A_HOME_BROKER_ID", "local"))


def runtime_flavor() -> str:
    return env("A2A_HERMES_RUNTIME_FLAVOR", "termux-hermes")


def mobile_model_analysis_enabled() -> bool:
    return env_bool("A2A_HERMES_REFERENCE_ANALYSIS_ENABLED")


def mobile_model_analysis_command() -> list[str]:
    values = env_json_array("A2A_HERMES_REFERENCE_ANALYSIS_COMMAND_JSON")
    if not values:
        return []
    command = [str(value) for value in values]
    if not command or any(part == "" for part in command):
        raise ValueError("A2A_HERMES_REFERENCE_ANALYSIS_COMMAND_JSON must contain non-empty argv strings")
    return command


def utc_now_iso() -> str:
    return datetime.fromtimestamp(time.time(), timezone.utc).isoformat().replace("+00:00", "Z")


def safe_task_dir_name(task_id: str) -> str:
    cleaned = "".join(ch if ch.isalnum() or ch in {"-", "_", "."} else "_" for ch in task_id)
    return cleaned[:160] if cleaned else "unknown-task"


def local_manifest_locations(task_id: str) -> tuple[Path, str]:
    safe_task = safe_task_dir_name(task_id)
    work_root = mobile_work_root()
    if work_root is not None:
        broker_id = home_broker_id()
        task_dir = work_root / broker_id / safe_task
        for name in ("repo", "artifacts", "evidence", "tmp"):
            (task_dir / name).mkdir(parents=True, exist_ok=True)
        manifest_path = task_dir / "evidence" / "evidence.json"
        public_path = f"~/.hermes/a2a-workspaces/{broker_id}/{safe_task}/evidence/evidence.json"
        return manifest_path, public_path

    task_dir = artifact_root() / safe_task
    task_dir.mkdir(parents=True, exist_ok=True)
    return task_dir / "evidence.json", f"~/.hermes/a2a/artifacts/{safe_task}/evidence.json"


def local_manifest_public_path(task_id: str) -> str:
    return local_manifest_locations(task_id)[1]


def write_local_evidence_manifest(
    task_id: str,
    status: str,
    evidence: dict[str, Any],
    limitations: list[str] | None = None,
) -> str:
    """Persist redacted receipt/evidence locally before relying on network state."""
    manifest_path, _public_path = local_manifest_locations(task_id)
    manifest = {
        "schema": LOCAL_EVIDENCE_SCHEMA,
        "taskId": task_id,
        "workerId": worker_id(),
        "status": status,
        "files": [
            {
                "path": "evidence.json",
                "kind": "manifest",
                "redacted": True,
            }
        ],
        "redactionStatement": (
            "Secrets, provider tokens, raw device identifiers, private Termux paths, "
            "and raw session dumps are redacted before broker evidence."
        ),
        "limitations": limitations or [],
        "timestamp": utc_now_iso(),
        "evidence": evidence,
    }
    tmp_path = manifest_path.with_suffix(".json.tmp")
    tmp_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True), encoding="utf-8")
    os.replace(tmp_path, manifest_path)
    return str(manifest_path)


def assert_safe_broker_url(url: str) -> None:
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in {"http", "https"}:
        raise SystemExit(f"unsupported broker URL scheme: {parsed.scheme}")
    if parsed.hostname in LOOPBACK_HOSTS:
        return
    if env_bool("A2A_HERMES_REFERENCE_ALLOW_NON_LOOPBACK"):
        return
    raise SystemExit(
        "refusing non-loopback broker URL without "
        "A2A_HERMES_REFERENCE_ALLOW_NON_LOOPBACK=1"
    )


def request_json(method: str, path: str, body: dict[str, Any] | None = None) -> Any:
    base = broker_url()
    assert_safe_broker_url(base)
    url = base + path
    payload = None if body is None else json.dumps(body).encode("utf-8")
    headers = {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "X-A2A-Requester-Id": worker_id(),
        "X-A2A-Requester-Kind": "node",
        "X-A2A-Requester-Role": worker_role(),
    }
    edge_secret = os.environ.get("A2A_EDGE_SECRET")
    if edge_secret:
        headers["X-A2A-Edge-Secret"] = edge_secret
    req = urllib.request.Request(url, data=payload, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=float(env("A2A_HTTP_TIMEOUT_SEC", "10"))) as res:
            data = res.read().decode("utf-8")
            return json.loads(data) if data else {}
    except urllib.error.HTTPError as error:
        details = error.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"{method} {path} failed: HTTP {error.code} {details}") from error


def registration_payload() -> dict[str, Any]:
    metadata = {
        "runtime": "hermes-agent",
        "runtimeFlavor": runtime_flavor(),
        "openClawRequired": "false",
        "gatewayRequired": "false",
        "transport": "http-poll",
        "receiptEvidence": "local-manifest-plus-broker-evidence",
        "artifactRoot": "~/.hermes/a2a/artifacts",
        "bootPersistence": env("A2A_HERMES_BOOT_PERSISTENCE", "termux-boot-or-cron"),
        "reference": "phase-2-dry-run",
    }
    metadata.update({str(key): str(value) for key, value in env_json_object("A2A_WORKER_METADATA_JSON").items()})
    return {
        "nodeId": worker_id(),
        "role": worker_role(),
        "displayName": env("A2A_WORKER_DISPLAY_NAME", "Hermes Agent Reference Worker"),
        "brokerUrl": broker_url(),
        "workerMode": env("A2A_WORKER_MODE", "mobile"),
        "capabilities": {
            "canAnalyze": True,
            "canBackfill": False,
            "canPatchWorkspace": True,
            "canPromoteLive": False,
            "workspaceIds": [env("A2A_WORKER_WORKSPACE_ID", "public-safe-reference")],
            "environments": [env("A2A_WORKER_ENVIRONMENT", "research")],
        },
        "metadata": metadata,
    }


def register() -> Any:
    return request_json("POST", "/workers/register", registration_payload())


def registration_state_path() -> Path:
    configured = os.environ.get("A2A_WORKER_REGISTRATION_STATE_PATH")
    if configured:
        return Path(configured).expanduser()
    name = f"{safe_task_dir_name(worker_id())}-registration.json"
    work_root = mobile_work_root()
    if work_root is not None:
        return work_root / home_broker_id() / name
    return artifact_root() / name


def worker_lock_path() -> Path:
    configured = os.environ.get("A2A_WORKER_LOCK_PATH")
    if configured:
        return Path(configured).expanduser()
    name = f"{safe_task_dir_name(worker_id())}-worker.lock"
    work_root = mobile_work_root()
    if work_root is not None:
        return work_root / home_broker_id() / name
    return artifact_root() / name


@contextmanager
def worker_ownership_lock() -> Any:
    """Fail closed when another local process already owns this workerId.

    Termux/mobile workers are commonly launched by simple shell loops. A stale
    duplicate loop with the same nodeId can create confusing broker identity
    churn, so each process takes a non-blocking advisory lock before touching
    broker lifecycle endpoints.
    """
    path = worker_lock_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a+", encoding="utf-8") as fh:
        try:
            fcntl.flock(fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise SystemExit(
                f"workerId ownership lock already held for {worker_id()} at {path}; "
                "stop the duplicate process or set a distinct A2A_WORKER_ID"
            ) from exc
        fh.seek(0)
        fh.truncate()
        fh.write(json.dumps({
            "workerId": worker_id(),
            "brokerUrl": broker_url(),
            "pid": os.getpid(),
            "lockedAt": utc_now_iso(),
        }, ensure_ascii=False, sort_keys=True))
        fh.flush()
        try:
            yield
        finally:
            fcntl.flock(fh.fileno(), fcntl.LOCK_UN)


def registration_max_age_sec() -> int:
    raw = env("A2A_WORKER_REGISTER_REFRESH_SEC", "3600")
    try:
        value = int(raw)
    except ValueError:
        value = 3600
    return max(60, value)


def registration_fresh() -> bool:
    try:
        data = json.loads(registration_state_path().read_text(encoding="utf-8"))
    except Exception:
        return False
    if data.get("workerId") != worker_id() or data.get("brokerUrl") != broker_url():
        return False
    registered_at = data.get("registeredAtEpochSec")
    if not isinstance(registered_at, (int, float)):
        return False
    return time.time() - float(registered_at) < registration_max_age_sec()


def mark_registered() -> None:
    path = registration_state_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "workerId": worker_id(),
        "brokerUrl": broker_url(),
        "registeredAt": utc_now_iso(),
        "registeredAtEpochSec": int(time.time()),
        "refreshAfterSec": registration_max_age_sec(),
    }
    tmp_path = path.with_suffix(path.suffix + ".tmp")
    tmp_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True), encoding="utf-8")
    os.replace(tmp_path, path)


def ensure_registered() -> Any:
    if registration_fresh():
        return {"status": "skipped", "reason": "recent-registration", "workerId": worker_id()}
    result = register()
    mark_registered()
    return result


def heartbeat() -> Any:
    return request_json(
        "POST",
        f"/workers/{urllib.parse.quote(worker_id(), safe='')}/heartbeat",
        {
            "displayName": env("A2A_WORKER_DISPLAY_NAME", "Hermes Agent Reference Worker"),
            "metadata": {
                "runtime": "hermes-agent",
                "transport": "http-poll",
                "heartbeat": "ok",
                "heartbeatAtEpochMs": str(int(time.time() * 1000)),
            },
        },
    )


def poll() -> list[dict[str, Any]]:
    params = urllib.parse.urlencode({"worker": worker_id(), "status": "pending", "detail": "full"})
    payload = request_json("GET", f"/tasks?{params}")
    items = payload.get("items", [])
    if not isinstance(items, list):
        raise RuntimeError("unexpected broker task poll response")
    return [item for item in items if isinstance(item, dict)]


def task_payload(task: dict[str, Any]) -> dict[str, Any]:
    payload = task.get("payload")
    return payload if isinstance(payload, dict) else {}


def task_policy_context(task: dict[str, Any]) -> dict[str, Any]:
    policy_context = task.get("policyContext")
    return policy_context if isinstance(policy_context, dict) else {}


def normalized_task_intent(task: dict[str, Any]) -> str:
    payload = task_payload(task)
    value = task.get("intent") or payload.get("intent") or ""
    return str(value).strip().lower()


def payload_requests_forbidden_surface(payload: dict[str, Any]) -> bool:
    """Fail closed on surfaces the mobile/reference worker must never execute."""
    forbidden_boolean_keys = {
        "providerSend",
        "sendProviderRequest",
        "telegramSend",
        "terminalAck",
        "terminalReplay",
        "requiresDocker",
        "dockerRunnerRequired",
        "githubWrite",
        "writeGitHub",
        "proofMarker",
        "liveMutation",
    }
    if any(payload.get(key) is True for key in forbidden_boolean_keys):
        return True
    mode = str(payload.get("mode", "")).strip().lower()
    return mode in {"github-propose-patch", "propose_patch", "docker-runner", "docker_runner"}


def is_no_live_analysis_task(task: dict[str, Any]) -> bool:
    return str(task_payload(task).get("mode", "")).strip() in NO_LIVE_ANALYSIS_MODES


def non_substantive_mobile_model_output(status: str, summary: str, details: dict[str, Any] | None = None) -> dict[str, Any]:
    return {
        "analysisKind": "mobile_model_bridge",
        "analysisStatus": status,
        "evidenceClass": status,
        "bridgeAdapter": "hermes-reference-mobile",
        "summary": summary,
        "findings": [],
        "recommendations": [],
        "risks": [],
        "evidenceRefs": [],
        "details": details or {},
    }


def normalize_string_list(value: Any) -> list[str]:
    return [str(item) for item in value] if isinstance(value, list) else []


def normalize_mobile_model_output(parsed: dict[str, Any], task: dict[str, Any]) -> dict[str, Any]:
    status = str(parsed.get("analysisStatus") or parsed.get("status") or "").strip().lower()
    if status != "done":
        return non_substantive_mobile_model_output(
            "provider_or_model_failure",
            "mobile model bridge did not return analysisStatus=done",
            {"returnedStatus": status or None},
        )
    findings = normalize_string_list(parsed.get("findings"))
    recommendations = normalize_string_list(parsed.get("recommendations"))
    evidence_refs = normalize_string_list(parsed.get("evidenceRefs"))
    risks = normalize_string_list(parsed.get("risks"))
    summary = str(parsed.get("summary") or "mobile model bridge produced analysis")
    if not findings and not recommendations:
        return non_substantive_mobile_model_output(
            "wrapper_only",
            "mobile model bridge returned done without findings or recommendations",
            {"taskId": task.get("id")},
        )
    return {
        "analysisKind": "mobile_model_bridge",
        "analysisStatus": "done",
        "evidenceClass": "substantive",
        "bridgeAdapter": "hermes-reference-mobile",
        "summary": summary,
        "findings": findings,
        "recommendations": recommendations,
        "risks": risks,
        "evidenceRefs": evidence_refs,
        "nodeId": worker_id(),
        "runtimeFlavor": runtime_flavor(),
    }


def mobile_model_analysis_output(task: dict[str, Any]) -> dict[str, Any]:
    if not mobile_model_analysis_enabled():
        return non_substantive_mobile_model_output(
            "wrapper_only",
            "mobile model bridge is not enabled; reference worker will emit local evidence only",
            {"enabled": False},
        )
    command = mobile_model_analysis_command()
    if not command:
        return non_substantive_mobile_model_output(
            "handler_artifact_failure",
            "mobile model bridge command is not configured",
            {"env": "A2A_HERMES_REFERENCE_ANALYSIS_COMMAND_JSON"},
        )
    bridge_input = {
        "schema": "a2a.hermesWorker.mobileModelAnalysisRequest.v1",
        "workerId": worker_id(),
        "runtimeFlavor": runtime_flavor(),
        "task": task,
        "safety": {
            "noLive": True,
            "sourceOnly": bool(task_payload(task).get("sourceOnly")),
            "providerOrModelUse": "operator-approved-analysis-only",
            "forbiddenSurfaces": ["telegram", "terminal_ack", "github_write", "docker_runner", "live_mutation"],
        },
    }
    try:
        completed = subprocess.run(
            command,
            input=json.dumps(bridge_input, ensure_ascii=False),
            text=True,
            capture_output=True,
            timeout=float(env("A2A_HERMES_REFERENCE_ANALYSIS_TIMEOUT_SEC", "120")),
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        return non_substantive_mobile_model_output(
            "handler_artifact_failure",
            f"mobile model bridge execution failed: {type(exc).__name__}",
            {"error": str(exc), "command": command[0] if command else None},
        )
    if completed.returncode != 0:
        return non_substantive_mobile_model_output(
            "provider_or_model_failure",
            f"mobile model bridge exited non-zero: {completed.returncode}",
            {"stderrTail": completed.stderr[-500:], "stdoutTail": completed.stdout[-500:]},
        )
    try:
        parsed = json.loads(completed.stdout)
    except json.JSONDecodeError as exc:
        return non_substantive_mobile_model_output(
            "provider_or_model_failure",
            "mobile model bridge emitted invalid JSON",
            {"error": str(exc), "stdoutHead": completed.stdout[:200]},
        )
    if not isinstance(parsed, dict):
        return non_substantive_mobile_model_output(
            "provider_or_model_failure",
            "mobile model bridge JSON must be an object",
            {"type": type(parsed).__name__},
        )
    return normalize_mobile_model_output(parsed, task)


def is_safe_local_task(task: dict[str, Any]) -> bool:
    payload = task_payload(task)
    mode = str(payload.get("mode", "")).strip()
    policy_context = task_policy_context(task)
    target_environment = str(policy_context.get("targetEnvironment", "")).strip().lower()
    intent = normalized_task_intent(task)
    if payload.get("noLive") is not True:
        return False
    if mode not in SAFE_LOCAL_MODES:
        return False
    if intent and intent not in SUPPORTED_NO_LIVE_INTENTS:
        return False
    if policy_context.get("liveImpact") is True:
        return False
    if payload_requests_forbidden_surface(payload):
        return False
    if mode in NO_LIVE_ANALYSIS_MODES and target_environment not in {"", "research"}:
        return False
    if mode in LOCAL_DRY_RUN_MODES and target_environment not in {"", "local", "research"}:
        return False
    return True


def run_once() -> dict[str, Any]:
    ensure_registered()
    try:
        heartbeat()
    except RuntimeError as exc:
        if "HTTP 404" not in str(exc) and "HTTP 410" not in str(exc):
            raise
        register()
        mark_registered()
        heartbeat()
    tasks = poll()
    if not tasks:
        return {"status": "idle", "workerId": worker_id(), "processed": 0}

    task = tasks[0]
    task_id = str(task.get("id", ""))
    if not task_id:
        raise RuntimeError("polled task has no id")
    if not is_safe_local_task(task):
        refusal_evidence = {
            "workerId": worker_id(),
            "outcome": "blocked",
            "result": {
                "summary": "Hermes reference worker refused non-local or live-impact task",
                "output": {
                    "gongyungProfile": "hermes-worker",
                    "openClawRequired": False,
                    "runtimeFlavor": runtime_flavor(),
                    "profileVersion": 1,
                    "reason": "task payload is not a local noLive Hermes reference dry-run task",
                },
                "artifacts": [],
            },
        }
        manifest_path = write_local_evidence_manifest(
            task_id,
            "rejected",
            refusal_evidence,
            ["Task was not claimed; broker state was not mutated by this refusal."],
        )
        return {
            "status": "refused",
            "workerId": worker_id(),
            "taskId": task_id,
            "reason": "task payload is not a local noLive Hermes reference dry-run task",
            "localEvidenceManifest": manifest_path,
            "processed": 0,
        }

    encoded_task_id = urllib.parse.quote(task_id, safe="")
    body = {"workerId": worker_id()}
    request_json("POST", f"/tasks/{encoded_task_id}/claim", body)
    request_json("POST", f"/tasks/{encoded_task_id}/start", body)
    output = {
        "referenceWorker": "hermes-agent",
        "gongyungProfile": "hermes-worker",
        "mode": task_payload(task).get("mode"),
        "openClawRequired": False,
        "runtimeFlavor": runtime_flavor(),
        "profileVersion": 1,
        "liveProviderSend": False,
        "productionMutation": False,
    }
    summary = "Hermes reference worker completed local dry-run evidence"
    limitations: list[str] = []
    if is_no_live_analysis_task(task) and mobile_model_analysis_enabled():
        model_output = mobile_model_analysis_output(task)
        output.update(model_output)
        if model_output.get("analysisStatus") == "done":
            summary = str(model_output.get("summary") or "Hermes reference worker completed mobile model-backed analysis")
        else:
            summary = str(model_output.get("summary") or "Hermes reference worker mobile model bridge failed closed")
            limitations.append("Mobile model bridge did not produce substantive analysisStatus=done evidence.")
    manifest_ref = local_manifest_public_path(task_id)
    evidence = {
        "workerId": worker_id(),
        "outcome": "done",
        "result": {
            "summary": summary,
            "artifactIds": [manifest_ref],
            "output": output,
            "artifacts": [
                {
                    "path": manifest_ref,
                    "kind": "manifest",
                    "redacted": True,
                }
            ],
        },
    }
    manifest_path = write_local_evidence_manifest(task_id, "accepted", evidence, limitations)
    completed = request_json("POST", f"/tasks/{encoded_task_id}/evidence", evidence)
    return {
        "status": "processed",
        "workerId": worker_id(),
        "taskId": task_id,
        "localEvidenceManifest": manifest_path,
        "task": completed,
        "processed": 1,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Hermes-style A2A worker local dry-run reference")
    parser.add_argument("--action", choices=["register", "heartbeat", "poll", "run-once"], default="run-once")
    args = parser.parse_args()
    with worker_ownership_lock():
        if args.action == "register":
            result = register()
        elif args.action == "heartbeat":
            result = heartbeat()
        elif args.action == "poll":
            result = {"items": poll()}
        else:
            result = run_once()
    print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(json.dumps({"status": "error", "message": str(exc)}, ensure_ascii=False), file=sys.stderr)
        raise SystemExit(1)
