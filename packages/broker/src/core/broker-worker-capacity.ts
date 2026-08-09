// Worker capacity summary builder, extracted from the InMemoryA2ABroker
// god-class. getWorkerCapacitySummary() was a ~100-line read-only report that
// buckets active tasks per worker and tallies online/stale/queue counts. The
// reasoning is pure — it only reads the supplied worker/task lists plus the
// identity-churn warnings — so it moves here as a free function; the broker
// keeps a thin wrapper that gathers the inputs and delegates.
//
// This module imports only leaf helpers and types, never broker.ts, so there is
// no import cycle.
import { ageSecFromIso } from "./broker-helpers.js";
import { taskStatusSinceAt } from "./broker-record-helpers.js";
import {
  computeWorkerMobileHealth,
  effectiveOfflineAfterMs,
  isWorkerStale,
  isWorkerSubstantiveAnalysisReady,
} from "./broker-worker-status.js";
import type {
  TaskRecord,
  WorkerCapacitySummary,
  WorkerCapacitySummaryItem,
  WorkerIdentityWarning,
  WorkerRecord,
} from "./types.js";

export interface WorkerCapacityInput {
  workers: WorkerRecord[];
  tasks: TaskRecord[];
  /** Identity-churn warnings keyed by nodeId (from the churn tracker). */
  identityWarnings: Record<string, WorkerIdentityWarning>;
}

export interface WorkerCapacityOptions {
  nowMs?: number;
  workerOfflineAfterMs?: number;
  taskStaleAfterMs?: number;
}

export function buildWorkerCapacitySummary(
  input: WorkerCapacityInput,
  options?: WorkerCapacityOptions,
): WorkerCapacitySummary {
  const nowMs = options?.nowMs ?? Date.now();
  const workerOfflineAfterMs = options?.workerOfflineAfterMs ?? 90_000;
  const taskStaleAfterMs = options?.taskStaleAfterMs ?? workerOfflineAfterMs;
  const workers = input.workers;
  const tasks = input.tasks.filter((task) =>
    task.status === "queued" || task.status === "claimed" || task.status === "running",
  );
  const tasksByWorker = new Map<string, TaskRecord[]>();
  for (const task of tasks) {
    const workerId = task.assignedWorkerId ?? task.targetNodeId;
    if (!workerId) {
      continue;
    }
    const bucket = tasksByWorker.get(workerId) ?? [];
    bucket.push(task);
    tasksByWorker.set(workerId, bucket);
  }

  let online = 0;
  let staleWorkers = 0;
  let queued = 0;
  let claimed = 0;
  let running = 0;
  let staleTasks = 0;
  let active = 0;
  let substantiveAnalysisReadyOnline = 0;

  const items: WorkerCapacitySummaryItem[] = workers.map((worker) => {
    // Use mobile-aware stale threshold when the worker declares mobile mode
    const effectiveOffline = effectiveOfflineAfterMs(worker.workerMode, workerOfflineAfterMs);
    const workerIsStale = isWorkerStale(worker.lastSeenAt, effectiveOffline, nowMs);
    const substantiveAnalysisReady = isWorkerSubstantiveAnalysisReady(worker);
    if (workerIsStale) {
      staleWorkers += 1;
    } else {
      online += 1;
      if (substantiveAnalysisReady) {
        substantiveAnalysisReadyOnline += 1;
      }
    }

    const workerTasks = tasksByWorker.get(worker.nodeId) ?? [];
    const counts = { queued: 0, claimed: 0, running: 0, stale: 0, active: 0 };
    let latestTaskUpdatedAt: string | undefined;
    for (const task of workerTasks) {
      if (task.status === "queued") {
        counts.queued += 1;
      } else if (task.status === "claimed") {
        counts.claimed += 1;
      } else if (task.status === "running") {
        counts.running += 1;
      }
      counts.active += 1;
      if (!latestTaskUpdatedAt || task.updatedAt > latestTaskUpdatedAt) {
        latestTaskUpdatedAt = task.updatedAt;
      }
      if ((task.status === "claimed" || task.status === "running") && (
        workerIsStale || nowMs - Date.parse(taskStatusSinceAt(task)) > taskStaleAfterMs
      )) {
        counts.stale += 1;
      }
    }

    queued += counts.queued;
    claimed += counts.claimed;
    running += counts.running;
    staleTasks += counts.stale;
    active += counts.active;

    const identityWarning = input.identityWarnings[worker.nodeId];
    return {
      nodeId: worker.nodeId,
      role: worker.role,
      displayName: worker.displayName,
      status: workerIsStale ? "stale" : "online",
      lastSeenAt: worker.lastSeenAt,
      lastSeenAgeSec: ageSecFromIso(worker.lastSeenAt, nowMs),
      counts,
      latestTaskUpdatedAt,
      workerMode: worker.workerMode,
      ...(worker.capabilities.implementationCapability
        ? { implementationCapability: worker.capabilities.implementationCapability }
        : {}),
      runtimeFlavor: worker.capabilities.runtimeFlavor,
      gatewayRequired: worker.capabilities.gatewayRequired,
      substantiveAnalysisReady,
      mobileHealth: computeWorkerMobileHealth(worker.workerMode, worker.lastSeenAt, nowMs),
      ...(identityWarning ? { identityWarning } : {}),
    };
  });

  return {
    generatedAt: new Date(nowMs).toISOString(),
    workerOfflineAfterMs,
    taskStaleAfterMs,
    totals: {
      workers: workers.length,
      online,
      staleWorkers,
      queued,
      claimed,
      running,
      staleTasks,
      active,
      substantiveAnalysisReadyOnline,
    },
    items,
  };
}
