import test from "node:test";
import assert from "node:assert/strict";
import { createHash, createPrivateKey, sign } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBrokerServer } from "./server.js";
import { buildA2AHttpSignatureBase } from "./core/request-security.js";
import { createInMemoryStateStore, startTestServer, jsonHeaders, withEnv, workerPayload } from "./server-test-helpers.js";

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

test("strict A2A HTTP Signature worker route gate fails closed on every out-of-scope task mutation route (#691)", async () => {
  // sogyo is scoped to registration only, so every task.* mutation route is out of
  // scope. The scope check fires before any task lookup, so a placeholder task id is
  // enough to exercise denial across the full mutation surface.
  const scopedKeyRegistry = {
    "worker:sogyo:v1": {
      ...routeGateKeyRegistry["worker:sogyo:v1"],
      scopes: ["worker.register"] as const,
    },
    "worker:bangtong:v1": routeGateKeyRegistry["worker:bangtong:v1"],
  };
  const server = await startTestServer({
    brokerId: "seoseo",
    a2aHttpSignatureWorkerAuth: "strict",
    a2aHttpSignatureKeyRegistry: scopedKeyRegistry,
  });
  try {
    const actions = ["claim", "start", "heartbeat", "checkpoint", "complete", "evidence", "fail"] as const;
    for (const action of actions) {
      const path = `/tasks/scope-probe-task/${action}`;
      const body = JSON.stringify({ workerId: "sogyo" });
      const res = await fetch(`${server.baseUrl}${path}`, {
        method: "POST",
        headers: signedWorkerHeaders({
          baseUrl: server.baseUrl,
          method: "POST",
          path,
          workerId: "sogyo",
          body,
          nonce: `scoped-deny-${action}`,
        }),
        body,
      });
      assert.equal(res.status, 403, `${action} must be scope-denied`);
      const errorBody = await res.json() as { error: { code: string; message: string } };
      assert.equal(errorBody.error.code, "policy_denied");
      assert.match(
        errorBody.error.message,
        new RegExp(`a2a_signature_scope_denied: signing key is not authorized for task\\.${action}`),
      );
    }
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



test("public broker bind fails closed without edge secret, strict worker signatures, or explicit insecure-dev opt-in", async () => {
  await withEnv({ A2A_ALLOW_INSECURE_DEV: undefined, NODE_ENV: undefined }, async () => {
    assert.throws(
      () => createBrokerServer({
        host: "0.0.0.0",
        port: 0,
        publicBaseUrl: "https://broker.test/",
        stateStore: createInMemoryStateStore(),
      }),
      /insecure broker bind rejected/,
    );

    assert.doesNotThrow(() => createBrokerServer({
      host: "0.0.0.0",
      port: 0,
      publicBaseUrl: "https://broker.test/",
      edgeSecret: "test-edge-secret",
      stateStore: createInMemoryStateStore(),
    }).server.close());

    assert.doesNotThrow(() => createBrokerServer({
      host: "0.0.0.0",
      port: 0,
      publicBaseUrl: "https://broker.test/",
      a2aHttpSignatureWorkerAuth: "strict",
      a2aHttpSignatureKeyRegistry: routeGateKeyRegistry,
      stateStore: createInMemoryStateStore(),
    }).server.close());
  });
});
