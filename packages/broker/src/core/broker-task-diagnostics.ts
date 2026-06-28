// Task diagnostics: requeue-reason derivation, latest-audit lookup, durable
// signal projection, and exchange thread-message collection, extracted from
// broker.ts. Pure functions over task/audit/worker records; they hold no broker
// state.
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

  const lastActivityAt = Date.parse(task.updatedAt || task.claimedAt || task.createdAt);
  if (!Number.isFinite(lastActivityAt)) {
    return null;
  }

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
