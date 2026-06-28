import { unique } from "./collections.js";
import { isRecord } from "./value-guards.js";
import { createHash } from "node:crypto";
import { optionalString } from "./terminal-brief-value-guards.js";

import {
  buildTerminalBriefSidecarDefaultOnRuntimeExecutionFinalGate,
  extractTerminalBriefSidecarDefaultOnRuntimeExecutionFinalGateEvidence,
  extractTerminalBriefSidecarDefaultOnRuntimeExecutionFinalGateOptions,
  type TerminalBriefSidecarDefaultOnRuntimeExecutionFinalGatePacket,
} from "./terminal-brief-sidecar-default-on-runtime-execution-final-gate.js";

export type TerminalBriefSidecarDefaultOnRuntimeExecutionRequestDraftState =
  | "runtime_execution_request_draft_ready"
  | "waiting_for_runtime_execution_final_gate"
  | "approval_rejected"
  | "stale"
  | "conflicting"
  | "blocked";

export interface TerminalBriefSidecarDefaultOnRuntimeExecutionRequestDraftOptions {
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
  executionRequestReference?: string;
  execution_request_reference?: string;
  approvalWindowMinutes?: number;
  approval_window_minutes?: number;
  finalizer?: string;
  finalizerId?: string;
}

export interface TerminalBriefSidecarDefaultOnRuntimeExecutionRequestDraftPacket {
  kind: "a2a-broker.terminal-brief-sidecar-default-on-runtime-execution-request-draft.packet";
  version: 1;
  generatedAt: string;
  mode: string;
  state: TerminalBriefSidecarDefaultOnRuntimeExecutionRequestDraftState;
  dryRunOnly: false;
  sourceOnlyNoLive: true;
  idempotencyKey: string;
  source: {
    runtimeExecutionFinalGateKind: TerminalBriefSidecarDefaultOnRuntimeExecutionFinalGatePacket["kind"];
    runtimeExecutionFinalGateState: TerminalBriefSidecarDefaultOnRuntimeExecutionFinalGatePacket["state"];
    runtimeExecutionFinalGateIdempotencyKey: string;
    runtimeExecutionFinalGateReady: boolean;
    gateReady: boolean;
    executionGateReference: string;
    approvalReference: string;
    priorRequestedAction: string;
    runtimeTarget: string;
    configKey: string;
    proposedValue: string;
    executorId: string;
  };
  executionRequestDraft: {
    draftOnly: true;
    status: "draft_not_sent" | "not_ready";
    requestedAction: string;
    requestedBy: string;
    operatorTarget: string;
    operatorChannel?: string;
    executionRequestReference: string;
    approvalExpiresAt?: string;
    dispatchRequired: boolean;
    dispatchPermitted: false;
    approvalGrantPermitted: false;
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
  runtimeExecutionBoundary: {
    requestDraftOnly: true;
    sourcePacketIds: string[];
    finalizerRequired: true;
    separateOperatorApprovalRequired: true;
    separateRuntimeExecutorRequired: true;
    approvalCanBeRequestedBy: string;
    approvalCanBeDeliveredBy: Array<"openclaw" | "hermes" | "gongyung" | "external">;
    forbiddenFromThisPacket: string[];
  };
  readiness: {
    sourceCriteriaMet: boolean;
    runtimeExecutionRequestDraftReady: boolean;
    runtimeExecutionRequestDispatchPermitted: false;
    approvalGrantPermitted: false;
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
    runtimeExecutionRequestDraftVersion: 1;
    consumesRuntimeExecutionFinalGatePacket: true;
    rendersRuntimeExecutionRequestDraft: true;
    sendsExecutionRequest: false;
    grantsApproval: false;
    executesApprovalGrant: false;
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
    runtimeExecutionRequestDraftOnly: true;
    sourceOnlyNoLive: true;
    requestDraftIsNotSend: true;
    requestDoesNotGrantApproval: true;
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

export function buildTerminalBriefSidecarDefaultOnRuntimeExecutionRequestDraft(
  finalGate: TerminalBriefSidecarDefaultOnRuntimeExecutionFinalGatePacket,
  options: TerminalBriefSidecarDefaultOnRuntimeExecutionRequestDraftOptions = {},
): TerminalBriefSidecarDefaultOnRuntimeExecutionRequestDraftPacket {
  const generatedAt = options.now ?? new Date().toISOString();
  const blockers = sourceBlockers(finalGate);
  const state = stateFor(finalGate, blockers);
  const ready = state === "runtime_execution_request_draft_ready";
  const requestedBy = optionalString(options.requestedBy ?? options.requested_by)
    ?? optionalString(options.finalizer ?? options.finalizerId)
    ?? finalGate.finalGate.finalizer
    ?? "broker-finalizer";
  const operatorTarget = optionalString(options.operatorTarget ?? options.operator_target) ?? "terminal-brief-default-on";
  const operatorChannel = optionalString(options.operatorChannel ?? options.operator_channel);
  const requestedAction = optionalString(options.requestedAction ?? options.requested_action)
    ?? "execute_terminal_brief_default_on_runtime_mutation";
  const executionRequestReference = optionalString(options.executionRequestReference ?? options.execution_request_reference)
    ?? buildExecutionRequestReference(finalGate);
  const approvalExpiresAt = approvalExpiry(generatedAt, options);
  const requiredReply = "execute default-on runtime mutation 승인";
  const transcriptDraft = buildTranscriptDraft(
    finalGate,
    requestedAction,
    requestedBy,
    operatorTarget,
    executionRequestReference,
    requiredReply,
    approvalExpiresAt,
    ready,
  );

  return {
    kind: "a2a-broker.terminal-brief-sidecar-default-on-runtime-execution-request-draft.packet",
    version: 1,
    generatedAt,
    mode: options.mode ?? "terminal-brief-default-on-runtime-execution-request-draft-source-only",
    state,
    dryRunOnly: false,
    sourceOnlyNoLive: true,
    idempotencyKey: buildIdempotencyKey(finalGate, generatedAt, requestedAction, requestedBy, operatorTarget, state),
    source: {
      runtimeExecutionFinalGateKind: finalGate.kind,
      runtimeExecutionFinalGateState: finalGate.state,
      runtimeExecutionFinalGateIdempotencyKey: finalGate.idempotencyKey,
      runtimeExecutionFinalGateReady: finalGate.readiness.runtimeExecutionFinalGateReady,
      gateReady: finalGate.finalGate.gateReady,
      executionGateReference: finalGate.finalGate.executionGateReference,
      approvalReference: finalGate.source.approvalReference,
      priorRequestedAction: finalGate.source.requestedAction,
      runtimeTarget: finalGate.source.runtimeTarget,
      configKey: finalGate.source.configKey,
      proposedValue: finalGate.source.proposedValue,
      executorId: finalGate.source.executorId,
    },
    executionRequestDraft: {
      draftOnly: true,
      status: ready ? "draft_not_sent" : "not_ready",
      requestedAction,
      requestedBy,
      operatorTarget,
      operatorChannel,
      executionRequestReference,
      approvalExpiresAt,
      dispatchRequired: ready,
      dispatchPermitted: false,
      approvalGrantPermitted: false,
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
    runtimeExecutionBoundary: {
      requestDraftOnly: true,
      sourcePacketIds: [finalGate.idempotencyKey, finalGate.source.executionApprovalEvidenceIdempotencyKey],
      finalizerRequired: true,
      separateOperatorApprovalRequired: true,
      separateRuntimeExecutorRequired: true,
      approvalCanBeRequestedBy: requestedBy,
      approvalCanBeDeliveredBy: ["openclaw", "hermes", "gongyung", "external"],
      forbiddenFromThisPacket: approvalSensitiveActionsExcluded(),
    },
    readiness: {
      sourceCriteriaMet: ready,
      runtimeExecutionRequestDraftReady: ready,
      runtimeExecutionRequestDispatchPermitted: false,
      approvalGrantPermitted: false,
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
      missingEvidence: missingEvidence(finalGate),
      blockers: [
        ...blockers,
        "runtime execution request draft is source-only and is not sent by this packet",
        "config write, default-on enablement, and sidecar restart require a later explicit runtime executor",
      ],
      nextAction: nextActionFor(state),
    },
    blockers,
    nextActions: nextActionsFor(state),
    approvalSensitiveActionsExcluded: approvalSensitiveActionsExcluded(),
    integrationContract: {
      transport: "json",
      runtimeExecutionRequestDraftVersion: 1,
      consumesRuntimeExecutionFinalGatePacket: true,
      rendersRuntimeExecutionRequestDraft: true,
      sendsExecutionRequest: false,
      grantsApproval: false,
      executesApprovalGrant: false,
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
      runtimeExecutionRequestDraftOnly: true,
      sourceOnlyNoLive: true,
      requestDraftIsNotSend: true,
      requestDoesNotGrantApproval: true,
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

export function extractTerminalBriefSidecarDefaultOnRuntimeExecutionRequestDraftFinalGate(
  input: unknown,
): TerminalBriefSidecarDefaultOnRuntimeExecutionFinalGatePacket {
  const envelope = isRecord(input) ? input : {};
  const candidates = [
    input,
    envelope.defaultOnRuntimeExecutionFinalGatePacket,
    envelope.runtimeExecutionFinalGatePacket,
    envelope.runtimeExecutionFinalGate,
    envelope.packet,
  ];
  const packet = candidates.find(isRuntimeExecutionFinalGatePacket);
  if (packet) return packet;

  try {
    return buildTerminalBriefSidecarDefaultOnRuntimeExecutionFinalGate(
      extractTerminalBriefSidecarDefaultOnRuntimeExecutionFinalGateEvidence(input),
      extractTerminalBriefSidecarDefaultOnRuntimeExecutionFinalGateOptions(input),
    );
  } catch {
    throw new Error("expected a Terminal Brief sidecar default-on runtime execution final gate packet");
  }
}

export function extractTerminalBriefSidecarDefaultOnRuntimeExecutionRequestDraftOptions(
  input: unknown,
): TerminalBriefSidecarDefaultOnRuntimeExecutionRequestDraftOptions {
  const envelope = isRecord(input) ? input : {};
  const options = isRecord(envelope.defaultOnRuntimeExecutionRequestDraft)
    ? envelope.defaultOnRuntimeExecutionRequestDraft
    : isRecord(envelope.runtimeExecutionRequestDraft)
      ? envelope.runtimeExecutionRequestDraft
      : isRecord(envelope.options)
        ? envelope.options
        : {};
  return options as TerminalBriefSidecarDefaultOnRuntimeExecutionRequestDraftOptions;
}

export function renderTerminalBriefSidecarDefaultOnRuntimeExecutionRequestDraftMarkdown(
  packet: TerminalBriefSidecarDefaultOnRuntimeExecutionRequestDraftPacket,
): string {
  return [
    titleForState(packet.state),
    "Mode: " + packet.mode,
    "State: " + packet.state + " sourceOnlyNoLive=" + packet.sourceOnlyNoLive,
    "Idempotency: " + packet.idempotencyKey,
    "Final gate: state=" + packet.source.runtimeExecutionFinalGateState
      + " gateReady=" + packet.source.gateReady
      + " runtimeExecutionFinalGateReady=" + packet.source.runtimeExecutionFinalGateReady,
    "Runtime target: " + packet.source.runtimeTarget
      + " configKey=" + packet.source.configKey
      + " proposedValue=" + packet.source.proposedValue
      + " executorId=" + packet.source.executorId,
    "Request draft: reference=" + packet.executionRequestDraft.executionRequestReference
      + " status=" + packet.executionRequestDraft.status
      + " dispatchPermitted=" + packet.executionRequestDraft.dispatchPermitted
      + " requiredReply=\"" + packet.executionRequestDraft.requiredReply + "\"",
    "Readiness: configWritePermitted=" + packet.readiness.configWritePermitted
      + " defaultOnPermitted=" + packet.readiness.defaultOnPermitted
      + " sidecarRestartPermitted=" + packet.readiness.sidecarRestartPermitted
      + " startExecutorDispatchPermitted=" + packet.readiness.startExecutorDispatchPermitted
      + " executorInvocationPermitted=" + packet.readiness.executorInvocationPermitted
      + " executionPermitted=" + packet.readiness.executionPermitted
      + " processSpawnPermitted=" + packet.readiness.processSpawnPermitted,
    "",
    "Transcript draft:",
    packet.executionRequestDraft.transcriptDraft,
    ...(packet.blockers.length ? ["", "Blockers:", ...packet.blockers.map((blocker) => "- " + blocker)] : []),
    "",
    "Next actions:",
    ...packet.nextActions.map((action) => "- " + action),
    "",
    "Safety: runtime execution request draft only; does not send the request, grant approval, write config, enable default-on, restart sidecar, dispatch/invoke executor, spawn a process, send providers, ACK/replay terminal rows, mutate GitHub/DB/TaskFlow state, restart Gateway/broker, release, publish, or move secrets.",
  ].join("\n");
}

function sourceBlockers(finalGate: TerminalBriefSidecarDefaultOnRuntimeExecutionFinalGatePacket): string[] {
  return unique([
    ...finalGate.blockers,
    ...(finalGate.state === "approval_rejected" ? ["runtime execution final gate is rejected"] : []),
    ...(finalGate.state === "stale" ? ["runtime execution final gate is stale"] : []),
    ...(finalGate.state === "conflicting" ? ["runtime execution final gate is conflicting"] : []),
    ...(finalGate.state !== "ready_for_runtime_execution_final_review" && !["approval_rejected", "stale", "conflicting"].includes(finalGate.state)
      ? ["runtime execution final gate state is " + finalGate.state]
      : []),
    ...(!finalGate.finalGate.gateReady ? ["runtime execution final gate is not ready"] : []),
    ...(!finalGate.readiness.runtimeExecutionFinalGateReady ? ["runtime execution final gate readiness is false"] : []),
    ...(finalGate.readiness.configWritePermitted !== false ? ["final gate unexpectedly permits config write"] : []),
    ...(finalGate.readiness.defaultOnPermitted !== false ? ["final gate unexpectedly permits default-on"] : []),
    ...(finalGate.readiness.sidecarRestartPermitted !== false ? ["final gate unexpectedly permits sidecar restart"] : []),
    ...(finalGate.readiness.providerSendPermitted !== false ? ["final gate unexpectedly permits provider send"] : []),
    ...(finalGate.readiness.terminalAckPermitted !== false ? ["final gate unexpectedly permits terminal ACK"] : []),
    ...(finalGate.readiness.dbMutationPermitted !== false ? ["final gate unexpectedly permits DB mutation"] : []),
    ...(finalGate.readiness.taskFlowMutationPermitted !== false ? ["final gate unexpectedly permits TaskFlow mutation"] : []),
    ...(finalGate.readiness.startExecutorDispatchPermitted !== false ? ["final gate unexpectedly permits start executor dispatch"] : []),
    ...(finalGate.readiness.executorInvocationPermitted !== false ? ["final gate unexpectedly permits executor invocation"] : []),
    ...(finalGate.readiness.executionPermitted !== false ? ["final gate unexpectedly permits execution"] : []),
    ...(finalGate.readiness.processSpawnPermitted !== false ? ["final gate unexpectedly permits process spawn"] : []),
    ...(finalGate.readiness.sidecarStartPermitted !== false ? ["final gate unexpectedly permits sidecar start"] : []),
    ...(finalGate.readiness.brokerRestartPermitted !== false ? ["final gate unexpectedly permits broker restart"] : []),
    ...(finalGate.readiness.gatewayRestartPermitted !== false ? ["final gate unexpectedly permits Gateway restart"] : []),
    ...(finalGate.finalGate.reviewOnly !== true ? ["final gate is not review-only"] : []),
    ...(finalGate.finalGate.requiredSeparateApprovalForExecution !== true ? ["final gate does not require separate execution approval"] : []),
    ...(finalGate.integrationContract.writesConfig ? ["final gate unexpectedly writes config"] : []),
    ...(finalGate.integrationContract.enablesDefaultOn ? ["final gate unexpectedly enables default-on"] : []),
    ...(finalGate.integrationContract.dispatchesStartExecutor ? ["final gate unexpectedly dispatches start executor"] : []),
    ...(finalGate.integrationContract.invokesExecutor ? ["final gate unexpectedly invokes executor"] : []),
    ...(finalGate.integrationContract.spawnsProcess ? ["final gate unexpectedly spawns process"] : []),
    ...(finalGate.integrationContract.startsSidecar ? ["final gate unexpectedly starts sidecar"] : []),
    ...(finalGate.integrationContract.restartsSidecar ? ["final gate unexpectedly restarts sidecar"] : []),
    ...(finalGate.integrationContract.restartsBroker ? ["final gate unexpectedly restarts broker"] : []),
    ...(finalGate.integrationContract.restartsGateway ? ["final gate unexpectedly restarts Gateway"] : []),
    ...(finalGate.integrationContract.sendsProvider ? ["final gate unexpectedly sends provider"] : []),
    ...(finalGate.integrationContract.performsTerminalAck ? ["final gate unexpectedly performs terminal ACK"] : []),
    ...(finalGate.integrationContract.mutatesDb ? ["final gate unexpectedly mutates DB"] : []),
    ...(finalGate.integrationContract.mutatesTaskFlow ? ["final gate unexpectedly mutates TaskFlow"] : []),
    ...(finalGate.integrationContract.executesAction ? ["final gate unexpectedly executes action"] : []),
    ...(finalGate.semantics.finalGateDoesNotWriteConfig !== true ? ["final gate does not preserve config boundary"] : []),
    ...(finalGate.semantics.finalGateDoesNotEnableDefaultOn !== true ? ["final gate does not preserve default-on boundary"] : []),
    ...(finalGate.semantics.finalGateDoesNotRestartSidecar !== true ? ["final gate does not preserve sidecar restart boundary"] : []),
    ...(finalGate.semantics.finalGateDoesNotDispatchExecutor !== true ? ["final gate does not preserve executor dispatch boundary"] : []),
    ...(finalGate.semantics.finalGateDoesNotInvokeExecutor !== true ? ["final gate does not preserve executor invocation boundary"] : []),
    ...(finalGate.semantics.performsProviderSend ? ["final gate unexpectedly performs provider send"] : []),
    ...(finalGate.semantics.performsTerminalAck ? ["final gate unexpectedly performs terminal ACK"] : []),
    ...(finalGate.semantics.performsRuntimeRestartOrDeploy ? ["final gate unexpectedly performs runtime restart/deploy"] : []),
    ...(finalGate.semantics.performsDbMutation ? ["final gate unexpectedly performs DB mutation"] : []),
    ...(finalGate.semantics.createsTaskFlowRecords ? ["final gate unexpectedly creates TaskFlow records"] : []),
    ...(finalGate.semantics.movesSecretsOrCredentials ? ["final gate unexpectedly moves secrets/credentials"] : []),
  ]);
}

function stateFor(
  finalGate: TerminalBriefSidecarDefaultOnRuntimeExecutionFinalGatePacket,
  blockers: string[],
): TerminalBriefSidecarDefaultOnRuntimeExecutionRequestDraftState {
  if (finalGate.state === "approval_rejected") return "approval_rejected";
  if (finalGate.state === "stale") return "stale";
  if (finalGate.state === "conflicting") return "conflicting";
  if (finalGate.state !== "ready_for_runtime_execution_final_review") return "waiting_for_runtime_execution_final_gate";
  if (blockers.length) return "blocked";
  return "runtime_execution_request_draft_ready";
}

function missingEvidence(finalGate: TerminalBriefSidecarDefaultOnRuntimeExecutionFinalGatePacket): string[] {
  return unique([
    ...(finalGate.state !== "ready_for_runtime_execution_final_review" ? ["ready_runtime_execution_final_gate"] : []),
    ...(!finalGate.finalGate.gateReady ? ["gate_ready"] : []),
    ...(!finalGate.readiness.runtimeExecutionFinalGateReady ? ["runtime_execution_final_gate_ready"] : []),
  ]);
}

function nextActionFor(state: TerminalBriefSidecarDefaultOnRuntimeExecutionRequestDraftState): string {
  if (state === "runtime_execution_request_draft_ready") return "broker finalizer may review this source-only request draft before separately approved dispatch or runtime execution";
  if (state === "approval_rejected") return "stop this default-on runtime execution path unless a new operator approval is requested";
  if (state === "stale") return "refresh runtime execution final gate evidence before drafting execution request";
  if (state === "conflicting") return "resolve conflicting runtime execution final gate evidence before drafting execution request";
  if (state === "waiting_for_runtime_execution_final_gate") return "wait for a ready runtime execution final gate";
  return "resolve blocked source evidence before drafting runtime execution request";
}

function nextActionsFor(state: TerminalBriefSidecarDefaultOnRuntimeExecutionRequestDraftState): string[] {
  return [
    nextActionFor(state),
    "do not send this request, grant approval, write config, enable default-on, restart sidecar, dispatch/invoke executor, spawn process, send provider, ACK terminal rows, or mutate state from this packet",
  ];
}

function approvalSensitiveActionsExcluded(): string[] {
  return [
    "sending the runtime execution request",
    "granting approval or executing an approval grant",
    "runtime config write",
    "Terminal Brief default-on enablement",
    "Terminal Brief sidecar start/restart",
    "live provider/Hermes/Gongyung/Telegram/OpenClaw send",
    "terminal ACK/replay or terminal receipt DB mutation",
    "start executor dispatch, executor invocation, or process spawn",
    "GitHub PR merge, issue close, or comment post from the packet/route",
    "TaskFlow record creation or broker DB mutation",
    "Gateway/broker restart, production deploy, historical replay, release, publish, or secret movement",
  ];
}

function buildTranscriptDraft(
  finalGate: TerminalBriefSidecarDefaultOnRuntimeExecutionFinalGatePacket,
  requestedAction: string,
  requestedBy: string,
  operatorTarget: string,
  executionRequestReference: string,
  requiredReply: string,
  approvalExpiresAt: string | undefined,
  ready: boolean,
): string {
  return [
    "Terminal Brief default-on runtime execution request draft",
    "",
    "Status: " + (ready ? "ready to request operator approval" : "not ready"),
    "Requested action: " + requestedAction,
    "Requested by: " + requestedBy,
    "Operator target: " + operatorTarget,
    "Execution request reference: " + executionRequestReference,
    "Final gate reference: " + finalGate.finalGate.executionGateReference,
    "Runtime target: " + finalGate.source.runtimeTarget,
    "Config key: " + finalGate.source.configKey,
    "Proposed value: " + finalGate.source.proposedValue,
    "Executor id: " + finalGate.source.executorId,
    ...(approvalExpiresAt ? ["Expires at: " + approvalExpiresAt] : []),
    "",
    "Required reply: " + requiredReply,
    "",
    "This draft does not send the request, grant approval, write config, enable default-on, restart the sidecar, dispatch/invoke an executor, spawn a process, send providers, ACK/replay terminal rows, mutate DB/TaskFlow state, restart Gateway/broker, release, publish, or move secrets.",
  ].join("\n");
}

function approvalExpiry(
  generatedAt: string,
  options: TerminalBriefSidecarDefaultOnRuntimeExecutionRequestDraftOptions,
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

function buildExecutionRequestReference(finalGate: TerminalBriefSidecarDefaultOnRuntimeExecutionFinalGatePacket): string {
  return "tb-sidecar-default-on-runtime-execution-request:" + createHash("sha256").update(finalGate.idempotencyKey).digest("hex").slice(0, 16);
}

function buildIdempotencyKey(
  finalGate: TerminalBriefSidecarDefaultOnRuntimeExecutionFinalGatePacket,
  generatedAt: string,
  requestedAction: string,
  requestedBy: string,
  operatorTarget: string,
  state: TerminalBriefSidecarDefaultOnRuntimeExecutionRequestDraftState,
): string {
  const base = JSON.stringify({
    label: "terminal-brief-sidecar-default-on-runtime-execution-request-draft",
    finalGate: finalGate.idempotencyKey,
    generatedAt,
    requestedAction,
    requestedBy,
    operatorTarget,
    state,
  });
  return "tb-sidecar-default-on-runtime-execution-request-draft:" + createHash("sha256").update(base).digest("hex").slice(0, 24);
}

function titleForState(state: TerminalBriefSidecarDefaultOnRuntimeExecutionRequestDraftState): string {
  if (state === "runtime_execution_request_draft_ready") return "Ready: Terminal Brief default-on runtime execution request draft";
  if (state === "approval_rejected") return "Rejected: Terminal Brief default-on runtime execution request draft";
  if (state === "stale") return "Stale: Terminal Brief default-on runtime execution request draft";
  if (state === "conflicting") return "Conflicting: Terminal Brief default-on runtime execution request draft";
  if (state === "waiting_for_runtime_execution_final_gate") return "Waiting: Terminal Brief default-on runtime execution request draft";
  return "Blocked: Terminal Brief default-on runtime execution request draft";
}

function isRuntimeExecutionFinalGatePacket(
  value: unknown,
): value is TerminalBriefSidecarDefaultOnRuntimeExecutionFinalGatePacket {
  return isRecord(value) && value.kind === "a2a-broker.terminal-brief-sidecar-default-on-runtime-execution-final-gate.packet";
}

