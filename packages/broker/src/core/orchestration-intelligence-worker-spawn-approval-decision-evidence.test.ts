import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildOIWorkerSpawnApprovalDecisionEvidencePacket,
  renderOIWorkerSpawnApprovalDecisionEvidenceMarkdown,
} from "./orchestration-intelligence-worker-spawn-approval-decision-evidence.js";
import { buildOIWorkerSpawnApprovalRequestPacket } from "./orchestration-intelligence-worker-spawn-approval-request.js";
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

const NOW = "2026-05-31T08:30:00.000Z";
const PHRASE = "APPROVE OI V2 WORKER SPAWN APPROVAL REQUEST FOR SOURCE-ONLY EVIDENCE REVIEW";
const REPO = "jinwon-int/a2a-broker";
const ISSUE = 968;

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

function runtimeApprovalRequest(decision = "advance_to_next_source_step") {
  return buildOIRuntimeApprovalRequestPacket({
    generatedAt: NOW,
    requester: "gwakga",
    operator: "seo-jin-on",
    runtimeDesignReview: runtimeDesignReview(decision),
    approvalEvidence: allApprovalEvidence,
  });
}

function runtimeApprovalDecisionEvidence(decision = "advance_to_next_source_step") {
  return buildOIRuntimeApprovalDecisionEvidencePacket({
    generatedAt: NOW,
    recorder: "gwakga",
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
        "keep broker dispatch, worker spawn, and Daegyo/mobile scope expansion as independent gates",
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
    requester: "gwakga",
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

function brokerDispatchApprovalDecisionEvidence(decision = "advance_to_next_source_step") {
  return buildOIBrokerDispatchApprovalDecisionEvidencePacket({
    generatedAt: NOW,
    recorder: "gwakga",
    brokerDispatchApprovalRequest: brokerDispatchApprovalRequest(decision),
    decisionEvidence: decision === "advance_to_next_source_step"
      ? acceptedBrokerDispatchEvidence()
      : undefined,
  });
}

function workerSpawnApprovalRequest(decision = "advance_to_next_source_step") {
  return buildOIWorkerSpawnApprovalRequestPacket({
    generatedAt: NOW,
    requester: "gwakga",
    operator: "seo-jin-on",
    brokerDispatchApprovalDecisionEvidence: brokerDispatchApprovalDecisionEvidence(decision),
    spawnEvidence: allSpawnEvidence,
  });
}

function acceptedWorkerSpawnEvidence() {
  const req = workerSpawnApprovalRequest();
  return {
    kind: "approval_grant" as const,
    operator: req.operator,
    approvalPhrase: req.spawnApprovalRequest.requestedApprovalPhrase,
    approvedAt: "2026-05-31T08:20:00.000Z",
    expiresAt: "2026-06-01T08:20:00.000Z",
    targetRepo: REPO,
    targetIssueNumber: ISSUE,
    spawnScope: [...req.spawnApprovalRequest.requiredConditions],
    allowedWorkerClasses: [...req.spawnApprovalRequest.allowedWorkerClasses],
    noLiveExclusions: [...req.spawnApprovalRequest.noLiveExclusions],
    conditions: [...req.spawnApprovalRequest.requiredConditions],
    conditionsAccepted: true,
    revocationOrExpiry: "expires when source packet, scope, operator identity, or broker dispatch readiness inputs change; or when upstream broker dispatch approval evidence is revoked or expired",
    rationale: "Source-only fixture worker spawn approval evidence for tests.",
  };
}

// === TESTS ===

test("accepts strict worker spawn approval decision evidence but still does not enable runtime actions", () => {
  const packet = buildOIWorkerSpawnApprovalDecisionEvidencePacket({
    generatedAt: NOW,
    recorder: "gwakga",
    workerSpawnApprovalRequest: workerSpawnApprovalRequest(),
    decisionEvidence: acceptedWorkerSpawnEvidence(),
  });

  assert.equal(
    packet.kind,
    "a2a-broker.orchestration-intelligence.worker-spawn-approval-decision-evidence.packet",
  );
  assert.equal(packet.state, "worker_spawn_approval_evidence_accepted");
  assert.equal(packet.disposition, "record_explicit_worker_spawn_approval_evidence");
  assert.equal(packet.acceptedDecisionEvidence?.operator, "seo-jin-on");
  assert.equal(packet.acceptedDecisionEvidence?.approvalPhrase, PHRASE);
  assert.equal(packet.runtimeReadinessEvidencePatch.runtimeExecutorDesignReviewed, true);
  assert.equal(packet.runtimeReadinessEvidencePatch.explicitRuntimeApprovalPresent, true);
  assert.equal(packet.runtimeReadinessEvidencePatch.brokerDispatchApprovalPresent, true);
  assert.equal(packet.runtimeReadinessEvidencePatch.workerSpawnApprovalPresent, true);
  assert.equal(packet.runtimeReadinessEvidencePatch.daegyoMobileScopeResolved, false);
  assert.equal(packet.safety.workerSpawnApprovalEvidenceAccepted, true);
  assert.equal(packet.safety.grantsExecutionApproval, false);
  assert.equal(packet.safety.runtimeExecutorEnabled, false);
  assert.equal(packet.safety.brokerDispatchCreated, false);
  assert.equal(packet.safety.workerSpawned, false);
  assert.equal(packet.safety.daegyoScopeExpanded, false);
});

test("waits when worker spawn approval decision evidence is absent (missing)", () => {
  const packet = buildOIWorkerSpawnApprovalDecisionEvidencePacket({
    generatedAt: NOW,
    workerSpawnApprovalRequest: workerSpawnApprovalRequest(),
  });

  assert.equal(packet.state, "worker_spawn_approval_evidence_missing");
  assert.equal(packet.disposition, "wait_for_operator_worker_spawn_response");
  assert.equal(packet.runtimeReadinessEvidencePatch.workerSpawnApprovalPresent, false);
  assert.equal(packet.runtimeReadinessEvidencePatch.brokerDispatchApprovalPresent, false);
  assert.equal(packet.runtimeReadinessEvidencePatch.explicitRuntimeApprovalPresent, false);
});

test("rejects mismatched approval phrase and spawn scope as invalid", () => {
  const evidence = acceptedWorkerSpawnEvidence();
  const packet = buildOIWorkerSpawnApprovalDecisionEvidencePacket({
    generatedAt: NOW,
    workerSpawnApprovalRequest: workerSpawnApprovalRequest(),
    decisionEvidence: {
      ...evidence,
      approvalPhrase: "APPROVE WORKER SPAWN",
      spawnScope: [evidence.spawnScope[0]],
    },
  });

  assert.equal(packet.state, "worker_spawn_approval_evidence_invalid");
  assert.equal(packet.runtimeReadinessEvidencePatch.workerSpawnApprovalPresent, false);
  assert.ok(packet.blockers.some((blocker) => blocker.includes("approval_phrase_matches_request")));
  assert.ok(packet.blockers.some((blocker) => blocker.includes("spawn_scope_matches_request")));
});

test("rejects expired worker spawn approval evidence", () => {
  const packet = buildOIWorkerSpawnApprovalDecisionEvidencePacket({
    generatedAt: NOW,
    workerSpawnApprovalRequest: workerSpawnApprovalRequest(),
    decisionEvidence: {
      ...acceptedWorkerSpawnEvidence(),
      expiresAt: "2026-05-31T06:00:00.000Z",
    },
  });

  assert.equal(packet.state, "worker_spawn_approval_evidence_invalid");
  assert.equal(packet.runtimeReadinessEvidencePatch.workerSpawnApprovalPresent, false);
  assert.ok(packet.blockers.some((blocker) => blocker.includes("approval_not_expired")));
});

test("mismatched target repo is fail-closed", () => {
  const packet = buildOIWorkerSpawnApprovalDecisionEvidencePacket({
    generatedAt: NOW,
    workerSpawnApprovalRequest: workerSpawnApprovalRequest(),
    expectedRepo: "other-org/other-repo",
    decisionEvidence: acceptedWorkerSpawnEvidence(),
  });

  assert.equal(packet.state, "worker_spawn_approval_evidence_invalid");
  assert.equal(packet.runtimeReadinessEvidencePatch.workerSpawnApprovalPresent, false);
  assert.ok(packet.blockers.some((blocker) => blocker.includes("target_repo_and_issue_match")));
});

test("rejects mismatched allowed worker classes as invalid", () => {
  const evidence = acceptedWorkerSpawnEvidence();
  const packet = buildOIWorkerSpawnApprovalDecisionEvidencePacket({
    generatedAt: NOW,
    workerSpawnApprovalRequest: workerSpawnApprovalRequest(),
    decisionEvidence: {
      ...evidence,
      allowedWorkerClasses: ["source-only evidence collector (read-only, no mutation)"],
    },
  });

  assert.equal(packet.state, "worker_spawn_approval_evidence_invalid");
  assert.equal(packet.runtimeReadinessEvidencePatch.workerSpawnApprovalPresent, false);
  assert.ok(packet.blockers.some((blocker) => blocker.includes("allowed_worker_classes_match_request")));
});

test("rejects mismatched no-live exclusions as invalid", () => {
  const evidence = acceptedWorkerSpawnEvidence();
  const packet = buildOIWorkerSpawnApprovalDecisionEvidencePacket({
    generatedAt: NOW,
    workerSpawnApprovalRequest: workerSpawnApprovalRequest(),
    decisionEvidence: {
      ...evidence,
      noLiveExclusions: ["no live provider or Telegram canary send"],
    },
  });

  assert.equal(packet.state, "worker_spawn_approval_evidence_invalid");
  assert.equal(packet.runtimeReadinessEvidencePatch.workerSpawnApprovalPresent, false);
  assert.ok(packet.blockers.some((blocker) => blocker.includes("no_live_exclusions_match_request")));
});

test("records explicit rejection, expiry, and conflict states fail-closed", () => {
  const baseReq = workerSpawnApprovalRequest();
  const baseEvidence = acceptedWorkerSpawnEvidence();

  const rejection = buildOIWorkerSpawnApprovalDecisionEvidencePacket({
    generatedAt: NOW,
    workerSpawnApprovalRequest: baseReq,
    decisionEvidence: { ...baseEvidence, kind: "rejected" },
  });
  const expiry = buildOIWorkerSpawnApprovalDecisionEvidencePacket({
    generatedAt: NOW,
    workerSpawnApprovalRequest: baseReq,
    decisionEvidence: { ...baseEvidence, kind: "expired" },
  });
  const conflict = buildOIWorkerSpawnApprovalDecisionEvidencePacket({
    generatedAt: NOW,
    workerSpawnApprovalRequest: baseReq,
    decisionEvidence: { ...baseEvidence, kind: "conflict" },
  });

  assert.equal(rejection.state, "worker_spawn_approval_evidence_rejected");
  assert.equal(expiry.state, "worker_spawn_approval_evidence_expired");
  assert.equal(conflict.state, "worker_spawn_approval_evidence_conflicting");
  assert.equal(rejection.runtimeReadinessEvidencePatch.workerSpawnApprovalPresent, false);
  assert.equal(expiry.runtimeReadinessEvidencePatch.workerSpawnApprovalPresent, false);
  assert.equal(conflict.runtimeReadinessEvidencePatch.workerSpawnApprovalPresent, false);
});

test("waits when worker spawn approval request is not ready", () => {
  const incompleteSpawnRequest = buildOIWorkerSpawnApprovalRequestPacket({
    generatedAt: NOW,
    brokerDispatchApprovalDecisionEvidence: brokerDispatchApprovalDecisionEvidence(),
    spawnEvidence: {
      spawnScopeDocumented: true,
    },
  });

  assert.equal(
    buildOIWorkerSpawnApprovalDecisionEvidencePacket({
      generatedAt: NOW,
      workerSpawnApprovalRequest: incompleteSpawnRequest,
      decisionEvidence: acceptedWorkerSpawnEvidence(),
    }).state,
    "worker_spawn_approval_request_not_ready",
  );
});

test("preserves boundary, candidate-revision, and forbidden-invariant states from upstream", () => {
  // Boundary review from worker-spawn request (triggered by upstream broker-dispatch boundary)
  const boundaryBrokerDispatch = buildOIBrokerDispatchApprovalDecisionEvidencePacket({
    generatedAt: NOW,
    brokerDispatchApprovalRequest: brokerDispatchApprovalRequest("stop_for_approval_boundary_review"),
  });
  const boundarySpawnReq = buildOIWorkerSpawnApprovalRequestPacket({
    generatedAt: NOW,
    brokerDispatchApprovalDecisionEvidence: boundaryBrokerDispatch,
    spawnEvidence: allSpawnEvidence,
  });
  assert.equal(
    buildOIWorkerSpawnApprovalDecisionEvidencePacket({
      generatedAt: NOW,
      workerSpawnApprovalRequest: boundarySpawnReq,
      decisionEvidence: acceptedWorkerSpawnEvidence(),
    }).state,
    "worker_spawn_boundary_review_required",
  );

  // Candidate revision from worker-spawn request
  const candidateBrokerDispatch = buildOIBrokerDispatchApprovalDecisionEvidencePacket({
    generatedAt: NOW,
    brokerDispatchApprovalRequest: brokerDispatchApprovalRequest("revise_candidate"),
  });
  const candidateSpawnReq = buildOIWorkerSpawnApprovalRequestPacket({
    generatedAt: NOW,
    brokerDispatchApprovalDecisionEvidence: candidateBrokerDispatch,
    spawnEvidence: allSpawnEvidence,
  });
  assert.equal(
    buildOIWorkerSpawnApprovalDecisionEvidencePacket({
      generatedAt: NOW,
      workerSpawnApprovalRequest: candidateSpawnReq,
      decisionEvidence: acceptedWorkerSpawnEvidence(),
    }).state,
    "worker_spawn_candidate_revision_required",
  );

  // Forbidden safety invariant from worker-spawn request
  const upstreamDispatch = brokerDispatchApprovalDecisionEvidence();
  const violatingSpawnReq = {
    ...buildOIWorkerSpawnApprovalRequestPacket({
      generatedAt: NOW,
      brokerDispatchApprovalDecisionEvidence: upstreamDispatch,
      spawnEvidence: allSpawnEvidence,
    }),
    state: "worker_spawn_approval_request_ready" as const,
    safety: {
      ...buildOIWorkerSpawnApprovalRequestPacket({
        generatedAt: NOW,
        brokerDispatchApprovalDecisionEvidence: upstreamDispatch,
        spawnEvidence: allSpawnEvidence,
      }).safety,
      workerSpawnApprovalRequestOnly: false,
    },
  };
  assert.equal(
    buildOIWorkerSpawnApprovalDecisionEvidencePacket({
      generatedAt: NOW,
      workerSpawnApprovalRequest: violatingSpawnReq as ReturnType<typeof buildOIWorkerSpawnApprovalRequestPacket>,
      decisionEvidence: acceptedWorkerSpawnEvidence(),
    }).state,
    "worker_spawn_forbidden_safety_invariant_violated",
  );
});

test("detects forbidden safety invariant from upstream worker-spawn request", () => {
  const upstreamDispatch = brokerDispatchApprovalDecisionEvidence();
  const violatingSpawnReq = {
    ...buildOIWorkerSpawnApprovalRequestPacket({
      generatedAt: NOW,
      brokerDispatchApprovalDecisionEvidence: upstreamDispatch,
      spawnEvidence: allSpawnEvidence,
    }),
    state: "worker_spawn_approval_request_ready" as const,
    safety: {
      ...buildOIWorkerSpawnApprovalRequestPacket({
        generatedAt: NOW,
        brokerDispatchApprovalDecisionEvidence: upstreamDispatch,
        spawnEvidence: allSpawnEvidence,
      }).safety,
      workerSpawnApprovalRequestOnly: false,
    },
  };
  const packet = buildOIWorkerSpawnApprovalDecisionEvidencePacket({
    generatedAt: NOW,
    workerSpawnApprovalRequest: violatingSpawnReq as ReturnType<typeof buildOIWorkerSpawnApprovalRequestPacket>,
    decisionEvidence: acceptedWorkerSpawnEvidence(),
  });
  assert.equal(packet.state, "worker_spawn_forbidden_safety_invariant_violated");
  assert.equal(packet.disposition, "blocked_forbidden_safety_invariant");
  assert.equal(packet.runtimeReadinessEvidencePatch.workerSpawnApprovalPresent, false);
});

test("detects upstream worker-spawn request in forbidden state", () => {
  const upstreamDispatch = brokerDispatchApprovalDecisionEvidence();
  const spawnReq = buildOIWorkerSpawnApprovalRequestPacket({
    generatedAt: NOW,
    brokerDispatchApprovalDecisionEvidence: upstreamDispatch,
    spawnEvidence: allSpawnEvidence,
  });
  // The builder ensures consistency. Simulate a violation where the upstream
  // request state is "forbidden_safety_invariant_violated".
  const violatingPacket = {
    ...spawnReq,
    state: "forbidden_safety_invariant_violated" as const,
  };
  const packet = buildOIWorkerSpawnApprovalDecisionEvidencePacket({
    generatedAt: NOW,
    workerSpawnApprovalRequest: violatingPacket,
    decisionEvidence: acceptedWorkerSpawnEvidence(),
  });
  assert.equal(packet.state, "worker_spawn_forbidden_safety_invariant_violated");
  assert.equal(packet.disposition, "blocked_forbidden_safety_invariant");
});

test("renders accepted evidence and remaining NO-GO boundaries via markdown", () => {
  const fixture = JSON.parse(
    readFileSync(
      "fixtures/orchestration-intelligence/worker-spawn-approval-decision-evidence.accepted.json",
      "utf8",
    ),
  );
  const packet = buildOIWorkerSpawnApprovalDecisionEvidencePacket({
    generatedAt: NOW,
    recorder: fixture.recorder,
    workerSpawnApprovalRequest: workerSpawnApprovalRequest(),
    decisionEvidence: fixture.decisionEvidenceForWorkerSpawnApproval,
    notes: fixture.notes,
  });
  const markdown = renderOIWorkerSpawnApprovalDecisionEvidenceMarkdown(packet);

  assert.match(markdown, /worker\/subagent spawn approval decision evidence/);
  assert.match(markdown, /State: worker_spawn_approval_evidence_accepted/);
  assert.match(markdown, /workerSpawnApprovalPresent: true/);
  assert.match(markdown, /source readiness flag only/);
  assert.match(markdown, /does not grant execution approval/);
  assert.match(markdown, /spawn workers\/subagents/);
});
