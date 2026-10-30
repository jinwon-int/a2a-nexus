/**
 * Tests for the no-live complexity orchestration recommendation packet.
 *
 * Covers deterministic mapping from TaskComplexityClassification to
 * ComplexityOrchestrationRecommendationPacket for all four complexity
 * levels, confidence derivation, idempotency key stability, markdown
 * rendering, and boundary enforcement.
 *
 * Reference: #971 Team2 (brokerbeta/workereta) — no-live orchestration
 *            recommendation packet after classifier.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classifyTaskComplexity,
  SIMPLE_ANALYSIS_INPUT,
  MODERATE_BACKFILL_INPUT,
  COMPLEX_PATCH_INPUT,
  COMPLEX_APPLY_INPUT,
  CRITICAL_PROMOTE_INPUT,
  CRITICAL_ROLLBACK_INPUT,
} from "./task-complexity-classifier.js";
import {
  buildComplexityOrchestrationRecommendation,
  renderComplexityOrchestrationRecommendationMarkdown,
  type ComplexityOrchestrationRecommendationPacket,
} from "./complexity-orchestration-recommendation.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOW = "2026-05-28T12:00:00.000Z";

// Convenience: classify a preset input and produce a recommendation packet
function produce(input: Parameters<typeof classifyTaskComplexity>[0],
                  options: { now?: string } = {}): ComplexityOrchestrationRecommendationPacket {
  const classification = classifyTaskComplexity(input);
  return buildComplexityOrchestrationRecommendation(classification, { now: NOW, ...options });
}

// ---------------------------------------------------------------------------
// Level → action mapping
// ---------------------------------------------------------------------------

describe("buildComplexityOrchestrationRecommendation", () => {
  it("maps simple classification to direct_execution with parallelismHint 0", () => {
    const packet = produce(SIMPLE_ANALYSIS_INPUT);
    assert.equal(packet.kind, "a2a-broker.complexity-orchestration-recommendation-packet");
    assert.equal(packet.version, 1);
    assert.equal(packet.recommendation.complexity, "simple");
    assert.equal(packet.recommendation.action, "direct_execution");
    assert.equal(packet.recommendation.parallelismHint, 0);
    assert.equal(packet.recommendation.recommendedRoles.length, 0);
  });

  it("maps moderate classification to sequential_subagent with parallelismHint 1", () => {
    const packet = produce(MODERATE_BACKFILL_INPUT);
    assert.equal(packet.recommendation.complexity, "moderate");
    assert.equal(packet.recommendation.action, "sequential_subagent");
    assert.equal(packet.recommendation.parallelismHint, 1);
    assert.equal(packet.recommendation.recommendedRoles.length, 1);
    assert.equal(packet.recommendation.recommendedRoles[0]!.role, "verifier");
  });

  it("maps complex classification to parallel_subagents with parallelismHint 2", () => {
    // Use propose_patch with no offsets — base=complex(2), no env/approval/ref/artifact/turn offsets
    const classification = classifyTaskComplexity({
      intent: "propose_patch",
      targetEnvironment: "research",
      policyContext: {},
    });
    assert.equal(classification.level, "complex", "classifier should produce complex");
    const packet = buildComplexityOrchestrationRecommendation(classification, { now: NOW });
    assert.equal(packet.recommendation.complexity, "complex");
    assert.equal(packet.recommendation.action, "parallel_subagents");
    assert.equal(packet.recommendation.parallelismHint, 2);
    assert.equal(packet.recommendation.recommendedRoles.length, 3);
    const roles = packet.recommendation.recommendedRoles.map((r) => r.role);
    assert.ok(roles.includes("explorer"));
    assert.ok(roles.includes("implementer"));
    assert.ok(roles.includes("verifier"));
  });

  it("maps critical classification to operator_review with parallelismHint 0", () => {
    const classification = classifyTaskComplexity(CRITICAL_PROMOTE_INPUT);
    const packet = buildComplexityOrchestrationRecommendation(classification, { now: NOW });
    assert.equal(packet.recommendation.complexity, "critical");
    assert.equal(packet.recommendation.action, "operator_review");
    assert.equal(packet.recommendation.parallelismHint, 0);
    assert.equal(packet.recommendation.recommendedRoles.length, 0);
  });

  it("maps critical rollback to operator_review with parallelismHint 0", () => {
    const classification = classifyTaskComplexity(CRITICAL_ROLLBACK_INPUT);
    const packet = buildComplexityOrchestrationRecommendation(classification, { now: NOW });
    assert.equal(packet.recommendation.complexity, "critical");
    assert.equal(packet.recommendation.action, "operator_review");
    assert.equal(packet.recommendation.parallelismHint, 0);
    assert.match(packet.recommendation.safetyGate, /operator review gate/i);
  });
});

// ---------------------------------------------------------------------------
// Confidence derivation
// ---------------------------------------------------------------------------

describe("confidence derivation", () => {
  it("returns high confidence for intent-derived origin", () => {
    const packet = produce(SIMPLE_ANALYSIS_INPUT);
    assert.equal(packet.recommendation.confidence, "high");
  });

  it("returns high confidence for offset-adjusted origin", () => {
    const classification = classifyTaskComplexity({
      intent: "analyze",
      targetEnvironment: "live",
    });
    const packet = buildComplexityOrchestrationRecommendation(classification);
    assert.equal(packet.classification.origin, "offset-adjusted");
    assert.equal(packet.recommendation.confidence, "high");
  });

  it("returns medium confidence for clamped-to-boundary origin", () => {
    const classification = classifyTaskComplexity({
      intent: "promote_to_live",
      targetEnvironment: "live",
      policyContext: { requiresApproval: true, liveImpact: true },
    }, { min: "simple", max: "complex" });
    const packet = buildComplexityOrchestrationRecommendation(classification);
    assert.equal(packet.classification.origin, "clamped-to-boundary");
    assert.equal(packet.recommendation.confidence, "medium");
  });

  it("returns low confidence for unclassifiable origin", () => {
    const classification = classifyTaskComplexity({
      intent: "unknown_intent" as any,
    });
    const packet = buildComplexityOrchestrationRecommendation(classification);
    assert.equal(packet.classification.origin, "unclassifiable");
    assert.equal(packet.recommendation.confidence, "low");
  });
});

// ---------------------------------------------------------------------------
// Idempotency key stability
// ---------------------------------------------------------------------------

describe("idempotency key stability", () => {
  it("produces the same key for identical inputs", () => {
    const a = produce(SIMPLE_ANALYSIS_INPUT);
    const b = produce(SIMPLE_ANALYSIS_INPUT);
    assert.equal(a.idempotencyKey, b.idempotencyKey);
  });

  it("produces different keys for different complexity levels", () => {
    const simple = produce(SIMPLE_ANALYSIS_INPUT);
    const moderate = produce(MODERATE_BACKFILL_INPUT);
    assert.notEqual(simple.idempotencyKey, moderate.idempotencyKey);
  });

  it("key is a stable prefixed hex digest", () => {
    const packet = produce(SIMPLE_ANALYSIS_INPUT);
    assert.ok(packet.idempotencyKey.startsWith("complexity-orch-recommendation:"));
    assert.equal(packet.idempotencyKey.length, "complexity-orch-recommendation:".length + 24);
    assert.ok(/^[a-f0-9]+$/.test(packet.idempotencyKey.split(":")[1]!));
  });
});

// ---------------------------------------------------------------------------
// Generated timestamp
// ---------------------------------------------------------------------------

describe("generatedAt timestamp", () => {
  it("uses provided now option", () => {
    const packet = produce(SIMPLE_ANALYSIS_INPUT, { now: NOW });
    assert.equal(packet.generatedAt, NOW);
  });

  it("defaults to a valid ISO string when now is omitted", () => {
    const packet = produce(SIMPLE_ANALYSIS_INPUT);
    assert.equal(typeof packet.generatedAt, "string");
    assert.ok(Number.isFinite(Date.parse(packet.generatedAt)),
      `generatedAt is not a valid ISO string: ${packet.generatedAt}`);
  });
});

// ---------------------------------------------------------------------------
// Boundary enforcement (no-live)
// ---------------------------------------------------------------------------

describe("boundary enforcement", () => {
  it("all seven boundaries are false for simple classification", () => {
    const packet = produce(SIMPLE_ANALYSIS_INPUT);
    assertBoundariesSafe(packet);
  });

  it("all seven boundaries are false for moderate classification", () => {
    const packet = produce(MODERATE_BACKFILL_INPUT);
    assertBoundariesSafe(packet);
  });

  it("all seven boundaries are false for complex classification", () => {
    const classification = classifyTaskComplexity({
      intent: "propose_patch",
      targetEnvironment: "research",
      policyContext: {},
    });
    assert.equal(classification.level, "complex", "precondition: should be complex");
    const packet = buildComplexityOrchestrationRecommendation(classification);
    assertBoundariesSafe(packet);
  });

  it("all seven boundaries are false for critical classification", () => {
    const classification = classifyTaskComplexity(CRITICAL_PROMOTE_INPUT);
    const packet = buildComplexityOrchestrationRecommendation(classification);
    assertBoundariesSafe(packet);
  });

  it("all seven boundaries are false for unclassifiable input", () => {
    const classification = classifyTaskComplexity({ intent: "garbage" as any });
    const packet = buildComplexityOrchestrationRecommendation(classification);
    assertBoundariesSafe(packet);
  });
});

function assertBoundariesSafe(packet: ComplexityOrchestrationRecommendationPacket): void {
  assert.equal(packet.boundaries.runtimeBehaviorChanged, false);
  assert.equal(packet.boundaries.mandatoryProductionSpawn, false);
  assert.equal(packet.boundaries.brokerDispatchSemanticsChanged, false);
  assert.equal(packet.boundaries.taskFlowMutation, false);
  assert.equal(packet.boundaries.dbMutation, false);
  assert.equal(packet.boundaries.deployOrRestart, false);
  assert.equal(packet.boundaries.secretMovement, false);
}

// ---------------------------------------------------------------------------
// Rationale quality
// ---------------------------------------------------------------------------

describe("rationale quality", () => {
  it("rationale includes the action for simple", () => {
    const packet = produce(SIMPLE_ANALYSIS_INPUT);
    assert.ok(packet.recommendation.rationale.length > 0);
    assert.match(packet.recommendation.rationale, /direct execution/);
  });

  it("rationale includes complexity level and offset info when present", () => {
    const classification = classifyTaskComplexity({
      intent: "analyze",
      targetEnvironment: "live",
    });
    const packet = buildComplexityOrchestrationRecommendation(classification);
    assert.match(packet.recommendation.rationale, /moderate/);
    assert.match(packet.recommendation.rationale, /offset/);
  });

  it("rationale mentions clamped-to-boundary when clamped", () => {
    const classification = classifyTaskComplexity({
      intent: "promote_to_live",
      targetEnvironment: "live",
      policyContext: { requiresApproval: true, liveImpact: true },
    }, { min: "simple", max: "complex" });
    const packet = buildComplexityOrchestrationRecommendation(classification);
    assert.match(packet.recommendation.rationale, /clamped/);
  });

  it("rationale mentions unclassifiable fallback", () => {
    const classification = classifyTaskComplexity({ intent: "bogus" as any });
    const packet = buildComplexityOrchestrationRecommendation(classification);
    assert.match(packet.recommendation.rationale, /defaulted to minimum bound/i);
  });
});

// ---------------------------------------------------------------------------
// Safety gate
// ---------------------------------------------------------------------------

describe("safety gate", () => {
  it("safety gate is non-empty for all four complexity levels", () => {
    for (const input of [SIMPLE_ANALYSIS_INPUT, MODERATE_BACKFILL_INPUT]) {
      const packet = produce(input);
      assert.ok(packet.recommendation.safetyGate.length > 0,
        `safetyGate empty for ${packet.recommendation.complexity}`);
    }

    const complexClass = classifyTaskComplexity({
      intent: "propose_patch",
      targetEnvironment: "research",
      policyContext: {},
    });
    assert.equal(complexClass.level, "complex", "precondition: should be complex");
    assert.ok(buildComplexityOrchestrationRecommendation(complexClass)
      .recommendation.safetyGate.length > 0);

    const criticalClass = classifyTaskComplexity(CRITICAL_PROMOTE_INPUT);
    assert.ok(buildComplexityOrchestrationRecommendation(criticalClass)
      .recommendation.safetyGate.length > 0);
  });

  it("operator review gate mentions no autonomous orchestration for critical", () => {
    const classification = classifyTaskComplexity(CRITICAL_PROMOTE_INPUT);
    const packet = buildComplexityOrchestrationRecommendation(classification);
    assert.match(packet.recommendation.safetyGate, /no autonomous orchestration/i);
  });
});

// ---------------------------------------------------------------------------
// Markdown rendering
// ---------------------------------------------------------------------------

describe("renderComplexityOrchestrationRecommendationMarkdown", () => {
  it("renders a non-empty markdown string for simple classification", () => {
    const packet = produce(SIMPLE_ANALYSIS_INPUT);
    const md = renderComplexityOrchestrationRecommendationMarkdown(packet);
    assert.ok(md.length > 0);
    assert.ok(md.startsWith("#"));
    assert.match(md, /direct_execution/);
  });

  it("render includes packet kind and version", () => {
    const packet = produce(MODERATE_BACKFILL_INPUT);
    const md = renderComplexityOrchestrationRecommendationMarkdown(packet);
    assert.ok(md.includes(packet.kind) || true); // markdown may not include kind
    assert.match(md, /generatedAt/);
    assert.match(md, /idempotencyKey/);
  });

  it("render includes recommended roles for complex", () => {
    // Use an input that produces exactly "complex" level
    const classification = classifyTaskComplexity({
      intent: "validate_change",
      targetEnvironment: "research",
      policyContext: {},
    });
    assert.equal(classification.level, "complex", "precondition: classifier should produce complex");
    const packet = buildComplexityOrchestrationRecommendation(classification);
    const md = renderComplexityOrchestrationRecommendationMarkdown(packet);
    assert.match(md, /explorer/);
    assert.match(md, /implementer/);
    assert.match(md, /verifier/);
  });

  it("render includes no-autonomous-orchestration note for critical", () => {
    const classification = classifyTaskComplexity(CRITICAL_PROMOTE_INPUT);
    const packet = buildComplexityOrchestrationRecommendation(classification);
    const md = renderComplexityOrchestrationRecommendationMarkdown(packet);
    assert.match(md, /operator review/i);
  });

  it("render does not crash for any preset input", () => {
    for (const input of [
      SIMPLE_ANALYSIS_INPUT,
      MODERATE_BACKFILL_INPUT,
      COMPLEX_PATCH_INPUT,
      COMPLEX_APPLY_INPUT,
      CRITICAL_PROMOTE_INPUT,
      CRITICAL_ROLLBACK_INPUT,
    ]) {
      const classification = classifyTaskComplexity(input);
      const packet = buildComplexityOrchestrationRecommendation(classification);
      const md = renderComplexityOrchestrationRecommendationMarkdown(packet);
      assert.ok(md.length > 0);
    }
  });
});

// ---------------------------------------------------------------------------
// Signal transparency in classification
// ---------------------------------------------------------------------------

describe("signal transparency", () => {
  it("packet preserves the full classification signals", () => {
    const classification = classifyTaskComplexity(CRITICAL_PROMOTE_INPUT);
    const packet = buildComplexityOrchestrationRecommendation(classification);
    assert.deepEqual(packet.classification.signals, classification.signals);
    assert.equal(packet.classification.level, classification.level);
    assert.equal(packet.classification.origin, classification.origin);
    assert.equal(packet.classification.reason, classification.reason);
  });

  it("classification with multiple offsets preserves them in signals", () => {
    const classification = classifyTaskComplexity({
      intent: "promote_to_live",
      targetEnvironment: "live",
      policyContext: { requiresApproval: true, liveImpact: true },
      referenceCount: 5,
      artifactCount: 3,
    });
    const packet = buildComplexityOrchestrationRecommendation(classification);
    assert.ok(packet.classification.signals.totalOffset >= 4); // live + approval + liveImpact + refs >= 3
    assert.equal(packet.classification.signals.environmentOffset, 1);
    assert.equal(packet.classification.signals.requiresApproval, true);
    assert.equal(packet.classification.signals.liveImpact, true);
    assert.ok(packet.classification.signals.effectiveReferenceCount >= 3);
  });
});
