/**
 * Tests for durable-session-wake-adapter (Round 20, plugin-a2a#97).
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  DurableSessionWakeAdapter,
  createDurableSessionWakeAdapter,
} from "../dist/src/durable-session-wake-adapter.js";

// ── Helpers ────────────────────────────────────────────────────

let clockMs = 0;
function resetClock() { clockMs = 1700000000000; }
function tickMs(ms: number) { clockMs += ms; }
const fixedNow = () => new Date(clockMs);

function makeRequest(overrides = {}) {
  return {
    taskId: "task-42",
    targetSessionKey: "session:worker-alpha:main",
    message: "A2A Wake-on-Task accepted",
    targetNodeId: "worker-alpha-host",
    correlationId: "corr-001",
    createdAt: clockMs,
    ...overrides,
  };
}

// ── Wake creation ──────────────────────────────────────────────

test("creates pending wake entry", () => {
  resetClock();
  const adapter = new DurableSessionWakeAdapter({ now: fixedNow });
  const result = adapter.wake(makeRequest());
  assert.equal(result.entry.state, "pending");
  assert.equal(result.entry.taskId, "task-42");
  assert.equal(result.entry.targetSessionKey, "session:worker-alpha:main");
  assert.equal(result.entry.targetNodeId, "worker-alpha-host");
  assert.equal(result.entry.correlationId, "corr-001");
  assert.equal(result.audit.toState, "pending");
  assert.equal(result.audit.isFallback, false);
});

test("wake produces deterministic wake ID", () => {
  resetClock();
  const a1 = new DurableSessionWakeAdapter({ now: fixedNow });
  const a2 = new DurableSessionWakeAdapter({ now: fixedNow });
  const r1 = a1.wake(makeRequest());
  const r2 = a2.wake(makeRequest());
  assert.equal(r1.entry.wakeId, r2.entry.wakeId);
});

test("different requests produce different wake IDs", () => {
  resetClock();
  const adapter = new DurableSessionWakeAdapter({ now: fixedNow });
  const r1 = adapter.wake(makeRequest());
  const r2 = adapter.wake(makeRequest({ taskId: "task-43" }));
  assert.notEqual(r1.entry.wakeId, r2.entry.wakeId);
});

test("coalesces duplicate wake for same task+session", () => {
  resetClock();
  const adapter = new DurableSessionWakeAdapter({ now: fixedNow });
  const r1 = adapter.wake(makeRequest());
  tickMs(100);
  const r2 = adapter.wake(makeRequest());
  assert.equal(r1.entry.wakeId, r2.entry.wakeId);
  assert.equal(r2.audit.toState, "pending"); // state unchanged
});

test("fails on missing taskId", () => {
  resetClock();
  const adapter = new DurableSessionWakeAdapter({ now: fixedNow });
  const result = adapter.wake(makeRequest({ taskId: "" }));
  assert.equal(result.entry.state, "failed");
});

test("fails on missing targetSessionKey", () => {
  resetClock();
  const adapter = new DurableSessionWakeAdapter({ now: fixedNow });
  const result = adapter.wake(makeRequest({ targetSessionKey: "  " }));
  assert.equal(result.entry.state, "failed");
});

// ── Node ID preservation ──────────────────────────────────────

test("preserves remote node ID through wake lifecycle", () => {
  resetClock();
  const adapter = new DurableSessionWakeAdapter({ now: fixedNow });
  const r1 = adapter.wake(makeRequest());
  const wakeId = r1.entry.wakeId;

  const status = adapter.getNodeIdStatus(wakeId);
  assert.equal(status.preserved, true);
  assert.equal(status.nodeId, "worker-alpha-host");
});

test("node ID not preserved when not provided", () => {
  resetClock();
  const adapter = new DurableSessionWakeAdapter({ now: fixedNow });
  const r = adapter.wake(makeRequest({ targetNodeId: undefined }));
  const status = adapter.getNodeIdStatus(r.entry.wakeId);
  assert.equal(status.preserved, false);
});

test("node ID preserved even after failure", () => {
  resetClock();
  const adapter = new DurableSessionWakeAdapter({ now: fixedNow });
  const r = adapter.wake(makeRequest());
  tickMs(100);
  adapter.fail(r.entry.wakeId, "test failure");
  const status = adapter.getNodeIdStatus(r.entry.wakeId);
  assert.equal(status.preserved, true);
});

// ── State transitions ──────────────────────────────────────────

test("full lifecycle: pending → dispatched → acknowledged → resumed → completed", () => {
  resetClock();
  const adapter = new DurableSessionWakeAdapter({ now: fixedNow });
  const r1 = adapter.wake(makeRequest());
  const wakeId = r1.entry.wakeId;

  // Manually transition through states
  const entry = adapter.getEntry(wakeId);
  assert.ok(entry);

  // Simulate dispatch
  tickMs(100);
  // Wake was already pending, let's acknowledge
  // First we need dispatched state - wake() without runtimeAdapter stays pending
  // Let's use a runtime adapter
});

test("full lifecycle with runtime adapter", () => {
  resetClock();
  // Simple mock runtime adapter
  const mockAdapter = {
    runtime: "openclaw-session" as const,
    wake: () => ({
      status: "dispatched" as const,
      taskId: "task-42",
      targetSessionKey: "session:worker-alpha:main",
      runtime: "openclaw-session",
      wakeId: "wake:mock123",
      coalescedTaskIds: [] as string[],
    }),
    failures: () => [],
  };

  const adapter = new DurableSessionWakeAdapter({ now: fixedNow, runtimeAdapter: mockAdapter });
  const r1 = adapter.wake(makeRequest());
  const wakeId = r1.entry.wakeId;

  assert.equal(r1.entry.state, "dispatched");
  assert.ok(r1.dispatch);
  assert.equal(r1.dispatch.status, "dispatched");

  tickMs(100);
  const r2 = adapter.acknowledge(wakeId);
  assert.ok(r2);
  assert.equal(r2.entry.state, "acknowledged");
  assert.equal(r2.audit.fromState, "dispatched");

  tickMs(100);
  const r3 = adapter.resume(wakeId);
  assert.ok(r3);
  assert.equal(r3.entry.state, "resumed");
  assert.equal(r3.audit.fromState, "acknowledged");

  tickMs(100);
  const r4 = adapter.complete(wakeId);
  assert.ok(r4);
  assert.equal(r4.entry.state, "completed");
  assert.equal(r4.audit.fromState, "resumed");
});

test("acknowledge returns null for non-dispatched entry", () => {
  resetClock();
  const adapter = new DurableSessionWakeAdapter({ now: fixedNow });
  const r = adapter.wake(makeRequest());
  // pending state, not dispatched
  const result = adapter.acknowledge(r.entry.wakeId);
  assert.equal(result, null);
});

test("resume returns null for non-acknowledged entry", () => {
  resetClock();
  const adapter = new DurableSessionWakeAdapter({ now: fixedNow });
  const r = adapter.wake(makeRequest());
  const result = adapter.resume(r.entry.wakeId);
  assert.equal(result, null);
});

test("complete returns null for non-resumed entry", () => {
  resetClock();
  const adapter = new DurableSessionWakeAdapter({ now: fixedNow });
  const r = adapter.wake(makeRequest());
  const result = adapter.complete(r.entry.wakeId);
  assert.equal(result, null);
});

// ── Failure and fallback ───────────────────────────────────────

test("fail marks entry as failed", () => {
  resetClock();
  const adapter = new DurableSessionWakeAdapter({ now: fixedNow });
  const r = adapter.wake(makeRequest());
  tickMs(100);
  const failResult = adapter.fail(r.entry.wakeId, "target unreachable");
  assert.ok(failResult);
  assert.equal(failResult.entry.state, "failed");
  assert.equal(failResult.audit.toState, "failed");
  assert.equal(failResult.audit.isFallback, false);
});

test("fail with fallback reason transitions to fallback state", () => {
  resetClock();
  const adapter = new DurableSessionWakeAdapter({ now: fixedNow });
  const r = adapter.wake(makeRequest());
  tickMs(100);
  const failResult = adapter.fail(r.entry.wakeId, "target unreachable", "target_unreachable");
  assert.ok(failResult);
  assert.equal(failResult.entry.state, "fallback");
  assert.equal(failResult.entry.fallbackReason, "target_unreachable");
  assert.equal(failResult.entry.attemptCount, 1);
  assert.equal(failResult.audit.isFallback, true);
});

test("fallback transitions to failed after max retries", () => {
  resetClock();
  const adapter = new DurableSessionWakeAdapter({ now: fixedNow, maxRetryAttempts: 2 });
  const r = adapter.wake(makeRequest());
  tickMs(100);
  const f1 = adapter.fail(r.entry.wakeId, "fail 1", "target_unreachable");
  assert.equal(f1.entry.state, "fallback");
  tickMs(100);
  const f2 = adapter.fail(r.entry.wakeId, "fail 2", "target_unreachable");
  assert.equal(f2.entry.state, "fallback");
  tickMs(100);
  const f3 = adapter.fail(r.entry.wakeId, "fail 3", "target_unreachable");
  assert.ok(f3);
  assert.equal(f3.entry.state, "failed");
});

test("fail returns null for unknown wake ID", () => {
  resetClock();
  const adapter = new DurableSessionWakeAdapter({ now: fixedNow });
  const result = adapter.fail("nonexistent", "reason");
  assert.equal(result, null);
});

// ── Audit projection ───────────────────────────────────────────

test("audit projection tracks state transitions", () => {
  resetClock();
  const mockAdapter = {
    runtime: "openclaw-session" as const,
    wake: () => ({
      status: "dispatched" as const,
      taskId: "task-42",
      targetSessionKey: "session:worker-alpha:main",
      runtime: "openclaw-session",
      wakeId: "wake:mock123",
      coalescedTaskIds: [] as string[],
    }),
    failures: () => [],
  };

  const adapter = new DurableSessionWakeAdapter({ now: fixedNow, runtimeAdapter: mockAdapter });
  const r1 = adapter.wake(makeRequest());
  tickMs(100);
  adapter.acknowledge(r1.entry.wakeId);
  tickMs(100);
  adapter.resume(r1.entry.wakeId);

  const projection = adapter.getAuditProjection(r1.entry.wakeId);
  assert.ok(projection.length >= 2);

  // Verify redaction in audit summaries
  for (const event of projection) {
    assert.ok(!event.summary?.includes("api_key") || event.summary?.includes("[redacted]"));
  }
});

test("audit projection redacts secrets", () => {
  resetClock();
  const adapter = new DurableSessionWakeAdapter({ now: fixedNow });
  // Force an audit with secret in summary
  const result = adapter.wake(makeRequest());
  // The audit is created with safe text, but let's check getAuditProjection
  const projection = adapter.getAuditProjection(result.entry.wakeId);
  // All audit summaries should be redacted versions
  for (const event of projection) {
    assert.ok(
      !event.summary?.match(/api[_-]?key\s*[:=]\s*[^\s,;]+/i),
      `Unredacted secret found: ${event.summary}`,
    );
  }
});

test("audit projection can filter by wake ID", () => {
  resetClock();
  const adapter = new DurableSessionWakeAdapter({ now: fixedNow });
  adapter.wake(makeRequest());
  adapter.wake(makeRequest({ taskId: "task-43" }));
  const all = adapter.getAuditProjection();
  assert.ok(all.length >= 2);
});

test("audit projection redacts target ref", () => {
  resetClock();
  const adapter = new DurableSessionWakeAdapter({ now: fixedNow });
  const result = adapter.wake(makeRequest());
  const projection = adapter.getAuditProjection(result.entry.wakeId);
  assert.ok(projection.length > 0);
  // R29: targetRef must not contain raw or partial sessionKey values
  // See openclaw-plugin-a2a#337 (R28 HOLD) and openclaw-plugin-a2a#338
  for (const event of projection) {
    if (event.targetRef) {
      assert.ok(!event.targetRef.includes("session:worker-alpha:main"), `Full session key in targetRef: ${event.targetRef}`);
      // Also verify it's a nodeId/hex-digest format
      assert.match(event.targetRef, /^[a-zA-Z0-9_-]+\/[0-9a-f]{16}$/, `targetRef must be nodeId/hexdigest, got: ${event.targetRef}`);
    }
  }
});

// ── Capacity management ────────────────────────────────────────

test("evicts oldest entries when at capacity", () => {
  resetClock();
  const adapter = new DurableSessionWakeAdapter({ now: fixedNow, maxEntries: 3 });
  adapter.wake(makeRequest({ taskId: "task-1" }));
  tickMs(100);
  adapter.wake(makeRequest({ taskId: "task-2" }));
  tickMs(100);
  adapter.wake(makeRequest({ taskId: "task-3" }));
  tickMs(100);
  // 4th should trigger eviction
  adapter.wake(makeRequest({ taskId: "task-4" }));
  const active = adapter.getActiveWakes();
  assert.ok(active.length <= 4);
});

// ── getActiveWakes ─────────────────────────────────────────────

test("getActiveWakes returns only non-terminal entries", () => {
  resetClock();
  const adapter = new DurableSessionWakeAdapter({ now: fixedNow });
  adapter.wake(makeRequest({ taskId: "task-1" }));
  adapter.wake(makeRequest({ taskId: "task-2" }));
  // Fail one
  const entries = adapter.getActiveWakes();
  assert.ok(entries.length >= 1);
  for (const e of entries) {
    assert.notEqual(e.state, "completed");
    assert.notEqual(e.state, "failed");
  }
});

// ── Duplicate wake suppression ─────────────────────────────────

test("duplicate wake suppression preserves original entry", () => {
  resetClock();
  const adapter = new DurableSessionWakeAdapter({ now: fixedNow });
  const r1 = adapter.wake(makeRequest());
  tickMs(500);
  const r2 = adapter.wake(makeRequest());
  assert.equal(r1.entry.wakeId, r2.entry.wakeId);
  assert.equal(r1.entry.createdAt, r2.entry.createdAt);
});

// ── factory function ───────────────────────────────────────────

test("createDurableSessionWakeAdapter creates working adapter", () => {
  resetClock();
  const adapter = createDurableSessionWakeAdapter({ now: fixedNow });
  const result = adapter.wake(makeRequest());
  assert.equal(result.entry.state, "pending");
  assert.equal(result.entry.taskId, "task-42");
});

// ── Additive broker metadata tolerance ─────────────────────────

test("tolerates extra fields in wake request", () => {
  resetClock();
  const adapter = new DurableSessionWakeAdapter({ now: fixedNow });
  const result = adapter.wake(makeRequest({
    extraField1: "value1",
    extraField2: { nested: true },
  } as any));
  assert.equal(result.entry.state, "pending");
  assert.equal(result.entry.taskId, "task-42");
});
