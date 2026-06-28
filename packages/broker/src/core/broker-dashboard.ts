// Broker dashboard builder, extracted from the InMemoryA2ABroker god-class.
// getDashboard() was a ~230-line read-only reporting method that derives a
// BrokerDashboard from the task/proposal/worker collections. The reasoning is
// pure — it only reads the supplied snapshots and returns a report object — so
// it moves here as a free function. The broker keeps a thin wrapper that
// gathers the inputs (including the two derived collections it computes via its
// own query helpers) and delegates.
//
// This module imports only leaf helpers and types, never broker.ts, so there is
// no import cycle.
import { ageSecFromIso, countBy, sortedCopy } from "./broker-helpers.js";
import { taskStatusSinceAt } from "./broker-record-helpers.js";
import {
  computeWorkerMobileHealth,
  effectiveOfflineAfterMs,
  isWorkerStale,
} from "./broker-worker-status.js";
import type {
  AuditEvent,
  BrokerDashboard,
  ChangeProposal,
  ProposalPipelineSummary,
  ProposalStatus,
  TaskHistorySummary,
  TaskQueueSummary,
  TaskRecord,
  TaskStatus,
  WorkerFleetSummary,
  WorkerRecord,
} from "./types.js";

const DEFAULT_OFFLINE_AFTER_MS = 90_000;

/** The broker collections and derived sets a dashboard is computed from. */
export interface BrokerDashboardInput {
  tasks: TaskRecord[];
  proposals: ChangeProposal[];
  workers: WorkerRecord[];
  /** Worker ids considered stale by the broker's own offline policy. */
  staleWorkerIds: Set<string>;
  /** Audit events with action "task.requeued", newest first. */
  requeuedAuditEvents: AuditEvent[];
}

export interface BrokerDashboardOptions {
  nowMs?: number;
  offlineAfterMs?: number;
  recentHistoryLimit?: number;
  oldestPendingLimit?: number;
  pendingActionLimit?: number;
}

export function buildBrokerDashboard(
  input: BrokerDashboardInput,
  options?: BrokerDashboardOptions,
): BrokerDashboard {
  const nowMs = options?.nowMs ?? Date.now();
  const offlineAfterMs = options?.offlineAfterMs ?? DEFAULT_OFFLINE_AFTER_MS;
  const recentHistoryLimit = options?.recentHistoryLimit ?? 10;
  const oldestPendingLimit = options?.oldestPendingLimit ?? 5;
  const pendingActionLimit = options?.pendingActionLimit ?? 5;

  const allTasks = input.tasks;
  const allProposals = input.proposals;
  const allWorkers = input.workers;
  const staleWorkerIds = input.staleWorkerIds;

  // --- Queue ---
  const pendingTasks = allTasks.filter(
    (t) => t.status === "blocked" || t.status === "queued" || t.status === "claimed",
  );
  const oldestPending = sortedCopy(
    pendingTasks,
    (a, b) => taskStatusSinceAt(a).localeCompare(taskStatusSinceAt(b)),
  ).slice(0, oldestPendingLimit);
  const queue: TaskQueueSummary = {
    total: pendingTasks.length,
    byStatus: countBy(allTasks, (t) => t.status) as Record<TaskStatus, number>,
    byIntent: countBy(allTasks, (t) => t.intent),
    oldestPending: oldestPending.map((t) => ({
      id: t.id,
      intent: t.intent,
      status: t.status,
      targetNodeId: t.targetNodeId,
      assignedWorkerId: t.assignedWorkerId,
      createdAt: t.createdAt,
      statusSinceAt: taskStatusSinceAt(t),
      statusAgeSec: ageSecFromIso(taskStatusSinceAt(t), nowMs),
    })),
  };

  // --- History ---
  const oneHourAgoMs = nowMs - 3_600_000;
  const completedTasks = allTasks.filter(
    (t) => t.status === "succeeded" && t.completedAt && Date.parse(t.completedAt) >= oneHourAgoMs,
  );
  const failedTasks = allTasks.filter(
    (t) => t.status === "failed" && t.completedAt && Date.parse(t.completedAt) >= oneHourAgoMs,
  );
  const recentOutcomes = sortedCopy(
    allTasks.filter((t) => (t.status === "succeeded" || t.status === "failed") && t.completedAt),
    (a, b) => {
      const cmp = (b.completedAt ?? "").localeCompare(a.completedAt ?? "");
      if (cmp !== 0) {
        return cmp;
      }
      const cmp2 = b.createdAt.localeCompare(a.createdAt);
      if (cmp2 !== 0) {
        return cmp2;
      }
      return b.id.localeCompare(a.id);
    },
  ).slice(0, recentHistoryLimit);
  const history: TaskHistorySummary = {
    completedLastHour: completedTasks.length,
    failedLastHour: failedTasks.length,
    totalCompleted: allTasks.filter((t) => t.status === "succeeded").length,
    totalFailed: allTasks.filter((t) => t.status === "failed").length,
    recent: recentOutcomes.map((t) => ({
      id: t.id,
      intent: t.intent,
      status: t.status,
      targetNodeId: t.targetNodeId,
      completedAt: t.completedAt!,
      result: t.result,
      error: t.error,
    })),
  };

  // --- Proposals ---
  const actionableStatuses = new Set<ProposalStatus>(["submitted", "validated", "approved"]);
  const pendingAction = sortedCopy(
    allProposals.filter((p) => actionableStatuses.has(p.status)),
    (a, b) => a.updatedAt.localeCompare(b.updatedAt),
  ).slice(0, pendingActionLimit)
    .map((p) => ({
      id: p.id,
      kind: p.kind,
      summary: p.summary,
      status: p.status,
      sourceNodeId: p.sourceNodeId,
      targetNodeId: p.targetNodeId,
      updatedAt: p.updatedAt,
    }));
  const proposals: ProposalPipelineSummary = {
    total: allProposals.length,
    byStatus: countBy(allProposals, (p) => p.status) as Record<ProposalStatus, number>,
    pendingAction,
  };

  // --- Workers ---
  let onlineCount = 0;
  let staleCount = 0;
  const byNode = allWorkers.map((w) => {
    const effectiveOffline = effectiveOfflineAfterMs(w.workerMode, offlineAfterMs);
    const isStale = isWorkerStale(w.lastSeenAt, effectiveOffline, nowMs);
    const status: WorkerFleetSummary["byNode"][number]["status"] = isStale ? "stale" : "online";
    if (isStale) {
      staleCount++;
    } else {
      onlineCount++;
    }
    return {
      nodeId: w.nodeId,
      role: w.role,
      displayName: w.displayName,
      status,
      activeTaskCount: allTasks.filter(
        (t) =>
          t.status === "claimed" || t.status === "running"
            ? t.assignedWorkerId === w.nodeId || t.targetNodeId === w.nodeId
            : false,
      ).length,
      lastSeenAt: w.lastSeenAt,
      lastSeenAgeSec: ageSecFromIso(w.lastSeenAt, nowMs),
      workerMode: w.workerMode,
      mobileHealth: computeWorkerMobileHealth(w.workerMode, w.lastSeenAt, nowMs),
    };
  });
  const workers: WorkerFleetSummary = {
    total: allWorkers.length,
    online: onlineCount,
    stale: staleCount,
    byNode,
  };

  const claimedTasks = allTasks.filter((task) => task.status === "claimed");
  const runningTasks = allTasks.filter((task) => task.status === "running");
  const oldestClaimedTask = sortedCopy(
    claimedTasks,
    (a, b) => taskStatusSinceAt(a).localeCompare(taskStatusSinceAt(b)),
  )[0];
  const oldestRunningTask = sortedCopy(
    runningTasks,
    (a, b) => taskStatusSinceAt(a).localeCompare(taskStatusSinceAt(b)),
  )[0];
  const staleWorkerAssignments = allTasks.filter((task) => {
    const workerId = task.assignedWorkerId ?? task.targetNodeId;
    return (
      (task.status === "claimed" || task.status === "running") &&
      typeof workerId === "string" &&
      staleWorkerIds.has(workerId)
    );
  }).length;
  const recentRequeueEvents = input.requeuedAuditEvents
    .slice(0, 5)
    .map((event) => ({
      taskId: event.targetId,
      actorId: event.actorId,
      createdAt: event.createdAt,
      note: event.note,
    }));
  const deadLetteredTasks = sortedCopy(
    allTasks.filter(
      (task) => task.status === "failed" && task.error?.code === "exceeded_requeue_limit",
    ),
    (a, b) => (b.completedAt ?? "").localeCompare(a.completedAt ?? ""),
  );
  const observability = {
    queuePressure: {
      blocked: queue.byStatus.blocked ?? 0,
      queued: queue.byStatus.queued ?? 0,
      claimed: queue.byStatus.claimed ?? 0,
      running: queue.byStatus.running ?? 0,
      staleWorkerAssignments,
      oldestClaimed: oldestClaimedTask
        ? {
            id: oldestClaimedTask.id,
            intent: oldestClaimedTask.intent,
            targetNodeId: oldestClaimedTask.targetNodeId,
            assignedWorkerId: oldestClaimedTask.assignedWorkerId,
            createdAt: oldestClaimedTask.createdAt,
            statusSinceAt: taskStatusSinceAt(oldestClaimedTask),
            statusAgeSec: ageSecFromIso(taskStatusSinceAt(oldestClaimedTask), nowMs),
          }
        : undefined,
      oldestRunning: oldestRunningTask
        ? {
            id: oldestRunningTask.id,
            intent: oldestRunningTask.intent,
            targetNodeId: oldestRunningTask.targetNodeId,
            assignedWorkerId: oldestRunningTask.assignedWorkerId,
            createdAt: oldestRunningTask.createdAt,
            statusSinceAt: taskStatusSinceAt(oldestRunningTask),
            statusAgeSec: ageSecFromIso(taskStatusSinceAt(oldestRunningTask), nowMs),
          }
        : undefined,
    },
    recovery: {
      totalRequeued: input.requeuedAuditEvents.length,
      totalDeadLettered: deadLetteredTasks.length,
      recentRequeues: recentRequeueEvents,
      recentDeadLetters: deadLetteredTasks.slice(0, 5).map((task) => ({
        id: task.id,
        intent: task.intent,
        targetNodeId: task.targetNodeId,
        assignedWorkerId: task.assignedWorkerId,
        completedAt: task.completedAt,
        error: task.error,
        requeueCount: task.requeueCount,
      })),
    },
    workerHealth: {
      staleWorkersWithActiveTasks: byNode
        .filter((worker) => worker.status === "stale" && worker.activeTaskCount > 0)
        .map((worker) => ({
          nodeId: worker.nodeId,
          activeTaskCount: worker.activeTaskCount,
          lastSeenAt: worker.lastSeenAt,
          lastSeenAgeSec: worker.lastSeenAgeSec,
        })),
    },
  };

  return {
    generatedAt: new Date(nowMs).toISOString(),
    queue,
    history,
    proposals,
    workers,
    observability,
  };
}
