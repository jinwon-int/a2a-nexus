// Regression coverage for #1579: default maxTerminalTasks (2000) x realistic
// task payloads far exceeds the default snapshot byte cap (STATE_FILE_MAX_BYTES,
// 50 MB), so count-based retention alone let the persisted state file outgrow
// its own limit and wedge persistence. Terminal-task retention is now also
// bounded by a cumulative serialized-byte budget (maxTerminalTaskBytes).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { InMemoryA2ABroker } from "./broker.js";
import { selectRetainedTerminalRecordIds } from "./broker-retention-selectors.js";
import { JsonFileBrokerStateStore } from "./store.js";
import { registerWorker } from "./broker-test-helpers.js";

interface FakeRecord {
  id: string;
  terminal: boolean;
  updatedAt: string;
  bytes: number;
}

const NOW_MS = Date.parse("2026-01-10T00:00:00.000Z");
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

function fakeRecord(id: string, ageMs: number, bytes: number, terminal = true): FakeRecord {
  return {
    id,
    terminal,
    updatedAt: new Date(NOW_MS - ageMs).toISOString(),
    bytes,
  };
}

function selectIds(
  records: FakeRecord[],
  overrides: {
    maxTerminalRecords?: number;
    maxTerminalRecordBytes?: number;
    protectedIds?: Set<string>;
  } = {},
): Set<string> {
  return selectRetainedTerminalRecordIds({
    records,
    isTerminal: (record) => record.terminal,
    getId: (record) => record.id,
    getTimestamp: (record) => record.updatedAt,
    nowMs: NOW_MS,
    retentionMs: RETENTION_MS,
    maxTerminalRecords: overrides.maxTerminalRecords ?? 2_000,
    maxTerminalRecordBytes: overrides.maxTerminalRecordBytes,
    getRecordBytes:
      overrides.maxTerminalRecordBytes === undefined ? undefined : (record) => record.bytes,
    protectedIds: overrides.protectedIds,
  });
}

test("without a byte budget, within-window terminal records are retained regardless of cumulative size (#1579 failure mode)", () => {
  // Pin the count-only semantics that caused the failure mode: every record is
  // inside the retention window and under the count cap, so all are retained
  // no matter how many bytes they add up to.
  const records = [
    fakeRecord("t1", 3_000, 30 * 1024 * 1024),
    fakeRecord("t2", 2_000, 30 * 1024 * 1024),
    fakeRecord("t3", 1_000, 30 * 1024 * 1024),
  ];

  const retained = selectIds(records);

  assert.deepEqual([...retained].sort(), ["t1", "t2", "t3"]);
});

test("byte budget evicts oldest terminal records once the cumulative budget is exhausted, even inside the retention window", () => {
  const records = [
    fakeRecord("t1", 4_000, 100),
    fakeRecord("t2", 3_000, 100),
    fakeRecord("t3", 2_000, 100),
    fakeRecord("t4", 1_000, 100),
  ];

  const retained = selectIds(records, { maxTerminalRecordBytes: 250 });

  assert.deepEqual([...retained].sort(), ["t3", "t4"]);
});

test("oversized record is evicted without starving smaller, older records", () => {
  const records = [
    fakeRecord("t-old-small", 3_000, 100),
    fakeRecord("t-mid-small", 2_000, 100),
    fakeRecord("t-new-huge", 1_000, 1_000),
  ];

  const retained = selectIds(records, { maxTerminalRecordBytes: 250 });

  assert.deepEqual([...retained].sort(), ["t-mid-small", "t-old-small"]);
});

test("expired-record count cap still applies alongside the byte budget", () => {
  const expiredAge = RETENTION_MS + 60_000;
  const records = [
    fakeRecord("expired-1", expiredAge + 2_000, 10),
    fakeRecord("expired-2", expiredAge + 1_000, 10),
    fakeRecord("recent", 1_000, 10),
  ];

  const retained = selectIds(records, { maxTerminalRecords: 1, maxTerminalRecordBytes: 1_000 });

  assert.deepEqual([...retained].sort(), ["expired-2", "recent"]);
});

test("protected and non-terminal records are never evicted by the byte budget", () => {
  const records = [
    fakeRecord("protected-big", 1_000, 500),
    fakeRecord("active", 2_000, 500, false),
    fakeRecord("evictable", 500, 500),
  ];

  const retained = selectIds(records, {
    maxTerminalRecordBytes: 0,
    protectedIds: new Set(["protected-big"]),
  });

  assert.deepEqual([...retained].sort(), ["active", "protected-big"]);
});

function runLargePayloadTaskLifecycles(broker: InMemoryA2ABroker, count: number, payloadBytes: number): string[] {
  registerWorker(broker, "worker-bytes");
  const taskIds: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const id = `task-bytes-${String(index).padStart(2, "0")}`;
    broker.createTask({
      id,
      intent: "chat",
      requester: { id: "hub-a", kind: "node", role: "hub" },
      target: { id: "worker-bytes", kind: "node", role: "analyst" },
      assignedWorkerId: "worker-bytes",
      message: `task ${id}`,
      payload: { blob: "x".repeat(payloadBytes) },
    });
    broker.claimTask(id, "worker-bytes");
    broker.startTask(id, "worker-bytes");
    broker.completeTask(id, "worker-bytes", { summary: `done ${id}` });
    taskIds.push(id);
  }
  return taskIds;
}

test("terminal-task byte budget keeps the persisted state file within the snapshot byte cap (#1579)", () => {
  const dir = mkdtempSync(join(tmpdir(), "broker-byte-budget-"));
  try {
    const stateFile = join(dir, "state.json");
    const maxSnapshotBytes = 256 * 1024;
    const store = new JsonFileBrokerStateStore(stateFile, { maxBytes: maxSnapshotBytes });
    const broker = new InMemoryA2ABroker(store, undefined, {
      retention: { maxTerminalTaskBytes: Math.floor(maxSnapshotBytes / 2) },
    });

    // 12 x ~32 KB terminal payloads = ~400 KB of terminal tasks, well past the
    // 256 KB snapshot cap if retention were count-based only.
    const taskIds = runLargePayloadTaskLifecycles(broker, 12, 32 * 1024);

    assert.ok(statSync(stateFile).size <= maxSnapshotBytes);
    const retainedTaskIds = broker.exportSnapshot().tasks.map((task) => task.id);
    assert.ok(retainedTaskIds.length < taskIds.length, "expected oldest terminal tasks to be evicted");
    assert.ok(retainedTaskIds.includes(taskIds[taskIds.length - 1]!), "newest terminal task must survive");
    assert.ok(!retainedTaskIds.includes(taskIds[0]!), "oldest terminal task must be evicted");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("without an effective byte budget the same workload wedges the snapshot write (#1579 failure mode)", () => {
  const dir = mkdtempSync(join(tmpdir(), "broker-byte-budget-wedged-"));
  try {
    const stateFile = join(dir, "state.json");
    const store = new JsonFileBrokerStateStore(stateFile, { maxBytes: 256 * 1024 });
    const broker = new InMemoryA2ABroker(store, undefined, {
      // Simulate the pre-#1579 count-only retention: a byte budget too large
      // to ever bind, with all tasks inside the retention window and far below
      // the terminal count cap.
      retention: { maxTerminalTaskBytes: Number.MAX_SAFE_INTEGER },
    });

    assert.throws(
      () => runLargePayloadTaskLifecycles(broker, 12, 32 * 1024),
      /broker snapshot exceeds max size/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
