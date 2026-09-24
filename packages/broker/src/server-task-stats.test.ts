import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BROKER_POLICY_SCHEMA, type BrokerPolicyDocument } from "a2a-policy-referee";

import { SqliteBrokerStateStore } from "./core/store.js";
import { startTestServer, jsonHeaders, registerTestWorker } from "./server-test-helpers.js";

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return jsonHeaders({
    "x-a2a-edge-secret": "test-edge-secret",
    "x-a2a-requester-id": "operator-1",
    "x-a2a-requester-role": "operator",
    ...extra,
  });
}

function allowPolicyFile(): string {
  // A present allow document gives the classifier a policy decision, so a
  // clean analyze task can actually land in the fast cohort.
  const policy: BrokerPolicyDocument = {
    schemaVersion: BROKER_POLICY_SCHEMA,
    mode: "warn",
    defaultAction: "allow",
    rules: [],
  };
  const dir = mkdtempSync(join(tmpdir(), "lane-cohort-policy-"));
  const path = join(dir, "broker-policy.json");
  writeFileSync(path, JSON.stringify(policy));
  return path;
}

async function registerPersistentWorker(server: { baseUrl: string }, nodeId: string): Promise<void> {
  const res = await fetch(`${server.baseUrl}/workers/register`, {
    method: "POST",
    headers: jsonHeaders({
      "x-a2a-edge-secret": "test-edge-secret",
      "x-a2a-requester-id": nodeId,
      "x-a2a-requester-role": "analyst",
    }),
    body: JSON.stringify({
      nodeId,
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
  assert.ok(res.status === 200 || res.status === 201, `worker register failed: ${res.status}`);
}

async function runCohortScenario(server: Awaited<ReturnType<typeof startTestServer>>): Promise<void> {
  await registerPersistentWorker(server, "secret-cohort-worker");

  // Clean analyze + read-only mode + persistent worker + allow policy = fast.
  server.runtime.broker.createTask({
    id: "stats-cohort-fast",
    intent: "analyze",
    requester: { id: "operator-1", kind: "node", role: "operator" },
    target: { id: "secret-cohort-worker", kind: "node", role: "analyst" },
    assignedWorkerId: "secret-cohort-worker",
    message: "fast cohort",
    payload: { mode: "analysis-only" },
  });
  server.runtime.broker.claimTask("stats-cohort-fast", "secret-cohort-worker");
  server.runtime.broker.startTask("stats-cohort-fast", "secret-cohort-worker");
  server.runtime.broker.completeTask("stats-cohort-fast", "secret-cohort-worker", { summary: "ok" });

  // Missing payload.mode = full (mode_missing), otherwise identical.
  server.runtime.broker.createTask({
    id: "stats-cohort-full",
    intent: "analyze",
    requester: { id: "operator-1", kind: "node", role: "operator" },
    target: { id: "secret-cohort-worker", kind: "node", role: "analyst" },
    assignedWorkerId: "secret-cohort-worker",
    message: "full cohort",
    payload: {},
  });
  server.runtime.broker.claimTask("stats-cohort-full", "secret-cohort-worker");
  server.runtime.broker.startTask("stats-cohort-full", "secret-cohort-worker");
  server.runtime.broker.failTask("stats-cohort-full", "secret-cohort-worker", {
    code: "handler_exit_nonzero",
    message: "handler failed",
  });
}

function assertCohortAggregate(body: {
  total: number;
  laneCohorts: {
    schemaVersion: string;
    viewMode: string;
    executionPolicy: string;
    coverage: { selectedTasks: number; validAssignments: number; legacyAbsent: number; invalidAssignment: number };
    cohorts: {
      fast: { tasks: number; terminal: Record<string, number>; reasonCounts: Record<string, number>; latency: { coverage: { terminalTasks: number; completeChains: number } } };
      full: { tasks: number; terminal: Record<string, number>; reasonCounts: Record<string, number>; latency: { coverage: { terminalTasks: number; completeChains: number } } };
    };
  };
  latency: { coverage: { terminalTasks: number } };
}): void {
  const cohorts = body.laneCohorts;
  assert.equal(cohorts.schemaVersion, "a2a.task-lane-shadow-cohorts.v1");
  assert.equal(cohorts.viewMode, "read_only_advisory");
  assert.match(cohorts.executionPolicy, /all tasks still run full execution/);
  assert.deepEqual(cohorts.coverage, {
    selectedTasks: 2,
    validAssignments: 2,
    legacyAbsent: 0,
    invalidAssignment: 0,
  });
  // Cohorts + missing + invalid reconcile across every selected task.
  assert.equal(
    cohorts.cohorts.fast.tasks + cohorts.cohorts.full.tasks
      + cohorts.coverage.legacyAbsent + cohorts.coverage.invalidAssignment,
    body.total,
  );
  assert.deepEqual(cohorts.cohorts.fast.terminal, { succeeded: 1, failed: 0, canceled: 0 });
  assert.deepEqual(cohorts.cohorts.fast.reasonCounts, { all_fast_conditions_met: 1 });
  assert.deepEqual(cohorts.cohorts.full.terminal, { succeeded: 0, failed: 1, canceled: 0 });
  assert.deepEqual(cohorts.cohorts.full.reasonCounts, { mode_missing: 1 });
  // Same lifecycle latency semantics as the overall view, per cohort.
  assert.equal(cohorts.cohorts.fast.latency.coverage.terminalTasks, 1);
  assert.equal(cohorts.cohorts.fast.latency.coverage.completeChains, 1);
  assert.equal(cohorts.cohorts.full.latency.coverage.terminalTasks, 1);
  assert.equal(cohorts.cohorts.full.latency.coverage.completeChains, 1);
  assert.equal(body.latency.coverage.terminalTasks, 2);
}

test("GET /stats/tasks reports advisory fast-lane shadow cohorts without task or worker identifiers", async () => {
  const server = await startTestServer({
    edgeSecret: "test-edge-secret",
    enforceRequesterIdentity: true,
    brokerPolicyFile: allowPolicyFile(),
  });
  try {
    await runCohortScenario(server);

    const until = new Date(Date.now() + 60_000).toISOString();
    const since = new Date(Date.now() - 60_000).toISOString();
    const windowQuery = `since=${encodeURIComponent(since)}&until=${encodeURIComponent(until)}`;
    const unauthenticated = await fetch(`${server.baseUrl}/stats/tasks?${windowQuery}`);
    assert.equal(unauthenticated.status, 401);

    const res = await fetch(`${server.baseUrl}/stats/tasks?${windowQuery}`, { headers: headers() });
    if (res.status !== 200) {
      assert.fail(`expected 200, got ${res.status}: ${await res.text()}`);
    }
    const body = await res.json() as Parameters<typeof assertCohortAggregate>[0];
    assertCohortAggregate(body);

    // Fixed schema surface: no task/worker/message/model identifiers anywhere
    // in the added aggregate — only counts and closed reason codes.
    assert.deepEqual(Object.keys(body.laneCohorts), [
      "schemaVersion",
      "viewMode",
      "executionPolicy",
      "measurementPolicy",
      "coverage",
      "cohorts",
    ]);
    assert.deepEqual(Object.keys(body.laneCohorts.cohorts.fast), ["tasks", "terminal", "reasonCounts", "latency"]);
    const serialized = JSON.stringify(body.laneCohorts);
    assert.equal(serialized.includes("secret-"), false);
    assert.equal(serialized.includes("stats-cohort-"), false);
    assert.equal(serialized.includes("fast cohort"), false);
  } finally {
    await server.close();
  }
});

test("GET /stats/tasks shadow cohorts read equivalently from persisted SQLite hot tables", async () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-task-stats-lane-cohorts-"));
  const store = new SqliteBrokerStateStore(join(dir, "state.sqlite"), { loadSource: "hot-tables" });
  const server = await startTestServer({
    stateStore: store,
    edgeSecret: "test-edge-secret",
    enforceRequesterIdentity: true,
    brokerPolicyFile: allowPolicyFile(),
  });
  try {
    await runCohortScenario(server);

    const until = new Date(Date.now() + 60_000).toISOString();
    const since = new Date(Date.now() - 60_000).toISOString();
    const res = await fetch(
      `${server.baseUrl}/stats/tasks?since=${encodeURIComponent(since)}&until=${encodeURIComponent(until)}`,
      { headers: headers() },
    );
    assert.equal(res.status, 200);
    const body = await res.json() as Parameters<typeof assertCohortAggregate>[0];
    assertCohortAggregate(body);
    assert.equal(JSON.stringify(body).includes("secret-cohort-worker"), false);
  } finally {
    await server.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

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
    server.runtime.broker.startTask("stats-failed-handler", "secret-mobile-worker");
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
    server.runtime.broker.startTask("stats-succeeded-source-only", "secret-source-worker");
    server.runtime.broker.completeTask("stats-succeeded-source-only", "secret-source-worker", { summary: "ok" });

    const before = server.runtime.broker.listTasks().map((task) => ({ ...task }));
    // completeTask/failTask stamp completedAt/updatedAt with the real wall clock, and
    // aggregateTaskStats windows on that terminal timestamp. Anchor the query window to
    // now so the test does not silently fail once wall-clock passes a hardcoded bound
    // (see #1365); keep the span under the 7-day maximum.
    const until = new Date(Date.now() + 60_000).toISOString();
    const since = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000).toISOString();
    const windowQuery = `since=${encodeURIComponent(since)}&until=${encodeURIComponent(until)}`;
    const unauthenticated = await fetch(`${server.baseUrl}/stats/tasks?${windowQuery}`);
    assert.equal(unauthenticated.status, 401);

    const res = await fetch(`${server.baseUrl}/stats/tasks?${windowQuery}`, {
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
      latency: {
        schemaVersion: string;
        coverage: { terminalTasks: number; completeChains: number; invalidChains: number };
        segments: Record<string, { count: number; p50Ms: number | null; p95Ms: number | null }>;
      };
    };
    assert.equal(body.total, 2);
    assert.deepEqual(body.byStatus, { failed: 1, succeeded: 1 });
    assert.deepEqual(body.byErrorCode, { handler_exit_nonzero: 1 });
    assert.deepEqual(body.byNestedClass, { openclaw_analysis_failed: 1 });
    assert.deepEqual(body.byStage, { handler: 1 });
    assert.deepEqual(body.byWorkerClass, { "source-only": 1, vps: 1 });
    assert.deepEqual(body.byRound.top, [{ parentRoundId: "env1-round-a", failed: 1, total: 2 }]);
    assert.equal(body.latency.schemaVersion, "a2a.task-lifecycle-latency.v1");
    assert.equal(body.latency.coverage.terminalTasks, 2);
    assert.equal(body.latency.coverage.completeChains, 2);
    assert.equal(body.latency.coverage.invalidChains, 0);
    assert.equal(body.latency.segments.createToClaim.count, 2);
    assert.equal(body.latency.segments.claimToStart.count, 2);
    assert.equal(body.latency.segments.startToComplete.count, 2);
    assert.equal(body.latency.segments.createToComplete.count, 2);
    assert.equal(JSON.stringify(body).includes("secret-"), false);
    assert.deepEqual(server.runtime.broker.listTasks().map((task) => ({ ...task })), before);
  } finally {
    await server.close();
  }
});

test("GET /stats/tasks reads lifecycle latency from SQLite hot audit tables", async () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-task-stats-latency-"));
  const store = new SqliteBrokerStateStore(join(dir, "state.sqlite"), { loadSource: "hot-tables" });
  const server = await startTestServer({
    stateStore: store,
    edgeSecret: "test-edge-secret",
    enforceRequesterIdentity: true,
  });
  try {
    await registerTestWorker(server.baseUrl, "secret-sqlite-worker", "analyst", "test-edge-secret");
    server.runtime.broker.createTask({
      id: "stats-sqlite-latency",
      intent: "analyze",
      requester: { id: "operator-1", kind: "node", role: "operator" },
      target: { id: "secret-sqlite-worker", kind: "node", role: "analyst" },
      assignedWorkerId: "secret-sqlite-worker",
      message: "sqlite latency",
      payload: {},
    });
    server.runtime.broker.claimTask("stats-sqlite-latency", "secret-sqlite-worker");
    server.runtime.broker.startTask("stats-sqlite-latency", "secret-sqlite-worker");
    server.runtime.broker.completeTask("stats-sqlite-latency", "secret-sqlite-worker", { summary: "ok" });

    const until = new Date(Date.now() + 60_000).toISOString();
    const since = new Date(Date.now() - 60_000).toISOString();
    const res = await fetch(
      `${server.baseUrl}/stats/tasks?since=${encodeURIComponent(since)}&until=${encodeURIComponent(until)}`,
      { headers: headers() },
    );
    assert.equal(res.status, 200);
    const body = await res.json() as {
      total: number;
      latency: {
        coverage: { terminalTasks: number; completeChains: number };
        segments: Record<string, { count: number }>;
      };
    };
    assert.equal(body.total, 1);
    assert.equal(body.latency.coverage.terminalTasks, 1);
    assert.equal(body.latency.coverage.completeChains, 1);
    assert.equal(body.latency.segments.claimToStart.count, 1);
    assert.equal(JSON.stringify(body).includes("secret-sqlite-worker"), false);
  } finally {
    await server.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
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
