import { createHash } from "node:crypto";

import {
  buildOIValidationFinalizerReviewPacket,
  type OIValidationFinalizerReviewPacket,
  type OIValidationFinalizerScenarioReview,
} from "./orchestration-intelligence-validation-finalizer-review.js";
import { buildOIValidationScorePacket } from "./orchestration-intelligence-validation-scorer.js";
import { stableStringify } from "./value-guards.js";

export type OIValidationOperatorReviewRequestState =
  | "operator_review_request_ready"
  | "evidence_incomplete"
  | "approval_boundary_blocked"
  | "candidate_review_required";

export interface OIValidationOperatorReviewRequestInput {
  generatedAt?: string;
  runId?: string;
  operator?: string;
  finalizerReview?: OIValidationFinalizerReviewPacket;
  notes?: string[];
}

export interface OIValidationOperatorScenarioRequest {
  id: OIValidationFinalizerScenarioReview["id"];
  recommendation: OIValidationFinalizerScenarioReview["recommendation"];
  operatorAction:
    | "review_in_final_packet"
    | "collect_missing_evidence"
    | "hold_for_broker_review"
    | "stop_for_approval_boundary";
  improvedMetrics: number;
  degradedMetrics: number;
  missingMetrics: string[];
  blockers: string[];
  evidenceUrls: string[];
}

export interface OIValidationOperatorReviewRequestPacket {
  kind: "a2a-broker.orchestration-intelligence.validation-operator-review-request.packet";
  version: 1;
  generatedAt: string;
  runId: string;
  operator: string;
  sourceOnly: true;
  idempotencyKey: string;
  finalizerReviewIdempotencyKey: string;
  scoreIdempotencyKey: string;
  frameworkIdempotencyKey: string;
  roadmap: OIValidationFinalizerReviewPacket["roadmap"];
  state: OIValidationOperatorReviewRequestState;
  requestedDecision:
    | "review_validation_results"
    | "collect_missing_evidence"
    | "stop_for_approval_boundary_review"
    | "review_degraded_candidates";
  title: string;
  summary: string;
  scenarioRequests: OIValidationOperatorScenarioRequest[];
  missingEvidence: string[];
  blockers: string[];
  evidenceUrls: string[];
  operatorPrompts: string[];
  nextActions: string[];
  notes: string[];
  safety: {
    approvalRequestDraftOnly: true;
    grantsExecutionApproval: false;
    approvalGranted: false;
    runtimeExecutorCreated: false;
    brokerDispatchCreated: false;
    workerSpawned: false;
    providerSend: false;
    terminalAckReplay: false;
    dbMutation: false;
    deployOrRestart: false;
    credentialMovement: false;
    releasePublished: false;
  };
}

export function buildOIValidationOperatorReviewRequestPacket(
  input: OIValidationOperatorReviewRequestInput = {},
): OIValidationOperatorReviewRequestPacket {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const finalizerReview =
    input.finalizerReview
    ?? buildOIValidationFinalizerReviewPacket({ generatedAt, score: buildOIValidationScorePacket({ generatedAt }) });
  const runId = input.runId ?? `${finalizerReview.runId}-operator-review-request`;
  const operator = input.operator ?? "operator";
  const state = stateForFinalizerReview(finalizerReview);
  const scenarioRequests = finalizerReview.scenarioReviews.map(scenarioRequest);
  const missingEvidence = unique(scenarioRequests.flatMap((scenario) => scenario.missingMetrics));
  const blockers = unique([
    ...scenarioRequests.flatMap((scenario) => scenario.blockers),
    ...(state === "approval_boundary_blocked" ? ["approval boundary violation requires broker finalizer review"] : []),
  ]);
  const evidenceUrls = unique(scenarioRequests.flatMap((scenario) => scenario.evidenceUrls));
  const requestedDecision = requestedDecisionForState(state);

  return {
    kind: "a2a-broker.orchestration-intelligence.validation-operator-review-request.packet",
    version: 1,
    generatedAt,
    runId,
    operator,
    sourceOnly: true,
    idempotencyKey: stableId("oi-validation-operator-review-request", {
      runId,
      finalizerReview: finalizerReview.idempotencyKey,
      operator,
      state,
      scenarioRequests,
    }),
    finalizerReviewIdempotencyKey: finalizerReview.idempotencyKey,
    scoreIdempotencyKey: finalizerReview.scoreIdempotencyKey,
    frameworkIdempotencyKey: finalizerReview.frameworkIdempotencyKey,
    roadmap: finalizerReview.roadmap,
    state,
    requestedDecision,
    title: `OI v2 validation operator review for #${finalizerReview.roadmap.issueNumber}`,
    summary: summaryForState(state, finalizerReview),
    scenarioRequests,
    missingEvidence,
    blockers,
    evidenceUrls,
    operatorPrompts: promptsForState(state),
    nextActions: nextActionsForState(state),
    notes: input.notes ?? [],
    safety: {
      approvalRequestDraftOnly: true,
      grantsExecutionApproval: false,
      approvalGranted: false,
      runtimeExecutorCreated: false,
      brokerDispatchCreated: false,
      workerSpawned: false,
      providerSend: false,
      terminalAckReplay: false,
      dbMutation: false,
      deployOrRestart: false,
      credentialMovement: false,
      releasePublished: false,
    },
  };
}

export function renderOIValidationOperatorReviewRequestMarkdown(
  packet: OIValidationOperatorReviewRequestPacket,
): string {
  const scenarioLines = packet.scenarioRequests.map(
    (scenario) =>
      `- ${scenario.id}: ${scenario.operatorAction}; improved=${scenario.improvedMetrics}, degraded=${scenario.degradedMetrics}, missing=${scenario.missingMetrics.length}, blockers=${scenario.blockers.length}`,
  );
  return [
    "A2A Orchestration Intelligence v2 validation operator review request",
    `Roadmap: #${packet.roadmap.issueNumber}`,
    `State: ${packet.state}`,
    `Requested decision: ${packet.requestedDecision}`,
    `Operator: ${packet.operator}`,
    `Summary: ${packet.summary}`,
    "Scenario requests:",
    ...scenarioLines,
    "Operator prompts:",
    ...packet.operatorPrompts.map((prompt) => `- ${prompt}`),
    "Safety: source-only operator review request draft; does not grant execution approval and does not create a runtime executor, broker dispatch, worker spawn, provider send, Terminal ACK/replay, DB mutation, deploy/restart, release, or credential movement.",
  ].join("\n");
}

function stateForFinalizerReview(review: OIValidationFinalizerReviewPacket): OIValidationOperatorReviewRequestState {
  if (review.state === "approval_boundary_blocked") return "approval_boundary_blocked";
  if (review.state === "evidence_incomplete") return "evidence_incomplete";
  if (review.state === "candidate_needs_review") return "candidate_review_required";
  return "operator_review_request_ready";
}

function requestedDecisionForState(
  state: OIValidationOperatorReviewRequestState,
): OIValidationOperatorReviewRequestPacket["requestedDecision"] {
  if (state === "approval_boundary_blocked") return "stop_for_approval_boundary_review";
  if (state === "evidence_incomplete") return "collect_missing_evidence";
  if (state === "candidate_review_required") return "review_degraded_candidates";
  return "review_validation_results";
}

function scenarioRequest(review: OIValidationFinalizerScenarioReview): OIValidationOperatorScenarioRequest {
  return {
    id: review.id,
    recommendation: review.recommendation,
    operatorAction: operatorActionForScenario(review),
    improvedMetrics: review.improvedMetrics,
    degradedMetrics: review.degradedMetrics,
    missingMetrics: review.missingMetrics,
    blockers: review.blockers,
    evidenceUrls: review.evidenceUrls,
  };
}

function operatorActionForScenario(
  review: OIValidationFinalizerScenarioReview,
): OIValidationOperatorScenarioRequest["operatorAction"] {
  if (review.recommendation === "blocked_by_approval_boundary") return "stop_for_approval_boundary";
  if (review.recommendation === "collect_more_evidence") return "collect_missing_evidence";
  if (review.recommendation === "hold_for_broker_review") return "hold_for_broker_review";
  return "review_in_final_packet";
}

function summaryForState(
  state: OIValidationOperatorReviewRequestState,
  review: OIValidationFinalizerReviewPacket,
): string {
  if (state === "approval_boundary_blocked") {
    return `${review.summary.approvalBoundaryViolations} approval boundary violation(s) block operator review until reconciled.`;
  }
  if (state === "evidence_incomplete") {
    return `${review.summary.missingMetrics} metric(s) are missing; collect paired evidence before operator review.`;
  }
  if (state === "candidate_review_required") {
    return `${review.summary.degradedMetrics} degraded metric(s) require broker/operator review before final validation.`;
  }
  return `${review.summary.scenariosReady} scenario(s) are ready for operator review.`;
}

function promptsForState(state: OIValidationOperatorReviewRequestState): string[] {
  if (state === "approval_boundary_blocked") {
    return [
      "Confirm the approval-boundary violation is reconciled before any further validation decision.",
      "Do not grant execution approval from this packet.",
    ];
  }
  if (state === "evidence_incomplete") {
    return [
      "Collect the missing paired baseline/candidate evidence.",
      "Re-run scorer and finalizer review before requesting an operator decision.",
    ];
  }
  if (state === "candidate_review_required") {
    return [
      "Review degraded candidate metrics and decide whether the candidate needs redesign.",
      "Keep any execution, deploy, provider, DB, Terminal ACK, release, or credential action behind separate approval.",
    ];
  }
  return [
    "Review validation results and decide whether the OI v2 candidate can advance to the next source-only planning step.",
    "Treat this as review evidence only, not an execution approval grant.",
  ];
}

function nextActionsForState(state: OIValidationOperatorReviewRequestState): string[] {
  if (state === "approval_boundary_blocked") return ["stop validation closeout", "reconcile approval-boundary violation"];
  if (state === "evidence_incomplete") return ["collect missing evidence", "rebuild score and finalizer review packets"];
  if (state === "candidate_review_required") return ["review degraded candidate metrics", "record broker finalizer decision"];
  return ["present operator review request", "record explicit operator decision separately if needed"];
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function stableId(prefix: string, value: unknown): string {
  return `${prefix}-${createHash("sha256").update(stableStringify(value)).digest("hex").slice(0, 24)}`;
}
