import test from "node:test";
import assert from "node:assert/strict";

import {
  aggregateWorkerLatencyProfiles,
  WORKER_RECEIPT_TELEMETRY_SCHEMA_VERSION,
  workerIdentityForTask,
} from "./task-stats.js";
import type { AuditEvent, TaskRecord } from "./types.js";

function task(overrides: Partial<TaskRecord> & { id: string }): TaskRecord {
  return {
    intent: "analyze",
    status: "succeeded",
    targetNodeId: overrides.assignedWorkerId ?? "worker-a",
    payload: {},
    message: "private message body that must never leak",
    requester: { id: "operator-1", kind: "node", role: "operator" },
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:10.000Z",
    ...overrides,
  } as TaskRecord;
}

function event(action: AuditEvent["action"], targetId: string, at: string): AuditEvent {
  return { id: `${targetId}-${action}-${at}`, actorId: "broker", action, targetType: "task", targetId, createdAt: at };
}

function chainEvents(id: string, times: { created: string; claimed: string; started: string; terminal: string }, status: "succeeded" | "failed" | "canceled"): AuditEvent[] {
  const terminalAction = status === "succeeded" ? "task.succeeded" : status === "failed" ? "task.failed" : "task.canceled";
  return [
    event("task.created", id, times.created),
    event("task.claimed", id, times.claimed),
    event("task.started", id, times.started),
    event(terminalAction, id, times.terminal),
  ];
}

test("aggregates latency and outcomes separately per worker", () => {
  const tasks = [
    task({ id: "t1", assignedWorkerId: "worker-a" }),
    task({ id: "t2", assignedWorkerId: "worker-a", status: "failed", error: { code: "handler_exit_nonzero", message: "x" } }),
    task({ id: "t3", assignedWorkerId: "worker-b" }),
  ];
  const events = [
    ...chainEvents("t1", { created: "2026-09-01T00:00:00.000Z", claimed: "2026-09-01T00:00:02.000Z", started: "2026-09-01T00:00:03.000Z", terminal: "2026-09-01T00:00:13.000Z" }, "succeeded"),
    ...chainEvents("t2", { created: "2026-09-01T01:00:00.000Z", claimed: "2026-09-01T01:00:04.000Z", started: "2026-09-01T01:00:05.000Z", terminal: "2026-09-01T01:00:45.000Z" }, "failed"),
    ...chainEvents("t3", { created: "2026-09-01T02:00:00.000Z", claimed: "2026-09-01T02:00:01.000Z", started: "2026-09-01T02:00:02.000Z", terminal: "2026-09-01T02:00:06.000Z" }, "succeeded"),
  ];

  const response = aggregateWorkerLatencyProfiles(tasks, events);

  assert.equal(response.schemaVersion, "a2a.worker-latency-profiles.v1");
  assert.equal(response.viewMode, "read_only_advisory");
  assert.equal(response.automaticRoutingPolicy, "none");
  assert.equal(response.coverage.workers, 2);
  assert.equal(response.coverage.truncatedWorkers, 0);
  assert.equal(response.coverage.tasksWithoutWorkerIdentity, 0);

  const a = response.profiles.find((profile) => profile.workerId === "worker-a");
  const b = response.profiles.find((profile) => profile.workerId === "worker-b");
  assert.ok(a && b);

  assert.equal(a.terminalTasks, 2);
  assert.equal(a.completeChains, 2);
  assert.deepEqual(a.byStatus, { succeeded: 1, failed: 1, canceled: 0 });
  assert.deepEqual(a.failureCodes.top, [{ code: "handler_exit_nonzero", count: 1 }]);
  // t1: run 10s, t2: run 40s → nearest-rank: p50 picks ceil(0.5·2)=1st → 10000; p95 picks 2nd → 40000.
  assert.equal(a.latency.runMs.p50Ms, 10000);
  assert.equal(a.latency.runMs.p95Ms, 40000);
  assert.equal(a.latency.queueMs.p50Ms, 2000);

  assert.equal(b.terminalTasks, 1);
  assert.deepEqual(b.byStatus, { succeeded: 1, failed: 0, canceled: 0 });
  assert.equal(b.latency.runMs.p50Ms, 4000);
});

test("emission order is deterministic (terminal volume desc, then workerId asc) and maxWorkers truncates with a count", () => {
  const tasks = [
    task({ id: "t1", assignedWorkerId: "worker-c" }),
    task({ id: "t2", assignedWorkerId: "worker-c" }),
    task({ id: "t3", assignedWorkerId: "worker-a" }),
    task({ id: "t4", assignedWorkerId: "worker-b" }),
  ];
  const events = [
    ...chainEvents("t1", { created: "2026-09-01T00:00:00.000Z", claimed: "2026-09-01T00:00:01.000Z", started: "2026-09-01T00:00:02.000Z", terminal: "2026-09-01T00:00:05.000Z" }, "succeeded"),
    ...chainEvents("t2", { created: "2026-09-01T00:01:00.000Z", claimed: "2026-09-01T00:01:01.000Z", started: "2026-09-01T00:01:02.000Z", terminal: "2026-09-01T00:01:05.000Z" }, "succeeded"),
    ...chainEvents("t3", { created: "2026-09-01T00:02:00.000Z", claimed: "2026-09-01T00:02:01.000Z", started: "2026-09-01T00:02:02.000Z", terminal: "2026-09-01T00:02:05.000Z" }, "succeeded"),
    ...chainEvents("t4", { created: "2026-09-01T00:03:00.000Z", claimed: "2026-09-01T00:03:01.000Z", started: "2026-09-01T00:03:02.000Z", terminal: "2026-09-01T00:03:05.000Z" }, "succeeded"),
  ];

  const response = aggregateWorkerLatencyProfiles(tasks, events, { maxWorkers: 2 });

  // worker-c has 2 terminals (volume desc first); worker-a beats worker-b on the 1-terminal tie via workerId asc.
  assert.deepEqual(response.profiles.map((profile) => profile.workerId), ["worker-c", "worker-a"]);
  assert.equal(response.coverage.workers, 3);
  assert.equal(response.coverage.truncatedWorkers, 1);
});

test("counts tasks without a usable worker identity and ignores non-terminal tasks", () => {
  const tasks = [
    task({ id: "t1", assignedWorkerId: undefined as unknown as string, targetNodeId: undefined as unknown as string }),
    task({ id: "t2", assignedWorkerId: "worker-a", status: "failed", error: { code: "nope", message: "x" } }),
  ];
  const events = chainEvents("t2", { created: "2026-09-01T00:00:00.000Z", claimed: "2026-09-01T00:00:01.000Z", started: "2026-09-01T00:00:02.000Z", terminal: "2026-09-01T00:00:05.000Z" }, "failed");

  const response = aggregateWorkerLatencyProfiles(tasks, events);
  assert.equal(response.coverage.tasksWithoutWorkerIdentity, 1);
  assert.equal(response.coverage.workers, 1);
  assert.equal(response.profiles[0]?.workerId, "worker-a");
  assert.equal(response.profiles[0]?.terminalTasks, 1);
});

test("non-monotonic chains are excluded from latency samples without becoming private leaks", () => {
  const tasks = [task({ id: "t1", assignedWorkerId: "worker-a", status: "failed", error: { code: "handler_exit_nonzero", message: "x" } })];
  const events = [
    event("task.created", "t1", "2026-09-01T00:00:10.000Z"),
    // claimed before created — non-monotonic, must not feed samples.
    event("task.claimed", "t1", "2026-09-01T00:00:01.000Z"),
    event("task.started", "t1", "2026-09-01T00:00:02.000Z"),
    event("task.failed", "t1", "2026-09-01T00:00:05.000Z"),
  ];

  const response = aggregateWorkerLatencyProfiles(tasks, events);
  const profile = response.profiles[0];
  assert.ok(profile);
  assert.equal(profile.completeChains, 0);
  assert.equal(profile.latency.runMs.count, 0);
  assert.equal(profile.latency.queueMs.count, 0);
  assert.equal(profile.latency.totalMs.count, 0);
  assert.equal(profile.terminalTasks, 1);
  assert.deepEqual(profile.failureCodes.top, [{ code: "handler_exit_nonzero", count: 1 }]);
});

test("failure code lists are bounded and deterministically ordered", () => {
  const tasks = Array.from({ length: 9 }, (_, index) =>
    task({ id: `t${index}`, assignedWorkerId: "worker-a", status: "failed", error: { code: `code-${index % 3}`, message: "x" } }),
  );
  const events = tasks.flatMap((t, index) =>
    chainEvents(t.id, { created: "2026-09-01T00:00:00.000Z", claimed: "2026-09-01T00:00:01.000Z", started: "2026-09-01T00:00:02.000Z", terminal: "2026-09-01T00:00:05.000Z" }, "failed"),
  );

  const response = aggregateWorkerLatencyProfiles(tasks, events);
  const profile = response.profiles[0];
  assert.ok(profile);
  assert.ok(profile.failureCodes.top.length <= 5);
  // 3 distinct codes, each 3 occurrences — code asc tie-break.
  assert.deepEqual(profile.failureCodes.top.map((row) => row.code), ["code-0", "code-1", "code-2"]);
  assert.deepEqual(profile.failureCodes.top.map((row) => row.count), [3, 3, 3]);
});

test("workerIdentityForTask prefers assignedWorkerId and falls back to targetNodeId", () => {
  assert.equal(workerIdentityForTask(task({ id: "t1", assignedWorkerId: "w1" })), "w1");
  assert.equal(workerIdentityForTask(task({ id: "t2", assignedWorkerId: undefined as unknown as string, targetNodeId: "w2" })), "w2");
});

test("profiles carry no free-form task content", () => {
  const tasks = [task({ id: "t1", assignedWorkerId: "worker-a", message: "super-secret-private-message" })];
  const events = chainEvents("t1", { created: "2026-09-01T00:00:00.000Z", claimed: "2026-09-01T00:00:01.000Z", started: "2026-09-01T00:00:02.000Z", terminal: "2026-09-01T00:00:05.000Z" }, "succeeded");

  const response = aggregateWorkerLatencyProfiles(tasks, events);
  const serialized = JSON.stringify(response);
  assert.ok(!serialized.includes("super-secret-private-message"));
  assert.ok(!serialized.toLowerCase().includes("message"));
});

function successOutput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    analysisSummary: "operator-facing summary stays out of stats",
    requestedModel: "k3[1m]",
    requestedThinking: "high",
    actualRuntimeModel: "k3[1m]",
    effectiveModel: "k3[1m]",
    effectiveThinking: "high",
    sourceCarrierStats: { sourceFiles: 3, totalFiles: 3, totalBytes: 71_680 },
    executionTelemetry: {
      schemaVersion: WORKER_RECEIPT_TELEMETRY_SCHEMA_VERSION,
      source: "piri_progress_file",
      elapsedMs: 158_600,
      modelRequests: 3,
      schemaRetries: 0,
      inputTokens: 12_345,
      outputTokens: 6_789,
      costUsd: 0.42,
    },
    ...overrides,
  };
}

function bridgeFailure(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    code: "analysis_bridge_schema_unsatisfied",
    stage: "validate",
    requestedModel: "kimi-coding/k3",
    requestedThinking: "high",
    actualRuntimeModel: "zai/glm-5.2",
    excerpt: "raw validator excerpt that must never leak into stats",
    sourceCarrierStats: { sourceFiles: 3, totalBytes: 4_096 },
    executionTelemetry: {
      schemaVersion: WORKER_RECEIPT_TELEMETRY_SCHEMA_VERSION,
      source: "claude_cli_envelope",
      elapsedMs: 1_234,
      modelRequests: 4,
      schemaRetries: 2,
      schemaRetryReasons: { extra_property: 1, forged_reason: 7 },
    },
    ...overrides,
  };
}

function observedTelemetry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: WORKER_RECEIPT_TELEMETRY_SCHEMA_VERSION,
    source: "piri_progress_file",
    elapsedMs: 10_000,
    modelRequests: 2,
    schemaRetries: 0,
    ...overrides,
  };
}

test("success receipts aggregate source bytes, model requests, retries and model coverage without emitting bodies or names", () => {
  const tasks = [task({ id: "t1", assignedWorkerId: "worker-a", result: { output: successOutput() } })];
  const events = chainEvents("t1", { created: "2026-09-01T00:00:00.000Z", claimed: "2026-09-01T00:00:01.000Z", started: "2026-09-01T00:00:02.000Z", terminal: "2026-09-01T00:00:05.000Z" }, "succeeded");

  const response = aggregateWorkerLatencyProfiles(tasks, events);
  const profile = response.profiles[0];
  assert.ok(profile);

  assert.deepEqual(profile.receipts.carriers, { structuredBridgeFailure: 0, resultOutput: 1, none: 0 });
  assert.equal(profile.receipts.sourceBytes.observed, 1);
  assert.equal(profile.receipts.sourceBytes.missing, 0);
  assert.equal(profile.receipts.sourceBytes.totalBytes.count, 1);
  assert.equal(profile.receipts.sourceBytes.totalBytes.max, 71_680);
  assert.equal(profile.receipts.executionTelemetry.observed, 1);
  assert.equal(profile.receipts.executionTelemetry.missing, 0);
  assert.equal(profile.receipts.executionTelemetry.invalid, 0);
  assert.equal(profile.receipts.executionTelemetry.truncated, 0);
  assert.equal(profile.receipts.executionTelemetry.modelRequests.observed, 1);
  assert.equal(profile.receipts.executionTelemetry.modelRequests.total, 3);
  assert.equal(profile.receipts.executionTelemetry.schemaRetries.observed, 1);
  assert.equal(profile.receipts.executionTelemetry.schemaRetries.total, 0);
  assert.equal(profile.receipts.executionTelemetry.schemaRetries.tasksWithZero, 1, "explicit zero is a real observation");
  assert.equal(profile.receipts.executionTelemetry.schemaRetries.tasksWithRetries, 0);
  assert.deepEqual(profile.receipts.executionTelemetry.schemaRetries.reasons, {});
  assert.equal(profile.receipts.modelMetadata.requestedModelObserved, 1);
  assert.equal(profile.receipts.modelMetadata.actualRuntimeModelObserved, 1);
  assert.equal(profile.receipts.modelMetadata.effectiveModelObserved, 1);
  assert.deepEqual(profile.receipts.modelMetadata.requestedActualModelLiteralEquality, { bothObserved: 1, literalMatch: 1, literalDifference: 0 });
  assert.deepEqual(profile.receipts.modelMetadata.requestedEffectiveThinkingLiteralEquality, { bothObserved: 1, literalMatch: 1, literalDifference: 0 });

  // Top-level coverage mirrors the attributed task; optional token/USD usage is never projected.
  assert.deepEqual(response.coverage.receipts, { withCarrier: 1, structuredBridgeFailure: 0, resultOutput: 1, none: 0 });
  assert.deepEqual(response.coverage.executionTelemetry, { observed: 1, missing: 0, invalid: 0, truncated: 0 });
  const serialized = JSON.stringify(response);
  assert.ok(!serialized.includes("operator-facing summary"));
  assert.ok(!serialized.includes("12345"));
  assert.ok(!serialized.toLowerCase().includes("token"));
  assert.ok(!serialized.includes("costUsd"));
  assert.ok(!serialized.includes("k3[1m]"));
});

test("structured bridge failure receipts win over preserved result output and count once", () => {
  const tasks = [
    task({
      id: "t1",
      assignedWorkerId: "worker-a",
      status: "failed",
      error: {
        code: "openclaw_analysis_failed",
        message: "x",
        details: { bridgeFailure: bridgeFailure() },
      },
      // Success-side metadata on a failed task must never hide the failure receipt.
      result: { output: { requestedModel: "should-not-win", sourceCarrierStats: { totalBytes: 999 } } },
    }),
  ];
  const events = chainEvents("t1", { created: "2026-09-01T00:00:00.000Z", claimed: "2026-09-01T00:00:01.000Z", started: "2026-09-01T00:00:02.000Z", terminal: "2026-09-01T00:00:05.000Z" }, "failed");

  const response = aggregateWorkerLatencyProfiles(tasks, events);
  const profile = response.profiles[0];
  assert.ok(profile);

  assert.deepEqual(profile.receipts.carriers, { structuredBridgeFailure: 1, resultOutput: 0, none: 0 });
  assert.equal(profile.receipts.sourceBytes.totalBytes.max, 4_096, "failure carrier bytes, not success bytes");
  assert.equal(profile.receipts.executionTelemetry.modelRequests.total, 4);
  assert.equal(profile.receipts.executionTelemetry.schemaRetries.total, 2);
  assert.equal(profile.receipts.executionTelemetry.schemaRetries.tasksWithRetries, 1);
  // Unknown reason keys are dropped, bounded enum keys survive.
  assert.deepEqual(profile.receipts.executionTelemetry.schemaRetries.reasons, { extra_property: 1 });
  // Literal identifier equality only — a genuine cross-provider literal difference.
  assert.deepEqual(profile.receipts.modelMetadata.requestedActualModelLiteralEquality, { bothObserved: 1, literalMatch: 0, literalDifference: 1 });
  assert.equal(profile.receipts.modelMetadata.effectiveModelObserved, 0, "failure carrier has no effectiveModel");

  const serialized = JSON.stringify(response);
  assert.ok(!serialized.includes("should-not-win"));
  assert.ok(!serialized.includes("raw validator excerpt"));
  assert.ok(!serialized.includes("forged_reason"));
  assert.ok(!serialized.includes("kimi-coding/k3"));
  assert.ok(!serialized.includes("zai/glm-5.2"));
});

test("alias-equivalent model ids count as literal differences and the limitation is labelled", () => {
  const tasks = [
    task({
      id: "t1",
      assignedWorkerId: "worker-a",
      result: { output: { requestedModel: "k3[1m]", actualRuntimeModel: "kimi-coding/k3" } },
    }),
  ];
  const events = chainEvents("t1", { created: "2026-09-01T00:00:00.000Z", claimed: "2026-09-01T00:00:01.000Z", started: "2026-09-01T00:00:02.000Z", terminal: "2026-09-01T00:00:05.000Z" }, "succeeded");

  const response = aggregateWorkerLatencyProfiles(tasks, events);
  const profile = response.profiles[0];
  assert.ok(profile);
  // Alias resolution is out of scope: equivalent ids are reported as literal differences.
  assert.deepEqual(profile.receipts.modelMetadata.requestedActualModelLiteralEquality, { bothObserved: 1, literalMatch: 0, literalDifference: 1 });
  assert.equal(response.measurementPolicy.modelComparison.includes("literal identifier equality only"), true);
  const serialized = JSON.stringify(response);
  assert.ok(!serialized.includes("k3[1m]"));
  assert.ok(!serialized.includes("kimi-coding/k3"));
});

test("receipt coverage separates missing carriers and missing telemetry from explicit zeros", () => {
  const tasks = [
    // Carrier, but neither telemetry nor source bytes on it → missing, not zero.
    task({ id: "t1", assignedWorkerId: "worker-a", result: { output: { analysisStatus: "completed" } } }),
    // Explicit valid zeros (modelRequests:0, schemaRetries:0) with no source stats.
    task({
      id: "t2",
      assignedWorkerId: "worker-a",
      result: { output: { executionTelemetry: observedTelemetry({ modelRequests: 0, schemaRetries: 0 }) } },
    }),
    // Neither carrier → none.
    task({ id: "t3", assignedWorkerId: "worker-a" }),
  ];
  const events = [
    ...chainEvents("t1", { created: "2026-09-01T00:00:00.000Z", claimed: "2026-09-01T00:00:01.000Z", started: "2026-09-01T00:00:02.000Z", terminal: "2026-09-01T00:00:05.000Z" }, "succeeded"),
    ...chainEvents("t2", { created: "2026-09-01T00:01:00.000Z", claimed: "2026-09-01T00:01:01.000Z", started: "2026-09-01T00:01:02.000Z", terminal: "2026-09-01T00:01:05.000Z" }, "succeeded"),
    ...chainEvents("t3", { created: "2026-09-01T00:02:00.000Z", claimed: "2026-09-01T00:02:01.000Z", started: "2026-09-01T00:02:02.000Z", terminal: "2026-09-01T00:02:05.000Z" }, "succeeded"),
  ];

  const response = aggregateWorkerLatencyProfiles(tasks, events);
  const profile = response.profiles[0];
  assert.ok(profile);

  assert.deepEqual(profile.receipts.carriers, { structuredBridgeFailure: 0, resultOutput: 2, none: 1 });
  assert.deepEqual(profile.receipts.sourceBytes, {
    observed: 0,
    missing: 2,
    invalid: 0,
    totalBytes: { count: 0, min: null, max: null, average: null, p50: null, p95: null },
  });
  assert.equal(profile.receipts.executionTelemetry.observed, 1);
  assert.equal(profile.receipts.executionTelemetry.missing, 1);
  assert.equal(profile.receipts.executionTelemetry.modelRequests.observed, 1);
  assert.equal(profile.receipts.executionTelemetry.modelRequests.total, 0, "explicit zero stays a zero, not absence");
  assert.equal(profile.receipts.executionTelemetry.schemaRetries.tasksWithZero, 1);
  assert.equal(profile.receipts.executionTelemetry.schemaRetries.tasksWithRetries, 0);
  assert.deepEqual(response.coverage.receipts, { withCarrier: 2, structuredBridgeFailure: 0, resultOutput: 2, none: 1 });
  assert.deepEqual(response.coverage.executionTelemetry, { observed: 1, missing: 1, invalid: 0, truncated: 0 });
});

test("malformed, non-finite, negative and fractional receipt numbers are rejected without coercion", () => {
  const tasks = [
    // Fractional byte counts are not observations.
    task({ id: "t1", assignedWorkerId: "worker-a", result: { output: { sourceCarrierStats: { totalBytes: 1.5 } } } }),
    // Present malformed counts invalidate the receipt rather than mimicking absence.
    task({
      id: "t2",
      assignedWorkerId: "worker-a",
      result: {
        output: {
          executionTelemetry: observedTelemetry({ modelRequests: "3", schemaRetries: -2 }),
        },
      },
    }),
    // Telemetry that is not an object → invalid.
    task({ id: "t3", assignedWorkerId: "worker-a", result: { output: { executionTelemetry: "not-an-object" } } }),
    // Wrong schemaVersion → invalid.
    task({
      id: "t4",
      assignedWorkerId: "worker-a",
      result: { output: { executionTelemetry: observedTelemetry({ schemaVersion: "a2a.forged.v9" }) } },
    }),
    // Disallowed source → invalid.
    task({
      id: "t5",
      assignedWorkerId: "worker-a",
      result: { output: { executionTelemetry: observedTelemetry({ source: "forged_source" }) } },
    }),
  ];
  const events = tasks.flatMap((t) =>
    chainEvents(t.id, { created: "2026-09-01T00:00:00.000Z", claimed: "2026-09-01T00:00:01.000Z", started: "2026-09-01T00:00:02.000Z", terminal: "2026-09-01T00:00:05.000Z" }, "succeeded"),
  );

  const response = aggregateWorkerLatencyProfiles(tasks, events);
  const profile = response.profiles[0];
  assert.ok(profile);

  assert.deepEqual(profile.receipts.sourceBytes, {
    observed: 0,
    missing: 4,
    invalid: 1, // present fractional bytes are distinct from absence
    totalBytes: { count: 0, min: null, max: null, average: null, p50: null, p95: null },
  });
  assert.equal(profile.receipts.executionTelemetry.observed, 0);
  assert.equal(profile.receipts.executionTelemetry.invalid, 4);
  assert.equal(profile.receipts.executionTelemetry.missing, 1);
  assert.equal(profile.receipts.executionTelemetry.modelRequests.observed, 0, "string counts never coerce");
  assert.equal(profile.receipts.executionTelemetry.modelRequests.total, 0, "negatives never pollute totals");
  assert.equal(profile.receipts.executionTelemetry.schemaRetries.observed, 0);
  assert.equal(profile.receipts.executionTelemetry.schemaRetries.total, 0);
});

test("truncated telemetry stays visibly incomplete", () => {
  const tasks = [
    task({
      id: "t1",
      assignedWorkerId: "worker-a",
      result: { output: { executionTelemetry: observedTelemetry({ truncated: true, schemaRetries: 1, schemaRetryReasons: { invalid_value: 1 } }) } },
    }),
  ];
  const events = chainEvents("t1", { created: "2026-09-01T00:00:00.000Z", claimed: "2026-09-01T00:00:01.000Z", started: "2026-09-01T00:00:02.000Z", terminal: "2026-09-01T00:00:05.000Z" }, "succeeded");

  const response = aggregateWorkerLatencyProfiles(tasks, events);
  const profile = response.profiles[0];
  assert.ok(profile);
  assert.equal(profile.receipts.executionTelemetry.observed, 1);
  assert.equal(profile.receipts.executionTelemetry.truncated, 1);
  assert.equal(response.coverage.executionTelemetry.truncated, 1);
  assert.deepEqual(profile.receipts.executionTelemetry.schemaRetries.reasons, { invalid_value: 1 });
});

test("receipt carriers outside the stats window are excluded", () => {
  const tasks = [
    task({
      id: "t-fresh",
      assignedWorkerId: "worker-a",
      result: { output: successOutput() },
      completedAt: "2026-09-02T00:00:00.000Z",
      updatedAt: "2026-09-02T00:00:00.000Z",
    }),
    task({
      id: "t-stale",
      assignedWorkerId: "worker-a",
      result: { output: successOutput() },
      createdAt: "2026-08-01T00:00:00.000Z",
      completedAt: "2026-08-01T00:00:05.000Z",
      updatedAt: "2026-08-01T00:00:05.000Z",
    }),
  ];
  const events = [
    ...chainEvents("t-fresh", { created: "2026-09-02T00:00:00.000Z", claimed: "2026-09-02T00:00:01.000Z", started: "2026-09-02T00:00:02.000Z", terminal: "2026-09-02T00:00:05.000Z" }, "succeeded"),
  ];

  const response = aggregateWorkerLatencyProfiles(tasks, events, {
    window: { sinceMs: Date.parse("2026-08-27T00:00:00.000Z"), untilMs: Date.parse("2026-09-03T00:00:00.000Z") },
  });
  assert.deepEqual(response.coverage.receipts, { withCarrier: 1, structuredBridgeFailure: 0, resultOutput: 1, none: 0 });
  const profile = response.profiles[0];
  assert.ok(profile);
  assert.equal(profile.receipts.carriers.resultOutput, 1);
  assert.equal(profile.receipts.sourceBytes.observed, 1);
});

test("malicious extra fields on carriers never reach the report", () => {
  const tasks = [
    task({
      id: "t1",
      assignedWorkerId: "worker-a",
      result: {
        output: successOutput({
          promptLeak: "secret prompt fragment",
          executionTelemetry: {
            ...observedTelemetry(),
            schemaRetryReasons: { forged_reason: 7, extra_property: 2 },
            forgedMarker: { nested: "leak" },
          },
        }),
      },
    }),
  ];
  const events = chainEvents("t1", { created: "2026-09-01T00:00:00.000Z", claimed: "2026-09-01T00:00:01.000Z", started: "2026-09-01T00:00:02.000Z", terminal: "2026-09-01T00:00:05.000Z" }, "succeeded");

  const response = aggregateWorkerLatencyProfiles(tasks, events);
  const profile = response.profiles[0];
  assert.ok(profile);
  assert.deepEqual(profile.receipts.executionTelemetry.schemaRetries.reasons, { extra_property: 2 });
  const serialized = JSON.stringify(response);
  assert.ok(!serialized.includes("secret prompt fragment"));
  assert.ok(!serialized.includes("forged_reason"));
  assert.ok(!serialized.includes("forgedMarker"));
  assert.ok(!serialized.includes("leak"));
});


function receiptForOutput(output: Record<string, unknown>) {
  return aggregateWorkerLatencyProfiles([task({ id: "receipt-boundary", result: { output } })], []).profiles[0]!.receipts;
}

test("present invalid receipt fields stay distinct from omitted optional values", () => {
  const empty = { schemaVersion: WORKER_RECEIPT_TELEMETRY_SCHEMA_VERSION, source: "piri_progress_file" };
  const absent = receiptForOutput({ executionTelemetry: empty });
  assert.equal(absent.executionTelemetry.observed, 1);
  assert.equal(absent.executionTelemetry.invalid, 0);
  assert.equal(absent.executionTelemetry.modelRequests.observed, 0);
  for (const bad of [null, false, "3", -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    for (const key of ["modelRequests", "schemaRetries"]) {
      const actual = receiptForOutput({ executionTelemetry: { ...empty, [key]: bad } });
      assert.equal(actual.executionTelemetry.invalid, 1, `${key}: ${String(bad)}`);
      assert.equal(actual.executionTelemetry.observed, 0);
      assert.equal(actual.executionTelemetry.missing, 0);
    }
    const bytes = receiptForOutput({ sourceCarrierStats: { totalBytes: bad } }).sourceBytes;
    assert.equal(bytes.invalid, 1);
    assert.equal(bytes.missing, 0);
    const reasons = receiptForOutput({ executionTelemetry: { ...empty, schemaRetryReasons: { other: bad } } });
    assert.equal(reasons.executionTelemetry.invalid, 1);
  }
  for (const bad of [null, "true", 0, [], {}]) {
    assert.equal(receiptForOutput({ executionTelemetry: { ...empty, truncated: bad } }).executionTelemetry.invalid, 1);
  }
  for (const bad of [null, [], "bad"]) {
    assert.equal(receiptForOutput({ executionTelemetry: { ...empty, schemaRetryReasons: bad } }).executionTelemetry.invalid, 1);
    assert.equal(receiptForOutput({ sourceCarrierStats: bad }).sourceBytes.invalid, 1);
  }
  assert.equal(receiptForOutput({}).sourceBytes.missing, 1);
  assert.equal(receiptForOutput({ sourceCarrierStats: {} }).sourceBytes.missing, 1);
  const zero = receiptForOutput({ sourceCarrierStats: { totalBytes: 0 }, executionTelemetry: { ...empty, truncated: false, modelRequests: 0, schemaRetries: 0 } });
  assert.equal(zero.sourceBytes.observed, 1);
  assert.equal(zero.executionTelemetry.modelRequests.observed, 1);
  assert.equal(zero.executionTelemetry.modelRequests.total, 0);
});

test("receipt sums expose overflow without wrapping, clamping or rounded counts", () => {
  function aggregate(values: number[]) {
    return aggregateWorkerLatencyProfiles(values.map((value, index) => task({
      id: `sum-${index}`, result: { output: {
        sourceCarrierStats: { totalBytes: value },
        executionTelemetry: observedTelemetry({ modelRequests: value, schemaRetries: value, schemaRetryReasons: { other: value } }),
      } },
    })), []).profiles[0]!.receipts;
  }
  const max = Number.MAX_SAFE_INTEGER;
  const exact = aggregate([max - 2, 1, 1]);
  assert.equal(exact.executionTelemetry.modelRequests.total, max);
  assert.equal(exact.executionTelemetry.schemaRetries.total, max);
  assert.equal(exact.executionTelemetry.schemaRetries.reasons.other, max);
  const overflow = aggregate([max, 2, 1]);
  assert.equal(overflow.executionTelemetry.modelRequests.observed, 3);
  assert.equal(overflow.executionTelemetry.modelRequests.total, null);
  assert.equal(overflow.executionTelemetry.schemaRetries.total, null);
  assert.equal(overflow.executionTelemetry.schemaRetries.reasons.other, null);
  assert.equal(overflow.sourceBytes.totalBytes.count, 3);
  assert.equal(aggregate([max]).sourceBytes.totalBytes.average, max, "average must not lose precision by multiplying a Number by 1000");
  assert.equal(aggregate([1, 2, 2]).sourceBytes.totalBytes.average, 1.667);
  assert.equal(JSON.parse(JSON.stringify(overflow)).executionTelemetry.modelRequests.total, null);
});
