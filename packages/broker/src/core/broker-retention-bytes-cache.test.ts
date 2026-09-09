/**
 * Retention byte-estimation cost (#2077 step 3, criterion: "full persist 1회당
 * JSON.stringify 호출 횟수가 O(변경 레코드)로 줄고, pretty-print 추정이 사라진다").
 *
 * Invariants pinned here:
 * - the estimator measures the COMPACT form the canonical snapshot row is
 *   actually written in (`serializeBrokerSnapshot`), not the pretty-printed
 *   form it stopped using in #1994;
 * - the SQLite hot-retention planner answers byte budgets from the EXACT
 *   stored payload length (`length(CAST(payload AS BLOB))`), so planning over
 *   re-read rows re-serializes nothing at all;
 * - the pure planner stays stateless and honors the injectable
 *   `getRecordBytes` override;
 * - the WeakMap estimator cache validates the record's `updatedAt` stamp.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { estimateRetentionRecordBytes } from "./broker-retention-selectors.js";
import { planTaskRetentionFromRecords } from "./store-hot-retention-planning.js";
import {
  SqliteBrokerStateStore,
  emptySnapshot,
} from "./store.js";
import { makeTask, withTempFile } from "./store-test-helpers.js";
import type { TaskRecord } from "./types.js";

const NOW_MS = Date.parse("2026-08-08T00:00:00.000Z");
const DAY_MS = 86_400_000;
const RETENTION_MS = 7 * DAY_MS;

/**
 * Count JSON.stringify calls while running a synchronous block. Separately
 * counts calls whose argument looks like a serialized task record — zod's
 * schema validation stringifies internally (fastpass escaping), which is not
 * what the criterion counts; record serialization is.
 */
function countStringifyCalls<T>(run: () => T): { result: T; calls: number; recordSerializations: number } {
  const original = JSON.stringify;
  let calls = 0;
  let recordSerializations = 0;
  JSON.stringify = ((value: unknown, replacer?: unknown, space?: unknown) => {
    calls += 1;
    if (
      value && typeof value === "object" && !Array.isArray(value)
      && "id" in value && "status" in value && "updatedAt" in value
    ) {
      recordSerializations += 1;
    }
    return original(value, replacer as never, space as never);
  }) as typeof JSON.stringify;
  try {
    return { result: run(), calls, recordSerializations };
  } finally {
    JSON.stringify = original;
  }
}

function bulkyTerminalTask(id: string, ageDays: number, padBytes: number): TaskRecord {
  const at = new Date(NOW_MS - ageDays * DAY_MS).toISOString();
  return {
    ...makeTask(id, "succeeded", "worker-0"),
    createdAt: at,
    updatedAt: at,
    completedAt: at,
    resultSummary: "x".repeat(padBytes),
  } as TaskRecord;
}

function planOptions(maxTerminalRecordBytes: number) {
  return {
    nowMs: NOW_MS,
    retentionMs: RETENTION_MS,
    maxTerminalRecords: 2_000,
    maxTerminalRecordBytes,
  };
}

test("estimation measures the compact form the canonical row is written in", () => {
  const record = { id: "task-1", nested: { note: "y".repeat(50) }, updatedAt: "2026-08-01T00:00:00.000Z" };
  const compact = Buffer.byteLength(JSON.stringify(record), "utf8");
  const pretty = Buffer.byteLength(JSON.stringify(record, null, 2), "utf8");
  assert.ok(pretty > compact, "test sanity: pretty-printing adds bytes for nested records");
  assert.equal(
    estimateRetentionRecordBytes(record),
    compact,
    "estimation must match serializeBrokerSnapshot's compact output",
  );
});

test("the estimator cache re-measures when the updatedAt stamp changes", () => {
  const before = bulkyTerminalTask("task-mut", 30, 512);
  const warm = countStringifyCalls(() => estimateRetentionRecordBytes(before));
  assert.equal(warm.recordSerializations, 1, "cold measurement serializes once");

  const same = countStringifyCalls(() => estimateRetentionRecordBytes(before));
  assert.equal(same.recordSerializations, 0, "the same record object with the same stamp is cached");

  const mutated = { ...before, resultSummary: "z".repeat(2_048), updatedAt: new Date(NOW_MS - DAY_MS).toISOString() };
  const after = countStringifyCalls(() => estimateRetentionRecordBytes(mutated));
  assert.equal(after.recordSerializations, 1, "a new updatedAt stamp re-measures");
  assert.ok(after.result > warm.result, "the larger record measures larger");
});

test("the pure planner is stateless: repeat passes over re-read rows give identical answers", () => {
  const rows = Array.from({ length: 20 }, (_, i) => bulkyTerminalTask(`old-${i}`, 30 - i, 512));
  const budget = Buffer.byteLength(JSON.stringify(rows[0]), "utf8") * 5;

  const first = planTaskRetentionFromRecords(rows, planOptions(budget));
  // Simulate the planner's SELECT re-read: fresh objects, same content.
  const reread = rows.map((row) => structuredClone(row));
  const second = planTaskRetentionFromRecords(reread, planOptions(budget));

  assert.deepEqual(second.retainedIds, first.retainedIds);
  assert.deepEqual(second.pruneIds, first.pruneIds);
  assert.equal(second.retainedBytes, first.retainedBytes);
});

test("the planner honors the injected getRecordBytes override", () => {
  const rows = Array.from({ length: 6 }, (_, i) => bulkyTerminalTask(`old-${i}`, 30 - i, 512));
  // Claim every row costs 10MB: with the override the budget behaves as if
  // only the single newest row fits; compact reality would fit many more.
  const huge = 10 * 1024 * 1024;
  const plan = planTaskRetentionFromRecords(rows, {
    ...planOptions(huge),
    getRecordBytes: () => huge,
  });

  assert.equal(plan.retainedByCapCount, 1, "only the newest row fits a one-row budget");
  assert.equal(plan.retainedBytes, huge, "the override's numbers are used verbatim");
});

test("the store planner answers byte budgets without re-serializing any row", () => {
  const temp = withTempFile("retention-bytes-cache.db");
  try {
    const store = new SqliteBrokerStateStore(temp.filePath);
    const tasks = Array.from({ length: 25 }, (_, i) => bulkyTerminalTask(`row-${i}`, 30 - i, 512));
    store.save({ ...emptySnapshot(), tasks }, {});

    const budget = 100 * 1024 * 1024;
    const first = countStringifyCalls(() => store.planHotTaskRetention(planOptions(budget)));
    assert.equal(
      first.recordSerializations,
      0,
      "planning reads the stored payload lengths; it must not serialize any task record",
    );

    // A repeat pass (fresh row objects from the re-read) behaves identically.
    const repeat = countStringifyCalls(() => store.planHotTaskRetention(planOptions(budget)));
    assert.equal(repeat.recordSerializations, 0);
    assert.deepEqual(repeat.result.retainedIds, first.result.retainedIds);
    assert.equal(repeat.result.retainedBytes, first.result.retainedBytes);
    store.close();
  } finally {
    temp.cleanup();
  }
});

test("the store planner's byte accounting matches the stored payload sizes", () => {
  const temp = withTempFile("retention-bytes-exact.db");
  try {
    const store = new SqliteBrokerStateStore(temp.filePath);
    const tasks = [
      bulkyTerminalTask("tiny", 30, 100),
      bulkyTerminalTask("mid", 20, 1_000),
      bulkyTerminalTask("big", 10, 5_000),
    ];
    store.save({ ...emptySnapshot(), tasks }, {});

    const byteLength = (task: TaskRecord) => Buffer.byteLength(JSON.stringify(task), "utf8");
    // Budget that keeps exactly the two newest rows (mid + big): their combined
    // stored bytes plus one, with tiny's 539 bytes not fitting.
    const plan = store.planHotTaskRetention({
      nowMs: NOW_MS,
      retentionMs: RETENTION_MS,
      maxTerminalRecords: 2_000,
      maxTerminalRecordBytes: byteLength(tasks[1]!) + byteLength(tasks[2]!) + 1,
    });

    assert.ok(plan.pruneIds.includes("tiny"), "the oldest row is pruned");
    assert.ok(plan.retainedIds.includes("big"), "the newest row survives");
    assert.equal(
      plan.retainedBytes,
      byteLength(tasks[1]!) + byteLength(tasks[2]!),
      "retainedBytes equals the exact stored payload bytes of the survivors",
    );
    store.close();
  } finally {
    temp.cleanup();
  }
});
