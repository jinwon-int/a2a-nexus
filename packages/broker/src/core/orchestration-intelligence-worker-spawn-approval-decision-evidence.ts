import { createHash } from "node:crypto";

import {
  buildOIWorkerSpawnApprovalRequestPacket,
  type OIWorkerSpawnApprovalRequestPacket,
} from "./orchestration-intelligence-worker-spawn-approval-request.js";
import type { OIRuntimeReadinessEvidence } from "./orchestration-intelligence-runtime-readiness-gate.js";

export type OIWorkerSpawnApprovalDecisionEvidenceState =
  | "worker_spawn_approval_evidence_accepted"
  | "worker_spawn_approval_evidence_missing"
  | "worker_spawn_approval_evidence_rejected"
  | "worker_spawn_approval_evidence_expired"
  | "worker_spawn_approval_evidence_conflicting"
  | "worker_spawn_approval_evidence_invalid"
  | "worker_spawn_approval_request_not_ready"
  | "worker_spawn_boundary_review_required"
  | "worker_spawn_candidate_revision_required"
  | "worker_spawn_forbidden_safety_invariant_violated";

export type OIWorkerSpawnApprovalDecisionKind =
  | "approval_grant"
  | "rejected"
  | "expired"
  | "conflict";

export interface OIWorkerSpawnApprovalDecisionEvidence {
  kind?: OIWorkerSpawnApprovalDecisionKind;
  operator?: string;
  approvalPhrase?: string;
  approvedAt?: string;
  expiresAt?: string;
  targetRepo?: string;
  targetIssueNumber?: number;
  spawnScope?: string[];
  allowedWorkerClasses?: string[];
  noLiveExclusions?: string[];
  conditions?: string[];
  conditionsAccepted?: boolean;
  revocationOrExpiry?: string;
  rationale?: string;
}

export interface OIWorkerSpawnApprovalDecisionEvidenceInput {
  generatedAt?: string;
  runId?: string;
  recorder?: string;
  expectedRepo?: string;
  expectedIssueNumber?: number;
  workerSpawnApprovalRequest?: OIWorkerSpawnApprovalRequestPacket;
  decisionEvidence?: OIWorkerSpawnApprovalDecisionEvidence;
  notes?: string[];
}

export interface OIWorkerSpawnApprovalDecisionEvidenceCheck {
  id:
    | "worker_spawn_approval_request_ready"
    | "decision_kind_is_approval_grant"
    | "operator_matches_request"
    | "approval_phrase_matches_request"
    | "approved_at_valid"
    | "approval_not_expired"
    | "target_repo_and_issue_match"
    | "spawn_scope_matches_request"
    | "allowed_worker_classes_match_request"
    | "no_live_exclusions_match_request"
    | "conditions_accepted"
    | "revocation_or_expiry_documented";
  status: "pass" | "fail" | "review";
  summary: string;
}

export interface OIWorkerSpawnApprovalDecisionEvidencePacket {
  kind: "a2a-broker.orchestration-intelligence.worker-spawn-approval-decision-evidence.packet";
  version: 1;
  generatedAt: string;
  runId: string;
  recorder: string;
  sourceOnly: true;
  idempotencyKey: string;
  workerSpawnApprovalRequestIdempotencyKey: string;
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
  roadmap: OIWorkerSpawnApprovalRequestPacket["roadmap"];
  state: OIWorkerSpawnApprovalDecisionEvidenceState;
  disposition:
    | "record_explicit_worker_spawn_approval_evidence"
    | "wait_for_operator_worker_spawn_response"
    | "record_worker_spawn_rejection"
    | "record_worker_spawn_expiry"
    | "stop_for_worker_spawn_conflict_resolution"
    | "reject_invalid_worker_spawn_approval_evidence"
    | "wait_for_worker_spawn_approval_request"
    | "stop_for_worker_spawn_boundary"
    | "revise_candidate_for_worker_spawn"
    | "blocked_forbidden_safety_invariant";
  checks: OIWorkerSpawnApprovalDecisionEvidenceCheck[];
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
    workerSpawnApprovalDecisionEvidenceOnly: true;
    sourceOnly: true;
    grantsExecutionApproval: false;
    workerSpawnApprovalEvidenceAccepted: boolean;
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

export function buildOIWorkerSpawnApprovalDecisionEvidencePacket(
  input: OIWorkerSpawnApprovalDecisionEvidenceInput = {},
): OIWorkerSpawnApprovalDecisionEvidencePacket {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const workerSpawnApprovalRequest =
    input.workerSpawnApprovalRequest ?? buildOIWorkerSpawnApprovalRequestPacket({ generatedAt });
  const runId = input.runId ?? `${workerSpawnApprovalRequest.runId}-worker-spawn-approval-decision-evidence`;
  const recorder = input.recorder ?? "broker-finalizer";
  const expectedRepo = input.expectedRepo ?? "jinwon-int/a2a-broker";
  const expectedIssueNumber = input.expectedIssueNumber ?? workerSpawnApprovalRequest.roadmap.issueNumber;
  const decisionEvidence = input.decisionEvidence;
  const checks = buildChecks({
    generatedAt,
    workerSpawnApprovalRequest,
    decisionEvidence,
    expectedRepo,
    expectedIssueNumber,
  });
  const state = stateFor(workerSpawnApprovalRequest, decisionEvidence, checks);

  return {
    kind: "a2a-broker.orchestration-intelligence.worker-spawn-approval-decision-evidence.packet",
    version: 1,
    generatedAt,
    runId,
    recorder,
    sourceOnly: true,
    idempotencyKey: stableId("oi-worker-spawn-approval-decision-evidence", {
      runId,
      recorder,
      expectedRepo,
      expectedIssueNumber,
      workerSpawnApprovalRequest: workerSpawnApprovalRequest.idempotencyKey,
      decisionEvidence,
      state,
    }),
    workerSpawnApprovalRequestIdempotencyKey: workerSpawnApprovalRequest.idempotencyKey,
    brokerDispatchApprovalDecisionEvidenceIdempotencyKey:
      workerSpawnApprovalRequest.brokerDispatchApprovalDecisionEvidenceIdempotencyKey,
    brokerDispatchApprovalRequestIdempotencyKey:
      workerSpawnApprovalRequest.brokerDispatchApprovalRequestIdempotencyKey,
    runtimeApprovalDecisionEvidenceIdempotencyKey:
      workerSpawnApprovalRequest.runtimeApprovalDecisionEvidenceIdempotencyKey,
    runtimeApprovalRequestIdempotencyKey: workerSpawnApprovalRequest.runtimeApprovalRequestIdempotencyKey,
    runtimeDesignReviewIdempotencyKey: workerSpawnApprovalRequest.runtimeDesignReviewIdempotencyKey,
    runtimeReadinessGateIdempotencyKey: workerSpawnApprovalRequest.runtimeReadinessGateIdempotencyKey,
    finalizerDecisionIdempotencyKey: workerSpawnApprovalRequest.finalizerDecisionIdempotencyKey,
    operatorDecisionEvidenceIdempotencyKey: workerSpawnApprovalRequest.operatorDecisionEvidenceIdempotencyKey,
    reviewRequestIdempotencyKey: workerSpawnApprovalRequest.reviewRequestIdempotencyKey,
    finalizerReviewIdempotencyKey: workerSpawnApprovalRequest.finalizerReviewIdempotencyKey,
    scoreIdempotencyKey: workerSpawnApprovalRequest.scoreIdempotencyKey,
    frameworkIdempotencyKey: workerSpawnApprovalRequest.frameworkIdempotencyKey,
    roadmap: workerSpawnApprovalRequest.roadmap,
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
      workerSpawnApprovalDecisionEvidenceOnly: true,
      sourceOnly: true,
      grantsExecutionApproval: false,
      workerSpawnApprovalEvidenceAccepted: state === "worker_spawn_approval_evidence_accepted",
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

export function renderOIWorkerSpawnApprovalDecisionEvidenceMarkdown(
  packet: OIWorkerSpawnApprovalDecisionEvidencePacket,
): string {
  return [
    "A2A Orchestration Intelligence v2 worker/subagent spawn approval decision evidence",
    `Roadmap: #${packet.roadmap.issueNumber}`,
    `State: ${packet.state}`,
    `Disposition: ${packet.disposition}`,
    `Recorder: ${packet.recorder}`,
    "Worker spawn approval decision checks:",
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
    "Safety: source-only worker/subagent spawn approval decision evidence. It may record explicit worker",
    "spawn approval evidence for a later readiness gate, but it does not grant execution approval, enable",
    "or create a runtime executor, create broker dispatch tasks, spawn workers/subagents, expand",
    "mobilebeta/mobile scope, send providers, ACK/replay Terminal rows, mutate DB state, deploy/restart",
    "services, publish releases, or move credentials. workerSpawnApprovalPresent remains a source readiness flag only.",
  ].join("\n");
}

function buildChecks(input: {
  generatedAt: string;
  workerSpawnApprovalRequest: OIWorkerSpawnApprovalRequestPacket;
  decisionEvidence: OIWorkerSpawnApprovalDecisionEvidence | undefined;
  expectedRepo: string;
  expectedIssueNumber: number;
}): OIWorkerSpawnApprovalDecisionEvidenceCheck[] {
  const requestReady = input.workerSpawnApprovalRequest.state === "worker_spawn_approval_request_ready";
  const evidence = input.decisionEvidence;
  return [
    {
      id: "worker_spawn_approval_request_ready",
      status: requestReady ? "pass" : "fail",
      summary: requestReady
        ? "worker/spawn approval request is ready for an operator response"
        : `worker/spawn approval request is ${input.workerSpawnApprovalRequest.state}`,
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
      status: evidence?.operator === input.workerSpawnApprovalRequest.operator ? "pass" : "fail",
      summary: evidence?.operator === input.workerSpawnApprovalRequest.operator
        ? "operator matches the worker/spawn approval request"
        : "operator is missing or does not match the worker/spawn approval request",
    },
    {
      id: "approval_phrase_matches_request",
      status: evidence?.approvalPhrase === input.workerSpawnApprovalRequest.spawnApprovalRequest.requestedApprovalPhrase
        ? "pass"
        : "fail",
      summary: evidence?.approvalPhrase === input.workerSpawnApprovalRequest.spawnApprovalRequest.requestedApprovalPhrase
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
        ? "worker spawn approval is not expired at packet generation time"
        : "worker spawn approval is expired or expiry is invalid",
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
      id: "spawn_scope_matches_request",
      status: scopeMatches(
        input.workerSpawnApprovalRequest.spawnApprovalRequest.requiredConditions,
        evidence?.spawnScope,
      )
        ? "pass"
        : "fail",
      summary: scopeMatches(
        input.workerSpawnApprovalRequest.spawnApprovalRequest.requiredConditions,
        evidence?.spawnScope,
      )
        ? "worker spawn approval evidence scope covers the requested conditions"
        : "worker spawn approval evidence scope is missing or does not cover the requested conditions",
    },
    {
      id: "allowed_worker_classes_match_request",
      status: coversAll(
        input.workerSpawnApprovalRequest.spawnApprovalRequest.allowedWorkerClasses,
        evidence?.allowedWorkerClasses,
      )
        ? "pass"
        : "fail",
      summary: coversAll(
        input.workerSpawnApprovalRequest.spawnApprovalRequest.allowedWorkerClasses,
        evidence?.allowedWorkerClasses,
      )
        ? "allowed worker classes in approval evidence match the request"
        : "allowed worker classes are missing or do not match the request",
    },
    {
      id: "no_live_exclusions_match_request",
      status: coversAll(
        input.workerSpawnApprovalRequest.spawnApprovalRequest.noLiveExclusions,
        evidence?.noLiveExclusions,
      )
        ? "pass"
        : "fail",
      summary: coversAll(
        input.workerSpawnApprovalRequest.spawnApprovalRequest.noLiveExclusions,
        evidence?.noLiveExclusions,
      )
        ? "no-live/live exclusions in approval evidence match the request"
        : "no-live/live exclusions are missing or do not match the request",
    },
    {
      id: "conditions_accepted",
      status: evidence?.conditionsAccepted === true && coversAll(
        input.workerSpawnApprovalRequest.spawnApprovalRequest.requiredConditions,
        evidence?.conditions,
      )
        ? "pass"
        : "fail",
      summary: evidence?.conditionsAccepted === true && coversAll(
        input.workerSpawnApprovalRequest.spawnApprovalRequest.requiredConditions,
        evidence?.conditions,
      )
        ? "worker spawn approval conditions are explicitly accepted"
        : "worker spawn approval conditions are missing or not explicitly accepted",
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
  workerSpawnApprovalRequest: OIWorkerSpawnApprovalRequestPacket,
  evidence: OIWorkerSpawnApprovalDecisionEvidence | undefined,
  checks: OIWorkerSpawnApprovalDecisionEvidenceCheck[],
): OIWorkerSpawnApprovalDecisionEvidenceState {
  if (workerSpawnApprovalRequest.state === "approval_boundary_review_required") {
    return "worker_spawn_boundary_review_required";
  }
  if (workerSpawnApprovalRequest.state === "candidate_revision_required") {
    return "worker_spawn_candidate_revision_required";
  }
  if (
    workerSpawnApprovalRequest.state === "worker_spawn_approval_request_ready" &&
    !workerSpawnApprovalRequest.safety.workerSpawnApprovalRequestOnly
  ) {
    return "worker_spawn_forbidden_safety_invariant_violated";
  }
  if (workerSpawnApprovalRequest.state === "forbidden_safety_invariant_violated") {
    return "worker_spawn_forbidden_safety_invariant_violated";
  }
  if (workerSpawnApprovalRequest.state !== "worker_spawn_approval_request_ready") {
    return "worker_spawn_approval_request_not_ready";
  }
  if (!evidence) return "worker_spawn_approval_evidence_missing";
  if (evidence.kind === "rejected") return "worker_spawn_approval_evidence_rejected";
  if (evidence.kind === "expired") return "worker_spawn_approval_evidence_expired";
  if (evidence.kind === "conflict") return "worker_spawn_approval_evidence_conflicting";
  if (checks.every((check) => check.status === "pass")) return "worker_spawn_approval_evidence_accepted";
  return "worker_spawn_approval_evidence_invalid";
}

function dispositionForState(
  state: OIWorkerSpawnApprovalDecisionEvidenceState,
): OIWorkerSpawnApprovalDecisionEvidencePacket["disposition"] {
  if (state === "worker_spawn_approval_evidence_accepted") return "record_explicit_worker_spawn_approval_evidence";
  if (state === "worker_spawn_approval_evidence_missing") return "wait_for_operator_worker_spawn_response";
  if (state === "worker_spawn_approval_evidence_rejected") return "record_worker_spawn_rejection";
  if (state === "worker_spawn_approval_evidence_expired") return "record_worker_spawn_expiry";
  if (state === "worker_spawn_approval_evidence_conflicting") return "stop_for_worker_spawn_conflict_resolution";
  if (state === "worker_spawn_approval_request_not_ready") return "wait_for_worker_spawn_approval_request";
  if (state === "worker_spawn_boundary_review_required") return "stop_for_worker_spawn_boundary";
  if (state === "worker_spawn_candidate_revision_required") return "revise_candidate_for_worker_spawn";
  if (state === "worker_spawn_forbidden_safety_invariant_violated") return "blocked_forbidden_safety_invariant";
  return "reject_invalid_worker_spawn_approval_evidence";
}

function blockersForState(
  state: OIWorkerSpawnApprovalDecisionEvidenceState,
  checks: OIWorkerSpawnApprovalDecisionEvidenceCheck[],
): string[] {
  if (state === "worker_spawn_approval_evidence_rejected") return ["operator response rejected worker spawn approval"];
  if (state === "worker_spawn_approval_evidence_expired") return ["operator worker spawn approval evidence is expired"];
  if (state === "worker_spawn_approval_evidence_conflicting") {
    return ["conflicting operator worker spawn approval evidence requires manual resolution"];
  }
  if (state === "worker_spawn_forbidden_safety_invariant_violated") {
    return ["forbidden safety invariant violated: upstream worker/spawn request has unsafe state"];
  }
  return checks
    .filter((check) => check.status !== "pass")
    .map((check) => `${check.id}: ${check.summary}`);
}

function nextActionsForState(state: OIWorkerSpawnApprovalDecisionEvidenceState): string[] {
  if (state === "worker_spawn_approval_evidence_accepted") {
    return [
      "feed workerSpawnApprovalPresent=true into a later readiness gate review",
      "keep worker/subagent process spawn, broker task creation, executor invocation, mobilebeta/mobile scope resolution, rollback/live readiness, and executor enablement as separate gates",
    ];
  }
  if (state === "worker_spawn_approval_evidence_missing") {
    return ["wait for a scoped operator response to the worker/spawn approval request"];
  }
  if (state === "worker_spawn_approval_evidence_rejected") return ["record rejection and keep worker spawn approval absent"];
  if (state === "worker_spawn_approval_evidence_expired") return ["refresh worker spawn approval request before considering spawn approval"];
  if (state === "worker_spawn_approval_evidence_conflicting") {
    return ["resolve conflicting operator worker spawn evidence before proceeding"];
  }
  if (state === "worker_spawn_approval_request_not_ready") {
    return ["complete worker spawn approval request packet before ingesting decision evidence"];
  }
  if (state === "worker_spawn_boundary_review_required") {
    return ["stop worker spawn progression", "request separate worker-spawn-boundary review"];
  }
  if (state === "worker_spawn_candidate_revision_required") {
    return ["revise candidate and rerun worker spawn validation packets"];
  }
  if (state === "worker_spawn_forbidden_safety_invariant_violated") {
    return [
      "blocked: upstream worker spawn approval request reports unsafe runtime mutation",
      "do not proceed with worker spawn approval decision evidence until upstream is corrected",
    ];
  }
  return ["collect corrected operator worker spawn approval evidence", "keep worker/subagent spawn approval absent"];
}

function evidencePatchForState(
  state: OIWorkerSpawnApprovalDecisionEvidenceState,
): Required<OIRuntimeReadinessEvidence> {
  const accepted = state === "worker_spawn_approval_evidence_accepted";
  return {
    runtimeExecutorDesignReviewed: accepted,
    explicitRuntimeApprovalPresent: accepted,
    brokerDispatchApprovalPresent: accepted,
    workerSpawnApprovalPresent: accepted,
    mobilebetaMobileScopeResolved: false,
    rollbackAbortCriteriaDocumented: accepted,
    liveBoundaryPlanDocumented: false,
    validationEvidenceFresh: accepted,
  };
}

function acceptedDecisionForState(
  state: OIWorkerSpawnApprovalDecisionEvidenceState,
  evidence: OIWorkerSpawnApprovalDecisionEvidence | undefined,
  expectedRepo: string,
  expectedIssueNumber: number,
): OIWorkerSpawnApprovalDecisionEvidencePacket["acceptedDecisionEvidence"] {
  if (state !== "worker_spawn_approval_evidence_accepted" || !evidence) return null;
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
