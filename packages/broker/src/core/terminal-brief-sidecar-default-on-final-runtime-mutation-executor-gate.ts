import { createHash } from "node:crypto";

import type { TerminalBriefSidecarDefaultOnExecutionWindowApprovalEvidenceIngestorPacket } from "./terminal-brief-sidecar-default-on-execution-window-approval-evidence-ingestor.js";
import {
  buildTerminalBriefSidecarDefaultOnExecutionWindowApprovalEvidenceIngestor,
  extractTerminalBriefSidecarDefaultOnExecutionWindowApprovalEvidence,
  extractTerminalBriefSidecarDefaultOnExecutionWindowApprovalEvidenceIngestorOptions,
  extractTerminalBriefSidecarDefaultOnExecutionWindowApprovalEvidenceRequestDraft,
} from "./terminal-brief-sidecar-default-on-execution-window-approval-evidence-ingestor.js";

export type TerminalBriefSidecarDefaultOnFinalRuntimeMutationExecutorGateState =
  | "ready_for_final_runtime_mutation_executor_review"
  | "waiting_for_execution_window_approval_evidence"
  | "approval_rejected"
  | "stale"
  | "conflicting"
  | "blocked";

export interface TerminalBriefSidecarDefaultOnFinalRuntimeMutationExecutorGateOptions {
  now?: string;
  mode?: string;
  finalizer?: string;
  finalizerId?: string;
  finalRuntimeMutationExecutorGateReference?: string;
  final_runtime_mutation_executor_gate_reference?: string;
}

export interface TerminalBriefSidecarDefaultOnFinalRuntimeMutationExecutorGatePacket {
  kind: "a2a-broker.terminal-brief-sidecar-default-on-final-runtime-mutation-executor-gate.packet";
  version: 1;
  generatedAt: string;
  mode: string;
  state: TerminalBriefSidecarDefaultOnFinalRuntimeMutationExecutorGateState;
  dryRunOnly: false;
  sourceOnlyNoLive: true;
  idempotencyKey: string;
  source: {
    executionWindowApprovalEvidenceState: TerminalBriefSidecarDefaultOnExecutionWindowApprovalEvidenceIngestorPacket["state"];
    executionWindowApprovalEvidenceIdempotencyKey: string;
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
  finalRuntimeMutationExecutorGate: {
    reviewOnly: true;
    finalizer: string;
    finalRuntimeMutationExecutorGateReference: string;
    gateReady: boolean;
    requiredFreshOperatorExecutionWindowEvidence: true;
    checkpointRequiredBeforeMutation: true;
    rollbackRequiredBeforeMutation: true;
    configWritePlannedButNotPermitted: true;
    defaultOnPlannedButNotPermitted: true;
    sidecarApplyPlannedButNotPermitted: true;
    executorDispatchPlannedButNotPermitted: true;
    prerequisites: Array<{
      id: string;
      status: "ready" | "blocked";
      evidence: string[];
      permitsRuntimeAction: false;
    }>;
    abortConditions: string[];
    requiredSeparateApprovalForExecution: true;
  };
  readiness: {
    sourceCriteriaMet: boolean;
    finalRuntimeMutationExecutorGateReady: boolean;
    executionWindowRequestDispatchPermitted: false;
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
    missingEvidence: string[];
    blockers: string[];
    nextAction: string;
  };
  blockers: string[];
  nextActions: string[];
  approvalSensitiveActionsExcluded: string[];
  integrationContract: {
    transport: "json";
    finalRuntimeMutationExecutorGateVersion: 1;
    consumesExecutionWindowApprovalEvidenceIngestorPacket: true;
    rendersFinalRuntimeMutationExecutorGate: true;
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
    finalRuntimeMutationExecutorGateOnly: true;
    sourceOnlyNoLive: true;
    acceptedEvidenceDoesNotAuthorizeRuntime: true;
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

export function buildTerminalBriefSidecarDefaultOnFinalRuntimeMutationExecutorGate(
  evidence: TerminalBriefSidecarDefaultOnExecutionWindowApprovalEvidenceIngestorPacket,
  options: TerminalBriefSidecarDefaultOnFinalRuntimeMutationExecutorGateOptions = {},
): TerminalBriefSidecarDefaultOnFinalRuntimeMutationExecutorGatePacket {
  const generatedAt = options.now ?? new Date().toISOString();
  const blockers = sourceBlockers(evidence);
  const state = stateFor(evidence, blockers);
  const ready = state === "ready_for_final_runtime_mutation_executor_review";
  const finalRuntimeMutationExecutorGateReference = options.finalRuntimeMutationExecutorGateReference
    ?? options.final_runtime_mutation_executor_gate_reference
    ?? buildGateReference(evidence);

  return {
    kind: "a2a-broker.terminal-brief-sidecar-default-on-final-runtime-mutation-executor-gate.packet",
    version: 1,
    generatedAt,
    mode: options.mode ?? "terminal-brief-default-on-final-runtime-mutation-executor-gate-source-only",
    state,
    dryRunOnly: false,
    sourceOnlyNoLive: true,
    idempotencyKey: buildIdempotencyKey(evidence, finalRuntimeMutationExecutorGateReference, generatedAt, state),
    source: {
      executionWindowApprovalEvidenceState: evidence.state,
      executionWindowApprovalEvidenceIdempotencyKey: evidence.idempotencyKey,
      receiptEvidenceAccepted: evidence.receiptEvidenceAccepted,
      approvalEvidenceAccepted: evidence.approvalEvidenceAccepted,
      executionWindowApprovalEvidenceAccepted: evidence.readiness.executionWindowApprovalEvidenceAccepted,
      executionWindowReference: evidence.source.executionWindowReference,
      requestedAction: evidence.source.requestedAction,
      requestedBy: evidence.source.requestedBy,
      operatorTarget: evidence.source.operatorTarget,
      requiredReply: evidence.source.requiredReply,
      checkpointReference: evidence.source.checkpointReference,
      targetConfigFile: evidence.source.targetConfigFile,
      backupLocation: evidence.source.backupLocation,
      runtimeTarget: evidence.source.runtimeTarget,
      configKey: evidence.source.configKey,
      proposedValue: evidence.source.proposedValue,
      executorId: evidence.source.executorId,
    },
    finalRuntimeMutationExecutorGate: {
      reviewOnly: true,
      finalizer: options.finalizer ?? options.finalizerId ?? "broker-finalizer",
      finalRuntimeMutationExecutorGateReference,
      gateReady: ready,
      requiredFreshOperatorExecutionWindowEvidence: true,
      checkpointRequiredBeforeMutation: true,
      rollbackRequiredBeforeMutation: true,
      configWritePlannedButNotPermitted: true,
      defaultOnPlannedButNotPermitted: true,
      sidecarApplyPlannedButNotPermitted: true,
      executorDispatchPlannedButNotPermitted: true,
      prerequisites: prerequisites(evidence, ready),
      abortConditions: [
        "accepted execution window approval evidence is missing, stale, rejected, conflicting, or blocked",
        "receipt evidence and matching approval grant evidence are not both accepted",
        "provider_accepted is being treated as visibility proof",
        "approval_grant evidence is being treated as approval grant execution",
        "checkpoint, rollback, target config, runtime target, config key, proposed value, or executor identity drift is detected",
        "Gateway readiness or event loop health is degraded",
        "queue backlog exceeds the approved runtime bound",
        "operator asks to perform a live provider send or terminal ACK from this packet",
        "config write, default-on enablement, sidecar apply, executor invocation, or process spawn is requested by this packet",
        "secret values are required in the packet, logs, issue comments, or Wiki",
      ],
      requiredSeparateApprovalForExecution: true,
    },
    readiness: {
      sourceCriteriaMet: ready,
      finalRuntimeMutationExecutorGateReady: ready,
      executionWindowRequestDispatchPermitted: false,
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
      missingEvidence: missingEvidence(evidence),
      blockers: [
        ...blockers,
        "final runtime mutation executor gate is source-only and does not execute default-on",
        "checkpoint creation, rollback, config write, default-on enablement, sidecar apply, and executor invocation require a later explicit live executor step",
      ],
      nextAction: nextActionFor(state),
    },
    blockers,
    nextActions: nextActionsFor(state),
    approvalSensitiveActionsExcluded: approvalSensitiveActionsExcluded(),
    integrationContract: {
      transport: "json",
      finalRuntimeMutationExecutorGateVersion: 1,
      consumesExecutionWindowApprovalEvidenceIngestorPacket: true,
      rendersFinalRuntimeMutationExecutorGate: true,
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
      finalRuntimeMutationExecutorGateOnly: true,
      sourceOnlyNoLive: true,
      acceptedEvidenceDoesNotAuthorizeRuntime: true,
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

export function extractTerminalBriefSidecarDefaultOnFinalRuntimeMutationExecutorGateEvidence(
  input: unknown,
): TerminalBriefSidecarDefaultOnExecutionWindowApprovalEvidenceIngestorPacket {
  const envelope = isRecord(input) ? input : {};
  const candidates = [
    input,
    envelope.defaultOnExecutionWindowApprovalEvidenceIngestorPacket,
    envelope.executionWindowApprovalEvidenceIngestorPacket,
    envelope.executionWindowApprovalEvidence,
    envelope.packet,
  ];
  const packet = candidates.find(isExecutionWindowApprovalEvidencePacket);
  if (packet) return packet;

  return buildTerminalBriefSidecarDefaultOnExecutionWindowApprovalEvidenceIngestor(
    extractTerminalBriefSidecarDefaultOnExecutionWindowApprovalEvidenceRequestDraft(input),
    extractTerminalBriefSidecarDefaultOnExecutionWindowApprovalEvidence(input),
    extractTerminalBriefSidecarDefaultOnExecutionWindowApprovalEvidenceIngestorOptions(input),
  );
}

export function extractTerminalBriefSidecarDefaultOnFinalRuntimeMutationExecutorGateOptions(
  input: unknown,
): TerminalBriefSidecarDefaultOnFinalRuntimeMutationExecutorGateOptions {
  const envelope = isRecord(input) ? input : {};
  const options = isRecord(envelope.defaultOnFinalRuntimeMutationExecutorGate)
    ? envelope.defaultOnFinalRuntimeMutationExecutorGate
    : isRecord(envelope.finalRuntimeMutationExecutorGate)
      ? envelope.finalRuntimeMutationExecutorGate
      : isRecord(envelope.options)
        ? envelope.options
        : {};
  return options as TerminalBriefSidecarDefaultOnFinalRuntimeMutationExecutorGateOptions;
}

export function renderTerminalBriefSidecarDefaultOnFinalRuntimeMutationExecutorGateMarkdown(
  packet: TerminalBriefSidecarDefaultOnFinalRuntimeMutationExecutorGatePacket,
): string {
  return [
    titleForState(packet.state),
    "Mode: " + packet.mode,
    "State: " + packet.state + " sourceOnlyNoLive=" + packet.sourceOnlyNoLive,
    "Idempotency: " + packet.idempotencyKey,
    "Source evidence: state=" + packet.source.executionWindowApprovalEvidenceState
      + " receiptAccepted=" + packet.source.receiptEvidenceAccepted
      + " approvalAccepted=" + packet.source.approvalEvidenceAccepted
      + " executionWindowApprovalEvidenceAccepted=" + packet.source.executionWindowApprovalEvidenceAccepted,
    "Runtime target: " + packet.source.runtimeTarget
      + " configKey=" + packet.source.configKey
      + " proposedValue=" + packet.source.proposedValue
      + " executorId=" + packet.source.executorId,
    "Final gate: reference=" + packet.finalRuntimeMutationExecutorGate.finalRuntimeMutationExecutorGateReference
      + " gateReady=" + packet.finalRuntimeMutationExecutorGate.gateReady
      + " reviewOnly=" + packet.finalRuntimeMutationExecutorGate.reviewOnly,
    "Readiness: checkpointCreationPermitted=" + packet.readiness.checkpointCreationPermitted
      + " rollbackExecutionPermitted=" + packet.readiness.rollbackExecutionPermitted
      + " configWritePermitted=" + packet.readiness.configWritePermitted
      + " defaultOnPermitted=" + packet.readiness.defaultOnPermitted
      + " sidecarRestartPermitted=" + packet.readiness.sidecarRestartPermitted
      + " startExecutorDispatchPermitted=" + packet.readiness.startExecutorDispatchPermitted
      + " executorInvocationPermitted=" + packet.readiness.executorInvocationPermitted
      + " executionPermitted=" + packet.readiness.executionPermitted
      + " processSpawnPermitted=" + packet.readiness.processSpawnPermitted,
    ...(packet.blockers.length ? ["", "Blockers:", ...packet.blockers.map((blocker) => "- " + blocker)] : []),
    "",
    "Next actions:",
    ...packet.nextActions.map((action) => "- " + action),
    "",
    "Safety: final runtime mutation executor gate only; does not create checkpoints, execute rollback, write config, enable default-on, start/restart sidecar, dispatch/invoke executor, spawn a process, send providers, ACK/replay terminal rows, mutate GitHub/DB/TaskFlow state, restart Gateway/broker, release, publish, or move secrets.",
  ].join("\n");
}

function sourceBlockers(evidence: TerminalBriefSidecarDefaultOnExecutionWindowApprovalEvidenceIngestorPacket): string[] {
  return unique([
    ...evidence.blockers,
    ...(evidence.state !== "accepted" ? ["execution window approval evidence state is " + evidence.state] : []),
    ...(!evidence.sourceOnlyNoLive ? ["execution window approval evidence is not source-only no-live"] : []),
    ...(!evidence.receiptEvidenceAccepted ? ["receipt evidence is not accepted"] : []),
    ...(!evidence.approvalEvidenceAccepted ? ["approval evidence is not accepted"] : []),
    ...(!evidence.readiness.executionWindowApprovalEvidenceAccepted ? ["execution window approval evidence is not accepted"] : []),
    ...(evidence.classification.providerAcceptedIsVisibilityProof !== false ? ["provider accepted unexpectedly acts as visibility proof"] : []),
    ...(evidence.classification.approvalGrantEvidenceExecutesGrant !== false ? ["approval grant evidence unexpectedly executes grant"] : []),
    ...(evidence.readiness.executionWindowRequestDispatchPermitted !== false ? ["evidence unexpectedly permits execution window request dispatch"] : []),
    ...(evidence.readiness.approvalGrantPermitted !== false ? ["evidence unexpectedly permits approval grant"] : []),
    ...(evidence.readiness.approvalGrantExecutionPermitted !== false ? ["evidence unexpectedly permits approval grant execution"] : []),
    ...(evidence.readiness.checkpointCreationPermitted !== false ? ["evidence unexpectedly permits checkpoint creation"] : []),
    ...(evidence.readiness.rollbackExecutionPermitted !== false ? ["evidence unexpectedly permits rollback execution"] : []),
    ...(evidence.readiness.runtimeMutationPermitted !== false ? ["evidence unexpectedly permits runtime mutation"] : []),
    ...(evidence.readiness.configWritePermitted !== false ? ["evidence unexpectedly permits config write"] : []),
    ...(evidence.readiness.defaultOnPermitted !== false ? ["evidence unexpectedly permits default-on"] : []),
    ...(evidence.readiness.sidecarRestartPermitted !== false ? ["evidence unexpectedly permits sidecar restart"] : []),
    ...(evidence.readiness.providerSendPermitted !== false ? ["evidence unexpectedly permits provider send"] : []),
    ...(evidence.readiness.terminalAckPermitted !== false ? ["evidence unexpectedly permits terminal ACK"] : []),
    ...(evidence.readiness.dbMutationPermitted !== false ? ["evidence unexpectedly permits DB mutation"] : []),
    ...(evidence.readiness.taskFlowMutationPermitted !== false ? ["evidence unexpectedly permits TaskFlow mutation"] : []),
    ...(evidence.readiness.startExecutorDispatchPermitted !== false ? ["evidence unexpectedly permits start executor dispatch"] : []),
    ...(evidence.readiness.executorInvocationPermitted !== false ? ["evidence unexpectedly permits executor invocation"] : []),
    ...(evidence.readiness.executionPermitted !== false ? ["evidence unexpectedly permits execution"] : []),
    ...(evidence.readiness.processSpawnPermitted !== false ? ["evidence unexpectedly permits process spawn"] : []),
    ...(evidence.readiness.sidecarStartPermitted !== false ? ["evidence unexpectedly permits sidecar start"] : []),
    ...(evidence.readiness.brokerRestartPermitted !== false ? ["evidence unexpectedly permits broker restart"] : []),
    ...(evidence.readiness.gatewayRestartPermitted !== false ? ["evidence unexpectedly permits gateway restart"] : []),
    ...(evidence.integrationContract.sendsExecutionWindowRequest ? ["evidence unexpectedly sends execution window request"] : []),
    ...(evidence.integrationContract.grantsApproval ? ["evidence unexpectedly grants approval"] : []),
    ...(evidence.integrationContract.executesApprovalGrant ? ["evidence unexpectedly executes approval grant"] : []),
    ...(evidence.integrationContract.createsCheckpoint ? ["evidence unexpectedly creates checkpoint"] : []),
    ...(evidence.integrationContract.executesRollback ? ["evidence unexpectedly executes rollback"] : []),
    ...(evidence.integrationContract.writesConfig ? ["evidence unexpectedly writes config"] : []),
    ...(evidence.integrationContract.enablesDefaultOn ? ["evidence unexpectedly enables default-on"] : []),
    ...(evidence.integrationContract.dispatchesStartExecutor ? ["evidence unexpectedly dispatches start executor"] : []),
    ...(evidence.integrationContract.invokesExecutor ? ["evidence unexpectedly invokes executor"] : []),
    ...(evidence.integrationContract.spawnsProcess ? ["evidence unexpectedly spawns process"] : []),
    ...(evidence.integrationContract.startsSidecar ? ["evidence unexpectedly starts sidecar"] : []),
    ...(evidence.integrationContract.restartsSidecar ? ["evidence unexpectedly restarts sidecar"] : []),
    ...(evidence.integrationContract.restartsBroker ? ["evidence unexpectedly restarts broker"] : []),
    ...(evidence.integrationContract.restartsGateway ? ["evidence unexpectedly restarts gateway"] : []),
    ...(evidence.integrationContract.sendsProvider ? ["evidence unexpectedly sends provider"] : []),
    ...(evidence.integrationContract.performsTerminalAck ? ["evidence unexpectedly performs terminal ACK"] : []),
    ...(evidence.integrationContract.mutatesDb ? ["evidence unexpectedly mutates DB"] : []),
    ...(evidence.integrationContract.mutatesTaskFlow ? ["evidence unexpectedly mutates TaskFlow"] : []),
    ...(evidence.integrationContract.executesAction ? ["evidence unexpectedly executes action"] : []),
    ...(evidence.semantics.approvalEvidenceDoesNotGrantApproval !== true ? ["evidence does not preserve approval boundary"] : []),
    ...(evidence.semantics.approvalEvidenceDoesNotCreateCheckpoint !== true ? ["evidence does not preserve checkpoint boundary"] : []),
    ...(evidence.semantics.approvalEvidenceDoesNotExecuteRollback !== true ? ["evidence does not preserve rollback boundary"] : []),
    ...(evidence.semantics.approvalEvidenceDoesNotWriteConfig !== true ? ["evidence does not preserve config boundary"] : []),
    ...(evidence.semantics.approvalEvidenceDoesNotEnableDefaultOn !== true ? ["evidence does not preserve default-on boundary"] : []),
    ...(evidence.semantics.approvalEvidenceDoesNotRestartSidecar !== true ? ["evidence does not preserve sidecar restart boundary"] : []),
    ...(evidence.semantics.approvalEvidenceDoesNotDispatchExecutor !== true ? ["evidence does not preserve executor dispatch boundary"] : []),
    ...(evidence.semantics.approvalEvidenceDoesNotInvokeExecutor !== true ? ["evidence does not preserve executor invocation boundary"] : []),
    ...(evidence.semantics.performsProviderSend ? ["evidence unexpectedly performs provider send"] : []),
    ...(evidence.semantics.performsTerminalAck ? ["evidence unexpectedly performs terminal ACK"] : []),
    ...(evidence.semantics.performsRuntimeRestartOrDeploy ? ["evidence unexpectedly performs runtime restart/deploy"] : []),
    ...(evidence.semantics.performsDbMutation ? ["evidence unexpectedly performs DB mutation"] : []),
    ...(evidence.semantics.createsTaskFlowRecords ? ["evidence unexpectedly creates TaskFlow records"] : []),
    ...(evidence.semantics.movesSecretsOrCredentials ? ["evidence unexpectedly moves secrets/credentials"] : []),
  ]);
}

function stateFor(
  evidence: TerminalBriefSidecarDefaultOnExecutionWindowApprovalEvidenceIngestorPacket,
  blockers: string[],
): TerminalBriefSidecarDefaultOnFinalRuntimeMutationExecutorGateState {
  if (evidence.state === "rejected") return "approval_rejected";
  if (evidence.state === "stale") return "stale";
  if (evidence.state === "conflicting") return "conflicting";
  if (evidence.state !== "accepted") return "waiting_for_execution_window_approval_evidence";
  if (blockers.length) return "blocked";
  return "ready_for_final_runtime_mutation_executor_review";
}

function missingEvidence(evidence: TerminalBriefSidecarDefaultOnExecutionWindowApprovalEvidenceIngestorPacket): string[] {
  return unique([
    ...(evidence.state !== "accepted" ? ["accepted_execution_window_approval_evidence"] : []),
    ...(!evidence.receiptEvidenceAccepted ? ["receipt_evidence_accepted"] : []),
    ...(!evidence.approvalEvidenceAccepted ? ["approval_evidence_accepted"] : []),
    ...(!evidence.readiness.executionWindowApprovalEvidenceAccepted ? ["execution_window_approval_evidence_accepted"] : []),
  ]);
}

function prerequisites(
  evidence: TerminalBriefSidecarDefaultOnExecutionWindowApprovalEvidenceIngestorPacket,
  ready: boolean,
): TerminalBriefSidecarDefaultOnFinalRuntimeMutationExecutorGatePacket["finalRuntimeMutationExecutorGate"]["prerequisites"] {
  const status = ready ? "ready" as const : "blocked" as const;
  const row = (id: string, evidenceRows: string[]) => ({ id, status, evidence: evidenceRows, permitsRuntimeAction: false as const });
  return [
    row("accepted_execution_window_approval_evidence", [evidence.idempotencyKey, "state=" + evidence.state]),
    row("receipt_and_approval", ["receiptEvidenceAccepted=" + evidence.receiptEvidenceAccepted, "approvalEvidenceAccepted=" + evidence.approvalEvidenceAccepted]),
    row("operator_reply_match", [evidence.source.executionWindowReference, evidence.source.requiredReply]),
    row("checkpoint_and_rollback_references", [evidence.source.checkpointReference, evidence.source.backupLocation]),
    row("target_identity", [evidence.source.runtimeTarget, evidence.source.configKey, evidence.source.executorId]),
    row("runtime_action_boundary", ["checkpointCreationPermitted=false", "configWritePermitted=false", "defaultOnPermitted=false", "sidecarRestartPermitted=false", "executionPermitted=false"]),
    row("terminal_boundary", ["providerSendPermitted=false", "terminalAckPermitted=false"]),
    row("state_boundary", ["dbMutationPermitted=false", "taskFlowMutationPermitted=false"]),
  ];
}

function nextActionFor(state: TerminalBriefSidecarDefaultOnFinalRuntimeMutationExecutorGateState): string {
  if (state === "ready_for_final_runtime_mutation_executor_review") return "broker finalizer may review this source-only final runtime mutation executor gate before any later separately approved live executor";
  if (state === "approval_rejected") return "stop this default-on execution path unless a new operator execution window is approved";
  if (state === "stale") return "refresh execution window approval evidence before final runtime mutation review";
  if (state === "conflicting") return "resolve conflicting execution window approval evidence before final runtime mutation review";
  if (state === "waiting_for_execution_window_approval_evidence") return "wait for accepted execution window approval evidence";
  return "resolve blocked source evidence before final runtime mutation review";
}

function nextActionsFor(state: TerminalBriefSidecarDefaultOnFinalRuntimeMutationExecutorGateState): string[] {
  return [
    nextActionFor(state),
    "do not create checkpoints, execute rollback, write config, enable default-on, start/restart sidecar, dispatch/invoke executor, spawn process, send provider, ACK terminal rows, or mutate state from this packet",
  ];
}

function approvalSensitiveActionsExcluded(): string[] {
  return [
    "execution window request dispatch or approval grant execution",
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

function buildGateReference(evidence: TerminalBriefSidecarDefaultOnExecutionWindowApprovalEvidenceIngestorPacket): string {
  return "tb-sidecar-default-on-final-runtime-mutation-executor-gate:"
    + createHash("sha256").update(evidence.idempotencyKey).digest("hex").slice(0, 16);
}

function buildIdempotencyKey(
  evidence: TerminalBriefSidecarDefaultOnExecutionWindowApprovalEvidenceIngestorPacket,
  finalRuntimeMutationExecutorGateReference: string,
  generatedAt: string,
  state: TerminalBriefSidecarDefaultOnFinalRuntimeMutationExecutorGateState,
): string {
  const base = JSON.stringify({
    label: "terminal-brief-sidecar-default-on-final-runtime-mutation-executor-gate",
    evidence: evidence.idempotencyKey,
    finalRuntimeMutationExecutorGateReference,
    generatedAt,
    state,
  });
  return "tb-sidecar-default-on-final-runtime-mutation-executor-gate:"
    + createHash("sha256").update(base).digest("hex").slice(0, 24);
}

function titleForState(state: TerminalBriefSidecarDefaultOnFinalRuntimeMutationExecutorGateState): string {
  if (state === "ready_for_final_runtime_mutation_executor_review") return "Ready: Terminal Brief default-on final runtime mutation executor gate";
  if (state === "approval_rejected") return "Rejected: Terminal Brief default-on final runtime mutation executor gate";
  if (state === "stale") return "Stale: Terminal Brief default-on final runtime mutation executor gate";
  if (state === "conflicting") return "Conflicting: Terminal Brief default-on final runtime mutation executor gate";
  if (state === "waiting_for_execution_window_approval_evidence") return "Waiting: Terminal Brief default-on final runtime mutation executor gate";
  return "Blocked: Terminal Brief default-on final runtime mutation executor gate";
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function isExecutionWindowApprovalEvidencePacket(
  value: unknown,
): value is TerminalBriefSidecarDefaultOnExecutionWindowApprovalEvidenceIngestorPacket {
  return isRecord(value) && value.kind === "a2a-broker.terminal-brief-sidecar-default-on-execution-window-approval-evidence-ingestor.packet";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
