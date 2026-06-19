import { createHash } from "node:crypto";

import type {
  A2AWorkerSubagentDryRunPlanPacket,
  A2AWorkerSubagentSynthesisPacket,
} from "./worker-subagent-dry-run.js";

export type A2AWorkerSubagentExecutorAdapterBoundaryState =
  | "disabled"
  | "blocked"
  | "eligible_pending_runtime_approval";

export interface A2AWorkerSubagentExecutorAdapterGateInput {
  enabled?: boolean;
  taskOptIn?: boolean;
  depthLimit?: number;
  workerActiveSubagents?: number;
  workerSubagentCap?: number;
  brokerActiveSubagents?: number;
  brokerSubagentCap?: number;
}

export interface A2AWorkerSubagentExecutorAdapterBoundaryInput {
  now?: string;
  dryRunPlan: A2AWorkerSubagentDryRunPlanPacket;
  synthesis: A2AWorkerSubagentSynthesisPacket;
  featureGate?: A2AWorkerSubagentExecutorAdapterGateInput;
  runtimeAdapter?: () => unknown;
}

export interface A2AWorkerSubagentExecutorAdapterBoundaryPacket {
  kind: "a2a-broker.worker-subagent-executor-adapter-boundary.packet";
  version: 1;
  generatedAt: string;
  sourceOnly: true;
  idempotencyKey: string;
  state: A2AWorkerSubagentExecutorAdapterBoundaryState;
  finalizer: string;
  workerId: string;
  parentTaskId: string;
  dryRunPlanIdempotencyKey: string;
  synthesisIdempotencyKey: string;
  laneIdempotencyKeys: string[];
  featureGate: {
    enabled: boolean;
    taskOptIn: boolean;
    runtimeSpawnAllowed: false;
    depthLimit: 1;
    workerActiveSubagents: number;
    workerSubagentCap: number;
    brokerActiveSubagents: number;
    brokerSubagentCap: number;
  };
  readiness: {
    dryRunReady: boolean;
    synthesisReady: boolean;
    finalizerMatches: boolean;
    workerMatches: boolean;
    parentTaskMatches: boolean;
    rolesPresent: boolean;
    workerCapOk: boolean;
    brokerCapOk: boolean;
    adapterBoundaryReady: boolean;
  };
  runtime: {
    wouldEnterRuntimeAdapter: boolean;
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

export function buildA2AWorkerSubagentExecutorAdapterBoundary(
  input: A2AWorkerSubagentExecutorAdapterBoundaryInput,
): A2AWorkerSubagentExecutorAdapterBoundaryPacket {
  const generatedAt = input.now ?? new Date().toISOString();
  const gate = normalizeGate(input.featureGate);
  const readiness = buildReadiness(input.dryRunPlan, input.synthesis, gate);
  const blockers = buildBlockers(input.dryRunPlan, input.synthesis, gate, readiness);
  const state = stateFor(gate, blockers);
  const laneIdempotencyKeys = input.dryRunPlan.recommendation.roles.map((role, index) => hashPacket(
    "subagent-adapter-lane",
    input.dryRunPlan.idempotencyKey,
    input.synthesis.idempotencyKey,
    input.dryRunPlan.workerId,
    input.dryRunPlan.taskId ?? "",
    role.role,
    role.writeSet ?? "",
    index,
  ));

  return {
    kind: "a2a-broker.worker-subagent-executor-adapter-boundary.packet",
    version: 1,
    generatedAt,
    sourceOnly: true,
    idempotencyKey: hashPacket(
      "subagent-adapter-boundary",
      input.dryRunPlan.idempotencyKey,
      input.synthesis.idempotencyKey,
      input.dryRunPlan.workerId,
      input.dryRunPlan.taskId ?? "",
      gate.enabled,
      gate.taskOptIn,
      gate.depthLimit,
    ),
    state,
    finalizer: input.synthesis.finalizer,
    workerId: input.dryRunPlan.workerId,
    parentTaskId: input.dryRunPlan.taskId ?? input.synthesis.parentTaskId,
    dryRunPlanIdempotencyKey: input.dryRunPlan.idempotencyKey,
    synthesisIdempotencyKey: input.synthesis.idempotencyKey,
    laneIdempotencyKeys,
    featureGate: {
      enabled: gate.enabled,
      taskOptIn: gate.taskOptIn,
      runtimeSpawnAllowed: false,
      depthLimit: 1,
      workerActiveSubagents: gate.workerActiveSubagents,
      workerSubagentCap: gate.workerSubagentCap,
      brokerActiveSubagents: gate.brokerActiveSubagents,
      brokerSubagentCap: gate.brokerSubagentCap,
    },
    readiness,
    runtime: {
      wouldEnterRuntimeAdapter: state === "eligible_pending_runtime_approval",
      actualSubagentSpawn: false,
      executorInvocation: false,
      processSpawn: false,
      runtimeBehaviorChanged: false,
    },
    boundaries: noLiveBoundaries(),
    blockers,
    nextAction: nextActionFor(state),
  };
}

export function renderA2AWorkerSubagentExecutorAdapterBoundaryMarkdown(
  packet: A2AWorkerSubagentExecutorAdapterBoundaryPacket,
): string {
  return [
    "A2A worker subagent executor adapter boundary",
    "State: " + packet.state,
    "Worker: " + packet.workerId,
    "Task: " + packet.parentTaskId,
    "Finalizer: " + packet.finalizer,
    "Feature gate: enabled=" + packet.featureGate.enabled + " taskOptIn=" + packet.featureGate.taskOptIn,
    "Runtime: no runtime spawn; executor invocation=false process spawn=false",
    "Lane idempotency keys: " + packet.laneIdempotencyKeys.length,
    "Blockers: " + (packet.blockers.join("; ") || "none"),
    "Next: " + packet.nextAction,
    "Safety: adapter boundary only; future explicit runtime-spawn approval required before live executor work.",
  ].join("\n");
}

function normalizeGate(input?: A2AWorkerSubagentExecutorAdapterGateInput): Required<A2AWorkerSubagentExecutorAdapterGateInput> {
  return {
    enabled: input?.enabled === true,
    taskOptIn: input?.taskOptIn === true,
    depthLimit: input?.depthLimit ?? 1,
    workerActiveSubagents: input?.workerActiveSubagents ?? 0,
    workerSubagentCap: input?.workerSubagentCap ?? 4,
    brokerActiveSubagents: input?.brokerActiveSubagents ?? 0,
    brokerSubagentCap: input?.brokerSubagentCap ?? 12,
  };
}

function buildReadiness(
  dryRunPlan: A2AWorkerSubagentDryRunPlanPacket,
  synthesis: A2AWorkerSubagentSynthesisPacket,
  gate: Required<A2AWorkerSubagentExecutorAdapterGateInput>,
): A2AWorkerSubagentExecutorAdapterBoundaryPacket["readiness"] {
  const dryRunReady = dryRunPlan.state === "recommendation_recorded" && dryRunPlan.blockers.length === 0;
  const synthesisReady = synthesis.state === "ready_for_finalizer_review" && synthesis.blockers.length === 0;
  const finalizerMatches = dryRunPlan.finalizer === synthesis.finalizer;
  const workerMatches = dryRunPlan.workerId === synthesis.workerId;
  const parentTaskMatches = (dryRunPlan.taskId ?? "") === synthesis.parentTaskId;
  const rolesPresent = dryRunPlan.recommendation.parallelismHint > 0 && dryRunPlan.recommendation.roles.length > 0;
  const workerCapOk = gate.workerActiveSubagents < gate.workerSubagentCap;
  const brokerCapOk = gate.brokerActiveSubagents < gate.brokerSubagentCap;
  const adapterBoundaryReady = dryRunReady
    && synthesisReady
    && finalizerMatches
    && workerMatches
    && parentTaskMatches
    && rolesPresent
    && workerCapOk
    && brokerCapOk
    && gate.enabled
    && gate.taskOptIn
    && gate.depthLimit === 1;
  return {
    dryRunReady,
    synthesisReady,
    finalizerMatches,
    workerMatches,
    parentTaskMatches,
    rolesPresent,
    workerCapOk,
    brokerCapOk,
    adapterBoundaryReady,
  };
}

function buildBlockers(
  dryRunPlan: A2AWorkerSubagentDryRunPlanPacket,
  synthesis: A2AWorkerSubagentSynthesisPacket,
  gate: Required<A2AWorkerSubagentExecutorAdapterGateInput>,
  readiness: A2AWorkerSubagentExecutorAdapterBoundaryPacket["readiness"],
): string[] {
  const blockers = [
    ...(!gate.enabled ? ["feature gate disabled"] : []),
    ...(!gate.taskOptIn ? ["task-level opt-in missing"] : []),
    ...(gate.depthLimit !== 1 ? ["depth limit must be exactly 1"] : []),
    ...(!readiness.dryRunReady ? ["dry-run plan is not ready"] : []),
    ...(!readiness.synthesisReady ? ["synthesis is not ready for finalizer review"] : []),
    ...(!readiness.finalizerMatches ? ["dry-run finalizer does not match synthesis finalizer"] : []),
    ...(!readiness.workerMatches ? ["dry-run worker does not match synthesis worker"] : []),
    ...(!readiness.parentTaskMatches ? ["dry-run task does not match synthesis task"] : []),
    ...(!readiness.rolesPresent ? ["no subagent roles are recommended"] : []),
    ...(!readiness.workerCapOk ? ["worker subagent cap exhausted"] : []),
    ...(!readiness.brokerCapOk ? ["broker subagent cap exhausted"] : []),
    ...(dryRunPlan.runtime.actualSubagentSpawn !== false ? ["dry-run plan attempted runtime spawn"] : []),
    ...(synthesis.boundaries.actualSubagentSpawn !== false ? ["synthesis attempted runtime spawn"] : []),
  ];
  return unique(blockers);
}

function stateFor(
  gate: Required<A2AWorkerSubagentExecutorAdapterGateInput>,
  blockers: string[],
): A2AWorkerSubagentExecutorAdapterBoundaryState {
  if (!gate.enabled && blockers.every((blocker) => ["feature gate disabled", "task-level opt-in missing"].includes(blocker))) {
    return "disabled";
  }
  return blockers.length === 0 ? "eligible_pending_runtime_approval" : "blocked";
}

function nextActionFor(state: A2AWorkerSubagentExecutorAdapterBoundaryState): string {
  if (state === "eligible_pending_runtime_approval") {
    return "record adapter eligibility only; future explicit runtime-spawn approval is required before executor work";
  }
  if (state === "disabled") {
    return "keep direct/dry-run behavior; enable feature gate and task opt-in only in a future approved runtime slice";
  }
  return "resolve adapter boundary blockers before any future explicit runtime-spawn approval";
}

function noLiveBoundaries(): A2AWorkerSubagentExecutorAdapterBoundaryPacket["boundaries"] {
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
