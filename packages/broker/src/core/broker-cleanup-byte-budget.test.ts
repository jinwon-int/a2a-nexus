/**
 * Byte-aware terminal-task retention for the cleanup/prune path (#1768).
 *
 * The situation these tests pin down is the one observed live: a table well
 * under the record cap, well over the byte budget, and a cleanup planner that
 * answered "nothing to do" — leaving an oversized canonical snapshot with no
 * operator remedy at all.
 *
 * The second thing they pin down is the boundary that makes this safe: this is
 * a DESTRUCTIVE path, so the byte budget may only ever reach rows the retention
 * window has already released. The in-memory reachability selector may evict
 * in-window records because it only shapes a projection; deleting SQLite rows
 * is not the same act.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { planTaskRetentionFromRecords } from "./store-hot-retention-planning.js";
import { estimateRetentionRecordBytes } from "./broker-retention-selectors.js";
import { makeTask } from "./store-test-helpers.js";
import type { TaskRecord } from "./types.js";

const NOW_MS = Date.parse("2026-08-08T00:00:00.000Z");
const DAY_MS = 86_400_000;
const RETENTION_MS = 7 * DAY_MS;

/** A terminal task of a roughly controllable serialized size. */
function bulkyTask(id: string, ageDays: number, padBytes: number): TaskRecord {
  const at = new Date(NOW_MS - ageDays * DAY_MS).toISOString();
  return {
    ...makeTask(id, "succeeded", "worker-0"),
    createdAt: at,
    updatedAt: at,
    completedAt: at,
    resultSummary: "x".repeat(padBytes),
  } as TaskRecord;
}

test("byte budget prunes past-retention rows the record cap would have kept (#1768)", () => {
  // 10 past-retention terminal tasks, cap of 2000 — the count cap alone keeps
  // every one of them, which is exactly the live failure.
  const records = Array.from({ length: 10 }, (_, i) => bulkyTask(`old-${i}`, 30 - i, 10_000));
  const perTask = estimateRetentionRecordBytes(records[0]!);

  const countOnly = planTaskRetentionFromRecords(records, {
    nowMs: NOW_MS,
    retentionMs: RETENTION_MS,
    maxTerminalRecords: 2000,
  });
  assert.equal(countOnly.pruneIds.length, 0, "count-only planning keeps everything: the bug");
  assert.equal(countOnly.retainedByCapCount, 10);
  assert.equal(countOnly.retainedBytes, undefined, "no byte reporting without a budget");

  // Same records, same cap, but a budget that fits only ~3 of them.
  const byteAware = planTaskRetentionFromRecords(records, {
    nowMs: NOW_MS,
    retentionMs: RETENTION_MS,
    maxTerminalRecords: 2000,
    maxTerminalRecordBytes: perTask * 3,
  });
  assert.equal(byteAware.retainedByCapCount, 3, "retains what the budget affords");
  assert.equal(byteAware.pruneIds.length, 7);
  assert.equal(byteAware.prunedByByteBudgetCount, 7, "attributed to the budget, not the cap");
  assert.ok(byteAware.retainedBytes! <= byteAware.maxRetainedBytes!);
  assert.equal(byteAware.byteBudgetUnreachable, false);

  // Newest-first: the three survivors are the three most recent.
  assert.deepEqual(byteAware.retainedIds.sort(), ["old-7", "old-8", "old-9"]);
});

test("rows inside the retention window are never offered for pruning, however far over budget", () => {
  // Everything is recent, so the retention window protects all of it, and the
  // budget is far too small. A destructive path must still propose nothing.
  const records = Array.from({ length: 8 }, (_, i) => bulkyTask(`fresh-${i}`, 1, 10_000));

  const plan = planTaskRetentionFromRecords(records, {
    nowMs: NOW_MS,
    retentionMs: RETENTION_MS,
    maxTerminalRecords: 2000,
    maxTerminalRecordBytes: 1_000,
  });

  assert.equal(plan.pruneIds.length, 0, "the byte budget must not reach inside the retention window");
  assert.equal(plan.retainedIds.length, 8);
  assert.equal(plan.byteBudgetUnreachable, true, "but the impossible budget is reported, not hidden");
  assert.ok(plan.retainedBytes! > plan.maxRetainedBytes!);
});

test("byteBudgetUnreachable is false when pruning past-retention rows can close the gap", () => {
  const oldRecords = Array.from({ length: 6 }, (_, i) => bulkyTask(`old-${i}`, 30, 10_000));
  const freshRecords = [bulkyTask("fresh-0", 1, 1_000)];
  const freshBytes = estimateRetentionRecordBytes(freshRecords[0]!);

  const plan = planTaskRetentionFromRecords([...oldRecords, ...freshRecords], {
    nowMs: NOW_MS,
    retentionMs: RETENTION_MS,
    maxTerminalRecords: 2000,
    // Budget fits the in-window row with room to spare, so the gap is closable
    // purely by pruning expired rows.
    maxTerminalRecordBytes: freshBytes * 2,
  });

  assert.equal(plan.byteBudgetUnreachable, false);
  assert.equal(plan.pruneIds.length, 6, "all past-retention rows pruned to fit");
  assert.ok(plan.retainedIds.includes("fresh-0"), "the in-window row survives");
});

test("non-terminal rows are never pruned and never blamed on the budget", () => {
  const active = [
    { ...makeTask("active-0", "running", "worker-0"), resultSummary: "y".repeat(10_000) } as TaskRecord,
    { ...makeTask("active-1", "queued", "worker-0"), resultSummary: "y".repeat(10_000) } as TaskRecord,
  ];
  const expired = [bulkyTask("old-0", 30, 10_000)];

  const plan = planTaskRetentionFromRecords([...active, ...expired], {
    nowMs: NOW_MS,
    retentionMs: RETENTION_MS,
    maxTerminalRecords: 2000,
    maxTerminalRecordBytes: 100,
  });

  assert.deepEqual(plan.pruneIds, ["old-0"], "only the expired terminal row is a candidate");
  assert.ok(plan.retainedIds.includes("active-0"));
  assert.ok(plan.retainedIds.includes("active-1"));
});

test("protected task ids survive the byte budget", () => {
  const records = Array.from({ length: 5 }, (_, i) => bulkyTask(`old-${i}`, 30 - i, 10_000));

  const plan = planTaskRetentionFromRecords(records, {
    nowMs: NOW_MS,
    retentionMs: RETENTION_MS,
    maxTerminalRecords: 2000,
    maxTerminalRecordBytes: 1,
    protectedTaskIds: ["old-0"],
  });

  assert.ok(plan.retainedIds.includes("old-0"), "protection outranks the budget");
  assert.equal(plan.pruneIds.includes("old-0"), false);
});

test("one oversized record does not starve smaller older records", () => {
  // Newest is huge, the older ones are small. Newest-first ordering would
  // consume the whole budget on the giant unless it is skipped over.
  const giant = bulkyTask("old-giant", 10, 100_000);
  const smalls = Array.from({ length: 3 }, (_, i) => bulkyTask(`old-small-${i}`, 20 + i, 500));
  const smallBytes = estimateRetentionRecordBytes(smalls[0]!);

  const plan = planTaskRetentionFromRecords([giant, ...smalls], {
    nowMs: NOW_MS,
    retentionMs: RETENTION_MS,
    maxTerminalRecords: 2000,
    maxTerminalRecordBytes: smallBytes * 3,
  });

  assert.ok(plan.pruneIds.includes("old-giant"), "the giant is evicted");
  for (const small of smalls) {
    assert.ok(plan.retainedIds.includes(small.id), `${small.id} still fits and is kept`);
  }
});

test("the record cap still binds when it is the tighter constraint", () => {
  const records = Array.from({ length: 10 }, (_, i) => bulkyTask(`old-${i}`, 30 - i, 100));

  const plan = planTaskRetentionFromRecords(records, {
    nowMs: NOW_MS,
    retentionMs: RETENTION_MS,
    maxTerminalRecords: 4,
    maxTerminalRecordBytes: 10_000_000,
  });

  assert.equal(plan.retainedByCapCount, 4, "the cap wins when it is tighter than the budget");
  assert.equal(plan.pruneIds.length, 6);
  assert.equal(plan.prunedByByteBudgetCount, 0, "and the budget takes no credit for it");
});

test("a reachable budget actually ends up under budget (untouchable rows are charged first)", () => {
  // Regression for a real defect caught only by running the planner against a
  // live-backup copy: the candidate loop was budgeted against the FULL budget,
  // ignoring that in-window and non-terminal rows already consume it. The plan
  // then reported retainedBytes far above maxRetainedBytes while still claiming
  // byteBudgetUnreachable=false — a self-contradictory plan.
  const inWindow = Array.from({ length: 4 }, (_, i) => bulkyTask(`fresh-${i}`, 1, 4_000));
  const expired = Array.from({ length: 20 }, (_, i) => bulkyTask(`old-${i}`, 30 - i, 4_000));
  const perTask = estimateRetentionRecordBytes(expired[0]!);

  // Budget fits ~10 rows total; 4 of them are already spoken for by in-window rows.
  const plan = planTaskRetentionFromRecords([...inWindow, ...expired], {
    nowMs: NOW_MS,
    retentionMs: RETENTION_MS,
    maxTerminalRecords: 2000,
    maxTerminalRecordBytes: perTask * 10,
  });

  assert.equal(plan.byteBudgetUnreachable, false, "the untouchable rows fit, so the budget is reachable");
  assert.ok(
    plan.retainedBytes! <= plan.maxRetainedBytes!,
    `reachable budget must actually be met: retained ${plan.retainedBytes} > budget ${plan.maxRetainedBytes}`,
  );
  // 4 in-window + ~6 expired survive; the rest are pruned by the budget.
  assert.ok(plan.pruneIds.length >= 14, `expected most expired rows pruned, got ${plan.pruneIds.length}`);
  for (const row of inWindow) {
    assert.ok(plan.retainedIds.includes(row.id), "in-window rows are never pruned");
  }
});

test("omitting the budget preserves the previous count-only behaviour exactly", () => {
  const records = Array.from({ length: 12 }, (_, i) => bulkyTask(`old-${i}`, 30 - i, 5_000));

  const plan = planTaskRetentionFromRecords(records, {
    nowMs: NOW_MS,
    retentionMs: RETENTION_MS,
    maxTerminalRecords: 5,
  });

  assert.equal(plan.retainedByCapCount, 5);
  assert.equal(plan.pruneIds.length, 7);
  assert.equal(plan.retainedBytes, undefined);
  assert.equal(plan.maxRetainedBytes, undefined);
  assert.equal(plan.prunedByByteBudgetCount, undefined);
  assert.equal(plan.byteBudgetUnreachable, undefined);
});
