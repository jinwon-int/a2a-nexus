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
 *                worker_root_missing | handler_missing | task_poll_unauthorized
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
