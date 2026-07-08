// Graceful drain (#1405) — while draining, new poll/claim work is refused
// with 503 broker_draining + Retry-After and every response carries
// `Connection: close`, but in-flight submission/lifecycle routes keep working
// so worker results land before the process exits.
import test from "node:test";
import assert from "node:assert/strict";

import { startTestServer, jsonHeaders, workerPayload } from "./server-test-helpers.js";
import { computeReconnectDelayMs, isBrokerConnectionError, BrokerApiError, MAX_RECONNECT_DELAY_MS } from "./worker.js";

// beginDrain() severs idle keep-alive sockets; undici may race a pooled socket
// into the next request and surface `fetch failed`. Real workers treat that as
// a connection error and reconnect (the exact #1405 behavior) — mirror that
// with a single retry on a fresh connection.
async function fetchAfterDrain(url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch {
    return await fetch(url, init);
  }
}

async function registerWorker(baseUrl: string): Promise<void> {
  const res = await fetch(`${baseUrl}/workers/register`, {
    method: "POST",
    headers: jsonHeaders(),
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
      message: "drain test task",
      taskOrigin: "api",
    }),
  });
  assert.equal(res.status, 201);
}

test("draining refuses new poll and claim work with 503 broker_draining + Retry-After (#1405)", async () => {
  const server = await startTestServer({ enforceRequesterIdentity: false });
  try {
    await registerWorker(server.baseUrl);
    await createTask(server.baseUrl, "drain-refuse-task");

    // pre-drain baseline: poll works
    const before = await fetch(`${server.baseUrl}/tasks?assignedWorkerId=workerbeta&status=queued`, {
      headers: jsonHeaders({ "x-a2a-requester-id": "workerbeta", "x-a2a-requester-role": "analyst" }),
    });
    assert.equal(before.status, 200);

    server.runtime.beginDrain();
    assert.equal(server.runtime.isDraining(), true);

    const poll = await fetchAfterDrain(`${server.baseUrl}/tasks?assignedWorkerId=workerbeta&status=queued`, {
      headers: jsonHeaders({ "x-a2a-requester-id": "workerbeta", "x-a2a-requester-role": "analyst" }),
    });
    assert.equal(poll.status, 503);
    assert.ok(Number(poll.headers.get("retry-after")) >= 1);
    assert.equal(poll.headers.get("connection"), "close");
    const pollBody = await poll.json() as { error: { code: string } };
    assert.equal(pollBody.error.code, "broker_draining");

    const claim = await fetchAfterDrain(`${server.baseUrl}/tasks/drain-refuse-task/claim`, {
      method: "POST",
      headers: jsonHeaders({ "x-a2a-requester-id": "workerbeta", "x-a2a-requester-role": "analyst" }),
      body: JSON.stringify({ workerId: "workerbeta" }),
    });
    assert.equal(claim.status, 503);
    const claimBody = await claim.json() as { error: { code: string } };
    assert.equal(claimBody.error.code, "broker_draining");
  } finally {
    await server.close();
  }
});

test("in-flight submissions still land during drain — claimed task completes (#1405)", async () => {
  const server = await startTestServer({ enforceRequesterIdentity: false });
  try {
    await registerWorker(server.baseUrl);
    await createTask(server.baseUrl, "drain-complete-task");

    const claim = await fetch(`${server.baseUrl}/tasks/drain-complete-task/claim`, {
      method: "POST",
      headers: jsonHeaders({ "x-a2a-requester-id": "workerbeta", "x-a2a-requester-role": "analyst" }),
      body: JSON.stringify({ workerId: "workerbeta" }),
    });
    assert.equal(claim.status, 200);

    server.runtime.beginDrain();

    // The whole point of the drain window: a submission for work claimed
    // before the drain must succeed, not die on a severed socket.
    const complete = await fetchAfterDrain(`${server.baseUrl}/tasks/drain-complete-task/complete`, {
      method: "POST",
      headers: jsonHeaders({ "x-a2a-requester-id": "workerbeta", "x-a2a-requester-role": "analyst" }),
      body: JSON.stringify({ workerId: "workerbeta", result: { summary: "done", artifactIds: [] } }),
    });
    assert.equal(complete.status, 200);
    assert.equal(complete.headers.get("connection"), "close");
    const completed = await complete.json() as { status: string };
    assert.equal(completed.status, "succeeded");

    // heartbeat-class lifecycle traffic is also allowed through
    const heartbeat = await fetchAfterDrain(`${server.baseUrl}/workers/register`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify(workerPayload("workerbeta")),
    });
    assert.ok(heartbeat.status === 200 || heartbeat.status === 201);
  } finally {
    await server.close();
  }
});

test("/livez stays alive but reports draining (#1405)", async () => {
  const server = await startTestServer({ enforceRequesterIdentity: false });
  try {
    const before = await fetch(`${server.baseUrl}/livez`);
    assert.equal(before.status, 200);
    assert.equal((await before.json() as { draining: boolean }).draining, false);

    server.runtime.beginDrain();
    server.runtime.beginDrain(); // idempotent

    const after = await fetchAfterDrain(`${server.baseUrl}/livez`);
    assert.equal(after.status, 200, "liveness must not fail during a seconds-long drain");
    assert.equal((await after.json() as { draining: boolean }).draining, true);
  } finally {
    await server.close();
  }
});

// --- worker-side reconnect backoff (#1405) ---

test("computeReconnectDelayMs grows exponentially, caps at MAX, and jitters within +/-25%", () => {
  const noJitter = () => 0.5; // jitter factor 1.0
  assert.equal(computeReconnectDelayMs(5_000, 1, noJitter), 5_000);
  assert.equal(computeReconnectDelayMs(5_000, 2, noJitter), 10_000);
  assert.equal(computeReconnectDelayMs(5_000, 3, noJitter), 20_000);
  assert.equal(computeReconnectDelayMs(5_000, 4, noJitter), MAX_RECONNECT_DELAY_MS);
  assert.equal(computeReconnectDelayMs(5_000, 50, noJitter), MAX_RECONNECT_DELAY_MS, "bounded");

  assert.equal(computeReconnectDelayMs(5_000, 1, () => 0), 3_750); // -25%
  assert.equal(computeReconnectDelayMs(5_000, 1, () => 1), 6_250); // +25%
  for (let i = 0; i < 50; i += 1) {
    const d = computeReconnectDelayMs(5_000, 1);
    assert.ok(d >= 3_750 && d <= 6_250, `jitter out of band: ${d}`);
  }
});

test("isBrokerConnectionError classifies socket churn and drain notices, not app errors", () => {
  const reset = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
  assert.equal(isBrokerConnectionError(reset), true);

  const wrapped = new Error("fetch failed");
  (wrapped as Error & { cause?: unknown }).cause = Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" });
  assert.equal(isBrokerConnectionError(wrapped), true);

  assert.equal(isBrokerConnectionError(new BrokerApiError(503, "broker_draining", "draining")), true);
  assert.equal(isBrokerConnectionError(new BrokerApiError(403, "policy_denied", "no")), false);
  assert.equal(isBrokerConnectionError(new BrokerApiError(503, "queue_drain_timeout", "busy")), false);
  assert.equal(isBrokerConnectionError(new Error("some handler bug")), false);
});
