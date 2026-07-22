import { createHash } from "node:crypto";

import type {
  A2ASubagentRole,
  A2AWorkerSubagentPolicyPacket,
} from "a2a-attestation";

export type A2AWorkerSubagentEvidenceStatus = "done" | "blocked";
export type A2AWorkerSubagentDryRunState = "recommendation_recorded" | "blocked";
export type A2AWorkerSubagentSynthesisState = "ready_for_finalizer_review" | "blocked";

export interface A2AWorkerSubagentSideEffects {
  gitCommit?: boolean;
  fileWrite?: boolean;
  brokerDispatch?: boolean;
  dbMutation?: boolean;
  deployOrRestart?: boolean;
  providerSend?: boolean;
  terminalAckOrReplay?: boolean;
  releaseOrPublish?: boolean;
  secretMovement?: boolean;
}

export interface A2AWorkerSubagentDryRunGateInput {
  enabled?: boolean;
  runtimeSpawnAllowed?: boolean;
  depthLimit?: number;
}

export interface A2AWorkerSubagentDryRunPlanInput {
  now?: string;
  finalizer?: string;
  plannerPolicy: A2AWorkerSubagentPolicyPacket;
  featureGate?: A2AWorkerSubagentDryRunGateInput;
}

export interface A2AWorkerSubagentDryRunPlanPacket {
  kind: "a2a-broker.worker-subagent-dry-run.plan";
  version: 1;
  generatedAt: string;
  sourceOnly: true;
  dryRunOnly: true;
  idempotencyKey: string;
  state: A2AWorkerSubagentDryRunState;
  finalizer: string;
  workerId: string;
  taskId?: string;
  featureGate: {
    enabled: boolean;
    runtimeSpawnAllowed: false;
    depthLimit: 1;
  };
  recommendation: {
    parallelismHint: 0 | 1 | 2 | 3 | 4;
    roles: A2AWorkerSubagentPolicyPacket["decision"]["recommendedSubagents"];
    directExecutionAllowed: boolean;
    evidenceOnlySubagents: true;
    writeSetIsolationRequired: true;
    finalizerRequired: true;
  };
  runtime: {
    wouldSpawnSubagents: false;
    actualSubagentSpawn: false;
    executorInvocation: false;
    processSpawn: false;
    runtimeBehaviorChanged: false;
  };
  boundaries: {
    brokerDispatch: false;
    workerClaim: false;
    taskFlowMutation: false;
    dbMutation: false;
    deployOrRestart: false;
    providerSend: false;
    terminalAckOrReplay: false;
    releaseOrPublish: false;
    secretMovement: false;
    mandatoryProductionSpawn: false;
  };
  blockers: string[];
  nextAction: string;
}

export interface A2AWorkerSubagentEvidencePacketInput {
  now?: string;
  parentTaskId: string;
  workerId: string;
  subagentId: string;
  role: A2ASubagentRole;
  status: A2AWorkerSubagentEvidenceStatus;
  claims?: string[];
  evidenceRefs?: string[];
  filesInspected?: string[];
  testsRun?: string[];
  risks?: string[];
  recommendation?: string;
  confidence?: "low" | "medium" | "high";
  blockedReason?: string;
  finalDecisionClaim?: string;
  sideEffects?: A2AWorkerSubagentSideEffects;
}

export interface A2AWorkerSubagentEvidencePacket {
  kind: "a2a-broker.worker-subagent-evidence.packet";
  version: 1;
  generatedAt: string;
  sourceOnly: true;
  id: string;
  parentTaskId: string;
  workerId: string;
  subagentId: string;
  role: A2ASubagentRole;
  state: A2AWorkerSubagentEvidenceStatus;
  claims: string[];
  evidenceRefs: string[];
  filesInspected: string[];
  testsRun: string[];
  risks: string[];
  recommendation?: string;
  confidence: "low" | "medium" | "high";
  blockedReason?: string;
  finalDecisionClaim?: string;
  sideEffects: Required<A2AWorkerSubagentSideEffects>;
  decisionAuthority: {
    evidenceOnly: true;
    subagentMayCloseOrMerge: false;
    subagentMayDeployOrRestart: false;
    subagentMayAckOrReplayTerminal: false;
    subagentMaySendProviders: false;
    subagentMayMoveSecrets: false;
    finalizerDecisionRequired: true;
  };
  blockers: string[];
}

export interface A2AWorkerSubagentSynthesisPacketInput {
  now?: string;
  finalizer: string;
  workerId: string;
  parentTaskId: string;
  dryRunPlan: A2AWorkerSubagentDryRunPlanPacket;
  subagentEvidence: A2AWorkerSubagentEvidencePacket[];
}

export interface A2AWorkerSubagentSynthesisPacket {
  kind: "a2a-broker.worker-subagent-synthesis.packet";
  version: 1;
  generatedAt: string;
  sourceOnly: true;
  idempotencyKey: string;
  state: A2AWorkerSubagentSynthesisState;
  finalizer: string;
  workerId: string;
  parentTaskId: string;
  dryRunPlanIdempotencyKey: string;
  expectedRoles: A2AWorkerSubagentPolicyPacket["decision"]["recommendedSubagents"];
  acceptedEvidenceIds: string[];
  rejectedEvidenceIds: string[];
  finalizerDecisionRequired: true;
  subagentsMayNotCloseOrMerge: true;
  boundaries: {
    actualSubagentSpawn: false;
    executorInvocation: false;
    processSpawn: false;
    brokerDispatch: false;
    workerClaim: false;
    taskFlowMutation: false;
    dbMutation: false;
    deployOrRestart: false;
    providerSend: false;
    terminalAckOrReplay: false;
    releaseOrPublish: false;
    secretMovement: false;
  };
  blockers: string[];
  nextAction: string;
}

const EMPTY_SIDE_EFFECTS: Required<A2AWorkerSubagentSideEffects> = {
  gitCommit: false,
  fileWrite: false,
  brokerDispatch: false,
  dbMutation: false,
  deployOrRestart: false,
  providerSend: false,
  terminalAckOrReplay: false,
  releaseOrPublish: false,
  secretMovement: false,
};

export function buildA2AWorkerSubagentDryRunPlan(input: A2AWorkerSubagentDryRunPlanInput): A2AWorkerSubagentDryRunPlanPacket {
  const generatedAt = input.now ?? new Date().toISOString();
  const finalizer = input.finalizer ?? "broker-finalizer";
  const blockers = dryRunBlockers(input.plannerPolicy);
  const state: A2AWorkerSubagentDryRunState = blockers.length ? "blocked" : "recommendation_recorded";

  return {
    kind: "a2a-broker.worker-subagent-dry-run.plan",
    version: 1,
    generatedAt,
    sourceOnly: true,
    dryRunOnly: true,
    idempotencyKey: hashPacket("dry-run", generatedAt, input.plannerPolicy.idempotencyKey, finalizer),
    state,
    finalizer,
    workerId: input.plannerPolicy.host.workerId,
    taskId: input.plannerPolicy.task.taskId,
    featureGate: {
      enabled: input.featureGate?.enabled === true,
      runtimeSpawnAllowed: false,
      depthLimit: 1,
    },
    recommendation: {
      parallelismHint: input.plannerPolicy.decision.parallelismHint,
      roles: input.plannerPolicy.decision.recommendedSubagents,
      directExecutionAllowed: input.plannerPolicy.decision.directExecutionAllowed,
      evidenceOnlySubagents: true,
      writeSetIsolationRequired: true,
      finalizerRequired: true,
    },
    runtime: {
      wouldSpawnSubagents: false,
      actualSubagentSpawn: false,
      executorInvocation: false,
      processSpawn: false,
      runtimeBehaviorChanged: false,
    },
    boundaries: noLiveBoundaries(),
    blockers,
    nextAction: state === "recommendation_recorded"
      ? "record dry-run recommendation for finalizer review; runtime spawn remains disabled"
      : "resolve dry-run blockers before any runtime executor work",
  };
}

export function buildA2AWorkerSubagentEvidencePacket(
  input: A2AWorkerSubagentEvidencePacketInput,
): A2AWorkerSubagentEvidencePacket {
  const generatedAt = input.now ?? new Date().toISOString();
  const sideEffects = { ...EMPTY_SIDE_EFFECTS, ...(input.sideEffects ?? {}) };
  const blockers = evidenceBlockers(input, sideEffects);
  const state: A2AWorkerSubagentEvidenceStatus = blockers.length ? "blocked" : input.status;
  const id = hashPacket("subagent-evidence", input.parentTaskId, input.workerId, input.subagentId, generatedAt);

  return {
    kind: "a2a-broker.worker-subagent-evidence.packet",
    version: 1,
    generatedAt,
    sourceOnly: true,
    id,
    parentTaskId: input.parentTaskId,
    workerId: input.workerId,
    subagentId: input.subagentId,
    role: input.role,
    state,
    claims: [...(input.claims ?? [])],
    evidenceRefs: [...(input.evidenceRefs ?? [])],
    filesInspected: [...(input.filesInspected ?? [])],
    testsRun: [...(input.testsRun ?? [])],
    risks: [...(input.risks ?? [])],
    recommendation: input.recommendation,
    confidence: input.confidence ?? "medium",
    blockedReason: input.blockedReason,
    finalDecisionClaim: input.finalDecisionClaim,
    sideEffects,
    decisionAuthority: {
      evidenceOnly: true,
      subagentMayCloseOrMerge: false,
      subagentMayDeployOrRestart: false,
      subagentMayAckOrReplayTerminal: false,
      subagentMaySendProviders: false,
      subagentMayMoveSecrets: false,
      finalizerDecisionRequired: true,
    },
    blockers,
  };
}

export function buildA2AWorkerSubagentSynthesisPacket(
  input: A2AWorkerSubagentSynthesisPacketInput,
): A2AWorkerSubagentSynthesisPacket {
  const generatedAt = input.now ?? new Date().toISOString();
  const blockers = synthesisBlockers(input);
  const acceptedEvidenceIds = input.subagentEvidence
    .filter((packet) => packet.state === "done" && packet.blockers.length === 0)
    .map((packet) => packet.id);
  const rejectedEvidenceIds = input.subagentEvidence
    .filter((packet) => packet.state !== "done" || packet.blockers.length > 0)
    .map((packet) => packet.id);
  const state: A2AWorkerSubagentSynthesisState = blockers.length ? "blocked" : "ready_for_finalizer_review";

  return {
    kind: "a2a-broker.worker-subagent-synthesis.packet",
    version: 1,
    generatedAt,
    sourceOnly: true,
    idempotencyKey: hashPacket("subagent-synthesis", input.parentTaskId, input.workerId, input.finalizer, generatedAt),
    state,
    finalizer: input.finalizer,
    workerId: input.workerId,
    parentTaskId: input.parentTaskId,
    dryRunPlanIdempotencyKey: input.dryRunPlan.idempotencyKey,
    expectedRoles: input.dryRunPlan.recommendation.roles,
    acceptedEvidenceIds,
    rejectedEvidenceIds,
    finalizerDecisionRequired: true,
    subagentsMayNotCloseOrMerge: true,
    boundaries: {
      actualSubagentSpawn: false,
      executorInvocation: false,
      processSpawn: false,
      brokerDispatch: false,
      workerClaim: false,
      taskFlowMutation: false,
      dbMutation: false,
      deployOrRestart: false,
      providerSend: false,
      terminalAckOrReplay: false,
      releaseOrPublish: false,
      secretMovement: false,
    },
    blockers,
    nextAction: state === "ready_for_finalizer_review"
      ? "broker finalizer may review synthesized evidence; subagents do not make final decisions"
      : "broker finalizer must resolve blocked subagent evidence before counting synthesis",
  };
}

export function isA2AWorkerSubagentEvidencePacket(value: unknown): value is A2AWorkerSubagentEvidencePacket {
  return isObject(value) && value.kind === "a2a-broker.worker-subagent-evidence.packet" && value.sourceOnly === true;
}

export function isA2AWorkerSubagentSynthesisPacket(value: unknown): value is A2AWorkerSubagentSynthesisPacket {
  return isObject(value) && value.kind === "a2a-broker.worker-subagent-synthesis.packet" && value.sourceOnly === true;
}

export function renderA2AWorkerSubagentDryRunPlanMarkdown(packet: A2AWorkerSubagentDryRunPlanPacket): string {
  return [
    "A2A worker subagent dry-run plan",
    "State: " + packet.state,
    "Worker: " + packet.workerId,
    "Task: " + (packet.taskId ?? "unknown"),
    "Finalizer: " + packet.finalizer,
    "Mode: dry-run only; runtime spawn disabled",
    "Feature gate enabled: " + String(packet.featureGate.enabled),
    "Parallelism hint: " + packet.recommendation.parallelismHint,
    "Roles: " + (packet.recommendation.roles.map((role) => role.role).join(",") || "direct"),
    "Safety: no executor/process spawn, broker dispatch, worker claim, DB/TaskFlow mutation, deploy/restart, provider send, terminal ACK/replay, release/publish, or secret movement.",
  ].join("\n");
}

function dryRunBlockers(policy: A2AWorkerSubagentPolicyPacket): string[] {
  const blockers: string[] = [];
  if (policy.sourceOnlyPolicy !== true) blockers.push("planner policy is not source-only");
  if (policy.decision.evidenceOnlySubagents !== true) blockers.push("planner policy does not require evidence-only subagents");
  if (policy.decision.oneFinalizerRequired !== true) blockers.push("planner policy does not require one finalizer");
  if (policy.boundaries.runtimeBehaviorChanged !== false) blockers.push("planner policy changed runtime behavior");
  if (policy.boundaries.mandatoryProductionSpawn !== false) blockers.push("planner policy requires production spawn");
  if (policy.boundaries.brokerDispatchSemanticsChanged !== false) blockers.push("planner policy changes broker dispatch semantics");
  if (policy.boundaries.dbMutation !== false) blockers.push("planner policy allows db mutation");
  return blockers;
}

function evidenceBlockers(
  input: A2AWorkerSubagentEvidencePacketInput,
  sideEffects: Required<A2AWorkerSubagentSideEffects>,
): string[] {
  const blockers: string[] = [];
  if (input.finalDecisionClaim) blockers.push("subagent attempted final decision: " + input.finalDecisionClaim);
  if (Object.values(sideEffects).some(Boolean)) blockers.push("subagent reported side effects");
  if (input.status === "blocked" && !input.blockedReason && !blockers.length) blockers.push("blocked evidence requires blockedReason");
  return blockers;
}

function synthesisBlockers(input: A2AWorkerSubagentSynthesisPacketInput): string[] {
  const blockers: string[] = [];
  if (!input.finalizer) blockers.push("finalizer is required");
  if (input.dryRunPlan.runtime.actualSubagentSpawn !== false) blockers.push("dry-run plan attempted runtime spawn");
  if (input.dryRunPlan.workerId !== input.workerId) blockers.push("dry-run worker does not match synthesis worker");
  if ((input.dryRunPlan.taskId ?? "") !== input.parentTaskId) blockers.push("dry-run task does not match synthesis task");
  for (const packet of input.subagentEvidence) {
    if (packet.workerId !== input.workerId) blockers.push("subagent " + packet.subagentId + " worker mismatch");
    if (packet.parentTaskId !== input.parentTaskId) blockers.push("subagent " + packet.subagentId + " task mismatch");
    if (packet.state !== "done" || packet.blockers.length > 0) blockers.push("subagent " + packet.subagentId + " is blocked");
  }
  return unique(blockers);
}

function noLiveBoundaries(): A2AWorkerSubagentDryRunPlanPacket["boundaries"] {
  return {
    brokerDispatch: false,
    workerClaim: false,
    taskFlowMutation: false,
    dbMutation: false,
    deployOrRestart: false,
    providerSend: false,
    terminalAckOrReplay: false,
    releaseOrPublish: false,
    secretMovement: false,
    mandatoryProductionSpawn: false,
  };
}

function hashPacket(...parts: unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 24);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
