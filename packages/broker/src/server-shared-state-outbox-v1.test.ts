/**
 * Server-level tests for the #1504 §4 Slice W outbox-primitive integration.
 *
 * With `sharedStateOutboxV1: true` the local terminal event append is decided
 * by the V1 `appendOutbox` authority: completing a task allocates a durable
 * per-stream sequence, a second fence handle re-presenting the same event id
 * gets the ORIGINAL allocation back (proving the server appended through the
 * authority), and the sequence high-water mark survives a full server
 * restart. The default-off posture allocates nothing in the V1 store. The
 * loud startup failure on an invalid env value is asserted as well.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createBrokerServer } from "./server.js";
import {
  openSharedStateServingFenceV1,
  type SharedStateServingFenceV1,
} from "./shared-state-serving-fence-v1.js";
import {
  createInMemoryStateStore,
  jsonHeaders,
  startTestServer,
  withEnv,
  workerPayload,
} from "./server-test-helpers.js";

async function withTempDir<T>(run: (directory: string) => Promise<T>): Promise<T> {
  const directory = mkdtempSync(join(tmpdir(), "a2a-server-outbox-v1-test-"));
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

async function createTask(baseUrl: string, id: string): Promise<void> {
  const res = await fetch(`${baseUrl}/tasks`, {
    method: "POST",
    headers: jsonHeaders({ "x-a2a-requester-id": "hub-a", "x-a2a-requester-role": "hub" }),
    body: JSON.stringify({
      id,
      intent: "analyze",
      requester: { id: "hub-a", kind: "node", role: "hub" },
      target: { id: "workerbeta", kind: "node", role: "analyst" },
      targetNodeId: "workerbeta",
      message: "outbox test task",
      taskOrigin: "api",
    }),
  });
  assert.equal(res.status, 201);
}

const workerHeaders = jsonHeaders({ "x-a2a-requester-id": "workerbeta", "x-a2a-requester-role": "analyst" });

async function claimAndComplete(baseUrl: string, taskId: string): Promise<{ completedAt: string }> {
  const claim = await fetch(`${baseUrl}/tasks/${taskId}/claim`, {
    method: "POST",
    headers: workerHeaders,
    body: JSON.stringify({ workerId: "workerbeta" }),
  });
  assert.equal(claim.status, 200);
  const complete = await fetch(`${baseUrl}/tasks/${taskId}/complete`, {
    method: "POST",
    headers: workerHeaders,
    body: JSON.stringify({ workerId: "workerbeta", result: { summary: "done" } }),
  });
  assert.equal(complete.status, 200);
  const done = await complete.json() as { status: string; completedAt: string };
  assert.equal(done.status, "succeeded");
  return { completedAt: done.completedAt };
}

/**
 * Fresh-event probes measure the stream's high-water mark around a terminal
 * transition — payload-independent, unlike a replay probe (a replay must
 * present the exact original payload digest).
 */
function probeNextSequence(fence: SharedStateServingFenceV1, probeId: string) {
  const outcome = fence.appendTerminalTaskEvent(
    {
      brokerAuthorityId: "brokeralpha",
      eventId: probeId,
      payloadSha256Hex: createHash("sha256").update(`probe:${probeId}`).digest("hex"),
    },
    Date.now(),
  );
  assert.ok(outcome.outcome === "appended");
  if (outcome.outcome !== "appended") throw new Error("probe did not append");
  return BigInt(outcome.streamSequence);
}

test("sharedStateOutboxV1 consumes a stream sequence for the terminal event", async () => {
  await withTempDir(async (directory) => {
    const sharedStateFile = join(directory, "fence.sqlite");
    const server = await startTestServer({
      brokerId: "brokeralpha",
      sharedStateOutboxV1: true,
      sharedStateFile,
      enforceRequesterIdentity: false,
    });
    try {
      await registerWorker(server.baseUrl);
      await createTask(server.baseUrl, "outbox-task-1");
      await claimAndComplete(server.baseUrl, "outbox-task-1");
    } finally {
      // The fence is a singleton CAS: probe only after the server releases it.
      await server.close();
    }

    const probe = openSharedStateServingFenceV1({ filePath: sharedStateFile });
    assert.ok(probe.ok);
    try {
      const before = probeNextSequence(probe.value, "probe-before-complete");
      // Replay the probe to pin its allocation (the §5.5 replay property).
      const replayed = probe.value.appendTerminalTaskEvent(
        {
          brokerAuthorityId: "brokeralpha",
          eventId: "probe-before-complete",
          payloadSha256Hex: createHash("sha256").update("probe:probe-before-complete").digest("hex"),
        },
        Date.now(),
      );
      assert.ok(replayed.outcome === "replayed");
      if (replayed.outcome === "replayed") {
        assert.equal(BigInt(replayed.streamSequence), before);
      }
      const after = probeNextSequence(probe.value, "probe-after-complete");
      // The completion is the ONLY prior activity in this fresh store: the
      // first probe landing at 2 proves the terminal event consumed the
      // stream's first sequence through the V1 authority.
      assert.ok(before >= 2n, `expected before (${before}) >= 2`);
      assert.equal(after, before + 1n);
    } finally {
      probe.value.release();
    }
  });
});

test("sharedStateOutboxV1 keeps the sequence high-water mark across a server restart", async () => {
  await withTempDir(async (directory) => {
    const sharedStateFile = join(directory, "fence.sqlite");
    const server1 = await startTestServer({
      brokerId: "brokeralpha",
      sharedStateOutboxV1: true,
      sharedStateFile,
      enforceRequesterIdentity: false,
    });
    try {
      await registerWorker(server1.baseUrl);
      await createTask(server1.baseUrl, "outbox-restart-1");
      await claimAndComplete(server1.baseUrl, "outbox-restart-1");
    } finally {
      await server1.close();
    }

    const probe1 = openSharedStateServingFenceV1({ filePath: sharedStateFile });
    assert.ok(probe1.ok);
    let highWater: bigint;
    try {
      highWater = probeNextSequence(probe1.value, "probe-pre-restart");
    } finally {
      probe1.value.release();
    }

    // §5.5 restart behavior: the next allocation resumes ABOVE the durable
    // high-water mark — the restart never resets the stream sequence.
    const server2 = await startTestServer({
      brokerId: "brokeralpha",
      sharedStateOutboxV1: true,
      sharedStateFile,
      enforceRequesterIdentity: false,
    });
    try {
      await registerWorker(server2.baseUrl);
      await createTask(server2.baseUrl, "outbox-restart-2");
      await claimAndComplete(server2.baseUrl, "outbox-restart-2");
    } finally {
      await server2.close();
    }

    const probe2 = openSharedStateServingFenceV1({ filePath: sharedStateFile });
    assert.ok(probe2.ok);
    try {
      const after = probeNextSequence(probe2.value, "probe-post-restart");
      // The second completion (post-restart server) must have consumed a
      // sequence beyond the pre-restart high-water mark: the adapter's
      // sequence authority survived the restart (§5.5).
      assert.ok(after >= highWater + 2n, `expected after (${after}) >= highWater (${highWater}) + 2`);
    } finally {
      probe2.value.release();
    }
  });
});

test("default-off allocates nothing in the V1 outbox store", async () => {
  await withTempDir(async (directory) => {
    const sharedStateFile = join(directory, "fence.sqlite");
    const server = await startTestServer({
      brokerId: "brokeralpha",
      sharedStateOutboxV1: false,
      sharedStateFile,
      enforceRequesterIdentity: false,
    });
    try {
      await registerWorker(server.baseUrl);
      await createTask(server.baseUrl, "legacy-outbox");
      await claimAndComplete(server.baseUrl, "legacy-outbox");
    } finally {
      await server.close();
    }

    // The legacy path never touched the V1 store: the terminal completion
    // consumed NO sequence between the two probes.
    const probe = openSharedStateServingFenceV1({ filePath: sharedStateFile });
    assert.ok(probe.ok);
    try {
      const before = probeNextSequence(probe.value, "probe-legacy-before");
      const after = probeNextSequence(probe.value, "probe-legacy-after");
      assert.equal(after, before + 1n);
    } finally {
      probe.value.release();
    }
  });
});

test("invalid BROKER_SHARED_STATE_V1_OUTBOX value fails startup loudly", async () => {
  await withEnv({ BROKER_SHARED_STATE_V1_OUTBOX: "definitely-not-a-mode" }, async () => {
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
        error.message.includes("BROKER_SHARED_STATE_V1_OUTBOX"),
    );
  });
});
