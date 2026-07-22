// Declarative worker-class policy engine (#1355 G1) — HTTP + broker-core
// integration. Covers the G1-c paths end-to-end: enforce deny, warn
// pass-through with structural audit, requireApproval routing to the existing
// blocked -> operator-approve -> queued flow, daily budget exhaustion,
// claim-time class re-evaluation, backward compatibility (no document = all
// allow), and loud startup failure on an invalid document.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createBrokerServer } from "./server.js";
import { BROKER_POLICY_SCHEMA, type BrokerPolicyDocument } from "a2a-policy-referee";
import { createInMemoryStateStore, startTestServer, jsonHeaders, workerPayload } from "./server-test-helpers.js";

function policyFile(doc: Partial<BrokerPolicyDocument> & Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "g1-policy-"));
  const path = join(dir, "broker-policy.json");
  writeFileSync(path, JSON.stringify({
    schemaVersion: BROKER_POLICY_SCHEMA,
    mode: "warn",
    defaultAction: "allow",
    rules: [],
    ...doc,
  }));
  return path;
}

async function registerWorker(baseUrl: string, workerMode?: string): Promise<void> {
  const res = await fetch(`${baseUrl}/workers/register`, {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({ ...workerPayload("workerbeta"), ...(workerMode ? { workerMode } : {}) }),
  });
  assert.ok(res.status === 200 || res.status === 201, `worker register failed: ${res.status}`);
}

function taskBody(id: string, intent = "chat"): string {
  return JSON.stringify({
    id,
    intent,
    requester: { id: "test-hub", kind: "node", role: "hub" },
    target: { id: "workerbeta", kind: "node", role: "analyst" },
    targetNodeId: "workerbeta",
    message: "policy engine test task",
    taskOrigin: "api",
  });
}

async function postTask(baseUrl: string, id: string, intent?: string): Promise<Response> {
  return fetch(`${baseUrl}/tasks`, { method: "POST", headers: jsonHeaders(), body: taskBody(id, intent) });
}

test("enforce mode denies a task whose intent is not allowed for its worker class (#1355)", async () => {
  const server = await startTestServer({
    enforceRequesterIdentity: false,
    brokerPolicyFile: policyFile({
      mode: "enforce",
      rules: [{ id: "vps-analyze-only", workerClass: "vps", allowIntents: ["analyze"] }],
    }),
  });
  try {
    await registerWorker(server.baseUrl);
    const denied = await postTask(server.baseUrl, "g1-enforce-denied", "chat");
    assert.equal(denied.status, 403);
    const body = await denied.json() as { error: { code: string; details?: { ruleId?: string } } };
    assert.equal(body.error.code, "policy_denied");
    assert.equal(body.error.details?.ruleId, "vps-analyze-only");
    // audit evidence exists even though nothing was created
    const audits = server.runtime.broker.listAuditEvents({ action: "task.policy_denied" });
    assert.equal(audits.length, 1);
    assert.match(audits[0].note ?? "", /vps-analyze-only/);

    const allowed = await postTask(server.baseUrl, "g1-enforce-allowed", "analyze");
    assert.equal(allowed.status, 201);
  } finally {
    await server.close();
  }
});

test("warn mode logs a structural policy_warned audit and lets the task proceed (#1355)", async () => {
  const server = await startTestServer({
    enforceRequesterIdentity: false,
    brokerPolicyFile: policyFile({
      mode: "warn",
      rules: [{ id: "vps-analyze-only", workerClass: "vps", allowIntents: ["analyze"] }],
    }),
  });
  try {
    await registerWorker(server.baseUrl);
    const res = await postTask(server.baseUrl, "g1-warned-task", "chat");
    assert.equal(res.status, 201, "warn mode must not block");
    const audits = server.runtime.broker.listAuditEvents({ action: "task.policy_warned" });
    assert.equal(audits.length, 1);
    assert.equal(audits[0].targetId, "g1-warned-task");
    assert.match(audits[0].note ?? "", /vps-analyze-only/);
  } finally {
    await server.close();
  }
});

test("a requireApproval rule routes the task to blocked -> operator approve -> claimable (#1355)", async () => {
  const server = await startTestServer({
    enforceRequesterIdentity: false,
    brokerPolicyFile: policyFile({
      mode: "warn", // approval routing applies in BOTH modes — blocking is recoverable
      rules: [{ id: "vps-needs-approval", workerClass: "vps", requireApproval: true }],
    }),
  });
  try {
    await registerWorker(server.baseUrl);
    const res = await postTask(server.baseUrl, "g1-approval-task");
    assert.equal(res.status, 201);
    const created = await res.json() as { status: string };
    assert.equal(created.status, "blocked");

    const broker = server.runtime.broker;
    assert.throws(() => broker.claimTask("g1-approval-task", "workerbeta"), /approval/);

    broker.approveTask("g1-approval-task", { actor: { id: "op-1", kind: "user", role: "operator" } });
    const claimed = broker.claimTask("g1-approval-task", "workerbeta");
    assert.equal(claimed.status, "claimed");
  } finally {
    await server.close();
  }
});

test("daily budget exhaustion denies the create over the cap under enforce (#1355)", async () => {
  const server = await startTestServer({
    enforceRequesterIdentity: false,
    brokerPolicyFile: policyFile({
      mode: "enforce",
      rules: [{ id: "vps-budget-1", workerClass: "vps", maxTasksPerDay: 1 }],
    }),
  });
  try {
    await registerWorker(server.baseUrl);
    const first = await postTask(server.baseUrl, "g1-budget-1");
    assert.equal(first.status, 201);
    const second = await postTask(server.baseUrl, "g1-budget-2");
    assert.equal(second.status, 403);
    const body = await second.json() as { error: { code: string; message: string } };
    assert.equal(body.error.code, "policy_denied");
    assert.match(body.error.message, /budget exhausted/);
  } finally {
    await server.close();
  }
});

test("claim-time re-evaluation catches a worker whose class changed after create (#1355)", async () => {
  const server = await startTestServer({
    enforceRequesterIdentity: false,
    brokerPolicyFile: policyFile({
      mode: "enforce",
      rules: [{ id: "mobile-analyze-only", workerClass: "mobile", allowIntents: ["analyze"] }],
    }),
  });
  try {
    await registerWorker(server.baseUrl); // vps class — no rule matches, defaultAction allow
    const res = await postTask(server.baseUrl, "g1-claim-recheck", "chat");
    assert.equal(res.status, 201);

    await registerWorker(server.baseUrl, "mobile"); // worker is now mobile class
    assert.throws(
      () => server.runtime.broker.claimTask("g1-claim-recheck", "workerbeta"),
      /intent 'chat' is not allowed/,
    );
    const audits = server.runtime.broker.listAuditEvents({ action: "task.policy_denied" });
    assert.equal(audits.length, 1);
    assert.equal(audits[0].targetId, "g1-claim-recheck");
  } finally {
    await server.close();
  }
});

test("no policy document keeps legacy behavior — everything allowed (#1355 backward compat)", async () => {
  const server = await startTestServer({ enforceRequesterIdentity: false });
  try {
    await registerWorker(server.baseUrl);
    const res = await postTask(server.baseUrl, "g1-no-policy", "chat");
    assert.equal(res.status, 201);
    const created = await res.json() as { status: string };
    assert.equal(created.status, "queued");
  } finally {
    await server.close();
  }
});

test("an invalid policy document fails startup loudly (#1355 fail-closed gate)", () => {
  const path = policyFile({ rules: [{ id: "r-1", workerClass: "*", denyIntents: ["x"] }] } as never);
  assert.throws(
    () =>
      createBrokerServer({
        host: "127.0.0.1",
        port: 0,
        publicBaseUrl: "https://broker.test/",
        edgeSecret: "test-edge-secret",
        brokerPolicyFile: path,
        stateStore: createInMemoryStateStore(),
      }),
    /unknown field 'denyIntents'/,
  );
});

test("a worker-name-shaped workerClass fails startup loudly (#1355 anonymity gate)", () => {
  const path = policyFile({ rules: [{ id: "r-1", workerClass: "workerbeta" }] });
  assert.throws(
    () =>
      createBrokerServer({
        host: "127.0.0.1",
        port: 0,
        publicBaseUrl: "https://broker.test/",
        edgeSecret: "test-edge-secret",
        brokerPolicyFile: path,
        stateStore: createInMemoryStateStore(),
      }),
    /worker names are rejected/,
  );
});
