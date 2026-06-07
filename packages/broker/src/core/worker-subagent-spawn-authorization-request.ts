import { createHash } from "node:crypto";

import type { A2AWorkerSubagentPlannerHandoffPacket } from "./worker-subagent-planner-handoff.js";

export type A2AWorkerSubagentSpawnAuthorizationRequestState =
  | "authorization_request_draft_ready"
  | "waiting_for_planner_handoff"
  | "blocked";

export interface A2AWorkerSubagentSpawnAuthorizationRequestOptions {
  now?: string;
  finalizer?: string;
  finalizer_id?: string;
  requestedBy?: string;
  requested_by?: string;
  operatorTarget?: string;
  operator_target?: string;
  authorizationReference?: string;
  authorization_reference?: string;
  requestReference?: string;
  request_reference?: string;
  approvalWindowMinutes?: number;
  approval_window_minutes?: number;
  requiredReply?: string;
  required_reply?: string;
}

export interface A2AWorkerSubagentSpawnAuthorizationRequestPacket {
  kind: "a2a-broker.worker-subagent-spawn-authorization-request.packet";
  version: 1;
  generatedAt: string;
  sourceOnly: true;
  idempotencyKey: string;
  state: A2AWorkerSubagentSpawnAuthorizationRequestState;
  finalizer: string;
  workerId: string;
  taskId?: string;
  source: {
    plannerHandoffState: A2AWorkerSubagentPlannerHandoffPacket["state"];
    plannerHandoffIdempotencyKey: string;
    plannerHandoffReady: boolean;
    selfAssessmentIdempotencyKey: string;
    plannerPolicyIdempotencyKey: string;
    plannerParallelismHint: 0 | 1 | 2 | 3;
    recommendedRoles: string[];
  };
  authorizationRequestDraft: {
    draftOnly: true;
    status: "draft_not_sent" | "not_ready";
    requestedAction: "authorize_worker_subagent_spawn";
    requestedBy: string;
    operatorTarget: string;
    authorizationReference: string;
    requestReference: string;
    approvalExpiresAt?: string;
    dispatchRequired: boolean;
    dispatchPermitted: false;
    authorizationGrantPermitted: false;
    actualSubagentSpawnPermitted: false;
    brokerDispatchPermitted: false;
    workerClaimPermitted: false;
    executorInvocationPermitted: false;
    processSpawnPermitted: false;
    taskFlowMutationPermitted: false;
    dbMutationPermitted: false;
    providerSendPermitted: false;
    terminalAckPermitted: false;
    releaseOrPublishPermitted: false;
    secretMovementPermitted: false;
    requestedSubagents: Array<{
      role: string;
      purpose: string;
      writeSetConstraint: string;
      evidenceRequired: true;
    }>;
    requiredEvidence: string[];
    transcriptDraft: string;
    requiredReply: string;
  };
  finalizerReview: {
    finalizerRequired: true;
    oneFinalizerRequired: true;
    evidenceOnlySubagents: true;
    writeSetIsolationRequired: true;
    directExecutionEscapeHatch: true;
    capacityConstraints: {
      plannerParallelismHint: 0 | 1 | 2 | 3;
      requestedSubagentCount: number;
      workerCapMustStillPermit: true;
      brokerCapMustStillPermit: true;
      reduceOrRejectIfCapacityChanges: true;
    };
    blockers: string[];
    nextAction: string;
  };
  boundaries: {
    sourceOnly: true;
    liveHostProbe: false;
    plannerRouteCall: false;
    actualSubagentSpawn: false;
    runtimeBehaviorChanged: false;
    mandatoryProductionSpawn: false;
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
  semantics: {
    authorizationRequestDraftOnly: true;
    sourceOnly: true;
    requestDoesNotGrantAuthorization: true;
    requestDoesNotSpawnSubagents: true;
    requestDoesNotDispatchBrokerWork: true;
    requestDoesNotCreateTaskFlowRecords: true;
    requestDoesNotMutateDb: true;
    routeIsNotRequired: true;
    brokerFinalizerRequired: true;
    oneFinalizerOwnsRuntimeDecision: true;
    evidenceOnlySubagents: true;
    writeSetIsolationRequired: true;
    directExecutionEscapeHatchPreserved: true;
    performsProviderSend: false;
    performsTerminalAck: false;
    performsRuntimeRestartOrDeploy: false;
    performsHistoricalReplay: false;
    performsReleaseOrPublish: false;
    movesSecretsOrCredentials: false;
  };
}

export function buildA2AWorkerSubagentSpawnAuthorizationRequest(
  handoff: A2AWorkerSubagentPlannerHandoffPacket,
  options: A2AWorkerSubagentSpawnAuthorizationRequestOptions = {},
): A2AWorkerSubagentSpawnAuthorizationRequestPacket {
  const generatedAt = options.now ?? new Date().toISOString();
  const blockers = buildBlockers(handoff);
  const state = stateFor(handoff, blockers);
  const ready = state === "authorization_request_draft_ready";
  const finalizer = optionalString(options.finalizer ?? options.finalizer_id) ?? handoff.finalizer;
  const requestedBy = optionalString(options.requestedBy ?? options.requested_by) ?? finalizer;
  const operatorTarget = optionalString(options.operatorTarget ?? options.operator_target) ?? finalizer;
  const authorizationReference = optionalString(options.authorizationReference ?? options.authorization_reference)
    ?? buildAuthorizationReference(handoff);
  const requestReference = optionalString(options.requestReference ?? options.request_reference)
    ?? buildRequestReference(handoff);
  const approvalExpiresAt = approvalExpiry(generatedAt, options);
  const requestedSubagents = requestedSubagentsFor(handoff);
  const requiredReply = optionalString(options.requiredReply ?? options.required_reply)
    ?? "authorize_worker_subagent_spawn " + authorizationReference;
  const transcriptDraft = buildTranscriptDraft(
    handoff,
    requestedBy,
    operatorTarget,
    authorizationReference,
    requestReference,
    requestedSubagents,
    requiredReply,
    approvalExpiresAt,
    ready,
  );

  return {
    kind: "a2a-broker.worker-subagent-spawn-authorization-request.packet",
    version: 1,
    generatedAt,
    sourceOnly: true,
    idempotencyKey: buildIdempotencyKey(handoff, generatedAt, authorizationReference, requestReference, state),
    state,
    finalizer,
    workerId: handoff.workerId,
    taskId: handoff.taskId,
    source: {
      plannerHandoffState: handoff.state,
      plannerHandoffIdempotencyKey: handoff.idempotencyKey,
      plannerHandoffReady: handoff.state === "ready_for_finalizer_review",
      selfAssessmentIdempotencyKey: handoff.source.selfAssessmentIdempotencyKey,
      plannerPolicyIdempotencyKey: handoff.source.plannerPolicyIdempotencyKey,
      plannerParallelismHint: handoff.source.plannerParallelismHint,
      recommendedRoles: handoff.source.recommendedRoles,
    },
    authorizationRequestDraft: {
      draftOnly: true,
      status: ready ? "draft_not_sent" : "not_ready",
      requestedAction: "authorize_worker_subagent_spawn",
      requestedBy,
      operatorTarget,
      authorizationReference,
      requestReference,
      approvalExpiresAt,
      dispatchRequired: ready,
      dispatchPermitted: false,
      authorizationGrantPermitted: false,
      actualSubagentSpawnPermitted: false,
      brokerDispatchPermitted: false,
      workerClaimPermitted: false,
      executorInvocationPermitted: false,
      processSpawnPermitted: false,
      taskFlowMutationPermitted: false,
      dbMutationPermitted: false,
      providerSendPermitted: false,
      terminalAckPermitted: false,
      releaseOrPublishPermitted: false,
      secretMovementPermitted: false,
      requestedSubagents,
      requiredEvidence: requiredEvidenceFor(handoff),
      transcriptDraft,
      requiredReply,
    },
    finalizerReview: {
      finalizerRequired: true,
      oneFinalizerRequired: true,
      evidenceOnlySubagents: true,
      writeSetIsolationRequired: true,
      directExecutionEscapeHatch: true,
      capacityConstraints: {
        plannerParallelismHint: handoff.source.plannerParallelismHint,
        requestedSubagentCount: requestedSubagents.length,
        workerCapMustStillPermit: true,
        brokerCapMustStillPermit: true,
        reduceOrRejectIfCapacityChanges: true,
      },
      blockers,
      nextAction: ready
        ? "finalizer may review this draft before any separate runtime subagent spawn gate"
        : "resolve planner handoff blockers before requesting authorization",
    },
    boundaries: falseBoundaries(),
    semantics: {
      authorizationRequestDraftOnly: true,
      sourceOnly: true,
      requestDoesNotGrantAuthorization: true,
      requestDoesNotSpawnSubagents: true,
      requestDoesNotDispatchBrokerWork: true,
      requestDoesNotCreateTaskFlowRecords: true,
      requestDoesNotMutateDb: true,
      routeIsNotRequired: true,
      brokerFinalizerRequired: true,
      oneFinalizerOwnsRuntimeDecision: true,
      evidenceOnlySubagents: true,
      writeSetIsolationRequired: true,
      directExecutionEscapeHatchPreserved: true,
      performsProviderSend: false,
      performsTerminalAck: false,
      performsRuntimeRestartOrDeploy: false,
      performsHistoricalReplay: false,
      performsReleaseOrPublish: false,
      movesSecretsOrCredentials: false,
    },
  };
}

export function extractA2AWorkerSubagentSpawnAuthorizationRequestHandoff(
  input: unknown,
): A2AWorkerSubagentPlannerHandoffPacket {
  const envelope = isRecord(input) ? input : {};
  const candidates = [
    input,
    envelope.plannerHandoffPacket,
    envelope.workerSubagentPlannerHandoffPacket,
    envelope.workerSubagentPlannerHandoff,
    envelope.plannerHandoff,
    envelope.packet,
  ];
  const packet = candidates.find(isPlannerHandoffPacket);
  if (!packet) throw new Error("expected worker subagent planner handoff packet");
  return packet;
}

export function extractA2AWorkerSubagentSpawnAuthorizationRequestOptions(
  input: unknown,
): A2AWorkerSubagentSpawnAuthorizationRequestOptions {
  const envelope = isRecord(input) ? input : {};
  const candidate = envelope.spawnAuthorizationRequest
    ?? envelope.subagentSpawnAuthorization
    ?? envelope.authorizationRequest
    ?? envelope.options;
  return isRecord(candidate) ? candidate as A2AWorkerSubagentSpawnAuthorizationRequestOptions : {};
}

export function renderA2AWorkerSubagentSpawnAuthorizationRequestMarkdown(
  packet: A2AWorkerSubagentSpawnAuthorizationRequestPacket,
): string {
  return [
    "A2A worker subagent spawn authorization request draft",
    "State: " + packet.state,
    "Worker: " + packet.workerId,
    "Task: " + (packet.taskId ?? "unknown"),
    "Finalizer: " + packet.finalizer,
    "Authorization reference: " + packet.authorizationRequestDraft.authorizationReference,
    "Requested roles: " + (packet.authorizationRequestDraft.requestedSubagents.map((agent) => agent.role).join(",") || "none"),
    "Readiness: dispatchPermitted=" + packet.authorizationRequestDraft.dispatchPermitted
      + " actualSubagentSpawnPermitted=" + packet.authorizationRequestDraft.actualSubagentSpawnPermitted
      + " brokerDispatchPermitted=" + packet.authorizationRequestDraft.brokerDispatchPermitted
      + " taskFlowMutationPermitted=" + packet.authorizationRequestDraft.taskFlowMutationPermitted
      + " dbMutationPermitted=" + packet.authorizationRequestDraft.dbMutationPermitted,
    "Blockers: " + (packet.finalizerReview.blockers.join("; ") || "none"),
    "Safety: authorization request draft only; no actual subagent spawn, broker dispatch, worker claim, executor invocation, process spawn, TaskFlow/DB mutation, deploy/restart, provider send, terminal ACK/replay, release/publish, or secret movement.",
  ].join("\n");
}

function buildBlockers(handoff: A2AWorkerSubagentPlannerHandoffPacket): string[] {
  return unique([
    ...handoff.review.blockers,
    ...(handoff.state !== "ready_for_finalizer_review" ? ["planner handoff state is " + handoff.state] : []),
    ...(!handoff.review.workerMatches ? ["worker does not match planner handoff"] : []),
    ...(!handoff.review.taskMatches ? ["task does not match planner handoff"] : []),
    ...(!handoff.review.plannerInputMatches ? ["planner input does not match handoff"] : []),
    ...(!handoff.review.sourceBoundariesIntact ? ["source-only boundaries are not intact"] : []),
    ...(!handoff.review.finalizerRequired ? ["finalizer is not required by handoff"] : []),
    ...(!handoff.review.evidenceOnlySubagents ? ["subagents are not evidence-only"] : []),
    ...(!handoff.review.writeSetIsolationRequired ? ["write-set isolation is not required"] : []),
    ...(!handoff.review.directExecutionEscapeHatch ? ["direct execution escape hatch is not preserved"] : []),
    ...(handoff.boundaries.actualSubagentSpawn ? ["handoff unexpectedly permits actual subagent spawn"] : []),
    ...(handoff.boundaries.brokerDispatch ? ["handoff unexpectedly permits broker dispatch"] : []),
    ...(handoff.boundaries.workerClaim ? ["handoff unexpectedly permits worker claim"] : []),
    ...(handoff.boundaries.executorInvocation ? ["handoff unexpectedly permits executor invocation"] : []),
    ...(handoff.boundaries.processSpawn ? ["handoff unexpectedly permits process spawn"] : []),
    ...(handoff.boundaries.taskFlowMutation ? ["handoff unexpectedly permits TaskFlow mutation"] : []),
    ...(handoff.boundaries.dbMutation ? ["handoff unexpectedly permits DB mutation"] : []),
    ...(handoff.boundaries.deployOrRestart ? ["handoff unexpectedly permits deploy/restart"] : []),
    ...(handoff.boundaries.providerSend ? ["handoff unexpectedly permits provider send"] : []),
    ...(handoff.boundaries.terminalAckOrReplay ? ["handoff unexpectedly permits terminal ACK/replay"] : []),
    ...(handoff.boundaries.releaseOrPublish ? ["handoff unexpectedly permits release/publish"] : []),
    ...(handoff.boundaries.secretMovement ? ["handoff unexpectedly permits secret movement"] : []),
  ].filter(Boolean));
}

function stateFor(
  handoff: A2AWorkerSubagentPlannerHandoffPacket,
  blockers: string[],
): A2AWorkerSubagentSpawnAuthorizationRequestState {
  if (hasUnsafeBoundaryDrift(handoff)) return "blocked";
  if (handoff.state !== "ready_for_finalizer_review") return "waiting_for_planner_handoff";
  return blockers.length ? "blocked" : "authorization_request_draft_ready";
}

function hasUnsafeBoundaryDrift(handoff: A2AWorkerSubagentPlannerHandoffPacket): boolean {
  return handoff.boundaries.actualSubagentSpawn
    || handoff.boundaries.brokerDispatch
    || handoff.boundaries.workerClaim
    || handoff.boundaries.executorInvocation
    || handoff.boundaries.processSpawn
    || handoff.boundaries.taskFlowMutation
    || handoff.boundaries.dbMutation
    || handoff.boundaries.deployOrRestart
    || handoff.boundaries.providerSend
    || handoff.boundaries.terminalAckOrReplay
    || handoff.boundaries.releaseOrPublish
    || handoff.boundaries.secretMovement;
}

function requestedSubagentsFor(
  handoff: A2AWorkerSubagentPlannerHandoffPacket,
): A2AWorkerSubagentSpawnAuthorizationRequestPacket["authorizationRequestDraft"]["requestedSubagents"] {
  return handoff.source.recommendedRoles.map((role) => ({
    role,
    purpose: purposeForRole(role),
    writeSetConstraint: role === "implementer"
      ? "finalizer must assign a disjoint explicit write set before any runtime spawn gate"
      : "read-only/evidence-only unless finalizer assigns an explicit disjoint write set",
    evidenceRequired: true,
  }));
}

function purposeForRole(role: string): string {
  if (role === "explorer") return "bounded investigation and evidence collection";
  if (role === "implementer") return "scoped implementation within an assigned disjoint write set";
  if (role === "verifier") return "test, CI, risk, and evidence review";
  return "finalizer-reviewed evidence contribution";
}

function requiredEvidenceFor(handoff: A2AWorkerSubagentPlannerHandoffPacket): string[] {
  return unique([
    handoff.idempotencyKey,
    handoff.source.selfAssessmentIdempotencyKey,
    handoff.source.plannerPolicyIdempotencyKey,
    "fresh worker capacity before runtime spawn gate",
    "finalizer-owned write-set assignment for implementer roles",
    "single finalizer closeout decision",
  ]);
}

function buildTranscriptDraft(
  handoff: A2AWorkerSubagentPlannerHandoffPacket,
  requestedBy: string,
  operatorTarget: string,
  authorizationReference: string,
  requestReference: string,
  requestedSubagents: A2AWorkerSubagentSpawnAuthorizationRequestPacket["authorizationRequestDraft"]["requestedSubagents"],
  requiredReply: string,
  approvalExpiresAt: string | undefined,
  ready: boolean,
): string {
  return [
    "A2A worker subagent spawn authorization request draft",
    "Status: " + (ready ? "draft_not_sent" : "not_ready"),
    "Worker: " + handoff.workerId,
    "Task: " + (handoff.taskId ?? "unknown"),
    "Requested by: " + requestedBy,
    "Operator target: " + operatorTarget,
    "Authorization reference: " + authorizationReference,
    "Request reference: " + requestReference,
    "Requested roles: " + (requestedSubagents.map((agent) => agent.role).join(", ") || "none"),
    ...(approvalExpiresAt ? ["Approval expires at: " + approvalExpiresAt] : []),
    "Required reply: " + requiredReply,
    "Safety: this is a source-only draft. It does not grant authorization, spawn subagents, dispatch broker work, claim worker tasks, invoke executors, spawn processes, create TaskFlow records, mutate DB state, deploy/restart, send providers, ACK/replay terminal rows, publish releases, or move secrets.",
  ].join("\n");
}

function falseBoundaries(): A2AWorkerSubagentSpawnAuthorizationRequestPacket["boundaries"] {
  return {
    sourceOnly: true,
    liveHostProbe: false,
    plannerRouteCall: false,
    actualSubagentSpawn: false,
    runtimeBehaviorChanged: false,
    mandatoryProductionSpawn: false,
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

function approvalExpiry(
  generatedAt: string,
  options: A2AWorkerSubagentSpawnAuthorizationRequestOptions,
): string | undefined {
  const minutes = numberValue(options.approvalWindowMinutes ?? options.approval_window_minutes);
  if (!minutes) return undefined;
  return new Date(Date.parse(generatedAt) + minutes * 60 * 1000).toISOString();
}

function buildAuthorizationReference(handoff: A2AWorkerSubagentPlannerHandoffPacket): string {
  return "subagent-spawn-authorization:" + createHash("sha256").update(handoff.idempotencyKey).digest("hex").slice(0, 16);
}

function buildRequestReference(handoff: A2AWorkerSubagentPlannerHandoffPacket): string {
  return "subagent-spawn-request:" + createHash("sha256").update(handoff.workerId + ":" + (handoff.taskId ?? "")).digest("hex").slice(0, 16);
}

function buildIdempotencyKey(
  handoff: A2AWorkerSubagentPlannerHandoffPacket,
  generatedAt: string,
  authorizationReference: string,
  requestReference: string,
  state: A2AWorkerSubagentSpawnAuthorizationRequestState,
): string {
  const base = JSON.stringify({
    label: "worker-subagent-spawn-authorization-request",
    handoff: handoff.idempotencyKey,
    generatedAt,
    authorizationReference,
    requestReference,
    state,
  });
  return "a2a-worker-subagent-spawn-authorization-request:" + createHash("sha256").update(base).digest("hex").slice(0, 24);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function isPlannerHandoffPacket(value: unknown): value is A2AWorkerSubagentPlannerHandoffPacket {
  return isRecord(value) && value.kind === "a2a-broker.worker-subagent-planner-handoff.packet";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
