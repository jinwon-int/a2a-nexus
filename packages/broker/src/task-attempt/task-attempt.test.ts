// #1799 slice 1: TaskAttemptRecordV1 runtime producer + durable store.
// Deterministic, no-network. Cross-checks the runtime contract implementation
// against the frozen golden fixture, pins spec §6 replay/conflict semantics,
// restart durability (issue acceptance), producer honesty rules, and the
// fail-open broker wiring (recording can never change task execution).
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { InMemoryA2ABroker } from "../core/broker.js";
import type { TaskRecord } from "../core/types.js";
import {
  buildBrokerExecutionAttemptRecord,
  computeTaskAttemptFingerprint,
  computeTaskAttemptRecordKey,
  validateTaskAttemptRecord,
} from "./record.js";
import { recordBrokerTerminalAttempt, type TaskAttemptStoreSurface } from "./producer.js";
import { TaskAttemptRecordStore, TASK_ATTEMPT_RECORD_TABLE } from "./store.js";

const FIXTURE_PATH = join(process.cwd(), "..", "..", "fixtures", "contract", "task-attempt-failure-sharing.json");

function tempStore(): { store: TaskAttemptRecordStore; dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "task-attempt-"));
  const path = join(dir, "records.sqlite");
  return { store: new TaskAttemptRecordStore(path), dir, path };
}

const WORKER = "worker-attempt";

function setupWorker(broker: InMemoryA2ABroker): void {
  broker.registerWorker({
    nodeId: WORKER,
    role: "analyst",
    capabilities: {
      canAnalyze: true,
      canBackfill: false,
      canPatchWorkspace: false,
      canPromoteLive: false,
      workspaceIds: ["ws1"],
      environments: ["research"],
    },
    metadata: {},
  });
}

function runningTask(broker: InMemoryA2ABroker): TaskRecord {
  const task = broker.createTask({
    intent: "analyze",
    requester: { id: "hub", kind: "node", role: "hub" },
    target: { id: WORKER, kind: "node", role: "analyst" },
    payload: {},
  });
  broker.claimTask(task.id, WORKER);
  broker.startTask(task.id, WORKER);
  return broker.getTask(task.id) ?? task;
}

// ---------------------------------------------------------------- contract

test("every golden fixture record validates with byte-identical digests", () => {
  const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as { records: Record<string, unknown>[] };
  assert.ok(fixture.records.length >= 5);
  for (const raw of fixture.records) {
    const validation = validateTaskAttemptRecord(raw);
    assert.ok(validation.ok, `fixture record rejected: ${validation.ok ? "" : validation.reason}`);
    assert.equal(computeTaskAttemptRecordKey(raw), raw.recordKey);
    assert.equal(computeTaskAttemptFingerprint(raw), raw.fingerprint);
  }
});

test("closed vocabulary and closed shape are enforced", () => {
  const built = buildBrokerExecutionAttemptRecord({
    brokerOfRecord: "brk_1111111111111111",
    taskId: "tsk_11111111111111111111111111111111",
    retryRootTaskId: "tsk_11111111111111111111111111111111",
    attemptOrdinal: 1,
    brokerOutcome: "failed",
    reasonClass: "execution_failure",
    reasonCode: "producer_reported_failure",
  });
  assert.ok(built.ok);

  // Free-form reason cannot be emitted (spec §3.2).
  const badReason = buildBrokerExecutionAttemptRecord({
    brokerOfRecord: "brk_1111111111111111",
    taskId: "tsk_11111111111111111111111111111111",
    retryRootTaskId: "tsk_11111111111111111111111111111111",
    attemptOrdinal: 1,
    brokerOutcome: "failed",
    reasonClass: "flaky network",
    reasonCode: "socket hang up",
  });
  assert.ok(!badReason.ok);

  // succeeded must not carry a reason.
  const successWithReason = buildBrokerExecutionAttemptRecord({
    brokerOfRecord: "brk_1111111111111111",
    taskId: "tsk_11111111111111111111111111111111",
    retryRootTaskId: "tsk_11111111111111111111111111111111",
    attemptOrdinal: 1,
    brokerOutcome: "succeeded",
    reasonClass: "cancellation",
    reasonCode: "before_start",
  });
  assert.ok(!successWithReason.ok && successWithReason.reason === "reason_forbidden");

  // Extra fields fail closed; ordinal 1 must be its own retry root.
  assert.ok(built.ok);
  const extra = { ...(built.record as unknown as Record<string, unknown>), note: "free text" };
  const extraValidation = validateTaskAttemptRecord(extra);
  assert.ok(!extraValidation.ok && extraValidation.reason === "closed_field_violation");
  const rootMismatch = buildBrokerExecutionAttemptRecord({
    brokerOfRecord: "brk_1111111111111111",
    taskId: "tsk_22222222222222222222222222222222",
    retryRootTaskId: "tsk_11111111111111111111111111111111",
    attemptOrdinal: 1,
    brokerOutcome: "succeeded",
  });
  assert.ok(!rootMismatch.ok && rootMismatch.reason === "ordinal_one_root_mismatch");
});

// ------------------------------------------------------------------- store

test("store: accept, idempotent replay, same-key conflict, restart durability", () => {
  const { store, dir, path } = tempStore();
  try {
    const built = buildBrokerExecutionAttemptRecord({
      brokerOfRecord: "brk_1111111111111111",
      taskId: "tsk_11111111111111111111111111111111",
      retryRootTaskId: "tsk_11111111111111111111111111111111",
      attemptOrdinal: 1,
      brokerOutcome: "failed",
      reasonClass: "execution_failure",
      reasonCode: "producer_reported_failure",
    });
    assert.ok(built.ok);
    const record = built.record;

    assert.equal(store.submit(record).status, "accepted");
    assert.equal(store.submit(record).status, "idempotent_replay");
    assert.equal(store.recordCount(), 1);

    // Same identity (⇒ same recordKey), different validated payload ⇒ conflict,
    // original untouched (spec §6).
    const mutated = buildBrokerExecutionAttemptRecord({
      brokerOfRecord: "brk_1111111111111111",
      taskId: "tsk_11111111111111111111111111111111",
      retryRootTaskId: "tsk_11111111111111111111111111111111",
      attemptOrdinal: 1,
      brokerOutcome: "canceled",
      reasonClass: "cancellation",
      reasonCode: "before_start",
    });
    assert.ok(mutated.ok);
    assert.equal(mutated.record.recordKey, record.recordKey);
    assert.equal(store.submit(mutated.record).status, "same_key_payload_conflict");
    assert.equal(store.getByRecordKey(record.recordKey)?.brokerOutcome, "failed");

    // Malformed input is contract_rejected, nothing stored.
    const rejected = store.submit({ kind: "TaskAttemptRecordV1" });
    assert.equal(rejected.status, "contract_rejected");
    assert.equal(store.recordCount(), 1);

    // Issue acceptance: identical read-back after restart.
    store.close();
    const reopened = new TaskAttemptRecordStore(path);
    const readBack = reopened.getByRecordKey(record.recordKey);
    assert.deepEqual(readBack, record);
    assert.equal(reopened.submit(record).status, "idempotent_replay");
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("store: a corrupted row fails closed to no data, not bad data", () => {
  const { store, dir, path } = tempStore();
  try {
    const built = buildBrokerExecutionAttemptRecord({
      brokerOfRecord: "brk_1111111111111111",
      taskId: "tsk_11111111111111111111111111111111",
      retryRootTaskId: "tsk_11111111111111111111111111111111",
      attemptOrdinal: 1,
      brokerOutcome: "succeeded",
    });
    assert.ok(built.ok);
    store.submit(built.record);
    store.close();
    const db = new DatabaseSync(path);
    db.prepare(`UPDATE ${TASK_ATTEMPT_RECORD_TABLE} SET canonical_payload = ?`).run('{"kind":"tampered"}');
    db.close();
    const reopened = new TaskAttemptRecordStore(path);
    assert.equal(reopened.getByRecordKey(built.record.recordKey), undefined);
    assert.deepEqual(reopened.listByRetryRoot(built.record.brokerOfRecord, built.record.retryRootTaskId), []);
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- producer

test("producer: stable aliases, explicit retry lineage ordinals, idempotent re-emission", () => {
  const { store, dir } = tempStore();
  try {
    const root = recordBrokerTerminalAttempt(store, {
      localTaskId: "local-task-1",
      localBrokerId: "local-broker",
      status: "failed",
      everClaimed: true,
    });
    assert.equal(root.status, "accepted");

    const retry = recordBrokerTerminalAttempt(store, {
      localTaskId: "local-task-2",
      localBrokerId: "local-broker",
      status: "succeeded",
      everClaimed: true,
      retryOfLocalTaskId: "local-task-1",
    });
    assert.equal(retry.status, "accepted");

    const brokerAlias = store.aliasFor("broker", "local-broker");
    const rootAlias = store.aliasFor("task", "local-task-1");
    const lineage = store.listByRetryRoot(brokerAlias, rootAlias);
    assert.equal(lineage.length, 2);
    assert.deepEqual(lineage.map((r) => r.attemptOrdinal), [1, 2]);
    assert.equal(lineage[0].brokerOutcome, "failed");
    assert.equal(lineage[1].brokerOutcome, "succeeded");
    // No broker-local identifier leaks into the public record.
    for (const record of lineage) {
      const canonical = JSON.stringify(record);
      assert.ok(!canonical.includes("local-task"));
      assert.ok(!canonical.includes("local-broker"));
    }

    // Re-emission of a terminal task reproduces the same record: replay.
    const again = recordBrokerTerminalAttempt(store, {
      localTaskId: "local-task-2",
      localBrokerId: "local-broker",
      status: "succeeded",
      everClaimed: true,
      retryOfLocalTaskId: "local-task-1",
    });
    assert.equal(again.status, "idempotent_replay");
    assert.equal(store.recordCount(), 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("producer: cancellation honesty — supersession vs claim history", () => {
  const { store, dir } = tempStore();
  try {
    const superseded = recordBrokerTerminalAttempt(store, {
      localTaskId: "t-superseded",
      localBrokerId: "b",
      status: "canceled",
      cancellationKind: "superseded",
      everClaimed: true,
    });
    assert.equal(superseded.status, "accepted");
    const preStart = recordBrokerTerminalAttempt(store, {
      localTaskId: "t-prestart",
      localBrokerId: "b",
      status: "canceled",
      everClaimed: false,
    });
    assert.equal(preStart.status, "accepted");
    const brokerAlias = store.aliasFor("broker", "b");
    const supersededRecord = store.listByRetryRoot(brokerAlias, store.aliasFor("task", "t-superseded"))[0];
    assert.equal(supersededRecord.brokerOutcome, "superseded");
    assert.equal(supersededRecord.reasonCode, "newer_attempt");
    const preStartRecord = store.listByRetryRoot(brokerAlias, store.aliasFor("task", "t-prestart"))[0];
    assert.equal(preStartRecord.brokerOutcome, "canceled");
    assert.equal(preStartRecord.reasonCode, "before_start");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------ broker wiring

test("broker default is off: no store, no recording, unchanged execution", () => {
  const broker = new InMemoryA2ABroker();
  setupWorker(broker);
  const task = runningTask(broker);
  broker.completeTask(task.id, WORKER, { summary: "ok" });
  const diagnostics = broker.taskAttemptRecordDiagnostics();
  assert.equal(diagnostics.enabled, false);
  assert.equal(diagnostics.emitted, 0);
  assert.equal(broker.getTask(task.id)?.status, "succeeded");
});

test("broker record mode: terminal transitions emit durable records, replays counted", () => {
  const { store, dir, path } = tempStore();
  try {
    const broker = new InMemoryA2ABroker(undefined, undefined, { taskAttemptRecordStore: store });
    setupWorker(broker);

    const succeeded = runningTask(broker);
    broker.completeTask(succeeded.id, WORKER, { summary: "ok" });
    const failed = runningTask(broker);
    broker.failTask(failed.id, WORKER, { code: "internal_error", message: "worker reported failure" });

    let diagnostics = broker.taskAttemptRecordDiagnostics();
    assert.equal(diagnostics.enabled, true);
    assert.equal(diagnostics.emitted, 2);
    assert.equal(diagnostics.conflicted, 0);

    // Idempotent terminal wrapper re-entry emits a replay, not a duplicate.
    broker.completeTask(succeeded.id, WORKER, { summary: "ok" });
    diagnostics = broker.taskAttemptRecordDiagnostics();
    assert.equal(diagnostics.emitted, 2);
    assert.equal(diagnostics.replayed, 1);

    // Issue acceptance: the record survives a store restart identically.
    const brokerAlias = store.aliasFor("broker", "broker-local");
    const failedAlias = store.aliasFor("task", failed.id);
    store.close();
    const reopened = new TaskAttemptRecordStore(path);
    const records = reopened.listByRetryRoot(brokerAlias, failedAlias);
    assert.equal(records.length, 1);
    assert.equal(records[0].brokerOutcome, "failed");
    assert.equal(records[0].reasonClass, "execution_failure");
    assert.equal(records[0].reasonCode, "producer_reported_failure");
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("broker record mode: a throwing store never affects task execution (fail-open)", () => {
  const throwing: TaskAttemptStoreSurface = {
    aliasFor() {
      throw new Error("store unavailable");
    },
    listByRetryRoot() {
      throw new Error("store unavailable");
    },
    submit() {
      throw new Error("store unavailable");
    },
  };
  const broker = new InMemoryA2ABroker(undefined, undefined, { taskAttemptRecordStore: throwing });
  setupWorker(broker);
  const task = runningTask(broker);
  const completed = broker.completeTask(task.id, WORKER, { summary: "ok" });
  assert.equal(completed.status, "succeeded");
  const diagnostics = broker.taskAttemptRecordDiagnostics();
  assert.equal(diagnostics.skipped, 1);
  assert.ok(diagnostics.lastSkipReason?.startsWith("producer_error:"));
});
