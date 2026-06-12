/**
 * Recovery loop E2E regression tests.
 *
 * Closes jinwon-int/plugin-a2a#76.
 *
 * Covers:
 *  R2. Stale queued handoff — requeued task gets new wake
 *  R3. Failed child session — partial failure surface
 *  R4. Cancelled run retry — cancel + new task independence
 *  R5. Duplicate GitHub event replay — wake dedup
 *  R6. Max requeue exhausted — dead-letter mapping
 *  R7. Low-resource timing — rate limit + timeout
 *  R8. Concurrent recovery — idempotent cancel/requeue
 *
 * No broker instance needed — tests exercise plugin's wake evaluation
 * and type-mapping with fixture-derived envelopes.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { evaluateA2AWakePlan } from "../dist/src/wake-layer.js";

// ── Helpers ───────────────────────────────────────────────────

function makeEnvelope(overrides = {}) {
  return {
    taskId: "task-1",
    waitRunId: "wait-1",
    correlationId: "corr-1",
    brokerStatus: "claimed",
    target: { sessionKey: "session-alpha", displayKey: "worker-alpha" },
    ...overrides,
  };
}

function enabledConfig(overrides = {}) {
  return { enabled: true, ...overrides };
}

async function importTypeMapping() {
  return await import("../dist/type-mapping.js");
}

// ── R2. Stale queued handoff — requeued task gets new wake ────

describe("R2 — stale queued handoff: requeued task gets new wake", () => {
  it("requeued task (back to queued) evaluates as accepted and wake is scheduled", () => {
    const plan = evaluateA2AWakePlan({
      envelope: makeEnvelope({
        taskId: "requeued-task",
        waitRunId: "wait-requeue-1",
        correlationId: "corr-requeue",
        brokerStatus: "queued",
        target: { sessionKey: "session-alpha", displayKey: "worker-alpha" },
      }),
      config: enabledConfig(),
    });

    assert.equal(plan.status, "scheduled");
    assert.equal(plan.sessionKey, "session-alpha");
  });

  it("requeued task wake is not suppressed by old wake key", () => {
    const oldWakeKey = "corr-old:wait-old";
    const state = { recentWakeKeys: new Set([oldWakeKey]) };

    const plan = evaluateA2AWakePlan({
      envelope: makeEnvelope({
        taskId: "requeued-task",
        waitRunId: "wait-requeue-new",
        correlationId: "corr-requeue",
        brokerStatus: "queued",
      }),
      config: enabledConfig(),
      state,
    });

    assert.equal(plan.status, "scheduled");
    assert.notEqual(plan.wakeKey, oldWakeKey);
  });
});

// ── R3. Failed child session — partial failure surface ────────

describe("R3 — failed child session: partial failure is not silently passed", () => {
  it("failed child maps to 'failed' (not timed_out) without timeout error code", async () => {
    const { mapBrokerStatusToExecutionStatus } = await importTypeMapping();
    const result = mapBrokerStatusToExecutionStatus({
      brokerStatus: "failed",
      brokerErrorCode: "worker_crash",
    });
    assert.equal(result, "failed");
  });

  it("wake for failed child is skipped as terminal", () => {
    const plan = evaluateA2AWakePlan({
      envelope: makeEnvelope({
        taskId: "failed-child",
        brokerStatus: "failed",
        target: { sessionKey: "session-beta" },
      }),
      config: enabledConfig(),
    });

    assert.equal(plan.status, "skipped");
    assert.equal(plan.code, "terminal_task");
  });

  it("succeeded sibling child wake is also skipped (terminal)", () => {
    const plan = evaluateA2AWakePlan({
      envelope: makeEnvelope({
        taskId: "succeeded-child",
        brokerStatus: "succeeded",
        target: { sessionKey: "session-alpha" },
      }),
      config: enabledConfig(),
    });

    assert.equal(plan.status, "skipped");
    assert.equal(plan.code, "terminal_task");
  });
});

// ── R4. Cancelled run retry — cancel + new task independence ─

describe("R4 — cancelled run retry: cancel and retry are independent", () => {
  it("cancelled task wake is skipped", () => {
    const plan = evaluateA2AWakePlan({
      envelope: makeEnvelope({
        taskId: "cancelled-parent",
        brokerStatus: "canceled",
        target: { sessionKey: "session-alpha" },
      }),
      config: enabledConfig(),
    });

    assert.equal(plan.status, "skipped");
    assert.equal(plan.code, "terminal_task");
  });

  it("retry task gets a fresh wake not suppressed by cancel", () => {
    const state = {
      recentWakeKeys: new Set(["corr-cancel:wait-cancel"]),
    };

    const plan = evaluateA2AWakePlan({
      envelope: makeEnvelope({
        taskId: "retry-parent",
        waitRunId: "wait-retry",
        correlationId: "corr-retry",
        brokerStatus: "queued",
        target: { sessionKey: "session-alpha", displayKey: "worker-alpha" },
      }),
      config: enabledConfig(),
      state,
    });

    assert.equal(plan.status, "scheduled");
    assert.equal(plan.wakeKey, "corr-retry:wait-retry");
    assert.notEqual(plan.wakeKey, "corr-cancel:wait-cancel");
  });
});

// ── R5. Duplicate GitHub event replay — wake dedup ───────────

describe("R5 — duplicate event replay: wake dedup", () => {
  it("replayed event (same wake key) is suppressed", () => {
    const wakeKey = "sse-replay:wait-1";

    const plan1 = evaluateA2AWakePlan({
      envelope: makeEnvelope({
        taskId: "task-replay",
        waitRunId: "wait-1",
        correlationId: "sse-replay",
        brokerStatus: "running",
      }),
      config: enabledConfig(),
      state: { recentWakeKeys: new Set() },
    });

    const plan2 = evaluateA2AWakePlan({
      envelope: makeEnvelope({
        taskId: "task-replay",
        waitRunId: "wait-1",
        correlationId: "sse-replay",
        brokerStatus: "running",
      }),
      config: enabledConfig(),
      state: { recentWakeKeys: new Set([plan1.wakeKey]) },
    });

    assert.equal(plan1.status, "scheduled");
    assert.equal(plan2.status, "skipped");
    assert.equal(plan2.code, "duplicate_wake");
  });

  it("new event after replay is not suppressed", () => {
    const state = { recentWakeKeys: new Set(["sse-replay:wait-1"]) };

    const plan = evaluateA2AWakePlan({
      envelope: makeEnvelope({
        taskId: "task-replay",
        waitRunId: "wait-2",
        correlationId: "sse-replay",
        brokerStatus: "running",
      }),
      config: enabledConfig(),
      state,
    });

    assert.equal(plan.status, "scheduled");
  });
});

// ── R6. Max requeue exhausted — dead-letter mapping ──────────

describe("R6 — max requeue exhausted: dead-letter error code preserved", () => {
  it("exceeded_requeue_limit maps to failed (not timed_out)", async () => {
    const { mapBrokerStatusToExecutionStatus } = await importTypeMapping();
    const result = mapBrokerStatusToExecutionStatus({
      brokerStatus: "failed",
      brokerErrorCode: "exceeded_requeue_limit",
    });
    assert.equal(result, "failed");
  });

  it("is distinguishable from timeout failure", async () => {
    const { mapBrokerStatusToExecutionStatus } = await importTypeMapping();
    const deadLetter = mapBrokerStatusToExecutionStatus({
      brokerStatus: "failed",
      brokerErrorCode: "exceeded_requeue_limit",
    });
    const timeout = mapBrokerStatusToExecutionStatus({
      brokerStatus: "failed",
      brokerErrorCode: "timeout",
    });
    assert.notEqual(deadLetter, timeout);
    assert.equal(timeout, "timed_out");
  });
});

// ── R7. Low-resource timing — rate limit + timeout ───────────

describe("R7 — low-resource timing: rate limit and timeout handling", () => {
  it("rate-limited wakes are skipped with correct code", () => {
    const plan = evaluateA2AWakePlan({
      envelope: makeEnvelope({
        target: { sessionKey: "session-slow", displayKey: "node-slow" },
      }),
      config: enabledConfig({
        perNodeRateLimit: { maxWakeCount: 1, windowMs: 60_000, nowMs: 30_000 },
      }),
      state: {
        recentWakeTimestampsByTargetKey: new Map([
          ["node-slow", [20_000]],
        ]),
      },
    });

    assert.equal(plan.status, "skipped");
    assert.equal(plan.code, "rate_limited");
  });

  it("timeout error code produces timed_out status (distinct from failed)", async () => {
    const { mapBrokerStatusToExecutionStatus } = await importTypeMapping();
    assert.equal(
      mapBrokerStatusToExecutionStatus({ brokerStatus: "failed", brokerErrorCode: "timeout" }),
      "timed_out",
    );
    assert.equal(
      mapBrokerStatusToExecutionStatus({ brokerStatus: "failed", brokerErrorCode: "broker_timeout" }),
      "timed_out",
    );
  });

  it("rate limit window expiry allows new wakes", () => {
    const plan = evaluateA2AWakePlan({
      envelope: makeEnvelope({
        target: { sessionKey: "session-slow", displayKey: "node-slow" },
      }),
      config: enabledConfig({
        perNodeRateLimit: { maxWakeCount: 1, windowMs: 10_000, nowMs: 50_000 },
      }),
      state: {
        recentWakeTimestampsByTargetKey: new Map([
          ["node-slow", [5_000]],
        ]),
      },
    });

    assert.equal(plan.status, "scheduled");
  });
});

// ── R8. Concurrent recovery — idempotent cancel/requeue ──────

describe("R8 — concurrent recovery: idempotent actions", () => {
  it("duplicate cancel wake is idempotent (skipped as terminal)", () => {
    const plan1 = evaluateA2AWakePlan({
      envelope: makeEnvelope({
        taskId: "task-cancel",
        brokerStatus: "canceled",
      }),
      config: enabledConfig(),
    });

    const plan2 = evaluateA2AWakePlan({
      envelope: makeEnvelope({
        taskId: "task-cancel",
        brokerStatus: "canceled",
      }),
      config: enabledConfig(),
    });

    assert.equal(plan1.status, "skipped");
    assert.equal(plan1.code, "terminal_task");
    assert.equal(plan2.status, "skipped");
    assert.equal(plan2.code, "terminal_task");
    // No double dispatch
  });

  it("second requeue attempt does not produce duplicate wake if first was recent", () => {
    const wakeKey = "requeue:wait-rq";

    const plan1 = evaluateA2AWakePlan({
      envelope: makeEnvelope({
        taskId: "task-requeue",
        waitRunId: "wait-rq",
        correlationId: "requeue",
        brokerStatus: "queued",
      }),
      config: enabledConfig(),
      state: { recentWakeKeys: new Set() },
    });

    const plan2 = evaluateA2AWakePlan({
      envelope: makeEnvelope({
        taskId: "task-requeue",
        waitRunId: "wait-rq",
        correlationId: "requeue",
        brokerStatus: "queued",
      }),
      config: enabledConfig(),
      state: { recentWakeKeys: new Set([plan1.wakeKey]) },
    });

    assert.equal(plan1.status, "scheduled");
    assert.equal(plan2.status, "skipped");
    assert.equal(plan2.code, "duplicate_wake");
  });
});
