/**
 * Tests for the operator approval request for sealed execution plans (#990).
 *
 * Consumes ComplexityExecutionPlanPreflightSealPacket (#989) and produces a
 * deterministic operator approval request with operator-facing fields:
 * selected plan id, risks, required approvals, abort conditions, evidence
 * refs, idempotency key, and approval expiration guidance.
 *
 * Covers:
 *   - All four execution mode → approval request mappings
 *   - Risk profile selection by mode
 *   - Approval request state logic
 *   - Idempotency key stability
 *   - Safety block for unknown/unexpected states
 *   - Markdown rendering
 *   - Boundary enforcement
 *   - Risk, abort, gate, and ref ID stability
 *   - Expiration computation
 *   - Pipeline separation
 *   - Blocker generation
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
} from "./complexity-execution-plan-draft.js";
import { buildComplexityExecutionPlanPreflightSeal } from "./complexity-execution-plan-preflight-seal.js";
import {
  buildOperatorApprovalRequestFromPreflightSeal,
  renderOperatorApprovalRequestMarkdown,
  type OperatorApprovalRequestPacket,
} from "./operator-approval-request.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOW = "2026-06-01T12:00:00.000Z";

/**
 * Full pipeline: #970 → #971 → #978 → #982 → #990.
 */
function produceRequest(
  input: Parameters<typeof classifyTaskComplexity>[0],
  options: { now?: string } = {},
): OperatorApprovalRequestPacket {
  const classification = classifyTaskComplexity(input);
  const recommendation = buildComplexityOrchestrationRecommendation(classification, {
    now: NOW,
    ...options,
  });
  const envelope = buildFinalizerApprovalEnvelopeDraft(recommendation, {
    now: NOW,
    ...options,
  });
  const plan = buildComplexityExecutionPlanDraft(envelope, {
    now: NOW,
    ...options,
  });
  const seal = buildComplexityExecutionPlanPreflightSeal(plan, {
    now: NOW,
    ...options,
  });
  return buildOperatorApprovalRequestFromPreflightSeal(seal, {
    now: options.now ?? NOW,
  });
}

/**
 * Build an approval request from a recommendation directly for testing
 * the mapping without going through the classifier.
 */
function produceRequestFromRecommendation(
  action: string,
  complexity: string,
  roles: Array<{ role: string; purpose: string }>,
  confidence: "high" | "medium" | "low" = "high",
  options: { now?: string } = {},
): OperatorApprovalRequestPacket {
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
  const plan = buildComplexityExecutionPlanDraft(envelope, {
    now: NOW,
    ...options,
  });
  const seal = buildComplexityExecutionPlanPreflightSeal(plan, {
    now: NOW,
    ...options,
  });
  return buildOperatorApprovalRequestFromPreflightSeal(seal, {
    now: options.now ?? NOW,
  });
}

/**
 * Build an approval request from an envelope category directly for testing
 * the mapping at the request level.
 */
function produceRequestFromEnvelope(
  envelopeCat: FinalizerApprovalEnvelopeCategory,
  action: string,
  complexity: string,
  roles: Array<{ role: string; purpose: string }>,
  options: { now?: string } = {},
): OperatorApprovalRequestPacket {
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

  // Build envelope with the desired category directly
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

  const plan = buildComplexityExecutionPlanDraft(sourceEnvelope, { now: options.now ?? NOW });
  const seal = buildComplexityExecutionPlanPreflightSeal(plan, {
    now: NOW,
    ...options,
  });
  return buildOperatorApprovalRequestFromPreflightSeal(seal, { now: options.now ?? NOW });
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

describe("buildOperatorApprovalRequestFromPreflightSeal", () => {
  it("produces a valid packet with correct kind and version", () => {
    const req = produceRequestFromRecommendation("direct_execution", "simple", []);
    assert.equal(req.kind, "a2a-broker.operator-approval-request.packet");
    assert.equal(req.version, 1);
    assert.match(req.idempotencyKey, /^operator-approval-request:/);
    assert.ok(req.generatedAt);
  });

  it("carries through plan, envelope, and recommendation idempotency keys", () => {
    const req = produceRequestFromRecommendation("sequential_subagent", "moderate", [
      { role: "verifier", purpose: "review output" },
    ]);
    assert.ok(req.sourcePlanIdempotencyKey);
    assert.ok(req.sourceEnvelopeIdempotencyKey);
    assert.ok(req.sourceRecommendationIdempotencyKey);
    assert.notEqual(
      req.sourcePlanIdempotencyKey,
      req.sourceEnvelopeIdempotencyKey,
    );
    assert.notEqual(
      req.sourceEnvelopeIdempotencyKey,
      req.sourceRecommendationIdempotencyKey,
    );
  });

  it("sets correct source plan fields", () => {
    const req = produceRequestFromRecommendation("parallel_subagents", "complex", [
      { role: "explorer", purpose: "bounded investigation" },
    ]);
    assert.equal(req.selectedPlanId, req.sourcePlanIdempotencyKey);
    assert.equal(req.action, "parallel_subagents");
    assert.equal(req.complexity, "complex");
    assert.equal(req.envelopeCategory, "operator_approval_required");
  });
});

// ---------------------------------------------------------------------------
// Execution mode → approval request mapping
// ---------------------------------------------------------------------------

describe("execution mode → approval request mapping", () => {
  it("autonomous mode produces approval_not_needed state", () => {
    const req = produceRequestFromEnvelope(
      "approval_not_required", "direct_execution", "simple", [],
    );
    assert.equal(req.state, "approval_not_needed");
    assert.equal(req.executionMode, "autonomous");
    assert.equal(req.executionBlocked, false);
    assert.equal(req.approvalRequired, false);
    assert.equal(req.semantics.autonomousExecutionBlocked, false);
  });

  it("operator_notify mode produces approval_request_ready state", () => {
    const req = produceRequestFromEnvelope(
      "operator_notify", "direct_execution", "simple", [],
    );
    assert.equal(req.state, "approval_request_ready");
    assert.equal(req.executionMode, "operator_notify");
    assert.equal(req.executionBlocked, false);
    assert.equal(req.approvalRequired, false);
  });

  it("operator_approval_gated mode produces approval_request_ready state", () => {
    const req = produceRequestFromEnvelope(
      "operator_approval_required", "sequential_subagent", "moderate",
      [{ role: "verifier", purpose: "review output" }],
    );
    assert.equal(req.state, "approval_request_ready");
    assert.equal(req.executionMode, "operator_approval_gated");
    assert.equal(req.executionBlocked, false);
    assert.equal(req.approvalRequired, true);
  });

  it("operator_review_gated mode produces approval_request_ready state with blocked semantics", () => {
    const req = produceRequestFromEnvelope(
      "operator_review_required", "operator_review", "critical", [],
    );
    assert.equal(req.state, "approval_request_ready");
    assert.equal(req.executionMode, "operator_review_gated");
    assert.equal(req.executionBlocked, true);
    assert.equal(req.approvalRequired, true);
    assert.equal(req.semantics.autonomousExecutionBlocked, true);
  });

  it("safety blocked plan produces approval_request_blocked state", () => {
    const req = produceRequestFromEnvelope(
      "unknown_category" as any, "parallel_subagents", "complex",
      [{ role: "explorer", purpose: "bounded investigation" }],
    );
    assert.equal(req.state, "approval_request_blocked");
    assert.equal(req.executionBlocked, true);
    assert.ok(req.blockers.length > 0);
    assert.match(req.blockers.join("\n"), /SAFETY BLOCK/);
  });
});

// ---------------------------------------------------------------------------
// Full pipeline: #970 → #971 → #978 → #982 → #990 end-to-end
// ---------------------------------------------------------------------------

describe("full pipeline (#970 → #971 → #978 → #982 → #990)", () => {
  it("simple analysis → autonomous mode → approval_not_needed", () => {
    const req = produceRequest(SIMPLE_ANALYSIS_INPUT);
    assert.equal(req.state, "approval_not_needed");
    assert.equal(req.executionMode, "autonomous");
    assert.equal(req.action, "direct_execution");
    assert.equal(req.approvalRequired, false);
  });

  it("moderate backfill → approval gated → approval_request_ready", () => {
    const req = produceRequest(MODERATE_BACKFILL_INPUT);
    assert.equal(req.state, "approval_request_ready");
    assert.equal(req.executionMode, "operator_approval_gated");
    assert.equal(req.approvalRequired, true);
  });

  it("complex propose → approval gated → approval_request_ready with parallel subagents", () => {
    const req = produceRequest(COMPLEX_PROPOSE_INPUT);
    assert.equal(req.state, "approval_request_ready");
    assert.equal(req.executionMode, "operator_approval_gated");
    assert.equal(req.approvalRequired, true);
    assert.equal(req.stepCount >= 4, true);
  });

  it("critical promote → review required → approval_request_ready with blocked semantics", () => {
    const req = produceRequest(CRITICAL_PROMOTE_INPUT);
    assert.equal(req.state, "approval_request_ready");
    assert.equal(req.executionMode, "operator_review_gated");
    assert.equal(req.executionBlocked, true);
    assert.equal(req.approvalRequired, true);
    assert.equal(req.semantics.autonomousExecutionBlocked, true);
  });
});

// ---------------------------------------------------------------------------
// Risk profiles
// ---------------------------------------------------------------------------

describe("risk profiles by execution mode", () => {
  it("autonomous mode has low-severity risk profile", () => {
    const req = produceRequestFromEnvelope(
      "approval_not_required", "direct_execution", "simple", [],
    );
    assert.ok(req.risks.length >= 1);
    const hasOnlyLowRisk = req.risks.every(
      (r) => r.severity === "low" || r.severity === "none",
    );
    assert.ok(hasOnlyLowRisk);
  });

  it("operator_notify mode has low-severity risk profile", () => {
    const req = produceRequestFromEnvelope(
      "operator_notify", "direct_execution", "simple", [],
    );
    assert.ok(req.risks.length >= 1);
    const hasOnlyLowRisk = req.risks.every(
      (r) => r.severity === "low" || r.severity === "none",
    );
    assert.ok(hasOnlyLowRisk);
  });

  it("operator_approval_gated mode has medium-severity risk profile", () => {
    const req = produceRequestFromEnvelope(
      "operator_approval_required", "sequential_subagent", "moderate",
      [{ role: "verifier", purpose: "review output" }],
    );
    assert.ok(req.risks.length >= 1);
    const hasMediumOrHigher = req.risks.some(
      (r) => r.severity === "medium" || r.severity === "high" || r.severity === "critical",
    );
    assert.ok(hasMediumOrHigher);
  });

  it("operator_review_gated mode has critical-severity risk profile", () => {
    const req = produceRequestFromEnvelope(
      "operator_review_required", "operator_review", "critical", [],
    );
    assert.ok(req.risks.length >= 1);
    const hasCriticalRisk = req.risks.some((r) => r.severity === "critical");
    assert.ok(hasCriticalRisk);
    const criticalRisk = req.risks.find((r) => r.severity === "critical");
    assert.ok(criticalRisk?.requiresAcknowledgment);
  });

  it("blocked request has high-severity risk profile", () => {
    const req = produceRequestFromEnvelope(
      "unknown_category" as any, "parallel_subagents", "complex",
      [{ role: "explorer", purpose: "test" }],
    );
    assert.equal(req.state, "approval_request_blocked");
    assert.ok(req.risks.length >= 1);
    const highOrCritical = req.risks.some(
      (r) => r.severity === "high" || r.severity === "critical",
    );
    assert.ok(highOrCritical);
  });
});

// ---------------------------------------------------------------------------
// Required approvals
// ---------------------------------------------------------------------------

describe("required approvals by execution mode", () => {
  it("autonomous mode has no required approvals", () => {
    const req = produceRequestFromEnvelope(
      "approval_not_required", "direct_execution", "simple", [],
    );
    assert.equal(req.requiredApprovals.length, 0);
  });

  it("operator_approval_gated mode has one mandatory approval gate", () => {
    const req = produceRequestFromEnvelope(
      "operator_approval_required", "sequential_subagent", "moderate",
      [{ role: "verifier", purpose: "review output" }],
    );
    assert.ok(req.requiredApprovals.length >= 1);
    const mandatoryGates = req.requiredApprovals.filter((g) => g.mandatory);
    assert.ok(mandatoryGates.length >= 1);
    const firstGate = mandatoryGates[0]!;
    assert.match(firstGate.approver, /operator/);
  });

  it("operator_review_gated mode has mandatory review gate", () => {
    const req = produceRequestFromEnvelope(
      "operator_review_required", "operator_review", "critical", [],
    );
    assert.ok(req.requiredApprovals.length >= 1);
    const allMandatory = req.requiredApprovals.every((g) => g.mandatory);
    assert.ok(allMandatory);
  });
});

// ---------------------------------------------------------------------------
// Abort conditions
// ---------------------------------------------------------------------------

describe("abort conditions by execution mode", () => {
  it("autonomous mode has soft abort conditions", () => {
    const req = produceRequestFromEnvelope(
      "approval_not_required", "direct_execution", "simple", [],
    );
    assert.ok(req.abortConditions.length >= 1);
    const allSoft = req.abortConditions.every((a) => !a.hardAbort);
    assert.ok(allSoft);
  });

  it("operator_approval_gated mode has hard abort on operator decline", () => {
    const req = produceRequestFromEnvelope(
      "operator_approval_required", "sequential_subagent", "moderate",
      [{ role: "verifier", purpose: "review output" }],
    );
    const hasHardAbort = req.abortConditions.some((a) => a.hardAbort);
    assert.ok(hasHardAbort);
    const declineAbort = req.abortConditions.find(
      (a) => a.condition.toLowerCase().includes("declin"),
    );
    assert.ok(declineAbort);
    assert.equal(declineAbort!.hardAbort, true);
  });

  it("operator_review_gated mode has critical abort conditions", () => {
    const req = produceRequestFromEnvelope(
      "operator_review_required", "operator_review", "critical", [],
    );
    assert.ok(req.abortConditions.length >= 1);
    const hasCriticalAbort = req.abortConditions.some(
      (a) => a.severity === "critical",
    );
    assert.ok(hasCriticalAbort);
  });
});

// ---------------------------------------------------------------------------
// Evidence references
// ---------------------------------------------------------------------------

describe("evidence references", () => {
  it("always includes execution plan draft as required evidence", () => {
    const req = produceRequestFromEnvelope(
      "approval_not_required", "direct_execution", "simple", [],
    );
    const planEvidence = req.evidenceRefs.find(
      (ref) => ref.label === "Execution plan draft",
    );
    assert.ok(planEvidence);
    assert.equal(planEvidence!.required, true);
    assert.match(planEvidence!.uri, /plan:/);
  });

  it("approval-gated plan includes envelope draft evidence", () => {
    const req = produceRequestFromEnvelope(
      "operator_approval_required", "sequential_subagent", "moderate",
      [{ role: "verifier", purpose: "review output" }],
    );
    const envelopeEvidence = req.evidenceRefs.find(
      (ref) => ref.label === "Approval envelope draft",
    );
    assert.ok(envelopeEvidence);
    assert.equal(envelopeEvidence!.required, true);
  });

  it("review-required plan includes recommendation evidence", () => {
    const req = produceRequestFromEnvelope(
      "operator_review_required", "operator_review", "critical", [],
    );
    const recommendationEvidence = req.evidenceRefs.find(
      (ref) => ref.label === "Orchestration recommendation",
    );
    assert.ok(recommendationEvidence);
  });

  it("all evidence references have stable IDs", () => {
    const req = produceRequestFromEnvelope(
      "operator_approval_required", "sequential_subagent", "moderate",
      [{ role: "verifier", purpose: "review output" }],
    );
    for (const ref of req.evidenceRefs) {
      assert.match(ref.refId, /^ref-/);
    }
  });
});

// ---------------------------------------------------------------------------
// Approval expiration
// ---------------------------------------------------------------------------

describe("approval expiration", () => {
  it("autonomous mode has longer expiration window", () => {
    const req = produceRequestFromEnvelope(
      "approval_not_required", "direct_execution", "simple", [],
    );
    assert.ok(req.expiration.expiresAt);
    assert.equal(req.expiration.hardExpiry, false);
  });

  it("operator_approval_gated mode has 24-hour expiration window", () => {
    const req = produceRequestFromEnvelope(
      "operator_approval_required", "sequential_subagent", "moderate",
      [{ role: "verifier", purpose: "review output" }],
    );
    const expiresAt = new Date(req.expiration.expiresAt).getTime();
    const generatedAt = new Date(NOW).getTime();
    const diffHours = (expiresAt - generatedAt) / (1000 * 60 * 60);
    // 24 hours
    assert.ok(diffHours >= 23 && diffHours <= 25);
    assert.equal(req.expiration.hardExpiry, true);
  });

  it("operator_review_gated mode has 12-hour expiration window", () => {
    const req = produceRequestFromEnvelope(
      "operator_review_required", "operator_review", "critical", [],
    );
    const expiresAt = new Date(req.expiration.expiresAt).getTime();
    const generatedAt = new Date(NOW).getTime();
    const diffHours = (expiresAt - generatedAt) / (1000 * 60 * 60);
    // 12 hours
    assert.ok(diffHours >= 11 && diffHours <= 13);
    assert.equal(req.expiration.hardExpiry, true);
  });

  it("blocked request has no real expiration", () => {
    const req = produceRequestFromEnvelope(
      "unknown_category" as any, "direct_execution", "simple", [],
    );
    assert.equal(req.state, "approval_request_blocked");
    assert.equal(req.expiration.hardExpiry, false);
    assert.match(req.expiration.reason, /Blocked/);
  });
});

// ---------------------------------------------------------------------------
// Idempotency key stability
// ---------------------------------------------------------------------------

describe("idempotency key stability", () => {
  it("produces the same key for identical inputs", () => {
    const req1 = produceRequestFromRecommendation("direct_execution", "simple", []);
    const req2 = produceRequestFromRecommendation("direct_execution", "simple", []);
    assert.equal(req1.idempotencyKey, req2.idempotencyKey);
  });

  it("produces different keys for different inputs", () => {
    const req1 = produceRequestFromRecommendation("direct_execution", "simple", []);
    const req2 = produceRequestFromRecommendation("sequential_subagent", "moderate", [
      { role: "verifier", purpose: "review output" },
    ]);
    assert.notEqual(req1.idempotencyKey, req2.idempotencyKey);
  });

  it("produces different keys for different execution modes", () => {
    const req1 = produceRequestFromEnvelope(
      "approval_not_required", "direct_execution", "simple", [],
    );
    const req2 = produceRequestFromEnvelope(
      "operator_approval_required", "sequential_subagent", "moderate",
      [{ role: "verifier", purpose: "review output" }],
    );
    assert.notEqual(req1.idempotencyKey, req2.idempotencyKey);
  });

  it("risk IDs are stable for identical inputs", () => {
    const req1 = produceRequestFromEnvelope(
      "operator_approval_required", "sequential_subagent", "moderate",
      [{ role: "verifier", purpose: "review output" }],
    );
    const req2 = produceRequestFromEnvelope(
      "operator_approval_required", "sequential_subagent", "moderate",
      [{ role: "verifier", purpose: "review output" }],
    );
    for (let i = 0; i < req1.risks.length; i++) {
      assert.equal(req1.risks[i]!.riskId, req2.risks[i]!.riskId);
    }
  });

  it("abort IDs are stable for identical inputs", () => {
    const req1 = produceRequestFromEnvelope(
      "operator_approval_required", "sequential_subagent", "moderate",
      [{ role: "verifier", purpose: "review output" }],
    );
    const req2 = produceRequestFromEnvelope(
      "operator_approval_required", "sequential_subagent", "moderate",
      [{ role: "verifier", purpose: "review output" }],
    );
    for (let i = 0; i < req1.abortConditions.length; i++) {
      assert.equal(
        req1.abortConditions[i]!.abortId,
        req2.abortConditions[i]!.abortId,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Operator notes
// ---------------------------------------------------------------------------

describe("operator notes", () => {
  it("autonomous mode has informational notes", () => {
    const req = produceRequestFromEnvelope(
      "approval_not_required", "direct_execution", "simple", [],
    );
    assert.ok(req.operatorNotes.length >= 1);
    const allNotes = req.operatorNotes.join(" ");
    assert.match(allNotes, /does not require|informational/);
  });

  it("operator_approval_gated mode has approval-gated notes", () => {
    const req = produceRequestFromEnvelope(
      "operator_approval_required", "sequential_subagent", "moderate",
      [{ role: "verifier", purpose: "review output" }],
    );
    assert.ok(req.operatorNotes.length >= 1);
    const allNotes = req.operatorNotes.join(" ");
    assert.match(allNotes, /approval/);
  });

  it("operator_review_gated mode has critical review notes", () => {
    const req = produceRequestFromEnvelope(
      "operator_review_required", "operator_review", "critical", [],
    );
    assert.ok(req.operatorNotes.length >= 1);
    const allNotes = req.operatorNotes.join(" ");
    assert.match(allNotes, /BLOCKED/);
    assert.match(allNotes, /review/);
    assert.match(allNotes, /cannot/i);
  });
});

// ---------------------------------------------------------------------------
// Title and summary
// ---------------------------------------------------------------------------

describe("title and summary generation", () => {
  it("autonomous request has non-blocked title", () => {
    const req = produceRequestFromEnvelope(
      "approval_not_required", "direct_execution", "simple", [],
    );
    assert.match(req.title, /not needed/i);
  });

  it("approval gated request has gated title", () => {
    const req = produceRequestFromEnvelope(
      "operator_approval_required", "sequential_subagent", "moderate",
      [{ role: "verifier", purpose: "review output" }],
    );
    assert.match(req.title, /approval required/i);
  });

  it("review gated request has critical title", () => {
    const req = produceRequestFromEnvelope(
      "operator_review_required", "operator_review", "critical", [],
    );
    assert.match(req.title, /CRITICAL/i);
    assert.match(req.title, /review/i);
  });

  it("blocked request has blocked title", () => {
    const req = produceRequestFromEnvelope(
      "unknown_category" as any, "direct_execution", "simple", [],
    );
    assert.match(req.title, /SAFETY BLOCKED/i);
  });

  it("summary includes step count", () => {
    const req = produceRequestFromEnvelope(
      "operator_approval_required", "sequential_subagent", "moderate",
      [{ role: "verifier", purpose: "review output" }],
    );
    assert.match(req.summary, /\d+ step/);
  });
});

// ---------------------------------------------------------------------------
// renderOperatorApprovalRequestMarkdown
// ---------------------------------------------------------------------------

describe("renderOperatorApprovalRequestMarkdown", () => {
  it("renders autonomous request markdown", () => {
    const req = produceRequestFromEnvelope(
      "approval_not_required", "direct_execution", "simple", [],
    );
    const markdown = renderOperatorApprovalRequestMarkdown(req);
    assert.match(markdown, /Approval not needed/);
    assert.match(markdown, /Operator approval request/);
    assert.match(markdown, /autonomous/);
    assert.match(markdown, /Risks/);
    assert.match(markdown, /Required approvals/);
    assert.match(markdown, /Abort conditions/);
  });

  it("renders approval gated request markdown", () => {
    const req = produceRequestFromEnvelope(
      "operator_approval_required", "sequential_subagent", "moderate",
      [{ role: "verifier", purpose: "review output" }],
    );
    const markdown = renderOperatorApprovalRequestMarkdown(req);
    assert.match(markdown, /Operator approval request/);
    assert.match(markdown, /operator_approval_gated/);
    assert.match(markdown, /Required approvals/);
    assert.match(markdown, /approval gate/);
  });

  it("renders review gated request markdown with blocked warning", () => {
    const req = produceRequestFromEnvelope(
      "operator_review_required", "operator_review", "critical", [],
    );
    const markdown = renderOperatorApprovalRequestMarkdown(req);
    assert.match(markdown, /Operator approval request/);
    assert.match(markdown, /operator_review_gated/);
    assert.match(markdown, /🔥|CRITICAL/);
  });

  it("renders safety blocked request markdown", () => {
    const req = produceRequestFromEnvelope(
      "unknown_category" as any, "direct_execution", "simple", [],
    );
    const markdown = renderOperatorApprovalRequestMarkdown(req);
    assert.match(markdown, /SAFETY BLOCKED/);
  });

  it("renders boundaries, semantics, and evidence sections", () => {
    const req = produceRequestFromEnvelope(
      "operator_approval_required", "sequential_subagent", "moderate",
      [{ role: "verifier", purpose: "review output" }],
    );
    const markdown = renderOperatorApprovalRequestMarkdown(req);
    assert.match(markdown, /Boundaries/);
    assert.match(markdown, /Semantics/);
    assert.match(markdown, /Evidence/);
    assert.match(markdown, /approvalGranted/);
    assert.match(markdown, /approvalRequestDraftOnly/);
  });

  it("renders expiration section", () => {
    const req = produceRequestFromEnvelope(
      "operator_approval_required", "sequential_subagent", "moderate",
      [{ role: "verifier", purpose: "review output" }],
    );
    const markdown = renderOperatorApprovalRequestMarkdown(req);
    assert.match(markdown, /expiresAt/);
    assert.match(markdown, /hardExpiry/);
  });
});

// ---------------------------------------------------------------------------
// Next actions
// ---------------------------------------------------------------------------

describe("next actions", () => {
  it("autonomous plan has no-approval next actions", () => {
    const req = produceRequestFromEnvelope(
      "approval_not_required", "direct_execution", "simple", [],
    );
    assert.ok(req.nextActions.length > 0);
    const allText = req.nextActions.join(" ");
    assert.match(allText, /approval/);
    assert.doesNotMatch(allText, /blocked/);
  });

  it("operator_approval_gated plan has approval-gated next actions", () => {
    const req = produceRequestFromEnvelope(
      "operator_approval_required", "sequential_subagent", "moderate",
      [{ role: "verifier", purpose: "review output" }],
    );
    assert.ok(req.nextActions.length > 0);
    const allText = req.nextActions.join(" ");
    assert.match(allText, /approval/);
    assert.match(allText, /grant/);
  });

  it("operator_review_gated plan has blocked next actions", () => {
    const req = produceRequestFromEnvelope(
      "operator_review_required", "operator_review", "critical", [],
    );
    assert.ok(req.nextActions.length > 0);
    const allText = req.nextActions.join(" ");
    assert.match(allText, /BLOCKED/);
    assert.match(allText, /review/);
    assert.match(allText, /cannot|NOT/);
  });

  it("blocked request has blocked next actions", () => {
    const req = produceRequestFromEnvelope(
      "unknown_category" as any, "direct_execution", "simple", [],
    );
    assert.equal(req.state, "approval_request_blocked");
    assert.ok(req.nextActions.length > 0);
    const allText = req.nextActions.join(" ");
    assert.match(allText, /blocked/);
  });
});

// ---------------------------------------------------------------------------
// Symbolic boundary enforcement
// ---------------------------------------------------------------------------

describe("symbolic boundary enforcement", () => {
  it("all boundaries are statically false", () => {
    const req = produceRequestFromEnvelope(
      "approval_not_required", "direct_execution", "simple", [],
    );
    const { boundaries } = req;
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
    assert.equal(boundaries.sealedPlanConsumed, false);
    assert.equal(boundaries.executionWindowOpened, false);
  });

  it("all semantics enforce source-only no-live and no approval", () => {
    const req = produceRequestFromEnvelope(
      "operator_approval_required", "sequential_subagent", "moderate",
      [{ role: "verifier", purpose: "review output" }],
    );
    const { semantics } = req;
    assert.equal(semantics.approvalRequestDraftOnly, true);
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
    assert.equal(semantics.performsApprovalGrant, false);
    assert.equal(semantics.performsExecutionDispatch, false);
    assert.equal(semantics.performsSeal, false);
    assert.equal(semantics.opensExecutionWindow, false);
  });
});

// ---------------------------------------------------------------------------
// Pipeline separation
// ---------------------------------------------------------------------------

describe("pipeline separation", () => {
  it("approval request packet kind differs from all prior pipeline packets", () => {
    const req = produceRequest(SIMPLE_ANALYSIS_INPUT);
    assert.equal(req.kind, "a2a-broker.operator-approval-request.packet");
    assert.notEqual(req.kind, "a2a-broker.finalizer-approval-envelope-draft.packet");
    assert.notEqual(req.kind, "a2a-broker.complexity-orchestration-recommendation-packet");
    assert.notEqual(req.kind, "a2a-broker.complexity-execution-plan-draft.packet");
  });

  it("approval request does not contain approval grant or dispatch fields", () => {
    const req = produceRequestFromEnvelope(
      "approval_not_required", "direct_execution", "simple", [],
    );
    assert.equal((req as any).approvalGranted, undefined);
    assert.equal((req as any).executionDispatched, undefined);
    assert.equal((req as any).sealPerformed, undefined);
  });

  it("approval request can be traced back to its source plan", () => {
    const req = produceRequest(SIMPLE_ANALYSIS_INPUT);
    assert.ok(req.sourcePlanIdempotencyKey);
    assert.ok(req.sourceEnvelopeIdempotencyKey);
    assert.ok(req.sourceRecommendationIdempotencyKey);
    assert.notEqual(req.sourcePlanIdempotencyKey, req.sourceEnvelopeIdempotencyKey);
  });
});

// ---------------------------------------------------------------------------
// Blockers
// ---------------------------------------------------------------------------

describe("blockers", () => {
  it("non-blocked request has no blockers", () => {
    const req = produceRequestFromEnvelope(
      "approval_not_required", "direct_execution", "simple", [],
    );
    assert.equal(req.blockers.length, 0);
  });

  it("approval gated request has no blockers", () => {
    const req = produceRequestFromEnvelope(
      "operator_approval_required", "sequential_subagent", "moderate",
      [{ role: "verifier", purpose: "review output" }],
    );
    assert.equal(req.blockers.length, 0);
  });

  it("review gated request has no blockers (request is ready, execution is blocked)", () => {
    const req = produceRequestFromEnvelope(
      "operator_review_required", "operator_review", "critical", [],
    );
    assert.equal(req.blockers.length, 0);
  });

  it("blocked request has safety block blocker", () => {
    const req = produceRequestFromEnvelope(
      "unknown_category" as any, "direct_execution", "simple", [],
    );
    assert.ok(req.blockers.length > 0);
    assert.match(req.blockers.join("\n"), /SAFETY BLOCK/);
  });
});

// ---------------------------------------------------------------------------
// generatedAt timestamp
// ---------------------------------------------------------------------------

describe("generatedAt timestamp", () => {
  it("uses provided timestamp", () => {
    const customNow = "2026-07-01T08:00:00.000Z";
    const req = produceRequestFromEnvelope(
      "approval_not_required", "direct_execution", "simple", [],
      { now: customNow },
    );
    assert.equal(req.generatedAt, customNow);
  });

  it("generates a timestamp when none is provided", () => {
    const req = produceRequestFromEnvelope(
      "approval_not_required", "direct_execution", "simple", [],
    );
    assert.ok(req.generatedAt);
    assert.match(req.generatedAt, /^\d{4}-\d{2}-\d{2}T/);
  });
});

// ---------------------------------------------------------------------------
// Step count tracking
// ---------------------------------------------------------------------------

describe("step count tracking", () => {
  it("autonomous plan reports correct step count", () => {
    const req = produceRequestFromEnvelope(
      "approval_not_required", "direct_execution", "simple", [],
    );
    assert.equal(req.stepCount, 2); // direct_execution, completion
  });

  it("sequential approval plan reports correct step count", () => {
    const req = produceRequestFromEnvelope(
      "operator_approval_required", "sequential_subagent", "moderate",
      [{ role: "verifier", purpose: "review output" }],
    );
    assert.equal(req.stepCount, 3); // approval_gate, subagent_sequential, completion
  });

  it("critical review plan reports correct step count", () => {
    const req = produceRequestFromEnvelope(
      "operator_review_required", "operator_review", "critical", [],
    );
    assert.equal(req.stepCount, 2); // operator_review, completion
  });
});

// ---------------------------------------------------------------------------
// All execution/dispatch/live mutation booleans remain false
// ---------------------------------------------------------------------------

describe("no-live boolean enforcement", () => {
  it("all safety-relevant booleans are false", () => {
    const req = produceRequestFromEnvelope(
      "operator_approval_required", "sequential_subagent", "moderate",
      [{ role: "verifier", purpose: "review output" }],
    );

    // Boundaries
    assert.equal(req.boundaries.runtimeBehaviorChanged, false);
    assert.equal(req.boundaries.terminalAckPerformed, false);
    assert.equal(req.boundaries.secretMovement, false);

    // Semantics
    assert.equal(req.semantics.performsProviderSend, false);
    assert.equal(req.semantics.performsTerminalAck, false);
    assert.equal(req.semantics.performsRuntimeRestartOrDeploy, false);
    assert.equal(req.semantics.performsDbMutation, false);
    assert.equal(req.semantics.performsHistoricalReplay, false);
    assert.equal(req.semantics.performsReleaseOrPublish, false);
    assert.equal(req.semantics.movesSecretsOrCredentials, false);
    assert.equal(req.semantics.performsApprovalGrant, false);
    assert.equal(req.semantics.performsExecutionDispatch, false);
    assert.equal(req.semantics.performsSeal, false);
    assert.equal(req.semantics.opensExecutionWindow, false);
  });
});
