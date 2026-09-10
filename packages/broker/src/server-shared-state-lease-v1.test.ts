/**
 * Server-level tests for the #1504 §4 Slice U lease-primitive integration.
 *
 * With `sharedStateLeaseV1: true` the worker task-claim lifecycle is fenced
 * through the V1 lease authority: claims grant through `claimLease`, a stale
 * operator requeue releases through `releaseLease`, re-claims present the
 * advanced resource version, and a claimed task survives a full server
 * restart with its authority intact (durable record stamp + durable fence).
 * The default-off posture and the loud startup failure on an invalid env
 * value are asserted as well.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";

import { createBrokerServer } from "./server.js";
import {
  createInMemoryStateStore,
  jsonHeaders,
  startTestServer,
  withEnv,
  workerPayload,
} from "./server-test-helpers.js";

async function withTempDir<T>(run: (directory: string) => Promise<T>): Promise<T> {
  const directory = mkdtempSync(join(tmpdir(), "a2a-server-lease-v1-test-"));
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
      message: "lease test task",
      taskOrigin: "api",
    }),
  });
  assert.equal(res.status, 201);
}

function claimBody(workerId = "workerbeta"): string {
  return JSON.stringify({ workerId });
}

const workerHeaders = jsonHeaders({ "x-a2a-requester-id": "workerbeta", "x-a2a-requester-role": "analyst" });

test("sharedStateLeaseV1 fences claim, requeue, and re-claim through the V1 authority", async () => {
  const server = await startTestServer({
    brokerId: "brokeralpha",
    sharedStateLeaseV1: true,
    staleReaperOlderThanSec: 60,
  });
  try {
    await registerWorker(server.baseUrl);
    await createTask(server.baseUrl, "lease-task-1");
    await createTask(server.baseUrl, "lease-task-2");

    const claim1 = await fetch(`${server.baseUrl}/tasks/lease-task-1/claim`, {
      method: "POST",
      headers: workerHeaders,
      body: claimBody(),
    });
    assert.equal(claim1.status, 200);
    const claim2 = await fetch(`${server.baseUrl}/tasks/lease-task-2/claim`, {
      method: "POST",
      headers: workerHeaders,
      body: claimBody(),
    });
    assert.equal(claim2.status, 200);
    const claimed1 = await claim1.json() as { leaseV1?: { fencingToken: string; resourceVersion: string } };
    // The authority's stamp is on the durable record.
    assert.ok(claimed1.leaseV1);
    assert.equal(claimed1.leaseV1?.fencingToken, "1");
    const claimed2 = await claim2.json() as { leaseV1?: { fencingToken: string } };
    assert.ok(claimed2.leaseV1);

    // A stale requeue (older_than_seconds=0 makes everything stale) releases
    // the V1 leases BEFORE the legacy requeue.
    const requeue = await fetch(`${server.baseUrl}/tasks/requeue_stale?older_than_seconds=0`, {
      method: "POST",
      headers: jsonHeaders({ "x-a2a-requester-id": "op-a", "x-a2a-requester-role": "operator" }),
    });
    assert.equal(requeue.status, 200);
    const requeueBody = await requeue.json() as { requeued: number };
    assert.equal(requeueBody.requeued, 2);

    // The re-claim presents the advanced resource version: a design bug that
    // pinned the claim's expected version at "0" would surface here as a 409.
    const reClaim = await fetch(`${server.baseUrl}/tasks/lease-task-1/claim`, {
      method: "POST",
      headers: workerHeaders,
      body: claimBody(),
    });
    assert.equal(reClaim.status, 200);
    const reClaimed = await reClaim.json() as { leaseV1?: { fencingToken: string; resourceVersion: string } };
    assert.ok(reClaimed.leaseV1);
    // The fence rose across the release/re-claim cycle (never reused, never lower).
    assert.equal(reClaimed.leaseV1?.fencingToken, "2");

    // The second requeued task is claimable too — per-task version memory.
    const reClaim2 = await fetch(`${server.baseUrl}/tasks/lease-task-2/claim`, {
      method: "POST",
      headers: workerHeaders,
      body: claimBody(),
    });
    assert.equal(reClaim2.status, 200);
    const reClaimed2 = await reClaim2.json() as { leaseV1?: { fencingToken: string } };
    assert.ok(reClaimed2.leaseV1);
    assert.equal(reClaimed2.leaseV1?.fencingToken, "2");
  } finally {
    await server.close();
  }
});

test("sharedStateLeaseV1 gates the terminal mutation: a fenced-out attempt cannot complete", async () => {
  const server = await startTestServer({
    brokerId: "brokeralpha",
    sharedStateLeaseV1: true,
  });
  try {
    await registerWorker(server.baseUrl);
    await createTask(server.baseUrl, "lease-terminal");

    const claim = await fetch(`${server.baseUrl}/tasks/lease-terminal/claim`, {
      method: "POST",
      headers: workerHeaders,
      body: claimBody(),
    });
    assert.equal(claim.status, 200);
    const claimed = await claim.json() as {
      leaseV1?: { fencingToken: string; attemptKeyDigest: string; resourceVersion: string };
    };
    assert.ok(claimed.leaseV1);

    // Corrupt the record's version memory so the next authority command
    // presents a version the durable row cannot accept: the ladder answers
    // version_conflict and the legacy completion must never run.
    server.runtime.broker.stampTaskLeaseV1("lease-terminal", {
      fencingToken: claimed.leaseV1.fencingToken,
      attemptKeyDigest: claimed.leaseV1.attemptKeyDigest,
      resourceVersion: "99",
    });

    const badComplete = await fetch(`${server.baseUrl}/tasks/lease-terminal/complete`, {
      method: "POST",
      headers: workerHeaders,
      body: JSON.stringify({
        workerId: "workerbeta",
        result: { summary: "should not land" },
      }),
    });
    assert.equal(badComplete.status, 409);
    const badBody = await badComplete.json() as { error?: { code?: string } };
    assert.equal(badBody.error?.code, "invalid_transition");

    // The legacy record is untouched by the refused mutation.
    const task = server.runtime.broker.getTask("lease-terminal");
    assert.ok(task);
    assert.equal(task.status, "claimed");
    assert.equal(task.result, undefined);
  } finally {
    await server.close();
  }
});

test("sharedStateLeaseV1 keeps claim authority across a durable server restart", async () => {
  await withTempDir(async (directory) => {
    const options = {
      host: "127.0.0.1",
      port: 0,
      publicBaseUrl: "https://broker.test/",
      brokerId: "brokeralpha",
      sharedStateLeaseV1: true,
      persistenceBackend: "sqlite" as const,
      sqliteFile: join(directory, "state.sqlite"),
      stateFile: join(directory, "snap.json"),
      sharedStateFile: join(directory, "fence.sqlite"),
      enforceRequesterIdentity: false,
      // Tests must not inherit the production process.exit(1) fence-loss posture.
      lostFenceExit: () => {},
    };
    // startTestServer injects an in-memory state store, so the durable-restart
    // test boots the real server with the real sqlite-backed store directly.
    const boot = async () => {
      const runtime = createBrokerServer({ ...options });
      runtime.server.listen(0, "127.0.0.1");
      await once(runtime.server, "listening");
      const address = runtime.server.address();
      if (!address || typeof address === "string") throw new Error("failed to bind");
      return {
        runtime,
        baseUrl: `http://127.0.0.1:${address.port}`,
        close: async () => {
          runtime.server.close();
          runtime.server.closeAllConnections?.();
          await once(runtime.server, "close");
          await runtime.closeWorkerPersistence();
        },
      };
    };

    const server1 = await boot();
    try {
      await registerWorker(server1.baseUrl);
      await createTask(server1.baseUrl, "lease-restart");
      const claim = await fetch(`${server1.baseUrl}/tasks/lease-restart/claim`, {
        method: "POST",
        headers: workerHeaders,
        body: claimBody(),
      });
      assert.equal(claim.status, 200);
    } finally {
      await server1.close();
    }

    // Restart on the same sqlite state + fence files: the record stamp and
    // the durable lease row agree, so the holder can still complete.
    const server2 = await boot();
    try {
      const complete = await fetch(`${server2.baseUrl}/tasks/lease-restart/complete`, {
        method: "POST",
        headers: workerHeaders,
        body: JSON.stringify({
          workerId: "workerbeta",
          result: { summary: "completed after restart" },
        }),
      });
      assert.equal(complete.status, 200);
      const done = await complete.json() as { status?: string };
      assert.equal(done.status, "succeeded");
    } finally {
      await server2.close();
    }
  });
});

test("default-off keeps the legacy claim path unchanged", async () => {
  const server = await startTestServer({
    brokerId: "brokeralpha",
    sharedStateLeaseV1: false,
  });
  try {
    await registerWorker(server.baseUrl);
    await createTask(server.baseUrl, "legacy-claim");
    const claim = await fetch(`${server.baseUrl}/tasks/legacy-claim/claim`, {
      method: "POST",
      headers: workerHeaders,
      body: claimBody(),
    });
    assert.equal(claim.status, 200);
    const claimed = await claim.json() as Record<string, unknown>;
    // No V1 machinery on the record.
    assert.equal("leaseV1" in claimed, false);
  } finally {
    await server.close();
  }
});

test("invalid BROKER_SHARED_STATE_V1_LEASE value fails startup loudly", async () => {
  await withEnv({ BROKER_SHARED_STATE_V1_LEASE: "definitely-not-a-mode" }, async () => {
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
        error.message.includes("BROKER_SHARED_STATE_V1_LEASE"),
    );
  });
});
