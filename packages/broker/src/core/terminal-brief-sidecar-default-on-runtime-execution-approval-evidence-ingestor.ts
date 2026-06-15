import { unique } from "./collections.js";
import { isRecord } from "./value-guards.js";
import { createHash } from "node:crypto";

import {
  extractTerminalBriefSidecarActivationReceiptEvidence,
  type TerminalBriefSidecarActivationReceiptEvidenceInput,
  type TerminalBriefSidecarActivationReceiptEvidenceKind,
  type TerminalBriefSidecarActivationReceiptEvidenceRecord,
} from "./terminal-brief-sidecar-activation-receipt-ingestor.js";
import {
  buildTerminalBriefSidecarDefaultOnRuntimeExecutionRequestDraft,
  extractTerminalBriefSidecarDefaultOnRuntimeExecutionRequestDraftFinalGate,
  extractTerminalBriefSidecarDefaultOnRuntimeExecutionRequestDraftOptions,
  type TerminalBriefSidecarDefaultOnRuntimeExecutionRequestDraftPacket,
} from "./terminal-brief-sidecar-default-on-runtime-execution-request-draft.js";
import { numberValue, optionalString } from "./value-text.js";

export type TerminalBriefSidecarDefaultOnRuntimeExecutionApprovalEvidenceIngestorState =
  | "accepted"
  | "insufficient"
  | "stale"
  | "conflicting"
  | "rejected"
  | "blocked";

export type TerminalBriefSidecarDefaultOnRuntimeExecutionApprovalEvidenceKind =
  TerminalBriefSidecarActivationReceiptEvidenceKind;

export type TerminalBriefSidecarDefaultOnRuntimeExecutionApprovalEvidenceInput =
  TerminalBriefSidecarActivationReceiptEvidenceInput;

export type TerminalBriefSidecarDefaultOnRuntimeExecutionApprovalEvidenceRecord =
  TerminalBriefSidecarActivationReceiptEvidenceRecord;

export interface TerminalBriefSidecarDefaultOnRuntimeExecutionApprovalEvidenceIngestorOptions {
  now?: string;
  mode?: string;
  maxAgeMs?: number;
}

export interface TerminalBriefSidecarDefaultOnRuntimeExecutionApprovalEvidenceIngestorPacket {
  kind: "a2a-broker.terminal-brief-sidecar-default-on-runtime-execution-approval-evidence-ingestor.packet";
  version: 1;
  generatedAt: string;
  mode: string;
  state: TerminalBriefSidecarDefaultOnRuntimeExecutionApprovalEvidenceIngestorState;
  dryRunOnly: false;
  sourceOnlyNoLive: true;
  receiptEvidenceAccepted: boolean;
  approvalEvidenceAccepted: boolean;
  idempotencyKey: string;
  source: {
    runtimeExecutionRequestDraftState: TerminalBriefSidecarDefaultOnRuntimeExecutionRequestDraftPacket["state"];
    runtimeExecutionRequestDraftIdempotencyKey: string;
    requestedAction: string;
    requestedBy: string;
    operatorTarget: string;
    operatorChannel?: string;
    executionRequestReference: string;
    dispatchRequired: boolean;
    dispatchPermitted: false;
    runtimeTarget: string;
    configKey: string;
    proposedValue: string;
    executorId: string;
  };
  evidence: {
    received: number;
    acceptedKinds: TerminalBriefSidecarDefaultOnRuntimeExecutionApprovalEvidenceKind[];
    staleKinds: TerminalBriefSidecarDefaultOnRuntimeExecutionApprovalEvidenceKind[];
    conflictingKinds: TerminalBriefSidecarDefaultOnRuntimeExecutionApprovalEvidenceKind[];
    rejectedKinds: TerminalBriefSidecarDefaultOnRuntimeExecutionApprovalEvidenceKind[];
    records: TerminalBriefSidecarDefaultOnRuntimeExecutionApprovalEvidenceRecord[];
  };
  classification: {
    providerAccepted: boolean;
    currentSessionVisible: boolean;
    manualOperatorConfirmed: boolean;
    approvalGrantAccepted: boolean;
    receiptProofAccepted: boolean;
    rejected: boolean;
    expired: boolean;
    stale: boolean;
    terminalAckEligible: boolean;
    providerAcceptedIsVisibilityProof: false;
    approvalGrantEvidenceExecutesGrant: false;
    reason: string;
  };
  readiness: {
    sourceCriteriaMet: boolean;
    receiptEvidenceAccepted: boolean;
    approvalEvidenceAccepted: boolean;
    runtimeExecutionRequestDispatchPermitted: false;
    approvalGrantPermitted: false;
    approvalGrantExecutionPermitted: false;
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
    blockers: string[];
    nextAction: string;
  };
  blockers: string[];
  nextActions: string[];
  approvalSensitiveActionsExcluded: string[];
  integrationContract: {
    transport: "json";
    evidenceSchemaVersion: 1;
    harnessNeutral: true;
    openclawMessageSendRequired: false;
    hermesAdapterCompatible: true;
    gongyungAdapterCompatible: true;
    consumesRuntimeExecutionRequestDraftPacket: true;
    providerAcceptedIsVisibilityProof: false;
    approvalGrantEvidenceExecutesGrant: false;
    terminalAckRequiresVisibilityProof: true;
    sendsExecutionRequest: false;
    grantsApproval: false;
    executesApprovalGrant: false;
    writesConfig: false;
    enablesDefaultOn: false;
    dispatchesStartExecutor: false;
    invokesExecutor: false;
    sendsProvider: false;
    performsTerminalAck: false;
    mutatesDb: false;
    mutatesTaskFlow: false;
    spawnsProcess: false;
    startsSidecar: false;
    restartsSidecar: false;
    restartsBroker: false;
    restartsGateway: false;
    executesAction: false;
  };
  semantics: {
    runtimeExecutionApprovalEvidenceIngestorOnly: true;
    sourceOnlyNoLive: true;
    evidenceDoesNotMutateState: true;
    providerAcceptedIsVisibilityProof: false;
    terminalAckEligibleDoesNotPermitAck: true;
    approvalGrantEvidenceDoesNotGrantApproval: true;
    approvalGrantEvidenceDoesNotExecuteGrant: true;
    runtimeExecutionApprovalEvidenceDoesNotWriteConfig: true;
    runtimeExecutionApprovalEvidenceDoesNotEnableDefaultOn: true;
    runtimeExecutionApprovalEvidenceDoesNotRestartSidecar: true;
    runtimeExecutionApprovalEvidenceDoesNotDispatchExecutor: true;
    runtimeExecutionApprovalEvidenceDoesNotInvokeExecutor: true;
    runtimeExecutionRequiresSeparateRuntimeExecutor: true;
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

interface EvidenceClassificationCore {
  providerAccepted: boolean;
  currentSessionVisible: boolean;
  manualOperatorConfirmed: boolean;
  approvalGrantAccepted: boolean;
  receiptProofAccepted: boolean;
  rejected: boolean;
  expired: boolean;
  stale: boolean;
}

export function buildTerminalBriefSidecarDefaultOnRuntimeExecutionApprovalEvidenceIngestor(
  request: TerminalBriefSidecarDefaultOnRuntimeExecutionRequestDraftPacket,
  evidenceInput: TerminalBriefSidecarDefaultOnRuntimeExecutionApprovalEvidenceInput[] = [],
  options: TerminalBriefSidecarDefaultOnRuntimeExecutionApprovalEvidenceIngestorOptions = {},
): TerminalBriefSidecarDefaultOnRuntimeExecutionApprovalEvidenceIngestorPacket {
  const generatedAt = options.now ?? new Date().toISOString();
  const nowMs = Date.parse(generatedAt);
  const maxAgeMs = Math.max(0, options.maxAgeMs ?? 5 * 60 * 1000);
  const records = evidenceInput.map((record) => normalizeEvidenceRecord(record, request, nowMs, maxAgeMs));
  const blockers = buildBlockers(request, records);
  const classification = classifyEvidence(records);
  const state = stateForClassification(request, classification, blockers, records);
  const receiptEvidenceAccepted = state === "accepted" && classification.receiptProofAccepted;
  const approvalEvidenceAccepted = state === "accepted" && classification.approvalGrantAccepted;
  const terminalAckEligible = state === "accepted" && classification.receiptProofAccepted;
  const readinessBlockers = [
    ...blockers,
    "approval grant evidence does not grant or execute approval in this ingestor",
    "runtime execution approval evidence still requires a separate runtime executor",
  ];

  return {
    kind: "a2a-broker.terminal-brief-sidecar-default-on-runtime-execution-approval-evidence-ingestor.packet",
    version: 1,
    generatedAt,
    mode: options.mode ?? request.mode,
    state,
    dryRunOnly: false,
    sourceOnlyNoLive: true,
    receiptEvidenceAccepted,
    approvalEvidenceAccepted,
    idempotencyKey: buildEvidenceIngestorIdempotencyKey(request, state, records, maxAgeMs),
    source: {
      runtimeExecutionRequestDraftState: request.state,
      runtimeExecutionRequestDraftIdempotencyKey: request.idempotencyKey,
      requestedAction: request.executionRequestDraft.requestedAction,
      requestedBy: request.executionRequestDraft.requestedBy,
      operatorTarget: request.executionRequestDraft.operatorTarget,
      operatorChannel: request.executionRequestDraft.operatorChannel,
      executionRequestReference: request.executionRequestDraft.executionRequestReference,
      dispatchRequired: request.executionRequestDraft.dispatchRequired,
      dispatchPermitted: false,
      runtimeTarget: request.source.runtimeTarget,
      configKey: request.source.configKey,
      proposedValue: request.source.proposedValue,
      executorId: request.source.executorId,
    },
    evidence: {
      received: records.length,
      acceptedKinds: unique(records.filter((record) => !record.stale && !record.conflict && isStrongEvidenceKind(record.kind)).map((record) => record.kind)),
      staleKinds: unique(records.filter((record) => record.stale).map((record) => record.kind)),
      conflictingKinds: unique(records.filter((record) => record.conflict || record.kind === "conflict").map((record) => record.kind)),
      rejectedKinds: unique(records.filter((record) => isNegativeKind(record.kind)).map((record) => record.kind)),
      records,
    },
    classification: {
      ...classification,
      terminalAckEligible,
      providerAcceptedIsVisibilityProof: false,
      approvalGrantEvidenceExecutesGrant: false,
      reason: reasonForState(state, classification, blockers, records),
    },
    readiness: {
      sourceCriteriaMet: state === "accepted",
      receiptEvidenceAccepted,
      approvalEvidenceAccepted,
      runtimeExecutionRequestDispatchPermitted: false,
      approvalGrantPermitted: false,
      approvalGrantExecutionPermitted: false,
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
      blockers: readinessBlockers,
      nextAction: state === "accepted"
        ? "feed accepted no-live runtime execution approval evidence into a separate runtime executor gate"
        : "collect non-conflicting visibility/manual receipt and matching runtime execution approval grant evidence",
    },
    blockers,
    nextActions: nextActionsForState(state),
    approvalSensitiveActionsExcluded: approvalSensitiveActionsExcluded(),
    integrationContract: {
      transport: "json",
      evidenceSchemaVersion: 1,
      harnessNeutral: true,
      openclawMessageSendRequired: false,
      hermesAdapterCompatible: true,
      gongyungAdapterCompatible: true,
      consumesRuntimeExecutionRequestDraftPacket: true,
      providerAcceptedIsVisibilityProof: false,
      approvalGrantEvidenceExecutesGrant: false,
      terminalAckRequiresVisibilityProof: true,
      sendsExecutionRequest: false,
      grantsApproval: false,
      executesApprovalGrant: false,
      writesConfig: false,
      enablesDefaultOn: false,
      dispatchesStartExecutor: false,
      invokesExecutor: false,
      sendsProvider: false,
      performsTerminalAck: false,
      mutatesDb: false,
      mutatesTaskFlow: false,
      spawnsProcess: false,
      startsSidecar: false,
      restartsSidecar: false,
      restartsBroker: false,
      restartsGateway: false,
      executesAction: false,
    },
    semantics: {
      runtimeExecutionApprovalEvidenceIngestorOnly: true,
      sourceOnlyNoLive: true,
      evidenceDoesNotMutateState: true,
      providerAcceptedIsVisibilityProof: false,
      terminalAckEligibleDoesNotPermitAck: true,
      approvalGrantEvidenceDoesNotGrantApproval: true,
      approvalGrantEvidenceDoesNotExecuteGrant: true,
      runtimeExecutionApprovalEvidenceDoesNotWriteConfig: true,
      runtimeExecutionApprovalEvidenceDoesNotEnableDefaultOn: true,
      runtimeExecutionApprovalEvidenceDoesNotRestartSidecar: true,
      runtimeExecutionApprovalEvidenceDoesNotDispatchExecutor: true,
      runtimeExecutionApprovalEvidenceDoesNotInvokeExecutor: true,
      runtimeExecutionRequiresSeparateRuntimeExecutor: true,
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

export function extractTerminalBriefSidecarDefaultOnRuntimeExecutionRequestDraftPacket(
  input: unknown,
): TerminalBriefSidecarDefaultOnRuntimeExecutionRequestDraftPacket {
  const envelope = isRecord(input) ? input : {};
  const candidates = [
    input,
    envelope.defaultOnRuntimeExecutionRequestDraft,
    envelope.defaultOnRuntimeExecutionRequestDraftPacket,
    envelope.runtimeExecutionRequestDraft,
    envelope.runtimeExecutionRequestDraftPacket,
    envelope.executionRequestDraft,
    envelope.packet,
  ];
  const packet = candidates.find(isTerminalBriefSidecarDefaultOnRuntimeExecutionRequestDraftPacket);
  if (packet) return packet;

  try {
    return buildTerminalBriefSidecarDefaultOnRuntimeExecutionRequestDraft(
      extractTerminalBriefSidecarDefaultOnRuntimeExecutionRequestDraftFinalGate(input),
      extractTerminalBriefSidecarDefaultOnRuntimeExecutionRequestDraftOptions(input),
    );
  } catch {
    throw new Error("expected a Terminal Brief sidecar default-on runtime execution request draft packet");
  }
}

export const extractTerminalBriefSidecarDefaultOnRuntimeExecutionApprovalEvidence =
  extractTerminalBriefSidecarActivationReceiptEvidence;

export function extractTerminalBriefSidecarDefaultOnRuntimeExecutionApprovalEvidenceIngestorOptions(
  input: unknown,
): TerminalBriefSidecarDefaultOnRuntimeExecutionApprovalEvidenceIngestorOptions {
  const envelope = isRecord(input) ? input : {};
  const options = isRecord(envelope.defaultOnRuntimeExecutionApprovalEvidenceIngestor)
    ? envelope.defaultOnRuntimeExecutionApprovalEvidenceIngestor
    : isRecord(envelope.runtimeExecutionApprovalEvidenceIngestor)
      ? envelope.runtimeExecutionApprovalEvidenceIngestor
      : isRecord(envelope.evidenceIngestor)
        ? envelope.evidenceIngestor
        : isRecord(envelope.options)
          ? envelope.options
          : {};
  return {
    now: optionalString(options.now),
    mode: optionalString(options.mode),
    maxAgeMs: numberValue(options.maxAgeMs ?? options.max_age_ms),
  };
}

export function renderTerminalBriefSidecarDefaultOnRuntimeExecutionApprovalEvidenceIngestorMarkdown(
  packet: TerminalBriefSidecarDefaultOnRuntimeExecutionApprovalEvidenceIngestorPacket,
): string {
  return [
    titleForState(packet.state),
    "Mode: " + packet.mode,
    "State: " + packet.state + " sourceOnlyNoLive=" + packet.sourceOnlyNoLive,
    "Idempotency: " + packet.idempotencyKey,
    "Runtime execution request draft: state=" + packet.source.runtimeExecutionRequestDraftState
      + " requestedAction=" + packet.source.requestedAction
      + " dispatchPermitted=" + packet.source.dispatchPermitted
      + " executionRequestReference=" + packet.source.executionRequestReference,
    "Runtime target: " + packet.source.runtimeTarget
      + " configKey=" + packet.source.configKey
      + " proposedValue=" + packet.source.proposedValue
      + " executorId=" + packet.source.executorId,
    "Evidence: received=" + packet.evidence.received
      + " acceptedKinds=" + list(packet.evidence.acceptedKinds)
      + " staleKinds=" + list(packet.evidence.staleKinds)
      + " conflictingKinds=" + list(packet.evidence.conflictingKinds)
      + " rejectedKinds=" + list(packet.evidence.rejectedKinds),
    "Classification: providerAccepted=" + packet.classification.providerAccepted
      + " currentSessionVisible=" + packet.classification.currentSessionVisible
      + " manualOperatorConfirmed=" + packet.classification.manualOperatorConfirmed
      + " approvalGrantAccepted=" + packet.classification.approvalGrantAccepted
      + " receiptProofAccepted=" + packet.classification.receiptProofAccepted
      + " terminalAckEligible=" + packet.classification.terminalAckEligible
      + " terminalAckPermitted=" + packet.readiness.terminalAckPermitted
      + " configWritePermitted=" + packet.readiness.configWritePermitted
      + " defaultOnPermitted=" + packet.readiness.defaultOnPermitted
      + " sidecarRestartPermitted=" + packet.readiness.sidecarRestartPermitted
      + " executorInvocationPermitted=" + packet.readiness.executorInvocationPermitted
      + " executionPermitted=" + packet.readiness.executionPermitted,
    "Reason: " + packet.classification.reason,
    "Harness contract: JSON transport; providerAcceptedIsVisibilityProof=false; approvalGrantEvidenceExecutesGrant=false; sendsExecutionRequest=false; grantsApproval=false; writesConfig=false; enablesDefaultOn=false; restartsSidecar=false; dispatchesStartExecutor=false; invokesExecutor=false; mutatesDb=false; executesAction=false.",
    ...(packet.blockers.length ? ["", "Blockers:", ...packet.blockers.map((blocker) => "- " + blocker)] : []),
    "",
    "Next actions:",
    ...packet.nextActions.map((action) => "- " + action),
    "",
    "Safety: runtime execution approval evidence ingestor only; evidence does not mutate state; provider accepted is not visibility proof; terminalAckEligible never permits ACK here; approval grant evidence does not grant or execute approval; config is not written; default-on is not enabled; no live send, terminal ACK/replay, process spawn, executor dispatch/invocation, sidecar restart/deploy, DB mutation, TaskFlow record creation, historical replay, release, or secret movement.",
  ].join("\n");
}

function normalizeEvidenceRecord(
  input: TerminalBriefSidecarDefaultOnRuntimeExecutionApprovalEvidenceInput,
  request: TerminalBriefSidecarDefaultOnRuntimeExecutionRequestDraftPacket,
  nowMs: number,
  maxAgeMs: number,
): TerminalBriefSidecarDefaultOnRuntimeExecutionApprovalEvidenceRecord {
  const rawKind = optionalString(input.kind ?? input.status);
  const kind = normalizeEvidenceKind(rawKind);
  const observedAt = optionalString(input.observedAt ?? input.observed_at);
  const expiresAt = optionalString(input.expiresAt ?? input.expires_at);
  const action = optionalString(input.action);
  const approvedAction = optionalString(input.approvedAction ?? input.approved_action);
  const target = optionalString(input.target);
  const approvedTarget = optionalString(input.approvedTarget ?? input.approved_target);
  const stale = isStale(kind, observedAt, expiresAt, nowMs, maxAgeMs);
  const conflict = kind === "conflict" || conflictsWithRuntimeExecutionRequest(kind, request, { action, approvedAction, target, approvedTarget });
  return {
    kind,
    rawKind,
    observedAt,
    expiresAt,
    receiptId: optionalString(input.receiptId ?? input.receipt_id),
    providerMessageId: optionalString(input.providerMessageId ?? input.provider_message_id),
    target,
    channel: optionalString(input.channel),
    action,
    approvedAction,
    approvedTarget,
    operatorId: optionalString(input.operatorId ?? input.operator_id),
    currentSessionId: optionalString(input.currentSessionId ?? input.current_session_id),
    source: optionalString(input.source),
    note: optionalString(input.note),
    stale,
    conflict,
    reason: reasonForRecord(kind, stale, conflict),
  };
}

function normalizeEvidenceKind(value?: string): TerminalBriefSidecarDefaultOnRuntimeExecutionApprovalEvidenceKind {
  const raw = value?.trim().toLowerCase().replace(/[-\s]+/g, "_");
  if (!raw) return "unknown";
  if (["provider_accepted", "provider_sent", "sent", "delivered", "produced"].includes(raw)) return "provider_accepted";
  if (["current_session_visible", "current_session", "visible", "operator_visible", "read_visible"].includes(raw)) return "current_session_visible";
  if (["manual_operator_confirmation", "manual_operator_receipt", "operator_confirmed", "manual_confirmed"].includes(raw)) return "manual_operator_confirmation";
  if (["approval_grant", "approval_granted", "approved"].includes(raw)) return "approval_grant";
  if (["rejected", "denied", "approval_rejected"].includes(raw)) return "rejected";
  if (["expired", "timed_out", "timeout"].includes(raw)) return "expired";
  if (["conflict", "conflicting", "mismatch"].includes(raw)) return "conflict";
  return "unknown";
}

function isStale(
  kind: TerminalBriefSidecarDefaultOnRuntimeExecutionApprovalEvidenceKind,
  observedAt: string | undefined,
  expiresAt: string | undefined,
  nowMs: number,
  maxAgeMs: number,
): boolean {
  if (kind === "expired") return true;
  const expiresAtMs = expiresAt ? Date.parse(expiresAt) : Number.NaN;
  if (Number.isFinite(expiresAtMs) && expiresAtMs <= nowMs) return true;
  const observedAtMs = observedAt ? Date.parse(observedAt) : Number.NaN;
  if (Number.isFinite(observedAtMs) && nowMs - observedAtMs > maxAgeMs) return true;
  return false;
}

function conflictsWithRuntimeExecutionRequest(
  kind: TerminalBriefSidecarDefaultOnRuntimeExecutionApprovalEvidenceKind,
  request: TerminalBriefSidecarDefaultOnRuntimeExecutionRequestDraftPacket,
  fields: { action?: string; approvedAction?: string; target?: string; approvedTarget?: string },
): boolean {
  if (kind !== "approval_grant") return false;
  const expectedAction = request.executionRequestDraft.requestedAction;
  const validTargets = new Set([
    request.executionRequestDraft.operatorTarget,
    request.executionRequestDraft.executionRequestReference,
  ]);
  const actualAction = fields.approvedAction ?? fields.action;
  const actualTarget = fields.approvedTarget ?? fields.target;
  if (actualAction && actualAction !== expectedAction) return true;
  if (actualTarget && !validTargets.has(actualTarget)) return true;
  return false;
}

function buildBlockers(
  request: TerminalBriefSidecarDefaultOnRuntimeExecutionRequestDraftPacket,
  records: TerminalBriefSidecarDefaultOnRuntimeExecutionApprovalEvidenceRecord[],
): string[] {
  return unique([
    ...request.blockers,
    ...(request.state !== "runtime_execution_request_draft_ready" ? ["runtime execution request draft packet is " + request.state] : []),
    ...(request.executionRequestDraft.status !== "draft_not_sent" ? ["runtime execution request draft is not ready"] : []),
    ...(request.executionRequestDraft.dispatchPermitted !== false ? ["runtime execution request unexpectedly permits dispatch"] : []),
    ...(request.executionRequestDraft.approvalGrantPermitted !== false ? ["runtime execution request unexpectedly permits approval grant"] : []),
    ...(request.executionRequestDraft.runtimeMutationPermitted !== false ? ["runtime execution request unexpectedly permits runtime mutation"] : []),
    ...(request.executionRequestDraft.configWritePermitted !== false ? ["runtime execution request unexpectedly permits config write"] : []),
    ...(request.executionRequestDraft.defaultOnPermitted !== false ? ["runtime execution request unexpectedly permits default-on"] : []),
    ...(request.executionRequestDraft.sidecarRestartPermitted !== false ? ["runtime execution request unexpectedly permits sidecar restart"] : []),
    ...(request.executionRequestDraft.providerSendPermitted !== false ? ["runtime execution request unexpectedly permits provider send"] : []),
    ...(request.executionRequestDraft.terminalAckPermitted !== false ? ["runtime execution request unexpectedly permits terminal ACK"] : []),
    ...(request.executionRequestDraft.dbMutationPermitted !== false ? ["runtime execution request unexpectedly permits DB mutation"] : []),
    ...(request.executionRequestDraft.taskFlowMutationPermitted !== false ? ["runtime execution request unexpectedly permits TaskFlow mutation"] : []),
    ...(request.executionRequestDraft.startExecutorDispatchPermitted !== false ? ["runtime execution request unexpectedly permits start executor dispatch"] : []),
    ...(request.executionRequestDraft.executorInvocationPermitted !== false ? ["runtime execution request unexpectedly permits executor invocation"] : []),
    ...(request.executionRequestDraft.executionPermitted !== false ? ["runtime execution request unexpectedly permits execution"] : []),
    ...(request.executionRequestDraft.processSpawnPermitted !== false ? ["runtime execution request unexpectedly permits process spawn"] : []),
    ...(request.executionRequestDraft.sidecarStartPermitted !== false ? ["runtime execution request unexpectedly permits sidecar start"] : []),
    ...(request.executionRequestDraft.brokerRestartPermitted !== false ? ["runtime execution request unexpectedly permits broker restart"] : []),
    ...(request.executionRequestDraft.gatewayRestartPermitted !== false ? ["runtime execution request unexpectedly permits Gateway restart"] : []),
    ...(request.readiness.runtimeExecutionRequestDispatchPermitted !== false ? ["runtime execution request readiness unexpectedly permits request dispatch"] : []),
    ...(request.readiness.approvalGrantPermitted !== false ? ["runtime execution request readiness unexpectedly permits approval grant"] : []),
    ...(request.readiness.runtimeMutationPermitted !== false ? ["runtime execution request readiness unexpectedly permits runtime mutation"] : []),
    ...(request.readiness.configWritePermitted !== false ? ["runtime execution request readiness unexpectedly permits config write"] : []),
    ...(request.readiness.defaultOnPermitted !== false ? ["runtime execution request readiness unexpectedly permits default-on"] : []),
    ...(request.readiness.sidecarRestartPermitted !== false ? ["runtime execution request readiness unexpectedly permits sidecar restart"] : []),
    ...(request.readiness.providerSendPermitted !== false ? ["runtime execution request readiness unexpectedly permits provider send"] : []),
    ...(request.readiness.terminalAckPermitted !== false ? ["runtime execution request readiness unexpectedly permits terminal ACK"] : []),
    ...(request.readiness.dbMutationPermitted !== false ? ["runtime execution request readiness unexpectedly permits DB mutation"] : []),
    ...(request.readiness.taskFlowMutationPermitted !== false ? ["runtime execution request readiness unexpectedly permits TaskFlow mutation"] : []),
    ...(request.readiness.startExecutorDispatchPermitted !== false ? ["runtime execution request readiness unexpectedly permits start executor dispatch"] : []),
    ...(request.readiness.executorInvocationPermitted !== false ? ["runtime execution request readiness unexpectedly permits executor invocation"] : []),
    ...(request.readiness.executionPermitted !== false ? ["runtime execution request readiness unexpectedly permits execution"] : []),
    ...(request.readiness.processSpawnPermitted !== false ? ["runtime execution request readiness unexpectedly permits process spawn"] : []),
    ...(request.readiness.sidecarStartPermitted !== false ? ["runtime execution request readiness unexpectedly permits sidecar start"] : []),
    ...(request.readiness.sidecarRestartPermitted !== false ? ["runtime execution request readiness unexpectedly permits sidecar restart"] : []),
    ...(request.readiness.brokerRestartPermitted !== false ? ["runtime execution request readiness unexpectedly permits broker restart"] : []),
    ...(request.readiness.gatewayRestartPermitted !== false ? ["runtime execution request readiness unexpectedly permits Gateway restart"] : []),
    ...(request.integrationContract.sendsExecutionRequest ? ["runtime execution request unexpectedly sends request"] : []),
    ...(request.integrationContract.grantsApproval ? ["runtime execution request unexpectedly grants approval"] : []),
    ...(request.integrationContract.executesApprovalGrant ? ["runtime execution request unexpectedly executes approval grant"] : []),
    ...(request.integrationContract.writesConfig ? ["runtime execution request unexpectedly writes config"] : []),
    ...(request.integrationContract.enablesDefaultOn ? ["runtime execution request unexpectedly enables default-on"] : []),
    ...(request.integrationContract.dispatchesStartExecutor ? ["runtime execution request unexpectedly dispatches start executor"] : []),
    ...(request.integrationContract.invokesExecutor ? ["runtime execution request unexpectedly invokes executor"] : []),
    ...(request.integrationContract.sendsProvider ? ["runtime execution request unexpectedly sends provider"] : []),
    ...(request.integrationContract.performsTerminalAck ? ["runtime execution request unexpectedly performs terminal ACK"] : []),
    ...(request.integrationContract.mutatesDb ? ["runtime execution request unexpectedly mutates DB"] : []),
    ...(request.integrationContract.mutatesTaskFlow ? ["runtime execution request unexpectedly mutates TaskFlow"] : []),
    ...(request.integrationContract.spawnsProcess ? ["runtime execution request unexpectedly spawns process"] : []),
    ...(request.integrationContract.startsSidecar ? ["runtime execution request unexpectedly starts sidecar"] : []),
    ...(request.integrationContract.restartsSidecar ? ["runtime execution request unexpectedly restarts sidecar"] : []),
    ...(request.integrationContract.restartsBroker ? ["runtime execution request unexpectedly restarts broker"] : []),
    ...(request.integrationContract.restartsGateway ? ["runtime execution request unexpectedly restarts Gateway"] : []),
    ...(request.integrationContract.executesAction ? ["runtime execution request unexpectedly executes action"] : []),
    ...(request.semantics.requestDraftIsNotSend !== true ? ["runtime execution request does not preserve draft-only boundary"] : []),
    ...(request.semantics.requestDoesNotGrantApproval !== true ? ["runtime execution request does not preserve no-grant boundary"] : []),
    ...(request.semantics.requestDoesNotExecuteRuntimeMutation !== true ? ["runtime execution request does not preserve no-mutation boundary"] : []),
    ...(request.semantics.requestDoesNotWriteConfig !== true ? ["runtime execution request does not preserve config boundary"] : []),
    ...(request.semantics.requestDoesNotEnableDefaultOn !== true ? ["runtime execution request does not preserve default-on boundary"] : []),
    ...(request.semantics.requestDoesNotRestartSidecar !== true ? ["runtime execution request does not preserve restart boundary"] : []),
    ...(request.semantics.requestDoesNotDispatchExecutor !== true ? ["runtime execution request does not preserve executor dispatch boundary"] : []),
    ...(request.semantics.requestDoesNotInvokeExecutor !== true ? ["runtime execution request does not preserve executor invocation boundary"] : []),
    ...(request.semantics.performsProviderSend ? ["runtime execution request unexpectedly performs provider send"] : []),
    ...(request.semantics.performsTerminalAck ? ["runtime execution request unexpectedly performs terminal ACK"] : []),
    ...(request.semantics.performsRuntimeRestartOrDeploy ? ["runtime execution request unexpectedly performs restart/deploy"] : []),
    ...(request.semantics.performsDbMutation ? ["runtime execution request unexpectedly performs DB mutation"] : []),
    ...(request.semantics.createsTaskFlowRecords ? ["runtime execution request unexpectedly creates TaskFlow records"] : []),
    ...(request.semantics.performsHistoricalReplay ? ["runtime execution request unexpectedly performs historical replay"] : []),
    ...(request.semantics.performsReleaseOrPublish ? ["runtime execution request unexpectedly performs release/publish"] : []),
    ...(request.semantics.movesSecretsOrCredentials ? ["runtime execution request unexpectedly moves secrets/credentials"] : []),
    ...(records.some((record) => record.kind === "unknown") ? ["runtime execution approval evidence contains an unsupported kind"] : []),
  ].filter(Boolean));
}

function classifyEvidence(records: TerminalBriefSidecarDefaultOnRuntimeExecutionApprovalEvidenceRecord[]): EvidenceClassificationCore {
  const fresh = records.filter((record) => !record.stale && !record.conflict);
  const receiptProofAccepted = fresh.some((record) => record.kind === "current_session_visible" || record.kind === "manual_operator_confirmation");
  return {
    providerAccepted: fresh.some((record) => record.kind === "provider_accepted"),
    currentSessionVisible: fresh.some((record) => record.kind === "current_session_visible"),
    manualOperatorConfirmed: fresh.some((record) => record.kind === "manual_operator_confirmation"),
    approvalGrantAccepted: fresh.some((record) => record.kind === "approval_grant"),
    receiptProofAccepted,
    rejected: fresh.some((record) => record.kind === "rejected"),
    expired: records.some((record) => record.kind === "expired"),
    stale: records.some((record) => record.stale),
  };
}

function stateForClassification(
  request: TerminalBriefSidecarDefaultOnRuntimeExecutionRequestDraftPacket,
  classification: EvidenceClassificationCore,
  blockers: string[],
  records: TerminalBriefSidecarDefaultOnRuntimeExecutionApprovalEvidenceRecord[],
): TerminalBriefSidecarDefaultOnRuntimeExecutionApprovalEvidenceIngestorState {
  if (blockers.length > 0) return "blocked";
  if (request.state === "blocked") return "blocked";
  if (request.state !== "runtime_execution_request_draft_ready") return "insufficient";
  if (records.some((record) => record.conflict) || records.some((record) => record.kind === "conflict")) return "conflicting";
  if (hasFreshPositive(records) && classification.rejected) return "conflicting";
  if (classification.rejected) return "rejected";
  if (records.length > 0 && records.every((record) => record.stale)) return "stale";
  if (classification.receiptProofAccepted && classification.approvalGrantAccepted) return "accepted";
  return "insufficient";
}

function reasonForState(
  state: TerminalBriefSidecarDefaultOnRuntimeExecutionApprovalEvidenceIngestorState,
  classification: EvidenceClassificationCore,
  blockers: string[],
  records: TerminalBriefSidecarDefaultOnRuntimeExecutionApprovalEvidenceRecord[],
): string {
  if (state === "blocked" && blockers.length) return blockers[0];
  if (state === "accepted") return "operator-visible receipt proof and matching runtime execution approval grant evidence accepted as source-only evidence";
  if (state === "conflicting") return "receipt or runtime execution approval grant evidence conflicts with the execution request";
  if (state === "rejected") return "operator rejected runtime execution approval";
  if (state === "stale") return "runtime execution approval evidence is stale or expired";
  if (classification.providerAccepted && !classification.receiptProofAccepted) return "provider accepted is transport evidence only and is not visibility proof";
  if (classification.receiptProofAccepted && !classification.approvalGrantAccepted) return "visibility/manual receipt is present but matching runtime execution approval grant evidence is missing";
  if (!classification.receiptProofAccepted && classification.approvalGrantAccepted) return "approval grant evidence is present but operator-visible receipt proof is missing";
  if (records.length === 0) return "no runtime execution approval evidence supplied";
  return "runtime execution approval evidence is insufficient";
}

function reasonForRecord(
  kind: TerminalBriefSidecarDefaultOnRuntimeExecutionApprovalEvidenceKind,
  stale: boolean,
  conflict: boolean,
): string {
  if (conflict) return "evidence conflicts with requested runtime execution action or target";
  if (stale) return "evidence is stale or expired";
  if (kind === "provider_accepted") return "provider accepted is transport evidence only, not operator-visible proof";
  if (kind === "current_session_visible") return "current session visibility can satisfy receipt proof";
  if (kind === "manual_operator_confirmation") return "manual operator confirmation can satisfy receipt proof";
  if (kind === "approval_grant") return "approval grant evidence is source evidence only and does not grant or execute approval by itself";
  if (kind === "rejected") return "operator rejected approval";
  if (kind === "expired") return "approval evidence expired";
  if (kind === "conflict") return "explicit conflict marker";
  return "unsupported evidence kind";
}

function nextActionsForState(state: TerminalBriefSidecarDefaultOnRuntimeExecutionApprovalEvidenceIngestorState): string[] {
  if (state === "accepted") {
    return [
      "feed accepted no-live runtime execution approval evidence into a separate runtime executor gate",
      "keep config write, default-on enablement, sidecar restart, provider send, terminal ACK, deploy, and DB mutation behind separate runtime gates",
    ];
  }
  if (state === "insufficient") {
    return [
      "collect current-session-visible or manual operator confirmation plus matching runtime execution approval grant evidence",
      "do not treat provider accepted evidence as visibility proof or approval grant",
    ];
  }
  if (state === "stale") {
    return [
      "refresh receipt and approval evidence before runtime executor gate review",
      "do not execute default-on from stale approval evidence",
    ];
  }
  if (state === "conflicting") {
    return [
      "resolve conflicting receipt or approval evidence before runtime executor gate review",
      "rerun the ingestor with one coherent evidence set",
    ];
  }
  if (state === "rejected") {
    return [
      "do not enable Terminal Brief default-on",
      "collect a new execution request if the operator later changes the decision",
    ];
  }
  return [
    "recover blocked runtime execution request source or unsupported evidence before continuing",
    "do not use blocked evidence as runtime execution approval proof",
  ];
}

function approvalSensitiveActionsExcluded(): string[] {
  return [
    "sending the runtime execution request",
    "granting approval or executing an approval grant",
    "runtime config write or Terminal Brief default-on enablement",
    "Terminal Brief sidecar start/stop/restart",
    "live provider/Hermes/Gongyung/Telegram/OpenClaw send",
    "terminal ACK/replay or terminal receipt DB mutation",
    "process spawn, start executor dispatch, executor invocation, broker restart, or deploy",
    "GitHub PR merge, issue close, or comment post from the ingestor",
    "TaskFlow record creation or broker DB mutation",
    "historical replay, release, publish, or secret movement",
  ];
}

function hasFreshPositive(records: TerminalBriefSidecarDefaultOnRuntimeExecutionApprovalEvidenceRecord[]): boolean {
  return records.some((record) => !record.stale && !record.conflict && ["provider_accepted", "current_session_visible", "manual_operator_confirmation", "approval_grant"].includes(record.kind));
}

function isStrongEvidenceKind(kind: TerminalBriefSidecarDefaultOnRuntimeExecutionApprovalEvidenceKind): boolean {
  return kind === "current_session_visible" || kind === "manual_operator_confirmation" || kind === "approval_grant";
}

function isNegativeKind(kind: TerminalBriefSidecarDefaultOnRuntimeExecutionApprovalEvidenceKind): boolean {
  return kind === "rejected" || kind === "expired" || kind === "unknown";
}

function buildEvidenceIngestorIdempotencyKey(
  request: TerminalBriefSidecarDefaultOnRuntimeExecutionRequestDraftPacket,
  state: TerminalBriefSidecarDefaultOnRuntimeExecutionApprovalEvidenceIngestorState,
  records: TerminalBriefSidecarDefaultOnRuntimeExecutionApprovalEvidenceRecord[],
  maxAgeMs: number,
): string {
  const base = JSON.stringify({
    label: "terminal-brief-sidecar-default-on-runtime-execution-approval-evidence-ingestor",
    requestDraft: request.idempotencyKey,
    executionRequestReference: request.executionRequestDraft.executionRequestReference,
    records: records.map((record) => ({
      kind: record.kind,
      observedAt: record.observedAt,
      expiresAt: record.expiresAt,
      receiptId: record.receiptId,
      providerMessageId: record.providerMessageId,
      target: record.target,
      action: record.action,
      approvedAction: record.approvedAction,
      approvedTarget: record.approvedTarget,
      operatorId: record.operatorId,
      stale: record.stale,
      conflict: record.conflict,
    })),
    maxAgeMs,
    state,
  });
  return "tb-sidecar-default-on-runtime-execution-approval-evidence:" + createHash("sha256").update(base).digest("hex").slice(0, 24);
}

function titleForState(state: TerminalBriefSidecarDefaultOnRuntimeExecutionApprovalEvidenceIngestorState): string {
  if (state === "accepted") return "Accepted: Terminal Brief default-on runtime execution approval evidence";
  if (state === "insufficient") return "Insufficient: Terminal Brief default-on runtime execution approval evidence";
  if (state === "stale") return "Stale: Terminal Brief default-on runtime execution approval evidence";
  if (state === "conflicting") return "Conflicting: Terminal Brief default-on runtime execution approval evidence";
  if (state === "rejected") return "Rejected: Terminal Brief default-on runtime execution approval";
  return "Blocked: Terminal Brief default-on runtime execution approval evidence";
}

function list(items: unknown[]): string {
  return items.length ? items.join(",") : "none";
}

function isTerminalBriefSidecarDefaultOnRuntimeExecutionRequestDraftPacket(
  value: unknown,
): value is TerminalBriefSidecarDefaultOnRuntimeExecutionRequestDraftPacket {
  return isRecord(value) && value.kind === "a2a-broker.terminal-brief-sidecar-default-on-runtime-execution-request-draft.packet";
}

