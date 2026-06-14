import { unique } from "./collections.js";
import { isRecord } from "./value-guards.js";
import { createHash } from "node:crypto";

import {
  extractTerminalBriefSidecarActivationReceiptEvidence,
  type TerminalBriefSidecarActivationReceiptEvidenceInput,
  type TerminalBriefSidecarActivationReceiptEvidenceKind,
  type TerminalBriefSidecarActivationReceiptEvidenceRecord,
} from "./terminal-brief-sidecar-activation-receipt-ingestor.js";
import type { TerminalBriefSidecarDefaultOnExecutionApprovalRequestPacket } from "./terminal-brief-sidecar-default-on-execution-approval-request.js";
import { numberValue, optionalString } from "./value-text.js";

export type TerminalBriefSidecarDefaultOnExecutionApprovalEvidenceIngestorState =
  | "accepted"
  | "insufficient"
  | "stale"
  | "conflicting"
  | "rejected"
  | "blocked";

export type TerminalBriefSidecarDefaultOnExecutionApprovalEvidenceKind =
  TerminalBriefSidecarActivationReceiptEvidenceKind;

export type TerminalBriefSidecarDefaultOnExecutionApprovalEvidenceInput =
  TerminalBriefSidecarActivationReceiptEvidenceInput;

export type TerminalBriefSidecarDefaultOnExecutionApprovalEvidenceRecord =
  TerminalBriefSidecarActivationReceiptEvidenceRecord;

export interface TerminalBriefSidecarDefaultOnExecutionApprovalEvidenceIngestorOptions {
  now?: string;
  mode?: string;
  maxAgeMs?: number;
}

export interface TerminalBriefSidecarDefaultOnExecutionApprovalEvidenceIngestorPacket {
  kind: "a2a-broker.terminal-brief-sidecar-default-on-execution-approval-evidence-ingestor.packet";
  version: 1;
  generatedAt: string;
  mode: string;
  state: TerminalBriefSidecarDefaultOnExecutionApprovalEvidenceIngestorState;
  dryRunOnly: false;
  sourceOnlyNoLive: true;
  receiptEvidenceAccepted: boolean;
  approvalEvidenceAccepted: boolean;
  idempotencyKey: string;
  source: {
    executionApprovalRequestState: TerminalBriefSidecarDefaultOnExecutionApprovalRequestPacket["state"];
    executionApprovalRequestIdempotencyKey: string;
    requestedAction: TerminalBriefSidecarDefaultOnExecutionApprovalRequestPacket["approvalRequestDraft"]["requestedAction"];
    requestedBy: string;
    operatorTarget: string;
    operatorChannel?: string;
    approvalReference: string;
    dispatchRequired: boolean;
    dispatchPermitted: false;
    runtimeTarget: string;
    configKey: string;
    proposedValue: string;
    executorId: string;
  };
  evidence: {
    received: number;
    acceptedKinds: TerminalBriefSidecarDefaultOnExecutionApprovalEvidenceKind[];
    staleKinds: TerminalBriefSidecarDefaultOnExecutionApprovalEvidenceKind[];
    conflictingKinds: TerminalBriefSidecarDefaultOnExecutionApprovalEvidenceKind[];
    rejectedKinds: TerminalBriefSidecarDefaultOnExecutionApprovalEvidenceKind[];
    records: TerminalBriefSidecarDefaultOnExecutionApprovalEvidenceRecord[];
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
    executionApprovalRequestDispatchPermitted: false;
    approvalGrantPermitted: false;
    runtimeMutationPermitted: false;
    configWritePermitted: false;
    defaultOnPermitted: false;
    liveActivationPermitted: false;
    providerSendPermitted: false;
    terminalAckPermitted: false;
    dbMutationPermitted: false;
    taskFlowMutationPermitted: false;
    executionPermitted: false;
    processSpawnPermitted: false;
    sidecarStartPermitted: false;
    sidecarRestartPermitted: false;
    brokerRestartPermitted: false;
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
    consumesExecutionApprovalRequestPacket: true;
    providerAcceptedIsVisibilityProof: false;
    approvalGrantEvidenceExecutesGrant: false;
    terminalAckRequiresVisibilityProof: true;
    grantsApproval: false;
    writesConfig: false;
    enablesDefaultOn: false;
    sendsProvider: false;
    performsTerminalAck: false;
    mutatesDb: false;
    mutatesTaskFlow: false;
    spawnsProcess: false;
    startsSidecar: false;
    restartsSidecar: false;
    restartsBroker: false;
    executesAction: false;
  };
  semantics: {
    evidenceIngestorOnly: true;
    sourceOnlyNoLive: true;
    evidenceDoesNotMutateState: true;
    providerAcceptedIsVisibilityProof: false;
    terminalAckEligibleDoesNotPermitAck: true;
    approvalGrantEvidenceDoesNotGrantApproval: true;
    approvalGrantEvidenceDoesNotExecuteGrant: true;
    executionApprovalEvidenceDoesNotWriteConfig: true;
    executionApprovalEvidenceDoesNotEnableDefaultOn: true;
    executionApprovalEvidenceDoesNotRestartSidecar: true;
    executionRequiresSeparateRuntimeExecutor: true;
    executionNotPermitted: true;
    processSpawnNotPermitted: true;
    sidecarStartNotPermitted: true;
    sidecarRestartNotPermitted: true;
    brokerRestartNotPermitted: true;
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

export function buildTerminalBriefSidecarDefaultOnExecutionApprovalEvidenceIngestor(
  request: TerminalBriefSidecarDefaultOnExecutionApprovalRequestPacket,
  evidenceInput: TerminalBriefSidecarDefaultOnExecutionApprovalEvidenceInput[] = [],
  options: TerminalBriefSidecarDefaultOnExecutionApprovalEvidenceIngestorOptions = {},
): TerminalBriefSidecarDefaultOnExecutionApprovalEvidenceIngestorPacket {
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
    "execution approval evidence still requires a separate runtime executor gate",
  ];

  return {
    kind: "a2a-broker.terminal-brief-sidecar-default-on-execution-approval-evidence-ingestor.packet",
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
      executionApprovalRequestState: request.state,
      executionApprovalRequestIdempotencyKey: request.idempotencyKey,
      requestedAction: request.approvalRequestDraft.requestedAction,
      requestedBy: request.approvalRequestDraft.requestedBy,
      operatorTarget: request.approvalRequestDraft.operatorTarget,
      operatorChannel: request.approvalRequestDraft.operatorChannel,
      approvalReference: request.approvalRequestDraft.approvalReference,
      dispatchRequired: request.approvalRequestDraft.dispatchRequired,
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
      executionApprovalRequestDispatchPermitted: false,
      approvalGrantPermitted: false,
      runtimeMutationPermitted: false,
      configWritePermitted: false,
      defaultOnPermitted: false,
      liveActivationPermitted: false,
      providerSendPermitted: false,
      terminalAckPermitted: false,
      dbMutationPermitted: false,
      taskFlowMutationPermitted: false,
      executionPermitted: false,
      processSpawnPermitted: false,
      sidecarStartPermitted: false,
      sidecarRestartPermitted: false,
      brokerRestartPermitted: false,
      blockers: readinessBlockers,
      nextAction: state === "accepted"
        ? "feed accepted no-live execution approval evidence into a separate runtime execution gate"
        : "collect non-conflicting visibility/manual receipt and matching execution approval grant evidence",
    },
    blockers,
    nextActions: nextActionsForState(state),
    approvalSensitiveActionsExcluded: [
      "sending the execution approval request",
      "granting approval or executing an approval grant",
      "runtime config write or Terminal Brief default-on enablement",
      "Terminal Brief sidecar start/stop/restart",
      "live provider/Hermes/Gongyung/Telegram/OpenClaw send",
      "terminal ACK/replay or terminal receipt DB mutation",
      "process spawn, executor invocation, broker restart, or deploy",
      "GitHub PR merge, issue close, or comment post from the ingestor",
      "TaskFlow record creation or broker DB mutation",
      "historical replay, release, publish, or secret movement",
    ],
    integrationContract: {
      transport: "json",
      evidenceSchemaVersion: 1,
      harnessNeutral: true,
      openclawMessageSendRequired: false,
      hermesAdapterCompatible: true,
      gongyungAdapterCompatible: true,
      consumesExecutionApprovalRequestPacket: true,
      providerAcceptedIsVisibilityProof: false,
      approvalGrantEvidenceExecutesGrant: false,
      terminalAckRequiresVisibilityProof: true,
      grantsApproval: false,
      writesConfig: false,
      enablesDefaultOn: false,
      sendsProvider: false,
      performsTerminalAck: false,
      mutatesDb: false,
      mutatesTaskFlow: false,
      spawnsProcess: false,
      startsSidecar: false,
      restartsSidecar: false,
      restartsBroker: false,
      executesAction: false,
    },
    semantics: {
      evidenceIngestorOnly: true,
      sourceOnlyNoLive: true,
      evidenceDoesNotMutateState: true,
      providerAcceptedIsVisibilityProof: false,
      terminalAckEligibleDoesNotPermitAck: true,
      approvalGrantEvidenceDoesNotGrantApproval: true,
      approvalGrantEvidenceDoesNotExecuteGrant: true,
      executionApprovalEvidenceDoesNotWriteConfig: true,
      executionApprovalEvidenceDoesNotEnableDefaultOn: true,
      executionApprovalEvidenceDoesNotRestartSidecar: true,
      executionRequiresSeparateRuntimeExecutor: true,
      executionNotPermitted: true,
      processSpawnNotPermitted: true,
      sidecarStartNotPermitted: true,
      sidecarRestartNotPermitted: true,
      brokerRestartNotPermitted: true,
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

export function extractTerminalBriefSidecarDefaultOnExecutionApprovalRequestPacket(
  input: unknown,
): TerminalBriefSidecarDefaultOnExecutionApprovalRequestPacket {
  const envelope = isRecord(input) ? input : {};
  const candidates = [
    input,
    envelope.defaultOnExecutionApprovalRequest,
    envelope.defaultOnExecutionApprovalRequestPacket,
    envelope.executionApprovalRequest,
    envelope.executionApprovalRequestPacket,
    envelope.approvalRequest,
    envelope.packet,
  ];
  const packet = candidates.find(isTerminalBriefSidecarDefaultOnExecutionApprovalRequestPacket);
  if (!packet) {
    throw new Error("expected a Terminal Brief sidecar default-on execution approval request packet");
  }
  return packet;
}

export const extractTerminalBriefSidecarDefaultOnExecutionApprovalEvidence =
  extractTerminalBriefSidecarActivationReceiptEvidence;

export function extractTerminalBriefSidecarDefaultOnExecutionApprovalEvidenceIngestorOptions(
  input: unknown,
): TerminalBriefSidecarDefaultOnExecutionApprovalEvidenceIngestorOptions {
  const envelope = isRecord(input) ? input : {};
  const options = isRecord(envelope.defaultOnExecutionApprovalEvidenceIngestor)
    ? envelope.defaultOnExecutionApprovalEvidenceIngestor
    : isRecord(envelope.executionApprovalEvidenceIngestor)
      ? envelope.executionApprovalEvidenceIngestor
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

export function renderTerminalBriefSidecarDefaultOnExecutionApprovalEvidenceIngestorMarkdown(
  packet: TerminalBriefSidecarDefaultOnExecutionApprovalEvidenceIngestorPacket,
): string {
  return [
    titleForState(packet.state),
    "Mode: " + packet.mode,
    "State: " + packet.state + " sourceOnlyNoLive=" + packet.sourceOnlyNoLive,
    "Idempotency: " + packet.idempotencyKey,
    "Execution approval request: state=" + packet.source.executionApprovalRequestState
      + " requestedAction=" + packet.source.requestedAction
      + " dispatchPermitted=" + packet.source.dispatchPermitted
      + " approvalReference=" + packet.source.approvalReference,
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
      + " sidecarRestartPermitted=" + packet.readiness.sidecarRestartPermitted,
    "Reason: " + packet.classification.reason,
    "Harness contract: JSON transport; providerAcceptedIsVisibilityProof=false; approvalGrantEvidenceExecutesGrant=false; grantsApproval=false; writesConfig=false; enablesDefaultOn=false; restartsSidecar=false; mutatesDb=false; executesAction=false.",
    ...(packet.blockers.length ? ["", "Blockers:", ...packet.blockers.map((blocker) => "- " + blocker)] : []),
    "",
    "Next actions:",
    ...packet.nextActions.map((action) => "- " + action),
    "",
    "Safety: execution approval evidence ingestor only; evidence does not mutate state; provider accepted is not visibility proof; terminalAckEligible never permits ACK here; approval grant evidence does not grant or execute approval; config is not written; default-on is not enabled; no live send, terminal ACK/replay, process spawn, sidecar restart/deploy, DB mutation, TaskFlow record creation, historical replay, release, or secret movement.",
  ].join("\n");
}

function normalizeEvidenceRecord(
  input: TerminalBriefSidecarDefaultOnExecutionApprovalEvidenceInput,
  request: TerminalBriefSidecarDefaultOnExecutionApprovalRequestPacket,
  nowMs: number,
  maxAgeMs: number,
): TerminalBriefSidecarDefaultOnExecutionApprovalEvidenceRecord {
  const rawKind = optionalString(input.kind ?? input.status);
  const kind = normalizeEvidenceKind(rawKind);
  const observedAt = optionalString(input.observedAt ?? input.observed_at);
  const expiresAt = optionalString(input.expiresAt ?? input.expires_at);
  const action = optionalString(input.action);
  const approvedAction = optionalString(input.approvedAction ?? input.approved_action);
  const target = optionalString(input.target);
  const approvedTarget = optionalString(input.approvedTarget ?? input.approved_target);
  const stale = isStale(kind, observedAt, expiresAt, nowMs, maxAgeMs);
  const conflict = kind === "conflict" || conflictsWithExecutionApprovalRequest(kind, request, { action, approvedAction, target, approvedTarget });
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

function normalizeEvidenceKind(value?: string): TerminalBriefSidecarDefaultOnExecutionApprovalEvidenceKind {
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
  kind: TerminalBriefSidecarDefaultOnExecutionApprovalEvidenceKind,
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

function conflictsWithExecutionApprovalRequest(
  kind: TerminalBriefSidecarDefaultOnExecutionApprovalEvidenceKind,
  request: TerminalBriefSidecarDefaultOnExecutionApprovalRequestPacket,
  fields: { action?: string; approvedAction?: string; target?: string; approvedTarget?: string },
): boolean {
  if (kind !== "approval_grant") return false;
  const expectedAction = request.approvalRequestDraft.requestedAction;
  const validTargets = new Set([request.approvalRequestDraft.operatorTarget, request.approvalRequestDraft.approvalReference]);
  const actualAction = fields.approvedAction ?? fields.action;
  const actualTarget = fields.approvedTarget ?? fields.target;
  if (actualAction && actualAction !== expectedAction) return true;
  if (actualTarget && !validTargets.has(actualTarget)) return true;
  return false;
}

function buildBlockers(
  request: TerminalBriefSidecarDefaultOnExecutionApprovalRequestPacket,
  records: TerminalBriefSidecarDefaultOnExecutionApprovalEvidenceRecord[],
): string[] {
  return unique([
    ...request.blockers,
    ...(request.state !== "execution_approval_request_draft_ready" ? ["execution approval request packet is " + request.state] : []),
    ...(request.approvalRequestDraft.status !== "draft_not_sent" ? ["execution approval request draft is not ready"] : []),
    ...(request.approvalRequestDraft.dispatchPermitted !== false ? ["execution approval request unexpectedly permits dispatch"] : []),
    ...(request.approvalRequestDraft.approvalGrantPermitted !== false ? ["execution approval request unexpectedly permits approval grant"] : []),
    ...(request.approvalRequestDraft.runtimeMutationPermitted !== false ? ["execution approval request unexpectedly permits runtime mutation"] : []),
    ...(request.approvalRequestDraft.configWritePermitted !== false ? ["execution approval request unexpectedly permits config write"] : []),
    ...(request.approvalRequestDraft.defaultOnPermitted !== false ? ["execution approval request unexpectedly permits default-on"] : []),
    ...(request.approvalRequestDraft.sidecarRestartPermitted !== false ? ["execution approval request unexpectedly permits sidecar restart"] : []),
    ...(request.approvalRequestDraft.providerSendPermitted !== false ? ["execution approval request unexpectedly permits provider send"] : []),
    ...(request.approvalRequestDraft.terminalAckPermitted !== false ? ["execution approval request unexpectedly permits terminal ACK"] : []),
    ...(request.approvalRequestDraft.dbMutationPermitted !== false ? ["execution approval request unexpectedly permits DB mutation"] : []),
    ...(request.approvalRequestDraft.taskFlowMutationPermitted !== false ? ["execution approval request unexpectedly permits TaskFlow mutation"] : []),
    ...(request.approvalRequestDraft.executionPermitted !== false ? ["execution approval request unexpectedly permits execution"] : []),
    ...(request.approvalRequestDraft.processSpawnPermitted !== false ? ["execution approval request unexpectedly permits process spawn"] : []),
    ...(request.readiness.executionApprovalRequestDispatchPermitted !== false ? ["execution approval request readiness unexpectedly permits approval dispatch"] : []),
    ...(request.readiness.approvalGrantPermitted !== false ? ["execution approval request readiness unexpectedly permits approval grant"] : []),
    ...(request.readiness.runtimeMutationPermitted !== false ? ["execution approval request readiness unexpectedly permits runtime mutation"] : []),
    ...(request.readiness.configWritePermitted !== false ? ["execution approval request readiness unexpectedly permits config write"] : []),
    ...(request.readiness.defaultOnPermitted !== false ? ["execution approval request readiness unexpectedly permits default-on"] : []),
    ...(request.readiness.sidecarRestartPermitted !== false ? ["execution approval request readiness unexpectedly permits sidecar restart"] : []),
    ...(request.readiness.providerSendPermitted !== false ? ["execution approval request readiness unexpectedly permits provider send"] : []),
    ...(request.readiness.terminalAckPermitted !== false ? ["execution approval request readiness unexpectedly permits terminal ACK"] : []),
    ...(request.readiness.dbMutationPermitted !== false ? ["execution approval request readiness unexpectedly permits DB mutation"] : []),
    ...(request.readiness.taskFlowMutationPermitted !== false ? ["execution approval request readiness unexpectedly permits TaskFlow mutation"] : []),
    ...(request.readiness.executionPermitted !== false ? ["execution approval request readiness unexpectedly permits execution"] : []),
    ...(request.readiness.processSpawnPermitted !== false ? ["execution approval request readiness unexpectedly permits process spawn"] : []),
    ...(request.readiness.sidecarStartPermitted !== false ? ["execution approval request readiness unexpectedly permits sidecar start"] : []),
    ...(request.readiness.sidecarRestartPermitted !== false ? ["execution approval request readiness unexpectedly permits sidecar restart"] : []),
    ...(request.readiness.brokerRestartPermitted !== false ? ["execution approval request readiness unexpectedly permits broker restart"] : []),
    ...(request.integrationContract.sendsApprovalRequest ? ["execution approval request unexpectedly sends approval request"] : []),
    ...(request.integrationContract.grantsApproval ? ["execution approval request unexpectedly grants approval"] : []),
    ...(request.integrationContract.writesConfig ? ["execution approval request unexpectedly writes config"] : []),
    ...(request.integrationContract.enablesDefaultOn ? ["execution approval request unexpectedly enables default-on"] : []),
    ...(request.integrationContract.sendsProvider ? ["execution approval request unexpectedly sends provider"] : []),
    ...(request.integrationContract.performsTerminalAck ? ["execution approval request unexpectedly performs terminal ACK"] : []),
    ...(request.integrationContract.mutatesDb ? ["execution approval request unexpectedly mutates DB"] : []),
    ...(request.integrationContract.mutatesTaskFlow ? ["execution approval request unexpectedly mutates TaskFlow"] : []),
    ...(request.integrationContract.spawnsProcess ? ["execution approval request unexpectedly spawns process"] : []),
    ...(request.integrationContract.startsSidecar ? ["execution approval request unexpectedly starts sidecar"] : []),
    ...(request.integrationContract.restartsSidecar ? ["execution approval request unexpectedly restarts sidecar"] : []),
    ...(request.integrationContract.restartsBroker ? ["execution approval request unexpectedly restarts broker"] : []),
    ...(request.integrationContract.executesAction ? ["execution approval request unexpectedly executes action"] : []),
    ...(request.semantics.requestDoesNotGrantApproval !== true ? ["execution approval request does not preserve no-grant boundary"] : []),
    ...(request.semantics.requestDoesNotExecuteEnvelope !== true ? ["execution approval request does not preserve no-execution boundary"] : []),
    ...(request.semantics.requestDoesNotWriteConfig !== true ? ["execution approval request does not preserve config boundary"] : []),
    ...(request.semantics.requestDoesNotEnableDefaultOn !== true ? ["execution approval request does not preserve default-on boundary"] : []),
    ...(request.semantics.requestDoesNotRestartSidecar !== true ? ["execution approval request does not preserve restart boundary"] : []),
    ...(request.semantics.performsProviderSend ? ["execution approval request unexpectedly performs provider send"] : []),
    ...(request.semantics.performsTerminalAck ? ["execution approval request unexpectedly performs terminal ACK"] : []),
    ...(request.semantics.performsRuntimeRestartOrDeploy ? ["execution approval request unexpectedly performs restart/deploy"] : []),
    ...(request.semantics.performsDbMutation ? ["execution approval request unexpectedly performs DB mutation"] : []),
    ...(request.semantics.createsTaskFlowRecords ? ["execution approval request unexpectedly creates TaskFlow records"] : []),
    ...(request.semantics.performsHistoricalReplay ? ["execution approval request unexpectedly performs historical replay"] : []),
    ...(request.semantics.performsReleaseOrPublish ? ["execution approval request unexpectedly performs release/publish"] : []),
    ...(request.semantics.movesSecretsOrCredentials ? ["execution approval request unexpectedly moves secrets/credentials"] : []),
    ...(records.some((record) => record.kind === "unknown") ? ["execution approval evidence contains an unsupported kind"] : []),
  ].filter(Boolean));
}

function classifyEvidence(records: TerminalBriefSidecarDefaultOnExecutionApprovalEvidenceRecord[]): EvidenceClassificationCore {
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
  request: TerminalBriefSidecarDefaultOnExecutionApprovalRequestPacket,
  classification: EvidenceClassificationCore,
  blockers: string[],
  records: TerminalBriefSidecarDefaultOnExecutionApprovalEvidenceRecord[],
): TerminalBriefSidecarDefaultOnExecutionApprovalEvidenceIngestorState {
  if (blockers.length > 0) return "blocked";
  if (request.state === "blocked") return "blocked";
  if (request.state !== "execution_approval_request_draft_ready") return "insufficient";
  if (records.some((record) => record.conflict) || records.some((record) => record.kind === "conflict")) return "conflicting";
  if (hasFreshPositive(records) && classification.rejected) return "conflicting";
  if (classification.rejected) return "rejected";
  if (records.length > 0 && records.every((record) => record.stale)) return "stale";
  if (classification.receiptProofAccepted && classification.approvalGrantAccepted) return "accepted";
  return "insufficient";
}

function reasonForState(
  state: TerminalBriefSidecarDefaultOnExecutionApprovalEvidenceIngestorState,
  classification: EvidenceClassificationCore,
  blockers: string[],
  records: TerminalBriefSidecarDefaultOnExecutionApprovalEvidenceRecord[],
): string {
  if (state === "blocked" && blockers.length) return blockers[0];
  if (state === "accepted") return "operator-visible receipt proof and matching execution approval grant evidence accepted as source-only evidence";
  if (state === "conflicting") return "receipt or execution approval grant evidence conflicts with the approval request";
  if (state === "rejected") return "operator rejected execution approval";
  if (state === "stale") return "execution approval evidence is stale or expired";
  if (classification.providerAccepted && !classification.receiptProofAccepted) return "provider accepted is transport evidence only and is not visibility proof";
  if (classification.receiptProofAccepted && !classification.approvalGrantAccepted) return "visibility/manual receipt is present but matching execution approval grant evidence is missing";
  if (!classification.receiptProofAccepted && classification.approvalGrantAccepted) return "approval grant evidence is present but operator-visible receipt proof is missing";
  if (records.length === 0) return "no execution approval evidence supplied";
  return "execution approval evidence is insufficient";
}

function reasonForRecord(
  kind: TerminalBriefSidecarDefaultOnExecutionApprovalEvidenceKind,
  stale: boolean,
  conflict: boolean,
): string {
  if (conflict) return "evidence conflicts with requested execution action or target";
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

function nextActionsForState(state: TerminalBriefSidecarDefaultOnExecutionApprovalEvidenceIngestorState): string[] {
  if (state === "accepted") {
    return [
      "feed accepted no-live execution approval evidence into a separate runtime execution gate",
      "keep config write, default-on enablement, sidecar restart, provider send, terminal ACK, deploy, and DB mutation behind separate runtime gates",
    ];
  }
  if (state === "insufficient") {
    return [
      "collect current-session-visible or manual operator confirmation plus matching execution approval grant evidence",
      "do not treat provider accepted evidence as visibility proof or approval grant",
    ];
  }
  if (state === "stale") {
    return [
      "refresh receipt and approval evidence before runtime execution gate review",
      "do not execute default-on from stale approval evidence",
    ];
  }
  if (state === "conflicting") {
    return [
      "resolve conflicting receipt or approval evidence before runtime execution gate review",
      "rerun the ingestor with one coherent evidence set",
    ];
  }
  if (state === "rejected") {
    return [
      "do not enable Terminal Brief default-on",
      "collect a new approval request if the operator later changes the decision",
    ];
  }
  return [
    "recover blocked approval request source or unsupported evidence before continuing",
    "do not use blocked evidence as execution approval proof",
  ];
}

function hasFreshPositive(records: TerminalBriefSidecarDefaultOnExecutionApprovalEvidenceRecord[]): boolean {
  return records.some((record) => !record.stale && !record.conflict && ["provider_accepted", "current_session_visible", "manual_operator_confirmation", "approval_grant"].includes(record.kind));
}

function isStrongEvidenceKind(kind: TerminalBriefSidecarDefaultOnExecutionApprovalEvidenceKind): boolean {
  return kind === "current_session_visible" || kind === "manual_operator_confirmation" || kind === "approval_grant";
}

function isNegativeKind(kind: TerminalBriefSidecarDefaultOnExecutionApprovalEvidenceKind): boolean {
  return kind === "rejected" || kind === "expired" || kind === "unknown";
}

function buildEvidenceIngestorIdempotencyKey(
  request: TerminalBriefSidecarDefaultOnExecutionApprovalRequestPacket,
  state: TerminalBriefSidecarDefaultOnExecutionApprovalEvidenceIngestorState,
  records: TerminalBriefSidecarDefaultOnExecutionApprovalEvidenceRecord[],
  maxAgeMs: number,
): string {
  const base = JSON.stringify({
    label: "terminal-brief-sidecar-default-on-execution-approval-evidence-ingestor",
    approvalRequest: request.idempotencyKey,
    approvalReference: request.approvalRequestDraft.approvalReference,
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
  return "tb-sidecar-default-on-execution-approval-evidence:" + createHash("sha256").update(base).digest("hex").slice(0, 24);
}

function titleForState(state: TerminalBriefSidecarDefaultOnExecutionApprovalEvidenceIngestorState): string {
  if (state === "accepted") return "Accepted: Terminal Brief default-on execution approval evidence";
  if (state === "insufficient") return "Insufficient: Terminal Brief default-on execution approval evidence";
  if (state === "stale") return "Stale: Terminal Brief default-on execution approval evidence";
  if (state === "conflicting") return "Conflicting: Terminal Brief default-on execution approval evidence";
  if (state === "rejected") return "Rejected: Terminal Brief default-on execution approval";
  return "Blocked: Terminal Brief default-on execution approval evidence";
}

function list(items: unknown[]): string {
  return items.length ? items.join(",") : "none";
}

function isTerminalBriefSidecarDefaultOnExecutionApprovalRequestPacket(
  value: unknown,
): value is TerminalBriefSidecarDefaultOnExecutionApprovalRequestPacket {
  return isRecord(value) && value.kind === "a2a-broker.terminal-brief-sidecar-default-on-execution-approval-request.packet";
}

