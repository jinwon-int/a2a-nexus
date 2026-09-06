// Regression cover for the broker persistence/read-path performance pass.
//
// The optimizations are only acceptable if they are behaviour-preserving, so
// every test here pins an invariant the change could plausibly break:
//   - `runBatch` collapses commits without weakening atomicity (P2);
//   - the pushed-down SQL predicates select exactly the rows the JavaScript
//     predicates used to select, and the LIMIT is applied to matches (P3);
//   - `requireTask` reading the in-memory map first still falls back to rows
//     only the store has (P3).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { InMemoryA2ABroker } from "./broker.js";
import { readBrokerTask } from "./broker-task-read.js";
import {
  SqliteBrokerStateStore,
  SqliteAuditRuntimeRepository,
  SqliteTaskRuntimeRepository,
  SqliteWorkerRuntimeRepository,
} from "./store.js";
import type { TaskRecord } from "./types.js";

function tempDir(tag: string): string {
  return mkdtempSync(join(tmpdir(), `broker-perf-${tag}-`));
}

function makeStore(dir: string): SqliteBrokerStateStore {
  return new SqliteBrokerStateStore(join(dir, "state.sqlite"), {});
}

function makeBroker(store: SqliteBrokerStateStore): InMemoryA2ABroker {
  return new InMemoryA2ABroker(store, undefined, {
    taskRepository: new SqliteTaskRuntimeRepository(store),
    auditRepository: new SqliteAuditRuntimeRepository(store),
    workerRepository: new SqliteWorkerRuntimeRepository(store),
  });
}

function registerWorker(broker: InMemoryA2ABroker, nodeId: string): void {
  broker.registerWorker({
    nodeId,
    role: "analyst",
    capabilities: {
      canAnalyze: true,
      canBackfill: false,
      canPatchWorkspace: false,
      canPromoteLive: false,
      workspaceIds: ["test"],
      environments: ["research"],
    },
  });
}

function createTask(
  broker: InMemoryA2ABroker,
  id: string,
  workerId: string,
  payload: Record<string, unknown> = {},
): TaskRecord {
  return broker.createTask({
    id,
    intent: "chat",
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: workerId, kind: "node", role: "analyst" },
    assignedWorkerId: workerId,
    message: `task ${id}`,
    payload,
  });
}

/** Count BEGIN statements issued on the store's connection. */
function countTransactions(store: SqliteBrokerStateStore): { readonly count: number } {
  const db = (store as unknown as { db: { exec(sql: string): unknown } }).db;
  const original = db.exec.bind(db);
  const state = { count: 0 };
  db.exec = (sql: string) => {
    if (typeof sql === "string" && sql.startsWith("BEGIN")) state.count += 1;
    return original(sql);
  };
  return state;
}

test("runBatch commits nested store writes exactly once (P2)", () => {
  const dir = tempDir("batch");
  const store = makeStore(dir);
  try {
    const counter = countTransactions(store);
    store.runBatch(() => {
      store.upsertHotAuditEvents([
        { id: "a1", actorId: "n1", action: "task.created", targetType: "task", targetId: "t1", createdAt: "2026-01-01T00:00:00.000Z" },
      ]);
      store.pruneHotAuditEventsToMax(100);
      store.pruneHotHeartbeatAuditEventsToMax(100);
    });
    assert.equal(counter.count, 1, "three store writes inside one batch must produce one BEGIN");
    assert.equal(store.readHotAuditEvents({}).length, 1);
  } finally {
    store.close?.();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runBatch rolls back every write in the unit when the body throws (P2 atomicity)", () => {
  const dir = tempDir("rollback");
  const store = makeStore(dir);
  try {
    assert.throws(() => {
      store.runBatch(() => {
        store.upsertHotAuditEvents([
          { id: "a1", actorId: "n1", action: "task.created", targetType: "task", targetId: "t1", createdAt: "2026-01-01T00:00:00.000Z" },
        ]);
        store.upsertHotAuditEvents([
          { id: "a2", actorId: "n1", action: "task.claimed", targetType: "task", targetId: "t1", createdAt: "2026-01-01T00:00:01.000Z" },
        ]);
        throw new Error("mutation failed midway");
      });
    }, /mutation failed midway/);
    assert.deepEqual(store.readHotAuditEvents({}), [], "a partial unit of work must not survive");

    // The connection must be usable again: a failed batch that left a
    // transaction open would make every later write fail.
    store.runBatch(() => {
      store.upsertHotAuditEvents([
        { id: "a3", actorId: "n1", action: "task.created", targetType: "task", targetId: "t2", createdAt: "2026-01-01T00:00:02.000Z" },
      ]);
    });
    assert.equal(store.readHotAuditEvents({}).length, 1);
  } finally {
    store.close?.();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("one task lifecycle transition costs one store commit (P2)", () => {
  const dir = tempDir("commits");
  const store = makeStore(dir);
  const broker = makeBroker(store);
  try {
    registerWorker(broker, "w1");
    createTask(broker, "t1", "w1");
    const counter = countTransactions(store);
    broker.claimTask("t1", "w1");
    assert.equal(counter.count, 1, "claim = task row + audit append + retention prune + persist, one commit");
    const before = counter.count;
    broker.heartbeatTask("t1", "w1");
    assert.equal(counter.count - before, 1, "heartbeat must not fan out into several commits");
    // The mutation is durable, not merely batched away.
    assert.equal(broker.getTask("t1")?.status, "claimed");
    assert.equal(store.readHotTasks({ id: "t1" })[0]?.status, "claimed");
  } finally {
    store.close?.();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pushed-down payload filters return the same rows as the in-memory predicates (P3)", () => {
  const dir = tempDir("filters");
  const store = makeStore(dir);
  const broker = makeBroker(store);
  try {
    registerWorker(broker, "w1");
    registerWorker(broker, "w2");
    for (let i = 0; i < 12; i += 1) {
      createTask(broker, `t-${i}`, i % 2 === 0 ? "w1" : "w2", {
        parentRoundId: `round-${i % 3}`,
        parentRoundTotal: 4,
      });
    }
    for (let i = 0; i < 6; i += 1) broker.claimTask(`t-${i}`, i % 2 === 0 ? "w1" : "w2");

    const repository = new SqliteTaskRuntimeRepository(store);
    const all = store.readHotTasks();

    const expectClaimed = all.filter((task) => task.claimedBy === "w1").map((task) => task.id).sort();
    const actualClaimed = repository.listTasks({ claimedBy: "w1" }).map((task) => task.id).sort();
    assert.deepEqual(actualClaimed, expectClaimed);
    assert.ok(expectClaimed.length > 0, "fixture must actually exercise the filter");

    const expectRound = all.filter((task) => task.parentRoundId === "round-1").map((task) => task.id).sort();
    const actualRound = repository.listTasks({ parentRoundId: "round-1" }).map((task) => task.id).sort();
    assert.deepEqual(actualRound, expectRound);
    assert.ok(expectRound.length > 0);

    // A filter that matches nothing must return nothing rather than everything.
    assert.deepEqual(repository.listTasks({ claimedBy: "nobody" }), []);
    assert.deepEqual(repository.listTasks({ parentRoundId: "round-absent" }), []);
    assert.deepEqual(repository.listTasks({ exchangeId: "exchange-absent" }), []);
    assert.deepEqual(repository.listTasks({ proposalId: "proposal-absent" }), []);
  } finally {
    store.close?.();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("LIMIT applies to matching rows, not to the pre-filter scan (P3)", () => {
  const dir = tempDir("limit");
  const store = makeStore(dir);
  const broker = makeBroker(store);
  try {
    registerWorker(broker, "w1");
    registerWorker(broker, "w2");
    // 20 tasks claimed by w2 are newer than the 3 claimed by w1. Before the
    // pushdown the LIMIT had to be dropped for claimedBy; if it were applied
    // before the predicate instead, the w1 rows would be truncated away.
    for (let i = 0; i < 3; i += 1) {
      createTask(broker, `old-${i}`, "w1");
      broker.claimTask(`old-${i}`, "w1");
    }
    for (let i = 0; i < 20; i += 1) {
      createTask(broker, `new-${i}`, "w2");
      broker.claimTask(`new-${i}`, "w2");
    }
    const repository = new SqliteTaskRuntimeRepository(store);
    assert.equal(repository.listTasks({ claimedBy: "w1" }).length, 3);
    assert.equal(repository.listTasks({ claimedBy: "w1", limit: 2 }).length, 2);
    assert.equal(repository.listTasks({ claimedBy: "w1", limit: 50 }).length, 3);
    assert.deepEqual(repository.listTasks({ claimedBy: "w1", limit: 0 }), []);
  } finally {
    store.close?.();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("round status matches lanes whose round id is only in the payload (P3)", () => {
  const dir = tempDir("round");
  const store = makeStore(dir);
  const broker = makeBroker(store);
  try {
    registerWorker(broker, "w1");
    for (let i = 0; i < 4; i += 1) {
      createTask(broker, `lane-${i}`, "w1", {
        parentRoundId: "round-x",
        parentRoundTotal: 4,
        parentRoundOrder: i + 1,
        originBrokerId: "broker-local",
      });
    }
    createTask(broker, "other", "w1", { parentRoundId: "round-y" });
    broker.claimTask("lane-0", "w1");
    broker.startTask("lane-0", "w1");
    broker.completeTask("lane-0", "w1", { summary: "done" });

    const status = broker.getRoundStatus("round-x");
    assert.equal(status.matched, 4);
    assert.equal(status.total, 4);
    assert.equal(status.completedCount, 1);
    assert.equal(status.pendingCount, 3);
    assert.deepEqual(status.lanes.map((lane) => lane.taskId), ["lane-0", "lane-1", "lane-2", "lane-3"]);
    assert.equal(broker.getRoundStatus("round-absent").matched, 0);

    // A legacy row that carries the round id only inside the payload must still
    // match: normalizeTaskRecord hoists it, so the SQL predicate has to fall
    // back to the payload copy the same way rather than dropping the lane.
    const payloadOnly = { ...broker.getTask("lane-1")! };
    delete (payloadOnly as { parentRoundId?: string }).parentRoundId;
    payloadOnly.id = "lane-payload-only";
    store.upsertHotTasks([payloadOnly]);
    const repository = new SqliteTaskRuntimeRepository(store);
    assert.deepEqual(
      repository.listTasks({ parentRoundId: "round-x" }).map((task) => task.id).sort(),
      ["lane-0", "lane-1", "lane-2", "lane-3", "lane-payload-only"],
    );
  } finally {
    store.close?.();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readBrokerTask prefers the live map and still falls back to the store (P3)", () => {
  const dir = tempDir("readback");
  const store = makeStore(dir);
  const broker = makeBroker(store);
  try {
    registerWorker(broker, "w1");
    const created = createTask(broker, "t1", "w1");

    const repository = new SqliteTaskRuntimeRepository(store);
    let repositoryReads = 0;
    const countingRepository = {
      getTask(id: string) {
        repositoryReads += 1;
        return repository.getTask(id);
      },
      listTasks: repository.listTasks.bind(repository),
      upsertTask: repository.upsertTask.bind(repository),
    };

    const map = new Map<string, TaskRecord>([[created.id, created]]);
    assert.equal(readBrokerTask(map, countingRepository, "t1")?.id, "t1");
    assert.equal(repositoryReads, 0, "a record already in the live map must not hit the store");

    // A task the map does not hold — e.g. written by an earlier process — is
    // still served, and is cached for the next read.
    const empty = new Map<string, TaskRecord>();
    assert.equal(readBrokerTask(empty, countingRepository, "t1")?.id, "t1");
    assert.equal(repositoryReads, 1);
    assert.equal(empty.size, 1);
    assert.equal(readBrokerTask(empty, countingRepository, "t1")?.id, "t1");
    assert.equal(repositoryReads, 1, "the fallback must back-fill the map");

    assert.equal(readBrokerTask(empty, countingRepository, "missing"), null);
  } finally {
    store.close?.();
    rmSync(dir, { recursive: true, force: true });
  }
});
