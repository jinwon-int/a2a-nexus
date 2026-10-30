import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildOIBrokerDispatchApprovalRequestPacket,
  renderOIBrokerDispatchApprovalRequestMarkdown,
} from "./orchestration-intelligence-broker-dispatch-approval-request.js";
import { buildOIRuntimeApprovalDecisionEvidencePacket } from "./orchestration-intelligence-runtime-approval-decision-evidence.js";
import { buildOIRuntimeApprovalRequestPacket } from "./orchestration-intelligence-runtime-approval-request.js";
import { buildOIRuntimeDesignReviewPacket } from "./orchestration-intelligence-runtime-design-review.js";
import { buildOIRuntimeReadinessGatePacket } from "./orchestration-intelligence-runtime-readiness-gate.js";
import { buildOIValidationFinalizerDecisionPacket } from "./orchestration-intelligence-validation-finalizer-decision.js";
import { buildOIValidationFinalizerReviewPacket } from "./orchestration-intelligence-validation-finalizer-review.js";
import { buildOIValidationOperatorDecisionEvidencePacket } from "./orchestration-intelligence-validation-operator-decision-evidence.js";
import { buildOIValidationOperatorReviewRequestPacket } from "./orchestration-intelligence-validation-operator-review-request.js";
import { buildOIValidationScorePacket } from "./orchestration-intelligence-validation-scorer.js";

const NOW = "2026-06-01T08:00:00.000Z";
const PHRASE = "APPROVE OI V2 BROKER DISPATCH APPROVAL REQUEST FOR SOURCE-ONLY EVIDENCE REVIEW";
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

function runtimeDesignReview(decision = "advance_to_next_source_step") {
  return buildOIRuntimeDesignReviewPacket({
    generatedAt: NOW,
    reviewer: "brokerbeta",
    runtimeReadinessGate: runtimeReadinessGate(decision),
    designEvidence: allDesignEvidence,
  });
}

function runtimeApprovalRequest(decision = "advance_to_next_source_step") {
  return buildOIRuntimeApprovalRequestPacket({
    generatedAt: NOW,
    requester: "brokerbeta",
    operator: "seo-jin-on",
    runtimeDesignReview: runtimeDesignReview(decision),
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
      approvedAt: "2026-06-01T07:00:00.000Z",
      expiresAt: "2026-06-02T07:00:00.000Z",
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

test("builds a broker dispatch approval request without granting approval or dispatch", () => {
  const packet = buildOIBrokerDispatchApprovalRequestPacket({
    generatedAt: NOW,
    requester: "brokerbeta",
    operator: "seo-jin-on",
    runtimeApprovalDecisionEvidence: runtimeApprovalDecisionEvidence(),
    dispatchEvidence: allDispatchEvidence,
  });

  assert.equal(
    packet.kind,
    "a2a-broker.orchestration-intelligence.broker-dispatch-approval-request.packet",
  );
  assert.equal(packet.state, "dispatch_approval_request_ready");
  assert.equal(packet.disposition, "request_explicit_broker_dispatch_approval_evidence");
  assert.equal(packet.dispatchApprovalRequest.requestedApprovalPhrase, PHRASE);
  assert.equal(packet.dispatchApprovalRequest.targetRepo, REPO);
  assert.equal(packet.dispatchApprovalRequest.targetIssueNumber, ISSUE);
  assert.equal(packet.runtimeReadinessEvidencePatch.runtimeExecutorDesignReviewed, true);
  assert.equal(packet.runtimeReadinessEvidencePatch.explicitRuntimeApprovalPresent, true);
  assert.equal(packet.runtimeReadinessEvidencePatch.brokerDispatchApprovalPresent, false);
  assert.equal(packet.runtimeReadinessEvidencePatch.workerSpawnApprovalPresent, false);
  assert.equal(packet.runtimeReadinessEvidencePatch.mobilebetaMobileScopeResolved, false);
  assert.equal(packet.safety.brokerDispatchApprovalRequestOnly, true);
  assert.equal(packet.safety.brokerDispatchApprovalPresent, false);
  assert.equal(packet.safety.approvalGranted, false);
  assert.equal(packet.safety.brokerDispatchCreated, false);
  assert.equal(packet.safety.runtimeExecutorEnabled, false);
  assert.equal(packet.safety.workerSpawned, false);
  assert.equal(packet.safety.mobilebetaScopeExpanded, false);
});

test("fails closed when dispatch approval request evidence is incomplete", () => {
  const packet = buildOIBrokerDispatchApprovalRequestPacket({
    generatedAt: NOW,
    runtimeApprovalDecisionEvidence: runtimeApprovalDecisionEvidence(),
    dispatchEvidence: {
      dispatchScopeDocumented: true,
      targetRepoDocumented: true,
    },
  });

  assert.equal(packet.state, "dispatch_approval_request_incomplete");
  assert.equal(packet.runtimeReadinessEvidencePatch.brokerDispatchApprovalPresent, false);
  assert.ok(packet.blockers.some((blocker) => blocker.includes("worker_team_constraints_documented")));
  assert.ok(packet.blockers.some((blocker) => blocker.includes("expiry_revocation_documented")));
  assert.ok(packet.blockers.some((blocker) => blocker.includes("rollback_abort_requirements_documented")));
});

test("waits when runtime approval decision is not ready", () => {
  const incompleteDecision = buildOIRuntimeApprovalDecisionEvidencePacket({
    generatedAt: NOW,
    runtimeApprovalRequest: runtimeApprovalRequest(),
  });
  const packet = buildOIBrokerDispatchApprovalRequestPacket({
    generatedAt: NOW,
    runtimeApprovalDecisionEvidence: incompleteDecision,
    dispatchEvidence: allDispatchEvidence,
  });

  assert.equal(packet.state, "runtime_approval_decision_not_ready");
  assert.equal(packet.disposition, "wait_for_runtime_approval_decision");
  assert.equal(packet.runtimeReadinessEvidencePatch.brokerDispatchApprovalPresent, false);
  assert.equal(packet.runtimeReadinessEvidencePatch.explicitRuntimeApprovalPresent, false);
});

test("preserves approval-boundary and candidate-revision states from upstream", () => {
  assert.equal(
    buildOIBrokerDispatchApprovalRequestPacket({
      generatedAt: NOW,
      runtimeApprovalDecisionEvidence: runtimeApprovalDecisionEvidence("stop_for_approval_boundary_review"),
      dispatchEvidence: allDispatchEvidence,
    }).state,
    "approval_boundary_review_required",
  );
  assert.equal(
    buildOIBrokerDispatchApprovalRequestPacket({
      generatedAt: NOW,
      runtimeApprovalDecisionEvidence: runtimeApprovalDecisionEvidence("revise_candidate"),
      dispatchEvidence: allDispatchEvidence,
    }).state,
    "candidate_revision_required",
  );
});

test("renders dispatch scope, worker constraints, and remaining NO-GO boundaries", () => {
  const fixture = JSON.parse(
    readFileSync("fixtures/orchestration-intelligence/broker-dispatch-approval-request.ready.json", "utf8"),
  );
  const packet = buildOIBrokerDispatchApprovalRequestPacket({
    generatedAt: NOW,
    requester: fixture.requester,
    operator: fixture.operator,
    runtimeApprovalDecisionEvidence: runtimeApprovalDecisionEvidence(),
    dispatchEvidence: fixture.dispatchEvidence,
    notes: fixture.notes,
  });
  const markdown = renderOIBrokerDispatchApprovalRequestMarkdown(packet);

  assert.match(markdown, /broker dispatch approval request/);
  assert.match(markdown, /State: dispatch_approval_request_ready/);
  assert.match(markdown, /APPROVE OI V2 BROKER DISPATCH APPROVAL REQUEST/);
  assert.match(markdown, /jinwon-int\/a2a-broker/);
  assert.match(markdown, /brokerDispatchApprovalPresent: false/);
  assert.match(markdown, /not approval and not execution permission/);
  assert.match(markdown, /worker\/team constraints/);
  assert.match(markdown, /rollback\/abort requirements/);
});
