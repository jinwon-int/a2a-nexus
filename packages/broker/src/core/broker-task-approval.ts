// Operator task-approval decision pair extracted from broker.ts (#1289 R4
// L-broker-12 — first of the four task-lifecycle lanes). approveTask flips a
// blocked approval-gated task back to queued with an approval record;
// rejectTaskApproval records the terminal outcome and cancels the task tree.
// Pure move: privileged-actor gates, idempotency/transition guards, audit
// action strings, and persist points are unchanged; state effects are
// callback-injected via TaskApprovalContext (the broker-exchange.ts pattern);
// InMemoryA2ABroker keeps both public methods as delegators.
import { randomUUID } from "node:crypto";

import { BrokerError } from "./broker-error.js";
import { isoNow } from "./broker-helpers.js";
import { isTerminalTaskStatus } from "./broker-status-predicates.js";
import {
  normalizeApprovalId,
  normalizeApprovalReason,
  normalizeApprovalTerminalStatus,
} from "./broker-wake-normalizers.js";
import { isPrivilegedTaskApprover } from "./policy.js";
import type { TaskUpdateReason } from "./broker-contracts.js";
import type {
  A2AExchangeState,
  AuditAction,
  AuditEvent,
  TaskApprovalRequest,
  TaskApprovalTerminalRequest,
  TaskRecord,
} from "./types.js";

export interface TaskApprovalContext {
  requireTask(id: string): TaskRecord;
  setTaskRecord(task: TaskRecord): void;
  syncExchangeStateFromTask(task: TaskRecord, nextStatus: A2AExchangeState["status"]): void;
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
  cancelTaskTree(task: TaskRecord, params: { actorId: string; reason?: string }): TaskRecord;
}

export function approveTask(taskId: string, request: TaskApprovalRequest, context: TaskApprovalContext): TaskRecord {
  const task = context.requireTask(taskId);
  if (!request.actor?.id) {
    throw new BrokerError("bad_request", "actor.id is required");
  }
  if (!isPrivilegedTaskApprover(request.actor)) {
    throw new BrokerError("policy_denied", "task approval requires a hub or operator actor");
  }
  if (task.policyContext?.requiresApproval !== true) {
    throw new BrokerError("invalid_transition", "task does not require approval");
  }
  if (task.approval) {
    return task;
  }
  if (isTerminalTaskStatus(task.status)) {
    throw new BrokerError("invalid_transition", `cannot approve task while status is ${task.status}`);
  }
  if (task.status !== "blocked" && task.status !== "queued") {
    throw new BrokerError("invalid_transition", `cannot approve task while status is ${task.status}`);
  }

  const now = isoNow();
  task.approval = {
    approvalId: normalizeApprovalId(request.approvalId) ?? randomUUID(),
    approvedAt: now,
    approvedBy: request.actor.id,
    actorRole: request.actor.role,
    requesterRole: task.requester.role,
    reason: normalizeApprovalReason(request.reason),
  };
  task.approvalOutcome = {
    status: "approved",
    approvalId: task.approval.approvalId,
    decidedAt: now,
    decidedBy: request.actor.id,
    actorRole: request.actor.role,
    requesterRole: task.requester.role,
    reason: task.approval.reason,
  };
  task.status = "queued";
  task.updatedAt = now;
  context.setTaskRecord(task);
  context.syncExchangeStateFromTask(task, "queued");
  context.appendAuditEvent({
    actorId: request.actor.id,
    action: "task.approved",
    targetType: "task",
    targetId: task.id,
    proposalId: task.proposalId,
    note: task.approval.reason ?? `approvalId=${task.approval.approvalId}`,
  });
  context.persistState();
  context.emitTaskEvent(task, "approved");
  return task;
}

export function rejectTaskApproval(
  taskId: string,
  request: TaskApprovalTerminalRequest,
  context: TaskApprovalContext,
): TaskRecord {
  const task = context.requireTask(taskId);
  if (!request.actor?.id) {
    throw new BrokerError("bad_request", "actor.id is required");
  }
  if (!isPrivilegedTaskApprover(request.actor)) {
    throw new BrokerError("policy_denied", "task approval rejection requires a hub or operator actor");
  }
  if (task.policyContext?.requiresApproval !== true) {
    throw new BrokerError("invalid_transition", "task does not require approval");
  }
  if (task.approval || task.approvalOutcome?.status === "approved") {
    throw new BrokerError("invalid_transition", "task approval is already approved");
  }
  if (task.approvalOutcome) {
    return task;
  }
  if (isTerminalTaskStatus(task.status)) {
    throw new BrokerError("invalid_transition", `cannot reject approval while task status is ${task.status}`);
  }
  if (task.status !== "blocked" && task.status !== "queued") {
    throw new BrokerError("invalid_transition", `cannot reject approval while task status is ${task.status}`);
  }

  const now = isoNow();
  const status = normalizeApprovalTerminalStatus(request.status);
  const reason = normalizeApprovalReason(request.reason) ?? `approval ${status}`;
  task.approvalOutcome = {
    status,
    approvalId: normalizeApprovalId(request.approvalId) ?? randomUUID(),
    decidedAt: now,
    decidedBy: request.actor.id,
    actorRole: request.actor.role,
    requesterRole: task.requester.role,
    reason,
  };
  const canceled = context.cancelTaskTree(task, {
    actorId: request.actor.id,
    reason,
  });
  context.appendAuditEvent({
    actorId: request.actor.id,
    action: "task.approval_rejected",
    targetType: "task",
    targetId: task.id,
    proposalId: task.proposalId,
    note: `${status}: ${reason}`,
  });
  context.persistState();
  return canceled;
}
