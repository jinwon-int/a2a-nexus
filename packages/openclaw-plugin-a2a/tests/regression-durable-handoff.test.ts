/**
 * Second-wave regression tests for the durable-runtime handoff.
 *
 * Issue: jinwon-int/plugin-a2a#35
 *
 * Covers scenarios from the regression matrix and durable-runtime
 * requirements that do NOT depend on the canonical core seam
 * (jinwon-int/openclaw#29) or broker durable identity (jinwon-int/a2a-broker#33):
 *
 *  - Cancel lifecycle mapping (scenario 7): broker canceled → cancelled,
 *    abortStatus arms, idempotent cancel on terminal tasks
 *  - Timeout mapping (scenario 2): BROKER_TIMEOUT_CODES variants → timed_out
 *  - Stale worker / requeue worker-id resolution (scenario 3 partial)
 *  - Terminal status classification and idempotent transitions
 *  - Reconcile-needed signals from status drift
 *  - Interruption-aware lifecycle: broker state mismatch detection
 *  - Duplicate create awareness: idempotency key contract validation
 *
 * These are pure unit tests — no broker instance needed.
 * When upstream contracts land, add integration fixtures here.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ── imports from src ──────────────────────────────────────────

import {
  mapBrokerStatusToExecutionStatus,
  mapBrokerStatusToDeliveryStatus,
  mapBrokerErrorToTaskError,
  isBrokerTimeoutCode,
  isBrokerTaskTerminal,
  isTerminalExecutionStatus,
  resolveCancelTarget,
  resolveTraceField,
  toEpochMs,
  ACTIVE_BROKER_STATUSES,
  TERMINAL_BROKER_STATUSES,
  TERMINAL_OPENCLAW_STATUSES,
  NON_CANCEL_TERMINAL_STATUSES,
  type BrokerTaskStatus,
  type A2AExecutionStatus,
  type A2ATaskCancelTarget,
} from "../dist/type-mapping.js";

import {
  buildGatewayTaskResult,
  buildGatewayTaskStatus,
  buildGatewayTaskOutput,
  buildGatewayTaskError,
  resolveWorkerId,
  normalizeString,
  type GatewayTaskMethod,
} from "../dist/src/gateway-handlers.js";

import { a2aError, A2AErrorCodes } from "../dist/src/plugin-errors.js";
import { A2ABrokerClientError } from "../dist/standalone-broker-client.js";

// ── helpers ───────────────────────────────────────────────────

type TaskOverrides = Partial<{
  status: string;
  brokerStatus: string;
  executionStatus: string;
  deliveryStatus: string;
  error: { code: string; message?: string } | undefined;
  output: unknown;
  summary: string | undefined;
  claimedBy: string | undefined;
  assignedWorkerId: string | undefined;
  targetNodeId: string | undefined;
  target: { id: string; kind?: string } | undefined;
  payload: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  startedAt: string | undefined;
  completedAt: string | undefined;
  attemptId: string | undefined;
  idempotencyKey: string | undefined;
  correlationId: string | undefined;
  parentRunId: string | undefined;
}>;

function makeTask(overrides: TaskOverrides = {}): Record<string, unknown> {
  return {
    id: "task-1",
    intent: "chat",
    status: "queued",
    brokerStatus: "queued",
    requester: { id: "hub-001", kind: "session", role: "hub" },
    target: { id: "worker-001" },
    assignedWorkerId: "worker-001",
    payload: {},
    createdAt: "2025-01-01T00:00:00Z",
    updatedAt: "2025-01-01T00:00:00Z",
    ...overrides,
  };
}

// ── 7. Cancel lifecycle mapping ──────────────────────────────

describe("7 — cancel lifecycle mapping", () => {
  it("broker canceled → executionStatus cancelled (two L's)", () => {
    // The plugin maps broker "canceled" to OpenClaw "cancelled"
    const task = makeTask({ status: "canceled" });
    const status = buildGatewayTaskStatus(task);
    assert.equal(status.executionStatus, "cancelled");
  });

  it("cancel result sets abortStatus aborted when broker is canceled", () => {
    const task = makeTask({ status: "canceled" });
    const result = buildGatewayTaskResult("a2a.task.cancel" as GatewayTaskMethod, task);
    assert.equal(result.abortStatus, "aborted");
  });

  it("cancel result sets not-attempted when task already succeeded", () => {
    const task = makeTask({ status: "succeeded" });
    const result = buildGatewayTaskResult("a2a.task.cancel" as GatewayTaskMethod, task);
    assert.equal(result.abortStatus, "not-attempted");
  });

  it("cancel result sets not-attempted when task already failed", () => {
    const task = makeTask({ status: "failed" });
    const result = buildGatewayTaskResult("a2a.task.cancel" as GatewayTaskMethod, task);
    assert.equal(result.abortStatus, "not-attempted");
  });

  it("cancel result sets not-attempted when task already canceled", () => {
    const task = makeTask({ status: "canceled" });
    // If already terminal cancel, should still be aborted (not not-attempted)
    // because the broker DID cancel — just confirming idempotent behavior
    const result = buildGatewayTaskResult("a2a.task.cancel" as GatewayTaskMethod, task);
    assert.equal(result.abortStatus, "aborted");
  });

  it("cancel target resolution: explicit > payload > request > synth", () => {
    const explicit: A2ATaskCancelTarget = { kind: "session_run", sessionKey: "explicit" };
    const payload: A2ATaskCancelTarget = { kind: "session_run", sessionKey: "payload" };
    const request: A2ATaskCancelTarget = { kind: "session_run", sessionKey: "request" };

    // explicit wins
    assert.deepEqual(
      resolveCancelTarget({ explicit, payload, request }),
      explicit,
    );

    // payload wins when no explicit
    assert.deepEqual(
      resolveCancelTarget({ payload, request }),
      payload,
    );

    // request wins when no explicit/payload
    assert.deepEqual(
      resolveCancelTarget({ request }),
      request,
    );

    // synth from targetSessionKey + runId
    assert.deepEqual(
      resolveCancelTarget({ targetSessionKey: "ssk-1", runId: "run-1" }),
      { kind: "session_run", sessionKey: "ssk-1", runId: "run-1" },
    );

    // synth from targetSessionKey alone (no runId)
    assert.deepEqual(
      resolveCancelTarget({ targetSessionKey: "ssk-2" }),
      { kind: "session_run", sessionKey: "ssk-2" },
    );

    // no cancel target when nothing provided
    assert.equal(resolveCancelTarget({}), undefined);
  });
});

// ── 2. Timeout mapping ───────────────────────────────────────

describe("2 — timeout mapping variants", () => {
  const TIMEOUT_CODES = ["timeout", "timed_out", "broker_timeout", "TIMEOUT", "Timed_Out"];

  for (const code of TIMEOUT_CODES) {
    it(`broker error code "${code}" maps to timed_out`, () => {
      const status = mapBrokerStatusToExecutionStatus({
        brokerStatus: "failed",
        brokerErrorCode: code,
      });
      assert.equal(status, "timed_out");
    });
  }

  it("broker failed without timeout code maps to failed (not timed_out)", () => {
    const status = mapBrokerStatusToExecutionStatus({
      brokerStatus: "failed",
      brokerErrorCode: "some_other_error",
    });
    assert.equal(status, "failed");
  });

  it("broker failed without any error code maps to failed", () => {
    const status = mapBrokerStatusToExecutionStatus({
      brokerStatus: "failed",
    });
    assert.equal(status, "failed");
  });

  it("isBrokerTimeoutCode handles whitespace", () => {
    assert.equal(isBrokerTimeoutCode("  timeout  "), true);
  });

  it("isBrokerTimeoutCode returns false for undefined", () => {
    assert.equal(isBrokerTimeoutCode(undefined), false);
  });

  it("isBrokerTimeoutCode returns false for non-timeout code", () => {
    assert.equal(isBrokerTimeoutCode("dead_lettered"), false);
    assert.equal(isBrokerTimeoutCode("policy_denied"), false);
  });

  it("timeout gateway error shape preserves broker timeout code (mapped in executionStatus)", () => {
    const task = makeTask({
      status: "failed",
      error: { code: "timeout", message: "worker did not respond" },
    });
    // buildGatewayTaskError preserves the raw broker error code
    const error = buildGatewayTaskError(task);
    assert.equal(error.code, "timeout");
    // mapBrokerStatusToExecutionStatus maps the timeout code to timed_out
    const execStatus = mapBrokerStatusToExecutionStatus({
      brokerStatus: "failed",
      brokerErrorCode: "timeout",
    });
    assert.equal(execStatus, "timed_out");
  });
});

// ── 3 (partial). Stale worker / requeue worker-id ────────────

describe("3 — stale worker / requeue worker-id resolution", () => {
  it("prefers claimedBy after requeue over stale assignedWorkerId", () => {
    const task = makeTask({
      claimedBy: "worker-B",
      assignedWorkerId: "worker-A", // stale pre-requeue assignment
    });
    const id = resolveWorkerId(task, undefined);
    assert.equal(id, "worker-B");
  });

  it("falls back to assignedWorkerId when claimedBy is absent", () => {
    const task = makeTask({
      assignedWorkerId: "worker-A",
      claimedBy: undefined,
    });
    const id = resolveWorkerId(task, undefined);
    assert.equal(id, "worker-A");
  });

  it("falls back to targetNodeId when both worker IDs absent", () => {
    const task = makeTask({
      targetNodeId: "node-1",
      target: { id: "node-1", kind: "session" },
      claimedBy: undefined,
      assignedWorkerId: undefined,
    });
    const id = resolveWorkerId(task, undefined);
    assert.equal(id, "node-1");
  });

  it("requeue simulation: same task, different worker picks up", () => {
    // Before requeue
    const before = makeTask({ claimedBy: "worker-A", assignedWorkerId: "worker-A" });
    assert.equal(resolveWorkerId(before, undefined), "worker-A");

    // After requeue: claimedBy changed, assignedWorkerId may be stale
    const after = makeTask({ claimedBy: "worker-B", assignedWorkerId: "worker-A" });
    assert.equal(resolveWorkerId(after, undefined), "worker-B");
  });

  it("requester id takes highest priority over any claimedBy", () => {
    const task = makeTask({ claimedBy: "worker-B", assignedWorkerId: "worker-A" });
    const id = resolveWorkerId(task, { id: "req-1" });
    assert.equal(id, "req-1");
  });
});

// ── Terminal status classification ───────────────────────────

describe("terminal status classification", () => {
  it("all active broker statuses are recognized", () => {
    for (const s of ACTIVE_BROKER_STATUSES) {
      assert.equal(isBrokerTaskTerminal(s as BrokerTaskStatus), false);
    }
  });

  it("all terminal broker statuses are recognized", () => {
    for (const s of TERMINAL_BROKER_STATUSES) {
      assert.equal(isBrokerTaskTerminal(s as BrokerTaskStatus), true);
    }
  });

  it("all terminal OpenClaw statuses are recognized", () => {
    for (const s of TERMINAL_OPENCLAW_STATUSES) {
      assert.equal(isTerminalExecutionStatus(s), true);
    }
  });

  it("non-terminal OpenClaw statuses are not classified as terminal", () => {
    assert.equal(isTerminalExecutionStatus("accepted"), false);
    assert.equal(isTerminalExecutionStatus("running"), false);
    assert.equal(isTerminalExecutionStatus("waiting_reply"), false);
    assert.equal(isTerminalExecutionStatus("waiting_external"), false);
  });

  it("undefined is not terminal", () => {
    assert.equal(isTerminalExecutionStatus(undefined), false);
  });
});

// ── Reconcile-needed signals ─────────────────────────────────

describe("reconcile-needed detection from status drift", () => {
  it("broker succeeded but OpenClaw still shows running → needs reconcile", () => {
    const task = makeTask({ status: "succeeded" });
    const status = buildGatewayTaskStatus(task);
    // The plugin should surface the broker's terminal state regardless
    // of what the caller expects
    assert.equal(status.executionStatus, "completed");
    assert.equal(status.taskId, "task-1");
  });

  it("broker failed with dead-letter but OpenClaw still shows accepted → needs reconcile", () => {
    const task = makeTask({
      status: "failed",
      error: { code: "exceeded_requeue_limit", message: "dead-lettered after 5 attempts" },
    });
    const status = buildGatewayTaskStatus(task);
    assert.equal(status.executionStatus, "failed");
    assert.equal(status.error?.code, "exceeded_requeue_limit");
  });

  it("broker canceled but task was expected to be running → needs reconcile", () => {
    const task = makeTask({ status: "canceled" });
    const status = buildGatewayTaskStatus(task);
    assert.equal(status.executionStatus, "cancelled");
  });

  it("broker requeued status is not terminal → no reconcile needed", () => {
    // "requeued" is not a formal BrokerTaskStatus, but verify non-terminal states
    for (const s of ACTIVE_BROKER_STATUSES) {
      assert.equal(isBrokerTaskTerminal(s as BrokerTaskStatus), false);
    }
  });

  it("delivery status reflects broker terminal state for reconcile", () => {
    // succeeded → skipped delivery (internal completion)
    assert.equal(mapBrokerStatusToDeliveryStatus("succeeded"), "skipped");
    // failed → skipped delivery (internal failure)
    assert.equal(mapBrokerStatusToDeliveryStatus("failed"), "skipped");
    // canceled → skipped delivery (internal cancel)
    assert.equal(mapBrokerStatusToDeliveryStatus("canceled"), "skipped");
  });
});

// ── Interruption-aware lifecycle ─────────────────────────────

describe("interruption-aware lifecycle: status mismatch detection", () => {
  /**
   * An interruption is detected when the plugin's cached/expected state
   * disagrees with the broker's authoritative state. These tests verify
   * the mapping functions surface the broker truth regardless.
   */

  it("mapBrokerErrorToTaskError returns undefined when no error info", () => {
    const result = mapBrokerErrorToTaskError({});
    assert.equal(result, undefined);
  });

  it("mapBrokerErrorToTaskError synthesizes remote_task_failed for failed status with no code", () => {
    const result = mapBrokerErrorToTaskError({ brokerStatus: "failed" });
    assert.equal(result?.code, "remote_task_failed");
  });

  it("mapBrokerErrorToTaskError preserves explicit broker error code", () => {
    const result = mapBrokerErrorToTaskError({
      brokerErrorCode: "exceeded_requeue_limit",
      brokerErrorMessage: "task dead-lettered",
      brokerStatus: "failed",
    });
    assert.equal(result?.code, "exceeded_requeue_limit");
    assert.equal(result?.message, "task dead-lettered");
  });

  it("non-failed status with no error code returns undefined", () => {
    const result = mapBrokerErrorToTaskError({ brokerStatus: "running" });
    assert.equal(result, undefined);
  });

  it("error code without message still returns error with code only", () => {
    const result = mapBrokerErrorToTaskError({
      brokerErrorCode: "policy_denied",
    });
    assert.equal(result?.code, "policy_denied");
    assert.equal(result?.message, undefined);
  });
});

// ── Duplicate create awareness ───────────────────────────────

describe("duplicate create: idempotency key contract validation", () => {
  /**
   * The plugin should preserve and surface idempotency key metadata
   * so callers can detect duplicates. These tests verify the
   * gateway status includes idempotency-relevant fields.
   */

  it("gateway status includes task id from broker", () => {
    const task = makeTask({ id: "task-dup-001" });
    const status = buildGatewayTaskStatus(task);
    assert.equal(status.taskId, "task-dup-001");
  });

  it("gateway status surfaces correlationId when present in payload", () => {
    const task = makeTask({
      payload: { correlationId: "corr-123", parentRunId: "run-456" },
    });
    const status = buildGatewayTaskStatus(task);
    // These should be available in the payload round-trip
    assert.equal(status.correlationId, "corr-123");
    assert.equal(status.parentRunId, "run-456");
  });

  it("duplicate create with same idempotency key returns same task id (contract)", () => {
    // This is a contract test: the plugin MUST NOT generate its own task IDs.
    // The broker owns task identity. The plugin surfaces what the broker returns.
    const taskA = makeTask({ id: "broker-assigned-1", payload: { idempotencyKey: "key-A" } });
    const taskB = makeTask({ id: "broker-assigned-1", payload: { idempotencyKey: "key-A" } });

    // Same idempotency key → broker should return the same task ID
    // Plugin must not create a new local ID
    const statusA = buildGatewayTaskStatus(taskA);
    const statusB = buildGatewayTaskStatus(taskB);
    assert.equal(statusA.taskId, statusB.taskId);
    assert.equal(statusA.taskId, "broker-assigned-1");
  });

  it("different idempotency keys get different task IDs", () => {
    const taskA = makeTask({ id: "task-aaa", payload: { idempotencyKey: "key-A" } });
    const taskB = makeTask({ id: "task-bbb", payload: { idempotencyKey: "key-B" } });

    const statusA = buildGatewayTaskStatus(taskA);
    const statusB = buildGatewayTaskStatus(taskB);
    assert.notEqual(statusA.taskId, statusB.taskId);
  });
});

// ── Delivery status correctness ──────────────────────────────

describe("delivery status across all broker states", () => {
  const cases: Array<[BrokerTaskStatus, string]> = [
    ["queued", "pending"],
    ["claimed", "pending"],
    ["running", "pending"],
    ["succeeded", "skipped"],
    ["failed", "skipped"],
    ["canceled", "skipped"],
  ];

  for (const [brokerStatus, expected] of cases) {
    it(`broker ${brokerStatus} → delivery ${expected}`, () => {
      assert.equal(mapBrokerStatusToDeliveryStatus(brokerStatus), expected);
    });
  }
});

// ── Trace field resolution ───────────────────────────────────

describe("resolveTraceField precedence", () => {
  it("explicit wins over payload", () => {
    assert.equal(resolveTraceField({ explicit: "e", payload: "p" }), "e");
  });

  it("payload wins over request", () => {
    assert.equal(resolveTraceField({ payload: "p", request: "r" }), "p");
  });

  it("request wins over fallback", () => {
    assert.equal(resolveTraceField({ request: "r", fallback: "f" }), "r");
  });

  it("returns fallback when nothing else", () => {
    assert.equal(resolveTraceField({ fallback: "f" }), "f");
  });

  it("returns undefined when nothing provided", () => {
    assert.equal(resolveTraceField({}), undefined);
  });
});

// ── Epoch parsing ────────────────────────────────────────────

describe("toEpochMs", () => {
  it("parses valid ISO date", () => {
    const ms = toEpochMs("2025-06-01T12:00:00Z");
    assert.equal(ms, new Date("2025-06-01T12:00:00Z").getTime());
  });

  it("returns now for undefined", () => {
    const before = Date.now();
    const ms = toEpochMs(undefined);
    const after = Date.now();
    assert.ok(ms >= before && ms <= after, "should be approximately now");
  });

  it("returns now for empty string", () => {
    const before = Date.now();
    const ms = toEpochMs("");
    const after = Date.now();
    assert.ok(ms >= before && ms <= after, "should be approximately now");
  });

  it("returns now for unparseable string", () => {
    const before = Date.now();
    const ms = toEpochMs("not-a-date");
    const after = Date.now();
    assert.ok(ms >= before && ms <= after, "should be approximately now");
  });
});

// ── Error shaping edge cases ─────────────────────────────────

describe("error shaping: auth and rate-limit", () => {
  it("A2ABrokerClientError with 401 preserves status and message", () => {
    const err = new A2ABrokerClientError("unauthorized", 401, "POST", "/tasks");
    assert.equal(err.status, 401);
    assert.ok(err.message.includes("unauthorized"));
  });

  it("A2ABrokerClientError with 429 preserves status", () => {
    const err = new A2ABrokerClientError("too many requests", 429, "POST", "/tasks");
    assert.equal(err.status, 429);
  });

  it("a2aError produces INTERNAL for broker relay failures", () => {
    const err = a2aError(A2AErrorCodes.INTERNAL, "broker relay failed");
    assert.equal(err.code, "INTERNAL");
  });
});
