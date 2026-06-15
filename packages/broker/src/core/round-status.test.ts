import assert from "node:assert/strict";
import test from "node:test";

import { buildRoundParentAggregateTaskReport, summarizeRoundStatus } from "./round-status.js";
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

test("buildRoundParentAggregateTaskReport emits parent-comment compatible task report (#629)", () => {
  const report = buildRoundParentAggregateTaskReport([
    task("a", "succeeded", "r", { parentRoundTotal: 3, parentRoundOrder: 1, assignedWorkerId: "sogyo" }),
    task("b", "running", "r", { parentRoundTotal: 3, parentRoundOrder: 2, assignedWorkerId: "nosuk" }),
    task("other", "failed", "other"),
  ], "r", { generatedAt: "2026-06-15T10:30:00.000Z" });

  assert.equal(report.generatedAt, "2026-06-15T10:30:00.000Z");
  assert.equal(report.parentRoundId, "r");
  assert.equal(report.total, 3);
  assert.equal(report.terminal, 1);
  assert.equal(report.active, 2);
  assert.equal(report.stale, 1);
  assert.equal(report.reportable, 3);
  assert.equal(report.allTerminal, false);
  assert.deepEqual(report.items.map((item) => item.taskId), ["a", "b", "r:missing:1"]);
  assert.match(report.items[0].reportLine, /terminal: sogyo lane=1 task=a status=succeeded/);
  assert.match(report.items[1].reportLine, /progress: nosuk lane=2 task=b status=running/);
  assert.match(report.items[2].reportLine, /missing: expected lane 3\/3 has no task record yet/);
});

test("round report names actual missing parentRoundOrder gaps and sorts ties deterministically (#629)", () => {
  const report = buildRoundParentAggregateTaskReport([
    task("z-task", "running", "r", { parentRoundTotal: 3, parentRoundOrder: 3, assignedWorkerId: "z" }),
    task("a-task", "succeeded", "r", { parentRoundTotal: 3, parentRoundOrder: 1, assignedWorkerId: "a" }),
    task("b-task", "failed", "r", { parentRoundTotal: 3, assignedWorkerId: "b" }),
    task("a2-task", "succeeded", "r", { parentRoundTotal: 3, assignedWorkerId: "a2" }),
  ], "r", { generatedAt: "2026-06-15T10:30:00.000Z" });

  assert.deepEqual(report.items.map((item) => item.taskId), ["a-task", "z-task", "a2-task", "b-task"]);
  assert.equal(report.stale, 0);

  const gapReport = buildRoundParentAggregateTaskReport([
    task("lane-1", "succeeded", "gap", { parentRoundTotal: 3, parentRoundOrder: 1, assignedWorkerId: "sogyo" }),
    task("lane-3", "running", "gap", { parentRoundTotal: 3, parentRoundOrder: 3, assignedWorkerId: "nosuk" }),
  ], "gap", { generatedAt: "2026-06-15T10:30:00.000Z" });

  assert.match(gapReport.items[2].reportLine, /missing: expected lane 2\/3 has no task record yet/);
  assert.doesNotMatch(gapReport.items[2].reportLine, /lane 3\/3/);
});

test("round report caps missing lane expansion for hostile parentRoundTotal values (#629)", () => {
  const report = buildRoundParentAggregateTaskReport([
    task("only", "succeeded", "huge", { parentRoundTotal: 10000, assignedWorkerId: "sogyo" }),
  ], "huge", { generatedAt: "2026-06-15T10:30:00.000Z" });

  assert.equal(report.total, 10000);
  assert.equal(report.stale, 9999);
  assert.equal(report.items.length, 50);
  assert.match(report.items[49].reportLine, /9951 expected lanes without task records omitted from this capped report/);
});
