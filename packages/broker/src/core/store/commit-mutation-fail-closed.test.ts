/**
 * #2523: a failed durable write inside commitMutation fails closed.
 *
 * Memory changes before the store write. When the write then failed, the
 * batch rolled back on disk while memory kept the transition, the hints the
 * write drained were gone, and a retry was idempotent in memory, so it got
 * 200 with nothing persisted (the source of #2499's "terminal task row
 * without spend row", G2). Now:
 * - the drained hints are put back (no hint row is lost);
 * - persistence is degraded and every mutation, and every mutating route's
 *   ACK, is refused with 503 `state_unavailable` until a recovery save (a full
 *   save of memory) succeeds, or the broker restarts;
 * - reads are still served; `/health` and the operator alert scan show it.
 *
 * The failure is forced with a SQLite trigger that RAISEs on the spend-ledger
 * insert, the last row of the completion's write, so memory has fully
 * transitioned when the write fails. Covered on both in-process wirings
 * (hints only, repositories on write), both load sources, and the
 * worker-thread topology where the write is queued.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";

import { intentHash } from "a2a-review-lifecycle";
import type { IntentContractV1, ReviewLineageBudgetV1, ReviewLineageRecord } from "a2a-review-lifecycle";

import { assertDurableWritesAvailable, registerDurableAckGate } from "../../http/error-mapping.js";
import { jsonHeaders, startTestServer } from "../../server-test-helpers.js";
import { BrokerError, InMemoryA2ABroker } from "../broker.js";
import { projectPersistenceDegradedAlert } from "../observability/alert-projection.js";
import type { CreateTaskRequest, SpendEventRecord, TaskRecord } from "../types.js";
import {
  DurableWriteHealth,
  durableWriteErrorClass,
  PendingHotStateBuffer,
  withoutHotTableHints,
} from "./pending-hot-state-buffer.js";
import { REVIEW_LINEAGE_OBSERVATION_META_TABLE } from "./review-lineage-observation-store.js";
import { ReviewLineageStore } from "./review-lineage-store.js";
import { createWorkerThreadPersistence } from "./sqlite-worker-thread-persistence.js";
import {
  emptySnapshot,
  SqliteArtifactRuntimeRepository,
  SqliteAuditRuntimeRepository,
  SqliteBrokerStateStore,
  SqliteExchangeMessageRuntimeRepository,
  SqliteExchangeRuntimeRepository,
  SqliteProposalRuntimeRepository,
  SqliteTaskRuntimeRepository,
  SqliteTombstoneRuntimeRepository,
  SqliteValidationRuntimeRepository,
  SqliteWorkerRuntimeRepository,
  type BrokerStateStore,
  type SqliteBrokerLoadSource,
} from "./store.js";

const LOAD_SOURCES: readonly SqliteBrokerLoadSource[] = ["snapshot", "hot-tables"];
const WIRINGS = ["hints", "repositories"] as const;
type Wiring = (typeof WIRINGS)[number];

const TELEMETRY = {
  schemaVersion: "a2a.analysis-execution-telemetry.v1",
  source: "claude_cli_envelope",
  elapsedMs: 1200,
  modelRequests: 1,
  inputTokens: 10,
  outputTokens: 20,
  costUsd: 0.01,
};
const RESULT = { summary: "done", output: { executionTelemetry: TELEMETRY } };

const FAIL_SPEND_TRIGGER = `CREATE TRIGGER fail_spend_2523 BEFORE INSERT ON broker_spend_events
  BEGIN SELECT RAISE(ABORT, 'forced_spend_write_failure_2523'); END`;
const DROP_SPEND_TRIGGER = "DROP TRIGGER fail_spend_2523";

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function taskRequest(id: string): CreateTaskRequest {
  return {
    id,
    intent: "analyze",
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    assignedWorkerId: "worker-a",
    message: `task ${id}`,
    payload: {},
  };
}

/** Repositories wiring mirrors server.ts for an in-process SQLite store; hints wiring has none. */
function repositoriesFor(store: SqliteBrokerStateStore, wiring: Wiring) {
  if (wiring === "hints") return {};
  return {
    taskRepository: new SqliteTaskRuntimeRepository(store),
    auditRepository: new SqliteAuditRuntimeRepository(store),
    tombstoneRepository: new SqliteTombstoneRuntimeRepository(store),
    workerRepository: new SqliteWorkerRuntimeRepository(store),
    exchangeRepository: new SqliteExchangeRuntimeRepository(store),
    exchangeMessageRepository: new SqliteExchangeMessageRuntimeRepository(store),
    proposalRepository: new SqliteProposalRuntimeRepository(store),
    artifactRepository: new SqliteArtifactRuntimeRepository(store),
    validationRepository: new SqliteValidationRuntimeRepository(store),
  };
}

function openBroker(store: SqliteBrokerStateStore, wiring: Wiring): InMemoryA2ABroker {
  return new InMemoryA2ABroker(store, store.load(), {
    ...repositoriesFor(store, wiring),
    persistenceRecoveryProbeIntervalMs: 0,
  });
}

function registerWorker(broker: InMemoryA2ABroker, nodeId = "worker-a"): void {
  broker.registerWorker({
    nodeId,
    role: "analyst",
    capabilities: {
      canAnalyze: true,
      canBackfill: false,
      canPatchWorkspace: false,
      canPromoteLive: false,
      workspaceIds: ["default"],
      environments: ["research"],
    },
  });
}

function startedTask(broker: InMemoryA2ABroker, id: string): void {
  broker.createTask(taskRequest(id));
  broker.claimTask(id, "worker-a");
  broker.startTask(id, "worker-a");
}

function exec(dbFile: string, sql: string): void {
  const db = new DatabaseSync(dbFile);
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec(sql);
  } finally {
    db.close();
  }
}

function query<T>(dbFile: string, sql: string, ...params: string[]): T[] {
  const db = new DatabaseSync(dbFile);
  try {
    return db.prepare(sql).all(...params).map((row) => ({ ...row })) as T[];
  } finally {
    db.close();
  }
}

function diskStatus(dbFile: string, taskId: string): string | undefined {
  return query<{ status: string }>(dbFile, "SELECT status FROM broker_tasks WHERE id = ?", taskId)[0]?.status;
}

function spendRows(dbFile: string): string[] {
  return query<{ task_id: string }>(dbFile, "SELECT task_id FROM broker_spend_events ORDER BY task_id").map((row) => row.task_id);
}

/** Silence the expected failure logs (and keep them for assertions). */
function captureLogs(t: TestContext): { errors: string[]; warns: string[] } {
  const logs = { errors: [] as string[], warns: [] as string[] };
  t.mock.method(console, "error", (...args: unknown[]) => {
    logs.errors.push(args.map(String).join(" "));
  });
  t.mock.method(console, "warn", (...args: unknown[]) => {
    logs.warns.push(args.map(String).join(" "));
  });
  return logs;
}

function assertStateUnavailable(fn: () => unknown, label: string): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof BrokerError, `${label}: a BrokerError`);
    assert.equal(error.code, "state_unavailable", label);
    assert.match(error.message, /broker_persistence_degraded/, label);
    return true;
  });
}

// --- In-process: both wirings, both load sources -----------------------------------

for (const loadSource of LOAD_SOURCES) {
  for (const wiring of WIRINGS) {
    test(`[${loadSource}/${wiring}] a failed durable write fails closed, keeps its hints, and clears on a recovery save (#2523)`, (t) => {
      const logs = captureLogs(t);
      const dir = tempDir("a2a-2523-in-process-");
      const dbFile = join(dir, "state.sqlite");
      try {
        const store = new SqliteBrokerStateStore(dbFile, { loadSource });
        try {
          const broker = openBroker(store, wiring);
          registerWorker(broker);
          startedTask(broker, "task-2523");
          assert.equal(diskStatus(dbFile, "task-2523"), "running");

          exec(dbFile, FAIL_SPEND_TRIGGER);
          assert.throws(() => broker.completeTask("task-2523", "worker-a", RESULT), /forced_spend_write_failure_2523/);

          // The rollback left disk behind memory; the broker now knows it.
          assert.equal(broker.getTask("task-2523")?.status, "succeeded", "memory kept the transition");
          assert.equal(diskStatus(dbFile, "task-2523"), "running", "the batch rolled back on disk");
          assert.deepEqual(spendRows(dbFile), []);
          const degraded = broker.getDurableWriteHealth();
          assert.equal(degraded.state, "degraded");
          assert.equal(degraded.lastFailure?.topology, "in_process");
          assert.match(degraded.lastFailure?.message ?? "", /forced_spend_write_failure_2523/);
          assert.equal(broker.getPersistenceAlerts()[0]?.kind, "persistence_degraded");
          assert.ok(logs.errors.some((line) => line.includes("broker.persistence.degraded")), "one degraded log line");

          // Every mutation is refused while the recovery save keeps failing,
          // before it touches memory.
          assertStateUnavailable(() => broker.createTask(taskRequest("task-refused")), "createTask");
          assert.ok(!broker.getTask("task-refused"), "the refused mutation changed nothing");
          assertStateUnavailable(() => broker.createTask(taskRequest("task-refused")), "createTask again");
          assert.equal(broker.getDurableWriteHealth().state, "degraded");
          // Reads are still served.
          assert.equal(broker.listTasks().some((task) => task.id === "task-2523"), true);

          // The disk recovers: the next mutation's recovery save rewrites disk
          // from memory, the restored spend hint included, and lets it through.
          exec(dbFile, DROP_SPEND_TRIGGER);
          broker.createTask(taskRequest("task-after"));
          const recovered = broker.getDurableWriteHealth();
          assert.equal(recovered.state, "ok");
          assert.equal(recovered.recoveriesTotal, 1);
          assert.ok(recovered.failuresTotal >= 2, "the failed recovery saves are counted too");
          assert.deepEqual(broker.getPersistenceAlerts(), []);
          assert.ok(logs.warns.some((line) => line.includes("broker.persistence.recovered")));
          assert.equal(diskStatus(dbFile, "task-2523"), "succeeded", "disk caught up with memory");
          assert.deepEqual(spendRows(dbFile), ["task-2523"], "the drained spend row was not lost");
          assert.equal(diskStatus(dbFile, "task-after"), "queued");
          assert.equal(broker.completeTask("task-2523", "worker-a", RESULT).status, "succeeded", "the retry is idempotent");
        } finally {
          store.close();
        }

        // A restart loads exactly what memory held: nothing to requeue.
        const reopened = new SqliteBrokerStateStore(dbFile, { loadSource });
        try {
          const loaded = reopened.load();
          assert.equal(loaded.tasks.find((task) => task.id === "task-2523")?.status, "succeeded");
          assert.equal(loaded.tasks.some((task) => task.id === "task-refused"), false);
        } finally {
          reopened.close();
        }
        assert.deepEqual(spendRows(dbFile), ["task-2523"], "exactly one spend row");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
}

test("a restart clears the degraded state: memory reloads from disk and the task completes once (#2523)", (t) => {
  captureLogs(t);
  const dir = tempDir("a2a-2523-restart-");
  const dbFile = join(dir, "state.sqlite");
  try {
    const store = new SqliteBrokerStateStore(dbFile, { loadSource: "hot-tables" });
    try {
      const broker = openBroker(store, "repositories");
      registerWorker(broker);
      startedTask(broker, "task-restart");
      exec(dbFile, FAIL_SPEND_TRIGGER);
      assert.throws(() => broker.completeTask("task-restart", "worker-a", RESULT), /forced_spend_write_failure_2523/);
      assert.equal(broker.getDurableWriteHealth().state, "degraded");
    } finally {
      store.close();
    }
    exec(dbFile, DROP_SPEND_TRIGGER);

    const reopened = new SqliteBrokerStateStore(dbFile, { loadSource: "hot-tables" });
    try {
      const broker = openBroker(reopened, "repositories");
      assert.equal(broker.getDurableWriteHealth().state, "ok", "a fresh process starts ok");
      assert.equal(broker.getTask("task-restart")?.status, "running", "memory equals disk after the restart");
      assert.equal(broker.completeTask("task-restart", "worker-a", RESULT).status, "succeeded");
    } finally {
      reopened.close();
    }
    assert.equal(diskStatus(dbFile, "task-restart"), "succeeded");
    assert.deepEqual(spendRows(dbFile), ["task-restart"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a rejection (BrokerError before any write) does not degrade persistence (#2523)", (t) => {
  captureLogs(t);
  const dir = tempDir("a2a-2523-rejection-");
  const dbFile = join(dir, "state.sqlite");
  try {
    const store = new SqliteBrokerStateStore(dbFile);
    try {
      const broker = openBroker(store, "hints");
      registerWorker(broker);
      broker.createTask(taskRequest("task-rejected"));
      assert.throws(() => broker.startTask("task-rejected", "worker-a"), (error: unknown) => error instanceof BrokerError);
      assert.throws(() => broker.completeTask("task-missing", "worker-a", RESULT), (error: unknown) => error instanceof BrokerError);
      assert.equal(broker.getDurableWriteHealth().state, "ok");
      assert.equal(broker.getDurableWriteHealth().failuresTotal, 0);
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("recovery saves are throttled after the first one: a refusal inside the interval writes nothing (#2523)", (t) => {
  captureLogs(t);
  const dir = tempDir("a2a-2523-throttle-");
  const dbFile = join(dir, "state.sqlite");
  try {
    const store = new SqliteBrokerStateStore(dbFile);
    try {
      const broker = new InMemoryA2ABroker(store, store.load(), { persistenceRecoveryProbeIntervalMs: 60_000 });
      registerWorker(broker);
      startedTask(broker, "task-throttle");
      exec(dbFile, FAIL_SPEND_TRIGGER);
      assert.throws(() => broker.completeTask("task-throttle", "worker-a", RESULT), /forced_spend_write_failure_2523/);
      exec(dbFile, DROP_SPEND_TRIGGER);
      // The first recovery save runs on the next mutation, whatever the interval.
      broker.createTask(taskRequest("task-first-probe"));
      assert.equal(broker.getDurableWriteHealth().state, "ok");

      exec(dbFile, FAIL_SPEND_TRIGGER);
      startedTask(broker, "task-throttle-2");
      assert.throws(() => broker.completeTask("task-throttle-2", "worker-a", RESULT), /forced_spend_write_failure_2523/);
      exec(dbFile, DROP_SPEND_TRIGGER);
      broker.createTask(taskRequest("task-second-probe"));
      assert.equal(broker.getDurableWriteHealth().state, "ok", "a new degraded period gets an immediate probe again");

      exec(dbFile, FAIL_SPEND_TRIGGER);
      startedTask(broker, "task-throttle-3");
      assert.throws(() => broker.completeTask("task-throttle-3", "worker-a", RESULT), /forced_spend_write_failure_2523/);
      assertStateUnavailable(() => broker.createTask(taskRequest("task-probe-fails")), "probe fails");
      exec(dbFile, DROP_SPEND_TRIGGER);
      const commitsBefore = store.commits;
      assertStateUnavailable(() => broker.createTask(taskRequest("task-throttled")), "throttled");
      assert.equal(store.commits, commitsBefore, "a throttled refusal issues no write");
      assert.equal(broker.retryDegradedPersistence(), "degraded", "the sweep retry respects the interval too");
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- Worker-thread topology: the write is queued ------------------------------------

test("[worker-thread] a failed queued write puts its hints back and degrades; a queued recovery save clears it on ack (#2523)", async (t) => {
  captureLogs(t);
  const dir = tempDir("a2a-2523-worker-thread-");
  const dbFile = join(dir, "state.sqlite");
  const handle = createWorkerThreadPersistence({ dbFile, loadSource: "hot-tables", queueCapacity: 64 });
  try {
    const proxy = handle.stateStore;
    const broker = new InMemoryA2ABroker(proxy, proxy.load(), { persistenceRecoveryProbeIntervalMs: 0 });
    registerWorker(broker);
    startedTask(broker, "task-queued");
    await proxy.awaitDurablePersistenceAck();
    assert.equal(diskStatus(dbFile, "task-queued"), "running");

    exec(dbFile, FAIL_SPEND_TRIGGER);
    // The mutation returns before its write runs: memory moves on at once.
    assert.equal(broker.completeTask("task-queued", "worker-a", RESULT).status, "succeeded");
    assert.equal(broker.getDurableWriteHealth().state, "ok", "nothing is known to have failed yet");
    await assert.rejects(() => proxy.awaitDurablePersistenceAck(), /forced_spend_write_failure_2523/);
    const degraded = broker.getDurableWriteHealth();
    assert.equal(degraded.state, "degraded", "the rejection degraded persistence before the ACK wait returned");
    assert.equal(degraded.lastFailure?.topology, "queued");
    assert.equal(diskStatus(dbFile, "task-queued"), "running");
    assert.deepEqual(spendRows(dbFile), []);

    // A mutation is refused; its recovery save is queued (and fails here).
    assertStateUnavailable(() => broker.createTask(taskRequest("task-refused")), "queued probe issued");
    assert.ok(!broker.getTask("task-refused"), "the refused mutation changed nothing");
    assert.equal(broker.getDurableWriteHealth().recoveryProbe.inFlight, true);
    assertStateUnavailable(() => broker.createTask(taskRequest("task-refused")), "probe in flight");
    await assert.rejects(() => proxy.awaitDurablePersistenceAck(), /forced_spend_write_failure_2523/);
    assert.equal(broker.getDurableWriteHealth().state, "degraded", "a failed recovery save keeps it degraded");
    assert.equal(broker.getDurableWriteHealth().recoveryProbe.inFlight, false);

    exec(dbFile, DROP_SPEND_TRIGGER);
    assertStateUnavailable(() => broker.createTask(taskRequest("task-refused")), "refused while the probe is queued");
    await proxy.awaitDurablePersistenceAck();
    assert.equal(broker.getDurableWriteHealth().state, "ok", "the queued recovery save cleared it on ack");
    assert.equal(diskStatus(dbFile, "task-queued"), "succeeded", "disk caught up with memory");
    assert.deepEqual(spendRows(dbFile), ["task-queued"], "the drained spend row was not lost");

    broker.createTask(taskRequest("task-after"));
    await proxy.awaitDurablePersistenceAck();
    assert.equal(diskStatus(dbFile, "task-after"), "queued");
    assert.equal(diskStatus(dbFile, "task-refused"), undefined);
  } finally {
    await handle.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("[worker-thread] a queued write that fails after a recovery save was queued keeps the broker degraded (#2523)", async (t) => {
  captureLogs(t);
  const dir = tempDir("a2a-2523-worker-epoch-");
  const dbFile = join(dir, "state.sqlite");
  const handle = createWorkerThreadPersistence({ dbFile, loadSource: "hot-tables", queueCapacity: 64 });
  try {
    const proxy = handle.stateStore;
    const broker = new InMemoryA2ABroker(proxy, proxy.load(), { persistenceRecoveryProbeIntervalMs: 0 });
    registerWorker(broker);
    startedTask(broker, "task-a");
    startedTask(broker, "task-b");
    await proxy.awaitDurablePersistenceAck();

    exec(dbFile, FAIL_SPEND_TRIGGER);
    broker.completeTask("task-a", "worker-a", RESULT);
    broker.completeTask("task-b", "worker-a", RESULT);
    await assert.rejects(() => proxy.awaitDurablePersistenceAck());
    // Both writes failed: two failures, one degraded period.
    assert.equal(broker.getDurableWriteHealth().failuresTotal, 2);
    exec(dbFile, DROP_SPEND_TRIGGER);
    assertStateUnavailable(() => broker.createTask(taskRequest("task-x")), "probe queued");
    await proxy.awaitDurablePersistenceAck();
    assert.equal(broker.getDurableWriteHealth().state, "ok");
    assert.deepEqual(spendRows(dbFile), ["task-a", "task-b"], "both drained spend rows were put back and written");
    assert.equal(diskStatus(dbFile, "task-a"), "succeeded");
    assert.equal(diskStatus(dbFile, "task-b"), "succeeded");
  } finally {
    await handle.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- Over HTTP: a retry never gets a false 200 ---------------------------------------

type HttpTopology = Wiring | "worker-thread";

for (const topology of ["hints", "repositories", "worker-thread"] as const satisfies readonly HttpTopology[]) {
  test(`[http/${topology}] a retried complete after a failed write gets 503, not 200, until disk holds the transition (#2523)`, async (t) => {
    captureLogs(t);
    const dir = tempDir("a2a-2523-http-");
    const dbFile = join(dir, "state.sqlite");
    let close: () => Promise<void> = async () => {};
    let stateStore: BrokerStateStore;
    let broker: InMemoryA2ABroker;
    let awaitQueue: () => Promise<void> = async () => {};
    if (topology === "worker-thread") {
      const handle = createWorkerThreadPersistence({ dbFile, loadSource: "hot-tables", queueCapacity: 64 });
      stateStore = handle.stateStore;
      broker = new InMemoryA2ABroker(stateStore, handle.stateStore.load(), { persistenceRecoveryProbeIntervalMs: 0 });
      awaitQueue = () => handle.queue.awaitIdle({ timeoutMs: 10_000 });
      close = () => handle.close();
    } else {
      const store = new SqliteBrokerStateStore(dbFile, { loadSource: "hot-tables" });
      stateStore = store;
      broker = openBroker(store, topology);
      close = async () => store.close();
    }
    const server = await startTestServer({
      stateStore,
      broker,
      sharedStateFile: join(dir, "serving-fence.sqlite"),
      enforceRequesterIdentity: false,
    });
    const complete = () =>
      fetch(`${server.baseUrl}/tasks/task-http/complete`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ workerId: "worker-a", result: RESULT }),
      });
    const health = async () => (await (await fetch(`${server.baseUrl}/health`)).json()) as {
      ok: boolean;
      error?: string;
      persistenceWrites: { state: string; recoveriesTotal: number };
    };
    try {
      registerWorker(broker);
      startedTask(broker, "task-http");
      await awaitQueue();

      exec(dbFile, FAIL_SPEND_TRIGGER);
      const failed = await complete();
      assert.equal(failed.status, 500, await failed.text());

      const retry = await complete();
      const retryBody = await retry.text();
      assert.equal(retry.status, 503, `the retry must not be acknowledged: ${retryBody}`);
      assert.equal((JSON.parse(retryBody) as { error: { code: string } }).error.code, "state_unavailable");
      assert.equal(diskStatus(dbFile, "task-http"), "running", "nothing persisted");

      const read = await fetch(`${server.baseUrl}/tasks/task-http`);
      assert.equal(read.status, 200, "reads are still served");
      const degradedHealth = await health();
      assert.equal(degradedHealth.persistenceWrites.state, "degraded");
      assert.equal(degradedHealth.ok, false);
      assert.match(degradedHealth.error ?? "", /persistence degraded/);
      const alerts = (await (await fetch(`${server.baseUrl}/alerts`)).json()) as { alerts: Array<{ kind: string }> };
      assert.ok(alerts.alerts.some((alert) => alert.kind === "persistence_degraded"), "the operator alert is open");

      exec(dbFile, DROP_SPEND_TRIGGER);
      await awaitQueue();
      let final = await complete();
      if (topology === "worker-thread") {
        // The recovery save is queued: refused until it acks, then accepted.
        assert.equal(final.status, 503, await final.text());
        await awaitQueue();
        final = await complete();
      }
      assert.equal(final.status, 200, await final.text());
      assert.equal(diskStatus(dbFile, "task-http"), "succeeded", "a 200 means disk holds the transition");
      assert.deepEqual(spendRows(dbFile), ["task-http"]);
      const recoveredHealth = await health();
      assert.equal(recoveredHealth.persistenceWrites.state, "ok");
      assert.equal(recoveredHealth.persistenceWrites.recoveriesTotal, 1);
    } finally {
      await server.close();
      await close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

// --- Units ---------------------------------------------------------------------------

function spendEvent(taskId: string, costUsd: number): SpendEventRecord {
  return { taskId, costUsd } as unknown as SpendEventRecord;
}

test("PendingHotStateBuffer.restore keeps newer staged rows, lets the earlier spend row win, and honours except (#2523)", () => {
  const buffer = new PendingHotStateBuffer();
  const v1 = { id: "t-1", status: "running" } as TaskRecord;
  const v2 = { id: "t-1", status: "succeeded" } as TaskRecord;
  buffer.stageTask(v1);
  buffer.stageSpendEvent(spendEvent("t-1", 1));
  buffer.stageBudget({ id: "b-1" } as never);
  const drained = buffer.consumeAll()!;
  assert.equal(buffer.hasPending(), false);

  buffer.stageTask(v2);
  buffer.stageSpendEvent(spendEvent("t-1", 2));
  buffer.restore(drained, { except: ["budgets"] });
  const after = buffer.consumeAll()!;
  assert.deepEqual(after.hotTasks?.map((task) => task.status), ["succeeded"], "the newer staged task row is kept");
  assert.deepEqual(after.spendEvents?.map((event) => event.costUsd), [1], "the earlier spend row wins (first write wins)");
  assert.equal(after.budgets, undefined, "budgets are not put back");

  buffer.restore(drained);
  const full = buffer.consumeAll()!;
  assert.deepEqual(full.hotTasks?.map((task) => task.status), ["running"]);
  assert.deepEqual(full.budgets?.map((budget) => budget.id), ["b-1"]);
});

test("withoutHotTableHints keeps only the rows with no snapshot copy (#2523)", () => {
  assert.equal(withoutHotTableHints(undefined), undefined);
  assert.equal(withoutHotTableHints({ hotTasks: [{ id: "t" } as TaskRecord] }), undefined);
  assert.deepEqual(
    Object.keys(withoutHotTableHints({ hotTasks: [], hotAuditEvents: [], spendEvents: [], goals: [] }) ?? {}),
    ["spendEvents", "goals"],
  );
});

test("DurableWriteHealth: epoch-guarded probes, an immediate first probe, then the interval (#2523)", () => {
  const health = new DurableWriteHealth(1_000);
  assert.equal(health.beginProbe({ queued: false }, 0), undefined, "no probe while ok");
  assert.equal(health.markFailed(new Error("disk full"), "queued", 10), true, "opens the state");
  assert.equal(health.markFailed(new Error("again"), "queued", 11), false, "already open");

  const token = health.beginProbe({ queued: true }, 12)!;
  assert.notEqual(token, undefined, "the first probe runs at once");
  assert.equal(health.beginProbe({ queued: true }, 5_000), undefined, "never two queued probes");
  health.markFailed(new Error("an earlier queued write failed"), "queued", 13);
  assert.equal(health.probeSettled(token, true, 14), false, "a failure after the probe started keeps it degraded");
  assert.equal(health.beginProbe({ queued: false }, 500), undefined, "inside the interval");
  const next = health.beginProbe({ queued: false }, 1_012)!;
  assert.equal(health.probeSettled(next, true, 1_013), true);
  const snapshot = health.snapshot();
  assert.equal(snapshot.state, "ok");
  assert.equal(snapshot.failuresTotal, 3);
  assert.equal(snapshot.recoveriesTotal, 1);
  assert.equal(snapshot.lastFailure?.message, "an earlier queued write failed");
  assert.equal(projectPersistenceDegradedAlert(snapshot), null);
  health.markFailed(new Error("x".repeat(1_000)), "in_process", 2_000);
  assert.equal(health.snapshot().lastFailure?.message.length, 300, "the stored message is bounded");
  assert.equal(projectPersistenceDegradedAlert(health.snapshot())?.severity, "critical");
});

// --- Review findings (#2538): persistent failures, backoff, legacy import, sweep -------

function freezeClock(t: TestContext): { advance(ms: number): void } {
  let now = Date.now();
  t.mock.timers.enable({ apis: ["Date"], now });
  return {
    advance(ms: number) {
      now += ms;
      t.mock.timers.setTime(now);
    },
  };
}

test("a failure disk always rejects stays fail-closed, reports its error class and failure streak, and a restart clears it (#2523)", (t) => {
  captureLogs(t);
  const dir = tempDir("a2a-2523-persistent-");
  const dbFile = join(dir, "state.sqlite");
  try {
    const store = new SqliteBrokerStateStore(dbFile, { loadSource: "hot-tables" });
    try {
      const broker = openBroker(store, "repositories");
      registerWorker(broker);
      startedTask(broker, "task-poison");
      // Disk rejects this one task's terminal row for good; memory holds it.
      for (const op of ["INSERT", "UPDATE"]) {
        exec(dbFile, `CREATE TRIGGER poison_2523_${op} BEFORE ${op} ON broker_tasks
          WHEN NEW.id = 'task-poison' AND NEW.status = 'succeeded'
          BEGIN SELECT RAISE(ABORT, 'poison_row_2523'); END`);
      }
      assert.throws(() => broker.completeTask("task-poison", "worker-a", RESULT), /poison_row_2523/);
      for (let attempt = 0; attempt < 5; attempt += 1) {
        assertStateUnavailable(() => broker.createTask(taskRequest(`task-refused-${attempt}`)), `attempt ${attempt}`);
      }
      const health = broker.getDurableWriteHealth();
      assert.equal(health.state, "degraded", "drift is worse than refusing: stays fail-closed");
      assert.equal(health.lastFailure?.errorClass, "Error/ERR_SQLITE_ERROR");
      assert.equal(health.recoveryProbe.consecutiveFailures, 5);
      assert.equal(health.failuresTotal, 6);
      const alert = broker.getPersistenceAlerts()[0]!;
      assert.equal(alert.metadata.lastFailureErrorClass, "Error/ERR_SQLITE_ERROR");
      assert.equal(alert.metadata.consecutiveRecoveryFailures, 5);
      assert.match(alert.summary, /Error\/ERR_SQLITE_ERROR, 5 failed recovery save/);
    } finally {
      store.close();
    }
    // The restart reloads memory from disk: the row disk rejects is not in
    // memory any more, so nothing has to be written and the broker serves.
    const reopened = new SqliteBrokerStateStore(dbFile, { loadSource: "hot-tables" });
    try {
      const broker = openBroker(reopened, "repositories");
      assert.equal(broker.getDurableWriteHealth().state, "ok");
      assert.equal(broker.getTask("task-poison")?.status, "running");
      broker.createTask(taskRequest("task-after-restart"));
      assert.equal(broker.getDurableWriteHealth().state, "ok");
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("recovery saves back off exponentially while they keep failing, and the backoff resets on success (#2523)", (t) => {
  captureLogs(t);
  const clock = freezeClock(t);
  const dir = tempDir("a2a-2523-backoff-");
  const dbFile = join(dir, "state.sqlite");
  try {
    const store = new SqliteBrokerStateStore(dbFile);
    try {
      const broker = new InMemoryA2ABroker(store, store.load(), { persistenceRecoveryProbeIntervalMs: 1_000 });
      registerWorker(broker);
      startedTask(broker, "task-backoff");
      exec(dbFile, FAIL_SPEND_TRIGGER);
      assert.throws(() => broker.completeTask("task-backoff", "worker-a", RESULT), /forced_spend_write_failure_2523/);
      const probes = (): number => broker.getDurableWriteHealth().failuresTotal - 1;
      // Probe 1 runs at once and fails; then waits of 1 s, 2 s, 4 s, 8 s.
      assertStateUnavailable(() => broker.createTask(taskRequest("x")), "probe 1");
      assert.equal(probes(), 1);
      for (const wait of [1_000, 2_000, 4_000, 8_000]) {
        clock.advance(wait - 1);
        const commits = store.commits;
        assertStateUnavailable(() => broker.createTask(taskRequest("x")), `inside ${wait}`);
        assert.equal(store.commits, commits, `no write inside the ${wait} ms backoff`);
        assert.equal(broker.getDurableWriteHealth().recoveryProbe.intervalMs, wait);
        const before = probes();
        clock.advance(1);
        assertStateUnavailable(() => broker.createTask(taskRequest("x")), `after ${wait}`);
        assert.equal(probes(), before + 1, `a probe runs once ${wait} ms passed`);
      }
      assert.equal(broker.getDurableWriteHealth().recoveryProbe.consecutiveFailures, 5);
      assert.equal(broker.getDurableWriteHealth().recoveryProbe.intervalMs, 16_000);

      exec(dbFile, DROP_SPEND_TRIGGER);
      clock.advance(16_000);
      broker.createTask(taskRequest("task-recovered"));
      const recovered = broker.getDurableWriteHealth();
      assert.equal(recovered.state, "ok");
      assert.equal(recovered.recoveryProbe.consecutiveFailures, 0, "the streak resets on success");
      assert.equal(recovered.recoveryProbe.intervalMs, 1_000);
      assert.deepEqual(spendRows(dbFile), ["task-backoff"]);
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("DurableWriteHealth: the backoff is capped at 60 s (or the base interval when larger) (#2523)", () => {
  const health = new DurableWriteHealth(1_000);
  health.markFailed(new Error("disk full"), "in_process", 0);
  let now = 0;
  for (let failure = 0; failure < 12; failure += 1) {
    const token = health.beginProbe({ queued: false }, now)!;
    assert.notEqual(token, undefined, `probe ${failure} allowed at ${now}`);
    health.markFailed(new Error("disk full"), "in_process", now);
    health.probeSettled(token, false, now);
    now += health.snapshot().recoveryProbe.intervalMs;
  }
  assert.equal(health.snapshot().recoveryProbe.intervalMs, 60_000);
  assert.equal(new DurableWriteHealth(120_000).snapshot().recoveryProbe.maxIntervalMs, 120_000);
  assert.equal(durableWriteErrorClass(Object.assign(new Error("x"), { code: "ERR_SQLITE_ERROR" })), "Error/ERR_SQLITE_ERROR");
  assert.equal(durableWriteErrorClass(new TypeError("x")), "TypeError");
  assert.equal(durableWriteErrorClass("x"), "string");
});

function legacyLineage(lineageId: string): ReviewLineageRecord {
  const partial = {
    kind: "IntentContractV1" as const,
    lineageId,
    goal: "Legacy lineage carried in memory.",
    nonGoals: ["None."],
    invariants: ["Imported once."],
    acceptanceCriteria: [{ id: "AC-1", text: "Imported once." }],
    declaredPaths: { allowed: ["packages/broker/src/core/**"], forbidden: [] },
    baseSha: "2".repeat(40),
    headSha: "3".repeat(40),
    createdAt: "2026-07-23T14:20:00Z",
  };
  const contract: IntentContractV1 = { ...partial, intentHash: intentHash(partial as unknown as Record<string, unknown>) };
  const budget: ReviewLineageBudgetV1 = {
    kind: "ReviewLineageBudgetV1",
    maxWallClockSeconds: 21600,
    maxCorrectionGenerations: 1,
    maxReviewerRuns: 2,
    maxReviewerReplacements: 1,
    repeatedFindingThreshold: 2,
    onExhaustion: "blocked_needs_operator",
  };
  return new ReviewLineageStore().create({ contract, budget, diffHash: `sha256:${"b".repeat(64)}`, at: "2026-07-23T14:20:00Z" });
}

/** A record the lineage schema rejects (an unknown mode). */
function invalidLineage(lineageId: string): ReviewLineageRecord {
  return { ...legacyLineage(lineageId), mode: "bogus" } as unknown as ReviewLineageRecord;
}

function importMarkerCount(dbFile: string): number {
  return query<{ count: number }>(
    dbFile,
    `SELECT COUNT(*) AS count FROM ${REVIEW_LINEAGE_OBSERVATION_META_TABLE} WHERE key = 'legacy_snapshot_import_v1'`,
  )[0]!.count;
}

test("a legacy review lineage the schema rejects defers the import instead of failing the save (#2523)", (t) => {
  const logs = captureLogs(t);
  const dir = tempDir("a2a-2523-legacy-store-");
  const dbFile = join(dir, "state.sqlite");
  try {
    const store = new SqliteBrokerStateStore(dbFile);
    try {
      const snapshot = { ...emptySnapshot(), reviewLineages: [legacyLineage("legacy-ok"), invalidLineage("legacy-bad")] };
      store.runBatch(() => store.save(snapshot));
      store.save(snapshot);
      assert.equal(importMarkerCount(dbFile), 0, "the import stays pending");
      assert.equal(
        logs.errors.filter((line) => line.includes("broker.review_lineage.legacy_import_deferred")).length,
        1,
        "logged once per store",
      );
      assert.match(logs.errors.find((line) => line.includes("legacy_import_deferred"))!, /legacy-bad/);
      // The pre-write import (not a save) still fails loudly, as before.
      assert.throws(() => store.runBatch(() => {
        (store as unknown as { reviewLineageObservations: { importLegacySnapshot(records: unknown[]): unknown } })
          .reviewLineageObservations.importLegacySnapshot(snapshot.reviewLineages);
      }));
    } finally {
      store.close();
    }
    // A restart quarantines the rejected record (#2044) and imports the rest.
    const reopened = new SqliteBrokerStateStore(dbFile, { loadSource: "snapshot" });
    try {
      const loaded = reopened.load();
      assert.deepEqual(loaded.reviewLineages?.map((record) => record.lineageId), ["legacy-ok"]);
      assert.equal(importMarkerCount(dbFile), 1);
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const loadSource of LOAD_SOURCES) {
  test(`[${loadSource}] an invalid in-memory legacy lineage cannot degrade persistence through the full save (#2523)`, (t) => {
    captureLogs(t);
    const clock = freezeClock(t);
    const dir = tempDir("a2a-2523-legacy-broker-");
    const dbFile = join(dir, "state.sqlite");
    try {
      const store = new SqliteBrokerStateStore(dbFile, { loadSource });
      try {
        const broker = new InMemoryA2ABroker(
          store,
          { ...store.load(), reviewLineages: [invalidLineage("legacy-bad")] },
          { persistenceRecoveryProbeIntervalMs: 0 },
        );
        registerWorker(broker);
        clock.advance(6 * 60_000);
        broker.createTask(taskRequest("task-full-save"));
        clock.advance(6 * 60_000);
        broker.createTask(taskRequest("task-full-save-2"));
        assert.equal(broker.getDurableWriteHealth().state, "ok");
        assert.equal(broker.getDurableWriteHealth().failuresTotal, 0);
        assert.equal(diskStatus(dbFile, "task-full-save-2"), "queued");
      } finally {
        store.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("while degraded the stale-reaper sweep skips its mutating steps without failing, probes, and publishes the recovery (#2523)", async (t) => {
  const logs = captureLogs(t);
  const clock = freezeClock(t);
  const dir = tempDir("a2a-2523-sweep-");
  const dbFile = join(dir, "state.sqlite");
  const store = new SqliteBrokerStateStore(dbFile, { loadSource: "hot-tables" });
  const broker = openBroker(store, "repositories");
  const server = await startTestServer({
    stateStore: store,
    broker,
    sharedStateFile: join(dir, "serving-fence.sqlite"),
    enforceRequesterIdentity: false,
    staleReaperOlderThanSec: 60,
  });
  try {
    registerWorker(broker);
    startedTask(broker, "task-sweep-done");
    startedTask(broker, "task-stale");
    exec(dbFile, FAIL_SPEND_TRIGGER);
    assert.throws(() => broker.completeTask("task-sweep-done", "worker-a", RESULT), /forced_spend_write_failure_2523/);
    clock.advance(10 * 60_000);

    assert.equal(server.runtime.runStaleReaperSweep(), 0, "the requeue step is skipped while degraded");
    assert.equal(broker.getTask("task-stale")?.status, "running");
    assert.equal(logs.errors.some((line) => line.includes("stale reaper sweep failed")), false, "no sweep error");
    assert.equal(broker.getDurableWriteHealth().state, "degraded", "the sweep's recovery save failed (trigger)");

    exec(dbFile, DROP_SPEND_TRIGGER);
    server.runtime.runStaleReaperSweep();
    assert.equal(broker.getDurableWriteHealth().state, "ok", "the sweep's recovery save cleared it");
    assert.equal(diskStatus(dbFile, "task-sweep-done"), "succeeded");
    assert.equal(logs.errors.some((line) => line.includes("stale reaper sweep failed")), false);
  } finally {
    await server.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("routes that write directly run the registered fail-closed gate (#2523)", () => {
  const store = { load: () => emptySnapshot(), save: () => undefined } as BrokerStateStore;
  assert.doesNotThrow(() => assertDurableWritesAvailable(store), "no gate registered");
  registerDurableAckGate(store, () => {
    throw new BrokerError("state_unavailable", "broker_persistence_degraded: test");
  });
  assert.throws(() => assertDurableWritesAvailable(store), /broker_persistence_degraded/);
});
