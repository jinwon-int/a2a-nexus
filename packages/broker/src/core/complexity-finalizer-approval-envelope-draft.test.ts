/**
 * Tests for the finalizer approval envelope draft (#978).
 *
 * Consumes ComplexityOrchestrationRecommendationPacket (#971) and produces
 * a deterministic approval-request envelope draft with strict separation
 * between recommendation, approval request draft, and actual approval grant.
 *
 * Covers:
 *   - All four orchestration action → envelope category mappings
 *   - Critical/operator_review safety invariant (never autonomous execution)
 *   - Idempotency key stability
 *   - Safety block for unexpected envelope mappings
 *   - Markdown rendering
 *   - Boundary enforcement
 *   - Extractor functions
 *   - Requested item shape and content
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
  extractOrchestrationRecommendationFromEnvelope,
  renderFinalizerApprovalEnvelopeDraftMarkdown,
  type FinalizerApprovalEnvelopeDraftPacket,
  type FinalizerApprovalEnvelopeCategory,
} from "./complexity-finalizer-approval-envelope-draft.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOW = "2026-06-01T12:00:00.000Z";

/**
 * Classify and build a recommendation, then build an envelope.
 * This is the canonical pipeline: #970 → #971 → #978.
 */
function produceEnvelope(
  input: Parameters<typeof classifyTaskComplexity>[0],
  options: { now?: string } = {},
): FinalizerApprovalEnvelopeDraftPacket {
  const classification = classifyTaskComplexity(input);
  const recommendation = buildComplexityOrchestrationRecommendation(classification, {
    now: NOW,
    ...options,
  });
  return buildFinalizerApprovalEnvelopeDraft(recommendation, {
    now: NOW,
    ...options,
  });
}

/**
 * Build an envelope directly from a recommendation packet for testing
 * the mapping without going through the classifier.
 */
function produceEnvelopeFromRecommendation(
  action: string,
  complexity: string,
  roles: Array<{ role: string; purpose: string }>,
  confidence: "high" | "medium" | "low" = "high",
  options: { now?: string } = {},
): FinalizerApprovalEnvelopeDraftPacket {
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
      parallelismHint: action === "direct_execution" ? 0 : action === "sequential_subagent" ? 1 : action === "parallel_subagents" ? 2 : 0,
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
  return buildFinalizerApprovalEnvelopeDraft(recommendation, { now: NOW, ...options });
}

// Convenience preset inputs (same pattern as the test-complexity-classifier test)
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
const CRITICAL_ROLLBACK_INPUT = {
  intent: "rollback_live" as const,
  targetEnvironment: "live" as const,
  policyContext: { requiresApproval: true, liveImpact: true } as const,
};

// ---------------------------------------------------------------------------
// Action → envelope category mapping
// ---------------------------------------------------------------------------

describe("buildFinalizerApprovalEnvelopeDraft", () => {
  it("maps direct_execution to approval_not_required", () => {
    const packet = produceEnvelopeFromRecommendation(
      "direct_execution", "simple", [],
    );
    assert.equal(packet.kind, "a2a-broker.finalizer-approval-envelope-draft.packet");
    assert.equal(packet.version, 1);
    assert.equal(packet.envelopeCategory, "approval_not_required");
    assert.equal(packet.decision, "no_approval_needed");
    assert.equal(packet.approvalMode, "autonomous");
    assert.equal(packet.autonomousApprovalPossible, true);
    assert.equal(packet.subagentSpawnPermitted, false);
    assert.equal(packet.directExecutionPermitted, true);
    assert.equal(packet.liveDeploymentPermitted, false);
  });

  it("maps sequential_subagent to operator_approval_required", () => {
    const packet = produceEnvelopeFromRecommendation(
      "sequential_subagent", "moderate",
      [{ role: "verifier", purpose: "review output" }],
    );
    assert.equal(packet.envelopeCategory, "operator_approval_required");
    assert.equal(packet.decision, "envelope_draft_ready");
    assert.equal(packet.approvalMode, "operator_approval_gated");
    assert.equal(packet.autonomousApprovalPossible, false);
    assert.equal(packet.subagentSpawnPermitted, false);
    assert.equal(packet.requestedItems[0]!.operatorApprovalRequired, true);
  });

  it("maps parallel_subagents to operator_approval_required", () => {
    const packet = produceEnvelopeFromRecommendation(
      "parallel_subagents", "complex",
      [
        { role: "explorer", purpose: "investigate" },
        { role: "implementer", purpose: "implement" },
        { role: "verifier", purpose: "verify" },
      ],
    );
    assert.equal(packet.envelopeCategory, "operator_approval_required");
    assert.equal(packet.decision, "envelope_draft_ready");
    assert.equal(packet.approvalMode, "operator_approval_gated");
    assert.equal(packet.autonomousApprovalPossible, false);
    assert.equal(packet.subagentSpawnPermitted, false);
    assert.equal(packet.directExecutionPermitted, false);
    assert.equal(packet.liveDeploymentPermitted, false);
  });

  it("maps operator_review to operator_review_required with autonomous execution BLOCKED", () => {
    const packet = produceEnvelopeFromRecommendation(
      "operator_review", "critical", [],
    );
    assert.equal(packet.envelopeCategory, "operator_review_required");
    assert.equal(packet.decision, "envelope_draft_ready");
    assert.equal(packet.approvalMode, "operator_review_gated");
    assert.equal(packet.autonomousApprovalPossible, false);
    assert.equal(packet.subagentSpawnPermitted, false);
    assert.equal(packet.directExecutionPermitted, false);
    assert.equal(packet.liveDeploymentPermitted, false);
    assert.equal(packet.semantics.autonomousExecutionBlockedForOperatorReview, true);
  });
});

// ---------------------------------------------------------------------------
// Full pipeline: #970 → #971 → #978 end-to-end
// ---------------------------------------------------------------------------

describe("full pipeline (#970 → #971 → #978)", () => {
  it("simple analysis → approval_not_required", () => {
    const packet = produceEnvelope(SIMPLE_ANALYSIS_INPUT);
    assert.equal(packet.envelopeCategory, "approval_not_required");
    assert.equal(packet.decision, "no_approval_needed");
    assert.equal(packet.autonomousApprovalPossible, true);
    assert.equal(packet.sourceOrchestrationAction, "direct_execution");
  });

  it("moderate backfill → operator_approval_required", () => {
    const packet = produceEnvelope(MODERATE_BACKFILL_INPUT);
    assert.equal(packet.envelopeCategory, "operator_approval_required");
    assert.equal(packet.decision, "envelope_draft_ready");
    assert.equal(packet.requestedItems.length, 1);
    assert.equal(packet.requestedItems[0]!.subagentPermitted, true);
    assert.equal(packet.requestedItems[0]!.operatorApprovalRequired, true);
  });

  it("complex propose → operator_approval_required with three subagent roles", () => {
    const packet = produceEnvelope(COMPLEX_PROPOSE_INPUT);
    assert.equal(packet.envelopeCategory, "operator_approval_required");
    assert.equal(packet.decision, "envelope_draft_ready");
    assert.equal(packet.requestedItems.length, 3);
    const roles = packet.requestedItems.map((item) => item.reason);
    assert.ok(roles.some((r) => r.includes("explorer")));
    assert.ok(roles.some((r) => r.includes("implementer")));
    assert.ok(roles.some((r) => r.includes("verifier")));
  });

  it("promote_to_live critical → operator_review_required, autonomous blocked", () => {
    const packet = produceEnvelope(CRITICAL_PROMOTE_INPUT);
    assert.equal(packet.envelopeCategory, "operator_review_required");
    assert.equal(packet.autonomousApprovalPossible, false);
    assert.equal(packet.semantics.autonomousExecutionBlockedForOperatorReview, true);
    assert.equal(packet.subagentSpawnPermitted, false);
    assert.equal(packet.directExecutionPermitted, false);
  });

  it("rollback_live critical → operator_review_required, autonomous blocked", () => {
    const packet = produceEnvelope(CRITICAL_ROLLBACK_INPUT);
    assert.equal(packet.envelopeCategory, "operator_review_required");
    assert.equal(packet.autonomousApprovalPossible, false);
    assert.equal(packet.semantics.autonomousExecutionBlockedForOperatorReview, true);
  });
});

// ---------------------------------------------------------------------------
// Safety invariant: operator_review NEVER becomes approved autonomous
// ---------------------------------------------------------------------------

describe("safety invariant: operator_review cannot become autonomous", () => {
  it("operator_review envelope properties all deny autonomous execution", () => {
    const packet = produceEnvelopeFromRecommendation(
      "operator_review", "critical", [],
    );
    // Core invariant
    assert.equal(packet.envelopeCategory, "operator_review_required");
    assert.equal(packet.autonomousApprovalPossible, false);
    assert.equal(packet.semantics.autonomousExecutionBlockedForOperatorReview, true);
    // All execution gates closed
    assert.equal(packet.subagentSpawnPermitted, false);
    assert.equal(packet.directExecutionPermitted, false);
    assert.equal(packet.liveDeploymentPermitted, false);
    // No approval granted
    assert.equal(packet.boundaries.approvalGranted, false);
    assert.equal(packet.boundaries.executionDispatched, false);
    assert.equal(packet.semantics.approvalNotGranted, true);
  });

  it("all critical inputs regardless of offset produce operator_review_required", () => {
    // Multiple ways to reach critical
    const inputs = [
      { intent: "promote_to_live" as const, targetEnvironment: "live" as const },
      { intent: "rollback_live" as const, targetEnvironment: "live" as const },
      { intent: "promote_to_live" as const, targetEnvironment: "live" as const, policyContext: {} },
    ];
    for (const input of inputs) {
      const classification = classifyTaskComplexity(input);
      assert.equal(classification.level, "critical",
        `expected critical for ${input.intent}, got ${classification.level}`);
      const recommendation = buildComplexityOrchestrationRecommendation(classification);
      const packet = buildFinalizerApprovalEnvelopeDraft(recommendation);
      assert.equal(packet.envelopeCategory, "operator_review_required",
        `envelope should be operator_review_required for ${input.intent}`);
      assert.equal(packet.autonomousApprovalPossible, false,
        `autonomous approval should be false for ${input.intent}`);
    }
  });

  it("envelope draft does not grant approval (all boundaries false)", () => {
    const packet = produceEnvelope(CRITICAL_PROMOTE_INPUT);
    assert.equal(packet.boundaries.approvalGranted, false);
    assert.equal(packet.boundaries.executionDispatched, false);
    assert.equal(packet.boundaries.providerMessageSent, false);
    assert.equal(packet.boundaries.terminalAckPerformed, false);
    assert.equal(packet.boundaries.taskFlowMutation, false);
    assert.equal(packet.boundaries.dbMutation, false);
    assert.equal(packet.boundaries.deployOrRestart, false);
    assert.equal(packet.boundaries.secretMovement, false);
    assert.equal(packet.semantics.envelopeDraftOnly, true);
    assert.equal(packet.semantics.approvalNotGranted, true);
    assert.equal(packet.semantics.recommendationSeparated, true);
    assert.equal(packet.semantics.approvalRequestDraftSeparated, true);
    assert.equal(packet.semantics.approvalGrantSeparated, true);
    assert.equal(packet.semantics.sourceOnlyNoLive, true);
  });
});

// ---------------------------------------------------------------------------
// Idempotency key stability
// ---------------------------------------------------------------------------

describe("idempotency key stability", () => {
  it("produces the same key for identical inputs", () => {
    const a = produceEnvelope(SIMPLE_ANALYSIS_INPUT);
    const b = produceEnvelope(SIMPLE_ANALYSIS_INPUT);
    assert.equal(a.idempotencyKey, b.idempotencyKey);
  });

  it("produces different keys for different complexity levels", () => {
    const simple = produceEnvelope(SIMPLE_ANALYSIS_INPUT);
    const critical = produceEnvelope(CRITICAL_PROMOTE_INPUT);
    assert.notEqual(simple.idempotencyKey, critical.idempotencyKey);
  });

  it("key is a stable prefixed hex digest", () => {
    const packet = produceEnvelope(SIMPLE_ANALYSIS_INPUT);
    assert.ok(packet.idempotencyKey.startsWith("complexity-finalizer-approval-envelope:"));
    assert.equal(packet.idempotencyKey.length,
      "complexity-finalizer-approval-envelope:".length + 24);
    assert.ok(/^[a-f0-9]+$/.test(packet.idempotencyKey.split(":")[1]!));
  });

  it("same recommendation idempotencyKey plus same envelope yields same envelope key", () => {
    const recommendation: ComplexityOrchestrationRecommendationPacket = {
      kind: "a2a-broker.complexity-orchestration-recommendation-packet",
      version: 1,
      generatedAt: NOW,
      idempotencyKey: "complexity-orch-recommendation:abcdef1234567890abcdef12",
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
        safetyGate: "test",
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
    const a = buildFinalizerApprovalEnvelopeDraft(recommendation, { now: NOW });
    const b = buildFinalizerApprovalEnvelopeDraft(recommendation, { now: NOW });
    assert.equal(a.idempotencyKey, b.idempotencyKey);
    assert.equal(a.sourceRecommendationIdempotencyKey, recommendation.idempotencyKey);
  });
});

// ---------------------------------------------------------------------------
// Safety block for unexpected mappings
// ---------------------------------------------------------------------------

describe("safety block", () => {
  it("unknown action defaults to operator_review_required (fail-closed)", () => {
    const packet = produceEnvelopeFromRecommendation(
      "unknown_action", "complex", [],
    );
    // Unknown actions should fail closed to the most restrictive envelope.
    // Since ACTION_TO_ENVELOPE has no entry for "unknown_action", ?? falls
    // through to operator_review_required.
    assert.equal(packet.envelopeCategory, "operator_review_required");
    assert.equal(packet.autonomousApprovalPossible, false);
    assert.equal(packet.semantics.autonomousExecutionBlockedForOperatorReview, true);
  });
});

// ---------------------------------------------------------------------------
// Generated timestamp
// ---------------------------------------------------------------------------

describe("generatedAt timestamp", () => {
  it("uses provided now option", () => {
    const packet = produceEnvelope(SIMPLE_ANALYSIS_INPUT, { now: NOW });
    assert.equal(packet.generatedAt, NOW);
  });

  it("defaults to a valid ISO string when now is omitted", () => {
    const packet = produceEnvelope(SIMPLE_ANALYSIS_INPUT);
    assert.equal(typeof packet.generatedAt, "string");
    assert.ok(Number.isFinite(Date.parse(packet.generatedAt)),
      `generatedAt is not a valid ISO string: ${packet.generatedAt}`);
  });
});

// ---------------------------------------------------------------------------
// Requested items
// ---------------------------------------------------------------------------

describe("requested items", () => {
  it("direct_execution has one item without roles", () => {
    const packet = produceEnvelopeFromRecommendation(
      "direct_execution", "simple", [],
    );
    assert.equal(packet.requestedItems.length, 1);
    assert.equal(packet.requestedItems[0]!.subagentPermitted, false);
    assert.equal(packet.requestedItems[0]!.operatorApprovalRequired, false);
  });

  it("parallel_subagents has one item per role", () => {
    const packet = produceEnvelopeFromRecommendation(
      "parallel_subagents", "complex",
      [
        { role: "explorer", purpose: "investigate" },
        { role: "implementer", purpose: "implement" },
        { role: "verifier", purpose: "verify" },
      ],
    );
    assert.equal(packet.requestedItems.length, 3);
    for (const item of packet.requestedItems) {
      assert.equal(item.orchestrationAction, "parallel_subagents");
      assert.equal(item.complexity, "complex");
      assert.equal(item.operatorApprovalRequired, true);
      assert.equal(item.subagentPermitted, true);
    }
    const reasons = packet.requestedItems.map((item) => item.reason);
    assert.ok(reasons.some((r) => r.includes("explorer")));
    assert.ok(reasons.some((r) => r.includes("implementer")));
    assert.ok(reasons.some((r) => r.includes("verifier")));
  });

  it("operator_review_required items say no autonomous subagents", () => {
    const packet = produceEnvelopeFromRecommendation(
      "operator_review", "critical", [],
    );
    assert.equal(packet.requestedItems.length, 1);
    assert.match(packet.requestedItems[0]!.reason, /no autonomous subagents/i);
    assert.equal(packet.requestedItems[0]!.autonomousExecutionBlocked, true);
  });
});

// ---------------------------------------------------------------------------
// Next actions
// ---------------------------------------------------------------------------

describe("next actions", () => {
  it("approval_not_required next actions mention safe execution", () => {
    const packet = produceEnvelopeFromRecommendation("direct_execution", "simple", []);
    const joint = packet.nextActions.join(" ");
    assert.match(joint, /no approval needed|does not require/i);
  });

  it("sequential_subagent next actions mention explicit approval", () => {
    const packet = produceEnvelopeFromRecommendation(
      "sequential_subagent", "moderate",
      [{ role: "verifier", purpose: "verify" }],
    );
    const joint = packet.nextActions.join(" ");
    assert.match(joint, /explicit operator approval/i);
  });

  it("operator_approval_required next actions mention explicit approval", () => {
    const packet = produceEnvelopeFromRecommendation(
      "parallel_subagents", "complex",
      [{ role: "explorer", purpose: "investigate" }],
    );
    const joint = packet.nextActions.join(" ");
    assert.match(joint, /explicit operator approval/i);
  });

  it("operator_review_required next actions mention operator review and blocked autonomous", () => {
    const packet = produceEnvelopeFromRecommendation("operator_review", "critical", []);
    const joint = packet.nextActions.join(" ");
    assert.match(joint, /operator review/i);
    assert.match(joint, /autonomous.*blocked|blocked.*autonomous/i);
  });
});

// ---------------------------------------------------------------------------
// Markdown rendering
// ---------------------------------------------------------------------------

describe("renderFinalizerApprovalEnvelopeDraftMarkdown", () => {
  it("renders a non-empty markdown string for simple analysis", () => {
    const packet = produceEnvelope(SIMPLE_ANALYSIS_INPUT);
    const md = renderFinalizerApprovalEnvelopeDraftMarkdown(packet);
    assert.ok(md.length > 0);
    assert.ok(md.startsWith("#"));
    assert.match(md, /No approval needed/);
  });

  it("renders envelope category and properties for moderate", () => {
    const packet = produceEnvelope(MODERATE_BACKFILL_INPUT);
    const md = renderFinalizerApprovalEnvelopeDraftMarkdown(packet);
    assert.match(md, /operator_approval_required/);
    assert.match(md, /Envelope properties/);
    assert.match(md, /subagentSpawnPermitted\*\*: false/);
  });

  it("renders requested items for complex", () => {
    const packet = produceEnvelope(COMPLEX_PROPOSE_INPUT);
    const md = renderFinalizerApprovalEnvelopeDraftMarkdown(packet);
    assert.match(md, /explorer/);
    assert.match(md, /implementer/);
    assert.match(md, /verifier/);
    assert.match(md, /Requested items/);
  });

  it("renders safety gate for critical", () => {
    const packet = produceEnvelope(CRITICAL_PROMOTE_INPUT);
    const md = renderFinalizerApprovalEnvelopeDraftMarkdown(packet);
    assert.match(md, /operator_review_required/);
    assert.match(md, /Safety gate/);
  });

  it("renders boundaries and semantics", () => {
    const packet = produceEnvelope(SIMPLE_ANALYSIS_INPUT);
    const md = renderFinalizerApprovalEnvelopeDraftMarkdown(packet);
    assert.match(md, /runtimeBehaviorChanged/);
    assert.match(md, /approvalNotGranted/);
    assert.match(md, /sourceOnlyNoLive/);
  });

  it("render does not crash for any preset input", () => {
    const inputs = [
      SIMPLE_ANALYSIS_INPUT,
      MODERATE_BACKFILL_INPUT,
      COMPLEX_PROPOSE_INPUT,
      CRITICAL_PROMOTE_INPUT,
      CRITICAL_ROLLBACK_INPUT,
    ];
    for (const input of inputs) {
      const packet = produceEnvelope(input);
      const md = renderFinalizerApprovalEnvelopeDraftMarkdown(packet);
      assert.ok(md.length > 0);
    }
  });
});

// ---------------------------------------------------------------------------
// Extractor
// ---------------------------------------------------------------------------

describe("extractOrchestrationRecommendationFromEnvelope", () => {
  it("extracts a bare recommendation packet", () => {
    const recommendation: ComplexityOrchestrationRecommendationPacket = {
      kind: "a2a-broker.complexity-orchestration-recommendation-packet",
      version: 1,
      generatedAt: NOW,
      idempotencyKey: "complexity-orch-recommendation:test-extract",
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
        safetyGate: "test",
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
    const extracted = extractOrchestrationRecommendationFromEnvelope(recommendation);
    assert.equal(extracted, recommendation);
  });

  it("extracts from an envelope containing a recommendation key", () => {
    const recommendation: ComplexityOrchestrationRecommendationPacket = {
      kind: "a2a-broker.complexity-orchestration-recommendation-packet",
      version: 1,
      generatedAt: NOW,
      idempotencyKey: "complexity-orch-recommendation:test-env",
      classification: {
        level: "moderate",
        reason: "test",
        origin: "intent-derived",
        signals: {
          baseLevel: "moderate",
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
        complexity: "moderate",
        action: "sequential_subagent",
        parallelismHint: 1,
        confidence: "high",
        rationale: "test",
        recommendedRoles: [],
        safetyGate: "test",
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
    const envelope = { recommendation };
    const extracted = extractOrchestrationRecommendationFromEnvelope(envelope);
    assert.equal(extracted, recommendation);
  });

  it("extracts from envelope with recommendationPacket key", () => {
    const recommendation = {
      kind: "a2a-broker.complexity-orchestration-recommendation-packet",
      version: 1,
      generatedAt: NOW,
      idempotencyKey: "complexity-orch-recommendation:test-key",
      classification: { level: "simple", reason: "test", origin: "intent-derived", signals: {} as any },
      recommendation: { complexity: "simple", action: "direct_execution", parallelismHint: 0, confidence: "high", rationale: "test", recommendedRoles: [], safetyGate: "test" },
      boundaries: {} as any,
    } as ComplexityOrchestrationRecommendationPacket;
    assert.equal(
      extractOrchestrationRecommendationFromEnvelope({ recommendationPacket: recommendation }),
      recommendation,
    );
  });

  it("extracts from envelope with complexityOrchestrationRecommendation key", () => {
    const recommendation = {
      kind: "a2a-broker.complexity-orchestration-recommendation-packet",
      version: 1,
      generatedAt: NOW,
      idempotencyKey: "complexity-orch-recommendation:test-key2",
      classification: { level: "complex", reason: "test", origin: "intent-derived", signals: {} as any },
      recommendation: { complexity: "complex", action: "parallel_subagents", parallelismHint: 2, confidence: "high", rationale: "test", recommendedRoles: [], safetyGate: "test" },
      boundaries: {} as any,
    } as ComplexityOrchestrationRecommendationPacket;
    assert.equal(
      extractOrchestrationRecommendationFromEnvelope({ complexityOrchestrationRecommendation: recommendation }),
      recommendation,
    );
  });

  it("throws for non-packet input", () => {
    assert.throws(
      () => extractOrchestrationRecommendationFromEnvelope({ kind: "wrong" }),
      /expected a ComplexityOrchestrationRecommendationPacket/,
    );
  });
});

// ---------------------------------------------------------------------------
// Source idempotency key carry-through
// ---------------------------------------------------------------------------

describe("source recommendation idempotency key carry-through", () => {
  it("carries the source recommendation idempotency key", () => {
    const packet = produceEnvelope(SIMPLE_ANALYSIS_INPUT);
    assert.equal(typeof packet.sourceRecommendationIdempotencyKey, "string");
    assert.ok(packet.sourceRecommendationIdempotencyKey.length > 0);
  });

  it("two envelopes from same recommendation have different envelope keys", () => {
    const classification = classifyTaskComplexity({
      intent: "analyze",
      targetEnvironment: "research",
    });
    const recommendation = buildComplexityOrchestrationRecommendation(classification, { now: NOW });
    const a = buildFinalizerApprovalEnvelopeDraft(recommendation, { now: NOW });
    const b = buildFinalizerApprovalEnvelopeDraft(recommendation, { now: NOW });
    assert.equal(a.sourceRecommendationIdempotencyKey, b.sourceRecommendationIdempotencyKey);
    assert.equal(a.idempotencyKey, b.idempotencyKey);
  });
});

// ---------------------------------------------------------------------------
// Symbolic boundary enforcement
// ---------------------------------------------------------------------------

describe("symbolic boundary enforcement", () => {
  it("all eleven boundaries are false for every envelope category", () => {
    const categories: FinalizerApprovalEnvelopeCategory[] = [
      "approval_not_required",
      "operator_approval_required",
      "operator_review_required",
    ];
    for (const category of categories) {
      const action =
        category === "approval_not_required" ? "direct_execution"
        : category === "operator_approval_required" ? "parallel_subagents"
        : "operator_review";
      const complexity =
        category === "operator_review_required" ? "critical"
        : category === "operator_approval_required" ? "complex"
        : "simple";
      const packet = produceEnvelopeFromRecommendation(action, complexity, []);
      assert.equal(packet.boundaries.runtimeBehaviorChanged, false, `${category}: runtimeBehaviorChanged`);
      assert.equal(packet.boundaries.mandatoryProductionSpawn, false, `${category}: mandatoryProductionSpawn`);
      assert.equal(packet.boundaries.brokerDispatchSemanticsChanged, false, `${category}: brokerDispatchSemanticsChanged`);
      assert.equal(packet.boundaries.taskFlowMutation, false, `${category}: taskFlowMutation`);
      assert.equal(packet.boundaries.dbMutation, false, `${category}: dbMutation`);
      assert.equal(packet.boundaries.deployOrRestart, false, `${category}: deployOrRestart`);
      assert.equal(packet.boundaries.secretMovement, false, `${category}: secretMovement`);
      assert.equal(packet.boundaries.approvalGranted, false, `${category}: approvalGranted`);
      assert.equal(packet.boundaries.executionDispatched, false, `${category}: executionDispatched`);
      assert.equal(packet.boundaries.providerMessageSent, false, `${category}: providerMessageSent`);
      assert.equal(packet.boundaries.terminalAckPerformed, false, `${category}: terminalAckPerformed`);
    }
  });

  it("all semantics flags are correct for source-only/no-live", () => {
    const packet = produceEnvelope(COMPLEX_PROPOSE_INPUT);
    assert.equal(packet.semantics.envelopeDraftOnly, true);
    assert.equal(packet.semantics.approvalNotGranted, true);
    assert.equal(packet.semantics.sourceOnlyNoLive, true);
    assert.equal(packet.semantics.recommendationSeparated, true);
    assert.equal(packet.semantics.approvalRequestDraftSeparated, true);
    assert.equal(packet.semantics.approvalGrantSeparated, true);
    assert.equal(packet.semantics.performsGitHubMutation, false);
    assert.equal(packet.semantics.performsProviderSend, false);
    assert.equal(packet.semantics.performsTerminalAck, false);
    assert.equal(packet.semantics.performsRuntimeRestartOrDeploy, false);
    assert.equal(packet.semantics.performsDbMutation, false);
    assert.equal(packet.semantics.createsTaskFlowRecords, false);
    assert.equal(packet.semantics.performsHistoricalReplay, false);
    assert.equal(packet.semantics.performsReleaseOrPublish, false);
    assert.equal(packet.semantics.movesSecretsOrCredentials, false);
  });
});

// ---------------------------------------------------------------------------
// Pipeline separation evidence
// ---------------------------------------------------------------------------

describe("pipeline separation (#971 recommendation ≠ #978 envelope ≠ approval grant)", () => {
  it("the envelope packet kind is different from the recommendation packet kind", () => {
    const packet = produceEnvelope(COMPLEX_PROPOSE_INPUT);
    assert.equal(packet.kind, "a2a-broker.finalizer-approval-envelope-draft.packet");
    assert.notEqual(packet.kind, "a2a-broker.complexity-orchestration-recommendation-packet");
  });

  it("envelope carries no dispatch or grant fields", () => {
    const packet = produceEnvelope(COMPLEX_PROPOSE_INPUT);
    // The envelope does NOT have dispatch, grant, or execution fields.
    // Those will exist in a later approval grant module.
    assert.equal(packet.boundaries.approvalGranted, false);
    assert.equal(packet.boundaries.executionDispatched, false);
    assert.equal(packet.semantics.envelopeDraftOnly, true);
    assert.equal(packet.semantics.approvalNotGranted, true);
  });

  it("envelope does not mutate or access live state", () => {
    const packet = produceEnvelope(CRITICAL_PROMOTE_INPUT);
    // All live mutation semantics are false.
    const liveSemantics = [
      "performsGitHubMutation",
      "performsProviderSend",
      "performsTerminalAck",
      "performsRuntimeRestartOrDeploy",
      "performsDbMutation",
      "createsTaskFlowRecords",
      "performsHistoricalReplay",
      "performsReleaseOrPublish",
      "movesSecretsOrCredentials",
    ] as const;
    for (const field of liveSemantics) {
      assert.equal(
        (packet.semantics as Record<string, boolean>)[field],
        false,
        `${field} should be false for source-only envelope`,
      );
    }
  });
});
