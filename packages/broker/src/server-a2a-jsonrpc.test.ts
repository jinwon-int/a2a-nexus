import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTestServer, jsonHeaders, registerTestWorker, readSseEventsUntil, createInMemoryStateStore } from "./server-test-helpers.js";
import { InMemoryA2ABroker } from "./core/broker.js";
import { emptySnapshot } from "./core/store.js";

test("server exposes a public agent card on the well-known path", async () => {
  const server = await startTestServer({
    serviceName: "brokeralpha-broker",
    publicBaseUrl: "https://broker.example.com/",
    edgeSecret: "test-edge-secret",
  });

  try {
    const response = await fetch(`${server.baseUrl}/.well-known/agent-card.json`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "public, max-age=300");

    const card = await response.json();
    assert.equal(card.name, "brokeralpha-broker");
    assert.equal(card.url, "https://broker.example.com/a2a/jsonrpc");
    assert.equal(card.protocolVersion, "1.0");
    assert.equal(card.capabilities.streaming, true);
    assert.equal(card.capabilities.pushNotifications, false);
    // A2A 1.0 transport binding declaration (CARD-PROTO / BIND-FIELD).
    assert.deepEqual(card.supportedInterfaces, [
      { protocolBinding: "JSONRPC", url: "https://broker.example.com/a2a/jsonrpc" },
    ]);
    assert.ok(Array.isArray(card.skills));
    assert.ok(card.skills.some((skill: { id: string }) => skill.id === "propose_patch"));
  } finally {
    await server.close();
  }
});

test("server exposes JSON-RPC SendMessage and task methods behind the A2A facade", async () => {
  const server = await startTestServer({
    edgeSecret: "test-edge-secret",
  });

  try {
    const workerPayload = {
      role: "analyst",
      capabilities: {
        canAnalyze: true,
        canBackfill: false,
        canPatchWorkspace: false,
        canPromoteLive: false,
        workspaceIds: ["test"],
        environments: ["research"],
      },
    };

    await fetch(`${server.baseUrl}/workers/register`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "worker-a",
        "x-a2a-requester-role": "analyst",
      }),
      body: JSON.stringify({ nodeId: "worker-a", ...workerPayload }),
    });

    const sendRes = await fetch(`${server.baseUrl}/a2a/jsonrpc`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "hub-a",
        "x-a2a-requester-role": "hub",
      }),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "SendMessage",
        params: {
          message: {
            parts: [{ text: "analyze drift" }],
          },
          metadata: {
            targetNodeId: "worker-a",
            intent: "analyze",
            traceId: "send-1",
          },
        },
      }),
    });
    assert.equal(sendRes.status, 200);
    const sendBody = await sendRes.json();
    assert.equal(sendBody.result.task.status.state, "submitted");
    assert.equal(sendBody.result.task.metadata.internalStatus, "queued");
    assert.equal(sendBody.result.task.metadata.targetNodeId, "worker-a");
    assert.equal(sendBody.result.task.metadata.intent, "analyze");
    assert.ok(typeof sendBody.result.contextId === "string");
    assert.ok(typeof sendBody.result.messageId === "string");

    const exchangeStateRes = await fetch(`${server.baseUrl}/exchanges/${sendBody.result.contextId}`, {
      headers: {
        "x-a2a-edge-secret": "test-edge-secret",
      },
    });
    const exchangeState = await exchangeStateRes.json();
    assert.equal(exchangeState.rootMessageId, sendBody.result.messageId);
    assert.equal(exchangeState.activeTaskId, sendBody.result.task.id);

    const followupRes = await fetch(`${server.baseUrl}/a2a/jsonrpc`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "hub-a",
        "x-a2a-requester-role": "hub",
      }),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "SendMessage",
        params: {
          message: {
            text: "follow up note",
          },
          metadata: {
            contextId: sendBody.result.contextId,
            parentMessageId: sendBody.result.messageId,
            targetNodeId: "worker-a",
            assignedWorkerId: "worker-a",
            traceId: "send-2",
          },
        },
      }),
    });
    assert.equal(followupRes.status, 200);
    const followupBody = await followupRes.json();
    assert.equal(followupBody.result.contextId, sendBody.result.contextId);
    assert.notEqual(followupBody.result.messageId, sendBody.result.messageId);
    assert.equal(followupBody.result.task.id, sendBody.result.task.id);

    const getTaskRes = await fetch(`${server.baseUrl}/a2a/jsonrpc`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "hub-a",
        "x-a2a-requester-role": "hub",
      }),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "GetTask",
        params: {
          taskId: exchangeState.activeTaskId,
        },
      }),
    });
    assert.equal(getTaskRes.status, 200);
    const getTaskBody = await getTaskRes.json();
    assert.equal(getTaskBody.result.task.id, exchangeState.activeTaskId);
    assert.equal(getTaskBody.result.task.status.state, "submitted");
    assert.equal(getTaskBody.result.task.metadata.internalStatus, "queued");

    const cancelRes = await fetch(`${server.baseUrl}/a2a/jsonrpc`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "hub-a",
        "x-a2a-requester-role": "hub",
      }),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 4,
        method: "CancelTask",
        params: {
          taskId: exchangeState.activeTaskId,
          reason: "operator stop",
          actor: { id: "hub-a", role: "hub", kind: "node" },
        },
      }),
    });
    assert.equal(cancelRes.status, 200);
    const cancelBody = await cancelRes.json();
    assert.equal(cancelBody.result.task.status.state, "canceled");
    assert.equal(cancelBody.result.task.metadata.internalStatus, "canceled");
  } finally {
    await server.close();
  }
});

test("server keeps peer status default-off and exposes a2a.peer.status when enabled", async () => {
  const defaultOffServer = await startTestServer({ edgeSecret: "test-edge-secret", peerStatusEnabled: false });
  try {
    await registerTestWorker(defaultOffServer.baseUrl, "worker-a", "analyst", "test-edge-secret");
    const disabledRes = await fetch(`${defaultOffServer.baseUrl}/a2a/jsonrpc`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "hub-a",
        "x-a2a-requester-role": "hub",
      }),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "disabled",
        method: "a2a.peer.status",
        params: { target: "worker-a" },
      }),
    });
    const disabled = await disabledRes.json();
    assert.equal(disabled.error.code, -32601);
  } finally {
    await defaultOffServer.close();
  }

  const enabledServer = await startTestServer({
    edgeSecret: "test-edge-secret",
    peerStatusEnabled: true,
  });
  try {
    await registerTestWorker(enabledServer.baseUrl, "worker-a", "analyst", "test-edge-secret");
    const enabledRes = await fetch(`${enabledServer.baseUrl}/a2a/jsonrpc`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "hub-a",
        "x-a2a-requester-role": "hub",
      }),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "enabled",
        method: "a2a.peer.status",
        params: { target: "worker-a" },
      }),
    });
    const enabled = await enabledRes.json();
    assert.equal(enabled.result.schemaVersion, 1);
    assert.equal(enabled.result.target, "worker-a");
    assert.equal(enabled.result.gateway.reachable, true);
    assert.equal(enabled.result.worker.registered, true);
    assert.equal(enabled.result.health, "ok");
  } finally {
    await enabledServer.close();
  }
});

test("agent card is served signed when a signing key is configured (A2A 1.0)", async () => {
  const { generateKeyPairSync } = await import("node:crypto");
  const { writeFileSync, mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { verifyAgentCardSignature } = await import("./a2a/agent-card-signing.js");

  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const keyDir = mkdtempSync(join(tmpdir(), "a2a-card-key-"));
  const keyFile = join(keyDir, "signing-key.pem");
  writeFileSync(keyFile, privateKey.export({ type: "pkcs8", format: "pem" }));

  const server = await startTestServer({
    agentCardSigningKeyFile: keyFile,
    agentCardSigningKid: "integration-key-1",
  });
  try {
    const res = await fetch(`${server.baseUrl}/.well-known/agent-card.json`);
    assert.equal(res.status, 200);
    const card = await res.json();
    assert.ok(Array.isArray(card.signatures), "served card must carry signatures");
    assert.equal(card.signatures.length, 1);
    const header = JSON.parse(Buffer.from(card.signatures[0].protected, "base64url").toString());
    assert.equal(header.alg, "EdDSA");
    assert.equal(header.kid, "integration-key-1");
    assert.equal(
      verifyAgentCardSignature(card, publicKey.export({ type: "spki", format: "pem" }).toString()),
      true,
      "served signature must verify against the public key",
    );
  } finally {
    await server.close();
  }
});

test("agent card stays unsigned when no signing key is configured", async () => {
  const server = await startTestServer();
  try {
    const res = await fetch(`${server.baseUrl}/.well-known/agent-card.json`);
    const card = await res.json();
    assert.equal("signatures" in card, false, "unsigned card must not carry a signatures field");
  } finally {
    await server.close();
  }
});

test("A2A-Version negotiation on /a2a/jsonrpc (A2A 1.0)", async () => {
  const server = await startTestServer();
  try {
    const rpcBody = JSON.stringify({
      jsonrpc: "2.0",
      id: "version-probe",
      method: "ListTasks",
      params: {},
    });
    const headers = jsonHeaders({
      "x-a2a-requester-id": "version-probe",
      "x-a2a-requester-role": "hub",
    });

    // Explicit supported version is served and echoed.
    const v1 = await fetch(`${server.baseUrl}/a2a/jsonrpc`, {
      method: "POST",
      headers: { ...headers, "a2a-version": "1.0" },
      body: rpcBody,
    });
    assert.equal(v1.status, 200);
    assert.equal(v1.headers.get("a2a-version"), "1.0");

    // Missing header is served with 1.0 semantics (documented deviation from
    // the spec's 0.3 fallback: 0.3 semantics are unsupported) and the
    // response advertises the version actually served.
    const missing = await fetch(`${server.baseUrl}/a2a/jsonrpc`, {
      method: "POST",
      headers,
      body: rpcBody,
    });
    assert.equal(missing.status, 200);
    assert.equal(missing.headers.get("a2a-version"), "1.0");

    // A version we cannot honor fails closed instead of being silently
    // served with the wrong semantics.
    const v03 = await fetch(`${server.baseUrl}/a2a/jsonrpc`, {
      method: "POST",
      headers: { ...headers, "a2a-version": "0.3" },
      body: rpcBody,
    });
    assert.equal(v03.status, 400);
    assert.equal(v03.headers.get("a2a-version"), "1.0");
    const errorBody = await v03.json();
    assert.equal(errorBody.error.code, -32009);
    assert.match(errorBody.error.message, /unsupported A2A-Version "0\.3"/);
    assert.ok(Array.isArray(errorBody.error.data));
    assert.equal(errorBody.error.data[0]["@type"], "type.googleapis.com/google.rpc.ErrorInfo");
    assert.equal(errorBody.error.data[0].domain, "a2a-protocol.org");
    assert.equal(errorBody.error.data[0].reason, "VERSION_NOT_SUPPORTED");
    assert.deepEqual(errorBody.error.data[0].metadata, {});
  } finally {
    await server.close();
  }
});

test("SendStreamingMessage streams JSON-RPC envelopes over SSE (A2A 1.0)", async () => {
  const server = await startTestServer({ edgeSecret: "test-edge-secret" });
  try {
    await registerTestWorker(server.baseUrl, "worker-stream", "analyst", "test-edge-secret");
    const hubHeaders = jsonHeaders({
      "x-a2a-edge-secret": "test-edge-secret",
      "x-a2a-requester-id": "hub-a",
      "x-a2a-requester-role": "hub",
    });

    const streamRes = await fetch(`${server.baseUrl}/a2a/jsonrpc`, {
      method: "POST",
      headers: { ...hubHeaders, accept: "text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "stream-1",
        method: "SendStreamingMessage",
        params: {
          message: { parts: [{ text: "analyze streaming" }] },
          metadata: { targetNodeId: "worker-stream", intent: "analyze" },
        },
      }),
    });
    assert.equal(streamRes.status, 200);
    assert.match(streamRes.headers.get("content-type") ?? "", /text\/event-stream/);

    // Drive the task to terminal while the stream is open.
    const workerHeaders = jsonHeaders({
      "x-a2a-edge-secret": "test-edge-secret",
      "x-a2a-requester-id": "worker-stream",
      "x-a2a-requester-role": "analyst",
    });
    const listRes = await fetch(`${server.baseUrl}/tasks?targetNodeId=worker-stream`, {
      headers: hubHeaders,
    });
    const listed = await listRes.json() as { items?: Array<{ id: string }> };
    const streamTaskId = listed.items?.[0]?.id;
    assert.ok(streamTaskId, "streamed task must be visible via REST list");
    const claimRes = await fetch(`${server.baseUrl}/tasks/${streamTaskId}/claim`, {
      method: "POST",
      headers: workerHeaders,
      body: JSON.stringify({ workerId: "worker-stream" }),
    });
    assert.equal(claimRes.status, 200);
    await fetch(`${server.baseUrl}/tasks/${streamTaskId}/complete`, {
      method: "POST",
      headers: workerHeaders,
      body: JSON.stringify({ workerId: "worker-stream", result: { summary: "stream done" } }),
    });

    const events = await readSseEventsUntil(streamRes, (seen) =>
      seen.some((e) => {
        if (e.event !== "task-status-update") return false;
        const body = JSON.parse(e.data);
        return body.result?.final === true;
      }),
    );

    // Every SSE payload is a JSON-RPC result envelope correlated to the id.
    const snapshot = events.find((e) => e.event === "task-snapshot");
    assert.ok(snapshot, "stream must open with a task snapshot");
    const snapshotBody = JSON.parse(snapshot.data);
    assert.equal(snapshotBody.jsonrpc, "2.0");
    assert.equal(snapshotBody.id, "stream-1");
    assert.equal(snapshotBody.result.task.metadata.targetNodeId, "worker-stream");
    assert.ok(typeof snapshotBody.result.contextId === "string");

    const finalEvent = events
      .filter((e) => e.event === "task-status-update")
      .map((e) => JSON.parse(e.data))
      .find((body) => body.result?.final === true);
    assert.ok(finalEvent, "stream must end with a final status update");
    assert.equal(finalEvent.id, "stream-1");
    assert.equal(finalEvent.result.task.status.state, "completed");
  } finally {
    await server.close();
  }
});

test("SendStreamingMessage with explicit A2A-Version streams spec StreamResponse oneofs", async () => {
  const server = await startTestServer({ edgeSecret: "test-edge-secret" });
  try {
    await registerTestWorker(server.baseUrl, "worker-stream-spec", "analyst", "test-edge-secret");
    const hubHeaders = jsonHeaders({
      "x-a2a-edge-secret": "test-edge-secret",
      "x-a2a-requester-id": "hub-a",
      "x-a2a-requester-role": "hub",
    });

    const streamRes = await fetch(`${server.baseUrl}/a2a/jsonrpc`, {
      method: "POST",
      headers: { ...hubHeaders, accept: "text/event-stream", "a2a-version": "1.0" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "stream-spec-1",
        method: "SendStreamingMessage",
        params: {
          message: { parts: [{ text: "analyze streaming spec" }] },
          metadata: { targetNodeId: "worker-stream-spec", intent: "analyze" },
        },
      }),
    });
    assert.equal(streamRes.status, 200);
    assert.equal(streamRes.headers.get("a2a-version"), "1.0");
    assert.match(streamRes.headers.get("content-type") ?? "", /text\/event-stream/);

    const workerHeaders = jsonHeaders({
      "x-a2a-edge-secret": "test-edge-secret",
      "x-a2a-requester-id": "worker-stream-spec",
      "x-a2a-requester-role": "analyst",
    });
    const listRes = await fetch(`${server.baseUrl}/tasks?targetNodeId=worker-stream-spec`, {
      headers: hubHeaders,
    });
    const listed = await listRes.json() as { items?: Array<{ id: string }> };
    const streamTaskId = listed.items?.[0]?.id;
    assert.ok(streamTaskId, "streamed task must be visible via REST list");
    const claimRes = await fetch(`${server.baseUrl}/tasks/${streamTaskId}/claim`, {
      method: "POST",
      headers: workerHeaders,
      body: JSON.stringify({ workerId: "worker-stream-spec" }),
    });
    assert.equal(claimRes.status, 200);
    await fetch(`${server.baseUrl}/tasks/${streamTaskId}/complete`, {
      method: "POST",
      headers: workerHeaders,
      body: JSON.stringify({ workerId: "worker-stream-spec", result: { summary: "stream done" } }),
    });

    const events = await readSseEventsUntil(streamRes, (seen) =>
      seen.some((e) => {
        if (e.event !== "task-status-update") return false;
        const body = JSON.parse(e.data);
        return body.result?.statusUpdate?.metadata?.final === true;
      }),
    );

    // Opening event: StreamResponse { task } with proto-JSON Task — top-level
    // contextId, TASK_STATE_* status, no legacy contextId/final siblings.
    const snapshot = events.find((e) => e.event === "task-snapshot");
    assert.ok(snapshot, "stream must open with a task snapshot");
    const snapshotBody = JSON.parse(snapshot.data);
    assert.equal(snapshotBody.jsonrpc, "2.0");
    assert.equal(snapshotBody.id, "stream-spec-1");
    assert.equal(snapshotBody.result.task.id, streamTaskId);
    assert.ok(typeof snapshotBody.result.task.contextId === "string");
    assert.match(snapshotBody.result.task.status.state, /^TASK_STATE_/);
    assert.equal(snapshotBody.result.contextId, undefined);
    assert.equal(snapshotBody.result.final, undefined);
    assert.equal(snapshotBody.result.task.kind, undefined);

    // Subsequent events: StreamResponse { statusUpdate } TaskStatusUpdateEvent.
    // The proto event is { taskId, contextId, status, metadata } only — no
    // top-level `final` field; the broker's final flag rides in metadata.
    const finalEvent = events
      .filter((e) => e.event === "task-status-update")
      .map((e) => JSON.parse(e.data))
      .find((body) => body.result?.statusUpdate?.metadata?.final === true);
    assert.ok(finalEvent, "stream must end with a final statusUpdate");
    assert.equal(finalEvent.id, "stream-spec-1");
    assert.equal(finalEvent.result.statusUpdate.taskId, streamTaskId);
    assert.ok(typeof finalEvent.result.statusUpdate.contextId === "string");
    assert.equal(finalEvent.result.statusUpdate.status.state, "TASK_STATE_COMPLETED");
    assert.equal("final" in finalEvent.result.statusUpdate, false, "proto TaskStatusUpdateEvent has no final field");
    assert.equal(finalEvent.result.task, undefined);
  } finally {
    await server.close();
  }
});

test("SendStreamingMessage with malformed JSON-RPC envelope is rejected before streaming", async () => {
  const server = await startTestServer({ edgeSecret: "test-edge-secret" });
  try {
    await registerTestWorker(server.baseUrl, "worker-stream-invalid", "analyst", "test-edge-secret");
    const res = await fetch(`${server.baseUrl}/a2a/jsonrpc`, {
      method: "POST",
      headers: {
        ...jsonHeaders({
          "x-a2a-edge-secret": "test-edge-secret",
          "x-a2a-requester-id": "hub-a",
          "x-a2a-requester-role": "hub",
        }),
        accept: "text/event-stream",
      },
      body: JSON.stringify({
        id: "stream-invalid",
        method: "SendStreamingMessage",
        params: {
          message: { parts: [{ text: "invalid envelope" }] },
          metadata: { targetNodeId: "worker-stream-invalid" },
        },
      }),
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /application\/json/);
    const body = await res.json();
    assert.equal(body.id, "stream-invalid");
    assert.equal(body.error.code, -32600);
    assert.match(body.error.message, /jsonrpc must be '2\.0'/);

    const listRes = await fetch(`${server.baseUrl}/tasks?targetNodeId=worker-stream-invalid`, {
      headers: jsonHeaders({
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "hub-a",
        "x-a2a-requester-role": "hub",
      }),
    });
    const listed = await listRes.json() as { items?: unknown[] };
    assert.equal(listed.items?.length ?? 0, 0, "malformed streaming request must not create a task");
  } finally {
    await server.close();
  }
});

test("SendStreamingMessage inside a batch is rejected with -32600", async () => {
  const server = await startTestServer({ edgeSecret: "test-edge-secret" });
  try {
    await registerTestWorker(server.baseUrl, "worker-batch-stream", "analyst", "test-edge-secret");
    const res = await fetch(`${server.baseUrl}/a2a/jsonrpc`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "hub-a",
        "x-a2a-requester-role": "hub",
      }),
      body: JSON.stringify([
        {
          jsonrpc: "2.0",
          id: "batch-stream-1",
          method: "SendStreamingMessage",
          params: {
            message: { parts: [{ text: "no batch streaming" }] },
            metadata: { targetNodeId: "worker-batch-stream" },
          },
        },
      ]),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body[0].error.code, -32600);
    assert.match(body[0].error.message, /cannot be used inside a batch/);
  } finally {
    await server.close();
  }
});

test("awaiting_operator checkpoint projects input-required and a context message resumes it (A2A multiturn)", async () => {
  const server = await startTestServer({ edgeSecret: "test-edge-secret" });
  try {
    await registerTestWorker(server.baseUrl, "worker-ckpt", "analyst", "test-edge-secret");
    const hubHeaders = jsonHeaders({
      "x-a2a-edge-secret": "test-edge-secret",
      "x-a2a-requester-id": "hub-a",
      "x-a2a-requester-role": "hub",
    });
    const workerHeaders = jsonHeaders({
      "x-a2a-edge-secret": "test-edge-secret",
      "x-a2a-requester-id": "worker-ckpt",
      "x-a2a-requester-role": "analyst",
    });

    // Create + claim + start a task through SendMessage.
    const send = await fetch(`${server.baseUrl}/a2a/jsonrpc`, {
      method: "POST",
      headers: hubHeaders,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "ckpt-1",
        method: "SendMessage",
        params: { message: { parts: [{ text: "needs input later" }] }, metadata: { targetNodeId: "worker-ckpt", intent: "analyze" } },
      }),
    });
    const sendBody = await send.json();
    const taskId = sendBody.result.task.id;
    const contextId = sendBody.result.contextId;
    await fetch(`${server.baseUrl}/tasks/${taskId}/claim`, {
      method: "POST", headers: workerHeaders, body: JSON.stringify({ workerId: "worker-ckpt" }),
    });
    await fetch(`${server.baseUrl}/tasks/${taskId}/start`, {
      method: "POST", headers: workerHeaders, body: JSON.stringify({ workerId: "worker-ckpt" }),
    });

    // Worker hits a human-interrupt checkpoint.
    const ckpt = await fetch(`${server.baseUrl}/tasks/${taskId}/checkpoint`, {
      method: "POST",
      headers: workerHeaders,
      body: JSON.stringify({ workerId: "worker-ckpt", state: "awaiting_operator", reason: "need the target branch name" }),
    });
    assert.equal(ckpt.status, 200);

    const interrupted = await fetch(`${server.baseUrl}/a2a/jsonrpc`, {
      method: "POST",
      headers: hubHeaders,
      body: JSON.stringify({ jsonrpc: "2.0", id: "ckpt-2", method: "GetTask", params: { taskId } }),
    });
    const interruptedBody = await interrupted.json();
    assert.equal(interruptedBody.result.task.status.state, "input-required");

    // The requester answers in the same context — that IS the input.
    const answer = await fetch(`${server.baseUrl}/a2a/jsonrpc`, {
      method: "POST",
      headers: hubHeaders,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "ckpt-3",
        method: "SendMessage",
        params: { message: { parts: [{ text: "use branch release/1.2" }] }, metadata: { contextId } },
      }),
    });
    const answerBody = await answer.json();
    assert.equal(answerBody.result.task.status.state, "working", "context message must resume the task");

    // A plain paused checkpoint stays "working" (spec has no paused state),
    // and the explicit resume route clears it.
    await fetch(`${server.baseUrl}/tasks/${taskId}/checkpoint`, {
      method: "POST",
      headers: workerHeaders,
      body: JSON.stringify({ workerId: "worker-ckpt", state: "paused" }),
    });
    const paused = await (await fetch(`${server.baseUrl}/a2a/jsonrpc`, {
      method: "POST",
      headers: hubHeaders,
      body: JSON.stringify({ jsonrpc: "2.0", id: "ckpt-4", method: "GetTask", params: { taskId } }),
    })).json();
    assert.equal(paused.result.task.status.state, "working");
    const resume = await fetch(`${server.baseUrl}/tasks/${taskId}/resume`, {
      method: "POST",
      headers: workerHeaders,
      body: JSON.stringify({ actorId: "worker-ckpt" }),
    });
    assert.equal(resume.status, 200);
    const resumed = await resume.json();
    assert.equal(resumed.checkpoint, undefined);
  } finally {
    await server.close();
  }
});

test("default-agent mode: worker-less SendMessage produces a task driven to completed (A2A single-agent)", async () => {
  const server = await startTestServer({ defaultAgentMode: true, enforceRequesterIdentity: false });
  try {
    // TCK/httpx-style trailing-slash POST must hit the same endpoint.
    const send = await fetch(`${server.baseUrl}/a2a/jsonrpc/`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "da-1",
        method: "SendMessage",
        params: { message: { role: "ROLE_USER", parts: [{ text: "hello agent" }], messageId: "da-msg-1" } },
      }),
    });
    assert.equal(send.status, 200);
    const sendBody = await send.json();
    const taskId = sendBody.result?.task?.id;
    assert.ok(taskId, "worker-less SendMessage must create a task in default-agent mode");
    assert.equal(sendBody.result.task.metadata.targetNodeId, "default-agent");

    // The embedded agent drives the task to terminal.
    let finalState = "";
    for (let i = 0; i < 50; i++) {
      const get = await fetch(`${server.baseUrl}/a2a/jsonrpc`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "da-2", method: "GetTask", params: { taskId } }),
      });
      const body = await get.json();
      finalState = body.result?.task?.status?.state ?? "";
      if (finalState === "completed" || finalState === "failed") break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(finalState, "completed");
  } finally {
    await server.close();
  }
});

test("default-agent mode preserves explicit targetNodeId routing failures", async () => {
  const server = await startTestServer({ defaultAgentMode: true, enforceRequesterIdentity: false });
  try {
    const send = await fetch(`${server.baseUrl}/a2a/jsonrpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "da-explicit-missing",
        method: "SendMessage",
        params: {
          message: { parts: [{ text: "do not fallback" }] },
          metadata: { targetNodeId: "missing-worker" },
        },
      }),
    });
    const body = await send.json();
    assert.ok(body.error, "explicit missing target must fail instead of falling back to default-agent");
    assert.match(body.error.message, /target worker not found/);
    assert.notEqual(body.result?.task?.metadata?.targetNodeId, "default-agent");
  } finally {
    await server.close();
  }
});

test("SendMessage context resume requires task-party authorization (a2a-nexus#617 review)", async () => {
  const server = await startTestServer({ edgeSecret: "test-edge-secret" });
  try {
    await registerTestWorker(server.baseUrl, "worker-ctxrz", "analyst", "test-edge-secret");
    const hub = jsonHeaders({ "x-a2a-edge-secret": "test-edge-secret", "x-a2a-requester-id": "hub-a", "x-a2a-requester-role": "hub" });
    const worker = jsonHeaders({ "x-a2a-edge-secret": "test-edge-secret", "x-a2a-requester-id": "worker-ctxrz", "x-a2a-requester-role": "analyst" });

    const send = await (await fetch(`${server.baseUrl}/a2a/jsonrpc`, {
      method: "POST", headers: hub,
      body: JSON.stringify({ jsonrpc: "2.0", id: "ctxrz-1", method: "SendMessage", params: { message: { parts: [{ text: "needs input" }] }, metadata: { targetNodeId: "worker-ctxrz", intent: "analyze" } } }),
    })).json();
    const taskId = send.result.task.id;
    const contextId = send.result.contextId;
    await fetch(`${server.baseUrl}/tasks/${taskId}/claim`, { method: "POST", headers: worker, body: JSON.stringify({ workerId: "worker-ctxrz" }) });
    await fetch(`${server.baseUrl}/tasks/${taskId}/start`, { method: "POST", headers: worker, body: JSON.stringify({ workerId: "worker-ctxrz" }) });
    await fetch(`${server.baseUrl}/tasks/${taskId}/checkpoint`, { method: "POST", headers: worker, body: JSON.stringify({ workerId: "worker-ctxrz", state: "awaiting_operator", reason: "need input" }) });

    // A non-party requester who knows the contextId cannot auto-clear the
    // awaiting_operator checkpoint by messaging into the context.
    const stranger = jsonHeaders({ "x-a2a-edge-secret": "test-edge-secret", "x-a2a-requester-id": "intruder", "x-a2a-requester-role": "analyst" });
    const deniedBody = await (await fetch(`${server.baseUrl}/a2a/jsonrpc`, {
      method: "POST", headers: stranger,
      body: JSON.stringify({ jsonrpc: "2.0", id: "ctxrz-2", method: "SendMessage", params: { message: { parts: [{ text: "hijack resume" }] }, metadata: { contextId } } }),
    })).json();
    assert.ok(deniedBody.error, "non-party context message must not resume the task");

    // The checkpoint is still in force: the task remains input-required.
    const still = await (await fetch(`${server.baseUrl}/a2a/jsonrpc`, {
      method: "POST", headers: hub,
      body: JSON.stringify({ jsonrpc: "2.0", id: "ctxrz-3", method: "GetTask", params: { taskId } }),
    })).json();
    assert.equal(still.result.task.status.state, "input-required");

    // The original requester (a task party) resumes it with the same call.
    const resumedBody = await (await fetch(`${server.baseUrl}/a2a/jsonrpc`, {
      method: "POST", headers: hub,
      body: JSON.stringify({ jsonrpc: "2.0", id: "ctxrz-4", method: "SendMessage", params: { message: { parts: [{ text: "here is the input" }] }, metadata: { contextId } } }),
    })).json();
    assert.equal(resumedBody.result.task.status.state, "working", "party context message must resume the task");
  } finally {
    await server.close();
  }
});

test("explicit task resume requires task-party authorization (a2a-nexus#617 review)", async () => {
  const server = await startTestServer({ edgeSecret: "test-edge-secret" });
  try {
    await registerTestWorker(server.baseUrl, "worker-rz", "analyst", "test-edge-secret");
    const hub = jsonHeaders({ "x-a2a-edge-secret": "test-edge-secret", "x-a2a-requester-id": "hub-a", "x-a2a-requester-role": "hub" });
    const worker = jsonHeaders({ "x-a2a-edge-secret": "test-edge-secret", "x-a2a-requester-id": "worker-rz", "x-a2a-requester-role": "analyst" });

    const send = await (await fetch(`${server.baseUrl}/a2a/jsonrpc`, {
      method: "POST", headers: hub,
      body: JSON.stringify({ jsonrpc: "2.0", id: "rz", method: "SendMessage", params: { message: { parts: [{ text: "x" }] }, metadata: { targetNodeId: "worker-rz", intent: "analyze" } } }),
    })).json();
    const taskId = send.result.task.id;
    await fetch(`${server.baseUrl}/tasks/${taskId}/claim`, { method: "POST", headers: worker, body: JSON.stringify({ workerId: "worker-rz" }) });
    await fetch(`${server.baseUrl}/tasks/${taskId}/start`, { method: "POST", headers: worker, body: JSON.stringify({ workerId: "worker-rz" }) });
    await fetch(`${server.baseUrl}/tasks/${taskId}/checkpoint`, { method: "POST", headers: worker, body: JSON.stringify({ workerId: "worker-rz", state: "awaiting_operator" }) });

    // A stranger (analyst, not a party to this task) cannot resume it.
    const stranger = jsonHeaders({ "x-a2a-edge-secret": "test-edge-secret", "x-a2a-requester-id": "intruder", "x-a2a-requester-role": "analyst" });
    const denied = await fetch(`${server.baseUrl}/tasks/${taskId}/resume`, { method: "POST", headers: stranger, body: JSON.stringify({ actorId: "intruder" }) });
    assert.ok(denied.status >= 400, "non-party resume must be rejected");

    // checkpoint id mismatch is rejected for an authorized party.
    const mismatch = await fetch(`${server.baseUrl}/tasks/${taskId}/resume`, { method: "POST", headers: worker, body: JSON.stringify({ actorId: "worker-rz", checkpointId: "wrong" }) });
    assert.ok(mismatch.status >= 400, "checkpoint id mismatch must be rejected");

    // The assigned worker (a party) can resume.
    const ok = await fetch(`${server.baseUrl}/tasks/${taskId}/resume`, { method: "POST", headers: worker, body: JSON.stringify({ actorId: "worker-rz" }) });
    assert.equal(ok.status, 200);

    // Resuming a missing task is not_found.
    const missing = await fetch(`${server.baseUrl}/tasks/no-such-task/resume`, { method: "POST", headers: hub, body: JSON.stringify({ actorId: "hub-a" }) });
    assert.equal(missing.status, 404);
  } finally {
    await server.close();
  }
});

test("default-agent mode off keeps requiring a target worker for new contexts", async () => {
  const server = await startTestServer({ enforceRequesterIdentity: false });
  try {
    const send = await fetch(`${server.baseUrl}/a2a/jsonrpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "da-off-1",
        method: "SendMessage",
        params: {
          actor: { id: "client-x", kind: "service", role: "hub" },
          message: { parts: [{ text: "no agent" }] },
        },
      }),
    });
    const body = await send.json();
    assert.ok(body.error, "without the default agent a worker-less send must fail");
    assert.match(body.error.message, /targetNodeId is required/);
  } finally {
    await server.close();
  }
});

test("explicit A2A-Version negotiation returns spec result shapes; legacy clients keep envelopes", async () => {
  const server = await startTestServer({ edgeSecret: "test-edge-secret" });
  try {
    await registerTestWorker(server.baseUrl, "worker-shape", "analyst", "test-edge-secret");
    const baseHeaders = jsonHeaders({
      "x-a2a-edge-secret": "test-edge-secret",
      "x-a2a-requester-id": "hub-a",
      "x-a2a-requester-role": "hub",
    });
    const sendParams = {
      message: { parts: [{ text: "shape probe" }] },
      metadata: { targetNodeId: "worker-shape", intent: "analyze" },
    };

    // Spec shape: result IS the Task, with top-level contextId and no wrapper.
    const spec = await fetch(`${server.baseUrl}/a2a/jsonrpc`, {
      method: "POST",
      headers: { ...baseHeaders, "a2a-version": "1.0" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "shape-1", method: "SendMessage", params: sendParams }),
    });
    const specBody = await spec.json();
    // SendMessageResponse is a oneof wrapper: { task } here.
    assert.ok(specBody.result.task, "spec SendMessage result is the { task } oneof");
    assert.equal("messageId" in specBody.result, false, "no legacy wrapper fields");
    assert.equal("contextId" in specBody.result, false, "contextId lives on the Task");
    const specTask = specBody.result.task;
    assert.ok(typeof specTask.contextId === "string");
    assert.equal("kind" in specTask, false, "proto Task has no kind discriminator");
    assert.equal(specTask.status.state, "TASK_STATE_SUBMITTED");
    const taskId = specTask.id;

    // GetTask returns the Task directly per the proto service contract.
    const specGet = await fetch(`${server.baseUrl}/a2a/jsonrpc`, {
      method: "POST",
      headers: { ...baseHeaders, "a2a-version": "1.0" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "shape-2", method: "GetTask", params: { taskId } }),
    });
    const specGetBody = await specGet.json();
    assert.equal(specGetBody.result.id, taskId);
    assert.equal(specGetBody.result.contextId, specTask.contextId);
    assert.equal("task" in specGetBody.result, false, "GetTask spec result is the bare Task");

    // Legacy shape (no header): historical envelopes, byte-compatible.
    const legacy = await fetch(`${server.baseUrl}/a2a/jsonrpc`, {
      method: "POST",
      headers: baseHeaders,
      body: JSON.stringify({ jsonrpc: "2.0", id: "shape-3", method: "GetTask", params: { taskId } }),
    });
    const legacyBody = await legacy.json();
    assert.ok(legacyBody.result.task, "legacy GetTask keeps the { task } envelope");
    assert.equal(legacyBody.result.task.id, taskId);
  } finally {
    await server.close();
  }
});

test("spec response shape covers ListTasks, CancelTask, context-only send, and default-agent (a2a-nexus#615 review)", async () => {
  const server = await startTestServer({ edgeSecret: "test-edge-secret", defaultAgentMode: true });
  try {
    await registerTestWorker(server.baseUrl, "worker-s2", "analyst", "test-edge-secret");
    const hub = { ...jsonHeaders({ "x-a2a-edge-secret": "test-edge-secret", "x-a2a-requester-id": "hub-a", "x-a2a-requester-role": "hub" }), "a2a-version": "1.0" };
    const rpc = (method: string, params: unknown, id = "s") =>
      fetch(`${server.baseUrl}/a2a/jsonrpc`, { method: "POST", headers: hub, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) }).then((r) => r.json());

    const send = await rpc("SendMessage", { message: { parts: [{ text: "x" }] }, metadata: { targetNodeId: "worker-s2", intent: "analyze" } }, "s1");
    const taskId = send.result.task.id;
    const contextId = send.result.task.contextId;

    // ListTasks spec items are proto Tasks (top-level contextId, enum state, no kind),
    // and ListTasksResponse carries the REQUIRED pagination fields.
    const list = await rpc("ListTasks", { contextId }, "s2");
    assert.ok(Array.isArray(list.result.tasks));
    assert.equal(list.result.nextPageToken, "", "single-page response has an empty nextPageToken");
    assert.equal(list.result.pageSize, list.result.tasks.length);
    assert.equal(list.result.totalSize, list.result.tasks.length);
    const item = list.result.tasks.find((t: { id: string }) => t.id === taskId);
    assert.ok(item, "task visible in spec ListTasks");
    assert.equal("kind" in item, false);
    assert.ok(typeof item.contextId === "string");
    assert.match(item.status.state, /^TASK_STATE_/);

    // Context-only SendMessage (append to an existing context) -> Message oneof.
    const ctxSend = await rpc("SendMessage", { message: { parts: [{ text: "follow-up" }] }, metadata: { contextId } }, "s3");
    // For a context with an active task this returns { task }; assert it's a valid oneof either way.
    assert.ok(ctxSend.result.task || ctxSend.result.message, "context send returns a task or message oneof");

    // CancelTask spec -> bare Task.
    const cancel = await rpc("CancelTask", { taskId, actor: { id: "hub-a", kind: "node", role: "hub" } }, "s4");
    assert.equal(cancel.result.id, taskId);
    assert.match(cancel.result.status.state, /^TASK_STATE_/);
    assert.equal("task" in cancel.result, false, "CancelTask spec result is the bare Task");
  } finally {
    await server.close();
  }
});

test("spec Task projects proto Artifacts (artifactId + parts), not the legacy { id } shape (a2a-nexus#615 review)", async () => {
  const server = await startTestServer({ edgeSecret: "test-edge-secret" });
  try {
    await registerTestWorker(server.baseUrl, "worker-art", "analyst", "test-edge-secret");
    const hub = jsonHeaders({ "x-a2a-edge-secret": "test-edge-secret", "x-a2a-requester-id": "hub-a", "x-a2a-requester-role": "hub" });
    const worker = jsonHeaders({ "x-a2a-edge-secret": "test-edge-secret", "x-a2a-requester-id": "worker-art", "x-a2a-requester-role": "analyst" });

    // A resolvable artifact record (uri/contentType/summary) via a proposal.
    const proposalRes = await fetch(`${server.baseUrl}/proposals`, {
      method: "POST",
      headers: jsonHeaders({ "x-a2a-edge-secret": "test-edge-secret", "x-a2a-requester-id": "worker-art", "x-a2a-requester-role": "analyst" }),
      body: JSON.stringify({
        source: { id: "worker-art", kind: "node", role: "analyst" },
        target: { id: "hub-a", kind: "node", role: "hub" },
        kind: "patch",
        summary: "artifact projection probe",
        workspace: { nodeId: "hub-a", workspaceId: "ws-art" },
        patchText: "diff --git a/x b/x",
      }),
    });
    assert.equal(proposalRes.status, 201);
    const proposal = await proposalRes.json();
    const artifactRes = await fetch(`${server.baseUrl}/proposals/${proposal.id}/artifacts`, {
      method: "POST",
      headers: jsonHeaders({ "x-a2a-edge-secret": "test-edge-secret", "x-a2a-requester-id": "worker-art", "x-a2a-requester-role": "analyst" }),
      body: JSON.stringify({ kind: "report", uri: "file:///tmp/report.md", contentType: "text/markdown", summary: "analysis report" }),
    });
    assert.equal(artifactRes.status, 201);
    const artifact = await artifactRes.json();

    // Drive a task to completion carrying both a resolvable and a dangling artifact id.
    const send = await (await fetch(`${server.baseUrl}/a2a/jsonrpc`, {
      method: "POST", headers: hub,
      body: JSON.stringify({ jsonrpc: "2.0", id: "art-1", method: "SendMessage", params: { message: { parts: [{ text: "produce artifacts" }] }, metadata: { targetNodeId: "worker-art", intent: "analyze" } } }),
    })).json();
    const taskId = send.result.task.id;
    await fetch(`${server.baseUrl}/tasks/${taskId}/claim`, { method: "POST", headers: worker, body: JSON.stringify({ workerId: "worker-art" }) });
    await fetch(`${server.baseUrl}/tasks/${taskId}/complete`, {
      method: "POST", headers: worker,
      body: JSON.stringify({ workerId: "worker-art", result: { summary: "done", artifactIds: [artifact.id, "art-dangling"] } }),
    });

    const specGet = await (await fetch(`${server.baseUrl}/a2a/jsonrpc`, {
      method: "POST", headers: { ...hub, "a2a-version": "1.0" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "art-2", method: "GetTask", params: { taskId } }),
    })).json();
    const artifacts = specGet.result.artifacts as Array<Record<string, unknown>>;
    assert.equal(artifacts.length, 2);
    for (const a of artifacts) {
      assert.equal("id" in a, false, "spec Artifact must not carry the legacy id key");
      assert.ok(typeof a.artifactId === "string" && a.artifactId.length > 0);
      assert.ok(Array.isArray(a.parts) && a.parts.length >= 1, "proto Artifact.parts is REQUIRED with >=1 part");
    }
    const resolved = artifacts.find((a) => a.artifactId === artifact.id);
    assert.ok(resolved, "resolvable artifact projected");
    const part = (resolved!.parts as Array<Record<string, unknown>>)[0];
    assert.equal(part.url, "file:///tmp/report.md");
    assert.equal(part.mediaType, "text/markdown");
    assert.equal(resolved!.name, "report");
    assert.equal(resolved!.description, "analysis report");
    const dangling = artifacts.find((a) => a.artifactId === "art-dangling");
    assert.ok(dangling, "dangling artifact id still projects a valid proto Artifact");

    // Legacy clients keep the historical { id } shape untouched.
    const legacyGet = await (await fetch(`${server.baseUrl}/a2a/jsonrpc`, {
      method: "POST", headers: hub,
      body: JSON.stringify({ jsonrpc: "2.0", id: "art-3", method: "GetTask", params: { taskId } }),
    })).json();
    assert.deepEqual(legacyGet.result.task.artifacts.map((a: { id: string }) => a.id).sort(), [artifact.id, "art-dangling"].sort());
  } finally {
    await server.close();
  }
});

test("default-agent worker-less send + spec header returns the proto task oneof (a2a-nexus#615 review)", async () => {
  const server = await startTestServer({ defaultAgentMode: true, enforceRequesterIdentity: false });
  try {
    const res = await fetch(`${server.baseUrl}/a2a/jsonrpc`, {
      method: "POST",
      headers: { "content-type": "application/json", "a2a-version": "1.0" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "da-spec", method: "SendMessage", params: { message: { role: "ROLE_USER", parts: [{ text: "hi" }], messageId: "m1" } } }),
    });
    const body = await res.json();
    assert.ok(body.result.task, "worker-less spec send returns the { task } oneof");
    assert.ok(typeof body.result.task.contextId === "string");
    assert.match(body.result.task.status.state, /^TASK_STATE_/);
  } finally {
    await server.close();
  }
});

test("cross-broker receiver enforces request-bound proof of possession when anchors are pinned", async () => {
  const { generateKeyPairSync } = await import("node:crypto");
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { buildCrossBrokerSenderProof } = await import("./a2a/cross-broker-sender-proof.js");

  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const dir = mkdtempSync(join(tmpdir(), "a2a-xbroker-trust-"));
  const anchorsFile = join(dir, "anchors.json");
  writeFileSync(
    anchorsFile,
    JSON.stringify({ "peer-a": publicKey.export({ type: "spki", format: "pem" }).toString() }),
  );

  const server = await startTestServer({
    edgeSecret: "test-edge-secret",
    crossBrokerSenderProofKeysFile: anchorsFile,
  });
  try {
    const headers = jsonHeaders({
      "x-a2a-edge-secret": "test-edge-secret",
      "x-a2a-requester-id": "hub-a",
      "x-a2a-requester-role": "hub",
    });
    const body = { crossBrokerHandoff: { handoffBrokerId: "peer-a" }, parentRoundId: "r-trust" };

    // No proof -> fail closed before ingestion.
    const rejected = await fetch(`${server.baseUrl}/a2a/cross-broker/terminal-briefs`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    assert.ok(rejected.status >= 400);
    assert.match(JSON.stringify(await rejected.json()), /cross-broker trust/);

    // A fresh body-bound proof clears the trust gate (any further response is
    // ingestion-level validation, not a trust rejection).
    const proof = buildCrossBrokerSenderProof(
      privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      { brokerId: "peer-a", body, nonce: `n-${Date.now()}` },
    );
    const passed = await fetch(`${server.baseUrl}/a2a/cross-broker/terminal-briefs`, {
      method: "POST",
      headers,
      body: JSON.stringify({ ...body, senderProof: proof }),
    });
    assert.ok(
      !JSON.stringify(await passed.json()).includes("cross-broker trust"),
      "a valid proof must clear the trust gate",
    );
  } finally {
    await server.close();
  }
});

test("push notification config CRUD over JSON-RPC when enabled (A2A 1.0)", async () => {
  const server = await startTestServer({ pushNotificationsEnabled: true, enforceRequesterIdentity: false });
  try {
    await registerTestWorker(server.baseUrl, "worker-push", "analyst", undefined);
    const headers = jsonHeaders({});
    const rpc = (method: string, params: unknown, id = "p") =>
      fetch(`${server.baseUrl}/a2a/jsonrpc`, {
        method: "POST",
        headers,
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      }).then((r) => r.json());

    // Card advertises the capability.
    const card = await (await fetch(`${server.baseUrl}/.well-known/agent-card.json`)).json();
    assert.equal(card.capabilities.pushNotifications, true);

    // A real task is required — config ops are authorized against it.
    const send = await rpc("SendMessage", { actor: { id: "hub-a", kind: "node", role: "hub" }, message: { parts: [{ text: "x" }] }, metadata: { targetNodeId: "worker-push", intent: "analyze" } }, "mk");
    const pushTaskId = send.result.task.id;

    const invalidAuth = await rpc("CreateTaskPushNotificationConfig", {
      taskId: pushTaskId,
      url: "https://example.com/invalid-auth",
      authentication: "Bearer",
    });
    assert.ok(invalidAuth.error, "malformed authentication must fail instead of creating a weaker config");
    const afterInvalidAuth = await rpc("ListTaskPushNotificationConfigs", { taskId: pushTaskId }, "after-invalid-auth");
    assert.equal(afterInvalidAuth.result.configs.length, 0, "malformed auth input must not mutate the store");

    // Operations on a non-existent task fail closed.
    const noTask = await rpc("CreateTaskPushNotificationConfig", { taskId: "no-such-task", url: "https://x.example" });
    assert.ok(noTask.error, "config ops require the task to exist");

    const created = await rpc("CreateTaskPushNotificationConfig", {
      taskId: pushTaskId,
      url: "https://example.com/tck-webhook",
      token: "super-secret-token",
      authentication: { schemes: ["Bearer"], credentials: "secret-cred" },
    });
    assert.equal(created.result.taskId, pushTaskId);
    assert.equal(created.result.token, "[redacted]", "create response keeps token write-only");
    assert.equal(created.result.authentication.credentials, "[redacted]", "create response keeps auth credentials write-only");
    assert.ok(!JSON.stringify(created).includes("super-secret-token"));
    assert.ok(!JSON.stringify(created).includes("secret-cred"));
    const configId = created.result.id;

    // Reads redact delivery secrets.
    const got = await rpc("GetTaskPushNotificationConfig", { taskId: pushTaskId, id: configId });
    assert.equal(got.result.id, configId);
    assert.equal(got.result.token, "[redacted]");
    assert.equal(got.result.authentication.credentials, "[redacted]");
    assert.ok(!JSON.stringify(got.result).includes("super-secret-token"));
    assert.ok(!JSON.stringify(got.result).includes("secret-cred"));

    const listed = await rpc("ListTaskPushNotificationConfigs", { taskId: pushTaskId });
    assert.equal(listed.result.configs.length, 1);
    assert.ok(!JSON.stringify(listed.result).includes("super-secret-token"));

    const deleted = await rpc("DeleteTaskPushNotificationConfig", { taskId: pushTaskId, id: configId });
    assert.ok(!("error" in deleted));
    const missing = await rpc("GetTaskPushNotificationConfig", { taskId: pushTaskId, id: configId });
    assert.ok(missing.error, "deleted config no longer retrievable");
  } finally {
    await server.close();
  }
});

test("push notification configs survive broker restart for retained tasks (a2a-nexus#647)", async () => {
  const stateStore = createInMemoryStateStore();
  let server = await startTestServer({
    stateStore,
    pushNotificationsEnabled: true,
    enforceRequesterIdentity: false,
  });
  let taskId = "";
  let configId = "";
  try {
    await registerTestWorker(server.baseUrl, "worker-push-restart", "analyst", undefined);
    const headers = jsonHeaders({});
    const rpc = (method: string, params: unknown, id = "pr") =>
      fetch(`${server.baseUrl}/a2a/jsonrpc`, {
        method: "POST",
        headers,
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      }).then((r) => r.json());

    const sent = await rpc(
      "SendMessage",
      { actor: { id: "hub-a", kind: "node", role: "hub" }, message: { parts: [{ text: "x" }] }, metadata: { targetNodeId: "worker-push-restart", intent: "analyze" } },
      "mk-restart",
    );
    taskId = sent.result.task.id;
    const created = await rpc("CreateTaskPushNotificationConfig", {
      taskId,
      id: "cfg-restart",
      url: "https://example.com/restart-hook",
      token: "restart-secret-token",
      authentication: { schemes: ["Bearer"], credentials: "restart-secret-cred" },
    });
    assert.equal(created.result.id, "cfg-restart");
    configId = created.result.id;
  } finally {
    await server.close();
  }

  server = await startTestServer({
    stateStore,
    pushNotificationsEnabled: true,
    enforceRequesterIdentity: false,
  });
  try {
    const got = await (await fetch(`${server.baseUrl}/a2a/jsonrpc`, {
      method: "POST",
      headers: jsonHeaders({}),
      body: JSON.stringify({ jsonrpc: "2.0", id: "pr-get", method: "GetTaskPushNotificationConfig", params: { taskId, id: configId } }),
    })).json();
    assert.equal(got.result?.id, configId);
    assert.equal(got.result?.url, "https://example.com/restart-hook");
    assert.equal(got.result?.token, "[redacted]", "raw token remains write-only after restart");
    assert.equal(got.result?.authentication?.credentials, "[redacted]");
    assert.ok(!JSON.stringify(got).includes("restart-secret"), "restart read must not leak raw delivery secrets");

    const deleted = await (await fetch(`${server.baseUrl}/a2a/jsonrpc`, {
      method: "POST",
      headers: jsonHeaders({}),
      body: JSON.stringify({ jsonrpc: "2.0", id: "pr-delete", method: "DeleteTaskPushNotificationConfig", params: { taskId, id: configId } }),
    })).json();
    assert.ok(!deleted.error, "delete after restart succeeds and persists through the current store instance");
  } finally {
    await server.close();
  }

  server = await startTestServer({
    stateStore,
    pushNotificationsEnabled: true,
    enforceRequesterIdentity: false,
  });
  try {
    const missing = await (await fetch(`${server.baseUrl}/a2a/jsonrpc`, {
      method: "POST",
      headers: jsonHeaders({}),
      body: JSON.stringify({ jsonrpc: "2.0", id: "pr-missing", method: "GetTaskPushNotificationConfig", params: { taskId, id: configId } }),
    })).json();
    assert.ok(missing.error, "deleted config must not resurrect on a second restart with the same state store");
    assert.ok(!JSON.stringify(missing).includes("restart-secret"));
  } finally {
    await server.close();
  }
});

test("push notification methods are absent when the feature is disabled", async () => {
  const server = await startTestServer();
  try {
    const card = await (await fetch(`${server.baseUrl}/.well-known/agent-card.json`)).json();
    assert.equal(card.capabilities.pushNotifications, false);
    const resp = await fetch(`${server.baseUrl}/a2a/jsonrpc`, {
      method: "POST",
      headers: jsonHeaders({}),
      body: JSON.stringify({ jsonrpc: "2.0", id: "p", method: "CreateTaskPushNotificationConfig", params: { taskId: "t", url: "https://x.example" } }),
    });
    const body = await resp.json();
    assert.ok(body.error, "disabled broker must not accept push config methods");
    // Disabled mode means the methods are absent from the surface entirely:
    // JSON-RPC method-not-found, exactly like other extension-gated methods.
    assert.equal(body.error.code, -32601);
    assert.match(body.error.message, /method not found/);
  } finally {
    await server.close();
  }
});

test("disabled push notifications with supplied broker do not force state-store load", async () => {
  const broker = new InMemoryA2ABroker();
  const stateStore = {
    load() {
      throw new Error("state store load should not be called for disabled push notifications with a supplied broker");
    },
    save() {
      throw new Error("state store save should not be called by an idle supplied broker server");
    },
  };
  const server = await startTestServer({ broker, stateStore, pushNotificationsEnabled: false });
  try {
    const card = await (await fetch(`${server.baseUrl}/.well-known/agent-card.json`)).json();
    assert.equal(card.capabilities.pushNotifications, false);
  } finally {
    await server.close();
  }
});

test("push notification sidecar attaches to supplied broker snapshots", async () => {
  const stateStore = createInMemoryStateStore();
  const broker = new InMemoryA2ABroker(stateStore);
  const server = await startTestServer({
    broker,
    stateStore,
    pushNotificationsEnabled: true,
    enforceRequesterIdentity: false,
  });
  try {
    await registerTestWorker(server.baseUrl, "worker-push-custom", "analyst", undefined);
    const headers = jsonHeaders({});
    const rpc = (method: string, params: unknown, id = "pc") =>
      fetch(`${server.baseUrl}/a2a/jsonrpc`, {
        method: "POST",
        headers,
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      }).then((r) => r.json());

    const sent = await rpc(
      "SendMessage",
      { actor: { id: "hub-a", kind: "node", role: "hub" }, message: { parts: [{ text: "x" }] }, metadata: { targetNodeId: "worker-push-custom", intent: "analyze" } },
      "pc-mk",
    );
    const taskId = sent.result.task.id;
    const created = await rpc("CreateTaskPushNotificationConfig", {
      taskId,
      id: "cfg-custom-broker",
      url: "https://example.com/custom-broker-hook",
      token: "custom-broker-secret-token",
    });
    assert.equal(created.result?.token, "[redacted]");
    assert.deepEqual(broker.exportSnapshot().pushNotificationConfigs?.map((config) => config.id), ["cfg-custom-broker"]);
  } finally {
    await server.close();
  }
});

test("push config CRUD enforces task-party authorization and never leaks secrets (a2a-nexus#620 review)", async () => {
  const server = await startTestServer({ pushNotificationsEnabled: true, edgeSecret: "test-edge-secret" });
  try {
    await registerTestWorker(server.baseUrl, "worker-pauth", "analyst", "test-edge-secret");
    const hub = jsonHeaders({ "x-a2a-edge-secret": "test-edge-secret", "x-a2a-requester-id": "hub-a", "x-a2a-requester-role": "hub" });
    const stranger = jsonHeaders({ "x-a2a-edge-secret": "test-edge-secret", "x-a2a-requester-id": "intruder", "x-a2a-requester-role": "analyst" });
    const rpc = (headers: Record<string, string>, method: string, params: unknown, id = "pa") =>
      fetch(`${server.baseUrl}/a2a/jsonrpc`, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) }).then((r) => r.json());

    const send = await rpc(hub, "SendMessage", { message: { parts: [{ text: "x" }] }, metadata: { targetNodeId: "worker-pauth", intent: "analyze" } }, "pa-mk");
    const taskId = send.result.task.id;
    const created = await rpc(hub, "CreateTaskPushNotificationConfig", {
      taskId,
      url: "https://example.com/hook",
      token: "party-secret-token",
      authentication: { schemes: ["Bearer"], credentials: "party-secret-cred" },
    });
    assert.ok(created.result?.id, "task party can create a config");
    assert.equal(created.result.token, "[redacted]", "authorized create keeps token write-only");
    assert.equal(created.result.authentication.credentials, "[redacted]", "authorized create keeps auth credentials write-only");
    assert.ok(!JSON.stringify(created).includes("party-secret"), "create response must not leak raw delivery secrets");
    const configId = created.result.id;

    // A non-party requester is denied on all four operations, and no
    // response ever carries the raw secrets.
    const deniedCreate = await rpc(stranger, "CreateTaskPushNotificationConfig", { taskId, url: "https://evil.example" });
    assert.ok(deniedCreate.error, "non-party create denied");
    const deniedGet = await rpc(stranger, "GetTaskPushNotificationConfig", { taskId, id: configId });
    assert.ok(deniedGet.error, "non-party get denied");
    assert.ok(!JSON.stringify(deniedGet).includes("party-secret"), "denied get must not leak secrets");
    const deniedList = await rpc(stranger, "ListTaskPushNotificationConfigs", { taskId });
    assert.ok(deniedList.error, "non-party list denied");
    assert.ok(!JSON.stringify(deniedList).includes("party-secret"), "denied list must not leak secrets");
    const deniedDelete = await rpc(stranger, "DeleteTaskPushNotificationConfig", { taskId, id: configId });
    assert.ok(deniedDelete.error, "non-party delete denied");
    const stillThere = await rpc(hub, "GetTaskPushNotificationConfig", { taskId, id: configId });
    assert.equal(stillThere.result?.id, configId, "denied delete must not remove the config");

    // Authorized reads stay redacted: even a party never reads raw secrets back.
    assert.equal(stillThere.result.token, "[redacted]");
    assert.ok(!JSON.stringify(stillThere).includes("party-secret"));

    // TCK wire form: the official JSON-RPC client sends proto field names
    // (task_id); the methods accept it as an alias for taskId.
    const viaSnake = await rpc(hub, "ListTaskPushNotificationConfigs", { task_id: taskId });
    assert.equal(viaSnake.result?.configs?.length, 1, "task_id (TCK wire form) accepted");
    assert.equal(viaSnake.result.nextPageToken, "", "proto list response carries nextPageToken");
  } finally {
    await server.close();
  }
});
