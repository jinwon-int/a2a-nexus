import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { evaluateA2AWakePlan, executeA2AWake } from "../dist/src/wake-layer.js";

function baseEnvelope(overrides = {}) {
  return {
    taskId: "task-1",
    waitRunId: "wait-1",
    correlationId: "corr-1",
    brokerStatus: "queued",
    target: { sessionKey: "target-session", displayKey: "target-node" },
    ...overrides,
  };
}

describe("evaluateA2AWakePlan", () => {
  it("keeps Wake-on-Task default-off until Phase 6 gates are green", () => {
    const plan = evaluateA2AWakePlan({ envelope: baseEnvelope() });
    assert.equal(plan.status, "skipped");
    assert.equal(plan.code, "wake_disabled");
  });

  it("schedules a deterministic wake for an accepted non-terminal task", () => {
    const plan = evaluateA2AWakePlan({
      envelope: baseEnvelope(),
      config: { enabled: true },
    });
    assert.equal(plan.status, "scheduled");
    assert.equal(plan.sessionKey, "target-session");
    assert.equal(plan.wakeKey, "corr-1:wait-1");
    assert.equal(plan.idempotencyKey, "a2a-wake:corr-1:wait-1");
    assert.equal(plan.mode, "resume_or_launch");
    assert.equal(plan.coalesced, false);
  });

  it("coalesces into active sessions instead of scheduling duplicate worker launches", () => {
    const plan = evaluateA2AWakePlan({
      envelope: baseEnvelope(),
      config: { enabled: true },
      state: { activeSessionKeys: new Set(["target-session"]) },
    });
    assert.equal(plan.status, "scheduled");
    assert.equal(plan.mode, "append_to_active_session");
    assert.equal(plan.coalesced, true);
  });

  it("suppresses recently scheduled duplicate wake keys", () => {
    const plan = evaluateA2AWakePlan({
      envelope: baseEnvelope(),
      config: { enabled: true },
      state: { recentWakeKeys: new Set(["corr-1:wait-1"]) },
    });
    assert.equal(plan.status, "skipped");
    assert.equal(plan.code, "duplicate_wake");
  });

  it("rate-limits repeated wakes for the same target key", () => {
    const plan = evaluateA2AWakePlan({
      envelope: baseEnvelope({ target: { sessionKey: "target-session", displayKey: "node-a" } }),
      config: {
        enabled: true,
        perNodeRateLimit: { maxWakeCount: 2, windowMs: 60_000, nowMs: 120_000 },
      },
      state: { recentWakeTimestampsByTargetKey: new Map([["node-a", [61_000, 90_000]]]) },
    });
    assert.equal(plan.status, "skipped");
    assert.equal(plan.code, "rate_limited");
  });

  it("skips terminal broker tasks", () => {
    const plan = evaluateA2AWakePlan({
      envelope: baseEnvelope({ brokerStatus: "succeeded" }),
      config: { enabled: true },
    });
    assert.equal(plan.status, "skipped");
    assert.equal(plan.code, "terminal_task");
  });

  it("blocks parent-run loops", () => {
    const plan = evaluateA2AWakePlan({
      envelope: baseEnvelope({ parentRunId: "parent-run" }),
      config: { enabled: true, localRunIds: new Set(["parent-run"]) },
    });
    assert.equal(plan.status, "skipped");
    assert.equal(plan.code, "loop_guard");
  });

  it("does not dispatch runtime wakes for repeated self-triggering loop candidates", async () => {
    let dispatchCount = 0;
    const runtime = {
      dispatchWake: () => {
        dispatchCount += 1;
        return { accepted: true, runtimeRunId: "should-not-run" };
      },
    };

    for (const taskId of ["task-loop-1", "task-loop-2", "task-loop-3"]) {
      const result = await executeA2AWake({
        envelope: baseEnvelope({ taskId, parentRunId: "local-run" }),
        config: { enabled: true, localRunIds: new Set(["local-run"]) },
        nowMs: 789,
        runtime,
      });

      assert.equal(result.status, "skipped");
      assert.equal(result.plan.code, "loop_guard");
      assert.equal(result.audit.taskStatePatch.wake.status, "skipped");
      assert.equal(result.audit.taskStatePatch.wake.code, "loop_guard");
      assert.equal(result.audit.taskStatePatch.wake.atMs, 789);
    }

    assert.equal(dispatchCount, 0);
  });

  it("dispatches scheduled wakes through the runtime-facing port", async () => {
    let seenPlan;
    const result = await executeA2AWake({
      envelope: baseEnvelope(),
      config: { enabled: true },
      nowMs: 123,
      runtime: {
        dispatchWake: ({ plan }) => {
          seenPlan = plan;
          return { accepted: true, runtimeRunId: "run-1", queuedAtMs: 456 };
        },
      },
    });

    assert.equal(result.status, "scheduled");
    assert.equal(seenPlan.idempotencyKey, "a2a-wake:corr-1:wait-1");
    assert.equal(result.audit.auditEvent.status, "scheduled");
    assert.equal(result.audit.taskStatePatch.wake.runtimeRunId, "run-1");
    assert.equal(result.audit.taskStatePatch.wake.atMs, 456);
  });

  it("keeps wake failures visible in audit/task state", async () => {
    const result = await executeA2AWake({
      envelope: baseEnvelope(),
      config: { enabled: true },
      nowMs: 123,
      runtime: {
        dispatchWake: () => {
          throw new Error("runtime unavailable");
        },
      },
    });

    assert.equal(result.status, "failed");
    assert.equal(result.code, "wake_dispatch_failed");
    assert.equal(result.audit.auditEvent.status, "failed");
    assert.equal(result.audit.taskStatePatch.wake.code, "wake_dispatch_failed");
    assert.equal(result.audit.taskStatePatch.wake.message, "runtime unavailable");
  });
});
