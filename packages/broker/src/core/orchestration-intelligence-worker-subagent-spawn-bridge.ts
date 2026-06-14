import { isRecord } from "./value-guards.js";
import { createHash } from "node:crypto";

import type { OIWorkerSpawnApprovalDecisionEvidencePacket } from "./orchestration-intelligence-worker-spawn-approval-decision-evidence.js";
import type { A2AWorkerSubagentSpawnAuthorizationRequestPacket } from "./worker-subagent-spawn-authorization-request.js";

/**
 * OI v2 worker/subagent spawn authorization request bridge packet.
 *
 * Bridges the A2A broker v1 worker-subagent-spawn-authorization-request
 * packet type into the Orchestration Intelligence v2 pipeline.
 *
 * This is a source-only bridge. It does not grant authorization, spawn
 * subagents, dispatch broker work, or mutate any state. It translates
 * the v1 authorization request semantics into an OI v2 compatible
 * approval request shape so that the OI v2 finalizer or operator can
 * review and respond in the v2 evidence pipeline.
 */

export type OIWorkerSubagentSpawnAuthorizationBridgeState =
  | "bridge_ready"
  | "bridge_worker_spawn_decision_evidence_not_accepted"
  | "bridge_v1_authorization_request_not_ready"
  | "bridge_blocked_v1_boundary_drift"
  | "bridge_blocked_v1_state";

export interface OIWorkerSubagentSpawnAuthorizationBridgeCheck {
  id:
    | "worker_spawn_approval_decision_evidence_accepted"
    | "worker_spawn_approval_decision_source_only"
    | "v1_authorization_request_state_ready"
    | "v1_source_only_boundaries_intact"
    | "v1_finalizer_present"
    | "v1_recommended_roles_mapped"
    | "v1_dispatch_required"
  | "v1_semantics_source_only_contract";
  status: "pass" | "fail" | "review";
  summary: string;
}

export interface OIWorkerSubagentSpawnAuthorizationBridgePacket {
  kind: "a2a-broker.orchestration-intelligence.worker-subagent-spawn-authorization-bridge.packet";
  version: 1;
  generatedAt: string;
  sourceOnly: true;
  idempotencyKey: string;

  /** Tracks the original v1 idempotency key for upstream traceability. */
  v1AuthorizationRequestIdempotencyKey: string;

  /** Tracks the prior OI v2 worker spawn approval decision evidence layer. */
  workerSpawnApprovalDecisionEvidenceIdempotencyKey: string | null;

  /** Bridge state derived from the v1 packet. */
  state: OIWorkerSubagentSpawnAuthorizationBridgeState;

  /** Worker identity and finalizer copied from the v1 packet. */
  workerId: string;
  taskId?: string;
  finalizer: string;

  /** V1 source trace — provenance chain. */
  v1Source: {
    authorizationRequestState: A2AWorkerSubagentSpawnAuthorizationRequestPacket["state"];
    plannerHandoffIdempotencyKey: string;
    selfAssessmentIdempotencyKey: string;
    plannerPolicyIdempotencyKey: string;
    plannerParallelismHint: 0 | 1 | 2 | 3 | 4;
    recommendedRoles: string[];
    authorizationReference: string;
    requestReference: string;
  };

  /** OI v2 upstream source trace. */
  oiV2Source: {
    workerSpawnApprovalDecisionEvidenceState: OIWorkerSpawnApprovalDecisionEvidencePacket["state"] | "missing";
    workerSpawnApprovalPresent: boolean;
    sourceOnly: boolean;
  };

  /** OI v2 bridge output — maps the v1 authorization request into the OI v2 shape. */
  oiV2Output: {
    bridgeAction:
      | "bridge_to_oi_worker_spawn_approval_request"
      | "blocked_bridge_preconditions"
      | "forbidden_safety_invariant";
    requestedApprovalPhrase: string;
    operatorTarget: string;
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

  /** Bridge checks. */
  checks: OIWorkerSubagentSpawnAuthorizationBridgeCheck[];
  blockers: string[];
  nextActions: string[];

  /** Source-only boundary guarantees — all mutation/action flags are false. */
  boundaries: {
    sourceOnly: true;
    actualSubagentSpawn: false;
    brokerDispatch: false;
    workerClaim: false;
    executorInvocation: false;
    processSpawn: false;
    taskFlowMutation: false;
    dbMutation: false;
    deployOrRestart: false;
    providerSend: false;
    terminalAckOrReplay: false;
    releaseOrPublish: false;
    secretMovement: false;
  };

  /** Semantic invariants — this is a bridge-only, source-only, no-op packet. */
  semantics: {
    bridgePacketOnly: true;
    sourceOnly: true;
    doesNotGrantAuthorization: true;
    doesNotSpawnSubagents: true;
    doesNotDispatchBrokerWork: true;
    doesNotCreateTaskFlowRecords: true;
    doesNotMutateDb: true;
    performsProviderSend: false;
    performsTerminalAck: false;
    performsRuntimeRestartOrDeploy: false;
    performsHistoricalReplay: false;
    performsReleaseOrPublish: false;
    movesSecretsOrCredentials: false;
  };
}

export interface OIWorkerSubagentSpawnAuthorizationBridgeOptions {
  now?: string;
  operatorTarget?: string;
  targetRepo?: string;
  targetIssueNumber?: number;
  approvalWindowMinutes?: number;
  workerSpawnApprovalDecisionEvidence?: OIWorkerSpawnApprovalDecisionEvidencePacket;
}

/**
 * Build an OI v2 worker/subagent spawn authorization request bridge packet
 * from an A2A broker v1 authorization request packet.
 */
export function buildOIWorkerSubagentSpawnAuthorizationBridgePacket(
  v1Packet: A2AWorkerSubagentSpawnAuthorizationRequestPacket,
  options: OIWorkerSubagentSpawnAuthorizationBridgeOptions = {},
): OIWorkerSubagentSpawnAuthorizationBridgePacket {
  const generatedAt = options.now ?? new Date().toISOString();
  const workerSpawnApprovalDecisionEvidence = options.workerSpawnApprovalDecisionEvidence;
  const checks = buildBridgeChecks(v1Packet, workerSpawnApprovalDecisionEvidence);
  const state = bridgeStateFor(v1Packet, workerSpawnApprovalDecisionEvidence, checks);
  const operatorTarget = options.operatorTarget ?? v1Packet.authorizationRequestDraft.operatorTarget;
  const targetRepo = options.targetRepo ?? "jinwon-int/a2a-broker";
  const targetIssueNumber = options.targetIssueNumber ?? 0;
  const approvalWindowMinutes = options.approvalWindowMinutes ?? 60;

  return {
    kind: "a2a-broker.orchestration-intelligence.worker-subagent-spawn-authorization-bridge.packet",
    version: 1,
    generatedAt,
    sourceOnly: true,
    idempotencyKey: buildBridgeIdempotencyKey(
      v1Packet,
      workerSpawnApprovalDecisionEvidence,
      generatedAt,
      state,
      operatorTarget,
    ),
    v1AuthorizationRequestIdempotencyKey: v1Packet.idempotencyKey,
    workerSpawnApprovalDecisionEvidenceIdempotencyKey:
      workerSpawnApprovalDecisionEvidence?.idempotencyKey ?? null,
    state,
    workerId: v1Packet.workerId,
    taskId: v1Packet.taskId,
    finalizer: v1Packet.finalizer,
    v1Source: {
      authorizationRequestState: v1Packet.state,
      plannerHandoffIdempotencyKey: v1Packet.source.plannerHandoffIdempotencyKey,
      selfAssessmentIdempotencyKey: v1Packet.source.selfAssessmentIdempotencyKey,
      plannerPolicyIdempotencyKey: v1Packet.source.plannerPolicyIdempotencyKey,
      plannerParallelismHint: v1Packet.source.plannerParallelismHint,
      recommendedRoles: v1Packet.source.recommendedRoles,
      authorizationReference: v1Packet.authorizationRequestDraft.authorizationReference,
      requestReference: v1Packet.authorizationRequestDraft.requestReference,
    },
    oiV2Source: {
      workerSpawnApprovalDecisionEvidenceState:
        workerSpawnApprovalDecisionEvidence?.state ?? "missing",
      workerSpawnApprovalPresent:
        workerSpawnApprovalDecisionEvidence?.runtimeReadinessEvidencePatch.workerSpawnApprovalPresent ?? false,
      sourceOnly: workerSpawnApprovalDecisionEvidence?.sourceOnly ?? false,
    },
    oiV2Output: oiV2OutputFor(
      v1Packet,
      state,
      operatorTarget,
      targetRepo,
      targetIssueNumber,
      approvalWindowMinutes,
      generatedAt,
    ),
    checks,
    blockers: blockersForChecks(checks),
    nextActions: nextActionsForState(state),
    boundaries: falseBoundaries(),
    semantics: safetySemantics(),
  };
}

/**
 * Build an OI v2 bridge packet from raw input (envelope).
 *
 * Accepts an `A2AWorkerSubagentSpawnAuthorizationRequestPacket` directly
 * or nested under `v1AuthorizationRequest`, `authorizationRequest`, or `packet`.
 */
export function buildOIWorkerSubagentSpawnAuthorizationBridgePacketFromInput(
  input: unknown,
  options: OIWorkerSubagentSpawnAuthorizationBridgeOptions = {},
): OIWorkerSubagentSpawnAuthorizationBridgePacket {
  const v1Packet = extractV1AuthorizationRequest(input);
  const workerSpawnApprovalDecisionEvidence =
    options.workerSpawnApprovalDecisionEvidence
    ?? extractWorkerSpawnApprovalDecisionEvidence(input);
  return buildOIWorkerSubagentSpawnAuthorizationBridgePacket(v1Packet, {
    ...options,
    workerSpawnApprovalDecisionEvidence,
  });
}

/**
 * Render the bridge packet as human-readable markdown.
 */
export function renderOIWorkerSubagentSpawnAuthorizationBridgeMarkdown(
  packet: OIWorkerSubagentSpawnAuthorizationBridgePacket,
): string {
  const output = packet.oiV2Output;
  return [
    "A2A Orchestration Intelligence v2 worker/subagent spawn authorization request bridge",
    "Bridge packet (v1 → OI v2)",
    `State: ${packet.state}`,
    `Worker: ${packet.workerId}`,
    `Task: ${packet.taskId ?? "unknown"}`,
    `Finalizer: ${packet.finalizer}`,
    `V1 authorization reference: ${packet.v1Source.authorizationReference}`,
    `V1 request reference: ${packet.v1Source.requestReference}`,
    `OI v2 worker spawn decision evidence: ${packet.oiV2Source.workerSpawnApprovalDecisionEvidenceState}`,
    `Bridge action: ${output.bridgeAction}`,
    "Bridge checks:",
    ...packet.checks.map((check) => `- ${check.id}: ${check.status} - ${check.summary}`),
    "V1 roles mapped to OI v2:",
    ...packet.v1Source.recommendedRoles.map((role) => `- ${role}`),
    "OI v2 output:",
    `- requested approval phrase: ${output.requestedApprovalPhrase}`,
    `- operator target: ${output.operatorTarget}`,
    ...output.spawnScope.map((scope) => `- spawn scope: ${scope}`),
    ...output.workerTeamConstraints.map((c) => `- worker/team constraint: ${c}`),
    ...output.allowedWorkerClasses.map((c) => `- allowed worker class: ${c}`),
    ...output.noLiveExclusions.map((excl) => `- no-live/live exclusion: ${excl}`),
    ...output.requiredConditions.map((c) => `- required condition: ${c}`),
    ...output.rollbackAbortRequirements.map((r) => `- rollback/abort requirement: ${r}`),
    `- expiry/revocation: ${output.expiryOrRevocation}`,
    "Bridge blockers:",
    ...(packet.blockers.length ? packet.blockers.map((b) => `- ${b}`) : ["- none"]),
    "Next actions:",
    ...packet.nextActions.map((a) => `- ${a}`),
    "Safety: source-only bridge packet. It translates v1 authorization request semantics",
    "into an OI v2 compatible shape but does not grant authorization, spawn subagents,",
    "dispatch broker work, create TaskFlow records, mutate DB, deploy/restart services,",
    "send providers, ACK/replay Terminal rows, publish releases, or move secrets.",
    "All mutation/action boundaries remain false.",
  ].join("\n");
}

// ── Bridge checks ──────────────────────────────────────────────────────────

function buildBridgeChecks(
  v1: A2AWorkerSubagentSpawnAuthorizationRequestPacket,
  workerSpawnApprovalDecisionEvidence?: OIWorkerSpawnApprovalDecisionEvidencePacket,
): OIWorkerSubagentSpawnAuthorizationBridgeCheck[] {
  const decisionEvidenceAccepted =
    workerSpawnApprovalDecisionEvidence?.state === "worker_spawn_approval_evidence_accepted"
    && workerSpawnApprovalDecisionEvidence.runtimeReadinessEvidencePatch.workerSpawnApprovalPresent === true;
  const decisionEvidenceSourceOnly =
    workerSpawnApprovalDecisionEvidence?.sourceOnly === true
    && workerSpawnApprovalDecisionEvidence.safety.grantsExecutionApproval === false
    && workerSpawnApprovalDecisionEvidence.safety.workerSpawned === false
    && workerSpawnApprovalDecisionEvidence.safety.brokerDispatchCreated === false
    && workerSpawnApprovalDecisionEvidence.safety.runtimeExecutorEnabled === false
    && workerSpawnApprovalDecisionEvidence.safety.dbMutation === false
    && workerSpawnApprovalDecisionEvidence.safety.deployOrRestart === false
    && workerSpawnApprovalDecisionEvidence.safety.providerSend === false;
  const stateReady = v1.state === "authorization_request_draft_ready";
  const boundariesIntact = checkBoundariesIntact(v1);
  const finalizerPresent = typeof v1.finalizer === "string" && v1.finalizer.trim().length > 0;
  const rolesMapped = v1.source.recommendedRoles.length > 0;
  const dispatchRequired = v1.authorizationRequestDraft.dispatchRequired === true;
  const sourceOnlyContractIntact = checkSemanticsIntact(v1);

  return [
    {
      id: "worker_spawn_approval_decision_evidence_accepted",
      status: decisionEvidenceAccepted ? "pass" : "fail",
      summary: decisionEvidenceAccepted
        ? "upstream OI v2 worker spawn approval decision evidence is accepted"
        : `upstream OI v2 worker spawn approval decision evidence is ${
          workerSpawnApprovalDecisionEvidence?.state ?? "missing"
        }`,
    },
    {
      id: "worker_spawn_approval_decision_source_only",
      status: decisionEvidenceSourceOnly ? "pass" : "fail",
      summary: decisionEvidenceSourceOnly
        ? "upstream OI v2 decision evidence remains source-only and grants no execution"
        : "upstream OI v2 decision evidence is missing or violates source-only safety",
    },
    {
      id: "v1_authorization_request_state_ready",
      status: stateReady ? "pass" : "fail",
      summary: stateReady
        ? "v1 authorization request state is 'authorization_request_draft_ready'"
        : `v1 authorization request state is '${v1.state}'`,
    },
    {
      id: "v1_source_only_boundaries_intact",
      status: boundariesIntact ? "pass" : "fail",
      summary: boundariesIntact
        ? "v1 source-only boundaries are intact; no unsafe mutations permitted"
        : "v1 source-only boundaries have unsafe mutations enabled",
    },
    {
      id: "v1_finalizer_present",
      status: finalizerPresent ? "pass" : "fail",
      summary: finalizerPresent
        ? "v1 finalizer is present"
        : "v1 finalizer is missing",
    },
    {
      id: "v1_recommended_roles_mapped",
      status: rolesMapped ? "pass" : "fail",
      summary: rolesMapped
        ? `v1 recommended roles mapped: ${v1.source.recommendedRoles.join(", ")}`
        : "v1 recommended roles are empty — no subagent roles to bridge",
    },
    {
      id: "v1_dispatch_required",
      status: dispatchRequired ? "pass" : "fail",
      summary: dispatchRequired
        ? "v1 authorization request draft requires dispatch"
        : "v1 authorization request draft does not require dispatch",
    },
    {
      id: "v1_semantics_source_only_contract",
      status: sourceOnlyContractIntact ? "pass" : "fail",
      summary: sourceOnlyContractIntact
        ? "v1 semantics source-only contract is intact"
        : "v1 semantics source-only contract is violated",
    },
  ];
}

function checkSemanticsIntact(v1: A2AWorkerSubagentSpawnAuthorizationRequestPacket): boolean {
  return v1.semantics.authorizationRequestDraftOnly
    && v1.semantics.sourceOnly
    && !v1.semantics.performsProviderSend
    && !v1.semantics.performsTerminalAck
    && !v1.semantics.performsRuntimeRestartOrDeploy
    && !v1.semantics.performsHistoricalReplay
    && !v1.semantics.performsReleaseOrPublish
    && !v1.semantics.movesSecretsOrCredentials;
}

function checkBoundariesIntact(v1: A2AWorkerSubagentSpawnAuthorizationRequestPacket): boolean {
  return !v1.boundaries.actualSubagentSpawn
    && !v1.boundaries.brokerDispatch
    && !v1.boundaries.workerClaim
    && !v1.boundaries.executorInvocation
    && !v1.boundaries.processSpawn
    && !v1.boundaries.taskFlowMutation
    && !v1.boundaries.dbMutation
    && !v1.boundaries.deployOrRestart
    && !v1.boundaries.providerSend
    && !v1.boundaries.terminalAckOrReplay
    && !v1.boundaries.releaseOrPublish
    && !v1.boundaries.secretMovement;
}

function bridgeStateFor(
  v1: A2AWorkerSubagentSpawnAuthorizationRequestPacket,
  workerSpawnApprovalDecisionEvidence: OIWorkerSpawnApprovalDecisionEvidencePacket | undefined,
  checks: OIWorkerSubagentSpawnAuthorizationBridgeCheck[],
): OIWorkerSubagentSpawnAuthorizationBridgeState {
  // Safety: if v1 semantics violate the source-only contract, block.
  if (
    !v1.semantics.authorizationRequestDraftOnly
    || !v1.semantics.sourceOnly
    || v1.semantics.performsProviderSend
    || v1.semantics.performsTerminalAck
    || v1.semantics.performsRuntimeRestartOrDeploy
    || v1.semantics.performsHistoricalReplay
    || v1.semantics.performsReleaseOrPublish
    || v1.semantics.movesSecretsOrCredentials
  ) {
    return "bridge_blocked_v1_boundary_drift";
  }

  // Check boundary flags from the v1 packet.
  if (!checkBoundariesIntact(v1)) {
    return "bridge_blocked_v1_boundary_drift";
  }

  if (
    workerSpawnApprovalDecisionEvidence?.state !== "worker_spawn_approval_evidence_accepted"
    || workerSpawnApprovalDecisionEvidence.runtimeReadinessEvidencePatch.workerSpawnApprovalPresent !== true
  ) {
    return "bridge_worker_spawn_decision_evidence_not_accepted";
  }

  // Check state readiness.
  if (v1.state !== "authorization_request_draft_ready") {
    return "bridge_v1_authorization_request_not_ready";
  }

  // If all pass checks pass, the bridge is ready.
  if (checks.every((check) => check.status === "pass")) {
    return "bridge_ready";
  }

  // Incomplete mapping.
  return "bridge_blocked_v1_state";
}

function blockersForChecks(checks: OIWorkerSubagentSpawnAuthorizationBridgeCheck[]): string[] {
  return checks
    .filter((check) => check.status !== "pass")
    .map((check) => `${check.id}: ${check.summary}`);
}

function nextActionsForState(
  state: OIWorkerSubagentSpawnAuthorizationBridgeState,
): string[] {
  if (state === "bridge_ready") {
    return [
      "bridge the v1 authorization request into the OI v2 worker-spawn-approval-request pipeline",
      "present the bridged approval request to the OI v2 finalizer or operator for review",
      "record the operator response in a future OI v2 worker-spawn-approval-decision-evidence packet",
      "keep worker/subagent spawn, broker dispatch, and runtime executor gates separate",
    ];
  }
  if (state === "bridge_v1_authorization_request_not_ready") {
    return [
      "wait for the v1 authorization request to reach 'authorization_request_draft_ready' state",
      "resolve any v1 planner handoff or self-assessment blockers before bridging",
    ];
  }
  if (state === "bridge_blocked_v1_boundary_drift") {
    return [
      "blocked: v1 authorization request has unsafe boundary drift",
      "do not bridge into OI v2 until v1 boundary flags are corrected to all-false",
      "review v1 semantics for source-only contract violations",
    ];
  }
  if (state === "bridge_worker_spawn_decision_evidence_not_accepted") {
    return [
      "wait for accepted OI v2 worker spawn approval decision evidence before bridging",
      "do not bridge into the authorization request layer from missing/rejected/expired/conflicting evidence",
      "keep runtime spawn, broker dispatch, and executor gates blocked",
    ];
  }
  return [
    "resolve v1 authorization request check failures before bridging into OI v2",
    "verify that all pass/fail checks are satisfiable",
  ];
}

function oiV2OutputFor(
  v1: A2AWorkerSubagentSpawnAuthorizationRequestPacket,
  state: OIWorkerSubagentSpawnAuthorizationBridgeState,
  operatorTarget: string,
  targetRepo: string,
  targetIssueNumber: number,
  approvalWindowMinutes: number,
  generatedAt: string,
): OIWorkerSubagentSpawnAuthorizationBridgePacket["oiV2Output"] {
  const ready = state === "bridge_ready";
  const roles = v1.source.recommendedRoles;
  const authorizationRef = v1.authorizationRequestDraft.authorizationReference;
  const requestRef = v1.authorizationRequestDraft.requestReference;
  const requestedBy = v1.authorizationRequestDraft.requestedBy;
  const requiredReply = v1.authorizationRequestDraft.requiredReply;
  const expiresAt = approvalWindowMinutes > 0
    ? new Date(Date.parse(generatedAt) + approvalWindowMinutes * 60 * 1000).toISOString()
    : undefined;

  return {
    bridgeAction: ready
      ? "bridge_to_oi_worker_spawn_approval_request"
      : state === "bridge_blocked_v1_boundary_drift"
        ? "forbidden_safety_invariant"
        : "blocked_bridge_preconditions",
    requestedApprovalPhrase: `APPROVE OI V2 WORKER SPAWN AUTHORIZATION BRIDGE FOR ${authorizationRef}`,
    operatorTarget,
    spawnScope: [
      `bridge v1 authorization request '${authorizationRef}' (request: '${requestRef}') into OI v2 pipeline`,
      `worker '${v1.workerId}' spawn roles: ${roles.join(", ")}`,
      `requested by: ${requestedBy}`,
      `required reply: ${requiredReply}`,
      ...(expiresAt ? [`bridged approval window expires at: ${expiresAt}`] : []),
      "record the v1→OI v2 bridge outcome in a future source-only OI v2 packet",
      "keep worker/subagent spawn, broker dispatch, and runtime executor in separate future gates",
    ],
    workerTeamConstraints: [
      `worker '${v1.workerId}' must remain source-only (no live executor, no DB mutation, no provider send)`,
      "all spawned subagents must be evidence-only and operate within assigned write sets",
      "worker/subagent spawn scope must not exceed the roles and parallelism hint from the v1 authorization request",
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
      "no broker dispatch task creation",
    ],
    requiredConditions: [
      "v1 authorization request idempotencyKey must match",
      "v1 source-only boundaries must be intact (all mutation flags false)",
      "operator must approve the exact bridged approval phrase or a stricter variant",
      "approved scope must match the v1 authorization reference, roles, and finalizer",
      "approval must not authorize deploy, restart, DB mutation, live provider send, Terminal ACK/replay, release publish, or credential movement",
      "approval must not authorize actual subagent process spawn, broker dispatch task creation, executor invocation, or TaskFlow mutation",
    ],
    rollbackAbortRequirements: [
      "rollback plan must exist for any bridge-output artifacts (proposals, comments, metadata patches)",
      "abort must be possible without live provider side-effects, DB roll-forward, or TaskFlow mutation",
      "bridge output must reference the original v1 authorization reference and request reference for traceability",
    ],
    expiryOrRevocation: `expires when the v1 authorization request idempotencyKey, state, or source-only boundaries change; or when '${expiresAt ?? "the configured approval window elapses"}' is reached`,
    nonGoals: [
      "actual worker or subagent process spawn at runtime",
      "broker task creation or dispatch at runtime",
      "executor invocation",
      "runtime executor enablement",
      "Daegyo/mobile scope expansion",
      "live provider or Telegram canary",
      "deploy, restart, DB mutation, Terminal ACK/replay, release publish, or credential movement",
      "TaskFlow task creation or mutation",
      "granting or revoking any v1 authorization — the v1 packet remains a draft only",
    ],
    evidenceFieldsRequiredForFutureApproval: [
      "operator",
      "approvalPhrase",
      "approvedAt",
      "v1AuthorizationRequestIdempotencyKey",
      "bridgeIdempotencyKey",
      "workerId",
      "finalizer",
      "authorizationReference",
      "requestReference",
      "spawnRoles",
      "expiryOrRevocation",
      "rollbackAbortPlanRef",
    ],
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────

function buildBridgeIdempotencyKey(
  v1: A2AWorkerSubagentSpawnAuthorizationRequestPacket,
  workerSpawnApprovalDecisionEvidence: OIWorkerSpawnApprovalDecisionEvidencePacket | undefined,
  generatedAt: string,
  state: OIWorkerSubagentSpawnAuthorizationBridgeState,
  operatorTarget: string,
): string {
  const base = JSON.stringify({
    label: "oi-worker-subagent-spawn-authorization-bridge",
    v1IdempotencyKey: v1.idempotencyKey,
    workerSpawnApprovalDecisionEvidenceIdempotencyKey:
      workerSpawnApprovalDecisionEvidence?.idempotencyKey ?? null,
    generatedAt,
    state,
    operatorTarget,
    v1AuthorizationReference: v1.authorizationRequestDraft.authorizationReference,
  });
  return "oi-worker-subagent-spawn-auth-bridge:"
    + createHash("sha256").update(base).digest("hex").slice(0, 24);
}

function extractV1AuthorizationRequest(input: unknown): A2AWorkerSubagentSpawnAuthorizationRequestPacket {
  const envelope = isRecord(input) ? input : {};
  const candidates = [
    input,
    envelope.v1AuthorizationRequest,
    envelope.authorizationRequest,
    envelope.packet,
    envelope.v1Packet,
  ];
  const packet = candidates.find(isV1AuthorizationRequestPacket);
  if (!packet) {
    throw new Error(
      "expected an A2AWorkerSubagentSpawnAuthorizationRequestPacket"
      + " (kind: a2a-broker.worker-subagent-spawn-authorization-request.packet)"
      + " as input or nested under v1AuthorizationRequest, authorizationRequest, or packet",
    );
  }
  return packet;
}

function isV1AuthorizationRequestPacket(
  value: unknown,
): value is A2AWorkerSubagentSpawnAuthorizationRequestPacket {
  return isRecord(value)
    && value.kind === "a2a-broker.worker-subagent-spawn-authorization-request.packet";
}

function extractWorkerSpawnApprovalDecisionEvidence(
  input: unknown,
): OIWorkerSpawnApprovalDecisionEvidencePacket | undefined {
  const envelope = isRecord(input) ? input : {};
  const candidates = [
    envelope.workerSpawnApprovalDecisionEvidence,
    envelope.oiWorkerSpawnApprovalDecisionEvidence,
    envelope.decisionEvidencePacket,
  ];
  return candidates.find(isWorkerSpawnApprovalDecisionEvidencePacket);
}

function isWorkerSpawnApprovalDecisionEvidencePacket(
  value: unknown,
): value is OIWorkerSpawnApprovalDecisionEvidencePacket {
  return isRecord(value)
    && value.kind === "a2a-broker.orchestration-intelligence.worker-spawn-approval-decision-evidence.packet";
}

function falseBoundaries(): OIWorkerSubagentSpawnAuthorizationBridgePacket["boundaries"] {
  return {
    sourceOnly: true,
    actualSubagentSpawn: false,
    brokerDispatch: false,
    workerClaim: false,
    executorInvocation: false,
    processSpawn: false,
    taskFlowMutation: false,
    dbMutation: false,
    deployOrRestart: false,
    providerSend: false,
    terminalAckOrReplay: false,
    releaseOrPublish: false,
    secretMovement: false,
  };
}

function safetySemantics(): OIWorkerSubagentSpawnAuthorizationBridgePacket["semantics"] {
  return {
    bridgePacketOnly: true,
    sourceOnly: true,
    doesNotGrantAuthorization: true,
    doesNotSpawnSubagents: true,
    doesNotDispatchBrokerWork: true,
    doesNotCreateTaskFlowRecords: true,
    doesNotMutateDb: true,
    performsProviderSend: false,
    performsTerminalAck: false,
    performsRuntimeRestartOrDeploy: false,
    performsHistoricalReplay: false,
    performsReleaseOrPublish: false,
    movesSecretsOrCredentials: false,
  };
}

