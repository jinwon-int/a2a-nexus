// #2077 step 1: every task mutation entry point must run inside
// commitMutation, so one mutation = one SQLite transaction = one WAL fsync.
// The store exposes a top-level commit counter (`commits`); these tests
// pin the delta per public mutation at exactly 1 (nested runBatch calls
// join the open transaction instead of committing again).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { InMemoryA2ABroker } from "./broker.js";
import {
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
} from "./store.js";
import { createWorkerTask, registerWorker } from "./broker-test-helpers.js";

interface Wired {
  broker: InMemoryA2ABroker;
  store: SqliteBrokerStateStore;
  cleanup: () => void;
}

/** Wire a broker the way server.ts does: store + full SQLite repository set. */
function wireBroker(): Wired {
  const dir = mkdtempSync(join(tmpdir(), "a2a-commit-batching-"));
  const store = new SqliteBrokerStateStore(join(dir, "state.sqlite"));
  const broker = new InMemoryA2ABroker(store, store.load(), {
    taskRepository: new SqliteTaskRuntimeRepository(store),
    auditRepository: new SqliteAuditRuntimeRepository(store),
    tombstoneRepository: new SqliteTombstoneRuntimeRepository(store),
    workerRepository: new SqliteWorkerRuntimeRepository(store),
    exchangeRepository: new SqliteExchangeRuntimeRepository(store),
    exchangeMessageRepository: new SqliteExchangeMessageRuntimeRepository(store),
    proposalRepository: new SqliteProposalRuntimeRepository(store),
    artifactRepository: new SqliteArtifactRuntimeRepository(store),
    validationRepository: new SqliteValidationRuntimeRepository(store),
  });
  return {
    broker,
    store,
    cleanup: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("completeTask ends in exactly one store commit", () => {
  const { broker, store, cleanup } = wireBroker();
  try {
    registerWorker(broker, "worker-a");
    const task = createWorkerTask(broker, "commit-complete", "worker-a");
    broker.claimTask(task.id, "worker-a");
    broker.startTask(task.id, "worker-a");

    const before = store.commits;
    broker.completeTask(task.id, "worker-a", { summary: "done" });
    assert.equal(
      store.commits - before,
      1,
      "completeTask must be one transaction (record + exchange sync + audit + persist), not 4-7",
    );
  } finally {
    cleanup();
  }
});

test("failTask ends in exactly one store commit", () => {
  const { broker, store, cleanup } = wireBroker();
  try {
    registerWorker(broker, "worker-a");
    const task = createWorkerTask(broker, "commit-fail", "worker-a");
    broker.claimTask(task.id, "worker-a");

    const before = store.commits;
    broker.failTask(task.id, "worker-a", { code: "boom", message: "m" });
    assert.equal(store.commits - before, 1, "failTask (with tombstone) must be one transaction");
  } finally {
    cleanup();
  }
});

test("cancelTask ends in exactly one store commit", () => {
  const { broker, store, cleanup } = wireBroker();
  try {
    registerWorker(broker, "worker-a");
    const task = createWorkerTask(broker, "commit-cancel", "worker-a");

    const before = store.commits;
    broker.cancelTask(task.id, {
      actor: { id: "hub-a", kind: "node", role: "hub" },
      reason: "no longer needed",
    });
    assert.equal(store.commits - before, 1, "cancelTask (with tombstone) must be one transaction");
  } finally {
    cleanup();
  }
});

test("updateTaskPayload and reassignTask each end in exactly one store commit", () => {
  const { broker, store, cleanup } = wireBroker();
  try {
    registerWorker(broker, "worker-a");
    registerWorker(broker, "worker-b");
    const task = createWorkerTask(broker, "commit-update", "worker-a");

    let before = store.commits;
    broker.updateTaskPayload(task.id, { intent: "chat", note2: "bigger" }, {
      actor: { id: "hub-a", kind: "node", role: "hub" },
    });
    assert.equal(store.commits - before, 1, "updateTaskPayload must be one transaction");

    before = store.commits;
    broker.reassignTask(task.id, {
      actor: { id: "hub-a", kind: "node", role: "hub" },
      targetNodeId: "worker-b",
      assignedWorkerId: "worker-b",
    });
    assert.equal(store.commits - before, 1, "reassignTask must be one transaction");
  } finally {
    cleanup();
  }
});

test("wake plan and decision each end in exactly one store commit", () => {
  const { broker, store, cleanup } = wireBroker();
  try {
    registerWorker(broker, "worker-a");
    const task = createWorkerTask(broker, "commit-wake", "worker-a");

    let before = store.commits;
    broker.planAcceptedTaskWake(task.id, {
      targetSessionKey: "session-1",
      message: "go",
    });
    assert.equal(store.commits - before, 1, "wake plan must be one transaction");

    before = store.commits;
    broker.recordTaskWakeDecision(task.id, { status: "scheduled" });
    assert.equal(store.commits - before, 1, "wake decision must be one transaction");
  } finally {
    cleanup();
  }
});

test("nested mutations join the outer transaction: completeTask with proposal side-effects is one commit", () => {
  const { broker, store, cleanup } = wireBroker();
  try {
    registerWorker(broker, "worker-a");
    const proposal = broker.createProposal({
      source: { id: "hub-a", kind: "node", role: "hub" },
      target: { id: "worker-a", kind: "node", role: "analyst" },
      kind: "params",
      summary: "s",
      workspace: { nodeId: "worker-a", workspaceId: "test" },
      parameterPayload: { key: "value" },
    });
    const task = broker.createTask({
      id: "commit-nested-proposal",
      intent: "validate_change",
      requester: { id: "hub-a", kind: "node", role: "hub" },
      target: { id: "worker-a", kind: "node", role: "analyst" },
      assignedWorkerId: "worker-a",
      message: "validate",
      proposalId: proposal.id,
    });
    broker.claimTask(task.id, "worker-a");

    const before = store.commits;
    // completeTask -> applyTaskCompletion -> submitValidationResult (a nested
    // commitMutation). The nested call must join the outer batch.
    broker.completeTask(task.id, "worker-a", {
      summary: "v",
      validation: { nodeId: "worker-a", kind: "smoke", verdict: "pass" },
    });
    assert.equal(
      store.commits - before,
      1,
      "nested proposal writes must join the completeTask transaction",
    );
  } finally {
    cleanup();
  }
});

test("the stale reaper sweep is one commit for the whole loop", () => {
  const { broker, store, cleanup } = wireBroker();
  try {
    registerWorker(broker, "worker-a");
    const tasks = [];
    for (let i = 0; i < 3; i += 1) {
      const task = createWorkerTask(broker, `commit-reaper-${i}`, "worker-a");
      broker.claimTask(task.id, "worker-a");
      tasks.push(task);
    }

    const before = store.commits;
    // Requeue all three claimed tasks as stale (claimed long ago, worker stale).
    const requeued = broker.requeueStaleTasks(0, {
      nowMs: Date.now() + 10 * 60 * 1000,
      workerOfflineAfterMs: 60 * 1000,
    });
    assert.equal(requeued.length, 3);
    assert.equal(
      store.commits - before,
      1,
      "an N-task sweep must be one transaction, not N+1",
    );
  } finally {
    cleanup();
  }
});
