import test from "node:test";
import assert from "node:assert/strict";

import {
  aggregateTaskLifecycleLatency,
  aggregateTaskStats,
  summarizeTaskLatency,
} from "./task-stats.js";
import type { AuditEvent, TaskRecord } from "./types.js";

function task(overrides: Partial<TaskRecord>): TaskRecord {
  const createdAt = overrides.createdAt ?? "2026-07-05T00:00:00.000Z";
  return {
    id: overrides.id ?? "task-1",
    intent: overrides.intent ?? "analyze",
    requester: overrides.requester ?? { id: "hub", kind: "node", role: "hub" },
    target: overrides.target ?? { id: "worker-secret-alpha", kind: "node", role: "analyst" },
    targetNodeId: overrides.targetNodeId ?? "worker-secret-alpha",
    assignedWorkerId: overrides.assignedWorkerId ?? "worker-secret-alpha",
    message: overrides.message ?? "stats task",
    createdAt,
    updatedAt: overrides.updatedAt ?? createdAt,
    status: overrides.status ?? "queued",
    payload: overrides.payload ?? {},
    ...overrides,
  };
}

function audit(
  taskId: string,
  action: AuditEvent["action"],
  createdAt: string,
  suffix: string = action,
): AuditEvent {
  return {
    id: `${taskId}:${suffix}`,
    actorId: "worker-redacted",
    action,
    targetType: "task",
    targetId: taskId,
    createdAt,
  };
}

test("summarizeTaskLatency uses deterministic nearest-rank percentiles", () => {
  assert.deepEqual(summarizeTaskLatency([40, 10, 30, 20]), {
    count: 4,
    minMs: 10,
    maxMs: 40,
    averageMs: 25,
    p50Ms: 20,
    p95Ms: 40,
  });
  assert.deepEqual(summarizeTaskLatency([]), {
    count: 0,
    minMs: null,
    maxMs: null,
    averageMs: null,
    p50Ms: null,
    p95Ms: null,
  });
});

test("aggregateTaskLifecycleLatency reports complete phase distributions", () => {
  const tasks = [
    task({
      id: "latency-a",
      status: "succeeded",
      createdAt: "2026-07-05T00:00:00.000Z",
      claimedAt: "2026-07-05T00:00:00.100Z",
      completedAt: "2026-07-05T00:00:00.500Z",
      updatedAt: "2026-07-05T00:00:00.500Z",
    }),
    task({
      id: "latency-b",
      status: "failed",
      createdAt: "2026-07-05T00:00:01.000Z",
      claimedAt: "2026-07-05T00:00:01.200Z",
      completedAt: "2026-07-05T00:00:01.700Z",
      updatedAt: "2026-07-05T00:00:01.700Z",
      error: { code: "test_failure", message: "redacted" },
    }),
  ];
  const audits = [
    audit("latency-a", "task.created", "2026-07-05T00:00:00.000Z"),
    audit("latency-a", "task.claimed", "2026-07-05T00:00:00.100Z"),
    audit("latency-a", "task.started", "2026-07-05T00:00:00.150Z"),
    audit("latency-a", "task.succeeded", "2026-07-05T00:00:00.500Z"),
    audit("latency-b", "task.created", "2026-07-05T00:00:01.000Z"),
    audit("latency-b", "task.claimed", "2026-07-05T00:00:01.200Z"),
    audit("latency-b", "task.started", "2026-07-05T00:00:01.300Z"),
    audit("latency-b", "task.failed", "2026-07-05T00:00:01.700Z"),
  ];

  const latency = aggregateTaskLifecycleLatency(tasks, audits);

  assert.deepEqual(latency.coverage, {
    terminalTasks: 2,
    completeChains: 2,
    stages: { created: 2, claimed: 2, started: 2, completed: 2 },
    missing: { created: 0, claimed: 0, started: 0, completed: 0 },
    invalidChains: 0,
    invalidTimestampEvents: 0,
  });
  assert.deepEqual(latency.segments.createToClaim, {
    count: 2,
    minMs: 100,
    maxMs: 200,
    averageMs: 150,
    p50Ms: 100,
    p95Ms: 200,
  });
  assert.deepEqual(latency.segments.claimToStart, {
    count: 2,
    minMs: 50,
    maxMs: 100,
    averageMs: 75,
    p50Ms: 50,
    p95Ms: 100,
  });
  assert.deepEqual(latency.segments.startToComplete, {
    count: 2,
    minMs: 350,
    maxMs: 400,
    averageMs: 375,
    p50Ms: 350,
    p95Ms: 400,
  });
  assert.deepEqual(latency.segments.createToComplete, {
    count: 2,
    minMs: 500,
    maxMs: 700,
    averageMs: 600,
    p50Ms: 500,
    p95Ms: 700,
  });
  assert.deepEqual(latency.bottleneckByP95, { segment: "startToComplete", p95Ms: 400 });
});

test("aggregateTaskLifecycleLatency uses the latest monotonic requeue attempt", () => {
  const record = task({
    id: "latency-requeue",
    status: "succeeded",
    createdAt: "2026-07-05T00:00:00.000Z",
    claimedAt: "2026-07-05T00:00:00.400Z",
    completedAt: "2026-07-05T00:00:00.800Z",
    updatedAt: "2026-07-05T00:00:00.800Z",
    requeueCount: 1,
  });
  const latency = aggregateTaskLifecycleLatency([record], [
    audit(record.id, "task.created", "2026-07-05T00:00:00.000Z"),
    audit(record.id, "task.claimed", "2026-07-05T00:00:00.100Z", "claim-1"),
    audit(record.id, "task.started", "2026-07-05T00:00:00.150Z", "start-1"),
    audit(record.id, "task.requeued", "2026-07-05T00:00:00.300Z"),
    audit(record.id, "task.claimed", "2026-07-05T00:00:00.400Z", "claim-2"),
    audit(record.id, "task.started", "2026-07-05T00:00:00.450Z", "start-2"),
    audit(record.id, "task.succeeded", "2026-07-05T00:00:00.800Z"),
  ]);

  assert.equal(latency.coverage.completeChains, 1);
  assert.equal(latency.segments.createToClaim.p50Ms, 400);
  assert.equal(latency.segments.claimToStart.p50Ms, 50);
  assert.equal(latency.segments.startToComplete.p50Ms, 350);
});

test("aggregateTaskLifecycleLatency reports missing and non-monotonic chains without guessing", () => {
  const missingStart = task({
    id: "latency-missing-start",
    status: "succeeded",
    createdAt: "2026-07-05T00:00:00.000Z",
    claimedAt: "2026-07-05T00:00:00.100Z",
    completedAt: "2026-07-05T00:00:00.500Z",
    updatedAt: "2026-07-05T00:00:00.500Z",
  });
  const invalidOrder = task({
    id: "latency-invalid-order",
    status: "failed",
    createdAt: "2026-07-05T00:00:01.100Z",
    claimedAt: "2026-07-05T00:00:01.050Z",
    completedAt: "2026-07-05T00:00:01.500Z",
    updatedAt: "2026-07-05T00:00:01.500Z",
  });
  const latency = aggregateTaskLifecycleLatency([missingStart, invalidOrder], [
    audit(missingStart.id, "task.created", "2026-07-05T00:00:00.000Z"),
    audit(missingStart.id, "task.claimed", "2026-07-05T00:00:00.100Z"),
    audit(missingStart.id, "task.succeeded", "2026-07-05T00:00:00.500Z"),
    audit(invalidOrder.id, "task.created", "2026-07-05T00:00:01.100Z"),
    audit(invalidOrder.id, "task.claimed", "2026-07-05T00:00:01.050Z"),
    audit(invalidOrder.id, "task.started", "2026-07-05T00:00:01.200Z"),
    audit(invalidOrder.id, "task.started", "not-a-timestamp", "invalid-start"),
    audit(invalidOrder.id, "task.failed", "2026-07-05T00:00:01.500Z"),
    audit("outside-selection", "task.started", "not-a-timestamp"),
  ]);

  assert.equal(latency.coverage.terminalTasks, 2);
  assert.equal(latency.coverage.completeChains, 0);
  assert.equal(latency.coverage.missing.started, 1);
  assert.equal(latency.coverage.invalidChains, 1);
  assert.equal(latency.coverage.invalidTimestampEvents, 1);
  assert.equal(latency.segments.claimToStart.count, 0);
  assert.equal(latency.segments.createToComplete.count, 2);
});

test("aggregateTaskStats counts axes without leaking worker names", () => {
  const tasks = [
    task({
      id: "failed-handler",
      status: "failed",
      assignedWorkerId: "secret-mobile-worker",
      targetNodeId: "secret-mobile-worker",
      parentRoundId: "round-a",
      createdAt: "2026-07-05T01:00:00.000Z",
      updatedAt: "2026-07-05T01:10:00.000Z",
      error: {
        code: "handler_exit_nonzero",
        message: "handler failed",
        details: {
          stage: "handler",
          nestedError: { code: "openclaw_analysis_failed" },
        },
      },
    }),
    task({
      id: "failed-acceptance",
      status: "failed",
      assignedWorkerId: "secret-vps-worker",
      targetNodeId: "secret-vps-worker",
      parentRoundId: "round-a",
      createdAt: "2026-07-05T02:00:00.000Z",
      updatedAt: "2026-07-05T02:10:00.000Z",
      error: {
        code: "acceptance_failed",
        message: "acceptance failed",
        details: { stage: "verification" },
      },
    }),
    task({
      id: "succeeded-source-only",
      status: "succeeded",
      assignedWorkerId: "secret-source-worker",
      targetNodeId: "secret-source-worker",
      parentRoundId: "round-b",
      createdAt: "2026-07-05T03:00:00.000Z",
      updatedAt: "2026-07-05T03:10:00.000Z",
      payload: { sourceOnly: true },
    }),
    task({
      id: "outside-window",
      status: "failed",
      createdAt: "2026-06-01T00:00:00.000Z",
      updatedAt: "2026-06-01T00:00:00.000Z",
      error: { code: "old", message: "old" },
    }),
  ];

  const stats = aggregateTaskStats(tasks, {
    since: new Date("2026-07-05T00:00:00.000Z"),
    until: new Date("2026-07-06T00:00:00.000Z"),
    workerClassForTask(task) {
      if (task.payload.sourceOnly === true) return "source-only";
      if (task.assignedWorkerId?.includes("mobile")) return "mobile";
      return "vps";
    },
  });

  assert.equal(stats.total, 3);
  assert.deepEqual(stats.byStatus, { failed: 2, succeeded: 1 });
  assert.deepEqual(stats.byErrorCode, { acceptance_failed: 1, handler_exit_nonzero: 1 });
  assert.deepEqual(stats.byNestedClass, { no_stdout: 1, openclaw_analysis_failed: 1 });
  assert.deepEqual(stats.byStage, { handler: 1, verification: 1 });
  assert.deepEqual(stats.byWorkerClass, { mobile: 1, "source-only": 1, vps: 1 });
  assert.deepEqual(stats.byRound.top, [
    { parentRoundId: "round-a", failed: 2, total: 2 },
    { parentRoundId: "round-b", failed: 0, total: 1 },
  ]);
  assert.equal(JSON.stringify(stats).includes("secret-"), false);
});

test("aggregateTaskStats rejects inverted and over-broad windows", () => {
  assert.throws(
    () => aggregateTaskStats([], {
      since: new Date("2026-07-06T00:00:00.000Z"),
      until: new Date("2026-07-05T00:00:00.000Z"),
    }),
    /since must be <= until/,
  );
  assert.throws(
    () => aggregateTaskStats([], {
      since: new Date("2026-06-01T00:00:00.000Z"),
      until: new Date("2026-07-05T00:00:00.000Z"),
    }),
    /must not exceed 7 days/,
  );
});
