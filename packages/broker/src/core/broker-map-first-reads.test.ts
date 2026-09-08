// #2078 B: map-first reads. claim/start/complete run assertTaskWorker →
// getWorker on every request; with a repository configured the old
// repository-first read issued a SQL SELECT + JSON.parse + zod parse per
// lookup. The in-memory map is updated by every write path and the serving
// fence guarantees a single writer, so these tests pin that steady-state
// task lifecycle requests never touch the repository.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { InMemoryA2ABroker } from "./broker.js";
import { emptySnapshot, SqliteBrokerStateStore, SqliteWorkerRuntimeRepository } from "./store.js";
import { createWorkerTask, registerWorker } from "./broker-test-helpers.js";

class CountingWorkerRepository {
  getWorkerCalls = 0;
  constructor(private readonly inner: SqliteWorkerRuntimeRepository) {}
  getWorker(nodeId: string) {
    this.getWorkerCalls += 1;
    return this.inner.getWorker(nodeId);
  }
  upsertWorker(worker: Parameters<SqliteWorkerRuntimeRepository["upsertWorker"]>[0]) {
    return this.inner.upsertWorker(worker);
  }
  listWorkers(filters?: Parameters<SqliteWorkerRuntimeRepository["listWorkers"]>[0]) {
    return this.inner.listWorkers(filters);
  }
}

test("claim/start/complete never hit the worker repository in steady state (#2078 B)", () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-map-first-"));
  const store = new SqliteBrokerStateStore(join(dir, "state.sqlite"));
  try {
    const repository = new CountingWorkerRepository(new SqliteWorkerRuntimeRepository(store));
    const noopStore = {
      load: () => emptySnapshot(),
      save: () => undefined,
    };
    const broker = new InMemoryA2ABroker(noopStore, noopStore.load(), {
      workerRepository: repository as unknown as SqliteWorkerRuntimeRepository,
    });

    registerWorker(broker, "worker-a");
    // Registration itself may consult the repository (read-modify-write on a
    // fresh map); everything after this point must be map hits.
    const baseline = repository.getWorkerCalls;

    const task = createWorkerTask(broker, "map-first-lifecycle", "worker-a");
    broker.claimTask(task.id, "worker-a");
    broker.startTask(task.id, "worker-a");
    broker.completeTask(task.id, "worker-a", { summary: "done" });

    assert.equal(
      repository.getWorkerCalls - baseline,
      0,
      "claim/start/complete must read the worker from the in-memory map (0 SELECTs)",
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
