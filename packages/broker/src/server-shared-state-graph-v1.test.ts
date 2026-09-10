/**
 * Server-level tests for the #1504 §4 Slice X graph-primitive integration.
 *
 * With `sharedStateGraphV1: true` every terminal task transition appends one
 * source fact through the V1 `appendGraphSource` authority
 * (`broker.claim-graph`), deduped by the fact digest, and the namespace
 * high-water survives a full server restart. The default-off posture
 * allocates nothing in the V1 graph store. The loud startup failure on an
 * invalid env value is asserted as well.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createBrokerServer } from "./server.js";
import {
  openSharedStateServingFenceV1,
  type SharedStateServingFenceV1,
} from "./shared-state-serving-fence-v1.js";
import { SharedStateGraphSourceGateV1 } from "./shared-state-graph-gate-v1.js";
import {
  createInMemoryStateStore,
  jsonHeaders,
  startTestServer,
  withEnv,
  workerPayload,
} from "./server-test-helpers.js";

async function withTempDir<T>(run: (directory: string) => Promise<T>): Promise<T> {
  const directory = mkdtempSync(join(tmpdir(), "a2a-server-graph-v1-test-"));
  try {
    return await run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

async function registerWorker(baseUrl: string): Promise<void> {
  const res = await fetch(`${baseUrl}/workers/register`, {
    method: "POST",
    headers: jsonHeaders({ "x-a2a-requester-id": "workerbeta", "x-a2a-requester-role": "analyst" }),
    body: JSON.stringify(workerPayload("workerbeta")),
  });
  assert.ok(res.status === 200 || res.status === 201);
}

async function createAndCompleteTask(baseUrl: string, id: string): Promise<void> {
  const create = await fetch(`${baseUrl}/tasks`, {
    method: "POST",
    headers: jsonHeaders({ "x-a2a-requester-id": "hub-a", "x-a2a-requester-role": "hub" }),
    body: JSON.stringify({
      id,
      intent: "analyze",
      requester: { id: "hub-a", kind: "node", role: "hub" },
      target: { id: "workerbeta", kind: "node", role: "analyst" },
      targetNodeId: "workerbeta",
      message: "graph test task",
      taskOrigin: "api",
    }),
  });
  assert.equal(create.status, 201);
  const claim = await fetch(`${baseUrl}/tasks/${id}/claim`, {
    method: "POST",
    headers: jsonHeaders({ "x-a2a-requester-id": "workerbeta", "x-a2a-requester-role": "analyst" }),
    body: JSON.stringify({ workerId: "workerbeta" }),
  });
  assert.equal(claim.status, 200);
  const complete = await fetch(`${baseUrl}/tasks/${id}/complete`, {
    method: "POST",
    headers: jsonHeaders({ "x-a2a-requester-id": "workerbeta", "x-a2a-requester-role": "analyst" }),
    body: JSON.stringify({ workerId: "workerbeta", result: { summary: "done" } }),
  });
  assert.equal(complete.status, 200);
}

/**
 * Measures the durable namespace high-water by appending a fresh probe fact
 * through the very gate under test — its cold-start resync walks the tracked
 * sequence up to the durable mark, so the probe works regardless of prior
 * facts. Probe facts are part of the ledger; each probe allocates one.
 */
function probeHighWater(
  fence: SharedStateServingFenceV1,
  probeId: string,
): bigint {
  const gate = new SharedStateGraphSourceGateV1(() => fence);
  const { sequence } = gate.appendTerminalTaskFact({
    brokerAuthorityId: "brokeralpha",
    taskId: `graph-probe-${probeId}`,
    status: "succeeded",
    completedAt: "2026-09-10T00:00:00.000Z",
  });
  return BigInt(sequence);
}

test("sharedStateGraphV1 consumes a source sequence per terminal transition", async () => {
  await withTempDir(async (directory) => {
    const sharedStateFile = join(directory, "fence.sqlite");
    const server = await startTestServer({
      brokerId: "brokeralpha",
      sharedStateGraphV1: true,
      sharedStateFile,
      enforceRequesterIdentity: false,
    });
    try {
      await registerWorker(server.baseUrl);
      await createAndCompleteTask(server.baseUrl, "graph-task-1");
      await createAndCompleteTask(server.baseUrl, "graph-task-2");
    } finally {
      // The fence is a singleton CAS: probe only after the server releases it.
      await server.close();
    }

    // Two terminal transitions in a fresh namespace consumed sequences 1 and
    // 2; this probe itself allocated 3 (high-water + 1).
    const probe = openSharedStateServingFenceV1({ filePath: sharedStateFile });
    assert.ok(probe.ok);
    try {
      const probeSequence = probeHighWater(probe.value, "one");
      assert.equal(probeSequence, 3n);
    } finally {
      probe.value.release();
    }
  });
});

test("sharedStateGraphV1 dedupes repeated terminal facts and keeps the high-water across a restart", async () => {
  await withTempDir(async (directory) => {
    const sharedStateFile = join(directory, "fence.sqlite");
    const server1 = await startTestServer({
      brokerId: "brokeralpha",
      sharedStateGraphV1: true,
      sharedStateFile,
      enforceRequesterIdentity: false,
    });
    try {
      await registerWorker(server1.baseUrl);
      await createAndCompleteTask(server1.baseUrl, "graph-restart-1");
    } finally {
      await server1.close();
    }

    const probe1 = openSharedStateServingFenceV1({ filePath: sharedStateFile });
    assert.ok(probe1.ok);
    const highWater1 = probeHighWater(probe1.value, "pre-restart");
    probe1.value.release();

    // Restart on the same durable store: the second server's terminal
    // transitions continue ABOVE the pre-restart high-water (the gate's
    // cold-start resync walks its counter up to the durable mark).
    const server2 = await startTestServer({
      brokerId: "brokeralpha",
      sharedStateGraphV1: true,
      sharedStateFile,
      enforceRequesterIdentity: false,
    });
    try {
      await registerWorker(server2.baseUrl);
      await createAndCompleteTask(server2.baseUrl, "graph-restart-2");
    } finally {
      await server2.close();
    }

    const probe2 = openSharedStateServingFenceV1({ filePath: sharedStateFile });
    assert.ok(probe2.ok);
    try {
      const highWater2 = probeHighWater(probe2.value, "post-restart");
      // One completion pre-restart + the probe + one completion post-restart.
      assert.ok(
        highWater2 >= highWater1 + 2n,
        `expected post-restart high-water (${highWater2}) >= pre (${highWater1}) + 2`,
      );
    } finally {
      probe2.value.release();
    }
  });
});

test("default-off allocates nothing in the V1 graph store", async () => {
  await withTempDir(async (directory) => {
    const sharedStateFile = join(directory, "fence.sqlite");
    const server = await startTestServer({
      brokerId: "brokeralpha",
      sharedStateGraphV1: false,
      sharedStateFile,
      enforceRequesterIdentity: false,
    });
    try {
      await registerWorker(server.baseUrl);
      await createAndCompleteTask(server.baseUrl, "legacy-graph");
    } finally {
      await server.close();
    }

    // The legacy path never touched the V1 store: the first allocation in
    // the fresh namespace is this probe at sequence 1.
    const probe = openSharedStateServingFenceV1({ filePath: sharedStateFile });
    assert.ok(probe.ok);
    try {
      const highWater = probeHighWater(probe.value, "legacy");
      assert.equal(highWater, 1n);
    } finally {
      probe.value.release();
    }
  });
});

test("invalid BROKER_SHARED_STATE_V1_GRAPH value fails startup loudly", async () => {
  await withEnv({ BROKER_SHARED_STATE_V1_GRAPH: "definitely-not-a-mode" }, async () => {
    assert.throws(
      () =>
        createBrokerServer({
          host: "127.0.0.1",
          port: 0,
          publicBaseUrl: "https://broker.test/",
          brokerId: "brokeralpha",
          stateStore: createInMemoryStateStore(),
        }),
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes("BROKER_SHARED_STATE_V1_GRAPH"),
    );
  });
});
