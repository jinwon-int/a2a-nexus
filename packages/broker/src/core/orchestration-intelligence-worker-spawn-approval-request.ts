import { createHash } from "node:crypto";

import {
  buildOIBrokerDispatchApprovalDecisionEvidencePacket,
  type OIBrokerDispatchApprovalDecisionEvidencePacket,
} from "./orchestration-intelligence-broker-dispatch-approval-decision-evidence.js";
import type { OIRuntimeReadinessEvidence } from "./orchestration-intelligence-runtime-readiness-gate.js";

export type OIWorkerSpawnApprovalRequestState =
  | "worker_spawn_approval_request_ready"
  | "worker_spawn_approval_request_incomplete"
  | "broker_dispatch_evidence_not_ready"
  | "approval_boundary_review_required"
  | "candidate_revision_required"
  | "forbidden_safety_invariant_violated";

export interface OIWorkerSpawnApprovalRequestEvidence {
  spawnScopeDocumented?: boolean;
  targetRepoDocumented?: boolean;
  targetIssueDocumented?: boolean;
  workerTeamConstraintsDocumented?: boolean;
  allowedWorkerClassesDocumented?: boolean;
  noLiveExclusionsDocumented?: boolean;
  operatorIdentityRequirementDocumented?: boolean;
  expiryRevocationDocumented?: boolean;
  rollbackAbortRequirementsDocumented?: boolean;
  requiredFutureDecisionEvidenceDocumented?: boolean;
}

export interface OIWorkerSpawnApprovalRequestInput {
  generatedAt?: string;
  runId?: string;
  requester?: string;
  operator?: string;
  brokerDispatchApprovalDecisionEvidence?: OIBrokerDispatchApprovalDecisionEvidencePacket;
  spawnEvidence?: OIWorkerSpawnApprovalRequestEvidence;
  notes?: string[];
}

export interface OIWorkerSpawnApprovalRequestCheck {
  id:
    | "broker_dispatch_evidence_ready"
    | "spawn_scope_documented"
    | "target_repo_documented"
    | "target_issue_documented"
    | "worker_team_constraints_documented"
    | "allowed_worker_classes_documented"
    | "no_live_exclusions_documented"
    | "operator_identity_requirement_documented"
    | "expiry_revocation_documented"
    | "rollback_abort_requirements_documented"
    | "required_future_decision_evidence_documented";
  status: "pass" | "fail" | "review";
  summary: string;
}

export interface OIWorkerSpawnApprovalRequestPacket {
  kind: "a2a-broker.orchestration-intelligence.worker-spawn-approval-request.packet";
  version: 1;
  generatedAt: string;
  runId: string;
  requester: string;
  operator: string;
  sourceOnly: true;
  idempotencyKey: string;
  brokerDispatchApprovalDecisionEvidenceIdempotencyKey: string;
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
  roadmap: OIBrokerDispatchApprovalDecisionEvidencePacket["roadmap"];
  state: OIWorkerSpawnApprovalRequestState;
  disposition:
    | "request_explicit_worker_spawn_approval_evidence"
    | "collect_worker_spawn_approval_request_evidence"
    | "wait_for_broker_dispatch_evidence"
    | "stop_for_approval_boundary"
    | "revise_candidate"
    | "blocked_forbidden_safety_invariant";
  checks: OIWorkerSpawnApprovalRequestCheck[];
  blockers: string[];
  nextActions: string[];
  notes: string[];
  spawnApprovalRequest: {
    requestedApprovalPhrase: string;
    operator: string;
    targetRepo: string;
    targetIssueNumber: number;
    spawnScope: string[];
    workerTeamConstraints: string[];
    allowedWorkerClasses: string[];
    noLiveExclusions: string[];
    requiredConditions: string[];
    rollbackAbortRequirements: string[];
    expiryOrRevocation: string;
    nonGoals: string[];
    evidenceFieldsRequiredForFutureApproval: string[];
  };
  runtimeReadinessEvidencePatch: Required<OIRuntimeReadinessEvidence>;
  safety: {
    workerSpawnApprovalRequestOnly: true;
    sourceOnly: true;
    grantsExecutionApproval: false;
    approvalGranted: false;
    workerSpawnApprovalPresent: false;
    brokerDispatchApprovalPresent: boolean;
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

export function buildOIWorkerSpawnApprovalRequestPacket(
  input: OIWorkerSpawnApprovalRequestInput = {},
): OIWorkerSpawnApprovalRequestPacket {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const brokerDispatchApprovalDecisionEvidence = input.brokerDispatchApprovalDecisionEvidence ??
    buildOIBrokerDispatchApprovalDecisionEvidencePacket({ generatedAt });
  const runId = input.runId ?? `${brokerDispatchApprovalDecisionEvidence.runId}-worker-spawn-approval-request`;
  const requester = input.requester ?? "broker-finalizer";
  const operator = input.operator ?? "human-operator";
  const spawnEvidence = input.spawnEvidence ?? {};
  const checks = buildChecks(brokerDispatchApprovalDecisionEvidence, spawnEvidence);
  const state = stateFor(brokerDispatchApprovalDecisionEvidence, checks);

  return {
    kind: "a2a-broker.orchestration-intelligence.worker-spawn-approval-request.packet",
    version: 1,
    generatedAt,
    runId,
    requester,
    operator,
    sourceOnly: true,
    idempotencyKey: stableId("oi-worker-spawn-approval-request", {
      runId,
      requester,
      operator,
      brokerDispatchApprovalDecisionEvidence: brokerDispatchApprovalDecisionEvidence.idempotencyKey,
      spawnEvidence,
      state,
    }),
    brokerDispatchApprovalDecisionEvidenceIdempotencyKey: brokerDispatchApprovalDecisionEvidence.idempotencyKey,
    brokerDispatchApprovalRequestIdempotencyKey: brokerDispatchApprovalDecisionEvidence.brokerDispatchApprovalRequestIdempotencyKey,
    runtimeApprovalDecisionEvidenceIdempotencyKey: brokerDispatchApprovalDecisionEvidence.runtimeApprovalDecisionEvidenceIdempotencyKey,
    runtimeApprovalRequestIdempotencyKey: brokerDispatchApprovalDecisionEvidence.runtimeApprovalRequestIdempotencyKey,
    runtimeDesignReviewIdempotencyKey: brokerDispatchApprovalDecisionEvidence.runtimeDesignReviewIdempotencyKey,
    runtimeReadinessGateIdempotencyKey: brokerDispatchApprovalDecisionEvidence.runtimeReadinessGateIdempotencyKey,
    finalizerDecisionIdempotencyKey: brokerDispatchApprovalDecisionEvidence.finalizerDecisionIdempotencyKey,
    operatorDecisionEvidenceIdempotencyKey: brokerDispatchApprovalDecisionEvidence.operatorDecisionEvidenceIdempotencyKey,
    reviewRequestIdempotencyKey: brokerDispatchApprovalDecisionEvidence.reviewRequestIdempotencyKey,
    finalizerReviewIdempotencyKey: brokerDispatchApprovalDecisionEvidence.finalizerReviewIdempotencyKey,
    scoreIdempotencyKey: brokerDispatchApprovalDecisionEvidence.scoreIdempotencyKey,
    frameworkIdempotencyKey: brokerDispatchApprovalDecisionEvidence.frameworkIdempotencyKey,
    roadmap: brokerDispatchApprovalDecisionEvidence.roadmap,
    state,
    disposition: dispositionForState(state),
    checks,
    blockers: blockersForChecks(checks),
    nextActions: nextActionsForState(state),
    notes: input.notes ?? [],
    spawnApprovalRequest: spawnApprovalRequestFor(
      operator,
      brokerDispatchApprovalDecisionEvidence,
      spawnEvidence,
    ),
    runtimeReadinessEvidencePatch: evidencePatchForState(state),
    safety: {
      workerSpawnApprovalRequestOnly: true,
      sourceOnly: true,
      grantsExecutionApproval: false,
      approvalGranted: false,
      workerSpawnApprovalPresent: false,
      brokerDispatchApprovalPresent: state === "worker_spawn_approval_request_ready",
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

export function renderOIWorkerSpawnApprovalRequestMarkdown(
  packet: OIWorkerSpawnApprovalRequestPacket,
): string {
  const req = packet.spawnApprovalRequest;
  return [
    "A2A Orchestration Intelligence v2 worker/subagent spawn approval request",
    `Roadmap: #${packet.roadmap.issueNumber}`,
    `State: ${packet.state}`,
    `Disposition: ${packet.disposition}`,
    `Requester: ${packet.requester}`,
    `Operator: ${packet.operator}`,
    "Worker spawn approval request checks:",
    ...packet.checks.map((check) => `- ${check.id}: ${check.status} - ${check.summary}`),
    "Requested approval phrase:",
    `- ${req.requestedApprovalPhrase}`,
    `Target: ${req.targetRepo}#${req.targetIssueNumber}`,
    "Spawn scope:",
    ...req.spawnScope.map((scope) => `- ${scope}`),
    "Worker/team constraints:",
    ...req.workerTeamConstraints.map((constraint) => `- ${constraint}`),
    "Allowed worker classes:",
    ...req.allowedWorkerClasses.map((cls) => `- ${cls}`),
    "No-live/live exclusions:",
    ...req.noLiveExclusions.map((excl) => `- ${excl}`),
    "Required conditions:",
    ...req.requiredConditions.map((condition) => `- ${condition}`),
    "Rollback/abort requirements:",
    ...req.rollbackAbortRequirements.map((reqt) => `- ${reqt}`),
    "Expiry/revocation:",
    `- ${req.expiryOrRevocation}`,
    "Runtime readiness evidence patch:",
    ...Object.entries(packet.runtimeReadinessEvidencePatch).map(([key, value]) => `- ${key}: ${value}`),
    "Blockers:",
    ...(packet.blockers.length ? packet.blockers.map((blocker) => `- ${blocker}`) : ["- none"]),
    "Next actions:",
    ...packet.nextActions.map((action) => `- ${action}`),
    "Safety: source-only worker/subagent spawn approval request. It documents the exact approval phrase,",
    "spawn scope, target, worker/team constraints, allowed worker classes, no-live/live exclusions,",
    "rollback/abort requirements, expiry/revocation, and evidence fields for a future worker/subagent",
    "spawn approval decision, but does not grant approval, create broker tasks, invoke executors,",
    "spawn workers/subagents, mutate TaskFlow/DB, send providers, or touch live services.",
    "workerSpawnApprovalPresent remains false. This packet is not approval and not execution permission.",
  ].join("\n");
}

function buildChecks(
  brokerDispatchApprovalDecisionEvidence: OIBrokerDispatchApprovalDecisionEvidencePacket,
  evidence: OIWorkerSpawnApprovalRequestEvidence,
): OIWorkerSpawnApprovalRequestCheck[] {
  const dispatchAccepted = brokerDispatchApprovalDecisionEvidence.state === "broker_dispatch_approval_evidence_accepted"
    && brokerDispatchApprovalDecisionEvidence.safety.brokerDispatchApprovalEvidenceAccepted === true
    && brokerDispatchApprovalDecisionEvidence.runtimeReadinessEvidencePatch.brokerDispatchApprovalPresent === true;
  return [
    {
      id: "broker_dispatch_evidence_ready",
      status: dispatchAccepted ? "pass" : "fail",
      summary: dispatchAccepted
        ? "broker dispatch approval decision evidence is accepted with brokerDispatchApprovalPresent=true"
        : `broker dispatch approval decision evidence is ${brokerDispatchApprovalDecisionEvidence.state}`,
    },
    boolCheck(
      "spawn_scope_documented",
      evidence.spawnScopeDocumented,
      "worker/subagent spawn scope is documented",
      "worker/subagent spawn scope is missing",
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
      "allowed_worker_classes_documented",
      evidence.allowedWorkerClassesDocumented,
      "allowed worker classes are documented",
      "allowed worker classes are missing",
    ),
    boolCheck(
      "no_live_exclusions_documented",
      evidence.noLiveExclusionsDocumented,
      "no-live/live exclusions are documented",
      "no-live/live exclusions are missing",
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
  id: OIWorkerSpawnApprovalRequestCheck["id"],
  value: boolean | undefined,
  passSummary: string,
  failSummary: string,
): OIWorkerSpawnApprovalRequestCheck {
  return {
    id,
    status: value === true ? "pass" : "fail",
    summary: value === true ? passSummary : failSummary,
  };
}

function stateFor(
  brokerDispatchApprovalDecisionEvidence: OIBrokerDispatchApprovalDecisionEvidencePacket,
  checks: OIWorkerSpawnApprovalRequestCheck[],
): OIWorkerSpawnApprovalRequestState {
  if (brokerDispatchApprovalDecisionEvidence.state === "broker_dispatch_boundary_review_required") {
    return "approval_boundary_review_required";
  }
  if (brokerDispatchApprovalDecisionEvidence.state === "broker_dispatch_candidate_revision_required") {
    return "candidate_revision_required";
  }
  // Forbidden safety invariant: the upstream packet must be in a safe state.
  // The upstream builder type guarantees all runtime mutation booleans are
  // literal `false`. We verify the safety contract by checking the accepted
  // evidence flag, which is typed as `boolean` (not a literal `false`).
  if (
    brokerDispatchApprovalDecisionEvidence.state === "broker_dispatch_approval_evidence_accepted" &&
    !brokerDispatchApprovalDecisionEvidence.safety.brokerDispatchApprovalEvidenceAccepted
  ) {
    return "forbidden_safety_invariant_violated";
  }
  const dispatchReady = checks.some(
    (check) => check.id === "broker_dispatch_evidence_ready" && check.status === "pass",
  );
  if (!dispatchReady) return "broker_dispatch_evidence_not_ready";
  return checks.every((check) => check.status === "pass")
    ? "worker_spawn_approval_request_ready"
    : "worker_spawn_approval_request_incomplete";
}

function dispositionForState(
  state: OIWorkerSpawnApprovalRequestState,
): OIWorkerSpawnApprovalRequestPacket["disposition"] {
  if (state === "worker_spawn_approval_request_ready") return "request_explicit_worker_spawn_approval_evidence";
  if (state === "broker_dispatch_evidence_not_ready") return "wait_for_broker_dispatch_evidence";
  if (state === "approval_boundary_review_required") return "stop_for_approval_boundary";
  if (state === "candidate_revision_required") return "revise_candidate";
  if (state === "forbidden_safety_invariant_violated") return "blocked_forbidden_safety_invariant";
  return "collect_worker_spawn_approval_request_evidence";
}

function evidencePatchForState(
  state: OIWorkerSpawnApprovalRequestState,
): Required<OIRuntimeReadinessEvidence> {
  const ready = state === "worker_spawn_approval_request_ready";
  return {
    runtimeExecutorDesignReviewed: ready,
    explicitRuntimeApprovalPresent: ready,
    brokerDispatchApprovalPresent: ready,
    workerSpawnApprovalPresent: false,
    mobilebetaMobileScopeResolved: false,
    rollbackAbortCriteriaDocumented: ready,
    liveBoundaryPlanDocumented: false,
    validationEvidenceFresh: ready,
  };
}

function blockersForChecks(checks: OIWorkerSpawnApprovalRequestCheck[]): string[] {
  return checks
    .filter((check) => check.status !== "pass")
    .map((check) => `${check.id}: ${check.summary}`);
}

function nextActionsForState(state: OIWorkerSpawnApprovalRequestState): string[] {
  if (state === "worker_spawn_approval_request_ready") {
    return [
      "present the worker/subagent spawn approval request to the operator as a separate approval gate",
      "record any operator response in a future source-only worker spawn approval decision evidence packet",
      "keep worker spawn approval, broker dispatch, runtime executor, and mobilebeta/mobile scope expansion disabled until later gates pass",
    ];
  }
  if (state === "broker_dispatch_evidence_not_ready") {
    return ["complete broker dispatch approval decision evidence before requesting worker spawn approval"];
  }
  if (state === "approval_boundary_review_required") {
    return ["stop broker dispatch progression", "request separate approval-boundary review"];
  }
  if (state === "candidate_revision_required") {
    return ["revise candidate and rerun broker dispatch validation packets"];
  }
  if (state === "forbidden_safety_invariant_violated") {
    return [
      "blocked: upstream broker dispatch decision evidence reports unsafe runtime mutation",
      "do not proceed with worker spawn approval request until upstream is corrected",
    ];
  }
  return ["collect missing worker spawn approval request evidence", "keep worker/subagent spawn approval absent"];
}

function spawnApprovalRequestFor(
  operator: string,
  brokerDispatchApprovalDecisionEvidence: OIBrokerDispatchApprovalDecisionEvidencePacket,
  evidence: OIWorkerSpawnApprovalRequestEvidence,
): OIWorkerSpawnApprovalRequestPacket["spawnApprovalRequest"] {
  const targetRepo = evidence.targetRepoDocumented
    ? (brokerDispatchApprovalDecisionEvidence.acceptedDecisionEvidence?.targetRepo ?? "jinwon-int/a2a-broker")
    : "";
  const targetIssueNumber = evidence.targetIssueDocumented
    ? (brokerDispatchApprovalDecisionEvidence.acceptedDecisionEvidence?.targetIssueNumber ?? 0)
    : brokerDispatchApprovalDecisionEvidence.roadmap.issueNumber;

  return {
    requestedApprovalPhrase: "APPROVE OI V2 WORKER SPAWN APPROVAL REQUEST FOR SOURCE-ONLY EVIDENCE REVIEW",
    operator,
    targetRepo,
    targetIssueNumber,
    spawnScope: [
      "record explicit worker/subagent spawn approval evidence in a future source-only packet",
      "keep worker/subagent spawn, broker task creation, executor invocation, and runtime enablement in separate future work",
      "keep mobilebeta/mobile scope expansion and no-live/live execution gates as independent gates",
    ],
    workerTeamConstraints: [
      "all spawned workers/subagents must remain source-only (no live executor, no DB mutation, no provider send)",
      "worker/subagent identity and capability must be verifiable without secrets",
      "worker/subagent spawn scope must not exceed the approved target repo/issue/scope",
      "workers/subagents must report completion or failure without live provider side-effects",
      "spawned workers/subagents must not exceed the allowed worker classes specified in the request",
    ],
    allowedWorkerClasses: [
      "source-only evidence collector (read-only, no mutation)",
      "source-only implementer (write to proposal/comments only, no live or DB mutation)",
      "source-only verifier (CI, tests, evidence review only)",
    ],
    noLiveExclusions: [
      "no live provider or Telegram canary send",
      "no deploy, restart, or service mutation",
      "no DB mutation, migration, or roll-forward",
      "no Terminal ACK/replay or historical replay",
      "no credential or secret movement",
      "no release or tag publish",
      "no runtime executor creation or enablement",
      "no actual worker/subagent process spawn",
      "no TaskFlow task creation or mutation",
    ],
    requiredConditions: [
      "operator identity must be recorded without secrets",
      "approval phrase must match the requested phrase exactly or be superseded by a stricter phrase",
      "approval must name the repository, issue, and spawn scope",
      "approval must specify allowed worker classes and enforce no-live/live exclusions",
      "approval must not authorize deploy, restart, DB mutation, live provider send, Terminal ACK/replay, release publish, or credential movement",
      "approval must not authorize actual subagent process spawn, broker task creation, executor invocation, or TaskFlow mutation",
      "approval may be revoked or expired before any later spawn enablement step",
    ],
    rollbackAbortRequirements: [
      "rollback plan must exist for any spawn-scope artifacts (proposals, comments, metadata patches)",
      "abort must be possible without live provider side-effects, DB roll-forward, or TaskFlow mutation",
      "spawn request must specify a revocation-trigger handler for each target scope",
    ],
    expiryOrRevocation: "expires when source packet, scope, operator identity, or broker dispatch readiness inputs change; or when upstream broker dispatch approval evidence is revoked or expired",
    nonGoals: [
      "actual worker or subagent process spawn at runtime",
      "broker task creation or dispatch at runtime",
      "executor invocation",
      "runtime executor enablement",
      "mobilebeta/mobile scope expansion",
      "live provider or Telegram canary",
      "deploy, restart, DB mutation, Terminal ACK/replay, release publish, or credential movement",
      "TaskFlow task creation or mutation",
    ],
    evidenceFieldsRequiredForFutureApproval: [
      "operator",
      "approvalPhrase",
      "approvedAt",
      "targetRepo",
      "targetIssueNumber",
      "spawnScope",
      "workerTeamConstraints",
      "allowedWorkerClasses",
      "noLiveExclusions",
      "conditions",
      "expiryOrRevocation",
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
