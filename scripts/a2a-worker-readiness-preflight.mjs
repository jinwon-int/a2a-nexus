#!/usr/bin/env node
/**
 * A2A worker readiness preflight — fail-closed, secret-safe (#655, ref #628 #633 #659).
 *
 * `systemctl is-active` returning success does not mean a worker is actually
 * ready: nosuk had a truncated BROKER_EDGE_SECRET (64→13 chars) and still
 * "ran"; yukson sat on a legacy /opt/openclaw-a2a-worker root whose analysis
 * bridge was not executable. This preflight classifies a worker's collected
 * env/artifact record into one machine-readable failure category so a deploy /
 * rollout gate can refuse to mark it ready.
 *
 * It composes with — does not replace — the existing guards: fleet:routing-guard
 * matches an observed brokerUrl/secret-fingerprint matrix against a fleet
 * expectation, worker-compatibility-audit checks handler-arg canonicality, and
 * worker-artifact-rollout-guard checks artifact integrity. The novel slice here
 * is (a) secret length/shape (truncation) without the broker-side fingerprint,
 * (b) handler presence + executable bit, and (c) the unified #655 taxonomy.
 *
 * Failure codes: secret_invalid | broker_route_mismatch | service_path_drift |
 *                worker_root_missing | handler_missing | task_poll_unauthorized |
 *                worker_role_mismatch | heartbeat_requester_role_mismatch |
 *                broker_worker_stale | worker_model_profile_mismatch |
 *                no_live_verification_missing | docker_runner_mount_invalid
 *
 * Secret-safe: consumes only secretLength / secretPresent plus redaction-safe
 * taskPollProbe metadata — never a raw secret — and emits only lengths/categories.
 * Pure offline: no SSH, network, restart,
 * DB/outbox mutation, secret movement, or runtime execution.
 */
import fs from "node:fs";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

import { TEAM_BROKER_INVARIANT, hasText } from "./a2a-routing-shared.mjs";
import { isWorkerModelSupportedByPatchProfile } from "../packages/broker/scripts/worker-model-policy.mjs";

// Canonical fleet expectations (#655). team↔home-broker invariant matches #633/#630.
export const DEFAULT_EXPECTATIONS = {
  service: "a2a-hermes-worker",
  envPath: "/etc/default/a2a-hermes-worker",
  root: "/opt/a2a-broker-worker",
  minSecretLength: 32,
  requiredHandlers: ["dist/worker.js", "a2a-task-handler.mjs", "hermes-a2a-analysis-bridge.mjs"],
  teamBroker: TEAM_BROKER_INVARIANT,
};

function secretLengthOf(record) {
  if (typeof record?.secretLength === "number" && Number.isFinite(record.secretLength)) {
    return record.secretLength;
  }
  // Allow a redaction-safe length carried as a string of digits.
  if (hasText(record?.secretLength) && /^\d+$/.test(record.secretLength.trim())) {
    return Number(record.secretLength.trim());
  }
  return null;
}

function taskPollProbeStatusOf(probe) {
  if (typeof probe?.httpStatus === "number" && Number.isInteger(probe.httpStatus)) {
    return probe.httpStatus;
  }
  if (hasText(probe?.httpStatus) && /^\d+$/.test(probe.httpStatus.trim())) {
    return Number(probe.httpStatus.trim());
  }
  return null;
}

function hasRawCredentialField(probe) {
  if (!probe || typeof probe !== "object") return false;
  return ["secret", "edgeSecret", "brokerEdgeSecret", "token", "authorization", "headers"].some((field) => Object.hasOwn(probe, field));
}

function serviceActiveOf(record) {
  return record?.serviceActive === true || record?.active === true;
}

function patchProfileOf(record) {
  for (const field of ["patchProfile", "dockerRunnerPatchProfile", "dockerRunnerPatchCommandProfile", "A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE"]) {
    if (hasText(record?.[field])) return record[field].trim();
  }
  return null;
}

function workerModelOf(record) {
  for (const field of ["workerModel", "defaultModel", "hermesDefaultModel", "openclawModel", "A2A_HERMES_DEFAULT_MODEL", "A2A_OPENCLAW_MODEL"]) {
    if (hasText(record?.[field])) return record[field].trim();
  }
  return null;
}

function parseBooleanLike(value) {
  if (typeof value === "boolean") return value;
  if (!hasText(value)) return null;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  return null;
}

function normalizeMountPath(value) {
  return value.replace(/\/+/g, "/").replace(/\/$/, "") || "/";
}

function isProtectedDockerRunnerMountPath(value) {
  const normalized = normalizeMountPath(value);
  return [
    /^\/root\/\.openclaw(?:\/|$)/,
    /^\/home\/[^/]+\/\.openclaw(?:\/|$)/,
    /^\/run\/secrets\/openclaw-dir(?:\/|$)/,
    /^\/root\/\.hermes(?:\/|$)/,
    /^\/home\/[^/]+\/\.hermes(?:\/|$)/,
    /^\/run\/secrets\/hermes-dir(?:\/|$)/,
  ].some((pattern) => pattern.test(normalized));
}

function dockerRunnerMountsOf(record) {
  for (const field of ["dockerRunnerExtraMounts", "extraMounts", "mounts"]) {
    if (Array.isArray(record?.[field])) return record[field];
  }
  for (const field of ["A2A_DOCKER_RUNNER_EXTRA_MOUNTS_JSON", "dockerRunnerExtraMountsJson"]) {
    if (!hasText(record?.[field])) continue;
    try {
      const parsed = JSON.parse(record[field]);
      return Array.isArray(parsed) ? parsed : { malformed: `invalid ${field}: expected an array` };
    } catch (error) {
      return { malformed: `invalid ${field}: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  return null;
}

function profileConfigDirOf(record, profile) {
  if (profile === "hermes") {
    for (const field of ["hermesConfigDir", "dockerRunnerHermesConfigDir", "A2A_DOCKER_RUNNER_HERMES_CONFIG_DIR"]) {
      if (hasText(record?.[field])) return record[field].trim();
    }
  }
  if (profile === "openclaw") {
    for (const field of ["openclawConfigDir", "dockerRunnerOpenClawConfigDir", "A2A_DOCKER_RUNNER_OPENCLAW_CONFIG_DIR"]) {
      if (hasText(record?.[field])) return record[field].trim();
    }
  }
  return null;
}

function noLiveEvidenceOf(record) {
  for (const field of ["noLiveVerification", "noLiveEvidence", "noLiveProbe"]) {
    if (record?.[field] && typeof record[field] === "object" && !Array.isArray(record[field])) return record[field];
  }
  if (parseBooleanLike(record?.noLive) === true) return { ok: true, mode: "no-live" };
  return null;
}

function noLiveEvidenceAllowsLiveAction(evidence) {
  const liveActionFields = [
    "liveActionsAllowed",
    "liveActionAllowed",
    "providerSend",
    "telegramCanary",
    "workerRestart",
    "brokerRestart",
    "gatewayRestart",
    "dbMutation",
    "terminalAck",
    "releasePublish",
    "secretMovement",
  ];
  return liveActionFields.some((field) => parseBooleanLike(evidence?.[field]) === true);
}

/**
 * Classify one worker's readiness. Returns the worker name, ok flag, and the
 * list of {code, reason} violations (empty when ready).
 */
export function evaluateWorkerReadiness(record, expectations = {}) {
  const exp = { ...DEFAULT_EXPECTATIONS, ...expectations, teamBroker: { ...DEFAULT_EXPECTATIONS.teamBroker, ...(expectations.teamBroker ?? {}) } };
  const name = hasText(record?.node) ? record.node.trim() : "(unnamed)";
  const violations = [];

  // 1. secret — present and not truncated. Never inspects the raw value.
  const secretPresent = record?.secretPresent === true || secretLengthOf(record) !== null;
  const secretLength = secretLengthOf(record);
  if (!secretPresent || secretLength === null) {
    violations.push({ code: "secret_invalid", reason: "BROKER_EDGE_SECRET is absent or its length was not reported" });
  } else if (secretLength < exp.minSecretLength) {
    violations.push({ code: "secret_invalid", reason: `BROKER_EDGE_SECRET length ${secretLength} is below the minimum ${exp.minSecretLength} (looks truncated)` });
  }

  // 2. broker route — homeBrokerId is the primary key; team↔broker must hold.
  const homeBrokerId = hasText(record?.homeBrokerId) ? record.homeBrokerId.trim() : null;
  const teamId = hasText(record?.teamId) ? record.teamId.trim() : null;
  if (!homeBrokerId) {
    violations.push({ code: "broker_route_mismatch", reason: "A2A_HOME_BROKER_ID is missing (primary routing key)" });
  } else if (teamId && exp.teamBroker[teamId] && exp.teamBroker[teamId] !== homeBrokerId) {
    violations.push({ code: "broker_route_mismatch", reason: `team '${teamId}' must route to '${exp.teamBroker[teamId]}', not '${homeBrokerId}'` });
  }

  // 3. service / env path drift.
  if (hasText(exp.service) && record?.service !== exp.service) {
    violations.push({ code: "service_path_drift", reason: `service '${record?.service ?? "(missing)"}' != canonical '${exp.service}'` });
  }
  if (hasText(exp.envPath) && hasText(record?.envPath) && record.envPath.trim() !== exp.envPath) {
    violations.push({ code: "service_path_drift", reason: `env file '${record.envPath}' != canonical '${exp.envPath}'` });
  }

  // 4. worker root (legacy /opt/openclaw-a2a-worker → fail).
  if (hasText(exp.root) && record?.root !== exp.root) {
    violations.push({ code: "worker_root_missing", reason: `worker root '${record?.root ?? "(missing)"}' != canonical '${exp.root}'` });
  }

  // 5. handler artifacts present AND executable (covers the #659 EACCES class).
  const handlers = Array.isArray(record?.handlers) ? record.handlers : [];
  for (const required of exp.requiredHandlers) {
    const match = handlers.find((h) => hasText(h?.path) && h.path.trim().endsWith(required));
    if (!match || match.present === false) {
      violations.push({ code: "handler_missing", reason: `required handler '${required}' is missing` });
    } else if (match.executable === false) {
      violations.push({ code: "handler_missing", reason: `required handler '${required}' is present but not executable (EACCES on spawn)` });
    }
  }

  // 6. task-poll probe — optional by default for backwards compatibility, but
  // fail-closed when explicitly required by a rollout/readiness gate (#697; ref
  // #691/#695). The probe is collected elsewhere; this evaluator stays offline
  // and secret-safe.
  const taskPollProbe = record?.taskPollProbe;
  if (exp.requireTaskPollProbe === true && !taskPollProbe) {
    violations.push({ code: "task_poll_unauthorized", reason: "task-poll authorization probe is missing" });
  } else if (taskPollProbe) {
    if (hasRawCredentialField(taskPollProbe)) {
      violations.push({ code: "task_poll_unauthorized", reason: "task-poll probe must not carry raw credential fields" });
    }

    const probeStatus = taskPollProbeStatusOf(taskPollProbe);
    const probeOk = taskPollProbe.ok === true && probeStatus !== null && probeStatus >= 200 && probeStatus <= 299;
    if (!probeOk) {
      const statusLabel = probeStatus === null ? "missing/invalid HTTP status" : `HTTP ${probeStatus}`;
      violations.push({ code: "task_poll_unauthorized", reason: `task-poll authorization probe failed (${statusLabel})` });
    }

    const probeAssignedWorkerId = hasText(taskPollProbe.assignedWorkerId) ? taskPollProbe.assignedWorkerId.trim() : null;
    if (!probeAssignedWorkerId) {
      violations.push({ code: "task_poll_unauthorized", reason: "task-poll probe did not report assignedWorkerId" });
    } else if (probeAssignedWorkerId !== name) {
      violations.push({ code: "task_poll_unauthorized", reason: `task-poll probe assignedWorkerId '${probeAssignedWorkerId}' does not match worker '${name}'` });
    }

    const probeBrokerId = hasText(taskPollProbe.brokerId) ? taskPollProbe.brokerId.trim() : null;
    if (probeBrokerId && homeBrokerId && probeBrokerId !== homeBrokerId) {
      violations.push({ code: "task_poll_unauthorized", reason: `task-poll probe brokerId '${probeBrokerId}' does not match home broker '${homeBrokerId}'` });
    }
  }

  // 7. worker role drift (#739). `systemctl is-active` plus the right artifact
  // revision is NOT healthy if the local WORKER_ROLE no longer matches the role
  // the broker registered/expects: the broker then rejects heartbeats with 401
  // "worker.heartbeat requester role must match <role>", leaving the worker
  // active-but-stale. Roles are not secret and may appear in diagnostics; raw
  // credentials still must not.
  const localRole = hasText(record?.role) ? record.role.trim() : null;
  const expectedRole = hasText(record?.expectedRole) ? record.expectedRole.trim() : null;

  // (a) Classify a broker heartbeat rejection explicitly as role drift rather
  // than a generic service-active success.
  const heartbeatProbe = record?.heartbeatProbe;
  if (heartbeatProbe) {
    if (hasRawCredentialField(heartbeatProbe)) {
      violations.push({ code: "heartbeat_requester_role_mismatch", reason: "heartbeat probe must not carry raw credential fields" });
    }
    const hbReason = hasText(heartbeatProbe.reason)
      ? heartbeatProbe.reason.trim()
      : hasText(heartbeatProbe.error)
        ? heartbeatProbe.error.trim()
        : "";
    const hbStatus = taskPollProbeStatusOf(heartbeatProbe);
    const roleMatch = hbReason.match(/requester role must match(?:\s+privileged actor role)?\s+([a-z][a-z-]*)/i);
    if (roleMatch || (hbStatus === 401 && /\brole\b/i.test(hbReason))) {
      const brokerExpected = roleMatch?.[1] ?? expectedRole ?? "(broker-expected role)";
      violations.push({
        code: "heartbeat_requester_role_mismatch",
        reason: `broker rejected heartbeat: local role '${localRole ?? "(missing)"}' must match broker-expected role '${brokerExpected}' — set WORKER_ROLE=${brokerExpected} and restart`,
      });
    }
  }

  // (b) Declared local vs expected role mismatch, catchable before a live probe.
  if (localRole && expectedRole && localRole !== expectedRole) {
    violations.push({
      code: "worker_role_mismatch",
      reason: `local WORKER_ROLE '${localRole}' != broker-expected role '${expectedRole}' — set WORKER_ROLE=${expectedRole} and restart`,
    });
  }

  // (c) Post-deploy: a service reporting active is not healthy if the broker
  // still shows the worker stale/absent. Requires broker /workers freshness, not
  // just systemd active + artifact revision.
  const serviceActive = serviceActiveOf(record);
  const brokerWorkerStatus = hasText(record?.brokerWorkerStatus) ? record.brokerWorkerStatus.trim().toLowerCase() : null;
  if (serviceActive && brokerWorkerStatus && brokerWorkerStatus !== "online") {
    violations.push({
      code: "broker_worker_stale",
      reason: `service is active but broker reports worker '${name}' as '${brokerWorkerStatus}', not online`,
    });
  }

  // 8. Worker model ↔ patch profile compatibility (#810). A service can be
  // active and online while the external handler will fail before useful work if
  // the configured default model is unsupported by the patch command profile
  // (for example Hermes profile + DeepSeek Flash). Classify that drift before
  // dispatch/claim evidence lanes are counted.
  const patchProfile = patchProfileOf(record);
  const workerModel = workerModelOf(record);
  if (patchProfile && workerModel) {
    const support = isWorkerModelSupportedByPatchProfile(patchProfile, workerModel);
    if (!support.supported) {
      violations.push({
        code: "worker_model_profile_mismatch",
        reason: `patch profile '${support.profile || patchProfile}' does not support worker model '${support.canonicalModel || workerModel}' — ${support.supportedAction || "choose a compatible worker model or patch profile"}`,
      });
    }
  }

  // 9. Runtime-repair no-live evidence (#832). When an operator is collecting
  // repair evidence before a live-facing closeout, require an explicit no-live
  // marker and reject any record that claims live actions were allowed/performed.
  const noLiveEvidence = noLiveEvidenceOf(record);
  if (exp.requireNoLiveVerification === true) {
    if (!noLiveEvidence || noLiveEvidence.ok !== true) {
      violations.push({ code: "no_live_verification_missing", reason: "explicit no-live verification evidence is missing or not ok" });
    } else if (noLiveEvidenceAllowsLiveAction(noLiveEvidence)) {
      violations.push({ code: "no_live_verification_missing", reason: "no-live verification evidence must not allow or include a live action" });
    }
  } else if (noLiveEvidence && noLiveEvidenceAllowsLiveAction(noLiveEvidence)) {
    violations.push({ code: "no_live_verification_missing", reason: "no-live evidence conflicts with a reported live action" });
  }

  // 10. Docker runner mount preflight (#832; mirrors the startup fail-closed
  // guard from packages/broker/src/worker.ts). Offline records can now classify
  // mount drift in the same readiness packet as handler/model/service evidence.
  const dockerRunnerMounts = dockerRunnerMountsOf(record);
  if (dockerRunnerMounts && !Array.isArray(dockerRunnerMounts)) {
    violations.push({ code: "docker_runner_mount_invalid", reason: dockerRunnerMounts.malformed });
  } else if (Array.isArray(dockerRunnerMounts)) {
    const parsedMounts = [];
    for (const [index, mount] of dockerRunnerMounts.entries()) {
      if (!mount || typeof mount !== "object" || Array.isArray(mount)) {
        violations.push({ code: "docker_runner_mount_invalid", reason: `invalid extra mount at index ${index}: expected object` });
        continue;
      }
      const source = mount.source;
      const target = mount.target;
      const readOnly = mount.readOnly;
      if (!hasText(source) || !source.startsWith("/")) {
        violations.push({ code: "docker_runner_mount_invalid", reason: `invalid extra mount at index ${index}: source must be an absolute path` });
        continue;
      }
      if (!hasText(target) || !target.startsWith("/")) {
        violations.push({ code: "docker_runner_mount_invalid", reason: `invalid extra mount at index ${index}: target must be an absolute path` });
        continue;
      }
      if (readOnly !== undefined && typeof readOnly !== "boolean") {
        violations.push({ code: "docker_runner_mount_invalid", reason: `invalid extra mount at index ${index}: readOnly must be boolean` });
        continue;
      }
      const parsedMount = { source, target, readOnly };
      parsedMounts.push(parsedMount);
      if (readOnly === false && (isProtectedDockerRunnerMountPath(source) || isProtectedDockerRunnerMountPath(target))) {
        violations.push({
          code: "docker_runner_mount_invalid",
          reason: `invalid extra mount at index ${index}: writable agent runtime/session paths are forbidden; keep ~/.openclaw / ~/.hermes and /run/secrets profile mounts read-only`,
        });
      }
    }

    const normalizedPatchProfile = patchProfile?.toLowerCase().replace(/_/g, "-");
    const requiredProfileMount = normalizedPatchProfile === "hermes"
      ? { target: "/run/secrets/hermes-dir", label: "Hermes", profile: "hermes" }
      : normalizedPatchProfile === "openclaw"
        ? { target: "/run/secrets/openclaw-dir", label: "OpenClaw", profile: "openclaw" }
        : null;
    if (requiredProfileMount) {
      const matching = parsedMounts.filter((mount) => normalizeMountPath(mount.target) === requiredProfileMount.target);
      if (matching.length === 0) {
        violations.push({
          code: "docker_runner_mount_invalid",
          reason: `${requiredProfileMount.profile} patch profile requires a ${requiredProfileMount.target} mount; include the ${requiredProfileMount.label} config mount explicitly`,
        });
      }
      const expectedSource = profileConfigDirOf(record, requiredProfileMount.profile);
      if (expectedSource) {
        const normalizedExpected = normalizeMountPath(expectedSource);
        const conflicts = matching.filter((mount) => normalizeMountPath(mount.source) !== normalizedExpected);
        if (conflicts.length > 0) {
          violations.push({
            code: "docker_runner_mount_invalid",
            reason: `${requiredProfileMount.target} source conflicts with the configured ${requiredProfileMount.label} profile directory`,
          });
        }
      }
    }
  }

  return { node: name, ok: violations.length === 0, secretLength, violations };
}

/** Evaluate a fleet (array of worker records). */
export function evaluateFleetReadiness(records, expectations = {}) {
  if (!Array.isArray(records)) {
    return { ok: false, malformed: true, inputErrors: ["workers must be an array"], rows: [], violations: [] };
  }
  const rows = records.map((r) => evaluateWorkerReadiness(r, expectations));
  const violations = rows.flatMap((r) => r.violations.map((v) => ({ node: r.node, ...v })));
  return { ok: violations.length === 0, malformed: false, inputErrors: [], rows, violations };
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({
    args: argv,
    options: {
      workers: { type: "string", default: "" },
      expectations: { type: "string", default: "" },
      json: { type: "boolean", default: false },
    },
  });

  if (!values.workers) {
    process.stderr.write(JSON.stringify({ ok: false, error: "--workers <file> is required (array of collected worker records)" }, null, 2) + "\n");
    process.exit(1);
  }

  let records;
  try {
    records = readJson(values.workers);
  } catch (error) {
    process.stderr.write(JSON.stringify({ ok: false, malformed: true, error: `cannot read/parse --workers: ${error.message}` }, null, 2) + "\n");
    process.exit(1);
  }
  let expectations = {};
  if (values.expectations) {
    try {
      expectations = readJson(values.expectations);
    } catch (error) {
      process.stderr.write(JSON.stringify({ ok: false, malformed: true, error: `cannot read/parse --expectations: ${error.message}` }, null, 2) + "\n");
      process.exit(1);
    }
  }

  const result = evaluateFleetReadiness(records, expectations);
  const exitCode = result.ok ? 0 : 1;
  const sink = exitCode === 0 ? process.stdout : process.stderr;
  sink.write(JSON.stringify(result, null, 2) + "\n");
  process.exit(exitCode);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
