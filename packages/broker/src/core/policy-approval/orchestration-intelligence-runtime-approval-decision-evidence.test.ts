import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildOIRuntimeApprovalDecisionEvidencePacket,
  renderOIRuntimeApprovalDecisionEvidenceMarkdown,
} from "./orchestration-intelligence-runtime-approval-decision-evidence.js";
import { buildOIRuntimeApprovalRequestPacket } from "./orchestration-intelligence-runtime-approval-request.js";
import { buildOIRuntimeDesignReviewPacket } from "./orchestration-intelligence-runtime-design-review.js";
import { buildOIRuntimeReadinessGatePacket } from "./orchestration-intelligence-runtime-readiness-gate.js";
import { buildOIValidationFinalizerDecisionPacket } from "./orchestration-intelligence-validation-finalizer-decision.js";
import { buildOIValidationFinalizerReviewPacket } from "./orchestration-intelligence-validation-finalizer-review.js";
import { buildOIValidationOperatorDecisionEvidencePacket } from "./orchestration-intelligence-validation-operator-decision-evidence.js";
import { buildOIValidationOperatorReviewRequestPacket } from "./orchestration-intelligence-validation-operator-review-request.js";
import { buildOIValidationScorePacket } from "./orchestration-intelligence-validation-scorer.js";

const NOW = "2026-05-30T09:55:00.000Z";
const PHRASE = "APPROVE OI V2 RUNTIME APPROVAL REQUEST FOR SOURCE-ONLY EVIDENCE REVIEW";
const REPO = "jinwon-int/a2a-broker";
const ISSUE = 968;

const allDesignEvidence = {
  executorContractDocumented: true,
  brokerDispatchBoundaryDocumented: true,
  workerSpawnBoundaryDocumented: true,
  mobilebetaMobileBoundaryDocumented: true,
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
    reviewer: "brokerbeta",
    finalizerDecision: finalizerDecision(decision),
    runtimeEvidence: {
      runtimeExecutorDesignReviewed: false,
      explicitRuntimeApprovalPresent: false,
      brokerDispatchApprovalPresent: false,
      workerSpawnApprovalPresent: false,
      mobilebetaMobileScopeResolved: false,
      rollbackAbortCriteriaDocumented: false,
      liveBoundaryPlanDocumented: false,
      validationEvidenceFresh: true,
    },
  });
}

function runtimeApprovalRequest(decision = "advance_to_next_source_step") {
  const designReview = buildOIRuntimeDesignReviewPacket({
    generatedAt: NOW,
    reviewer: "brokerbeta",
    runtimeReadinessGate: runtimeReadinessGate(decision),
    designEvidence: allDesignEvidence,
  });
  return buildOIRuntimeApprovalRequestPacket({
    generatedAt: NOW,
    requester: "brokerbeta",
    operator: "seo-jin-on",
    runtimeDesignReview: designReview,
    approvalEvidence: allApprovalEvidence,
  });
}

function acceptedEvidence() {
  const req = runtimeApprovalRequest();
  return {
    kind: "approval_grant" as const,
    operator: req.operator,
    approvalPhrase: req.approvalRequest.requestedApprovalPhrase,
    approvedAt: "2026-05-30T09:54:00.000Z",
    expiresAt: "2026-05-31T09:54:00.000Z",
    repo: REPO,
    issueNumber: ISSUE,
    scope: [...req.approvalRequest.scope],
    conditions: [...req.approvalRequest.requiredConditions],
    conditionsAccepted: true,
    revocationOrExpiry: "expires when source packet, scope, operator identity, or runtime readiness inputs change",
    rationale: "Source-only fixture approval evidence for tests.",
  };
}

test("accepts strict runtime approval decision evidence but still does not enable runtime actions", () => {
  const packet = buildOIRuntimeApprovalDecisionEvidencePacket({
    generatedAt: NOW,
    recorder: "brokerbeta",
    runtimeApprovalRequest: runtimeApprovalRequest(),
    decisionEvidence: acceptedEvidence(),
  });

  assert.equal(packet.kind, "a2a-broker.orchestration-intelligence.runtime-approval-decision-evidence.packet");
  assert.equal(packet.state, "approval_evidence_accepted");
  assert.equal(packet.disposition, "record_explicit_runtime_approval_evidence");
  assert.equal(packet.acceptedDecisionEvidence?.operator, "seo-jin-on");
  assert.equal(packet.runtimeReadinessEvidencePatch.runtimeExecutorDesignReviewed, true);
  assert.equal(packet.runtimeReadinessEvidencePatch.explicitRuntimeApprovalPresent, true);
  assert.equal(packet.runtimeReadinessEvidencePatch.brokerDispatchApprovalPresent, false);
  assert.equal(packet.runtimeReadinessEvidencePatch.workerSpawnApprovalPresent, false);
  assert.equal(packet.runtimeReadinessEvidencePatch.mobilebetaMobileScopeResolved, false);
  assert.equal(packet.safety.approvalEvidenceAccepted, true);
  assert.equal(packet.safety.grantsExecutionApproval, false);
  assert.equal(packet.safety.runtimeExecutorEnabled, false);
  assert.equal(packet.safety.brokerDispatchCreated, false);
  assert.equal(packet.safety.workerSpawned, false);
  assert.equal(packet.safety.mobilebetaScopeExpanded, false);
});

test("waits when operator response evidence is absent", () => {
  const packet = buildOIRuntimeApprovalDecisionEvidencePacket({
    generatedAt: NOW,
    runtimeApprovalRequest: runtimeApprovalRequest(),
  });

  assert.equal(packet.state, "approval_evidence_missing");
  assert.equal(packet.disposition, "wait_for_operator_response");
  assert.equal(packet.runtimeReadinessEvidencePatch.explicitRuntimeApprovalPresent, false);
});

test("rejects mismatched approval phrase and scope", () => {
  const evidence = acceptedEvidence();
  const packet = buildOIRuntimeApprovalDecisionEvidencePacket({
    generatedAt: NOW,
    runtimeApprovalRequest: runtimeApprovalRequest(),
    decisionEvidence: {
      ...evidence,
      approvalPhrase: "APPROVE RUNTIME",
      scope: [evidence.scope[0]],
    },
  });

  assert.equal(packet.state, "approval_evidence_invalid");
  assert.equal(packet.runtimeReadinessEvidencePatch.explicitRuntimeApprovalPresent, false);
  assert.ok(packet.blockers.some((blocker) => blocker.includes("approval_phrase_matches_request")));
  assert.ok(packet.blockers.some((blocker) => blocker.includes("scope_matches_request")));
});

test("rejects expired approval evidence", () => {
  const packet = buildOIRuntimeApprovalDecisionEvidencePacket({
    generatedAt: NOW,
    runtimeApprovalRequest: runtimeApprovalRequest(),
    decisionEvidence: {
      ...acceptedEvidence(),
      expiresAt: "2026-05-30T09:00:00.000Z",
    },
  });

  assert.equal(packet.state, "approval_evidence_invalid");
  assert.equal(packet.runtimeReadinessEvidencePatch.explicitRuntimeApprovalPresent, false);
  assert.ok(packet.blockers.some((blocker) => blocker.includes("approval_not_expired")));
});

test("records explicit rejection, expiry, and conflict states fail-closed", () => {
  const rejection = buildOIRuntimeApprovalDecisionEvidencePacket({
    generatedAt: NOW,
    runtimeApprovalRequest: runtimeApprovalRequest(),
    decisionEvidence: { ...acceptedEvidence(), kind: "rejected" },
  });
  const expiry = buildOIRuntimeApprovalDecisionEvidencePacket({
    generatedAt: NOW,
    runtimeApprovalRequest: runtimeApprovalRequest(),
    decisionEvidence: { ...acceptedEvidence(), kind: "expired" },
  });
  const conflict = buildOIRuntimeApprovalDecisionEvidencePacket({
    generatedAt: NOW,
    runtimeApprovalRequest: runtimeApprovalRequest(),
    decisionEvidence: { ...acceptedEvidence(), kind: "conflict" },
  });

  assert.equal(rejection.state, "approval_evidence_rejected");
  assert.equal(expiry.state, "approval_evidence_expired");
  assert.equal(conflict.state, "approval_evidence_conflicting");
  assert.equal(rejection.runtimeReadinessEvidencePatch.explicitRuntimeApprovalPresent, false);
  assert.equal(expiry.runtimeReadinessEvidencePatch.explicitRuntimeApprovalPresent, false);
  assert.equal(conflict.runtimeReadinessEvidencePatch.explicitRuntimeApprovalPresent, false);
});

test("waits when approval request is not ready and preserves upstream boundary states", () => {
  const incompleteRequest = buildOIRuntimeApprovalRequestPacket({
    generatedAt: NOW,
    runtimeDesignReview: buildOIRuntimeDesignReviewPacket({
      generatedAt: NOW,
      runtimeReadinessGate: runtimeReadinessGate(),
      designEvidence: {
        executorContractDocumented: true,
      },
    }),
    approvalEvidence: allApprovalEvidence,
  });

  assert.equal(
    buildOIRuntimeApprovalDecisionEvidencePacket({
      generatedAt: NOW,
      runtimeApprovalRequest: incompleteRequest,
      decisionEvidence: acceptedEvidence(),
    }).state,
    "approval_request_not_ready",
  );
  assert.equal(
    buildOIRuntimeApprovalDecisionEvidencePacket({
      generatedAt: NOW,
      runtimeApprovalRequest: runtimeApprovalRequest("stop_for_approval_boundary_review"),
      decisionEvidence: acceptedEvidence(),
    }).state,
    "approval_boundary_review_required",
  );
  assert.equal(
    buildOIRuntimeApprovalDecisionEvidencePacket({
      generatedAt: NOW,
      runtimeApprovalRequest: runtimeApprovalRequest("revise_candidate"),
      decisionEvidence: acceptedEvidence(),
    }).state,
    "candidate_revision_required",
  );
});

test("renders accepted evidence and remaining NO-GO boundaries", () => {
  const fixture = JSON.parse(readFileSync("fixtures/orchestration-intelligence/runtime-approval-decision-evidence.accepted.json", "utf8"));
  const packet = buildOIRuntimeApprovalDecisionEvidencePacket({
    generatedAt: NOW,
    recorder: fixture.recorder,
    runtimeApprovalRequest: runtimeApprovalRequest(),
    decisionEvidence: fixture.decisionEvidence,
    notes: fixture.notes,
  });
  const markdown = renderOIRuntimeApprovalDecisionEvidenceMarkdown(packet);

  assert.match(markdown, /runtime approval decision evidence/);
  assert.match(markdown, /State: approval_evidence_accepted/);
  assert.match(markdown, /explicitRuntimeApprovalPresent: true/);
  assert.match(markdown, /brokerDispatchApprovalPresent: false/);
  assert.match(markdown, /does not grant execution approval/);
  assert.match(markdown, /expand mobilebeta\/mobile scope/);
});
