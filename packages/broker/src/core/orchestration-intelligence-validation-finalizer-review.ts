import { createHash } from "node:crypto";
import { stableStringify } from "./value-guards.js";

import type {
  OIValidationScorePacket,
  OIValidationScenarioScore,
} from "./orchestration-intelligence-validation-scorer.js";

export type OIValidationFinalizerReviewState =
  | "review_ready"
  | "evidence_incomplete"
  | "approval_boundary_blocked"
  | "candidate_needs_review";

export interface OIValidationFinalizerReviewInput {
  generatedAt?: string;
  runId?: string;
  score: OIValidationScorePacket;
  reviewer?: string;
  notes?: string[];
}

export interface OIValidationFinalizerScenarioReview {
  id: OIValidationScenarioScore["id"];
  decision: OIValidationScenarioScore["decision"];
  recommendation:
    | "include_in_final_review"
    | "collect_more_evidence"
    | "hold_for_broker_review"
    | "blocked_by_approval_boundary";
  improvedMetrics: number;
  degradedMetrics: number;
  missingMetrics: string[];
  blockers: string[];
  evidenceUrls: string[];
}

export interface OIValidationFinalizerReviewPacket {
  kind: "a2a-broker.orchestration-intelligence.validation-finalizer-review.packet";
  version: 1;
  generatedAt: string;
  runId: string;
  reviewer: string;
  sourceOnly: true;
  idempotencyKey: string;
  scoreIdempotencyKey: string;
  frameworkIdempotencyKey: string;
  roadmap: OIValidationScorePacket["roadmap"];
  state: OIValidationFinalizerReviewState;
  scenarioReviews: OIValidationFinalizerScenarioReview[];
  summary: {
    scenariosReady: number;
    scenariosWaiting: number;
    scenariosBlocked: number;
    scenariosNeedingReview: number;
    improvedMetrics: number;
    degradedMetrics: number;
    missingMetrics: number;
    approvalBoundaryViolations: number;
  };
  finalizerRecommendation:
    | "prepare_operator_review"
    | "collect_missing_evidence"
    | "stop_for_approval_boundary_review"
    | "review_degraded_candidates";
  notes: string[];
  safety: {
    grantsExecutionApproval: false;
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

export function buildOIValidationFinalizerReviewPacket(
  input: OIValidationFinalizerReviewInput,
): OIValidationFinalizerReviewPacket {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const runId = input.runId ?? `${input.score.runId}-finalizer-review`;
  const reviewer = input.reviewer ?? "broker-finalizer";
  const scenarioReviews = input.score.scenarioScores.map(reviewScenario);
  const scenariosNeedingReview = scenarioReviews.filter((review) => review.recommendation === "hold_for_broker_review").length;
  const state = reviewState(input.score, scenariosNeedingReview);
  const summary = {
    scenariosReady: input.score.aggregate.scenariosReady,
    scenariosWaiting: input.score.aggregate.scenariosWaiting,
    scenariosBlocked: input.score.aggregate.scenariosBlocked,
    scenariosNeedingReview,
    improvedMetrics: input.score.aggregate.improvedMetrics,
    degradedMetrics: input.score.aggregate.degradedMetrics,
    missingMetrics: input.score.aggregate.missingMetrics,
    approvalBoundaryViolations: input.score.aggregate.approvalBoundaryViolations,
  };

  return {
    kind: "a2a-broker.orchestration-intelligence.validation-finalizer-review.packet",
    version: 1,
    generatedAt,
    runId,
    reviewer,
    sourceOnly: true,
    idempotencyKey: stableId("oi-validation-finalizer-review", {
      runId,
      score: input.score.idempotencyKey,
      reviewer,
      scenarioReviews,
    }),
    scoreIdempotencyKey: input.score.idempotencyKey,
    frameworkIdempotencyKey: input.score.frameworkIdempotencyKey,
    roadmap: input.score.roadmap,
    state,
    scenarioReviews,
    summary,
    finalizerRecommendation: recommendationForState(state),
    notes: input.notes ?? [],
    safety: {
      grantsExecutionApproval: false,
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

export function renderOIValidationFinalizerReviewMarkdown(packet: OIValidationFinalizerReviewPacket): string {
  const scenarioLines = packet.scenarioReviews.map(
    (scenario) =>
      `- ${scenario.id}: ${scenario.recommendation}; improved=${scenario.improvedMetrics}, degraded=${scenario.degradedMetrics}, missing=${scenario.missingMetrics.length}, blockers=${scenario.blockers.length}`,
  );
  return [
    "A2A Orchestration Intelligence v2 validation finalizer review",
    `Roadmap: #${packet.roadmap.issueNumber}`,
    `State: ${packet.state}`,
    `Recommendation: ${packet.finalizerRecommendation}`,
    `Reviewer: ${packet.reviewer}`,
    "Scenario review:",
    ...scenarioLines,
    "Safety: source-only finalizer review; does not grant execution approval and does not create a runtime executor, broker dispatch, worker spawn, provider send, Terminal ACK/replay, DB mutation, deploy/restart, release, or credential movement.",
  ].join("\n");
}

function reviewScenario(scenario: OIValidationScenarioScore): OIValidationFinalizerScenarioReview {
  const improvedMetrics = scenario.metricScores.filter((metric) => metric.status === "improved").length;
  const degradedMetrics = scenario.metricScores.filter((metric) => metric.status === "degraded").length;
  return {
    id: scenario.id,
    decision: scenario.decision,
    recommendation: scenarioRecommendation(scenario),
    improvedMetrics,
    degradedMetrics,
    missingMetrics: scenario.missingMetrics,
    blockers: scenario.blockers,
    evidenceUrls: scenario.evidenceUrls,
  };
}

function scenarioRecommendation(scenario: OIValidationScenarioScore): OIValidationFinalizerScenarioReview["recommendation"] {
  if (scenario.blockers.length > 0 || scenario.decision === "blocked") return "blocked_by_approval_boundary";
  if (scenario.missingMetrics.length > 0 || scenario.decision === "waiting_for_paired_evidence") return "collect_more_evidence";
  if (scenario.decision === "candidate_needs_review") return "hold_for_broker_review";
  return "include_in_final_review";
}

function reviewState(score: OIValidationScorePacket, scenariosNeedingReview: number): OIValidationFinalizerReviewState {
  if (score.state === "approval_boundary_blocked") return "approval_boundary_blocked";
  if (score.state === "waiting_for_paired_evidence") return "evidence_incomplete";
  if (scenariosNeedingReview > 0) return "candidate_needs_review";
  return "review_ready";
}

function recommendationForState(
  state: OIValidationFinalizerReviewState,
): OIValidationFinalizerReviewPacket["finalizerRecommendation"] {
  if (state === "approval_boundary_blocked") return "stop_for_approval_boundary_review";
  if (state === "evidence_incomplete") return "collect_missing_evidence";
  if (state === "candidate_needs_review") return "review_degraded_candidates";
  return "prepare_operator_review";
}

function stableId(prefix: string, value: unknown): string {
  return `${prefix}-${createHash("sha256").update(stableStringify(value)).digest("hex").slice(0, 24)}`;
}
