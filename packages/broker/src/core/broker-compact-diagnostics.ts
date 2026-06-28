// Compact diagnostics builder, extracted from the InMemoryA2ABroker god-class.
// getCompactDiagnostics() was a ~50-line read-only report that tallies task /
// worker / audit health into a small fixed-shape summary. The reasoning is pure
// — it only reads the supplied collections — so it moves here as a free
// function; the broker keeps a thin wrapper that gathers the inputs and
// delegates.
//
// This module imports only leaf helpers and constants plus type-only references
// to broker.ts, so there is no runtime import cycle.
import { countBy } from "./broker-helpers.js";
import { computeTaskDiagnosticStatus } from "./broker-status-predicates.js";
import { isWorkerStale } from "./broker-worker-status.js";
import { REQUEUE_EXHAUSTED_ERROR_CODE } from "./broker-error.js";
import type { AuditEvent, TaskRecord, TaskStatus, WorkerRecord } from "./types.js";
import type { BrokerCompactDiagnostics, BrokerRetentionPolicy } from "./broker.js";

export interface CompactDiagnosticsInput {
  tasks: TaskRecord[];
  workers: WorkerRecord[];
  audits: AuditEvent[];
  /** Number of tasks with a non-empty replay buffer. */
  bufferedEventStreams: number;
  retentionPolicy: BrokerRetentionPolicy;
  runtimeRepositories: BrokerCompactDiagnostics["runtimeRepositories"];
}

export interface CompactDiagnosticsOptions {
  nowMs?: number;
  staleAfterMs?: number;
  longRunningAfterMs?: number;
  workerOfflineAfterMs?: number;
}

export function buildCompactDiagnostics(
  input: CompactDiagnosticsInput,
  options?: CompactDiagnosticsOptions,
): BrokerCompactDiagnostics {
  const nowMs = options?.nowMs ?? Date.now();
  const staleAfterMs = options?.staleAfterMs ?? 120_000;
  const longRunningAfterMs = options?.longRunningAfterMs ?? 3_600_000;
  const workerOfflineAfterMs = options?.workerOfflineAfterMs ?? 90_000;
  const { tasks, workers, audits } = input;
  const staleTasks = tasks.filter((task) => computeTaskDiagnosticStatus(task, staleAfterMs, longRunningAfterMs, nowMs) === "stale");
  const longRunningTasks = tasks.filter((task) => computeTaskDiagnosticStatus(task, staleAfterMs, longRunningAfterMs, nowMs) === "long_running");
  const staleWorkers = workers.filter((worker) => isWorkerStale(worker.lastSeenAt, workerOfflineAfterMs, nowMs));

  return {
    generatedAt: new Date(nowMs).toISOString(),
    tasks: {
      total: tasks.length,
      byStatus: countBy(tasks, (task) => task.status) as Record<TaskStatus, number>,
      stale: staleTasks.length,
      longRunning: longRunningTasks.length,
      bufferedEventStreams: input.bufferedEventStreams,
    },
    workers: {
      total: workers.length,
      stale: staleWorkers.length,
    },
    audit: {
      total: audits.length,
      requeued: audits.filter((event) => event.action === "task.requeued").length,
      deadLettered: tasks.filter((task) => task.error?.code === REQUEUE_EXHAUSTED_ERROR_CODE).length,
    },
    retention: { ...input.retentionPolicy },
    runtimeRepositories: { ...input.runtimeRepositories },
  };
}
