/**
 * #1912 D1 — A2A-Version negotiation on the per-task SSE stream.
 *
 * The SSE surface previously had no negotiation at all and always emitted the
 * historical lowercase state projection — the one surface that contradicted
 * even the broker's documented "header-less gets 1.0 semantics" deviation.
 * Negotiated clients now receive the v1.0 ProtoJSON state encoding
 * (TASK_STATE_*) inside the unchanged broker-extension envelope, header-less
 * clients keep the legacy lowercase projection, and an explicit unsupported
 * version is rejected fail-closed. The typed client negotiates by default and
 * normalizes both wire encodings to the legacy lowercase form.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { createA2ABrokerClient } from "../client/broker-client.js";
import {
  createTaskRequest,
  jsonHeaders,
  readSseEventsUntil,
  registerTestWorker,
  startTestServer,
} from "../server-test-helpers.js";

async function createQueuedTask(baseUrl: string): Promise<string> {
  await registerTestWorker(baseUrl, "worker-a", "analyst", undefined);
  const response = await fetch(`${baseUrl}/tasks`, {
    method: "POST",
    headers: jsonHeaders({}),
    body: JSON.stringify(createTaskRequest("sse-version-task")),
  });
  assert.equal(response.status, 201, `task create failed: ${response.status}`);
  const created = (await response.json()) as { id: string };
  return created.id;
}

test("D1: header-less SSE subscription keeps the legacy lowercase projection", async () => {
  const server = await startTestServer({ enforceRequesterIdentity: false });
  try {
    const taskId = await createQueuedTask(server.baseUrl);
    const response = await fetch(`${server.baseUrl}/a2a/tasks/${taskId}/events`);
    assert.equal(response.status, 200);
    const events = await readSseEventsUntil(response, (evts) => evts.length >= 1);
    const snapshot = JSON.parse(events[0]!.data) as { task: { status: { state: string } } };
    assert.equal(snapshot.task.status.state, "submitted");
    assert.equal(response.headers.get("a2a-version"), "1.0");
  } finally {
    await server.close();
  }
});

test("D1: negotiated SSE subscription receives TASK_STATE_* encoding in the unchanged envelope", async () => {
  const server = await startTestServer({ enforceRequesterIdentity: false });
  try {
    const taskId = await createQueuedTask(server.baseUrl);
    const response = await fetch(`${server.baseUrl}/a2a/tasks/${taskId}/events`, {
      headers: { "a2a-version": "1.0" },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("a2a-version"), "1.0");
    const events = await readSseEventsUntil(response, (evts) => evts.length >= 1);
    const snapshot = JSON.parse(events[0]!.data) as {
      task: { id: string; kind: string; status: { state: string } };
      reason: string;
      final: boolean;
    };
    assert.equal(snapshot.task.status.state, "TASK_STATE_SUBMITTED");
    // Broker-extension envelope is untouched: only the state vocabulary flips.
    assert.equal(snapshot.task.kind, "task");
    assert.equal(snapshot.reason, "snapshot");
    assert.equal(snapshot.final, false);
  } finally {
    await server.close();
  }
});

test("D1: an explicit unsupported A2A-Version is rejected fail-closed", async () => {
  const server = await startTestServer({ enforceRequesterIdentity: false });
  try {
    const taskId = await createQueuedTask(server.baseUrl);
    const response = await fetch(`${server.baseUrl}/a2a/tasks/${taskId}/events`, {
      headers: { "a2a-version": "9.9" },
    });
    assert.notEqual(response.status, 200, "unsupported version must not open an SSE stream");
    assert.notEqual(response.headers.get("content-type") ?? "", "text/event-stream");
    const body = (await response.json()) as { error?: { message?: string } };
    assert.match(body.error?.message ?? JSON.stringify(body), /unsupported A2A-Version/);
  } finally {
    await server.close();
  }
});

test("D1: typed client negotiates by default and normalizes spec encoding to lowercase", async () => {
  const server = await startTestServer({ enforceRequesterIdentity: false });
  try {
    const taskId = await createQueuedTask(server.baseUrl);
    const client = createA2ABrokerClient({ baseUrl: server.baseUrl });
    const iterator = client.streamTaskEvents(taskId)[Symbol.asyncIterator]();
    const first = await iterator.next();
    await iterator.return?.();
    assert.equal(first.done, false);
    if (!first.done) {
      assert.equal(first.value.data.task.status.state, "submitted");
    }
  } finally {
    await server.close();
  }
});

test("D1: typed client with a2aVersion null opts out and reads the legacy envelope", async () => {
  const server = await startTestServer({ enforceRequesterIdentity: false });
  try {
    const taskId = await createQueuedTask(server.baseUrl);
    const client = createA2ABrokerClient({ baseUrl: server.baseUrl, a2aVersion: null });
    const iterator = client.streamTaskEvents(taskId)[Symbol.asyncIterator]();
    const first = await iterator.next();
    await iterator.return?.();
    assert.equal(first.done, false);
    if (!first.done) {
      assert.equal(first.value.data.task.status.state, "submitted");
    }
  } finally {
    await server.close();
  }
});
