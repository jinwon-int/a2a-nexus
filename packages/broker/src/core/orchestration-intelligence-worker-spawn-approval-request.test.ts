import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildOIWorkerSpawnApprovalRequestPacket,
  renderOIWorkerSpawnApprovalRequestMarkdown,
} from "./orchestration-intelligence-worker-spawn-approval-request.js";
import { buildOIBrokerDispatchApprovalDecisionEvidencePacket } from "./orchestration-intelligence-broker-dispatch-approval-decision-evidence.js";
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

const NOW = "2026-06-01T12:00:00.000Z";
const PHRASE = "APPROVE OI V2 WORKER SPAWN APPROVAL REQUEST FOR SOURCE-ONLY EVIDENCE REVIEW";
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

const allSpawnEvidence = {
  spawnScopeDocumented: true,
  targetRepoDocumented: true,
  targetIssueDocumented: true,
  workerTeamConstraintsDocumented: true,
  allowedWorkerClassesDocumented: true,
  noLiveExclusionsDocumented: true,
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
    approvedAt: "2026-06-01T07:55:00.000Z",
    expiresAt: "2026-06-02T07:55:00.000Z",
    targetRepo: REPO,
    targetIssueNumber: ISSUE,
    dispatchScope: [...req.dispatchApprovalRequest.requiredConditions],
    conditions: [...req.dispatchApprovalRequest.requiredConditions],
    conditionsAccepted: true,
    revocationOrExpiry: "expires when source packet, scope, operator identity, or broker dispatch readiness inputs change",
    rationale: "Source-only fixture broker dispatch approval evidence for tests.",
  };
}

function brokerDispatchApprovalDecisionEvidence(decision = "advance_to_next_source_step") {
  return buildOIBrokerDispatchApprovalDecisionEvidencePacket({
    generatedAt: NOW,
    recorder: "brokerbeta",
    brokerDispatchApprovalRequest: brokerDispatchApprovalRequest(decision),
    decisionEvidence: decision === "advance_to_next_source_step"
      ? acceptedBrokerDispatchEvidence()
      : undefined,
  });
}

// === TESTS ===

test("builds a worker spawn approval request without granting approval or spawn", () => {
  const packet = buildOIWorkerSpawnApprovalRequestPacket({
    generatedAt: NOW,
    requester: "brokerbeta",
    operator: "seo-jin-on",
    brokerDispatchApprovalDecisionEvidence: brokerDispatchApprovalDecisionEvidence(),
    spawnEvidence: allSpawnEvidence,
  });

  assert.equal(
    packet.kind,
    "a2a-broker.orchestration-intelligence.worker-spawn-approval-request.packet",
  );
  assert.equal(packet.state, "worker_spawn_approval_request_ready");
  assert.equal(packet.disposition, "request_explicit_worker_spawn_approval_evidence");
  assert.equal(packet.spawnApprovalRequest.requestedApprovalPhrase, PHRASE);
  assert.equal(packet.spawnApprovalRequest.targetRepo, REPO);
  assert.equal(packet.spawnApprovalRequest.targetIssueNumber, ISSUE);
  assert.equal(packet.runtimeReadinessEvidencePatch.runtimeExecutorDesignReviewed, true);
  assert.equal(packet.runtimeReadinessEvidencePatch.explicitRuntimeApprovalPresent, true);
  assert.equal(packet.runtimeReadinessEvidencePatch.brokerDispatchApprovalPresent, true);
  assert.equal(packet.runtimeReadinessEvidencePatch.workerSpawnApprovalPresent, false);
  assert.equal(packet.runtimeReadinessEvidencePatch.mobilebetaMobileScopeResolved, false);
  assert.equal(packet.safety.workerSpawnApprovalRequestOnly, true);
  assert.equal(packet.safety.workerSpawnApprovalPresent, false);
  assert.equal(packet.safety.brokerDispatchApprovalPresent, true);
  assert.equal(packet.safety.approvalGranted, false);
  assert.equal(packet.safety.workerSpawned, false);
  assert.equal(packet.safety.brokerDispatchCreated, false);
  assert.equal(packet.safety.runtimeExecutorEnabled, false);
  assert.equal(packet.safety.mobilebetaScopeExpanded, false);
});

test("fails closed when spawn approval request evidence is incomplete", () => {
  const packet = buildOIWorkerSpawnApprovalRequestPacket({
    generatedAt: NOW,
    brokerDispatchApprovalDecisionEvidence: brokerDispatchApprovalDecisionEvidence(),
    spawnEvidence: {
      spawnScopeDocumented: true,
      targetRepoDocumented: true,
      targetIssueDocumented: true,
    },
  });

  assert.equal(packet.state, "worker_spawn_approval_request_incomplete");
  assert.equal(packet.runtimeReadinessEvidencePatch.workerSpawnApprovalPresent, false);
  assert.ok(packet.blockers.some((blocker) => blocker.includes("worker_team_constraints_documented")));
  assert.ok(packet.blockers.some((blocker) => blocker.includes("allowed_worker_classes_documented")));
  assert.ok(packet.blockers.some((blocker) => blocker.includes("no_live_exclusions_documented")));
  assert.ok(packet.blockers.some((blocker) => blocker.includes("expiry_revocation_documented")));
  assert.ok(packet.blockers.some((blocker) => blocker.includes("rollback_abort_requirements_documented")));
  assert.ok(packet.blockers.some((blocker) => blocker.includes("required_future_decision_evidence_documented")));
});

test("waits when broker dispatch approval decision evidence is not ready", () => {
  const incompleteDecision = buildOIBrokerDispatchApprovalDecisionEvidencePacket({
    generatedAt: NOW,
    brokerDispatchApprovalRequest: brokerDispatchApprovalRequest(),
    decisionEvidence: undefined,
  });
  const packet = buildOIWorkerSpawnApprovalRequestPacket({
    generatedAt: NOW,
    brokerDispatchApprovalDecisionEvidence: incompleteDecision,
    spawnEvidence: allSpawnEvidence,
  });

  assert.equal(packet.state, "broker_dispatch_evidence_not_ready");
  assert.equal(packet.disposition, "wait_for_broker_dispatch_evidence");
  assert.equal(packet.runtimeReadinessEvidencePatch.workerSpawnApprovalPresent, false);
  assert.equal(packet.runtimeReadinessEvidencePatch.brokerDispatchApprovalPresent, false);
});

test("preserves approval-boundary and candidate-revision states from upstream", () => {
  // Boundary review from broker-dispatch evidence
  const boundaryPacket = buildOIBrokerDispatchApprovalDecisionEvidencePacket({
    generatedAt: NOW,
    brokerDispatchApprovalRequest: brokerDispatchApprovalRequest("stop_for_approval_boundary_review"),
  });
  assert.equal(
    buildOIWorkerSpawnApprovalRequestPacket({
      generatedAt: NOW,
      brokerDispatchApprovalDecisionEvidence: boundaryPacket,
      spawnEvidence: allSpawnEvidence,
    }).state,
    "approval_boundary_review_required",
  );
  // Candidate revision from broker-dispatch evidence
  const candidatePacket = buildOIBrokerDispatchApprovalDecisionEvidencePacket({
    generatedAt: NOW,
    brokerDispatchApprovalRequest: brokerDispatchApprovalRequest("revise_candidate"),
  });
  assert.equal(
    buildOIWorkerSpawnApprovalRequestPacket({
      generatedAt: NOW,
      brokerDispatchApprovalDecisionEvidence: candidatePacket,
      spawnEvidence: allSpawnEvidence,
    }).state,
    "candidate_revision_required",
  );
});

test("detects forbidden safety invariant violations from upstream", () => {
  // Simulate a packet where state says accepted but safety flag is false
  const req = brokerDispatchApprovalRequest();
  const evidence = acceptedBrokerDispatchEvidence();
  const upstream = buildOIBrokerDispatchApprovalDecisionEvidencePacket({
    generatedAt: NOW,
    brokerDispatchApprovalRequest: req,
    decisionEvidence: evidence,
  });

  // The builder guarantees consistency. Simulate a violation by creating
  // a packet where state is "accepted" but the safety boolean is false.
  const violatingPacket = {
    ...upstream,
    state: "broker_dispatch_approval_evidence_accepted" as const,
    safety: {
      ...upstream.safety,
      brokerDispatchApprovalEvidenceAccepted: false,
    },
  };

  const packet = buildOIWorkerSpawnApprovalRequestPacket({
    generatedAt: NOW,
    brokerDispatchApprovalDecisionEvidence: violatingPacket as typeof upstream,
    spawnEvidence: allSpawnEvidence,
  });

  assert.equal(packet.state, "forbidden_safety_invariant_violated");
  assert.equal(packet.disposition, "blocked_forbidden_safety_invariant");
  assert.equal(packet.runtimeReadinessEvidencePatch.workerSpawnApprovalPresent, false);
});

test("detects upstream broker-dispatch evidence not accepted (rejected state)", () => {
  const req = brokerDispatchApprovalRequest();
  const evidence = acceptedBrokerDispatchEvidence();
  const rejectedUpstream = buildOIBrokerDispatchApprovalDecisionEvidencePacket({
    generatedAt: NOW,
    brokerDispatchApprovalRequest: req,
    decisionEvidence: { ...evidence, kind: "rejected" },
  });
  const packet = buildOIWorkerSpawnApprovalRequestPacket({
    generatedAt: NOW,
    brokerDispatchApprovalDecisionEvidence: rejectedUpstream,
    spawnEvidence: allSpawnEvidence,
  });

  assert.equal(packet.state, "broker_dispatch_evidence_not_ready");
  assert.equal(packet.runtimeReadinessEvidencePatch.workerSpawnApprovalPresent, false);
  assert.ok(packet.blockers.some((blocker) => blocker.includes("broker_dispatch_evidence_ready")));
});

test("renders spawn scope, worker constraints, allowed classes, no-live exclusions, and remaining NO-GO boundaries", () => {
  const fixture = JSON.parse(
    readFileSync("fixtures/orchestration-intelligence/worker-spawn-approval-request.ready.json", "utf8"),
  );
  const packet = buildOIWorkerSpawnApprovalRequestPacket({
    generatedAt: NOW,
    requester: fixture.requester,
    operator: fixture.operator,
    brokerDispatchApprovalDecisionEvidence: brokerDispatchApprovalDecisionEvidence(),
    spawnEvidence: fixture.spawnEvidence,
    notes: fixture.notes,
  });
  const markdown = renderOIWorkerSpawnApprovalRequestMarkdown(packet);

  assert.match(markdown, /worker\/subagent spawn approval request/);
  assert.match(markdown, /State: worker_spawn_approval_request_ready/);
  assert.match(markdown, /APPROVE OI V2 WORKER SPAWN APPROVAL REQUEST/);
  assert.match(markdown, /jinwon-int\/a2a-broker/);
  assert.match(markdown, /workerSpawnApprovalPresent: false/);
  assert.match(markdown, /not approval and not execution permission/);
  assert.match(markdown, /worker\/team constraints/);
  assert.match(markdown, /allowed worker classes/);
  assert.match(markdown, /no-live\/live exclusions/);
  assert.match(markdown, /rollback\/abort requirements/);
});
