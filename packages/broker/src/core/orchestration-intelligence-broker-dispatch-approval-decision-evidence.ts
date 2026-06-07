import { createHash } from "node:crypto";

import {
  buildOIBrokerDispatchApprovalRequestPacket,
  type OIBrokerDispatchApprovalRequestPacket,
} from "./orchestration-intelligence-broker-dispatch-approval-request.js";
import type { OIRuntimeReadinessEvidence } from "./orchestration-intelligence-runtime-readiness-gate.js";

export type OIBrokerDispatchApprovalDecisionEvidenceState =
  | "broker_dispatch_approval_evidence_accepted"
  | "broker_dispatch_approval_evidence_missing"
  | "broker_dispatch_approval_evidence_rejected"
  | "broker_dispatch_approval_evidence_expired"
  | "broker_dispatch_approval_evidence_conflicting"
  | "broker_dispatch_approval_evidence_invalid"
  | "broker_dispatch_approval_request_not_ready"
  | "broker_dispatch_boundary_review_required"
  | "broker_dispatch_candidate_revision_required";

export type OIBrokerDispatchApprovalDecisionKind =
  | "approval_grant"
  | "rejected"
  | "expired"
  | "conflict";

export interface OIBrokerDispatchApprovalDecisionEvidence {
  kind?: OIBrokerDispatchApprovalDecisionKind;
  operator?: string;
  approvalPhrase?: string;
  approvedAt?: string;
  expiresAt?: string;
  targetRepo?: string;
  targetIssueNumber?: number;
  dispatchScope?: string[];
  conditions?: string[];
  conditionsAccepted?: boolean;
  revocationOrExpiry?: string;
  rationale?: string;
}

export interface OIBrokerDispatchApprovalDecisionEvidenceInput {
  generatedAt?: string;
  runId?: string;
  recorder?: string;
  expectedRepo?: string;
  expectedIssueNumber?: number;
  brokerDispatchApprovalRequest?: OIBrokerDispatchApprovalRequestPacket;
  decisionEvidence?: OIBrokerDispatchApprovalDecisionEvidence;
  notes?: string[];
}

export interface OIBrokerDispatchApprovalDecisionEvidenceCheck {
  id:
    | "broker_dispatch_approval_request_ready"
    | "decision_kind_is_approval_grant"
    | "operator_matches_request"
    | "approval_phrase_matches_request"
    | "approved_at_valid"
    | "approval_not_expired"
    | "target_repo_and_issue_match"
    | "dispatch_scope_matches_request"
    | "conditions_accepted"
    | "revocation_or_expiry_documented";
  status: "pass" | "fail" | "review";
  summary: string;
}

export interface OIBrokerDispatchApprovalDecisionEvidencePacket {
  kind: "a2a-broker.orchestration-intelligence.broker-dispatch-approval-decision-evidence.packet";
  version: 1;
  generatedAt: string;
  runId: string;
  recorder: string;
  sourceOnly: true;
  idempotencyKey: string;
  brokerDispatchApprovalRequestIdempotencyKey: string;
  runtimeApprovalDecisionEvidenceIdempotencyKey: string;
  runtimeApprovalRequestIdempotencyKey: string;
  runtimeDesignReviewIdempotencyKey: string;
  runtimeReadinessGateIdempotencyKey: string;
  finalizerDecisionIdempotencyKey: string;
  operatorDecisionEvidenceIdempotencyKey: string;
  reviewRequestIdempotencyKey: string;
  finalizerReviewIdempotencyKey: string;
  scoreIdempotencyKey: string;
  frameworkIdempotencyKey: string;
  roadmap: OIBrokerDispatchApprovalRequestPacket["roadmap"];
  state: OIBrokerDispatchApprovalDecisionEvidenceState;
  disposition:
    | "record_explicit_broker_dispatch_approval_evidence"
    | "wait_for_operator_broker_dispatch_response"
    | "record_broker_dispatch_rejection"
    | "record_broker_dispatch_expiry"
    | "stop_for_broker_dispatch_conflict_resolution"
    | "reject_invalid_broker_dispatch_approval_evidence"
    | "wait_for_broker_dispatch_approval_request"
    | "stop_for_broker_dispatch_boundary"
    | "revise_candidate_for_broker_dispatch";
  checks: OIBrokerDispatchApprovalDecisionEvidenceCheck[];
  blockers: string[];
  nextActions: string[];
  notes: string[];
  acceptedDecisionEvidence: {
    operator: string;
    approvalPhrase: string;
    approvedAt: string;
    targetRepo: string;
    targetIssueNumber: number;
    revocationOrExpiry: string;
  } | null;
  runtimeReadinessEvidencePatch: Required<OIRuntimeReadinessEvidence>;
  safety: {
    brokerDispatchApprovalDecisionEvidenceOnly: true;
    sourceOnly: true;
    grantsExecutionApproval: false;
    brokerDispatchApprovalEvidenceAccepted: boolean;
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

export function buildOIBrokerDispatchApprovalDecisionEvidencePacket(
  input: OIBrokerDispatchApprovalDecisionEvidenceInput = {},
): OIBrokerDispatchApprovalDecisionEvidencePacket {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const brokerDispatchApprovalRequest =
    input.brokerDispatchApprovalRequest ?? buildOIBrokerDispatchApprovalRequestPacket({ generatedAt });
  const runId = input.runId ?? `${brokerDispatchApprovalRequest.runId}-broker-dispatch-approval-decision-evidence`;
  const recorder = input.recorder ?? "broker-finalizer";
  const expectedRepo = input.expectedRepo ?? "jinwon-int/a2a-broker";
  const expectedIssueNumber = input.expectedIssueNumber ?? brokerDispatchApprovalRequest.roadmap.issueNumber;
  const decisionEvidence = input.decisionEvidence;
  const checks = buildChecks({
    generatedAt,
    brokerDispatchApprovalRequest,
    decisionEvidence,
    expectedRepo,
    expectedIssueNumber,
  });
  const state = stateFor(brokerDispatchApprovalRequest, decisionEvidence, checks);

  return {
    kind: "a2a-broker.orchestration-intelligence.broker-dispatch-approval-decision-evidence.packet",
    version: 1,
    generatedAt,
    runId,
    recorder,
    sourceOnly: true,
    idempotencyKey: stableId("oi-broker-dispatch-approval-decision-evidence", {
      runId,
      recorder,
      expectedRepo,
      expectedIssueNumber,
      brokerDispatchApprovalRequest: brokerDispatchApprovalRequest.idempotencyKey,
      decisionEvidence,
      state,
    }),
    brokerDispatchApprovalRequestIdempotencyKey: brokerDispatchApprovalRequest.idempotencyKey,
    runtimeApprovalDecisionEvidenceIdempotencyKey: brokerDispatchApprovalRequest.runtimeApprovalDecisionEvidenceIdempotencyKey,
    runtimeApprovalRequestIdempotencyKey: brokerDispatchApprovalRequest.runtimeApprovalRequestIdempotencyKey,
    runtimeDesignReviewIdempotencyKey: brokerDispatchApprovalRequest.runtimeDesignReviewIdempotencyKey,
    runtimeReadinessGateIdempotencyKey: brokerDispatchApprovalRequest.runtimeReadinessGateIdempotencyKey,
    finalizerDecisionIdempotencyKey: brokerDispatchApprovalRequest.finalizerDecisionIdempotencyKey,
    operatorDecisionEvidenceIdempotencyKey: brokerDispatchApprovalRequest.operatorDecisionEvidenceIdempotencyKey,
    reviewRequestIdempotencyKey: brokerDispatchApprovalRequest.reviewRequestIdempotencyKey,
    finalizerReviewIdempotencyKey: brokerDispatchApprovalRequest.finalizerReviewIdempotencyKey,
    scoreIdempotencyKey: brokerDispatchApprovalRequest.scoreIdempotencyKey,
    frameworkIdempotencyKey: brokerDispatchApprovalRequest.frameworkIdempotencyKey,
    roadmap: brokerDispatchApprovalRequest.roadmap,
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
      brokerDispatchApprovalDecisionEvidenceOnly: true,
      sourceOnly: true,
      grantsExecutionApproval: false,
      brokerDispatchApprovalEvidenceAccepted: state === "broker_dispatch_approval_evidence_accepted",
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

export function renderOIBrokerDispatchApprovalDecisionEvidenceMarkdown(
  packet: OIBrokerDispatchApprovalDecisionEvidencePacket,
): string {
  return [
    "A2A Orchestration Intelligence v2 broker dispatch approval decision evidence",
    `Roadmap: #${packet.roadmap.issueNumber}`,
    `State: ${packet.state}`,
    `Disposition: ${packet.disposition}`,
    `Recorder: ${packet.recorder}`,
    "Broker dispatch approval decision checks:",
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
    "Safety: source-only broker dispatch approval decision evidence. It may record explicit broker dispatch",
    "approval evidence for a later readiness gate, but it does not grant execution approval, enable or create",
    "a runtime executor, create broker dispatch tasks, spawn workers/subagents, expand Daegyo/mobile scope,",
    "send providers, ACK/replay Terminal rows, mutate DB state, deploy/restart services, publish releases,",
    "or move credentials. brokerDispatchApprovalPresent remains a source readiness flag only.",
  ].join("\n");
}

function buildChecks(input: {
  generatedAt: string;
  brokerDispatchApprovalRequest: OIBrokerDispatchApprovalRequestPacket;
  decisionEvidence: OIBrokerDispatchApprovalDecisionEvidence | undefined;
  expectedRepo: string;
  expectedIssueNumber: number;
}): OIBrokerDispatchApprovalDecisionEvidenceCheck[] {
  const requestReady = input.brokerDispatchApprovalRequest.state === "dispatch_approval_request_ready";
  const evidence = input.decisionEvidence;
  return [
    {
      id: "broker_dispatch_approval_request_ready",
      status: requestReady ? "pass" : "fail",
      summary: requestReady
        ? "broker dispatch approval request is ready for an operator response"
        : `broker dispatch approval request is ${input.brokerDispatchApprovalRequest.state}`,
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
      status: evidence?.operator === input.brokerDispatchApprovalRequest.operator ? "pass" : "fail",
      summary: evidence?.operator === input.brokerDispatchApprovalRequest.operator
        ? "operator matches the broker dispatch approval request"
        : "operator is missing or does not match the broker dispatch approval request",
    },
    {
      id: "approval_phrase_matches_request",
      status: evidence?.approvalPhrase === input.brokerDispatchApprovalRequest.dispatchApprovalRequest.requestedApprovalPhrase
        ? "pass"
        : "fail",
      summary: evidence?.approvalPhrase === input.brokerDispatchApprovalRequest.dispatchApprovalRequest.requestedApprovalPhrase
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
        ? "broker dispatch approval is not expired at packet generation time"
        : "broker dispatch approval is expired or expiry is invalid",
    },
    {
      id: "target_repo_and_issue_match",
      status: evidence?.targetRepo === input.expectedRepo && evidence?.targetIssueNumber === input.expectedIssueNumber
        ? "pass"
        : "fail",
      summary: evidence?.targetRepo === input.expectedRepo && evidence?.targetIssueNumber === input.expectedIssueNumber
        ? "approval evidence names the expected target repository and issue context"
        : "approval evidence does not name the expected target repository and issue context",
    },
    {
      id: "dispatch_scope_matches_request",
      status: scopeMatches(input.brokerDispatchApprovalRequest.dispatchApprovalRequest.requiredConditions, evidence?.dispatchScope)
        ? "pass"
        : "fail",
      summary: scopeMatches(input.brokerDispatchApprovalRequest.dispatchApprovalRequest.requiredConditions, evidence?.dispatchScope)
        ? "broker dispatch approval evidence scope covers the requested scope"
        : "broker dispatch approval evidence scope is missing or does not cover the requested scope",
    },
    {
      id: "conditions_accepted",
      status: evidence?.conditionsAccepted === true && coversAll(input.brokerDispatchApprovalRequest.dispatchApprovalRequest.requiredConditions, evidence.conditions)
        ? "pass"
        : "fail",
      summary: evidence?.conditionsAccepted === true && coversAll(input.brokerDispatchApprovalRequest.dispatchApprovalRequest.requiredConditions, evidence.conditions)
        ? "broker dispatch approval conditions are explicitly accepted"
        : "broker dispatch approval conditions are missing or not explicitly accepted",
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
  brokerDispatchApprovalRequest: OIBrokerDispatchApprovalRequestPacket,
  evidence: OIBrokerDispatchApprovalDecisionEvidence | undefined,
  checks: OIBrokerDispatchApprovalDecisionEvidenceCheck[],
): OIBrokerDispatchApprovalDecisionEvidenceState {
  if (brokerDispatchApprovalRequest.state === "approval_boundary_review_required") {
    return "broker_dispatch_boundary_review_required";
  }
  if (brokerDispatchApprovalRequest.state === "candidate_revision_required") {
    return "broker_dispatch_candidate_revision_required";
  }
  if (brokerDispatchApprovalRequest.state !== "dispatch_approval_request_ready") {
    return "broker_dispatch_approval_request_not_ready";
  }
  if (!evidence) return "broker_dispatch_approval_evidence_missing";
  if (evidence.kind === "rejected") return "broker_dispatch_approval_evidence_rejected";
  if (evidence.kind === "expired") return "broker_dispatch_approval_evidence_expired";
  if (evidence.kind === "conflict") return "broker_dispatch_approval_evidence_conflicting";
  if (checks.every((check) => check.status === "pass")) return "broker_dispatch_approval_evidence_accepted";
  return "broker_dispatch_approval_evidence_invalid";
}

function dispositionForState(
  state: OIBrokerDispatchApprovalDecisionEvidenceState,
): OIBrokerDispatchApprovalDecisionEvidencePacket["disposition"] {
  if (state === "broker_dispatch_approval_evidence_accepted") return "record_explicit_broker_dispatch_approval_evidence";
  if (state === "broker_dispatch_approval_evidence_missing") return "wait_for_operator_broker_dispatch_response";
  if (state === "broker_dispatch_approval_evidence_rejected") return "record_broker_dispatch_rejection";
  if (state === "broker_dispatch_approval_evidence_expired") return "record_broker_dispatch_expiry";
  if (state === "broker_dispatch_approval_evidence_conflicting") return "stop_for_broker_dispatch_conflict_resolution";
  if (state === "broker_dispatch_approval_request_not_ready") return "wait_for_broker_dispatch_approval_request";
  if (state === "broker_dispatch_boundary_review_required") return "stop_for_broker_dispatch_boundary";
  if (state === "broker_dispatch_candidate_revision_required") return "revise_candidate_for_broker_dispatch";
  return "reject_invalid_broker_dispatch_approval_evidence";
}

function blockersForState(
  state: OIBrokerDispatchApprovalDecisionEvidenceState,
  checks: OIBrokerDispatchApprovalDecisionEvidenceCheck[],
): string[] {
  if (state === "broker_dispatch_approval_evidence_rejected") return ["operator response rejected broker dispatch approval"];
  if (state === "broker_dispatch_approval_evidence_expired") return ["operator broker dispatch approval evidence is expired"];
  if (state === "broker_dispatch_approval_evidence_conflicting") {
    return ["conflicting operator broker dispatch approval evidence requires manual resolution"];
  }
  return checks
    .filter((check) => check.status !== "pass")
    .map((check) => `${check.id}: ${check.summary}`);
}

function nextActionsForState(state: OIBrokerDispatchApprovalDecisionEvidenceState): string[] {
  if (state === "broker_dispatch_approval_evidence_accepted") {
    return [
      "feed brokerDispatchApprovalPresent=true into a later readiness gate review",
      "keep broker task creation, executor invocation, worker/subagent spawn, Daegyo/mobile scope resolution, rollback/live readiness, and executor enablement as separate gates",
    ];
  }
  if (state === "broker_dispatch_approval_evidence_missing") {
    return ["wait for a scoped operator response to the broker dispatch approval request"];
  }
  if (state === "broker_dispatch_approval_evidence_rejected") return ["record rejection and keep broker dispatch approval absent"];
  if (state === "broker_dispatch_approval_evidence_expired") return ["refresh broker dispatch approval request before considering dispatch approval"];
  if (state === "broker_dispatch_approval_evidence_conflicting") {
    return ["resolve conflicting operator broker dispatch evidence before proceeding"];
  }
  if (state === "broker_dispatch_approval_request_not_ready") {
    return ["complete broker dispatch approval request packet before ingesting decision evidence"];
  }
  if (state === "broker_dispatch_boundary_review_required") {
    return ["stop broker dispatch progression", "request separate broker-dispatch-boundary review"];
  }
  if (state === "broker_dispatch_candidate_revision_required") {
    return ["revise candidate and rerun broker dispatch validation packets"];
  }
  return ["collect corrected operator broker dispatch approval evidence", "keep broker dispatch approval absent"];
}

function evidencePatchForState(
  state: OIBrokerDispatchApprovalDecisionEvidenceState,
): Required<OIRuntimeReadinessEvidence> {
  const accepted = state === "broker_dispatch_approval_evidence_accepted";
  return {
    runtimeExecutorDesignReviewed: accepted,
    explicitRuntimeApprovalPresent: accepted,
    brokerDispatchApprovalPresent: accepted,
    workerSpawnApprovalPresent: false,
    daegyoMobileScopeResolved: false,
    rollbackAbortCriteriaDocumented: false,
    liveBoundaryPlanDocumented: false,
    validationEvidenceFresh: accepted,
  };
}

function acceptedDecisionForState(
  state: OIBrokerDispatchApprovalDecisionEvidenceState,
  evidence: OIBrokerDispatchApprovalDecisionEvidence | undefined,
  expectedRepo: string,
  expectedIssueNumber: number,
): OIBrokerDispatchApprovalDecisionEvidencePacket["acceptedDecisionEvidence"] {
  if (state !== "broker_dispatch_approval_evidence_accepted" || !evidence) return null;
  return {
    operator: evidence.operator ?? "",
    approvalPhrase: evidence.approvalPhrase ?? "",
    approvedAt: evidence.approvedAt ?? "",
    targetRepo: evidence.targetRepo ?? expectedRepo,
    targetIssueNumber: evidence.targetIssueNumber ?? expectedIssueNumber,
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
