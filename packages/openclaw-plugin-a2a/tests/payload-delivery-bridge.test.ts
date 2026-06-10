/**
 * Tests for payload-delivery-bridge (Round 21, plugin-a2a#100).
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  PayloadDeliveryAdapter,
  createPayloadDeliveryAdapter,
} from "../dist/src/payload-delivery-bridge.js";

// ── Helpers ────────────────────────────────────────────────────

let clockMs = 1700000000000;
function resetClock() { clockMs = 1700000000000; }
function tickMs(ms: number) { clockMs += ms; }
const fixedNow = () => new Date(clockMs);

function makeRequest(overrides = {}) {
  return {
    wakeId: "wake-001",
    taskId: "task-42",
    payload: "Execute task A2A-100 on remote node",
    targetSessionKey: "session:worker-alpha:main",
    targetNodeId: "worker-alpha-host",
    correlationId: "corr-001",
    deadline: new Date(clockMs + 30000).toISOString(),
    ...overrides,
  };
}

// ── Delivery creation ──────────────────────────────────────────

test("creates delivered entry from valid request", () => {
  resetClock();
  const adapter = new PayloadDeliveryAdapter({ now: fixedNow });
  const result = adapter.deliver(makeRequest());
  assert.equal(result.entry.state, "delivered");
  assert.equal(result.entry.taskId, "task-42");
  assert.equal(result.entry.targetNodeId, "worker-alpha-host");
  assert.equal(result.audit.toState, "delivered");
});

test("produces deterministic delivery ID", () => {
  resetClock();
  const a1 = new PayloadDeliveryAdapter({ now: fixedNow });
  const a2 = new PayloadDeliveryAdapter({ now: fixedNow });
  const r1 = a1.deliver(makeRequest());
  const r2 = a2.deliver(makeRequest());
  assert.equal(r1.entry.deliveryId, r2.entry.deliveryId);
});

test("different payloads produce different delivery IDs", () => {
  resetClock();
  const adapter = new PayloadDeliveryAdapter({ now: fixedNow });
  const r1 = adapter.deliver(makeRequest());
  const r2 = adapter.deliver(makeRequest({ payload: "Different payload" }));
  assert.notEqual(r1.entry.deliveryId, r2.entry.deliveryId);
});

test("fails on missing wakeId", () => {
  resetClock();
  const adapter = new PayloadDeliveryAdapter({ now: fixedNow });
  const result = adapter.deliver(makeRequest({ wakeId: "" }));
  assert.equal(result.entry.state, "failed");
});

test("fails on missing taskId", () => {
  resetClock();
  const adapter = new PayloadDeliveryAdapter({ now: fixedNow });
  const result = adapter.deliver(makeRequest({ taskId: "" }));
  assert.equal(result.entry.state, "failed");
});

test("fails on missing targetSessionKey", () => {
  resetClock();
  const adapter = new PayloadDeliveryAdapter({ now: fixedNow });
  const result = adapter.deliver(makeRequest({ targetSessionKey: "  " }));
  assert.equal(result.entry.state, "failed");
});

// ── Idempotent delivery ────────────────────────────────────────

test("suppresses duplicate delivery for same wake + payload", () => {
  resetClock();
  const adapter = new PayloadDeliveryAdapter({ now: fixedNow });
  const r1 = adapter.deliver(makeRequest());
  tickMs(100);
  const r2 = adapter.deliver(makeRequest());
  assert.equal(r1.entry.deliveryId, r2.entry.deliveryId);
  assert.equal(r2.audit.toState, "delivered"); // state unchanged
});

test("allows redelivery after failure", () => {
  resetClock();
  const adapter = new PayloadDeliveryAdapter({ now: fixedNow });
  const r1 = adapter.deliver(makeRequest());
  adapter.recordResult({ deliveryId: r1.entry.deliveryId, type: "failure", summary: "crashed" });
  tickMs(100);
  const r2 = adapter.deliver(makeRequest());
  // Should create new delivery after failure
  assert.equal(r2.entry.state, "delivered");
});

// ── Result marker recording ────────────────────────────────────

test("records success result marker", () => {
  resetClock();
  const adapter = new PayloadDeliveryAdapter({ now: fixedNow });
  const r = adapter.deliver(makeRequest());
  tickMs(100);
  const result = adapter.recordResult({
    deliveryId: r.entry.deliveryId,
    type: "success",
    summary: "Task completed successfully",
  });
  assert.ok(result);
  assert.equal(result.entry.state, "completed");
  assert.equal(result.audit.toState, "completed");
});

test("records failure result marker", () => {
  resetClock();
  const adapter = new PayloadDeliveryAdapter({ now: fixedNow });
  const r = adapter.deliver(makeRequest());
  tickMs(100);
  const result = adapter.recordResult({
    deliveryId: r.entry.deliveryId,
    type: "failure",
    summary: "Runtime error occurred",
  });
  assert.ok(result);
  assert.equal(result.entry.state, "failed");
});

test("records timeout result marker", () => {
  resetClock();
  const adapter = new PayloadDeliveryAdapter({ now: fixedNow });
  const r = adapter.deliver(makeRequest());
  tickMs(100);
  const result = adapter.recordResult({
    deliveryId: r.entry.deliveryId,
    type: "timeout",
  });
  assert.ok(result);
  assert.equal(result.entry.state, "timeout");
});

test("records partial result as completed with warning", () => {
  resetClock();
  const adapter = new PayloadDeliveryAdapter({ now: fixedNow });
  const r = adapter.deliver(makeRequest());
  tickMs(100);
  const result = adapter.recordResult({
    deliveryId: r.entry.deliveryId,
    type: "partial",
    summary: "Partial execution",
  });
  assert.ok(result);
  assert.equal(result.entry.state, "completed");
  assert.ok(result.entry.warnings.includes("partial result received"));
});

test("records stale session result marker", () => {
  resetClock();
  const adapter = new PayloadDeliveryAdapter({ now: fixedNow });
  const r = adapter.deliver(makeRequest());
  tickMs(100);
  const result = adapter.recordResult({
    deliveryId: r.entry.deliveryId,
    type: "stale",
  });
  assert.ok(result);
  assert.equal(result.entry.state, "stale_session");
});

test("returns null for unknown delivery ID", () => {
  resetClock();
  const adapter = new PayloadDeliveryAdapter({ now: fixedNow });
  const result = adapter.recordResult({ deliveryId: "nonexistent", type: "success" });
  assert.equal(result, null);
});

// ── Redaction ──────────────────────────────────────────────────

test("result projection strips rawMarkerText", () => {
  resetClock();
  const adapter = new PayloadDeliveryAdapter({ now: fixedNow });
  const r = adapter.deliver(makeRequest());
  adapter.recordResult({
    deliveryId: r.entry.deliveryId,
    type: "success",
    summary: "Done",
    rawMarkerText: "sensitive internal text with api_key=sk-123",
  });
  const projection = adapter.getResultProjection(r.entry.deliveryId);
  assert.equal(projection.length, 1);
  assert.equal(projection[0].rawMarkerText, undefined);
});

test("result projection redacts secrets in summary", () => {
  resetClock();
  const adapter = new PayloadDeliveryAdapter({ now: fixedNow });
  const r = adapter.deliver(makeRequest());
  adapter.recordResult({
    deliveryId: r.entry.deliveryId,
    type: "success",
    summary: "Completed with token=abc123",
  });
  const projection = adapter.getResultProjection(r.entry.deliveryId);
  assert.ok(projection[0].summary?.includes("[redacted]"));
  assert.ok(!projection[0].summary?.includes("abc123"));
});

test("audit projection redacts target refs", () => {
  resetClock();
  const adapter = new PayloadDeliveryAdapter({ now: fixedNow });
  adapter.deliver(makeRequest());
  const audit = adapter.getAuditProjection();
  assert.ok(audit.length > 0);
  for (const e of audit) {
    if (e.targetRef) {
      // R29: targetRef must not contain raw or partial sessionKey values
      assert.ok(!e.targetRef.includes("session:worker-alpha:main"), `Full session key leaked: ${e.targetRef}`);
      // Also verify it's a hex digest format (nodeId/16-hex-chars)
      // plugin-a2a#338
      assert.match(e.targetRef, /^[a-zA-Z0-9_-]+\/[0-9a-f]{16}$/, `targetRef must be nodeId/hexdigest, got: ${e.targetRef}`);
    }
  }
});

test("no raw transcript leakage in projection", () => {
  resetClock();
  const adapter = new PayloadDeliveryAdapter({ now: fixedNow });
  const r = adapter.deliver(makeRequest({
    payload: "session content: this should not appear anywhere",
  }));
  adapter.recordResult({
    deliveryId: r.entry.deliveryId,
    type: "success",
    summary: "session: secret_data_here",
  });
  const projection = adapter.getResultProjection(r.entry.deliveryId);
  const audit = adapter.getAuditProjection(r.entry.deliveryId);

  for (const m of projection) {
    assert.ok(!m.summary?.includes("secret_data_here"), `Leak in result projection: ${m.summary}`);
  }
  for (const a of audit) {
    assert.ok(!a.summary?.includes("secret_data_here"), `Leak in audit: ${a.summary}`);
  }
});

// ── Timeout handling ───────────────────────────────────────────

test("checkTimeouts transitions expired deliveries", () => {
  resetClock();
  const adapter = new PayloadDeliveryAdapter({ now: fixedNow });
  adapter.deliver(makeRequest({
    deadline: new Date(clockMs + 1000).toISOString(),
  }));
  tickMs(2000); // past deadline
  const transitions = adapter.checkTimeouts();
  assert.equal(transitions.length, 1);
  assert.equal(transitions[0].entry.state, "timeout");
});

test("checkTimeouts skips non-expired deliveries", () => {
  resetClock();
  const adapter = new PayloadDeliveryAdapter({ now: fixedNow });
  adapter.deliver(makeRequest({
    deadline: new Date(clockMs + 60000).toISOString(),
  }));
  tickMs(1000);
  const transitions = adapter.checkTimeouts();
  assert.equal(transitions.length, 0);
});

test("checkTimeouts skips entries without deadline", () => {
  resetClock();
  const adapter = new PayloadDeliveryAdapter({ now: fixedNow });
  adapter.deliver(makeRequest({ deadline: undefined }));
  tickMs(60000);
  const transitions = adapter.checkTimeouts();
  assert.equal(transitions.length, 0);
});

// ── Stale session handling ─────────────────────────────────────

test("markStaleSession transitions delivered entries for session", () => {
  resetClock();
  const adapter = new PayloadDeliveryAdapter({ now: fixedNow });
  adapter.deliver(makeRequest({ targetSessionKey: "session:stale:main" }));
  const transitions = adapter.markStaleSession("session:stale:main");
  assert.equal(transitions.length, 1);
  assert.equal(transitions[0].entry.state, "stale_session");
});

test("markStaleSession does not affect other sessions", () => {
  resetClock();
  const adapter = new PayloadDeliveryAdapter({ now: fixedNow });
  adapter.deliver(makeRequest({ targetSessionKey: "session:active:main" }));
  const transitions = adapter.markStaleSession("session:other:main");
  assert.equal(transitions.length, 0);
});

test("markStaleSession skips completed entries", () => {
  resetClock();
  const adapter = new PayloadDeliveryAdapter({ now: fixedNow });
  const r = adapter.deliver(makeRequest({ targetSessionKey: "session:done:main" }));
  adapter.recordResult({ deliveryId: r.entry.deliveryId, type: "success" });
  const transitions = adapter.markStaleSession("session:done:main");
  assert.equal(transitions.length, 0);
});

// ── Additive metadata tolerance ────────────────────────────────

test("tolerates extra broker metadata fields", () => {
  resetClock();
  const adapter = new PayloadDeliveryAdapter({ now: fixedNow });
  const result = adapter.deliver(makeRequest({
    brokerMetadata: { region: "ap-northeast", priority: "high" },
    routingHint: "direct",
  }));
  assert.equal(result.entry.state, "delivered");
});

// ── Compatibility with durable wake adapter ────────────────────

test("delivery entry preserves wake reference", () => {
  resetClock();
  const adapter = new PayloadDeliveryAdapter({ now: fixedNow });
  const result = adapter.deliver(makeRequest());
  assert.equal(result.entry.wakeId, "wake-001");
  assert.equal(result.entry.correlationId, "corr-001");
});

// ── Factory function ───────────────────────────────────────────

test("createPayloadDeliveryAdapter creates working adapter", () => {
  resetClock();
  const adapter = createPayloadDeliveryAdapter({ now: fixedNow });
  const result = adapter.deliver(makeRequest());
  assert.equal(result.entry.state, "delivered");
});

// ── Capacity management ────────────────────────────────────────

test("evicts terminal entries at capacity", () => {
  resetClock();
  const adapter = new PayloadDeliveryAdapter({ now: fixedNow, maxDeliveries: 2 });
  adapter.deliver(makeRequest({ taskId: "t1" }));
  adapter.deliver(makeRequest({ taskId: "t2" }));
  // Mark one as completed
  const entry = adapter.getEntry(
    adapter.deliver(makeRequest({ taskId: "t1" })).entry.deliveryId,
  );
  // Third delivery should still work (evicts completed)
  const r3 = adapter.deliver(makeRequest({ taskId: "t3" }));
  assert.equal(r3.entry.state, "delivered");
});
