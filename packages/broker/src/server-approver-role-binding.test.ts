// Approver role binding (A2A_APPROVER_ROLE_BINDING=enforce): task approval
// decisions must carry a hub/operator role bound to a signing credential whose
// key record explicitly declares that role. Default "off" keeps header-based
// behavior (covered by server-workers-tasks.test.ts).
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { buildA2AHttpSignatureBase, type A2AHttpSignatureKeyRegistry } from "./core/request-security.js";
import { resolveApproverRoleBindingMode } from "./startup-security.js";
import { jsonHeaders, registerTestWorker, startTestServer } from "./server-test-helpers.js";

const BROKER_ID = "brokeralpha";

function keyPair(): { privateKey: KeyObject; publicJwk: Record<string, unknown> } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return { privateKey, publicJwk: publicKey.export({ format: "jwk" }) as Record<string, unknown> };
}

const operatorKey = keyPair();
const unscopedKey = keyPair();
const analystOnlyKey = keyPair();

const registry: A2AHttpSignatureKeyRegistry = {
  "approver:operator-a:v1": {
    keyid: "approver:operator-a:v1",
    workerId: "operator-a",
    publicKeyJwk: operatorKey.publicJwk,
    roles: ["operator"],
  },
  // Legacy key without a roles declaration: may sign, must not approve.
  "worker:legacy-b:v1": {
    keyid: "worker:legacy-b:v1",
    workerId: "legacy-b",
    publicKeyJwk: unscopedKey.publicJwk,
  },
  "worker:analyst-c:v1": {
    keyid: "worker:analyst-c:v1",
    workerId: "analyst-c",
    publicKeyJwk: analystOnlyKey.publicJwk,
    roles: ["analyst"],
  },
};

let nonceCounter = 0;

function signedHeaders(params: {
  baseUrl: string;
  path: string;
  body: string;
  requesterId: string;
  role: string;
  keyid: string;
  privateKey: KeyObject;
}): Record<string, string> {
  const url = new URL(params.path, params.baseUrl);
  const headers = {
    "content-type": "application/json",
    "content-digest": `sha-256=:${createHash("sha256").update(Buffer.from(params.body)).digest("base64")}:`,
    "x-a2a-requester-id": params.requesterId,
    "x-a2a-requester-role": params.role,
    "x-a2a-broker-id": BROKER_ID,
  };
  const created = Math.floor(Date.now() / 1000) - 1;
  const expires = created + 60;
  nonceCounter += 1;
  const signatureInput = `a2a=("@method" "@authority" "@path" "@query" "content-digest" "x-a2a-requester-id" "x-a2a-requester-role" "x-a2a-broker-id");alg="ed25519";keyid="${params.keyid}";created=${created};expires=${expires};nonce="approver-${nonceCounter}-${Date.now()}";tag="a2a-worker-v1"`;
  const base = buildA2AHttpSignatureBase({
    method: "POST",
    authority: url.host,
    path: url.pathname,
    query: "",
    headers,
    signatureInput,
  });
  const signature = sign(null, Buffer.from(base), params.privateKey).toString("base64");
  return { ...headers, "signature-input": signatureInput, signature: `a2a=:${signature}:` };
}

async function createBlockedTask(baseUrl: string): Promise<{ id: string }> {
  await registerTestWorker(baseUrl, "worker-a", "analyst");
  const res = await fetch(`${baseUrl}/tasks`, {
    method: "POST",
    headers: jsonHeaders({ "x-a2a-requester-id": "analyst-a", "x-a2a-requester-role": "analyst" }),
    body: JSON.stringify({
      intent: "promote_to_live",
      requester: { id: "analyst-a", kind: "node", role: "analyst" },
      target: { id: "worker-a", kind: "node", role: "analyst" },
      message: "promote after review",
    }),
  });
  assert.equal(res.status, 201);
  const task = await res.json() as { id: string; status: string };
  assert.equal(task.status, "blocked");
  return task;
}

async function errorCode(res: Response): Promise<string> {
  const body = await res.json() as { error?: { message?: string } };
  return body.error?.message ?? "";
}

function approveBody(actorId: string, role: string): string {
  return JSON.stringify({ actor: { id: actorId, kind: "node", role }, reason: "reviewed" });
}

test("resolveApproverRoleBindingMode defaults to off and rejects unknown values", () => {
  assert.equal(resolveApproverRoleBindingMode(undefined), "off");
  assert.equal(resolveApproverRoleBindingMode(""), "off");
  assert.equal(resolveApproverRoleBindingMode(" Enforce "), "enforce");
  assert.throws(() => resolveApproverRoleBindingMode("strict"), /A2A_APPROVER_ROLE_BINDING/);
});

test("approver role binding enforce: header-only operator approval is rejected", async () => {
  const server = await startTestServer({
    brokerId: BROKER_ID,
    approverRoleBinding: "enforce",
    a2aHttpSignatureKeyRegistry: registry,
  });
  try {
    const task = await createBlockedTask(server.baseUrl);
    const res = await fetch(`${server.baseUrl}/tasks/${task.id}/approve`, {
      method: "POST",
      headers: jsonHeaders({ "x-a2a-requester-id": "operator-a", "x-a2a-requester-role": "operator" }),
      body: approveBody("operator-a", "operator"),
    });
    assert.equal(res.status, 401);
    assert.match(await errorCode(res), /a2a_signature_approver_required/);
  } finally {
    await server.close();
  }
});

test("approver role binding enforce: role-declared operator key approves", async () => {
  const server = await startTestServer({
    brokerId: BROKER_ID,
    approverRoleBinding: "enforce",
    a2aHttpSignatureKeyRegistry: registry,
  });
  try {
    const task = await createBlockedTask(server.baseUrl);
    const path = `/tasks/${task.id}/approve`;
    const body = approveBody("operator-a", "operator");
    const res = await fetch(`${server.baseUrl}${path}`, {
      method: "POST",
      headers: signedHeaders({
        baseUrl: server.baseUrl, path, body,
        requesterId: "operator-a", role: "operator",
        keyid: "approver:operator-a:v1", privateKey: operatorKey.privateKey,
      }),
      body,
    });
    assert.equal(res.status, 200);
    const approved = await res.json() as { status: string; approval: { approvedBy: string; actorRole: string } };
    assert.equal(approved.status, "queued");
    assert.equal(approved.approval.approvedBy, "operator-a");
    assert.equal(approved.approval.actorRole, "operator");
  } finally {
    await server.close();
  }
});

test("approver role binding enforce: legacy key without roles cannot approve", async () => {
  const server = await startTestServer({
    brokerId: BROKER_ID,
    approverRoleBinding: "enforce",
    a2aHttpSignatureKeyRegistry: registry,
  });
  try {
    const task = await createBlockedTask(server.baseUrl);
    const path = `/tasks/${task.id}/approve`;
    const body = approveBody("legacy-b", "operator");
    const res = await fetch(`${server.baseUrl}${path}`, {
      method: "POST",
      headers: signedHeaders({
        baseUrl: server.baseUrl, path, body,
        requesterId: "legacy-b", role: "operator",
        keyid: "worker:legacy-b:v1", privateKey: unscopedKey.privateKey,
      }),
      body,
    });
    assert.equal(res.status, 401);
    assert.match(await errorCode(res), /a2a_signature_approver_role_unbound/);
  } finally {
    await server.close();
  }
});

test("approver role binding enforce: analyst-only key cannot assert operator", async () => {
  const server = await startTestServer({
    brokerId: BROKER_ID,
    approverRoleBinding: "enforce",
    a2aHttpSignatureKeyRegistry: registry,
  });
  try {
    const task = await createBlockedTask(server.baseUrl);
    const path = `/tasks/${task.id}/approve`;
    const body = approveBody("analyst-c", "operator");
    const res = await fetch(`${server.baseUrl}${path}`, {
      method: "POST",
      headers: signedHeaders({
        baseUrl: server.baseUrl, path, body,
        requesterId: "analyst-c", role: "operator",
        keyid: "worker:analyst-c:v1", privateKey: analystOnlyKey.privateKey,
      }),
      body,
    });
    // The signature verifier already denies a role outside the key's declared roles.
    assert.equal(res.status, 401);
    assert.match(await errorCode(res), /a2a_signature_role_denied/);
  } finally {
    await server.close();
  }
});

test("approver role binding enforce: body actor must match the signed requester even without requester enforcement", async () => {
  const server = await startTestServer({
    enforceRequesterIdentity: false,
    brokerId: BROKER_ID,
    approverRoleBinding: "enforce",
    a2aHttpSignatureKeyRegistry: registry,
  });
  const baseUrl = server.baseUrl;
  try {
    const task = await createBlockedTask(baseUrl);
    const path = `/tasks/${task.id}/approve`;
    const body = approveBody("someone-else", "operator");
    const res = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: signedHeaders({
        baseUrl, path, body,
        requesterId: "operator-a", role: "operator",
        keyid: "approver:operator-a:v1", privateKey: operatorKey.privateKey,
      }),
      body,
    });
    assert.equal(res.status, 401);
  } finally {
    await server.close();
  }
});

test("approver role binding enforce: reject-approval is bound the same way", async () => {
  const server = await startTestServer({
    brokerId: BROKER_ID,
    approverRoleBinding: "enforce",
    a2aHttpSignatureKeyRegistry: registry,
  });
  try {
    const task = await createBlockedTask(server.baseUrl);
    const unsigned = await fetch(`${server.baseUrl}/tasks/${task.id}/reject-approval`, {
      method: "POST",
      headers: jsonHeaders({ "x-a2a-requester-id": "operator-a", "x-a2a-requester-role": "operator" }),
      body: approveBody("operator-a", "operator"),
    });
    assert.equal(unsigned.status, 401);
    assert.match(await errorCode(unsigned), /a2a_signature_approver_required/);

    const path = `/tasks/${task.id}/reject-approval`;
    const body = approveBody("operator-a", "operator");
    const signed = await fetch(`${server.baseUrl}${path}`, {
      method: "POST",
      headers: signedHeaders({
        baseUrl: server.baseUrl, path, body,
        requesterId: "operator-a", role: "operator",
        keyid: "approver:operator-a:v1", privateKey: operatorKey.privateKey,
      }),
      body,
    });
    assert.equal(signed.status, 200);
  } finally {
    await server.close();
  }
});

test("approver role binding off (default): health reports off and header approval still works", async () => {
  const server = await startTestServer({ brokerId: BROKER_ID });
  try {
    const health = await fetch(`${server.baseUrl}/health`);
    const healthBody = await health.json() as { requestSecurity?: { approverRoleBinding?: string } };
    assert.equal(healthBody.requestSecurity?.approverRoleBinding, "off");

    const task = await createBlockedTask(server.baseUrl);
    const res = await fetch(`${server.baseUrl}/tasks/${task.id}/approve`, {
      method: "POST",
      headers: jsonHeaders({ "x-a2a-requester-id": "operator-a", "x-a2a-requester-role": "operator" }),
      body: approveBody("operator-a", "operator"),
    });
    assert.equal(res.status, 200);
  } finally {
    await server.close();
  }
});
