import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateA2AExecutionPolicy,
  type A2AFinalizerDecision,
} from "./a2a-execution-policy.js";

const completeDecision: A2AFinalizerDecision = {
  finalizerDecisionId: "fd-001",
  finalizerOwner: "seoseo",
  parentRoundId: "round-42",
  brokerOfRecordId: "seoseo",
  executionLane: "a2ad",
  allowedActions: ["pr_merge"],
  workerEvidenceIds: ["ev-sogyo-1"],
};

test("non-A2A context is allowed without a finalizer decision", () => {
  const result = evaluateA2AExecutionPolicy({
    intent: "please summarize the weekly metrics doc",
    requestedAction: "pr_merge",
  });
  assert.equal(result.executionContext, "none");
  assert.equal(result.allowed, true);
  assert.deepEqual(result.blockers, []);
});

test("a2a-required action fails closed when no finalizer decision is present", () => {
  const result = evaluateA2AExecutionPolicy({
    intent: "A2A로 진행해서 워커들한테 맡겨",
    requestedAction: "pr_merge",
  });
  assert.equal(result.executionContext, "a2a_required");
  assert.equal(result.allowed, false);
  assert.deepEqual(result.blockers, ["a2a_required_action_without_finalizer_decision"]);
});

test("a2a-required action fails closed when the requested action is not in allowedActions", () => {
  const result = evaluateA2AExecutionPolicy({
    intent: "A2AD로 봐줘",
    requestedAction: "pr_merge",
    finalizerDecision: { ...completeDecision, allowedActions: ["issue_closeout_comment"] },
  });
  assert.equal(result.allowed, false);
  assert.deepEqual(result.blockers, ["action_not_in_allowed_actions:pr_merge"]);
});

test("a2a-required action fails closed when finalizer provenance is incomplete", () => {
  const result = evaluateA2AExecutionPolicy({
    intent: "A2A로 진행",
    requestedAction: "pr_merge",
    finalizerDecision: { ...completeDecision, finalizerDecisionId: "", parentRoundId: "  " },
  });
  assert.equal(result.allowed, false);
  assert.ok(result.blockers.includes("missing_finalizer_provenance:finalizerDecisionId"));
  assert.ok(result.blockers.includes("missing_finalizer_provenance:parentRoundId"));
});

test("wrapper-only evidence does not count as substantive worker evidence", () => {
  const result = evaluateA2AExecutionPolicy({
    intent: "A2A로 진행",
    requestedAction: "pr_merge",
    finalizerDecision: { ...completeDecision, workerEvidenceIds: ["ev-wrapper-1"] },
    wrapperOnlyEvidenceIds: ["ev-wrapper-1"],
  });
  assert.equal(result.allowed, false);
  assert.deepEqual(result.blockers, ["no_substantive_worker_evidence"]);
});

test("a2a-required action is allowed with a complete, action-scoped finalizer decision", () => {
  const result = evaluateA2AExecutionPolicy({
    intent: "A2A로 진행해서 finalizer 판단으로 머지",
    requestedAction: "pr_merge",
    finalizerDecision: completeDecision,
  });
  assert.equal(result.executionContext, "a2a_required");
  assert.equal(result.allowed, true);
  assert.deepEqual(result.blockers, []);
});

test("substantive evidence alongside wrapper-only evidence still authorizes", () => {
  const result = evaluateA2AExecutionPolicy({
    intent: "A2A로 진행",
    requestedAction: "pr_merge",
    finalizerDecision: { ...completeDecision, workerEvidenceIds: ["ev-wrapper-1", "ev-sogyo-2"] },
    wrapperOnlyEvidenceIds: ["ev-wrapper-1"],
  });
  assert.equal(result.allowed, true);
  assert.deepEqual(result.blockers, []);
});
