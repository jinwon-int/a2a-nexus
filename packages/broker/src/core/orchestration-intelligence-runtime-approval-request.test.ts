import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildOIRuntimeApprovalRequestPacket,
  renderOIRuntimeApprovalRequestMarkdown,
} from "./orchestration-intelligence-runtime-approval-request.js";
import { buildOIRuntimeDesignReviewPacket } from "./orchestration-intelligence-runtime-design-review.js";
import { buildOIRuntimeReadinessGatePacket } from "./orchestration-intelligence-runtime-readiness-gate.js";
import { buildOIValidationFinalizerDecisionPacket } from "./orchestration-intelligence-validation-finalizer-decision.js";
import { buildOIValidationFinalizerReviewPacket } from "./orchestration-intelligence-validation-finalizer-review.js";
import { buildOIValidationOperatorDecisionEvidencePacket } from "./orchestration-intelligence-validation-operator-decision-evidence.js";
import { buildOIValidationOperatorReviewRequestPacket } from "./orchestration-intelligence-validation-operator-review-request.js";
import { buildOIValidationScorePacket } from "./orchestration-intelligence-validation-scorer.js";

const NOW = "2026-05-30T09:15:00.000Z";
const PHRASE = "APPROVE OI V2 RUNTIME APPROVAL REQUEST FOR SOURCE-ONLY EVIDENCE REVIEW";

const allDesignEvidence = {
  executorContractDocumented: true,
  brokerDispatchBoundaryDocumented: true,
  workerSpawnBoundaryDocumented: true,
  daegyoMobileBoundaryDocumented: true,
  rollbackAbortCriteriaDocumented: true,
  liveBoundaryPlanDocumented: true,
  observabilityPlanDocumented: true,
};

const allApprovalEvidence = {
  requiredApprovalPhrase: PHRASE,
  approverIdentityDocumented: true,
  requestScopeDocumented: true,
  approvalConditionsDocumented: true,
  riskSummaryDocumented: true,
  rollbackAbortCriteriaReferenced: true,
  liveBoundaryPlanReferenced: true,
  expiryOrRevocationDocumented: true,
};

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

function runtimeReadinessGate(decision = "advance_to_next_source_step") {
  return buildOIRuntimeReadinessGatePacket({
    generatedAt: NOW,
    reviewer: "gwakga",
    finalizerDecision: finalizerDecision(decision),
    runtimeEvidence: {
      runtimeExecutorDesignReviewed: false,
      explicitRuntimeApprovalPresent: false,
      brokerDispatchApprovalPresent: false,
      workerSpawnApprovalPresent: false,
      daegyoMobileScopeResolved: false,
      rollbackAbortCriteriaDocumented: false,
      liveBoundaryPlanDocumented: false,
      validationEvidenceFresh: true,
    },
  });
}

function runtimeDesignReview(decision = "advance_to_next_source_step") {
  return buildOIRuntimeDesignReviewPacket({
    generatedAt: NOW,
    reviewer: "gwakga",
    runtimeReadinessGate: runtimeReadinessGate(decision),
    designEvidence: allDesignEvidence,
  });
}

test("builds an explicit runtime approval request without granting approval", () => {
  const packet = buildOIRuntimeApprovalRequestPacket({
    generatedAt: NOW,
    requester: "gwakga",
    operator: "seo-jin-on",
    runtimeDesignReview: runtimeDesignReview(),
    approvalEvidence: allApprovalEvidence,
  });

  assert.equal(packet.kind, "a2a-broker.orchestration-intelligence.runtime-approval-request.packet");
  assert.equal(packet.state, "approval_request_ready");
  assert.equal(packet.disposition, "request_explicit_runtime_approval_evidence");
  assert.equal(packet.approvalRequest.requestedApprovalPhrase, PHRASE);
  assert.equal(packet.runtimeReadinessEvidencePatch.runtimeExecutorDesignReviewed, true);
  assert.equal(packet.runtimeReadinessEvidencePatch.explicitRuntimeApprovalPresent, false);
  assert.equal(packet.runtimeReadinessEvidencePatch.brokerDispatchApprovalPresent, false);
  assert.equal(packet.runtimeReadinessEvidencePatch.workerSpawnApprovalPresent, false);
  assert.equal(packet.runtimeReadinessEvidencePatch.daegyoMobileScopeResolved, false);
  assert.equal(packet.safety.runtimeApprovalRequestOnly, true);
  assert.equal(packet.safety.explicitRuntimeApprovalPresent, false);
  assert.equal(packet.safety.approvalGranted, false);
  assert.equal(packet.safety.runtimeExecutorEnabled, false);
  assert.equal(packet.safety.brokerDispatchCreated, false);
  assert.equal(packet.safety.workerSpawned, false);
  assert.equal(packet.safety.daegyoScopeExpanded, false);
});

test("fails closed when approval request evidence is incomplete", () => {
  const packet = buildOIRuntimeApprovalRequestPacket({
    generatedAt: NOW,
    runtimeDesignReview: runtimeDesignReview(),
    approvalEvidence: {
      requiredApprovalPhrase: PHRASE,
      approverIdentityDocumented: true,
    },
  });

  assert.equal(packet.state, "approval_request_incomplete");
  assert.equal(packet.runtimeReadinessEvidencePatch.explicitRuntimeApprovalPresent, false);
  assert.ok(packet.blockers.some((blocker) => blocker.includes("approval_conditions_documented")));
  assert.ok(packet.blockers.some((blocker) => blocker.includes("live_boundary_plan_referenced")));
});

test("rejects vague approval phrases", () => {
  const packet = buildOIRuntimeApprovalRequestPacket({
    generatedAt: NOW,
    runtimeDesignReview: runtimeDesignReview(),
    approvalEvidence: {
      ...allApprovalEvidence,
      requiredApprovalPhrase: "ok",
    },
  });

  assert.equal(packet.state, "approval_request_incomplete");
  assert.ok(packet.blockers.some((blocker) => blocker.includes("required_approval_phrase_documented")));
  assert.equal(packet.runtimeReadinessEvidencePatch.explicitRuntimeApprovalPresent, false);
});

test("waits when runtime design review is not ready", () => {
  const incompleteDesignReview = buildOIRuntimeDesignReviewPacket({
    generatedAt: NOW,
    runtimeReadinessGate: runtimeReadinessGate(),
    designEvidence: {
      executorContractDocumented: true,
    },
  });
  const packet = buildOIRuntimeApprovalRequestPacket({
    generatedAt: NOW,
    runtimeDesignReview: incompleteDesignReview,
    approvalEvidence: allApprovalEvidence,
  });

  assert.equal(packet.state, "runtime_design_review_not_ready");
  assert.equal(packet.disposition, "wait_for_runtime_design_review");
  assert.equal(packet.runtimeReadinessEvidencePatch.runtimeExecutorDesignReviewed, false);
  assert.equal(packet.runtimeReadinessEvidencePatch.explicitRuntimeApprovalPresent, false);
});

test("preserves approval-boundary and candidate-revision states", () => {
  assert.equal(
    buildOIRuntimeApprovalRequestPacket({
      generatedAt: NOW,
      runtimeDesignReview: runtimeDesignReview("stop_for_approval_boundary_review"),
      approvalEvidence: allApprovalEvidence,
    }).state,
    "approval_boundary_review_required",
  );
  assert.equal(
    buildOIRuntimeApprovalRequestPacket({
      generatedAt: NOW,
      runtimeDesignReview: runtimeDesignReview("revise_candidate"),
      approvalEvidence: allApprovalEvidence,
    }).state,
    "candidate_revision_required",
  );
});

test("renders request phrase, required conditions, and remaining NO-GO boundaries", () => {
  const fixture = JSON.parse(readFileSync("fixtures/orchestration-intelligence/runtime-approval-request.ready.json", "utf8"));
  const packet = buildOIRuntimeApprovalRequestPacket({
    generatedAt: NOW,
    requester: fixture.requester,
    operator: fixture.operator,
    runtimeDesignReview: runtimeDesignReview(),
    approvalEvidence: fixture.approvalEvidence,
    notes: fixture.notes,
  });
  const markdown = renderOIRuntimeApprovalRequestMarkdown(packet);

  assert.match(markdown, /explicit runtime approval request/);
  assert.match(markdown, /State: approval_request_ready/);
  assert.match(markdown, /APPROVE OI V2 RUNTIME APPROVAL REQUEST/);
  assert.match(markdown, /explicitRuntimeApprovalPresent: false/);
  assert.match(markdown, /does not grant approval/);
  assert.match(markdown, /expand Daegyo\/mobile scope/);
});
