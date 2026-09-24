// HTTP surface for #1601/#2208 operator lane re-judgment: POST
// /tasks/:id/rejudge-lane. Pins the requester-identity gate (401 for
// non-hub/operator requesters and for actor/requester mismatch), the broker
// gate mapping through HTTP (400 blank actor.id, 403 analyst actor when
// identity enforcement is off, 409 non-fast/terminal tasks, 404 unknown task),
// and the 200 success contract: laneRejudgment set, create-time laneAssignment
// byte-identical, one task.lane_rejudged audit, and the ruling visible on the
// post-ack read path (GET /tasks/:id).
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { BROKER_POLICY_SCHEMA } from "a2a-policy-referee";

import { jsonHeaders, startTestServer } from "./server-test-helpers.js";

const NOTE = "payload carried a fanout marker; not a single-worker analysis";

// A fast lane requires an explicit create-time policy allow decision: with no
// policy document the classifier fails closed (policy_decision_missing) and the
// task lands in the full lane. Wire the test server to a minimal allow-all
// policy file — the same brokerPolicyFile wiring production uses via
// A2A_BROKER_POLICY_FILE.
const ALLOW_POLICY_DIR = mkdtempSync(join(tmpdir(), "rejudge-lane-policy-"));
const ALLOW_POLICY_FILE = join(ALLOW_POLICY_DIR, "allow-policy.json");
writeFileSync(ALLOW_POLICY_FILE, JSON.stringify({
  schemaVersion: BROKER_POLICY_SCHEMA,
  mode: "enforce",
  defaultAction: "allow",
  rules: [],
}));
process.on("exit", () => rmSync(ALLOW_POLICY_DIR, { recursive: true, force: true }));

const OPERATOR = { id: "ops", kind: "node", role: "operator" } as const;
const HUB = { id: "hub-a", kind: "node", role: "hub" } as const;

function requesterHeaders(id: string, role: string): Record<string, string> {
  return jsonHeaders({
    "x-a2a-requester-id": id,
    "x-a2a-requester-role": role,
  });
}

/** Seed a persistent operator worker + a claimed/running fast-lane task. */
function seedRunningFastTask(
  server: Awaited<ReturnType<typeof startTestServer>>,
  payload: Record<string, unknown> = { mode: "analysis-only" },
): { id: string } {
  const broker = server.runtime.broker;
  broker.registerWorker({
    nodeId: "worker-1",
    role: "operator",
    capabilities: {
      canAnalyze: true,
      canBackfill: false,
      canPatchWorkspace: false,
      canPromoteLive: false,
      workspaceIds: ["default"],
      environments: ["research"],
    },
  });
  const task = broker.createTask({
    intent: "analyze",
    requester: { id: "hub", kind: "node", role: "hub" },
    target: { id: "worker-1", kind: "node", role: "operator" },
    payload,
  });
  broker.claimTask(task.id, "worker-1");
  broker.startTask(task.id, "worker-1");
  return task;
}

function rejudge(
  server: Awaited<ReturnType<typeof startTestServer>>,
  taskId: string,
  body: unknown,
  requester: { id: string; role: string } = { id: "ops", role: "operator" },
): Promise<Response> {
  return fetch(`${server.baseUrl}/tasks/${taskId}/rejudge-lane`, {
    method: "POST",
    headers: requesterHeaders(requester.id, requester.role),
    body: JSON.stringify(body),
  });
}

function rejudgeBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    actor: OPERATOR,
    decision: "full",
    reasonCode: "multi_worker_marker_present",
    note: NOTE,
    ...overrides,
  };
}

test("operator ruling returns 200, persists the ruling, and leaves laneAssignment untouched", async () => {
  const server = await startTestServer({ brokerPolicyFile: ALLOW_POLICY_FILE });
  try {
    const task = seedRunningFastTask(server);

    const beforeRes = await fetch(`${server.baseUrl}/tasks/${task.id}`);
    assert.equal(beforeRes.status, 200);
    const before = await beforeRes.json();
    assert.equal(before.laneAssignment.decision, "fast");

    const res = await rejudge(server, task.id, rejudgeBody());
    assert.equal(res.status, 200);
    const ruled = await res.json();
    assert.equal(ruled.status, "running");
    assert.ok(ruled.laneRejudgment, "response must carry laneRejudgment");
    assert.equal(ruled.laneRejudgment.actorId, "ops");
    assert.equal(ruled.laneRejudgment.from, "fast");
    assert.equal(ruled.laneRejudgment.to, "full");
    assert.equal(ruled.laneRejudgment.reasonCode, "multi_worker_marker_present");
    assert.equal(ruled.laneRejudgment.note, NOTE);
    assert.deepEqual(ruled.laneAssignment, before.laneAssignment);

    // Post-ack read path: the durable ack precedes the 200, so a plain read
    // must already observe the ruling.
    const afterRes = await fetch(`${server.baseUrl}/tasks/${task.id}`);
    const after = await afterRes.json();
    assert.deepEqual(after.laneRejudgment, ruled.laneRejudgment);
    assert.deepEqual(after.laneAssignment, before.laneAssignment);

    const audits = server.runtime.broker.listAuditEvents({ action: "task.lane_rejudged" });
    assert.equal(audits.length, 1);
    assert.equal(audits[0]?.targetId, task.id);
    assert.deepEqual(JSON.parse(audits[0]?.note ?? ""), after.laneRejudgment);
  } finally {
    await server.close();
  }
});

test("hub actors may rule through HTTP", async () => {
  const server = await startTestServer({ brokerPolicyFile: ALLOW_POLICY_FILE });
  try {
    const task = seedRunningFastTask(server);
    const res = await rejudge(server, task.id, rejudgeBody({ actor: HUB }), {
      id: "hub-a",
      role: "hub",
    });
    assert.equal(res.status, 200);
    const ruled = await res.json();
    assert.equal(ruled.laneRejudgment.actorId, "hub-a");
  } finally {
    await server.close();
  }
});

test("401: analyst requester is unauthorized — identity gate precedes the broker gate", async () => {
  const server = await startTestServer({ brokerPolicyFile: ALLOW_POLICY_FILE });
  try {
    const task = seedRunningFastTask(server);
    const res = await rejudge(
      server,
      task.id,
      rejudgeBody({ actor: { id: "worker-1", kind: "node", role: "analyst" } }),
      { id: "worker-1", role: "analyst" },
    );
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.error.code, "unauthorized");
    assert.equal(
      server.runtime.broker.getTask(task.id)?.laneRejudgment,
      undefined,
      "unauthorized request must not mutate the task",
    );
  } finally {
    await server.close();
  }
});

test("401: actor must match the authenticated requester identity", async () => {
  const server = await startTestServer({ brokerPolicyFile: ALLOW_POLICY_FILE });
  try {
    const task = seedRunningFastTask(server);
    const res = await rejudge(server, task.id, rejudgeBody(), {
      id: "someone-else",
      role: "operator",
    });
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.error.code, "unauthorized");
  } finally {
    await server.close();
  }
});

test("400: blank actor.id is rejected before any mutation", async () => {
  const server = await startTestServer({ brokerPolicyFile: ALLOW_POLICY_FILE });
  try {
    const task = seedRunningFastTask(server);
    const res = await rejudge(server, task.id, rejudgeBody({ actor: { id: "", kind: "node", role: "operator" } }));
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, "bad_request");
    assert.equal(server.runtime.broker.getTask(task.id)?.laneRejudgment, undefined);
  } finally {
    await server.close();
  }
});

test("403: analyst actor hits the broker policy gate when identity enforcement is off", async () => {
  const server = await startTestServer({
    brokerPolicyFile: ALLOW_POLICY_FILE,
    enforceRequesterIdentity: false,
  });
  try {
    const task = seedRunningFastTask(server);
    const res = await rejudge(
      server,
      task.id,
      rejudgeBody({ actor: { id: "worker-1", kind: "node", role: "analyst" } }),
    );
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.error.code, "policy_denied");
    assert.equal(server.runtime.broker.getTask(task.id)?.laneRejudgment, undefined);
  } finally {
    await server.close();
  }
});

test("409: full-lane, failed, and unknown tasks map to invalid_transition / not_found", async () => {
  const server = await startTestServer({
    brokerPolicyFile: ALLOW_POLICY_FILE,
    enforceRequesterIdentity: false,
  });
  try {
    const fullLane = seedRunningFastTask(server, {
      mode: "analysis-only",
      workers: ["w-1", "w-2"],
    });
    assert.equal(server.runtime.broker.getTask(fullLane.id)?.laneAssignment?.decision, "full");
    const fullRes = await rejudge(server, fullLane.id, rejudgeBody());
    assert.equal(fullRes.status, 409);
    assert.equal((await fullRes.json()).error.code, "invalid_transition");

    const failed = seedRunningFastTask(server);
    server.runtime.broker.failTask(failed.id, "worker-1", { code: "boom", message: "m" });
    const failedRes = await rejudge(server, failed.id, rejudgeBody());
    assert.equal(failedRes.status, 409);
    assert.equal((await failedRes.json()).error.code, "invalid_transition");

    const missingRes = await rejudge(server, "task-does-not-exist", rejudgeBody());
    assert.equal(missingRes.status, 404);
    assert.equal((await missingRes.json()).error.code, "not_found");
  } finally {
    await server.close();
  }
});
