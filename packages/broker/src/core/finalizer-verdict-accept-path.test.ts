// Integration: the accept-path finalizer-verdict hook is wired into
// InMemoryA2ABroker.completeTask via the terminal context (#1383 V-c).
// Proves default-inert (off) completes unchanged, enforce blocks a bad verdict
// before side-effects, and a well-formed bound independent verdict passes.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { InMemoryA2ABroker } from "./broker.js";
import { FINALIZER_VERDICT_SCHEMA } from "./finalizer-verdict-admission.js";
import { BrokerError } from "./broker-error.js";
import type { TaskResult } from "./types.js";

const ANCHOR = "sha256:acceptpathanchor";

function registerWorker(broker: InMemoryA2ABroker, nodeId = "worker-1") {
  broker.registerWorker({
    nodeId, role: "operator",
    capabilities: {
      canAnalyze: true, canBackfill: false, canPatchWorkspace: false,
      canPromoteLive: false, workspaceIds: ["default"], environments: ["research"],
    },
  });
}

function claimedTask(broker: InMemoryA2ABroker, payload: Record<string, unknown>) {
  const task = broker.createTask({
    intent: "analyze",
    requester: { id: "hub", kind: "node", role: "hub" },
    target: { id: "worker-1", kind: "node", role: "operator" },
    payload,
  });
  broker.claimTask(task.id, "worker-1");
  broker.startTask(task.id, "worker-1");
  return task;
}

function boundVerdictResult(verdictOverrides: Record<string, unknown> = {}): TaskResult {
  return {
    summary: "analysis complete",
    provenance: { workerKeyId: "worker:alpha:g2:v1", resultHash: ANCHOR },
    finalizerVerdict: {
      schemaVersion: FINALIZER_VERDICT_SCHEMA,
      subject: { kind: "task-result", resultHash: ANCHOR },
      decision: "go",
      finalizerKeyId: "finalizer:panel:v1",
      ...verdictOverrides,
    },
  } as unknown as TaskResult;
}

describe("accept-path finalizer-verdict enforcement (#1383 V-c)", () => {
  it("off posture: opt-in task completes byte-identically without a verdict", () => {
    const broker = new InMemoryA2ABroker();
    registerWorker(broker);
    const task = claimedTask(broker, { requireFinalizerVerdict: true });
    const done = broker.completeTask(task.id, "worker-1", { summary: "no verdict, but off" });
    assert.equal(done.status, "succeeded");
  });

  it("enforce posture: a non-opted-in task still completes unchanged", () => {
    const broker = new InMemoryA2ABroker(undefined, undefined, { finalizerVerdictEnforcement: "enforce" });
    registerWorker(broker);
    const task = claimedTask(broker, {});
    const done = broker.completeTask(task.id, "worker-1", { summary: "legacy path" });
    assert.equal(done.status, "succeeded");
  });

  it("enforce posture: an opted-in task with no verdict is blocked (fail-closed)", () => {
    const broker = new InMemoryA2ABroker(undefined, undefined, { finalizerVerdictEnforcement: "enforce" });
    registerWorker(broker);
    const task = claimedTask(broker, { requireFinalizerVerdict: true });
    assert.throws(
      () => broker.completeTask(task.id, "worker-1", { summary: "missing verdict" }),
      (err: unknown) => err instanceof BrokerError && err.code === "finalizer_verdict_invalid",
    );
    // The task did NOT transition to succeeded (blocked before side-effects).
    assert.notEqual(broker.getTask(task.id)?.status, "succeeded");
  });

  it("enforce posture: a well-formed bound independent GO verdict passes", () => {
    const broker = new InMemoryA2ABroker(undefined, undefined, { finalizerVerdictEnforcement: "enforce" });
    registerWorker(broker);
    const task = claimedTask(broker, { requireFinalizerVerdict: true });
    const done = broker.completeTask(task.id, "worker-1", boundVerdictResult());
    assert.equal(done.status, "succeeded");
  });

  it("warn posture: an opted-in task with a bad verdict completes but records a warn audit event", () => {
    const broker = new InMemoryA2ABroker(undefined, undefined, { finalizerVerdictEnforcement: "warn" });
    registerWorker(broker);
    const task = claimedTask(broker, { requireFinalizerVerdict: true });
    const done = broker.completeTask(task.id, "worker-1", { summary: "no verdict under warn" });
    assert.equal(done.status, "succeeded");
    const warned = broker.listAuditEvents().some((e) => e.action === "task.finalizer_verdict_warned");
    assert.ok(warned, "warn posture must record a finalizer_verdict_warned audit event");
  });
});
