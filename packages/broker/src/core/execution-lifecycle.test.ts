import { describe, it } from "node:test";

import { expect } from "../test-helpers/expect.js";

import {
  ExecutionManager,
  type ExecutionManagerOptions,
} from "./execution-lifecycle.js";
import {
  EXECUTION_TRANSITIONS,
  EXECUTION_FAILURE_CODES,
  FAILURE_RETRYABILITY,
  classifyExecutionFailure,
} from "./execution-lifecycle-types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createManager(opts?: Partial<ExecutionManagerOptions>): ExecutionManager {
  return new ExecutionManager({
    idFactory: () => `run-${Math.random().toString(36).slice(2)}`,
    ...opts,
  });
}

function baseInput(overrides?: Partial<{ sessionKey: string; peerNodeId: string; parentTaskId: string }>) {
  return {
    sessionKey: overrides?.sessionKey ?? "session-alpha",
    peerNodeId: overrides?.peerNodeId ?? "workerbeta",
    parentTaskId: overrides?.parentTaskId ?? "task-1",
  };
}

const FUTURE_DEADLINE = new Date(Date.now() + 300_000).toISOString(); // 5min
const PAST_DEADLINE = new Date(Date.now() - 10_000).toISOString(); // 10s ago

// ---------------------------------------------------------------------------
// State machine validation
// ---------------------------------------------------------------------------

describe("execution state machine", () => {
  it("terminal states have no outgoing transitions", () => {
    expect(EXECUTION_TRANSITIONS["result_reported"].size).toBe(0);
    expect(EXECUTION_TRANSITIONS["cancelled"].size).toBe(0);
  });

  it("failed and timeout can retry", () => {
    expect(EXECUTION_TRANSITIONS["failed"].has("wake_requested")).toBe(true);
    expect(EXECUTION_TRANSITIONS["timeout"].has("wake_requested")).toBe(true);
  });

  it("cannot skip from wake_requested to running", () => {
    expect(EXECUTION_TRANSITIONS["wake_requested"].has("running")).toBe(false);
  });

  it("cannot skip from session_ready to result_reported", () => {
    expect(EXECUTION_TRANSITIONS["session_ready"].has("result_reported")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Normal execution lifecycle
// ---------------------------------------------------------------------------

describe("normal execution", () => {
  it("full happy path: request → ready → deliver → running → result", () => {
    const mgr = createManager();
    const input = baseInput();

    const req = mgr.requestExecution(input);
    expect(req.status).toBe("wake_requested");
    expect(req.attempts).toBe(1);
    expect(req.payloadDelivered).toBe(false);

    const ready = mgr.sessionReady(req.runId, FUTURE_DEADLINE);
    expect(ready.status).toBe("session_ready");
    expect(ready.leaseDeadline).toBe(FUTURE_DEADLINE);

    const delivered = mgr.deliverPayload({ runId: req.runId });
    expect(delivered.status).toBe("payload_delivered");
    expect(delivered.payloadDelivered).toBe(true);
    expect(delivered.payloadDeliveredAt).toBeDefined();

    const running = mgr.startRunning(req.runId);
    expect(running.status).toBe("running");
    expect(running.startedAt).toBeDefined();

    const result = mgr.reportResult({
      runId: req.runId,
      outcome: "success",
      summary: "Deployed v2.1 successfully",
      artifactIds: ["artifact-1"],
    });
    expect(result.status).toBe("result_reported");
    expect(result.result?.outcome).toBe("success");
    expect(result.result?.artifactIds).toEqual(["artifact-1"]);
    expect(result.completedAt).toBeDefined();
  });

  it("emits correct event sequence", () => {
    const mgr = createManager();
    const input = baseInput();
    const req = mgr.requestExecution(input);
    mgr.sessionReady(req.runId);
    mgr.deliverPayload({ runId: req.runId });
    mgr.startRunning(req.runId);
    mgr.reportResult({
      runId: req.runId,
      outcome: "success",
      summary: "Done",
    });

    const events = mgr.subscribe({ runId: req.runId });
    expect(events.map((e) => e.kind)).toEqual([
      "exec_wake_requested",
      "exec_session_ready",
      "exec_payload_delivered",
      "exec_running",
      "exec_result_reported",
    ]);
  });

  it("result_reported event carries outcome and executionDurationMs", () => {
    const mgr = createManager();
    const input = baseInput();
    const req = mgr.requestExecution(input);
    mgr.sessionReady(req.runId);
    mgr.deliverPayload({ runId: req.runId });
    mgr.startRunning(req.runId);
    mgr.reportResult({
      runId: req.runId,
      outcome: "success",
      summary: "Done",
    });

    const events = mgr.subscribe({ runId: req.runId });
    const reported = events.find((e) => e.kind === "exec_result_reported");
    expect(reported!.metadata.outcome).toBe("success");
    expect(typeof reported!.metadata.executionDurationMs).toBe("number");
  });

  it("partial result outcome", () => {
    const mgr = createManager();
    const input = baseInput();
    const req = mgr.requestExecution(input);
    mgr.sessionReady(req.runId);
    mgr.deliverPayload({ runId: req.runId });
    mgr.startRunning(req.runId);
    const result = mgr.reportResult({
      runId: req.runId,
      outcome: "partial",
      summary: "2 of 3 subtasks completed",
    });
    expect(result.result?.outcome).toBe("partial");
  });

  it("rejected result outcome with error code", () => {
    const mgr = createManager();
    const input = baseInput();
    const req = mgr.requestExecution(input);
    mgr.sessionReady(req.runId);
    mgr.deliverPayload({ runId: req.runId });
    mgr.startRunning(req.runId);
    const result = mgr.reportResult({
      runId: req.runId,
      outcome: "rejected",
      summary: "Validation failed",
      errorCode: "result_parse_error",
    });
    expect(result.result?.outcome).toBe("rejected");
    expect(result.result?.errorCode).toBe("result_parse_error");
  });
});

// ---------------------------------------------------------------------------
// Duplicate payload suppression
// ---------------------------------------------------------------------------

describe("duplicate payload suppression", () => {
  it("deliverPayload is idempotent", () => {
    const mgr = createManager();
    const input = baseInput();
    const req = mgr.requestExecution(input);
    mgr.sessionReady(req.runId);

    const first = mgr.deliverPayload({ runId: req.runId });
    const second = mgr.deliverPayload({ runId: req.runId });
    expect(second.status).toBe("payload_delivered");
    expect(second.runId).toBe(first.runId);

    // Only one payload_delivered event
    const events = mgr.subscribe({ runId: req.runId });
    const delivered = events.filter((e) => e.kind === "exec_payload_delivered");
    expect(delivered).toHaveLength(1);
  });

  it("different runs for same session can each deliver", () => {
    const mgr = createManager();
    const input = baseInput();
    const req1 = mgr.requestExecution(input);
    mgr.sessionReady(req1.runId);
    mgr.deliverPayload({ runId: req1.runId });

    const req2 = mgr.requestExecution(input);
    mgr.sessionReady(req2.runId);
    const delivered = mgr.deliverPayload({ runId: req2.runId });
    expect(delivered.payloadDelivered).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Failure handling
// ---------------------------------------------------------------------------

describe("failure handling", () => {
  it("fail from running with structured code", () => {
    const mgr = createManager();
    const input = baseInput();
    const req = mgr.requestExecution(input);
    mgr.sessionReady(req.runId);
    mgr.deliverPayload({ runId: req.runId });
    mgr.startRunning(req.runId);

    const failed = mgr.failExecution(req.runId, "runtime_error");
    expect(failed.status).toBe("failed");
    expect(failed.failureCode).toBe("runtime_error");
    expect(failed.completedAt).toBeDefined();
  });

  it("fail from session_ready (delivery failure)", () => {
    const mgr = createManager();
    const input = baseInput();
    const req = mgr.requestExecution(input);
    mgr.sessionReady(req.runId);

    const failed = mgr.failExecution(req.runId, "delivery_failed");
    expect(failed.status).toBe("failed");
    expect(failed.failureCode).toBe("delivery_failed");
  });

  it("fail from wake_requested (peer unreachable)", () => {
    const mgr = createManager();
    const input = baseInput();
    const req = mgr.requestExecution(input);

    const failed = mgr.failExecution(req.runId, "peer_unreachable");
    expect(failed.status).toBe("failed");
    expect(failed.failureCode).toBe("peer_unreachable");
  });

  it("resolves failure code aliases", () => {
    const mgr = createManager();
    const input = baseInput();
    const req = mgr.requestExecution(input);
    mgr.failExecution(req.runId, "timeout");
    expect(mgr.getRun(req.runId)!.failureCode).toBe("execution_timeout");
  });

  it("falls back to 'other' for unknown codes", () => {
    const mgr = createManager();
    const input = baseInput();
    const req = mgr.requestExecution(input);
    mgr.failExecution(req.runId, "weird");
    expect(mgr.getRun(req.runId)!.failureCode).toBe("other");
  });
});

// ---------------------------------------------------------------------------
// Timeout handling
// ---------------------------------------------------------------------------

describe("timeout handling", () => {
  it("timeout from running state", () => {
    const mgr = createManager();
    const input = baseInput();
    const req = mgr.requestExecution(input);
    mgr.sessionReady(req.runId);
    mgr.deliverPayload({ runId: req.runId });
    mgr.startRunning(req.runId);

    const timedOut = mgr.timeoutExecution(req.runId);
    expect(timedOut.status).toBe("timeout");
    expect(timedOut.failureCode).toBe("execution_timeout");
    expect(timedOut.completedAt).toBeDefined();
  });

  it("timeout from session_ready", () => {
    const mgr = createManager();
    const input = baseInput();
    const req = mgr.requestExecution(input);
    mgr.sessionReady(req.runId);

    const timedOut = mgr.timeoutExecution(req.runId);
    expect(timedOut.status).toBe("timeout");
  });

  it("isLeaseExpired returns false for runs without deadline", () => {
    const mgr = createManager();
    const input = baseInput();
    const req = mgr.requestExecution(input);
    mgr.sessionReady(req.runId); // no deadline
    expect(mgr.isLeaseExpired(req.runId)).toBe(false);
  });

  it("isLeaseExpired returns false for future deadline", () => {
    const mgr = createManager();
    const input = baseInput();
    const req = mgr.requestExecution(input);
    mgr.sessionReady(req.runId, FUTURE_DEADLINE);
    expect(mgr.isLeaseExpired(req.runId)).toBe(false);
  });

  it("isLeaseExpired returns true for past deadline on active run", () => {
    const mgr = createManager();
    const input = baseInput();
    const req = mgr.requestExecution(input);
    mgr.sessionReady(req.runId, PAST_DEADLINE);
    expect(mgr.isLeaseExpired(req.runId)).toBe(true);
  });

  it("isLeaseExpired returns false for terminal run even with past deadline", () => {
    const mgr = createManager();
    const input = baseInput();
    const req = mgr.requestExecution(input);
    mgr.sessionReady(req.runId, PAST_DEADLINE);
    mgr.failExecution(req.runId, "lease_expired");
    expect(mgr.isLeaseExpired(req.runId)).toBe(false);
  });

  it("findExpiredLeases returns only expired active runs", () => {
    const mgr = createManager();
    const a = mgr.requestExecution(baseInput({ sessionKey: "a" }));
    mgr.sessionReady(a.runId, PAST_DEADLINE); // expired

    const b = mgr.requestExecution(baseInput({ sessionKey: "b" }));
    mgr.sessionReady(b.runId, FUTURE_DEADLINE); // not expired

    const c = mgr.requestExecution(baseInput({ sessionKey: "c" }));
    mgr.sessionReady(c.runId, PAST_DEADLINE);
    mgr.failExecution(c.runId, "lease_expired"); // terminal, not active

    const expired = mgr.findExpiredLeases();
    expect(expired).toHaveLength(1);
    expect(expired[0]).toBe(a.runId);
  });
});

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

describe("cancellation", () => {
  it("cancel from running", () => {
    const mgr = createManager();
    const input = baseInput();
    const req = mgr.requestExecution(input);
    mgr.sessionReady(req.runId);
    mgr.deliverPayload({ runId: req.runId });
    mgr.startRunning(req.runId);

    const cancelled = mgr.cancelExecution(req.runId);
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.failureCode).toBe("cancelled_by_operator");
    expect(cancelled.completedAt).toBeDefined();
  });

  it("cancel from session_ready", () => {
    const mgr = createManager();
    const input = baseInput();
    const req = mgr.requestExecution(input);
    mgr.sessionReady(req.runId);

    const cancelled = mgr.cancelExecution(req.runId);
    expect(cancelled.status).toBe("cancelled");
  });

  it("cannot cancel from result_reported", () => {
    const mgr = createManager();
    const input = baseInput();
    const req = mgr.requestExecution(input);
    mgr.sessionReady(req.runId);
    mgr.deliverPayload({ runId: req.runId });
    mgr.startRunning(req.runId);
    mgr.reportResult({ runId: req.runId, outcome: "success", summary: "Done" });

    expect(() => mgr.cancelExecution(req.runId)).toThrow(/Cannot transition/i);
  });
});

// ---------------------------------------------------------------------------
// Retry
// ---------------------------------------------------------------------------

describe("retry", () => {
  it("retry from failed creates new run", () => {
    const mgr = createManager();
    const input = baseInput();
    const req = mgr.requestExecution(input);
    mgr.failExecution(req.runId, "runtime_error");

    const retry = mgr.retryExecution(req.runId);
    expect(retry.status).toBe("wake_requested");
    expect(retry.runId).not.toBe(req.runId);
    expect(retry.sessionKey).toBe(req.sessionKey);
    expect(retry.attempts).toBe(2);
    expect(retry.payloadDelivered).toBe(false);
  });

  it("retry from timeout creates new run", () => {
    const mgr = createManager();
    const input = baseInput();
    const req = mgr.requestExecution(input);
    mgr.sessionReady(req.runId);
    mgr.timeoutExecution(req.runId);

    const retry = mgr.retryExecution(req.runId);
    expect(retry.status).toBe("wake_requested");
    expect(retry.attempts).toBe(2);
  });

  it("retry increments attempts across retries", () => {
    const mgr = createManager();
    const input = baseInput();
    const r1 = mgr.requestExecution(input);
    mgr.failExecution(r1.runId, "runtime_error");
    const r2 = mgr.retryExecution(r1.runId, { maxRetries: 2 });
    mgr.failExecution(r2.runId, "runtime_error");
    const r3 = mgr.retryExecution(r2.runId, { maxRetries: 2 });
    expect(r3.attempts).toBe(3);
  });

  it("cannot retry from active or completed", () => {
    const mgr = createManager();
    const input = baseInput();
    const req = mgr.requestExecution(input);
    expect(() => mgr.retryExecution(req.runId)).toThrow(/Cannot retry/i);

    mgr.sessionReady(req.runId);
    mgr.deliverPayload({ runId: req.runId });
    mgr.startRunning(req.runId);
    mgr.reportResult({ runId: req.runId, outcome: "success", summary: "Done" });
    expect(() => mgr.retryExecution(req.runId)).toThrow(/Cannot retry/i);
  });
});

// ---------------------------------------------------------------------------
// Invalid transitions
// ---------------------------------------------------------------------------

describe("invalid transitions", () => {
  it("throws on wake_requested → running", () => {
    const mgr = createManager();
    const req = mgr.requestExecution(baseInput());
    expect(() => mgr.startRunning(req.runId)).toThrow(/Cannot transition/i);
  });

  it("throws on session_ready → result_reported", () => {
    const mgr = createManager();
    const req = mgr.requestExecution(baseInput());
    mgr.sessionReady(req.runId);
    expect(() => mgr.reportResult({ runId: req.runId, outcome: "success", summary: "s" }))
      .toThrow(/Cannot transition/i);
  });

  it("throws on non-existent run", () => {
    const mgr = createManager();
    expect(() => mgr.sessionReady("nope")).toThrow(/not found/i);
  });
});

// ---------------------------------------------------------------------------
// Cursor/replay
// ---------------------------------------------------------------------------

describe("cursor replay", () => {
  it("events have monotonically increasing ids", () => {
    const mgr = createManager();
    const input = baseInput();
    const req = mgr.requestExecution(input);
    mgr.sessionReady(req.runId);
    mgr.deliverPayload({ runId: req.runId });
    mgr.startRunning(req.runId);
    mgr.reportResult({ runId: req.runId, outcome: "success", summary: "Done" });

    const events = mgr.subscribe({ runId: req.runId });
    const ids = events.map((e) => e.id);
    for (let i = 1; i < ids.length; i++) {
      expect(ids[i]).toBeGreaterThan(ids[i - 1]);
    }
  });

  it("subscribe with afterId skips older events", () => {
    const mgr = createManager();
    const input = baseInput();
    const req = mgr.requestExecution(input);
    mgr.sessionReady(req.runId);

    const all = mgr.subscribe({ runId: req.runId });
    expect(all).toHaveLength(2);
    const afterFirst = mgr.subscribe({ runId: req.runId, afterId: all[0].id });
    expect(afterFirst).toHaveLength(1);
    expect(afterFirst[0].kind).toBe("exec_session_ready");
  });

  it("filters by sessionKey", () => {
    const mgr = createManager();
    const a = mgr.requestExecution(baseInput({ sessionKey: "s1" }));
    const b = mgr.requestExecution(baseInput({ sessionKey: "s2" }));
    expect(mgr.subscribe({ sessionKey: "s1" })).toHaveLength(1);
    expect(mgr.subscribe({ sessionKey: "s2" })).toHaveLength(1);
  });

  it("filters by peerNodeId", () => {
    const mgr = createManager();
    mgr.requestExecution(baseInput({ peerNodeId: "workerbeta" }));
    mgr.requestExecution(baseInput({ peerNodeId: "workerepsilon" }));
    expect(mgr.subscribe({ peerNodeId: "workerbeta" })).toHaveLength(1);
  });

  it("filters by parentTaskId", () => {
    const mgr = createManager();
    mgr.requestExecution(baseInput({ parentTaskId: "task-a" }));
    mgr.requestExecution(baseInput({ parentTaskId: "task-b" }));
    expect(mgr.subscribe({ parentTaskId: "task-a" })).toHaveLength(1);
  });

  it("respects limit", () => {
    const mgr = createManager();
    mgr.requestExecution(baseInput({ sessionKey: "a" }));
    mgr.requestExecution(baseInput({ sessionKey: "b" }));
    mgr.requestExecution(baseInput({ sessionKey: "c" }));
    expect(mgr.subscribe({ limit: 2 })).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Replay after retention pressure
// ---------------------------------------------------------------------------

describe("replay after retention eviction", () => {
  it("run state survives event eviction", () => {
    const mgr = createManager({ maxEvents: 3 });
    const input = baseInput();
    const req = mgr.requestExecution(input);
    mgr.sessionReady(req.runId);
    mgr.deliverPayload({ runId: req.runId });
    mgr.startRunning(req.runId);

    // Evict earlier events
    mgr.requestExecution(baseInput({ sessionKey: "filler-1" }));
    mgr.requestExecution(baseInput({ sessionKey: "filler-2" }));

    const run = mgr.getRun(req.runId)!;
    expect(run.status).toBe("running");
    expect(run.payloadDelivered).toBe(true);

    // Can still complete
    const result = mgr.reportResult({ runId: req.runId, outcome: "success", summary: "Done" });
    expect(result.status).toBe("result_reported");
  });

  it("closeout works after eviction", () => {
    const mgr = createManager({ maxEvents: 2 });
    const input = baseInput();
    const req = mgr.requestExecution(input);
    mgr.sessionReady(req.runId);
    mgr.deliverPayload({ runId: req.runId });
    mgr.startRunning(req.runId);
    mgr.reportResult({ runId: req.runId, outcome: "success", summary: "Done" });

    // Evict events
    mgr.requestExecution(baseInput({ sessionKey: "filler" }));

    const closeout = mgr.closeoutRun(req.runId);
    expect(closeout).not.toBeNull();
    expect(closeout!.kind).toBe("completed");
  });
});

// ---------------------------------------------------------------------------
// Closeout reconciliation
// ---------------------------------------------------------------------------

describe("closeout reconciliation", () => {
  it("closeoutRun returns completed for result_reported", () => {
    const mgr = createManager();
    const input = baseInput();
    const req = mgr.requestExecution(input);
    mgr.sessionReady(req.runId);
    mgr.deliverPayload({ runId: req.runId });
    mgr.startRunning(req.runId);
    mgr.reportResult({ runId: req.runId, outcome: "success", summary: "Done" });

    const c = mgr.closeoutRun(req.runId)!;
    expect(c.kind).toBe("completed");
    expect(c.result?.outcome).toBe("success");
    expect(c.attempts).toBe(1);
  });

  it("closeoutRun returns failed", () => {
    const mgr = createManager();
    const input = baseInput();
    const req = mgr.requestExecution(input);
    mgr.failExecution(req.runId, "runtime_error");

    const c = mgr.closeoutRun(req.runId)!;
    expect(c.kind).toBe("failed");
    expect(c.failureCode).toBe("runtime_error");
  });

  it("closeoutRun returns timed_out", () => {
    const mgr = createManager();
    const input = baseInput();
    const req = mgr.requestExecution(input);
    mgr.sessionReady(req.runId);
    mgr.timeoutExecution(req.runId);

    const c = mgr.closeoutRun(req.runId)!;
    expect(c.kind).toBe("timed_out");
    expect(c.failureCode).toBe("execution_timeout");
  });

  it("closeoutRun returns waiting for active run", () => {
    const mgr = createManager();
    const input = baseInput();
    const req = mgr.requestExecution(input);
    mgr.sessionReady(req.runId);

    const c = mgr.closeoutRun(req.runId)!;
    expect(c.kind).toBe("waiting");
  });

  it("closeoutRun returns cancelled", () => {
    const mgr = createManager();
    const input = baseInput();
    const req = mgr.requestExecution(input);
    mgr.cancelExecution(req.runId);

    const c = mgr.closeoutRun(req.runId)!;
    expect(c.kind).toBe("cancelled");
    expect(c.failureCode).toBe("cancelled_by_operator");
  });

  it("closeoutRun returns null for unknown run", () => {
    const mgr = createManager();
    expect(mgr.closeoutRun("nope")).toBeNull();
  });

  it("closeoutTask aggregates all runs for a task", () => {
    const mgr = createManager();
    const input = baseInput({ parentTaskId: "task-x" });
    const r1 = mgr.requestExecution(input);
    mgr.sessionReady(r1.runId);
    mgr.deliverPayload({ runId: r1.runId });
    mgr.startRunning(r1.runId);
    mgr.reportResult({ runId: r1.runId, outcome: "success", summary: "Done" });

    const r2 = mgr.requestExecution({ ...input, sessionKey: "session-b" });
    mgr.failExecution(r2.runId, "peer_unreachable");

    const r3 = mgr.requestExecution({ ...input, sessionKey: "session-c" });
    mgr.sessionReady(r3.runId);

    const closeouts = mgr.closeoutTask("task-x");
    expect(closeouts).toHaveLength(3);
    const kinds = closeouts.map((c) => c.kind);
    expect(kinds).toContain("completed");
    expect(kinds).toContain("failed");
    expect(kinds).toContain("waiting");
  });

  it("closeoutSession aggregates all runs for a session", () => {
    const mgr = createManager();
    const input = baseInput({ sessionKey: "session-x" });
    const r1 = mgr.requestExecution(input);
    mgr.failExecution(r1.runId, "runtime_error");
    const r2 = mgr.retryExecution(r1.runId);
    mgr.sessionReady(r2.runId);
    mgr.deliverPayload({ runId: r2.runId });
    mgr.startRunning(r2.runId);
    mgr.reportResult({ runId: r2.runId, outcome: "success", summary: "Done" });

    const closeouts = mgr.closeoutSession("session-x");
    expect(closeouts).toHaveLength(2);
    expect(closeouts[0].kind).toBe("failed");
    expect(closeouts[1].kind).toBe("completed");
  });
});

// ---------------------------------------------------------------------------
// Audit trail safety
// ---------------------------------------------------------------------------

describe("audit trail safety", () => {
  it("events never carry raw prompt or session text", () => {
    const mgr = createManager();
    const input = baseInput();
    const req = mgr.requestExecution(input);
    mgr.sessionReady(req.runId);
    mgr.deliverPayload({ runId: req.runId });
    mgr.startRunning(req.runId);
    mgr.reportResult({
      runId: req.runId,
      outcome: "success",
      summary: "Deployed successfully",
    });

    const events = mgr.subscribe({ runId: req.runId });
    for (const e of events) {
      expect(e).not.toHaveProperty("prompt");
      expect(e).not.toHaveProperty("sessionText");
      expect(e).not.toHaveProperty("rawBody");
      expect(e).not.toHaveProperty("message");
    }
  });

  it("run state has no raw content fields", () => {
    const mgr = createManager();
    const req = mgr.requestExecution(baseInput());
    const run = mgr.getRun(req.runId)!;

    expect(run).not.toHaveProperty("prompt");
    expect(run).not.toHaveProperty("sessionText");
    expect(run).not.toHaveProperty("rawBody");
    expect(run).not.toHaveProperty("payload");
  });

  it("result artifact has structured fields only", () => {
    const mgr = createManager();
    const req = mgr.requestExecution(baseInput());
    mgr.sessionReady(req.runId);
    mgr.deliverPayload({ runId: req.runId });
    mgr.startRunning(req.runId);
    mgr.reportResult({
      runId: req.runId,
      outcome: "success",
      summary: "Done",
      artifactIds: ["a1"],
    });

    const run = mgr.getRun(req.runId)!;
    expect(run.result).toEqual({
      outcome: "success",
      summary: "Done",
      artifactIds: ["a1"],
    });
  });
});

// ---------------------------------------------------------------------------
// Multi-run / multi-session scenarios
// ---------------------------------------------------------------------------

describe("multi-run scenarios", () => {
  it("tracks independent runs", () => {
    const mgr = createManager();
    const r1 = mgr.requestExecution(baseInput({ sessionKey: "s1", peerNodeId: "workerbeta" }));
    const r2 = mgr.requestExecution(baseInput({ sessionKey: "s2", peerNodeId: "workerepsilon" }));

    mgr.sessionReady(r1.runId);
    mgr.deliverPayload({ runId: r1.runId });
    mgr.startRunning(r1.runId);
    mgr.reportResult({ runId: r1.runId, outcome: "success", summary: "Done" });

    mgr.failExecution(r2.runId, "peer_unreachable");

    expect(mgr.getRun(r1.runId)!.status).toBe("result_reported");
    expect(mgr.getRun(r2.runId)!.status).toBe("failed");
  });

  it("getRunsForSession returns all runs for a session", () => {
    const mgr = createManager();
    const input = baseInput({ sessionKey: "s1" });
    const r1 = mgr.requestExecution(input);
    mgr.failExecution(r1.runId, "runtime_error");
    const r2 = mgr.retryExecution(r1.runId);

    expect(mgr.getRunsForSession("s1")).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Retryability classification (issue #838)
// ---------------------------------------------------------------------------

describe("retryability classification", () => {
  it("classifies retryable codes correctly", () => {
    // Core retryable: transient infrastructure failures
    expect(classifyExecutionFailure("peer_unreachable")).toBe(true);
    expect(classifyExecutionFailure("session_expired")).toBe(true);
    expect(classifyExecutionFailure("delivery_failed")).toBe(true);
    expect(classifyExecutionFailure("runtime_error")).toBe(true);
    expect(classifyExecutionFailure("rate_limited")).toBe(true);
    expect(classifyExecutionFailure("lease_expired")).toBe(true);
    expect(classifyExecutionFailure("execution_timeout")).toBe(true);
  });

  it("classifies non-retryable codes correctly", () => {
    // Non-retryable: permanent or semantic failures
    expect(classifyExecutionFailure("payload_too_large")).toBe(false);
    expect(classifyExecutionFailure("result_parse_error")).toBe(false);
    expect(classifyExecutionFailure("auth_failed")).toBe(false);
    expect(classifyExecutionFailure("cancelled_by_operator")).toBe(false);
    expect(classifyExecutionFailure("duplicate_payload_suppressed")).toBe(false);
    expect(classifyExecutionFailure("other")).toBe(false);
  });

  it("resolves aliases through classifyExecutionFailure", () => {
    expect(classifyExecutionFailure("timeout")).toBe(true);
    expect(classifyExecutionFailure("auth")).toBe(false);
    expect(classifyExecutionFailure("unreachable")).toBe(true);
    expect(classifyExecutionFailure("lease")).toBe(true);
    expect(classifyExecutionFailure("rate_limit")).toBe(true);
  });

  it("defaults unknown codes to non-retryable", () => {
    expect(classifyExecutionFailure("unknown")).toBe(false);
    expect(classifyExecutionFailure("weird_failure")).toBe(false);
    expect(classifyExecutionFailure("")).toBe(false);
  });

  it("FAILURE_RETRYABILITY has entry for every EXECUTION_FAILURE_CODES member", () => {
    for (const code of EXECUTION_FAILURE_CODES) {
      expect(FAILURE_RETRYABILITY).toHaveProperty(code);
      expect(typeof FAILURE_RETRYABILITY[code]).toBe("boolean");
    }
  });
});

// ---------------------------------------------------------------------------
// isRetryableFailure and remainingRetries (issue #838)
// ---------------------------------------------------------------------------

describe("isRetryableFailure", () => {
  it("returns true for failed run with retryable code", () => {
    const mgr = createManager();
    const req = mgr.requestExecution(baseInput());
    mgr.failExecution(req.runId, "runtime_error");
    expect(mgr.isRetryableFailure(req.runId)).toBe(true);
  });

  it("returns true for timed-out run", () => {
    const mgr = createManager();
    const req = mgr.requestExecution(baseInput());
    mgr.sessionReady(req.runId);
    mgr.timeoutExecution(req.runId);
    expect(mgr.isRetryableFailure(req.runId)).toBe(true);
  });

  it("returns false for failed run with non-retryable code", () => {
    const mgr = createManager();
    const req = mgr.requestExecution(baseInput());
    mgr.failExecution(req.runId, "auth_failed");
    expect(mgr.isRetryableFailure(req.runId)).toBe(false);
  });

  it("returns false for active run", () => {
    const mgr = createManager();
    const req = mgr.requestExecution(baseInput());
    expect(mgr.isRetryableFailure(req.runId)).toBe(false);
  });

  it("returns false for completed run", () => {
    const mgr = createManager();
    const req = mgr.requestExecution(baseInput());
    mgr.sessionReady(req.runId);
    mgr.deliverPayload({ runId: req.runId });
    mgr.startRunning(req.runId);
    mgr.reportResult({ runId: req.runId, outcome: "success", summary: "Done" });
    expect(mgr.isRetryableFailure(req.runId)).toBe(false);
  });

  it("returns false for unknown run id", () => {
    const mgr = createManager();
    expect(mgr.isRetryableFailure("nope")).toBe(false);
  });

  it("returns false for cancelled run", () => {
    const mgr = createManager();
    const req = mgr.requestExecution(baseInput());
    mgr.cancelExecution(req.runId);
    expect(mgr.isRetryableFailure(req.runId)).toBe(false);
  });
});

describe("remainingRetries", () => {
  it("returns 1 for first failed run with maxRetries=1", () => {
    const mgr = createManager();
    const req = mgr.requestExecution(baseInput());
    mgr.failExecution(req.runId, "runtime_error");
    expect(mgr.remainingRetries(req.runId)).toBe(1);
  });

  it("returns 0 for first failed run with maxRetries=0", () => {
    const mgr = createManager({ defaultMaxRetries: 0 });
    const req = mgr.requestExecution(baseInput());
    mgr.failExecution(req.runId, "runtime_error");
    expect(mgr.remainingRetries(req.runId)).toBe(0);
  });

  it("returns 0 for non-retryable failure code", () => {
    const mgr = createManager({ defaultMaxRetries: 5 });
    const req = mgr.requestExecution(baseInput());
    mgr.failExecution(req.runId, "auth_failed");
    expect(mgr.remainingRetries(req.runId)).toBe(0);
  });

  it("returns 0 for active run", () => {
    const mgr = createManager();
    const req = mgr.requestExecution(baseInput());
    expect(mgr.remainingRetries(req.runId)).toBe(0);
  });

  it("returns 2 after one retry used with maxRetries=3", () => {
    const mgr = createManager({ defaultMaxRetries: 3 });
    const r1 = mgr.requestExecution(baseInput());
    mgr.failExecution(r1.runId, "runtime_error");
    const r2 = mgr.retryExecution(r1.runId);
    mgr.failExecution(r2.runId, "runtime_error");
    expect(mgr.remainingRetries(r2.runId)).toBe(2);
  });

  it("returns 0 after all retries exhausted", () => {
    const mgr = createManager({ defaultMaxRetries: 1 });
    const r1 = mgr.requestExecution(baseInput());
    mgr.failExecution(r1.runId, "runtime_error");
    const r2 = mgr.retryExecution(r1.runId);
    expect(mgr.remainingRetries(r2.runId)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Retry policy enforcement (issue #838)
// ---------------------------------------------------------------------------

describe("retry policy enforcement", () => {
  it("blocks retry for non-retryable failure code", () => {
    const mgr = createManager();
    const req = mgr.requestExecution(baseInput());
    mgr.failExecution(req.runId, "auth_failed");
    expect(() => mgr.retryExecution(req.runId)).toThrow(/not classified as retryable/);
  });

  it("blocks retry when attempts exceed maxRetries", () => {
    const mgr = createManager({ defaultMaxRetries: 1 });
    const r1 = mgr.requestExecution(baseInput());
    mgr.failExecution(r1.runId, "runtime_error");
    const r2 = mgr.retryExecution(r1.runId);
    // r2 is in wake_requested; fail it before retrying to trigger budget exhaust
    mgr.failExecution(r2.runId, "runtime_error");
    // attempts now 2, maxRetries=1 → budget exhausted
    expect(() => mgr.retryExecution(r2.runId)).toThrow(/attempt budget exhausted/);
  });

  it("blocks retry when maxRetries=0", () => {
    const mgr = createManager({ defaultMaxRetries: 0 });
    const req = mgr.requestExecution(baseInput());
    mgr.failExecution(req.runId, "runtime_error");
    expect(() => mgr.retryExecution(req.runId)).toThrow(/automatic retry is disabled/);
  });

  it("allows per-call maxRetries override", () => {
    const mgr = createManager({ defaultMaxRetries: 0 });
    const req = mgr.requestExecution(baseInput());
    mgr.failExecution(req.runId, "runtime_error");
    const retry = mgr.retryExecution(req.runId, { maxRetries: 1 });
    expect(retry.attempts).toBe(2);
  });

  it("allows retry once by default", () => {
    const mgr = createManager();
    const req = mgr.requestExecution(baseInput());
    mgr.failExecution(req.runId, "runtime_error");
    const retry = mgr.retryExecution(req.runId);
    expect(retry.attempts).toBe(2);
    expect(retry.runId).not.toBe(req.runId);
    expect(retry.payloadDelivered).toBe(false);
  });

  it("distinguishes infra failure from source failure", () => {
    // runtime_error (infra) is retryable; other (unknown/source) is not
    expect(classifyExecutionFailure("runtime_error")).toBe(true);
    expect(classifyExecutionFailure("result_parse_error")).toBe(false);
    expect(classifyExecutionFailure("other")).toBe(false);
  });

  it("fresh retry run has new session workspace (new runId)", () => {
    const mgr = createManager();
    const req = mgr.requestExecution(baseInput());
    mgr.failExecution(req.runId, "runtime_error");
    const retry = mgr.retryExecution(req.runId);
    expect(retry.runId).not.toBe(req.runId);
    expect(retry.attempts).toBe(2);
    expect(retry.status).toBe("wake_requested");
  });
});
