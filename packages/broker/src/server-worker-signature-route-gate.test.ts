import test from "node:test";
import assert from "node:assert/strict";
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBrokerServer } from "./server.js";
import { buildA2AHttpSignatureBase } from "./core/request-security.js";
import { signTaskResultProvenance, verifyTaskResultProvenance } from "./core/provenance.js";
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
  "worker:workerbeta:v1": {
    keyid: "worker:workerbeta:v1",
    workerId: "workerbeta",
    publicKeyJwk: routeGatePublicJwk,
  },
  "worker:workergamma:v1": {
    keyid: "worker:workergamma:v1",
    workerId: "workergamma",
    publicKeyJwk: routeGatePublicJwk,
  },
};

function signedWorkerHeaders(params: {
  baseUrl: string;
  method: string;
  path: string;
  query?: string;
  workerId: "workerbeta" | "workergamma";
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
    "x-a2a-broker-id": "brokeralpha",
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

function routeGatePrivatePem(): string {
  return createPrivateKey({ key: routeGatePrivateJwk, format: "jwk" })
    .export({ type: "pkcs8", format: "pem" })
    .toString();
}

function routeGatePublicPem(): string {
  return createPublicKey(createPrivateKey({ key: routeGatePrivateJwk, format: "jwk" }))
    .export({ type: "spki", format: "pem" })
    .toString();
}

function generatedPrivatePem(): string {
  const { privateKey } = generateKeyPairSync("ed25519");
  return privateKey.export({ type: "pkcs8", format: "pem" }).toString();
}

function brokerSigningKeyFile(): string {
  const { privateKey } = generateKeyPairSync("ed25519");
  const dir = mkdtempSync(join(tmpdir(), "g2-broker-signing-key-"));
  const keyFile = join(dir, "broker-signing.pem");
  writeFileSync(keyFile, privateKey.export({ type: "pkcs8", format: "pem" }));
  return keyFile;
}

test("strict A2A HTTP Signature worker route gate rejects unsigned worker requests", async () => {
  const server = await startTestServer({
    brokerId: "brokeralpha",
    a2aHttpSignatureWorkerAuth: "strict",
    a2aHttpSignatureKeyRegistry: routeGateKeyRegistry,
  });
  try {
    const body = JSON.stringify(workerPayload("workerbeta"));
    const res = await fetch(`${server.baseUrl}/workers/register`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-requester-id": "workerbeta",
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
    brokerId: "brokeralpha",
    a2aHttpSignatureWorkerAuth: "strict",
    a2aHttpSignatureKeyRegistry: routeGateKeyRegistry,
  });
  try {
    const registerBody = JSON.stringify(workerPayload("workerbeta"));
    const registerHeaders = signedWorkerHeaders({
      baseUrl: server.baseUrl,
      method: "POST",
      path: "/workers/register",
      workerId: "workerbeta",
      body: registerBody,
      nonce: "route-register-workerbeta",
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
        target: { id: "workerbeta", kind: "node", role: "analyst" },
        targetNodeId: "workerbeta",
        intent: "analyze",
        message: "signed worker should be able to poll this task",
      }),
    });
    assert.equal(createRes.status, 201);

    const unsignedPollRes = await fetch(`${server.baseUrl}/tasks?worker=workerbeta&status=pending&detail=full`);
    assert.equal(unsignedPollRes.status, 401);

    const unsignedAssignedPollRes = await fetch(`${server.baseUrl}/tasks?assignedWorkerId=workerbeta&status=queued`);
    assert.equal(unsignedAssignedPollRes.status, 401);

    const mismatchedQuery = "worker=workerbeta&assignedWorkerId=workergamma&status=pending&detail=full";
    const mismatchedPollRes = await fetch(`${server.baseUrl}/tasks?${mismatchedQuery}`, {
      headers: signedWorkerHeaders({
        baseUrl: server.baseUrl,
        method: "GET",
        path: "/tasks",
        query: mismatchedQuery,
        workerId: "workerbeta",
        nonce: "route-poll-mismatched-worker-params",
      }),
    });
    assert.equal(mismatchedPollRes.status, 400);

    const emptyWorkerAssignedQuery = "worker=&assignedWorkerId=workergamma&status=pending&detail=full";
    const emptyWorkerAssignedRes = await fetch(`${server.baseUrl}/tasks?${emptyWorkerAssignedQuery}`, {
      headers: signedWorkerHeaders({
        baseUrl: server.baseUrl,
        method: "GET",
        path: "/tasks",
        query: emptyWorkerAssignedQuery,
        workerId: "workerbeta",
        nonce: "route-poll-empty-worker-assigned-victim",
      }),
    });
    assert.equal(emptyWorkerAssignedRes.status, 401);

    const query = "worker=workerbeta&status=pending&detail=full";
    const pollHeaders = signedWorkerHeaders({
      baseUrl: server.baseUrl,
      method: "GET",
      path: "/tasks",
      query,
      workerId: "workerbeta",
      nonce: "route-poll-workerbeta",
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
  // workerbeta's key is scoped to registration/heartbeat only; workergamma stays unscoped (legacy).
  const scopedKeyRegistry = {
    "worker:workerbeta:v1": {
      ...routeGateKeyRegistry["worker:workerbeta:v1"],
      scopes: ["worker.register", "worker.heartbeat"] as const,
    },
    "worker:workergamma:v1": routeGateKeyRegistry["worker:workergamma:v1"],
  };
  const server = await startTestServer({
    brokerId: "brokeralpha",
    a2aHttpSignatureWorkerAuth: "strict",
    a2aHttpSignatureKeyRegistry: scopedKeyRegistry,
  });
  try {
    // In-scope route (worker.register) is authorized.
    const registerBody = JSON.stringify(workerPayload("workerbeta"));
    const registerRes = await fetch(`${server.baseUrl}/workers/register`, {
      method: "POST",
      headers: signedWorkerHeaders({
        baseUrl: server.baseUrl,
        method: "POST",
        path: "/workers/register",
        workerId: "workerbeta",
        body: registerBody,
        nonce: "scoped-register-workerbeta",
      }),
      body: registerBody,
    });
    assert.equal(registerRes.status, 201);

    // Out-of-scope route (tasks.list) fails closed with 403 even though the
    // signature itself is valid and the requester id matches the key owner.
    const query = "worker=workerbeta&status=pending&detail=full";
    const pollRes = await fetch(`${server.baseUrl}/tasks?${query}`, {
      headers: signedWorkerHeaders({
        baseUrl: server.baseUrl,
        method: "GET",
        path: "/tasks",
        query,
        workerId: "workerbeta",
        nonce: "scoped-poll-workerbeta-denied",
      }),
    });
    assert.equal(pollRes.status, 403);
    const pollBody = await pollRes.json() as { error: { code: string; message: string } };
    assert.equal(pollBody.error.code, "policy_denied");
    assert.match(pollBody.error.message, /a2a_signature_scope_denied: signing key is not authorized for tasks\.list/);

    // An unscoped (legacy) key remains authorized for the same route.
    const workergammaQuery = "worker=workergamma&status=pending&detail=full";
    const workergammaPollRes = await fetch(`${server.baseUrl}/tasks?${workergammaQuery}`, {
      headers: signedWorkerHeaders({
        baseUrl: server.baseUrl,
        method: "GET",
        path: "/tasks",
        query: workergammaQuery,
        workerId: "workergamma",
        nonce: "scoped-poll-workergamma-allowed",
      }),
    });
    assert.equal(workergammaPollRes.status, 200);
  } finally {
    await server.close();
  }
});

test("strict A2A HTTP Signature worker route gate fails closed on every out-of-scope task mutation route (#691)", async () => {
  // workerbeta is scoped to registration only, so every task.* mutation route is out of
  // scope. The scope check fires before any task lookup, so a placeholder task id is
  // enough to exercise denial across the full mutation surface.
  const scopedKeyRegistry = {
    "worker:workerbeta:v1": {
      ...routeGateKeyRegistry["worker:workerbeta:v1"],
      scopes: ["worker.register"] as const,
    },
    "worker:workergamma:v1": routeGateKeyRegistry["worker:workergamma:v1"],
  };
  const server = await startTestServer({
    brokerId: "brokeralpha",
    a2aHttpSignatureWorkerAuth: "strict",
    a2aHttpSignatureKeyRegistry: scopedKeyRegistry,
  });
  try {
    const actions = ["claim", "start", "heartbeat", "checkpoint", "complete", "evidence", "fail"] as const;
    for (const action of actions) {
      const path = `/tasks/scope-probe-task/${action}`;
      const body = JSON.stringify({ workerId: "workerbeta" });
      const res = await fetch(`${server.baseUrl}${path}`, {
        method: "POST",
        headers: signedWorkerHeaders({
          baseUrl: server.baseUrl,
          method: "POST",
          path,
          workerId: "workerbeta",
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
    brokerId: "brokeralpha",
    enforceRequesterIdentity: false,
    a2aHttpSignatureWorkerAuth: "strict",
    a2aHttpSignatureKeyRegistry: routeGateKeyRegistry,
  });
  try {
    for (const workerId of ["workerbeta", "workergamma"] as const) {
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
        id: "workergamma-owned-task",
        requester: { id: "hub-a", kind: "node", role: "hub" },
        target: { id: "workergamma", kind: "node", role: "analyst" },
        targetNodeId: "workergamma",
        intent: "analyze",
        message: "workerbeta must not claim as workergamma",
      }),
    });
    assert.equal(createRes.status, 201);

    const claimBody = JSON.stringify({ workerId: "workergamma" });
    const claimHeaders = signedWorkerHeaders({
      baseUrl: server.baseUrl,
      method: "POST",
      path: "/tasks/workergamma-owned-task/claim",
      workerId: "workerbeta",
      body: claimBody,
      nonce: "route-cross-worker-claim",
    });
    const claimRes = await fetch(`${server.baseUrl}/tasks/workergamma-owned-task/claim`, {
      method: "POST",
      headers: claimHeaders,
      body: claimBody,
    });
    assert.equal(claimRes.status, 401);
  } finally {
    await server.close();
  }
});


test("worker completion fail-closes invalid present provenance before mutating task", async () => {
  const server = await startTestServer({
    brokerId: "brokeralpha",
    enforceRequesterIdentity: false,
    a2aHttpSignatureWorkerAuth: "strict",
    a2aHttpSignatureKeyRegistry: routeGateKeyRegistry,
    agentCardSigningKeyFile: brokerSigningKeyFile(),
    agentCardSigningKid: "broker:brokeralpha:v1",
  });
  try {
    const registerBody = JSON.stringify(workerPayload("workerbeta"));
    const registerRes = await fetch(`${server.baseUrl}/workers/register`, {
      method: "POST",
      headers: signedWorkerHeaders({
        baseUrl: server.baseUrl,
        method: "POST",
        path: "/workers/register",
        workerId: "workerbeta",
        body: registerBody,
        nonce: "g2-invalid-register-workerbeta",
      }),
      body: registerBody,
    });
    assert.equal(registerRes.status, 201);

    const taskId = "g2-invalid-provenance-task";
    const createRes = await fetch(`${server.baseUrl}/tasks`, {
      method: "POST",
      headers: jsonHeaders({ "x-a2a-requester-id": "hub-a", "x-a2a-requester-role": "hub" }),
      body: JSON.stringify({
        id: taskId,
        requester: { id: "hub-a", kind: "node", role: "hub" },
        target: { id: "workerbeta", kind: "node", role: "analyst" },
        targetNodeId: "workerbeta",
        intent: "analyze",
        message: "invalid provenance must not complete",
      }),
    });
    assert.equal(createRes.status, 201);

    const claimBody = JSON.stringify({ workerId: "workerbeta" });
    const claimRes = await fetch(`${server.baseUrl}/tasks/${taskId}/claim`, {
      method: "POST",
      headers: signedWorkerHeaders({
        baseUrl: server.baseUrl,
        method: "POST",
        path: `/tasks/${taskId}/claim`,
        workerId: "workerbeta",
        body: claimBody,
        nonce: "g2-invalid-claim-workerbeta",
      }),
      body: claimBody,
    });
    assert.equal(claimRes.status, 200);

    const result = { summary: "done" };
    const provenance = signTaskResultProvenance(result, {
      taskId: "different-task-id",
      claimedAt: "2026-07-06T00:00:00.000Z",
      privateKeyPem: routeGatePrivatePem(),
      workerKeyId: "worker:workerbeta:v1",
    });
    const completeBody = JSON.stringify({ workerId: "workerbeta", result: { ...result, provenance } });
    const completeRes = await fetch(`${server.baseUrl}/tasks/${taskId}/complete`, {
      method: "POST",
      headers: signedWorkerHeaders({
        baseUrl: server.baseUrl,
        method: "POST",
        path: `/tasks/${taskId}/complete`,
        workerId: "workerbeta",
        body: completeBody,
        nonce: "g2-invalid-complete-workerbeta",
      }),
      body: completeBody,
    });

    assert.equal(completeRes.status, 400);
    const errorBody = await completeRes.json() as { error: { code: string; message: string } };
    assert.equal(errorBody.error.code, "provenance_invalid");
    assert.equal(server.runtime.broker.getTask(taskId)?.status, "claimed");
  } finally {
    await server.close();
  }
});

test("worker completion verifies provenance with the registered key and stores broker countersignature", async () => {
  const server = await startTestServer({
    brokerId: "brokeralpha",
    enforceRequesterIdentity: false,
    a2aHttpSignatureWorkerAuth: "strict",
    a2aHttpSignatureKeyRegistry: routeGateKeyRegistry,
    agentCardSigningKeyFile: brokerSigningKeyFile(),
    agentCardSigningKid: "broker:brokeralpha:v1",
  });
  try {
    const registerBody = JSON.stringify(workerPayload("workerbeta"));
    const registerRes = await fetch(`${server.baseUrl}/workers/register`, {
      method: "POST",
      headers: signedWorkerHeaders({
        baseUrl: server.baseUrl,
        method: "POST",
        path: "/workers/register",
        workerId: "workerbeta",
        body: registerBody,
        nonce: "g2-valid-register-workerbeta",
      }),
      body: registerBody,
    });
    assert.equal(registerRes.status, 201);

    const taskId = "g2-valid-provenance-task";
    const createRes = await fetch(`${server.baseUrl}/tasks`, {
      method: "POST",
      headers: jsonHeaders({ "x-a2a-requester-id": "hub-a", "x-a2a-requester-role": "hub" }),
      body: JSON.stringify({
        id: taskId,
        requester: { id: "hub-a", kind: "node", role: "hub" },
        target: { id: "workerbeta", kind: "node", role: "analyst" },
        targetNodeId: "workerbeta",
        intent: "analyze",
        message: "valid provenance should complete",
      }),
    });
    assert.equal(createRes.status, 201);

    const claimBody = JSON.stringify({ workerId: "workerbeta" });
    const claimRes = await fetch(`${server.baseUrl}/tasks/${taskId}/claim`, {
      method: "POST",
      headers: signedWorkerHeaders({
        baseUrl: server.baseUrl,
        method: "POST",
        path: `/tasks/${taskId}/claim`,
        workerId: "workerbeta",
        body: claimBody,
        nonce: "g2-valid-claim-workerbeta",
      }),
      body: claimBody,
    });
    assert.equal(claimRes.status, 200);

    const result = { summary: "done", artifactIds: [], output: { ok: true } };
    const provenance = signTaskResultProvenance(result, {
      taskId,
      claimedAt: "2026-07-06T00:00:00.000Z",
      privateKeyPem: routeGatePrivatePem(),
      workerKeyId: "worker:workerbeta:v1",
    });
    const completeBody = JSON.stringify({ workerId: "workerbeta", result: { ...result, provenance } });
    const completeRes = await fetch(`${server.baseUrl}/tasks/${taskId}/complete`, {
      method: "POST",
      headers: signedWorkerHeaders({
        baseUrl: server.baseUrl,
        method: "POST",
        path: `/tasks/${taskId}/complete`,
        workerId: "workerbeta",
        body: completeBody,
        nonce: "g2-valid-complete-workerbeta",
      }),
      body: completeBody,
    });

    assert.equal(completeRes.status, 200);
    const completed = await completeRes.json() as { result: Record<string, unknown> & { provenance?: { brokerCountersig?: { brokerKeyId: string } } } };
    assert.equal(completed.result.provenance?.brokerCountersig?.brokerKeyId, "broker:brokeralpha:v1");
    const verification = verifyTaskResultProvenance(completed.result, { taskId, publicKeyPem: routeGatePublicPem() });
    assert.deepEqual(verification, { ok: true });
  } finally {
    await server.close();
  }
});

test("worker evidence rejects forged provenance and still accepts unsigned v1-compatible results", async () => {
  const server = await startTestServer({
    brokerId: "brokeralpha",
    enforceRequesterIdentity: false,
    a2aHttpSignatureWorkerAuth: "strict",
    a2aHttpSignatureKeyRegistry: routeGateKeyRegistry,
    agentCardSigningKeyFile: brokerSigningKeyFile(),
    agentCardSigningKid: "broker:brokeralpha:v1",
  });
  try {
    const registerBody = JSON.stringify(workerPayload("workerbeta"));
    const registerRes = await fetch(`${server.baseUrl}/workers/register`, {
      method: "POST",
      headers: signedWorkerHeaders({
        baseUrl: server.baseUrl,
        method: "POST",
        path: "/workers/register",
        workerId: "workerbeta",
        body: registerBody,
        nonce: "g2-evidence-register-workerbeta",
      }),
      body: registerBody,
    });
    assert.equal(registerRes.status, 201);

    for (const taskId of ["g2-forged-evidence-task", "g2-unsigned-evidence-task"]) {
      const createRes = await fetch(`${server.baseUrl}/tasks`, {
        method: "POST",
        headers: jsonHeaders({ "x-a2a-requester-id": "hub-a", "x-a2a-requester-role": "hub" }),
        body: JSON.stringify({
          id: taskId,
          requester: { id: "hub-a", kind: "node", role: "hub" },
          target: { id: "workerbeta", kind: "node", role: "analyst" },
          targetNodeId: "workerbeta",
          intent: "analyze",
          message: "evidence provenance compatibility",
        }),
      });
      assert.equal(createRes.status, 201);
      const claimBody = JSON.stringify({ workerId: "workerbeta" });
      const claimRes = await fetch(`${server.baseUrl}/tasks/${taskId}/claim`, {
        method: "POST",
        headers: signedWorkerHeaders({
          baseUrl: server.baseUrl,
          method: "POST",
          path: `/tasks/${taskId}/claim`,
          workerId: "workerbeta",
          body: claimBody,
          nonce: `g2-evidence-claim-${taskId}`,
        }),
        body: claimBody,
      });
      assert.equal(claimRes.status, 200);
    }

    const forgedResult = { summary: "done" };
    const forgedProvenance = signTaskResultProvenance(forgedResult, {
      taskId: "g2-forged-evidence-task",
      claimedAt: "2026-07-06T00:00:00.000Z",
      privateKeyPem: generatedPrivatePem(),
      workerKeyId: "worker:workerbeta:v1",
    });
    const forgedBody = JSON.stringify({ workerId: "workerbeta", outcome: "done", result: { ...forgedResult, provenance: forgedProvenance } });
    const forgedRes = await fetch(`${server.baseUrl}/tasks/g2-forged-evidence-task/evidence`, {
      method: "POST",
      headers: signedWorkerHeaders({
        baseUrl: server.baseUrl,
        method: "POST",
        path: "/tasks/g2-forged-evidence-task/evidence",
        workerId: "workerbeta",
        body: forgedBody,
        nonce: "g2-forged-evidence",
      }),
      body: forgedBody,
    });
    assert.equal(forgedRes.status, 400);
    const forgedError = await forgedRes.json() as { error: { code: string } };
    assert.equal(forgedError.error.code, "provenance_invalid");
    assert.equal(server.runtime.broker.getTask("g2-forged-evidence-task")?.status, "claimed");

    const unsignedBody = JSON.stringify({ workerId: "workerbeta", outcome: "done", result: { summary: "legacy done" } });
    const unsignedRes = await fetch(`${server.baseUrl}/tasks/g2-unsigned-evidence-task/evidence`, {
      method: "POST",
      headers: signedWorkerHeaders({
        baseUrl: server.baseUrl,
        method: "POST",
        path: "/tasks/g2-unsigned-evidence-task/evidence",
        workerId: "workerbeta",
        body: unsignedBody,
        nonce: "g2-unsigned-evidence",
      }),
      body: unsignedBody,
    });
    assert.equal(unsignedRes.status, 200);
    assert.equal((await unsignedRes.json() as { status: string }).status, "succeeded");
  } finally {
    await server.close();
  }
});

test("strict A2A HTTP Signature worker route gate binds signed worker to poll query even without requester identity enforcement", async () => {
  const server = await startTestServer({
    brokerId: "brokeralpha",
    enforceRequesterIdentity: false,
    a2aHttpSignatureWorkerAuth: "strict",
    a2aHttpSignatureKeyRegistry: routeGateKeyRegistry,
  });
  try {
    for (const workerId of ["workerbeta", "workergamma"] as const) {
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
        id: "workerbeta-owned-poll-task",
        requester: { id: "hub-a", kind: "node", role: "hub" },
        target: { id: "workerbeta", kind: "node", role: "analyst" },
        targetNodeId: "workerbeta",
        intent: "analyze",
        message: "workergamma must not poll workerbeta queue",
      }),
    });
    assert.equal(createRes.status, 201);

    const query = "worker=workerbeta&status=pending&detail=full";
    const pollHeaders = signedWorkerHeaders({
      baseUrl: server.baseUrl,
      method: "GET",
      path: "/tasks",
      query,
      workerId: "workergamma",
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
    brokerId: "brokeralpha",
    a2aHttpSignatureWorkerAuth: "strict",
    a2aHttpSignatureKeyRegistry: routeGateKeyRegistry,
  });
  try {
    const registerBody = JSON.stringify(workerPayload("workerbeta"));
    const registerHeaders = signedWorkerHeaders({
      baseUrl: server.baseUrl,
      method: "POST",
      path: "/workers/register",
      workerId: "workerbeta",
      body: registerBody,
      nonce: "route-assignment-register-workerbeta",
    });
    const registerRes = await fetch(`${server.baseUrl}/workers/register`, {
      method: "POST",
      headers: registerHeaders,
      body: registerBody,
    });
    assert.equal(registerRes.status, 201);

    const unsignedRes = await fetch(`${server.baseUrl}/a2a/workers/workerbeta/assignment-events`, {
      headers: {
        "x-a2a-requester-id": "workerbeta",
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
    brokerId: "brokeralpha",
    a2aHttpSignatureWorkerAuth: "strict",
    a2aHttpSignatureKeyRegistry: routeGateKeyRegistry,
  });
  try {
    const signedBody = JSON.stringify(workerPayload("workerbeta"));
    const mutatedBody = JSON.stringify({ ...workerPayload("workerbeta"), displayName: "tampered-body" });
    const headers = signedWorkerHeaders({
      baseUrl: strictServer.baseUrl,
      method: "POST",
      path: "/workers/register",
      workerId: "workerbeta",
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
    brokerId: "brokeralpha",
    a2aHttpSignatureWorkerAuth: "optional",
    a2aHttpSignatureKeyRegistry: routeGateKeyRegistry,
  });
  try {
    const body = JSON.stringify(workerPayload("workerbeta"));
    const malformedHeaders = signedWorkerHeaders({
      baseUrl: optionalServer.baseUrl,
      method: "POST",
      path: "/workers/register",
      workerId: "workerbeta",
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
    brokerId: "brokeralpha",
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

    const body = JSON.stringify(workerPayload("workerbeta"));
    const res = await fetch(`${server.baseUrl}/workers/register`, {
      method: "POST",
      headers: signedWorkerHeaders({
        baseUrl: server.baseUrl,
        method: "POST",
        path: "/workers/register",
        workerId: "workerbeta",
        body,
        nonce: "route-file-registry-register-workerbeta",
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
