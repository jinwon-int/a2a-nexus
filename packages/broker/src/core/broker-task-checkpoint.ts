// Checkpoint/interrupt cluster extracted from broker.ts (#1289 R4 L-broker-14
// — lifecycle lane 3/4). Implements contracts/a2a/checkpoint-interrupt.md:
// checkpointTask records a bounded, shape-checked pause/awaiting_operator
// checkpoint (§2.4 redaction bounds, §2.2 frozen decision types); resumeTask
// clears it idempotently; heartbeatTask stamps liveness with throttled audit
// sampling. Pure move: state effects are callback-injected via
// TaskCheckpointContext (the broker-exchange.ts pattern) and the
// heartbeat-audit throttle state stays class-owned behind two callbacks;
// InMemoryA2ABroker keeps all three public methods as delegators.
import { randomUUID } from "node:crypto";

import { BrokerError } from "./broker-error.js";
import { isoNow } from "./broker-helpers.js";
import { isTerminalTaskStatus } from "./broker-status-predicates.js";
import { assertTaskStatus } from "./broker-transition-guards.js";
import type { TaskUpdateReason } from "./broker-contracts.js";
import type {
  AuditAction,
  AuditEvent,
  TaskCheckpointState,
  TaskInterruptDecisionType,
  TaskRecord,
} from "./types.js";

/** Frozen interrupt decision types (contracts/a2a/checkpoint-interrupt.md §2.2). */
const TASK_INTERRUPT_DECISION_TYPES: readonly TaskInterruptDecisionType[] = [
  "safety_gate",
  "ambiguous_scope",
  "approval_required",
  "conflict_detected",
];

export interface TaskCheckpointContext {
  requireTask(id: string): TaskRecord;
  assertTaskWorker(task: TaskRecord, workerId: string, action: string): void;
  setTaskRecord(task: TaskRecord): void;
  appendAuditEvent(input: {
    actorId: string;
    action: AuditAction;
    targetType: AuditEvent["targetType"];
    targetId: string;
    proposalId?: string;
    note?: string;
  }): AuditEvent;
  persistState(): void;
  emitTaskEvent(task: TaskRecord, reason: TaskUpdateReason): void;
  shouldPersistHeartbeatAudit(taskId: string, nowMs: number): boolean;
  markHeartbeatAuditPersisted(taskId: string, nowMs: number): void;
}

/**
 * Record a checkpoint (contracts/a2a/checkpoint-interrupt.md). The task
 * stays non-terminal; `awaiting_operator` marks a human-interrupt pause
 * that projects as the A2A `input-required` state until cleared.
 */
export function checkpointTask(
  taskId: string,
  workerId: string,
  request: {
    state: TaskCheckpointState;
    checkpointId?: string;
    reason?: string;
    decisionType?: string;
    artifactRefs?: string[];
  },
  context: TaskCheckpointContext,
): TaskRecord {
  const task = context.requireTask(taskId);
  context.assertTaskWorker(task, workerId, "checkpoint");
  assertTaskStatus(task.status, ["claimed", "running"], "checkpoint");
  if (request.state !== "paused" && request.state !== "awaiting_operator") {
    throw new BrokerError("bad_request", "checkpoint state must be paused or awaiting_operator");
  }

  // Checkpoint inputs become operator-visible and audit-visible state, so
  // they are bounded and shape-checked before being recorded (contract
  // §2.4: redacted, no raw internal state).
  const checkpointId = request.checkpointId?.trim() || randomUUID();
  if (checkpointId.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(checkpointId)) {
    throw new BrokerError("bad_request", "checkpointId must be <=128 chars of [A-Za-z0-9._:-]");
  }
  const reason = request.reason?.trim() || undefined;
  if (reason !== undefined && (reason.length > 500 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(reason))) {
    throw new BrokerError("bad_request", "checkpoint reason must be <=500 chars with no control characters");
  }
  let decisionType: TaskInterruptDecisionType | undefined;
  if (request.state === "awaiting_operator") {
    // Contract §2.2: human interrupts carry one of the four frozen
    // decision types; approval_required is the default interrupt shape.
    const requested = request.decisionType?.trim() || "approval_required";
    if (!TASK_INTERRUPT_DECISION_TYPES.includes(requested as TaskInterruptDecisionType)) {
      throw new BrokerError(
        "bad_request",
        `decisionType must be one of ${TASK_INTERRUPT_DECISION_TYPES.join(", ")}`,
      );
    }
    decisionType = requested as TaskInterruptDecisionType;
  } else if (request.decisionType?.trim()) {
    throw new BrokerError("bad_request", "decisionType only applies to awaiting_operator checkpoints");
  }
  let artifactRefs: string[] | undefined;
  if (request.artifactRefs !== undefined) {
    if (!Array.isArray(request.artifactRefs) || request.artifactRefs.length > 32) {
      throw new BrokerError("bad_request", "artifactRefs must be an array of at most 32 references");
    }
    artifactRefs = request.artifactRefs.map((ref) => {
      const trimmed = typeof ref === "string" ? ref.trim() : "";
      if (!trimmed || trimmed.length > 256 || /[\u0000-\u001f]/.test(trimmed)) {
        throw new BrokerError("bad_request", "each artifactRef must be a 1-256 char string with no control characters");
      }
      return trimmed;
    });
  }

  const now = isoNow();
  task.checkpoint = {
    state: request.state,
    checkpointId,
    reason,
    ...(decisionType ? { decisionType } : {}),
    ...(artifactRefs && artifactRefs.length > 0 ? { artifactRefs } : {}),
    recordedAt: now,
    recordedBy: workerId,
  };
  task.updatedAt = now;
  context.setTaskRecord(task);
  context.appendAuditEvent({
    actorId: workerId,
    action: "task.checkpointed",
    targetType: "task",
    targetId: task.id,
    proposalId: task.proposalId,
    note: `checkpoint ${task.checkpoint.state}${decisionType ? ` (${decisionType})` : ""}: ${task.checkpoint.reason ?? task.checkpoint.checkpointId}`,
  });
  context.persistState();
  context.emitTaskEvent(task, "checkpointed");
  return task;
}

/** Clear an active checkpoint (operator approval, requester input, or worker resume). */
export function resumeTask(
  taskId: string,
  actorId: string,
  request: { checkpointId?: string },
  context: TaskCheckpointContext,
): TaskRecord {
  const task = context.requireTask(taskId);
  if (!task.checkpoint) {
    return task; // idempotent: nothing to resume
  }
  if (isTerminalTaskStatus(task.status)) {
    throw new BrokerError("invalid_transition", `cannot resume task while status is ${task.status}`);
  }
  if (request.checkpointId && request.checkpointId !== task.checkpoint.checkpointId) {
    throw new BrokerError("bad_request", "checkpointId does not match the active checkpoint");
  }

  const cleared = task.checkpoint;
  task.checkpoint = undefined;
  task.updatedAt = isoNow();
  context.setTaskRecord(task);
  context.appendAuditEvent({
    actorId,
    action: "task.resumed",
    targetType: "task",
    targetId: task.id,
    proposalId: task.proposalId,
    note: `resumed from ${cleared.state} checkpoint ${cleared.checkpointId}`,
  });
  context.persistState();
  context.emitTaskEvent(task, "resumed");
  return task;
}

export function heartbeatTask(taskId: string, workerId: string, context: TaskCheckpointContext, lastProgressAt?: string): TaskRecord {
  const task = context.requireTask(taskId);
  context.assertTaskWorker(task, workerId, "heartbeat");
  assertTaskStatus(task.status, ["claimed", "running"], "heartbeat");

  const now = isoNow();
  const nowMs = Date.parse(now);
  task.lastHeartbeatAt = now;
  if (lastProgressAt) {
    const reportedProgressMs = Date.parse(lastProgressAt);
    if (Number.isFinite(reportedProgressMs)) {
      const priorProgressMs = task.lastProgressAt ? Date.parse(task.lastProgressAt) : Number.NaN;
      const boundedProgressMs = Math.min(reportedProgressMs, nowMs);
      const monotonicProgressMs = Number.isFinite(priorProgressMs) && priorProgressMs <= nowMs
        ? Math.max(priorProgressMs, boundedProgressMs)
        : boundedProgressMs;
      task.lastProgressAt = new Date(monotonicProgressMs).toISOString();
    }
  }
  task.updatedAt = now;
  context.setTaskRecord(task);
  if (context.shouldPersistHeartbeatAudit(task.id, nowMs)) {
    context.appendAuditEvent({
      actorId: workerId,
      action: "task.heartbeat",
      targetType: "task",
      targetId: task.id,
      proposalId: task.proposalId,
      note: "task heartbeat",
    });
    context.markHeartbeatAuditPersisted(task.id, nowMs);
  }
  context.persistState();
  context.emitTaskEvent(task, "started"); // re-emit so subscribers see the heartbeat
  return task;
}
