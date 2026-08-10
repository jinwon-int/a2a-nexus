// Task diagnostics: requeue-reason derivation, latest-audit lookup, durable
// signal projection, and exchange thread-message collection, extracted from
// broker.ts. Pure functions over task/audit/worker records; they hold no broker
// state.
import {
  computeTaskDiagnosticStatus,
  resolveTaskStalenessSignalMs,
} from "./broker-status-predicates.js";
import { isWorkerStale } from "./broker-worker-status.js";
import type {
  A2AExchangeMessageRecord,
  AuditAction,
  AuditEvent,
  TaskDiagnosticReport,
  TaskDiagnosticStatus,
  TaskRecord,
  TaskTombstone,
  WorkerRecord,
} from "./types.js";
// TaskDiagnosticsOptions is defined and exported by broker.ts; imported here
// type-only, so there is no runtime import cycle.
import type { TaskDiagnosticsOptions } from "./broker.js";

export function collectThreadMessageIds(
  messages: A2AExchangeMessageRecord[],
  parentMessageId: string,
): Set<string> {
  const allowedIds = new Set<string>([parentMessageId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const message of messages) {
      if (message.parentMessageId && allowedIds.has(message.parentMessageId) && !allowedIds.has(message.id)) {
        allowedIds.add(message.id);
        changed = true;
      }
    }
  }
  return allowedIds;
}

export function getTaskRequeueReason(
  task: TaskRecord,
  olderThanMs: number,
  staleWorkerIds: Set<string>,
  nowMs: number,
): string | null {
  if (task.status !== "claimed" && task.status !== "running") {
    return null;
  }

  if (task.completedAt) {
    return null;
  }

  // A checkpointed task is deliberately suspended (paused/awaiting_operator),
  // not stale: requeueing it would strip the public input-required projection
  // while the checkpoint remains. Checkpoint expiry is handled separately by
  // the timeout sweep (contract: cancelled on timeout), not by requeue.
  if (task.checkpoint) {
    return null;
  }

  if (task.claimedBy && staleWorkerIds.has(task.claimedBy)) {
    return `worker ${task.claimedBy} is stale`;
  }

  const lastActivityAt = resolveTaskStalenessSignalMs(task, nowMs);

  if (nowMs - lastActivityAt >= olderThanMs) {
    return `task exceeded stale threshold ${olderThanMs}ms`;
  }

  return null;
}

export function findLatestTaskAuditEvent(
  events: Iterable<AuditEvent>,
  taskId: string,
  action: AuditAction,
): AuditEvent | undefined {
  let latest: AuditEvent | undefined;
  for (const event of events) {
    if (event.targetId !== taskId || event.action !== action) {
      continue;
    }
    if (!latest || event.createdAt > latest.createdAt) {
      latest = event;
    }
  }
  return latest;
}

export function projectTaskDurableSignals(params: {
  task: TaskRecord;
  diagnosticStatus: TaskDiagnosticStatus;
  tombstone?: TaskTombstone;
  assignedWorker?: WorkerRecord;
  staleWorker: boolean;
  lastRequeueEvent?: AuditEvent;
}): Pick<TaskDiagnosticReport, "brokerState" | "reconcileNeeded" | "interruption" | "brokerHints"> {
  const { task, diagnosticStatus, tombstone, assignedWorker, staleWorker, lastRequeueEvent } = params;
  const staleLease = diagnosticStatus === "stale";
  const requeued = (task.requeueCount ?? 0) > 0;

  const lateEvidence = task.lateEvidenceAfterCancel
    ? { kind: task.lateEvidenceAfterCancel.kind as "complete" | "fail", submittedAt: task.lateEvidenceAfterCancel.submittedAt, submittedBy: task.lateEvidenceAfterCancel.submittedBy }
    : undefined;

  const brokerHints: TaskDiagnosticReport["brokerHints"] = {
    staleLease,
    staleWorker,
    cancellationRequested: Boolean(task.cancellation),
    requeued,
    lastRequeueAt: lastRequeueEvent?.createdAt,
    lastRequeueReason: lastRequeueEvent?.note,
    workerLastSeenAt: assignedWorker?.lastSeenAt,
    tombstoneReason: tombstone?.tombstoneReason,
    supersededByTaskId: task.cancellation?.supersededByTaskId,
    supersededByPrUrl: task.cancellation?.supersededByPrUrl,
    supersededRoundId: task.cancellation?.roundId,
    lateEvidenceAfterCancel: lateEvidence,
  };

  if (tombstone) {
    switch (tombstone.tombstoneReason) {
      case "timeout":
        return {
          brokerState: "terminal",
          reconcileNeeded: false,
          interruption: {
            kind: "timeout",
            source: "tombstone",
            summary: "broker marked the task as timed out",
            detectedAt: tombstone.tombstonedAt,
            reason: tombstone.error?.message,
          },
          brokerHints,
        };
      case "worker_lost":
        return {
          brokerState: "terminal",
          reconcileNeeded: false,
          interruption: {
            kind: "worker_lost",
            source: "tombstone",
            summary: "broker terminated the task after worker loss",
            detectedAt: tombstone.tombstonedAt,
          },
          brokerHints,
        };
      case "dead_lettered":
        return {
          brokerState: "terminal",
          reconcileNeeded: false,
          interruption: {
            kind: "dead_lettered",
            source: "tombstone",
            summary: "broker dead-lettered the task after exhausting requeues",
            detectedAt: tombstone.tombstonedAt,
            reason: tombstone.error?.message,
          },
          brokerHints,
        };
      case "canceled":
        if (task.cancellation?.kind === "superseded") {
          return {
            brokerState: "terminal",
            reconcileNeeded: false,
            interruption: {
              kind: "superseded",
              source: "tombstone",
              summary: "broker canceled the task as superseded by finalizer selection",
              detectedAt: tombstone.tombstonedAt,
              actorId: task.cancellation.requestedBy,
              reason: task.cancellation.reason,
            },
            brokerHints,
          };
        }
        return {
          brokerState: "terminal",
          reconcileNeeded: false,
          interruption: {
            kind: "operator_canceled",
            source: "tombstone",
            summary: "broker canceled the task",
            detectedAt: tombstone.tombstonedAt,
            actorId: task.cancellation?.requestedBy,
            reason: task.cancellation?.reason,
          },
          brokerHints,
        };
      case "canceled_with_late_completion":
        return {
          brokerState: "terminal",
          reconcileNeeded: false,
          interruption: {
            kind: "late_completion_after_cancel",
            source: "tombstone",
            summary: "worker posted completion/fail evidence after cancel",
            detectedAt: task.lateEvidenceAfterCancel?.submittedAt ?? tombstone.tombstonedAt,
            actorId: task.lateEvidenceAfterCancel?.submittedBy ?? task.cancellation?.requestedBy,
            reason: `${task.lateEvidenceAfterCancel?.kind ?? "unknown"} evidence after cancel`,
          },
          brokerHints,
        };
      case "failed":
        if (tombstone.error?.code === "timeout") {
          return {
            brokerState: "terminal",
            reconcileNeeded: false,
            interruption: {
              kind: "timeout",
              source: "tombstone",
              summary: "broker recorded timeout failure for the task",
              detectedAt: tombstone.tombstonedAt,
              reason: tombstone.error?.message,
            },
            brokerHints,
          };
        }
        return {
          brokerState: "terminal",
          reconcileNeeded: false,
          interruption: {
            kind: "failed",
            source: "tombstone",
            summary: "broker recorded task failure",
            detectedAt: tombstone.tombstonedAt,
            reason: tombstone.error?.message,
          },
          brokerHints,
        };
    }
  }

  if (staleWorker && (task.status === "claimed" || task.status === "running")) {
    return {
      brokerState: "reconcile_needed",
      reconcileNeeded: true,
      interruption: {
        kind: "stale_worker",
        source: "worker_state",
        summary: "assigned worker is stale while the task is still active",
        detectedAt: assignedWorker?.lastSeenAt,
        actorId: task.assignedWorkerId,
      },
      brokerHints,
    };
  }

  if (staleLease && (task.status === "claimed" || task.status === "running")) {
    return {
      brokerState: "reconcile_needed",
      reconcileNeeded: true,
      interruption: {
        kind: "stale_lease",
        source: "task_state",
        summary: "task lease is stale and should be reconciled from broker state",
      },
      brokerHints,
    };
  }

  if (task.status === "queued" && requeued) {
    return {
      brokerState: "interrupted",
      reconcileNeeded: false,
      interruption: {
        kind: "requeued",
        source: "audit",
        summary: "broker requeued the task after interruption detection",
        detectedAt: lastRequeueEvent?.createdAt,
        reason: lastRequeueEvent?.note,
      },
      brokerHints,
    };
  }

  return {
    brokerState: task.status === "succeeded" ? "terminal" : "healthy",
    reconcileNeeded: false,
    interruption: undefined,
    brokerHints,
  };
}

/**
 * Assemble a TaskDiagnosticReport from a task plus its already-resolved
 * tombstone / assigned-worker / last-requeue-event. The broker resolves those
 * three (from overrides or its own lookups) and delegates the pure computation —
 * diagnostic status, worker staleness, durable-signal projection, and the
 * lifecycle/timing fields — here.
 */
export function buildTaskDiagnosticReport(
  task: TaskRecord,
  resolved: {
    tombstone?: TaskTombstone;
    assignedWorker?: WorkerRecord;
    lastRequeueEvent?: AuditEvent;
  },
  options?: TaskDiagnosticsOptions,
): TaskDiagnosticReport {
  const nowMs = options?.nowMs ?? Date.now();
  const staleAfterMs = options?.staleAfterMs ?? 120_000; // 2 min default
  const longRunningAfterMs = options?.longRunningAfterMs ?? 3_600_000; // 1 hr default
  const workerOfflineAfterMs = options?.workerOfflineAfterMs ?? 90_000;

  const { tombstone, assignedWorker, lastRequeueEvent } = resolved;
  const diagnosticStatus = computeTaskDiagnosticStatus(task, staleAfterMs, longRunningAfterMs, nowMs);
  const staleWorker = assignedWorker
    ? isWorkerStale(assignedWorker.lastSeenAt, workerOfflineAfterMs, nowMs)
    : false;
  const durableSignals = projectTaskDurableSignals({
    task,
    diagnosticStatus,
    tombstone,
    assignedWorker,
    staleWorker,
    lastRequeueEvent,
  });
  const createdAtMs = Date.parse(task.createdAt);
  const lastStatusChangeMs = Math.max(
    createdAtMs,
    task.claimedAt ? Date.parse(task.claimedAt) : 0,
    task.completedAt ? Date.parse(task.completedAt) : 0,
    task.lastHeartbeatAt ? Date.parse(task.lastHeartbeatAt) : 0,
    task.lastProgressAt ? Date.parse(task.lastProgressAt) : 0,
  );
  const stalenessMs = task.status === "claimed" || task.status === "running"
    ? nowMs - resolveTaskStalenessSignalMs(task, nowMs)
    : undefined;

  return {
    taskId: task.id,
    diagnosticStatus,
    brokerState: durableSignals.brokerState,
    reconcileNeeded: durableSignals.reconcileNeeded,
    interruption: durableSignals.interruption,
    task: structuredClone(task),
    currentStatusDurationMs: nowMs - lastStatusChangeMs,
    stalenessMs,
    brokerHints: durableSignals.brokerHints,
    tombstone: tombstone ? structuredClone(tombstone) : undefined,
    lifecycle: {
      createdAt: task.createdAt,
      claimedAt: task.claimedAt,
      startedAt: task.status === "running" || task.status === "succeeded" || task.status === "failed"
        ? task.claimedAt
        : undefined,
      lastHeartbeatAt: task.lastHeartbeatAt,
      lastProgressAt: task.lastProgressAt,
      completedAt: task.completedAt,
      tombstonedAt: tombstone?.tombstonedAt,
    },
  };
}
