import { createHash } from "node:crypto";
import { stableStringify } from "./value-guards.js";

import {
  buildOIValidationOperatorReviewRequestPacket,
  type OIValidationOperatorReviewRequestPacket,
} from "./orchestration-intelligence-validation-operator-review-request.js";

export type OIValidationOperatorDecision =
  | "advance_to_next_source_step"
  | "collect_more_evidence"
  | "stop_for_approval_boundary_review"
  | "revise_candidate";

export type OIValidationOperatorDecisionEvidenceState =
  | "decision_evidence_accepted"
  | "decision_evidence_missing"
  | "decision_evidence_conflicting"
  | "decision_blocked_by_request_state";

export interface OIValidationOperatorDecisionEvidenceInput {
  generatedAt?: string;
  runId?: string;
  reviewRequest?: OIValidationOperatorReviewRequestPacket;
  decisionEvidence?: {
    decision: OIValidationOperatorDecision;
    actor: string;
    observedAt?: string;
    rationale?: string;
    evidenceUrl?: string;
    reviewRequestIdempotencyKey?: string;
  };
  notes?: string[];
}

export interface OIValidationOperatorDecisionEvidencePacket {
  kind: "a2a-broker.orchestration-intelligence.validation-operator-decision-evidence.packet";
  version: 1;
  generatedAt: string;
  runId: string;
  sourceOnly: true;
  idempotencyKey: string;
  reviewRequestIdempotencyKey: string;
  finalizerReviewIdempotencyKey: string;
  scoreIdempotencyKey: string;
  frameworkIdempotencyKey: string;
  roadmap: OIValidationOperatorReviewRequestPacket["roadmap"];
  state: OIValidationOperatorDecisionEvidenceState;
  decision?: OIValidationOperatorDecision;
  actor?: string;
  observedAt?: string;
  evidenceUrl?: string;
  rationale?: string;
  accepted: boolean;
  blockers: string[];
  nextActions: string[];
  notes: string[];
  safety: {
    decisionEvidenceOnly: true;
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

export function buildOIValidationOperatorDecisionEvidencePacket(
  input: OIValidationOperatorDecisionEvidenceInput = {},
): OIValidationOperatorDecisionEvidencePacket {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const reviewRequest = input.reviewRequest ?? buildOIValidationOperatorReviewRequestPacket({ generatedAt });
  const runId = input.runId ?? `${reviewRequest.runId}-decision-evidence`;
  const state = stateForDecisionEvidence(reviewRequest, input.decisionEvidence);
  const blockers = blockersForState(state, reviewRequest, input.decisionEvidence);

  return {
    kind: "a2a-broker.orchestration-intelligence.validation-operator-decision-evidence.packet",
    version: 1,
    generatedAt,
    runId,
    sourceOnly: true,
    idempotencyKey: stableId("oi-validation-operator-decision-evidence", {
      runId,
      reviewRequest: reviewRequest.idempotencyKey,
      decisionEvidence: input.decisionEvidence ?? null,
      state,
    }),
    reviewRequestIdempotencyKey: reviewRequest.idempotencyKey,
    finalizerReviewIdempotencyKey: reviewRequest.finalizerReviewIdempotencyKey,
    scoreIdempotencyKey: reviewRequest.scoreIdempotencyKey,
    frameworkIdempotencyKey: reviewRequest.frameworkIdempotencyKey,
    roadmap: reviewRequest.roadmap,
    state,
    decision: input.decisionEvidence?.decision,
    actor: input.decisionEvidence?.actor,
    observedAt: input.decisionEvidence?.observedAt,
    evidenceUrl: input.decisionEvidence?.evidenceUrl,
    rationale: input.decisionEvidence?.rationale,
    accepted: state === "decision_evidence_accepted",
    blockers,
    nextActions: nextActionsForState(state, input.decisionEvidence?.decision),
    notes: input.notes ?? [],
    safety: {
      decisionEvidenceOnly: true,
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

export function renderOIValidationOperatorDecisionEvidenceMarkdown(
  packet: OIValidationOperatorDecisionEvidencePacket,
): string {
  return [
    "A2A Orchestration Intelligence v2 validation operator decision evidence",
    `Roadmap: #${packet.roadmap.issueNumber}`,
    `State: ${packet.state}`,
    `Accepted: ${packet.accepted}`,
    `Decision: ${packet.decision ?? "none"}`,
    `Actor: ${packet.actor ?? "none"}`,
    "Blockers:",
    ...(packet.blockers.length ? packet.blockers.map((blocker) => `- ${blocker}`) : ["- none"]),
    "Next actions:",
    ...packet.nextActions.map((action) => `- ${action}`),
    "Safety: source-only decision evidence; does not grant execution approval and does not create a runtime executor, broker dispatch, worker spawn, provider send, Terminal ACK/replay, DB mutation, deploy/restart, release, or credential movement.",
  ].join("\n");
}

function stateForDecisionEvidence(
  reviewRequest: OIValidationOperatorReviewRequestPacket,
  evidence: OIValidationOperatorDecisionEvidenceInput["decisionEvidence"],
): OIValidationOperatorDecisionEvidenceState {
  if (!evidence) return "decision_evidence_missing";
  if (evidence.reviewRequestIdempotencyKey && evidence.reviewRequestIdempotencyKey !== reviewRequest.idempotencyKey) {
    return "decision_evidence_conflicting";
  }
  if (!decisionCompatibleWithRequest(reviewRequest, evidence.decision)) return "decision_blocked_by_request_state";
  return "decision_evidence_accepted";
}

function decisionCompatibleWithRequest(
  reviewRequest: OIValidationOperatorReviewRequestPacket,
  decision: OIValidationOperatorDecision,
): boolean {
  if (reviewRequest.state === "operator_review_request_ready") return true;
  if (reviewRequest.state === "evidence_incomplete") return decision === "collect_more_evidence";
  if (reviewRequest.state === "approval_boundary_blocked") return decision === "stop_for_approval_boundary_review";
  if (reviewRequest.state === "candidate_review_required") {
    return decision === "revise_candidate" || decision === "collect_more_evidence";
  }
  return false;
}

function blockersForState(
  state: OIValidationOperatorDecisionEvidenceState,
  reviewRequest: OIValidationOperatorReviewRequestPacket,
  evidence: OIValidationOperatorDecisionEvidenceInput["decisionEvidence"],
): string[] {
  if (state === "decision_evidence_missing") return ["operator decision evidence is required before recording validation decision"];
  if (state === "decision_evidence_conflicting") return ["decision evidence references a different operator review request idempotency key"];
  if (state === "decision_blocked_by_request_state") {
    return [
      `decision ${evidence?.decision ?? "unknown"} is incompatible with review request state ${reviewRequest.state}`,
      ...reviewRequest.blockers,
    ];
  }
  return [];
}

function nextActionsForState(
  state: OIValidationOperatorDecisionEvidenceState,
  decision: OIValidationOperatorDecision | undefined,
): string[] {
  if (state === "decision_evidence_missing") return ["collect explicit operator decision evidence"];
  if (state === "decision_evidence_conflicting") return ["reconcile decision evidence with the current review request"];
  if (state === "decision_blocked_by_request_state") return ["do not advance validation; resolve request state first"];
  if (decision === "advance_to_next_source_step") return ["record source-only advancement decision", "open next source-only planning step if needed"];
  if (decision === "collect_more_evidence") return ["collect missing paired evidence", "rebuild validation score chain"];
  if (decision === "stop_for_approval_boundary_review") return ["stop validation closeout", "reconcile approval boundary"];
  return ["revise candidate metrics or implementation before another operator review"];
}

function stableId(prefix: string, value: unknown): string {
  return `${prefix}-${createHash("sha256").update(stableStringify(value)).digest("hex").slice(0, 24)}`;
}
