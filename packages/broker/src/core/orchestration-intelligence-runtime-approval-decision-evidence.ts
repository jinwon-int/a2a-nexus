import { createHash } from "node:crypto";

import {
  buildOIRuntimeApprovalRequestPacket,
  type OIRuntimeApprovalRequestPacket,
} from "./orchestration-intelligence-runtime-approval-request.js";
import type { OIRuntimeReadinessEvidence } from "./orchestration-intelligence-runtime-readiness-gate.js";

export type OIRuntimeApprovalDecisionEvidenceState =
  | "approval_evidence_accepted"
  | "approval_evidence_missing"
  | "approval_evidence_rejected"
  | "approval_evidence_expired"
  | "approval_evidence_conflicting"
  | "approval_evidence_invalid"
  | "approval_request_not_ready"
  | "approval_boundary_review_required"
  | "candidate_revision_required";

export type OIRuntimeApprovalDecisionKind =
  | "approval_grant"
  | "rejected"
  | "expired"
  | "conflict";

export interface OIRuntimeApprovalDecisionEvidence {
  kind?: OIRuntimeApprovalDecisionKind;
  operator?: string;
  approvalPhrase?: string;
  approvedAt?: string;
  expiresAt?: string;
  repo?: string;
  issueNumber?: number;
  scope?: string[];
  conditions?: string[];
  conditionsAccepted?: boolean;
  revocationOrExpiry?: string;
  rationale?: string;
}

export interface OIRuntimeApprovalDecisionEvidenceInput {
  generatedAt?: string;
  runId?: string;
  recorder?: string;
  expectedRepo?: string;
  expectedIssueNumber?: number;
  runtimeApprovalRequest?: OIRuntimeApprovalRequestPacket;
  decisionEvidence?: OIRuntimeApprovalDecisionEvidence;
  notes?: string[];
}

export interface OIRuntimeApprovalDecisionEvidenceCheck {
  id:
    | "approval_request_ready"
    | "decision_kind_is_approval_grant"
    | "operator_matches_request"
    | "approval_phrase_matches_request"
    | "approved_at_valid"
    | "approval_not_expired"
    | "repo_and_issue_match"
    | "scope_matches_request"
    | "conditions_accepted"
    | "revocation_or_expiry_documented";
  status: "pass" | "fail" | "review";
  summary: string;
}

export interface OIRuntimeApprovalDecisionEvidencePacket {
  kind: "a2a-broker.orchestration-intelligence.runtime-approval-decision-evidence.packet";
  version: 1;
  generatedAt: string;
  runId: string;
  recorder: string;
  sourceOnly: true;
  idempotencyKey: string;
  runtimeApprovalRequestIdempotencyKey: string;
  runtimeDesignReviewIdempotencyKey: string;
  runtimeReadinessGateIdempotencyKey: string;
  finalizerDecisionIdempotencyKey: string;
  operatorDecisionEvidenceIdempotencyKey: string;
  reviewRequestIdempotencyKey: string;
  finalizerReviewIdempotencyKey: string;
  scoreIdempotencyKey: string;
  frameworkIdempotencyKey: string;
  roadmap: OIRuntimeApprovalRequestPacket["roadmap"];
  state: OIRuntimeApprovalDecisionEvidenceState;
  disposition:
    | "record_explicit_runtime_approval_evidence"
    | "wait_for_operator_response"
    | "record_runtime_rejection"
    | "record_runtime_expiry"
    | "stop_for_conflict_resolution"
    | "reject_invalid_approval_evidence"
    | "wait_for_approval_request"
    | "stop_for_approval_boundary"
    | "revise_candidate";
  checks: OIRuntimeApprovalDecisionEvidenceCheck[];
  blockers: string[];
  nextActions: string[];
  notes: string[];
  acceptedDecisionEvidence: {
    operator: string;
    approvalPhrase: string;
    approvedAt: string;
    repo: string;
    issueNumber: number;
    revocationOrExpiry: string;
  } | null;
  runtimeReadinessEvidencePatch: Required<OIRuntimeReadinessEvidence>;
  safety: {
    runtimeApprovalDecisionEvidenceOnly: true;
    sourceOnly: true;
    grantsExecutionApproval: false;
    approvalEvidenceAccepted: boolean;
    runtimeExecutorCreated: false;
    runtimeExecutorEnabled: false;
    brokerDispatchCreated: false;
    workerSpawned: false;
    daegyoScopeExpanded: false;
    providerSend: false;
    terminalAckReplay: false;
    dbMutation: false;
    deployOrRestart: false;
    credentialMovement: false;
    releasePublished: false;
  };
}

export function buildOIRuntimeApprovalDecisionEvidencePacket(
  input: OIRuntimeApprovalDecisionEvidenceInput = {},
): OIRuntimeApprovalDecisionEvidencePacket {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const runtimeApprovalRequest =
    input.runtimeApprovalRequest ?? buildOIRuntimeApprovalRequestPacket({ generatedAt });
  const runId = input.runId ?? `${runtimeApprovalRequest.runId}-runtime-approval-decision-evidence`;
  const recorder = input.recorder ?? "broker-finalizer";
  const expectedRepo = input.expectedRepo ?? "jinwon-int/a2a-broker";
  const expectedIssueNumber = input.expectedIssueNumber ?? runtimeApprovalRequest.roadmap.issueNumber;
  const decisionEvidence = input.decisionEvidence;
  const checks = buildChecks({
    generatedAt,
    runtimeApprovalRequest,
    decisionEvidence,
    expectedRepo,
    expectedIssueNumber,
  });
  const state = stateFor(runtimeApprovalRequest, decisionEvidence, checks);

  return {
    kind: "a2a-broker.orchestration-intelligence.runtime-approval-decision-evidence.packet",
    version: 1,
    generatedAt,
    runId,
    recorder,
    sourceOnly: true,
    idempotencyKey: stableId("oi-runtime-approval-decision-evidence", {
      runId,
      recorder,
      expectedRepo,
      expectedIssueNumber,
      runtimeApprovalRequest: runtimeApprovalRequest.idempotencyKey,
      decisionEvidence,
      state,
    }),
    runtimeApprovalRequestIdempotencyKey: runtimeApprovalRequest.idempotencyKey,
    runtimeDesignReviewIdempotencyKey: runtimeApprovalRequest.runtimeDesignReviewIdempotencyKey,
    runtimeReadinessGateIdempotencyKey: runtimeApprovalRequest.runtimeReadinessGateIdempotencyKey,
    finalizerDecisionIdempotencyKey: runtimeApprovalRequest.finalizerDecisionIdempotencyKey,
    operatorDecisionEvidenceIdempotencyKey: runtimeApprovalRequest.operatorDecisionEvidenceIdempotencyKey,
    reviewRequestIdempotencyKey: runtimeApprovalRequest.reviewRequestIdempotencyKey,
    finalizerReviewIdempotencyKey: runtimeApprovalRequest.finalizerReviewIdempotencyKey,
    scoreIdempotencyKey: runtimeApprovalRequest.scoreIdempotencyKey,
    frameworkIdempotencyKey: runtimeApprovalRequest.frameworkIdempotencyKey,
    roadmap: runtimeApprovalRequest.roadmap,
    state,
    disposition: dispositionForState(state),
    checks,
    blockers: blockersForState(state, checks),
    nextActions: nextActionsForState(state),
    notes: input.notes ?? [],
    acceptedDecisionEvidence: acceptedDecisionForState(
      state,
      decisionEvidence,
      expectedRepo,
      expectedIssueNumber,
    ),
    runtimeReadinessEvidencePatch: evidencePatchForState(state),
    safety: {
      runtimeApprovalDecisionEvidenceOnly: true,
      sourceOnly: true,
      grantsExecutionApproval: false,
      approvalEvidenceAccepted: state === "approval_evidence_accepted",
      runtimeExecutorCreated: false,
      runtimeExecutorEnabled: false,
      brokerDispatchCreated: false,
      workerSpawned: false,
      daegyoScopeExpanded: false,
      providerSend: false,
      terminalAckReplay: false,
      dbMutation: false,
      deployOrRestart: false,
      credentialMovement: false,
      releasePublished: false,
    },
  };
}

export function renderOIRuntimeApprovalDecisionEvidenceMarkdown(
  packet: OIRuntimeApprovalDecisionEvidencePacket,
): string {
  return [
    "A2A Orchestration Intelligence v2 runtime approval decision evidence",
    `Roadmap: #${packet.roadmap.issueNumber}`,
    `State: ${packet.state}`,
    `Disposition: ${packet.disposition}`,
    `Recorder: ${packet.recorder}`,
    "Decision checks:",
    ...packet.checks.map((check) => `- ${check.id}: ${check.status} - ${check.summary}`),
    "Accepted evidence:",
    ...(packet.acceptedDecisionEvidence
      ? Object.entries(packet.acceptedDecisionEvidence).map(([key, value]) => `- ${key}: ${value}`)
      : ["- none"]),
    "Runtime readiness evidence patch:",
    ...Object.entries(packet.runtimeReadinessEvidencePatch).map(([key, value]) => `- ${key}: ${value}`),
    "Blockers:",
    ...(packet.blockers.length ? packet.blockers.map((blocker) => `- ${blocker}`) : ["- none"]),
    "Next actions:",
    ...packet.nextActions.map((action) => `- ${action}`),
    "Safety: source-only runtime approval decision evidence. It may record explicit approval evidence for a later readiness gate, but it does not grant execution approval, enable or create a runtime executor, create broker dispatch, spawn workers, expand Daegyo/mobile scope, send providers, ACK/replay Terminal rows, mutate DB state, deploy/restart services, publish releases, or move credentials.",
  ].join("\n");
}

function buildChecks(input: {
  generatedAt: string;
  runtimeApprovalRequest: OIRuntimeApprovalRequestPacket;
  decisionEvidence: OIRuntimeApprovalDecisionEvidence | undefined;
  expectedRepo: string;
  expectedIssueNumber: number;
}): OIRuntimeApprovalDecisionEvidenceCheck[] {
  const requestReady = input.runtimeApprovalRequest.state === "approval_request_ready";
  const evidence = input.decisionEvidence;
  return [
    {
      id: "approval_request_ready",
      status: requestReady ? "pass" : "fail",
      summary: requestReady
        ? "runtime approval request is ready for an operator response"
        : `runtime approval request is ${input.runtimeApprovalRequest.state}`,
    },
    {
      id: "decision_kind_is_approval_grant",
      status: evidence?.kind === "approval_grant" ? "pass" : "fail",
      summary: evidence?.kind === "approval_grant"
        ? "operator response is an approval grant evidence record"
        : `operator response is ${evidence?.kind ?? "missing"}`,
    },
    {
      id: "operator_matches_request",
      status: evidence?.operator === input.runtimeApprovalRequest.operator ? "pass" : "fail",
      summary: evidence?.operator === input.runtimeApprovalRequest.operator
        ? "operator matches the approval request"
        : "operator is missing or does not match the approval request",
    },
    {
      id: "approval_phrase_matches_request",
      status: evidence?.approvalPhrase === input.runtimeApprovalRequest.approvalRequest.requestedApprovalPhrase
        ? "pass"
        : "fail",
      summary: evidence?.approvalPhrase === input.runtimeApprovalRequest.approvalRequest.requestedApprovalPhrase
        ? "approval phrase exactly matches the requested phrase"
        : "approval phrase is missing or does not exactly match",
    },
    {
      id: "approved_at_valid",
      status: approvedAtValid(evidence?.approvedAt, input.generatedAt) ? "pass" : "fail",
      summary: approvedAtValid(evidence?.approvedAt, input.generatedAt)
        ? "approvedAt is parseable and not in the future"
        : "approvedAt is missing, invalid, or in the future",
    },
    {
      id: "approval_not_expired",
      status: approvalNotExpired(evidence?.expiresAt, input.generatedAt) ? "pass" : "fail",
      summary: approvalNotExpired(evidence?.expiresAt, input.generatedAt)
        ? "approval is not expired at packet generation time"
        : "approval is expired or expiry is invalid",
    },
    {
      id: "repo_and_issue_match",
      status: evidence?.repo === input.expectedRepo && evidence?.issueNumber === input.expectedIssueNumber
        ? "pass"
        : "fail",
      summary: evidence?.repo === input.expectedRepo && evidence?.issueNumber === input.expectedIssueNumber
        ? "approval evidence names the expected repository and issue context"
        : "approval evidence does not name the expected repository and issue context",
    },
    {
      id: "scope_matches_request",
      status: scopeMatches(input.runtimeApprovalRequest.approvalRequest.scope, evidence?.scope) ? "pass" : "fail",
      summary: scopeMatches(input.runtimeApprovalRequest.approvalRequest.scope, evidence?.scope)
        ? "approval evidence scope covers the requested scope"
        : "approval evidence scope is missing or does not cover the requested scope",
    },
    {
      id: "conditions_accepted",
      status: evidence?.conditionsAccepted === true && coversAll(input.runtimeApprovalRequest.approvalRequest.requiredConditions, evidence.conditions)
        ? "pass"
        : "fail",
      summary: evidence?.conditionsAccepted === true && coversAll(input.runtimeApprovalRequest.approvalRequest.requiredConditions, evidence.conditions)
        ? "approval conditions are explicitly accepted"
        : "approval conditions are missing or not explicitly accepted",
    },
    {
      id: "revocation_or_expiry_documented",
      status: typeof evidence?.revocationOrExpiry === "string" && evidence.revocationOrExpiry.trim().length > 0
        ? "pass"
        : "fail",
      summary: typeof evidence?.revocationOrExpiry === "string" && evidence.revocationOrExpiry.trim().length > 0
        ? "revocation or expiry rule is documented"
        : "revocation or expiry rule is missing",
    },
  ];
}

function stateFor(
  runtimeApprovalRequest: OIRuntimeApprovalRequestPacket,
  evidence: OIRuntimeApprovalDecisionEvidence | undefined,
  checks: OIRuntimeApprovalDecisionEvidenceCheck[],
): OIRuntimeApprovalDecisionEvidenceState {
  if (runtimeApprovalRequest.state === "approval_boundary_review_required") return "approval_boundary_review_required";
  if (runtimeApprovalRequest.state === "candidate_revision_required") return "candidate_revision_required";
  if (runtimeApprovalRequest.state !== "approval_request_ready") return "approval_request_not_ready";
  if (!evidence) return "approval_evidence_missing";
  if (evidence.kind === "rejected") return "approval_evidence_rejected";
  if (evidence.kind === "expired") return "approval_evidence_expired";
  if (evidence.kind === "conflict") return "approval_evidence_conflicting";
  if (checks.every((check) => check.status === "pass")) return "approval_evidence_accepted";
  return "approval_evidence_invalid";
}

function dispositionForState(
  state: OIRuntimeApprovalDecisionEvidenceState,
): OIRuntimeApprovalDecisionEvidencePacket["disposition"] {
  if (state === "approval_evidence_accepted") return "record_explicit_runtime_approval_evidence";
  if (state === "approval_evidence_missing") return "wait_for_operator_response";
  if (state === "approval_evidence_rejected") return "record_runtime_rejection";
  if (state === "approval_evidence_expired") return "record_runtime_expiry";
  if (state === "approval_evidence_conflicting") return "stop_for_conflict_resolution";
  if (state === "approval_request_not_ready") return "wait_for_approval_request";
  if (state === "approval_boundary_review_required") return "stop_for_approval_boundary";
  if (state === "candidate_revision_required") return "revise_candidate";
  return "reject_invalid_approval_evidence";
}

function blockersForState(
  state: OIRuntimeApprovalDecisionEvidenceState,
  checks: OIRuntimeApprovalDecisionEvidenceCheck[],
): string[] {
  if (state === "approval_evidence_rejected") return ["operator response rejected runtime approval"];
  if (state === "approval_evidence_expired") return ["operator approval evidence is expired"];
  if (state === "approval_evidence_conflicting") return ["conflicting operator approval evidence requires manual resolution"];
  return checks
    .filter((check) => check.status !== "pass")
    .map((check) => `${check.id}: ${check.summary}`);
}

function nextActionsForState(state: OIRuntimeApprovalDecisionEvidenceState): string[] {
  if (state === "approval_evidence_accepted") {
    return [
      "feed explicitRuntimeApprovalPresent=true into a later runtime readiness gate review",
      "keep broker dispatch approval, worker spawn approval, Daegyo/mobile scope resolution, rollback/live readiness, and executor enablement as separate gates",
    ];
  }
  if (state === "approval_evidence_missing") return ["wait for a scoped operator response to the runtime approval request"];
  if (state === "approval_evidence_rejected") return ["record rejection and keep runtime approval absent"];
  if (state === "approval_evidence_expired") return ["refresh approval request before considering runtime approval"];
  if (state === "approval_evidence_conflicting") return ["resolve conflicting operator evidence before proceeding"];
  if (state === "approval_request_not_ready") return ["complete runtime approval request packet before ingesting decision evidence"];
  if (state === "approval_boundary_review_required") return ["stop runtime progression", "request separate approval-boundary review"];
  if (state === "candidate_revision_required") return ["revise candidate and rerun validation packets"];
  return ["collect corrected operator approval evidence", "keep runtime approval absent"];
}

function evidencePatchForState(state: OIRuntimeApprovalDecisionEvidenceState): Required<OIRuntimeReadinessEvidence> {
  return {
    runtimeExecutorDesignReviewed: state === "approval_evidence_accepted",
    explicitRuntimeApprovalPresent: state === "approval_evidence_accepted",
    brokerDispatchApprovalPresent: false,
    workerSpawnApprovalPresent: false,
    daegyoMobileScopeResolved: false,
    rollbackAbortCriteriaDocumented: false,
    liveBoundaryPlanDocumented: false,
    validationEvidenceFresh: state === "approval_evidence_accepted",
  };
}

function acceptedDecisionForState(
  state: OIRuntimeApprovalDecisionEvidenceState,
  evidence: OIRuntimeApprovalDecisionEvidence | undefined,
  expectedRepo: string,
  expectedIssueNumber: number,
): OIRuntimeApprovalDecisionEvidencePacket["acceptedDecisionEvidence"] {
  if (state !== "approval_evidence_accepted" || !evidence) return null;
  return {
    operator: evidence.operator ?? "",
    approvalPhrase: evidence.approvalPhrase ?? "",
    approvedAt: evidence.approvedAt ?? "",
    repo: evidence.repo ?? expectedRepo,
    issueNumber: evidence.issueNumber ?? expectedIssueNumber,
    revocationOrExpiry: evidence.revocationOrExpiry ?? "",
  };
}

function approvedAtValid(approvedAt: string | undefined, generatedAt: string): boolean {
  const approved = Date.parse(approvedAt ?? "");
  const generated = Date.parse(generatedAt);
  return Number.isFinite(approved) && Number.isFinite(generated) && approved <= generated;
}

function approvalNotExpired(expiresAt: string | undefined, generatedAt: string): boolean {
  if (!expiresAt) return true;
  const expiry = Date.parse(expiresAt);
  const generated = Date.parse(generatedAt);
  return Number.isFinite(expiry) && Number.isFinite(generated) && expiry > generated;
}

function scopeMatches(required: string[], supplied: string[] | undefined): boolean {
  return coversAll(required, supplied);
}

function coversAll(required: string[], supplied: string[] | undefined): boolean {
  if (!supplied?.length) return false;
  const suppliedSet = new Set(supplied.map((item) => item.trim()));
  return required.every((item) => suppliedSet.has(item));
}

function stableId(prefix: string, value: unknown): string {
  return `${prefix}-${createHash("sha256").update(stableStringify(value)).digest("hex").slice(0, 24)}`;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}
