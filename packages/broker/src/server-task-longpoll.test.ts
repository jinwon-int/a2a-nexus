// Server-side task long-poll (#2082 B): GET /tasks?assignedWorkerId=…&waitMs=N
// holds an empty worker-scoped page until a persisted mutation produces work,
// bounded by the 30s cap, the concurrent-slot gate, and drain. The response
// shape/status never differ from a plain poll.
import test from "node:test";
import assert from "node:assert/strict";

import { generateKeyPairSync } from "node:crypto";

import { startTestServer, jsonHeaders, workerPayload, withEnv } from "./server-test-helpers.js";
import { signA2AWorkerRequest } from "./workers/worker-http-signature.js";

async function registerWorker(baseUrl: string, nodeId: "workerbeta" | "workergamma"): Promise<void> {
  const res = await fetch(`${baseUrl}/workers/register`, {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify(workerPayload(nodeId)),
  });
  assert.ok(res.status === 200 || res.status === 201, `worker register failed: ${res.status}`);
}

function taskBody(id: string, targetNodeId: "workerbeta" | "workergamma"): string {
  return JSON.stringify({
    id,
    intent: "chat",
    requester: { id: "test-hub", kind: "node", role: "hub" },
    target: { id: targetNodeId, kind: "node", role: "analyst" },
    targetNodeId,
    message: "long-poll test task",
    taskOrigin: "api",
  });
}

test("waitMs poll answers immediately when a matching task is created while waiting", async () => {
  const { baseUrl, close } = await startTestServer({ enforceRequesterIdentity: false });
  try {
    await registerWorker(baseUrl, "workerbeta");
    const startedAt = Date.now();
    const pollPromise = fetch(`${baseUrl}/tasks?assignedWorkerId=workerbeta&status=queued&waitMs=10000`, {
      headers: { "x-a2a-requester-id": "workerbeta" },
    });
    // Create the task shortly after the poll starts; the wake must land well
    // before the 10s deadline.
    await new Promise((resolve) => setTimeout(resolve, 150));
    const created = await fetch(`${baseUrl}/tasks`, {
      method: "POST",
      headers: jsonHeaders(),
      body: taskBody("lp-create-1", "workerbeta"),
    });
    assert.equal(created.status, 201);
    const response = await pollPromise;
    const elapsed = Date.now() - startedAt;
    assert.equal(response.status, 200);
    const body = (await response.json()) as { count: number; items: Array<{ id: string }> };
    assert.equal(body.count, 1);
    assert.equal(body.items[0]?.id, "lp-create-1");
    assert.ok(elapsed < 5_000, `long-poll should wake on creation, took ${elapsed}ms`);
  } finally {
    await close();
  }
});

test("waitMs poll returns an empty page at the deadline with the plain-poll shape", async () => {
  const { baseUrl, close } = await startTestServer({ enforceRequesterIdentity: false });
  try {
    await registerWorker(baseUrl, "workerbeta");
    const startedAt = Date.now();
    const response = await fetch(
      `${baseUrl}/tasks?assignedWorkerId=workerbeta&status=queued&waitMs=400`,
      { headers: { "x-a2a-requester-id": "workerbeta" } },
    );
    const elapsed = Date.now() - startedAt;
    assert.equal(response.status, 200);
    const body = (await response.json()) as { count: number; limit: number; items: unknown[] };
    assert.deepEqual(body, { count: 0, limit: body.limit, items: [] });
    assert.ok(elapsed >= 350, `timeout poll must wait the deadline, took ${elapsed}ms`);
    assert.ok(elapsed < 5_000, `timeout poll must not overshoot the cap, took ${elapsed}ms`);
  } finally {
    await close();
  }
});

test("a drain started mid-hold answers the in-flight waitMs poll immediately", async () => {
  const { baseUrl, runtime, close } = await startTestServer({ enforceRequesterIdentity: false });
  try {
    await registerWorker(baseUrl, "workerbeta");
    const startedAt = Date.now();
    const pollPromise = fetch(
      `${baseUrl}/tasks?assignedWorkerId=workerbeta&status=queued&waitMs=10000`,
      { headers: { "x-a2a-requester-id": "workerbeta" } },
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    // Drain while the poll is held: the in-flight long-poll must release at
    // once with the plain-poll shape (new polls are 503-refused upstream).
    runtime.beginDrain();
    const response = await pollPromise;
    const elapsed = Date.now() - startedAt;
    assert.equal(response.status, 200);
    const body = (await response.json()) as { count: number };
    assert.equal(body.count, 0);
    assert.ok(elapsed < 2_000, `drain must release the held poll, took ${elapsed}ms`);
  } finally {
    await close();
  }
});

test("waitMs requires a worker-scoped query and rejects garbage values", async () => {
  const { baseUrl, close } = await startTestServer({ enforceRequesterIdentity: false });
  try {
    await registerWorker(baseUrl, "workerbeta");
    const unscoped = await fetch(`${baseUrl}/tasks?waitMs=1000`);
    assert.equal(unscoped.status, 400);

    const negative = await fetch(`${baseUrl}/tasks?assignedWorkerId=workerbeta&waitMs=-5`);
    assert.equal(negative.status, 400);

    const garbage = await fetch(`${baseUrl}/tasks?assignedWorkerId=workerbeta&waitMs=soon`);
    assert.equal(garbage.status, 400);
  } finally {
    await close();
  }
});

test("the long-poll slot gate degrades to an immediate plain poll when exhausted", async () => {
  await withEnv({ A2A_BROKER_TASK_LONG_POLL_MAX: "0" }, async () => {
    const { baseUrl, close } = await startTestServer({ enforceRequesterIdentity: false });
    try {
      await registerWorker(baseUrl, "workerbeta");
      const startedAt = Date.now();
      const response = await fetch(
        `${baseUrl}/tasks?assignedWorkerId=workerbeta&status=queued&waitMs=10000`,
        { headers: { "x-a2a-requester-id": "workerbeta" } },
      );
      const elapsed = Date.now() - startedAt;
      assert.equal(response.status, 200);
      assert.equal(((await response.json()) as { count: number }).count, 0);
      assert.ok(elapsed < 2_000, `exhausted gate must not hold the poll, took ${elapsed}ms`);
    } finally {
      await close();
    }
  });
});

// a2a-nexus#2127: production workers sign every request (A2A HTTP Signature).
// The signature gate drains the request body before the handler runs, which
// auto-destroys the IncomingMessage (`req.destroyed === true`) even though the
// client is still connected. The hold loop used to test `req.destroyed` as a
// client-gone signal, so every SIGNED long-poll skipped the hold and returned
// WITHOUT writing a response — workers timed out at waitMs+5s on each idle
// poll. These tests sign exactly the way the worker client does.
const signedPollKeyPair = generateKeyPairSync("ed25519");
const signedPollKeyid = "worker:workerbeta:longpoll";
const signedPollKeyRegistry = {
  [signedPollKeyid]: {
    keyid: signedPollKeyid,
    workerId: "workerbeta",
    publicKeyJwk: signedPollKeyPair.publicKey.export({ format: "jwk" }) as Record<string, unknown>,
  },
};
const signedPollSignatureConfig = {
  keyid: signedPollKeyid,
  privateKeyJwk: signedPollKeyPair.privateKey.export({ format: "jwk" }) as Record<string, unknown>,
  brokerId: "brokeralpha",
};

function signedWorkerPoll(baseUrl: string, waitMs: number): Promise<Response> {
  const url = new URL(`/tasks?assignedWorkerId=workerbeta&status=queued&waitMs=${waitMs}`, baseUrl);
  const headers = new Headers({
    accept: "application/json",
    "x-a2a-requester-id": "workerbeta",
    "x-a2a-requester-kind": "node",
    "x-a2a-requester-role": "analyst",
  });
  signA2AWorkerRequest({ method: "GET", url, headers, body: "", config: signedPollSignatureConfig });
  return fetch(url, { method: "GET", headers, signal: AbortSignal.timeout(waitMs + 5_000) });
}

test("a SIGNED waitMs poll still answers an empty page at the deadline (#2127)", async () => {
  const { baseUrl, close } = await startTestServer({
    enforceRequesterIdentity: false,
    brokerId: "brokeralpha",
    a2aHttpSignatureWorkerAuth: "optional",
    a2aHttpSignatureKeyRegistry: signedPollKeyRegistry,
  });
  try {
    await registerWorker(baseUrl, "workerbeta");
    const startedAt = Date.now();
    const response = await signedWorkerPoll(baseUrl, 1_000);
    const elapsed = Date.now() - startedAt;
    assert.equal(response.status, 200);
    const body = (await response.json()) as { count: number; items: unknown[] };
    assert.equal(body.count, 0);
    assert.deepEqual(body.items, []);
    assert.ok(elapsed >= 900, `signed poll must be held to the deadline, returned after ${elapsed}ms`);
    assert.ok(elapsed < 4_000, `signed poll must answer at the deadline, took ${elapsed}ms`);
  } finally {
    await close();
  }
});

test("a SIGNED waitMs poll wakes when a matching task is created while waiting (#2127)", async () => {
  const { baseUrl, close } = await startTestServer({
    enforceRequesterIdentity: false,
    brokerId: "brokeralpha",
    a2aHttpSignatureWorkerAuth: "optional",
    a2aHttpSignatureKeyRegistry: signedPollKeyRegistry,
  });
  try {
    await registerWorker(baseUrl, "workerbeta");
    const startedAt = Date.now();
    const pollPromise = signedWorkerPoll(baseUrl, 10_000);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const created = await fetch(`${baseUrl}/tasks`, {
      method: "POST",
      headers: jsonHeaders(),
      body: taskBody("lp-signed-create-1", "workerbeta"),
    });
    assert.equal(created.status, 201);
    const response = await pollPromise;
    const elapsed = Date.now() - startedAt;
    assert.equal(response.status, 200);
    const body = (await response.json()) as { count: number; items: Array<{ id: string }> };
    assert.equal(body.count, 1);
    assert.equal(body.items[0]?.id, "lp-signed-create-1");
    assert.ok(elapsed < 5_000, `signed long-poll should wake on creation, took ${elapsed}ms`);
  } finally {
    await close();
  }
});
