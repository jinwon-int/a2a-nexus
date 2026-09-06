import { createHash } from "node:crypto";

import {
  buildOIRuntimeDesignReviewPacket,
  type OIRuntimeDesignReviewPacket,
} from "./orchestration-intelligence-runtime-design-review.js";
import type { OIRuntimeReadinessEvidence } from "./orchestration-intelligence-runtime-readiness-gate.js";
import { stableStringify } from "./value-guards.js";

export type OIRuntimeApprovalRequestState =
  | "approval_request_ready"
  | "approval_request_incomplete"
  | "runtime_design_review_not_ready"
  | "approval_boundary_review_required"
  | "candidate_revision_required";

export interface OIRuntimeApprovalRequestEvidence {
  requiredApprovalPhrase?: string;
  approverIdentityDocumented?: boolean;
  requestScopeDocumented?: boolean;
  approvalConditionsDocumented?: boolean;
  riskSummaryDocumented?: boolean;
  rollbackAbortCriteriaReferenced?: boolean;
  liveBoundaryPlanReferenced?: boolean;
  expiryOrRevocationDocumented?: boolean;
}

export interface OIRuntimeApprovalRequestInput {
  generatedAt?: string;
  runId?: string;
  requester?: string;
  operator?: string;
  runtimeDesignReview?: OIRuntimeDesignReviewPacket;
  approvalEvidence?: OIRuntimeApprovalRequestEvidence;
  notes?: string[];
}

export interface OIRuntimeApprovalRequestCheck {
  id:
    | "runtime_design_review_ready"
    | "required_approval_phrase_documented"
    | "approver_identity_documented"
    | "request_scope_documented"
    | "approval_conditions_documented"
    | "risk_summary_documented"
    | "rollback_abort_criteria_referenced"
    | "live_boundary_plan_referenced"
    | "expiry_or_revocation_documented";
  status: "pass" | "fail" | "review";
  summary: string;
}

export interface OIRuntimeApprovalRequestPacket {
  kind: "a2a-broker.orchestration-intelligence.runtime-approval-request.packet";
  version: 1;
  generatedAt: string;
  runId: string;
  requester: string;
  operator: string;
  sourceOnly: true;
  idempotencyKey: string;
  runtimeDesignReviewIdempotencyKey: string;
  runtimeReadinessGateIdempotencyKey: string;
  finalizerDecisionIdempotencyKey: string;
  operatorDecisionEvidenceIdempotencyKey: string;
  reviewRequestIdempotencyKey: string;
  finalizerReviewIdempotencyKey: string;
  scoreIdempotencyKey: string;
  frameworkIdempotencyKey: string;
  roadmap: OIRuntimeDesignReviewPacket["roadmap"];
  state: OIRuntimeApprovalRequestState;
  disposition:
    | "request_explicit_runtime_approval_evidence"
    | "collect_approval_request_evidence"
    | "wait_for_runtime_design_review"
    | "stop_for_approval_boundary"
    | "revise_candidate";
  checks: OIRuntimeApprovalRequestCheck[];
  blockers: string[];
  nextActions: string[];
  notes: string[];
  approvalRequest: {
    requestedApprovalPhrase: string;
    operator: string;
    scope: string[];
    requiredConditions: string[];
    nonGoals: string[];
    evidenceFieldsRequiredForFutureApproval: string[];
  };
  runtimeReadinessEvidencePatch: Required<OIRuntimeReadinessEvidence>;
  safety: {
    runtimeApprovalRequestOnly: true;
    sourceOnly: true;
    grantsExecutionApproval: false;
    approvalGranted: false;
    explicitRuntimeApprovalPresent: false;
    runtimeExecutorCreated: false;
    runtimeExecutorEnabled: false;
    brokerDispatchCreated: false;
    workerSpawned: false;
    mobilebetaScopeExpanded: false;
    providerSend: false;
    terminalAckReplay: false;
    dbMutation: false;
    deployOrRestart: false;
    credentialMovement: false;
    releasePublished: false;
  };
}

export function buildOIRuntimeApprovalRequestPacket(
  input: OIRuntimeApprovalRequestInput = {},
): OIRuntimeApprovalRequestPacket {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const runtimeDesignReview = input.runtimeDesignReview ?? buildOIRuntimeDesignReviewPacket({ generatedAt });
  const runId = input.runId ?? `${runtimeDesignReview.runId}-runtime-approval-request`;
  const requester = input.requester ?? "broker-finalizer";
  const operator = input.operator ?? "human-operator";
  const approvalEvidence = input.approvalEvidence ?? {};
  const checks = buildChecks(runtimeDesignReview, approvalEvidence);
  const state = stateFor(runtimeDesignReview, checks);

  return {
    kind: "a2a-broker.orchestration-intelligence.runtime-approval-request.packet",
    version: 1,
    generatedAt,
    runId,
    requester,
    operator,
    sourceOnly: true,
    idempotencyKey: stableId("oi-runtime-approval-request", {
      runId,
      requester,
      operator,
      runtimeDesignReview: runtimeDesignReview.idempotencyKey,
      approvalEvidence,
      state,
    }),
    runtimeDesignReviewIdempotencyKey: runtimeDesignReview.idempotencyKey,
    runtimeReadinessGateIdempotencyKey: runtimeDesignReview.runtimeReadinessGateIdempotencyKey,
    finalizerDecisionIdempotencyKey: runtimeDesignReview.finalizerDecisionIdempotencyKey,
    operatorDecisionEvidenceIdempotencyKey: runtimeDesignReview.operatorDecisionEvidenceIdempotencyKey,
    reviewRequestIdempotencyKey: runtimeDesignReview.reviewRequestIdempotencyKey,
    finalizerReviewIdempotencyKey: runtimeDesignReview.finalizerReviewIdempotencyKey,
    scoreIdempotencyKey: runtimeDesignReview.scoreIdempotencyKey,
    frameworkIdempotencyKey: runtimeDesignReview.frameworkIdempotencyKey,
    roadmap: runtimeDesignReview.roadmap,
    state,
    disposition: dispositionForState(state),
    checks,
    blockers: blockersForChecks(checks),
    nextActions: nextActionsForState(state),
    notes: input.notes ?? [],
    approvalRequest: approvalRequestFor(operator, approvalEvidence.requiredApprovalPhrase),
    runtimeReadinessEvidencePatch: evidencePatchForState(state),
    safety: {
      runtimeApprovalRequestOnly: true,
      sourceOnly: true,
      grantsExecutionApproval: false,
      approvalGranted: false,
      explicitRuntimeApprovalPresent: false,
      runtimeExecutorCreated: false,
      runtimeExecutorEnabled: false,
      brokerDispatchCreated: false,
      workerSpawned: false,
      mobilebetaScopeExpanded: false,
      providerSend: false,
      terminalAckReplay: false,
      dbMutation: false,
      deployOrRestart: false,
      credentialMovement: false,
      releasePublished: false,
    },
  };
}

export function renderOIRuntimeApprovalRequestMarkdown(packet: OIRuntimeApprovalRequestPacket): string {
  return [
    "A2A Orchestration Intelligence v2 explicit runtime approval request",
    `Roadmap: #${packet.roadmap.issueNumber}`,
    `State: ${packet.state}`,
    `Disposition: ${packet.disposition}`,
    `Requester: ${packet.requester}`,
    `Operator: ${packet.operator}`,
    "Approval request checks:",
    ...packet.checks.map((check) => `- ${check.id}: ${check.status} - ${check.summary}`),
    "Requested approval phrase:",
    `- ${packet.approvalRequest.requestedApprovalPhrase}`,
    "Required conditions:",
    ...packet.approvalRequest.requiredConditions.map((condition) => `- ${condition}`),
    "Runtime readiness evidence patch:",
    ...Object.entries(packet.runtimeReadinessEvidencePatch).map(([key, value]) => `- ${key}: ${value}`),
    "Blockers:",
    ...(packet.blockers.length ? packet.blockers.map((blocker) => `- ${blocker}`) : ["- none"]),
    "Next actions:",
    ...packet.nextActions.map((action) => `- ${action}`),
    "Safety: source-only runtime approval request. It documents the exact approval phrase and evidence fields for a future operator decision, but does not grant approval, enable or create a runtime executor, create broker dispatch, spawn workers, expand mobilebeta/mobile scope, send providers, ACK/replay Terminal rows, mutate DB state, deploy/restart services, publish releases, or move credentials.",
  ].join("\n");
}

function buildChecks(
  runtimeDesignReview: OIRuntimeDesignReviewPacket,
  evidence: OIRuntimeApprovalRequestEvidence,
): OIRuntimeApprovalRequestCheck[] {
  const designReady = runtimeDesignReview.state === "design_review_ready"
    && runtimeDesignReview.runtimeReadinessEvidencePatch.runtimeExecutorDesignReviewed === true;
  return [
    {
      id: "runtime_design_review_ready",
      status: designReady ? "pass" : "fail",
      summary: designReady
        ? "runtime design review is recorded as source-only evidence"
        : `runtime design review is ${runtimeDesignReview.state}`,
    },
    {
      id: "required_approval_phrase_documented",
      status: requiredPhraseReady(evidence.requiredApprovalPhrase) ? "pass" : "fail",
      summary: requiredPhraseReady(evidence.requiredApprovalPhrase)
        ? "operator approval phrase is explicit and scoped"
        : "operator approval phrase is missing or too vague",
    },
    boolCheck(
      "approver_identity_documented",
      evidence.approverIdentityDocumented,
      "operator identity requirement is documented",
      "operator identity requirement is missing",
    ),
    boolCheck(
      "request_scope_documented",
      evidence.requestScopeDocumented,
      "runtime approval request scope is documented",
      "runtime approval request scope is missing",
    ),
    boolCheck(
      "approval_conditions_documented",
      evidence.approvalConditionsDocumented,
      "approval conditions are documented",
      "approval conditions are missing",
    ),
    boolCheck(
      "risk_summary_documented",
      evidence.riskSummaryDocumented,
      "risk summary is documented",
      "risk summary is missing",
    ),
    boolCheck(
      "rollback_abort_criteria_referenced",
      evidence.rollbackAbortCriteriaReferenced,
      "rollback and abort criteria are referenced without executing them",
      "rollback and abort criteria reference is missing",
    ),
    boolCheck(
      "live_boundary_plan_referenced",
      evidence.liveBoundaryPlanReferenced,
      "live boundary plan is referenced without live actions",
      "live boundary plan reference is missing",
    ),
    boolCheck(
      "expiry_or_revocation_documented",
      evidence.expiryOrRevocationDocumented,
      "approval expiry or revocation conditions are documented",
      "approval expiry or revocation conditions are missing",
    ),
  ];
}

function boolCheck(
  id: OIRuntimeApprovalRequestCheck["id"],
  value: boolean | undefined,
  passSummary: string,
  failSummary: string,
): OIRuntimeApprovalRequestCheck {
  return {
    id,
    status: value === true ? "pass" : "fail",
    summary: value === true ? passSummary : failSummary,
  };
}

function stateFor(
  runtimeDesignReview: OIRuntimeDesignReviewPacket,
  checks: OIRuntimeApprovalRequestCheck[],
): OIRuntimeApprovalRequestState {
  if (runtimeDesignReview.state === "approval_boundary_review_required") return "approval_boundary_review_required";
  if (runtimeDesignReview.state === "candidate_revision_required") return "candidate_revision_required";
  const designReady = checks.some((check) => check.id === "runtime_design_review_ready" && check.status === "pass");
  if (!designReady) return "runtime_design_review_not_ready";
  return checks.every((check) => check.status === "pass")
    ? "approval_request_ready"
    : "approval_request_incomplete";
}

function dispositionForState(
  state: OIRuntimeApprovalRequestState,
): OIRuntimeApprovalRequestPacket["disposition"] {
  if (state === "approval_request_ready") return "request_explicit_runtime_approval_evidence";
  if (state === "runtime_design_review_not_ready") return "wait_for_runtime_design_review";
  if (state === "approval_boundary_review_required") return "stop_for_approval_boundary";
  if (state === "candidate_revision_required") return "revise_candidate";
  return "collect_approval_request_evidence";
}

function evidencePatchForState(state: OIRuntimeApprovalRequestState): Required<OIRuntimeReadinessEvidence> {
  return {
    runtimeExecutorDesignReviewed: state === "approval_request_ready",
    explicitRuntimeApprovalPresent: false,
    brokerDispatchApprovalPresent: false,
    workerSpawnApprovalPresent: false,
    mobilebetaMobileScopeResolved: false,
    rollbackAbortCriteriaDocumented: false,
    liveBoundaryPlanDocumented: false,
    validationEvidenceFresh: state === "approval_request_ready",
  };
}

function blockersForChecks(checks: OIRuntimeApprovalRequestCheck[]): string[] {
  return checks
    .filter((check) => check.status !== "pass")
    .map((check) => `${check.id}: ${check.summary}`);
}

function nextActionsForState(state: OIRuntimeApprovalRequestState): string[] {
  if (state === "approval_request_ready") {
    return [
      "present the explicit runtime approval request to the operator as a separate approval gate",
      "record any operator response in a future source-only approval decision evidence packet",
      "keep runtime executor, broker dispatch, worker spawn, and mobilebeta/mobile scope expansion disabled until later gates pass",
    ];
  }
  if (state === "runtime_design_review_not_ready") return ["complete runtime design review before requesting approval"];
  if (state === "approval_boundary_review_required") return ["stop runtime progression", "request separate approval-boundary review"];
  if (state === "candidate_revision_required") return ["revise candidate and rerun validation packets"];
  return ["collect missing approval request evidence", "keep runtime approval absent"];
}

function approvalRequestFor(operator: string, phrase: string | undefined): OIRuntimeApprovalRequestPacket["approvalRequest"] {
  return {
    requestedApprovalPhrase: phrase ?? "APPROVE OI V2 RUNTIME APPROVAL REQUEST FOR SOURCE-ONLY EVIDENCE REVIEW",
    operator,
    scope: [
      "record explicit operator approval evidence in a future source-only packet",
      "keep runtime executor implementation and enablement in separate future work",
      "keep broker dispatch, worker spawn, and mobilebeta/mobile scope expansion as independent gates",
    ],
    requiredConditions: [
      "operator identity must be recorded without secrets",
      "approval phrase must match the requested phrase exactly or be superseded by a stricter phrase",
      "approval must name the repository and issue context",
      "approval must not authorize deploy, restart, DB mutation, live provider send, Terminal ACK/replay, release publish, or credential movement",
      "approval may be revoked or expired before any later runtime enablement step",
    ],
    nonGoals: [
      "runtime executor enablement",
      "broker dispatch creation",
      "worker spawn",
      "mobilebeta/mobile scope expansion",
      "live provider or Telegram canary",
      "deploy, restart, DB mutation, Terminal ACK/replay, release publish, or credential movement",
    ],
    evidenceFieldsRequiredForFutureApproval: [
      "operator",
      "approvalPhrase",
      "approvedAt",
      "repo",
      "issueNumber",
      "scope",
      "conditions",
      "revocationOrExpiry",
    ],
  };
}

function requiredPhraseReady(phrase: string | undefined): boolean {
  if (!phrase) return false;
  const normalized = phrase.trim().toLowerCase();
  return normalized.includes("approve")
    && normalized.includes("runtime")
    && normalized.includes("source-only")
    && normalized.length >= 32;
}

function stableId(prefix: string, value: unknown): string {
  return `${prefix}-${createHash("sha256").update(stableStringify(value)).digest("hex").slice(0, 24)}`;
}
