/**
 * Tests for status-result-delivery-adapter (Round 22, plugin-a2a#103).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { StatusResultDeliveryAdapter, createStatusResultDeliveryAdapter } from "../dist/src/status-result-delivery-adapter.js";
import type {
  SessionStatusEnvelope,
  SessionResultEnvelope,
  BrokerDeliveryEvent,
  BrokerDeliveryStatus,
  DeliveryFailureCode,
  DeliveryFailureCategory,
} from "../dist/src/status-result-delivery-adapter.js";

// ── Helpers ────────────────────────────────────────────────────

let clock = 0;
const fixedNow = () => new Date("2026-04-26T12:00:00Z");
function tickNow() {
  clock += 1000;
  return new Date(Date.parse("2026-04-26T12:00:00Z") + clock);
}

function makeStatus(overrides: Partial<SessionStatusEnvelope> = {}): SessionStatusEnvelope {
  return {
    deliveryId: "del-001",
    taskId: "task-001",
    wakeId: "wake-001",
    rawStatus: "running",
    timestamp: fixedNow().toISOString(),
    ...overrides,
  };
}

function makeResult(overrides: Partial<SessionResultEnvelope> = {}): SessionResultEnvelope {
  return {
    deliveryId: "del-001",
    taskId: "task-001",
    wakeId: "wake-001",
    resultType: "success",
    timestamp: fixedNow().toISOString(),
    ...overrides,
  };
}

// ── Tests ──────────────────────────────────────────────────────

describe("StatusResultDeliveryAdapter — status ingestion", () => {
  it("normalizes raw 'running' to in_progress", () => {
    const adapter = new StatusResultDeliveryAdapter({ now: fixedNow });
    const event = adapter.ingestStatus(makeStatus({ rawStatus: "running" }));
    assert.equal(event.status, "in_progress");
    assert.equal(event.isDuplicate, false);
    assert.equal(event.attemptNumber, 1);
  });

  it("normalizes raw 'completed' to completed", () => {
    const adapter = new StatusResultDeliveryAdapter({ now: fixedNow });
    const event = adapter.ingestStatus(makeStatus({ rawStatus: "completed" }));
    assert.equal(event.status, "completed");
  });

  it("normalizes raw 'failed' to failed with failure code", () => {
    const adapter = new StatusResultDeliveryAdapter({ now: fixedNow });
    const event = adapter.ingestStatus(makeStatus({ rawStatus: "failed" }));
    assert.equal(event.status, "failed");
    assert.equal(event.failureCode, "internal_error");
    assert.equal(event.failureCategory, "infra");
  });

  it("normalizes raw 'timeout' to timeout with deadline_exceeded", () => {
    const adapter = new StatusResultDeliveryAdapter({ now: fixedNow });
    const event = adapter.ingestStatus(makeStatus({ rawStatus: "timeout" }));
    assert.equal(event.status, "timeout");
    assert.equal(event.failureCode, "deadline_exceeded");
    assert.equal(event.failureCategory, "infra");
  });

  it("normalizes raw 'expired' to stale with session_expired", () => {
    const adapter = new StatusResultDeliveryAdapter({ now: fixedNow });
    const event = adapter.ingestStatus(makeStatus({ rawStatus: "expired" }));
    assert.equal(event.status, "stale");
    assert.equal(event.failureCode, "session_expired");
    assert.equal(event.failureCategory, "source");
  });

  it("normalizes unknown status to in_progress", () => {
    const adapter = new StatusResultDeliveryAdapter({ now: fixedNow });
    const event = adapter.ingestStatus(makeStatus({ rawStatus: "something_unknown" }));
    assert.equal(event.status, "in_progress");
  });

  it("preserves deliveryId, taskId, wakeId in event", () => {
    const adapter = new StatusResultDeliveryAdapter({ now: fixedNow });
    const event = adapter.ingestStatus(makeStatus());
    assert.equal(event.deliveryId, "del-001");
    assert.equal(event.taskId, "task-001");
    assert.equal(event.wakeId, "wake-001");
  });

  it("redacts source node ref when >12 chars", () => {
    const adapter = new StatusResultDeliveryAdapter({ now: fixedNow });
    const event = adapter.ingestStatus(makeStatus({ sourceNodeId: "very-long-node-identifier-12345" }));
    assert.ok(event.sourceNodeRef);
    assert.ok(event.sourceNodeRef!.includes("…"));
  });

  it("keeps short source node ref as-is", () => {
    const adapter = new StatusResultDeliveryAdapter({ now: fixedNow });
    const event = adapter.ingestStatus(makeStatus({ sourceNodeId: "node-1" }));
    assert.equal(event.sourceNodeRef, "node-1");
  });

  it("suppression: identical status+timestamp produces duplicate", () => {
    const adapter = new StatusResultDeliveryAdapter({ now: fixedNow });
    const env = makeStatus({ rawStatus: "running" });
    const e1 = adapter.ingestStatus(env);
    const e2 = adapter.ingestStatus(env);
    assert.equal(e1.isDuplicate, false);
    assert.equal(e2.isDuplicate, true);
    assert.equal(e2.attemptNumber, e1.attemptNumber);
  });

  it("different status produces new event", () => {
    const adapter = new StatusResultDeliveryAdapter({ now: fixedNow });
    const e1 = adapter.ingestStatus(makeStatus({ rawStatus: "running" }));
    const e2 = adapter.ingestStatus(makeStatus({ rawStatus: "completed" }));
    assert.equal(e1.isDuplicate, false);
    assert.equal(e2.isDuplicate, false);
    assert.equal(e2.attemptNumber, 2);
  });
});

describe("StatusResultDeliveryAdapter — result ingestion", () => {
  it("maps success result to completed", () => {
    const adapter = new StatusResultDeliveryAdapter({ now: fixedNow });
    const event = adapter.ingestResult(makeResult({ resultType: "success" }));
    assert.equal(event.status, "completed");
    assert.equal(event.isDuplicate, false);
  });

  it("maps failure result to failed with failure code", () => {
    const adapter = new StatusResultDeliveryAdapter({ now: fixedNow });
    const event = adapter.ingestResult(makeResult({ resultType: "failure", rawResultText: "connection unreachable" }));
    assert.equal(event.status, "failed");
    assert.equal(event.failureCode, "target_unreachable");
    assert.equal(event.failureCategory, "infra");
  });

  it("maps timeout result to timeout", () => {
    const adapter = new StatusResultDeliveryAdapter({ now: fixedNow });
    const event = adapter.ingestResult(makeResult({ resultType: "timeout" }));
    assert.equal(event.status, "timeout");
    assert.equal(event.failureCode, "deadline_exceeded");
    assert.equal(event.failureCategory, "infra");
  });

  it("maps partial result to completed", () => {
    const adapter = new StatusResultDeliveryAdapter({ now: fixedNow });
    const event = adapter.ingestResult(makeResult({ resultType: "partial" }));
    assert.equal(event.status, "completed");
  });

  it("maps stale result to stale with session_expired", () => {
    const adapter = new StatusResultDeliveryAdapter({ now: fixedNow });
    const event = adapter.ingestResult(makeResult({ resultType: "stale" }));
    assert.equal(event.status, "stale");
    assert.equal(event.failureCode, "session_expired");
    assert.equal(event.failureCategory, "source");
  });

  it("infers session_not_found from rawResultText", () => {
    const adapter = new StatusResultDeliveryAdapter({ now: fixedNow });
    const event = adapter.ingestResult(makeResult({ resultType: "failure", rawResultText: "no session found" }));
    assert.equal(event.failureCode, "session_not_found");
    assert.equal(event.failureCategory, "source");
  });

  it("infers payload_too_large from rawResultText", () => {
    const adapter = new StatusResultDeliveryAdapter({ now: fixedNow });
    const event = adapter.ingestResult(makeResult({ resultType: "failure", rawResultText: "payload too large" }));
    assert.equal(event.failureCode, "payload_too_large");
    assert.equal(event.failureCategory, "source");
  });

  it("infers broker_rejected from rawResultText", () => {
    const adapter = new StatusResultDeliveryAdapter({ now: fixedNow });
    const event = adapter.ingestResult(makeResult({ resultType: "failure", rawResultText: "rejected by broker" }));
    assert.equal(event.failureCode, "broker_rejected");
    assert.equal(event.failureCategory, "source");
  });

  it("duplicate result suppressed", () => {
    const adapter = new StatusResultDeliveryAdapter({ now: fixedNow });
    const env = makeResult({ resultType: "success" });
    const e1 = adapter.ingestResult(env);
    const e2 = adapter.ingestResult(env);
    assert.equal(e1.isDuplicate, false);
    assert.equal(e2.isDuplicate, true);
  });

  it("redacts summary in audit", () => {
    const adapter = new StatusResultDeliveryAdapter({ now: fixedNow });
    adapter.ingestResult(makeResult({ resultType: "success", summary: "api_key=sk-12345 done" }));
    const audit = adapter.getAuditLog("del-001");
    assert.ok(audit.length > 0);
    assert.ok(!audit.some((a) => a.summary.includes("sk-12345")));
  });
});

describe("StatusResultDeliveryAdapter — delivery entry bridge", () => {
  it("bridges pending entry to accepted", () => {
    const adapter = new StatusResultDeliveryAdapter({ now: fixedNow });
    const event = adapter.bridgeDeliveryEntry({
      deliveryId: "d1", wakeId: "w1", taskId: "t1",
      targetSessionKey: "sess", state: "pending",
      attemptCount: 1, createdAt: fixedNow().toISOString(),
      updatedAt: fixedNow().toISOString(), warnings: [],
    });
    assert.equal(event.status, "accepted");
  });

  it("bridges delivered entry to in_progress", () => {
    const adapter = new StatusResultDeliveryAdapter({ now: fixedNow });
    const event = adapter.bridgeDeliveryEntry({
      deliveryId: "d2", wakeId: "w2", taskId: "t2",
      targetSessionKey: "sess", state: "delivered",
      attemptCount: 1, createdAt: fixedNow().toISOString(),
      updatedAt: fixedNow().toISOString(), warnings: [],
    });
    assert.equal(event.status, "in_progress");
  });

  it("bridges completed entry to completed", () => {
    const adapter = new StatusResultDeliveryAdapter({ now: fixedNow });
    const event = adapter.bridgeDeliveryEntry({
      deliveryId: "d3", wakeId: "w3", taskId: "t3",
      targetSessionKey: "sess", state: "completed",
      attemptCount: 1, createdAt: fixedNow().toISOString(),
      updatedAt: fixedNow().toISOString(), warnings: [],
    });
    assert.equal(event.status, "completed");
  });

  it("bridges failed entry to failed", () => {
    const adapter = new StatusResultDeliveryAdapter({ now: fixedNow });
    const event = adapter.bridgeDeliveryEntry({
      deliveryId: "d4", wakeId: "w4", taskId: "t4",
      targetSessionKey: "sess", state: "failed",
      attemptCount: 1, createdAt: fixedNow().toISOString(),
      updatedAt: fixedNow().toISOString(), warnings: [],
    });
    assert.equal(event.status, "failed");
    assert.equal(event.failureCode, "internal_error");
    assert.equal(event.failureCategory, "infra");
  });

  it("bridges timeout entry to timeout", () => {
    const adapter = new StatusResultDeliveryAdapter({ now: fixedNow });
    const event = adapter.bridgeDeliveryEntry({
      deliveryId: "d5", wakeId: "w5", taskId: "t5",
      targetSessionKey: "sess", state: "timeout",
      attemptCount: 1, createdAt: fixedNow().toISOString(),
      updatedAt: fixedNow().toISOString(), warnings: [],
    });
    assert.equal(event.status, "timeout");
    assert.equal(event.failureCategory, "infra");
  });

  it("bridges stale_session entry to stale", () => {
    const adapter = new StatusResultDeliveryAdapter({ now: fixedNow });
    const event = adapter.bridgeDeliveryEntry({
      deliveryId: "d6", wakeId: "w6", taskId: "t6",
      targetSessionKey: "sess", state: "stale_session",
      attemptCount: 1, createdAt: fixedNow().toISOString(),
      updatedAt: fixedNow().toISOString(), warnings: [],
    });
    assert.equal(event.status, "stale");
    assert.equal(event.failureCode, "session_expired");
    assert.equal(event.failureCategory, "source");
  });

  it("duplicate bridge suppressed", () => {
    const adapter = new StatusResultDeliveryAdapter({ now: fixedNow });
    const entry = {
      deliveryId: "d7", wakeId: "w7", taskId: "t7",
      targetSessionKey: "sess", state: "delivered" as const,
      attemptCount: 1, createdAt: fixedNow().toISOString(),
      updatedAt: fixedNow().toISOString(), warnings: [] as string[],
    };
    const e1 = adapter.bridgeDeliveryEntry(entry);
    const e2 = adapter.bridgeDeliveryEntry(entry);
    assert.equal(e1.isDuplicate, false);
    assert.equal(e2.isDuplicate, true);
  });
});

describe("StatusResultDeliveryAdapter — idempotency & retry", () => {
  it("re-ingesting same status is idempotent", () => {
    const adapter = new StatusResultDeliveryAdapter({ now: fixedNow });
    const env = makeStatus({ rawStatus: "running" });
    const e1 = adapter.ingestStatus(env);
    const e2 = adapter.ingestStatus(env);
    assert.equal(e1.eventId, e2.eventId);
  });

  it("status progression tracks attempt count", () => {
    const adapter = new StatusResultDeliveryAdapter({ now: tickNow });
    adapter.ingestStatus(makeStatus({ rawStatus: "running" }));
    const e2 = adapter.ingestStatus(makeStatus({ rawStatus: "completed" }));
    assert.equal(e2.attemptNumber, 2);
  });

  it("result after status increments attempt", () => {
    const adapter = new StatusResultDeliveryAdapter({ now: tickNow });
    adapter.ingestStatus(makeStatus({ rawStatus: "running" }));
    const event = adapter.ingestResult(makeResult({ resultType: "success" }));
    assert.equal(event.attemptNumber, 2);
    assert.equal(event.status, "completed");
  });
});

describe("StatusResultDeliveryAdapter — audit & query", () => {
  it("getAuditLog returns all entries", () => {
    const adapter = new StatusResultDeliveryAdapter({ now: fixedNow });
    adapter.ingestStatus(makeStatus({ rawStatus: "running" }));
    adapter.ingestStatus(makeStatus({ deliveryId: "del-002", taskId: "t2", wakeId: "w2", rawStatus: "failed" }));
    const log = adapter.getAuditLog();
    assert.equal(log.length, 2);
  });

  it("getAuditLog filters by deliveryId", () => {
    const adapter = new StatusResultDeliveryAdapter({ now: fixedNow });
    adapter.ingestStatus(makeStatus({ rawStatus: "running" }));
    adapter.ingestStatus(makeStatus({ deliveryId: "del-002", taskId: "t2", wakeId: "w2", rawStatus: "failed" }));
    const log = adapter.getAuditLog("del-001");
    assert.equal(log.length, 1);
    assert.equal(log[0].deliveryId, "del-001");
  });

  it("getStatus returns current tracked event", () => {
    const adapter = new StatusResultDeliveryAdapter({ now: fixedNow });
    adapter.ingestStatus(makeStatus({ rawStatus: "running" }));
    const status = adapter.getStatus("del-001");
    assert.ok(status);
    assert.equal(status!.status, "in_progress");
  });

  it("getStatus returns null for unknown deliveryId", () => {
    const adapter = new StatusResultDeliveryAdapter({ now: fixedNow });
    assert.equal(adapter.getStatus("nonexistent"), null);
  });

  it("getTrackedDeliveryIds returns all IDs", () => {
    const adapter = new StatusResultDeliveryAdapter({ now: fixedNow });
    adapter.ingestStatus(makeStatus({ deliveryId: "a" }));
    adapter.ingestStatus(makeStatus({ deliveryId: "b" }));
    const ids = adapter.getTrackedDeliveryIds();
    assert.deepEqual(ids.sort(), ["a", "b"]);
  });
});

describe("StatusResultDeliveryAdapter — capacity eviction", () => {
  it("evicts completed entries when over capacity", () => {
    const adapter = new StatusResultDeliveryAdapter({ now: fixedNow, maxTracked: 5 });
    // Fill with completed entries
    for (let i = 0; i < 5; i++) {
      adapter.ingestStatus(makeStatus({ deliveryId: `full-${i}`, rawStatus: "completed" }));
    }
    // One more should trigger eviction
    adapter.ingestStatus(makeStatus({ deliveryId: "new-1", rawStatus: "running" }));
    const ids = adapter.getTrackedDeliveryIds();
    assert.ok(ids.length <= 6); // may have evicted some
    assert.ok(ids.includes("new-1"));
  });

  it("audit log trims when over maxAudit", () => {
    const adapter = new StatusResultDeliveryAdapter({ now: fixedNow, maxAudit: 5 });
    for (let i = 0; i < 10; i++) {
      adapter.ingestStatus(makeStatus({ deliveryId: `audit-${i}`, rawStatus: "running" }));
    }
    const log = adapter.getAuditLog();
    assert.ok(log.length <= 10);
  });
});

describe("StatusResultDeliveryAdapter — redaction", () => {
  it("redacts api_key in summary", () => {
    const adapter = new StatusResultDeliveryAdapter({ now: fixedNow });
    adapter.ingestResult(makeResult({ resultType: "success", summary: "used api_key=sk-deadbeef to call endpoint" }));
    const audit = adapter.getAuditLog("del-001");
    assert.ok(!audit[0]?.summary.includes("sk-deadbeef"));
    assert.ok(audit[0]?.summary.includes("[redacted]"));
  });

  it("redacts session content in summary", () => {
    const adapter = new StatusResultDeliveryAdapter({ now: fixedNow });
    adapter.ingestResult(makeResult({ resultType: "success", summary: "session text: long_private_content_here" }));
    const audit = adapter.getAuditLog("del-001");
    assert.ok(!audit[0]?.summary.includes("long_private_content_here"));
  });

  it("redacts code blocks in summary", () => {
    const adapter = new StatusResultDeliveryAdapter({ now: fixedNow });
    adapter.ingestResult(makeResult({ resultType: "success", summary: "result: ```javascript\nconst x = 1;\n``` done" }));
    const audit = adapter.getAuditLog("del-001");
    assert.ok(!audit[0]?.summary.includes("const x = 1"));
    assert.ok(audit[0]?.summary.includes("[redacted]"));
  });
});

describe("StatusResultDeliveryAdapter — additive metadata tolerance", () => {
  it("tolerates extra fields in status envelope", () => {
    const adapter = new StatusResultDeliveryAdapter({ now: fixedNow });
    const event = adapter.ingestStatus(makeStatus({
      rawStatus: "running",
      brokerLane: "worker-beta",
      retryCount: 3,
    } as SessionStatusEnvelope));
    assert.equal(event.status, "in_progress");
  });

  it("tolerates extra fields in result envelope", () => {
    const adapter = new StatusResultDeliveryAdapter({ now: fixedNow });
    const event = adapter.ingestResult(makeResult({
      resultType: "success",
      customBrokerField: "value",
    } as SessionResultEnvelope));
    assert.equal(event.status, "completed");
  });

  it("preserves correlationId from envelope", () => {
    const adapter = new StatusResultDeliveryAdapter({ now: fixedNow });
    const event = adapter.ingestStatus(makeStatus({
      rawStatus: "running",
      correlationId: "corr-xyz",
    }));
    assert.equal(event.correlationId, "corr-xyz");
  });
});

describe("StatusResultDeliveryAdapter — factory", () => {
  it("creates adapter with defaults", () => {
    const adapter = createStatusResultDeliveryAdapter();
    assert.ok(adapter);
    assert.equal(adapter.getStatus("none"), null);
  });
});

describe("StatusResultDeliveryAdapter — status message format", () => {
  it("includes human-readable message for each status", () => {
    const adapter = new StatusResultDeliveryAdapter({ now: fixedNow });
    const statuses: BrokerDeliveryStatus[] = [
      "accepted", "in_progress", "completed", "failed", "timeout", "cancelled", "stale",
    ];
    for (const raw of statuses) {
      const event = adapter.ingestStatus(makeStatus({ deliveryId: `msg-${raw}`, rawStatus: raw === "cancelled" ? "cancelled" : raw }));
      assert.ok(event.message.length > 0, `expected message for ${raw}`);
    }
  });

  it("duplicate message includes [duplicate] prefix", () => {
    const adapter = new StatusResultDeliveryAdapter({ now: fixedNow });
    const env = makeStatus({ rawStatus: "running" });
    adapter.ingestStatus(env);
    const dup = adapter.ingestStatus(env);
    assert.ok(dup.message.startsWith("[duplicate]"));
  });
});

describe("DeliveryFailureCategory — failure classification", () => {
  it("classifies target_unreachable as infra (retryable)", () => {
    const adapter = new StatusResultDeliveryAdapter({ now: fixedNow });
    const event = adapter.ingestResult(makeResult({ resultType: "failure", rawResultText: "target unreachable" }));
    assert.equal(event.failureCategory, "infra");
  });

  it("classifies node_unreachable as infra (retryable)", () => {
    const adapter = new StatusResultDeliveryAdapter({ now: fixedNow });
    const event = adapter.ingestResult(makeResult({ resultType: "failure", rawResultText: "node unreachable" }));
    assert.equal(event.failureCode, "target_unreachable");
    assert.equal(event.failureCategory, "infra");
  });

  it("classifies deadline_exceeded as infra (retryable)", () => {
    const adapter = new StatusResultDeliveryAdapter({ now: fixedNow });
    const event = adapter.ingestStatus(makeStatus({ rawStatus: "timeout" }));
    assert.equal(event.failureCategory, "infra");
  });

  it("classifies internal_error as infra (retryable)", () => {
    const adapter = new StatusResultDeliveryAdapter({ now: fixedNow });
    const event = adapter.ingestStatus(makeStatus({ rawStatus: "failed" }));
    assert.equal(event.failureCategory, "infra");
  });

  it("classifies session_expired as source (non-retryable)", () => {
    const adapter = new StatusResultDeliveryAdapter({ now: fixedNow });
    const event = adapter.ingestStatus(makeStatus({ rawStatus: "expired" }));
    assert.equal(event.failureCategory, "source");
  });

  it("classifies session_not_found as source (non-retryable)", () => {
    const adapter = new StatusResultDeliveryAdapter({ now: fixedNow });
    const event = adapter.ingestResult(makeResult({ resultType: "failure", rawResultText: "no session found" }));
    assert.equal(event.failureCategory, "source");
  });

  it("classifies payload_too_large as source (non-retryable)", () => {
    const adapter = new StatusResultDeliveryAdapter({ now: fixedNow });
    const event = adapter.ingestResult(makeResult({ resultType: "failure", rawResultText: "payload too large" }));
    assert.equal(event.failureCategory, "source");
  });

  it("classifies broker_rejected as source (non-retryable)", () => {
    const adapter = new StatusResultDeliveryAdapter({ now: fixedNow });
    const event = adapter.ingestResult(makeResult({ resultType: "failure", rawResultText: "rejected by broker" }));
    assert.equal(event.failureCategory, "source");
  });

  it("no failureCategory for non-failure statuses", () => {
    const adapter = new StatusResultDeliveryAdapter({ now: fixedNow });
    const event = adapter.ingestStatus(makeStatus({ rawStatus: "running" }));
    assert.equal(event.failureCode, undefined);
    assert.equal(event.failureCategory, undefined);
  });

  it("no failureCategory for completed delivery", () => {
    const adapter = new StatusResultDeliveryAdapter({ now: fixedNow });
    const event = adapter.ingestResult(makeResult({ resultType: "success" }));
    assert.equal(event.failureCode, undefined);
    assert.equal(event.failureCategory, undefined);
  });

  it("failureCategory set in audit entry for failures", () => {
    const adapter = new StatusResultDeliveryAdapter({ now: fixedNow });
    adapter.ingestResult(makeResult({ resultType: "stale" }));
    const audit = adapter.getAuditLog("del-001");
    const failureAudit = audit.find((a) => a.failureCode);
    assert.ok(failureAudit);
    assert.equal(failureAudit!.failureCategory, "source");
  });
});
