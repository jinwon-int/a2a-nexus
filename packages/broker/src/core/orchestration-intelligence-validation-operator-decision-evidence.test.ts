import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { buildOIValidationFinalizerReviewPacket } from "./orchestration-intelligence-validation-finalizer-review.js";
import { buildOIValidationOperatorReviewRequestPacket } from "./orchestration-intelligence-validation-operator-review-request.js";
import { buildOIValidationScorePacket } from "./orchestration-intelligence-validation-scorer.js";
import {
  buildOIValidationOperatorDecisionEvidencePacket,
  renderOIValidationOperatorDecisionEvidenceMarkdown,
} from "./orchestration-intelligence-validation-operator-decision-evidence.js";
import type { OIValidationScenarioId } from "./orchestration-intelligence-validation-framework.js";

const NOW = "2026-05-30T03:40:00.000Z";

const baselineMetrics = {
  elapsed_time_minutes: 90,
  human_intervention_count: 4,
  estimated_cost_usd: 12,
  output_quality_score: 3,
  system_stability_score: 4,
  approval_boundary_violated: false,
};

const improvedCandidateMetrics = {
  elapsed_time_minutes: 60,
  human_intervention_count: 2,
  estimated_cost_usd: 8,
  output_quality_score: 4,
  system_stability_score: 5,
  approval_boundary_violated: false,
};

function reviewRequest(candidateMetrics: typeof baselineMetrics = improvedCandidateMetrics) {
  const score = buildOIValidationScorePacket({
    generatedAt: NOW,
    evidence: ([
      "wiki-large-refactor",
      "skill-update-sweep",
      "complex-architecture-design",
      "a2a-worker-deployment",
    ] satisfies OIValidationScenarioId[]).map((id) => ({
      id,
      baselineMetrics,
      candidateMetrics,
    })),
  });
  const finalizerReview = buildOIValidationFinalizerReviewPacket({ generatedAt: NOW, score, reviewer: "brokerbeta" });
  return buildOIValidationOperatorReviewRequestPacket({ generatedAt: NOW, finalizerReview, operator: "seo-jin-on" });
}

test("accepts matching advance decision evidence for a ready review request", () => {
  const request = reviewRequest();
  const packet = buildOIValidationOperatorDecisionEvidencePacket({
    generatedAt: NOW,
    reviewRequest: request,
    decisionEvidence: {
      decision: "advance_to_next_source_step",
      actor: "seo-jin-on",
      observedAt: NOW,
      reviewRequestIdempotencyKey: request.idempotencyKey,
      rationale: "Ready to continue source-only planning.",
    },
  });

  assert.equal(packet.kind, "a2a-broker.orchestration-intelligence.validation-operator-decision-evidence.packet");
  assert.equal(packet.state, "decision_evidence_accepted");
  assert.equal(packet.accepted, true);
  assert.equal(packet.safety.decisionEvidenceOnly, true);
  assert.equal(packet.safety.grantsExecutionApproval, false);
  assert.equal(packet.safety.brokerDispatchCreated, false);
});

test("missing decision evidence stays waiting", () => {
  const packet = buildOIValidationOperatorDecisionEvidencePacket({
    generatedAt: NOW,
    reviewRequest: reviewRequest(),
  });

  assert.equal(packet.state, "decision_evidence_missing");
  assert.equal(packet.accepted, false);
  assert.ok(packet.blockers.includes("operator decision evidence is required before recording validation decision"));
});

test("mismatched review request idempotency key is conflicting", () => {
  const packet = buildOIValidationOperatorDecisionEvidencePacket({
    generatedAt: NOW,
    reviewRequest: reviewRequest(),
    decisionEvidence: {
      decision: "advance_to_next_source_step",
      actor: "seo-jin-on",
      reviewRequestIdempotencyKey: "different-review-request",
    },
  });

  assert.equal(packet.state, "decision_evidence_conflicting");
  assert.equal(packet.accepted, false);
});

test("blocks advance decisions when request state is evidence incomplete", () => {
  const score = buildOIValidationScorePacket({
    generatedAt: NOW,
    evidence: [{ id: "wiki-large-refactor", baselineMetrics }],
  });
  const finalizerReview = buildOIValidationFinalizerReviewPacket({ generatedAt: NOW, score });
  const request = buildOIValidationOperatorReviewRequestPacket({ generatedAt: NOW, finalizerReview });
  const packet = buildOIValidationOperatorDecisionEvidencePacket({
    generatedAt: NOW,
    reviewRequest: request,
    decisionEvidence: { decision: "advance_to_next_source_step", actor: "seo-jin-on" },
  });

  assert.equal(request.state, "evidence_incomplete");
  assert.equal(packet.state, "decision_blocked_by_request_state");
  assert.match(packet.blockers[0], /incompatible/);
});

test("accepts revise_candidate for degraded candidate review without granting approval", () => {
  const request = reviewRequest({ ...baselineMetrics, elapsed_time_minutes: 120 });
  const packet = buildOIValidationOperatorDecisionEvidencePacket({
    generatedAt: NOW,
    reviewRequest: request,
    decisionEvidence: { decision: "revise_candidate", actor: "brokerbeta" },
  });

  assert.equal(request.state, "candidate_review_required");
  assert.equal(packet.state, "decision_evidence_accepted");
  assert.equal(packet.safety.approvalGranted, false);
  assert.equal(packet.safety.runtimeExecutorCreated, false);
});

test("renders markdown without implying approval or execution", () => {
  const fixture = JSON.parse(readFileSync("fixtures/orchestration-intelligence/validation-operator-decision-evidence.accepted.json", "utf8"));
  const score = buildOIValidationScorePacket({ generatedAt: NOW, ...fixture.scoreInput });
  const finalizerReview = buildOIValidationFinalizerReviewPacket({ generatedAt: NOW, score, reviewer: fixture.reviewer });
  const request = buildOIValidationOperatorReviewRequestPacket({ generatedAt: NOW, finalizerReview, operator: fixture.operator });
  const packet = buildOIValidationOperatorDecisionEvidencePacket({
    generatedAt: NOW,
    reviewRequest: request,
    decisionEvidence: fixture.decisionEvidence,
  });
  const markdown = renderOIValidationOperatorDecisionEvidenceMarkdown(packet);

  assert.match(markdown, /A2A Orchestration Intelligence v2 validation operator decision evidence/);
  assert.match(markdown, /State: decision_evidence_accepted/);
  assert.match(markdown, /does not grant execution approval/);
  assert.match(markdown, /does not create a runtime executor/);
});
