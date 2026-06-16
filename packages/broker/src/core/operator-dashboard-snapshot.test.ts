import test from "node:test";
import assert from "node:assert/strict";

import { buildOperatorDashboardSnapshot } from "./operator-dashboard-snapshot.js";
import type { BrokerDashboard, TaskDiagnosticReport, TaskRecord } from "./types.js";

function task(overrides: Partial<TaskRecord> & Pick<TaskRecord, "id" | "status">): TaskRecord {
  return {
    id: overrides.id,
    intent: overrides.intent ?? "analyze",
    requester: { id: "operator", kind: "agent", role: "operator" },
    target: { id: overrides.targetNodeId ?? "worker-a", kind: "agent", role: "analyst" },
    targetNodeId: overrides.targetNodeId ?? "worker-a",
    assignedWorkerId: overrides.assignedWorkerId,
    status: overrides.status,
    createdAt: "2026-06-16T00:00:00.000Z",
    updatedAt: "2026-06-16T00:00:00.000Z",
    claimedBy: overrides.claimedBy,
    requeueCount: overrides.requeueCount,
    lastHeartbeatAt: overrides.lastHeartbeatAt,
    completedAt: overrides.completedAt,
    error: overrides.error,
    payload: {},
  } as unknown as TaskRecord;
}

const dashboard = {
  generatedAt: "2026-06-16T00:00:10.000Z",
  workers: [],
  queue: { byStatus: { running: 1, failed: 1 } },
  observability: {
    queuePressure: {
      staleWorkerAssignments: 1,
      oldestClaimed: null,
      oldestRunning: null,
    },
    workerHealth: { staleWorkersWithActiveTasks: 1 },
    recovery: {
      totalRequeued: 2,
      recentRequeues: [],
      totalDeadLettered: 1,
      recentDeadLetters: [],
    },
  },
} as unknown as BrokerDashboard;

function diagnostic(overrides: Partial<TaskDiagnosticReport>): TaskDiagnosticReport {
  return {
    taskId: "task",
    status: "running",
    currentStatusDurationMs: 125_000,
    diagnosticStatus: "long_running",
    brokerHints: { staleWorker: false, assignedWorkerMissing: false },
    interruption: null,
    staleAfterMs: 60_000,
    longRunningAfterMs: 120_000,
    checkedAt: "2026-06-16T00:02:05.000Z",
    ...overrides,
  } as unknown as TaskDiagnosticReport;
}

test("buildOperatorDashboardSnapshot projects stuck, dead-letter, and requeue attention items", () => {
  const tasks = [
    task({ id: "dead", status: "failed", error: { code: "exceeded_requeue_limit", message: "too stale" }, requeueCount: 3, completedAt: "2026-06-16T00:02:00.000Z" }),
    task({ id: "stale", status: "running", claimedBy: "worker-a", targetNodeId: "worker-a" }),
    task({ id: "long", status: "running", assignedWorkerId: "worker-b" }),
    task({ id: "requeued", status: "queued", assignedWorkerId: "worker-c", requeueCount: 1 }),
  ];
  const reports = new Map<string, TaskDiagnosticReport>([
    ["dead", diagnostic({ taskId: "dead", diagnosticStatus: "terminal", currentStatusDurationMs: 10_000 })],
    ["stale", diagnostic({ taskId: "stale", diagnosticStatus: "active", brokerHints: { staleLease: false, staleWorker: true, cancellationRequested: false, requeued: false } })],
    ["long", diagnostic({ taskId: "long", diagnosticStatus: "long_running", currentStatusDurationMs: 125_000 })],
    ["requeued", diagnostic({ taskId: "requeued", diagnosticStatus: "active", currentStatusDurationMs: 30_000 })],
  ]);

  const snapshot = buildOperatorDashboardSnapshot({
    broker: {
      listTasks: () => tasks,
      getTaskDiagnostics: (id) => reports.get(id)!,
    },
    dashboard,
    staleReaper: { olderThanSec: 60, maxRequeueAttempts: 3 },
  });

  assert.equal(snapshot.generatedAt, dashboard.generatedAt);
  assert.deepEqual(snapshot.taskStatusSummary, {
    total: 4,
    active: 3,
    terminal: 1,
    byStatus: { running: 1, failed: 1 },
  });
  assert.deepEqual(snapshot.attentionItems.map((item) => item.code), [
    "stale_worker",
    "dead_lettered",
    "long_running",
    "requeued",
  ]);
  assert.equal(snapshot.attentionItems[0].severity, "critical");
  assert.equal(snapshot.recoverySummary.retry.maxRequeueAttempts, 3);
});
