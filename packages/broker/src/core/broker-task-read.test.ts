// #2078 C: listing must not mutate the live mutation map. Repository rows
// overlaid into a listing result used to be written back into `this.tasks`,
// resurrecting retention-pruned terminal records into memory on every read
// (memory grew with read traffic). The live map is only ever mutated by
// write paths; the overlay is local to the listing result.
import assert from "node:assert/strict";
import test from "node:test";

import { listBrokerTasks } from "./broker-task-read.js";
import { normalizeTaskRecord } from "./broker-task-record-normalizers.js";
import { emptySnapshot } from "./store.js";
import { InMemoryA2ABroker } from "./broker.js";
import type { BrokerStateStore } from "./store.js";
import type { TaskRecord } from "./types.js";
import type { TaskRuntimeRepository } from "./task-repository.js";

test("listBrokerTasks overlays repository rows without writing back into the live map (#2078 C)", () => {
  const live: Map<string, TaskRecord> = new Map();
  const repositoryOnly = normalizeTaskRecord({
    ...emptySnapshot().tasks[0],
    id: "pruned-terminal-row",
    intent: "chat",
    status: "succeeded",
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    assignedWorkerId: "worker-a",
    message: "old completed task",
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
  });
  const repository = {
    getTask: (id: string) => (id === repositoryOnly.id ? repositoryOnly : null),
    listTasks: () => [repositoryOnly],
  } as unknown as TaskRuntimeRepository;

  const result = listBrokerTasks(live, repository);

  assert.equal(live.size, 0, "the live mutation map must stay empty after a listing");
  assert.equal(result.length, 1);
  assert.equal(result[0]?.id, "pruned-terminal-row", "repository rows still appear in results");
  assert.equal(live.get("pruned-terminal-row"), undefined, "…but are not resurrected into the map");
});

test("broker.listTasks does not change the size of the live task map (#2078 C)", () => {
  const noopStore: BrokerStateStore = {
    load: () => emptySnapshot(),
    save: () => undefined,
  };
  const broker = new InMemoryA2ABroker(noopStore, noopStore.load());
  broker.registerWorker({
    nodeId: "worker-a",
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
  broker.createTask({
    id: "live-1",
    intent: "chat",
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    assignedWorkerId: "worker-a",
    message: "x",
  });

  const snapshots: number[] = [];
  const before = broker.listTasks().length;
  for (let i = 0; i < 50; i += 1) {
    broker.listTasks();
    snapshots.push(broker.listTasks().length);
  }
  assert.deepEqual(snapshots, snapshots.map(() => before), "repeated listings must not grow the live set");
});
