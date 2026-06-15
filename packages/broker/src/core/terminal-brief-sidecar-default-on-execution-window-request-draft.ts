import { unique } from "./collections.js";
import { isRecord } from "./value-guards.js";
import { createHash } from "node:crypto";

import type { TerminalBriefSidecarDefaultOnFinalLiveExecutionPacket } from "./terminal-brief-sidecar-default-on-final-live-execution.js";

export type TerminalBriefSidecarDefaultOnExecutionWindowRequestDraftState =
  | "execution_window_request_draft_ready"
  | "waiting_for_final_live_execution_review"
  | "approval_rejected"
  | "stale"
  | "conflicting"
  | "blocked";

export interface TerminalBriefSidecarDefaultOnExecutionWindowRequestDraftOptions {
  now?: string;
  mode?: string;
  requestedAction?: string;
  requested_action?: string;
  requestedBy?: string;
  requested_by?: string;
  operatorTarget?: string;
  operator_target?: string;
  operatorChannel?: string;
  operator_channel?: string;
  executionWindowReference?: string;
  execution_window_reference?: string;
  approvalWindowMinutes?: number;
  approval_window_minutes?: number;
  finalizer?: string;
  finalizerId?: string;
}

export interface TerminalBriefSidecarDefaultOnExecutionWindowRequestDraftPacket {
  kind: "a2a-broker.terminal-brief-sidecar-default-on-execution-window-request-draft.packet";
  version: 1;
  generatedAt: string;
  mode: string;
  state: TerminalBriefSidecarDefaultOnExecutionWindowRequestDraftState;
  dryRunOnly: false;
  sourceOnlyNoLive: true;
  idempotencyKey: string;
  source: {
    finalLiveExecutionKind: TerminalBriefSidecarDefaultOnFinalLiveExecutionPacket["kind"];
    finalLiveExecutionState: TerminalBriefSidecarDefaultOnFinalLiveExecutionPacket["state"];
    finalLiveExecutionIdempotencyKey: string;
    finalLiveExecutionReviewReady: boolean;
    checkpointReference: string;
    targetConfigFile: string;
    backupLocation: string;
    requestedRuntimeAction: string;
    runtimeTarget: string;
    configKey: string;
    proposedValue: string;
    executorId: string;
    finalizer: string;
    executionWindowMinutes: number;
  };
  executionWindowRequestDraft: {
    draftOnly: true;
    status: "draft_not_sent" | "not_ready";
    requestedAction: string;
    requestedBy: string;
    operatorTarget: string;
    operatorChannel?: string;
    executionWindowReference: string;
    approvalExpiresAt?: string;
    dispatchRequired: boolean;
    dispatchPermitted: false;
    approvalGrantPermitted: false;
    approvalGrantExecutionPermitted: false;
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
    transcriptDraft: string;
    requiredReply: string;
  };
  executionWindowBoundary: {
    requestDraftOnly: true;
    sourcePacketIds: string[];
    finalizerRequired: true;
    separateOperatorApprovalRequired: true;
    separateRuntimeMutationRequired: true;
    separateCheckpointRequired: true;
    approvalCanBeRequestedBy: string;
    approvalCanBeDeliveredBy: Array<"openclaw" | "hermes" | "gongyung" | "external">;
    forbiddenFromThisPacket: string[];
  };
  readiness: {
    sourceCriteriaMet: boolean;
    executionWindowRequestDraftReady: boolean;
    executionWindowRequestDispatchPermitted: false;
    approvalGrantPermitted: false;
    approvalGrantExecutionPermitted: false;
    checkpointCreationPermitted: false;
    rollbackExecutionPermitted: false;
    runtimeMutationPermitted: false;
    configWritePermitted: false;
    defaultOnPermitted: false;
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
    sidecarRestartPermitted: false;
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
    executionWindowRequestDraftVersion: 1;
    consumesFinalLiveExecutionPacket: true;
    rendersExecutionWindowRequestDraft: true;
    sendsExecutionWindowRequest: false;
    grantsApproval: false;
    executesApprovalGrant: false;
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
    executionWindowRequestDraftOnly: true;
    sourceOnlyNoLive: true;
    requestDraftIsNotSend: true;
    requestDoesNotGrantApproval: true;
    requestDoesNotCreateCheckpoint: true;
    requestDoesNotExecuteRollback: true;
    requestDoesNotExecuteRuntimeMutation: true;
    requestDoesNotWriteConfig: true;
    requestDoesNotEnableDefaultOn: true;
    requestDoesNotRestartSidecar: true;
    requestDoesNotDispatchExecutor: true;
    requestDoesNotInvokeExecutor: true;
    providerAcceptedIsVisibilityProof: false;
    approvalGrantEvidenceExecutesGrant: false;
    defaultOnNotEnabledByThisPacket: true;
    executionNotPermitted: true;
    processSpawnNotPermitted: true;
    sidecarStartNotPermitted: true;
    sidecarRestartNotPermitted: true;
    brokerRestartNotPermitted: true;
    gatewayRestartNotPermitted: true;
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

export function buildTerminalBriefSidecarDefaultOnExecutionWindowRequestDraft(
  finalLiveExecution: TerminalBriefSidecarDefaultOnFinalLiveExecutionPacket,
  options: TerminalBriefSidecarDefaultOnExecutionWindowRequestDraftOptions = {},
): TerminalBriefSidecarDefaultOnExecutionWindowRequestDraftPacket {
  const generatedAt = options.now ?? new Date().toISOString();
  const blockers = sourceBlockers(finalLiveExecution);
  const state = stateFor(finalLiveExecution, blockers);
  const ready = state === "execution_window_request_draft_ready";
  const requestedBy = optionalString(options.requestedBy ?? options.requested_by)
    ?? optionalString(options.finalizer ?? options.finalizerId)
    ?? finalLiveExecution.finalLiveExecution.finalizer
    ?? "broker-finalizer";
  const operatorTarget = optionalString(options.operatorTarget ?? options.operator_target)
    ?? "terminal-brief-default-on-execution-window";
  const operatorChannel = optionalString(options.operatorChannel ?? options.operator_channel);
  const requestedAction = optionalString(options.requestedAction ?? options.requested_action)
    ?? "request_terminal_brief_default_on_fresh_operator_execution_window";
  const executionWindowReference = optionalString(options.executionWindowReference ?? options.execution_window_reference)
    ?? buildExecutionWindowReference(finalLiveExecution);
  const approvalExpiresAt = approvalExpiry(generatedAt, options);
  const requiredReply = "fresh operator execution window 승인";
  const transcriptDraft = buildTranscriptDraft(
    finalLiveExecution,
    requestedAction,
    requestedBy,
    operatorTarget,
    executionWindowReference,
    requiredReply,
    approvalExpiresAt,
    ready,
  );

  return {
    kind: "a2a-broker.terminal-brief-sidecar-default-on-execution-window-request-draft.packet",
    version: 1,
    generatedAt,
    mode: options.mode ?? "terminal-brief-default-on-execution-window-request-draft-source-only",
    state,
    dryRunOnly: false,
    sourceOnlyNoLive: true,
    idempotencyKey: buildIdempotencyKey(finalLiveExecution, generatedAt, requestedAction, requestedBy, operatorTarget, state),
    source: {
      finalLiveExecutionKind: finalLiveExecution.kind,
      finalLiveExecutionState: finalLiveExecution.state,
      finalLiveExecutionIdempotencyKey: finalLiveExecution.idempotencyKey,
      finalLiveExecutionReviewReady: finalLiveExecution.readiness.finalLiveExecutionReviewReady,
      checkpointReference: finalLiveExecution.finalLiveExecution.checkpoint.checkpointReference,
      targetConfigFile: finalLiveExecution.finalLiveExecution.executionPlan.targetConfigFile,
      backupLocation: finalLiveExecution.finalLiveExecution.checkpoint.backupLocation,
      requestedRuntimeAction: finalLiveExecution.source.requestedAction,
      runtimeTarget: finalLiveExecution.source.runtimeTarget,
      configKey: finalLiveExecution.source.configKey,
      proposedValue: finalLiveExecution.source.proposedValue,
      executorId: finalLiveExecution.source.executorId,
      finalizer: finalLiveExecution.finalLiveExecution.finalizer,
      executionWindowMinutes: finalLiveExecution.finalLiveExecution.executionWindowMinutes,
    },
    executionWindowRequestDraft: {
      draftOnly: true,
      status: ready ? "draft_not_sent" : "not_ready",
      requestedAction,
      requestedBy,
      operatorTarget,
      operatorChannel,
      executionWindowReference,
      approvalExpiresAt,
      dispatchRequired: ready,
      dispatchPermitted: false,
      approvalGrantPermitted: false,
      approvalGrantExecutionPermitted: false,
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
      transcriptDraft,
      requiredReply,
    },
    executionWindowBoundary: {
      requestDraftOnly: true,
      sourcePacketIds: [finalLiveExecution.idempotencyKey, finalLiveExecution.source.runtimeExecutorGateIdempotencyKey],
      finalizerRequired: true,
      separateOperatorApprovalRequired: true,
      separateRuntimeMutationRequired: true,
      separateCheckpointRequired: true,
      approvalCanBeRequestedBy: requestedBy,
      approvalCanBeDeliveredBy: ["openclaw", "hermes", "gongyung", "external"],
      forbiddenFromThisPacket: approvalSensitiveActionsExcluded(),
    },
    readiness: {
      sourceCriteriaMet: ready,
      executionWindowRequestDraftReady: ready,
      executionWindowRequestDispatchPermitted: false,
      approvalGrantPermitted: false,
      approvalGrantExecutionPermitted: false,
      checkpointCreationPermitted: false,
      rollbackExecutionPermitted: false,
      runtimeMutationPermitted: false,
      configWritePermitted: false,
      defaultOnPermitted: false,
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
      sidecarRestartPermitted: false,
      brokerRestartPermitted: false,
      gatewayRestartPermitted: false,
      missingEvidence: missingEvidence(finalLiveExecution),
      blockers: [
        ...blockers,
        "execution window request draft is source-only and is not sent by this packet",
        "checkpoint creation, config write, default-on enablement, and sidecar apply require a later explicit runtime execution window",
      ],
      nextAction: nextActionFor(state),
    },
    blockers,
    nextActions: nextActionsFor(state),
    approvalSensitiveActionsExcluded: approvalSensitiveActionsExcluded(),
    integrationContract: {
      transport: "json",
      executionWindowRequestDraftVersion: 1,
      consumesFinalLiveExecutionPacket: true,
      rendersExecutionWindowRequestDraft: true,
      sendsExecutionWindowRequest: false,
      grantsApproval: false,
      executesApprovalGrant: false,
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
      executionWindowRequestDraftOnly: true,
      sourceOnlyNoLive: true,
      requestDraftIsNotSend: true,
      requestDoesNotGrantApproval: true,
      requestDoesNotCreateCheckpoint: true,
      requestDoesNotExecuteRollback: true,
      requestDoesNotExecuteRuntimeMutation: true,
      requestDoesNotWriteConfig: true,
      requestDoesNotEnableDefaultOn: true,
      requestDoesNotRestartSidecar: true,
      requestDoesNotDispatchExecutor: true,
      requestDoesNotInvokeExecutor: true,
      providerAcceptedIsVisibilityProof: false,
      approvalGrantEvidenceExecutesGrant: false,
      defaultOnNotEnabledByThisPacket: true,
      executionNotPermitted: true,
      processSpawnNotPermitted: true,
      sidecarStartNotPermitted: true,
      sidecarRestartNotPermitted: true,
      brokerRestartNotPermitted: true,
      gatewayRestartNotPermitted: true,
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

export function extractTerminalBriefSidecarDefaultOnExecutionWindowRequestDraftFinalLiveExecution(
  input: unknown,
): TerminalBriefSidecarDefaultOnFinalLiveExecutionPacket {
  const envelope = isRecord(input) ? input : {};
  const candidates = [
    input,
    envelope.defaultOnFinalLiveExecutionPacket,
    envelope.finalLiveExecutionPacket,
    envelope.finalLiveExecution,
    envelope.packet,
  ];
  const packet = candidates.find(isFinalLiveExecutionPacket);
  if (!packet) throw new Error("expected a Terminal Brief sidecar default-on final live execution packet");
  return packet;
}

export function extractTerminalBriefSidecarDefaultOnExecutionWindowRequestDraftOptions(
  input: unknown,
): TerminalBriefSidecarDefaultOnExecutionWindowRequestDraftOptions {
  const envelope = isRecord(input) ? input : {};
  const options = isRecord(envelope.defaultOnExecutionWindowRequestDraft)
    ? envelope.defaultOnExecutionWindowRequestDraft
    : isRecord(envelope.executionWindowRequestDraft)
      ? envelope.executionWindowRequestDraft
      : isRecord(envelope.options)
        ? envelope.options
        : {};
  return options as TerminalBriefSidecarDefaultOnExecutionWindowRequestDraftOptions;
}

export function renderTerminalBriefSidecarDefaultOnExecutionWindowRequestDraftMarkdown(
  packet: TerminalBriefSidecarDefaultOnExecutionWindowRequestDraftPacket,
): string {
  return [
    titleForState(packet.state),
    "Mode: " + packet.mode,
    "State: " + packet.state + " sourceOnlyNoLive=" + packet.sourceOnlyNoLive,
    "Idempotency: " + packet.idempotencyKey,
    "Final live execution: state=" + packet.source.finalLiveExecutionState
      + " ready=" + packet.source.finalLiveExecutionReviewReady
      + " checkpoint=" + packet.source.checkpointReference,
    "Runtime target: " + packet.source.runtimeTarget
      + " configKey=" + packet.source.configKey
      + " proposedValue=" + packet.source.proposedValue
      + " executorId=" + packet.source.executorId,
    "Request draft: reference=" + packet.executionWindowRequestDraft.executionWindowReference
      + " status=" + packet.executionWindowRequestDraft.status
      + " dispatchPermitted=" + packet.executionWindowRequestDraft.dispatchPermitted
      + " requiredReply=\"" + packet.executionWindowRequestDraft.requiredReply + "\"",
    "Readiness: configWritePermitted=" + packet.readiness.configWritePermitted
      + " defaultOnPermitted=" + packet.readiness.defaultOnPermitted
      + " sidecarRestartPermitted=" + packet.readiness.sidecarRestartPermitted
      + " checkpointCreationPermitted=" + packet.readiness.checkpointCreationPermitted
      + " startExecutorDispatchPermitted=" + packet.readiness.startExecutorDispatchPermitted
      + " executorInvocationPermitted=" + packet.readiness.executorInvocationPermitted
      + " executionPermitted=" + packet.readiness.executionPermitted
      + " processSpawnPermitted=" + packet.readiness.processSpawnPermitted,
    "",
    "Transcript draft:",
    packet.executionWindowRequestDraft.transcriptDraft,
    ...(packet.blockers.length ? ["", "Blockers:", ...packet.blockers.map((blocker) => "- " + blocker)] : []),
    "",
    "Next actions:",
    ...packet.nextActions.map((action) => "- " + action),
    "",
    "Safety: execution window request draft only; does not send the request, grant approval, create checkpoint, execute rollback, write config, enable default-on, restart/apply sidecar, dispatch/invoke executor, spawn a process, send providers, ACK/replay terminal rows, mutate GitHub/DB/TaskFlow state, restart Gateway/broker, release, publish, or move secrets.",
  ].join("\n");
}

function sourceBlockers(finalLiveExecution: TerminalBriefSidecarDefaultOnFinalLiveExecutionPacket): string[] {
  return unique([
    ...finalLiveExecution.blockers,
    ...(finalLiveExecution.state === "approval_rejected" ? ["final live execution packet is rejected"] : []),
    ...(finalLiveExecution.state === "stale" ? ["final live execution packet is stale"] : []),
    ...(finalLiveExecution.state === "conflicting" ? ["final live execution packet is conflicting"] : []),
    ...(finalLiveExecution.state !== "ready_for_final_live_execution_review" && !["approval_rejected", "stale", "conflicting"].includes(finalLiveExecution.state)
      ? ["final live execution packet state is " + finalLiveExecution.state]
      : []),
    ...(!finalLiveExecution.readiness.finalLiveExecutionReviewReady ? ["final live execution review is not ready"] : []),
    ...(finalLiveExecution.sourceOnlyNoLive !== true ? ["final live execution packet is not source-only no-live"] : []),
    ...(finalLiveExecution.finalLiveExecution.reviewOnly !== true ? ["final live execution packet is not review-only"] : []),
    ...(finalLiveExecution.finalLiveExecution.requiresFreshOperatorApprovalForMutation !== true ? ["fresh operator approval is not required"] : []),
    ...(finalLiveExecution.finalLiveExecution.checkpoint.required !== true ? ["checkpoint is not required"] : []),
    ...(finalLiveExecution.finalLiveExecution.checkpoint.createsCheckpointInThisPacket !== false ? ["final packet unexpectedly creates checkpoint"] : []),
    ...(finalLiveExecution.finalLiveExecution.checkpoint.restoresCheckpointInThisPacket !== false ? ["final packet unexpectedly restores checkpoint"] : []),
    ...(finalLiveExecution.finalLiveExecution.executionPlan.executesInThisPacket !== false ? ["final packet unexpectedly executes runtime mutation"] : []),
    ...(finalLiveExecution.readiness.checkpointCreationPermitted !== false ? ["final packet unexpectedly permits checkpoint creation"] : []),
    ...(finalLiveExecution.readiness.rollbackExecutionPermitted !== false ? ["final packet unexpectedly permits rollback execution"] : []),
    ...(finalLiveExecution.readiness.runtimeMutationPermitted !== false ? ["final packet unexpectedly permits runtime mutation"] : []),
    ...(finalLiveExecution.readiness.configWritePermitted !== false ? ["final packet unexpectedly permits config write"] : []),
    ...(finalLiveExecution.readiness.defaultOnPermitted !== false ? ["final packet unexpectedly permits default-on"] : []),
    ...(finalLiveExecution.readiness.sidecarRestartPermitted !== false ? ["final packet unexpectedly permits sidecar restart"] : []),
    ...(finalLiveExecution.readiness.providerSendPermitted !== false ? ["final packet unexpectedly permits provider send"] : []),
    ...(finalLiveExecution.readiness.terminalAckPermitted !== false ? ["final packet unexpectedly permits terminal ACK"] : []),
    ...(finalLiveExecution.readiness.dbMutationPermitted !== false ? ["final packet unexpectedly permits DB mutation"] : []),
    ...(finalLiveExecution.readiness.taskFlowMutationPermitted !== false ? ["final packet unexpectedly permits TaskFlow mutation"] : []),
    ...(finalLiveExecution.readiness.startExecutorDispatchPermitted !== false ? ["final packet unexpectedly permits start executor dispatch"] : []),
    ...(finalLiveExecution.readiness.executorInvocationPermitted !== false ? ["final packet unexpectedly permits executor invocation"] : []),
    ...(finalLiveExecution.readiness.executionPermitted !== false ? ["final packet unexpectedly permits execution"] : []),
    ...(finalLiveExecution.readiness.processSpawnPermitted !== false ? ["final packet unexpectedly permits process spawn"] : []),
    ...(finalLiveExecution.readiness.sidecarStartPermitted !== false ? ["final packet unexpectedly permits sidecar start"] : []),
    ...(finalLiveExecution.readiness.brokerRestartPermitted !== false ? ["final packet unexpectedly permits broker restart"] : []),
    ...(finalLiveExecution.readiness.gatewayRestartPermitted !== false ? ["final packet unexpectedly permits Gateway restart"] : []),
    ...(finalLiveExecution.integrationContract.createsCheckpoint ? ["final packet unexpectedly creates checkpoint"] : []),
    ...(finalLiveExecution.integrationContract.executesRollback ? ["final packet unexpectedly executes rollback"] : []),
    ...(finalLiveExecution.integrationContract.writesConfig ? ["final packet unexpectedly writes config"] : []),
    ...(finalLiveExecution.integrationContract.enablesDefaultOn ? ["final packet unexpectedly enables default-on"] : []),
    ...(finalLiveExecution.integrationContract.dispatchesStartExecutor ? ["final packet unexpectedly dispatches start executor"] : []),
    ...(finalLiveExecution.integrationContract.invokesExecutor ? ["final packet unexpectedly invokes executor"] : []),
    ...(finalLiveExecution.integrationContract.spawnsProcess ? ["final packet unexpectedly spawns process"] : []),
    ...(finalLiveExecution.integrationContract.startsSidecar ? ["final packet unexpectedly starts sidecar"] : []),
    ...(finalLiveExecution.integrationContract.restartsSidecar ? ["final packet unexpectedly restarts sidecar"] : []),
    ...(finalLiveExecution.integrationContract.executesAction ? ["final packet unexpectedly executes action"] : []),
    ...(finalLiveExecution.semantics.packetDoesNotWriteConfig !== true ? ["final packet does not preserve config boundary"] : []),
    ...(finalLiveExecution.semantics.packetDoesNotEnableDefaultOn !== true ? ["final packet does not preserve default-on boundary"] : []),
    ...(finalLiveExecution.semantics.packetDoesNotCreateCheckpoint !== true ? ["final packet does not preserve checkpoint boundary"] : []),
    ...(finalLiveExecution.semantics.packetDoesNotExecuteRollback !== true ? ["final packet does not preserve rollback boundary"] : []),
  ]);
}

function stateFor(
  finalLiveExecution: TerminalBriefSidecarDefaultOnFinalLiveExecutionPacket,
  blockers: string[],
): TerminalBriefSidecarDefaultOnExecutionWindowRequestDraftState {
  if (finalLiveExecution.state === "approval_rejected") return "approval_rejected";
  if (finalLiveExecution.state === "stale") return "stale";
  if (finalLiveExecution.state === "conflicting") return "conflicting";
  if (finalLiveExecution.state !== "ready_for_final_live_execution_review") return "waiting_for_final_live_execution_review";
  if (blockers.length) return "blocked";
  return "execution_window_request_draft_ready";
}

function missingEvidence(finalLiveExecution: TerminalBriefSidecarDefaultOnFinalLiveExecutionPacket): string[] {
  return unique([
    ...(finalLiveExecution.state !== "ready_for_final_live_execution_review" ? ["ready_final_live_execution_packet"] : []),
    ...(!finalLiveExecution.readiness.finalLiveExecutionReviewReady ? ["final_live_execution_review_ready"] : []),
  ]);
}

function nextActionFor(state: TerminalBriefSidecarDefaultOnExecutionWindowRequestDraftState): string {
  if (state === "execution_window_request_draft_ready") return "broker finalizer may review this source-only execution window request draft before separately approved dispatch";
  if (state === "approval_rejected") return "stop this default-on execution window path unless a new operator approval is requested";
  if (state === "stale") return "refresh final live execution packet before drafting execution window request";
  if (state === "conflicting") return "resolve conflicting final live execution evidence before drafting execution window request";
  if (state === "waiting_for_final_live_execution_review") return "wait for a ready final live execution packet";
  return "resolve blocked final live execution evidence before drafting execution window request";
}

function nextActionsFor(state: TerminalBriefSidecarDefaultOnExecutionWindowRequestDraftState): string[] {
  return [
    nextActionFor(state),
    "do not send this request, grant approval, create checkpoint, write config, enable default-on, restart/apply sidecar, dispatch/invoke executor, spawn process, send provider, ACK terminal rows, or mutate state from this packet",
  ];
}

function approvalSensitiveActionsExcluded(): string[] {
  return [
    "sending the execution window request",
    "granting approval or executing an approval grant",
    "checkpoint creation or rollback execution",
    "runtime config write",
    "Terminal Brief default-on enablement",
    "Terminal Brief sidecar start/restart/apply",
    "live provider/Hermes/Gongyung/Telegram/OpenClaw send",
    "terminal ACK/replay or terminal receipt DB mutation",
    "start executor dispatch, executor invocation, or process spawn",
    "GitHub PR merge, issue close, or comment post from the packet/route",
    "TaskFlow record creation or broker DB mutation",
    "Gateway/broker restart, production deploy, historical replay, release, publish, or secret movement",
  ];
}

function buildTranscriptDraft(
  finalLiveExecution: TerminalBriefSidecarDefaultOnFinalLiveExecutionPacket,
  requestedAction: string,
  requestedBy: string,
  operatorTarget: string,
  executionWindowReference: string,
  requiredReply: string,
  approvalExpiresAt: string | undefined,
  ready: boolean,
): string {
  return [
    "Terminal Brief default-on fresh operator execution window request draft",
    "",
    "Status: " + (ready ? "ready to request operator approval" : "not ready"),
    "Requested action: " + requestedAction,
    "Requested by: " + requestedBy,
    "Operator target: " + operatorTarget,
    "Execution window reference: " + executionWindowReference,
    "Final live execution packet: " + finalLiveExecution.idempotencyKey,
    "Checkpoint reference: " + finalLiveExecution.finalLiveExecution.checkpoint.checkpointReference,
    "Target config: " + finalLiveExecution.finalLiveExecution.executionPlan.targetConfigFile,
    "Backup location: " + finalLiveExecution.finalLiveExecution.checkpoint.backupLocation,
    "Runtime target: " + finalLiveExecution.source.runtimeTarget,
    "Config key: " + finalLiveExecution.source.configKey,
    "Proposed value: " + finalLiveExecution.source.proposedValue,
    "Executor id: " + finalLiveExecution.source.executorId,
    "Window minutes: " + finalLiveExecution.finalLiveExecution.executionWindowMinutes,
    ...(approvalExpiresAt ? ["Expires at: " + approvalExpiresAt] : []),
    "",
    "Required reply: " + requiredReply,
    "",
    "This draft does not send the request, grant approval, create a checkpoint, execute rollback, write config, enable default-on, restart/apply the sidecar, dispatch/invoke an executor, spawn a process, send providers, ACK/replay terminal rows, mutate DB/TaskFlow state, restart Gateway/broker, release, publish, or move secrets.",
  ].join("\n");
}

function approvalExpiry(
  generatedAt: string,
  options: TerminalBriefSidecarDefaultOnExecutionWindowRequestDraftOptions,
): string | undefined {
  const minutes = numberOption(options.approvalWindowMinutes ?? options.approval_window_minutes);
  if (!minutes) return undefined;
  const parsed = Date.parse(generatedAt);
  if (!Number.isFinite(parsed)) return undefined;
  return new Date(parsed + minutes * 60_000).toISOString();
}

function numberOption(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function buildExecutionWindowReference(finalLiveExecution: TerminalBriefSidecarDefaultOnFinalLiveExecutionPacket): string {
  return "tb-sidecar-default-on-execution-window:" + createHash("sha256").update(finalLiveExecution.idempotencyKey).digest("hex").slice(0, 16);
}

function buildIdempotencyKey(
  finalLiveExecution: TerminalBriefSidecarDefaultOnFinalLiveExecutionPacket,
  generatedAt: string,
  requestedAction: string,
  requestedBy: string,
  operatorTarget: string,
  state: TerminalBriefSidecarDefaultOnExecutionWindowRequestDraftState,
): string {
  const base = JSON.stringify({
    label: "terminal-brief-sidecar-default-on-execution-window-request-draft",
    finalLiveExecution: finalLiveExecution.idempotencyKey,
    generatedAt,
    requestedAction,
    requestedBy,
    operatorTarget,
    state,
  });
  return "tb-sidecar-default-on-execution-window-request-draft:" + createHash("sha256").update(base).digest("hex").slice(0, 24);
}

function titleForState(state: TerminalBriefSidecarDefaultOnExecutionWindowRequestDraftState): string {
  if (state === "execution_window_request_draft_ready") return "Ready: Terminal Brief default-on execution window request draft";
  if (state === "approval_rejected") return "Rejected: Terminal Brief default-on execution window request draft";
  if (state === "stale") return "Stale: Terminal Brief default-on execution window request draft";
  if (state === "conflicting") return "Conflicting: Terminal Brief default-on execution window request draft";
  if (state === "waiting_for_final_live_execution_review") return "Waiting: Terminal Brief default-on execution window request draft";
  return "Blocked: Terminal Brief default-on execution window request draft";
}

function isFinalLiveExecutionPacket(
  value: unknown,
): value is TerminalBriefSidecarDefaultOnFinalLiveExecutionPacket {
  return isRecord(value) && value.kind === "a2a-broker.terminal-brief-sidecar-default-on-final-live-execution.packet";
}
