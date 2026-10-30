import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { buildOIValidationFinalizerReviewPacket } from "./orchestration-intelligence-validation-finalizer-review.js";
import { buildOIValidationScorePacket } from "./orchestration-intelligence-validation-scorer.js";
import {
  buildOIValidationOperatorReviewRequestPacket,
  renderOIValidationOperatorReviewRequestMarkdown,
} from "./orchestration-intelligence-validation-operator-review-request.js";
import type { OIValidationScenarioId } from "./orchestration-intelligence-validation-framework.js";

const NOW = "2026-05-30T03:20:00.000Z";

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

function finalizerReviewForAllCandidateMetrics(candidateMetrics: typeof baselineMetrics) {
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
      evidenceUrls: [`https://example.test/${id}`],
    })),
  });
  return buildOIValidationFinalizerReviewPacket({ generatedAt: NOW, score, reviewer: "brokerbeta" });
}

test("builds a source-only operator review request from a review-ready packet", () => {
  const packet = buildOIValidationOperatorReviewRequestPacket({
    generatedAt: NOW,
    finalizerReview: finalizerReviewForAllCandidateMetrics(improvedCandidateMetrics),
    operator: "seo-jin-on",
  });

  assert.equal(packet.kind, "a2a-broker.orchestration-intelligence.validation-operator-review-request.packet");
  assert.equal(packet.sourceOnly, true);
  assert.equal(packet.state, "operator_review_request_ready");
  assert.equal(packet.requestedDecision, "review_validation_results");
  assert.equal(packet.scenarioRequests.length, 4);
  assert.equal(packet.safety.approvalRequestDraftOnly, true);
  assert.equal(packet.safety.grantsExecutionApproval, false);
  assert.equal(packet.safety.brokerDispatchCreated, false);
});

test("routes missing paired evidence to an evidence collection request", () => {
  const score = buildOIValidationScorePacket({
    generatedAt: NOW,
    evidence: [{ id: "wiki-large-refactor", baselineMetrics }],
  });
  const finalizerReview = buildOIValidationFinalizerReviewPacket({ generatedAt: NOW, score });
  const packet = buildOIValidationOperatorReviewRequestPacket({ generatedAt: NOW, finalizerReview });

  assert.equal(packet.state, "evidence_incomplete");
  assert.equal(packet.requestedDecision, "collect_missing_evidence");
  assert.ok(packet.missingEvidence.includes("elapsed_time_minutes"));
  assert.ok(packet.operatorPrompts.some((prompt) => prompt.includes("Collect the missing")));
});

test("keeps approval-boundary violations blocked", () => {
  const score = buildOIValidationScorePacket({
    generatedAt: NOW,
    evidence: [
      {
        id: "wiki-large-refactor",
        baselineMetrics,
        candidateMetrics: { ...baselineMetrics, approval_boundary_violated: true },
      },
    ],
  });
  const finalizerReview = buildOIValidationFinalizerReviewPacket({ generatedAt: NOW, score });
  const packet = buildOIValidationOperatorReviewRequestPacket({ generatedAt: NOW, finalizerReview });

  assert.equal(packet.state, "approval_boundary_blocked");
  assert.equal(packet.requestedDecision, "stop_for_approval_boundary_review");
  assert.ok(packet.blockers.some((blocker) => blocker.includes("approval_boundary_violated")));
  assert.equal(packet.safety.approvalGranted, false);
});

test("routes degraded candidates to operator review without dispatching work", () => {
  const finalizerReview = finalizerReviewForAllCandidateMetrics({
    ...baselineMetrics,
    elapsed_time_minutes: 120,
  });
  const packet = buildOIValidationOperatorReviewRequestPacket({ generatedAt: NOW, finalizerReview });

  assert.equal(packet.state, "candidate_review_required");
  assert.equal(packet.requestedDecision, "review_degraded_candidates");
  assert.ok(packet.scenarioRequests.every((scenario) => scenario.operatorAction === "hold_for_broker_review"));
  assert.equal(packet.safety.workerSpawned, false);
});

test("renders markdown without implying approval or runtime execution", () => {
  const fixture = JSON.parse(readFileSync("fixtures/orchestration-intelligence/validation-operator-review-request.ready.json", "utf8"));
  const score = buildOIValidationScorePacket({ generatedAt: NOW, ...fixture.scoreInput });
  const finalizerReview = buildOIValidationFinalizerReviewPacket({ generatedAt: NOW, score, reviewer: "brokerbeta" });
  const packet = buildOIValidationOperatorReviewRequestPacket({
    generatedAt: NOW,
    finalizerReview,
    operator: fixture.operator,
  });
  const markdown = renderOIValidationOperatorReviewRequestMarkdown(packet);

  assert.match(markdown, /A2A Orchestration Intelligence v2 validation operator review request/);
  assert.match(markdown, /State: operator_review_request_ready/);
  assert.match(markdown, /does not grant execution approval/);
  assert.match(markdown, /does not create a runtime executor/);
});
