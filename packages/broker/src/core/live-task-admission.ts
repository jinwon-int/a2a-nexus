import { createHmac, timingSafeEqual } from "node:crypto";

import { BrokerError } from "./broker.js";
import { buildLiveApprovalConsumptionKey, type LiveApprovalScope } from "./runtime-safety-gates.js";
import type { BrokerStateStore } from "./store-contracts.js";
import type { CreateTaskRequest, WorkerView } from "./types.js";
import type { RequesterIdentity } from "./request-security.js";

export const LIVE_TASK_MODE = "promote-to-live-v1";
export const LIVE_OPERATION_SCHEMA = "a2a.live-operation.v1";
export const LIVE_APPROVAL_RECEIPT_SCHEMA = "a2a.live-approval-receipt.v1";
export const LIVE_RUNBOOK_IDS = ["ccc-node-3node-rollout-v1"] as const;

export type LiveRunbookId = (typeof LIVE_RUNBOOK_IDS)[number];

export interface LiveTaskOperation {
  schema: typeof LIVE_OPERATION_SCHEMA;
  runId: string;
  action: LiveApprovalScope["action"];
  target: string;
  targetWorkerId: string;
  targetSha: string;
  runbookId: LiveRunbookId;
  approvalTokenIssuedAt: string;
  approvalToken: string;
}

export interface LiveApprovalArtifactBinding {
  targetWorkerId: string;
  targetSha: string;
  runbookId: LiveRunbookId;
}

export interface LiveApprovalReceipt {
  schema: typeof LIVE_APPROVAL_RECEIPT_SCHEMA;
  brokerId: string;
  taskId: string;
  runId: string;
  action: LiveApprovalScope["action"];
  target: string;
  targetWorkerId: string;
  targetSha: string;
  runbookId: LiveRunbookId;
  consumedAt: string;
  consumptionKey: string;
  receiptMac: string;
}

export interface LiveTaskAdmissionContext {
  requesterIdentity: RequesterIdentity | null;
  worker: WorkerView | null;
  stateStore: BrokerStateStore;
  signingKey: string;
  brokerId: string;
  now?: string;
}

function ownRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireCanonicalText(record: Record<string, unknown>, key: string, maxLength = 256): string {
  if (!Object.hasOwn(record, key) || typeof record[key] !== "string") {
    throw new BrokerError("bad_request", `live operation ${key} is required`);
  }
  const value = record[key].trim();
  if (!value || value !== record[key] || value.length > maxLength || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new BrokerError("bad_request", `live operation ${key} must be canonical non-empty text without control characters`);
  }
  return value;
}

function assertExactKeys(record: Record<string, unknown>, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(record).filter((key) => !allowedSet.has(key));
  if (unknown.length > 0) {
    throw new BrokerError("bad_request", `live operation has unknown fields: ${unknown.sort().join(", ")}`);
  }
  for (const key of allowed) {
    if (!Object.hasOwn(record, key)) {
      throw new BrokerError("bad_request", `live operation ${key} is required`);
    }
  }
}

function parseLiveOperation(payload: Record<string, unknown>): LiveTaskOperation {
  if (!Object.hasOwn(payload, "liveOperation") || !ownRecord(payload.liveOperation)) {
    throw new BrokerError("bad_request", "liveOperation object is required");
  }
  const record = payload.liveOperation;
  assertExactKeys(record, [
    "schema",
    "runId",
    "action",
    "target",
    "targetWorkerId",
    "targetSha",
    "runbookId",
    "approvalTokenIssuedAt",
    "approvalToken",
  ]);
  const schema = requireCanonicalText(record, "schema");
  const action = requireCanonicalText(record, "action");
  const runbookId = requireCanonicalText(record, "runbookId");
  const targetSha = requireCanonicalText(record, "targetSha", 64);
  if (schema !== LIVE_OPERATION_SCHEMA) {
    throw new BrokerError("bad_request", `unsupported live operation schema ${schema}`);
  }
  if (action !== "promote_to_live_apply" && action !== "promote_to_live_rollback") {
    throw new BrokerError("bad_request", `unsupported live operation action ${action}`);
  }
  if (!(LIVE_RUNBOOK_IDS as readonly string[]).includes(runbookId)) {
    throw new BrokerError("bad_request", `runbook ${runbookId} is not allowlisted`);
  }
  if (!/^[a-f0-9]{40}$/.test(targetSha)) {
    throw new BrokerError("bad_request", "live operation targetSha must be a lowercase 40-character git SHA");
  }
  return {
    schema: LIVE_OPERATION_SCHEMA,
    runId: requireCanonicalText(record, "runId"),
    action,
    target: requireCanonicalText(record, "target", 512),
    targetWorkerId: requireCanonicalText(record, "targetWorkerId"),
    targetSha,
    runbookId: runbookId as LiveRunbookId,
    approvalTokenIssuedAt: requireCanonicalText(record, "approvalTokenIssuedAt"),
    approvalToken: requireCanonicalText(record, "approvalToken", 2048),
  };
}

function approvalMacInput(
  scope: LiveApprovalScope,
  binding: LiveApprovalArtifactBinding,
  issuedAt: string,
  nonce: string,
  requesterId: string,
): string {
  return [
    "a2a.live-approval-token.v2",
    buildLiveApprovalConsumptionKey(scope),
    binding.targetWorkerId,
    binding.targetSha,
    binding.runbookId,
    issuedAt,
    nonce,
    requesterId,
  ].join("\n");
}

function hmacHex(input: string, signingKey: string): string {
  return createHmac("sha256", signingKey).update(input).digest("hex");
}

function safeEqualHex(actual: string, expected: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(actual) || !/^[a-f0-9]{64}$/.test(expected)) return false;
  return timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
}

export function buildLiveApprovalTokenV2(
  scope: LiveApprovalScope,
  binding: LiveApprovalArtifactBinding,
  issuedAt: string,
  nonce: string,
  requesterId: string,
  signingKey: string,
): string {
  const canonicalIssuedAt = new Date(issuedAt).toISOString();
  if (canonicalIssuedAt !== issuedAt) throw new Error("issuedAt must be a canonical ISO timestamp");
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(nonce)) throw new Error("nonce must be 8..128 base64url characters");
  if (
    !requesterId.trim() ||
    requesterId !== requesterId.trim() ||
    requesterId.length > 256 ||
    /[\u0000-\u001f\u007f]/.test(requesterId)
  ) {
    throw new Error("requesterId must be canonical non-empty text");
  }
  if (signingKey.trim().length < 32) throw new Error("live approval signing key must contain at least 32 characters");
  const encodedIssuedAt = Buffer.from(issuedAt, "utf8").toString("base64url");
  const mac = hmacHex(approvalMacInput(scope, binding, issuedAt, nonce, requesterId), signingKey);
  return `live-approval-v2.${encodedIssuedAt}.${nonce}.${mac}`;
}

function verifyApprovalToken(
  operation: LiveTaskOperation,
  scope: LiveApprovalScope,
  binding: LiveApprovalArtifactBinding,
  requesterId: string,
  signingKey: string,
  now: string,
): void {
  if (signingKey.trim().length < 32) {
    throw new BrokerError("worker_unavailable", "live approval authority is unavailable");
  }
  const parts = operation.approvalToken.split(".");
  if (parts.length !== 4 || parts[0] !== "live-approval-v2") {
    throw new BrokerError("unauthorized", "invalid live approval token format");
  }
  let tokenIssuedAt: string;
  try {
    tokenIssuedAt = Buffer.from(parts[1]!, "base64url").toString("utf8");
  } catch {
    throw new BrokerError("unauthorized", "invalid live approval token issued-at encoding");
  }
  if (tokenIssuedAt !== operation.approvalTokenIssuedAt) {
    throw new BrokerError("unauthorized", "live approval issued-at binding mismatch");
  }
  const issuedAtMs = Date.parse(tokenIssuedAt);
  const nowMs = Date.parse(now);
  if (!Number.isFinite(issuedAtMs) || new Date(issuedAtMs).toISOString() !== tokenIssuedAt || !Number.isFinite(nowMs)) {
    throw new BrokerError("unauthorized", "live approval timestamp is invalid");
  }
  if (issuedAtMs > nowMs + 2_000 || nowMs - issuedAtMs > 5 * 60_000) {
    throw new BrokerError("unauthorized", "live approval token is stale or issued in the future");
  }
  const nonce = parts[2]!;
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(nonce)) {
    throw new BrokerError("unauthorized", "invalid live approval nonce");
  }
  const expected = hmacHex(approvalMacInput(scope, binding, tokenIssuedAt, nonce, requesterId), signingKey);
  if (!safeEqualHex(parts[3]!, expected)) {
    throw new BrokerError("unauthorized", "live approval token signature mismatch");
  }
}

function receiptMac(fields: Omit<LiveApprovalReceipt, "receiptMac">, signingKey: string): string {
  const canonical = [
    fields.schema,
    fields.brokerId,
    fields.taskId,
    fields.runId,
    fields.action,
    fields.target,
    fields.targetWorkerId,
    fields.targetSha,
    fields.runbookId,
    fields.consumedAt,
    fields.consumptionKey,
  ].join("\n");
  return hmacHex(canonical, signingKey);
}

export function admitLiveTaskSubmission(
  body: CreateTaskRequest,
  context: LiveTaskAdmissionContext,
): CreateTaskRequest {
  const payload: unknown = body.payload;
  if (!ownRecord(payload)) {
    if ((payload as { mode?: unknown } | null)?.mode === LIVE_TASK_MODE) {
      throw new BrokerError("bad_request", "live task payload must be a plain object");
    }
    return body;
  }
  if (payload.mode !== LIVE_TASK_MODE) return body;

  const identity = context.requesterIdentity;
  if (!identity || (identity.role !== "operator" && identity.role !== "hub")) {
    throw new BrokerError("unauthorized", "live task submission requires an authenticated operator or hub");
  }
  if (identity.id !== body.requester.id || identity.role !== body.requester.role) {
    throw new BrokerError("unauthorized", "live task requester identity mismatch");
  }
  if (body.intent !== "promote_to_live" && body.intent !== "rollback_live") {
    throw new BrokerError("bad_request", "live task intent must be promote_to_live or rollback_live");
  }

  const operation = parseLiveOperation(payload);
  const taskId = body.id;
  if (!taskId) throw new BrokerError("bad_request", "live task id is required");
  const expectedIntent = operation.action === "promote_to_live_apply" ? "promote_to_live" : "rollback_live";
  if (body.intent !== expectedIntent) {
    throw new BrokerError("bad_request", `live task intent must equal ${expectedIntent}`);
  }
  if (body.target.id !== operation.targetWorkerId) {
    throw new BrokerError("bad_request", "live operation target worker identity mismatch");
  }

  const worker = context.worker;
  if (!worker || worker.nodeId !== operation.targetWorkerId || worker.status !== "online") {
    throw new BrokerError("invalid_transition", "live operation target worker must be online");
  }
  if (!worker.capabilities.canPromoteLive) {
    throw new BrokerError("invalid_transition", "live operation target worker must declare canPromoteLive=true");
  }
  if (!worker.capabilities.environments.includes("live")) {
    throw new BrokerError("invalid_transition", "live operation target worker must declare environment live");
  }

  const scope: LiveApprovalScope = {
    taskId,
    runId: operation.runId,
    action: operation.action,
    target: operation.target,
  };
  const binding: LiveApprovalArtifactBinding = {
    targetWorkerId: operation.targetWorkerId,
    targetSha: operation.targetSha,
    runbookId: operation.runbookId,
  };
  const now = context.now ?? new Date().toISOString();
  verifyApprovalToken(operation, scope, binding, identity.id, context.signingKey, now);

  if (typeof context.stateStore.consumeLiveApprovalKey !== "function") {
    throw new BrokerError("worker_unavailable", "atomic live approval consumption is unavailable");
  }
  const consumptionKey = buildLiveApprovalConsumptionKey(scope);
  if (!context.stateStore.consumeLiveApprovalKey(consumptionKey, now)) {
    throw new BrokerError("invalid_transition", "live approval token has already been consumed");
  }

  const { approvalToken: _approvalToken, ...sanitizedOperation } = operation;
  const receiptFields: Omit<LiveApprovalReceipt, "receiptMac"> = {
    schema: LIVE_APPROVAL_RECEIPT_SCHEMA,
    brokerId: context.brokerId,
    taskId,
    runId: operation.runId,
    action: operation.action,
    target: operation.target,
    targetWorkerId: operation.targetWorkerId,
    targetSha: operation.targetSha,
    runbookId: operation.runbookId,
    consumedAt: now,
    consumptionKey,
  };
  const approvalReceipt: LiveApprovalReceipt = {
    ...receiptFields,
    receiptMac: receiptMac(receiptFields, context.signingKey),
  };
  return {
    ...body,
    payload: {
      ...payload,
      liveOperation: sanitizedOperation,
      approvalReceipt,
    },
  };
}
