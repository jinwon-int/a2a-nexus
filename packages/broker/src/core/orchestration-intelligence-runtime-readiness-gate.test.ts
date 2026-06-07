import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { buildOIValidationFinalizerDecisionPacket } from "./orchestration-intelligence-validation-finalizer-decision.js";
import { buildOIValidationFinalizerReviewPacket } from "./orchestration-intelligence-validation-finalizer-review.js";
import { buildOIValidationOperatorDecisionEvidencePacket } from "./orchestration-intelligence-validation-operator-decision-evidence.js";
import { buildOIValidationOperatorReviewRequestPacket } from "./orchestration-intelligence-validation-operator-review-request.js";
import { buildOIValidationScorePacket } from "./orchestration-intelligence-validation-scorer.js";
import {
  buildOIRuntimeReadinessGatePacket,
  renderOIRuntimeReadinessGateMarkdown,
} from "./orchestration-intelligence-runtime-readiness-gate.js";

const NOW = "2026-05-30T04:30:00.000Z";

function finalizerDecision(decision = "advance_to_next_source_step") {
  const fixture = JSON.parse(readFileSync("fixtures/orchestration-intelligence/validation-finalizer-decision.ready.json", "utf8"));
  const score = buildOIValidationScorePacket({ generatedAt: NOW, ...fixture.scoreInput });
  const finalizerReview = buildOIValidationFinalizerReviewPacket({ generatedAt: NOW, score, reviewer: fixture.reviewer });
  const reviewRequest = buildOIValidationOperatorReviewRequestPacket({ generatedAt: NOW, finalizerReview, operator: fixture.operator });
  const evidence = buildOIValidationOperatorDecisionEvidencePacket({
    generatedAt: NOW,
    reviewRequest,
    decisionEvidence: { ...fixture.decisionEvidence, decision },
  });
  return buildOIValidationFinalizerDecisionPacket({
    generatedAt: NOW,
    finalizer: fixture.finalizer,
    operatorDecisionEvidence: evidence,
  });
}

const allRuntimeEvidence = {
  runtimeExecutorDesignReviewed: true,
  explicitRuntimeApprovalPresent: true,
  brokerDispatchApprovalPresent: true,
  workerSpawnApprovalPresent: true,
  daegyoMobileScopeResolved: true,
  rollbackAbortCriteriaDocumented: true,
  liveBoundaryPlanDocumented: true,
  validationEvidenceFresh: true,
};

test("defaults to NO-GO for runtime executor even when source chain can advance", () => {
  const packet = buildOIRuntimeReadinessGatePacket({
    generatedAt: NOW,
    reviewer: "gwakga",
    finalizerDecision: finalizerDecision(),
  });

  assert.equal(packet.kind, "a2a-broker.orchestration-intelligence.runtime-readiness-gate.packet");
  assert.equal(packet.state, "no_go_runtime_executor");
  assert.equal(packet.runtimeDisposition, "no_go");
  assert.ok(packet.blockers.some((blocker) => blocker.includes("runtime_executor_design_reviewed")));
  assert.ok(packet.blockers.some((blocker) => blocker.includes("explicit_runtime_approval_present")));
  assert.ok(packet.blockers.some((blocker) => blocker.includes("daegyo_mobile_scope_resolved")));
  assert.equal(packet.safety.runtimeReadinessGateOnly, true);
  assert.equal(packet.safety.grantsExecutionApproval, false);
  assert.equal(packet.safety.runtimeExecutorEnabled, false);
  assert.equal(packet.safety.brokerDispatchCreated, false);
});

test("can become ready only for separate runtime design review when every gate is explicit", () => {
  const packet = buildOIRuntimeReadinessGatePacket({
    generatedAt: NOW,
    finalizerDecision: finalizerDecision(),
    runtimeEvidence: allRuntimeEvidence,
  });

  assert.equal(packet.state, "ready_for_runtime_design_review");
  assert.equal(packet.runtimeDisposition, "design_review_only");
  assert.equal(packet.blockers.length, 0);
  assert.equal(packet.safety.grantsExecutionApproval, false);
  assert.equal(packet.safety.runtimeExecutorCreated, false);
  assert.equal(packet.safety.workerSpawned, false);
});

test("waits when the source validation chain is not ready", () => {
  const packet = buildOIRuntimeReadinessGatePacket({
    generatedAt: NOW,
    finalizerDecision: finalizerDecision("collect_more_evidence"),
    runtimeEvidence: allRuntimeEvidence,
  });

  assert.equal(packet.state, "source_chain_not_ready");
  assert.equal(packet.runtimeDisposition, "wait_for_source_chain");
});

test("preserves approval boundary and candidate revision states", () => {
  assert.equal(
    buildOIRuntimeReadinessGatePacket({
      generatedAt: NOW,
      finalizerDecision: finalizerDecision("stop_for_approval_boundary_review"),
      runtimeEvidence: allRuntimeEvidence,
    }).state,
    "approval_boundary_review_required",
  );
  assert.equal(
    buildOIRuntimeReadinessGatePacket({
      generatedAt: NOW,
      finalizerDecision: finalizerDecision("revise_candidate"),
      runtimeEvidence: allRuntimeEvidence,
    }).state,
    "candidate_revision_required",
  );
});

test("renders a NO-GO matrix without implying execution", () => {
  const fixture = JSON.parse(readFileSync("fixtures/orchestration-intelligence/runtime-readiness-gate.no-go.json", "utf8"));
  const sourceDecision = finalizerDecision();
  const packet = buildOIRuntimeReadinessGatePacket({
    generatedAt: NOW,
    reviewer: fixture.reviewer,
    finalizerDecision: sourceDecision,
    runtimeEvidence: fixture.runtimeEvidence,
    notes: fixture.notes,
  });
  const markdown = renderOIRuntimeReadinessGateMarkdown(packet);

  assert.match(markdown, /runtime readiness gate/);
  assert.match(markdown, /State: no_go_runtime_executor/);
  assert.match(markdown, /runtime_executor_design_reviewed: fail/);
  assert.match(markdown, /does not grant execution approval/);
  assert.match(markdown, /does not create or enable a runtime executor/);
});
