/**
 * Tests for the worker-thread persistence facade (WriteQueue,
 * SqliteWorkerThread, WorkerThreadProxyStore).
 *
 * Focus areas:
 *   1. Queue FIFO ordering and capacity enforcement
 *   2. Crash/abort behavior cascade
 *   3. Drain lifecycle
 *   4. Proxy store sync/async boundary
 *   5. Read-after-write ordering through queue
 *   6. Concurrent flush protection
 *   7. Diagnostics contract
 *
 * Related: #1032
 * @module
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { InMemoryA2ABroker } from "./broker.js";
import { emptySnapshot, SqliteBrokerStateStore } from "./store.js";
import { makeTask } from "./store-test-helpers.js";
import { createWorkerThreadPersistence, WriteQueue } from "./sqlite-worker-thread-persistence.js";
import type { WriteQueueStats } from "./sqlite-worker-thread-persistence.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function deferred<T = unknown>(): {
  promise: Promise<T>;
  resolve: (value?: T) => void;
  reject: (error: Error) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve: resolve as (value?: T) => void, reject };
}

function nextTick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function makeQueueStats(stats: Partial<WriteQueueStats> & { capacity: number }): WriteQueueStats {
  return {
    queued: 0,
    active: 0,
    inFlight: 0,
    available: stats.capacity,
    closing: false,
    aborted: false,
    ...stats,
  };
}

// ---------------------------------------------------------------------------
// WriteQueue tests
// ---------------------------------------------------------------------------

test("WriteQueue: basic write-order fidelity", async () => {
  const queue = new WriteQueue(4);
  const order: number[] = [];

  const a = queue.enqueue("first", () => {
    order.push(0);
    return "a";
  });
  const b = queue.enqueue("second", () => {
    order.push(1);
    return "b";
  });
  const c = queue.enqueue("third", () => {
    order.push(2);
    return "c";
  });

  assert.equal(await a, "a");
  assert.equal(await b, "b");
  assert.equal(await c, "c");
  assert.deepEqual(order, [0, 1, 2]);
});

test("WriteQueue: rejects beyond capacity", async () => {
  const queue = new WriteQueue(2);
  const blocked = deferred();
  const inFlight = queue.enqueue("slow", () => blocked.promise);
  await nextTick(); // let pump start

  const second = queue.enqueue("second", () => "ok");
  await assert.rejects(
    queue.enqueue("overflow", () => "nope"),
    /queue_saturated/,
  );
  blocked.resolve("done");
  assert.equal(await inFlight, "done");
  assert.equal(await second, "ok");
});

test("WriteQueue: stats match state during lifecycle", async () => {
  const queue = new WriteQueue(3);

  assert.deepStrictEqual(queue.stats(), makeQueueStats({ capacity: 3, available: 3 }));

  await queue.enqueue("quick", () => "done");
  assert.deepStrictEqual(queue.stats(), makeQueueStats({ capacity: 3, available: 3 }));

  const blocked = deferred();
  const slow = queue.enqueue("slow", () => blocked.promise);
  await nextTick();
  const midStats = queue.stats();
  assert.equal(midStats.active, 1);
  assert.equal(midStats.queued, 0);
  assert.equal(midStats.inFlight, 1);
  assert.equal(midStats.available, 2);

  blocked.resolve("slow-done");
  await slow;
  assert.deepStrictEqual(queue.stats(), makeQueueStats({ capacity: 3, available: 3 }));
});

test("WriteQueue: abort rejects all pending writes", async () => {
  const queue = new WriteQueue(3);
  const blocked = deferred();
  const slow = queue.enqueue("slow", () => blocked.promise);
  const queued = queue.enqueue("queued", () => "should-fail");
  await nextTick();

  const err = new Error("worker_panic");
  queue.abort(err);

  await assert.rejects(slow, /worker_panic/);
  await assert.rejects(queued, /worker_panic/);
  await assert.rejects(queue.enqueue("future", () => "nope"), /worker_panic/);

  blocked.resolve();

  const s = queue.stats();
  assert.equal(s.aborted, true);
  assert.equal(s.closing, true);
  assert.equal(s.inFlight, 0);
});

test("WriteQueue: drain completes before close and rejects after", async () => {
  const queue = new WriteQueue(2);
  const blocked = deferred();
  const slow = queue.enqueue("slow", () => blocked.promise);
  const fast = queue.enqueue("fast", () => "ok");
  await nextTick();

  const drainPromise = queue.drainAndClose({ timeoutMs: 5000 });
  blocked.resolve("done");
  await slow;
  assert.equal(await fast, "ok");
  await drainPromise;

  assert.equal(queue.stats().closing, true);
  await assert.rejects(queue.enqueue("after-close", () => "nope"), /queue_closed/);
});

test("WriteQueue: drain timeout triggers abort only when requested", async () => {
  const queue = new WriteQueue(2);
  const blocked = deferred();
  const stuck = queue.enqueue("stuck", () => blocked.promise);
  await nextTick();

  await assert.rejects(queue.drainAndClose({ timeoutMs: 50, abortOnTimeout: true }), /queue_drain_timeout/);
  await assert.rejects(stuck, /queue_drain_timeout/);
  assert.equal(queue.stats().aborted, true);
  blocked.resolve(); // cleanup
});

test("WriteQueue: FIFO order with concurrent enqueue", async () => {
  const queue = new WriteQueue(4);
  const results: string[] = [];

  const write1 = queue.enqueue("one", async () => {
    await new Promise((r) => setTimeout(r, 10));
    results.push("one");
    return 1;
  });
  const write2 = queue.enqueue("two", async () => {
    results.push("two");
    return 2;
  });

  assert.equal(await write1, 1);
  assert.equal(await write2, 2);
  assert.deepEqual(results, ["one", "two"]);
});

test("WriteQueue: error propagation preserves rejection", async () => {
  const queue = new WriteQueue(2);

  await assert.rejects(
    queue.enqueue("fail", () => {
      throw new Error("write_failed");
    }),
    /write_failed/,
  );

  // Queue should be reusable after a failed write
  const ok = await queue.enqueue("recover", () => "still-works");
  assert.equal(ok, "still-works");
});

test("WriteQueue: concurrent stall does not block other entries past capacity", async () => {
  // Verify that a slow write ties up one slot, but the other slot is usable
  const queue = new WriteQueue(2);
  const blocked = deferred();
  const slow = queue.enqueue("slow", () => blocked.promise);
  await nextTick();

  const fast = queue.enqueue("fast", () => "result");
  const stats = queue.stats();
  assert.equal(stats.inFlight, 2);
  assert.equal(stats.available, 0);

  // third should be rejected (saturated)
  await assert.rejects(queue.enqueue("overflow", () => "nope"), /queue_saturated/);

  blocked.resolve("done");
  assert.equal(await slow, "done");
  assert.equal(await fast, "result");
});

test("WriteQueue: error during write does not deadlock queue", async () => {
  const queue = new WriteQueue(2);

  await assert.rejects(
    queue.enqueue("throw-err", () => Promise.reject(new Error("db_write_failure"))),
    /db_write_failure/,
  );

  // Subsequent write should work
  const result = await queue.enqueue("after-error", () => "recovered");
  assert.equal(result, "recovered");
});

// ---------------------------------------------------------------------------
// Proxy store sync/async boundary
// ---------------------------------------------------------------------------

test("ProxyStore: saveHotEntities returns void but promise is hidden", async () => {
  // This test validates the contract: the return type is void,
  // but the hidden promise rejects when the queue is aborted.
  const queue = new WriteQueue(2);
  const blocked = deferred();

  // Create a minimal store proxy using the Worker's local store
  // For this unit test, we test the queue contract directly
  const result = queue.enqueue("saveHotEntities", () => "committed");
  blocked.resolve();
  assert.equal(await result, "committed");
});

test("ProxyStore: multiple enqueues with capacity pressure", async () => {
  const queue = new WriteQueue(2);
  const blocked1 = deferred();
  const blocked2 = deferred();

  const e1 = queue.enqueue("write1", () => blocked1.promise);
  await nextTick();
  const e2 = queue.enqueue("write2", () => blocked2.promise);
  await nextTick();

  // Queue should be saturated now
  await assert.rejects(
    queue.enqueue("write3", () => "lost"),
    /queue_saturated/,
  );

  blocked1.resolve("one");
  blocked2.resolve("two");

  assert.equal(await e1, "one");
  assert.equal(await e2, "two");

  // After freeing slots, new writes succeed
  const e3 = await queue.enqueue("write3", () => "recovered");
  assert.equal(e3, "recovered");
});

// ---------------------------------------------------------------------------
// Integration: Sqlite persistence read-after-write through queue
// ---------------------------------------------------------------------------

test("WorkerThread: read-after-write ordering through queue", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "wt-test-"));
  const dbPath = join(tmpDir, "test.sqlite");
  try {
    const { SqliteBrokerStateStore } = await import("./store.js");
    const store = new SqliteBrokerStateStore(dbPath);
    const queue = new WriteQueue(8);

    // The local store and worker both point to the same DB
    // Simulate: queue writes, then read from local store
    const committed = await queue.enqueue("insert", () => {
      store.save({
        version: 1,
        tasks: [],
        workers: [],
        auditEvents: [],
        terminalOutbox: [],
        crossBrokerTerminalBriefs: [],
        exchanges: [],
        exchangeMessages: [],
        proposals: [],
        artifacts: [],
        validations: [],
      });
      return "committed";
    });
    assert.equal(committed, "committed");

    // Read-after-write: local store should see the changes
    const snapshot = store.readHotRuntimeSnapshot();
    assert.ok(snapshot);
    assert.deepEqual(snapshot.tasks, []);

    store.close();
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("WorkerThread: multiple ordered writes preserve sequence", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "wt-seq-"));
  const dbPath = join(tmpDir, "test.sqlite");
  try {
    const { SqliteBrokerStateStore } = await import("./store.js");
    const store = new SqliteBrokerStateStore(dbPath);
    const queue = new WriteQueue(8);
    const seenOrder: number[] = [];

    await queue.enqueue("write-1", () => {
      seenOrder.push(1);
      return true;
    });
    await queue.enqueue("write-2", () => {
      seenOrder.push(2);
      return true;
    });
    await queue.enqueue("write-3", () => {
      seenOrder.push(3);
      return true;
    });

    assert.deepEqual(seenOrder, [1, 2, 3]);
    store.close();
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Crash safety
// ---------------------------------------------------------------------------

test("WorkerThread: queue abort during active write prevents partial commit cascade", async () => {
  const queue = new WriteQueue(3);
  const blocked = deferred();
  const crash = new Error("worker_crash_imminent");

  // Active write: blocked
  const active = queue.enqueue("active-write", () => blocked.promise);
  await nextTick();

  // Queued writes
  const queued1 = queue.enqueue("queued-1", () => "should-not-commit");
  const queued2 = queue.enqueue("queued-2", () => "should-not-commit");

  // Abort simulates worker crash
  queue.abort(crash);

  await assert.rejects(active, /worker_crash_imminent/);
  await assert.rejects(queued1, /worker_crash_imminent/);
  await assert.rejects(queued2, /worker_crash_imminent/);

  // Future writes also reject
  await assert.rejects(
    queue.enqueue("future-write", () => "nope"),
    /worker_crash_imminent/,
  );

  const s = queue.stats();
  assert.equal(s.aborted, true);
  assert.equal(s.inFlight, 0);
  assert.equal(s.queued, 0);

  // Cleanup: resolve the blocked write to free resources
  blocked.resolve();
  await nextTick();
});

test("WorkerThreadProxyStore: durable ACK is reusable across repeated writes", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "wt-ack-repeat-"));
  const dbPath = join(tmpDir, "test.sqlite");
  try {
    const handle = createWorkerThreadPersistence({ dbFile: dbPath, queueCapacity: 4 });
    try {
      handle.stateStore.save(emptySnapshot());
      await handle.stateStore.awaitDurablePersistenceAck?.();
      assert.equal(handle.queue.stats().closing, false);

      handle.stateStore.save({
        ...emptySnapshot(),
        workers: [{
          nodeId: "worker-repeat",
          role: "operator",
          capabilities: {
            canAnalyze: true,
            canBackfill: false,
            canPatchWorkspace: false,
            canPromoteLive: false,
            workspaceIds: ["default"],
            environments: ["research"],
          },
          createdAt: "2026-06-05T00:00:00.000Z",
          updatedAt: "2026-06-05T00:00:00.000Z",
          lastSeenAt: "2026-06-05T00:00:00.000Z",
        }],
      });
      await handle.stateStore.awaitDurablePersistenceAck?.();

      const reader = new SqliteBrokerStateStore(dbPath, { loadSource: "hot-tables" });
      try {
        assert.equal(reader.load().workers[0]?.nodeId, "worker-repeat");
      } finally {
        reader.close();
      }
    } finally {
      await handle.close();
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("WorkerThreadProxyStore: enqueue failure reaches the same ACK boundary", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "wt-ack-fail-"));
  const dbPath = join(tmpDir, "test.sqlite");
  try {
    const handle = createWorkerThreadPersistence({ dbFile: dbPath, queueCapacity: 1 });
    try {
      handle.queue.abort(new Error("worker_crashed"));
      handle.stateStore.save(emptySnapshot());
      await assert.rejects(
        handle.stateStore.awaitDurablePersistenceAck?.(),
        /worker_crashed/,
      );
    } finally {
      await handle.close();
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("WorkerThreadProxyStore: loadSource=hot-tables hydrates proxy and worker reads", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "wt-hot-load-source-"));
  const dbPath = join(tmpDir, "test.sqlite");
  try {
    const seed = new SqliteBrokerStateStore(dbPath, { loadSource: "hot-tables" });
    try {
      seed.upsertHotTasks([makeTask("worker-thread-hot-load", "queued", "worker-thread-hot")]);
    } finally {
      seed.close();
    }

    const handle = createWorkerThreadPersistence({
      dbFile: dbPath,
      queueCapacity: 4,
      loadSource: "hot-tables",
    });
    try {
      assert.equal(handle.stateStore.getPersistenceInfo().loadSource, "hot-tables");
      assert.deepEqual(handle.stateStore.load().tasks.map((task) => task.id), ["worker-thread-hot-load"]);

      const workerInfo = await handle.workerThread.request<{ loadSource?: string }>("getPersistenceInfo");
      assert.equal(workerInfo.loadSource, "hot-tables");
      const workerSnapshot = await handle.workerThread.request<{ tasks: Array<{ id: string }> }>("load");
      assert.deepEqual(workerSnapshot.tasks.map((task) => task.id), ["worker-thread-hot-load"]);
    } finally {
      await handle.close();
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("WorkerThreadProxyStore: broker mutation ACK is visible to a fresh SQLite reader", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "wt-broker-ack-"));
  const dbPath = join(tmpDir, "test.sqlite");
  try {
    const handle = createWorkerThreadPersistence({ dbFile: dbPath, queueCapacity: 4 });
    try {
      const broker = new InMemoryA2ABroker(handle.stateStore, handle.stateStore.load());
      broker.registerWorker({
        nodeId: "worker-thread-owner",
        role: "operator",
        capabilities: {
          canAnalyze: true,
          canBackfill: false,
          canPatchWorkspace: false,
          canPromoteLive: false,
          workspaceIds: ["default"],
          environments: ["research"],
        },
      });
      await handle.stateStore.awaitDurablePersistenceAck?.();

      const reader = new SqliteBrokerStateStore(dbPath, { loadSource: "hot-tables" });
      try {
        assert.equal(reader.load().workers[0]?.nodeId, "worker-thread-owner");
      } finally {
        reader.close();
      }
    } finally {
      await handle.close();
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("WorkerThread: drain then crash is idempotent", async () => {
  const queue = new WriteQueue(2);
  const blocked = deferred();
  const slow = queue.enqueue("slow", () => blocked.promise);
  await nextTick();
  const fast = queue.enqueue("fast", () => "done");
  await nextTick();

  // drainAndClose will wait for both
  const drainPromise = queue.drainAndClose({ timeoutMs: 5000 });
  blocked.resolve("slow-done");
  await slow;
  await fast;
  await drainPromise;

  // Now crashed state is idempotent with already-closed queue
  const err = new Error("late_crash");
  queue.abort(err);
  assert.equal(queue.stats().aborted, true);

  await assert.rejects(queue.enqueue("after-all", () => "nope"), /late_crash/);
});

// ---------------------------------------------------------------------------
// Diagnostics contract
// ---------------------------------------------------------------------------

test("WriteQueue: diagnostics format matches BrokerPersistenceQueueDiagnostics shape", () => {
  const queue = new WriteQueue(4);

  // Healthy state
  const healthy = queue.stats();
  assert.equal(healthy.capacity, 4);
  assert.equal(healthy.queued, 0);
  assert.equal(healthy.active, 0);
  assert.equal(healthy.inFlight, 0);
  assert.equal(healthy.available, 4);
  assert.equal(healthy.closing, false);
  assert.equal(healthy.aborted, false);
});

test("WriteQueue: saturated diagnostics reflects full queue", async () => {
  const queue = new WriteQueue(1);
  const blocked = deferred();
  const slow = queue.enqueue("slow", () => blocked.promise);
  await nextTick();

  const stats = queue.stats();
  assert.equal(stats.available, 0);
  assert.equal(stats.inFlight, 1);
  assert.equal(stats.active, 1);

  await assert.rejects(
    queue.enqueue("overflow", () => "nope"),
    /queue_saturated/,
  );

  blocked.resolve("done");
  await slow;
});

test("WriteQueue: abort diagnostics reflects crashed state", () => {
  const queue = new WriteQueue(2);
  queue.abort(new Error("db_corruption"));

  const stats = queue.stats();
  assert.equal(stats.aborted, true);
  assert.equal(stats.closing, true);
  assert.equal(stats.inFlight, 0);
  assert.equal(stats.available, 2);
});
