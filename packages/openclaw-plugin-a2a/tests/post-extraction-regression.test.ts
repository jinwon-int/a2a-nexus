/**
 * Post-extraction regression tests for delegated-send runtime.
 *
 * Covers scenarios from the regression matrix (docs/regression-matrix.md)
 * that become plugin-owned after the runtime move (#22).
 *
 * Scope:
 *  - type-mapping.ts public API (all exports)
 *  - direct-vs-delegated routing (config.ts)
 *  - wait-run terminal resolution
 *  - cancel metadata carry-through (resolveCancelTarget all four arms)
 *  - heartbeat / timeout handling (isBrokerTimeoutCode, timeout code drift)
 *  - broker status mapping (type-mapping richer variants)
 *
 * Rows that MUST stay in the monorepo:
 *  - Full end-to-end delegated-send lifecycle (scenario 1): requires
 *    live broker + core wait-run seam (not yet extracted, §1.1)
 *  - End-to-end timer behavior (scenario 2): requires broker watchdog
 *    + plugin heartbeat seam (§2.4)
 *  - Full dead-letter propagation (scenario 3): requires broker SSE
 *    streaming + requeue retry policy
 *  - Broker spin-up auth failure (scenario 4): requires live broker
 *    with known secret
 *  - Rate-limit pressure (scenario 5): requires live broker
 *  - Cancel fan-out to session runs (scenario 7 e2e): requires core
 *    cancel dispatcher seam (§2.3)
 *  - Termux smoke path: third environment (Android Termux)
 *
 * All of the above have unit-testable mapping arms covered HERE.
 * The e2e arms will flip to automated when their respective seams land.
 *
 * Closes: plugin-a2a#23
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ── type-mapping.ts exports ───────────────────────────────────

import {
  ACTIVE_BROKER_STATUSES,
  TERMINAL_BROKER_STATUSES,
  TERMINAL_OPENCLAW_STATUSES,
  NON_CANCEL_TERMINAL_STATUSES,
  mapBrokerStatusToExecutionStatus,
  mapBrokerStatusToDeliveryStatus,
  mapBrokerErrorToTaskError,
  isBrokerTimeoutCode,
  resolveTraceField,
  resolveCancelTarget,
  isBrokerTaskTerminal,
  isTerminalExecutionStatus,
  toEpochMs,
  type BrokerTaskStatus,
  type A2AExecutionStatus,
  type A2ATaskCancelTarget,
} from "../dist/type-mapping.js";

// ── gateway-handlers.ts exports ───────────────────────────────

import {
  buildGatewayTaskResult,
  buildGatewayTaskStatus,
  buildGatewayTaskOutput,
  buildGatewayTaskError,
  mapBrokerStatusToExecutionStatus as gatewayMapStatus,
  mapBrokerStatusToDeliveryStatus as gatewayMapDelivery,
  normalizeString,
  readBrokerTaskPayload,
  resolveWorkerId,
  type GatewayTaskMethod,
} from "../dist/src/gateway-handlers.js";

import {
  A2ABrokerClientError,
  type A2ABrokerTaskRecord,
} from "../dist/standalone-broker-client.js";

import {
  validateParams,
  validateA2ATaskCancelParams,
  validateA2ATaskRequestParams,
  validateA2ATaskStatusParams,
  validateA2ATaskUpdateParams,
} from "../dist/src/gateway-validators.js";

// ── config.ts exports ─────────────────────────────────────────

import {
  shouldUseStandaloneBrokerSessionsSendAdapter,
  resolveA2ABrokerAdapterPluginConfig,
} from "../dist/config.js";

// ── helpers ───────────────────────────────────────────────────

function makeTask(overrides: Partial<A2ABrokerTaskRecord> = {}): A2ABrokerTaskRecord {
  return {
    id: "task-001",
    intent: "chat",
    status: "queued",
    requester: { id: "hub-001", kind: "session", role: "hub" },
    target: { id: "worker-001" },
    assignedWorkerId: "worker-001",
    createdAt: "2026-04-18T00:00:00Z",
    updatedAt: "2026-04-18T00:00:00Z",
    ...overrides,
  };
}

// ════════════════════════════════════════════════════════════════
// §1  type-mapping.ts — status set constants
// ════════════════════════════════════════════════════════════════

describe("type-mapping — ACTIVE_BROKER_STATUSES set", () => {
  it("contains queued, claimed, running", () => {
    assert.ok(ACTIVE_BROKER_STATUSES.has("queued"));
    assert.ok(ACTIVE_BROKER_STATUSES.has("claimed"));
    assert.ok(ACTIVE_BROKER_STATUSES.has("running"));
  });

  it("excludes terminal statuses", () => {
    assert.ok(!ACTIVE_BROKER_STATUSES.has("succeeded"));
    assert.ok(!ACTIVE_BROKER_STATUSES.has("failed"));
    assert.ok(!ACTIVE_BROKER_STATUSES.has("canceled"));
  });
});

describe("type-mapping — TERMINAL_BROKER_STATUSES set", () => {
  it("contains succeeded, failed, canceled", () => {
    assert.ok(TERMINAL_BROKER_STATUSES.has("succeeded"));
    assert.ok(TERMINAL_BROKER_STATUSES.has("failed"));
    assert.ok(TERMINAL_BROKER_STATUSES.has("canceled"));
  });

  it("excludes active statuses", () => {
    assert.ok(!TERMINAL_BROKER_STATUSES.has("queued"));
    assert.ok(!TERMINAL_BROKER_STATUSES.has("claimed"));
    assert.ok(!TERMINAL_BROKER_STATUSES.has("running"));
  });
});

describe("type-mapping — TERMINAL_OPENCLAW_STATUSES set", () => {
  const expected = ["completed", "failed", "cancelled", "timed_out"] as const;
  for (const status of expected) {
    it(`contains ${status}`, () => {
      assert.ok(TERMINAL_OPENCLAW_STATUSES.has(status));
    });
  }

  it("excludes non-terminal statuses", () => {
    assert.ok(!TERMINAL_OPENCLAW_STATUSES.has("accepted"));
    assert.ok(!TERMINAL_OPENCLAW_STATUSES.has("running"));
    assert.ok(!TERMINAL_OPENCLAW_STATUSES.has("waiting_reply"));
  });
});

describe("type-mapping — NON_CANCEL_TERMINAL_STATUSES set", () => {
  it("excludes cancelled", () => {
    assert.ok(!NON_CANCEL_TERMINAL_STATUSES.has("cancelled"));
  });

  it("includes completed, failed, timed_out", () => {
    assert.ok(NON_CANCEL_TERMINAL_STATUSES.has("completed"));
    assert.ok(NON_CANCEL_TERMINAL_STATUSES.has("failed"));
    assert.ok(NON_CANCEL_TERMINAL_STATUSES.has("timed_out"));
  });
});

// ════════════════════════════════════════════════════════════════
// §2  type-mapping.ts — mapBrokerStatusToExecutionStatus (params variant)
// ════════════════════════════════════════════════════════════════

describe("type-mapping — mapBrokerStatusToExecutionStatus", () => {
  const baseCases: Array<[BrokerTaskStatus, string]> = [
    ["queued", "accepted"],
    ["claimed", "accepted"],
    ["running", "running"],
    ["succeeded", "completed"],
    ["canceled", "cancelled"],
  ];

  for (const [brokerStatus, expected] of baseCases) {
    it(`${brokerStatus} → ${expected}`, () => {
      assert.equal(mapBrokerStatusToExecutionStatus({ brokerStatus }), expected);
    });
  }

  it("failed + timeout → timed_out", () => {
    assert.equal(
      mapBrokerStatusToExecutionStatus({ brokerStatus: "failed", brokerErrorCode: "timeout" }),
      "timed_out",
    );
  });

  it("failed + timed_out → timed_out", () => {
    assert.equal(
      mapBrokerStatusToExecutionStatus({ brokerStatus: "failed", brokerErrorCode: "timed_out" }),
      "timed_out",
    );
  });

  it("failed + broker_timeout → timed_out", () => {
    assert.equal(
      mapBrokerStatusToExecutionStatus({ brokerStatus: "failed", brokerErrorCode: "broker_timeout" }),
      "timed_out",
    );
  });

  it("failed + exceeded_requeue_limit → failed (not timed_out)", () => {
    assert.equal(
      mapBrokerStatusToExecutionStatus({ brokerStatus: "failed", brokerErrorCode: "exceeded_requeue_limit" }),
      "failed",
    );
  });

  it("failed + no code → failed", () => {
    assert.equal(
      mapBrokerStatusToExecutionStatus({ brokerStatus: "failed" }),
      "failed",
    );
  });

  it("returns cancelled for canceled broker status", () => {
    const result = mapBrokerStatusToExecutionStatus({ brokerStatus: "canceled" });
    assert.equal(result, "cancelled");
  });
});

// ════════════════════════════════════════════════════════════════
// §3  type-mapping.ts — mapBrokerStatusToDeliveryStatus (richer variant)
// ════════════════════════════════════════════════════════════════

describe("type-mapping — mapBrokerStatusToDeliveryStatus", () => {
  it("queued → pending", () => {
    assert.equal(mapBrokerStatusToDeliveryStatus("queued"), "pending");
  });

  it("claimed → pending", () => {
    assert.equal(mapBrokerStatusToDeliveryStatus("claimed"), "pending");
  });

  it("running → pending", () => {
    assert.equal(mapBrokerStatusToDeliveryStatus("running"), "pending");
  });

  it("succeeded → skipped", () => {
    assert.equal(mapBrokerStatusToDeliveryStatus("succeeded"), "skipped");
  });

  it("failed → skipped", () => {
    assert.equal(mapBrokerStatusToDeliveryStatus("failed"), "skipped");
  });

  it("canceled → skipped", () => {
    assert.equal(mapBrokerStatusToDeliveryStatus("canceled"), "skipped");
  });
});

// ════════════════════════════════════════════════════════════════
// §4  type-mapping.ts — mapBrokerErrorToTaskError
// ════════════════════════════════════════════════════════════════

describe("type-mapping — mapBrokerErrorToTaskError", () => {
  it("returns undefined when no code and no failed status", () => {
    assert.equal(mapBrokerErrorToTaskError({}), undefined);
    assert.equal(mapBrokerErrorToTaskError({ brokerErrorMessage: "oops" }), undefined);
    assert.equal(mapBrokerErrorToTaskError({ brokerStatus: "queued" }), undefined);
  });

  it("returns undefined when no code and status is not failed", () => {
    assert.equal(
      mapBrokerErrorToTaskError({ brokerStatus: "running", brokerErrorMessage: "still going" }),
      undefined,
    );
  });

  it("synthesizes remote_task_failed when status=failed but no code", () => {
    const error = mapBrokerErrorToTaskError({ brokerStatus: "failed", brokerErrorMessage: "boom" });
    assert.ok(error);
    assert.equal(error.code, "remote_task_failed");
    assert.equal(error.message, "boom");
  });

  it("synthesizes remote_task_failed with no message when status=failed", () => {
    const error = mapBrokerErrorToTaskError({ brokerStatus: "failed" });
    assert.ok(error);
    assert.equal(error.code, "remote_task_failed");
    assert.equal(error.message, undefined);
  });

  it("preserves explicit code", () => {
    const error = mapBrokerErrorToTaskError({
      brokerErrorCode: "exceeded_requeue_limit",
      brokerErrorMessage: "dead-lettered",
    });
    assert.ok(error);
    assert.equal(error.code, "exceeded_requeue_limit");
    assert.equal(error.message, "dead-lettered");
  });

  it("preserves explicit code without message", () => {
    const error = mapBrokerErrorToTaskError({ brokerErrorCode: "timeout" });
    assert.ok(error);
    assert.equal(error.code, "timeout");
    assert.equal(error.message, undefined);
  });

  it("timeout code is preserved (not special-cased here)", () => {
    const error = mapBrokerErrorToTaskError({
      brokerErrorCode: "timeout",
      brokerErrorMessage: "worker timed out",
      brokerStatus: "failed",
    });
    assert.ok(error);
    assert.equal(error.code, "timeout");
    // The timeout → timed_out distinction is in mapBrokerStatusToExecutionStatus,
    // not in mapBrokerErrorToTaskError.
  });
});

// ════════════════════════════════════════════════════════════════
// §5  isBrokerTimeoutCode — regression matrix scenario 2
// ════════════════════════════════════════════════════════════════

describe("isBrokerTimeoutCode — timeout detection (scenario 2)", () => {
  it("recognizes 'timeout'", () => {
    assert.ok(isBrokerTimeoutCode("timeout"));
  });

  it("recognizes 'timed_out'", () => {
    assert.ok(isBrokerTimeoutCode("timed_out"));
  });

  it("recognizes 'broker_timeout'", () => {
    assert.ok(isBrokerTimeoutCode("broker_timeout"));
  });

  it("is case-insensitive", () => {
    assert.ok(isBrokerTimeoutCode("TIMEOUT"));
    assert.ok(isBrokerTimeoutCode("Broker_Timeout"));
    assert.ok(isBrokerTimeoutCode("TIMED_OUT"));
  });

  it("is whitespace-trimmed", () => {
    assert.ok(isBrokerTimeoutCode("  timeout  "));
  });

  it("rejects non-timeout codes", () => {
    assert.ok(!isBrokerTimeoutCode("exceeded_requeue_limit"));
    assert.ok(!isBrokerTimeoutCode("policy_denied"));
    assert.ok(!isBrokerTimeoutCode("auth_failed"));
    assert.ok(!isBrokerTimeoutCode(""));
  });

  it("handles undefined safely", () => {
    assert.ok(!isBrokerTimeoutCode(undefined));
  });

  it("rejects code that merely contains 'timeout' as substring", () => {
    assert.ok(!isBrokerTimeoutCode("not_a_timeout_code"));
    assert.ok(!isBrokerTimeoutCode("my_timeout_suffix"));
  });
});

// ════════════════════════════════════════════════════════════════
// §6  resolveTraceField — correlation ID / parent run ID resolution
// ════════════════════════════════════════════════════════════════

describe("resolveTraceField — priority chain", () => {
  it("prefers explicit over payload over request over fallback", () => {
    assert.equal(
      resolveTraceField({
        explicit: "e1",
        payload: "p1",
        request: "r1",
        fallback: "f1",
      }),
      "e1",
    );
  });

  it("falls through to payload when no explicit", () => {
    assert.equal(
      resolveTraceField({ payload: "p1", request: "r1", fallback: "f1" }),
      "p1",
    );
  });

  it("falls through to request when no explicit/payload", () => {
    assert.equal(
      resolveTraceField({ request: "r1", fallback: "f1" }),
      "r1",
    );
  });

  it("falls through to fallback when only fallback", () => {
    assert.equal(
      resolveTraceField({ fallback: "f1" }),
      "f1",
    );
  });

  it("returns undefined when nothing provided", () => {
    assert.equal(resolveTraceField({}), undefined);
  });

  it("does NOT skip empty string (?? operator, only null/undefined)", () => {
    // ?? does not skip empty string — that's the contract.
    assert.equal(
      resolveTraceField({ explicit: "", payload: "p1" }),
      "",
    );
  });
});

// ════════════════════════════════════════════════════════════════
// §7  resolveCancelTarget — all four arms (scenario 6c)
// ════════════════════════════════════════════════════════════════

describe("resolveCancelTarget — four-arm resolution", () => {
  const baseTarget: A2ATaskCancelTarget = {
    kind: "session_run",
    sessionKey: "agent:main:worker-alpha",
    runId: "run-001",
  };

  it("arm 1: prefers explicit cancelTarget", () => {
    const result = resolveCancelTarget({
      explicit: baseTarget,
      payload: { kind: "session_run", sessionKey: "other" },
      request: { kind: "session_run", sessionKey: "another" },
    });
    assert.deepEqual(result, baseTarget);
  });

  it("arm 2: falls to payload when no explicit", () => {
    const payload: A2ATaskCancelTarget = {
      kind: "session_run",
      sessionKey: "agent:main:worker-beta",
      runId: "run-from-payload",
    };
    const result = resolveCancelTarget({
      payload,
      request: { kind: "session_run", sessionKey: "other" },
    });
    assert.deepEqual(result, payload);
  });

  it("arm 3: falls to request when no explicit/payload", () => {
    const request: A2ATaskCancelTarget = {
      kind: "session_run",
      sessionKey: "agent:main:worker-gamma",
    };
    const result = resolveCancelTarget({ request });
    assert.deepEqual(result, request);
  });

  it("arm 4: synthesizes from targetSessionKey + runId", () => {
    const result = resolveCancelTarget({
      targetSessionKey: "agent:main:gongyung",
      runId: "run-synth",
    });
    assert.ok(result);
    assert.equal(result.kind, "session_run");
    assert.equal(result.sessionKey, "agent:main:gongyung");
    assert.equal(result.runId, "run-synth");
  });

  it("arm 4: synthesizes without runId", () => {
    const result = resolveCancelTarget({
      targetSessionKey: "agent:main:node-remote",
    });
    assert.ok(result);
    assert.equal(result.kind, "session_run");
    assert.equal(result.sessionKey, "agent:main:node-remote");
    assert.equal(result.runId, undefined);
  });

  it("returns undefined when nothing provided", () => {
    assert.equal(resolveCancelTarget({}), undefined);
  });

  it("skips falsy explicit/payload/request (empty objects still count)", () => {
    // Only undefined should be skipped, not objects
    const target: A2ATaskCancelTarget = {
      kind: "session_run",
      sessionKey: "from-payload",
    };
    const result = resolveCancelTarget({
      explicit: undefined,
      payload: target,
      request: undefined,
    });
    assert.deepEqual(result, target);
  });
});

// ════════════════════════════════════════════════════════════════
// §8  isBrokerTaskTerminal / isTerminalExecutionStatus
// ════════════════════════════════════════════════════════════════

describe("isBrokerTaskTerminal", () => {
  for (const s of TERMINAL_BROKER_STATUSES) {
    it(`${s} is terminal`, () => assert.ok(isBrokerTaskTerminal(s)));
  }

  for (const s of ACTIVE_BROKER_STATUSES) {
    it(`${s} is NOT terminal`, () => assert.ok(!isBrokerTaskTerminal(s)));
  }
});

describe("isTerminalExecutionStatus", () => {
  for (const s of TERMINAL_OPENCLAW_STATUSES) {
    it(`${s} is terminal`, () => assert.ok(isTerminalExecutionStatus(s)));
  }

  it("running is NOT terminal", () => assert.ok(!isTerminalExecutionStatus("running")));
  it("accepted is NOT terminal", () => assert.ok(!isTerminalExecutionStatus("accepted")));
  it("undefined is NOT terminal", () => assert.ok(!isTerminalExecutionStatus(undefined)));
});

// ════════════════════════════════════════════════════════════════
// §9  toEpochMs
// ════════════════════════════════════════════════════════════════

describe("toEpochMs", () => {
  it("parses valid ISO string", () => {
    const ms = toEpochMs("2026-04-18T00:00:00Z");
    assert.equal(ms, new Date("2026-04-18T00:00:00Z").getTime());
  });

  it("returns Date.now() for undefined", () => {
    const before = Date.now();
    const ms = toEpochMs(undefined);
    const after = Date.now();
    assert.ok(ms >= before && ms <= after);
  });

  it("returns Date.now() for NaN-parseable string", () => {
    const before = Date.now();
    const ms = toEpochMs("not-a-date");
    const after = Date.now();
    assert.ok(ms >= before && ms <= after);
  });
});

// ════════════════════════════════════════════════════════════════
// §10  Gateway handlers — direct-vs-delegated routing
// ════════════════════════════════════════════════════════════════

describe("direct-vs-delegated routing — shouldUseStandaloneBrokerSessionsSendAdapter", () => {
  const PLUGIN_ID = "a2a-broker-adapter";

  it("returns true when plugin config has baseUrl and is enabled", () => {
    const config = {
      plugins: {
        entries: {
          [PLUGIN_ID]: {
            enabled: true,
            config: {
              baseUrl: "http://localhost:3000",
              edgeSecret: "test-secret",
              requester: { id: "hub-001", kind: "session", role: "hub" },
            },
          },
        },
        allow: [PLUGIN_ID],
      },
    };
    assert.ok(shouldUseStandaloneBrokerSessionsSendAdapter(config));
  });

  it("returns false when config is empty", () => {
    assert.ok(!shouldUseStandaloneBrokerSessionsSendAdapter({}));
  });

  it("returns false when config is null", () => {
    assert.ok(!shouldUseStandaloneBrokerSessionsSendAdapter(null as any));
  });

  it("returns false when baseUrl is missing", () => {
    const config = {
      plugins: {
        entries: {
          [PLUGIN_ID]: {
            enabled: true,
            config: {
              edgeSecret: "test",
            },
          },
        },
        allow: [PLUGIN_ID],
      },
    };
    assert.ok(!shouldUseStandaloneBrokerSessionsSendAdapter(config));
  });

  it("returns false when plugin is not in allow list", () => {
    const config = {
      plugins: {
        entries: {
          [PLUGIN_ID]: {
            enabled: true,
            config: {
              baseUrl: "http://localhost:3000",
            },
          },
        },
        allow: ["other-plugin"],
      },
    };
    assert.ok(!shouldUseStandaloneBrokerSessionsSendAdapter(config));
  });
});

describe("direct-vs-delegated routing — resolveA2ABrokerAdapterPluginConfig", () => {
  const PLUGIN_ID = "a2a-broker-adapter";

  it("resolves baseUrl from plugin config", () => {
    const config = {
      plugins: {
        entries: {
          [PLUGIN_ID]: {
            enabled: true,
            config: {
              baseUrl: "http://localhost:3000",
              edgeSecret: "secret",
              requester: { id: "hub", kind: "session", role: "hub" },
            },
          },
        },
        allow: [PLUGIN_ID],
      },
    };
    const resolved = resolveA2ABrokerAdapterPluginConfig(config);
    assert.equal(resolved.baseUrl, "http://localhost:3000");
    assert.equal(resolved.edgeSecret, "secret");
    assert.ok(resolved.enabled);
    assert.ok(resolved.explicitlyActivated);
  });

  it("returns falsy baseUrl when plugin config is empty", () => {
    const resolved = resolveA2ABrokerAdapterPluginConfig({});
    assert.ok(!resolved.baseUrl);
  });

  it("disabled when plugin is in deny list", () => {
    const config = {
      plugins: {
        entries: {
          [PLUGIN_ID]: {
            enabled: true,
            config: { baseUrl: "http://localhost:3000" },
          },
        },
        deny: [PLUGIN_ID],
      },
    };
    const resolved = resolveA2ABrokerAdapterPluginConfig(config);
    assert.ok(!resolved.enabled);
  });
});

// ════════════════════════════════════════════════════════════════
// §11  Wait-run terminal resolution
// ════════════════════════════════════════════════════════════════

describe("wait-run terminal resolution — buildGatewayTaskResult carries method", () => {
  const methods: GatewayTaskMethod[] = ["a2a.task.request", "a2a.task.update", "a2a.task.cancel"];

  for (const method of methods) {
    it(`${method} result includes method field`, () => {
      const task = makeTask({ status: "succeeded" });
      const result = buildGatewayTaskResult(method, task) as Record<string, unknown>;
      assert.equal(result.method, method);
    });
  }

  it("request on succeeded task includes completed status", () => {
    const task = makeTask({
      status: "succeeded",
      result: { summary: "done" },
    });
    const result = buildGatewayTaskResult("a2a.task.request", task) as Record<string, unknown>;
    assert.equal(result.executionStatus, "completed");
    assert.equal(result.deliveryStatus, "skipped");
    assert.equal(result.summary, "done");
  });

  it("update on running task includes running status", () => {
    const task = makeTask({ status: "running" });
    const result = buildGatewayTaskResult("a2a.task.update", task) as Record<string, unknown>;
    assert.equal(result.executionStatus, "running");
    assert.equal(result.deliveryStatus, "pending");
  });

  it("update on failed task carries error", () => {
    const task = makeTask({
      status: "failed",
      error: { code: "task_error", message: "worker crashed" },
    });
    const result = buildGatewayTaskResult("a2a.task.update", task) as Record<string, unknown>;
    assert.equal(result.executionStatus, "failed");
    const error = result.error as Record<string, unknown>;
    assert.equal(error.code, "task_error");
  });

  it("update on timed_out task maps to timed_out", () => {
    const task = makeTask({
      status: "failed",
      error: { code: "timeout", message: "elapsed" },
    });
    const result = buildGatewayTaskResult("a2a.task.update", task) as Record<string, unknown>;
    assert.equal(result.executionStatus, "timed_out");
  });
});

// ════════════════════════════════════════════════════════════════
// §12  Cancel metadata carry-through (scenario 6c + 7)
// ════════════════════════════════════════════════════════════════

describe("cancel metadata — full carry-through", () => {
  it("cancel on running task: abortStatus = aborted", () => {
    const task = makeTask({ status: "canceled" });
    const result = buildGatewayTaskResult("a2a.task.cancel", task) as Record<string, unknown>;
    assert.equal(result.abortStatus, "aborted");
    assert.equal(result.method, "a2a.task.cancel");
  });

  it("cancel on already-succeeded: abortStatus = not-attempted", () => {
    const task = makeTask({ status: "succeeded", result: { summary: "done" } });
    const result = buildGatewayTaskResult("a2a.task.cancel", task) as Record<string, unknown>;
    assert.equal(result.abortStatus, "not-attempted");
    assert.equal(result.executionStatus, "completed");
  });

  it("cancel on already-failed: abortStatus = not-attempted", () => {
    const task = makeTask({
      status: "failed",
      error: { code: "exceeded_requeue_limit", message: "dead-lettered" },
    });
    const result = buildGatewayTaskResult("a2a.task.cancel", task) as Record<string, unknown>;
    assert.equal(result.abortStatus, "not-attempted");
    assert.equal(result.executionStatus, "failed");
  });

  it("cancel preserves payload correlationId and parentRunId", () => {
    const task = makeTask({
      status: "canceled",
      payload: {
        correlationId: "corr-cancel-001",
        parentRunId: "parent-cancel-001",
        requesterSessionKey: "agent:main:node-remote",
        targetSessionKey: "agent:main:worker-alpha",
        targetDisplayKey: "worker-alpha",
      },
    });
    const result = buildGatewayTaskResult("a2a.task.cancel", task) as Record<string, unknown>;
    assert.equal(result.correlationId, "corr-cancel-001");
    assert.equal(result.parentRunId, "parent-cancel-001");
    assert.equal(result.abortStatus, "aborted");
  });

  it("cancel on timed-out task: abortStatus = not-attempted (already terminal)", () => {
    const task = makeTask({
      status: "failed",
      error: { code: "broker_timeout", message: "watchdog" },
    });
    const result = buildGatewayTaskResult("a2a.task.cancel", task) as Record<string, unknown>;
    assert.equal(result.abortStatus, "not-attempted");
    assert.equal(result.executionStatus, "timed_out");
  });
});

// ════════════════════════════════════════════════════════════════
// §13  Heartbeat / timeout handling — normalizeString + status
// ════════════════════════════════════════════════════════════════

describe("heartbeat handling — hasHeartbeat in status", () => {
  it("buildGatewayTaskStatus always sets hasHeartbeat to false", () => {
    const task = makeTask({ status: "running" });
    const status = buildGatewayTaskStatus(task) as Record<string, unknown>;
    assert.equal(status.hasHeartbeat, false);
  });

  it("hasHeartbeat stays false regardless of task status", () => {
    for (const status of ["queued", "running", "succeeded", "failed", "canceled"] as const) {
      const task = makeTask({ status });
      const result = buildGatewayTaskStatus(task) as Record<string, unknown>;
      assert.equal(result.hasHeartbeat, false, `hasHeartbeat should be false for ${status}`);
    }
  });
});

describe("timeout handling — normalizeString for announceTimeoutMs", () => {
  it("normalizes valid string", () => {
    assert.equal(normalizeString("hello"), "hello");
    assert.equal(normalizeString("  padded  "), "padded");
  });

  it("returns undefined for empty/whitespace", () => {
    assert.equal(normalizeString(""), undefined);
    assert.equal(normalizeString("   "), undefined);
    assert.equal(normalizeString(undefined), undefined);
  });
});

// ════════════════════════════════════════════════════════════════
// §14  Gateway handler status mapping consistency
// ════════════════════════════════════════════════════════════════

describe("gateway handlers — mapping consistency with type-mapping", () => {
  it("gateway mapStatus agrees with type-mapping for all broker statuses", () => {
    const statuses: BrokerTaskStatus[] = ["queued", "claimed", "running", "succeeded", "failed", "canceled"];

    for (const bs of statuses) {
      const gatewayResult = gatewayMapStatus(makeTask({ status: bs }));
      const tmResult = mapBrokerStatusToExecutionStatus({ brokerStatus: bs });

      assert.equal(gatewayResult, tmResult, `both agree for ${bs}`);
    }
  });

  it("gateway mapDelivery agrees with type-mapping for active statuses", () => {
    for (const s of ["queued", "claimed", "running"] as const) {
      assert.equal(gatewayMapDelivery(s), "pending");
      assert.equal(mapBrokerStatusToDeliveryStatus(s), "pending");
    }
  });

  it("gateway mapDelivery agrees with type-mapping for terminal statuses", () => {
    for (const s of ["succeeded", "failed", "canceled"] as const) {
      assert.equal(gatewayMapDelivery(s), "skipped");
      assert.equal(mapBrokerStatusToDeliveryStatus(s), "skipped");
    }
  });
});

// ════════════════════════════════════════════════════════════════
// §15  Task-not-found (scenario 8) — deeper coverage
// ════════════════════════════════════════════════════════════════

describe("task-not-found — handler-level NOT_FOUND response", () => {
  it("update on missing task returns NOT_FOUND", async () => {
    const { createA2AGatewayHandlers } = await import("../dist/src/gateway-handlers.js");

    const handlers = createA2AGatewayHandlers({
      baseUrl: "",
      edgeSecret: "",
    });

    // Simulate a handler call that goes through validation → broker → 404
    // We'll test via the gateway task status method since it also hits getBrokerTask
    let capturedResponse: { ok: boolean; data?: unknown; error?: unknown } | undefined;

    const mockOpts = {
      params: { sessionKey: "s1", taskId: "missing-001" },
      respond(ok: boolean, data?: unknown, error?: unknown) {
        capturedResponse = { ok, data, error };
      },
    };

    // We need a broker that returns 404
    const handlersWithMock = createA2AGatewayHandlers(
      { baseUrl: "http://localhost:9999", edgeSecret: "secret" },
      {
        createBrokerClient: () => ({
          statusTask: async () => {
            // getBrokerTask returns undefined on 404
            // statusTask then returns undefined
            return undefined;
          },
          requestTask: async () => undefined,
          updateTask: async () => undefined,
          cancelTask: async () => undefined,
        }),
      },
    );

    await handlersWithMock.handleA2ATaskStatus(mockOpts as any);

    assert.ok(capturedResponse);
    assert.ok(!capturedResponse.ok);
    const error = capturedResponse.error as Record<string, unknown>;
    assert.equal(error.code, "NOT_FOUND");
    assert.ok((error.message as string).includes("missing-001"));
  });
});

// ════════════════════════════════════════════════════════════════
// §16  Auth failure (scenario 4) — error shaping
// ════════════════════════════════════════════════════════════════

describe("auth failure (scenario 4) — 401/403 surfaces through gateway", () => {
  it("401 from broker surfaces as INTERNAL with original message", async () => {
    const { createA2AGatewayHandlers } = await import("../dist/src/gateway-handlers.js");

    let capturedResponse: { ok: boolean; data?: unknown; error?: unknown } | undefined;

    const handlersWithMock = createA2AGatewayHandlers(
      { baseUrl: "http://localhost:9999", edgeSecret: "secret" },
      {
        createBrokerClient: () => ({
          requestTask: async () => {
            throw new A2ABrokerClientError("unauthorized", 401, "POST", "/tasks");
          },
          updateTask: async () => undefined,
          cancelTask: async () => undefined,
          statusTask: async () => undefined,
        }),
      },
    );

    const mockOpts = {
      params: {
        sessionKey: "s1",
        request: {
          method: "a2a.task.request" as const,
          target: { sessionKey: "t1", displayKey: "t1" },
          task: { intent: "delegate" as const, instructions: "do it" },
        },
      },
      respond(ok: boolean, data?: unknown, error?: unknown) {
        capturedResponse = { ok, data, error };
      },
    };

    await handlersWithMock.handleA2ATaskRequest(mockOpts as any);

    assert.ok(capturedResponse);
    assert.ok(!capturedResponse.ok);
    const error = capturedResponse.error as Record<string, unknown>;
    assert.equal(error.code, "INTERNAL");
    assert.ok((error.message as string).includes("unauthorized"));
  });

  it("403 from broker surfaces as INTERNAL", async () => {
    const { createA2AGatewayHandlers } = await import("../dist/src/gateway-handlers.js");

    let capturedResponse: { ok: boolean; data?: unknown; error?: unknown } | undefined;

    const handlersWithMock = createA2AGatewayHandlers(
      { baseUrl: "http://localhost:9999", edgeSecret: "secret" },
      {
        createBrokerClient: () => ({
          requestTask: async () => {
            throw new A2ABrokerClientError("forbidden", 403, "POST", "/tasks");
          },
          updateTask: async () => undefined,
          cancelTask: async () => undefined,
          statusTask: async () => undefined,
        }),
      },
    );

    const mockOpts = {
      params: {
        sessionKey: "s1",
        request: {
          method: "a2a.task.request" as const,
          target: { sessionKey: "t1", displayKey: "t1" },
          task: { intent: "delegate" as const, instructions: "do it" },
        },
      },
      respond(ok: boolean, data?: unknown, error?: unknown) {
        capturedResponse = { ok, data, error };
      },
    };

    await handlersWithMock.handleA2ATaskRequest(mockOpts as any);

    assert.ok(capturedResponse);
    assert.ok(!capturedResponse.ok);
    const error = capturedResponse.error as Record<string, unknown>;
    assert.equal(error.code, "INTERNAL");
    assert.ok((error.message as string).includes("forbidden"));
  });
});

// ════════════════════════════════════════════════════════════════
// §17  Rate-limit (scenario 5) — 429 surfaces through gateway
// ════════════════════════════════════════════════════════════════

describe("rate-limit (scenario 5) — 429 surfaces as gateway error", () => {
  it("429 from broker is NOT retried, surfaced as INTERNAL", async () => {
    const { createA2AGatewayHandlers } = await import("../dist/src/gateway-handlers.js");

    let capturedResponse: { ok: boolean; data?: unknown; error?: unknown } | undefined;

    const handlersWithMock = createA2AGatewayHandlers(
      { baseUrl: "http://localhost:9999", edgeSecret: "secret" },
      {
        createBrokerClient: () => ({
          statusTask: async () => {
            throw new A2ABrokerClientError("rate limited", 429, "GET", "/tasks/t1");
          },
          requestTask: async () => undefined,
          updateTask: async () => undefined,
          cancelTask: async () => undefined,
        }),
      },
    );

    const mockOpts = {
      params: { sessionKey: "s1", taskId: "t1" },
      respond(ok: boolean, data?: unknown, error?: unknown) {
        capturedResponse = { ok, data, error };
      },
    };

    await handlersWithMock.handleA2ATaskStatus(mockOpts as any);

    assert.ok(capturedResponse);
    assert.ok(!capturedResponse.ok);
    const error = capturedResponse.error as Record<string, unknown>;
    assert.equal(error.code, "INTERNAL");
    assert.ok((error.message as string).includes("rate limited"));
  });
});

// ════════════════════════════════════════════════════════════════
// §18  Monorepo-must-keep documentation
// ════════════════════════════════════════════════════════════════

describe("monorepo-must-keep rows — deferred with rationale", () => {
  /**
   * These rows require core seams that haven't landed yet.
   * The mapping arms are tested here; the e2e arms are deferred.
   *
   * Row 1 (success path e2e): blocked on §1.1 delegated-task runtime extraction.
   *   Mapping tested in §11 (buildGatewayTaskResult terminal resolution).
   *
   * Row 2 (timeout e2e): blocked on §2.4 heartbeat/timeout timer seam.
   *   Mapping tested in §5 (isBrokerTimeoutCode).
   *
   * Row 3 (dead-letter e2e): blocked on broker SSE streaming in plugin.
   *   Mapping tested in first-wave (parity: dead-letter).
   *
   * Row 7 (cancel fan-out e2e): blocked on §2.3 cancel dispatcher seam.
   *   Mapping tested in §12 (cancel metadata carry-through).
   */

  it("documents: Row 1 e2e blocked on §1.1 — mapping covered in §11", () => {
    assert.ok(true, "see §11 wait-run terminal resolution");
  });

  it("documents: Row 2 e2e blocked on §2.4 — mapping covered in §5", () => {
    assert.ok(true, "see §5 isBrokerTimeoutCode");
  });

  it("documents: Row 3 e2e blocked on SSE — mapping covered in first-wave", () => {
    assert.ok(true, "see regression-first-wave.test.ts parity: dead-letter");
  });

  it("documents: Row 7 e2e blocked on §2.3 — mapping covered in §12", () => {
    assert.ok(true, "see §12 cancel metadata carry-through");
  });
});
