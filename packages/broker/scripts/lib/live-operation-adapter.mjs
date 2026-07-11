import { readFileSync, lstatSync, realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { spawnSync as nodeSpawnSync } from "node:child_process";

const LIVE_TASK_MODE = "promote-to-live-v1";
const LIVE_OPERATION_SCHEMA = "a2a.live-operation.v1";
const LIVE_RECEIPT_SCHEMA = "a2a.live-approval-receipt.v1";
const LIVE_RUNBOOK_SCHEMA = "a2a.live-runbooks.v1";
const PHASE_RESULT_SCHEMA = "a2a.live-runbook-phase-result.v1";
const ALLOWED_RUNBOOK_IDS = new Set(["ccc-node-3node-rollout-v1"]);

function ownRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(record, keys) {
  if (!ownRecord(record)) return false;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function canonicalText(value, maxLength = 512) {
  return typeof value === "string" && value.length > 0 && value === value.trim() && value.length <= maxLength;
}

function fail(code, message, details = undefined) {
  return { error: { code, message, ...(details ? { details } : {}) } };
}

function loadCapabilities(env) {
  const raw = String(env.WORKER_CAPABILITIES_JSON ?? env.A2A_WORKER_CAPABILITIES_JSON ?? "").trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return ownRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function assertRootOwnedImmutableFile(path, label, { executable = false } = {}) {
  if (!canonicalText(path, 4096) || !isAbsolute(path)) {
    throw new Error(`${label} path must be canonical and absolute`);
  }
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || realpathSync(path) !== path) {
    throw new Error(`${label} must be a regular non-symlink file`);
  }
  if (stat.uid !== 0 || (stat.mode & 0o022) !== 0) {
    throw new Error(`${label} must be root-owned and not group/other writable`);
  }
  if (executable && (stat.mode & 0o111) === 0) {
    throw new Error(`${label} must be executable`);
  }
}

function loadRunbook(manifestPath, runbookId, target) {
  if (!ALLOWED_RUNBOOK_IDS.has(runbookId)) {
    throw Object.assign(new Error(`runbook ${runbookId} is not allowlisted`), { code: "runbook_not_allowed" });
  }
  assertRootOwnedImmutableFile(manifestPath, "live runbook manifest");
  let document;
  try {
    document = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(`cannot read live runbook manifest: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!exactKeys(document, ["schema", "runbooks"]) || document.schema !== LIVE_RUNBOOK_SCHEMA || !ownRecord(document.runbooks)) {
    throw new Error("live runbook manifest schema is invalid");
  }
  const runbook = document.runbooks[runbookId];
  if (!exactKeys(runbook, ["command", "targetPrefix", "timeoutSec"])) {
    throw new Error(`runbook ${runbookId} schema is invalid`);
  }
  if (!canonicalText(runbook.command, 4096) || !canonicalText(runbook.targetPrefix, 256)) {
    throw new Error(`runbook ${runbookId} command or targetPrefix is invalid`);
  }
  if (!Number.isInteger(runbook.timeoutSec) || runbook.timeoutSec < 1 || runbook.timeoutSec > 3600) {
    throw new Error(`runbook ${runbookId} timeoutSec must be 1..3600`);
  }
  if (!target.startsWith(runbook.targetPrefix)) {
    throw new Error(`runbook ${runbookId} does not allow target ${target}`);
  }
  assertRootOwnedImmutableFile(runbook.command, `runbook ${runbookId} command`, { executable: true });
  return runbook;
}

function parseTask(task, env) {
  if (!ownRecord(task) || !canonicalText(task.id) || task.payload?.mode !== LIVE_TASK_MODE) {
    throw Object.assign(new Error("task is not a canonical promote-to-live task"), { code: "invalid_live_operation" });
  }
  const payload = task.payload;
  if (!ownRecord(payload) || !exactKeys(payload.liveOperation, [
    "schema",
    "runId",
    "action",
    "target",
    "targetWorkerId",
    "targetSha",
    "runbookId",
    "approvalTokenIssuedAt",
  ])) {
    throw Object.assign(new Error("live operation schema is invalid or contains unknown fields"), { code: "invalid_live_operation" });
  }
  const operation = payload.liveOperation;
  const expectedIntent = operation.action === "promote_to_live_apply" ? "promote_to_live" : "rollback_live";
  if (task.intent !== expectedIntent) {
    throw Object.assign(new Error(`live task intent must equal ${expectedIntent}`), { code: "invalid_live_operation" });
  }
  if (
    operation.schema !== LIVE_OPERATION_SCHEMA ||
    !canonicalText(operation.runId) ||
    !["promote_to_live_apply", "promote_to_live_rollback"].includes(operation.action) ||
    !canonicalText(operation.target) ||
    !canonicalText(operation.targetWorkerId) ||
    !/^[a-f0-9]{40}$/.test(String(operation.targetSha ?? "")) ||
    !canonicalText(operation.runbookId) ||
    !canonicalText(operation.approvalTokenIssuedAt)
  ) {
    throw Object.assign(new Error("live operation fields are invalid"), { code: "invalid_live_operation" });
  }
  if (
    operation.runbookId === "ccc-node-3node-rollout-v1" &&
    operation.target !== `ccc-node:fleet:${operation.targetSha}`
  ) {
    throw Object.assign(new Error("ccc-node rollout target must embed the exact target SHA"), { code: "invalid_live_operation" });
  }
  if (!exactKeys(payload.approvalReceipt, [
    "schema",
    "brokerId",
    "taskId",
    "runId",
    "action",
    "target",
    "targetWorkerId",
    "targetSha",
    "runbookId",
    "consumedAt",
    "consumptionKey",
    "receiptMac",
  ])) {
    throw Object.assign(new Error("broker approval receipt is missing or invalid"), { code: "approval_receipt_required" });
  }
  const receipt = payload.approvalReceipt;
  const nodeId = String(env.A2A_NODE_ID ?? env.NODE_ID ?? env.A2A_WORKER_ID ?? env.WORKER_ID ?? "").trim();
  if (!/^[A-Za-z0-9._:-]{1,64}$/.test(nodeId)) {
    throw Object.assign(new Error("live task worker identity is not canonical"), { code: "live_worker_identity_mismatch" });
  }
  if (!nodeId || nodeId !== operation.targetWorkerId || task.targetNodeId !== nodeId || task.assignedWorkerId !== nodeId) {
    throw Object.assign(new Error("live task worker identity mismatch"), { code: "live_worker_identity_mismatch" });
  }
  const fieldsMatch =
    receipt.schema === LIVE_RECEIPT_SCHEMA &&
    receipt.taskId === task.id &&
    receipt.runId === operation.runId &&
    receipt.action === operation.action &&
    receipt.target === operation.target &&
    receipt.targetWorkerId === nodeId &&
    receipt.targetSha === operation.targetSha &&
    receipt.runbookId === operation.runbookId &&
    canonicalText(receipt.brokerId) &&
    canonicalText(receipt.consumedAt) &&
    canonicalText(receipt.consumptionKey) &&
    /^[a-f0-9]{64}$/.test(String(receipt.receiptMac ?? ""));
  if (!fieldsMatch) {
    throw Object.assign(new Error("broker approval receipt does not match task scope"), { code: "approval_receipt_mismatch" });
  }
  return { operation, receipt, nodeId };
}

function phaseArgs(task, operation, receipt, phase) {
  return [
    "--phase", phase,
    "--task-id", task.id,
    "--run-id", operation.runId,
    "--action", operation.action,
    "--runbook-id", operation.runbookId,
    "--target", operation.target,
    "--target-sha", operation.targetSha,
    "--worker-id", operation.targetWorkerId,
    "--receipt-mac", receipt.receiptMac,
  ];
}

function parsePhaseResult(stdout, expected) {
  let result;
  try {
    result = JSON.parse(String(stdout ?? ""));
  } catch {
    throw new Error(`runbook ${expected.phase} did not return JSON`);
  }
  if (!ownRecord(result) || result.schema !== PHASE_RESULT_SCHEMA || result.ok !== true) {
    throw new Error(`runbook ${expected.phase} did not return an accepted success record`);
  }
  if (
    result.phase !== expected.phase ||
    result.taskId !== expected.taskId ||
    result.runId !== expected.runId ||
    result.target !== expected.target ||
    result.sentinel !== `${expected.phase}:${expected.taskId}:${expected.runId}`
  ) {
    throw new Error(`runbook ${expected.phase} sentinel does not match task scope`);
  }
  return result;
}

function sameFields(left, right, fields) {
  return fields.every((field) => left?.[field] === right?.[field]);
}

function verifyTaskAgainstBroker(task, operation, receipt, nodeId, env, spawnSync) {
  const rawUrl = String(env.A2A_BROKER_URL ?? env.BROKER_URL ?? "").trim();
  let brokerUrl;
  try {
    brokerUrl = new URL(rawUrl);
  } catch {
    throw Object.assign(new Error("trusted broker URL is required"), { code: "trusted_broker_confirmation_required" });
  }
  if (!['http:', 'https:'].includes(brokerUrl.protocol) || brokerUrl.username || brokerUrl.password) {
    throw Object.assign(new Error("trusted broker URL must be credential-free HTTP(S)"), { code: "trusted_broker_confirmation_required" });
  }
  const edgeSecret = String(
    env.BROKER_EDGE_SECRET ?? env.A2A_BROKER_EDGE_SECRET ?? env.EDGE_SECRET ?? env.A2A_EDGE_SECRET ?? "",
  ).trim();
  if (!/^[A-Za-z0-9._~+/=-]{16,512}$/.test(edgeSecret)) {
    throw Object.assign(new Error("trusted broker edge secret is unavailable"), { code: "trusted_broker_confirmation_required" });
  }
  const curlPath = "/usr/bin/curl";
  assertRootOwnedImmutableFile(curlPath, "curl client", { executable: true });
  const taskUrl = new URL(`/tasks/${encodeURIComponent(task.id)}`, brokerUrl).toString();
  const curlConfig = [
    `header = "x-a2a-edge-secret: ${edgeSecret}"`,
    `header = "x-a2a-requester-id: ${nodeId}"`,
    'header = "x-a2a-requester-role: analyst"',
    "",
  ].join("\n");
  const fetched = spawnSync(curlPath, [
    "--config", "-",
    "--fail-with-body",
    "--silent",
    "--show-error",
    "--max-time", "15",
    taskUrl,
  ], {
    encoding: "utf8",
    shell: false,
    timeout: 20_000,
    maxBuffer: 1024 * 1024,
    input: curlConfig,
    env: { PATH: "/usr/bin:/bin" },
  });
  if (fetched.error || fetched.status !== 0 || fetched.signal) {
    throw Object.assign(new Error("trusted broker did not confirm the live task"), { code: "trusted_broker_confirmation_required" });
  }
  let canonical;
  try {
    canonical = JSON.parse(String(fetched.stdout ?? ""));
  } catch {
    throw Object.assign(new Error("trusted broker returned an invalid task record"), { code: "trusted_broker_confirmation_required" });
  }
  const canonicalPayload = canonical?.payload;
  const canonicalOperation = canonicalPayload?.liveOperation;
  const canonicalReceipt = canonicalPayload?.approvalReceipt;
  const operationFields = [
    "schema", "runId", "action", "target", "targetWorkerId", "targetSha", "runbookId", "approvalTokenIssuedAt",
  ];
  const receiptFields = [
    "schema", "brokerId", "taskId", "runId", "action", "target", "targetWorkerId", "targetSha", "runbookId",
    "consumedAt", "consumptionKey", "receiptMac",
  ];
  if (
    !ownRecord(canonical) ||
    canonical.id !== task.id ||
    canonical.targetNodeId !== nodeId ||
    canonical.assignedWorkerId !== nodeId ||
    canonicalPayload?.mode !== LIVE_TASK_MODE ||
    !sameFields(canonicalOperation, operation, operationFields) ||
    !sameFields(canonicalReceipt, receipt, receiptFields)
  ) {
    throw Object.assign(new Error("local live task does not match the trusted broker record"), { code: "trusted_broker_confirmation_mismatch" });
  }
}

export function runLiveOperationTask(task, env = process.env, dependencies = {}) {
  const spawnSync = dependencies.spawnSync ?? nodeSpawnSync;
  try {
    const capabilities = loadCapabilities(env);
    if (!capabilities || capabilities.canPromoteLive !== true) {
      return fail("live_capability_required", "worker must declare canPromoteLive=true");
    }
    if (!Array.isArray(capabilities.environments) || !capabilities.environments.includes("live")) {
      return fail("live_environment_required", "worker must declare environment live");
    }
    const { operation, receipt, nodeId } = parseTask(task, env);
    verifyTaskAgainstBroker(task, operation, receipt, nodeId, env, spawnSync);
    const manifestPath = String(env.A2A_LIVE_RUNBOOKS_FILE ?? "").trim();
    const runbook = loadRunbook(manifestPath, operation.runbookId, operation.target);
    const phases = operation.action === "promote_to_live_apply"
      ? ["preflight", "apply", "verify"]
      : ["rollback", "verify"];
    const evidence = [];
    let verification = null;
    for (const phase of phases) {
      const args = phaseArgs(task, operation, receipt, phase);
      const executed = spawnSync(runbook.command, args, {
        encoding: "utf8",
        shell: false,
        timeout: runbook.timeoutSec * 1000,
        maxBuffer: 1024 * 1024,
        env: {
          PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
          A2A_NODE_ID: operation.targetWorkerId,
        },
      });
      if (executed.error || executed.status !== 0 || executed.signal) {
        return fail("live_runbook_phase_failed", `runbook phase ${phase} failed`, {
          phase,
          status: executed.status ?? null,
          signal: executed.signal ?? null,
          stderr: String(executed.stderr ?? "").slice(0, 2000),
        });
      }
      let phaseResult;
      try {
        phaseResult = parsePhaseResult(executed.stdout, {
          phase,
          taskId: task.id,
          runId: operation.runId,
          target: operation.target,
        });
      } catch (error) {
        return fail(
          phase === "verify" ? "live_verification_failed" : "live_runbook_phase_failed",
          error instanceof Error ? error.message : String(error),
          { phase },
        );
      }
      evidence.push({
        phase,
        sentinel: phaseResult.sentinel,
        evidence: ownRecord(phaseResult.evidence) ? phaseResult.evidence : undefined,
      });
      if (phase === "verify") verification = phaseResult.verification;
    }
    if (!ownRecord(verification) || verification.done !== true || verification.targetSha !== operation.targetSha) {
      return fail("live_verification_failed", "verify phase did not prove completion for the target SHA");
    }
    return {
      result: {
        schema: "a2a.live-operation-result.v1",
        taskId: task.id,
        runId: operation.runId,
        action: operation.action,
        target: operation.target,
        targetSha: operation.targetSha,
        runbookId: operation.runbookId,
        approvalReceipt: receipt,
        verification,
        evidence,
      },
    };
  } catch (error) {
    return fail(
      typeof error?.code === "string" ? error.code : "invalid_live_operation",
      error instanceof Error ? error.message : String(error),
    );
  }
}
