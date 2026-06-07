import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { buildOIValidationFinalizerReviewPacket } from "./orchestration-intelligence-validation-finalizer-review.js";
import { buildOIValidationOperatorDecisionEvidencePacket } from "./orchestration-intelligence-validation-operator-decision-evidence.js";
import { buildOIValidationOperatorReviewRequestPacket } from "./orchestration-intelligence-validation-operator-review-request.js";
import { buildOIValidationScorePacket } from "./orchestration-intelligence-validation-scorer.js";
import {
  buildOIValidationFinalizerDecisionPacket,
  renderOIValidationFinalizerDecisionMarkdown,
} from "./orchestration-intelligence-validation-finalizer-decision.js";

const NOW = "2026-05-30T03:52:00.000Z";

function acceptedEvidence(
  decision:
    | "advance_to_next_source_step"
    | "collect_more_evidence"
    | "stop_for_approval_boundary_review"
    | "revise_candidate" = "advance_to_next_source_step",
) {
  const fixture = JSON.parse(readFileSync("fixtures/orchestration-intelligence/validation-operator-decision-evidence.accepted.json", "utf8"));
  const score = buildOIValidationScorePacket({ generatedAt: NOW, ...fixture.scoreInput });
  const finalizerReview = buildOIValidationFinalizerReviewPacket({ generatedAt: NOW, score, reviewer: fixture.reviewer });
  const reviewRequest = buildOIValidationOperatorReviewRequestPacket({ generatedAt: NOW, finalizerReview, operator: fixture.operator });
  return buildOIValidationOperatorDecisionEvidencePacket({
    generatedAt: NOW,
    reviewRequest,
    decisionEvidence: { ...fixture.decisionEvidence, decision },
  });
}

test("converts accepted advance evidence into a source-only finalizer decision", () => {
  const packet = buildOIValidationFinalizerDecisionPacket({
    generatedAt: NOW,
    finalizer: "gwakga",
    operatorDecisionEvidence: acceptedEvidence(),
  });

  assert.equal(packet.kind, "a2a-broker.orchestration-intelligence.validation-finalizer-decision.packet");
  assert.equal(packet.state, "ready_for_next_source_step");
  assert.equal(packet.disposition, "advance_source_only");
  assert.equal(packet.acceptedOperatorDecision, true);
  assert.equal(packet.safety.finalizerDecisionOnly, true);
  assert.equal(packet.safety.grantsExecutionApproval, false);
  assert.equal(packet.safety.runtimeExecutorCreated, false);
  assert.equal(packet.safety.brokerDispatchCreated, false);
});

test("missing operator decision evidence remains waiting", () => {
  const evidence = buildOIValidationOperatorDecisionEvidencePacket({ generatedAt: NOW });
  const packet = buildOIValidationFinalizerDecisionPacket({
    generatedAt: NOW,
    operatorDecisionEvidence: evidence,
  });

  assert.equal(packet.state, "waiting_for_operator_decision");
  assert.equal(packet.disposition, "wait");
  assert.deepEqual(packet.blockers, evidence.blockers);
});

test("conflicting operator evidence requires conflict resolution", () => {
  const requestEvidence = acceptedEvidence();
  const evidence = buildOIValidationOperatorDecisionEvidencePacket({
    generatedAt: NOW,
    decisionEvidence: {
      decision: "advance_to_next_source_step",
      actor: "seo-jin-on",
      reviewRequestIdempotencyKey: requestEvidence.reviewRequestIdempotencyKey + "-stale",
    },
  });
  const packet = buildOIValidationFinalizerDecisionPacket({
    generatedAt: NOW,
    operatorDecisionEvidence: evidence,
  });

  assert.equal(packet.state, "operator_decision_conflict");
  assert.equal(packet.disposition, "resolve_conflict");
  assert.match(packet.nextActions.join(" "), /conflicting/);
});

test("maps non-advance accepted decisions to conservative finalizer states", () => {
  assert.equal(
    buildOIValidationFinalizerDecisionPacket({
      generatedAt: NOW,
      operatorDecisionEvidence: acceptedEvidence("collect_more_evidence"),
    }).state,
    "collect_more_validation_evidence",
  );
  assert.equal(
    buildOIValidationFinalizerDecisionPacket({
      generatedAt: NOW,
      operatorDecisionEvidence: acceptedEvidence("stop_for_approval_boundary_review"),
    }).state,
    "approval_boundary_review_required",
  );
  assert.equal(
    buildOIValidationFinalizerDecisionPacket({
      generatedAt: NOW,
      operatorDecisionEvidence: acceptedEvidence("revise_candidate"),
    }).state,
    "candidate_revision_required",
  );
});

test("renders markdown without implying execution approval", () => {
  const fixture = JSON.parse(readFileSync("fixtures/orchestration-intelligence/validation-finalizer-decision.ready.json", "utf8"));
  const score = buildOIValidationScorePacket({ generatedAt: NOW, ...fixture.scoreInput });
  const finalizerReview = buildOIValidationFinalizerReviewPacket({ generatedAt: NOW, score, reviewer: fixture.reviewer });
  const reviewRequest = buildOIValidationOperatorReviewRequestPacket({ generatedAt: NOW, finalizerReview, operator: fixture.operator });
  const evidence = buildOIValidationOperatorDecisionEvidencePacket({
    generatedAt: NOW,
    reviewRequest,
    decisionEvidence: fixture.decisionEvidence,
  });
  const packet = buildOIValidationFinalizerDecisionPacket({
    generatedAt: NOW,
    finalizer: fixture.finalizer,
    operatorDecisionEvidence: evidence,
  });
  const markdown = renderOIValidationFinalizerDecisionMarkdown(packet);

  assert.match(markdown, /A2A Orchestration Intelligence v2 validation finalizer decision/);
  assert.match(markdown, /State: ready_for_next_source_step/);
  assert.match(markdown, /does not grant execution approval/);
  assert.match(markdown, /does not create a runtime executor/);
});
