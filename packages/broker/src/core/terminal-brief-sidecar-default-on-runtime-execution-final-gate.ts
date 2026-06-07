import { createHash } from "node:crypto";

import type { TerminalBriefSidecarDefaultOnExecutionApprovalEvidenceIngestorPacket } from "./terminal-brief-sidecar-default-on-execution-approval-evidence-ingestor.js";

export type TerminalBriefSidecarDefaultOnRuntimeExecutionFinalGateState =
  | "ready_for_runtime_execution_final_review"
  | "waiting_for_execution_approval_evidence"
  | "approval_rejected"
  | "stale"
  | "conflicting"
  | "blocked";

export interface TerminalBriefSidecarDefaultOnRuntimeExecutionFinalGateOptions {
  now?: string;
  mode?: string;
  finalizer?: string;
  finalizerId?: string;
  executionGateReference?: string;
  execution_gate_reference?: string;
}

export interface TerminalBriefSidecarDefaultOnRuntimeExecutionFinalGatePacket {
  kind: "a2a-broker.terminal-brief-sidecar-default-on-runtime-execution-final-gate.packet";
  version: 1;
  generatedAt: string;
  mode: string;
  state: TerminalBriefSidecarDefaultOnRuntimeExecutionFinalGateState;
  dryRunOnly: false;
  sourceOnlyNoLive: true;
  idempotencyKey: string;
  source: {
    executionApprovalEvidenceState: TerminalBriefSidecarDefaultOnExecutionApprovalEvidenceIngestorPacket["state"];
    executionApprovalEvidenceIdempotencyKey: string;
    receiptEvidenceAccepted: boolean;
    approvalEvidenceAccepted: boolean;
    requestedAction: string;
    approvalReference: string;
    runtimeTarget: string;
    configKey: string;
    proposedValue: string;
    executorId: string;
  };
  finalGate: {
    reviewOnly: true;
    finalizer: string;
    executionGateReference: string;
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
    runtimeExecutionFinalGateReady: boolean;
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
    runtimeExecutionFinalGateVersion: 1;
    harnessNeutral: true;
    openclawMessageSendRequired: false;
    hermesAdapterCompatible: true;
    gongyungAdapterCompatible: true;
    externalHarnessCompatible: true;
    consumesExecutionApprovalEvidenceIngestorPacket: true;
    rendersRuntimeExecutionFinalGate: true;
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
    runtimeExecutionFinalGateOnly: true;
    sourceOnlyNoLive: true;
    acceptedEvidenceDoesNotAuthorizeRuntime: true;
    finalGateDoesNotWriteConfig: true;
    finalGateDoesNotEnableDefaultOn: true;
    finalGateDoesNotRestartSidecar: true;
    finalGateDoesNotDispatchExecutor: true;
    finalGateDoesNotInvokeExecutor: true;
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

export function buildTerminalBriefSidecarDefaultOnRuntimeExecutionFinalGate(
  evidence: TerminalBriefSidecarDefaultOnExecutionApprovalEvidenceIngestorPacket,
  options: TerminalBriefSidecarDefaultOnRuntimeExecutionFinalGateOptions = {},
): TerminalBriefSidecarDefaultOnRuntimeExecutionFinalGatePacket {
  const generatedAt = options.now ?? new Date().toISOString();
  const blockers = sourceBlockers(evidence);
  const state = stateFor(evidence, blockers);
  const ready = state === "ready_for_runtime_execution_final_review";
  const executionGateReference = options.executionGateReference
    ?? options.execution_gate_reference
    ?? buildExecutionGateReference(evidence);
  return {
    kind: "a2a-broker.terminal-brief-sidecar-default-on-runtime-execution-final-gate.packet",
    version: 1,
    generatedAt,
    mode: options.mode ?? evidence.mode,
    state,
    dryRunOnly: false,
    sourceOnlyNoLive: true,
    idempotencyKey: buildIdempotencyKey(evidence, executionGateReference, generatedAt, state),
    source: {
      executionApprovalEvidenceState: evidence.state,
      executionApprovalEvidenceIdempotencyKey: evidence.idempotencyKey,
      receiptEvidenceAccepted: evidence.receiptEvidenceAccepted,
      approvalEvidenceAccepted: evidence.approvalEvidenceAccepted,
      requestedAction: evidence.source.requestedAction,
      approvalReference: evidence.source.approvalReference,
      runtimeTarget: evidence.source.runtimeTarget,
      configKey: evidence.source.configKey,
      proposedValue: evidence.source.proposedValue,
      executorId: evidence.source.executorId,
    },
    finalGate: {
      reviewOnly: true,
      finalizer: options.finalizer ?? options.finalizerId ?? "broker-finalizer",
      executionGateReference,
      gateReady: ready,
      prerequisites: prerequisites(evidence, ready),
      abortConditions: [
        "accepted execution approval evidence is missing, stale, rejected, conflicting, or blocked",
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
      runtimeExecutionFinalGateReady: ready,
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
        "runtime execution final gate is source-only and does not execute default-on",
        "config write, default-on enablement, and sidecar restart require a later explicit runtime executor",
      ],
      nextAction: nextActionFor(state),
    },
    blockers,
    nextActions: nextActionsFor(state),
    approvalSensitiveActionsExcluded: approvalSensitiveActionsExcluded(),
    integrationContract: {
      transport: "json",
      runtimeExecutionFinalGateVersion: 1,
      harnessNeutral: true,
      openclawMessageSendRequired: false,
      hermesAdapterCompatible: true,
      gongyungAdapterCompatible: true,
      externalHarnessCompatible: true,
      consumesExecutionApprovalEvidenceIngestorPacket: true,
      rendersRuntimeExecutionFinalGate: true,
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
      runtimeExecutionFinalGateOnly: true,
      sourceOnlyNoLive: true,
      acceptedEvidenceDoesNotAuthorizeRuntime: true,
      finalGateDoesNotWriteConfig: true,
      finalGateDoesNotEnableDefaultOn: true,
      finalGateDoesNotRestartSidecar: true,
      finalGateDoesNotDispatchExecutor: true,
      finalGateDoesNotInvokeExecutor: true,
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

export function extractTerminalBriefSidecarDefaultOnRuntimeExecutionFinalGateEvidence(
  input: unknown,
): TerminalBriefSidecarDefaultOnExecutionApprovalEvidenceIngestorPacket {
  const envelope = isRecord(input) ? input : {};
  const candidates = [
    input,
    envelope.defaultOnExecutionApprovalEvidenceIngestorPacket,
    envelope.executionApprovalEvidenceIngestorPacket,
    envelope.runtimeExecutionEvidence,
    envelope.executionApprovalEvidence,
    envelope.packet,
  ];
  const packet = candidates.find(isExecutionApprovalEvidencePacket);
  if (!packet) throw new Error("expected a Terminal Brief sidecar default-on execution approval evidence ingestor packet");
  return packet;
}

export function extractTerminalBriefSidecarDefaultOnRuntimeExecutionFinalGateOptions(
  input: unknown,
): TerminalBriefSidecarDefaultOnRuntimeExecutionFinalGateOptions {
  const envelope = isRecord(input) ? input : {};
  const options = isRecord(envelope.defaultOnRuntimeExecutionFinalGate)
    ? envelope.defaultOnRuntimeExecutionFinalGate
    : isRecord(envelope.runtimeExecutionFinalGate)
      ? envelope.runtimeExecutionFinalGate
      : isRecord(envelope.options)
        ? envelope.options
        : {};
  return options as TerminalBriefSidecarDefaultOnRuntimeExecutionFinalGateOptions;
}

export function renderTerminalBriefSidecarDefaultOnRuntimeExecutionFinalGateMarkdown(
  packet: TerminalBriefSidecarDefaultOnRuntimeExecutionFinalGatePacket,
): string {
  return [
    titleForState(packet.state),
    "Mode: " + packet.mode,
    "State: " + packet.state + " sourceOnlyNoLive=" + packet.sourceOnlyNoLive,
    "Idempotency: " + packet.idempotencyKey,
    "Source evidence: state=" + packet.source.executionApprovalEvidenceState
      + " receiptAccepted=" + packet.source.receiptEvidenceAccepted
      + " approvalAccepted=" + packet.source.approvalEvidenceAccepted,
    "Runtime target: " + packet.source.runtimeTarget
      + " configKey=" + packet.source.configKey
      + " proposedValue=" + packet.source.proposedValue
      + " executorId=" + packet.source.executorId,
    "Final gate: reference=" + packet.finalGate.executionGateReference
      + " gateReady=" + packet.finalGate.gateReady
      + " reviewOnly=" + packet.finalGate.reviewOnly,
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
    "Safety: runtime execution final gate only; does not write config, enable default-on, restart sidecar, dispatch/invoke executor, spawn a process, send providers, ACK/replay terminal rows, mutate GitHub/DB/TaskFlow state, restart Gateway/broker, release, publish, or move secrets.",
  ].join("\n");
}

function sourceBlockers(evidence: TerminalBriefSidecarDefaultOnExecutionApprovalEvidenceIngestorPacket): string[] {
  return unique([
    ...evidence.blockers,
    ...(evidence.state !== "accepted" ? ["execution approval evidence state is " + evidence.state] : []),
    ...(!evidence.receiptEvidenceAccepted ? ["receipt evidence is not accepted"] : []),
    ...(!evidence.approvalEvidenceAccepted ? ["approval evidence is not accepted"] : []),
    ...(evidence.classification.providerAcceptedIsVisibilityProof !== false ? ["provider accepted unexpectedly acts as visibility proof"] : []),
    ...(evidence.classification.approvalGrantEvidenceExecutesGrant !== false ? ["approval grant evidence unexpectedly executes grant"] : []),
    ...(evidence.readiness.executionApprovalRequestDispatchPermitted !== false ? ["evidence unexpectedly permits approval request dispatch"] : []),
    ...(evidence.readiness.approvalGrantPermitted !== false ? ["evidence unexpectedly permits approval grant"] : []),
    ...(evidence.readiness.runtimeMutationPermitted !== false ? ["evidence unexpectedly permits runtime mutation"] : []),
    ...(evidence.readiness.configWritePermitted !== false ? ["evidence unexpectedly permits config write"] : []),
    ...(evidence.readiness.defaultOnPermitted !== false ? ["evidence unexpectedly permits default-on"] : []),
    ...(evidence.readiness.sidecarRestartPermitted !== false ? ["evidence unexpectedly permits sidecar restart"] : []),
    ...(evidence.readiness.providerSendPermitted !== false ? ["evidence unexpectedly permits provider send"] : []),
    ...(evidence.readiness.terminalAckPermitted !== false ? ["evidence unexpectedly permits terminal ACK"] : []),
    ...(evidence.readiness.dbMutationPermitted !== false ? ["evidence unexpectedly permits DB mutation"] : []),
    ...(evidence.readiness.taskFlowMutationPermitted !== false ? ["evidence unexpectedly permits TaskFlow mutation"] : []),
    ...(evidence.readiness.executionPermitted !== false ? ["evidence unexpectedly permits execution"] : []),
    ...(evidence.readiness.processSpawnPermitted !== false ? ["evidence unexpectedly permits process spawn"] : []),
    ...(evidence.readiness.sidecarStartPermitted !== false ? ["evidence unexpectedly permits sidecar start"] : []),
    ...(evidence.readiness.brokerRestartPermitted !== false ? ["evidence unexpectedly permits broker restart"] : []),
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
    ...(evidence.integrationContract.executesAction ? ["evidence unexpectedly executes action"] : []),
    ...(evidence.semantics.executionApprovalEvidenceDoesNotWriteConfig !== true ? ["evidence does not preserve config boundary"] : []),
    ...(evidence.semantics.executionApprovalEvidenceDoesNotEnableDefaultOn !== true ? ["evidence does not preserve default-on boundary"] : []),
    ...(evidence.semantics.executionApprovalEvidenceDoesNotRestartSidecar !== true ? ["evidence does not preserve sidecar restart boundary"] : []),
    ...(evidence.semantics.performsProviderSend ? ["evidence unexpectedly performs provider send"] : []),
    ...(evidence.semantics.performsTerminalAck ? ["evidence unexpectedly performs terminal ACK"] : []),
    ...(evidence.semantics.performsRuntimeRestartOrDeploy ? ["evidence unexpectedly performs runtime restart/deploy"] : []),
    ...(evidence.semantics.performsDbMutation ? ["evidence unexpectedly performs DB mutation"] : []),
    ...(evidence.semantics.createsTaskFlowRecords ? ["evidence unexpectedly creates TaskFlow records"] : []),
    ...(evidence.semantics.movesSecretsOrCredentials ? ["evidence unexpectedly moves secrets/credentials"] : []),
  ].filter(Boolean));
}

function stateFor(
  evidence: TerminalBriefSidecarDefaultOnExecutionApprovalEvidenceIngestorPacket,
  blockers: string[],
): TerminalBriefSidecarDefaultOnRuntimeExecutionFinalGateState {
  if (evidence.state === "rejected") return "approval_rejected";
  if (evidence.state === "stale") return "stale";
  if (evidence.state === "conflicting") return "conflicting";
  if (evidence.state !== "accepted") return "waiting_for_execution_approval_evidence";
  if (blockers.length) return "blocked";
  return "ready_for_runtime_execution_final_review";
}

function missingEvidence(evidence: TerminalBriefSidecarDefaultOnExecutionApprovalEvidenceIngestorPacket): string[] {
  return unique([
    ...(evidence.state !== "accepted" ? ["accepted_execution_approval_evidence"] : []),
    ...(!evidence.receiptEvidenceAccepted ? ["receipt_evidence_accepted"] : []),
    ...(!evidence.approvalEvidenceAccepted ? ["approval_evidence_accepted"] : []),
  ]);
}

function prerequisites(
  evidence: TerminalBriefSidecarDefaultOnExecutionApprovalEvidenceIngestorPacket,
  ready: boolean,
): TerminalBriefSidecarDefaultOnRuntimeExecutionFinalGatePacket["finalGate"]["prerequisites"] {
  const status = ready ? "ready" as const : "blocked" as const;
  const row = (id: string, evidenceRows: string[]) => ({ id, status, evidence: evidenceRows, permitsRuntimeAction: false as const });
  return [
    row("accepted_execution_approval_evidence", [evidence.idempotencyKey, "state=" + evidence.state]),
    row("receipt_and_approval", ["receiptEvidenceAccepted=" + evidence.receiptEvidenceAccepted, "approvalEvidenceAccepted=" + evidence.approvalEvidenceAccepted]),
    row("target_identity", [evidence.source.runtimeTarget, evidence.source.configKey, evidence.source.executorId]),
    row("runtime_action_boundary", ["configWritePermitted=false", "defaultOnPermitted=false", "sidecarRestartPermitted=false", "executionPermitted=false"]),
    row("terminal_boundary", ["providerSendPermitted=false", "terminalAckPermitted=false"]),
    row("state_boundary", ["dbMutationPermitted=false", "taskFlowMutationPermitted=false"]),
  ];
}

function nextActionFor(state: TerminalBriefSidecarDefaultOnRuntimeExecutionFinalGateState): string {
  if (state === "ready_for_runtime_execution_final_review") return "broker finalizer may review this source-only final gate before any later separately approved runtime executor";
  if (state === "approval_rejected") return "stop this default-on execution path unless a new operator approval is requested";
  if (state === "stale") return "refresh execution approval evidence before runtime final review";
  if (state === "conflicting") return "resolve conflicting execution approval evidence before runtime final review";
  if (state === "waiting_for_execution_approval_evidence") return "wait for accepted execution approval evidence";
  return "resolve blocked source evidence before runtime final review";
}

function nextActionsFor(state: TerminalBriefSidecarDefaultOnRuntimeExecutionFinalGateState): string[] {
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

function buildExecutionGateReference(evidence: TerminalBriefSidecarDefaultOnExecutionApprovalEvidenceIngestorPacket): string {
  return "tb-sidecar-default-on-runtime-execution-final-gate:" + createHash("sha256").update(evidence.idempotencyKey).digest("hex").slice(0, 16);
}

function buildIdempotencyKey(
  evidence: TerminalBriefSidecarDefaultOnExecutionApprovalEvidenceIngestorPacket,
  executionGateReference: string,
  generatedAt: string,
  state: TerminalBriefSidecarDefaultOnRuntimeExecutionFinalGateState,
): string {
  const base = JSON.stringify({
    label: "terminal-brief-sidecar-default-on-runtime-execution-final-gate",
    evidence: evidence.idempotencyKey,
    executionGateReference,
    generatedAt,
    state,
  });
  return "tb-sidecar-default-on-runtime-execution-final-gate:" + createHash("sha256").update(base).digest("hex").slice(0, 24);
}

function titleForState(state: TerminalBriefSidecarDefaultOnRuntimeExecutionFinalGateState): string {
  if (state === "ready_for_runtime_execution_final_review") return "Ready: Terminal Brief default-on runtime execution final gate";
  if (state === "approval_rejected") return "Rejected: Terminal Brief default-on runtime execution final gate";
  if (state === "stale") return "Stale: Terminal Brief default-on runtime execution final gate";
  if (state === "conflicting") return "Conflicting: Terminal Brief default-on runtime execution final gate";
  if (state === "waiting_for_execution_approval_evidence") return "Waiting: Terminal Brief default-on runtime execution final gate";
  return "Blocked: Terminal Brief default-on runtime execution final gate";
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function isExecutionApprovalEvidencePacket(
  value: unknown,
): value is TerminalBriefSidecarDefaultOnExecutionApprovalEvidenceIngestorPacket {
  return isRecord(value) && value.kind === "a2a-broker.terminal-brief-sidecar-default-on-execution-approval-evidence-ingestor.packet";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
