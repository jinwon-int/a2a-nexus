/**
 * Runtime wake-port adapter (src/runtime-wake-dispatch.ts).
 *
 * Issue: a2a-nexus#648 — closes a zero-coverage gap. This module is the seam
 * that turns a scheduled wake plan into a runtime dispatch: it builds the
 * human-readable wake message, forwards routing keys to the underlying
 * runtime adapter, and maps the adapter's queued/coalesced/failed outcomes
 * back into the A2AWakeRuntimeReceipt contract the wake layer consumes.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createA2AWakeRuntimePort } from "../dist/src/runtime-wake-dispatch.js";
import {
  createInProcessWakeQueueAdapter,
  type A2ARuntimeWakeAdapter,
  type A2AWakeDispatch,
} from "../dist/src/runtime-wake-adapter.js";
import type { A2AWakeEnvelope, A2AScheduledWakePlan } from "../dist/src/wake-layer.js";

function envelope(overrides: Partial<A2AWakeEnvelope> = {}): A2AWakeEnvelope {
  return {
    taskId: "task-1",
    brokerStatus: "queued",
    target: { sessionKey: "worker-a", displayKey: "Worker A" },
    acceptedAtMs: 1000,
    waitRunId: "wait-1",
    correlationId: "corr-1",
    ...overrides,
  } as A2AWakeEnvelope;
}

function scheduledPlan(overrides: Partial<A2AScheduledWakePlan> = {}): A2AScheduledWakePlan {
  return {
    status: "scheduled",
    taskId: "task-1",
    sessionKey: "worker-a",
    idempotencyKey: "idem-1",
    mode: "resume_or_launch",
    wakeKey: "corr-1:wait-1",
    targetKey: "Worker A",
    correlationId: "corr-1",
    coalesced: false,
    ...overrides,
  };
}

describe("createA2AWakeRuntimePort", () => {
  it("queues a wake through the in-process adapter and reports accepted with a queued note", async () => {
    const adapter = createInProcessWakeQueueAdapter();
    const port = createA2AWakeRuntimePort(adapter);

    const receipt = await port.dispatchWake({ envelope: envelope(), plan: scheduledPlan() });

    assert.equal(receipt.accepted, true);
    if (receipt.accepted) {
      assert.match(receipt.note ?? "", /queued/i);
      assert.ok(receipt.runtimeRunId);
    }
    // The adapter actually retained a queue entry for the target session.
    const entries = adapter.entries();
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.targetSessionKey, "worker-a");
  });

  it("reports a coalesced note when the adapter coalesces into an existing entry", async () => {
    const coalescedDispatch: A2AWakeDispatch = {
      status: "coalesced",
      taskId: "task-2",
      targetSessionKey: "worker-a",
      runtime: "in-process-queue",
      wakeId: "wake-xyz",
      coalescedTaskIds: ["task-1", "task-2"],
    };
    const stubAdapter: A2ARuntimeWakeAdapter = {
      runtime: "in-process-queue",
      wake: () => coalescedDispatch,
      failures: () => [],
    };
    const port = createA2AWakeRuntimePort(stubAdapter);

    const receipt = await port.dispatchWake({ envelope: envelope(), plan: scheduledPlan() });
    assert.equal(receipt.accepted, true);
    if (receipt.accepted) {
      assert.equal(receipt.runtimeRunId, "wake-xyz");
      assert.match(receipt.note ?? "", /coalesced/i);
    }
  });

  it("maps an adapter visibleFailure into a rejected receipt with code and message", async () => {
    const failingAdapter: A2ARuntimeWakeAdapter = {
      runtime: "in-process-queue",
      wake: () => ({
        status: "dispatched",
        taskId: "task-1",
        targetSessionKey: "worker-a",
        runtime: "in-process-queue",
        wakeId: "w-1",
        coalescedTaskIds: [],
        visibleFailure: {
          status: "failed",
          taskId: "task-1",
          reason: "runtime_unavailable",
          message: "runtime is down",
          visible: true,
          timestamp: 5,
        },
      }),
      failures: () => [],
    };
    const port = createA2AWakeRuntimePort(failingAdapter);

    const receipt = await port.dispatchWake({ envelope: envelope(), plan: scheduledPlan() });
    assert.equal(receipt.accepted, false);
    if (!receipt.accepted) {
      assert.equal(receipt.code, "runtime_unavailable");
      assert.equal(receipt.message, "runtime is down");
    }
  });

  it("forwards routing keys and a descriptive wake message to the adapter", async () => {
    let seen: { message: string; targetSessionKey: string; correlationId?: string; targetNodeId?: string } | undefined;
    const captureAdapter: A2ARuntimeWakeAdapter = {
      runtime: "in-process-queue",
      wake: (req) => {
        seen = {
          message: req.message,
          targetSessionKey: req.targetSessionKey,
          correlationId: req.correlationId,
          targetNodeId: req.targetNodeId,
        };
        return {
          status: "queued",
          taskId: req.taskId,
          targetSessionKey: req.targetSessionKey,
          runtime: "in-process-queue",
          wakeId: "w-1",
          coalescedTaskIds: [],
        };
      },
      failures: () => [],
    };
    const port = createA2AWakeRuntimePort(captureAdapter);

    await port.dispatchWake({
      envelope: envelope(),
      plan: scheduledPlan({ correlationId: "corr-1", targetKey: "node-1" }),
    });

    assert.ok(seen);
    assert.equal(seen!.targetSessionKey, "worker-a");
    assert.equal(seen!.correlationId, "corr-1");
    assert.equal(seen!.targetNodeId, "node-1");
    // The wake message advertises the task and target, plus correlation/run ids.
    assert.match(seen!.message, /A2A Wake-on-Task accepted\./);
    assert.match(seen!.message, /taskId=task-1/);
    assert.match(seen!.message, /target=Worker A/);
    assert.match(seen!.message, /waitRunId=wait-1/);
    assert.match(seen!.message, /correlationId=corr-1/);
  });
});
