// #2082 C: a worker heartbeat can name the actively-running task so the
// single worker heartbeat sustains task liveness — no dedicated
// /tasks/:id/heartbeat timer needed. The stamp is lenient (wrong worker,
// unknown task, terminal task → ignored) and the legacy per-task heartbeat
// route keeps working for old workers.
import test from "node:test";
import assert from "node:assert/strict";

import { startTestServer, jsonHeaders, workerPayload } from "./server-test-helpers.js";

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
    message: "active-task heartbeat test",
    taskOrigin: "api",
  });
}

interface TaskSnapshot {
  status: string;
  lastHeartbeatAt?: string;
}

async function createAndStartRunningTask(baseUrl: string, id: string, workerId: "workerbeta" | "workergamma"): Promise<void> {
  const created = await fetch(`${baseUrl}/tasks`, { method: "POST", headers: jsonHeaders(), body: taskBody(id, workerId) });
  assert.equal(created.status, 201);
  const claimed = await fetch(`${baseUrl}/tasks/${id}/claim`, { method: "POST", headers: jsonHeaders(), body: JSON.stringify({ workerId }) });
  assert.equal(claimed.status, 200);
  const started = await fetch(`${baseUrl}/tasks/${id}/start`, { method: "POST", headers: jsonHeaders(), body: JSON.stringify({ workerId }) });
  assert.equal(started.status, 200);
}

async function getTask(baseUrl: string, id: string): Promise<TaskSnapshot> {
  const res = await fetch(`${baseUrl}/tasks/${id}`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { task?: TaskSnapshot } & TaskSnapshot;
  return body.task ?? body;
}

async function workerHeartbeat(baseUrl: string, workerId: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${baseUrl}/workers/${workerId}/heartbeat`, {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify(body),
  });
}

test("a worker heartbeat carrying activeTaskId stamps task liveness", async () => {
  const { baseUrl, close } = await startTestServer({ enforceRequesterIdentity: false });
  try {
    await registerWorker(baseUrl, "workerbeta");
    await createAndStartRunningTask(baseUrl, "hb-active-1", "workerbeta");

    const before = await getTask(baseUrl, "hb-active-1");
    assert.equal(before.status, "running");
    assert.equal(before.lastHeartbeatAt, undefined);

    const res = await workerHeartbeat(baseUrl, "workerbeta", {
      activeTaskId: "hb-active-1",
      activeTaskLastProgressAt: new Date().toISOString(),
    });
    assert.equal(res.status, 200);

    const after = await getTask(baseUrl, "hb-active-1");
    assert.ok(after.lastHeartbeatAt, "task heartbeat must be stamped from the worker heartbeat");
  } finally {
    await close();
  }
});

test("an activeTaskId that is not this worker's active task is ignored, heartbeat still 200", async () => {
  const { baseUrl, close } = await startTestServer({ enforceRequesterIdentity: false });
  try {
    await registerWorker(baseUrl, "workerbeta");
    await registerWorker(baseUrl, "workergamma");
    // running task owned by workergamma
    await createAndStartRunningTask(baseUrl, "hb-other-1", "workergamma");
    // queued (never claimed) task — not in an active state
    await fetch(`${baseUrl}/tasks`, { method: "POST", headers: jsonHeaders(), body: taskBody("hb-other-2", "workerbeta") });

    const res = await workerHeartbeat(baseUrl, "workerbeta", { activeTaskId: "hb-other-1" });
    assert.equal(res.status, 200);
    const other = await getTask(baseUrl, "hb-other-1");
    assert.equal(other.lastHeartbeatAt, undefined, "another worker's task must not be stamped");

    const res2 = await workerHeartbeat(baseUrl, "workerbeta", { activeTaskId: "hb-other-2" });
    assert.equal(res2.status, 200);
    const queued = await getTask(baseUrl, "hb-other-2");
    assert.equal(queued.lastHeartbeatAt, undefined, "a non-active task must not be stamped");

    const res3 = await workerHeartbeat(baseUrl, "workerbeta", { activeTaskId: "hb-does-not-exist" });
    assert.equal(res3.status, 200, "an unknown activeTaskId must not fail the worker heartbeat");
  } finally {
    await close();
  }
});

test("the legacy dedicated task heartbeat route keeps working (old workers)", async () => {
  const { baseUrl, close } = await startTestServer({ enforceRequesterIdentity: false });
  try {
    await registerWorker(baseUrl, "workerbeta");
    await createAndStartRunningTask(baseUrl, "hb-legacy-1", "workerbeta");

    const res = await fetch(`${baseUrl}/tasks/hb-legacy-1/heartbeat`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ workerId: "workerbeta" }),
    });
    assert.equal(res.status, 200);
    const task = await getTask(baseUrl, "hb-legacy-1");
    assert.ok(task.lastHeartbeatAt, "dedicated task heartbeat must still stamp liveness");
  } finally {
    await close();
  }
});
