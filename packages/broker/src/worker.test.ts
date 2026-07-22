import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { once } from "node:events";

import { emptySnapshot, type BrokerStateStore } from "./core/store.js";
import { createBrokerServer, type BrokerServerOptions } from "./server.js";
import { A2ABrokerWorker, buildDynamicSubagentRuntime, createExternalWorkerHandler, createWorkerConfigFromEnv, type BrokerWorkerConfig } from "./worker.js";
import { verifyA2AHttpSignature, type A2AHttpSignatureKeyRegistry } from "./core/request-security.js";

function createInMemoryStateStore(): BrokerStateStore {
  let snapshot = emptySnapshot();
  return {
    load() {
      return snapshot;
    },
    save(nextSnapshot) {
      snapshot = structuredClone(nextSnapshot);
    },
  };
}

async function startTestServer(options: Partial<BrokerServerOptions> = {}) {
  const runtime = createBrokerServer({
    host: "127.0.0.1",
    port: 0,
    publicBaseUrl: "https://broker.test/",
    stateStore: createInMemoryStateStore(),
    enforceRequesterIdentity: true,
    rateLimitMaxRequests: 100,
    ...options,
  });
  runtime.server.listen(0, "127.0.0.1");
  await once(runtime.server, "listening");
  const address = runtime.server.address();
  if (!address || typeof address === "string") {
    throw new Error("failed to bind test server");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      runtime.server.close();
      await once(runtime.server, "close");
    },
  };
}

const workerSignaturePrivateJwk = {
  crv: "Ed25519",
  d: "AaTuhLv-jaClRWi80aTnBCH7OaqKDTRI1-BhVY6n8hw",
  x: "5WS0NM-6IqCFjg6O1otAWtJV2H-1kdybf7nFp4PEzdY",
  kty: "OKP",
} as const;

const workerSignaturePublicJwk = {
  crv: "Ed25519",
  x: "5WS0NM-6IqCFjg6O1otAWtJV2H-1kdybf7nFp4PEzdY",
  kty: "OKP",
} as const;

const workerSignatureKeyRegistry: A2AHttpSignatureKeyRegistry = {
  "worker:worker-a:v1": {
    keyid: "worker:worker-a:v1",
    workerId: "worker-a",
    publicKeyJwk: workerSignaturePublicJwk,
  },
};

async function createBrokerSigningKeyFile(): Promise<string> {
  const { privateKey } = generateKeyPairSync("ed25519");
  const dir = await mkdtemp(join(tmpdir(), "a2a-worker-broker-signing-"));
  const keyFile = join(dir, "broker-signing.pem");
  await writeFile(keyFile, privateKey.export({ type: "pkcs8", format: "pem" }));
  return keyFile;
}

function createWorker(baseUrl: string, options: { edgeSecret?: string; homeBrokerId?: string; homeBrokerLeaseFile?: string; httpSignature?: BrokerWorkerConfig["httpSignature"] } = {}) {
  return new A2ABrokerWorker({
    brokerUrl: baseUrl,
    edgeSecret: options.edgeSecret,
    homeBrokerId: options.homeBrokerId,
    homeBrokerLeaseFile: options.homeBrokerLeaseFile,
    httpSignature: options.httpSignature,
    requesterKind: "node",
    pollIntervalMs: 25,
    heartbeatIntervalMs: 25,
    handlerTimeoutMs: 1_000,
    userAgent: "a2a-broker-worker-test",
    handler: async (task) => ({
      result: {
        summary: `echo ${task.intent}`,
        output: {
          taskId: task.id,
          message: task.message,
          payload: task.payload,
        },
      },
    }),
    worker: {
      nodeId: "worker-a",
      role: "analyst",
      displayName: "Worker A",
      capabilities: {
        canAnalyze: true,
        canBackfill: false,
        canPatchWorkspace: false,
        canPromoteLive: false,
        workspaceIds: ["test"],
        environments: ["research"],
      },
      metadata: { lane: "test" },
    },
  });
}

async function createTask(baseUrl: string, body: Record<string, unknown>) {
  const response = await fetch(`${baseUrl}/tasks`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-a2a-requester-id": "hub-a",
      "x-a2a-requester-role": "hub",
      "x-a2a-requester-kind": "node",
    },
    body: JSON.stringify(body),
  });
  assert.equal(response.status, 201);
  return response.json();
}

test("worker registers, heartbeats, polls queued work, and completes tasks", async () => {
  const server = await startTestServer();
  const worker = createWorker(server.baseUrl);

  try {
    const registered = await worker.register();
    assert.equal(registered.nodeId, "worker-a");
    assert.equal(registered.status, "online");

    const beforeHeartbeat = await worker.getWorker();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const heartbeat = await worker.heartbeat();
    assert.equal(heartbeat.nodeId, "worker-a");

    const afterHeartbeat = await worker.getWorker();
    assert.equal(afterHeartbeat.status, "online");
    assert.ok(Date.parse(afterHeartbeat.lastSeenAt) >= Date.parse(beforeHeartbeat.lastSeenAt));

    const task = await createTask(server.baseUrl, {
      intent: "analyze",
      requester: { id: "hub-a", kind: "node", role: "hub" },
      target: { id: "worker-a", kind: "node", role: "analyst" },
      assignedWorkerId: "worker-a",
      message: "run echo",
      payload: { hello: "world" },
    });

    const queued = await worker.pollQueuedTasks();
    assert.equal(queued.length, 1);
    assert.equal(queued[0].id, task.id);

    const processed = await worker.runOnce();
    assert.equal(processed, 1);

    const taskResponse = await fetch(`${server.baseUrl}/tasks/${task.id}`);
    assert.equal(taskResponse.status, 200);
    const completedTask = await taskResponse.json();

    assert.equal(completedTask.status, "succeeded");
    assert.equal(completedTask.claimedBy, "worker-a");
    assert.equal(completedTask.result.summary, "echo analyze");
    assert.equal(completedTask.result.output.message, "run echo");
    assert.deepEqual(completedTask.result.output.payload, { hello: "world" });

    const auditResponse = await fetch(`${server.baseUrl}/audit`);
    const audit = await auditResponse.json();
    const actions = new Set(audit.items.map((item: { action: string }) => item.action));
    assert.ok(actions.has("worker.registered"));
    assert.ok(actions.has("task.claimed"));
    assert.ok(actions.has("task.started"));
    assert.ok(actions.has("task.succeeded"));
  } finally {
    await worker.stop();
    await server.close();
  }
});

test("worker with HTTP signature key emits signed result provenance and broker stores countersignature", async () => {
  const server = await startTestServer({
    brokerId: "brokeralpha",
    enforceRequesterIdentity: false,
    a2aHttpSignatureWorkerAuth: "strict",
    a2aHttpSignatureKeyRegistry: workerSignatureKeyRegistry,
    agentCardSigningKeyFile: await createBrokerSigningKeyFile(),
    agentCardSigningKid: "broker:brokeralpha:v1",
  });
  const worker = createWorker(server.baseUrl, {
    httpSignature: {
      keyid: "worker:worker-a:v1",
      privateKeyJwk: workerSignaturePrivateJwk,
      brokerId: "brokeralpha",
      nonceFactory: (() => {
        let nonce = 0;
        return () => `worker-provenance-${++nonce}`;
      })(),
    },
  });

  try {
    await worker.register();
    const task = await createTask(server.baseUrl, {
      id: "worker-signed-provenance-task",
      intent: "analyze",
      requester: { id: "hub-a", kind: "node", role: "hub" },
      target: { id: "worker-a", kind: "node", role: "analyst" },
      assignedWorkerId: "worker-a",
      message: "run signed provenance echo",
    });

    const processed = await worker.runOnce();
    assert.equal(processed, 1);

    const taskResponse = await fetch(`${server.baseUrl}/tasks/${task.id}`);
    assert.equal(taskResponse.status, 200);
    const completedTask = await taskResponse.json();
    assert.equal(completedTask.status, "succeeded");
    assert.equal(completedTask.result.provenance.workerKeyId, "worker:worker-a:v1");
    assert.equal(completedTask.result.provenance.brokerCountersig.brokerKeyId, "broker:brokeralpha:v1");
    assert.equal(completedTask.result.provenance.claimedAt, completedTask.claimedAt);
  } finally {
    await worker.stop();
    await server.close();
  }
});

test("worker lifecycle routes decode URL-encoded task ids containing reserved characters", async () => {
  const server = await startTestServer();
  const worker = createWorker(server.baseUrl);
  try {
    await worker.register();
    await worker.heartbeat();

    const taskId = "gh:acme/platform#42";
    const task = await createTask(server.baseUrl, {
      id: taskId,
      intent: "analyze",
      requester: { id: "hub-a", kind: "node", role: "hub" },
      target: { id: "worker-a", kind: "node", role: "analyst" },
      assignedWorkerId: "worker-a",
      message: "run encoded-id echo",
      payload: { hello: "encoded id" },
    });

    const queued = await worker.pollQueuedTasks();
    assert.equal(queued.length, 1);
    assert.equal(queued[0].id, task.id);

    const processed = await worker.runOnce();
    assert.equal(processed, 1);

    const taskResponse = await fetch(`${server.baseUrl}/tasks/${encodeURIComponent(taskId)}`);
    assert.equal(taskResponse.status, 200);
    const completedTask = await taskResponse.json();
    assert.equal(completedTask.id, taskId);
    assert.equal(completedTask.status, "succeeded");
    assert.equal(completedTask.claimedBy, "worker-a");
  } finally {
    await worker.stop();
    await server.close();
  }
});

test("server rejects malformed URL path encoding without crashing", async () => {
  const server = await startTestServer();
  try {
    const response = await fetch(`${server.baseUrl}/tasks/%`);
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.error.code, "bad_request");
    assert.equal(body.error.message, "invalid URL path encoding");
  } finally {
    await server.close();
  }
});

test("verifyPollReadiness resolves when the assigned-task poll path is reachable (#691)", async () => {
  const server = await startTestServer();
  const worker = createWorker(server.baseUrl);
  try {
    await worker.register();
    await assert.doesNotReject(() => worker.verifyPollReadiness());
  } finally {
    await server.close();
  }
});

test("run() fails closed at startup when register/heartbeat pass but the poll path is blocked (#691)", async () => {
  // register + heartbeat succeed; only the assigned-task poll is blocked, which is
  // exactly the silent-idle failure mode the readiness probe is meant to catch.
  const fetchImpl = async (input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
    const url = input instanceof URL ? input : new URL(String(input));
    const method = init?.method ?? "GET";
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (method === "POST" && url.pathname === "/workers/register") {
      return json(201, { nodeId: "worker-a", role: "analyst", status: "online", capabilities: { canAnalyze: true }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lastSeenAt: new Date().toISOString() });
    }
    if (method === "POST" && url.pathname.endsWith("/heartbeat")) {
      return json(200, { nodeId: "worker-a", role: "analyst", status: "online", capabilities: { canAnalyze: true }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lastSeenAt: new Date().toISOString() });
    }
    if (method === "GET" && url.pathname === "/tasks") {
      return json(403, { error: { code: "policy_denied", message: "edge blocked the poll path" } });
    }
    return json(404, { error: { code: "not_found", message: url.pathname } });
  };
  const worker = createWorker("https://broker.test");
  (worker as unknown as { fetchImpl: typeof fetchImpl }).fetchImpl = fetchImpl;

  await assert.rejects(
    () => worker.run(),
    /poll readiness probe failed.*not reachable or authorized \(403 policy_denied\)/s,
  );
});

test("pollReadinessProbe=false lets startup proceed even when the poll path is blocked", async () => {
  // register/heartbeat pass; poll stays blocked. With the probe disabled, startup
  // must not fail closed — it enters the loop and tolerates poll errors as before.
  const fetchImpl = async (input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
    const url = input instanceof URL ? input : new URL(String(input));
    const method = init?.method ?? "GET";
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (method === "GET" && url.pathname === "/tasks") {
      return json(403, { error: { code: "policy_denied", message: "would block if probed" } });
    }
    return json(method === "POST" && url.pathname === "/workers/register" ? 201 : 200, {
      nodeId: "worker-a", role: "analyst", status: "online", capabilities: { canAnalyze: true },
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(),
    });
  };
  const baseConfig = (createWorker("https://broker.test") as unknown as { config: BrokerWorkerConfig }).config;
  const worker = new A2ABrokerWorker({ ...baseConfig, pollReadinessProbe: false }, { fetchImpl });
  const runPromise = worker.run();
  // Let startup pass the (disabled) probe and enter the loop, then stop cleanly.
  await new Promise((resolve) => setTimeout(resolve, 30));
  await worker.stop();
  // Resolves without throwing => startup was not gated by the poll probe.
  await assert.doesNotReject(runPromise);
});


test("worker keeps legacy requester headers unsigned when HTTP Signature is not configured", async () => {
  let capturedHeaders: Headers | undefined;
  const fetchImpl = async (_url: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
    capturedHeaders = init?.headers as Headers;
    return new Response(JSON.stringify({
      nodeId: "worker-a",
      role: "analyst",
      status: "online",
      capabilities: { canAnalyze: true },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
    }), { status: 201, headers: { "content-type": "application/json" } });
  };

  const worker = createWorker("https://broker.test", { edgeSecret: "test-edge-secret" });
  (worker as unknown as { fetchImpl: typeof fetchImpl }).fetchImpl = fetchImpl;
  await worker.register();

  assert.equal(capturedHeaders?.get("x-a2a-requester-id"), "worker-a");
  assert.equal(capturedHeaders?.get("x-a2a-edge-secret"), "test-edge-secret");
  assert.equal(capturedHeaders?.has("signature-input"), false);
  assert.equal(capturedHeaders?.has("signature"), false);
  assert.equal(capturedHeaders?.has("content-digest"), false);
});

test("worker signs broker requests with configured per-worker A2A HTTP Signature key", async () => {
  let capturedUrl: URL | undefined;
  let capturedHeaders: Headers | undefined;
  let capturedBody = "";
  const fetchImpl = async (url: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
    capturedUrl = url instanceof URL ? url : new URL(String(url));
    capturedHeaders = init?.headers as Headers;
    capturedBody = String(init?.body ?? "");
    return new Response(JSON.stringify({
      nodeId: "worker-a",
      role: "analyst",
      status: "online",
      capabilities: { canAnalyze: true },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
    }), { status: 201, headers: { "content-type": "application/json" } });
  };

  const worker = createWorker("https://broker.test", {
    httpSignature: {
      keyid: "worker:worker-a:v1",
      privateKeyJwk: workerSignaturePrivateJwk,
      brokerId: "brokeralpha",
      nowEpochSeconds: () => 1770861620,
      nonceFactory: () => "worker-sign-register-nonce",
    },
  });
  (worker as unknown as { fetchImpl: typeof fetchImpl }).fetchImpl = fetchImpl;
  await worker.register();

  assert.ok(capturedUrl);
  assert.ok(capturedHeaders);
  assert.equal(capturedHeaders.get("x-a2a-requester-id"), "worker-a");
  assert.equal(capturedHeaders.get("x-a2a-requester-role"), "analyst");
  assert.equal(capturedHeaders.get("x-a2a-broker-id"), "brokeralpha");
  assert.equal(
    capturedHeaders.get("content-digest"),
    `sha-256=:${createHash("sha256").update(capturedBody).digest("base64")}:`,
  );
  const signatureInput = capturedHeaders.get("signature-input");
  assert.ok(signatureInput);
  const requestUrl = capturedUrl;
  assert.ok(requestUrl);
  const verification = verifyA2AHttpSignature({
    method: "POST",
    authority: requestUrl.host,
    path: requestUrl.pathname,
    query: requestUrl.search.slice(1),
    headers: Object.fromEntries([...capturedHeaders.entries()]),
    signatureInput,
    signature: capturedHeaders.get("signature") ?? undefined,
  }, workerSignatureKeyRegistry, { nowEpochSeconds: 1770861621 });
  assert.deepEqual(verification, {
    ok: true,
    keyid: "worker:worker-a:v1",
    requesterId: "worker-a",
    brokerId: "brokeralpha",
    created: 1770861620,
    expires: 1770861680,
    nonce: "worker-sign-register-nonce",
  });
});

test("worker signed requests pass strict broker route gate for register, poll, and lifecycle", async () => {
  const server = await startTestServer({
    brokerId: "brokeralpha",
    a2aHttpSignatureWorkerAuth: "strict",
    a2aHttpSignatureKeyRegistry: workerSignatureKeyRegistry,
    agentCardSigningKeyFile: await createBrokerSigningKeyFile(),
    agentCardSigningKid: "broker:brokeralpha:v1",
  });
  const worker = createWorker(server.baseUrl, {
    httpSignature: {
      keyid: "worker:worker-a:v1",
      privateKeyJwk: workerSignaturePrivateJwk,
      brokerId: "brokeralpha",
    },
  });

  try {
    await worker.register();
    await worker.heartbeat();
    const task = await createTask(server.baseUrl, {
      intent: "analyze",
      requester: { id: "hub-a", kind: "node", role: "hub" },
      target: { id: "worker-a", kind: "node", role: "analyst" },
      assignedWorkerId: "worker-a",
      message: "strict signed lifecycle",
      taskOrigin: "api",
    });

    const queued = await worker.pollQueuedTasks();
    assert.equal(queued.length, 1);
    assert.equal(queued[0].id, task.id);
    assert.equal(await worker.runOnce(), 1);

    const taskResponse = await fetch(`${server.baseUrl}/tasks/${task.id}`);
    assert.equal(taskResponse.status, 200);
    const completedTask = await taskResponse.json();
    assert.equal(completedTask.status, "succeeded");
    assert.equal(completedTask.claimedBy, "worker-a");
  } finally {
    await worker.stop();
    await server.close();
  }
});


test("worker signed requests cannot impersonate a different worker id in strict mode", async () => {
  const server = await startTestServer({
    brokerId: "brokeralpha",
    a2aHttpSignatureWorkerAuth: "strict",
    a2aHttpSignatureKeyRegistry: workerSignatureKeyRegistry,
  });
  const impersonatingWorker = new A2ABrokerWorker({
    brokerUrl: server.baseUrl,
    requesterKind: "node",
    pollIntervalMs: 25,
    heartbeatIntervalMs: 25,
    handlerTimeoutMs: 1_000,
    userAgent: "a2a-broker-worker-test",
    handler: async () => ({ result: {} }),
    httpSignature: {
      keyid: "worker:worker-a:v1",
      privateKeyJwk: workerSignaturePrivateJwk,
      brokerId: "brokeralpha",
    },
    worker: {
      nodeId: "worker-b",
      role: "analyst",
      capabilities: {
        canAnalyze: true,
        canBackfill: false,
        canPatchWorkspace: false,
        canPromoteLive: false,
        workspaceIds: ["test"],
        environments: ["research"],
      },
    },
  });

  try {
    await assert.rejects(
      () => impersonatingWorker.register(),
      (error: any) =>
        error.status === 401 &&
        error.code === "unauthorized" &&
        /requester id does not match the signing key owner/i.test(error.message),
    );
  } finally {
    await impersonatingWorker.stop();
    await server.close();
  }
});


test("worker HTTP Signature rejects unsafe key ids before building Signature-Input", async () => {
  const worker = createWorker("https://broker.test", {
    httpSignature: {
      keyid: 'worker:worker-a:v1";created=1',
      privateKeyJwk: workerSignaturePrivateJwk,
      brokerId: "brokeralpha",
    },
  });
  (worker as unknown as { fetchImpl: typeof fetch }).fetchImpl = async () => {
    throw new Error("fetch should not run for unsafe signature params");
  };

  await assert.rejects(
    () => worker.register(),
    /worker key id contains characters that are not safe for Signature-Input parameters/,
  );
});

test("worker HTTP Signature env config requires key id with private key material", () => {
  assert.throws(
    () => createWorkerConfigFromEnv({
      BROKER_URL: "https://broker.test",
      WORKER_ID: "worker-a",
      A2A_HTTP_SIGNATURE_WORKER_PRIVATE_KEY_JWK: JSON.stringify(workerSignaturePrivateJwk),
    }),
    /A2A_HTTP_SIGNATURE_WORKER_KEY_ID/,
  );

  const config = createWorkerConfigFromEnv({
    BROKER_URL: "https://broker.test",
    WORKER_ID: "worker-a",
    A2A_HTTP_SIGNATURE_WORKER_KEY_ID: "worker:worker-a:v1",
    A2A_HTTP_SIGNATURE_WORKER_PRIVATE_KEY_JWK: JSON.stringify(workerSignaturePrivateJwk),
    A2A_HTTP_SIGNATURE_BROKER_ID: "brokeralpha",
  });
  assert.equal(config.httpSignature?.keyid, "worker:worker-a:v1");
  assert.equal(config.httpSignature?.brokerId, "brokeralpha");

  const aliasConfig = createWorkerConfigFromEnv({
    BROKER_URL: "https://broker.test",
    WORKER_ID: "worker-a",
    A2A_HTTP_SIGNATURE_WORKER_KEY_ID: "",
    A2A_HTTP_SIGNATURE_WORKER_PRIVATE_KEY_JWK: "",
    A2A_HTTP_SIGNATURE_BROKER_ID: "",
    WORKER_HTTP_SIGNATURE_KEY_ID: "worker:worker-a:v1",
    WORKER_HTTP_SIGNATURE_PRIVATE_KEY_JWK: JSON.stringify(workerSignaturePrivateJwk),
    WORKER_HTTP_SIGNATURE_BROKER_ID: "brokeralpha",
  });
  assert.equal(aliasConfig.httpSignature?.keyid, "worker:worker-a:v1");
  assert.equal(aliasConfig.httpSignature?.brokerId, "brokeralpha");

  assert.throws(
    () => createWorkerConfigFromEnv({
      BROKER_URL: "https://broker.test",
      WORKER_ID: "worker-a",
      A2A_HTTP_SIGNATURE_WORKER_KEY_ID: 'worker:worker-a:v1";created=1',
      A2A_HTTP_SIGNATURE_WORKER_PRIVATE_KEY_JWK: JSON.stringify(workerSignaturePrivateJwk),
      A2A_HTTP_SIGNATURE_BROKER_ID: "brokeralpha",
    }),
    /A2A_HTTP_SIGNATURE_WORKER_KEY_ID contains characters that are not safe/,
  );
});

test("worker sends full heartbeat once and empty heartbeat bodies afterward", async () => {
  const bodies: Array<unknown> = [];
  const fetchImpl = async (_url: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
    bodies.push(init?.body ? JSON.parse(String(init.body)) : undefined);
    return new Response(JSON.stringify({
      nodeId: "worker-a",
      role: "analyst",
      status: "online",
      capabilities: { canAnalyze: true },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const compactWorker = new A2ABrokerWorker({
    brokerUrl: "https://broker.test",
    edgeSecret: "test-edge-secret",
    requesterKind: "node",
    pollIntervalMs: 25,
    heartbeatIntervalMs: 25,
    handlerTimeoutMs: 1_000,
    userAgent: "a2a-broker-worker-test",
    handler: async (task) => ({ result: { summary: `echo ${task.intent}` } }),
    worker: {
      nodeId: "worker-a",
      role: "analyst",
      displayName: "Worker A",
      capabilities: {
        canAnalyze: true,
        canBackfill: false,
        canPatchWorkspace: false,
        canPromoteLive: false,
        workspaceIds: ["test"],
        environments: ["research"],
      },
      metadata: { lane: "test" },
    },
  }, { fetchImpl });

  await compactWorker.heartbeat();
  await compactWorker.heartbeat();

  assert.equal(bodies.length, 2);
  assert.deepEqual((bodies[0] as { capabilities?: unknown }).capabilities, {
    canAnalyze: true,
    canBackfill: false,
    canPatchWorkspace: false,
    canPromoteLive: false,
    workspaceIds: ["test"],
    environments: ["research"],
  });
  assert.deepEqual(bodies[1], {});
});

test("worker sends task heartbeats while a handler is running", async () => {
  const server = await startTestServer();
  const worker = new A2ABrokerWorker({
    brokerUrl: server.baseUrl,
    requesterKind: "node",
    pollIntervalMs: 25,
    heartbeatIntervalMs: 20,
    handlerTimeoutMs: 1_000,
    userAgent: "a2a-broker-worker-test",
    handler: async (task) => {
      await new Promise((resolve) => setTimeout(resolve, 75));
      return { result: { summary: `slow echo ${task.intent}` } };
    },
    worker: {
      nodeId: "worker-a",
      role: "analyst",
      displayName: "Worker A",
      capabilities: {
        canAnalyze: true,
        canBackfill: false,
        canPatchWorkspace: false,
        canPromoteLive: false,
        workspaceIds: ["test"],
        environments: ["research"],
      },
    },
  });

  try {
    await worker.register();
    await createTask(server.baseUrl, {
      intent: "analyze",
      requester: { id: "hub-a", kind: "node", role: "hub" },
      target: { id: "worker-a", kind: "node", role: "analyst" },
      assignedWorkerId: "worker-a",
      message: "run slow echo",
      payload: {},
    });

    const processed = await worker.runOnce();
    assert.equal(processed, 1);

    const auditResponse = await fetch(`${server.baseUrl}/audit?action=task.heartbeat`);
    const audit = await auditResponse.json();
    assert.ok(audit.items.length >= 1, "expected at least one task heartbeat audit event");

    const taskResponse = await fetch(`${server.baseUrl}/tasks/${audit.items[0].targetId}`);
    const completedTask = await taskResponse.json();
    assert.equal(completedTask.status, "succeeded");
    assert.equal(typeof completedTask.lastHeartbeatAt, "string");
  } finally {
    await worker.stop();
    await server.close();
  }
});

test("worker includes x-a2a-edge-secret when configured", async () => {
  const server = await startTestServer({ edgeSecret: "test-edge-secret" });
  const worker = createWorker(server.baseUrl, { edgeSecret: "test-edge-secret" });

  try {
    const registered = await worker.register();
    assert.equal(registered.nodeId, "worker-a");

    const heartbeat = await worker.heartbeat();
    assert.equal(heartbeat.nodeId, "worker-a");
  } finally {
    await worker.stop();
    await server.close();
  }
});

test("worker queued-task polls do not consume the general rate limit budget", async () => {
  const server = await startTestServer({
    rateLimitMaxRequests: 1,
    workerRateLimitMaxRequests: 5,
  });
  const worker = createWorker(server.baseUrl);

  try {
    await worker.register();

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const queued = await worker.pollQueuedTasks();
      assert.deepEqual(queued, []);
    }
  } finally {
    await worker.stop();
    await server.close();
  }
});


test("worker HTTP Signature private key env is not propagated to external handlers", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "a2a-worker-signature-env-scrub-"));
  const handlerPath = join(tempDir, "handler.mjs");
  await writeFile(handlerPath, `
const chunks = [];
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  const hasPrivateJwk = Boolean(process.env.A2A_HTTP_SIGNATURE_WORKER_PRIVATE_KEY_JWK || process.env.WORKER_HTTP_SIGNATURE_PRIVATE_KEY_JWK);
  console.log(JSON.stringify({
    result: {
      summary: "env scrub checked",
      output: { hasPrivateJwk },
    },
  }));
});
`, "utf8");

  const config = createWorkerConfigFromEnv({
    BROKER_URL: "https://broker.test",
    WORKER_ID: "worker-a",
    WORKER_HANDLER_COMMAND: process.execPath,
    WORKER_HANDLER_ARGS_JSON: JSON.stringify([handlerPath]),
    A2A_HTTP_SIGNATURE_WORKER_KEY_ID: "worker:worker-a:v1",
    A2A_HTTP_SIGNATURE_WORKER_PRIVATE_KEY_JWK: JSON.stringify(workerSignaturePrivateJwk),
    A2A_HTTP_SIGNATURE_BROKER_ID: "brokeralpha",
  });

  const outcome = await config.handler({
    id: "env-scrub-task",
    intent: "analyze",
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    targetNodeId: "worker-a",
    assignedWorkerId: "worker-a",
    message: "check env scrub",
    status: "running",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as any);

  assert.equal((outcome as any).result.output.hasPrivateJwk, false);
});

test("worker env config prefers broker-specific edge secrets over generic ones", () => {
  const config = createWorkerConfigFromEnv({
    BROKER_URL: "http://127.0.0.1:8787",
    WORKER_ID: "worker-a",
    WORKER_HANDLER_BUILTIN: "echo",
    BROKER_EDGE_SECRET: "broker-secret",
    EDGE_SECRET: "generic-secret",
  });

  assert.equal(config.edgeSecret, "broker-secret");
});

test("worker env config reads A2A home broker id and lease file", () => {
  const config = createWorkerConfigFromEnv({
    BROKER_URL: "http://127.0.0.1:8787",
    WORKER_ID: "worker-a",
    WORKER_HANDLER_BUILTIN: "echo",
    A2A_HOME_BROKER_ID: "team2-broker",
    A2A_HOME_BROKER_LEASE_FILE: "/tmp/a2a-home-broker-lease.json",
  });

  assert.equal(config.homeBrokerId, "team2-broker");
  assert.equal(config.homeBrokerLeaseFile, "/tmp/a2a-home-broker-lease.json");
});

test("worker env config validates claude-code docker-runner profile mounts before startup", () => {
  const baseEnv = {
    BROKER_URL: "http://127.0.0.1:8787",
    WORKER_ID: "worker-a",
    WORKER_HANDLER_BUILTIN: "echo",
    A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE: "cccb",
    A2A_DOCKER_RUNNER_CLAUDE_CONFIG_DIR: "/root/.claude",
  };

  assert.throws(
    () => createWorkerConfigFromEnv({
      ...baseEnv,
      A2A_DOCKER_RUNNER_EXTRA_MOUNTS_JSON: JSON.stringify([
        { source: "/tmp/a2a-scratch", target: "/workspace", readOnly: false },
      ]),
    }),
    /claude-code patch profile requires a \/run\/secrets\/claude-dir mount/,
  );

  const config = createWorkerConfigFromEnv({
    ...baseEnv,
    A2A_DOCKER_RUNNER_EXTRA_MOUNTS_JSON: JSON.stringify([
      { source: "/root/.claude", target: "/run/secrets/claude-dir", readOnly: true },
      { source: "/tmp/a2a-scratch", target: "/workspace", readOnly: false },
    ]),
  });
  assert.equal(config.worker.nodeId, "worker-a");

  assert.throws(
    () => createWorkerConfigFromEnv({
      ...baseEnv,
      A2A_DOCKER_RUNNER_EXTRA_MOUNTS_JSON: JSON.stringify([
        { source: "/root/.claude", target: "/run/secrets/claude-dir", readOnly: false },
      ]),
    }),
    /writable agent runtime\/session paths are forbidden/,
  );
});

test("worker env config fails closed on unsafe docker-runner extra mounts before startup (#775)", () => {
  const baseEnv = {
    BROKER_URL: "http://127.0.0.1:8787",
    WORKER_ID: "worker-a",
    WORKER_HANDLER_BUILTIN: "echo",
    A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE: "hermes",
    A2A_DOCKER_RUNNER_HERMES_CONFIG_DIR: "/root/.hermes",
  };

  assert.throws(
    () => createWorkerConfigFromEnv({
      ...baseEnv,
      A2A_DOCKER_RUNNER_EXTRA_MOUNTS_JSON: JSON.stringify([
        { source: "/tmp/a2a-scratch", target: "/workspace", readOnly: false },
      ]),
    }),
    /hermes patch profile requires a \/run\/secrets\/hermes-dir mount/,
  );

  const config = createWorkerConfigFromEnv({
    ...baseEnv,
    A2A_DOCKER_RUNNER_EXTRA_MOUNTS_JSON: JSON.stringify([
      { source: "/root/.hermes", target: "/run/secrets/hermes-dir", readOnly: true },
      { source: "/tmp/a2a-scratch", target: "/workspace", readOnly: false },
    ]),
  });
  assert.equal(config.worker.nodeId, "worker-a");

  assert.throws(
    () => createWorkerConfigFromEnv({
      ...baseEnv,
      A2A_DOCKER_RUNNER_EXTRA_MOUNTS_JSON: JSON.stringify([
        { source: "/root/.hermes", target: "/run/secrets/hermes-dir", readOnly: false },
      ]),
    }),
    /writable agent runtime\/session paths are forbidden/,
  );
});

test("openclaw-poll-only profile declares broker poll handler metadata and disables bridge for external handlers", async () => {
  const server = await startTestServer();
  const tempDir = await mkdtemp(join(tmpdir(), "a2a-openclaw-poll-only-worker-"));
  const handlerPath = join(tempDir, "handler.mjs");
  await writeFile(handlerPath, `
const chunks = [];
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  const task = JSON.parse(chunks.join(""));
  console.log(JSON.stringify({
    result: {
      summary: "poll-only handler completed " + task.id,
      output: {
        bridgeDisabled: process.env.A2A_OPENCLAW_BRIDGE_DISABLED,
        openClawBin: process.env.OPENCLAW_BIN || "",
      },
    },
  }));
});
`, "utf8");

  const config = createWorkerConfigFromEnv({
    BROKER_URL: server.baseUrl,
    WORKER_ID: "worker-a",
    WORKER_ROLE: "analyst",
    WORKER_PROFILE: "openclaw-poll-only",
    WORKER_HANDLER_COMMAND: process.execPath,
    WORKER_HANDLER_ARGS_JSON: JSON.stringify([handlerPath]),
    OPENCLAW_BIN: "/path/that/must/not/run",
  });
  const worker = new A2ABrokerWorker(config);

  try {
    assert.equal(config.worker.capabilities.runtimeFlavor, "openclaw-poll-handler");
    assert.equal(config.worker.capabilities.gatewayRequired, false);
    assert.deepEqual(config.worker.metadata, {
      workerProfile: "openclaw-poll-only",
      runtimeFlavor: "openclaw-poll-handler",
      executionPlane: "broker-poll-http-handler",
      handlerContract: "stdin-stdout",
      gatewayHookRequired: "false",
      openclawBridge: "disabled",
    });

    await worker.register();
    const workerViewResponse = await fetch(`${server.baseUrl}/workers/worker-a`);
    assert.equal(workerViewResponse.status, 200);
    const workerView = await workerViewResponse.json();
    assert.equal(workerView.capabilities.runtimeFlavor, "openclaw-poll-handler");
    assert.equal(workerView.capabilities.gatewayRequired, false);
    assert.equal(workerView.metadata.executionPlane, "broker-poll-http-handler");

    const task = await createTask(server.baseUrl, {
      intent: "analyze",
      requester: { id: "hub-a", kind: "node", role: "hub" },
      target: { id: "worker-a", kind: "node", role: "analyst" },
      assignedWorkerId: "worker-a",
      message: "run poll-only handler",
      payload: {},
    });

    const processed = await worker.runOnce();
    assert.equal(processed, 1);

    const taskResponse = await fetch(`${server.baseUrl}/tasks/${task.id}`);
    assert.equal(taskResponse.status, 200);
    const completedTask = await taskResponse.json();
    assert.equal(completedTask.status, "succeeded");
    assert.equal(completedTask.result.output.bridgeDisabled, "1");
    assert.equal(completedTask.result.output.openClawBin, "/path/that/must/not/run");
  } finally {
    await worker.stop();
    await server.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("broker-poll-only profile declares neutral broker poll handler metadata without OpenClaw bridge env", () => {
  const config = createWorkerConfigFromEnv({
    BROKER_URL: "http://127.0.0.1:8787",
    WORKER_ID: "worker-neutral",
    WORKER_ROLE: "analyst",
    WORKER_PROFILE: "broker-poll-only",
    WORKER_HANDLER_COMMAND: process.execPath,
    WORKER_HANDLER_ARGS_JSON: JSON.stringify(["/tmp/handler.mjs"]),
    OPENCLAW_BIN: "/path/that/must/not-run",
  });

  assert.equal(config.worker.capabilities.runtimeFlavor, "broker-poll-http-handler");
  assert.equal(config.worker.capabilities.gatewayRequired, false);
  assert.deepEqual(config.worker.metadata, {
    workerProfile: "broker-poll-only",
    runtimeFlavor: "broker-poll-http-handler",
    executionPlane: "broker-poll-http-handler",
    handlerContract: "stdin-stdout",
    gatewayHookRequired: "false",
  });
});

test("legacy openclaw-poll-only profile remains a compatibility alias", () => {
  const config = createWorkerConfigFromEnv({
    BROKER_URL: "http://127.0.0.1:8787",
    WORKER_ID: "worker-legacy",
    WORKER_ROLE: "analyst",
    WORKER_PROFILE: "openclaw-poll-only",
    WORKER_HANDLER_COMMAND: process.execPath,
    WORKER_HANDLER_ARGS_JSON: JSON.stringify(["/tmp/handler.mjs"]),
  });

  assert.equal(config.worker.capabilities.runtimeFlavor, "openclaw-poll-handler");
  assert.equal(config.worker.capabilities.gatewayRequired, false);
  assert.equal(config.worker.metadata?.workerProfile, "openclaw-poll-only");
  assert.equal(config.worker.metadata?.openclawBridge, "disabled");
});

test("broker poll aliases normalize to the neutral broker-poll-only profile", () => {
  const config = createWorkerConfigFromEnv({
    BROKER_URL: "http://127.0.0.1:8787",
    WORKER_ID: "worker-poll-alias",
    WORKER_ROLE: "analyst",
    WORKER_PROFILE: "poll-only",
    WORKER_HANDLER_COMMAND: process.execPath,
    WORKER_HANDLER_ARGS_JSON: JSON.stringify(["/tmp/handler.mjs"]),
  });

  assert.equal(config.worker.capabilities.runtimeFlavor, "broker-poll-http-handler");
  assert.equal(config.worker.metadata?.workerProfile, "broker-poll-only");
});

test("worker validates matching A2A_HOME_BROKER_ID and writes local lease before registering", async () => {
  const server = await startTestServer({ brokerId: "team2-broker" });
  const tempDir = await mkdtemp(join(tmpdir(), "a2a-worker-lease-test-"));
  const leaseFile = join(tempDir, "home-broker.json");
  const worker = createWorker(server.baseUrl, { homeBrokerId: "team2-broker", homeBrokerLeaseFile: leaseFile });

  try {
    const registered = await worker.register();
    assert.equal(registered.nodeId, "worker-a");

    const lease = JSON.parse(await readFile(leaseFile, "utf8"));
    assert.equal(lease.brokerId, "team2-broker");
    assert.equal(lease.workerId, "worker-a");
    assert.equal(lease.brokerUrl, `${server.baseUrl}/`);
  } finally {
    await worker.stop();
    await server.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("worker fails closed when broker identity mismatches A2A_HOME_BROKER_ID", async () => {
  const server = await startTestServer({ brokerId: "other-broker" });
  const worker = createWorker(server.baseUrl, { homeBrokerId: "team2-broker" });

  try {
    await assert.rejects(() => worker.register(), /home broker mismatch: expected A2A_HOME_BROKER_ID=team2-broker, got other-broker/);
  } finally {
    await worker.stop();
    await server.close();
  }
});

test("worker fails closed when local home-broker lease points at a different broker", async () => {
  const server = await startTestServer({ brokerId: "team2-broker" });
  const tempDir = await mkdtemp(join(tmpdir(), "a2a-worker-lease-test-"));
  const leaseFile = join(tempDir, "home-broker.json");
  await writeFile(leaseFile, JSON.stringify({ brokerId: "old-broker" }), "utf8");
  const worker = createWorker(server.baseUrl, { homeBrokerId: "team2-broker", homeBrokerLeaseFile: leaseFile });

  try {
    await assert.rejects(() => worker.register(), /home broker lease mismatch/);
  } finally {
    await worker.stop();
    await server.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("external worker records handler stderr on non-zero exit", async () => {
  const server = await startTestServer();
  const tempDir = await mkdtemp(join(tmpdir(), "a2a-worker-test-"));
  const scriptPath = join(tempDir, "handler.mjs");

  await writeFile(
    scriptPath,
    [
      "import { stdin, stderr } from 'node:process';",
      "let input = '';",
      "stdin.setEncoding('utf8');",
      "stdin.on('data', (chunk) => { input += chunk; });",
      "stdin.on('end', () => {",
      "  const task = JSON.parse(input);",
      "  stderr.write(`external handler rejected ${task.id}`);",
      "  process.exitCode = 7;",
      "});",
    ].join("\n"),
    "utf8",
  );

  const worker = new A2ABrokerWorker({
    brokerUrl: server.baseUrl,
    requesterKind: "node",
    pollIntervalMs: 25,
    heartbeatIntervalMs: 25,
    handlerTimeoutMs: 1_000,
    userAgent: "a2a-broker-worker-test",
    handler: createExternalWorkerHandler({
      command: process.execPath,
      args: [scriptPath],
      timeoutMs: 1_000,
    }),
    worker: {
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
    },
  });

  try {
    await worker.register();
    const task = await createTask(server.baseUrl, {
      intent: "analyze",
      requester: { id: "hub-a", kind: "node", role: "hub" },
      target: { id: "worker-a", kind: "node", role: "analyst" },
      assignedWorkerId: "worker-a",
      message: "run external",
    });

    const processed = await worker.runOnce();
    assert.equal(processed, 1);

    const taskResponse = await fetch(`${server.baseUrl}/tasks/${task.id}`);
    assert.equal(taskResponse.status, 200);
    const failedTask = await taskResponse.json();

    assert.equal(failedTask.status, "failed");
    assert.equal(failedTask.claimedBy, "worker-a");
    assert.equal(failedTask.error.code, "handler_exit_nonzero");
    assert.match(failedTask.error.message, /external handler rejected/);
    assert.equal(failedTask.error.details.stage, "handler");
    assert.match(failedTask.error.details.excerpt, /external handler rejected/);
  } finally {
    await worker.stop();
    await server.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("external worker promotes structured stdout failure details on non-zero exit", async () => {
  const server = await startTestServer();
  const tempDir = await mkdtemp(join(tmpdir(), "a2a-worker-test-"));
  const scriptPath = join(tempDir, "handler.mjs");

  await writeFile(
    scriptPath,
    [
      "const failure = { error: { code: 'source_projection_blocked', message: 'projection blocked', details: { stage: 'projection', excerpt: 'stage=projection quality=insufficient' } } };",
      "process.stdout.write(JSON.stringify(failure));",
      "process.exitCode = 1;",
    ].join("\n"),
    "utf8",
  );

  const worker = new A2ABrokerWorker({
    brokerUrl: server.baseUrl,
    requesterKind: "node",
    pollIntervalMs: 25,
    heartbeatIntervalMs: 25,
    handlerTimeoutMs: 1_000,
    userAgent: "a2a-broker-worker-test",
    handler: createExternalWorkerHandler({
      command: process.execPath,
      args: [scriptPath],
      timeoutMs: 1_000,
    }),
    worker: {
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
    },
  });

  try {
    await worker.register();
    const task = await createTask(server.baseUrl, {
      intent: "analyze",
      requester: { id: "hub-a", kind: "node", role: "hub" },
      target: { id: "worker-a", kind: "node", role: "analyst" },
      assignedWorkerId: "worker-a",
      message: "run external",
    });

    const processed = await worker.runOnce();
    assert.equal(processed, 1);

    const taskResponse = await fetch(`${server.baseUrl}/tasks/${task.id}`);
    assert.equal(taskResponse.status, 200);
    const failedTask = await taskResponse.json();

    assert.equal(failedTask.status, "failed");
    assert.equal(failedTask.error.code, "handler_exit_nonzero");
    assert.equal(failedTask.error.details.stage, "projection");
    assert.equal(failedTask.error.details.excerpt, "stage=projection quality=insufficient");
    assert.equal(failedTask.error.details.nestedError.code, "source_projection_blocked");
  } finally {
    await worker.stop();
    await server.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});


test("worker fails GitHub propose_patch tasks without PR or block evidence", async () => {
  const server = await startTestServer();
  const worker = createWorker(server.baseUrl);

  try {
    await worker.register();
    const task = await createTask(server.baseUrl, {
      intent: "propose_patch",
      requester: { id: "hub-a", kind: "node", role: "hub" },
      target: { id: "worker-a", kind: "node", role: "analyst" },
      assignedWorkerId: "worker-a",
      message: "open a GitHub PR",
      payload: { mode: "github-propose-patch", repo: "owner/repo", issue: "#1" },
      taskOrigin: "github",
    });

    const processed = await worker.runOnce();
    assert.equal(processed, 1);

    const taskResponse = await fetch(`${server.baseUrl}/tasks/${task.id}`);
    assert.equal(taskResponse.status, 200);
    const failedTask = await taskResponse.json();

    assert.equal(failedTask.status, "failed");
    assert.equal(failedTask.error.code, "github_completion_evidence_missing");
  } finally {
    await worker.stop();
    await server.close();
  }
});

test("worker fails GitHub issue-instruction propose_patch tasks without PR or block evidence", async () => {
  const server = await startTestServer();
  const worker = createWorker(server.baseUrl);

  try {
    await worker.register();
    const task = await createTask(server.baseUrl, {
      intent: "propose_patch",
      requester: { id: "hub-a", kind: "node", role: "hub" },
      target: { id: "worker-a", kind: "node", role: "analyst" },
      assignedWorkerId: "worker-a",
      message: "process a GitHub issue instruction",
      payload: { mode: "github-issue-instruction", repo: "owner/repo", issue: "#1" },
      taskOrigin: "unknown",
    });

    const processed = await worker.runOnce();
    assert.equal(processed, 1);

    const taskResponse = await fetch(`${server.baseUrl}/tasks/${task.id}`);
    assert.equal(taskResponse.status, 200);
    const failedTask = await taskResponse.json();

    assert.equal(failedTask.status, "failed");
    assert.equal(failedTask.error.code, "github_completion_evidence_missing");
  } finally {
    await worker.stop();
    await server.close();
  }
});

test("worker allows GitHub propose_patch tasks with PR evidence", async () => {
  const server = await startTestServer();
  const worker = new A2ABrokerWorker({
    brokerUrl: server.baseUrl,
    requesterKind: "node",
    pollIntervalMs: 25,
    heartbeatIntervalMs: 25,
    handlerTimeoutMs: 1_000,
    userAgent: "a2a-broker-worker-test",
    handler: async () => ({
      result: {
        summary: "opened PR",
        output: {
          github: {
            prUrl: "https://github.com/owner/repo/pull/2",
          },
        },
      },
    }),
    worker: {
      nodeId: "worker-a",
      role: "analyst",
      capabilities: {
        canAnalyze: true,
        canBackfill: false,
        canPatchWorkspace: true,
        canPromoteLive: false,
        workspaceIds: ["test"],
        environments: ["research"],
      },
    },
  });

  try {
    await worker.register();
    const task = await createTask(server.baseUrl, {
      intent: "propose_patch",
      requester: { id: "hub-a", kind: "node", role: "hub" },
      target: { id: "worker-a", kind: "node", role: "analyst" },
      assignedWorkerId: "worker-a",
      message: "open a GitHub PR",
      payload: { mode: "github-propose-patch", repo: "owner/repo", issue: "#1" },
      taskOrigin: "github",
    });

    const processed = await worker.runOnce();
    assert.equal(processed, 1);

    const taskResponse = await fetch(`${server.baseUrl}/tasks/${task.id}`);
    assert.equal(taskResponse.status, 200);
    const completedTask = await taskResponse.json();

    assert.equal(completedTask.status, "succeeded");
    assert.equal(completedTask.result.output.github.prUrl, "https://github.com/owner/repo/pull/2");
  } finally {
    await worker.stop();
    await server.close();
  }
});

test("worker proposal APIs: createProposal, getProposalDetails, submitValidation", async () => {
  const server = await startTestServer();
  const worker = createWorker(server.baseUrl);

  try {
    await worker.register();

    // Create a proposal via worker API
    const proposal = await worker.createProposal({
      source: { id: "worker-a", kind: "node", role: "analyst" },
      target: { id: "target-node", kind: "node", role: "live-trader" },
      kind: "patch",
      summary: "test patch",
      workspace: { nodeId: "target-node", workspaceId: "ws1" },
      patchText: "- old\n+ new",
    });

    assert.equal(proposal.kind, "patch");
    assert.equal(proposal.summary, "test patch");
    assert.equal(proposal.status, "submitted");

    // Fetch proposal details
    const details = await worker.getProposalDetails(proposal.id);
    assert.equal(details.proposal.id, proposal.id);
    assert.equal(details.validations.length, 0);

    // Submit validation
    await worker.submitValidation(proposal.id, {
      nodeId: "worker-a",
      kind: "backfill",
      verdict: "pass",
      metrics: { sr_improvement: 0.2 },
      note: "backtest passed",
    });

    // Re-fetch — should now be validated
    const afterValidation = await worker.getProposalDetails(proposal.id);
    assert.equal(afterValidation.proposal.status, "validated");
    assert.equal(afterValidation.validations.length, 1);
    assert.equal(afterValidation.validations[0].verdict, "pass");
  } finally {
    await worker.stop();
    await server.close();
  }
});

test("worker proposal API: approveProposal and applyProposal lifecycle", async () => {
  const server = await startTestServer();
  const worker = createWorker(server.baseUrl);

  // Need to register both worker-a and target-node on broker
  // target-node is needed for policy checks
  const targetWorker = new A2ABrokerWorker({
    brokerUrl: server.baseUrl,
    requesterKind: "node",
    pollIntervalMs: 25,
    heartbeatIntervalMs: 25,
    handlerTimeoutMs: 1_000,
    userAgent: "a2a-broker-worker-test",
    handler: async () => ({ result: {} }),
    worker: {
      nodeId: "target-node",
      role: "live-trader",
      capabilities: {
        canAnalyze: false,
        canBackfill: false,
        canPatchWorkspace: true,
        canPromoteLive: true,
        workspaceIds: ["ws1"],
        environments: ["live"],
      },
    },
  });

  try {
    await worker.register();
    await targetWorker.register();

    // Create + validate proposal
    const proposal = await worker.createProposal({
      source: { id: "worker-a", kind: "node", role: "analyst" },
      target: { id: "target-node", kind: "node", role: "live-trader" },
      kind: "params",
      summary: "update threshold",
      workspace: { nodeId: "target-node", workspaceId: "ws1" },
      parameterPayload: { THRESHOLD: 2.5 },
    });

    await worker.submitValidation(proposal.id, {
      nodeId: "worker-a",
      kind: "backfill",
      verdict: "pass",
    });

    // Target-node approves (policy: target node or operator only)
    // target-node's requester identity matches, so approve via targetWorker
    await targetWorker.approveProposal(proposal.id, {
      actor: { id: "target-node", kind: "node", role: "live-trader" },
      note: "approved",
    });

    // Apply
    const applied = await targetWorker.applyProposal(proposal.id, {
      actor: { id: "target-node", kind: "node", role: "live-trader" },
      workspace: { nodeId: "target-node", workspaceId: "ws1" },
      note: "applied locally",
    });

    assert.equal((applied as { status: string }).status, "applied");

    // Verify via details
    const details = await worker.getProposalDetails(proposal.id);
    assert.equal(details.proposal.status, "applied");
    assert.ok(details.audit.some((e: any) => e.action === "proposal.applied"));
  } finally {
    await worker.stop();
    await targetWorker.stop();
    await server.close();
  }
});

test("worker returns 404 for non-existent proposal", async () => {
  const server = await startTestServer();
  const worker = createWorker(server.baseUrl);

  try {
    await worker.register();

    await assert.rejects(
      () => worker.getProposalDetails("nonexistent-id"),
      (error: any) => error.code === "not_found",
    );
  } finally {
    await worker.stop();
    await server.close();
  }
});

// ─── analysis-only / read-only task mode regression tests ───

test("worker completes analysis-only tasks without PR evidence", async () => {
  const server = await startTestServer();
  const worker = createWorker(server.baseUrl);

  try {
    await worker.register();
    const task = await createTask(server.baseUrl, {
      intent: "analyze",
      requester: { id: "hub-a", kind: "node", role: "hub" },
      target: { id: "worker-a", kind: "node", role: "analyst" },
      assignedWorkerId: "worker-a",
      message: "run market regime analysis",
      payload: {
        mode: "analysis-only",
        summary: "BTC dominance scan",
        findings: ["dominance at 58%"],
        risks: ["volume declining"],
      },
      taskOrigin: "api",
    });

    const processed = await worker.runOnce();
    assert.equal(processed, 1);

    const taskResponse = await fetch(`${server.baseUrl}/tasks/${task.id}`);
    assert.equal(taskResponse.status, 200);
    const completedTask = await taskResponse.json();

    assert.equal(completedTask.status, "succeeded", "analysis-only task should succeed");
    assert.equal(completedTask.claimedBy, "worker-a");
    assert.match(completedTask.result.summary, /echo analyze/);
  } finally {
    await worker.stop();
    await server.close();
  }
});

test("worker completes analysis-only tasks with github origin without PR evidence", async () => {
  const server = await startTestServer();
  const worker = createWorker(server.baseUrl);

  try {
    await worker.register();
    const task = await createTask(server.baseUrl, {
      intent: "analyze",
      requester: { id: "hub-a", kind: "node", role: "hub" },
      target: { id: "worker-a", kind: "node", role: "analyst" },
      assignedWorkerId: "worker-a",
      message: "read-only thesis analysis",
      payload: {
        mode: "analysis-only",
        summary: "thesis for BTC/USDT",
        doneCommentUrl: "https://github.com/owner/repo/issues/1#issuecomment-done",
        findings: ["bullish divergence on 4h"],
      },
      taskOrigin: "github",
    });

    const processed = await worker.runOnce();
    assert.equal(processed, 1);

    const taskResponse = await fetch(`${server.baseUrl}/tasks/${task.id}`);
    assert.equal(taskResponse.status, 200);
    const completedTask = await taskResponse.json();

    // Analysis-only tasks with github origin must succeed without PR evidence
    assert.equal(completedTask.status, "succeeded",
      `analysis-only github-origin task should succeed, got: ${JSON.stringify(completedTask.error)}`);
  } finally {
    await worker.stop();
    await server.close();
  }
});

test("worker fails github propose_patch tasks without PR evidence (existing contract preserved)", async () => {
  const server = await startTestServer();
  const worker = createWorker(server.baseUrl);

  try {
    await worker.register();
    const task = await createTask(server.baseUrl, {
      intent: "propose_patch",
      requester: { id: "hub-a", kind: "node", role: "hub" },
      target: { id: "worker-a", kind: "node", role: "analyst" },
      assignedWorkerId: "worker-a",
      message: "open a PR",
      payload: { mode: "github-propose-patch", repo: "owner/repo", issue: "#1" },
      taskOrigin: "github",
    });

    const processed = await worker.runOnce();
    assert.equal(processed, 1);

    const taskResponse = await fetch(`${server.baseUrl}/tasks/${task.id}`);
    assert.equal(taskResponse.status, 200);
    const failedTask = await taskResponse.json();

    // Existing contract: github propose_patch tasks MUST have PR evidence
    assert.equal(failedTask.status, "failed");
    assert.equal(failedTask.error.code, "github_completion_evidence_missing");
  } finally {
    await worker.stop();
    await server.close();
  }
});

// ───────────────────────────────────────────────────────────────────────────
// Worker robustness regressions (a2a-nexus#573 items 6, 7)
// ───────────────────────────────────────────────────────────────────────────

function robustnessConfig(overrides: Partial<BrokerWorkerConfig> = {}): BrokerWorkerConfig {
  return {
    brokerUrl: "http://broker.invalid",
    requesterKind: "node",
    pollIntervalMs: 25,
    heartbeatIntervalMs: 10_000,
    handlerTimeoutMs: 1_000,
    userAgent: "a2a-broker-worker-test",
    handler: async (task) => ({
      result: { summary: `echo ${task.intent}`, output: { taskId: task.id } },
    }),
    worker: {
      nodeId: "worker-a",
      role: "analyst",
      displayName: "Worker A",
      capabilities: {
        canAnalyze: true,
        canBackfill: false,
        canPatchWorkspace: false,
        canPromoteLive: false,
        workspaceIds: ["test"],
        environments: ["research"],
      },
    },
    ...overrides,
  };
}

const jsonOk = () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } });

test("stop() during startup aborts the run loop and never polls tasks (item 6)", async () => {
  const paths: string[] = [];
  let workerRef: A2ABrokerWorker;
  const fetchImpl = (async (url: URL | string) => {
    const path = new URL(String(url)).pathname;
    paths.push(path);
    if (path === "/workers/register") {
      // Simulate SIGINT/SIGTERM arriving mid-registration.
      await workerRef.stop();
    }
    return jsonOk();
  }) as unknown as typeof fetch;

  workerRef = new A2ABrokerWorker(robustnessConfig(), { fetchImpl });

  const runPromise = workerRef.run();
  await Promise.race([runPromise, new Promise((r) => setTimeout(r, 200))]);

  assert.ok(paths.includes("/workers/register"), "registration should have been attempted");
  assert.ok(
    !paths.some((p) => p.startsWith("/tasks")),
    "a stop() during startup must prevent the worker from entering the poll loop",
  );

  await workerRef.stop();
  await runPromise.catch(() => undefined);
});

test("broker requests abort on the request timeout instead of hanging forever (item 7)", async () => {
  // A fetch that only settles when its abort signal fires; without a timeout
  // signal this would hang the poll loop forever.
  const fetchImpl = ((_url: URL | string, init?: { signal?: AbortSignal }) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted by signal")));
    })) as unknown as typeof fetch;

  const worker = new A2ABrokerWorker(robustnessConfig({ requestTimeoutMs: 50 }), { fetchImpl });

  await assert.rejects(worker.register(), /aborted by signal/);
});

test("external handler propagates the distributed trace id from task.via.traceId", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "a2a-trace-"));
  const scriptPath = join(dir, "echo-trace.mjs");
  writeFileSync(
    scriptPath,
    [
      "for await (const c of process.stdin) void c;",
      "process.stdout.write(JSON.stringify({ result: { summary: 'ok', output: { traceId: process.env.A2A_TRACE_ID ?? null } } }));",
    ].join("\n"),
  );
  const handler = createExternalWorkerHandler({ command: process.execPath, args: [scriptPath], timeoutMs: 5_000 });
  const base = {
    id: "task-trace-1", exchangeId: "exchange-trace-1", intent: "analyze",
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    message: "m", status: "running", targetNodeId: "worker-a", payload: {},
    createdAt: "2026-06-12T00:00:00Z", updatedAt: "2026-06-12T00:00:00Z",
  };
  const withTrace = (await handler({ ...base, via: { traceId: "trace-xyz" } } as never)) as { result: { output: { traceId: string | null } } };
  assert.equal(withTrace.result.output.traceId, "trace-xyz");
  const withoutTrace = (await handler(base as never)) as { result: { output: { traceId: string | null } } };
  assert.equal(withoutTrace.result.output.traceId, null, "no trace id -> env unset");
});

test("worker rejects an out-of-policy trace id instead of propagating it (a2a-nexus#621 review)", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "a2a-trace-bound-"));
  const scriptPath = join(dir, "echo-trace.mjs");
  writeFileSync(scriptPath, [
    "for await (const c of process.stdin) void c;",
    "process.stdout.write(JSON.stringify({ result: { summary: 'ok', output: { traceId: process.env.A2A_TRACE_ID ?? null } } }));",
  ].join("\n"));
  const handler = createExternalWorkerHandler({ command: process.execPath, args: [scriptPath], timeoutMs: 5_000 });
  const base = {
    id: "t-bound", exchangeId: "e-bound", intent: "analyze",
    requester: { id: "hub", kind: "node", role: "hub" }, target: { id: "w", kind: "node", role: "analyst" },
    message: "m", status: "running", targetNodeId: "w", payload: {},
    createdAt: "2026-06-12T00:00:00Z", updatedAt: "2026-06-12T00:00:00Z",
  };
  // Injection-y / overlong trace ids are dropped, not forwarded.
  const bad = (await handler({ ...base, via: { traceId: "trace; rm -rf /" } } as never)) as { result: { output: { traceId: string | null } } };
  assert.equal(bad.result.output.traceId, null);
  const long = (await handler({ ...base, via: { traceId: "x".repeat(200) } } as never)) as { result: { output: { traceId: string | null } } };
  assert.equal(long.result.output.traceId, null);
  const good = (await handler({ ...base, via: { traceId: "trace-ok_1:2.3" } } as never)) as { result: { output: { traceId: string | null } } };
  assert.equal(good.result.output.traceId, "trace-ok_1:2.3");
});

test("external handler injects the subagent conductor directive per task", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "a2a-subagent-env-"));
  const scriptPath = join(dir, "echo-env.mjs");
  writeFileSync(
    scriptPath,
    [
      "const chunks = [];",
      "for await (const chunk of process.stdin) chunks.push(chunk);",
      "process.stdout.write(JSON.stringify({ result: { summary: 'env probe', output: {",
      "  conductor: process.env.A2A_SUBAGENT_CONDUCTOR ?? null,",
      "  max: process.env.A2A_SUBAGENT_MAX ?? null,",
      "  roles: process.env.A2A_SUBAGENT_ROLES ?? null,",
      "  plan: process.env.A2A_SUBAGENT_PLAN ?? null,",
      "} } }));",
    ].join("\n"),
  );

  const handler = createExternalWorkerHandler({
    command: process.execPath,
    args: [scriptPath],
    timeoutMs: 5_000,
    workerId: "conductor-node",
    subagentCap: 4,
  });

  const baseTask = {
    id: "task-conductor-1",
    exchangeId: "exchange-conductor-1",
    intent: "chat",
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "conductor-node", kind: "node", role: "analyst" },
    message: "simple chat",
    status: "running",
    targetNodeId: "conductor-node",
    payload: {},
    createdAt: "2026-06-12T00:00:00Z",
    updatedAt: "2026-06-12T00:00:00Z",
  } as never;

  // Simple work: the conductor keeps it for itself (budget reflects size).
  const simple = (await handler(baseTask)) as { result: { output: Record<string, string | null> } };
  assert.equal(simple.result.output.conductor, "1");
  assert.equal(simple.result.output.max, "0", "simple chat runs direct — the conductor keeps it");
  assert.equal(simple.result.output.roles, "", "no subagents for simple work");

  // Heavy work with an explicit profile: shared host clamp allows at most one implementer.
  const heavyTask = {
    ...(baseTask as Record<string, unknown>),
    id: "task-conductor-2",
    intent: "propose_patch",
    payload: {
      subagentProfile: {
        size: "large",
        coupling: "low",
        hasIndependentSubtasks: true,
        writeSets: ["src/a.ts", "src/b.ts"],
      },
    },
  } as never;
  const heavy = (await handler(heavyTask)) as { result: { output: Record<string, string | null> } };
  assert.equal(heavy.result.output.max, "3");
  assert.equal(heavy.result.output.roles, "explorer,implementer,verifier");
  const plan = JSON.parse(heavy.result.output.plan ?? "{}");
  assert.equal(plan.oneFinalizerRequired, true);
  assert.equal(plan.writeSetIsolationRequired, true);
  assert.deepEqual(plan.reducedBy, ["shared_workspace"]);



  // Patch-shaped work without an explicit profile can infer independent write sets.
  const inferredTask = {
    ...(baseTask as Record<string, unknown>),
    id: "task-conductor-3",
    intent: "propose_patch",
    payload: { writeSets: ["packages/broker/src/a.ts", "packages/docker-runner/src/b.ts"] },
  } as never;
  const inferred = (await handler(inferredTask)) as { result: { output: Record<string, string | null> } };
  assert.equal(inferred.result.output.max, "3");
  assert.equal(inferred.result.output.roles, "explorer,implementer,verifier");
  // Opt-out keeps the env clean.
  const optedOut = createExternalWorkerHandler({
    command: process.execPath,
    args: [scriptPath],
    timeoutMs: 5_000,
    subagentDirectiveDisabled: true,
  });
  const none = (await optedOut(baseTask)) as { result: { output: Record<string, string | null> } };
  assert.equal(none.result.output.conductor, null);
});

test("conductor budget is a verifiable contract: reports are annotated, overruns fail closed", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "a2a-subagent-budget-"));
  const scriptPath = join(dir, "report.mjs");
  writeFileSync(
    scriptPath,
    [
      "const chunks = [];",
      "for await (const chunk of process.stdin) chunks.push(chunk);",
      "const task = JSON.parse(Buffer.concat(chunks).toString());",
      "const count = Number(task.payload?.reportCount ?? 0);",
      "process.stdout.write(JSON.stringify({ result: { summary: 'done', output: { subagentReport: { count, roles: ['verifier'] } } } }));",
    ].join("\n"),
  );

  const handler = createExternalWorkerHandler({
    command: process.execPath,
    args: [scriptPath],
    timeoutMs: 5_000,
    workerId: "conductor-node",
    subagentCap: 4,
  });

  const heavyProfile = {
    subagentProfile: {
      size: "large",
      coupling: "low",
      hasIndependentSubtasks: true,
      writeSets: ["src/a.ts", "src/b.ts"],
    },
  };
  const makeTask = (id: string, payload: Record<string, unknown>) =>
    ({
      id,
      exchangeId: `exchange-${id}`,
      intent: "propose_patch",
      requester: { id: "hub-a", kind: "node", role: "hub" },
      target: { id: "conductor-node", kind: "node", role: "analyst" },
      message: "budget test",
      status: "running",
      targetNodeId: "conductor-node",
      payload,
      createdAt: "2026-06-12T00:00:00Z",
      updatedAt: "2026-06-12T00:00:00Z",
    }) as never;

  // Within shared-host budget (3): annotated with the budget for terminal evidence.
  const ok = (await handler(makeTask("budget-ok", { ...heavyProfile, reportCount: 3 }))) as {
    result: { output: { subagentReport: Record<string, unknown> } };
  };
  assert.equal(ok.result.output.subagentReport.count, 3);
  assert.equal(ok.result.output.subagentReport.budget, 3);
  assert.equal(ok.result.output.subagentReport.withinBudget, true);
  assert.equal(ok.result.output.subagentReport.roles, undefined, "legacy count-only reports must not reflect arbitrary fields");

  // Over budget: fail closed.
  const over = (await handler(makeTask("budget-over", { ...heavyProfile, reportCount: 5 }))) as {
    error: { code: string; details: Record<string, unknown> };
  };
  assert.equal(over.error.code, "subagent_budget_exceeded");
  assert.equal(over.error.details.budget, 3);
  assert.equal(over.error.details.reported, 5);

  // No report: result passes through untouched.
  const silentScript = join(dir, "silent.mjs");
  writeFileSync(
    silentScript,
    [
      "for await (const chunk of process.stdin) void chunk;",
      "process.stdout.write(JSON.stringify({ result: { summary: 'no report' } }));",
    ].join("\n"),
  );
  const silentHandler = createExternalWorkerHandler({
    command: process.execPath,
    args: [silentScript],
    timeoutMs: 5_000,
    subagentCap: 4,
  });
  const silent = (await silentHandler(makeTask("budget-silent", {}))) as { result: { summary: string } };
  assert.equal(silent.result.summary, "no report");
});

test("dynamic subagent runtime consults Phase-1 deciders and produces a redacted mounted brief payload (Phase-2 WS5)", async () => {
  const structuralSecret = `ghp_${"y".repeat(36)}`;
  const task = {
    id: "task-ws5",
    exchangeId: "exchange-ws5",
    intent: "propose_patch",
    requester: { id: "hub", kind: "node", role: "hub" },
    target: { id: "worker-ws5", kind: "node", role: "analyst" },
    message: "large independent patch",
    status: "running",
    targetNodeId: "worker-ws5",
    approval: {
      approvalId: "approval-ws5",
      approvedAt: "2026-07-13T00:00:00Z",
      approvedBy: "seoseo-a2a-finalizer",
      actorRole: "operator",
      requesterRole: "operator",
    },
    payload: {
      subagentProfile: {
        size: "large",
        coupling: "low",
        hasIndependentSubtasks: true,
        writeSets: ["src/a.ts", "src/b.ts"],
      },
      spawnAuthorization: {
        state: "authorization_request_draft_ready",
        workerId: "worker-ws5",
        taskId: "task-ws5",
        source: { plannerParallelismHint: 3 },
        finalizerReview: { oneFinalizerRequired: true, writeSetIsolationRequired: true },
      },
      workerSubagentBudgetCounter: {
        workerId: "worker-ws5",
        usage: { taskId: "task-ws5", taskTokensSpent: 100, taskTokenCeiling: 1_000 },
      },
      workerSubagentContextBrief: {
        workerId: "worker-ws5",
        taskId: "task-ws5",
        finalizer: "broker-finalizer",
        summary: `Use token ghp_${"x".repeat(36)} while editing src/a.ts`,
        assignments: [{
          role: `implementer-${structuralSecret}`,
          objective: "edit src/a.ts",
          writeSet: [`src/${structuralSecret}.ts`],
          pointers: [{ path: "src/a.ts", lines: structuralSecret, note: "inspect this range" }],
        }],
        pointers: [{ path: "src/a.ts", lines: structuralSecret, note: "top-level pointer" }],
        acceptanceCriteria: ["focused tests pass"],
      },
    },
    createdAt: "2026-07-13T00:00:00Z",
    updatedAt: "2026-07-13T00:00:00Z",
  } as never;

  const runtime = buildDynamicSubagentRuntime(task, {
    workerId: "worker-ws5",
    subagentCap: 4,
    executionIsolation: "shared",
    fanoutEnabled: true,
    staticRunnerMax: 2,
    staticRunnerRoles: ["explorer", "verifier"],
  });
  assert.equal(runtime.env.A2A_DOCKER_RUNNER_CLAUDE_CODE_FANOUT_ENABLED, "1");
  assert.equal(runtime.env.A2A_DOCKER_RUNNER_CONTAINED_SUBAGENTS_MAX, "2");
  assert.equal(runtime.env.A2A_DOCKER_RUNNER_CONTAINED_SUBAGENTS_ROLES, "explorer,verifier");
  const runtimePlan = JSON.parse(runtime.env.A2A_SUBAGENT_PLAN ?? "{}");
  assert.equal(runtimePlan.state, "authorized");
  assert.equal(runtimePlan.approvalRef, "approval-ws5");
  assert.equal(runtimePlan.taskId, "task-ws5");
  assert.equal(runtimePlan.authorizedSubagentCount, 2);
  assert.equal(runtimePlan.budgetState, "within-budget");
  assert.equal(runtimePlan.gateState, "authorized");
  assert.equal(runtimePlan.briefPath, "/work/artifacts/context-brief.md");
  assert.match(runtimePlan.briefDigest, /^sha256:[0-9a-f]{64}$/);
  assert.match(runtime.subagentContextBrief ?? "", /^# A2A sub-agent context brief/m);
  assert.match(runtime.subagentContextBrief ?? "", /\[redacted\]/);
  assert.doesNotMatch(runtime.subagentContextBrief ?? "", /ghp_/);
  assert.match(runtime.subagentContextBrief ?? "", /^### explorer$/m);
  assert.match(runtime.subagentContextBrief ?? "", /^### verifier$/m);
  assert.doesNotMatch(runtime.subagentContextBrief ?? "", /^### implementer/m);

  const unapproved = { ...(task as Record<string, unknown>) };
  delete unapproved.approval;
  const denied = buildDynamicSubagentRuntime(unapproved as never, {
    workerId: "worker-ws5",
    subagentCap: 4,
    executionIsolation: "shared",
    fanoutEnabled: true,
    staticRunnerMax: 2,
    staticRunnerRoles: ["explorer", "verifier"],
  });
  assert.equal(denied.env.A2A_DOCKER_RUNNER_CLAUDE_CODE_FANOUT_ENABLED, "0");
  assert.equal(JSON.parse(denied.env.A2A_SUBAGENT_PLAN ?? "{}").reason, "broker_approval_missing_or_untrusted");

  const unsafeWriteSetTask = {
    ...(task as Record<string, unknown>),
    payload: {
      ...((task as { payload: Record<string, unknown> }).payload),
      subagentProfile: {
        size: "large",
        coupling: "low",
        hasIndependentSubtasks: true,
        writeSets: ["/root/.openclaw/agents/main.json", "src/b.ts"],
      },
    },
  } as never;
  const unsafeWriteSet = buildDynamicSubagentRuntime(unsafeWriteSetTask, {
    workerId: "worker-ws5",
    subagentCap: 4,
    executionIsolation: "shared",
    fanoutEnabled: true,
    staticRunnerMax: 2,
    staticRunnerRoles: ["explorer", "implementer", "verifier"],
  });
  assert.equal(unsafeWriteSet.env.A2A_DOCKER_RUNNER_CLAUDE_CODE_FANOUT_ENABLED, "0");
  assert.equal(JSON.parse(unsafeWriteSet.env.A2A_SUBAGENT_PLAN ?? "{}").reason, "authorized_write_set_invalid");

  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "a2a-ws5-boundary-"));
  const scriptPath = join(dir, "probe.mjs");
  writeFileSync(scriptPath, [
    "const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk);",
    "const task = JSON.parse(Buffer.concat(chunks).toString('utf8'));",
    "const reportEntries = [",
    "  { role: task.payload?.reportedRole ?? 'explorer', id: 'helper-explorer', writeSet: [], status: 'complete', output: task.payload?.preRedacted ? 'read <private-dir> then notify telegram:<redacted-target>' : task.payload?.preTruncated ? 'bounded clean prefix' : 'read /root/.openclaw/config then TOKEN=runtime-synthetic', redacted: task.payload?.preRedacted === true, truncated: task.payload?.preTruncated === true },",
    "  { role: 'verifier', id: 'helper-verifier', writeSet: [], status: 'complete', output: task.payload?.preRedacted || task.payload?.preTruncated ? 'tests pass' : 'notify telegram:123456789 after tests pass' },",
    "];",
    "if (task.payload?.reverseReport === true) reportEntries.reverse();",
    "process.stdout.write(JSON.stringify({ result: { summary: 'ok', output: {",
    "  enabled: process.env.A2A_DOCKER_RUNNER_CLAUDE_CODE_FANOUT_ENABLED,",
    "  max: process.env.A2A_DOCKER_RUNNER_CONTAINED_SUBAGENTS_MAX,",
    "  roles: process.env.A2A_DOCKER_RUNNER_CONTAINED_SUBAGENTS_ROLES,",
    "  plan: process.env.A2A_SUBAGENT_PLAN,",
    "  brief: task.subagentContextBrief ?? null,",
    "  subagentReport: { count: 2, entries: reportEntries },",
    "} } }));",
  ].join("\n"));
  const handler = createExternalWorkerHandler({
    command: process.execPath,
    args: [scriptPath],
    workerId: "worker-ws5",
    subagentCap: 4,
    env: {
      A2A_DOCKER_RUNNER_CLAUDE_CODE_FANOUT_ENABLED: "1",
      A2A_DOCKER_RUNNER_CONTAINED_SUBAGENTS_MAX: "2",
      A2A_DOCKER_RUNNER_CONTAINED_SUBAGENTS_ROLES: "explorer,verifier",
    },
  });
  const boundary = await handler(task as never) as { result: { output: Record<string, unknown> } };
  assert.equal(boundary.result.output.enabled, "1");
  assert.equal(boundary.result.output.max, "2");
  assert.equal(boundary.result.output.roles, "explorer,verifier");
  const boundaryPlan = JSON.parse(String(boundary.result.output.plan));
  assert.equal(boundaryPlan.authorizedSubagentCount, 2);
  assert.deepEqual(boundaryPlan.authorizedAssignments.map((entry: { role: string }) => entry.role), ["explorer", "verifier"]);
  assert.match(String(boundary.result.output.brief), /\[redacted\]/);
  const report = boundary.result.output.subagentReport as Record<string, unknown>;
  assert.equal(report.count, 2);
  assert.equal(report.budget, 2);
  assert.equal(report.withinBudget, true);
  assert.equal(report.entries, undefined, "raw helper entries must not survive in TaskResult output");
  const evidence = boundary.result.output.subagentEvidence as {
    kind: string;
    workerId: string;
    taskId: string;
    redaction: { summary: { redacted: number; truncated: number }; cleanedEntries: Array<{ output: string }>; determinism: { contentDigest: string } };
    assembly: { assembledEvidence: Array<{ role: string; summary: string }>; determinism: { contentDigest: string } };
    runtime: { enforced: boolean; actualSubagentCount: number };
  };
  assert.equal(evidence.kind, "a2a-broker.worker-subagent-runtime-evidence");
  assert.equal(evidence.workerId, "worker-ws5");
  assert.equal(evidence.taskId, "task-ws5");
  assert.equal(evidence.runtime.enforced, true);
  assert.equal(evidence.runtime.actualSubagentCount, 2);
  assert.equal(evidence.redaction.summary.redacted, 2);
  assert.equal(evidence.assembly.assembledEvidence.length, 2);
  assert.match(evidence.assembly.determinism.contentDigest, /^sha256:[0-9a-f]{64}$/);
  const serialized = JSON.stringify(boundary.result.output);
  assert.doesNotMatch(serialized, /runtime-synthetic|\/root\/\.openclaw|123456789/);

  const reversedTask = {
    ...(task as Record<string, unknown>),
    payload: {
      ...((task as { payload: Record<string, unknown> }).payload),
      reverseReport: true,
    },
  } as never;
  const reversed = await handler(reversedTask) as { result: { output: Record<string, unknown> } };
  const reversedEvidence = reversed.result.output.subagentEvidence as typeof evidence;
  assert.equal(reversedEvidence.redaction.determinism.contentDigest, evidence.redaction.determinism.contentDigest);
  assert.deepEqual(reversedEvidence.assembly.assembledEvidence, evidence.assembly.assembledEvidence);
  const reversedReport = reversed.result.output.subagentReport as Record<string, unknown>;
  assert.deepEqual(reversedReport.roles, report.roles);
  assert.deepEqual(reversedReport.writeSets, report.writeSets);

  const duplicateRoleTask = {
    ...(task as Record<string, unknown>),
    payload: {
      ...((task as { payload: Record<string, unknown> }).payload),
      reportedRole: "verifier",
    },
  } as never;
  const duplicateRole = await handler(duplicateRoleTask) as { error: { code: string } };
  assert.equal(duplicateRole.error.code, "subagent_report_duplicate_role");

  const rejectHandler = createExternalWorkerHandler({
    command: process.execPath,
    args: [scriptPath],
    workerId: "worker-ws5",
    subagentCap: 4,
    env: {
      A2A_DOCKER_RUNNER_CLAUDE_CODE_FANOUT_ENABLED: "1",
      A2A_DOCKER_RUNNER_CONTAINED_SUBAGENTS_MAX: "2",
      A2A_DOCKER_RUNNER_CONTAINED_SUBAGENTS_ROLES: "explorer,verifier",
      A2A_WORKER_SUBAGENT_REDACTION_MODE: "reject",
    },
  });
  const preRedactedTask = {
    ...(task as Record<string, unknown>),
    payload: {
      ...((task as { payload: Record<string, unknown> }).payload),
      preRedacted: true,
    },
  } as never;
  const preRedacted = await rejectHandler(preRedactedTask) as { error: { code: string } };
  assert.equal(preRedacted.error.code, "subagent_evidence_rejected");

  const preTruncatedTask = {
    ...(task as Record<string, unknown>),
    payload: {
      ...((task as { payload: Record<string, unknown> }).payload),
      preTruncated: true,
    },
  } as never;
  const preTruncated = await handler(preTruncatedTask) as { result: { output: Record<string, unknown> } };
  const preTruncatedEvidence = preTruncated.result.output.subagentEvidence as typeof evidence;
  assert.equal(preTruncatedEvidence.redaction.summary.truncated, 1);
  assert.equal(preTruncatedEvidence.assembly.assembledEvidence[0]?.summary, "bounded clean prefix");

  const unauthorizedTask = {
    ...(task as Record<string, unknown>),
    payload: {
      ...((task as { payload: Record<string, unknown> }).payload),
      reportedRole: "TOKEN=runtime-synthetic-role",
    },
  } as never;
  const unauthorized = await handler(unauthorizedTask) as { error: { code: string } };
  assert.equal(unauthorized.error.code, "subagent_report_unauthorized_role");
  assert.doesNotMatch(JSON.stringify(unauthorized), /runtime-synthetic-role/);
});

test("dynamic subagent runtime requires broker-recorded operator approval before fanout (Phase-2 WS5)", () => {
  const task = {
    id: "task-ws5-unapproved",
    exchangeId: "exchange-ws5-unapproved",
    intent: "propose_patch",
    requester: { id: "hub", kind: "node", role: "hub" },
    target: { id: "worker-ws5", kind: "node", role: "analyst" },
    message: "large independent patch",
    status: "running",
    targetNodeId: "worker-ws5",
    payload: {
      subagentProfile: {
        size: "large",
        coupling: "low",
        hasIndependentSubtasks: true,
        writeSets: ["src/a.ts", "src/b.ts"],
      },
      spawnAuthorization: {
        state: "authorization_request_draft_ready",
        workerId: "worker-ws5",
        taskId: "task-ws5-unapproved",
        source: { plannerParallelismHint: 3 },
        finalizerReview: { oneFinalizerRequired: true, writeSetIsolationRequired: true },
      },
      workerSubagentBudgetCounter: {
        workerId: "worker-ws5",
        usage: { taskId: "task-ws5-unapproved", taskTokensSpent: 100, taskTokenCeiling: 1_000 },
      },
    },
    createdAt: "2026-07-13T00:00:00Z",
    updatedAt: "2026-07-13T00:00:00Z",
  } as never;
  const runtime = buildDynamicSubagentRuntime(task, {
    workerId: "worker-ws5",
    subagentCap: 4,
    executionIsolation: "shared",
    fanoutEnabled: true,
    staticRunnerMax: 3,
    staticRunnerRoles: ["explorer", "implementer", "verifier"],
  });
  assert.equal(runtime.env.A2A_DOCKER_RUNNER_CLAUDE_CODE_FANOUT_ENABLED, "0");
  assert.equal(JSON.parse(runtime.env.A2A_SUBAGENT_PLAN ?? "{}").reason, "broker_approval_missing_or_untrusted");
});

test("dynamic subagent runtime is default-off and fails closed on absent, insufficient, exhausted, or refused inputs (Phase-2 WS5)", () => {
  const base = {
    id: "task-ws5-closed", exchangeId: "exchange-ws5-closed", intent: "propose_patch",
    requester: { id: "hub", kind: "node", role: "hub" },
    target: { id: "worker-ws5", kind: "node", role: "analyst" },
    message: "large independent patch", status: "running", targetNodeId: "worker-ws5",
    approval: {
      approvalId: "approval-ws5-closed",
      approvedAt: "2026-07-13T00:00:00Z",
      approvedBy: "seoseo-a2a-finalizer",
      actorRole: "operator",
      requesterRole: "operator",
    },
    payload: {
      subagentProfile: { size: "large", coupling: "low", hasIndependentSubtasks: true, writeSets: ["src/a.ts", "src/b.ts"] },
      spawnAuthorization: {
        state: "authorization_request_draft_ready", workerId: "worker-ws5", taskId: "task-ws5-closed",
        source: { plannerParallelismHint: 3 },
        finalizerReview: { oneFinalizerRequired: true, writeSetIsolationRequired: true },
      },
      workerSubagentContextBrief: { workerId: "worker-ws5", summary: "must not be mounted while refused" },
    },
    createdAt: "2026-07-13T00:00:00Z", updatedAt: "2026-07-13T00:00:00Z",
  } as never;
  const options = {
    workerId: "worker-ws5",
    subagentCap: 4,
    executionIsolation: "shared" as const,
    fanoutEnabled: true,
    staticRunnerMax: 3,
    staticRunnerRoles: ["explorer", "implementer", "verifier"],
  };
  const expectClosed = (task: never) => {
    const runtime = buildDynamicSubagentRuntime(task, options);
    assert.equal(runtime.env.A2A_DOCKER_RUNNER_CLAUDE_CODE_FANOUT_ENABLED, "0");
    assert.equal(runtime.env.A2A_DOCKER_RUNNER_CONTAINED_SUBAGENTS_MAX, "0");
    assert.equal(runtime.env.A2A_SUBAGENT_MAX, "0");
    const plan = JSON.parse(runtime.env.A2A_SUBAGENT_PLAN ?? "{}");
    assert.equal(plan.state, "refused");
    assert.equal(plan.taskId, "task-ws5-closed");
    assert.equal(typeof plan.reason, "string");
    assert.equal(runtime.subagentContextBrief, undefined);
  };

  expectClosed(base);
  expectClosed({
    ...(base as Record<string, unknown>),
    payload: {
      ...((base as { payload: Record<string, unknown> }).payload),
      workerSubagentBudgetCounter: { workerId: "worker-ws5", usage: { taskTokensSpent: 100 } },
    },
  } as never);
  expectClosed({
    ...(base as Record<string, unknown>),
    payload: {
      ...((base as { payload: Record<string, unknown> }).payload),
      workerSubagentBudgetCounter: {
        workerId: "worker-ws5",
        usage: { taskTokensSpent: 100, taskTokenCeiling: 1_000 },
      },
    },
  } as never);
  expectClosed({
    ...(base as Record<string, unknown>),
    payload: {
      ...((base as { payload: Record<string, unknown> }).payload),
      spawnAuthorization: {
        state: "authorization_request_draft_ready",
        workerId: "worker-ws5",
        source: { plannerParallelismHint: 3 },
        finalizerReview: { oneFinalizerRequired: true, writeSetIsolationRequired: true },
      },
      workerSubagentBudgetCounter: {
        workerId: "worker-ws5",
        usage: { taskId: "task-ws5-closed", taskTokensSpent: 100, taskTokenCeiling: 1_000 },
      },
    },
  } as never);
  expectClosed({
    ...(base as Record<string, unknown>),
    payload: {
      ...((base as { payload: Record<string, unknown> }).payload),
      workerSubagentBudgetCounter: { workerId: "worker-ws5", usage: { taskTokensSpent: 1_000, taskTokenCeiling: 1_000 } },
    },
  } as never);
  expectClosed({
    ...(base as Record<string, unknown>),
    payload: {
      ...((base as { payload: Record<string, unknown> }).payload),
      spawnAuthorization: {
        state: "blocked",
        workerId: "worker-ws5",
        taskId: "task-ws5-closed",
        finalizerReview: { oneFinalizerRequired: true, writeSetIsolationRequired: true },
      },
      workerSubagentBudgetCounter: {
        workerId: "worker-ws5",
        usage: { taskId: "task-ws5-closed", taskTokensSpent: 100, taskTokenCeiling: 1_000 },
      },
    },
  } as never);
  const off = buildDynamicSubagentRuntime({
    ...(base as Record<string, unknown>),
    payload: {
      ...((base as { payload: Record<string, unknown> }).payload),
      workerSubagentBudgetCounter: {
        workerId: "worker-ws5",
        usage: { taskId: "task-ws5-closed", taskTokensSpent: 100, taskTokenCeiling: 1_000 },
      },
    },
  } as never, { ...options, fanoutEnabled: false });
  assert.deepEqual(off.env, {});
  assert.equal(off.subagentContextBrief, undefined);
});

test("external handler failure excerpt preserves head AND tail of the nested runner message (#1610)", async () => {
  const server = await startTestServer();
  const tempDir = await mkdtemp(join(tmpdir(), "a2a-worker-test-"));
  const scriptPath = join(tempDir, "handler.mjs");

  await writeFile(
    scriptPath,
    [
      'const filler = "x".repeat(4000);',
      "const failure = { error: { code: 'docker_runner_failed', message: `HEAD-MARKER clone start ${filler} TAIL-MARKER the actual error`, details: {} } };",
      "process.stdout.write(JSON.stringify(failure));",
      "process.exitCode = 1;",
    ].join("\n"),
    "utf8",
  );

  const worker = new A2ABrokerWorker({
    brokerUrl: server.baseUrl,
    requesterKind: "node",
    pollIntervalMs: 25,
    heartbeatIntervalMs: 25,
    handlerTimeoutMs: 1_000,
    userAgent: "a2a-broker-worker-test",
    handler: createExternalWorkerHandler({
      command: process.execPath,
      args: [scriptPath],
      timeoutMs: 1_000,
    }),
    worker: {
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
    },
  });

  try {
    await worker.register();
    const task = await createTask(server.baseUrl, {
      intent: "analyze",
      requester: { id: "hub-a", kind: "node", role: "hub" },
      target: { id: "worker-a", kind: "node", role: "analyst" },
      assignedWorkerId: "worker-a",
      message: "run external",
    });

    const processed = await worker.runOnce();
    assert.equal(processed, 1);

    const taskResponse = await fetch(`${server.baseUrl}/tasks/${task.id}`);
    assert.equal(taskResponse.status, 200);
    const failedTask = await taskResponse.json();

    assert.equal(failedTask.status, "failed");
    const excerpt = String(failedTask.error.details.excerpt ?? "");
    assert.match(excerpt, /HEAD-MARKER/);
    assert.match(excerpt, /TAIL-MARKER the actual error/);
  } finally {
    await worker.stop();
    await server.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("external handler non-JSON stderr failure excerpt keeps head AND tail (#1610)", async () => {
  const server = await startTestServer();
  const tempDir = await mkdtemp(join(tmpdir(), "a2a-worker-test-"));
  const scriptPath = join(tempDir, "handler.mjs");

  await writeFile(
    scriptPath,
    [
      "console.error('STDERR-HEAD ' + 'y'.repeat(4000) + ' STDERR-TAIL final failure line');",
      "process.exitCode = 1;",
    ].join("\n"),
    "utf8",
  );

  const worker = new A2ABrokerWorker({
    brokerUrl: server.baseUrl,
    requesterKind: "node",
    pollIntervalMs: 25,
    heartbeatIntervalMs: 25,
    handlerTimeoutMs: 1_000,
    userAgent: "a2a-broker-worker-test",
    handler: createExternalWorkerHandler({
      command: process.execPath,
      args: [scriptPath],
      timeoutMs: 1_000,
    }),
    worker: {
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
    },
  });

  try {
    await worker.register();
    const task = await createTask(server.baseUrl, {
      intent: "analyze",
      requester: { id: "hub-a", kind: "node", role: "hub" },
      target: { id: "worker-a", kind: "node", role: "analyst" },
      assignedWorkerId: "worker-a",
      message: "run external",
    });

    const processed = await worker.runOnce();
    assert.equal(processed, 1);

    const taskResponse = await fetch(`${server.baseUrl}/tasks/${task.id}`);
    assert.equal(taskResponse.status, 200);
    const failedTask = await taskResponse.json();

    assert.equal(failedTask.status, "failed");
    const excerpt = String(failedTask.error.details.excerpt ?? "");
    assert.match(excerpt, /STDERR-HEAD/);
    assert.match(excerpt, /STDERR-TAIL final failure line/);
  } finally {
    await worker.stop();
    await server.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});
