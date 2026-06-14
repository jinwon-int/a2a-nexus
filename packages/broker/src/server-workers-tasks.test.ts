import test from "node:test";
import assert from "node:assert/strict";
import { createHash, createPrivateKey, sign } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBrokerServer } from "./server.js";
import { WorkerRegistrationResponse } from "./core/types.js";
import { buildA2AHttpSignatureBase } from "./core/request-security.js";
import { createInMemoryStateStore, startTestServer, jsonHeaders, registerTestWorker } from "./server-test-helpers.js";


// Synthetic test-only Ed25519 fixture generated locally for deterministic verifier
// coverage. This key pair is not used by any broker or worker deployment.
const routeGatePrivateJwk = {
  crv: "Ed25519",
  d: "AaTuhLv-jaClRWi80aTnBCH7OaqKDTRI1-BhVY6n8hw",
  x: "5WS0NM-6IqCFjg6O1otAWtJV2H-1kdybf7nFp4PEzdY",
  kty: "OKP",
} as const;

const routeGatePublicJwk = {
  crv: "Ed25519",
  x: "5WS0NM-6IqCFjg6O1otAWtJV2H-1kdybf7nFp4PEzdY",
  kty: "OKP",
} as const;

const routeGateKeyRegistry = {
  "worker:sogyo:v1": {
    keyid: "worker:sogyo:v1",
    workerId: "sogyo",
    publicKeyJwk: routeGatePublicJwk,
  },
  "worker:bangtong:v1": {
    keyid: "worker:bangtong:v1",
    workerId: "bangtong",
    publicKeyJwk: routeGatePublicJwk,
  },
};

function signedWorkerHeaders(params: {
  baseUrl: string;
  method: string;
  path: string;
  query?: string;
  workerId: "sogyo" | "bangtong";
  body?: string;
  nonce: string;
}): Record<string, string> {
  const url = new URL(params.path + (params.query ? `?${params.query}` : ""), params.baseUrl);
  const rawBody = Buffer.from(params.body ?? "");
  const headers = {
    "content-type": "application/json",
    "content-digest": `sha-256=:${createHash("sha256").update(rawBody).digest("base64")}:`,
    "x-a2a-requester-id": params.workerId,
    "x-a2a-requester-role": "analyst",
    "x-a2a-broker-id": "seoseo",
  };
  const keyid = `worker:${params.workerId}:v1`;
  const created = Math.floor(Date.now() / 1000) - 1;
  const expires = created + 60;
  const signatureInput = `a2a=("@method" "@authority" "@path" "@query" "content-digest" "x-a2a-requester-id" "x-a2a-requester-role" "x-a2a-broker-id");alg="ed25519";keyid="${keyid}";created=${created};expires=${expires};nonce="${params.nonce}";tag="a2a-worker-v1"`;
  const signatureBase = buildA2AHttpSignatureBase({
    method: params.method,
    authority: url.host,
    path: url.pathname,
    query: url.search.length > 0 ? url.search.slice(1) : "",
    headers,
    signatureInput,
  });
  const privateKey = createPrivateKey({ key: routeGatePrivateJwk, format: "jwk" });
  const signature = sign(null, Buffer.from(signatureBase), privateKey).toString("base64");
  return {
    ...headers,
    "signature-input": signatureInput,
    signature: `a2a=:${signature}:`,
  };
}

function workerPayload(nodeId: "sogyo" | "bangtong") {
  return {
    nodeId,
    role: "analyst",
    capabilities: {
      canAnalyze: true,
      canBackfill: false,
      canPatchWorkspace: true,
      canPromoteLive: false,
      workspaceIds: ["test"],
      environments: ["research"],
    },
  };
}

test("worker registration still records material metadata changes", async () => {
  const server = await startTestServer({ enforceRequesterIdentity: true });
  const nodeId = "worker-a";
  const registration = {
    nodeId,
    role: "analyst",
    displayName: "Worker A",
    capabilities: {
      canAnalyze: true,
      canBackfill: false,
      canPatchWorkspace: true,
      canPromoteLive: false,
      workspaceIds: ["test"],
      environments: ["research"],
    },
    metadata: { runtime: "hermes-agent", transport: "http-poll" },
  };
  const headers = jsonHeaders({
    "x-a2a-requester-id": nodeId,
    "x-a2a-requester-role": "analyst",
  });

  try {
    const first = await fetch(`${server.baseUrl}/workers/register`, {
      method: "POST",
      headers,
      body: JSON.stringify(registration),
    });
    assert.equal(first.status, 201);

    const changed = await fetch(`${server.baseUrl}/workers/register`, {
      method: "POST",
      headers,
      body: JSON.stringify({ ...registration, displayName: "Worker A refreshed" }),
    });
    assert.equal(changed.status, 201);

    assert.equal(
      server.runtime.broker.listAuditEvents({ action: "worker.registered" }).length,
      2,
    );
    assert.equal(server.runtime.broker.getWorker(nodeId)?.displayName, "Worker A refreshed");
  } finally {
    await server.close();
  }
});

test("server accepts a broker-agnostic Hermes-style worker poll and evidence flow", async () => {
  const server = await startTestServer({ enforceRequesterIdentity: false });
  const workerId = "hermes-agent-reference-worker";
  try {
    const registerRes = await fetch(server.baseUrl + "/workers/register", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        nodeId: workerId,
        role: "analyst",
        displayName: "Hermes Agent Reference Worker",
        brokerUrl: "http://127.0.0.1:8787",
        workerMode: "mobile",
        capabilities: {
          canAnalyze: true,
          canBackfill: false,
          canPatchWorkspace: true,
          canPromoteLive: false,
          workspaceIds: ["public-safe-reference"],
          environments: ["research"],
        },
        metadata: {
          runtime: "hermes-agent",
          openClawRequired: "false",
          transport: "http-poll",
        },
      }),
    });
    assert.equal(registerRes.status, 201);
    const registered = await registerRes.json() as WorkerRegistrationResponse;
    assert.equal(registered.nodeId, workerId);
    assert.equal(registered.workerMode, "mobile");
    assert.deepEqual(registered.metadata, {
      runtime: "hermes-agent",
      openClawRequired: "false",
      transport: "http-poll",
    });

    const heartbeatRes = await fetch(server.baseUrl + "/workers/" + workerId + "/heartbeat", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ metadata: { runtime: "hermes-agent", heartbeat: "ok" } }),
    });
    assert.equal(heartbeatRes.status, 200);
    const heartbeat = await heartbeatRes.json() as WorkerRegistrationResponse;
    assert.deepEqual(heartbeat.metadata, { runtime: "hermes-agent", heartbeat: "ok" });

    const createRes = await fetch(server.baseUrl + "/tasks", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        id: "task-hermes-reference-worker",
        requester: { id: "hermes-requester", kind: "service", role: "hub" },
        target: { id: workerId, kind: "node", role: "analyst" },
        targetNodeId: workerId,
        intent: "analyze",
        message: "Broker-agnostic worker contract smoke task",
        payload: { source: "hermes-worker-integration-test" },
        taskOrigin: "api",
      }),
    });
    assert.equal(createRes.status, 201);

    const pollRes = await fetch(
      server.baseUrl + "/tasks?worker=" + encodeURIComponent(workerId) + "&status=pending&detail=full",
    );
    assert.equal(pollRes.status, 200);
    const polled = await pollRes.json() as { items: Array<{ id: string; status: string; assignedWorkerId?: string }> };
    assert.deepEqual(polled.items.map((task) => [task.id, task.status, task.assignedWorkerId]), [
      ["task-hermes-reference-worker", "queued", workerId],
    ]);

    const claimRes = await fetch(server.baseUrl + "/tasks/task-hermes-reference-worker/claim", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ workerId }),
    });
    assert.equal(claimRes.status, 200);

    const startRes = await fetch(server.baseUrl + "/tasks/task-hermes-reference-worker/start", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ workerId }),
    });
    assert.equal(startRes.status, 200);

    const evidenceRes = await fetch(server.baseUrl + "/tasks/task-hermes-reference-worker/evidence", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        workerId,
        outcome: "done",
        result: {
          summary: "Hermes-style worker produced redacted terminal evidence",
          output: { referenceWorker: "hermes-agent", openClawRequired: false },
        },
      }),
    });
    assert.equal(evidenceRes.status, 200);
    const evidenced = await evidenceRes.json() as {
      status: string;
      result?: { summary?: string; output?: Record<string, unknown> };
    };
    assert.equal(evidenced.status, "succeeded");
    assert.equal(evidenced.result?.summary, "Hermes-style worker produced redacted terminal evidence");
    assert.deepEqual(evidenced.result?.output, { referenceWorker: "hermes-agent", openClawRequired: false });
  } finally {
    await server.close();
  }
});


test("strict A2A HTTP Signature worker route gate rejects unsigned worker requests", async () => {
  const server = await startTestServer({
    brokerId: "seoseo",
    a2aHttpSignatureWorkerAuth: "strict",
    a2aHttpSignatureKeyRegistry: routeGateKeyRegistry,
  });
  try {
    const body = JSON.stringify(workerPayload("sogyo"));
    const res = await fetch(`${server.baseUrl}/workers/register`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-requester-id": "sogyo",
        "x-a2a-requester-role": "analyst",
      }),
      body,
    });

    assert.equal(res.status, 401);
    const errorBody = await res.json() as { error: { code: string; message: string } };
    assert.equal(errorBody.error.code, "unauthorized");
    assert.match(errorBody.error.message, /a2a_signature_required/);
  } finally {
    await server.close();
  }
});

test("strict A2A HTTP Signature worker route gate accepts signed worker flow and rejects replay", async () => {
  const server = await startTestServer({
    brokerId: "seoseo",
    a2aHttpSignatureWorkerAuth: "strict",
    a2aHttpSignatureKeyRegistry: routeGateKeyRegistry,
  });
  try {
    const registerBody = JSON.stringify(workerPayload("sogyo"));
    const registerHeaders = signedWorkerHeaders({
      baseUrl: server.baseUrl,
      method: "POST",
      path: "/workers/register",
      workerId: "sogyo",
      body: registerBody,
      nonce: "route-register-sogyo",
    });
    const registerRes = await fetch(`${server.baseUrl}/workers/register`, {
      method: "POST",
      headers: registerHeaders,
      body: registerBody,
    });
    assert.equal(registerRes.status, 201);

    const createRes = await fetch(`${server.baseUrl}/tasks`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-requester-id": "hub-a",
        "x-a2a-requester-role": "hub",
      }),
      body: JSON.stringify({
        id: "signed-worker-poll-task",
        requester: { id: "hub-a", kind: "node", role: "hub" },
        target: { id: "sogyo", kind: "node", role: "analyst" },
        targetNodeId: "sogyo",
        intent: "analyze",
        message: "signed worker should be able to poll this task",
      }),
    });
    assert.equal(createRes.status, 201);

    const unsignedPollRes = await fetch(`${server.baseUrl}/tasks?worker=sogyo&status=pending&detail=full`);
    assert.equal(unsignedPollRes.status, 401);

    const unsignedAssignedPollRes = await fetch(`${server.baseUrl}/tasks?assignedWorkerId=sogyo&status=queued`);
    assert.equal(unsignedAssignedPollRes.status, 401);

    const mismatchedQuery = "worker=sogyo&assignedWorkerId=bangtong&status=pending&detail=full";
    const mismatchedPollRes = await fetch(`${server.baseUrl}/tasks?${mismatchedQuery}`, {
      headers: signedWorkerHeaders({
        baseUrl: server.baseUrl,
        method: "GET",
        path: "/tasks",
        query: mismatchedQuery,
        workerId: "sogyo",
        nonce: "route-poll-mismatched-worker-params",
      }),
    });
    assert.equal(mismatchedPollRes.status, 400);

    const emptyWorkerAssignedQuery = "worker=&assignedWorkerId=bangtong&status=pending&detail=full";
    const emptyWorkerAssignedRes = await fetch(`${server.baseUrl}/tasks?${emptyWorkerAssignedQuery}`, {
      headers: signedWorkerHeaders({
        baseUrl: server.baseUrl,
        method: "GET",
        path: "/tasks",
        query: emptyWorkerAssignedQuery,
        workerId: "sogyo",
        nonce: "route-poll-empty-worker-assigned-victim",
      }),
    });
    assert.equal(emptyWorkerAssignedRes.status, 401);

    const query = "worker=sogyo&status=pending&detail=full";
    const pollHeaders = signedWorkerHeaders({
      baseUrl: server.baseUrl,
      method: "GET",
      path: "/tasks",
      query,
      workerId: "sogyo",
      nonce: "route-poll-sogyo",
    });
    const pollRes = await fetch(`${server.baseUrl}/tasks?${query}`, {
      headers: pollHeaders,
    });
    assert.equal(pollRes.status, 200);
    const pollBody = await pollRes.json() as { items: Array<{ id: string }> };
    assert.deepEqual(pollBody.items.map((task) => task.id), ["signed-worker-poll-task"]);

    const replayRes = await fetch(`${server.baseUrl}/tasks?${query}`, {
      headers: pollHeaders,
    });
    assert.equal(replayRes.status, 401);
    const replayBody = await replayRes.json() as { error: { message: string } };
    assert.match(replayBody.error.message, /a2a_signature_replay/);
  } finally {
    await server.close();
  }
});

test("strict A2A HTTP Signature worker route gate fails closed when the signing key lacks the route scope (#691)", async () => {
  // sogyo's key is scoped to registration/heartbeat only; bangtong stays unscoped (legacy).
  const scopedKeyRegistry = {
    "worker:sogyo:v1": {
      ...routeGateKeyRegistry["worker:sogyo:v1"],
      scopes: ["worker.register", "worker.heartbeat"] as const,
    },
    "worker:bangtong:v1": routeGateKeyRegistry["worker:bangtong:v1"],
  };
  const server = await startTestServer({
    brokerId: "seoseo",
    a2aHttpSignatureWorkerAuth: "strict",
    a2aHttpSignatureKeyRegistry: scopedKeyRegistry,
  });
  try {
    // In-scope route (worker.register) is authorized.
    const registerBody = JSON.stringify(workerPayload("sogyo"));
    const registerRes = await fetch(`${server.baseUrl}/workers/register`, {
      method: "POST",
      headers: signedWorkerHeaders({
        baseUrl: server.baseUrl,
        method: "POST",
        path: "/workers/register",
        workerId: "sogyo",
        body: registerBody,
        nonce: "scoped-register-sogyo",
      }),
      body: registerBody,
    });
    assert.equal(registerRes.status, 201);

    // Out-of-scope route (tasks.list) fails closed with 403 even though the
    // signature itself is valid and the requester id matches the key owner.
    const query = "worker=sogyo&status=pending&detail=full";
    const pollRes = await fetch(`${server.baseUrl}/tasks?${query}`, {
      headers: signedWorkerHeaders({
        baseUrl: server.baseUrl,
        method: "GET",
        path: "/tasks",
        query,
        workerId: "sogyo",
        nonce: "scoped-poll-sogyo-denied",
      }),
    });
    assert.equal(pollRes.status, 403);
    const pollBody = await pollRes.json() as { error: { code: string; message: string } };
    assert.equal(pollBody.error.code, "policy_denied");
    assert.match(pollBody.error.message, /a2a_signature_scope_denied: signing key is not authorized for tasks\.list/);

    // An unscoped (legacy) key remains authorized for the same route.
    const bangtongQuery = "worker=bangtong&status=pending&detail=full";
    const bangtongPollRes = await fetch(`${server.baseUrl}/tasks?${bangtongQuery}`, {
      headers: signedWorkerHeaders({
        baseUrl: server.baseUrl,
        method: "GET",
        path: "/tasks",
        query: bangtongQuery,
        workerId: "bangtong",
        nonce: "scoped-poll-bangtong-allowed",
      }),
    });
    assert.equal(bangtongPollRes.status, 200);
  } finally {
    await server.close();
  }
});

test("strict A2A HTTP Signature worker route gate does not let one worker mutate another worker task", async () => {
  const server = await startTestServer({
    brokerId: "seoseo",
    enforceRequesterIdentity: false,
    a2aHttpSignatureWorkerAuth: "strict",
    a2aHttpSignatureKeyRegistry: routeGateKeyRegistry,
  });
  try {
    for (const workerId of ["sogyo", "bangtong"] as const) {
      const body = JSON.stringify(workerPayload(workerId));
      const headers = signedWorkerHeaders({
        baseUrl: server.baseUrl,
        method: "POST",
        path: "/workers/register",
        workerId,
        body,
        nonce: `route-register-${workerId}`,
      });
      const res = await fetch(`${server.baseUrl}/workers/register`, {
        method: "POST",
        headers,
        body,
      });
      assert.equal(res.status, 201);
    }

    const createRes = await fetch(`${server.baseUrl}/tasks`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-requester-id": "hub-a",
        "x-a2a-requester-role": "hub",
      }),
      body: JSON.stringify({
        id: "bangtong-owned-task",
        requester: { id: "hub-a", kind: "node", role: "hub" },
        target: { id: "bangtong", kind: "node", role: "analyst" },
        targetNodeId: "bangtong",
        intent: "analyze",
        message: "sogyo must not claim as bangtong",
      }),
    });
    assert.equal(createRes.status, 201);

    const claimBody = JSON.stringify({ workerId: "bangtong" });
    const claimHeaders = signedWorkerHeaders({
      baseUrl: server.baseUrl,
      method: "POST",
      path: "/tasks/bangtong-owned-task/claim",
      workerId: "sogyo",
      body: claimBody,
      nonce: "route-cross-worker-claim",
    });
    const claimRes = await fetch(`${server.baseUrl}/tasks/bangtong-owned-task/claim`, {
      method: "POST",
      headers: claimHeaders,
      body: claimBody,
    });
    assert.equal(claimRes.status, 401);
  } finally {
    await server.close();
  }
});


test("strict A2A HTTP Signature worker route gate binds signed worker to poll query even without requester identity enforcement", async () => {
  const server = await startTestServer({
    brokerId: "seoseo",
    enforceRequesterIdentity: false,
    a2aHttpSignatureWorkerAuth: "strict",
    a2aHttpSignatureKeyRegistry: routeGateKeyRegistry,
  });
  try {
    for (const workerId of ["sogyo", "bangtong"] as const) {
      const body = JSON.stringify(workerPayload(workerId));
      const headers = signedWorkerHeaders({
        baseUrl: server.baseUrl,
        method: "POST",
        path: "/workers/register",
        workerId,
        body,
        nonce: `route-poll-bind-register-${workerId}`,
      });
      const res = await fetch(`${server.baseUrl}/workers/register`, { method: "POST", headers, body });
      assert.equal(res.status, 201);
    }

    const createRes = await fetch(`${server.baseUrl}/tasks`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-requester-id": "hub-a",
        "x-a2a-requester-role": "hub",
      }),
      body: JSON.stringify({
        id: "sogyo-owned-poll-task",
        requester: { id: "hub-a", kind: "node", role: "hub" },
        target: { id: "sogyo", kind: "node", role: "analyst" },
        targetNodeId: "sogyo",
        intent: "analyze",
        message: "bangtong must not poll sogyo queue",
      }),
    });
    assert.equal(createRes.status, 201);

    const query = "worker=sogyo&status=pending&detail=full";
    const pollHeaders = signedWorkerHeaders({
      baseUrl: server.baseUrl,
      method: "GET",
      path: "/tasks",
      query,
      workerId: "bangtong",
      nonce: "route-cross-worker-poll",
    });
    const pollRes = await fetch(`${server.baseUrl}/tasks?${query}`, { headers: pollHeaders });
    assert.equal(pollRes.status, 401);
    const body = await pollRes.json() as { error: { message: string } };
    assert.match(body.error.message, /a2a_signature_identity_mismatch/);
  } finally {
    await server.close();
  }
});

test("strict A2A HTTP Signature worker route gate rejects unsigned assignment-events subscriptions", async () => {
  const server = await startTestServer({
    brokerId: "seoseo",
    a2aHttpSignatureWorkerAuth: "strict",
    a2aHttpSignatureKeyRegistry: routeGateKeyRegistry,
  });
  try {
    const registerBody = JSON.stringify(workerPayload("sogyo"));
    const registerHeaders = signedWorkerHeaders({
      baseUrl: server.baseUrl,
      method: "POST",
      path: "/workers/register",
      workerId: "sogyo",
      body: registerBody,
      nonce: "route-assignment-register-sogyo",
    });
    const registerRes = await fetch(`${server.baseUrl}/workers/register`, {
      method: "POST",
      headers: registerHeaders,
      body: registerBody,
    });
    assert.equal(registerRes.status, 201);

    const unsignedRes = await fetch(`${server.baseUrl}/a2a/workers/sogyo/assignment-events`, {
      headers: {
        "x-a2a-requester-id": "sogyo",
        "x-a2a-requester-role": "analyst",
      },
    });
    assert.equal(unsignedRes.status, 401);
    const errorBody = await unsignedRes.json() as { error: { message: string } };
    assert.match(errorBody.error.message, /a2a_signature_required/);
  } finally {
    await server.close();
  }
});

test("A2A HTTP Signature worker route gate rejects body digest mismatches and optional-mode malformed signatures", async () => {
  const strictServer = await startTestServer({
    brokerId: "seoseo",
    a2aHttpSignatureWorkerAuth: "strict",
    a2aHttpSignatureKeyRegistry: routeGateKeyRegistry,
  });
  try {
    const signedBody = JSON.stringify(workerPayload("sogyo"));
    const mutatedBody = JSON.stringify({ ...workerPayload("sogyo"), displayName: "tampered-body" });
    const headers = signedWorkerHeaders({
      baseUrl: strictServer.baseUrl,
      method: "POST",
      path: "/workers/register",
      workerId: "sogyo",
      body: signedBody,
      nonce: "route-digest-mismatch",
    });
    const mismatchRes = await fetch(`${strictServer.baseUrl}/workers/register`, {
      method: "POST",
      headers,
      body: mutatedBody,
    });
    assert.equal(mismatchRes.status, 401);
    const mismatchBody = await mismatchRes.json() as { error: { message: string } };
    assert.match(mismatchBody.error.message, /a2a_signature_digest_mismatch/);

    const missingDigestHeaders = { ...headers };
    delete missingDigestHeaders["content-digest"];
    const missingDigestRes = await fetch(`${strictServer.baseUrl}/workers/register`, {
      method: "POST",
      headers: missingDigestHeaders,
      body: signedBody,
    });
    assert.equal(missingDigestRes.status, 401);
    const missingDigestBody = await missingDigestRes.json() as { error: { message: string } };
    assert.match(missingDigestBody.error.message, /a2a_signature_digest_required/);
  } finally {
    await strictServer.close();
  }

  const optionalServer = await startTestServer({
    brokerId: "seoseo",
    a2aHttpSignatureWorkerAuth: "optional",
    a2aHttpSignatureKeyRegistry: routeGateKeyRegistry,
  });
  try {
    const body = JSON.stringify(workerPayload("sogyo"));
    const malformedHeaders = signedWorkerHeaders({
      baseUrl: optionalServer.baseUrl,
      method: "POST",
      path: "/workers/register",
      workerId: "sogyo",
      body,
      nonce: "route-optional-malformed",
    });
    malformedHeaders.signature = "a2a=:not-valid-base64?:";
    const malformedRes = await fetch(`${optionalServer.baseUrl}/workers/register`, {
      method: "POST",
      headers: malformedHeaders,
      body,
    });
    assert.equal(malformedRes.status, 401);
  } finally {
    await optionalServer.close();
  }
});


test("strict A2A HTTP Signature worker route gate loads worker public keys from a registry file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-route-signature-registry-"));
  const registryFile = join(dir, "worker-public-keys.json");
  writeFileSync(registryFile, JSON.stringify(routeGateKeyRegistry));

  const server = await startTestServer({
    brokerId: "seoseo",
    a2aHttpSignatureWorkerAuth: "strict",
    a2aHttpSignatureKeyRegistryFile: registryFile,
  });
  try {
    assert.equal(server.runtime.config.a2aHttpSignatureWorkerKeyCount, 2);
    assert.equal(server.runtime.config.a2aHttpSignatureWorkerKeySource, "file");

    const healthRes = await fetch(`${server.baseUrl}/health`);
    assert.equal(healthRes.status, 200);
    const health = await healthRes.json() as { requestSecurity: { a2aHttpSignatureWorkerKeyCount: number; a2aHttpSignatureWorkerKeySource: string } };
    assert.equal(health.requestSecurity.a2aHttpSignatureWorkerKeyCount, 2);
    assert.equal(health.requestSecurity.a2aHttpSignatureWorkerKeySource, "file");

    const body = JSON.stringify(workerPayload("sogyo"));
    const res = await fetch(`${server.baseUrl}/workers/register`, {
      method: "POST",
      headers: signedWorkerHeaders({
        baseUrl: server.baseUrl,
        method: "POST",
        path: "/workers/register",
        workerId: "sogyo",
        body,
        nonce: "route-file-registry-register-sogyo",
      }),
      body,
    });
    assert.equal(res.status, 201);
  } finally {
    await server.close();
  }
});

test("server requires a real PUBLIC_BASE_URL", () => {
  assert.throws(
    () =>
      createBrokerServer({
        host: "127.0.0.1",
        port: 0,
        publicBaseUrl: "http://<masked-host>:8787",
        stateStore: createInMemoryStateStore(),
      }),
    /PUBLIC_BASE_URL must not use the placeholder/,
  );

  assert.throws(
    () =>
      createBrokerServer({
        host: "127.0.0.1",
        port: 0,
        publicBaseUrl: "",
        stateStore: createInMemoryStateStore(),
      }),
    /PUBLIC_BASE_URL is required/,
  );
});

test("server rejects task creation when brokerOfRecord targets another broker", async () => {
  const server = await startTestServer({ brokerId: "gwakga" });
  try {
    const registerRes = await fetch(`${server.baseUrl}/workers/register`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-requester-id": "soonwook",
        "x-a2a-requester-role": "analyst",
      }),
      body: JSON.stringify({
        nodeId: "soonwook",
        role: "analyst",
        capabilities: {
          canAnalyze: true,
          canBackfill: false,
          canPatchWorkspace: true,
          canPromoteLive: false,
        },
      }),
    });
    assert.equal(registerRes.status, 201);

    const createRes = await fetch(`${server.baseUrl}/tasks`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-requester-id": "hub-a",
        "x-a2a-requester-role": "hub",
      }),
      body: JSON.stringify({
        id: "wrong-broker-of-record-task",
        intent: "validate_change",
        requester: { id: "hub-a", kind: "node", role: "hub" },
        target: { id: "soonwook", kind: "node", role: "analyst" },
        assignedWorkerId: "soonwook",
        brokerOfRecord: "seoseo",
        teamId: "team2",
        message: "should fail at creation before it can become queued",
      }),
    });
    assert.equal(createRes.status, 403);
    assert.deepEqual(await createRes.json(), {
      error: {
        code: "policy_denied",
        message: "create cannot set brokerOfRecord seoseo on broker gwakga",
      },
    });

    const listRes = await fetch(`${server.baseUrl}/tasks?detail=full`);
    assert.equal(listRes.status, 200);
    const listBody = await listRes.json() as { items: Array<{ id: string }> };
    assert.deepEqual(listBody.items.map((task) => task.id), []);
  } finally {
    await server.close();
  }
});

test("server accepts local brokerOfRecord with parent-owned cross-broker Terminal Brief metadata", async () => {
  const server = await startTestServer({ brokerId: "gwakga", teamId: "team2" });
  try {
    const registerRes = await fetch(`${server.baseUrl}/workers/register`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-requester-id": "jingun",
        "x-a2a-requester-role": "analyst",
      }),
      body: JSON.stringify({
        nodeId: "jingun",
        role: "analyst",
        capabilities: {
          canAnalyze: true,
          canBackfill: false,
          canPatchWorkspace: true,
          canPromoteLive: false,
        },
      }),
    });
    assert.equal(registerRes.status, 201);

    const createRes = await fetch(`${server.baseUrl}/tasks`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-requester-id": "seoseo",
        "x-a2a-requester-role": "hub",
      }),
      body: JSON.stringify({
        id: "seoseo-led-team2-parent-owned-task",
        intent: "verify",
        requester: { id: "seoseo", kind: "node", role: "hub" },
        target: { id: "jingun", kind: "node", role: "analyst" },
        assignedWorkerId: "jingun",
        brokerOfRecord: "gwakga",
        teamId: "team2",
        message: "source-only Team2 handoff with Seoseo parent ownership",
        payload: {
          parentRoundId: "terminal-brief-contract-round",
          parentRoundTotal: 7,
          parentRoundOrder: 6,
          parentBrokerId: "seoseo",
          brokerOfRecordId: "seoseo",
          crossBrokerHandoff: {
            parentRoundId: "terminal-brief-contract-round",
            originBrokerId: "seoseo",
            handoffBrokerId: "gwakga",
            childWorkerId: "jingun",
          },
          notificationOwnership: {
            owner: "parent",
            ownerBrokerId: "seoseo",
            scope: "parent-broker-only",
            providerSendPermittedByProjection: false,
            terminalAckPermittedByProjection: false,
          },
          terminalBrief: {
            parentOwnedTerminalBrief: true,
            notificationOwnership: {
              owner: "parent",
              ownerBrokerId: "seoseo",
              scope: "parent-broker-only",
            },
          },
        },
      }),
    });
    assert.equal(createRes.status, 201);
    const created = await createRes.json() as {
      brokerOfRecord?: string;
      teamId?: string;
      payload?: Record<string, unknown>;
    };
    assert.equal(created.brokerOfRecord, "gwakga", "top-level brokerOfRecord is the local accepting broker");
    assert.equal(created.teamId, "team2");
    assert.equal(created.payload?.["brokerOfRecordId"], "seoseo", "parent/finalizer owner remains payload metadata");
    assert.deepEqual(created.payload?.["crossBrokerHandoff"], {
      parentRoundId: "terminal-brief-contract-round",
      originBrokerId: "seoseo",
      handoffBrokerId: "gwakga",
      childWorkerId: "jingun",
    });
    assert.deepEqual(created.payload?.["notificationOwnership"], {
      owner: "parent",
      ownerBrokerId: "seoseo",
      scope: "parent-broker-only",
      providerSendPermittedByProjection: false,
      terminalAckPermittedByProjection: false,
      reason: "parent-owned cross-broker Terminal Brief; handoff broker event is aggregation evidence only; parent broker owns operator notification and ACK",
    });
  } finally {
    await server.close();
  }
});

test("server rejects parent-owned handoff metadata for a different accepting broker", async () => {
  const server = await startTestServer({ brokerId: "gwakga", teamId: "team2" });
  try {
    const registerRes = await fetch(`${server.baseUrl}/workers/register`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-requester-id": "jingun",
        "x-a2a-requester-role": "analyst",
      }),
      body: JSON.stringify({
        nodeId: "jingun",
        role: "analyst",
        capabilities: {
          canAnalyze: true,
          canBackfill: false,
          canPatchWorkspace: true,
          canPromoteLive: false,
        },
      }),
    });
    assert.equal(registerRes.status, 201);

    const createRes = await fetch(`${server.baseUrl}/tasks`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-requester-id": "seoseo",
        "x-a2a-requester-role": "hub",
      }),
      body: JSON.stringify({
        id: "wrong-handoff-broker-parent-owned-task",
        intent: "verify",
        requester: { id: "seoseo", kind: "node", role: "hub" },
        target: { id: "jingun", kind: "node", role: "analyst" },
        assignedWorkerId: "jingun",
        brokerOfRecord: "gwakga",
        teamId: "team2",
        message: "contradictory handoff metadata should fail closed",
        payload: {
          parentRoundId: "terminal-brief-contract-round",
          parentRoundTotal: 7,
          parentRoundOrder: 6,
          parentBrokerId: "seoseo",
          crossBrokerHandoff: {
            parentRoundId: "terminal-brief-contract-round",
            originBrokerId: "seoseo",
            handoffBrokerId: "seoseo",
          },
        },
      }),
    });
    assert.equal(createRes.status, 400);
    const body = await createRes.json() as { error?: { code?: string; message?: string } };
    assert.equal(body.error?.code, "bad_request");
    assert.match(body.error?.message ?? "", /handoffBrokerId/);
    assert.match(body.error?.message ?? "", /accepting broker/);
  } finally {
    await server.close();
  }
});

test("server rejects invalid requester identity headers with 400", async () => {
  const server = await startTestServer();
  try {
    const invalidRoleRes = await fetch(`${server.baseUrl}/dashboard`, {
      headers: {
        "x-a2a-requester-id": "worker-a",
        "x-a2a-requester-role": "invalid-role",
      },
    });
    assert.equal(invalidRoleRes.status, 400);
    const invalidRoleBody = await invalidRoleRes.json();
    assert.match(invalidRoleBody.error.message, /x-a2a-requester-role must be one of/);

    const missingIdRes = await fetch(`${server.baseUrl}/dashboard`, {
      headers: {
        "x-a2a-requester-kind": "node",
      },
    });
    assert.equal(missingIdRes.status, 400);
    const missingIdBody = await missingIdRes.json();
    assert.match(missingIdBody.error.message, /x-a2a-requester-id is required/);
  } finally {
    await server.close();
  }
});

test("server maps GitHub completion evidence BrokerErrors to client errors", async () => {
  const server = await startTestServer();
  try {
    server.runtime.broker.registerWorker({
      nodeId: "worker-github-http",
      role: "analyst",
      capabilities: {
        canAnalyze: true,
        canBackfill: false,
        canPatchWorkspace: true,
        canPromoteLive: false,
        workspaceIds: ["repo"],
        environments: ["research"],
      },
    });
    const task = server.runtime.broker.createTask({
      id: "task-github-http-evidence-missing",
      intent: "propose_patch",
      requester: { id: "operator-a", kind: "user", role: "operator" },
      target: { id: "worker-github-http", kind: "node", role: "analyst" },
      assignedWorkerId: "worker-github-http",
      message: "test GitHub completion evidence mapping",
      taskOrigin: "github",
      payload: {
        mode: "github-propose-patch",
        repo: "jinwon-int/a2a-broker",
        issueNumber: 1032,
        issueUrl: "https://github.com/jinwon-int/a2a-broker/issues/1032",
      },
    });
    server.runtime.broker.claimTask(task.id, "worker-github-http");
    server.runtime.broker.startTask(task.id, "worker-github-http");

    const res = await fetch(`${server.baseUrl}/tasks/${task.id}/complete`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-requester-id": "worker-github-http",
        "x-a2a-requester-role": "analyst",
      }),
      body: JSON.stringify({
        workerId: "worker-github-http",
        result: { summary: "done without public GitHub evidence" },
      }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.deepEqual(body.error, {
      code: "github_completion_evidence_missing",
      message: "github-origin propose_patch tasks must return PR, Done-comment, or Block-comment evidence before they can succeed",
    });
  } finally {
    await server.close();
  }
});

test("server rejects unauthorized reassign with 401", async () => {
  const server = await startTestServer();
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
      headers: {
        "content-type": "application/json",
        "x-a2a-requester-id": "worker-a",
        "x-a2a-requester-role": "analyst",
      },
      body: JSON.stringify({ nodeId: "worker-a", ...workerPayload }),
    });
    await fetch(`${server.baseUrl}/workers/register`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-a2a-requester-id": "worker-b",
        "x-a2a-requester-role": "analyst",
      },
      body: JSON.stringify({ nodeId: "worker-b", ...workerPayload }),
    });

    const exchangeRes = await fetch(`${server.baseUrl}/exchanges`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-a2a-requester-id": "hub-a",
        "x-a2a-requester-role": "hub",
      },
      body: JSON.stringify({
        requester: { id: "hub-a", kind: "node", role: "hub" },
        target: { id: "worker-a", kind: "node", role: "analyst" },
        message: "root",
        intent: "analyze",
      }),
    });
    const exchange = await exchangeRes.json();

    await fetch(`${server.baseUrl}/exchanges/${exchange.id}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-a2a-requester-id": "hub-a",
        "x-a2a-requester-role": "hub",
      },
      body: JSON.stringify({
        actor: { id: "hub-a", kind: "node", role: "hub" },
        message: "accepted",
        decision: "accepted",
        targetNodeId: "worker-a",
        assignedWorkerId: "worker-a",
      }),
    });

    const exchangeStateRes = await fetch(`${server.baseUrl}/exchanges/${exchange.id}`);
    const exchangeState = await exchangeStateRes.json();
    const reassignRes = await fetch(`${server.baseUrl}/tasks/${exchangeState.activeTaskId}/reassign`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-a2a-requester-id": "worker-a",
        "x-a2a-requester-role": "analyst",
      },
      body: JSON.stringify({
        actor: { id: "worker-a", kind: "node", role: "analyst" },
        targetNodeId: "worker-b",
        assignedWorkerId: "worker-b",
        note: "should fail",
      }),
    });

    assert.equal(reassignRes.status, 401);
    const errorBody = await reassignRes.json();
    assert.equal(errorBody.error.code, "unauthorized");
  } finally {
    await server.close();
  }
});

test("server approves blocked live-impact task with operator audit metadata", async () => {
  const server = await startTestServer();
  try {
    await registerTestWorker(server.baseUrl, "worker-a", "analyst");

    const createRes = await fetch(`${server.baseUrl}/tasks`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-requester-id": "analyst-a",
        "x-a2a-requester-role": "analyst",
      }),
      body: JSON.stringify({
        intent: "promote_to_live",
        requester: { id: "analyst-a", kind: "node", role: "analyst" },
        target: { id: "worker-a", kind: "node", role: "analyst" },
        message: "promote after review",
      }),
    });
    assert.equal(createRes.status, 201);
    const task = await createRes.json();
    assert.equal(task.status, "blocked");

    const deniedApprove = await fetch(`${server.baseUrl}/tasks/${task.id}/approve`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-requester-id": "analyst-a",
        "x-a2a-requester-role": "analyst",
      }),
      body: JSON.stringify({
        actor: { id: "analyst-a", kind: "node", role: "analyst" },
        reason: "not authorized",
      }),
    });
    assert.equal(deniedApprove.status, 401);

    const approveRes = await fetch(`${server.baseUrl}/tasks/${task.id}/approve`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-requester-id": "operator-a",
        "x-a2a-requester-role": "operator",
      }),
      body: JSON.stringify({
        actor: { id: "operator-a", kind: "node", role: "operator" },
        approvalId: "approval-http-1",
        reason: "change ticket reviewed",
      }),
    });
    assert.equal(approveRes.status, 200);
    const approved = await approveRes.json();
    assert.equal(approved.status, "queued");
    assert.equal(approved.approval.approvalId, "approval-http-1");
    assert.equal(approved.approval.approvedBy, "operator-a");
    assert.equal(approved.approval.actorRole, "operator");
    assert.equal(approved.approval.requesterRole, "analyst");
    assert.equal(approved.approval.reason, "change ticket reviewed");

    const auditRes = await fetch(`${server.baseUrl}/audit?action=task.approved&targetId=${task.id}`);
    const audit = await auditRes.json();
    assert.equal(audit.items.length, 1);
    assert.equal(audit.items[0].actorId, "operator-a");
    assert.equal(audit.items[0].note, "change ticket reviewed");
  } finally {
    await server.close();
  }
});

test("GET /tasks returns lightweight task summaries and keeps full detail opt-in", async () => {
  const { baseUrl, close } = await startTestServer({ enforceRequesterIdentity: false });
  try {
    const largeOutput = "x".repeat(20_000);
    await registerTestWorker(baseUrl, "worker-a", "analyst");
    const createRes = await fetch(`${baseUrl}/tasks`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        id: "task-list-diet",
        requester: { id: "requester", kind: "session", role: "hub" },
        target: { id: "worker-a", kind: "node", role: "analyst" },
        targetNodeId: "worker-a",
        intent: "chat",
        payload: { rawLog: largeOutput },
      }),
    });
    assert.equal(createRes.status, 201);

    const task = await createRes.json();
    await fetch(`${baseUrl}/tasks/${task.id}/claim`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ workerId: "worker-a" }),
    });
    await fetch(`${baseUrl}/tasks/${task.id}/start`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ workerId: "worker-a" }),
    });
    await fetch(`${baseUrl}/tasks/${task.id}/complete`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        workerId: "worker-a",
        result: {
          summary: "short summary",
          artifactIds: ["artifact-1"],
          output: { rawLog: largeOutput },
        },
      }),
    });

    const listBody = await (await fetch(`${baseUrl}/tasks`)).json();
    assert.equal(listBody.items[0].id, "task-list-diet");
    assert.equal(listBody.items[0].resultSummary, "short summary");
    assert.deepEqual(listBody.items[0].artifactIds, ["artifact-1"]);
    assert.equal("payload" in listBody.items[0], false);
    assert.equal("result" in listBody.items[0], false);
    assert.ok(JSON.stringify(listBody).length < 2_000);

    const rpcListBody = await (await fetch(`${baseUrl}/a2a/jsonrpc`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ListTasks", params: {} }),
    })).json();
    assert.equal(rpcListBody.result.tasks[0].metadata.resultSummary, "short summary");
    assert.equal("result" in rpcListBody.result.tasks[0].metadata, false);
    assert.ok(JSON.stringify(rpcListBody).length < 2_000);

    const detailBody = await (await fetch(`${baseUrl}/tasks/${task.id}`)).json();
    assert.equal(detailBody.payload.rawLog.length, largeOutput.length);
    assert.equal(detailBody.result.output.rawLog.length, largeOutput.length);

    const fullListBody = await (await fetch(`${baseUrl}/tasks?detail=full`)).json();
    assert.equal(fullListBody.items[0].payload.rawLog.length, largeOutput.length);
    assert.equal(fullListBody.items[0].result.output.rawLog.length, largeOutput.length);
  } finally {
    await close();
  }
});

test("GET /tasks applies explicit bounded limits", async () => {
  const { baseUrl, close } = await startTestServer({ enforceRequesterIdentity: false });
  try {
    await registerTestWorker(baseUrl, "worker-a", "analyst");
    for (let i = 0; i < 3; i += 1) {
      const createRes = await fetch(`${baseUrl}/tasks`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({
          id: `task-list-bound-${i}`,
          requester: { id: "requester", kind: "session", role: "hub" },
          target: { id: "worker-a", kind: "node", role: "analyst" },
          targetNodeId: "worker-a",
          intent: "chat",
          message: `bounded task ${i}`,
        }),
      });
      assert.equal(createRes.status, 201);
    }

    const limitedBody = await (await fetch(`${baseUrl}/tasks?limit=2`)).json();
    assert.equal(limitedBody.count, 2);
    assert.equal(limitedBody.limit, 2);
    assert.equal(limitedBody.items.length, 2);

    const cappedBody = await (await fetch(`${baseUrl}/tasks?limit=9999`)).json();
    assert.equal(cappedBody.count, 3);
    assert.equal(cappedBody.limit, 500);

    const badLimitRes = await fetch(`${baseUrl}/tasks?limit=1.5`);
    assert.equal(badLimitRes.status, 400);
  } finally {
    await close();
  }
});

test("server returns subtree items and thread structure for exchange messages", async () => {
  const server = await startTestServer();
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
      headers: {
        "content-type": "application/json",
        "x-a2a-requester-id": "worker-a",
        "x-a2a-requester-role": "analyst",
      },
      body: JSON.stringify({ nodeId: "worker-a", ...workerPayload }),
    });

    const exchangeRes = await fetch(`${server.baseUrl}/exchanges`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-a2a-requester-id": "hub-a",
        "x-a2a-requester-role": "hub",
      },
      body: JSON.stringify({
        requester: { id: "hub-a", kind: "node", role: "hub" },
        target: { id: "worker-a", kind: "node", role: "analyst" },
        message: "root",
        intent: "analyze",
      }),
    });
    const exchange = await exchangeRes.json();

    const acceptedRes = await fetch(`${server.baseUrl}/exchanges/${exchange.id}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-a2a-requester-id": "hub-a",
        "x-a2a-requester-role": "hub",
      },
      body: JSON.stringify({
        actor: { id: "hub-a", kind: "node", role: "hub" },
        message: "accepted",
        decision: "accepted",
        parentMessageId: exchange.rootMessageId,
        targetNodeId: "worker-a",
        assignedWorkerId: "worker-a",
        via: { transport: "http", traceId: "server-test-accept" },
      }),
    });
    const accepted = await acceptedRes.json();

    await fetch(`${server.baseUrl}/exchanges/${exchange.id}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-a2a-requester-id": "worker-a",
        "x-a2a-requester-role": "analyst",
      },
      body: JSON.stringify({
        actor: { id: "worker-a", kind: "node", role: "analyst" },
        message: "need clarification",
        decision: "needs_clarification",
        parentMessageId: accepted.id,
      }),
    });

    const subtreeRes = await fetch(
      `${server.baseUrl}/exchanges/${exchange.id}/messages?parentMessageId=${accepted.id}&includeDescendants=true`,
    );
    assert.equal(subtreeRes.status, 200);
    const subtree = await subtreeRes.json();

    assert.equal(subtree.items.length, 2);
    assert.equal(subtree.threads.length, 1);
    assert.equal(subtree.threads[0].id, accepted.id);
    assert.equal(subtree.threads[0].via.traceId, "server-test-accept");
    assert.equal(subtree.threads[0].replies.length, 1);
    assert.equal(subtree.threads[0].replies[0].decision, "needs_clarification");
  } finally {
    await server.close();
  }
});

test("server splits worker lifecycle rate limits from general request limits", async () => {
  const server = await startTestServer({
    edgeSecret: "test-edge-secret",
    rateLimitMaxRequests: 1,
    rateLimitWindowSec: 60,
    workerRateLimitMaxRequests: 3,
    workerRateLimitWindowSec: 60,
  });

  try {
    const registerRes = await fetch(`${server.baseUrl}/workers/register`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "worker-a",
        "x-a2a-requester-role": "analyst",
      }),
      body: JSON.stringify({
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
      }),
    });
    assert.equal(registerRes.status, 201);
    assert.equal(registerRes.headers.get("x-a2a-ratelimit-bucket"), "worker");

    const auditOne = await fetch(`${server.baseUrl}/audit`, {
      headers: {
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "worker-a",
        "x-a2a-requester-role": "analyst",
      },
    });
    assert.equal(auditOne.status, 200);
    assert.equal(auditOne.headers.get("x-a2a-ratelimit-bucket"), "general");

    const heartbeatRes = await fetch(`${server.baseUrl}/workers/worker-a/heartbeat`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "worker-a",
        "x-a2a-requester-role": "analyst",
      }),
      body: JSON.stringify({}),
    });
    assert.equal(heartbeatRes.status, 200);
    assert.equal(heartbeatRes.headers.get("x-a2a-ratelimit-bucket"), "worker");

    const auditTwo = await fetch(`${server.baseUrl}/audit`, {
      headers: {
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "worker-a",
        "x-a2a-requester-role": "analyst",
      },
    });
    assert.equal(auditTwo.status, 429);

  } finally {
    await server.close();
  }
});

test("server rejects requeue_stale unless requester is a hub or operator", async () => {
  const server = await startTestServer({ edgeSecret: "test-edge-secret" });

  try {
    const unauthorizedRes = await fetch(`${server.baseUrl}/tasks/requeue_stale`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "worker-a",
        "x-a2a-requester-role": "analyst",
      }),
    });
    assert.equal(unauthorizedRes.status, 401);
    const unauthorizedBody = await unauthorizedRes.json();
    assert.equal(unauthorizedBody.error.code, "unauthorized");

    const allowedRes = await fetch(`${server.baseUrl}/tasks/requeue_stale`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "hub-a",
        "x-a2a-requester-role": "hub",
      }),
    });
    assert.equal(allowedRes.status, 200);
    const allowedBody = await allowedRes.json();
    assert.equal(allowedBody.ok, true);
    assert.equal(allowedBody.policy, "requeue_only");
  } finally {
    await server.close();
  }
});

test("server rejects artifact attachment from an unrelated requester", async () => {
  const server = await startTestServer();
  try {
    const proposalRes = await fetch(`${server.baseUrl}/proposals`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-requester-id": "research-a",
        "x-a2a-requester-role": "researcher",
      }),
      body: JSON.stringify({
        source: { id: "research-a", kind: "node", role: "researcher" },
        target: { id: "live-a", kind: "node", role: "live-trader" },
        kind: "patch",
        summary: "tighten threshold",
        workspace: { nodeId: "live-a", workspaceId: "ws-live" },
        patchText: "diff --git a/config.ts b/config.ts",
      }),
    });
    assert.equal(proposalRes.status, 201);
    const proposal = await proposalRes.json();

    const artifactRes = await fetch(`${server.baseUrl}/proposals/${proposal.id}/artifacts`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-requester-id": "outsider-a",
        "x-a2a-requester-role": "analyst",
      }),
      body: JSON.stringify({
        kind: "patch",
        uri: "file:///tmp/proposal.diff",
        summary: "outsider should not attach this",
      }),
    });

    assert.equal(artifactRes.status, 401);
    const errorBody = await artifactRes.json();
    assert.equal(errorBody.error.code, "unauthorized");
  } finally {
    await server.close();
  }
});

test("server rejects validation from a node outside the proposal parties", async () => {
  const server = await startTestServer();
  try {
    const proposalRes = await fetch(`${server.baseUrl}/proposals`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-requester-id": "research-a",
        "x-a2a-requester-role": "researcher",
      }),
      body: JSON.stringify({
        source: { id: "research-a", kind: "node", role: "researcher" },
        target: { id: "live-a", kind: "node", role: "live-trader" },
        kind: "patch",
        summary: "tighten threshold",
        workspace: { nodeId: "live-a", workspaceId: "ws-live" },
        patchText: "diff --git a/config.ts b/config.ts",
      }),
    });
    assert.equal(proposalRes.status, 201);
    const proposal = await proposalRes.json();

    const validationRes = await fetch(`${server.baseUrl}/proposals/${proposal.id}/validate`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-requester-id": "outsider-a",
        "x-a2a-requester-role": "analyst",
      }),
      body: JSON.stringify({
        nodeId: "outsider-a",
        kind: "smoke",
        verdict: "pass",
        note: "should be rejected",
      }),
    });

    assert.equal(validationRes.status, 403);
    const errorBody = await validationRes.json();
    assert.equal(errorBody.error.code, "policy_denied");
  } finally {
    await server.close();
  }
});

test("server rejects apply attempts from the proposal source after approval", async () => {
  const server = await startTestServer();
  try {
    const proposalRes = await fetch(`${server.baseUrl}/proposals`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-requester-id": "research-a",
        "x-a2a-requester-role": "researcher",
      }),
      body: JSON.stringify({
        source: { id: "research-a", kind: "node", role: "researcher" },
        target: { id: "live-a", kind: "node", role: "live-trader" },
        kind: "patch",
        summary: "tighten threshold",
        workspace: { nodeId: "live-a", workspaceId: "ws-live" },
        patchText: "diff --git a/config.ts b/config.ts",
      }),
    });
    assert.equal(proposalRes.status, 201);
    const proposal = await proposalRes.json();

    const approveRes = await fetch(`${server.baseUrl}/proposals/${proposal.id}/approve`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-requester-id": "live-a",
        "x-a2a-requester-role": "live-trader",
      }),
      body: JSON.stringify({
        actor: { id: "live-a", kind: "node", role: "live-trader" },
        note: "approved by target",
      }),
    });
    assert.equal(approveRes.status, 200);

    const applyRes = await fetch(`${server.baseUrl}/proposals/${proposal.id}/apply`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-requester-id": "research-a",
        "x-a2a-requester-role": "researcher",
      }),
      body: JSON.stringify({
        actor: { id: "research-a", kind: "node", role: "researcher" },
        workspace: { nodeId: "live-a", workspaceId: "ws-live" },
        note: "source should not apply target workspace",
      }),
    });

    assert.equal(applyRes.status, 403);
    const errorBody = await applyRes.json();
    assert.equal(errorBody.error.code, "policy_denied");
  } finally {
    await server.close();
  }
});

test("server classifies claim, start, complete, and fail into the worker lifecycle bucket", async () => {
  const server = await startTestServer({
    edgeSecret: "test-edge-secret",
    rateLimitMaxRequests: 10,
    workerRateLimitMaxRequests: 10,
  });

  try {
    const workerPayload = {
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
    };

    const registerRes = await fetch(`${server.baseUrl}/workers/register`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "worker-a",
        "x-a2a-requester-role": "analyst",
      }),
      body: JSON.stringify(workerPayload),
    });
    assert.equal(registerRes.status, 201);

    const taskCreateRes = await fetch(`${server.baseUrl}/tasks`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "hub-a",
        "x-a2a-requester-role": "hub",
      }),
      body: JSON.stringify({
        intent: "analyze",
        requester: { id: "hub-a", kind: "node", role: "hub" },
        target: { id: "worker-a", kind: "node", role: "analyst" },
        assignedWorkerId: "worker-a",
        message: "run task",
      }),
    });
    assert.equal(taskCreateRes.status, 201);
    const task = await taskCreateRes.json();

    const claimRes = await fetch(`${server.baseUrl}/tasks/${task.id}/claim`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "worker-a",
        "x-a2a-requester-role": "analyst",
      }),
      body: JSON.stringify({ workerId: "worker-a" }),
    });
    assert.equal(claimRes.status, 200);
    assert.equal(claimRes.headers.get("x-a2a-ratelimit-bucket"), "worker");

    const startRes = await fetch(`${server.baseUrl}/tasks/${task.id}/start`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "worker-a",
        "x-a2a-requester-role": "analyst",
      }),
      body: JSON.stringify({ workerId: "worker-a" }),
    });
    assert.equal(startRes.status, 200);
    assert.equal(startRes.headers.get("x-a2a-ratelimit-bucket"), "worker");

    const completeRes = await fetch(`${server.baseUrl}/tasks/${task.id}/complete`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "worker-a",
        "x-a2a-requester-role": "analyst",
      }),
      body: JSON.stringify({
        workerId: "worker-a",
        result: { summary: "done" },
      }),
    });
    assert.equal(completeRes.status, 200);
    assert.equal(completeRes.headers.get("x-a2a-ratelimit-bucket"), "worker");

    const failedTaskCreateRes = await fetch(`${server.baseUrl}/tasks`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "hub-a",
        "x-a2a-requester-role": "hub",
      }),
      body: JSON.stringify({
        intent: "analyze",
        requester: { id: "hub-a", kind: "node", role: "hub" },
        target: { id: "worker-a", kind: "node", role: "analyst" },
        assignedWorkerId: "worker-a",
        message: "run task 2",
      }),
    });
    assert.equal(failedTaskCreateRes.status, 201);
    const failedTask = await failedTaskCreateRes.json();

    const claimFailedTaskRes = await fetch(`${server.baseUrl}/tasks/${failedTask.id}/claim`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "worker-a",
        "x-a2a-requester-role": "analyst",
      }),
      body: JSON.stringify({ workerId: "worker-a" }),
    });
    assert.equal(claimFailedTaskRes.status, 200);
    assert.equal(claimFailedTaskRes.headers.get("x-a2a-ratelimit-bucket"), "worker");

    const startFailedTaskRes = await fetch(`${server.baseUrl}/tasks/${failedTask.id}/start`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "worker-a",
        "x-a2a-requester-role": "analyst",
      }),
      body: JSON.stringify({ workerId: "worker-a" }),
    });
    assert.equal(startFailedTaskRes.status, 200);
    assert.equal(startFailedTaskRes.headers.get("x-a2a-ratelimit-bucket"), "worker");

    const failRes = await fetch(`${server.baseUrl}/tasks/${failedTask.id}/fail`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "worker-a",
        "x-a2a-requester-role": "analyst",
      }),
      body: JSON.stringify({
        workerId: "worker-a",
        error: { code: "handler_error", message: "task failed" },
      }),
    });
    assert.equal(failRes.status, 200);
    assert.equal(failRes.headers.get("x-a2a-ratelimit-bucket"), "worker");
  } finally {
    await server.close();
  }
});

test("stale reaper sweep requeues a claimed task with a dead worker without operator action", async () => {
  const server = await startTestServer({
    edgeSecret: "s",
    // Disable the periodic timer so the test drives sweeps deterministically.
    staleReaperEnabled: false,
    staleReaperOlderThanSec: 0,
    workerOfflineAfterSec: 1,
  });
  try {
    const h = (extra: Record<string, string> = {}) => ({
      "content-type": "application/json",
      "x-a2a-edge-secret": "s",
      ...extra,
    });

    await fetch(`${server.baseUrl}/workers/register`, {
      method: "POST",
      headers: h({ "x-a2a-requester-id": "w1", "x-a2a-requester-role": "analyst" }),
      body: JSON.stringify({
        nodeId: "w1",
        role: "analyst",
        capabilities: {
          canAnalyze: true,
          canBackfill: false,
          canPatchWorkspace: false,
          canPromoteLive: false,
          workspaceIds: ["ws"],
          environments: ["research"],
        },
      }),
    });

    const taskRes = await fetch(`${server.baseUrl}/tasks`, {
      method: "POST",
      headers: h({ "x-a2a-requester-id": "hub-1", "x-a2a-requester-role": "hub" }),
      body: JSON.stringify({
        intent: "analyze",
        requester: { id: "hub-1", kind: "node", role: "hub" },
        target: { id: "w1", kind: "node", role: "analyst" },
        assignedWorkerId: "w1",
        message: "analyze payload",
      }),
    });
    const task = await taskRes.json();

    await fetch(`${server.baseUrl}/tasks/${task.id}/claim`, {
      method: "POST",
      headers: h({ "x-a2a-requester-id": "w1", "x-a2a-requester-role": "analyst" }),
      body: JSON.stringify({ workerId: "w1" }),
    });

    const requeuedCount = server.runtime.runStaleReaperSweep();
    assert.equal(requeuedCount, 1);

    const taskAfter = await (await fetch(`${server.baseUrl}/tasks/${task.id}`, {
      headers: h({ "x-a2a-requester-id": "hub-1", "x-a2a-requester-role": "hub" }),
    })).json();
    assert.equal(taskAfter.status, "queued");
    assert.equal(taskAfter.assignedWorkerId, "w1");

    const status = server.runtime.getStaleReaperStatus();
    assert.equal(status.runCount, 1);
    assert.equal(status.lastRequeued, 1);
    assert.equal(status.lastError, undefined);
    assert.ok(status.lastRunAt);
  } finally {
    await server.close();
  }
});

test("stopStaleReaper is idempotent and safe after server close", async () => {
  const server = await startTestServer({ staleReaperEnabled: true, staleReaperIntervalSec: 3600 });
  const { runtime } = server;
  await server.close();
  // server.close fires the "close" event which already stopped the reaper; extra calls
  // must not throw.
  runtime.stopStaleReaper();
  runtime.stopStaleReaper();
});

test("POST /tasks/requeue_stale reports both requeued and dead-lettered counts", async () => {
  const server = await startTestServer({
    edgeSecret: "s",
    staleReaperEnabled: false,
    workerOfflineAfterSec: 1,
    maxRequeueAttempts: 1,
  });
  try {
    const h = (extra: Record<string, string> = {}) => ({
      "content-type": "application/json",
      "x-a2a-edge-secret": "s",
      ...extra,
    });

    await fetch(`${server.baseUrl}/workers/register`, {
      method: "POST",
      headers: h({ "x-a2a-requester-id": "w1", "x-a2a-requester-role": "analyst" }),
      body: JSON.stringify({
        nodeId: "w1",
        role: "analyst",
        capabilities: {
          canAnalyze: true,
          canBackfill: false,
          canPatchWorkspace: false,
          canPromoteLive: false,
          workspaceIds: ["ws"],
          environments: ["research"],
        },
      }),
    });

    const taskRes = await fetch(`${server.baseUrl}/tasks`, {
      method: "POST",
      headers: h({ "x-a2a-requester-id": "hub-1", "x-a2a-requester-role": "hub" }),
      body: JSON.stringify({
        intent: "analyze",
        requester: { id: "hub-1", kind: "node", role: "hub" },
        target: { id: "w1", kind: "node", role: "analyst" },
        assignedWorkerId: "w1",
        message: "analyze payload",
      }),
    });
    const task = await taskRes.json();

    // Burn attempt #1 via the manual endpoint.
    await fetch(`${server.baseUrl}/tasks/${task.id}/claim`, {
      method: "POST",
      headers: h({ "x-a2a-requester-id": "w1", "x-a2a-requester-role": "analyst" }),
      body: JSON.stringify({ workerId: "w1" }),
    });
    const firstSweep = await (await fetch(
      `${server.baseUrl}/tasks/requeue_stale?older_than_seconds=0`,
      {
        method: "POST",
        headers: h({ "x-a2a-requester-id": "ops", "x-a2a-requester-role": "operator" }),
      },
    )).json();
    assert.equal(firstSweep.requeued, 1);
    assert.equal(firstSweep.deadLettered, 0);
    assert.equal(firstSweep.maxRequeueAttempts, 1);
    assert.equal(firstSweep.items[0].requeueCount, 1);

    // Second sweep: the task is over its cap and must dead-letter.
    await fetch(`${server.baseUrl}/tasks/${task.id}/claim`, {
      method: "POST",
      headers: h({ "x-a2a-requester-id": "w1", "x-a2a-requester-role": "analyst" }),
      body: JSON.stringify({ workerId: "w1" }),
    });
    const secondSweep = await (await fetch(
      `${server.baseUrl}/tasks/requeue_stale?older_than_seconds=0`,
      {
        method: "POST",
        headers: h({ "x-a2a-requester-id": "ops", "x-a2a-requester-role": "operator" }),
      },
    )).json();
    assert.equal(secondSweep.requeued, 0);
    assert.equal(secondSweep.deadLettered, 1);
    assert.equal(secondSweep.deadLetteredItems[0].id, task.id);
    assert.equal(secondSweep.deadLetteredItems[0].error.code, "exceeded_requeue_limit");
  } finally {
    await server.close();
  }
});

test("server persists task wake plan and decision through HTTP", async () => {
  const server = await startTestServer();
  try {
    await registerTestWorker(server.baseUrl, "worker-a", "analyst");
    const hubHeaders = jsonHeaders({
      "x-a2a-requester-id": "hub-a",
      "x-a2a-requester-role": "hub",
    });

    const createRes = await fetch(`${server.baseUrl}/tasks`, {
      method: "POST",
      headers: hubHeaders,
      body: JSON.stringify({
        id: "task-wake-http",
        intent: "chat",
        requester: { id: "hub-a", kind: "node", role: "hub" },
        target: { id: "worker-a", kind: "node", role: "analyst" },
        assignedWorkerId: "worker-a",
        message: "wake target",
        payload: { waitRunId: "wait-http", correlationId: "corr-http" },
      }),
    });
    assert.equal(createRes.status, 201);

    const planRes = await fetch(`${server.baseUrl}/tasks/task-wake-http/wake/plan`, {
      method: "POST",
      headers: hubHeaders,
      body: JSON.stringify({
        targetSessionKey: "agent:worker-a",
        targetNodeId: "worker-a",
        waitRunId: "wait-http",
        correlationId: "corr-http",
      }),
    });
    assert.equal(planRes.status, 201);
    const plan = await planRes.json() as Record<string, unknown>;
    assert.equal(plan.shouldDispatch, true);
    assert.equal((plan.wake as Record<string, unknown>).wakeKey, "corr-http:wait-http");

    const decisionRes = await fetch(`${server.baseUrl}/tasks/task-wake-http/wake/decision`, {
      method: "POST",
      headers: hubHeaders,
      body: JSON.stringify({
        status: "skipped",
        code: "wake_disabled",
        message: "default off",
      }),
    });
    assert.equal(decisionRes.status, 200);
    const task = await decisionRes.json() as Record<string, unknown>;
    assert.equal((task.wake as Record<string, unknown>).status, "skipped");
    assert.equal((task.wake as Record<string, unknown>).code, "wake_disabled");

    const replayRes = await fetch(`${server.baseUrl}/tasks/task-wake-http/wake/plan`, {
      method: "POST",
      headers: hubHeaders,
      body: JSON.stringify({
        targetSessionKey: "agent:worker-a",
        targetNodeId: "worker-a",
        waitRunId: "wait-http",
        correlationId: "corr-http",
      }),
    });
    assert.equal(replayRes.status, 200);
    const replay = await replayRes.json() as Record<string, unknown>;
    assert.equal(replay.replayed, true);
    assert.equal(replay.shouldDispatch, false);
  } finally {
    await server.close();
  }
});

test("GET /release/evidence returns read-only dry-run release evidence without mutating tasks", async () => {
  const server = await startTestServer({ edgeSecret: "test-edge-secret" });
  try {
    server.runtime.broker.registerWorker({
      nodeId: "dungae",
      role: "analyst",
      capabilities: {
        canAnalyze: true,
        canBackfill: false,
        canPatchWorkspace: true,
        canPromoteLive: false,
        workspaceIds: ["repo"],
        environments: ["research"],
      },
    });
    const created = server.runtime.broker.createTask({
      id: "release-evidence-task-1",
      intent: "propose_patch",
      requester: { id: "operator-a", kind: "user", role: "operator" },
      target: { id: "dungae", kind: "node", role: "analyst" },
      payload: {
        mode: "github-propose-patch",
        issue: 479,
        issueUrl: "https://github.com/jinwon-int/a2a-broker/issues/479",
      },
      taskOrigin: "github",
    });
    server.runtime.broker.claimTask(created.id, "dungae");
    server.runtime.broker.startTask(created.id, "dungae");
    server.runtime.broker.completeTask(created.id, "dungae", {
      output: {
        github: {
          repo: "jinwon-int/a2a-broker",
          issue: "#479",
          doneCommentUrl: "https://github.com/jinwon-int/a2a-broker/issues/479#issuecomment-4415413329",
        },
        receipt: { status: "operator_visible", evidence: "operator_visible" },
      },
    });
    const before = server.runtime.broker.getTask(created.id)?.updatedAt;

    const res = await fetch(
      `${server.baseUrl}/release/evidence?task_id=${created.id}&repo=jinwon-int/a2a-broker&issue=479&parentIssue=jinwon-int/a2a-plane%23197&runId=a2a-source-dryrun-orchestrator-20260510T133022Z`,
      {
        headers: {
          "x-a2a-edge-secret": "test-edge-secret",
          "x-a2a-requester-id": "operator-a",
          "x-a2a-requester-role": "operator",
        },
      },
    );

    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const body = await res.json();
    assert.equal(body.kind, "broker.release-evidence.export");
    assert.equal(body.mode, "dry-run/read-only");
    assert.equal(body.readOnly, true);
    assert.equal(body.gates.liveActionAllowed, false);
    assert.equal(body.gates.mutationAllowed, false);
    assert.equal(body.gates.ok, true);
    assert.equal(body.taskSummary.total, 1);
    assert.equal(body.evidenceSummary.done, 1);
    assert.deepEqual(body.links.doneComments, [
      "https://github.com/jinwon-int/a2a-broker/issues/479#issuecomment-4415413329",
    ]);
    assert.equal(server.runtime.broker.getTask(created.id)?.updatedAt, before);
  } finally {
    await server.close();
  }
});

test("POST bodies over the size cap are rejected with 400 (a2a-nexus#573 item 13)", async () => {
  const server = await startTestServer();
  try {
    // 10 MB + 1 byte of raw payload exceeds MAX_REQUEST_BODY_BYTES.
    const oversized = Buffer.alloc(10 * 1024 * 1024 + 1, 0x61);
    const response = await fetch(`${server.baseUrl}/tasks`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-a2a-requester-id": "hub-a",
        "x-a2a-requester-role": "hub",
        "x-a2a-requester-kind": "node",
      },
      body: oversized,
    });
    assert.equal(response.status, 400);
    const body = await response.json() as { error?: { message?: string } };
    assert.match(String(body.error?.message), /request body exceeds/);
  } finally {
    await server.close();
  }
});
