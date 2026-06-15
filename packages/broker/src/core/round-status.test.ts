import assert from "node:assert/strict";
import test from "node:test";

import { summarizeRoundStatus } from "./round-status.js";
import type { TaskRecord, TaskStatus } from "./types.js";

function task(id: string, status: TaskStatus, parentRoundId: string | undefined, extra: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id,
    intent: "verify",
    requester: { id: "hub", kind: "node", role: "hub" },
    target: { id: "w", kind: "node", role: "analyst" },
    targetNodeId: "w",
    status,
    createdAt: "2026-06-14T00:00:00Z",
    updatedAt: "2026-06-14T00:00:00Z",
    ...(parentRoundId !== undefined ? { parentRoundId } : {}),
    ...extra,
  } as TaskRecord;
}

test("summarizeRoundStatus aggregates lanes, completion, and incomplete ids for a round", () => {
  const tasks: TaskRecord[] = [
    task("t1", "succeeded", "round-1", { parentRoundTotal: 4, parentRoundOrder: 1, assignedWorkerId: "sogyo" }),
    task("t2", "failed", "round-1", { parentRoundTotal: 4, parentRoundOrder: 2 }),
    task("t3", "running", "round-1", { parentRoundTotal: 4, parentRoundOrder: 3 }),
    task("t4", "blocked", "round-1", { parentRoundTotal: 4, parentRoundOrder: 4 }),
    task("other", "queued", "round-2"),
    task("none", "queued", undefined),
  ];

  const summary = summarizeRoundStatus(tasks, "round-1");
  assert.equal(summary.parentRoundId, "round-1");
  assert.equal(summary.total, 4);
  assert.equal(summary.matched, 4);
  assert.equal(summary.completedCount, 2); // succeeded + failed
  assert.equal(summary.pendingCount, 2); // running + blocked
  assert.equal(summary.completionRate, 0.5);
  assert.deepEqual(summary.incompleteTaskIds, ["t3", "t4"]);
  assert.equal(summary.byStatus.succeeded, 1);
  assert.equal(summary.byStatus.failed, 1);
  assert.equal(summary.byStatus.running, 1);
  assert.equal(summary.byStatus.blocked, 1);
  // lanes are ordered by parentRoundOrder
  assert.deepEqual(summary.lanes.map((l) => l.taskId), ["t1", "t2", "t3", "t4"]);
  assert.equal(summary.lanes[0].assignedWorkerId, "sogyo");
});

test("summarizeRoundStatus uses matched count when no parentRoundTotal is declared", () => {
  const summary = summarizeRoundStatus(
    [task("a", "succeeded", "r"), task("b", "queued", "r")],
    "r",
  );
  assert.equal(summary.total, 2);
  assert.equal(summary.completionRate, 0.5);
});

test("summarizeRoundStatus returns an empty, zeroed summary for an unknown round", () => {
  const summary = summarizeRoundStatus([task("a", "succeeded", "r")], "missing");
  assert.equal(summary.matched, 0);
  assert.equal(summary.total, 0);
  assert.equal(summary.completedCount, 0);
  assert.equal(summary.completionRate, 0);
  assert.deepEqual(summary.lanes, []);
  assert.deepEqual(summary.incompleteTaskIds, []);
});

test("declared parentRoundTotal larger than matched lanes lowers the completion rate", () => {
  // 1 of an expected 4 lanes has reported, and it succeeded.
  const summary = summarizeRoundStatus(
    [task("a", "succeeded", "r", { parentRoundTotal: 4 })],
    "r",
  );
  assert.equal(summary.total, 4);
  assert.equal(summary.matched, 1);
  assert.equal(summary.completedCount, 1);
  assert.equal(summary.completionRate, 0.25);
  // 3 declared lanes have not reported a task yet.
  assert.equal(summary.expectedButMissingCount, 3);
  // pendingCount is matched-lanes-only, so completedCount + pendingCount === matched.
  assert.equal(summary.completedCount + summary.pendingCount, summary.matched);
});

test("a claimed lane is counted (byStatus.claimed) and treated as not-yet-terminal (#743)", () => {
  const summary = summarizeRoundStatus(
    [task("a", "claimed", "r"), task("b", "succeeded", "r")],
    "r",
  );
  assert.equal(summary.byStatus.claimed, 1);
  assert.equal(summary.completedCount, 1);
  assert.equal(summary.pendingCount, 1);
  assert.deepEqual(summary.incompleteTaskIds, ["a"]);
});

test("expectedButMissingCount is zero when all matched lanes are present", () => {
  const summary = summarizeRoundStatus(
    [task("a", "succeeded", "r", { parentRoundTotal: 2 }), task("b", "running", "r", { parentRoundTotal: 2 })],
    "r",
  );
  assert.equal(summary.matched, 2);
  assert.equal(summary.total, 2);
  assert.equal(summary.expectedButMissingCount, 0);
});
