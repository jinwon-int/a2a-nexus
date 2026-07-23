import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildOIBrokerDispatchApprovalDecisionEvidencePacket,
  renderOIBrokerDispatchApprovalDecisionEvidenceMarkdown,
} from "./orchestration-intelligence-broker-dispatch-approval-decision-evidence.js";
import { buildOIBrokerDispatchApprovalRequestPacket } from "./orchestration-intelligence-broker-dispatch-approval-request.js";
import { buildOIRuntimeApprovalDecisionEvidencePacket } from "./orchestration-intelligence-runtime-approval-decision-evidence.js";
import { buildOIRuntimeApprovalRequestPacket } from "./orchestration-intelligence-runtime-approval-request.js";
import { buildOIRuntimeDesignReviewPacket } from "./orchestration-intelligence-runtime-design-review.js";
import { buildOIRuntimeReadinessGatePacket } from "./orchestration-intelligence-runtime-readiness-gate.js";
import { buildOIValidationFinalizerDecisionPacket } from "./orchestration-intelligence-validation-finalizer-decision.js";
import { buildOIValidationFinalizerReviewPacket } from "./orchestration-intelligence-validation-finalizer-review.js";
import { buildOIValidationOperatorDecisionEvidencePacket } from "./orchestration-intelligence-validation-operator-decision-evidence.js";
import { buildOIValidationOperatorReviewRequestPacket } from "./orchestration-intelligence-validation-operator-review-request.js";
import { buildOIValidationScorePacket } from "./orchestration-intelligence-validation-scorer.js";

const NOW = "2026-05-31T08:00:00.000Z";
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
  requiredApprovalPhrase: "APPROVE OI V2 RUNTIME APPROVAL REQUEST FOR SOURCE-ONLY EVIDENCE REVIEW",
  approverIdentityDocumented: true,
  requestScopeDocumented: true,
  approvalConditionsDocumented: true,
  riskSummaryDocumented: true,
  rollbackAbortCriteriaReferenced: true,
  liveBoundaryPlanReferenced: true,
  expiryOrRevocationDocumented: true,
};

const allDispatchEvidence = {
  dispatchScopeDocumented: true,
  targetRepoDocumented: true,
  targetIssueDocumented: true,
  workerTeamConstraintsDocumented: true,
  operatorIdentityRequirementDocumented: true,
  expiryRevocationDocumented: true,
  rollbackAbortRequirementsDocumented: true,
  requiredFutureDecisionEvidenceDocumented: true,
};

function finalizerDecision(decision = "advance_to_next_source_step") {
  const fixture = JSON.parse(
    readFileSync("fixtures/orchestration-intelligence/validation-finalizer-decision.ready.json", "utf8"),
  );
  const score = buildOIValidationScorePacket({ generatedAt: NOW, ...fixture.scoreInput });
  const finalizerReview = buildOIValidationFinalizerReviewPacket({
    generatedAt: NOW,
    score,
    reviewer: fixture.reviewer,
  });
  const reviewRequest = buildOIValidationOperatorReviewRequestPacket({
    generatedAt: NOW,
    finalizerReview,
    operator: fixture.operator,
  });
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

function runtimeApprovalDecisionEvidence(decision = "advance_to_next_source_step") {
  return buildOIRuntimeApprovalDecisionEvidencePacket({
    generatedAt: NOW,
    recorder: "brokerbeta",
    runtimeApprovalRequest: runtimeApprovalRequest(decision),
    decisionEvidence: {
      kind: "approval_grant",
      operator: "seo-jin-on",
      approvalPhrase: allApprovalEvidence.requiredApprovalPhrase,
      approvedAt: "2026-05-31T07:00:00.000Z",
      expiresAt: "2026-06-01T07:00:00.000Z",
      repo: REPO,
      issueNumber: ISSUE,
      scope: [
        "record explicit operator approval evidence in a future source-only packet",
        "keep runtime executor implementation and enablement in separate future work",
        "keep broker dispatch, worker spawn, and mobilebeta/mobile scope expansion as independent gates",
      ],
      conditions: [
        "operator identity must be recorded without secrets",
        "approval phrase must match the requested phrase exactly or be superseded by a stricter phrase",
        "approval must name the repository and issue context",
        "approval must not authorize deploy, restart, DB mutation, live provider send, Terminal ACK/replay, release publish, or credential movement",
        "approval may be revoked or expired before any later runtime enablement step",
      ],
      conditionsAccepted: true,
      revocationOrExpiry: "expires when source packet, scope, operator identity, or runtime readiness inputs change",
      rationale: "Fixture approval evidence for broker dispatch request tests.",
    },
  });
}

function brokerDispatchApprovalRequest(decision = "advance_to_next_source_step") {
  return buildOIBrokerDispatchApprovalRequestPacket({
    generatedAt: NOW,
    requester: "brokerbeta",
    operator: "seo-jin-on",
    runtimeApprovalDecisionEvidence: runtimeApprovalDecisionEvidence(decision),
    dispatchEvidence: allDispatchEvidence,
  });
}

function acceptedBrokerDispatchEvidence() {
  const req = brokerDispatchApprovalRequest();
  return {
    kind: "approval_grant" as const,
    operator: req.operator,
    approvalPhrase: req.dispatchApprovalRequest.requestedApprovalPhrase,
    approvedAt: "2026-05-31T07:55:00.000Z",
    expiresAt: "2026-06-01T07:55:00.000Z",
    targetRepo: REPO,
    targetIssueNumber: ISSUE,
    dispatchScope: [...req.dispatchApprovalRequest.requiredConditions],
    conditions: [...req.dispatchApprovalRequest.requiredConditions],
    conditionsAccepted: true,
    revocationOrExpiry: "expires when source packet, scope, operator identity, or broker dispatch readiness inputs change",
    rationale: "Source-only fixture broker dispatch approval evidence for tests.",
  };
}

test("accepts strict broker dispatch approval decision evidence but still does not enable runtime actions", () => {
  const packet = buildOIBrokerDispatchApprovalDecisionEvidencePacket({
    generatedAt: NOW,
    recorder: "brokerbeta",
    brokerDispatchApprovalRequest: brokerDispatchApprovalRequest(),
    decisionEvidence: acceptedBrokerDispatchEvidence(),
  });

  assert.equal(
    packet.kind,
    "a2a-broker.orchestration-intelligence.broker-dispatch-approval-decision-evidence.packet",
  );
  assert.equal(packet.state, "broker_dispatch_approval_evidence_accepted");
  assert.equal(packet.disposition, "record_explicit_broker_dispatch_approval_evidence");
  assert.equal(packet.acceptedDecisionEvidence?.operator, "seo-jin-on");
  assert.equal(packet.runtimeReadinessEvidencePatch.runtimeExecutorDesignReviewed, true);
  assert.equal(packet.runtimeReadinessEvidencePatch.explicitRuntimeApprovalPresent, true);
  assert.equal(packet.runtimeReadinessEvidencePatch.brokerDispatchApprovalPresent, true);
  assert.equal(packet.runtimeReadinessEvidencePatch.workerSpawnApprovalPresent, false);
  assert.equal(packet.runtimeReadinessEvidencePatch.mobilebetaMobileScopeResolved, false);
  assert.equal(packet.safety.brokerDispatchApprovalEvidenceAccepted, true);
  assert.equal(packet.safety.grantsExecutionApproval, false);
  assert.equal(packet.safety.runtimeExecutorEnabled, false);
  assert.equal(packet.safety.brokerDispatchCreated, false);
  assert.equal(packet.safety.workerSpawned, false);
  assert.equal(packet.safety.mobilebetaScopeExpanded, false);
});

test("waits when broker dispatch approval decision evidence is absent (missing)", () => {
  const packet = buildOIBrokerDispatchApprovalDecisionEvidencePacket({
    generatedAt: NOW,
    brokerDispatchApprovalRequest: brokerDispatchApprovalRequest(),
  });

  assert.equal(packet.state, "broker_dispatch_approval_evidence_missing");
  assert.equal(packet.disposition, "wait_for_operator_broker_dispatch_response");
  assert.equal(packet.runtimeReadinessEvidencePatch.brokerDispatchApprovalPresent, false);
  assert.equal(packet.runtimeReadinessEvidencePatch.explicitRuntimeApprovalPresent, false);
});

test("rejects mismatched approval phrase and dispatch scope as invalid", () => {
  const evidence = acceptedBrokerDispatchEvidence();
  const packet = buildOIBrokerDispatchApprovalDecisionEvidencePacket({
    generatedAt: NOW,
    brokerDispatchApprovalRequest: brokerDispatchApprovalRequest(),
    decisionEvidence: {
      ...evidence,
      approvalPhrase: "APPROVE BROKER DISPATCH",
      dispatchScope: [evidence.dispatchScope[0]],
    },
  });

  assert.equal(packet.state, "broker_dispatch_approval_evidence_invalid");
  assert.equal(packet.runtimeReadinessEvidencePatch.brokerDispatchApprovalPresent, false);
  assert.ok(packet.blockers.some((blocker) => blocker.includes("approval_phrase_matches_request")));
  assert.ok(packet.blockers.some((blocker) => blocker.includes("dispatch_scope_matches_request")));
});

test("rejects expired broker dispatch approval evidence", () => {
  const packet = buildOIBrokerDispatchApprovalDecisionEvidencePacket({
    generatedAt: NOW,
    brokerDispatchApprovalRequest: brokerDispatchApprovalRequest(),
    decisionEvidence: {
      ...acceptedBrokerDispatchEvidence(),
      expiresAt: "2026-05-31T06:00:00.000Z",
    },
  });

  assert.equal(packet.state, "broker_dispatch_approval_evidence_invalid");
  assert.equal(packet.runtimeReadinessEvidencePatch.brokerDispatchApprovalPresent, false);
  assert.ok(packet.blockers.some((blocker) => blocker.includes("approval_not_expired")));
});

test("mismatched target repo is fail-closed", () => {
  const packet = buildOIBrokerDispatchApprovalDecisionEvidencePacket({
    generatedAt: NOW,
    brokerDispatchApprovalRequest: brokerDispatchApprovalRequest(),
    expectedRepo: "other-org/other-repo",
    decisionEvidence: acceptedBrokerDispatchEvidence(),
  });

  assert.equal(packet.state, "broker_dispatch_approval_evidence_invalid");
  assert.equal(packet.runtimeReadinessEvidencePatch.brokerDispatchApprovalPresent, false);
  assert.ok(packet.blockers.some((blocker) => blocker.includes("target_repo_and_issue_match")));
});

test("records explicit rejection, expiry, and conflict states fail-closed", () => {
  const baseReq = brokerDispatchApprovalRequest();
  const baseEvidence = acceptedBrokerDispatchEvidence();

  const rejection = buildOIBrokerDispatchApprovalDecisionEvidencePacket({
    generatedAt: NOW,
    brokerDispatchApprovalRequest: baseReq,
    decisionEvidence: { ...baseEvidence, kind: "rejected" },
  });
  const expiry = buildOIBrokerDispatchApprovalDecisionEvidencePacket({
    generatedAt: NOW,
    brokerDispatchApprovalRequest: baseReq,
    decisionEvidence: { ...baseEvidence, kind: "expired" },
  });
  const conflict = buildOIBrokerDispatchApprovalDecisionEvidencePacket({
    generatedAt: NOW,
    brokerDispatchApprovalRequest: baseReq,
    decisionEvidence: { ...baseEvidence, kind: "conflict" },
  });

  assert.equal(rejection.state, "broker_dispatch_approval_evidence_rejected");
  assert.equal(expiry.state, "broker_dispatch_approval_evidence_expired");
  assert.equal(conflict.state, "broker_dispatch_approval_evidence_conflicting");
  assert.equal(rejection.runtimeReadinessEvidencePatch.brokerDispatchApprovalPresent, false);
  assert.equal(expiry.runtimeReadinessEvidencePatch.brokerDispatchApprovalPresent, false);
  assert.equal(conflict.runtimeReadinessEvidencePatch.brokerDispatchApprovalPresent, false);
});

test("waits when broker dispatch approval request is not ready", () => {
  const incompleteDispatchRequest = buildOIBrokerDispatchApprovalRequestPacket({
    generatedAt: NOW,
    runtimeApprovalDecisionEvidence: runtimeApprovalDecisionEvidence(),
    dispatchEvidence: {
      dispatchScopeDocumented: true,
    },
  });

  assert.equal(
    buildOIBrokerDispatchApprovalDecisionEvidencePacket({
      generatedAt: NOW,
      brokerDispatchApprovalRequest: incompleteDispatchRequest,
      decisionEvidence: acceptedBrokerDispatchEvidence(),
    }).state,
    "broker_dispatch_approval_request_not_ready",
  );
});

test("preserves boundary and candidate-revision states from upstream", () => {
  assert.equal(
    buildOIBrokerDispatchApprovalDecisionEvidencePacket({
      generatedAt: NOW,
      brokerDispatchApprovalRequest: brokerDispatchApprovalRequest("stop_for_approval_boundary_review"),
      decisionEvidence: acceptedBrokerDispatchEvidence(),
    }).state,
    "broker_dispatch_boundary_review_required",
  );
  assert.equal(
    buildOIBrokerDispatchApprovalDecisionEvidencePacket({
      generatedAt: NOW,
      brokerDispatchApprovalRequest: brokerDispatchApprovalRequest("revise_candidate"),
      decisionEvidence: acceptedBrokerDispatchEvidence(),
    }).state,
    "broker_dispatch_candidate_revision_required",
  );
});

test("renders accepted evidence and remaining NO-GO boundaries via markdown", () => {
  const fixture = JSON.parse(
    readFileSync(
      "fixtures/orchestration-intelligence/broker-dispatch-approval-decision-evidence.accepted.json",
      "utf8",
    ),
  );
  const packet = buildOIBrokerDispatchApprovalDecisionEvidencePacket({
    generatedAt: NOW,
    recorder: fixture.recorder,
    brokerDispatchApprovalRequest: brokerDispatchApprovalRequest(),
    decisionEvidence: fixture.decisionEvidence,
    notes: fixture.notes,
  });
  const markdown = renderOIBrokerDispatchApprovalDecisionEvidenceMarkdown(packet);

  assert.match(markdown, /broker dispatch approval decision evidence/);
  assert.match(markdown, /State: broker_dispatch_approval_evidence_accepted/);
  assert.match(markdown, /brokerDispatchApprovalPresent: true/);
  assert.match(markdown, /source readiness flag only/);
  assert.match(markdown, /does not grant execution approval/);
  assert.match(markdown, /spawn workers\/subagents/);
});
