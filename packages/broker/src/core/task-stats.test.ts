import test from "node:test";
import assert from "node:assert/strict";

import { aggregateTaskStats } from "./task-stats.js";
import type { TaskRecord } from "./types.js";

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
