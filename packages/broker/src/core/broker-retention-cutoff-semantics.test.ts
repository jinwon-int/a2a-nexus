import assert from "node:assert/strict";
import test from "node:test";

import { selectRetainedTerminalRecordIds } from "./broker-retention-selectors.js";
import { planTaskRetentionFromRecords } from "./store-hot-retention-planning.js";
import type { TaskRecord, TaskStatus } from "./types.js";

const NOW_MS = Date.parse("2026-07-22T12:00:00.000Z");
const RETENTION_MS = 60 * 60 * 1000;

function task(id: string, status: TaskStatus, updatedAt: string): TaskRecord {
  return {
    id,
    intent: "chat",
    requester: { id: "requester", kind: "session", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    status,
    targetNodeId: "worker-a",
    payload: {},
    createdAt: updatedAt,
    updatedAt,
    ...(status === "succeeded" || status === "failed" || status === "canceled"
      ? { completedAt: updatedAt }
      : {}),
  };
}

function retainedBySelector(
  records: TaskRecord[],
  maxTerminalRecords: number,
  protectedTaskIds: string[],
): string[] {
  return [...selectRetainedTerminalRecordIds({
    records,
    isTerminal: (record) =>
      record.status === "succeeded" || record.status === "failed" || record.status === "canceled",
    getId: (record) => record.id,
    getTimestamp: (record) => record.completedAt ?? record.updatedAt,
    nowMs: NOW_MS,
    retentionMs: RETENTION_MS,
    maxTerminalRecords,
    protectedIds: new Set(protectedTaskIds),
  })].sort();
}

function assertSharedSemantics(
  records: TaskRecord[],
  maxTerminalRecords: number,
  protectedTaskIds: string[],
  expectedRetainedIds: string[],
  expectedPruneIds: string[],
): void {
  const plan = planTaskRetentionFromRecords(records, {
    nowMs: NOW_MS,
    retentionMs: RETENTION_MS,
    maxTerminalRecords,
    protectedTaskIds,
  });

  assert.deepEqual(retainedBySelector(records, maxTerminalRecords, protectedTaskIds), expectedRetainedIds);
  assert.deepEqual(plan.retainedIds, expectedRetainedIds);
  assert.deepEqual(plan.pruneIds, expectedPruneIds);
}

test("terminal retention keeps recent, non-terminal, and protected records when the old-tail cap is zero", () => {
  const records = [
    task("recent-a", "succeeded", "2026-07-22T11:30:00.000Z"),
    task("recent-b", "failed", "2026-07-22T11:15:00.000Z"),
    task("old-pruned", "canceled", "2026-07-22T08:00:00.000Z"),
    task("old-protected", "succeeded", "2026-07-22T07:00:00.000Z"),
    task("non-terminal", "running", "2026-07-22T06:00:00.000Z"),
  ];

  assertSharedSemantics(
    records,
    0,
    ["old-protected"],
    ["non-terminal", "old-protected", "recent-a", "recent-b"],
    ["old-pruned"],
  );
});

test("terminal retention caps only older candidates newest-first, independent of the recent set size", () => {
  const records = [
    task("recent-a", "succeeded", "2026-07-22T11:50:00.000Z"),
    task("recent-b", "failed", "2026-07-22T11:40:00.000Z"),
    task("recent-c", "canceled", "2026-07-22T11:30:00.000Z"),
    task("old-newest", "succeeded", "2026-07-22T10:00:00.000Z"),
    task("old-middle", "failed", "2026-07-22T09:00:00.000Z"),
    task("old-oldest", "canceled", "2026-07-22T08:00:00.000Z"),
    task("old-protected", "succeeded", "2026-07-22T07:00:00.000Z"),
    task("non-terminal", "queued", "2026-07-22T06:00:00.000Z"),
  ];

  assertSharedSemantics(
    records,
    1,
    ["old-protected"],
    ["non-terminal", "old-newest", "old-protected", "recent-a", "recent-b", "recent-c"],
    ["old-middle", "old-oldest"],
  );
});
