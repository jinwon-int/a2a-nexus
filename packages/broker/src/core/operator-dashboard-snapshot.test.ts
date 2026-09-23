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

test("buildOperatorDashboardSnapshot surfaces lane counts, re-judgments, and lane context on attention items (#1601/#2208)", () => {
  const fast = task({ id: "fast", status: "queued" });
  fast.laneAssignment = { version: "fast-lane.v1", mode: "shadow", decision: "fast", reasonCodes: ["all_fast_conditions_met"] };
  const full = task({ id: "full", status: "running", claimedBy: "worker-a", targetNodeId: "worker-a" });
  full.laneAssignment = { version: "fast-lane.v1", mode: "shadow", decision: "full", reasonCodes: ["multi_worker_marker_present"] };
  const legacy = task({ id: "legacy", status: "queued" });
  const dead = task({ id: "dead", status: "failed", error: { code: "exceeded_requeue_limit", message: "too stale" }, requeueCount: 3, completedAt: "2026-06-16T00:02:00.000Z" });
  dead.laneAssignment = { version: "fast-lane.v1", mode: "shadow", decision: "fast", reasonCodes: ["all_fast_conditions_met"] };
  dead.laneRejudgment = { at: "2026-06-16T00:01:00.000Z", actorId: "hub-1", from: "fast", to: "full", reasonCode: "multi_worker_marker_present", note: "prod-touching follow-up" };
  const olderRejudged = task({ id: "older", status: "queued" });
  olderRejudged.laneAssignment = { version: "fast-lane.v1", mode: "shadow", decision: "fast", reasonCodes: ["all_fast_conditions_met"] };
  olderRejudged.laneRejudgment = { at: "2026-06-16T00:00:30.000Z", actorId: "hub-2", from: "fast", to: "full", reasonCode: "sensitive_marker_present" };

  const tasks = [fast, full, legacy, dead, olderRejudged];
  const reports = new Map(tasks.map((entry) => [entry.id, diagnostic({
    taskId: entry.id,
    diagnosticStatus: "active",
    currentStatusDurationMs: 10_000,
    brokerHints: { staleLease: false, staleWorker: false, cancellationRequested: false, requeued: false },
  })]));

  const snapshot = buildOperatorDashboardSnapshot({
    broker: { listTasks: () => tasks, getTaskDiagnostics: (id) => reports.get(id)! },
    dashboard,
    staleReaper: { olderThanSec: 60, maxRequeueAttempts: 3 },
  });

  assert.deepEqual(snapshot.laneSummary, {
    assigned: 4,
    byDecision: { fast: 3, full: 1 },
    rejudged: 2,
    recentRejudgments: [
      { taskId: "dead", status: "failed", at: "2026-06-16T00:01:00.000Z", actorId: "hub-1", from: "fast", to: "full", reasonCode: "multi_worker_marker_present", note: "prod-touching follow-up" },
      { taskId: "older", status: "queued", at: "2026-06-16T00:00:30.000Z", actorId: "hub-2", from: "fast", to: "full", reasonCode: "sensitive_marker_present" },
    ],
  });
  const deadLetter = snapshot.attentionItems.find((item) => item.taskId === "dead");
  assert.equal(deadLetter?.laneDecision, "fast");
  assert.equal(deadLetter?.laneRejudgedTo, "full");
});

test("lane summary bounds recentRejudgments to the newest 10 entries", () => {
  const tasks: TaskRecord[] = [];
  for (let index = 0; index < 12; index += 1) {
    const entry = task({ id: `t-${String(index).padStart(2, "0")}`, status: "queued" });
    entry.laneAssignment = { version: "fast-lane.v1", mode: "shadow", decision: "fast", reasonCodes: ["all_fast_conditions_met"] };
    entry.laneRejudgment = {
      at: `2026-06-16T00:00:${String(index).padStart(2, "0")}.000Z`,
      actorId: "hub-1",
      from: "fast",
      to: "full",
      reasonCode: "all_fast_conditions_met",
    };
    tasks.push(entry);
  }
  const reports = new Map(tasks.map((entry) => [entry.id, diagnostic({
    taskId: entry.id,
    diagnosticStatus: "active",
    currentStatusDurationMs: 10_000,
    brokerHints: { staleLease: false, staleWorker: false, cancellationRequested: false, requeued: false },
  })]));

  const snapshot = buildOperatorDashboardSnapshot({
    broker: { listTasks: () => tasks, getTaskDiagnostics: (id) => reports.get(id)! },
    dashboard,
    staleReaper: { olderThanSec: 60, maxRequeueAttempts: 3 },
  });

  assert.equal(snapshot.laneSummary.assigned, 12);
  assert.equal(snapshot.laneSummary.rejudged, 12);
  assert.equal(snapshot.laneSummary.recentRejudgments.length, 10);
  assert.equal(snapshot.laneSummary.recentRejudgments[0].taskId, "t-11");
  assert.equal(snapshot.laneSummary.recentRejudgments[9].taskId, "t-02");
});
