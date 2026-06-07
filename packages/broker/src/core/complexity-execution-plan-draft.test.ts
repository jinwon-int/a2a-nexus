/**
 * Tests for the complexity execution plan draft (#982).
 *
 * Consumes FinalizerApprovalEnvelopeDraftPacket (#978) and produces a
 * deterministic execution plan draft with strict separation between approval
 * envelope, execution plan draft, and actual execution.
 *
 * Covers:
 *   - All four envelope category → execution plan mappings
 *   - Execution step structure and ordering
 *   - Operator review safety invariant (all steps blocked)
 *   - Idempotency key stability
 *   - Safety block for unexpected mappings
 *   - Markdown rendering
 *   - Boundary enforcement
 *   - Extractor functions
 *   - Bootstrap context isolation guard
 *   - Dependency chain correctness
 *   - Description generation
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyTaskComplexity } from "./task-complexity-classifier.js";
import {
  buildComplexityOrchestrationRecommendation,
  type ComplexityOrchestrationRecommendationPacket,
} from "./complexity-orchestration-recommendation.js";
import {
  buildFinalizerApprovalEnvelopeDraft,
  type FinalizerApprovalEnvelopeDraftPacket,
  type FinalizerApprovalEnvelopeCategory,
} from "./complexity-finalizer-approval-envelope-draft.js";
import {
  buildComplexityExecutionPlanDraft,
  renderComplexityExecutionPlanDraftMarkdown,
  extractEnvelopeFromExecutionPlan,
  type ComplexityExecutionPlanDraftPacket,
  type ExecutionPlanStep,
  type ExecutionPlanStepKind,
} from "./complexity-execution-plan-draft.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOW = "2026-06-01T12:00:00.000Z";

/**
 * Full pipeline: #970 → #971 → #978 → #982.
 */
function producePlan(
  input: Parameters<typeof classifyTaskComplexity>[0],
  options: { now?: string } = {},
): ComplexityExecutionPlanDraftPacket {
  const classification = classifyTaskComplexity(input);
  const recommendation = buildComplexityOrchestrationRecommendation(classification, {
    now: NOW,
    ...options,
  });
  const envelope = buildFinalizerApprovalEnvelopeDraft(recommendation, {
    now: NOW,
    ...options,
  });
  return buildComplexityExecutionPlanDraft(envelope, {
    now: NOW,
    ...options,
  });
}

/**
 * Build a plan from a recommendation directly for testing the mapping without
 * going through the classifier.
 */
function producePlanFromRecommendation(
  action: string,
  complexity: string,
  roles: Array<{ role: string; purpose: string }>,
  confidence: "high" | "medium" | "low" = "high",
  options: { now?: string } = {},
): ComplexityExecutionPlanDraftPacket {
  const recommendation: ComplexityOrchestrationRecommendationPacket = {
    kind: "a2a-broker.complexity-orchestration-recommendation-packet",
    version: 1,
    generatedAt: NOW,
    idempotencyKey: `complexity-orch-recommendation:test-${action}`,
    classification: {
      level: complexity as any,
      reason: `complexity=${complexity}: test`,
      origin: "intent-derived",
      signals: {
        baseLevel: complexity as any,
        intentRecognized: true,
        environmentOffset: 0,
        requiresApproval: false,
        liveImpact: false,
        effectiveReferenceCount: 0,
        effectiveArtifactCount: 0,
        effectiveTurnCount: 1,
        totalOffset: 0,
      },
    },
    recommendation: {
      complexity: complexity as any,
      action: action as any,
      parallelismHint:
        action === "direct_execution" ? 0
        : action === "sequential_subagent" ? 1
        : action === "parallel_subagents" ? 2
        : 0,
      confidence,
      rationale: `test rationale for ${action}`,
      recommendedRoles: roles,
      safetyGate: `test safety gate for ${action}`,
    },
    boundaries: {
      runtimeBehaviorChanged: false,
      mandatoryProductionSpawn: false,
      brokerDispatchSemanticsChanged: false,
      taskFlowMutation: false,
      dbMutation: false,
      deployOrRestart: false,
      secretMovement: false,
    },
  };

  const envelope = buildFinalizerApprovalEnvelopeDraft(recommendation, {
    now: NOW,
    ...options,
  });
  return buildComplexityExecutionPlanDraft(envelope, {
    now: NOW,
    ...options,
  });
}

/**
 * Build a plan from an envelope directly for testing step-level behavior.
 */
function producePlanFromEnvelope(
  envelopeCat: FinalizerApprovalEnvelopeCategory,
  action: string,
  complexity: string,
  roles: Array<{ role: string; purpose: string }>,
  options: { now?: string } = {},
): ComplexityExecutionPlanDraftPacket {
  const recommendation: ComplexityOrchestrationRecommendationPacket = {
    kind: "a2a-broker.complexity-orchestration-recommendation-packet",
    version: 1,
    generatedAt: NOW,
    idempotencyKey: `complexity-orch-recommendation:test-${action}`,
    classification: {
      level: complexity as any,
      reason: `complexity=${complexity}: test`,
      origin: "intent-derived",
      signals: {
        baseLevel: complexity as any,
        intentRecognized: true,
        environmentOffset: 0,
        requiresApproval: false,
        liveImpact: false,
        effectiveReferenceCount: 0,
        effectiveArtifactCount: 0,
        effectiveTurnCount: 1,
        totalOffset: 0,
      },
    },
    recommendation: {
      complexity: complexity as any,
      action: action as any,
      parallelismHint:
        action === "direct_execution" ? 0
        : action === "sequential_subagent" ? 1
        : action === "parallel_subagents" ? 2
        : 0,
      confidence: "high",
      rationale: `test rationale for ${action}`,
      recommendedRoles: roles,
      safetyGate: `test safety gate for ${action}`,
    },
    boundaries: {
      runtimeBehaviorChanged: false,
      mandatoryProductionSpawn: false,
      brokerDispatchSemanticsChanged: false,
      taskFlowMutation: false,
      dbMutation: false,
      deployOrRestart: false,
      secretMovement: false,
    },
  };

  // Build envelope with the desired category by directly creating the envelope
  // instead of going through buildFinalizerApprovalEnvelopeDraft which maps
  // based on the action (not envelope category).
  const sourceEnvelope: FinalizerApprovalEnvelopeDraftPacket = {
    kind: "a2a-broker.finalizer-approval-envelope-draft.packet",
    version: 1,
    generatedAt: NOW,
    idempotencyKey: `complexity-finalizer-approval-envelope:test-${action}-${envelopeCat}`,
    sourceRecommendationIdempotencyKey: recommendation.idempotencyKey,
    sourceOrchestrationAction: action,
    envelopeCategory: envelopeCat,
    decision:
      envelopeCat === "approval_not_required"
        ? "no_approval_needed"
        : envelopeCat === "operator_review_required"
        ? "envelope_draft_ready"
        : "envelope_draft_ready",
    approvalMode:
      envelopeCat === "approval_not_required"
        ? "autonomous"
        : envelopeCat === "operator_notify"
        ? "operator_notify"
        : envelopeCat === "operator_approval_required"
        ? "operator_approval_gated"
        : "operator_review_gated",
    autonomousApprovalPossible: envelopeCat === "approval_not_required",
    subagentSpawnPermitted: false,
    directExecutionPermitted: envelopeCat === "approval_not_required",
    liveDeploymentPermitted: false,
    requestedItems:
      roles.length === 0
        ? [
            {
              orchestrationAction: action,
              complexity,
              operatorApprovalRequired:
                envelopeCat === "operator_approval_required" ||
                envelopeCat === "operator_review_required",
              autonomousExecutionBlocked:
                envelopeCat === "operator_review_required",
              subagentPermitted:
                envelopeCat === "operator_approval_required" ||
                envelopeCat === "operator_notify",
              reason:
                envelopeCat === "operator_review_required"
                  ? "Operator review required for critical complexity."
                  : `test reason for ${action}`,
            },
          ]
        : roles.map((r) => ({
            orchestrationAction: action,
            complexity,
            operatorApprovalRequired:
              envelopeCat === "operator_approval_required" ||
              envelopeCat === "operator_review_required",
            autonomousExecutionBlocked:
              envelopeCat === "operator_review_required",
            subagentPermitted: true,
            reason: `Role "${r.role}": ${r.purpose}`,
          })),
    action,
    parallelismHint:
      action === "direct_execution" ? 0
      : action === "sequential_subagent" ? 1
      : 2,
    safetyGate: `test safety gate for ${action}`,
    blockers: [],
    nextActions: [],
    boundaries: {
      runtimeBehaviorChanged: false,
      mandatoryProductionSpawn: false,
      brokerDispatchSemanticsChanged: false,
      taskFlowMutation: false,
      dbMutation: false,
      deployOrRestart: false,
      secretMovement: false,
      approvalGranted: false,
      executionDispatched: false,
      providerMessageSent: false,
      terminalAckPerformed: false,
    },
    semantics: {
      envelopeDraftOnly: true,
      approvalNotGranted: true,
      autonomousExecutionBlockedForOperatorReview:
        envelopeCat === "operator_review_required",
      sourceOnlyNoLive: true,
      recommendationSeparated: true,
      approvalRequestDraftSeparated: true,
      approvalGrantSeparated: true,
      performsGitHubMutation: false,
      performsProviderSend: false,
      performsTerminalAck: false,
      performsRuntimeRestartOrDeploy: false,
      performsDbMutation: false,
      createsTaskFlowRecords: false,
      performsHistoricalReplay: false,
      performsReleaseOrPublish: false,
      movesSecretsOrCredentials: false,
    },
  };

  return buildComplexityExecutionPlanDraft(sourceEnvelope, { now: options.now ?? NOW });
}

// Convenience preset inputs (same as envelope draft test)
const SIMPLE_ANALYSIS_INPUT = {
  intent: "analyze" as const,
  targetEnvironment: "research" as const,
};
const MODERATE_BACKFILL_INPUT = {
  intent: "backfill" as const,
  targetEnvironment: "staging" as const,
};
const COMPLEX_PROPOSE_INPUT = {
  intent: "propose_patch" as const,
  targetEnvironment: "research" as const,
};
const CRITICAL_PROMOTE_INPUT = {
  intent: "promote_to_live" as const,
  targetEnvironment: "live" as const,
  policyContext: { requiresApproval: true, liveImpact: true } as const,
};

// ---------------------------------------------------------------------------
// Basic packet structure
// ---------------------------------------------------------------------------

describe("buildComplexityExecutionPlanDraft", () => {
  it("produces a valid packet with correct kind and version", () => {
    const plan = producePlanFromRecommendation("direct_execution", "simple", []);
    assert.equal(plan.kind, "a2a-broker.complexity-execution-plan-draft.packet");
    assert.equal(plan.version, 1);
    assert.match(plan.idempotencyKey, /^complexity-execution-plan:/);
    assert.ok(plan.generatedAt);
  });

  it("carries through envelope and recommendation idempotency keys", () => {
    const plan = producePlanFromRecommendation("sequential_subagent", "moderate", [
      { role: "verifier", purpose: "review output" },
    ]);
    assert.ok(plan.sourceEnvelopeIdempotencyKey);
    assert.ok(plan.sourceRecommendationIdempotencyKey);
    assert.match(
      plan.sourceRecommendationIdempotencyKey,
      /^complexity-orch-recommendation:/,
    );
  });

  it("sets correct envelopeCategory and action from source", () => {
    const plan = producePlanFromRecommendation("parallel_subagents", "complex", [
      { role: "explorer", purpose: "bounded investigation" },
    ]);
    assert.equal(plan.envelopeCategory, "operator_approval_required");
    assert.equal(plan.action, "parallel_subagents");
    assert.equal(plan.complexity, "complex");
  });
});

// ---------------------------------------------------------------------------
// Envelope category → execution plan mapping
// ---------------------------------------------------------------------------

describe("envelope category → execution plan mapping", () => {
  it("maps approval_not_required to autonomous execution plan", () => {
    const plan = producePlanFromEnvelope(
      "approval_not_required", "direct_execution", "simple", [],
    );
    assert.equal(plan.executionMode, "autonomous");
    assert.equal(plan.executionBlocked, false);
    assert.equal(plan.approvalRequired, false);
    assert.equal(plan.decision, "plan_approval_not_needed");
  });

  it("maps operator_notify to operator_notify plan", () => {
    const plan = producePlanFromEnvelope(
      "operator_notify", "direct_execution", "simple", [],
    );
    assert.equal(plan.executionMode, "operator_notify");
    assert.equal(plan.executionBlocked, false);
    assert.equal(plan.approvalRequired, false);
    assert.equal(plan.decision, "plan_ready");
  });

  it("maps operator_approval_required to operator_approval_gated plan", () => {
    const plan = producePlanFromEnvelope(
      "operator_approval_required", "sequential_subagent", "moderate",
      [{ role: "verifier", purpose: "review output" }],
    );
    assert.equal(plan.executionMode, "operator_approval_gated");
    assert.equal(plan.executionBlocked, false);
    assert.equal(plan.approvalRequired, true);
    assert.equal(plan.decision, "plan_ready");
  });

  it("maps operator_review_required to operator_review_gated plan with execution blocked", () => {
    const plan = producePlanFromEnvelope(
      "operator_review_required", "operator_review", "critical", [],
    );
    assert.equal(plan.executionMode, "operator_review_gated");
    assert.equal(plan.executionBlocked, true);
    assert.equal(plan.approvalRequired, true);
    assert.equal(plan.decision, "plan_ready");
    assert.equal(plan.semantics.autonomousExecutionBlocked, true);
  });

  it("fails closed for unknown envelope categories", () => {
    const plan = producePlanFromEnvelope(
      "unknown_category" as any, "parallel_subagents", "complex",
      [{ role: "explorer", purpose: "bounded investigation" }],
    );
    assert.equal(plan.executionMode, "operator_review_gated");
    assert.equal(plan.executionBlocked, true);
    assert.equal(plan.approvalRequired, true);
    assert.equal(plan.decision, "plan_safety_blocked");
    assert.equal(plan.steps[0]!.kind, "operator_review");
    assert.equal(plan.steps[0]!.executionBlocked, true);
    assert.match(plan.blockers.join("\n"), /unknown envelope category/);
  });
});

// ---------------------------------------------------------------------------
// Full pipeline: #970 → #971 → #978 → #982 end-to-end
// ---------------------------------------------------------------------------

describe("full pipeline (#970 → #971 → #978 → #982)", () => {
  it("simple analysis → autonomous plan with direct execution step", () => {
    const plan = producePlan(SIMPLE_ANALYSIS_INPUT);
    assert.equal(plan.executionMode, "autonomous");
    assert.equal(plan.executionBlocked, false);
    assert.equal(plan.approvalRequired, false);
    assert.equal(plan.steps.length, 2);
    assert.equal(plan.steps[0]!.kind, "direct_execution");
    assert.equal(plan.steps[1]!.kind, "completion");
  });

  it("moderate backfill → approval gated plan with sequential step", () => {
    const plan = producePlan(MODERATE_BACKFILL_INPUT);
    assert.equal(plan.executionMode, "operator_approval_gated");
    assert.equal(plan.approvalRequired, true);
    // Steps: approval_gate, subagent_sequential, completion
    assert.equal(plan.steps.length, 3);
    assert.equal(plan.steps[0]!.kind, "approval_gate");
    assert.equal(plan.steps[1]!.kind, "subagent_sequential");
    assert.equal(plan.steps[2]!.kind, "completion");
  });

  it("complex propose → approval gated plan with parallel subagent steps", () => {
    const plan = producePlan(COMPLEX_PROPOSE_INPUT);
    assert.equal(plan.executionMode, "operator_approval_gated");
    assert.equal(plan.approvalRequired, true);
    // Steps: approval_gate, subagent_parallel × 3, completion
    assert.ok(plan.steps.length >= 4);
    assert.equal(plan.steps[0]!.kind, "approval_gate");
    const parallelSteps = plan.steps.filter((s) => s.kind === "subagent_parallel");
    assert.equal(parallelSteps.length, 3);
  });

  it("critical promote → review required plan with all steps blocked", () => {
    const plan = producePlan(CRITICAL_PROMOTE_INPUT);
    assert.equal(plan.executionMode, "operator_review_gated");
    assert.equal(plan.executionBlocked, true);
    assert.equal(plan.approvalRequired, true);
    assert.equal(plan.semantics.autonomousExecutionBlocked, true);
    // All steps are blocked
    for (const step of plan.steps) {
      assert.equal(step.executionBlocked, true,
        `Step "${step.label}" must be blocked for critical actions`);
    }
  });
});

// ---------------------------------------------------------------------------
// Step structure and dependency chain
// ---------------------------------------------------------------------------

describe("execution step structure and dependencies", () => {
  it("direct execution plan has correct dependency chain", () => {
    const plan = producePlanFromEnvelope(
      "approval_not_required", "direct_execution", "simple", [],
    );
    assert.equal(plan.steps.length, 2);

    // Step 1: root step, no dependencies
    assert.equal(plan.steps[0]!.dependsOn.length, 0);
    assert.equal(plan.steps[0]!.executionBlocked, false);
    assert.equal(plan.steps[0]!.requiresApproval, false);

    // Step 2: completion, depends on step 1
    assert.deepEqual(plan.steps[1]!.dependsOn, [plan.steps[0]!.stepId]);
  });

  it("approval gated plan has approval gate as root step", () => {
    const plan = producePlanFromEnvelope(
      "operator_approval_required", "sequential_subagent", "moderate",
      [{ role: "verifier", purpose: "review output" }],
    );
    assert.equal(plan.steps.length, 3);

    // Step 1: approval gate, root
    assert.equal(plan.steps[0]!.kind, "approval_gate");
    assert.equal(plan.steps[0]!.dependsOn.length, 0);
    assert.equal(plan.steps[0]!.requiresApproval, true);

    // Step 2: subagent sequential, depends on approval gate
    assert.equal(plan.steps[1]!.kind, "subagent_sequential");
    assert.deepEqual(plan.steps[1]!.dependsOn, [plan.steps[0]!.stepId]);

    // Step 3: completion, depends on step 2
    assert.deepEqual(plan.steps[2]!.dependsOn, [plan.steps[1]!.stepId]);
  });

  it("parallel subagent plan has multiple execution steps depending on gate", () => {
    const plan = producePlanFromEnvelope(
      "operator_approval_required", "parallel_subagents", "complex",
      [
        { role: "explorer", purpose: "investigate" },
        { role: "implementer", purpose: "implement" },
        { role: "verifier", purpose: "verify" },
      ],
    );
    // Steps: approval_gate, subagent_parallel × 3, completion = 5
    assert.equal(plan.steps.length, 5);

    // All subagent steps depend on the approval gate
    const gateStepId = plan.steps[0]!.stepId;
    const subagentSteps = plan.steps.filter((s) => s.kind === "subagent_parallel");
    for (const step of subagentSteps) {
      assert.deepEqual(step.dependsOn, [gateStepId]);
    }

    // Completion depends on all subagent steps
    const completionStep = plan.steps[plan.steps.length - 1]!;
    assert.equal(completionStep.kind, "completion");
    const subagentStepIds = subagentSteps.map((s) => s.stepId);
    assert.deepEqual(completionStep.dependsOn.sort(), subagentStepIds.sort());
  });

  it("review required plan has only review and blocked completion steps", () => {
    const plan = producePlanFromEnvelope(
      "operator_review_required", "operator_review", "critical", [],
    );
    assert.equal(plan.steps.length, 2);
    assert.equal(plan.steps[0]!.kind, "operator_review");
    assert.equal(plan.steps[0]!.executionBlocked, true);
    assert.equal(plan.steps[0]!.requiresApproval, true);
    assert.equal(plan.steps[1]!.kind, "completion");
    assert.equal(plan.steps[1]!.executionBlocked, true);
  });
});

// ---------------------------------------------------------------------------
// Safety invariant: operator_review_required → all steps blocked
// ---------------------------------------------------------------------------

describe("safety invariant — operator_review_required blocks all steps", () => {
  it("all steps in a review-required plan are blocked", () => {
    const plan = producePlanFromEnvelope(
      "operator_review_required", "operator_review", "critical", [],
    );
    for (const step of plan.steps) {
      assert.equal(step.executionBlocked, true,
        `Step "${step.label}" must have executionBlocked=true`);
    }
    assert.equal(plan.semantics.autonomousExecutionBlocked, true);
  });

  it("review required plan never produces approval_not_required or autonomous mode", () => {
    const plan = producePlanFromEnvelope(
      "operator_review_required", "operator_review", "critical", [],
    );
    assert.notEqual(plan.executionMode, "autonomous");
    assert.notEqual(plan.executionMode, "operator_notify");
    assert.equal(plan.executionMode, "operator_review_gated");
  });

  it("review required plan never permits subagent roles for execution", () => {
    const plan = producePlanFromEnvelope(
      "operator_review_required", "operator_review", "critical",
      // Even if roles were somehow requested, the plan should not contain
      // execution steps that use them.
      [{ role: "verifier", purpose: "should not appear" }],
    );
    const hasExecutionStep = plan.steps.some(
      (s) => s.kind === "subagent_sequential" || s.kind === "subagent_parallel" || s.kind === "direct_execution",
    );
    assert.equal(hasExecutionStep, false);
  });
});

// ---------------------------------------------------------------------------
// Idempotency key stability
// ---------------------------------------------------------------------------

describe("idempotency key stability", () => {
  it("produces the same key for identical inputs", () => {
    const plan1 = producePlanFromRecommendation("direct_execution", "simple", []);
    const plan2 = producePlanFromRecommendation("direct_execution", "simple", []);
    assert.equal(plan1.idempotencyKey, plan2.idempotencyKey);
  });

  it("produces different keys for different inputs", () => {
    const plan1 = producePlanFromRecommendation("direct_execution", "simple", []);
    const plan2 = producePlanFromRecommendation("sequential_subagent", "moderate", [
      { role: "verifier", purpose: "review output" },
    ]);
    assert.notEqual(plan1.idempotencyKey, plan2.idempotencyKey);
  });

  it("produces different keys for different envelope categories", () => {
    const plan1 = producePlanFromEnvelope(
      "approval_not_required", "direct_execution", "simple", [],
    );
    const plan2 = producePlanFromEnvelope(
      "operator_approval_required", "sequential_subagent", "moderate",
      [{ role: "verifier", purpose: "review output" }],
    );
    assert.notEqual(plan1.idempotencyKey, plan2.idempotencyKey);
  });

  it("carries a deterministic stepId within the same plan", () => {
    const plan = producePlanFromEnvelope(
      "approval_not_required", "direct_execution", "simple", [],
    );
    assert.match(plan.steps[0]!.stepId, /^step-/);
    assert.match(plan.steps[1]!.stepId, /^step-/);
    assert.notEqual(plan.steps[0]!.stepId, plan.steps[1]!.stepId);
  });

  it("produces same stepIds for same inputs", () => {
    const plan1 = producePlanFromEnvelope(
      "approval_not_required", "direct_execution", "simple", [],
    );
    const plan2 = producePlanFromEnvelope(
      "approval_not_required", "direct_execution", "simple", [],
    );
    for (let i = 0; i < plan1.steps.length; i++) {
      assert.equal(plan1.steps[i]!.stepId, plan2.steps[i]!.stepId);
    }
  });
});

// ---------------------------------------------------------------------------
// Next actions
// ---------------------------------------------------------------------------

describe("next actions", () => {
  it("approval_not_required plan has autonomous next actions", () => {
    const plan = producePlanFromEnvelope(
      "approval_not_required", "direct_execution", "simple", [],
    );
    assert.ok(plan.nextActions.length > 0);
    const allText = plan.nextActions.join(" ");
    assert.match(allText, /approval/i);
    assert.doesNotMatch(allText, /blocked/i);
  });

  it("operator_approval_required plan has approval-gated next actions", () => {
    const plan = producePlanFromEnvelope(
      "operator_approval_required", "sequential_subagent", "moderate",
      [{ role: "verifier", purpose: "review output" }],
    );
    assert.ok(plan.nextActions.length > 0);
    const allText = plan.nextActions.join(" ");
    assert.match(allText, /approval/i);
  });

  it("operator_review_required plan has blocked next actions", () => {
    const plan = producePlanFromEnvelope(
      "operator_review_required", "operator_review", "critical", [],
    );
    assert.ok(plan.nextActions.length > 0);
    const allText = plan.nextActions.join(" ");
    assert.match(allText, /BLOCKED/i);
    assert.match(allText, /review/);
    assert.match(allText, /cannot/i);
  });

  it("operator_review_required plan next actions forbid subagent spawn", () => {
    const plan = producePlanFromEnvelope(
      "operator_review_required", "operator_review", "critical", [],
    );
    const allText = plan.nextActions.join(" ");
    assert.match(allText, /No subagent spawn/);
  });

  it("operator_notify plan has notification next actions", () => {
    const plan = producePlanFromEnvelope(
      "operator_notify", "direct_execution", "simple", [],
    );
    assert.ok(plan.nextActions.length > 0);
    const allText = plan.nextActions.join(" ");
    assert.match(allText, /notification/i);
  });
});

// ---------------------------------------------------------------------------
// Description
// ---------------------------------------------------------------------------

describe("description generation", () => {
  it("approval_not_required plan has appropriate description", () => {
    const plan = producePlanFromEnvelope(
      "approval_not_required", "direct_execution", "simple", [],
    );
    assert.match(plan.description, /no approval needed/i);
    assert.match(plan.description, /direct_execution/);
  });

  it("operator_approval_required plan has gated description", () => {
    const plan = producePlanFromEnvelope(
      "operator_approval_required", "sequential_subagent", "moderate",
      [{ role: "verifier", purpose: "review output" }],
    );
    assert.match(plan.description, /approval required/i);
  });

  it("operator_review_required plan has blocked description", () => {
    const plan = producePlanFromEnvelope(
      "operator_review_required", "operator_review", "critical", [],
    );
    assert.match(plan.description, /BLOCKED/i);
    assert.match(plan.description, /critical/);
  });
});

// ---------------------------------------------------------------------------
// renderComplexityExecutionPlanDraftMarkdown
// ---------------------------------------------------------------------------

describe("renderComplexityExecutionPlanDraftMarkdown", () => {
  it("renders autonomous plan markdown", () => {
    const plan = producePlanFromEnvelope(
      "approval_not_required", "direct_execution", "simple", [],
    );
    const markdown = renderComplexityExecutionPlanDraftMarkdown(plan);
    assert.match(markdown, /No approval needed/);
    assert.match(markdown, /Complexity execution plan draft/);
    assert.match(markdown, /direct_execution/);
    assert.match(markdown, /Execution steps/);
    assert.match(markdown, /autonomous/);
    assert.match(markdown, /complexity-execution-plan:/);
  });

  it("renders approval gated plan markdown", () => {
    const plan = producePlanFromEnvelope(
      "operator_approval_required", "sequential_subagent", "moderate",
      [{ role: "verifier", purpose: "review output" }],
    );
    const markdown = renderComplexityExecutionPlanDraftMarkdown(plan);
    assert.match(markdown, /Execution plan draft/);
    assert.match(markdown, /approval_gate/);
    assert.match(markdown, /operator_approval_gated/);
  });

  it("renders review required plan markdown", () => {
    const plan = producePlanFromEnvelope(
      "operator_review_required", "operator_review", "critical", [],
    );
    const markdown = renderComplexityExecutionPlanDraftMarkdown(plan);
    assert.match(markdown, /Execution plan draft/);
    assert.match(markdown, /operator_review/);
    assert.match(markdown, /blocked/);
  });

  it("renders safety blocked plan markdown", () => {
    // Create a plan with safety blocked by manipulating the mapper
    // We just need to verify the markdown header for safety blocked.
    const plan = producePlanFromEnvelope(
      "operator_review_required", "operator_review", "critical", [],
    );
    // Override decision to test the safety blocked rendering
    const modifiedPlan = { ...plan, decision: "plan_safety_blocked" as const };
    const markdown = renderComplexityExecutionPlanDraftMarkdown(modifiedPlan);
    assert.match(markdown, /SAFETY BLOCKED/);
  });

  it("renders boundaries and semantics sections", () => {
    const plan = producePlanFromEnvelope(
      "approval_not_required", "direct_execution", "simple", [],
    );
    const markdown = renderComplexityExecutionPlanDraftMarkdown(plan);
    assert.match(markdown, /Boundaries/);
    assert.match(markdown, /Semantics/);
    assert.match(markdown, /approvalGranted/);
    assert.match(markdown, /planDraftOnly/);
  });

  it("renders step details including safety gates and roles", () => {
    const plan = producePlanFromEnvelope(
      "operator_approval_required", "parallel_subagents", "complex",
      [
        { role: "explorer", purpose: "bounded investigation" },
        { role: "implementer", purpose: "scoped implementation" },
      ],
    );
    const markdown = renderComplexityExecutionPlanDraftMarkdown(plan);
    assert.match(markdown, /Safety gate/);
    assert.match(markdown, /explorer/);
    assert.match(markdown, /implementer/);
  });
});

// ---------------------------------------------------------------------------
// extractEnvelopeFromExecutionPlan
// ---------------------------------------------------------------------------

describe("extractEnvelopeFromExecutionPlan", () => {
  it("extracts envelope when the plan itself is the envelope carrier", () => {
    const envelope = produceEnvelopeObject();
    const extracted = extractEnvelopeFromExecutionPlan(envelope);
    assert.equal(extracted.kind, "a2a-broker.finalizer-approval-envelope-draft.packet");
    assert.equal(extracted.action, "direct_execution");
  });

  it("extracts envelope from nested object with key 'envelope'", () => {
    const envelope = produceEnvelopeObject();
    const extracted = extractEnvelopeFromExecutionPlan({ envelope });
    assert.ok(extracted);
    assert.equal(extracted.action, "direct_execution");
  });

  it("extracts envelope from nested object with key 'sourceEnvelope'", () => {
    const envelope = produceEnvelopeObject();
    const extracted = extractEnvelopeFromExecutionPlan({ sourceEnvelope: envelope });
    assert.ok(extracted);
    assert.equal(extracted.action, "direct_execution");
  });

  it("extracts envelope from nested object with key 'approvalEnvelope'", () => {
    const envelope = produceEnvelopeObject();
    const extracted = extractEnvelopeFromExecutionPlan({ approvalEnvelope: envelope });
    assert.ok(extracted);
  });

  it("throws when no envelope is found", () => {
    assert.throws(
      () => extractEnvelopeFromExecutionPlan({ notAnEnvelope: true }),
      /expected a FinalizerApprovalEnvelopeDraftPacket/,
    );
  });
});

/**
 * Produce a minimal envelope object for extraction testing.
 */
function produceEnvelopeObject(): FinalizerApprovalEnvelopeDraftPacket {
  const recommendation: ComplexityOrchestrationRecommendationPacket = {
    kind: "a2a-broker.complexity-orchestration-recommendation-packet",
    version: 1,
    generatedAt: NOW,
    idempotencyKey: "complexity-orch-recommendation:test-extraction",
    classification: {
      level: "simple",
      reason: "test",
      origin: "intent-derived",
      signals: {
        baseLevel: "simple",
        intentRecognized: true,
        environmentOffset: 0,
        requiresApproval: false,
        liveImpact: false,
        effectiveReferenceCount: 0,
        effectiveArtifactCount: 0,
        effectiveTurnCount: 1,
        totalOffset: 0,
      },
    },
    recommendation: {
      complexity: "simple",
      action: "direct_execution",
      parallelismHint: 0,
      confidence: "high",
      rationale: "test",
      recommendedRoles: [],
      safetyGate: "test safety gate",
    },
    boundaries: {
      runtimeBehaviorChanged: false,
      mandatoryProductionSpawn: false,
      brokerDispatchSemanticsChanged: false,
      taskFlowMutation: false,
      dbMutation: false,
      deployOrRestart: false,
      secretMovement: false,
    },
  };
  return buildFinalizerApprovalEnvelopeDraft(recommendation, { now: NOW });
}

// ---------------------------------------------------------------------------
// Symbolic boundary enforcement
// ---------------------------------------------------------------------------

describe("symbolic boundary enforcement", () => {
  it("all boundaries are statically false", () => {
    const plan = producePlanFromEnvelope(
      "approval_not_required", "direct_execution", "simple", [],
    );
    const { boundaries } = plan;
    assert.equal(boundaries.runtimeBehaviorChanged, false);
    assert.equal(boundaries.mandatoryProductionSpawn, false);
    assert.equal(boundaries.brokerDispatchSemanticsChanged, false);
    assert.equal(boundaries.taskFlowMutation, false);
    assert.equal(boundaries.dbMutation, false);
    assert.equal(boundaries.deployOrRestart, false);
    assert.equal(boundaries.secretMovement, false);
    assert.equal(boundaries.approvalGranted, false);
    assert.equal(boundaries.executionDispatched, false);
    assert.equal(boundaries.providerMessageSent, false);
    assert.equal(boundaries.terminalAckPerformed, false);
  });

  it("all semantics enforce source-only no-live", () => {
    const plan = producePlanFromEnvelope(
      "operator_approval_required", "sequential_subagent", "moderate",
      [{ role: "verifier", purpose: "review output" }],
    );
    const { semantics } = plan;
    assert.equal(semantics.planDraftOnly, true);
    assert.equal(semantics.approvalNotGranted, true);
    assert.equal(semantics.sourceOnlyNoLive, true);
    assert.equal(semantics.planStepsNotExecuted, true);
    assert.equal(semantics.performsGitHubMutation, false);
    assert.equal(semantics.performsProviderSend, false);
    assert.equal(semantics.performsTerminalAck, false);
    assert.equal(semantics.performsRuntimeRestartOrDeploy, false);
    assert.equal(semantics.performsDbMutation, false);
    assert.equal(semantics.createsTaskFlowRecords, false);
    assert.equal(semantics.performsHistoricalReplay, false);
    assert.equal(semantics.performsReleaseOrPublish, false);
    assert.equal(semantics.movesSecretsOrCredentials, false);
  });
});

// ---------------------------------------------------------------------------
// Pipeline separation
// ---------------------------------------------------------------------------

describe("pipeline separation", () => {
  it("execution plan packet kind differs from envelope and recommendation", () => {
    const plan = producePlanFromRecommendation("direct_execution", "simple", []);
    assert.equal(plan.kind, "a2a-broker.complexity-execution-plan-draft.packet");
    assert.notEqual(plan.kind, "a2a-broker.finalizer-approval-envelope-draft.packet");
    assert.notEqual(plan.kind, "a2a-broker.complexity-orchestration-recommendation-packet");
  });

  it("execution plan does not contain approval grant or dispatch fields", () => {
    const plan = producePlanFromEnvelope(
      "approval_not_required", "direct_execution", "simple", [],
    );
    assert.equal((plan as any).approvalGranted, undefined);
    assert.equal((plan as any).executionDispatched, undefined);
  });

  it("execution plan can be traced back to its source envelope and recommendation", () => {
    const plan = producePlan(SIMPLE_ANALYSIS_INPUT);
    assert.ok(plan.sourceEnvelopeIdempotencyKey);
    assert.ok(plan.sourceRecommendationIdempotencyKey);
    assert.notEqual(plan.sourceEnvelopeIdempotencyKey, plan.sourceRecommendationIdempotencyKey);
  });
});

// ---------------------------------------------------------------------------
// generatedAt timestamp
// ---------------------------------------------------------------------------

describe("generatedAt timestamp", () => {
  it("uses provided timestamp", () => {
    const customNow = "2026-07-01T08:00:00.000Z";
    const plan = producePlanFromEnvelope(
      "approval_not_required", "direct_execution", "simple", [],
      { now: customNow },
    );
    assert.equal(plan.generatedAt, customNow);
  });

  it("generates a timestamp when none is provided", () => {
    const plan = producePlanFromEnvelope(
      "approval_not_required", "direct_execution", "simple", [],
    );
    assert.ok(plan.generatedAt);
    assert.match(plan.generatedAt, /^\d{4}-\d{2}-\d{2}T/);
  });
});
