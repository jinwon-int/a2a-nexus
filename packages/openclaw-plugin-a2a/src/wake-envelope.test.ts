/**
 * Wake-envelope construction from an accepted broker task.
 *
 * Issue: a2a-nexus#648 — closes a zero-coverage gap on src/wake-envelope.ts,
 * a load-bearing module on the opt-in Wake-on-Task path: it derives the wake
 * envelope (target/requester routing keys) from the broker's accepted
 * task-record + caller fallback, and runs the wake after acceptance without
 * letting visibility callbacks change sessions_send behavior.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildA2AWakeEnvelopeFromAcceptedTask,
  runA2AWakeAfterTaskAcceptance,
} from "../dist/src/wake-envelope.js";
import type { A2ABrokerTaskRecord } from "../dist/standalone-broker-client.js";
import type { A2AWakeRuntimePort } from "../dist/src/wake-layer.js";

function acceptedTask(overrides: Partial<A2ABrokerTaskRecord> = {}): A2ABrokerTaskRecord {
  return {
    id: "task-9",
    intent: "chat",
    requester: { id: "hub-session", kind: "session", role: "hub" },
    target: { id: "worker-a", kind: "node" },
    status: "queued",
    targetNodeId: "worker-a",
    payload: {},
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as A2ABrokerTaskRecord;
}

describe("buildA2AWakeEnvelopeFromAcceptedTask", () => {
  it("prefers payload routing keys over fallback and task fields", () => {
    const envelope = buildA2AWakeEnvelopeFromAcceptedTask({
      task: acceptedTask({
        payload: {
          targetSessionKey: "payload-target",
          targetDisplayKey: "Payload Target",
          targetChannel: "telegram",
          requesterSessionKey: "payload-requester",
          requesterDisplayKey: "Payload Requester",
          requesterChannel: "web",
          waitRunId: "wait-1",
          correlationId: "corr-1",
          parentRunId: "parent-1",
        },
      }),
      fallback: {
        targetSessionKey: "fallback-target",
        requesterSessionKey: "fallback-requester",
      },
    });

    assert.equal(envelope.taskId, "task-9");
    assert.equal(envelope.target.sessionKey, "payload-target");
    assert.equal(envelope.target.displayKey, "Payload Target");
    assert.equal(envelope.target.channel, "telegram");
    assert.equal(envelope.requester?.sessionKey, "payload-requester");
    assert.equal(envelope.requester?.displayKey, "Payload Requester");
    assert.equal(envelope.requester?.channel, "web");
    assert.equal(envelope.waitRunId, "wait-1");
    assert.equal(envelope.correlationId, "corr-1");
    assert.equal(envelope.parentRunId, "parent-1");
    assert.equal(envelope.brokerStatus, "queued");
    assert.equal(envelope.acceptedAtMs, Date.parse("2026-01-01T00:00:00.000Z"));
  });

  it("falls back to caller-supplied keys then task fields when payload is empty", () => {
    const envelope = buildA2AWakeEnvelopeFromAcceptedTask({
      task: acceptedTask({ payload: {} }),
      fallback: { targetSessionKey: "fallback-target", waitRunId: "fallback-wait" },
    });

    assert.equal(envelope.target.sessionKey, "fallback-target");
    assert.equal(envelope.waitRunId, "fallback-wait");
    // displayKey falls through to targetNodeId when nothing else provided.
    assert.equal(envelope.target.displayKey, "worker-a");
    // requester displayKey falls back to the task requester id.
    assert.equal(envelope.requester?.displayKey, "hub-session");
  });

  it("uses the task target id, then the task id, as the last-resort target session key", () => {
    const noTargetKeys = buildA2AWakeEnvelopeFromAcceptedTask({
      task: acceptedTask({ payload: {}, target: { id: "worker-target", kind: "node" } }),
    });
    assert.equal(noTargetKeys.target.sessionKey, "worker-target");

    const empty = buildA2AWakeEnvelopeFromAcceptedTask({
      // target.id is empty/whitespace -> normalizeOptionalString drops it -> falls to task id.
      task: acceptedTask({ payload: {}, target: { id: "  ", kind: "node" } }),
    });
    assert.equal(empty.target.sessionKey, "task-9");
  });

  it("omits acceptedAtMs when createdAt is unparseable", () => {
    const envelope = buildA2AWakeEnvelopeFromAcceptedTask({
      task: acceptedTask({ createdAt: "not-a-date" }),
    });
    assert.equal(envelope.acceptedAtMs, undefined);
  });

  it("tolerates a non-object payload by treating it as empty", () => {
    const envelope = buildA2AWakeEnvelopeFromAcceptedTask({
      task: acceptedTask({ payload: [] as unknown as Record<string, unknown> }),
      fallback: { targetSessionKey: "fallback-target" },
    });
    assert.equal(envelope.target.sessionKey, "fallback-target");
  });
});

describe("runA2AWakeAfterTaskAcceptance", () => {
  it("skips by default — Wake-on-Task is opt-in (disabled unless config.enabled)", async () => {
    const runtime: A2AWakeRuntimePort = {
      dispatchWake: () => ({ accepted: true, runtimeRunId: "run-1" }),
    };
    const result = await runA2AWakeAfterTaskAcceptance({
      task: acceptedTask({ payload: { targetSessionKey: "worker-a" } }),
      wake: { runtime },
    });
    // No config.enabled -> the guard skips before any dispatch.
    assert.equal(result.status, "skipped");
  });

  it("schedules through a provided runtime when wake is enabled and surfaces the run id", async () => {
    const runtime: A2AWakeRuntimePort = {
      dispatchWake: () => ({ accepted: true, runtimeRunId: "run-1" }),
    };
    const result = await runA2AWakeAfterTaskAcceptance({
      task: acceptedTask({ payload: { targetSessionKey: "worker-a", waitRunId: "wait-1" } }),
      wake: { runtime, config: { enabled: true } },
    });
    assert.equal(result.status, "scheduled");
    if (result.status === "scheduled") {
      assert.equal(result.receipt.runtimeRunId, "run-1");
    }
  });

  it("invokes onResult with the built envelope and swallows callback errors", async () => {
    let seenTaskId: string | undefined;
    const runtime: A2AWakeRuntimePort = {
      dispatchWake: () => ({ accepted: true, runtimeRunId: "run-1" }),
    };
    const result = await runA2AWakeAfterTaskAcceptance({
      task: acceptedTask({ payload: { targetSessionKey: "worker-a", waitRunId: "wait-1" } }),
      wake: {
        runtime,
        config: { enabled: true },
        onResult: ({ envelope }) => {
          seenTaskId = envelope.taskId;
          throw new Error("callback boom — must not propagate");
        },
      },
    });

    assert.equal(seenTaskId, "task-9");
    // Despite the throwing callback, the wake result is still returned.
    assert.equal(result.status, "scheduled");
  });
});
