import test from "node:test";
import assert from "node:assert/strict";

import {
  aggregateTaskLaneShadowCohorts,
  aggregateTaskLifecycleLatency,
  aggregateTaskStats,
  summarizeTaskLatency,
  validateLaneAssignmentForStats,
} from "./task-stats.js";
import type { AuditEvent, TaskLaneAssignment, TaskLaneReasonCode, TaskRecord } from "./types.js";

function task(overrides: Partial<TaskRecord>): TaskRecord {
  const createdAt = overrides.createdAt ?? "2026-07-05T00:00:00.000Z";
  return {
    id: overrides.id ?? "task-1",
    intent: overrides.intent ?? "analyze",
    requester: overrides.requester ?? { id: "hub", kind: "node", role: "hub" },
    target: overrides.target ?? { id: "worker-secret-alpha", kind: "node", role: "analyst" },
    targetNodeId: overrides.targetNodeId ?? "worker-secret-alpha",
    assignedWorkerId: overrides.assignedWorkerId ?? "worker-secret-alpha",
    message: overrides.message ?? "stats task",
    createdAt,
    updatedAt: overrides.updatedAt ?? createdAt,
    status: overrides.status ?? "queued",
    payload: overrides.payload ?? {},
    ...overrides,
  };
}

function audit(
  taskId: string,
  action: AuditEvent["action"],
  createdAt: string,
  suffix: string = action,
): AuditEvent {
  return {
    id: `${taskId}:${suffix}`,
    actorId: "worker-redacted",
    action,
    targetType: "task",
    targetId: taskId,
    createdAt,
  };
}

test("summarizeTaskLatency uses deterministic nearest-rank percentiles", () => {
  assert.deepEqual(summarizeTaskLatency([40, 10, 30, 20]), {
    count: 4,
    minMs: 10,
    maxMs: 40,
    averageMs: 25,
    p50Ms: 20,
    p95Ms: 40,
  });
  assert.deepEqual(summarizeTaskLatency([]), {
    count: 0,
    minMs: null,
    maxMs: null,
    averageMs: null,
    p50Ms: null,
    p95Ms: null,
  });
});

test("aggregateTaskLifecycleLatency reports complete phase distributions", () => {
  const tasks = [
    task({
      id: "latency-a",
      status: "succeeded",
      createdAt: "2026-07-05T00:00:00.000Z",
      claimedAt: "2026-07-05T00:00:00.100Z",
      completedAt: "2026-07-05T00:00:00.500Z",
      updatedAt: "2026-07-05T00:00:00.500Z",
    }),
    task({
      id: "latency-b",
      status: "failed",
      createdAt: "2026-07-05T00:00:01.000Z",
      claimedAt: "2026-07-05T00:00:01.200Z",
      completedAt: "2026-07-05T00:00:01.700Z",
      updatedAt: "2026-07-05T00:00:01.700Z",
      error: { code: "test_failure", message: "redacted" },
    }),
  ];
  const audits = [
    audit("latency-a", "task.created", "2026-07-05T00:00:00.000Z"),
    audit("latency-a", "task.claimed", "2026-07-05T00:00:00.100Z"),
    audit("latency-a", "task.started", "2026-07-05T00:00:00.150Z"),
    audit("latency-a", "task.succeeded", "2026-07-05T00:00:00.500Z"),
    audit("latency-b", "task.created", "2026-07-05T00:00:01.000Z"),
    audit("latency-b", "task.claimed", "2026-07-05T00:00:01.200Z"),
    audit("latency-b", "task.started", "2026-07-05T00:00:01.300Z"),
    audit("latency-b", "task.failed", "2026-07-05T00:00:01.700Z"),
  ];

  const latency = aggregateTaskLifecycleLatency(tasks, audits);

  assert.deepEqual(latency.coverage, {
    terminalTasks: 2,
    completeChains: 2,
    stages: { created: 2, claimed: 2, started: 2, completed: 2 },
    missing: { created: 0, claimed: 0, started: 0, completed: 0 },
    invalidChains: 0,
    invalidTimestampEvents: 0,
  });
  assert.deepEqual(latency.segments.createToClaim, {
    count: 2,
    minMs: 100,
    maxMs: 200,
    averageMs: 150,
    p50Ms: 100,
    p95Ms: 200,
  });
  assert.deepEqual(latency.segments.claimToStart, {
    count: 2,
    minMs: 50,
    maxMs: 100,
    averageMs: 75,
    p50Ms: 50,
    p95Ms: 100,
  });
  assert.deepEqual(latency.segments.startToComplete, {
    count: 2,
    minMs: 350,
    maxMs: 400,
    averageMs: 375,
    p50Ms: 350,
    p95Ms: 400,
  });
  assert.deepEqual(latency.segments.createToComplete, {
    count: 2,
    minMs: 500,
    maxMs: 700,
    averageMs: 600,
    p50Ms: 500,
    p95Ms: 700,
  });
  assert.deepEqual(latency.bottleneckByP95, { segment: "startToComplete", p95Ms: 400 });
});

test("aggregateTaskLifecycleLatency uses the latest monotonic requeue attempt", () => {
  const record = task({
    id: "latency-requeue",
    status: "succeeded",
    createdAt: "2026-07-05T00:00:00.000Z",
    claimedAt: "2026-07-05T00:00:00.400Z",
    completedAt: "2026-07-05T00:00:00.800Z",
    updatedAt: "2026-07-05T00:00:00.800Z",
    requeueCount: 1,
  });
  const latency = aggregateTaskLifecycleLatency([record], [
    audit(record.id, "task.created", "2026-07-05T00:00:00.000Z"),
    audit(record.id, "task.claimed", "2026-07-05T00:00:00.100Z", "claim-1"),
    audit(record.id, "task.started", "2026-07-05T00:00:00.150Z", "start-1"),
    audit(record.id, "task.requeued", "2026-07-05T00:00:00.300Z"),
    audit(record.id, "task.claimed", "2026-07-05T00:00:00.400Z", "claim-2"),
    audit(record.id, "task.started", "2026-07-05T00:00:00.450Z", "start-2"),
    audit(record.id, "task.succeeded", "2026-07-05T00:00:00.800Z"),
  ]);

  assert.equal(latency.coverage.completeChains, 1);
  assert.equal(latency.segments.createToClaim.p50Ms, 400);
  assert.equal(latency.segments.claimToStart.p50Ms, 50);
  assert.equal(latency.segments.startToComplete.p50Ms, 350);
});

test("aggregateTaskLifecycleLatency reports missing and non-monotonic chains without guessing", () => {
  const missingStart = task({
    id: "latency-missing-start",
    status: "succeeded",
    createdAt: "2026-07-05T00:00:00.000Z",
    claimedAt: "2026-07-05T00:00:00.100Z",
    completedAt: "2026-07-05T00:00:00.500Z",
    updatedAt: "2026-07-05T00:00:00.500Z",
  });
  const invalidOrder = task({
    id: "latency-invalid-order",
    status: "failed",
    createdAt: "2026-07-05T00:00:01.100Z",
    claimedAt: "2026-07-05T00:00:01.050Z",
    completedAt: "2026-07-05T00:00:01.500Z",
    updatedAt: "2026-07-05T00:00:01.500Z",
  });
  const latency = aggregateTaskLifecycleLatency([missingStart, invalidOrder], [
    audit(missingStart.id, "task.created", "2026-07-05T00:00:00.000Z"),
    audit(missingStart.id, "task.claimed", "2026-07-05T00:00:00.100Z"),
    audit(missingStart.id, "task.succeeded", "2026-07-05T00:00:00.500Z"),
    audit(invalidOrder.id, "task.created", "2026-07-05T00:00:01.100Z"),
    audit(invalidOrder.id, "task.claimed", "2026-07-05T00:00:01.050Z"),
    audit(invalidOrder.id, "task.started", "2026-07-05T00:00:01.200Z"),
    audit(invalidOrder.id, "task.started", "not-a-timestamp", "invalid-start"),
    audit(invalidOrder.id, "task.failed", "2026-07-05T00:00:01.500Z"),
    audit("outside-selection", "task.started", "not-a-timestamp"),
  ]);

  assert.equal(latency.coverage.terminalTasks, 2);
  assert.equal(latency.coverage.completeChains, 0);
  assert.equal(latency.coverage.missing.started, 1);
  assert.equal(latency.coverage.invalidChains, 1);
  assert.equal(latency.coverage.invalidTimestampEvents, 1);
  assert.equal(latency.segments.claimToStart.count, 0);
  assert.equal(latency.segments.createToComplete.count, 2);
});

test("aggregateTaskStats counts axes without leaking worker names", () => {
  const tasks = [
    task({
      id: "failed-handler",
      status: "failed",
      assignedWorkerId: "secret-mobile-worker",
      targetNodeId: "secret-mobile-worker",
      parentRoundId: "round-a",
      createdAt: "2026-07-05T01:00:00.000Z",
      updatedAt: "2026-07-05T01:10:00.000Z",
      error: {
        code: "handler_exit_nonzero",
        message: "handler failed",
        details: {
          stage: "handler",
          nestedError: { code: "openclaw_analysis_failed" },
        },
      },
    }),
    task({
      id: "failed-acceptance",
      status: "failed",
      assignedWorkerId: "secret-vps-worker",
      targetNodeId: "secret-vps-worker",
      parentRoundId: "round-a",
      createdAt: "2026-07-05T02:00:00.000Z",
      updatedAt: "2026-07-05T02:10:00.000Z",
      error: {
        code: "acceptance_failed",
        message: "acceptance failed",
        details: { stage: "verification" },
      },
    }),
    task({
      id: "succeeded-source-only",
      status: "succeeded",
      assignedWorkerId: "secret-source-worker",
      targetNodeId: "secret-source-worker",
      parentRoundId: "round-b",
      createdAt: "2026-07-05T03:00:00.000Z",
      updatedAt: "2026-07-05T03:10:00.000Z",
      payload: { sourceOnly: true },
    }),
    task({
      id: "outside-window",
      status: "failed",
      createdAt: "2026-06-01T00:00:00.000Z",
      updatedAt: "2026-06-01T00:00:00.000Z",
      error: { code: "old", message: "old" },
    }),
  ];

  const stats = aggregateTaskStats(tasks, {
    since: new Date("2026-07-05T00:00:00.000Z"),
    until: new Date("2026-07-06T00:00:00.000Z"),
    workerClassForTask(task) {
      if (task.payload.sourceOnly === true) return "source-only";
      if (task.assignedWorkerId?.includes("mobile")) return "mobile";
      return "vps";
    },
  });

  assert.equal(stats.total, 3);
  assert.deepEqual(stats.byStatus, { failed: 2, succeeded: 1 });
  assert.deepEqual(stats.byErrorCode, { acceptance_failed: 1, handler_exit_nonzero: 1 });
  assert.deepEqual(stats.byNestedClass, { no_stdout: 1, openclaw_analysis_failed: 1 });
  assert.deepEqual(stats.byStage, { handler: 1, verification: 1 });
  assert.deepEqual(stats.byWorkerClass, { mobile: 1, "source-only": 1, vps: 1 });
  assert.deepEqual(stats.byRound.top, [
    { parentRoundId: "round-a", failed: 2, total: 2 },
    { parentRoundId: "round-b", failed: 0, total: 1 },
  ]);
  assert.equal(JSON.stringify(stats).includes("secret-"), false);
});

test("aggregateTaskStats rejects inverted and over-broad windows", () => {
  assert.throws(
    () => aggregateTaskStats([], {
      since: new Date("2026-07-06T00:00:00.000Z"),
      until: new Date("2026-07-05T00:00:00.000Z"),
    }),
    /since must be <= until/,
  );
  assert.throws(
    () => aggregateTaskStats([], {
      since: new Date("2026-06-01T00:00:00.000Z"),
      until: new Date("2026-07-05T00:00:00.000Z"),
    }),
    /must not exceed 7 days/,
  );
});

// ---- #1601 fast-lane shadow cohort tests ----------------------------------

const FAST_ASSIGNMENT: TaskLaneAssignment = {
  version: "fast-lane.v1",
  mode: "shadow",
  decision: "fast",
  reasonCodes: ["all_fast_conditions_met"],
};

function fullAssignment(reasonCodes: TaskLaneReasonCode[]): TaskLaneAssignment {
  return {
    version: "fast-lane.v1",
    mode: "shadow",
    decision: "full",
    reasonCodes,
  };
}

function chainedTask(overrides: Partial<TaskRecord>): TaskRecord {
  return task({
    createdAt: "2026-07-05T00:00:00.000Z",
    claimedAt: "2026-07-05T00:00:00.100Z",
    completedAt: "2026-07-05T00:00:00.500Z",
    updatedAt: "2026-07-05T00:00:00.500Z",
    status: "succeeded",
    ...overrides,
  });
}

const COHORT_WINDOW = {
  since: new Date("2026-07-05T00:00:00.000Z"),
  until: new Date("2026-07-06T00:00:00.000Z"),
} as const;

function laneCohortsOf(tasks: TaskRecord[]) {
  return aggregateTaskStats(tasks, COHORT_WINDOW).laneCohorts;
}

test("shadow cohorts reconcile mixed outcomes and exclude active tasks from terminal/latency views", () => {
  const tasks = [
    chainedTask({ id: "fast-succeeded", laneAssignment: FAST_ASSIGNMENT }),
    chainedTask({
      id: "fast-failed",
      status: "failed",
      error: { code: "handler_exit_nonzero", message: "redacted" },
      laneAssignment: FAST_ASSIGNMENT,
    }),
    chainedTask({
      id: "full-canceled",
      status: "canceled",
      laneAssignment: fullAssignment(["intent_not_analyze"]),
    }),
    chainedTask({
      id: "full-active",
      status: "running",
      laneAssignment: fullAssignment(["mode_missing"]),
    }),
    chainedTask({ id: "absent-legacy", status: "queued" }),
    chainedTask({
      id: "invalid-failed",
      status: "failed",
      error: { code: "handler_exit_nonzero", message: "redacted" },
      laneAssignment: { ...FAST_ASSIGNMENT, version: "fast-lane.v2" } as unknown as TaskLaneAssignment,
    }),
  ];

  const stats = aggregateTaskStats(tasks, COHORT_WINDOW);
  const cohorts = stats.laneCohorts;

  assert.equal(cohorts.schemaVersion, "a2a.task-lane-shadow-cohorts.v1");
  assert.equal(cohorts.viewMode, "read_only_advisory");
  assert.deepEqual(cohorts.coverage, {
    selectedTasks: 6,
    validAssignments: 4,
    legacyAbsent: 1,
    invalidAssignment: 1,
  });
  // Reconciliation across cohorts + absent + invalid covers every selected task.
  assert.equal(
    cohorts.cohorts.fast.tasks + cohorts.cohorts.full.tasks
      + cohorts.coverage.legacyAbsent + cohorts.coverage.invalidAssignment,
    stats.total,
  );
  assert.deepEqual(cohorts.cohorts.fast, {
    tasks: 2,
    terminal: { succeeded: 1, failed: 1, canceled: 0 },
    reasonCounts: { all_fast_conditions_met: 2 },
    latency: { ...cohorts.cohorts.fast.latency },
  });
  assert.equal(cohorts.cohorts.fast.latency.coverage.terminalTasks, 2);
  assert.equal(cohorts.cohorts.fast.latency.segments.createToComplete.count, 2);
  assert.deepEqual(cohorts.cohorts.full.terminal, { succeeded: 0, failed: 0, canceled: 1 });
  assert.deepEqual(cohorts.cohorts.full.reasonCounts, { intent_not_analyze: 1, mode_missing: 1 });
  // The running full task is counted in the cohort but never in terminal/latency views.
  assert.equal(cohorts.cohorts.full.latency.coverage.terminalTasks, 1);
  // The overall latency view is unchanged: all four terminal tasks, any cohort.
  assert.equal(stats.latency.coverage.terminalTasks, 4);
  assert.equal(JSON.stringify(cohorts).includes("full-active"), false);
});

test("strict validation separates legacy absent from invalid assignments and never coerces invalid to fast", () => {
  assert.equal(validateLaneAssignmentForStats(undefined).state, "absent");

  const invalidValues: unknown[] = [
    null,
    "fast",
    42,
    [],
    {},
    { version: "fast-lane.v1", mode: "shadow", decision: "fast" },
    // unknown version / mode / decision
    { ...FAST_ASSIGNMENT, version: "fast-lane.v2" },
    { ...FAST_ASSIGNMENT, mode: "enforce" },
    { ...FAST_ASSIGNMENT, decision: "FAST" },
    { ...FAST_ASSIGNMENT, decision: "unknown" },
    { ...FAST_ASSIGNMENT, decision: undefined },
    // unknown / missing / malformed reason sets
    { ...FAST_ASSIGNMENT, reasonCodes: ["made_up_reason"] },
    { ...FAST_ASSIGNMENT, reasonCodes: [] },
    { ...FAST_ASSIGNMENT, reasonCodes: undefined },
    { ...FAST_ASSIGNMENT, reasonCodes: "all_fast_conditions_met" },
    { ...FAST_ASSIGNMENT, reasonCodes: [null] },
    { ...FAST_ASSIGNMENT, reasonCodes: [42] },
    // contradictory reason sets
    { ...FAST_ASSIGNMENT, reasonCodes: ["all_fast_conditions_met", "intent_not_analyze"] },
    { ...FAST_ASSIGNMENT, reasonCodes: ["intent_not_analyze"] },
    { ...fullAssignment(["intent_not_analyze"]), reasonCodes: ["all_fast_conditions_met"] },
    // duplicated codes are not a valid reason set
    { ...fullAssignment(["mode_missing"]), reasonCodes: ["mode_missing", "mode_missing"] },
    // extra keys are unsupported
    { ...FAST_ASSIGNMENT, evaluatedAt: "2026-07-05T00:00:00.000Z" },
  ];
  for (const value of invalidValues) {
    assert.equal(validateLaneAssignmentForStats(value).state, "invalid", JSON.stringify(value));
  }

  // Unknown-version records surface in invalidAssignment, never in fast cohorts.
  const cohorts = laneCohortsOf([
    chainedTask({
      id: "bad-version",
      laneAssignment: { ...FAST_ASSIGNMENT, version: "fast-lane.v9" } as unknown as TaskLaneAssignment,
    }),
  ]);
  assert.equal(cohorts.coverage.invalidAssignment, 1);
  assert.deepEqual(cohorts.cohorts.fast, {
    tasks: 0,
    terminal: { succeeded: 0, failed: 0, canceled: 0 },
    reasonCounts: {},
    latency: cohorts.cohorts.fast.latency,
  });
  assert.equal(cohorts.cohorts.fast.latency.coverage.terminalTasks, 0);
  assert.equal(JSON.stringify(cohorts).includes("fast-lane.v9"), false);
});

test("mutually exclusive classifier reasons are invalid without rejecting independent dimensions", () => {
  const impossiblePairs: TaskLaneReasonCode[][] = [
    ["mode_missing", "mode_not_read_only_analysis"],
    ["worker_mode_missing", "worker_not_persistent"],
    ["policy_decision_missing", "policy_requires_approval"],
    ["policy_decision_missing", "policy_denied"],
    ["policy_decision_missing", "policy_decision_unknown"],
    ["policy_requires_approval", "policy_denied"],
    ["policy_requires_approval", "policy_decision_unknown"],
    ["policy_denied", "policy_decision_unknown"],
  ];
  const validCombinations: TaskLaneReasonCode[][] = [
    ["mode_missing", "worker_not_persistent", "policy_denied"],
    ["fanout_marker_present", "sensitive_marker_present"],
    ["policy_requires_approval", "approval_marker_present"],
  ];
  for (const reasons of impossiblePairs) {
    assert.equal(validateLaneAssignmentForStats(fullAssignment(reasons)).state, "invalid", reasons.join(","));
    assert.equal(validateLaneAssignmentForStats(fullAssignment([...reasons].reverse())).state, "invalid");
  }
  for (const reasons of validCombinations) {
    assert.equal(validateLaneAssignmentForStats(fullAssignment(reasons)).state, "valid", reasons.join(","));
  }
  const cohorts = laneCohortsOf([...impossiblePairs, ...validCombinations].map((reasons, index) =>
    chainedTask({ id: `reason-set-${index}`, laneAssignment: fullAssignment(reasons) }),
  ));
  assert.deepEqual(cohorts.coverage, {
    selectedTasks: 11, validAssignments: 3, legacyAbsent: 0, invalidAssignment: 8,
  });
  assert.equal(cohorts.cohorts.fast.tasks, 0);
  assert.equal(cohorts.cohorts.full.tasks, 3);
  assert.equal(cohorts.cohorts.full.latency.coverage.terminalTasks, 3);
});

test("spoofed payload lane hints never create observed fast cohorts", () => {
  const spoofed = chainedTask({
    id: "spoofed-payload",
    status: "succeeded",
    payload: {
      lane: { decision: "fast" },
      laneAssignment: FAST_ASSIGNMENT,
      laneDecision: "fast",
      laneMode: "shadow",
      laneShadow: true,
      shadowLane: FAST_ASSIGNMENT,
      fastLane: true,
      fastLaneDecision: "fast",
      fastLaneShadow: FAST_ASSIGNMENT,
    },
  });
  const cohorts = laneCohortsOf([spoofed]);
  assert.deepEqual(cohorts.coverage, {
    selectedTasks: 1,
    validAssignments: 0,
    legacyAbsent: 1,
    invalidAssignment: 0,
  });
  assert.equal(cohorts.cohorts.fast.tasks, 0);
  assert.deepEqual(cohorts.cohorts.fast.reasonCounts, {});
});

test("shadow cohort output is deterministic under task-order permutations", () => {
  const tasks = [
    chainedTask({ id: "fast-succeeded", laneAssignment: FAST_ASSIGNMENT }),
    chainedTask({ id: "fast-queued", status: "queued", laneAssignment: FAST_ASSIGNMENT }),
    chainedTask({ id: "full-failed", status: "failed", laneAssignment: fullAssignment(["mode_missing", "worker_mode_missing"]) }),
    chainedTask({ id: "full-blocked", status: "blocked", laneAssignment: fullAssignment(["policy_requires_approval"]) }),
    chainedTask({ id: "absent-failed", status: "failed" }),
    chainedTask({ id: "invalid-canceled", status: "canceled", laneAssignment: { ...FAST_ASSIGNMENT, mode: "enforce" } as unknown as TaskLaneAssignment }),
  ];
  const baseline = laneCohortsOf(tasks);
  // Deterministic pseudo-random shuffle (xorshift), far more orders than 3 tasks would distinguish.
  let seed = 0x9e3779b9;
  const shuffled = [...tasks];
  for (let round = 0; round < 25; round += 1) {
    for (let index = shuffled.length - 1; index > 0; index -= 1) {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      const swap = Math.abs(seed) % (index + 1);
      [shuffled[index], shuffled[swap]] = [shuffled[swap] ?? shuffled[index], shuffled[index]];
    }
    assert.deepEqual(laneCohortsOf([...shuffled]), baseline, `permutation round ${round}`);
  }
  // reasonCounts keys are always emitted sorted, never in first-seen order.
  assert.deepEqual(Object.keys(baseline.cohorts.full.reasonCounts), [...Object.keys(baseline.cohorts.full.reasonCounts)].sort());
});

test("one-shot audit iterables are materialized once for the overall and per-cohort latency views", () => {
  const events: AuditEvent[] = [
    audit("fast-requeue", "task.created", "2026-07-05T00:00:00.000Z"),
    audit("fast-requeue", "task.claimed", "2026-07-05T00:00:00.100Z", "claim-1"),
    audit("fast-requeue", "task.started", "2026-07-05T00:00:00.150Z", "start-1"),
    audit("fast-requeue", "task.requeued", "2026-07-05T00:00:00.300Z"),
    audit("fast-requeue", "task.claimed", "2026-07-05T00:00:00.400Z", "claim-2"),
    audit("fast-requeue", "task.started", "2026-07-05T00:00:00.450Z", "start-2"),
    audit("fast-requeue", "task.succeeded", "2026-07-05T00:00:00.800Z"),
    audit("full-once", "task.created", "2026-07-05T00:01:00.000Z"),
    audit("full-once", "task.claimed", "2026-07-05T00:01:00.200Z"),
    audit("full-once", "task.started", "2026-07-05T00:01:00.300Z"),
    audit("full-once", "task.succeeded", "2026-07-05T00:01:00.800Z"),
  ];
  let iterations = 0;
  const oneShot = {
    [Symbol.iterator]() {
      iterations += 1;
      if (iterations > 1) throw new Error("audit iterable consumed twice");
      return events[Symbol.iterator]();
    },
  };

  const stats = aggregateTaskStats([
    chainedTask({
      id: "fast-requeue",
      claimedAt: "2026-07-05T00:00:00.400Z",
      completedAt: "2026-07-05T00:00:00.800Z",
      updatedAt: "2026-07-05T00:00:00.800Z",
      requeueCount: 1,
      laneAssignment: FAST_ASSIGNMENT,
    }),
    chainedTask({
      id: "full-once",
      createdAt: "2026-07-05T00:01:00.000Z",
      claimedAt: "2026-07-05T00:01:00.200Z",
      completedAt: "2026-07-05T00:01:00.800Z",
      updatedAt: "2026-07-05T00:01:00.800Z",
      laneAssignment: fullAssignment(["mode_missing"]),
    }),
  ], { ...COHORT_WINDOW, auditEvents: oneShot });

  assert.equal(iterations, 1);
  // Same latest-monotonic-attempt semantics as the overall view, per cohort.
  // Overall p50 spans both cohorts' createToClaim samples (200, 400).
  assert.equal(stats.latency.segments.createToClaim.p50Ms, 200);
  // The fast cohort alone requeues: its latest attempt starts at claim-2 (400ms).
  assert.equal(stats.laneCohorts.cohorts.fast.latency.segments.createToClaim.p50Ms, 400);
  assert.equal(stats.laneCohorts.cohorts.fast.latency.segments.claimToStart.p50Ms, 50);
  assert.equal(stats.laneCohorts.cohorts.fast.latency.coverage.completeChains, 1);
  assert.equal(stats.laneCohorts.cohorts.full.latency.segments.startToComplete.count, 1);
});

test("cohort windows are inclusive and tasks with unparseable terminal timestamps fall out", () => {
  const tasks = [
    chainedTask({ id: "at-since", laneAssignment: FAST_ASSIGNMENT }),
    chainedTask({ id: "at-until", createdAt: "2026-07-05T23:00:00.000Z", claimedAt: "2026-07-05T23:59:59.900Z", completedAt: "2026-07-06T00:00:00.000Z", updatedAt: "2026-07-06T00:00:00.000Z", laneAssignment: FAST_ASSIGNMENT }),
    chainedTask({ id: "bad-timestamp", createdAt: "2026-07-05T06:00:00.000Z", completedAt: "not-a-timestamp", updatedAt: "not-a-timestamp", laneAssignment: FAST_ASSIGNMENT }),
  ];
  const cohorts = laneCohortsOf(tasks);
  assert.deepEqual(cohorts.coverage, {
    selectedTasks: 2,
    validAssignments: 2,
    legacyAbsent: 0,
    invalidAssignment: 0,
  });
  assert.equal(cohorts.cohorts.fast.tasks, 2);
  assert.equal(cohorts.cohorts.fast.latency.segments.createToComplete.count, 2);
  assert.equal(JSON.stringify(cohorts).includes("bad-timestamp"), false);
});

test("empty cohorts are explicit zero structures and aggregateTaskLaneShadowCohorts accepts iterables", () => {
  const empty = aggregateTaskStats([], COHORT_WINDOW).laneCohorts;
  assert.deepEqual(empty.coverage, {
    selectedTasks: 0,
    validAssignments: 0,
    legacyAbsent: 0,
    invalidAssignment: 0,
  });
  assert.deepEqual(empty.cohorts.fast, {
    tasks: 0,
    terminal: { succeeded: 0, failed: 0, canceled: 0 },
    reasonCounts: {},
    latency: empty.cohorts.fast.latency,
  });
  assert.equal(empty.cohorts.fast.latency.coverage.terminalTasks, 0);
  assert.deepEqual(empty.cohorts.fast.latency.segments.createToComplete, {
    count: 0,
    minMs: null,
    maxMs: null,
    averageMs: null,
    p50Ms: null,
    p95Ms: null,
  });

  const generator = function* generateTasks(): Generator<TaskRecord> {
    yield chainedTask({ id: "from-generator", laneAssignment: FAST_ASSIGNMENT });
  };
  const cohorts = aggregateTaskLaneShadowCohorts(generator(), []);
  assert.deepEqual(cohorts.coverage, {
    selectedTasks: 1,
    validAssignments: 1,
    legacyAbsent: 0,
    invalidAssignment: 0,
  });
  assert.equal(cohorts.cohorts.fast.tasks, 1);
});
