import { createHash } from "node:crypto";

import {
  buildOIRuntimeApprovalDecisionEvidencePacket,
  type OIRuntimeApprovalDecisionEvidencePacket,
} from "./orchestration-intelligence-runtime-approval-decision-evidence.js";
import type { OIRuntimeReadinessEvidence } from "./orchestration-intelligence-runtime-readiness-gate.js";

export type OIBrokerDispatchApprovalRequestState =
  | "dispatch_approval_request_ready"
  | "dispatch_approval_request_incomplete"
  | "runtime_approval_decision_not_ready"
  | "approval_boundary_review_required"
  | "candidate_revision_required";

export interface OIBrokerDispatchApprovalRequestEvidence {
  dispatchScopeDocumented?: boolean;
  targetRepoDocumented?: boolean;
  targetIssueDocumented?: boolean;
  workerTeamConstraintsDocumented?: boolean;
  operatorIdentityRequirementDocumented?: boolean;
  expiryRevocationDocumented?: boolean;
  rollbackAbortRequirementsDocumented?: boolean;
  requiredFutureDecisionEvidenceDocumented?: boolean;
}

export interface OIBrokerDispatchApprovalRequestInput {
  generatedAt?: string;
  runId?: string;
  requester?: string;
  operator?: string;
  runtimeApprovalDecisionEvidence?: OIRuntimeApprovalDecisionEvidencePacket;
  dispatchEvidence?: OIBrokerDispatchApprovalRequestEvidence;
  notes?: string[];
}

export interface OIBrokerDispatchApprovalRequestCheck {
  id:
    | "runtime_approval_decision_ready"
    | "dispatch_scope_documented"
    | "target_repo_documented"
    | "target_issue_documented"
    | "worker_team_constraints_documented"
    | "operator_identity_requirement_documented"
    | "expiry_revocation_documented"
    | "rollback_abort_requirements_documented"
    | "required_future_decision_evidence_documented";
  status: "pass" | "fail" | "review";
  summary: string;
}

export interface OIBrokerDispatchApprovalRequestPacket {
  kind: "a2a-broker.orchestration-intelligence.broker-dispatch-approval-request.packet";
  version: 1;
  generatedAt: string;
  runId: string;
  requester: string;
  operator: string;
  sourceOnly: true;
  idempotencyKey: string;
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
  roadmap: OIRuntimeApprovalDecisionEvidencePacket["roadmap"];
  state: OIBrokerDispatchApprovalRequestState;
  disposition:
    | "request_explicit_broker_dispatch_approval_evidence"
    | "collect_broker_dispatch_approval_request_evidence"
    | "wait_for_runtime_approval_decision"
    | "stop_for_approval_boundary"
    | "revise_candidate";
  checks: OIBrokerDispatchApprovalRequestCheck[];
  blockers: string[];
  nextActions: string[];
  notes: string[];
  dispatchApprovalRequest: {
    requestedApprovalPhrase: string;
    operator: string;
    targetRepo: string;
    targetIssueNumber: number;
    dispatchScope: string[];
    workerTeamConstraints: string[];
    requiredConditions: string[];
    rollbackAbortRequirements: string[];
    nonGoals: string[];
    evidenceFieldsRequiredForFutureApproval: string[];
  };
  runtimeReadinessEvidencePatch: Required<OIRuntimeReadinessEvidence>;
  safety: {
    brokerDispatchApprovalRequestOnly: true;
    sourceOnly: true;
    grantsExecutionApproval: false;
    approvalGranted: false;
    brokerDispatchApprovalPresent: false;
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

export function buildOIBrokerDispatchApprovalRequestPacket(
  input: OIBrokerDispatchApprovalRequestInput = {},
): OIBrokerDispatchApprovalRequestPacket {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const runtimeApprovalDecisionEvidence = input.runtimeApprovalDecisionEvidence ??
    buildOIRuntimeApprovalDecisionEvidencePacket({ generatedAt });
  const runId = input.runId ?? `${runtimeApprovalDecisionEvidence.runId}-broker-dispatch-approval-request`;
  const requester = input.requester ?? "broker-finalizer";
  const operator = input.operator ?? "human-operator";
  const dispatchEvidence = input.dispatchEvidence ?? {};
  const checks = buildChecks(runtimeApprovalDecisionEvidence, dispatchEvidence);
  const state = stateFor(runtimeApprovalDecisionEvidence, checks);

  return {
    kind: "a2a-broker.orchestration-intelligence.broker-dispatch-approval-request.packet",
    version: 1,
    generatedAt,
    runId,
    requester,
    operator,
    sourceOnly: true,
    idempotencyKey: stableId("oi-broker-dispatch-approval-request", {
      runId,
      requester,
      operator,
      runtimeApprovalDecisionEvidence: runtimeApprovalDecisionEvidence.idempotencyKey,
      dispatchEvidence,
      state,
    }),
    runtimeApprovalDecisionEvidenceIdempotencyKey: runtimeApprovalDecisionEvidence.idempotencyKey,
    runtimeApprovalRequestIdempotencyKey: runtimeApprovalDecisionEvidence.runtimeApprovalRequestIdempotencyKey,
    runtimeDesignReviewIdempotencyKey: runtimeApprovalDecisionEvidence.runtimeDesignReviewIdempotencyKey,
    runtimeReadinessGateIdempotencyKey: runtimeApprovalDecisionEvidence.runtimeReadinessGateIdempotencyKey,
    finalizerDecisionIdempotencyKey: runtimeApprovalDecisionEvidence.finalizerDecisionIdempotencyKey,
    operatorDecisionEvidenceIdempotencyKey: runtimeApprovalDecisionEvidence.operatorDecisionEvidenceIdempotencyKey,
    reviewRequestIdempotencyKey: runtimeApprovalDecisionEvidence.reviewRequestIdempotencyKey,
    finalizerReviewIdempotencyKey: runtimeApprovalDecisionEvidence.finalizerReviewIdempotencyKey,
    scoreIdempotencyKey: runtimeApprovalDecisionEvidence.scoreIdempotencyKey,
    frameworkIdempotencyKey: runtimeApprovalDecisionEvidence.frameworkIdempotencyKey,
    roadmap: runtimeApprovalDecisionEvidence.roadmap,
    state,
    disposition: dispositionForState(state),
    checks,
    blockers: blockersForChecks(checks),
    nextActions: nextActionsForState(state),
    notes: input.notes ?? [],
    dispatchApprovalRequest: dispatchApprovalRequestFor(
      operator,
      runtimeApprovalDecisionEvidence,
      dispatchEvidence,
    ),
    runtimeReadinessEvidencePatch: evidencePatchForState(state),
    safety: {
      brokerDispatchApprovalRequestOnly: true,
      sourceOnly: true,
      grantsExecutionApproval: false,
      approvalGranted: false,
      brokerDispatchApprovalPresent: false,
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

export function renderOIBrokerDispatchApprovalRequestMarkdown(
  packet: OIBrokerDispatchApprovalRequestPacket,
): string {
  const req = packet.dispatchApprovalRequest;
  return [
    "A2A Orchestration Intelligence v2 broker dispatch approval request",
    `Roadmap: #${packet.roadmap.issueNumber}`,
    `State: ${packet.state}`,
    `Disposition: ${packet.disposition}`,
    `Requester: ${packet.requester}`,
    `Operator: ${packet.operator}`,
    "Dispatch approval request checks:",
    ...packet.checks.map((check) => `- ${check.id}: ${check.status} - ${check.summary}`),
    "Requested approval phrase:",
    `- ${req.requestedApprovalPhrase}`,
    `Target: ${req.targetRepo}#${req.targetIssueNumber}`,
    "Dispatch scope:",
    ...req.dispatchScope.map((scope) => `- ${scope}`),
    "Worker/team constraints:",
    ...req.workerTeamConstraints.map((constraint) => `- ${constraint}`),
    "Required conditions:",
    ...req.requiredConditions.map((condition) => `- ${condition}`),
    "Rollback/abort requirements:",
    ...req.rollbackAbortRequirements.map((reqt) => `- ${reqt}`),
    "Runtime readiness evidence patch:",
    ...Object.entries(packet.runtimeReadinessEvidencePatch).map(([key, value]) => `- ${key}: ${value}`),
    "Blockers:",
    ...(packet.blockers.length ? packet.blockers.map((blocker) => `- ${blocker}`) : ["- none"]),
    "Next actions:",
    ...packet.nextActions.map((action) => `- ${action}`),
    "Safety: source-only broker dispatch approval request. It documents the exact approval phrase,",
    "dispatch scope, target, worker/team constraints, rollback/abort requirements, and evidence fields",
    "for a future broker dispatch approval decision, but does not grant approval, create broker tasks,",
    "invoke executors, spawn workers/subagents, mutate TaskFlow/DB, send providers, or touch live services.",
    "brokerDispatchApprovalPresent remains false. This packet is not approval and not execution permission.",
  ].join("\n");
}

function buildChecks(
  runtimeApprovalDecisionEvidence: OIRuntimeApprovalDecisionEvidencePacket,
  evidence: OIBrokerDispatchApprovalRequestEvidence,
): OIBrokerDispatchApprovalRequestCheck[] {
  const decisionReady = runtimeApprovalDecisionEvidence.state === "approval_evidence_accepted"
    && runtimeApprovalDecisionEvidence.runtimeReadinessEvidencePatch.explicitRuntimeApprovalPresent === true;
  return [
    {
      id: "runtime_approval_decision_ready",
      status: decisionReady ? "pass" : "fail",
      summary: decisionReady
        ? "runtime approval decision evidence is recorded as source-only evidence with explicitApprovalPresent=true"
        : `runtime approval decision evidence is ${runtimeApprovalDecisionEvidence.state}`,
    },
    boolCheck(
      "dispatch_scope_documented",
      evidence.dispatchScopeDocumented,
      "broker dispatch scope is documented",
      "broker dispatch scope is missing",
    ),
    boolCheck(
      "target_repo_documented",
      evidence.targetRepoDocumented,
      "target repository is documented",
      "target repository is missing",
    ),
    boolCheck(
      "target_issue_documented",
      evidence.targetIssueDocumented,
      "target issue number is documented",
      "target issue number is missing",
    ),
    boolCheck(
      "worker_team_constraints_documented",
      evidence.workerTeamConstraintsDocumented,
      "worker and team constraints are documented",
      "worker and team constraints are missing",
    ),
    boolCheck(
      "operator_identity_requirement_documented",
      evidence.operatorIdentityRequirementDocumented,
      "operator identity requirement is documented",
      "operator identity requirement is missing",
    ),
    boolCheck(
      "expiry_revocation_documented",
      evidence.expiryRevocationDocumented,
      "expiry and revocation requirements are documented",
      "expiry and revocation requirements are missing",
    ),
    boolCheck(
      "rollback_abort_requirements_documented",
      evidence.rollbackAbortRequirementsDocumented,
      "rollback and abort requirements are documented",
      "rollback and abort requirements are missing",
    ),
    boolCheck(
      "required_future_decision_evidence_documented",
      evidence.requiredFutureDecisionEvidenceDocumented,
      "required future decision evidence fields are documented",
      "required future decision evidence fields are missing",
    ),
  ];
}

function boolCheck(
  id: OIBrokerDispatchApprovalRequestCheck["id"],
  value: boolean | undefined,
  passSummary: string,
  failSummary: string,
): OIBrokerDispatchApprovalRequestCheck {
  return {
    id,
    status: value === true ? "pass" : "fail",
    summary: value === true ? passSummary : failSummary,
  };
}

function stateFor(
  runtimeApprovalDecisionEvidence: OIRuntimeApprovalDecisionEvidencePacket,
  checks: OIBrokerDispatchApprovalRequestCheck[],
): OIBrokerDispatchApprovalRequestState {
  if (runtimeApprovalDecisionEvidence.state === "approval_boundary_review_required") {
    return "approval_boundary_review_required";
  }
  if (runtimeApprovalDecisionEvidence.state === "candidate_revision_required") {
    return "candidate_revision_required";
  }
  const decisionReady = checks.some(
    (check) => check.id === "runtime_approval_decision_ready" && check.status === "pass",
  );
  if (!decisionReady) return "runtime_approval_decision_not_ready";
  return checks.every((check) => check.status === "pass")
    ? "dispatch_approval_request_ready"
    : "dispatch_approval_request_incomplete";
}

function dispositionForState(
  state: OIBrokerDispatchApprovalRequestState,
): OIBrokerDispatchApprovalRequestPacket["disposition"] {
  if (state === "dispatch_approval_request_ready") return "request_explicit_broker_dispatch_approval_evidence";
  if (state === "runtime_approval_decision_not_ready") return "wait_for_runtime_approval_decision";
  if (state === "approval_boundary_review_required") return "stop_for_approval_boundary";
  if (state === "candidate_revision_required") return "revise_candidate";
  return "collect_broker_dispatch_approval_request_evidence";
}

function evidencePatchForState(state: OIBrokerDispatchApprovalRequestState): Required<OIRuntimeReadinessEvidence> {
  return {
    runtimeExecutorDesignReviewed: state === "dispatch_approval_request_ready",
    explicitRuntimeApprovalPresent: state === "dispatch_approval_request_ready",
    brokerDispatchApprovalPresent: false,
    workerSpawnApprovalPresent: false,
    mobilebetaMobileScopeResolved: false,
    rollbackAbortCriteriaDocumented: false,
    liveBoundaryPlanDocumented: false,
    validationEvidenceFresh: state === "dispatch_approval_request_ready",
  };
}

function blockersForChecks(checks: OIBrokerDispatchApprovalRequestCheck[]): string[] {
  return checks
    .filter((check) => check.status !== "pass")
    .map((check) => `${check.id}: ${check.summary}`);
}

function nextActionsForState(state: OIBrokerDispatchApprovalRequestState): string[] {
  if (state === "dispatch_approval_request_ready") {
    return [
      "present the broker dispatch approval request to the operator as a separate approval gate",
      "record any operator response in a future source-only broker dispatch approval decision evidence packet",
      "keep broker dispatch approval, worker spawn, runtime executor, and mobilebeta/mobile scope expansion disabled until later gates pass",
    ];
  }
  if (state === "runtime_approval_decision_not_ready") {
    return ["complete runtime approval decision evidence before requesting broker dispatch approval"];
  }
  if (state === "approval_boundary_review_required") return ["stop runtime progression", "request separate approval-boundary review"];
  if (state === "candidate_revision_required") return ["revise candidate and rerun validation packets"];
  return ["collect missing broker dispatch approval request evidence", "keep broker dispatch approval absent"];
}

function dispatchApprovalRequestFor(
  operator: string,
  runtimeApprovalDecisionEvidence: OIRuntimeApprovalDecisionEvidencePacket,
  evidence: OIBrokerDispatchApprovalRequestEvidence,
): OIBrokerDispatchApprovalRequestPacket["dispatchApprovalRequest"] {
  const targetRepo = evidence.targetRepoDocumented
    ? (runtimeApprovalDecisionEvidence.acceptedDecisionEvidence?.repo ?? "jinwon-int/a2a-broker")
    : "";
  const targetIssueNumber = evidence.targetIssueDocumented
    ? (runtimeApprovalDecisionEvidence.acceptedDecisionEvidence?.issueNumber ?? 0)
    : runtimeApprovalDecisionEvidence.roadmap.issueNumber;

  return {
    requestedApprovalPhrase: "APPROVE OI V2 BROKER DISPATCH APPROVAL REQUEST FOR SOURCE-ONLY EVIDENCE REVIEW",
    operator,
    targetRepo,
    targetIssueNumber,
    dispatchScope: [
      "record explicit broker dispatch approval evidence in a future source-only packet",
      "keep broker task creation, executor invocation, worker/subagent spawn in separate future work",
      "keep runtime executor enablement and mobilebeta/mobile scope expansion as independent gates",
    ],
    workerTeamConstraints: [
      "all dispatched workers must remain source-only (no live executor, no DB mutation, no provider send)",
      "worker identity and capability must be verifiable without secrets",
      "worker dispatch scope must not exceed the approved target repo/issue/scope",
      "workers must report completion or failure without live provider side-effects",
    ],
    requiredConditions: [
      "operator identity must be recorded without secrets",
      "approval phrase must match the requested phrase exactly or be superseded by a stricter phrase",
      "approval must name the repository, issue, and dispatch scope",
      "approval must not authorize deploy, restart, DB mutation, live provider send, Terminal ACK/replay, release publish, or credential movement",
      "approval must not authorize broker task creation, executor invocation, or worker/subagent spawn from worker code at runtime",
      "approval may be revoked or expired before any later dispatch enablement step",
    ],
    rollbackAbortRequirements: [
      "rollback plan must exist for any dispatch-scope artifacts (comments, proposals, metadata)",
      "abort must be possible without live provider side-effects or DB roll-forward",
      "dispatch must specify a revocation-trigger handler for each target scope",
    ],
    nonGoals: [
      "broker task creation or dispatch at runtime",
      "executor invocation",
      "worker or subagent spawn",
      "runtime executor enablement",
      "mobilebeta/mobile scope expansion",
      "live provider or Telegram canary",
      "deploy, restart, DB mutation, Terminal ACK/replay, release publish, or credential movement",
    ],
    evidenceFieldsRequiredForFutureApproval: [
      "operator",
      "approvalPhrase",
      "approvedAt",
      "targetRepo",
      "targetIssueNumber",
      "dispatchScope",
      "workerTeamConstraints",
      "conditions",
      "revocationOrExpiry",
      "rollbackAbortPlanRef",
    ],
  };
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
