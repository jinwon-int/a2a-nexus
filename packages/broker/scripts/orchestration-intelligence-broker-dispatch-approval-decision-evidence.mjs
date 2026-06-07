#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import process from "node:process";

import { buildOIValidationScorePacket } from "../dist/core/orchestration-intelligence-validation-scorer.js";
import { buildOIValidationFinalizerReviewPacket } from "../dist/core/orchestration-intelligence-validation-finalizer-review.js";
import { buildOIValidationOperatorReviewRequestPacket } from "../dist/core/orchestration-intelligence-validation-operator-review-request.js";
import { buildOIValidationOperatorDecisionEvidencePacket } from "../dist/core/orchestration-intelligence-validation-operator-decision-evidence.js";
import { buildOIValidationFinalizerDecisionPacket } from "../dist/core/orchestration-intelligence-validation-finalizer-decision.js";
import { buildOIRuntimeReadinessGatePacket } from "../dist/core/orchestration-intelligence-runtime-readiness-gate.js";
import { buildOIRuntimeDesignReviewPacket } from "../dist/core/orchestration-intelligence-runtime-design-review.js";
import { buildOIRuntimeApprovalRequestPacket } from "../dist/core/orchestration-intelligence-runtime-approval-request.js";
import { buildOIRuntimeApprovalDecisionEvidencePacket } from "../dist/core/orchestration-intelligence-runtime-approval-decision-evidence.js";
import { buildOIBrokerDispatchApprovalRequestPacket } from "../dist/core/orchestration-intelligence-broker-dispatch-approval-request.js";
import {
  buildOIBrokerDispatchApprovalDecisionEvidencePacket,
  renderOIBrokerDispatchApprovalDecisionEvidenceMarkdown,
} from "../dist/core/orchestration-intelligence-broker-dispatch-approval-decision-evidence.js";

function readOption(argv, name) {
  const inline = argv.find((arg) => arg.startsWith(name + "="));
  if (inline) return inline.slice(name.length + 1);
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

async function main() {
  const argv = process.argv.slice(2);
  const inputPath = readOption(argv, "--input");
  const input = inputPath ? JSON.parse(await readFile(inputPath, "utf8")) : {};
  const score = input.score ?? buildOIValidationScorePacket(input.scoreInput ?? input);
  const finalizerReview =
    input.finalizerReview
    ?? buildOIValidationFinalizerReviewPacket({
      generatedAt: input.generatedAt,
      reviewer: input.reviewer,
      notes: input.finalizerReviewNotes,
      score,
    });
  const reviewRequest =
    input.reviewRequest
    ?? buildOIValidationOperatorReviewRequestPacket({
      generatedAt: input.generatedAt,
      operator: input.operator,
      notes: input.reviewRequestNotes,
      finalizerReview,
    });
  const operatorDecisionEvidence =
    input.operatorDecisionEvidence
    ?? buildOIValidationOperatorDecisionEvidencePacket({
      generatedAt: input.generatedAt,
      notes: input.operatorDecisionEvidenceNotes,
      reviewRequest,
      decisionEvidence: input.decisionEvidenceForSourceChain,
    });
  const finalizerDecision =
    input.finalizerDecision
    ?? buildOIValidationFinalizerDecisionPacket({
      generatedAt: input.generatedAt,
      finalizer: input.finalizer,
      notes: input.finalizerDecisionNotes,
      operatorDecisionEvidence,
    });
  const runtimeReadinessGate =
    input.runtimeReadinessGate
    ?? buildOIRuntimeReadinessGatePacket({
      generatedAt: input.generatedAt,
      runId: input.runtimeReadinessGateRunId,
      reviewer: input.reviewer,
      notes: input.runtimeReadinessGateNotes,
      finalizerDecision,
      runtimeEvidence: input.runtimeEvidence,
    });
  const runtimeDesignReview =
    input.runtimeDesignReview
    ?? buildOIRuntimeDesignReviewPacket({
      generatedAt: input.generatedAt,
      runId: input.runtimeDesignReviewRunId,
      reviewer: input.reviewer,
      notes: input.runtimeDesignReviewNotes,
      runtimeReadinessGate,
      designEvidence: input.designEvidence,
    });
  const runtimeApprovalRequest =
    input.runtimeApprovalRequest
    ?? buildOIRuntimeApprovalRequestPacket({
      generatedAt: input.generatedAt,
      runId: input.runtimeApprovalRequestRunId,
      requester: input.requester,
      operator: input.operator,
      notes: input.runtimeApprovalRequestNotes,
      runtimeDesignReview,
      approvalEvidence: input.approvalEvidence,
    });
  const runtimeApprovalDecisionEvidence =
    input.runtimeApprovalDecisionEvidence
    ?? buildOIRuntimeApprovalDecisionEvidencePacket({
      generatedAt: input.generatedAt,
      runId: input.runtimeApprovalDecisionEvidenceRunId,
      recorder: input.recorder,
      expectedRepo: input.expectedRepo,
      expectedIssueNumber: input.expectedIssueNumber,
      notes: input.runtimeApprovalDecisionEvidenceNotes,
      runtimeApprovalRequest,
      decisionEvidence: input.runtimeDecisionEvidence ?? input.decisionEvidenceForRuntimeApproval,
    });
  const brokerDispatchApprovalRequest =
    input.brokerDispatchApprovalRequest
    ?? buildOIBrokerDispatchApprovalRequestPacket({
      generatedAt: input.generatedAt,
      runId: input.brokerDispatchApprovalRequestRunId,
      requester: input.requester,
      operator: input.operator,
      notes: input.brokerDispatchApprovalRequestNotes,
      runtimeApprovalDecisionEvidence,
      dispatchEvidence: input.dispatchEvidence,
    });
  const packet = buildOIBrokerDispatchApprovalDecisionEvidencePacket({
    generatedAt: input.generatedAt,
    runId: input.runId,
    recorder: input.recorder,
    expectedRepo: input.expectedRepo,
    expectedIssueNumber: input.expectedIssueNumber,
    notes: input.notes,
    brokerDispatchApprovalRequest,
    decisionEvidence: input.decisionEvidence,
  });
  if (argv.includes("--json")) console.log(JSON.stringify(packet, null, 2));
  else console.log(renderOIBrokerDispatchApprovalDecisionEvidenceMarkdown(packet));
}

main().catch((error) => {
  console.error(
    "orchestration-intelligence-broker-dispatch-approval-decision-evidence: "
    + (error instanceof Error ? error.message : String(error)),
  );
  process.exit(2);
});
