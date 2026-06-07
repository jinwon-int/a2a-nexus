import { createHash } from "node:crypto";

import {
  buildOIValidationFinalizerDecisionPacket,
  type OIValidationFinalizerDecisionPacket,
} from "./orchestration-intelligence-validation-finalizer-decision.js";

export type OIRuntimeReadinessGateState =
  | "no_go_runtime_executor"
  | "source_chain_not_ready"
  | "approval_boundary_review_required"
  | "candidate_revision_required"
  | "ready_for_runtime_design_review";

export interface OIRuntimeReadinessEvidence {
  runtimeExecutorDesignReviewed?: boolean;
  explicitRuntimeApprovalPresent?: boolean;
  brokerDispatchApprovalPresent?: boolean;
  workerSpawnApprovalPresent?: boolean;
  daegyoMobileScopeResolved?: boolean;
  rollbackAbortCriteriaDocumented?: boolean;
  liveBoundaryPlanDocumented?: boolean;
  validationEvidenceFresh?: boolean;
}

export interface OIRuntimeReadinessGateInput {
  generatedAt?: string;
  runId?: string;
  reviewer?: string;
  finalizerDecision?: OIValidationFinalizerDecisionPacket;
  runtimeEvidence?: OIRuntimeReadinessEvidence;
  notes?: string[];
}

export interface OIRuntimeReadinessGateCheck {
  id:
    | "source_chain_ready"
    | "runtime_executor_design_reviewed"
    | "explicit_runtime_approval_present"
    | "broker_dispatch_approval_present"
    | "worker_spawn_approval_present"
    | "daegyo_mobile_scope_resolved"
    | "rollback_abort_criteria_documented"
    | "live_boundary_plan_documented"
    | "validation_evidence_fresh";
  status: "pass" | "fail" | "review";
  summary: string;
}

export interface OIRuntimeReadinessGatePacket {
  kind: "a2a-broker.orchestration-intelligence.runtime-readiness-gate.packet";
  version: 1;
  generatedAt: string;
  runId: string;
  reviewer: string;
  sourceOnly: true;
  idempotencyKey: string;
  finalizerDecisionIdempotencyKey: string;
  operatorDecisionEvidenceIdempotencyKey: string;
  reviewRequestIdempotencyKey: string;
  finalizerReviewIdempotencyKey: string;
  scoreIdempotencyKey: string;
  frameworkIdempotencyKey: string;
  roadmap: OIValidationFinalizerDecisionPacket["roadmap"];
  state: OIRuntimeReadinessGateState;
  runtimeDisposition:
    | "no_go"
    | "wait_for_source_chain"
    | "stop_for_approval_boundary"
    | "revise_candidate"
    | "design_review_only";
  checks: OIRuntimeReadinessGateCheck[];
  blockers: string[];
  nextActions: string[];
  notes: string[];
  safety: {
    runtimeReadinessGateOnly: true;
    sourceOnly: true;
    grantsExecutionApproval: false;
    approvalGranted: false;
    runtimeExecutorCreated: false;
    runtimeExecutorEnabled: false;
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

export function buildOIRuntimeReadinessGatePacket(
  input: OIRuntimeReadinessGateInput = {},
): OIRuntimeReadinessGatePacket {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const finalizerDecision = input.finalizerDecision ?? buildOIValidationFinalizerDecisionPacket({ generatedAt });
  const runId = input.runId ?? `${finalizerDecision.runId}-runtime-readiness-gate`;
  const reviewer = input.reviewer ?? "broker-finalizer";
  const runtimeEvidence = input.runtimeEvidence ?? {};
  const checks = buildChecks(finalizerDecision, runtimeEvidence);
  const state = stateForChecks(finalizerDecision, checks);

  return {
    kind: "a2a-broker.orchestration-intelligence.runtime-readiness-gate.packet",
    version: 1,
    generatedAt,
    runId,
    reviewer,
    sourceOnly: true,
    idempotencyKey: stableId("oi-runtime-readiness-gate", {
      runId,
      reviewer,
      finalizerDecision: finalizerDecision.idempotencyKey,
      runtimeEvidence,
      state,
    }),
    finalizerDecisionIdempotencyKey: finalizerDecision.idempotencyKey,
    operatorDecisionEvidenceIdempotencyKey: finalizerDecision.operatorDecisionEvidenceIdempotencyKey,
    reviewRequestIdempotencyKey: finalizerDecision.reviewRequestIdempotencyKey,
    finalizerReviewIdempotencyKey: finalizerDecision.finalizerReviewIdempotencyKey,
    scoreIdempotencyKey: finalizerDecision.scoreIdempotencyKey,
    frameworkIdempotencyKey: finalizerDecision.frameworkIdempotencyKey,
    roadmap: finalizerDecision.roadmap,
    state,
    runtimeDisposition: dispositionForState(state),
    checks,
    blockers: blockersForChecks(checks),
    nextActions: nextActionsForState(state),
    notes: input.notes ?? [],
    safety: {
      runtimeReadinessGateOnly: true,
      sourceOnly: true,
      grantsExecutionApproval: false,
      approvalGranted: false,
      runtimeExecutorCreated: false,
      runtimeExecutorEnabled: false,
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

export function renderOIRuntimeReadinessGateMarkdown(packet: OIRuntimeReadinessGatePacket): string {
  return [
    "A2A Orchestration Intelligence v2 runtime readiness gate",
    `Roadmap: #${packet.roadmap.issueNumber}`,
    `State: ${packet.state}`,
    `Runtime disposition: ${packet.runtimeDisposition}`,
    `Reviewer: ${packet.reviewer}`,
    "Readiness checks:",
    ...packet.checks.map((check) => `- ${check.id}: ${check.status} - ${check.summary}`),
    "Blockers:",
    ...(packet.blockers.length ? packet.blockers.map((blocker) => `- ${blocker}`) : ["- none"]),
    "Next actions:",
    ...packet.nextActions.map((action) => `- ${action}`),
    "Safety: source-only runtime readiness gate; does not grant execution approval and does not create or enable a runtime executor, create broker dispatch, spawn workers, send providers, ACK/replay Terminal rows, mutate DB state, deploy/restart services, publish releases, or move credentials.",
  ].join("\n");
}

function buildChecks(
  finalizerDecision: OIValidationFinalizerDecisionPacket,
  evidence: OIRuntimeReadinessEvidence,
): OIRuntimeReadinessGateCheck[] {
  const sourceReady = finalizerDecision.state === "ready_for_next_source_step";
  return [
    {
      id: "source_chain_ready",
      status: sourceReady ? "pass" : "fail",
      summary: sourceReady
        ? "validation finalizer decision allows only the next source-only step"
        : `validation finalizer decision is ${finalizerDecision.state}`,
    },
    boolCheck(
      "runtime_executor_design_reviewed",
      evidence.runtimeExecutorDesignReviewed,
      "runtime executor design has a reviewed source packet",
      "runtime executor design review is missing",
    ),
    boolCheck(
      "explicit_runtime_approval_present",
      evidence.explicitRuntimeApprovalPresent,
      "explicit runtime approval evidence is present",
      "explicit runtime approval evidence is missing",
    ),
    boolCheck(
      "broker_dispatch_approval_present",
      evidence.brokerDispatchApprovalPresent,
      "broker dispatch approval evidence is present",
      "broker dispatch approval evidence is missing",
    ),
    boolCheck(
      "worker_spawn_approval_present",
      evidence.workerSpawnApprovalPresent,
      "worker spawn approval evidence is present",
      "worker spawn approval evidence is missing",
    ),
    boolCheck(
      "daegyo_mobile_scope_resolved",
      evidence.daegyoMobileScopeResolved,
      "Daegyo/mobile worker scope limits are resolved for this runtime path",
      "Daegyo/mobile workers remain limited to no-live evidence and approved proof-marker paths",
    ),
    boolCheck(
      "rollback_abort_criteria_documented",
      evidence.rollbackAbortCriteriaDocumented,
      "rollback and abort criteria are documented",
      "rollback and abort criteria are missing",
    ),
    boolCheck(
      "live_boundary_plan_documented",
      evidence.liveBoundaryPlanDocumented,
      "live provider, DB, deploy, Terminal, release, and credential boundaries are documented",
      "live boundary plan is missing",
    ),
    boolCheck(
      "validation_evidence_fresh",
      evidence.validationEvidenceFresh,
      "validation evidence freshness is confirmed",
      "validation evidence freshness is unconfirmed",
    ),
  ];
}

function boolCheck(
  id: OIRuntimeReadinessGateCheck["id"],
  value: boolean | undefined,
  passSummary: string,
  failSummary: string,
): OIRuntimeReadinessGateCheck {
  return {
    id,
    status: value === true ? "pass" : "fail",
    summary: value === true ? passSummary : failSummary,
  };
}

function stateForChecks(
  finalizerDecision: OIValidationFinalizerDecisionPacket,
  checks: OIRuntimeReadinessGateCheck[],
): OIRuntimeReadinessGateState {
  if (finalizerDecision.state === "approval_boundary_review_required") return "approval_boundary_review_required";
  if (finalizerDecision.state === "candidate_revision_required") return "candidate_revision_required";
  if (finalizerDecision.state !== "ready_for_next_source_step") return "source_chain_not_ready";
  return checks.every((check) => check.status === "pass")
    ? "ready_for_runtime_design_review"
    : "no_go_runtime_executor";
}

function dispositionForState(
  state: OIRuntimeReadinessGateState,
): OIRuntimeReadinessGatePacket["runtimeDisposition"] {
  if (state === "ready_for_runtime_design_review") return "design_review_only";
  if (state === "source_chain_not_ready") return "wait_for_source_chain";
  if (state === "approval_boundary_review_required") return "stop_for_approval_boundary";
  if (state === "candidate_revision_required") return "revise_candidate";
  return "no_go";
}

function blockersForChecks(checks: OIRuntimeReadinessGateCheck[]): string[] {
  return checks
    .filter((check) => check.status !== "pass")
    .map((check) => `${check.id}: ${check.summary}`);
}

function nextActionsForState(state: OIRuntimeReadinessGateState): string[] {
  if (state === "ready_for_runtime_design_review") {
    return ["preserve this packet for broker finalizer review", "open a separate runtime design review issue if needed"];
  }
  if (state === "source_chain_not_ready") return ["complete source-only validation decision chain before runtime readiness review"];
  if (state === "approval_boundary_review_required") return ["stop runtime progression", "request separate approval-boundary review"];
  if (state === "candidate_revision_required") return ["revise candidate and rerun validation packets"];
  return ["keep runtime executor disabled", "collect missing runtime readiness evidence before another gate review"];
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
