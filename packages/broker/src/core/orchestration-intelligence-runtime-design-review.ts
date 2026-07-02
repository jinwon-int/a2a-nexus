import { createHash } from "node:crypto";

import {
  buildOIRuntimeReadinessGatePacket,
  type OIRuntimeReadinessEvidence,
  type OIRuntimeReadinessGatePacket,
} from "./orchestration-intelligence-runtime-readiness-gate.js";

export type OIRuntimeDesignReviewState =
  | "design_review_ready"
  | "design_review_incomplete"
  | "source_chain_not_ready"
  | "approval_boundary_review_required"
  | "candidate_revision_required";

export interface OIRuntimeDesignReviewEvidence {
  executorContractDocumented?: boolean;
  brokerDispatchBoundaryDocumented?: boolean;
  workerSpawnBoundaryDocumented?: boolean;
  mobilebetaMobileBoundaryDocumented?: boolean;
  rollbackAbortCriteriaDocumented?: boolean;
  liveBoundaryPlanDocumented?: boolean;
  observabilityPlanDocumented?: boolean;
}

export interface OIRuntimeDesignReviewInput {
  generatedAt?: string;
  runId?: string;
  reviewer?: string;
  runtimeReadinessGate?: OIRuntimeReadinessGatePacket;
  designEvidence?: OIRuntimeDesignReviewEvidence;
  notes?: string[];
}

export interface OIRuntimeDesignReviewCheck {
  id:
    | "source_chain_ready"
    | "executor_contract_documented"
    | "broker_dispatch_boundary_documented"
    | "worker_spawn_boundary_documented"
    | "mobilebeta_mobile_boundary_documented"
    | "rollback_abort_criteria_documented"
    | "live_boundary_plan_documented"
    | "observability_plan_documented";
  status: "pass" | "fail" | "review";
  summary: string;
}

export interface OIRuntimeDesignReviewPacket {
  kind: "a2a-broker.orchestration-intelligence.runtime-design-review.packet";
  version: 1;
  generatedAt: string;
  runId: string;
  reviewer: string;
  sourceOnly: true;
  idempotencyKey: string;
  runtimeReadinessGateIdempotencyKey: string;
  finalizerDecisionIdempotencyKey: string;
  operatorDecisionEvidenceIdempotencyKey: string;
  reviewRequestIdempotencyKey: string;
  finalizerReviewIdempotencyKey: string;
  scoreIdempotencyKey: string;
  frameworkIdempotencyKey: string;
  roadmap: OIRuntimeReadinessGatePacket["roadmap"];
  state: OIRuntimeDesignReviewState;
  disposition:
    | "runtime_design_review_recorded"
    | "collect_design_evidence"
    | "wait_for_source_chain"
    | "stop_for_approval_boundary"
    | "revise_candidate";
  checks: OIRuntimeDesignReviewCheck[];
  blockers: string[];
  nextActions: string[];
  notes: string[];
  runtimeReadinessEvidencePatch: Required<OIRuntimeReadinessEvidence>;
  safety: {
    runtimeDesignReviewOnly: true;
    sourceOnly: true;
    grantsExecutionApproval: false;
    approvalGranted: false;
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

export function buildOIRuntimeDesignReviewPacket(
  input: OIRuntimeDesignReviewInput = {},
): OIRuntimeDesignReviewPacket {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const runtimeReadinessGate = input.runtimeReadinessGate ?? buildOIRuntimeReadinessGatePacket({ generatedAt });
  const runId = input.runId ?? `${runtimeReadinessGate.runId}-runtime-design-review`;
  const reviewer = input.reviewer ?? "broker-finalizer";
  const designEvidence = input.designEvidence ?? {};
  const checks = buildChecks(runtimeReadinessGate, designEvidence);
  const state = stateFor(runtimeReadinessGate, checks);
  const runtimeReadinessEvidencePatch = evidencePatchForState(state);

  return {
    kind: "a2a-broker.orchestration-intelligence.runtime-design-review.packet",
    version: 1,
    generatedAt,
    runId,
    reviewer,
    sourceOnly: true,
    idempotencyKey: stableId("oi-runtime-design-review", {
      runId,
      reviewer,
      runtimeReadinessGate: runtimeReadinessGate.idempotencyKey,
      designEvidence,
      state,
    }),
    runtimeReadinessGateIdempotencyKey: runtimeReadinessGate.idempotencyKey,
    finalizerDecisionIdempotencyKey: runtimeReadinessGate.finalizerDecisionIdempotencyKey,
    operatorDecisionEvidenceIdempotencyKey: runtimeReadinessGate.operatorDecisionEvidenceIdempotencyKey,
    reviewRequestIdempotencyKey: runtimeReadinessGate.reviewRequestIdempotencyKey,
    finalizerReviewIdempotencyKey: runtimeReadinessGate.finalizerReviewIdempotencyKey,
    scoreIdempotencyKey: runtimeReadinessGate.scoreIdempotencyKey,
    frameworkIdempotencyKey: runtimeReadinessGate.frameworkIdempotencyKey,
    roadmap: runtimeReadinessGate.roadmap,
    state,
    disposition: dispositionForState(state),
    checks,
    blockers: blockersForChecks(checks),
    nextActions: nextActionsForState(state),
    notes: input.notes ?? [],
    runtimeReadinessEvidencePatch,
    safety: {
      runtimeDesignReviewOnly: true,
      sourceOnly: true,
      grantsExecutionApproval: false,
      approvalGranted: false,
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

export function renderOIRuntimeDesignReviewMarkdown(packet: OIRuntimeDesignReviewPacket): string {
  return [
    "A2A Orchestration Intelligence v2 runtime design review",
    `Roadmap: #${packet.roadmap.issueNumber}`,
    `State: ${packet.state}`,
    `Disposition: ${packet.disposition}`,
    `Reviewer: ${packet.reviewer}`,
    "Design checks:",
    ...packet.checks.map((check) => `- ${check.id}: ${check.status} - ${check.summary}`),
    "Blockers:",
    ...(packet.blockers.length ? packet.blockers.map((blocker) => `- ${blocker}`) : ["- none"]),
    "Runtime readiness evidence patch:",
    ...Object.entries(packet.runtimeReadinessEvidencePatch).map(([key, value]) => `- ${key}: ${value}`),
    "Next actions:",
    ...packet.nextActions.map((action) => `- ${action}`),
    "Safety: source-only runtime design review; records design evidence only. It does not grant execution approval, enable or create a runtime executor, create broker dispatch, spawn workers, expand mobilebeta/mobile scope, send providers, ACK/replay Terminal rows, mutate DB state, deploy/restart services, publish releases, or move credentials.",
  ].join("\n");
}

function buildChecks(
  runtimeReadinessGate: OIRuntimeReadinessGatePacket,
  evidence: OIRuntimeDesignReviewEvidence,
): OIRuntimeDesignReviewCheck[] {
  const sourceReady = runtimeReadinessGate.checks.some((check) =>
    check.id === "source_chain_ready" && check.status === "pass"
  );
  return [
    {
      id: "source_chain_ready",
      status: sourceReady ? "pass" : "fail",
      summary: sourceReady
        ? "runtime readiness gate is backed by a source-ready validation chain"
        : "runtime readiness gate is not backed by a source-ready validation chain",
    },
    boolCheck(
      "executor_contract_documented",
      evidence.executorContractDocumented,
      "runtime executor contract is documented as a design artifact",
      "runtime executor contract is missing",
    ),
    boolCheck(
      "broker_dispatch_boundary_documented",
      evidence.brokerDispatchBoundaryDocumented,
      "broker dispatch boundary is documented without creating dispatch",
      "broker dispatch boundary is missing",
    ),
    boolCheck(
      "worker_spawn_boundary_documented",
      evidence.workerSpawnBoundaryDocumented,
      "worker spawn boundary is documented without spawning workers",
      "worker spawn boundary is missing",
    ),
    boolCheck(
      "mobilebeta_mobile_boundary_documented",
      evidence.mobilebetaMobileBoundaryDocumented,
      "mobilebeta/mobile boundary remains constrained and documented",
      "mobilebeta/mobile boundary is missing",
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
      "observability_plan_documented",
      evidence.observabilityPlanDocumented,
      "observability and finalizer evidence handoff are documented",
      "observability plan is missing",
    ),
  ];
}

function boolCheck(
  id: OIRuntimeDesignReviewCheck["id"],
  value: boolean | undefined,
  passSummary: string,
  failSummary: string,
): OIRuntimeDesignReviewCheck {
  return {
    id,
    status: value === true ? "pass" : "fail",
    summary: value === true ? passSummary : failSummary,
  };
}

function stateFor(
  runtimeReadinessGate: OIRuntimeReadinessGatePacket,
  checks: OIRuntimeDesignReviewCheck[],
): OIRuntimeDesignReviewState {
  if (runtimeReadinessGate.state === "approval_boundary_review_required") return "approval_boundary_review_required";
  if (runtimeReadinessGate.state === "candidate_revision_required") return "candidate_revision_required";
  const sourceReady = checks.some((check) => check.id === "source_chain_ready" && check.status === "pass");
  if (!sourceReady) return "source_chain_not_ready";
  return checks.every((check) => check.status === "pass")
    ? "design_review_ready"
    : "design_review_incomplete";
}

function dispositionForState(
  state: OIRuntimeDesignReviewState,
): OIRuntimeDesignReviewPacket["disposition"] {
  if (state === "design_review_ready") return "runtime_design_review_recorded";
  if (state === "source_chain_not_ready") return "wait_for_source_chain";
  if (state === "approval_boundary_review_required") return "stop_for_approval_boundary";
  if (state === "candidate_revision_required") return "revise_candidate";
  return "collect_design_evidence";
}

function evidencePatchForState(state: OIRuntimeDesignReviewState): Required<OIRuntimeReadinessEvidence> {
  return {
    runtimeExecutorDesignReviewed: state === "design_review_ready",
    explicitRuntimeApprovalPresent: false,
    brokerDispatchApprovalPresent: false,
    workerSpawnApprovalPresent: false,
    mobilebetaMobileScopeResolved: false,
    rollbackAbortCriteriaDocumented: false,
    liveBoundaryPlanDocumented: false,
    validationEvidenceFresh: true,
  };
}

function blockersForChecks(checks: OIRuntimeDesignReviewCheck[]): string[] {
  return checks
    .filter((check) => check.status !== "pass")
    .map((check) => `${check.id}: ${check.summary}`);
}

function nextActionsForState(state: OIRuntimeDesignReviewState): string[] {
  if (state === "design_review_ready") {
    return [
      "feed runtimeExecutorDesignReviewed=true into the next runtime readiness gate review",
      "keep explicit runtime approval, broker dispatch approval, worker spawn approval, and mobilebeta/mobile scope expansion as separate NO-GO gates",
    ];
  }
  if (state === "source_chain_not_ready") return ["complete source-only validation chain before design review"];
  if (state === "approval_boundary_review_required") return ["stop runtime progression", "request separate approval-boundary review"];
  if (state === "candidate_revision_required") return ["revise candidate and rerun validation packets"];
  return ["collect missing runtime design evidence", "keep runtime executor disabled"];
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
