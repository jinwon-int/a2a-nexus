import { isRecord } from "./value-guards.js";
import { createHash } from "node:crypto";

import type { TerminalBriefSidecarDefaultOnRuntimeExecutionApprovalEvidenceIngestorPacket } from "./terminal-brief-sidecar-default-on-runtime-execution-approval-evidence-ingestor.js";

export type TerminalBriefSidecarDefaultOnRuntimeExecutorGateState =
  | "ready_for_runtime_executor_review"
  | "waiting_for_runtime_execution_approval_evidence"
  | "approval_rejected"
  | "stale"
  | "conflicting"
  | "blocked";

export interface TerminalBriefSidecarDefaultOnRuntimeExecutorGateOptions {
  now?: string;
  mode?: string;
  finalizer?: string;
  finalizerId?: string;
  runtimeExecutorGateReference?: string;
  runtime_executor_gate_reference?: string;
}

export interface TerminalBriefSidecarDefaultOnRuntimeExecutorGatePacket {
  kind: "a2a-broker.terminal-brief-sidecar-default-on-runtime-executor-gate.packet";
  version: 1;
  generatedAt: string;
  mode: string;
  state: TerminalBriefSidecarDefaultOnRuntimeExecutorGateState;
  dryRunOnly: false;
  sourceOnlyNoLive: true;
  idempotencyKey: string;
  source: {
    runtimeExecutionApprovalEvidenceState: TerminalBriefSidecarDefaultOnRuntimeExecutionApprovalEvidenceIngestorPacket["state"];
    runtimeExecutionApprovalEvidenceIdempotencyKey: string;
    receiptEvidenceAccepted: boolean;
    approvalEvidenceAccepted: boolean;
    requestedAction: string;
    executionRequestReference: string;
    runtimeTarget: string;
    configKey: string;
    proposedValue: string;
    executorId: string;
  };
  executorGate: {
    reviewOnly: true;
    finalizer: string;
    runtimeExecutorGateReference: string;
    gateReady: boolean;
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
    runtimeExecutorGateReady: boolean;
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
    missingEvidence: string[];
    blockers: string[];
    nextAction: string;
  };
  blockers: string[];
  nextActions: string[];
  approvalSensitiveActionsExcluded: string[];
  integrationContract: {
    transport: "json";
    runtimeExecutorGateVersion: 1;
    harnessNeutral: true;
    openclawMessageSendRequired: false;
    hermesAdapterCompatible: true;
    gongyungAdapterCompatible: true;
    externalHarnessCompatible: true;
    consumesRuntimeExecutionApprovalEvidenceIngestorPacket: true;
    rendersRuntimeExecutorGate: true;
    sendsApprovalRequest: false;
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
    runtimeExecutorGateOnly: true;
    sourceOnlyNoLive: true;
    acceptedEvidenceDoesNotAuthorizeRuntime: true;
    executorGateDoesNotWriteConfig: true;
    executorGateDoesNotEnableDefaultOn: true;
    executorGateDoesNotRestartSidecar: true;
    executorGateDoesNotDispatchExecutor: true;
    executorGateDoesNotInvokeExecutor: true;
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

export function buildTerminalBriefSidecarDefaultOnRuntimeExecutorGate(
  evidence: TerminalBriefSidecarDefaultOnRuntimeExecutionApprovalEvidenceIngestorPacket,
  options: TerminalBriefSidecarDefaultOnRuntimeExecutorGateOptions = {},
): TerminalBriefSidecarDefaultOnRuntimeExecutorGatePacket {
  const generatedAt = options.now ?? new Date().toISOString();
  const blockers = sourceBlockers(evidence);
  const state = stateFor(evidence, blockers);
  const ready = state === "ready_for_runtime_executor_review";
  const runtimeExecutorGateReference = options.runtimeExecutorGateReference
    ?? options.runtime_executor_gate_reference
    ?? buildRuntimeExecutorGateReference(evidence);
  return {
    kind: "a2a-broker.terminal-brief-sidecar-default-on-runtime-executor-gate.packet",
    version: 1,
    generatedAt,
    mode: options.mode ?? evidence.mode,
    state,
    dryRunOnly: false,
    sourceOnlyNoLive: true,
    idempotencyKey: buildIdempotencyKey(evidence, runtimeExecutorGateReference, generatedAt, state),
    source: {
      runtimeExecutionApprovalEvidenceState: evidence.state,
      runtimeExecutionApprovalEvidenceIdempotencyKey: evidence.idempotencyKey,
      receiptEvidenceAccepted: evidence.receiptEvidenceAccepted,
      approvalEvidenceAccepted: evidence.approvalEvidenceAccepted,
      requestedAction: evidence.source.requestedAction,
      executionRequestReference: evidence.source.executionRequestReference,
      runtimeTarget: evidence.source.runtimeTarget,
      configKey: evidence.source.configKey,
      proposedValue: evidence.source.proposedValue,
      executorId: evidence.source.executorId,
    },
    executorGate: {
      reviewOnly: true,
      finalizer: options.finalizer ?? options.finalizerId ?? "broker-finalizer",
      runtimeExecutorGateReference,
      gateReady: ready,
      prerequisites: prerequisites(evidence, ready),
      abortConditions: [
        "accepted runtime execution approval evidence is missing, stale, rejected, conflicting, or blocked",
        "runtime target/config/executor identity cannot be matched to the approved evidence",
        "Gateway readiness or event loop health is degraded",
        "queue backlog exceeds the approved runtime bound",
        "operator asks to perform a live provider send or terminal ACK from this packet",
        "config write, sidecar restart, process spawn, or executor invocation is requested by this packet",
        "secret values are required in the packet, logs, issue comments, or Wiki",
      ],
      requiredSeparateApprovalForExecution: true,
    },
    readiness: {
      sourceCriteriaMet: ready,
      runtimeExecutorGateReady: ready,
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
      missingEvidence: missingEvidence(evidence),
      blockers: [
        ...blockers,
        "runtime executor gate is source-only and does not execute default-on",
        "config write, default-on enablement, and sidecar restart require a later explicit runtime executor",
      ],
      nextAction: nextActionFor(state),
    },
    blockers,
    nextActions: nextActionsFor(state),
    approvalSensitiveActionsExcluded: approvalSensitiveActionsExcluded(),
    integrationContract: {
      transport: "json",
      runtimeExecutorGateVersion: 1,
      harnessNeutral: true,
      openclawMessageSendRequired: false,
      hermesAdapterCompatible: true,
      gongyungAdapterCompatible: true,
      externalHarnessCompatible: true,
      consumesRuntimeExecutionApprovalEvidenceIngestorPacket: true,
      rendersRuntimeExecutorGate: true,
      sendsApprovalRequest: false,
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
      runtimeExecutorGateOnly: true,
      sourceOnlyNoLive: true,
      acceptedEvidenceDoesNotAuthorizeRuntime: true,
      executorGateDoesNotWriteConfig: true,
      executorGateDoesNotEnableDefaultOn: true,
      executorGateDoesNotRestartSidecar: true,
      executorGateDoesNotDispatchExecutor: true,
      executorGateDoesNotInvokeExecutor: true,
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

export function extractTerminalBriefSidecarDefaultOnRuntimeExecutorGateEvidence(
  input: unknown,
): TerminalBriefSidecarDefaultOnRuntimeExecutionApprovalEvidenceIngestorPacket {
  const envelope = isRecord(input) ? input : {};
  const candidates = [
    input,
    envelope.defaultOnRuntimeExecutionApprovalEvidenceIngestorPacket,
    envelope.runtimeExecutionApprovalEvidenceIngestorPacket,
    envelope.runtimeExecutionEvidence,
    envelope.runtimeExecutionApprovalEvidence,
    envelope.packet,
  ];
  const packet = candidates.find(isRuntimeExecutionApprovalEvidencePacket);
  if (!packet) throw new Error("expected a Terminal Brief sidecar default-on runtime execution approval evidence ingestor packet");
  return packet;
}

export function extractTerminalBriefSidecarDefaultOnRuntimeExecutorGateOptions(
  input: unknown,
): TerminalBriefSidecarDefaultOnRuntimeExecutorGateOptions {
  const envelope = isRecord(input) ? input : {};
  const options = isRecord(envelope.defaultOnRuntimeExecutorGate)
    ? envelope.defaultOnRuntimeExecutorGate
    : isRecord(envelope.runtimeExecutorGate)
      ? envelope.runtimeExecutorGate
      : isRecord(envelope.options)
        ? envelope.options
        : {};
  return options as TerminalBriefSidecarDefaultOnRuntimeExecutorGateOptions;
}

export function renderTerminalBriefSidecarDefaultOnRuntimeExecutorGateMarkdown(
  packet: TerminalBriefSidecarDefaultOnRuntimeExecutorGatePacket,
): string {
  return [
    titleForState(packet.state),
    "Mode: " + packet.mode,
    "State: " + packet.state + " sourceOnlyNoLive=" + packet.sourceOnlyNoLive,
    "Idempotency: " + packet.idempotencyKey,
    "Source evidence: state=" + packet.source.runtimeExecutionApprovalEvidenceState
      + " receiptAccepted=" + packet.source.receiptEvidenceAccepted
      + " approvalAccepted=" + packet.source.approvalEvidenceAccepted,
    "Runtime target: " + packet.source.runtimeTarget
      + " configKey=" + packet.source.configKey
      + " proposedValue=" + packet.source.proposedValue
      + " executorId=" + packet.source.executorId,
    "Executor gate: reference=" + packet.executorGate.runtimeExecutorGateReference
      + " gateReady=" + packet.executorGate.gateReady
      + " reviewOnly=" + packet.executorGate.reviewOnly,
    "Readiness: configWritePermitted=" + packet.readiness.configWritePermitted
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
    "Safety: runtime executor gate only; does not write config, enable default-on, restart sidecar, dispatch/invoke executor, spawn a process, send providers, ACK/replay terminal rows, mutate GitHub/DB/TaskFlow state, restart Gateway/broker, release, publish, or move secrets.",
  ].join("\n");
}

function sourceBlockers(evidence: TerminalBriefSidecarDefaultOnRuntimeExecutionApprovalEvidenceIngestorPacket): string[] {
  return unique([
    ...evidence.blockers,
    ...(evidence.state !== "accepted" ? ["runtime execution approval evidence state is " + evidence.state] : []),
    ...(!evidence.receiptEvidenceAccepted ? ["receipt evidence is not accepted"] : []),
    ...(!evidence.approvalEvidenceAccepted ? ["approval evidence is not accepted"] : []),
    ...(evidence.classification.providerAcceptedIsVisibilityProof !== false ? ["provider accepted unexpectedly acts as visibility proof"] : []),
    ...(evidence.classification.approvalGrantEvidenceExecutesGrant !== false ? ["approval grant evidence unexpectedly executes grant"] : []),
    ...(evidence.readiness.runtimeExecutionRequestDispatchPermitted !== false ? ["evidence unexpectedly permits runtime execution request dispatch"] : []),
    ...(evidence.readiness.approvalGrantPermitted !== false ? ["evidence unexpectedly permits approval grant"] : []),
    ...(evidence.readiness.approvalGrantExecutionPermitted !== false ? ["evidence unexpectedly permits approval grant execution"] : []),
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
    ...(evidence.integrationContract.executesApprovalGrant ? ["evidence unexpectedly executes approval grant"] : []),
    ...(evidence.integrationContract.grantsApproval ? ["evidence unexpectedly grants approval"] : []),
    ...(evidence.integrationContract.writesConfig ? ["evidence unexpectedly writes config"] : []),
    ...(evidence.integrationContract.enablesDefaultOn ? ["evidence unexpectedly enables default-on"] : []),
    ...(evidence.integrationContract.sendsProvider ? ["evidence unexpectedly sends provider"] : []),
    ...(evidence.integrationContract.performsTerminalAck ? ["evidence unexpectedly performs terminal ACK"] : []),
    ...(evidence.integrationContract.mutatesDb ? ["evidence unexpectedly mutates DB"] : []),
    ...(evidence.integrationContract.mutatesTaskFlow ? ["evidence unexpectedly mutates TaskFlow"] : []),
    ...(evidence.integrationContract.spawnsProcess ? ["evidence unexpectedly spawns process"] : []),
    ...(evidence.integrationContract.startsSidecar ? ["evidence unexpectedly starts sidecar"] : []),
    ...(evidence.integrationContract.restartsSidecar ? ["evidence unexpectedly restarts sidecar"] : []),
    ...(evidence.integrationContract.restartsBroker ? ["evidence unexpectedly restarts broker"] : []),
    ...(evidence.integrationContract.restartsGateway ? ["evidence unexpectedly restarts gateway"] : []),
    ...(evidence.integrationContract.executesAction ? ["evidence unexpectedly executes action"] : []),
    ...(evidence.semantics.runtimeExecutionApprovalEvidenceDoesNotWriteConfig !== true ? ["evidence does not preserve config boundary"] : []),
    ...(evidence.semantics.runtimeExecutionApprovalEvidenceDoesNotEnableDefaultOn !== true ? ["evidence does not preserve default-on boundary"] : []),
    ...(evidence.semantics.runtimeExecutionApprovalEvidenceDoesNotRestartSidecar !== true ? ["evidence does not preserve sidecar restart boundary"] : []),
    ...(evidence.semantics.runtimeExecutionApprovalEvidenceDoesNotDispatchExecutor !== true ? ["evidence does not preserve executor dispatch boundary"] : []),
    ...(evidence.semantics.runtimeExecutionApprovalEvidenceDoesNotInvokeExecutor !== true ? ["evidence does not preserve executor invocation boundary"] : []),
    ...(evidence.semantics.performsProviderSend ? ["evidence unexpectedly performs provider send"] : []),
    ...(evidence.semantics.performsTerminalAck ? ["evidence unexpectedly performs terminal ACK"] : []),
    ...(evidence.semantics.performsRuntimeRestartOrDeploy ? ["evidence unexpectedly performs runtime restart/deploy"] : []),
    ...(evidence.semantics.performsDbMutation ? ["evidence unexpectedly performs DB mutation"] : []),
    ...(evidence.semantics.createsTaskFlowRecords ? ["evidence unexpectedly creates TaskFlow records"] : []),
    ...(evidence.semantics.movesSecretsOrCredentials ? ["evidence unexpectedly moves secrets/credentials"] : []),
  ].filter(Boolean));
}

function stateFor(
  evidence: TerminalBriefSidecarDefaultOnRuntimeExecutionApprovalEvidenceIngestorPacket,
  blockers: string[],
): TerminalBriefSidecarDefaultOnRuntimeExecutorGateState {
  if (evidence.state === "rejected") return "approval_rejected";
  if (evidence.state === "stale") return "stale";
  if (evidence.state === "conflicting") return "conflicting";
  if (evidence.state !== "accepted") return "waiting_for_runtime_execution_approval_evidence";
  if (blockers.length) return "blocked";
  return "ready_for_runtime_executor_review";
}

function missingEvidence(evidence: TerminalBriefSidecarDefaultOnRuntimeExecutionApprovalEvidenceIngestorPacket): string[] {
  return unique([
    ...(evidence.state !== "accepted" ? ["accepted_runtime_execution_approval_evidence"] : []),
    ...(!evidence.receiptEvidenceAccepted ? ["receipt_evidence_accepted"] : []),
    ...(!evidence.approvalEvidenceAccepted ? ["approval_evidence_accepted"] : []),
  ]);
}

function prerequisites(
  evidence: TerminalBriefSidecarDefaultOnRuntimeExecutionApprovalEvidenceIngestorPacket,
  ready: boolean,
): TerminalBriefSidecarDefaultOnRuntimeExecutorGatePacket["executorGate"]["prerequisites"] {
  const status = ready ? "ready" as const : "blocked" as const;
  const row = (id: string, evidenceRows: string[]) => ({ id, status, evidence: evidenceRows, permitsRuntimeAction: false as const });
  return [
    row("accepted_runtime_execution_approval_evidence", [evidence.idempotencyKey, "state=" + evidence.state]),
    row("receipt_and_approval", ["receiptEvidenceAccepted=" + evidence.receiptEvidenceAccepted, "approvalEvidenceAccepted=" + evidence.approvalEvidenceAccepted]),
    row("target_identity", [evidence.source.runtimeTarget, evidence.source.configKey, evidence.source.executorId]),
    row("runtime_action_boundary", ["configWritePermitted=false", "defaultOnPermitted=false", "sidecarRestartPermitted=false", "executionPermitted=false"]),
    row("terminal_boundary", ["providerSendPermitted=false", "terminalAckPermitted=false"]),
    row("state_boundary", ["dbMutationPermitted=false", "taskFlowMutationPermitted=false"]),
  ];
}

function nextActionFor(state: TerminalBriefSidecarDefaultOnRuntimeExecutorGateState): string {
  if (state === "ready_for_runtime_executor_review") return "broker finalizer may review this source-only executor gate before any later separately approved runtime executor";
  if (state === "approval_rejected") return "stop this default-on execution path unless a new operator approval is requested";
  if (state === "stale") return "refresh runtime execution approval evidence before runtime executor review";
  if (state === "conflicting") return "resolve conflicting runtime execution approval evidence before runtime executor review";
  if (state === "waiting_for_runtime_execution_approval_evidence") return "wait for accepted runtime execution approval evidence";
  return "resolve blocked source evidence before runtime executor review";
}

function nextActionsFor(state: TerminalBriefSidecarDefaultOnRuntimeExecutorGateState): string[] {
  return [
    nextActionFor(state),
    "do not write config, enable default-on, restart sidecar, dispatch/invoke executor, spawn process, send provider, ACK terminal rows, or mutate state from this packet",
  ];
}

function approvalSensitiveActionsExcluded(): string[] {
  return [
    "approval request dispatch or approval grant execution",
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

function buildRuntimeExecutorGateReference(evidence: TerminalBriefSidecarDefaultOnRuntimeExecutionApprovalEvidenceIngestorPacket): string {
  return "tb-sidecar-default-on-runtime-executor-gate:" + createHash("sha256").update(evidence.idempotencyKey).digest("hex").slice(0, 16);
}

function buildIdempotencyKey(
  evidence: TerminalBriefSidecarDefaultOnRuntimeExecutionApprovalEvidenceIngestorPacket,
  runtimeExecutorGateReference: string,
  generatedAt: string,
  state: TerminalBriefSidecarDefaultOnRuntimeExecutorGateState,
): string {
  const base = JSON.stringify({
    label: "terminal-brief-sidecar-default-on-runtime-executor-gate",
    evidence: evidence.idempotencyKey,
    runtimeExecutorGateReference,
    generatedAt,
    state,
  });
  return "tb-sidecar-default-on-runtime-executor-gate:" + createHash("sha256").update(base).digest("hex").slice(0, 24);
}

function titleForState(state: TerminalBriefSidecarDefaultOnRuntimeExecutorGateState): string {
  if (state === "ready_for_runtime_executor_review") return "Ready: Terminal Brief default-on runtime executor gate";
  if (state === "approval_rejected") return "Rejected: Terminal Brief default-on runtime executor gate";
  if (state === "stale") return "Stale: Terminal Brief default-on runtime executor gate";
  if (state === "conflicting") return "Conflicting: Terminal Brief default-on runtime executor gate";
  if (state === "waiting_for_runtime_execution_approval_evidence") return "Waiting: Terminal Brief default-on runtime executor gate";
  return "Blocked: Terminal Brief default-on runtime executor gate";
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function isRuntimeExecutionApprovalEvidencePacket(
  value: unknown,
): value is TerminalBriefSidecarDefaultOnRuntimeExecutionApprovalEvidenceIngestorPacket {
  return isRecord(value) && value.kind === "a2a-broker.terminal-brief-sidecar-default-on-runtime-execution-approval-evidence-ingestor.packet";
}

