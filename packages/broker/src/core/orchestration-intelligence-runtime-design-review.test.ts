import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { buildOIRuntimeReadinessGatePacket } from "./orchestration-intelligence-runtime-readiness-gate.js";
import { buildOIValidationFinalizerDecisionPacket } from "./orchestration-intelligence-validation-finalizer-decision.js";
import { buildOIValidationFinalizerReviewPacket } from "./orchestration-intelligence-validation-finalizer-review.js";
import { buildOIValidationOperatorDecisionEvidencePacket } from "./orchestration-intelligence-validation-operator-decision-evidence.js";
import { buildOIValidationOperatorReviewRequestPacket } from "./orchestration-intelligence-validation-operator-review-request.js";
import { buildOIValidationScorePacket } from "./orchestration-intelligence-validation-scorer.js";
import {
  buildOIRuntimeDesignReviewPacket,
  renderOIRuntimeDesignReviewMarkdown,
} from "./orchestration-intelligence-runtime-design-review.js";

const NOW = "2026-05-30T08:30:00.000Z";

const allDesignEvidence = {
  executorContractDocumented: true,
  brokerDispatchBoundaryDocumented: true,
  workerSpawnBoundaryDocumented: true,
  daegyoMobileBoundaryDocumented: true,
  rollbackAbortCriteriaDocumented: true,
  liveBoundaryPlanDocumented: true,
  observabilityPlanDocumented: true,
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

test("records a source-only runtime design review without granting execution approval", () => {
  const packet = buildOIRuntimeDesignReviewPacket({
    generatedAt: NOW,
    reviewer: "gwakga",
    runtimeReadinessGate: runtimeReadinessGate(),
    designEvidence: allDesignEvidence,
  });

  assert.equal(packet.kind, "a2a-broker.orchestration-intelligence.runtime-design-review.packet");
  assert.equal(packet.state, "design_review_ready");
  assert.equal(packet.disposition, "runtime_design_review_recorded");
  assert.equal(packet.runtimeReadinessEvidencePatch.runtimeExecutorDesignReviewed, true);
  assert.equal(packet.runtimeReadinessEvidencePatch.explicitRuntimeApprovalPresent, false);
  assert.equal(packet.runtimeReadinessEvidencePatch.brokerDispatchApprovalPresent, false);
  assert.equal(packet.runtimeReadinessEvidencePatch.workerSpawnApprovalPresent, false);
  assert.equal(packet.runtimeReadinessEvidencePatch.daegyoMobileScopeResolved, false);
  assert.equal(packet.safety.runtimeDesignReviewOnly, true);
  assert.equal(packet.safety.grantsExecutionApproval, false);
  assert.equal(packet.safety.runtimeExecutorEnabled, false);
  assert.equal(packet.safety.brokerDispatchCreated, false);
  assert.equal(packet.safety.workerSpawned, false);
  assert.equal(packet.safety.daegyoScopeExpanded, false);
});

test("fails closed when design evidence is incomplete", () => {
  const packet = buildOIRuntimeDesignReviewPacket({
    generatedAt: NOW,
    runtimeReadinessGate: runtimeReadinessGate(),
    designEvidence: {
      executorContractDocumented: true,
    },
  });

  assert.equal(packet.state, "design_review_incomplete");
  assert.equal(packet.runtimeReadinessEvidencePatch.runtimeExecutorDesignReviewed, false);
  assert.ok(packet.blockers.some((blocker) => blocker.includes("broker_dispatch_boundary_documented")));
  assert.ok(packet.blockers.some((blocker) => blocker.includes("live_boundary_plan_documented")));
});

test("waits when the source validation chain is not ready", () => {
  const packet = buildOIRuntimeDesignReviewPacket({
    generatedAt: NOW,
    runtimeReadinessGate: runtimeReadinessGate("collect_more_evidence"),
    designEvidence: allDesignEvidence,
  });

  assert.equal(packet.state, "source_chain_not_ready");
  assert.equal(packet.disposition, "wait_for_source_chain");
  assert.equal(packet.runtimeReadinessEvidencePatch.runtimeExecutorDesignReviewed, false);
});

test("preserves approval-boundary and candidate-revision states", () => {
  assert.equal(
    buildOIRuntimeDesignReviewPacket({
      generatedAt: NOW,
      runtimeReadinessGate: runtimeReadinessGate("stop_for_approval_boundary_review"),
      designEvidence: allDesignEvidence,
    }).state,
    "approval_boundary_review_required",
  );
  assert.equal(
    buildOIRuntimeDesignReviewPacket({
      generatedAt: NOW,
      runtimeReadinessGate: runtimeReadinessGate("revise_candidate"),
      designEvidence: allDesignEvidence,
    }).state,
    "candidate_revision_required",
  );
});

test("renders review and remaining NO-GO boundaries", () => {
  const fixture = JSON.parse(readFileSync("fixtures/orchestration-intelligence/runtime-design-review.ready.json", "utf8"));
  const packet = buildOIRuntimeDesignReviewPacket({
    generatedAt: NOW,
    reviewer: fixture.reviewer,
    runtimeReadinessGate: runtimeReadinessGate(),
    designEvidence: fixture.designEvidence,
    notes: fixture.notes,
  });
  const markdown = renderOIRuntimeDesignReviewMarkdown(packet);

  assert.match(markdown, /runtime design review/);
  assert.match(markdown, /State: design_review_ready/);
  assert.match(markdown, /runtimeExecutorDesignReviewed: true/);
  assert.match(markdown, /explicitRuntimeApprovalPresent: false/);
  assert.match(markdown, /does not grant execution approval/);
  assert.match(markdown, /expand Daegyo\/mobile scope/);
});
