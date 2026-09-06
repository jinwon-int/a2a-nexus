import { createHash } from "node:crypto";
import { stableStringify } from "./value-guards.js";

import {
  buildOIValidationOperatorDecisionEvidencePacket,
  type OIValidationOperatorDecisionEvidencePacket,
} from "./orchestration-intelligence-validation-operator-decision-evidence.js";

export type OIValidationFinalizerDecisionState =
  | "ready_for_next_source_step"
  | "waiting_for_operator_decision"
  | "operator_decision_conflict"
  | "operator_decision_blocked"
  | "collect_more_validation_evidence"
  | "approval_boundary_review_required"
  | "candidate_revision_required";

export interface OIValidationFinalizerDecisionInput {
  generatedAt?: string;
  runId?: string;
  finalizer?: string;
  operatorDecisionEvidence?: OIValidationOperatorDecisionEvidencePacket;
  notes?: string[];
}

export interface OIValidationFinalizerDecisionPacket {
  kind: "a2a-broker.orchestration-intelligence.validation-finalizer-decision.packet";
  version: 1;
  generatedAt: string;
  runId: string;
  finalizer: string;
  sourceOnly: true;
  idempotencyKey: string;
  operatorDecisionEvidenceIdempotencyKey: string;
  reviewRequestIdempotencyKey: string;
  finalizerReviewIdempotencyKey: string;
  scoreIdempotencyKey: string;
  frameworkIdempotencyKey: string;
  roadmap: OIValidationOperatorDecisionEvidencePacket["roadmap"];
  state: OIValidationFinalizerDecisionState;
  disposition:
    | "advance_source_only"
    | "wait"
    | "resolve_conflict"
    | "collect_evidence"
    | "stop_for_boundary_review"
    | "revise_candidate";
  acceptedOperatorDecision: boolean;
  blockers: string[];
  nextActions: string[];
  notes: string[];
  safety: {
    finalizerDecisionOnly: true;
    sourceOnly: true;
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

export function buildOIValidationFinalizerDecisionPacket(
  input: OIValidationFinalizerDecisionInput = {},
): OIValidationFinalizerDecisionPacket {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const evidence = input.operatorDecisionEvidence
    ?? buildOIValidationOperatorDecisionEvidencePacket({ generatedAt });
  const runId = input.runId ?? `${evidence.runId}-finalizer-decision`;
  const finalizer = input.finalizer ?? "broker-finalizer";
  const state = stateForOperatorDecisionEvidence(evidence);
  const disposition = dispositionForState(state);

  return {
    kind: "a2a-broker.orchestration-intelligence.validation-finalizer-decision.packet",
    version: 1,
    generatedAt,
    runId,
    finalizer,
    sourceOnly: true,
    idempotencyKey: stableId("oi-validation-finalizer-decision", {
      runId,
      finalizer,
      operatorDecisionEvidence: evidence.idempotencyKey,
      state,
    }),
    operatorDecisionEvidenceIdempotencyKey: evidence.idempotencyKey,
    reviewRequestIdempotencyKey: evidence.reviewRequestIdempotencyKey,
    finalizerReviewIdempotencyKey: evidence.finalizerReviewIdempotencyKey,
    scoreIdempotencyKey: evidence.scoreIdempotencyKey,
    frameworkIdempotencyKey: evidence.frameworkIdempotencyKey,
    roadmap: evidence.roadmap,
    state,
    disposition,
    acceptedOperatorDecision: evidence.accepted,
    blockers: blockersForState(state, evidence),
    nextActions: nextActionsForState(state),
    notes: input.notes ?? [],
    safety: {
      finalizerDecisionOnly: true,
      sourceOnly: true,
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

export function renderOIValidationFinalizerDecisionMarkdown(
  packet: OIValidationFinalizerDecisionPacket,
): string {
  return [
    "A2A Orchestration Intelligence v2 validation finalizer decision",
    `Roadmap: #${packet.roadmap.issueNumber}`,
    `State: ${packet.state}`,
    `Disposition: ${packet.disposition}`,
    `Finalizer: ${packet.finalizer}`,
    `Accepted operator decision: ${packet.acceptedOperatorDecision}`,
    "Blockers:",
    ...(packet.blockers.length ? packet.blockers.map((blocker) => `- ${blocker}`) : ["- none"]),
    "Next actions:",
    ...packet.nextActions.map((action) => `- ${action}`),
    "Safety: source-only finalizer decision; does not grant execution approval and does not create a runtime executor, broker dispatch, worker spawn, provider send, Terminal ACK/replay, DB mutation, deploy/restart, release, or credential movement.",
  ].join("\n");
}

function stateForOperatorDecisionEvidence(
  evidence: OIValidationOperatorDecisionEvidencePacket,
): OIValidationFinalizerDecisionState {
  if (evidence.state === "decision_evidence_missing") return "waiting_for_operator_decision";
  if (evidence.state === "decision_evidence_conflicting") return "operator_decision_conflict";
  if (evidence.state === "decision_blocked_by_request_state") return "operator_decision_blocked";
  if (evidence.decision === "advance_to_next_source_step") return "ready_for_next_source_step";
  if (evidence.decision === "collect_more_evidence") return "collect_more_validation_evidence";
  if (evidence.decision === "stop_for_approval_boundary_review") return "approval_boundary_review_required";
  return "candidate_revision_required";
}

function dispositionForState(
  state: OIValidationFinalizerDecisionState,
): OIValidationFinalizerDecisionPacket["disposition"] {
  if (state === "ready_for_next_source_step") return "advance_source_only";
  if (state === "operator_decision_conflict") return "resolve_conflict";
  if (state === "collect_more_validation_evidence") return "collect_evidence";
  if (state === "approval_boundary_review_required") return "stop_for_boundary_review";
  if (state === "candidate_revision_required") return "revise_candidate";
  return "wait";
}

function blockersForState(
  state: OIValidationFinalizerDecisionState,
  evidence: OIValidationOperatorDecisionEvidencePacket,
): string[] {
  if (state === "ready_for_next_source_step") return [];
  if (state === "collect_more_validation_evidence") return ["operator requested additional validation evidence"];
  if (state === "approval_boundary_review_required") return ["operator decision requires approval-boundary review"];
  if (state === "candidate_revision_required") return ["operator decision requires candidate revision before another review"];
  return evidence.blockers;
}

function nextActionsForState(state: OIValidationFinalizerDecisionState): string[] {
  if (state === "ready_for_next_source_step") {
    return ["record finalizer source-only advancement decision", "open the next source-only planning packet if needed"];
  }
  if (state === "waiting_for_operator_decision") return ["collect explicit operator decision evidence"];
  if (state === "operator_decision_conflict") return ["reconcile conflicting operator decision evidence"];
  if (state === "operator_decision_blocked") return ["resolve the blocked operator decision evidence before finalizer closeout"];
  if (state === "collect_more_validation_evidence") return ["collect paired validation evidence", "rebuild validation score chain"];
  if (state === "approval_boundary_review_required") return ["stop validation closeout", "request separate approval-boundary review"];
  return ["revise candidate metrics or implementation", "rerun validation operator review request"];
}

function stableId(prefix: string, value: unknown): string {
  return `${prefix}-${createHash("sha256").update(stableStringify(value)).digest("hex").slice(0, 24)}`;
}
