// Worker-signed task lifecycle routes — the task mutations a worker drives and
// that carry an optional A2A HTTP signature: POST
// /tasks/:id/{claim,start,heartbeat,checkpoint,complete,evidence,fail}. Extracted
// from the server request closure into explicit-context handlers (continuing the
// #645 dispatcher migration). These differ from the actor/operator decision
// routes (tasks-decision-routes.ts) in that they verify the worker signature and
// identity-match against the signed requester, so the context carries the
// server's two signature-route closures.
import type { IncomingMessage, ServerResponse } from "node:http";

import { BrokerError, InMemoryA2ABroker } from "../core/broker.js";
import { normalizeTaskResult } from "../core/broker-task-record-normalizers.js";
import type { BrokerStateStore } from "../core/store.js";
import {
  assertRequesterMatchesParty,
  type A2AWorkerRouteScope,
  type RequesterIdentity,
} from "../core/request-security.js";
import type {
  TaskClaimRequest,
  TaskCompleteRequest,
  TaskEvidenceRequest,
  TaskFailRequest,
  TaskRecord,
} from "../core/types.js";
import type { A2AHttpSignatureVerifiedWorker } from "../server.js";
import {
  countersignTaskResultProvenance,
  verifyTaskResultProvenance,
  type ResultWithProvenance,
} from "a2a-attestation";
import { awaitDurablePersistenceAck } from "./error-mapping.js";
import { readJson } from "./body.js";
import { sendJson } from "./response.js";

export interface TasksWorkerRouteContext {
  method: string | undefined;
  segments: string[];
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  broker: InMemoryA2ABroker;
  stateStore: BrokerStateStore;
  enforceRequesterIdentity: boolean;
  requesterIdentity: RequesterIdentity | null;
  /** Verify (and return) the request's signed worker, if any; throws on a bad signature. */
  assertWorkerHttpSignatureRoute: (
    req: IncomingMessage,
    url: URL,
  ) => Promise<A2AHttpSignatureVerifiedWorker | null>;
  /** Enforce the signed worker's route scope and identity-match the expected worker id. */
  assertVerifiedWorkerMatches: (
    verified: A2AHttpSignatureVerifiedWorker | null,
    expectedWorkerId: string | undefined,
    operation: A2AWorkerRouteScope,
  ) => void;
  resultProvenanceBrokerSigner?: {
    privateKeyPem: string;
    brokerKeyId: string;
  };
  /**
   * Countersigning posture for worker result provenance (#1389). "enforce" and
   * "auto" both verify+countersign when a signer is present; they differ only at
   * startup (enforce requires the key, auto does not). Under "auto" with no
   * signer the worker-signed result passes through un-countersigned rather than
   * failing the submission. "off" passes provenance through untouched (kill
   * switch). Defaults to "auto" when unset.
   */
  resultProvenanceCountersign?: "enforce" | "auto" | "off";
}

type TaskScopedContext = TasksWorkerRouteContext & { taskId: string };

interface WorkerScopedBody {
  workerId?: string;
}

/**
 * Verify the worker signature, read the worker-scoped body, require a workerId,
 * identity-match it against the signature, and (when enabled) the requester.
 */
async function authWorkerAction<T extends WorkerScopedBody>(
  ctx: TaskScopedContext,
  scope: A2AWorkerRouteScope,
): Promise<{ body: T; workerId: string; verifiedWorker: A2AHttpSignatureVerifiedWorker | null }> {
  const verifiedWorker = await ctx.assertWorkerHttpSignatureRoute(ctx.req, ctx.url);
  const body = await readJson<T>(ctx.req);
  if (!body?.workerId) {
    throw new BrokerError("bad_request", "workerId is required");
  }
  ctx.assertVerifiedWorkerMatches(verifiedWorker, body.workerId, scope);
  if (ctx.enforceRequesterIdentity) {
    assertRequesterMatchesParty(ctx.requesterIdentity, { id: body.workerId }, scope);
  }
  return { body, workerId: body.workerId, verifiedWorker };
}

function sendTask(ctx: TaskScopedContext, task: TaskRecord): void {
  sendJson(ctx.res, 200, task);
}

function resultHasProvenance(result: unknown): result is ResultWithProvenance {
  return Boolean(result && typeof result === "object" && !Array.isArray(result) && "provenance" in result);
}

function verifyAndCountersignResultProvenance(
  ctx: TaskScopedContext,
  result: TaskCompleteRequest["result"],
  verifiedWorker: A2AHttpSignatureVerifiedWorker | null,
): TaskCompleteRequest["result"] {
  if (!resultHasProvenance(result)) {
    return result;
  }
  // "off" is a kill switch (#1389): provenance passes through untouched, with no
  // verification or countersignature. Reserve it for incident recovery.
  if (ctx.resultProvenanceCountersign === "off") {
    return result;
  }
  const normalizedResult = normalizeTaskResult(result);
  if (!resultHasProvenance(normalizedResult)) {
    throw new BrokerError("provenance_invalid", "result provenance was not preserved by result normalization");
  }
  const provenance = normalizedResult.provenance;
  if (!provenance || typeof provenance !== "object" || Array.isArray(provenance)) {
    throw new BrokerError("provenance_invalid", "result.provenance must be an object when present");
  }
  if (!verifiedWorker?.publicKeyPem) {
    throw new BrokerError("provenance_invalid", "registered worker public key is required to verify result provenance");
  }
  if (provenance.workerKeyId !== verifiedWorker.keyid) {
    throw new BrokerError(
      "provenance_invalid",
      "result.provenance.workerKeyId does not match the registered worker signing key",
    );
  }
  const verification = verifyTaskResultProvenance(normalizedResult, {
    taskId: ctx.taskId,
    publicKeyPem: verifiedWorker.publicKeyPem,
  });
  if (!verification.ok) {
    throw new BrokerError("provenance_invalid", `result provenance verification failed: ${verification.reason}`);
  }
  const signer = ctx.resultProvenanceBrokerSigner;
  if (!signer) {
    // "enforce" guarantees a signer at startup, so reaching here means "auto"
    // with no configured key: pass the worker-signed result through
    // un-countersigned rather than failing the submission (#1389 — a deployed
    // build must never start rejecting worker tasks because the broker signer
    // env/key has not landed yet).
    if (ctx.resultProvenanceCountersign === "enforce") {
      throw new BrokerError("provenance_invalid", "broker result provenance countersigning key is not configured");
    }
    return normalizedResult;
  }
  return {
    ...normalizedResult,
    provenance: countersignTaskResultProvenance(provenance, {
      taskId: ctx.taskId,
      verifiedAt: new Date().toISOString(),
      privateKeyPem: signer.privateKeyPem,
      brokerKeyId: signer.brokerKeyId,
    }),
  };
}

/** POST /tasks/:id/claim — a worker claims a queued task. */
export async function handleClaimTaskRequest(ctx: TaskScopedContext): Promise<void> {
  const { workerId } = await authWorkerAction<TaskClaimRequest>(ctx, "task.claim");
  const task = ctx.broker.claimTask(ctx.taskId, workerId);
  await awaitDurablePersistenceAck(ctx.stateStore);
  sendTask(ctx, task);
}

/** POST /tasks/:id/start — a worker starts a claimed task. */
export async function handleStartTaskRequest(ctx: TaskScopedContext): Promise<void> {
  const { workerId } = await authWorkerAction<TaskClaimRequest>(ctx, "task.start");
  const task = ctx.broker.startTask(ctx.taskId, workerId);
  await awaitDurablePersistenceAck(ctx.stateStore);
  sendTask(ctx, task);
}

/** POST /tasks/:id/heartbeat — a worker reports liveness on a running task. */
export async function handleHeartbeatTaskRequest(ctx: TaskScopedContext): Promise<void> {
  const { body, workerId } = await authWorkerAction<TaskHeartbeatRequest>(ctx, "task.heartbeat");
  const task = ctx.broker.heartbeatTask(ctx.taskId, workerId, normalizeLastProgressAt(body.lastProgressAt));
  await awaitDurablePersistenceAck(ctx.stateStore);
  sendTask(ctx, task);
}

interface TaskHeartbeatRequest extends WorkerScopedBody {
  /** Optional harness progress-surface mtime (ISO 8601) observed by the worker. */
  lastProgressAt?: string;
}

function normalizeLastProgressAt(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const trimmed = value.trim();
  return Number.isNaN(Date.parse(trimmed)) ? undefined : trimmed;
}

interface TaskCheckpointBody extends WorkerScopedBody {
  state?: string;
  checkpointId?: string;
  reason?: string;
  decisionType?: string;
  artifactRefs?: string[];
}

/** POST /tasks/:id/checkpoint — a worker records a pause/awaiting-operator checkpoint. */
export async function handleCheckpointTaskRequest(ctx: TaskScopedContext): Promise<void> {
  const { body, workerId } = await authWorkerAction<TaskCheckpointBody>(ctx, "task.checkpoint");
  const task = ctx.broker.checkpointTask(ctx.taskId, workerId, {
    state: body.state as "paused" | "awaiting_operator",
    checkpointId: body.checkpointId,
    reason: body.reason,
    decisionType: body.decisionType,
    artifactRefs: body.artifactRefs,
  });
  await awaitDurablePersistenceAck(ctx.stateStore);
  sendTask(ctx, task);
}

/** POST /tasks/:id/complete — a worker reports successful completion. */
export async function handleCompleteTaskRequest(ctx: TaskScopedContext): Promise<void> {
  const { body, workerId, verifiedWorker } = await authWorkerAction<TaskCompleteRequest>(ctx, "task.complete");
  const result = verifyAndCountersignResultProvenance(ctx, body.result, verifiedWorker);
  const task = ctx.broker.completeTask(ctx.taskId, workerId, result);
  await awaitDurablePersistenceAck(ctx.stateStore);
  sendTask(ctx, task);
}

/** POST /tasks/:id/evidence — a worker posts outcome evidence (complete or fail). */
export async function handlePostEvidenceRequest(ctx: TaskScopedContext): Promise<void> {
  const { body, workerId, verifiedWorker } = await authWorkerAction<TaskEvidenceRequest>(ctx, "task.evidence");
  const outcome = body.outcome ?? "done";
  if (outcome === "done" || outcome === "pr") {
    const result = verifyAndCountersignResultProvenance(ctx, body.result, verifiedWorker);
    const task = ctx.broker.completeTask(ctx.taskId, workerId, result);
    await awaitDurablePersistenceAck(ctx.stateStore);
    sendTask(ctx, task);
    return;
  }
  if (outcome === "blocked" || outcome === "failed") {
    const task = ctx.broker.failTask(ctx.taskId, workerId, body.error ?? {
      code: outcome,
      message: body.result?.summary ?? body.result?.note ?? `worker posted ${outcome} evidence`,
    });
    await awaitDurablePersistenceAck(ctx.stateStore);
    sendTask(ctx, task);
    return;
  }
  throw new BrokerError("bad_request", "outcome must be done, pr, blocked, or failed");
}

/** POST /tasks/:id/fail — a worker reports a failure. */
export async function handleFailTaskRequest(ctx: TaskScopedContext): Promise<void> {
  const { body, workerId } = await authWorkerAction<TaskFailRequest>(ctx, "task.fail");
  // #1815 item 5: workers validate review evidence locally; when the verdict
  // gate failed they submit the held result so the broker preserves the
  // negative findings instead of discarding them.
  const task = ctx.broker.failTask(ctx.taskId, workerId, body.error, {
    negativeVerdictResult: body.negativeVerdictEvidence,
  });
  await awaitDurablePersistenceAck(ctx.stateStore);
  sendTask(ctx, task);
}

/** Route dispatcher for the worker-signed task lifecycle routes. */
export async function handleTasksWorkerRouteIfMatched(
  ctx: TasksWorkerRouteContext,
): Promise<boolean> {
  if (ctx.method !== "POST") {
    return false;
  }
  if (!(ctx.segments[0] === "tasks" && ctx.segments[1])) {
    return false;
  }
  const scoped: TaskScopedContext = { ...ctx, taskId: ctx.segments[1] };
  switch (ctx.segments[2]) {
    case "claim":
      await handleClaimTaskRequest(scoped);
      return true;
    case "start":
      await handleStartTaskRequest(scoped);
      return true;
    case "heartbeat":
      await handleHeartbeatTaskRequest(scoped);
      return true;
    case "checkpoint":
      await handleCheckpointTaskRequest(scoped);
      return true;
    case "complete":
      await handleCompleteTaskRequest(scoped);
      return true;
    case "evidence":
      await handlePostEvidenceRequest(scoped);
      return true;
    case "fail":
      await handleFailTaskRequest(scoped);
      return true;
    default:
      return false;
  }
}
