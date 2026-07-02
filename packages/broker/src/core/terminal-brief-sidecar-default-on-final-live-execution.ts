import { unique } from "./collections.js";
import { isRecord } from "./value-guards.js";
import { createHash } from "node:crypto";

import type { TerminalBriefSidecarDefaultOnRuntimeExecutorGatePacket } from "./terminal-brief-sidecar-default-on-runtime-executor-gate.js";

export type TerminalBriefSidecarDefaultOnFinalLiveExecutionState =
  | "ready_for_final_live_execution_review"
  | "waiting_for_runtime_executor_gate"
  | "approval_rejected"
  | "stale"
  | "conflicting"
  | "blocked";

export interface TerminalBriefSidecarDefaultOnFinalLiveExecutionOptions {
  now?: string;
  mode?: string;
  finalizer?: string;
  finalizerId?: string;
  checkpointReference?: string;
  checkpoint_reference?: string;
  targetConfigFile?: string;
  target_config_file?: string;
  backupLocation?: string;
  backup_location?: string;
  executionCommand?: string;
  execution_command?: string;
  rollbackCommand?: string;
  rollback_command?: string;
  sidecarApplyCommand?: string;
  sidecar_apply_command?: string;
  healthcheckCommand?: string;
  healthcheck_command?: string;
  executionWindowMinutes?: number;
  execution_window_minutes?: number;
}

export interface TerminalBriefSidecarDefaultOnFinalLiveExecutionPacket {
  kind: "a2a-broker.terminal-brief-sidecar-default-on-final-live-execution.packet";
  version: 1;
  generatedAt: string;
  mode: string;
  state: TerminalBriefSidecarDefaultOnFinalLiveExecutionState;
  dryRunOnly: false;
  sourceOnlyNoLive: true;
  idempotencyKey: string;
  source: {
    runtimeExecutorGateState: TerminalBriefSidecarDefaultOnRuntimeExecutorGatePacket["state"];
    runtimeExecutorGateIdempotencyKey: string;
    runtimeExecutorGateReference: string;
    runtimeExecutorGateReady: boolean;
    requestedAction: string;
    executionRequestReference: string;
    runtimeTarget: string;
    configKey: string;
    proposedValue: string;
    executorId: string;
  };
  finalLiveExecution: {
    reviewOnly: true;
    finalizer: string;
    executionWindowMinutes: number;
    checkpoint: {
      required: true;
      checkpointReference: string;
      targetConfigFile: string;
      backupLocation: string;
      rollbackCommandTemplate: string;
      containsSecretValues: false;
      createsCheckpointInThisPacket: false;
      restoresCheckpointInThisPacket: false;
    };
    executionPlan: {
      commandTemplate: string;
      sidecarApplyCommandTemplate: string;
      healthcheckCommandTemplate: string;
      targetConfigFile: string;
      configKey: string;
      proposedValue: string;
      executorId: string;
      requiresOperatorShell: true;
      containsSecretValues: false;
      executesInThisPacket: false;
    };
    abortConditions: string[];
    requiresFreshOperatorApprovalForMutation: true;
  };
  readiness: {
    sourceCriteriaMet: boolean;
    finalLiveExecutionReviewReady: boolean;
    approvalRequestDispatchPermitted: false;
    approvalGrantPermitted: false;
    approvalGrantExecutionPermitted: false;
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
    checkpointCreationPermitted: false;
    rollbackExecutionPermitted: false;
    missingEvidence: string[];
    blockers: string[];
    nextAction: string;
  };
  blockers: string[];
  nextActions: string[];
  approvalSensitiveActionsExcluded: string[];
  integrationContract: {
    transport: "json";
    finalLiveExecutionPacketVersion: 1;
    harnessNeutral: true;
    openclawMessageSendRequired: false;
    hermesAdapterCompatible: true;
    mobilealphaAdapterCompatible: true;
    externalHarnessCompatible: true;
    consumesRuntimeExecutorGatePacket: true;
    rendersFinalLiveExecutionPacket: true;
    rendersRollbackCheckpoint: true;
    sendsApprovalRequest: false;
    grantsApproval: false;
    executesApprovalGrant: false;
    writesConfig: false;
    enablesDefaultOn: false;
    createsCheckpoint: false;
    executesRollback: false;
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
    finalLiveExecutionPacketOnly: true;
    sourceOnlyNoLive: true;
    acceptedGateDoesNotAuthorizeRuntime: true;
    packetDoesNotWriteConfig: true;
    packetDoesNotEnableDefaultOn: true;
    packetDoesNotStartOrRestartSidecar: true;
    packetDoesNotDispatchExecutor: true;
    packetDoesNotInvokeExecutor: true;
    packetDoesNotSpawnProcess: true;
    packetDoesNotCreateCheckpoint: true;
    packetDoesNotExecuteRollback: true;
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

export function buildTerminalBriefSidecarDefaultOnFinalLiveExecution(
  gate: TerminalBriefSidecarDefaultOnRuntimeExecutorGatePacket,
  options: TerminalBriefSidecarDefaultOnFinalLiveExecutionOptions = {},
): TerminalBriefSidecarDefaultOnFinalLiveExecutionPacket {
  const generatedAt = options.now ?? new Date().toISOString();
  const blockers = sourceBlockers(gate);
  const state = stateFor(gate, blockers);
  const ready = state === "ready_for_final_live_execution_review";
  const checkpointReference = options.checkpointReference
    ?? options.checkpoint_reference
    ?? buildCheckpointReference(gate);
  const targetConfigFile = options.targetConfigFile
    ?? options.target_config_file
    ?? "/root/.openclaw/a2a-broker/terminal-brief-sidecar.env";
  const backupLocation = options.backupLocation
    ?? options.backup_location
    ?? "${targetConfigFile}.pre-default-on.${timestamp}.bak";
  const executionCommand = options.executionCommand
    ?? options.execution_command
    ?? "set TERMINAL_BRIEF_SIDECAR_DEFAULT_ON=true in the approved target config file";
  const rollbackCommand = options.rollbackCommand
    ?? options.rollback_command
    ?? "restore the checkpoint backup to the approved target config file";
  const sidecarApplyCommand = options.sidecarApplyCommand
    ?? options.sidecar_apply_command
    ?? "restart only the approved Terminal Brief sidecar runtime if required by the final operator window";
  const healthcheckCommand = options.healthcheckCommand
    ?? options.healthcheck_command
    ?? "verify broker /livez, sidecar health, and no provider send or terminal ACK occurred";
  const executionWindowMinutes = Math.max(1, Math.floor(options.executionWindowMinutes ?? options.execution_window_minutes ?? 10));

  return {
    kind: "a2a-broker.terminal-brief-sidecar-default-on-final-live-execution.packet",
    version: 1,
    generatedAt,
    mode: options.mode ?? gate.mode,
    state,
    dryRunOnly: false,
    sourceOnlyNoLive: true,
    idempotencyKey: buildIdempotencyKey(gate, checkpointReference, generatedAt, state),
    source: {
      runtimeExecutorGateState: gate.state,
      runtimeExecutorGateIdempotencyKey: gate.idempotencyKey,
      runtimeExecutorGateReference: gate.executorGate.runtimeExecutorGateReference,
      runtimeExecutorGateReady: gate.readiness.runtimeExecutorGateReady,
      requestedAction: gate.source.requestedAction,
      executionRequestReference: gate.source.executionRequestReference,
      runtimeTarget: gate.source.runtimeTarget,
      configKey: gate.source.configKey,
      proposedValue: gate.source.proposedValue,
      executorId: gate.source.executorId,
    },
    finalLiveExecution: {
      reviewOnly: true,
      finalizer: options.finalizer ?? options.finalizerId ?? "broker-finalizer",
      executionWindowMinutes,
      checkpoint: {
        required: true,
        checkpointReference,
        targetConfigFile,
        backupLocation,
        rollbackCommandTemplate: rollbackCommand,
        containsSecretValues: false,
        createsCheckpointInThisPacket: false,
        restoresCheckpointInThisPacket: false,
      },
      executionPlan: {
        commandTemplate: executionCommand,
        sidecarApplyCommandTemplate: sidecarApplyCommand,
        healthcheckCommandTemplate: healthcheckCommand,
        targetConfigFile,
        configKey: gate.source.configKey,
        proposedValue: gate.source.proposedValue,
        executorId: gate.source.executorId,
        requiresOperatorShell: true,
        containsSecretValues: false,
        executesInThisPacket: false,
      },
      abortConditions: [
        "runtime executor gate is missing, stale, conflicting, rejected, or blocked",
        "checkpoint target, backup location, rollback command, or healthcheck command is missing",
        "target config file identity does not match the final operator-approved runtime",
        "Gateway readiness or event-loop health is degraded",
        "broker or sidecar health is not known-good immediately before the execution window",
        "operator asks to combine provider send, terminal ACK/replay, DB mutation, or release with this execution",
        "secret values are required in the packet, logs, issue comments, or Wiki",
      ],
      requiresFreshOperatorApprovalForMutation: true,
    },
    readiness: {
      sourceCriteriaMet: ready,
      finalLiveExecutionReviewReady: ready,
      approvalRequestDispatchPermitted: false,
      approvalGrantPermitted: false,
      approvalGrantExecutionPermitted: false,
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
      checkpointCreationPermitted: false,
      rollbackExecutionPermitted: false,
      missingEvidence: missingEvidence(gate),
      blockers: [
        ...blockers,
        "final live execution packet is source-only and does not execute default-on",
        "runtime mutation still requires a separate fresh operator execution window",
      ],
      nextAction: nextActionFor(state),
    },
    blockers,
    nextActions: nextActionsFor(state),
    approvalSensitiveActionsExcluded: approvalSensitiveActionsExcluded(),
    integrationContract: {
      transport: "json",
      finalLiveExecutionPacketVersion: 1,
      harnessNeutral: true,
      openclawMessageSendRequired: false,
      hermesAdapterCompatible: true,
      mobilealphaAdapterCompatible: true,
      externalHarnessCompatible: true,
      consumesRuntimeExecutorGatePacket: true,
      rendersFinalLiveExecutionPacket: true,
      rendersRollbackCheckpoint: true,
      sendsApprovalRequest: false,
      grantsApproval: false,
      executesApprovalGrant: false,
      writesConfig: false,
      enablesDefaultOn: false,
      createsCheckpoint: false,
      executesRollback: false,
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
      finalLiveExecutionPacketOnly: true,
      sourceOnlyNoLive: true,
      acceptedGateDoesNotAuthorizeRuntime: true,
      packetDoesNotWriteConfig: true,
      packetDoesNotEnableDefaultOn: true,
      packetDoesNotStartOrRestartSidecar: true,
      packetDoesNotDispatchExecutor: true,
      packetDoesNotInvokeExecutor: true,
      packetDoesNotSpawnProcess: true,
      packetDoesNotCreateCheckpoint: true,
      packetDoesNotExecuteRollback: true,
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

export function extractTerminalBriefSidecarDefaultOnFinalLiveExecutionGate(
  input: unknown,
): TerminalBriefSidecarDefaultOnRuntimeExecutorGatePacket {
  const envelope = isRecord(input) ? input : {};
  const candidates = [
    input,
    envelope.defaultOnRuntimeExecutorGatePacket,
    envelope.runtimeExecutorGatePacket,
    envelope.runtimeExecutorGate,
    envelope.packet,
  ];
  const packet = candidates.find(isRuntimeExecutorGatePacket);
  if (!packet) throw new Error("expected a Terminal Brief sidecar default-on runtime executor gate packet");
  return packet;
}

export function extractTerminalBriefSidecarDefaultOnFinalLiveExecutionOptions(
  input: unknown,
): TerminalBriefSidecarDefaultOnFinalLiveExecutionOptions {
  const envelope = isRecord(input) ? input : {};
  const options = isRecord(envelope.defaultOnFinalLiveExecution)
    ? envelope.defaultOnFinalLiveExecution
    : isRecord(envelope.finalLiveExecution)
      ? envelope.finalLiveExecution
      : isRecord(envelope.options)
        ? envelope.options
        : {};
  return options as TerminalBriefSidecarDefaultOnFinalLiveExecutionOptions;
}

export function renderTerminalBriefSidecarDefaultOnFinalLiveExecutionMarkdown(
  packet: TerminalBriefSidecarDefaultOnFinalLiveExecutionPacket,
): string {
  return [
    titleForState(packet.state),
    "Mode: " + packet.mode,
    "State: " + packet.state + " sourceOnlyNoLive=" + packet.sourceOnlyNoLive,
    "Idempotency: " + packet.idempotencyKey,
    "Source gate: state=" + packet.source.runtimeExecutorGateState
      + " ready=" + packet.source.runtimeExecutorGateReady
      + " reference=" + packet.source.runtimeExecutorGateReference,
    "Target: " + packet.finalLiveExecution.executionPlan.targetConfigFile
      + " " + packet.source.configKey + "=" + packet.source.proposedValue
      + " executorId=" + packet.source.executorId,
    "Checkpoint: reference=" + packet.finalLiveExecution.checkpoint.checkpointReference
      + " backupLocation=" + packet.finalLiveExecution.checkpoint.backupLocation
      + " createsCheckpointInThisPacket=" + packet.finalLiveExecution.checkpoint.createsCheckpointInThisPacket,
    "Readiness: configWritePermitted=" + packet.readiness.configWritePermitted
      + " defaultOnPermitted=" + packet.readiness.defaultOnPermitted
      + " sidecarRestartPermitted=" + packet.readiness.sidecarRestartPermitted
      + " startExecutorDispatchPermitted=" + packet.readiness.startExecutorDispatchPermitted
      + " executorInvocationPermitted=" + packet.readiness.executorInvocationPermitted
      + " executionPermitted=" + packet.readiness.executionPermitted
      + " processSpawnPermitted=" + packet.readiness.processSpawnPermitted
      + " checkpointCreationPermitted=" + packet.readiness.checkpointCreationPermitted
      + " rollbackExecutionPermitted=" + packet.readiness.rollbackExecutionPermitted,
    ...(packet.blockers.length ? ["", "Blockers:", ...packet.blockers.map((blocker) => "- " + blocker)] : []),
    "",
    "Next actions:",
    ...packet.nextActions.map((action) => "- " + action),
    "",
    "Safety: final live execution packet only; review data does not write config, enable default-on, create/restore checkpoint, start/restart sidecar, dispatch/invoke executor, spawn a process, send providers, ACK/replay terminal rows, mutate GitHub/DB/TaskFlow state, restart Gateway/broker, release, publish, or move secrets.",
  ].join("\n");
}

function sourceBlockers(gate: TerminalBriefSidecarDefaultOnRuntimeExecutorGatePacket): string[] {
  return unique([
    ...gate.blockers,
    ...(gate.state !== "ready_for_runtime_executor_review" ? ["runtime executor gate state is " + gate.state] : []),
    ...(!gate.readiness.runtimeExecutorGateReady ? ["runtime executor gate is not ready"] : []),
    ...(gate.sourceOnlyNoLive !== true ? ["runtime executor gate is not source-only no-live"] : []),
    ...(gate.readiness.runtimeMutationPermitted !== false ? ["gate unexpectedly permits runtime mutation"] : []),
    ...(gate.readiness.configWritePermitted !== false ? ["gate unexpectedly permits config write"] : []),
    ...(gate.readiness.defaultOnPermitted !== false ? ["gate unexpectedly permits default-on"] : []),
    ...(gate.readiness.sidecarRestartPermitted !== false ? ["gate unexpectedly permits sidecar restart"] : []),
    ...(gate.readiness.providerSendPermitted !== false ? ["gate unexpectedly permits provider send"] : []),
    ...(gate.readiness.terminalAckPermitted !== false ? ["gate unexpectedly permits terminal ACK"] : []),
    ...(gate.readiness.dbMutationPermitted !== false ? ["gate unexpectedly permits DB mutation"] : []),
    ...(gate.readiness.taskFlowMutationPermitted !== false ? ["gate unexpectedly permits TaskFlow mutation"] : []),
    ...(gate.readiness.startExecutorDispatchPermitted !== false ? ["gate unexpectedly permits start executor dispatch"] : []),
    ...(gate.readiness.executorInvocationPermitted !== false ? ["gate unexpectedly permits executor invocation"] : []),
    ...(gate.readiness.executionPermitted !== false ? ["gate unexpectedly permits execution"] : []),
    ...(gate.readiness.processSpawnPermitted !== false ? ["gate unexpectedly permits process spawn"] : []),
    ...(gate.readiness.sidecarStartPermitted !== false ? ["gate unexpectedly permits sidecar start"] : []),
    ...(gate.readiness.brokerRestartPermitted !== false ? ["gate unexpectedly permits broker restart"] : []),
    ...(gate.readiness.gatewayRestartPermitted !== false ? ["gate unexpectedly permits gateway restart"] : []),
    ...(gate.integrationContract.writesConfig ? ["gate unexpectedly writes config"] : []),
    ...(gate.integrationContract.enablesDefaultOn ? ["gate unexpectedly enables default-on"] : []),
    ...(gate.integrationContract.dispatchesStartExecutor ? ["gate unexpectedly dispatches start executor"] : []),
    ...(gate.integrationContract.invokesExecutor ? ["gate unexpectedly invokes executor"] : []),
    ...(gate.integrationContract.spawnsProcess ? ["gate unexpectedly spawns process"] : []),
    ...(gate.integrationContract.startsSidecar ? ["gate unexpectedly starts sidecar"] : []),
    ...(gate.integrationContract.restartsSidecar ? ["gate unexpectedly restarts sidecar"] : []),
    ...(gate.integrationContract.executesAction ? ["gate unexpectedly executes action"] : []),
    ...(gate.semantics.executorGateDoesNotWriteConfig !== true ? ["gate does not preserve config boundary"] : []),
    ...(gate.semantics.executorGateDoesNotEnableDefaultOn !== true ? ["gate does not preserve default-on boundary"] : []),
    ...(gate.semantics.executorGateDoesNotRestartSidecar !== true ? ["gate does not preserve sidecar restart boundary"] : []),
    ...(gate.semantics.executorGateDoesNotDispatchExecutor !== true ? ["gate does not preserve executor dispatch boundary"] : []),
    ...(gate.semantics.executorGateDoesNotInvokeExecutor !== true ? ["gate does not preserve executor invocation boundary"] : []),
  ].filter(Boolean));
}

function stateFor(
  gate: TerminalBriefSidecarDefaultOnRuntimeExecutorGatePacket,
  blockers: string[],
): TerminalBriefSidecarDefaultOnFinalLiveExecutionState {
  if (gate.state === "approval_rejected") return "approval_rejected";
  if (gate.state === "stale") return "stale";
  if (gate.state === "conflicting") return "conflicting";
  if (gate.state !== "ready_for_runtime_executor_review") return "waiting_for_runtime_executor_gate";
  if (blockers.length) return "blocked";
  return "ready_for_final_live_execution_review";
}

function missingEvidence(gate: TerminalBriefSidecarDefaultOnRuntimeExecutorGatePacket): string[] {
  return unique([
    ...(gate.state !== "ready_for_runtime_executor_review" ? ["ready_runtime_executor_gate"] : []),
    ...(!gate.readiness.runtimeExecutorGateReady ? ["runtime_executor_gate_ready"] : []),
  ]);
}

function nextActionFor(state: TerminalBriefSidecarDefaultOnFinalLiveExecutionState): string {
  if (state === "ready_for_final_live_execution_review") return "broker finalizer may review this source-only final live execution packet before requesting a fresh operator execution window";
  if (state === "approval_rejected") return "stop this default-on execution path unless a new operator approval is requested";
  if (state === "stale") return "refresh runtime executor gate evidence before final live execution review";
  if (state === "conflicting") return "resolve conflicting runtime executor gate evidence before final live execution review";
  if (state === "waiting_for_runtime_executor_gate") return "wait for a ready source-only runtime executor gate";
  return "resolve blocked runtime executor gate evidence before final live execution review";
}

function nextActionsFor(state: TerminalBriefSidecarDefaultOnFinalLiveExecutionState): string[] {
  return [
    nextActionFor(state),
    "do not write config, enable default-on, create/restore checkpoint, restart sidecar, dispatch/invoke executor, spawn process, send provider, ACK terminal rows, or mutate state from this packet",
  ];
}

function approvalSensitiveActionsExcluded(): string[] {
  return [
    "approval request dispatch or approval grant execution",
    "checkpoint creation or rollback execution",
    "runtime config write",
    "Terminal Brief default-on enablement",
    "Terminal Brief sidecar start/restart",
    "live provider/Hermes/mobilealpha/Telegram/OpenClaw send",
    "terminal ACK/replay or terminal receipt DB mutation",
    "start executor dispatch, executor invocation, or process spawn",
    "GitHub PR merge, issue close, or comment post from the packet/route",
    "TaskFlow record creation or broker DB mutation",
    "Gateway/broker restart, production deploy, historical replay, release, publish, or secret movement",
  ];
}

function buildCheckpointReference(gate: TerminalBriefSidecarDefaultOnRuntimeExecutorGatePacket): string {
  return "tb-sidecar-default-on-final-live-execution-checkpoint:" + createHash("sha256").update(gate.idempotencyKey).digest("hex").slice(0, 16);
}

function buildIdempotencyKey(
  gate: TerminalBriefSidecarDefaultOnRuntimeExecutorGatePacket,
  checkpointReference: string,
  generatedAt: string,
  state: TerminalBriefSidecarDefaultOnFinalLiveExecutionState,
): string {
  const base = JSON.stringify({
    label: "terminal-brief-sidecar-default-on-final-live-execution",
    gate: gate.idempotencyKey,
    checkpointReference,
    generatedAt,
    state,
  });
  return "tb-sidecar-default-on-final-live-execution:" + createHash("sha256").update(base).digest("hex").slice(0, 24);
}

function titleForState(state: TerminalBriefSidecarDefaultOnFinalLiveExecutionState): string {
  if (state === "ready_for_final_live_execution_review") return "Ready: Terminal Brief default-on final live execution packet";
  if (state === "approval_rejected") return "Rejected: Terminal Brief default-on final live execution packet";
  if (state === "stale") return "Stale: Terminal Brief default-on final live execution packet";
  if (state === "conflicting") return "Conflicting: Terminal Brief default-on final live execution packet";
  if (state === "waiting_for_runtime_executor_gate") return "Waiting: Terminal Brief default-on final live execution packet";
  return "Blocked: Terminal Brief default-on final live execution packet";
}

function isRuntimeExecutorGatePacket(value: unknown): value is TerminalBriefSidecarDefaultOnRuntimeExecutorGatePacket {
  return isRecord(value) && value.kind === "a2a-broker.terminal-brief-sidecar-default-on-runtime-executor-gate.packet";
}
