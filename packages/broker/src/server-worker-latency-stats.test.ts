import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SqliteBrokerStateStore } from "./core/store.js";
import { startTestServer, jsonHeaders, registerTestWorker } from "./server-test-helpers.js";

const RECEIPT_TELEMETRY_SCHEMA_VERSION = "a2a.analysis-execution-telemetry.v1";

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return jsonHeaders({
    "x-a2a-edge-secret": "test-edge-secret",
    "x-a2a-requester-id": "operator-1",
    "x-a2a-requester-role": "operator",
    ...extra,
  });
}

test("GET /stats/workers returns advisory worker latency profiles for operators", async () => {
  const server = await startTestServer({ edgeSecret: "test-edge-secret", enforceRequesterIdentity: true });
  try {
    await registerTestWorker(server.baseUrl, "latency-worker-a", "analyst", "test-edge-secret");
    await registerTestWorker(server.baseUrl, "latency-worker-b", "analyst", "test-edge-secret");

    server.runtime.broker.createTask({
      id: "wlat-success",
      intent: "analyze",
      requester: { id: "operator-1", kind: "node", role: "operator" },
      target: { id: "latency-worker-a", kind: "node", role: "analyst" },
      assignedWorkerId: "latency-worker-a",
      message: "ok task",
      createdAt: "2026-07-05T01:00:00.000Z",
      payload: {},
    });
    server.runtime.broker.claimTask("wlat-success", "latency-worker-a");
    server.runtime.broker.startTask("wlat-success", "latency-worker-a");
    server.runtime.broker.completeTask("wlat-success", "latency-worker-a", {
      summary: "done",
      output: {
        requestedModel: "k3[1m]",
        requestedThinking: "high",
        actualRuntimeModel: "k3[1m]",
        effectiveModel: "k3[1m]",
        effectiveThinking: "high",
        sourceCarrierStats: { sourceFiles: 2, totalFiles: 2, totalBytes: 71_680 },
        executionTelemetry: {
          schemaVersion: RECEIPT_TELEMETRY_SCHEMA_VERSION,
          source: "piri_progress_file",
          elapsedMs: 158_600,
          modelRequests: 3,
          schemaRetries: 0,
        },
      },
    });

    server.runtime.broker.createTask({
      id: "wlat-failed",
      intent: "analyze",
      requester: { id: "operator-1", kind: "node", role: "operator" },
      target: { id: "latency-worker-b", kind: "node", role: "analyst" },
      assignedWorkerId: "latency-worker-b",
      message: "broken task",
      createdAt: "2026-07-05T01:05:00.000Z",
      payload: {},
    });
    server.runtime.broker.claimTask("wlat-failed", "latency-worker-b");
    server.runtime.broker.startTask("wlat-failed", "latency-worker-b");
    server.runtime.broker.failTask("wlat-failed", "latency-worker-b", {
      code: "handler_exit_nonzero",
      message: "handler failed",
      details: {
        bridgeFailure: {
          code: "analysis_bridge_schema_unsatisfied",
          requestedModel: "kimi-coding/k3",
          actualRuntimeModel: "zai/glm-5.2",
          excerpt: "raw bridge excerpt that must not reach stats",
          sourceCarrierStats: { sourceFiles: 2, totalBytes: 4_096 },
          executionTelemetry: {
            schemaVersion: RECEIPT_TELEMETRY_SCHEMA_VERSION,
            source: "claude_cli_envelope",
            elapsedMs: 1_234,
            modelRequests: 4,
            schemaRetries: 2,
            schemaRetryReasons: { extra_property: 2 },
          },
        },
      },
    });

    const response = await fetch(`${server.baseUrl}/stats/workers`, { headers: headers() });
    assert.equal(response.status, 200);
    const body = await response.json();

    assert.equal(body.schemaVersion, "a2a.worker-latency-profiles.v1");
    assert.equal(body.viewMode, "read_only_advisory");
    assert.equal(body.automaticRoutingPolicy, "none");
    assert.ok(body.window.since && body.window.until);

    const workerA = body.profiles.find((profile: { workerId: string }) => profile.workerId === "latency-worker-a");
    const workerB = body.profiles.find((profile: { workerId: string }) => profile.workerId === "latency-worker-b");
    assert.ok(workerA, "worker-a profile present");
    assert.ok(workerB, "worker-b profile present");
    assert.equal(workerA.byStatus.succeeded, 1);
    assert.equal(workerB.byStatus.failed, 1);
    assert.deepEqual(workerB.failureCodes.top, [{ code: "handler_exit_nonzero", count: 1 }]);
    assert.ok(workerA.latency.totalMs.p50Ms >= 0);

    // #1815 receipt measurements project onto the operator response.
    assert.deepEqual(body.coverage.receipts, { withCarrier: 2, structuredBridgeFailure: 1, resultOutput: 1, none: 0 });
    assert.deepEqual(body.coverage.executionTelemetry, { observed: 2, missing: 0, invalid: 0, truncated: 0 });
    assert.deepEqual(workerA.receipts.carriers, { structuredBridgeFailure: 0, resultOutput: 1, none: 0 });
    assert.equal(workerA.receipts.sourceBytes.totalBytes.max, 71_680);
    assert.equal(workerA.receipts.executionTelemetry.modelRequests.total, 3);
    assert.equal(workerA.receipts.executionTelemetry.schemaRetries.tasksWithZero, 1);
    assert.deepEqual(workerB.receipts.carriers, { structuredBridgeFailure: 1, resultOutput: 0, none: 0 });
    assert.equal(workerB.receipts.executionTelemetry.schemaRetries.total, 2);
    assert.deepEqual(workerB.receipts.executionTelemetry.schemaRetries.reasons, { extra_property: 2 });
    assert.deepEqual(workerB.receipts.modelMetadata.requestedActualModelLiteralEquality, { bothObserved: 1, literalMatch: 0, literalDifference: 1 });
    const serialized = JSON.stringify(body);
    assert.ok(!serialized.includes("k3[1m]"));
    assert.ok(!serialized.includes("kimi-coding/k3"));
    assert.ok(!serialized.includes("zai/glm-5.2"));
    assert.ok(!serialized.includes("raw bridge excerpt"));
    assert.ok(serialized.includes("71680"), "aggregate byte counts appear as numbers, never bodies");
    assert.equal(body.measurementPolicy.receiptCarrier.includes("one receipt per terminal task"), true);
    assert.equal(body.measurementPolicy.modelComparison.includes("literal identifier equality only"), true);
  } finally {
    await server.close();
  }
});

test("GET /stats/workers refuses non-operator roles when enforcement is on", async () => {
  const server = await startTestServer({ edgeSecret: "test-edge-secret", enforceRequesterIdentity: true });
  try {
    const response = await fetch(`${server.baseUrl}/stats/workers`, {
      headers: headers({
        "x-a2a-requester-id": "some-analyst",
        "x-a2a-requester-role": "analyst",
      }),
    });
    assert.equal(response.status, 401);
  } finally {
    await server.close();
  }
});

test("GET /stats/workers rejects invalid windows and bad maxWorkers", async () => {
  const server = await startTestServer({ edgeSecret: "test-edge-secret", enforceRequesterIdentity: true });
  try {
    const badWindow = await fetch(
      `${server.baseUrl}/stats/workers?since=2026-07-10T00:00:00.000Z&until=2026-07-05T00:00:00.000Z`,
      { headers: headers() },
    );
    assert.equal(badWindow.status, 400);

    const badCap = await fetch(`${server.baseUrl}/stats/workers?maxWorkers=0`, { headers: headers() });
    assert.equal(badCap.status, 400);
  } finally {
    await server.close();
  }
});

test("GET /stats/workers works against the sqlite state store read path", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "wlat-stats-"));
  const server = await startTestServer({
    edgeSecret: "test-edge-secret",
    enforceRequesterIdentity: true,
    stateStore: new SqliteBrokerStateStore(join(stateDir, "state.sqlite")),
  });
  try {
    await registerTestWorker(server.baseUrl, "latency-worker-c", "analyst", "test-edge-secret");
    server.runtime.broker.createTask({
      id: "wlat-sqlite",
      intent: "analyze",
      requester: { id: "operator-1", kind: "node", role: "operator" },
      target: { id: "latency-worker-c", kind: "node", role: "analyst" },
      assignedWorkerId: "latency-worker-c",
      message: "sqlite task",
      createdAt: "2026-07-05T02:00:00.000Z",
      payload: {},
    });
    server.runtime.broker.claimTask("wlat-sqlite", "latency-worker-c");
    server.runtime.broker.startTask("wlat-sqlite", "latency-worker-c");
    server.runtime.broker.completeTask("wlat-sqlite", "latency-worker-c", { summary: "done" });

    const response = await fetch(`${server.baseUrl}/stats/workers`, { headers: headers() });
    assert.equal(response.status, 200);
    const body = await response.json();
    const profile = body.profiles.find((row: { workerId: string }) => row.workerId === "latency-worker-c");
    assert.ok(profile, "sqlite-backed profile present");
    assert.equal(profile.completeChains, 1);
  } finally {
    await server.close();
    rmSync(stateDir, { recursive: true, force: true });
  }
});
