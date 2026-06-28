// Task wake-plan and approval-outcome normalizers extracted from broker.ts.
// Pure helpers that build the stable wake key and map wake/approval statuses to
// their default message, audit action, and update reason. They hold no broker
// state. TaskUpdateReason is defined in broker.ts and imported here as a
// type-only import (erased at runtime, so no runtime import cycle).
import type {
  AuditAction,
  TaskApprovalOutcomeStatus,
  TaskRecord,
  TaskWakePlanRequest,
  TaskWakeState,
} from "./types.js";
import type { TaskUpdateReason } from "./broker.js";

export function normalizeWakeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function normalizeApprovalId(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function normalizeApprovalReason(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function normalizeApprovalTerminalStatus(value: unknown): Exclude<TaskApprovalOutcomeStatus, "approved"> {
  return value === "expired" || value === "canceled" ? value : "rejected";
}

export function buildTaskWakeKey(task: TaskRecord, request: TaskWakePlanRequest): string {
  const explicit = normalizeWakeString(request.wakeKey);
  if (explicit) {
    return explicit;
  }
  const stableCorrelation =
    normalizeWakeString(request.correlationId) ??
    normalizeWakeString(task.payload.correlationId) ??
    task.id;
  const stableRun =
    normalizeWakeString(request.waitRunId) ??
    normalizeWakeString(task.payload.waitRunId) ??
    normalizeWakeString(request.targetSessionKey) ??
    task.targetNodeId;
  return `${stableCorrelation}:${stableRun}`;
}

export function defaultWakeDecisionMessage(status: Exclude<TaskWakeState["status"], "planned">): string {
  switch (status) {
    case "scheduled":
      return "Wake-on-Task scheduled.";
    case "skipped":
      return "Wake-on-Task skipped.";
    case "failed":
      return "Wake-on-Task failed.";
  }
}

export function wakeDecisionAuditAction(status: Exclude<TaskWakeState["status"], "planned">): AuditAction {
  switch (status) {
    case "scheduled":
      return "task.wake.scheduled";
    case "skipped":
      return "task.wake.skipped";
    case "failed":
      return "task.wake.failed";
  }
}

export function wakeDecisionUpdateReason(status: Exclude<TaskWakeState["status"], "planned">): TaskUpdateReason {
  switch (status) {
    case "scheduled":
      return "wake_scheduled";
    case "skipped":
      return "wake_skipped";
    case "failed":
      return "wake_failed";
  }
}

export function normalizeTaskWakeState(wake: TaskWakeState | undefined): TaskWakeState | undefined {
  if (!wake) {
    return undefined;
  }
  return {
    ...wake,
    replayCount: wake.replayCount ?? 0,
  };
}
