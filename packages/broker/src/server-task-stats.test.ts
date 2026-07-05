import test from "node:test";
import assert from "node:assert/strict";

import { startTestServer, jsonHeaders, registerTestWorker } from "./server-test-helpers.js";

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return jsonHeaders({
    "x-a2a-edge-secret": "test-edge-secret",
    "x-a2a-requester-id": "operator-1",
    "x-a2a-requester-role": "operator",
    ...extra,
  });
}

test("GET /stats/tasks returns read-only aggregate counts and omits worker identifiers", async () => {
  const server = await startTestServer({ edgeSecret: "test-edge-secret", enforceRequesterIdentity: true });
  try {
    await registerTestWorker(server.baseUrl, "secret-mobile-worker", "analyst", "test-edge-secret");
    await registerTestWorker(server.baseUrl, "secret-source-worker", "analyst", "test-edge-secret");

    server.runtime.broker.createTask({
      id: "stats-failed-handler",
      intent: "analyze",
      requester: { id: "operator-1", kind: "node", role: "operator" },
      target: { id: "secret-mobile-worker", kind: "node", role: "analyst" },
      assignedWorkerId: "secret-mobile-worker",
      parentRoundId: "env1-round-a",
      message: "failed handler",
      createdAt: "2026-07-05T01:00:00.000Z",
      payload: {},
    });
    server.runtime.broker.claimTask("stats-failed-handler", "secret-mobile-worker");
    server.runtime.broker.failTask("stats-failed-handler", "secret-mobile-worker", {
      code: "handler_exit_nonzero",
      message: "handler failed",
      details: { stage: "handler", nestedError: { code: "openclaw_analysis_failed" } },
    });

    server.runtime.broker.createTask({
      id: "stats-succeeded-source-only",
      intent: "analyze",
      requester: { id: "operator-1", kind: "node", role: "operator" },
      target: { id: "secret-source-worker", kind: "node", role: "analyst" },
      assignedWorkerId: "secret-source-worker",
      parentRoundId: "env1-round-a",
      message: "source only",
      createdAt: "2026-07-05T02:00:00.000Z",
      payload: { sourceOnly: true },
    });
    server.runtime.broker.claimTask("stats-succeeded-source-only", "secret-source-worker");
    server.runtime.broker.completeTask("stats-succeeded-source-only", "secret-source-worker", { summary: "ok" });

    const before = server.runtime.broker.listTasks().map((task) => ({ ...task }));
    const unauthenticated = await fetch(`${server.baseUrl}/stats/tasks?since=2026-07-05T00:00:00.000Z&until=2026-07-06T00:00:00.000Z`);
    assert.equal(unauthenticated.status, 401);

    const res = await fetch(`${server.baseUrl}/stats/tasks?since=2026-07-05T00:00:00.000Z&until=2026-07-06T00:00:00.000Z`, {
      headers: headers(),
    });
    if (res.status !== 200) {
      assert.fail(`expected 200, got ${res.status}: ${await res.text()}`);
    }
    const body = await res.json() as {
      total: number;
      byStatus: Record<string, number>;
      byErrorCode: Record<string, number>;
      byNestedClass: Record<string, number>;
      byStage: Record<string, number>;
      byWorkerClass: Record<string, number>;
      byRound: { top: Array<{ parentRoundId: string; failed: number; total: number }> };
    };
    assert.equal(body.total, 2);
    assert.deepEqual(body.byStatus, { failed: 1, succeeded: 1 });
    assert.deepEqual(body.byErrorCode, { handler_exit_nonzero: 1 });
    assert.deepEqual(body.byNestedClass, { openclaw_analysis_failed: 1 });
    assert.deepEqual(body.byStage, { handler: 1 });
    assert.deepEqual(body.byWorkerClass, { "source-only": 1, vps: 1 });
    assert.deepEqual(body.byRound.top, [{ parentRoundId: "env1-round-a", failed: 1, total: 2 }]);
    assert.equal(JSON.stringify(body).includes("secret-"), false);
    assert.deepEqual(server.runtime.broker.listTasks().map((task) => ({ ...task })), before);
  } finally {
    await server.close();
  }
});

test("GET /stats/tasks rejects invalid and over-broad windows", async () => {
  const server = await startTestServer({ edgeSecret: "test-edge-secret", enforceRequesterIdentity: true });
  try {
    const inverted = await fetch(`${server.baseUrl}/stats/tasks?since=2026-07-06T00:00:00.000Z&until=2026-07-05T00:00:00.000Z`, {
      headers: headers(),
    });
    assert.equal(inverted.status, 400);

    const broad = await fetch(`${server.baseUrl}/stats/tasks?since=2026-06-01T00:00:00.000Z&until=2026-07-05T00:00:00.000Z`, {
      headers: headers(),
    });
    assert.equal(broad.status, 400);
  } finally {
    await server.close();
  }
});
