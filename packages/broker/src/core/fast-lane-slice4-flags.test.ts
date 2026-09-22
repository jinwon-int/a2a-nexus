// #1601/#2208 fast-lane slice 4: opt-in flags fastLaneSkipReviewRound (Q1)
// and fastLaneSingleWorkerFinalize (Q2). Both flags are broker-constructor
// opt-ins that may only ever relax gates for tasks the broker itself
// classified `fast` at create (classifyTaskLane) — never for `full` lanes.
// Flag-off behavior must remain byte-identical to the pre-slice-4 paths
// (#1815 evidence preservation; #1383 V-c finalizer admission).
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { BROKER_POLICY_SCHEMA, type BrokerPolicyDocument } from "a2a-policy-referee";

import { InMemoryA2ABroker } from "./broker.js";
import { FINALIZER_VERDICT_SCHEMA } from "./finalizer-verdict-admission.js";
import { BrokerError } from "./broker-error.js";
import type { TaskResult } from "./types.js";

const ANCHOR = "sha256:fastlaneslice4anchor";

const ALLOW_POLICY: BrokerPolicyDocument = {
  schemaVersion: BROKER_POLICY_SCHEMA,
  mode: "enforce",
  defaultAction: "allow",
  rules: [],
};

type FastLaneBrokerOptions = {
  fastLaneSkipReviewRound?: boolean;
  fastLaneSingleWorkerFinalize?: boolean;
  finalizerVerdictEnforcement?: "off" | "warn" | "enforce";
};

function makeBroker(fastLaneOptions: FastLaneBrokerOptions = {}): InMemoryA2ABroker {
  return new InMemoryA2ABroker(undefined, undefined, {
    policyDocument: ALLOW_POLICY,
    ...fastLaneOptions,
  });
}

function registerPersistentWorker(broker: InMemoryA2ABroker, nodeId = "worker-1"): void {
  broker.registerWorker({
    nodeId,
    role: "operator",
    workerMode: "persistent",
    capabilities: {
      canAnalyze: true,
      canBackfill: false,
      canPatchWorkspace: false,
      canPromoteLive: false,
      workspaceIds: ["default"],
      environments: ["research"],
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

function audits(broker: InMemoryA2ABroker, action: string) {
  return broker.listAuditEvents().filter((event) => event.action === action);
}

function assertSkipCode(err: unknown, code: string): void {
  if (!(err instanceof BrokerError) || err.code !== code) {
    throw new Error(`expected BrokerError ${code}, got ${String(err)}`);
  }
}

function reviewResult(validation: Record<string, unknown>): TaskResult {
  return {
    summary: "analysis complete with review evidence attached",
    validation: { kind: "review", ...validation },
  } as unknown as TaskResult;
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

describe("fast-lane slice 4 fixture guard (#1601/#2208)", () => {
  it("analyze + analysis-only + persistent worker classifies fast (shadow)", () => {
    const broker = makeBroker();
    registerPersistentWorker(broker);
    const task = claimedTask(broker, { mode: "analysis-only" });
    assert.deepEqual(broker.getTask(task.id)?.laneAssignment, {
      version: "fast-lane.v1",
      mode: "shadow",
      decision: "fast",
      reasonCodes: ["all_fast_conditions_met"],
    });
  });
});

describe("Q1: fastLaneSkipReviewRound (#1601/#2208)", () => {
  it("flag on: missing review evidence completes with exactly one skip audit", () => {
    const broker = makeBroker({ fastLaneSkipReviewRound: true });
    registerPersistentWorker(broker);
    const task = claimedTask(broker, { mode: "analysis-only", review: { required: true } });
    const done = broker.completeTask(task.id, "worker-1", { summary: "no review evidence" });
    assert.equal(done.status, "succeeded");
    const skips = audits(broker, "task.review_gate_skipped");
    assert.equal(skips.length, 1);
    assert.equal(skips[0]?.targetId, task.id);
    assert.equal(
      skips[0]?.note,
      "fast-lane review round skipped: review_evidence_missing (#1601/#2208)",
    );
  });

  it("flag on: self-review (reviewer == author) completes with a skip audit", () => {
    const broker = makeBroker({ fastLaneSkipReviewRound: true });
    registerPersistentWorker(broker);
    const task = claimedTask(broker, { mode: "analysis-only", review: { required: true } });
    const done = broker.completeTask(task.id, "worker-1", reviewResult({
      nodeId: "worker-1",
      verdict: "pass",
      note: "reviewed by the author worker itself",
    }));
    assert.equal(done.status, "succeeded");
    const skips = audits(broker, "task.review_gate_skipped");
    assert.equal(skips.length, 1);
    assert.equal(
      skips[0]?.note,
      "fast-lane review round skipped: review_not_independent (#1601/#2208)",
    );
  });

  it("flag on: failed verdict completes, preserves negative evidence, skip audit", () => {
    const broker = makeBroker({ fastLaneSkipReviewRound: true });
    registerPersistentWorker(broker);
    const task = claimedTask(broker, { mode: "analysis-only", review: { required: true } });
    const done = broker.completeTask(task.id, "worker-1", reviewResult({
      nodeId: "worker-2",
      verdict: "fail",
      note: "reviewer found blocking defects in the analysis",
    }));
    assert.equal(done.status, "succeeded");
    const skips = audits(broker, "task.review_gate_skipped");
    assert.equal(skips.length, 1);
    assert.equal(
      skips[0]?.note,
      "fast-lane review round skipped: review_verdict_failed (#1601/#2208)",
    );
    // #1815 preservation runs BEFORE the skip decision, unconditionally.
    const preserved = broker.getTask(task.id)?.negativeVerdictEvidence;
    assert.equal(preserved?.reviewerNodeId, "worker-2");
    assert.equal(preserved?.verdict, "fail");
    assert.equal(audits(broker, "task.negative_verdict_preserved").length, 1);
  });

  it("flag off: every review gate still throws and records zero skip audits", () => {
    const cases: Array<[TaskResult, string]> = [
      [{ summary: "no review evidence" } as unknown as TaskResult, "review_evidence_missing"],
      [reviewResult({ nodeId: "worker-1", verdict: "pass", note: "reviewed by the author worker itself" }), "review_not_independent"],
      [reviewResult({ nodeId: "worker-2", verdict: "fail", note: "reviewer found blocking defects in the analysis" }), "review_verdict_failed"],
    ];
    for (const [result, code] of cases) {
      const broker = makeBroker();
      registerPersistentWorker(broker);
      const task = claimedTask(broker, { mode: "analysis-only", review: { required: true } });
      try {
        broker.completeTask(task.id, "worker-1", result);
        assert.fail(`expected ${code} to throw`);
      } catch (err) {
        assertSkipCode(err, code);
      }
      assert.notEqual(broker.getTask(task.id)?.status, "succeeded");
      assert.equal(audits(broker, "task.review_gate_skipped").length, 0);
    }
  });

  it("flag off: failed verdict still throws but evidence stays preserved (#1815)", () => {
    const broker = makeBroker();
    registerPersistentWorker(broker);
    const task = claimedTask(broker, { mode: "analysis-only", review: { required: true } });
    try {
      broker.completeTask(task.id, "worker-1", reviewResult({
        nodeId: "worker-2",
        verdict: "fail",
        note: "reviewer found blocking defects in the analysis",
      }));
      assert.fail("expected review_verdict_failed to throw");
    } catch (err) {
      assertSkipCode(err, "review_verdict_failed");
    }
    const preserved = broker.getTask(task.id)?.negativeVerdictEvidence;
    assert.equal(preserved?.reviewerNodeId, "worker-2");
    assert.equal(preserved?.verdict, "fail");
    assert.equal(audits(broker, "task.negative_verdict_preserved").length, 1);
  });

  it("flag on but full lane: write marker bypasses nothing — gate still throws", () => {
    const broker = makeBroker({ fastLaneSkipReviewRound: true });
    registerPersistentWorker(broker);
    const task = claimedTask(broker, {
      mode: "analysis-only",
      write: true,
      review: { required: true },
    });
    assert.equal(broker.getTask(task.id)?.laneAssignment?.decision, "full");
    try {
      broker.completeTask(task.id, "worker-1", { summary: "no review evidence" });
      assert.fail("expected review_evidence_missing to throw on a full lane");
    } catch (err) {
      assertSkipCode(err, "review_evidence_missing");
    }
    assert.equal(audits(broker, "task.review_gate_skipped").length, 0);
  });
});

describe("Q2: fastLaneSingleWorkerFinalize (#1601/#2208)", () => {
  it("flag on + enforce: opted-in fast task without a verdict completes via single-worker finalize", () => {
    const broker = makeBroker({
      fastLaneSingleWorkerFinalize: true,
      finalizerVerdictEnforcement: "enforce",
    });
    registerPersistentWorker(broker);
    const task = claimedTask(broker, { mode: "analysis-only", requireFinalizerVerdict: true });
    const done = broker.completeTask(task.id, "worker-1", {
      summary: "fast-lane single-worker finalize",
    });
    assert.equal(done.status, "succeeded");
    const skips = audits(broker, "task.finalizer_admission_skipped");
    assert.equal(skips.length, 1);
    assert.equal(skips[0]?.targetId, task.id);
    assert.equal(
      skips[0]?.note,
      "fast-lane single-worker finalize: verdict admission skipped (#1601/#2208)",
    );
  });

  it("flag on: a present verdict still runs full admission — bound GO passes, no skip audit", () => {
    const broker = makeBroker({
      fastLaneSingleWorkerFinalize: true,
      finalizerVerdictEnforcement: "enforce",
    });
    registerPersistentWorker(broker);
    const task = claimedTask(broker, { mode: "analysis-only", requireFinalizerVerdict: true });
    const done = broker.completeTask(task.id, "worker-1", boundVerdictResult());
    assert.equal(done.status, "succeeded");
    assert.equal(audits(broker, "task.finalizer_admission_skipped").length, 0);
  });

  it("flag on: a present NO-GO verdict is still blocked under enforce", () => {
    const broker = makeBroker({
      fastLaneSingleWorkerFinalize: true,
      finalizerVerdictEnforcement: "enforce",
    });
    registerPersistentWorker(broker);
    const task = claimedTask(broker, { mode: "analysis-only", requireFinalizerVerdict: true });
    try {
      broker.completeTask(task.id, "worker-1", boundVerdictResult({ decision: "no-go" }));
      assert.fail("expected finalizer_verdict_invalid to throw");
    } catch (err) {
      assertSkipCode(err, "finalizer_verdict_invalid");
    }
    assert.notEqual(broker.getTask(task.id)?.status, "succeeded");
    assert.equal(audits(broker, "task.finalizer_admission_skipped").length, 0);
  });

  it("flag on: a verdict bound to a foreign result hash is still blocked", () => {
    const broker = makeBroker({
      fastLaneSingleWorkerFinalize: true,
      finalizerVerdictEnforcement: "enforce",
    });
    registerPersistentWorker(broker);
    const task = claimedTask(broker, { mode: "analysis-only", requireFinalizerVerdict: true });
    try {
      broker.completeTask(task.id, "worker-1", boundVerdictResult({
        subject: { kind: "task-result", resultHash: "sha256:tampered" },
      }));
      assert.fail("expected finalizer_verdict_invalid to throw");
    } catch (err) {
      assertSkipCode(err, "finalizer_verdict_invalid");
    }
    assert.notEqual(broker.getTask(task.id)?.status, "succeeded");
  });

  it("flag off + enforce: opted-in task without a verdict stays blocked (baseline)", () => {
    const broker = makeBroker({ finalizerVerdictEnforcement: "enforce" });
    registerPersistentWorker(broker);
    const task = claimedTask(broker, { mode: "analysis-only", requireFinalizerVerdict: true });
    try {
      broker.completeTask(task.id, "worker-1", { summary: "no verdict, flag off" });
      assert.fail("expected finalizer_verdict_invalid to throw");
    } catch (err) {
      assertSkipCode(err, "finalizer_verdict_invalid");
    }
    assert.notEqual(broker.getTask(task.id)?.status, "succeeded");
    assert.equal(audits(broker, "task.finalizer_admission_skipped").length, 0);
  });

  it("warn posture (flag off): bad verdict completes with warned audit, no skip audit", () => {
    const broker = makeBroker({ finalizerVerdictEnforcement: "warn" });
    registerPersistentWorker(broker);
    const task = claimedTask(broker, { mode: "analysis-only", requireFinalizerVerdict: true });
    const done = broker.completeTask(task.id, "worker-1", { summary: "no verdict under warn" });
    assert.equal(done.status, "succeeded");
    assert.equal(audits(broker, "task.finalizer_verdict_warned").length >= 1, true);
    assert.equal(audits(broker, "task.finalizer_admission_skipped").length, 0);
  });
});
