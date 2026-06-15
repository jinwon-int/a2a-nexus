import { unique } from "./collections.js";
import { isRecord } from "./value-guards.js";
import { createHash } from "node:crypto";

import type { TerminalBriefSidecarDefaultOnFinalRuntimeMutationExecutorGatePacket } from "./terminal-brief-sidecar-default-on-final-runtime-mutation-executor-gate.js";
import {
  buildTerminalBriefSidecarDefaultOnFinalRuntimeMutationExecutorGate,
  extractTerminalBriefSidecarDefaultOnFinalRuntimeMutationExecutorGateEvidence,
  extractTerminalBriefSidecarDefaultOnFinalRuntimeMutationExecutorGateOptions,
} from "./terminal-brief-sidecar-default-on-final-runtime-mutation-executor-gate.js";

export type TerminalBriefSidecarDefaultOnLiveExecutorState =
  | "awaiting_final_live_execution_approval"
  | "waiting_for_final_runtime_mutation_executor_gate"
  | "approval_rejected"
  | "stale"
  | "conflicting"
  | "blocked";

export interface TerminalBriefSidecarDefaultOnLiveExecutorOptions {
  now?: string;
  mode?: string;
  finalizer?: string;
  finalizerId?: string;
  liveExecutorReference?: string;
  live_executor_reference?: string;
}

export interface TerminalBriefSidecarDefaultOnLiveExecutorPacket {
  kind: "a2a-broker.terminal-brief-sidecar-default-on-live-executor.packet";
  version: 1;
  generatedAt: string;
  mode: string;
  state: TerminalBriefSidecarDefaultOnLiveExecutorState;
  dryRunOnly: false;
  sourceOnlyNoLive: true;
  idempotencyKey: string;
  source: {
    finalRuntimeMutationExecutorGateState: TerminalBriefSidecarDefaultOnFinalRuntimeMutationExecutorGatePacket["state"];
    finalRuntimeMutationExecutorGateIdempotencyKey: string;
    finalRuntimeMutationExecutorGateReady: boolean;
    finalRuntimeMutationExecutorGateReference: string;
    executionWindowApprovalEvidenceState: string;
    receiptEvidenceAccepted: boolean;
    approvalEvidenceAccepted: boolean;
    executionWindowApprovalEvidenceAccepted: boolean;
    executionWindowReference: string;
    requestedAction: string;
    requestedBy: string;
    operatorTarget: string;
    requiredReply: string;
    checkpointReference: string;
    targetConfigFile: string;
    backupLocation: string;
    runtimeTarget: string;
    configKey: string;
    proposedValue: string;
    executorId: string;
  };
  liveExecutor: {
    reviewOnly: true;
    failClosed: true;
    liveExecutorReference: string;
    finalizer: string;
    liveExecutorAvailable: boolean;
    finalLiveExecutionApprovalRequired: true;
    finalLiveExecutionApprovalAccepted: false;
    executionArmed: false;
    executionPerformed: false;
    operations: Array<{
      id: string;
      description: string;
      target: string;
      commandTemplate: string;
      permitted: false;
      performed: false;
      requiresFinalApproval: true;
    }>;
    abortConditions: string[];
    requiredSeparateApprovalForExecution: true;
  };
  readiness: {
    sourceCriteriaMet: boolean;
    liveExecutorReviewReady: boolean;
    finalRuntimeMutationExecutorGateReady: boolean;
    finalLiveExecutionApprovalRequired: true;
    finalLiveExecutionApprovalAccepted: false;
    executionArmed: false;
    executionPerformed: false;
    checkpointCreationPermitted: false;
    rollbackExecutionPermitted: false;
    runtimeMutationPermitted: false;
    configWritePermitted: false;
    defaultOnPermitted: false;
    sidecarRestartPermitted: false;
    liveActivationPermitted: false;
    providerSendPermitted: false;
    terminalAckPermitted: false;
    dbMutationPermitted: false;
    taskFlowMutationPermitted: false;
    startExecutorDispatchPermitted: false;
    executorInvocationPermitted: false;
    executionPermitted: false;
    processSpawnPermitted: false;
    sidecarStartPermitted: false;
    brokerRestartPermitted: false;
    gatewayRestartPermitted: false;
    missingEvidence: string[];
    blockers: string[];
    nextAction: string;
  };
  blockers: string[];
  nextActions: string[];
  approvalSensitiveActionsExcluded: string[];
  integrationContract: {
    transport: "json";
    liveExecutorVersion: 1;
    consumesFinalRuntimeMutationExecutorGatePacket: true;
    rendersLiveExecutorPacket: true;
    createsCheckpoint: false;
    executesRollback: false;
    writesConfig: false;
    enablesDefaultOn: false;
    dispatchesStartExecutor: false;
    invokesExecutor: false;
    spawnsProcess: false;
    startsSidecar: false;
    restartsSidecar: false;
    restartsBroker: false;
    restartsGateway: false;
    sendsProvider: false;
    performsTerminalAck: false;
    mutatesDb: false;
    mutatesTaskFlow: false;
    executesAction: false;
  };
  semantics: {
    liveExecutorPacketOnly: true;
    sourceOnlyNoLive: true;
    finalRuntimeMutationExecutorGateDoesNotAuthorizeRuntime: true;
    liveExecutorDoesNotExecuteWithoutFinalApproval: true;
    finalApprovalStillRequired: true;
    gateDoesNotCreateCheckpoint: true;
    gateDoesNotExecuteRollback: true;
    gateDoesNotWriteConfig: true;
    gateDoesNotEnableDefaultOn: true;
    gateDoesNotStartOrRestartSidecar: true;
    gateDoesNotDispatchExecutor: true;
    gateDoesNotInvokeExecutor: true;
    gateDoesNotSpawnProcess: true;
    providerAcceptedIsVisibilityProof: false;
    approvalGrantEvidenceExecutesGrant: false;
    terminalAckEligibleDoesNotPermitAck: true;
    executionNotPermitted: true;
    processSpawnNotPermitted: true;
    sidecarStartNotPermitted: true;
    sidecarRestartNotPermitted: true;
    brokerRestartNotPermitted: true;
    gatewayRestartNotPermitted: true;
    defaultOnNotEnabledByThisPacket: true;
    routeIsReadOnly: true;
    brokerFinalizerRequired: true;
    performsGitHubMutation: false;
    performsProviderSend: false;
    performsTerminalAck: false;
    performsRuntimeRestartOrDeploy: false;
    performsDbMutation: false;
    createsTaskFlowRecords: false;
    performsHistoricalReplay: false;
    performsReleaseOrPublish: false;
    movesSecretsOrCredentials: false;
  };
}

type SourceGate = TerminalBriefSidecarDefaultOnFinalRuntimeMutationExecutorGatePacket;
type SourceReadinessKey = keyof SourceGate["readiness"];
type SourceIntegrationKey = keyof SourceGate["integrationContract"];
type SourceSemanticsKey = keyof SourceGate["semantics"];

const falseSourceReadinessKeys = [
  "executionWindowRequestDispatchPermitted",
  "approvalGrantPermitted",
  "approvalGrantExecutionPermitted",
  "checkpointCreationPermitted",
  "rollbackExecutionPermitted",
  "runtimeMutationPermitted",
  "configWritePermitted",
  "defaultOnPermitted",
  "sidecarRestartPermitted",
  "liveActivationPermitted",
  "providerSendPermitted",
  "terminalAckPermitted",
  "dbMutationPermitted",
  "taskFlowMutationPermitted",
  "startExecutorDispatchPermitted",
  "executorInvocationPermitted",
  "executionPermitted",
  "processSpawnPermitted",
  "sidecarStartPermitted",
  "brokerRestartPermitted",
  "gatewayRestartPermitted",
] as const satisfies readonly SourceReadinessKey[];

const falseSourceIntegrationKeys = [
  "sendsExecutionWindowRequest",
  "grantsApproval",
  "executesApprovalGrant",
  "createsCheckpoint",
  "executesRollback",
  "writesConfig",
  "enablesDefaultOn",
  "dispatchesStartExecutor",
  "invokesExecutor",
  "spawnsProcess",
  "startsSidecar",
  "restartsSidecar",
  "restartsBroker",
  "restartsGateway",
  "sendsProvider",
  "performsTerminalAck",
  "mutatesDb",
  "mutatesTaskFlow",
  "executesAction",
] as const satisfies readonly SourceIntegrationKey[];

const trueSourceSemanticsKeys = [
  "finalRuntimeMutationExecutorGateOnly",
  "sourceOnlyNoLive",
  "acceptedEvidenceDoesNotAuthorizeRuntime",
  "gateDoesNotCreateCheckpoint",
  "gateDoesNotExecuteRollback",
  "gateDoesNotWriteConfig",
  "gateDoesNotEnableDefaultOn",
  "gateDoesNotStartOrRestartSidecar",
  "gateDoesNotDispatchExecutor",
  "gateDoesNotInvokeExecutor",
  "gateDoesNotSpawnProcess",
  "terminalAckEligibleDoesNotPermitAck",
  "executionNotPermitted",
  "processSpawnNotPermitted",
  "sidecarStartNotPermitted",
  "sidecarRestartNotPermitted",
  "brokerRestartNotPermitted",
  "gatewayRestartNotPermitted",
  "defaultOnNotEnabledByThisPacket",
  "routeIsReadOnly",
  "brokerFinalizerRequired",
] as const satisfies readonly SourceSemanticsKey[];

const falseSourceSemanticsKeys = [
  "providerAcceptedIsVisibilityProof",
  "approvalGrantEvidenceExecutesGrant",
  "performsGitHubMutation",
  "performsProviderSend",
  "performsTerminalAck",
  "performsRuntimeRestartOrDeploy",
  "performsDbMutation",
  "createsTaskFlowRecords",
  "performsHistoricalReplay",
  "performsReleaseOrPublish",
  "movesSecretsOrCredentials",
] as const satisfies readonly SourceSemanticsKey[];

export function buildTerminalBriefSidecarDefaultOnLiveExecutor(
  gate: SourceGate,
  options: TerminalBriefSidecarDefaultOnLiveExecutorOptions = {},
): TerminalBriefSidecarDefaultOnLiveExecutorPacket {
  const generatedAt = options.now ?? new Date().toISOString();
  const blockers = sourceBlockers(gate);
  const state = stateFor(gate, blockers);
  const ready = state === "awaiting_final_live_execution_approval";
  const liveExecutorReference = options.liveExecutorReference
    ?? options.live_executor_reference
    ?? buildLiveExecutorReference(gate);

  return {
    kind: "a2a-broker.terminal-brief-sidecar-default-on-live-executor.packet",
    version: 1,
    generatedAt,
    mode: options.mode ?? "terminal-brief-default-on-live-executor-source-only-fail-closed",
    state,
    dryRunOnly: false,
    sourceOnlyNoLive: true,
    idempotencyKey: buildIdempotencyKey(gate, liveExecutorReference, generatedAt, state),
    source: {
      finalRuntimeMutationExecutorGateState: gate.state,
      finalRuntimeMutationExecutorGateIdempotencyKey: gate.idempotencyKey,
      finalRuntimeMutationExecutorGateReady: gate.readiness.finalRuntimeMutationExecutorGateReady,
      finalRuntimeMutationExecutorGateReference: gate.finalRuntimeMutationExecutorGate.finalRuntimeMutationExecutorGateReference,
      executionWindowApprovalEvidenceState: gate.source.executionWindowApprovalEvidenceState,
      receiptEvidenceAccepted: gate.source.receiptEvidenceAccepted,
      approvalEvidenceAccepted: gate.source.approvalEvidenceAccepted,
      executionWindowApprovalEvidenceAccepted: gate.source.executionWindowApprovalEvidenceAccepted,
      executionWindowReference: gate.source.executionWindowReference,
      requestedAction: gate.source.requestedAction,
      requestedBy: gate.source.requestedBy,
      operatorTarget: gate.source.operatorTarget,
      requiredReply: gate.source.requiredReply,
      checkpointReference: gate.source.checkpointReference,
      targetConfigFile: gate.source.targetConfigFile,
      backupLocation: gate.source.backupLocation,
      runtimeTarget: gate.source.runtimeTarget,
      configKey: gate.source.configKey,
      proposedValue: gate.source.proposedValue,
      executorId: gate.source.executorId,
    },
    liveExecutor: {
      reviewOnly: true,
      failClosed: true,
      liveExecutorReference,
      finalizer: options.finalizer ?? options.finalizerId ?? "broker-finalizer",
      liveExecutorAvailable: ready,
      finalLiveExecutionApprovalRequired: true,
      finalLiveExecutionApprovalAccepted: false,
      executionArmed: false,
      executionPerformed: false,
      operations: plannedOperations(gate),
      abortConditions: [
        "final live execution approval is missing or not explicitly accepted",
        "source final runtime mutation executor gate is missing, stale, rejected, conflicting, or blocked",
        "source gate permits any checkpoint, rollback, config write, default-on enablement, sidecar apply, executor invocation, process spawn, provider send, terminal ACK, DB/TaskFlow mutation, or restart",
        "checkpoint target, rollback target, runtime target, config key, proposed value, or executor identity drift is detected",
        "Gateway readiness or event loop health is degraded",
        "queue backlog exceeds the approved runtime bound",
        "operator asks this packet or route to execute instead of only rendering the fail-closed executor surface",
        "secret values are required in the packet, logs, issue comments, or Wiki",
      ],
      requiredSeparateApprovalForExecution: true,
    },
    readiness: {
      sourceCriteriaMet: ready,
      liveExecutorReviewReady: ready,
      finalRuntimeMutationExecutorGateReady: gate.readiness.finalRuntimeMutationExecutorGateReady,
      finalLiveExecutionApprovalRequired: true,
      finalLiveExecutionApprovalAccepted: false,
      executionArmed: false,
      executionPerformed: false,
      checkpointCreationPermitted: false,
      rollbackExecutionPermitted: false,
      runtimeMutationPermitted: false,
      configWritePermitted: false,
      defaultOnPermitted: false,
      sidecarRestartPermitted: false,
      liveActivationPermitted: false,
      providerSendPermitted: false,
      terminalAckPermitted: false,
      dbMutationPermitted: false,
      taskFlowMutationPermitted: false,
      startExecutorDispatchPermitted: false,
      executorInvocationPermitted: false,
      executionPermitted: false,
      processSpawnPermitted: false,
      sidecarStartPermitted: false,
      brokerRestartPermitted: false,
      gatewayRestartPermitted: false,
      missingEvidence: missingEvidence(gate),
      blockers: [
        ...blockers,
        "final live execution approval is still required before checkpoint creation, config write, default-on enablement, sidecar apply, or executor invocation",
      ],
      nextAction: nextActionFor(state),
    },
    blockers,
    nextActions: nextActionsFor(state),
    approvalSensitiveActionsExcluded: approvalSensitiveActionsExcluded(),
    integrationContract: {
      transport: "json",
      liveExecutorVersion: 1,
      consumesFinalRuntimeMutationExecutorGatePacket: true,
      rendersLiveExecutorPacket: true,
      createsCheckpoint: false,
      executesRollback: false,
      writesConfig: false,
      enablesDefaultOn: false,
      dispatchesStartExecutor: false,
      invokesExecutor: false,
      spawnsProcess: false,
      startsSidecar: false,
      restartsSidecar: false,
      restartsBroker: false,
      restartsGateway: false,
      sendsProvider: false,
      performsTerminalAck: false,
      mutatesDb: false,
      mutatesTaskFlow: false,
      executesAction: false,
    },
    semantics: {
      liveExecutorPacketOnly: true,
      sourceOnlyNoLive: true,
      finalRuntimeMutationExecutorGateDoesNotAuthorizeRuntime: true,
      liveExecutorDoesNotExecuteWithoutFinalApproval: true,
      finalApprovalStillRequired: true,
      gateDoesNotCreateCheckpoint: true,
      gateDoesNotExecuteRollback: true,
      gateDoesNotWriteConfig: true,
      gateDoesNotEnableDefaultOn: true,
      gateDoesNotStartOrRestartSidecar: true,
      gateDoesNotDispatchExecutor: true,
      gateDoesNotInvokeExecutor: true,
      gateDoesNotSpawnProcess: true,
      providerAcceptedIsVisibilityProof: false,
      approvalGrantEvidenceExecutesGrant: false,
      terminalAckEligibleDoesNotPermitAck: true,
      executionNotPermitted: true,
      processSpawnNotPermitted: true,
      sidecarStartNotPermitted: true,
      sidecarRestartNotPermitted: true,
      brokerRestartNotPermitted: true,
      gatewayRestartNotPermitted: true,
      defaultOnNotEnabledByThisPacket: true,
      routeIsReadOnly: true,
      brokerFinalizerRequired: true,
      performsGitHubMutation: false,
      performsProviderSend: false,
      performsTerminalAck: false,
      performsRuntimeRestartOrDeploy: false,
      performsDbMutation: false,
      createsTaskFlowRecords: false,
      performsHistoricalReplay: false,
      performsReleaseOrPublish: false,
      movesSecretsOrCredentials: false,
    },
  };
}

export function extractTerminalBriefSidecarDefaultOnLiveExecutorGate(input: unknown): SourceGate {
  const envelope = isRecord(input) ? input : {};
  const candidates = [
    input,
    envelope.defaultOnLiveExecutorGatePacket,
    envelope.liveExecutorGatePacket,
    envelope.defaultOnFinalRuntimeMutationExecutorGatePacket,
    envelope.finalRuntimeMutationExecutorGatePacket,
    envelope.finalRuntimeMutationExecutorGate,
    envelope.packet,
  ];
  const packet = candidates.find(isFinalRuntimeMutationExecutorGatePacket);
  if (packet) return packet;

  return buildTerminalBriefSidecarDefaultOnFinalRuntimeMutationExecutorGate(
    extractTerminalBriefSidecarDefaultOnFinalRuntimeMutationExecutorGateEvidence(input),
    extractTerminalBriefSidecarDefaultOnFinalRuntimeMutationExecutorGateOptions(input),
  );
}

export function extractTerminalBriefSidecarDefaultOnLiveExecutorOptions(
  input: unknown,
): TerminalBriefSidecarDefaultOnLiveExecutorOptions {
  const envelope = isRecord(input) ? input : {};
  const options = isRecord(envelope.defaultOnLiveExecutor)
    ? envelope.defaultOnLiveExecutor
    : isRecord(envelope.liveExecutor)
      ? envelope.liveExecutor
      : isRecord(envelope.options)
        ? envelope.options
        : {};
  return options as TerminalBriefSidecarDefaultOnLiveExecutorOptions;
}

export function renderTerminalBriefSidecarDefaultOnLiveExecutorMarkdown(
  packet: TerminalBriefSidecarDefaultOnLiveExecutorPacket,
): string {
  return [
    titleForState(packet.state),
    "Mode: " + packet.mode,
    "State: " + packet.state + " sourceOnlyNoLive=" + packet.sourceOnlyNoLive,
    "Idempotency: " + packet.idempotencyKey,
    "Source gate: state=" + packet.source.finalRuntimeMutationExecutorGateState
      + " gateReady=" + packet.source.finalRuntimeMutationExecutorGateReady
      + " reference=" + packet.source.finalRuntimeMutationExecutorGateReference,
    "Runtime target: " + packet.source.runtimeTarget
      + " configKey=" + packet.source.configKey
      + " proposedValue=" + packet.source.proposedValue
      + " executorId=" + packet.source.executorId,
    "Live executor: reference=" + packet.liveExecutor.liveExecutorReference
      + " available=" + packet.liveExecutor.liveExecutorAvailable
      + " failClosed=" + packet.liveExecutor.failClosed
      + " finalLiveExecutionApprovalAccepted=" + packet.liveExecutor.finalLiveExecutionApprovalAccepted,
    "Readiness: liveExecutorReviewReady=" + packet.readiness.liveExecutorReviewReady
      + " finalLiveExecutionApprovalAccepted=" + packet.readiness.finalLiveExecutionApprovalAccepted
      + " checkpointCreationPermitted=" + packet.readiness.checkpointCreationPermitted
      + " configWritePermitted=" + packet.readiness.configWritePermitted
      + " defaultOnPermitted=" + packet.readiness.defaultOnPermitted
      + " sidecarRestartPermitted=" + packet.readiness.sidecarRestartPermitted
      + " executionPermitted=" + packet.readiness.executionPermitted
      + " processSpawnPermitted=" + packet.readiness.processSpawnPermitted,
    "Planned operations:",
    ...packet.liveExecutor.operations.map((operation) => "- " + operation.id
      + ": permitted=" + operation.permitted
      + " performed=" + operation.performed
      + " requiresFinalApproval=" + operation.requiresFinalApproval
      + " target=" + operation.target),
    ...(packet.blockers.length ? ["", "Blockers:", ...packet.blockers.map((blocker) => "- " + blocker)] : []),
    "",
    "Next actions:",
    ...packet.nextActions.map((action) => "- " + action),
    "",
    "Safety: live executor packet only; final live execution approval is still required. This packet does not create checkpoints, execute rollback, write config, enable default-on, start/restart sidecar, dispatch/invoke executor, spawn a process, send providers, ACK/replay terminal rows, mutate GitHub/DB/TaskFlow state, restart Gateway/broker, release, publish, or move secrets.",
  ].join("\n");
}

function sourceBlockers(gate: SourceGate): string[] {
  return unique([
    ...gate.blockers,
    ...(gate.state !== "ready_for_final_runtime_mutation_executor_review" ? ["final runtime mutation executor gate state is " + gate.state] : []),
    ...(!gate.sourceOnlyNoLive ? ["final runtime mutation executor gate is not source-only no-live"] : []),
    ...(!gate.finalRuntimeMutationExecutorGate.gateReady ? ["final runtime mutation executor gate is not ready"] : []),
    ...(!gate.readiness.sourceCriteriaMet ? ["source criteria are not met"] : []),
    ...(!gate.readiness.finalRuntimeMutationExecutorGateReady ? ["final runtime mutation executor gate readiness is false"] : []),
    ...falseSourceReadinessKeys.flatMap((key) => gate.readiness[key] !== false ? ["source gate unexpectedly permits " + humanize(key)] : []),
    ...falseSourceIntegrationKeys.flatMap((key) => gate.integrationContract[key] !== false ? ["source gate unexpectedly performs " + humanize(key)] : []),
    ...trueSourceSemanticsKeys.flatMap((key) => gate.semantics[key] !== true ? ["source gate does not preserve " + humanize(key)] : []),
    ...falseSourceSemanticsKeys.flatMap((key) => gate.semantics[key] !== false ? ["source gate unexpectedly permits " + humanize(key)] : []),
  ]);
}

function stateFor(
  gate: SourceGate,
  blockers: string[],
): TerminalBriefSidecarDefaultOnLiveExecutorState {
  if (gate.state === "approval_rejected") return "approval_rejected";
  if (gate.state === "stale") return "stale";
  if (gate.state === "conflicting") return "conflicting";
  if (gate.state !== "ready_for_final_runtime_mutation_executor_review") return "waiting_for_final_runtime_mutation_executor_gate";
  if (blockers.length) return "blocked";
  return "awaiting_final_live_execution_approval";
}

function missingEvidence(gate: SourceGate): string[] {
  return unique([
    ...(gate.state !== "ready_for_final_runtime_mutation_executor_review" ? ["ready_final_runtime_mutation_executor_gate"] : []),
    ...(!gate.finalRuntimeMutationExecutorGate.gateReady ? ["final_runtime_mutation_executor_gate_ready"] : []),
    ...(!gate.readiness.finalRuntimeMutationExecutorGateReady ? ["final_runtime_mutation_executor_gate_readiness"] : []),
    "final_live_execution_approval",
  ]);
}

function plannedOperations(gate: SourceGate): TerminalBriefSidecarDefaultOnLiveExecutorPacket["liveExecutor"]["operations"] {
  return [
    {
      id: "checkpoint_create",
      description: "Create the approved pre-mutation checkpoint before any runtime write.",
      target: gate.source.checkpointReference,
      commandTemplate: "create checkpoint for " + gate.source.runtimeTarget + " before changing " + gate.source.configKey,
      permitted: false,
      performed: false,
      requiresFinalApproval: true,
    },
    {
      id: "config_write_default_on",
      description: "Write the Terminal Brief sidecar default-on config value.",
      target: gate.source.targetConfigFile,
      commandTemplate: "set " + gate.source.configKey + "=" + gate.source.proposedValue,
      permitted: false,
      performed: false,
      requiresFinalApproval: true,
    },
    {
      id: "sidecar_apply",
      description: "Apply the approved sidecar runtime after config write.",
      target: gate.source.runtimeTarget,
      commandTemplate: "apply/restart only the approved Terminal Brief sidecar runtime",
      permitted: false,
      performed: false,
      requiresFinalApproval: true,
    },
    {
      id: "post_apply_healthcheck",
      description: "Check broker/Gateway readiness and rollback criteria after the approved apply.",
      target: gate.source.runtimeTarget,
      commandTemplate: "check /readyz, broker /livez, event loop health, queue bound, and rollback target " + gate.source.backupLocation,
      permitted: false,
      performed: false,
      requiresFinalApproval: true,
    },
  ];
}

function nextActionFor(state: TerminalBriefSidecarDefaultOnLiveExecutorState): string {
  if (state === "awaiting_final_live_execution_approval") return "request explicit final live execution approval before arming checkpoint creation, config write, default-on enablement, sidecar apply, or executor invocation";
  if (state === "approval_rejected") return "stop this default-on execution path unless a new operator approval path is accepted";
  if (state === "stale") return "refresh final runtime mutation executor gate evidence before live executor review";
  if (state === "conflicting") return "resolve conflicting final runtime mutation executor gate evidence before live executor review";
  if (state === "waiting_for_final_runtime_mutation_executor_gate") return "wait for a ready source-only final runtime mutation executor gate";
  return "resolve blocked source gate evidence before live executor review";
}

function nextActionsFor(state: TerminalBriefSidecarDefaultOnLiveExecutorState): string[] {
  return [
    nextActionFor(state),
    "do not create checkpoints, execute rollback, write config, enable default-on, start/restart sidecar, dispatch/invoke executor, spawn process, send provider, ACK terminal rows, or mutate state from this packet",
  ];
}

function approvalSensitiveActionsExcluded(): string[] {
  return [
    "final live execution approval acceptance or execution",
    "checkpoint creation or rollback execution",
    "runtime config write",
    "Terminal Brief default-on enablement",
    "Terminal Brief sidecar start/restart/apply",
    "start executor dispatch, executor invocation, or process spawn",
    "live provider/Hermes/Gongyung/Telegram/OpenClaw send",
    "terminal ACK/replay or terminal receipt DB mutation",
    "GitHub PR merge, issue close, or comment post from the packet/route",
    "TaskFlow record creation or broker DB mutation",
    "Gateway/broker restart, production deploy, historical replay, release, publish, or secret movement",
  ];
}

function buildLiveExecutorReference(gate: SourceGate): string {
  return "tb-sidecar-default-on-live-executor:"
    + createHash("sha256").update(gate.idempotencyKey).digest("hex").slice(0, 16);
}

function buildIdempotencyKey(
  gate: SourceGate,
  liveExecutorReference: string,
  generatedAt: string,
  state: TerminalBriefSidecarDefaultOnLiveExecutorState,
): string {
  const base = JSON.stringify({
    label: "terminal-brief-sidecar-default-on-live-executor",
    gate: gate.idempotencyKey,
    liveExecutorReference,
    generatedAt,
    state,
  });
  return "tb-sidecar-default-on-live-executor:"
    + createHash("sha256").update(base).digest("hex").slice(0, 24);
}

function titleForState(state: TerminalBriefSidecarDefaultOnLiveExecutorState): string {
  if (state === "awaiting_final_live_execution_approval") return "Awaiting approval: Terminal Brief default-on live executor";
  if (state === "approval_rejected") return "Rejected: Terminal Brief default-on live executor";
  if (state === "stale") return "Stale: Terminal Brief default-on live executor";
  if (state === "conflicting") return "Conflicting: Terminal Brief default-on live executor";
  if (state === "waiting_for_final_runtime_mutation_executor_gate") return "Waiting: Terminal Brief default-on live executor";
  return "Blocked: Terminal Brief default-on live executor";
}

function humanize(key: string): string {
  return key.replace(/[A-Z]/g, (letter) => " " + letter.toLowerCase());
}

function isFinalRuntimeMutationExecutorGatePacket(value: unknown): value is SourceGate {
  return isRecord(value) && value.kind === "a2a-broker.terminal-brief-sidecar-default-on-final-runtime-mutation-executor-gate.packet";
}

