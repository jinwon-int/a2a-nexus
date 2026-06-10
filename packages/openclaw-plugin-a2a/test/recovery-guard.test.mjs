/**
 * Termux/mobile-safe recovery loop tests.
 *
 * Closes jinwon-int/plugin-a2a#77.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createRecoveryGuard } from "../dist/src/recovery-guard.js";

function createClockableGuard(options = {}) {
  let t = 0;
  const clock = () => t;
  const guard = createRecoveryGuard({ ...options, nowMs: clock });
  return { guard, advance: (ms) => { t += ms; } };
}

describe("T1 — new action allowed", () => {
  it("allows a new recovery action", () => {
    const guard = createRecoveryGuard();
    const result = guard.evaluate({
      actionId: "action-1",
      kind: "cancel",
      taskId: "task-1",
    });
    assert.equal(result.allowed, true);
    assert.equal(result.dedup, false);
  });
});

describe("T2 — duplicate action deduplicated", () => {
  it("deduplicates a running action", () => {
    const guard = createRecoveryGuard();
    guard.evaluate({ actionId: "dup-1", kind: "cancel", taskId: "task-1" });
    guard.start("dup-1");
    const result = guard.evaluate({ actionId: "dup-1", kind: "cancel", taskId: "task-1" });
    assert.equal(result.allowed, true);
    assert.equal(result.dedup, true);
  });

  it("deduplicates a completed action", () => {
    const guard = createRecoveryGuard();
    guard.evaluate({ actionId: "dup-2", kind: "requeue", taskId: "task-2" });
    guard.start("dup-2");
    guard.complete("dup-2");
    const result = guard.evaluate({ actionId: "dup-2", kind: "requeue", taskId: "task-2" });
    assert.equal(result.allowed, true);
    assert.equal(result.dedup, true);
  });
});

describe("T3 — concurrency limit enforced", () => {
  it("blocks when max concurrent is reached", () => {
    const guard = createRecoveryGuard({ maxConcurrent: 1 });
    guard.evaluate({ actionId: "c-1", kind: "cancel", taskId: "task-1" });
    guard.start("c-1");
    const result = guard.evaluate({ actionId: "c-2", kind: "requeue", taskId: "task-2" });
    assert.equal(result.allowed, false);
    assert.ok(result.reason.includes("Max concurrent"));
  });

  it("allows after completing an action", () => {
    const guard = createRecoveryGuard({ maxConcurrent: 1 });
    guard.evaluate({ actionId: "c-3", kind: "cancel", taskId: "task-1" });
    guard.start("c-3");
    guard.complete("c-3");
    const result = guard.evaluate({ actionId: "c-4", kind: "requeue", taskId: "task-2" });
    assert.equal(result.allowed, true);
  });
});

describe("T4 — retry backoff with jitter", () => {
  it("blocks retry until backoff elapses", () => {
    const { guard, advance } = createClockableGuard({
      retryPolicy: { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 5000, jitterFactor: 0 },
    });
    guard.evaluate({ actionId: "retry-1", kind: "requeue", taskId: "task-1" });
    guard.start("retry-1");
    guard.fail("retry-1", "transient error");
    const blocked = guard.evaluate({ actionId: "retry-1", kind: "requeue", taskId: "task-1" });
    assert.equal(blocked.allowed, false);
    assert.ok(blocked.reason.includes("Retry backoff"));
    advance(2000);
    const allowed = guard.evaluate({ actionId: "retry-1", kind: "requeue", taskId: "task-1" });
    assert.equal(allowed.allowed, true);
  });

  it("exponential backoff increases delay", () => {
    const { guard, advance } = createClockableGuard({
      retryPolicy: { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 10000, jitterFactor: 0 },
    });
    guard.evaluate({ actionId: "exp-1", kind: "requeue", taskId: "task-1" });
    guard.start("exp-1");
    guard.fail("exp-1", "error 1");
    advance(1001);
    guard.start("exp-1");
    guard.fail("exp-1", "error 2");
    const delay = guard.nextRetryDelayMs("exp-1");
    assert.ok(delay > 1500, `Expected ~2000ms delay, got ${delay}`);
  });
});

describe("T5 — max attempts exhausted", () => {
  it("abandons after max attempts", () => {
    const { guard, advance } = createClockableGuard({
      retryPolicy: { maxAttempts: 2, baseDelayMs: 100, maxDelayMs: 1000, jitterFactor: 0 },
    });
    guard.evaluate({ actionId: "max-1", kind: "cancel", taskId: "task-1" });
    guard.start("max-1");
    guard.fail("max-1", "error 1");
    advance(200);
    guard.evaluate({ actionId: "max-1", kind: "cancel", taskId: "task-1" });
    guard.start("max-1");
    guard.fail("max-1", "error 2");
    assert.equal(guard.canRetry("max-1"), false);
  });
});

describe("T6 — action timeout", () => {
  it("abandons running actions after timeout", () => {
    const { guard, advance } = createClockableGuard({ actionTimeoutMs: 5000 });
    guard.evaluate({ actionId: "timeout-1", kind: "requeue", taskId: "task-1" });
    guard.start("timeout-1");
    advance(6000);
    const st = guard.status();
    assert.equal(st.totalTimedOut, 1);
  });
});

describe("T7 — mobile profile", () => {
  it("uses conservative defaults when mobile is true", () => {
    const guard = createRecoveryGuard({ nodeProfile: { isMobile: true } });
    const st = guard.status();
    assert.equal(st.nodeProfile.isMobile, true);
    assert.equal(st.retryPolicy.maxAttempts, 2);
    assert.ok(st.retryPolicy.baseDelayMs >= 2000);
  });

  it("uses standard defaults when not mobile", () => {
    const guard = createRecoveryGuard({
      nodeProfile: { isMobile: false, isLowResource: false },
    });
    const st = guard.status();
    assert.equal(st.retryPolicy.maxAttempts, 5);
  });
});

describe("T8 — status snapshot", () => {
  it("reports accurate counts", () => {
    const guard = createRecoveryGuard({ maxConcurrent: 3 });
    guard.evaluate({ actionId: "s-1", kind: "cancel", taskId: "task-1" });
    guard.evaluate({ actionId: "s-2", kind: "requeue", taskId: "task-2" });
    guard.start("s-1");
    const st = guard.status();
    assert.equal(st.activeCount, 1);
    assert.equal(st.pendingCount, 1);
    assert.equal(st.totalAttempted, 2);
  });
});

describe("T9 — record purge", () => {
  it("purges completed records after retention", () => {
    const { guard, advance } = createClockableGuard({ recordRetentionMs: 1000 });
    guard.evaluate({ actionId: "p-1", kind: "cancel", taskId: "task-1" });
    guard.start("p-1");
    guard.complete("p-1");
    advance(1500);
    const purged = guard.purge();
    assert.ok(purged >= 1);
  });
});

describe("T10 — offline/reconnect duplicate wake", () => {
  it("does not create duplicate destructive actions on reconnect", () => {
    const guard = createRecoveryGuard({ maxConcurrent: 2 });
    const r1 = guard.evaluate({ actionId: "wake-cancel-task-1", kind: "cancel", taskId: "task-1" });
    assert.equal(r1.dedup, false);
    const r2 = guard.evaluate({ actionId: "wake-cancel-task-1", kind: "cancel", taskId: "task-1" });
    assert.equal(r2.dedup, true);
    const r3 = guard.evaluate({ actionId: "wake-requeue-task-1", kind: "requeue", taskId: "task-1" });
    assert.equal(r3.dedup, false);
    const st = guard.status();
    assert.ok(st.totalDeduplicated >= 1);
  });

  it("prevents retry storm from burst of failures", () => {
    const { guard, advance } = createClockableGuard({
      retryPolicy: { maxAttempts: 2, baseDelayMs: 5000, maxDelayMs: 10000, jitterFactor: 0 },
      maxConcurrent: 1,
    });
    guard.evaluate({ actionId: "storm-1", kind: "requeue", taskId: "task-1" });
    guard.start("storm-1");
    guard.fail("storm-1", "network error");
    const results = Array.from({ length: 5 }, () =>
      guard.evaluate({ actionId: "storm-1", kind: "requeue", taskId: "task-1" })
    );
    const blocked = results.filter((r) => r.allowed === false);
    assert.ok(blocked.length >= 4, `Expected at least 4 blocked, got ${blocked.length}`);
    const st = guard.status();
    assert.ok(st.totalRateLimited >= 4);
  });
});
