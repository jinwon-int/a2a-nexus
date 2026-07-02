import assert from "node:assert/strict";
import test from "node:test";

import {
  A2AExecutionPolicyDenied,
  evaluateA2AExecutionPolicy,
  runGuardedGitHubAction,
  type A2AFinalizerDecision,
} from "./a2a-execution-policy.js";

const completeDecision: A2AFinalizerDecision = {
  finalizerDecisionId: "fd-001",
  finalizerOwner: "brokeralpha",
  parentRoundId: "round-42",
  parentRoundTotal: 3,
  parentRoundOrder: 3,
  brokerOfRecordId: "brokeralpha",
  executionLane: "a2ad",
  allowedActions: ["pr_merge"],
  workerEvidenceIds: ["ev-workerbeta-1"],
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

test("a2a-required action fails closed when requestedAction is not a registered guarded action", () => {
  const result = evaluateA2AExecutionPolicy({
    intent: "A2A로 진행",
    requestedAction: "unregistered_write" as never,
    finalizerDecision: { ...completeDecision, allowedActions: ["unregistered_write" as never] },
  });
  assert.equal(result.allowed, false);
  assert.ok(result.blockers.includes("invalid_guarded_action:unregistered_write"));
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

test("a2a-required action fails closed when round count/order provenance is missing or invalid", () => {
  const missing = evaluateA2AExecutionPolicy({
    intent: "A2A로 진행",
    requestedAction: "pr_merge",
    finalizerDecision: { ...completeDecision, parentRoundTotal: undefined as never, parentRoundOrder: 0 },
  });
  assert.equal(missing.allowed, false);
  assert.ok(missing.blockers.includes("missing_finalizer_provenance:parentRoundTotal"));
  assert.ok(missing.blockers.includes("missing_finalizer_provenance:parentRoundOrder"));

  const outOfRange = evaluateA2AExecutionPolicy({
    intent: "A2A로 진행",
    requestedAction: "pr_merge",
    finalizerDecision: { ...completeDecision, parentRoundTotal: 2, parentRoundOrder: 3 },
  });
  assert.equal(outOfRange.allowed, false);
  assert.ok(outOfRange.blockers.includes("invalid_finalizer_provenance:parentRoundOrder"));
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

test("blank/whitespace worker evidence does not count as substantive (fail closed)", () => {
  const result = evaluateA2AExecutionPolicy({
    intent: "A2A로 진행",
    requestedAction: "pr_merge",
    finalizerDecision: { ...completeDecision, workerEvidenceIds: ["   ", ""] },
  });
  assert.equal(result.allowed, false);
  assert.deepEqual(result.blockers, ["no_substantive_worker_evidence"]);
});

test("an executionLane outside the known A2A/A2AD lanes fails closed", () => {
  const result = evaluateA2AExecutionPolicy({
    intent: "A2A로 진행",
    requestedAction: "pr_merge",
    finalizerDecision: { ...completeDecision, executionLane: "direct" as never },
  });
  assert.equal(result.allowed, false);
  assert.deepEqual(result.blockers, ["invalid_finalizer_provenance:executionLane"]);
});

test("malformed decision shapes fail closed instead of throwing", () => {
  const result = evaluateA2AExecutionPolicy({
    intent: "A2A로 진행",
    requestedAction: "pr_merge",
    finalizerDecision: {
      ...completeDecision,
      allowedActions: "pr_merge" as never,
      workerEvidenceIds: "ev-1" as never,
    },
  });
  assert.equal(result.allowed, false);
  assert.ok(result.blockers.includes("action_not_in_allowed_actions:pr_merge"));
  assert.ok(result.blockers.includes("no_substantive_worker_evidence"));
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
    finalizerDecision: { ...completeDecision, workerEvidenceIds: ["ev-wrapper-1", "ev-workerbeta-2"] },
    wrapperOnlyEvidenceIds: ["ev-wrapper-1"],
  });
  assert.equal(result.allowed, true);
  assert.deepEqual(result.blockers, []);
});

test("runGuardedGitHubAction fails closed and does not invoke the action when denied (#555)", async () => {
  let invoked = false;
  await assert.rejects(
    () =>
      runGuardedGitHubAction(
        { intent: "A2A로 진행", requestedAction: "pr_merge" }, // no finalizer decision
        () => {
          invoked = true;
          return "merged";
        },
      ),
    (error: unknown) =>
      error instanceof A2AExecutionPolicyDenied &&
      error.requestedAction === "pr_merge" &&
      error.blockers.includes("a2a_required_action_without_finalizer_decision"),
  );
  assert.equal(invoked, false, "the guarded action must not run when the policy denies it");
});

test("runGuardedGitHubAction blocks an action that is not in allowedActions (#555)", async () => {
  let invoked = false;
  await assert.rejects(
    () =>
      runGuardedGitHubAction(
        {
          intent: "A2AD로 봐줘",
          requestedAction: "issue_close",
          finalizerDecision: { ...completeDecision, allowedActions: ["pr_merge"] },
        },
        () => {
          invoked = true;
        },
      ),
    (error: unknown) =>
      error instanceof A2AExecutionPolicyDenied &&
      error.blockers.includes("action_not_in_allowed_actions:issue_close"),
  );
  assert.equal(invoked, false);
});

test("runGuardedGitHubAction runs the action in a non-A2A context (#555)", async () => {
  let invoked = false;
  const result = await runGuardedGitHubAction(
    { intent: "please summarize the weekly metrics doc", requestedAction: "pr_merge" },
    () => {
      invoked = true;
      return "ran";
    },
  );
  assert.equal(invoked, true);
  assert.equal(result, "ran");
});

test("runGuardedGitHubAction runs (and awaits) the action with a complete finalizer decision (#555)", async () => {
  let calls = 0;
  const result = await runGuardedGitHubAction(
    {
      intent: "A2A로 진행해서 finalizer 판단으로 머지",
      requestedAction: "pr_merge",
      finalizerDecision: completeDecision,
    },
    async () => {
      calls += 1;
      return 42;
    },
  );
  assert.equal(calls, 1);
  assert.equal(result, 42);
});
