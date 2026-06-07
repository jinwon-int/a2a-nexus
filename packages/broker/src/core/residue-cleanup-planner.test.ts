import assert from "node:assert/strict";
import test from "node:test";

import {
  buildResidueCleanupPlan,
  renderResidueCleanupPlanMarkdown,
  type ResidueCleanupPlannerInput,
  type ResidueCleanupPolicyMode,
} from "./residue-cleanup-planner.js";
import type {
  CleanupCandidate,
  CleanupCandidateActionability,
  CleanupCandidateClass,
  CleanupRiskClass,
} from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOW = "2026-05-20T11:30:00.000Z";

function candidateFor(
  cls: CleanupCandidateClass,
  entityId: string,
  options: {
    risk?: CleanupRiskClass;
    actionability?: CleanupCandidateActionability;
    reason?: string;
    ageMs?: number;
  } = {},
): CleanupCandidate {
  return {
    id: "cleanup:" + cls + ":" + encodeURIComponent(entityId),
    class: cls,
    entityId,
    reason: options.reason ?? cls + " candidate: " + entityId,
    risk: options.risk ?? "caution",
    actionability: options.actionability ?? "advisory",
    actionabilityReason: "test fixture",
    updatedAt: NOW,
    ageMs: options.ageMs ?? 600_000,
  };
}

function makeInput(
  candidates: CleanupCandidate[],
  overrides: Partial<ResidueCleanupPlannerInput> = {},
): ResidueCleanupPlannerInput {
  return {
    candidates,
    policyMode: overrides.policyMode ?? "draft",
    parentRef: overrides.parentRef ?? "ref-835",
    evidenceDigest: overrides.evidenceDigest,
    operatorOverride: overrides.operatorOverride,
  };
}

// ---------------------------------------------------------------------------
// Policy mode: off
// ---------------------------------------------------------------------------

test("off mode blocks planning regardless of candidates", () => {
  const plan = buildResidueCleanupPlan(makeInput(
    [candidateFor("queued_residue", "task-1")],
    { policyMode: "off" },
  ), { now: NOW });

  assert.equal(plan.kind, "a2a-broker.residue-cleanup-plan");
  assert.equal(plan.version, 1);
  assert.equal(plan.policyMode, "off");
  assert.equal(plan.decision, "policy_denied");
  assert.ok(plan.blockers.some((b) => b.includes("policy is off")));
  assert.equal(plan.summary.totalCandidates, 1);
  assert.ok(plan.failClosedBoundary.policyPreventsPlanning);
  assert.ok(!plan.actions.some((a) => a.executePermitted));
});

test("off mode with empty candidates returns policy_denied", () => {
  const plan = buildResidueCleanupPlan(makeInput([], { policyMode: "off" }), { now: NOW });

  assert.equal(plan.policyMode, "off");
  assert.equal(plan.decision, "policy_denied");
  assert.equal(plan.summary.totalCandidates, 0);
});

// ---------------------------------------------------------------------------
// Policy mode: draft
// ---------------------------------------------------------------------------

test("draft mode produces approved decision with all executePermitted=false", () => {
  const plan = buildResidueCleanupPlan(makeInput(
    [
      candidateFor("queued_residue", "task-1"),
      candidateFor("stale_worker", "worker-alpha"),
    ],
    { policyMode: "draft" },
  ), { now: NOW });

  assert.equal(plan.policyMode, "draft");
  assert.equal(plan.decision, "approved");
  assert.equal(plan.summary.totalCandidates, 2);
  assert.equal(plan.groups.length, 2);
  assert.ok(plan.idempotencyKey.startsWith("residue-cleanup:"));
  assert.ok(!plan.actions.some((a) => a.executePermitted));
});

test("draft mode with empty candidates produces approved no-op plan", () => {
  const plan = buildResidueCleanupPlan(makeInput([], { policyMode: "draft" }), { now: NOW });

  assert.equal(plan.policyMode, "draft");
  assert.equal(plan.decision, "approved");
  assert.equal(plan.summary.totalCandidates, 0);
  assert.equal(plan.groups.length, 0);
  assert.ok(plan.warnings.some((w) => w.includes("no cleanup candidates")));
});

// ---------------------------------------------------------------------------
// Policy mode: advisory_only
// ---------------------------------------------------------------------------

test("advisory_only mode surfaces advisory notes but blocks all execution", () => {
  const plan = buildResidueCleanupPlan(makeInput(
    [
      candidateFor("queued_residue", "task-1", { risk: "caution" }),
      candidateFor("historical_terminal_task", "task-2", { risk: "safe" }),
    ],
    { policyMode: "advisory_only" },
  ), { now: NOW });

  assert.equal(plan.policyMode, "advisory_only");
  assert.equal(plan.decision, "approved");
  assert.equal(plan.summary.totalCandidates, 2);

  // Should have advisory_note actions, not safe_prune
  assert.ok(plan.actions.some((a) => a.kind === "advisory_note"));
  assert.ok(!plan.actions.some((a) => a.kind === "safe_prune"));
  assert.ok(!plan.actions.some((a) => a.executePermitted));
});

// ---------------------------------------------------------------------------
// Policy mode: advisory_and_prune
// ---------------------------------------------------------------------------

test("advisory_and_prune mode marks safe items as prune-eligible", () => {
  const plan = buildResidueCleanupPlan(makeInput(
    [
      candidateFor("historical_terminal_task", "task-1", { risk: "safe" }),
      candidateFor("queued_residue", "task-2", { risk: "caution" }),
    ],
    { policyMode: "advisory_and_prune" },
  ), { now: NOW });

  assert.equal(plan.policyMode, "advisory_and_prune");
  assert.equal(plan.decision, "approved");
  assert.equal(plan.summary.totalCandidates, 2);

  // safe_prune action for the safe item
  assert.ok(plan.actions.some((a) => a.kind === "safe_prune"));
  const pruneAction = plan.actions.find((a) => a.kind === "safe_prune")!;
  assert.equal(pruneAction.count, 1);
  assert.equal(pruneAction.targetClass, "historical_terminal_task");
  assert.ok(pruneAction.requiresApproval);
  assert.ok(!pruneAction.executePermitted);

  // operator_review for the caution item
  assert.ok(plan.actions.some((a) => a.kind === "operator_review"));
});

test("advisory_and_prune mode only marks safe items as prune-eligible", () => {
  const plan = buildResidueCleanupPlan(makeInput(
    [
      candidateFor("queued_residue", "task-caution", { risk: "caution" }),
      candidateFor("orphaned_claim", "task-high", { risk: "high_risk" }),
    ],
    { policyMode: "advisory_and_prune" },
  ), { now: NOW });

  // No safe_prune actions since no items have risk=safe
  assert.ok(!plan.actions.some((a) => a.kind === "safe_prune"));
  // But operator_review should be present for caution/high items
  assert.ok(plan.actions.some((a) => a.kind === "operator_review"));
});

// ---------------------------------------------------------------------------
// High-risk items
// ---------------------------------------------------------------------------

test("plan surfaces warning for high-risk candidates", () => {
  const plan = buildResidueCleanupPlan(makeInput(
    [
      candidateFor("orphaned_claim", "task-orphan", { risk: "high_risk" }),
    ],
    { policyMode: "advisory_only" },
  ), { now: NOW });

  assert.ok(plan.failClosedBoundary.highRiskItemsExist);
  assert.ok(plan.warnings.some((w) => w.includes("high-risk")));
});

// ---------------------------------------------------------------------------
// Blocked items
// ---------------------------------------------------------------------------

test("plan surfaces warnings for blocked candidates", () => {
  const plan = buildResidueCleanupPlan(makeInput(
    [
      candidateFor("malformed_task", "task-bad", {
        actionability: "blocked",
        risk: "caution",
      }),
    ],
    { policyMode: "advisory_only" },
  ), { now: NOW });

  assert.ok(plan.failClosedBoundary.blockedItemsExist);
  assert.ok(plan.warnings.some((w) => w.includes("blocked")));
});

// ---------------------------------------------------------------------------
// All candidate classes
// ---------------------------------------------------------------------------

test("plan handles all candidate classes", () => {
  const allClasses: CleanupCandidateClass[] = [
    "stale_worker",
    "orphaned_claim",
    "queued_residue",
    "terminal_outbox_backlog",
    "historical_terminal_task",
    "malformed_task",
  ];

  const candidates = allClasses.map((cls) =>
    candidateFor(cls, cls + "-entity", { risk: "caution" }),
  );

  const plan = buildResidueCleanupPlan(makeInput(candidates, { policyMode: "draft" }), { now: NOW });

  assert.equal(plan.summary.totalCandidates, 6);
  assert.equal(plan.groups.length, 6);
  for (const group of plan.groups) {
    assert.equal(group.count, 1);
    assert.equal(group.aggregateRisk, "caution");
  }
});

// ---------------------------------------------------------------------------
// Operator override
// ---------------------------------------------------------------------------

test("operator override surfaces warning", () => {
  const plan = buildResidueCleanupPlan(makeInput(
    [candidateFor("queued_residue", "task-1")],
    { policyMode: "advisory_only", operatorOverride: "manual-unblock-R22" },
  ), { now: NOW });

  assert.ok(plan.failClosedBoundary.operatorOverridePresent);
  assert.ok(plan.warnings.some((w) => w.includes("operator override")));
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

test("identical input produces identical idempotency key", () => {
  const input = makeInput(
    [candidateFor("queued_residue", "task-1", { risk: "caution" })],
    { policyMode: "draft", evidenceDigest: "abc123" },
  );

  const plan1 = buildResidueCleanupPlan(input, { now: NOW });
  const plan2 = buildResidueCleanupPlan(input, { now: NOW });

  assert.equal(plan1.idempotencyKey, plan2.idempotencyKey);
});

test("different evidence digest produces different idempotency key", () => {
  const inputA = makeInput(
    [candidateFor("queued_residue", "task-1")],
    { policyMode: "draft", evidenceDigest: "abc" },
  );
  const inputB = makeInput(
    [candidateFor("queued_residue", "task-1")],
    { policyMode: "draft", evidenceDigest: "xyz" },
  );

  const planA = buildResidueCleanupPlan(inputA, { now: NOW });
  const planB = buildResidueCleanupPlan(inputB, { now: NOW });

  assert.notEqual(planA.idempotencyKey, planB.idempotencyKey);
});

test("different policy mode produces different idempotency key", () => {
  const candidates = [candidateFor("queued_residue", "task-1")];

  const planA = buildResidueCleanupPlan(makeInput(candidates, { policyMode: "draft" }), { now: NOW });
  const planB = buildResidueCleanupPlan(makeInput(candidates, { policyMode: "advisory_only" }), { now: NOW });

  assert.notEqual(planA.idempotencyKey, planB.idempotencyKey);
});

// ---------------------------------------------------------------------------
// Markdown rendering
// ---------------------------------------------------------------------------

test("renderResidueCleanupPlanMarkdown produces non-empty output for each decision", () => {
  for (const mode of ["off", "draft", "advisory_only", "advisory_and_prune"] as ResidueCleanupPolicyMode[]) {
    const plan = buildResidueCleanupPlan(makeInput(
      [candidateFor("queued_residue", "task-1")],
      { policyMode: mode },
    ), { now: NOW });

    const md = renderResidueCleanupPlanMarkdown(plan);
    assert.ok(md.length > 50, "markdown should be non-trivial for mode " + mode);
    assert.ok(md.includes("Residue cleanup plan"), "markdown should contain title");
    assert.ok(md.includes("Policy mode"), "markdown should show policy mode");
    assert.ok(md.includes(plan.idempotencyKey), "markdown should contain idempotency key");
  }
});

test("renderResidueCleanupPlanMarkdown renders empty candidate plan", () => {
  const plan = buildResidueCleanupPlan(makeInput([], { policyMode: "draft" }), { now: NOW });
  const md = renderResidueCleanupPlanMarkdown(plan);
  assert.ok(md.includes("Residue cleanup plan"));
  assert.ok(md.includes("0"));
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

test("candidates with mixed arrival order produce consistent groups", () => {
  const unordered = [
    candidateFor("queued_residue", "task-1"),
    candidateFor("stale_worker", "worker-alpha"),
    candidateFor("queued_residue", "task-2"),
  ];

  const plan = buildResidueCleanupPlan(makeInput(unordered, { policyMode: "draft" }), { now: NOW });

  // Groups should be in canonical order: stale_worker first, then queued_residue
  assert.equal(plan.groups[0].class, "stale_worker");
  assert.equal(plan.groups[0].count, 1);
  assert.equal(plan.groups[1].class, "queued_residue");
  assert.equal(plan.groups[1].count, 2);
  assert.equal(plan.summary.totalCandidates, 3);
});

test("plan summary counts are correct with mixed actionability", () => {
  const candidates: CleanupCandidate[] = [
    candidateFor("historical_terminal_task", "task-safe", { risk: "safe", actionability: "retention_not_due" }),
    candidateFor("queued_residue", "task-advisory", { risk: "caution", actionability: "advisory" }),
    candidateFor("malformed_task", "task-blocked", { risk: "caution", actionability: "blocked" }),
  ];

  const plan = buildResidueCleanupPlan(makeInput(candidates, { policyMode: "advisory_only" }), { now: NOW });

  assert.equal(plan.summary.totalCandidates, 3);
  assert.equal(plan.summary.actionableCount, 2); // safe + advisory = 2, blocked = 0
  assert.equal(plan.summary.blockedCount, 1);
  assert.equal(plan.summary.highestRisk, "caution");
});

// ---------------------------------------------------------------------------
// Safety boundary assertions
// ---------------------------------------------------------------------------

test("failClosedBoundary is always present with correct contract", () => {
  const plan = buildResidueCleanupPlan(makeInput(
    [candidateFor("queued_residue", "task-1")],
    { policyMode: "advisory_and_prune" },
  ), { now: NOW });

  assert.equal(plan.failClosedBoundary.noEventDrivenExecution, true);
  assert.equal(plan.failClosedBoundary.noDbMutationWithoutOperatorGate, true);
  assert.equal(plan.failClosedBoundary.noTerminalAckOrReplay, true);
});

test("all actions have executePermitted=false across all policy modes", () => {
  for (const mode of ["off", "draft", "advisory_only", "advisory_and_prune"] as ResidueCleanupPolicyMode[]) {
    const plan = buildResidueCleanupPlan(makeInput(
      [
        candidateFor("queued_residue", "task-1"),
        candidateFor("stale_worker", "worker-alpha"),
        candidateFor("orphaned_claim", "task-orphan", { risk: "high_risk" }),
      ],
      { policyMode: mode },
    ), { now: NOW });

    assert.ok(plan.actions.every((a) => a.executePermitted === false),
      "all actions must have executePermitted=false for mode " + mode);
  }
});
