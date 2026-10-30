import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { buildOIValidationScorePacket } from "./orchestration-intelligence-validation-scorer.js";
import {
  buildOIValidationFinalizerReviewPacket,
  renderOIValidationFinalizerReviewMarkdown,
} from "./orchestration-intelligence-validation-finalizer-review.js";
import type { OIValidationScenarioId } from "./orchestration-intelligence-validation-framework.js";

const NOW = "2026-05-30T02:10:00.000Z";

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

function readyScore() {
  return buildOIValidationScorePacket({
    generatedAt: NOW,
    evidence: ([
      "wiki-large-refactor",
      "skill-update-sweep",
      "complex-architecture-design",
      "a2a-worker-deployment",
    ] satisfies OIValidationScenarioId[]).map((id) => ({
      id,
      baselineMetrics,
      candidateMetrics: improvedCandidateMetrics,
    })),
  });
}

test("builds a source-only finalizer review from a score-ready packet", () => {
  const packet = buildOIValidationFinalizerReviewPacket({
    generatedAt: NOW,
    score: readyScore(),
    reviewer: "brokerbeta",
  });

  assert.equal(packet.kind, "a2a-broker.orchestration-intelligence.validation-finalizer-review.packet");
  assert.equal(packet.sourceOnly, true);
  assert.equal(packet.state, "review_ready");
  assert.equal(packet.finalizerRecommendation, "prepare_operator_review");
  assert.equal(packet.summary.scenariosReady, 4);
  assert.equal(packet.safety.grantsExecutionApproval, false);
  assert.equal(packet.safety.runtimeExecutorCreated, false);
  assert.equal(packet.safety.brokerDispatchCreated, false);
});

test("routes missing paired evidence to collect_missing_evidence", () => {
  const score = buildOIValidationScorePacket({
    generatedAt: NOW,
    evidence: [{ id: "wiki-large-refactor", baselineMetrics }],
  });
  const packet = buildOIValidationFinalizerReviewPacket({ generatedAt: NOW, score });

  assert.equal(packet.state, "evidence_incomplete");
  assert.equal(packet.finalizerRecommendation, "collect_missing_evidence");
  assert.equal(packet.scenarioReviews[0].recommendation, "collect_more_evidence");
  assert.ok(packet.summary.missingMetrics > 0);
});

test("keeps approval-boundary violations blocked for finalizer review", () => {
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
  const packet = buildOIValidationFinalizerReviewPacket({ generatedAt: NOW, score });

  assert.equal(packet.state, "approval_boundary_blocked");
  assert.equal(packet.finalizerRecommendation, "stop_for_approval_boundary_review");
  assert.equal(packet.scenarioReviews[0].recommendation, "blocked_by_approval_boundary");
});

test("routes degraded candidates to broker review without granting approval", () => {
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
      candidateMetrics: {
        ...baselineMetrics,
        elapsed_time_minutes: 120,
      },
    })),
  });
  const packet = buildOIValidationFinalizerReviewPacket({ generatedAt: NOW, score });

  assert.equal(packet.state, "candidate_needs_review");
  assert.equal(packet.finalizerRecommendation, "review_degraded_candidates");
  assert.equal(packet.safety.grantsExecutionApproval, false);
});

test("renders markdown without implying runtime execution", () => {
  const fixture = JSON.parse(readFileSync("fixtures/orchestration-intelligence/validation-finalizer-review.ready.json", "utf8"));
  const score = buildOIValidationScorePacket({ generatedAt: NOW, ...fixture.scoreInput });
  const packet = buildOIValidationFinalizerReviewPacket({ generatedAt: NOW, score, reviewer: "brokerbeta" });
  const markdown = renderOIValidationFinalizerReviewMarkdown(packet);

  assert.match(markdown, /A2A Orchestration Intelligence v2 validation finalizer review/);
  assert.match(markdown, /State: review_ready/);
  assert.match(markdown, /does not grant execution approval/);
  assert.match(markdown, /does not create a runtime executor/);
});
