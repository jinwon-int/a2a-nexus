import { unique } from "./collections.js";
import { isRecord } from "./value-guards.js";
import { createHash } from "node:crypto";

import {
  extractTerminalBriefSidecarActivationReceiptEvidence,
  type TerminalBriefSidecarActivationReceiptEvidenceInput,
  type TerminalBriefSidecarActivationReceiptEvidenceKind,
  type TerminalBriefSidecarActivationReceiptEvidenceRecord,
  type TerminalBriefSidecarActivationReceiptIngestorState,
} from "./terminal-brief-sidecar-activation-receipt-ingestor.js";
import type { TerminalBriefSidecarDefaultOnApprovalRequestPacket } from "./terminal-brief-sidecar-default-on-approval-request.js";
import { numberValue, optionalString } from "./value-text.js";

export type TerminalBriefSidecarDefaultOnApprovalEvidenceIngestorState =
  TerminalBriefSidecarActivationReceiptIngestorState;

export type TerminalBriefSidecarDefaultOnApprovalEvidenceKind =
  TerminalBriefSidecarActivationReceiptEvidenceKind;

export type TerminalBriefSidecarDefaultOnApprovalEvidenceInput =
  TerminalBriefSidecarActivationReceiptEvidenceInput;

export type TerminalBriefSidecarDefaultOnApprovalEvidenceRecord =
  TerminalBriefSidecarActivationReceiptEvidenceRecord;

export interface TerminalBriefSidecarDefaultOnApprovalEvidenceIngestorOptions {
  now?: string;
  mode?: string;
  maxAgeMs?: number;
}

export interface TerminalBriefSidecarDefaultOnApprovalEvidenceIngestorPacket {
  kind: "a2a-broker.terminal-brief-sidecar-default-on-approval-evidence-ingestor.packet";
  version: 1;
  generatedAt: string;
  mode: string;
  state: TerminalBriefSidecarDefaultOnApprovalEvidenceIngestorState;
  dryRunOnly: false;
  sourceOnlyNoLive: true;
  receiptEvidenceAccepted: boolean;
  approvalEvidenceAccepted: boolean;
  idempotencyKey: string;
  source: {
    defaultOnApprovalRequestState: TerminalBriefSidecarDefaultOnApprovalRequestPacket["state"];
    defaultOnApprovalRequestIdempotencyKey: string;
    requestedAction: TerminalBriefSidecarDefaultOnApprovalRequestPacket["approvalRequestDraft"]["requestedAction"];
    requestedBy: string;
    operatorTarget: string;
    operatorChannel?: string;
    approvalReference: string;
    dispatchRequired: boolean;
    dispatchPermitted: false;
  };
  evidence: {
    received: number;
    acceptedKinds: TerminalBriefSidecarDefaultOnApprovalEvidenceKind[];
    staleKinds: TerminalBriefSidecarDefaultOnApprovalEvidenceKind[];
    conflictingKinds: TerminalBriefSidecarDefaultOnApprovalEvidenceKind[];
    rejectedKinds: TerminalBriefSidecarDefaultOnApprovalEvidenceKind[];
    records: TerminalBriefSidecarDefaultOnApprovalEvidenceRecord[];
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
    reason: string;
  };
  readiness: {
    sourceCriteriaMet: boolean;
    receiptEvidenceAccepted: boolean;
    approvalEvidenceAccepted: boolean;
    approvalRequestDispatchPermitted: false;
    approvalGrantPermitted: false;
    defaultOnPermitted: false;
    liveActivationPermitted: false;
    providerSendPermitted: false;
    terminalAckPermitted: false;
    dbMutationPermitted: false;
    executionPermitted: false;
    processSpawnPermitted: false;
    sidecarStartPermitted: false;
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
    consumesDefaultOnApprovalRequestPacket: true;
    providerAcceptedIsVisibilityProof: false;
    terminalAckRequiresVisibilityProof: true;
    grantsApproval: false;
    enablesDefaultOn: false;
    sendsProvider: false;
    performsTerminalAck: false;
    mutatesDb: false;
    spawnsProcess: false;
    startsSidecar: false;
    executesAction: false;
  };
  semantics: {
    evidenceIngestorOnly: true;
    sourceOnlyNoLive: true;
    evidenceDoesNotMutateState: true;
    providerAcceptedIsVisibilityProof: false;
    terminalAckEligibleDoesNotPermitAck: true;
    approvalGrantEvidenceDoesNotGrantApproval: true;
    defaultOnApprovalEvidenceDoesNotEnableDefaultOn: true;
    defaultOnRequiresSeparateRuntimeMutationGate: true;
    executionNotPermitted: true;
    processSpawnNotPermitted: true;
    sidecarStartNotPermitted: true;
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

interface ReceiptClassificationCore {
  providerAccepted: boolean;
  currentSessionVisible: boolean;
  manualOperatorConfirmed: boolean;
  approvalGrantAccepted: boolean;
  receiptProofAccepted: boolean;
  rejected: boolean;
  expired: boolean;
  stale: boolean;
}

export function buildTerminalBriefSidecarDefaultOnApprovalEvidenceIngestor(
  request: TerminalBriefSidecarDefaultOnApprovalRequestPacket,
  evidenceInput: TerminalBriefSidecarDefaultOnApprovalEvidenceInput[] = [],
  options: TerminalBriefSidecarDefaultOnApprovalEvidenceIngestorOptions = {},
): TerminalBriefSidecarDefaultOnApprovalEvidenceIngestorPacket {
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
    "approval grant evidence does not grant approval in this ingestor",
    "default-on approval evidence still requires a separate runtime mutation gate",
  ];

  return {
    kind: "a2a-broker.terminal-brief-sidecar-default-on-approval-evidence-ingestor.packet",
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
      defaultOnApprovalRequestState: request.state,
      defaultOnApprovalRequestIdempotencyKey: request.idempotencyKey,
      requestedAction: request.approvalRequestDraft.requestedAction,
      requestedBy: request.approvalRequestDraft.requestedBy,
      operatorTarget: request.approvalRequestDraft.operatorTarget,
      operatorChannel: request.approvalRequestDraft.operatorChannel,
      approvalReference: request.approvalRequestDraft.approvalReference,
      dispatchRequired: request.approvalRequestDraft.dispatchRequired,
      dispatchPermitted: false,
    },
    evidence: {
      received: records.length,
      acceptedKinds: unique(records.filter((record) => !record.stale && !record.conflict && isStrongReceiptKind(record.kind)).map((record) => record.kind)),
      staleKinds: unique(records.filter((record) => record.stale).map((record) => record.kind)),
      conflictingKinds: unique(records.filter((record) => record.conflict || record.kind === "conflict").map((record) => record.kind)),
      rejectedKinds: unique(records.filter((record) => isNegativeKind(record.kind)).map((record) => record.kind)),
      records,
    },
    classification: {
      ...classification,
      terminalAckEligible,
      providerAcceptedIsVisibilityProof: false,
      reason: reasonForState(state, classification, blockers, records),
    },
    readiness: {
      sourceCriteriaMet: state === "accepted",
      receiptEvidenceAccepted,
      approvalEvidenceAccepted,
      approvalRequestDispatchPermitted: false,
      approvalGrantPermitted: false,
      defaultOnPermitted: false,
      liveActivationPermitted: false,
      providerSendPermitted: false,
      terminalAckPermitted: false,
      dbMutationPermitted: false,
      executionPermitted: false,
      processSpawnPermitted: false,
      sidecarStartPermitted: false,
      blockers: readinessBlockers,
      nextAction: state === "accepted"
        ? "feed accepted no-live default-on approval evidence into a separate default-on enablement gate"
        : "collect non-conflicting visibility/manual receipt and matching default-on approval grant evidence",
    },
    blockers,
    nextActions: nextActionsForState(state),
    approvalSensitiveActionsExcluded: [
      "sending the default-on approval request",
      "granting approval or executing an approval grant",
      "Terminal Brief default-on enablement",
      "live provider/Hermes/Gongyung/Telegram/OpenClaw send",
      "terminal ACK/replay or terminal receipt DB mutation",
      "process spawn, sidecar start/stop/restart, or deploy",
      "GitHub PR merge, issue close, or comment post from the ingestor",
      "TaskFlow record creation or broker DB mutation",
      "production deploy/restart, historical replay, release, publish, or secret movement",
    ],
    integrationContract: {
      transport: "json",
      evidenceSchemaVersion: 1,
      harnessNeutral: true,
      openclawMessageSendRequired: false,
      hermesAdapterCompatible: true,
      gongyungAdapterCompatible: true,
      consumesDefaultOnApprovalRequestPacket: true,
      providerAcceptedIsVisibilityProof: false,
      terminalAckRequiresVisibilityProof: true,
      grantsApproval: false,
      enablesDefaultOn: false,
      sendsProvider: false,
      performsTerminalAck: false,
      mutatesDb: false,
      spawnsProcess: false,
      startsSidecar: false,
      executesAction: false,
    },
    semantics: {
      evidenceIngestorOnly: true,
      sourceOnlyNoLive: true,
      evidenceDoesNotMutateState: true,
      providerAcceptedIsVisibilityProof: false,
      terminalAckEligibleDoesNotPermitAck: true,
      approvalGrantEvidenceDoesNotGrantApproval: true,
      defaultOnApprovalEvidenceDoesNotEnableDefaultOn: true,
      defaultOnRequiresSeparateRuntimeMutationGate: true,
      executionNotPermitted: true,
      processSpawnNotPermitted: true,
      sidecarStartNotPermitted: true,
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

export function extractTerminalBriefSidecarDefaultOnApprovalRequestPacket(
  input: unknown,
): TerminalBriefSidecarDefaultOnApprovalRequestPacket {
  const envelope = isRecord(input) ? input : {};
  const candidates = [
    input,
    envelope.defaultOnApprovalRequest,
    envelope.defaultOnApprovalRequestPacket,
    envelope.sidecarDefaultOnApprovalRequest,
    envelope.sidecarDefaultOnApprovalRequestPacket,
    envelope.approvalRequest,
    envelope.packet,
  ];
  const packet = candidates.find(isTerminalBriefSidecarDefaultOnApprovalRequestPacket);
  if (!packet) {
    throw new Error("expected a Terminal Brief sidecar default-on approval request packet");
  }
  return packet;
}

export const extractTerminalBriefSidecarDefaultOnApprovalEvidence =
  extractTerminalBriefSidecarActivationReceiptEvidence;

export function extractTerminalBriefSidecarDefaultOnApprovalEvidenceIngestorOptions(
  input: unknown,
): TerminalBriefSidecarDefaultOnApprovalEvidenceIngestorOptions {
  const envelope = isRecord(input) ? input : {};
  const options = isRecord(envelope.defaultOnApprovalEvidenceIngestor)
    ? envelope.defaultOnApprovalEvidenceIngestor
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

export function renderTerminalBriefSidecarDefaultOnApprovalEvidenceIngestorMarkdown(
  packet: TerminalBriefSidecarDefaultOnApprovalEvidenceIngestorPacket,
): string {
  return [
    titleForState(packet.state),
    "Mode: " + packet.mode,
    "State: " + packet.state + " sourceOnlyNoLive=" + packet.sourceOnlyNoLive,
    "Idempotency: " + packet.idempotencyKey,
    "Approval request: state=" + packet.source.defaultOnApprovalRequestState
      + " requestedAction=" + packet.source.requestedAction
      + " dispatchPermitted=" + packet.source.dispatchPermitted
      + " approvalReference=" + packet.source.approvalReference,
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
      + " defaultOnPermitted=" + packet.readiness.defaultOnPermitted,
    "Reason: " + packet.classification.reason,
    "Harness contract: JSON transport; providerAcceptedIsVisibilityProof=false; terminalAckRequiresVisibilityProof=true; grantsApproval=false; enablesDefaultOn=false; mutatesDb=false; executesAction=false.",
    ...(packet.blockers.length ? ["", "Blockers:", ...packet.blockers.map((blocker) => "- " + blocker)] : []),
    "",
    "Next actions:",
    ...packet.nextActions.map((action) => "- " + action),
    "",
    "Safety: default-on approval evidence ingestor only; evidence does not mutate state; provider accepted is not visibility proof; terminalAckEligible never permits ACK here; approval grant evidence does not grant approval; default-on is not enabled; no live send, terminal ACK/replay, process spawn, sidecar restart/deploy, DB mutation, TaskFlow record creation, historical replay, release, or secret movement.",
  ].join("\n");
}

function normalizeEvidenceRecord(
  input: TerminalBriefSidecarDefaultOnApprovalEvidenceInput,
  request: TerminalBriefSidecarDefaultOnApprovalRequestPacket,
  nowMs: number,
  maxAgeMs: number,
): TerminalBriefSidecarDefaultOnApprovalEvidenceRecord {
  const rawKind = optionalString(input.kind ?? input.status);
  const kind = normalizeEvidenceKind(rawKind);
  const observedAt = optionalString(input.observedAt ?? input.observed_at);
  const expiresAt = optionalString(input.expiresAt ?? input.expires_at);
  const action = optionalString(input.action);
  const approvedAction = optionalString(input.approvedAction ?? input.approved_action);
  const target = optionalString(input.target);
  const approvedTarget = optionalString(input.approvedTarget ?? input.approved_target);
  const stale = isStale(kind, observedAt, expiresAt, nowMs, maxAgeMs);
  const conflict = kind === "conflict" || conflictsWithDefaultOnApprovalRequest(kind, request, { action, approvedAction, target, approvedTarget });
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

function normalizeEvidenceKind(value?: string): TerminalBriefSidecarDefaultOnApprovalEvidenceKind {
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
  kind: TerminalBriefSidecarDefaultOnApprovalEvidenceKind,
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

function conflictsWithDefaultOnApprovalRequest(
  kind: TerminalBriefSidecarDefaultOnApprovalEvidenceKind,
  request: TerminalBriefSidecarDefaultOnApprovalRequestPacket,
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
  request: TerminalBriefSidecarDefaultOnApprovalRequestPacket,
  records: TerminalBriefSidecarDefaultOnApprovalEvidenceRecord[],
): string[] {
  return unique([
    ...request.blockers,
    ...(request.state !== "approval_request_draft_ready" ? ["default-on approval request packet is " + request.state] : []),
    ...(request.approvalRequestDraft.status !== "draft_not_sent" ? ["default-on approval request draft is not ready"] : []),
    ...(request.approvalRequestDraft.dispatchPermitted !== false ? ["default-on approval request unexpectedly permits dispatch"] : []),
    ...(request.approvalRequestDraft.approvalGrantPermitted !== false ? ["default-on approval request unexpectedly permits approval grant"] : []),
    ...(request.approvalRequestDraft.defaultOnPermitted !== false ? ["default-on approval request unexpectedly permits default-on"] : []),
    ...(request.approvalRequestDraft.providerSendPermitted !== false ? ["default-on approval request unexpectedly permits provider send"] : []),
    ...(request.approvalRequestDraft.terminalAckPermitted !== false ? ["default-on approval request unexpectedly permits terminal ACK"] : []),
    ...(request.approvalRequestDraft.dbMutationPermitted !== false ? ["default-on approval request unexpectedly permits DB mutation"] : []),
    ...(request.approvalRequestDraft.executionPermitted !== false ? ["default-on approval request unexpectedly permits execution"] : []),
    ...(request.readiness.approvalRequestDispatchPermitted !== false ? ["default-on approval request readiness unexpectedly permits approval dispatch"] : []),
    ...(request.readiness.approvalGrantPermitted !== false ? ["default-on approval request readiness unexpectedly permits approval grant"] : []),
    ...(request.readiness.defaultOnPermitted !== false ? ["default-on approval request readiness unexpectedly permits default-on"] : []),
    ...(request.readiness.providerSendPermitted !== false ? ["default-on approval request readiness unexpectedly permits provider send"] : []),
    ...(request.readiness.terminalAckPermitted !== false ? ["default-on approval request readiness unexpectedly permits terminal ACK"] : []),
    ...(request.readiness.dbMutationPermitted !== false ? ["default-on approval request readiness unexpectedly permits DB mutation"] : []),
    ...(request.readiness.executionPermitted !== false ? ["default-on approval request readiness unexpectedly permits execution"] : []),
    ...(request.readiness.processSpawnPermitted !== false ? ["default-on approval request readiness unexpectedly permits process spawn"] : []),
    ...(request.readiness.sidecarStartPermitted !== false ? ["default-on approval request readiness unexpectedly permits sidecar start"] : []),
    ...(request.integrationContract.sendsApprovalRequest ? ["default-on approval request unexpectedly sends approval request"] : []),
    ...(request.integrationContract.grantsApproval ? ["default-on approval request unexpectedly grants approval"] : []),
    ...(request.integrationContract.enablesDefaultOn ? ["default-on approval request unexpectedly enables default-on"] : []),
    ...(request.integrationContract.sendsProvider ? ["default-on approval request unexpectedly sends provider"] : []),
    ...(request.integrationContract.performsTerminalAck ? ["default-on approval request unexpectedly performs terminal ACK"] : []),
    ...(request.integrationContract.mutatesDb ? ["default-on approval request unexpectedly mutates DB"] : []),
    ...(request.integrationContract.spawnsProcess ? ["default-on approval request unexpectedly spawns process"] : []),
    ...(request.integrationContract.restartsSidecar ? ["default-on approval request unexpectedly restarts sidecar"] : []),
    ...(request.integrationContract.executesAction ? ["default-on approval request unexpectedly executes action"] : []),
    ...(request.semantics.performsProviderSend ? ["default-on approval request unexpectedly performs provider send"] : []),
    ...(request.semantics.performsTerminalAck ? ["default-on approval request unexpectedly performs terminal ACK"] : []),
    ...(request.semantics.performsRuntimeRestartOrDeploy ? ["default-on approval request unexpectedly performs restart/deploy"] : []),
    ...(request.semantics.performsDbMutation ? ["default-on approval request unexpectedly performs DB mutation"] : []),
    ...(request.semantics.performsHistoricalReplay ? ["default-on approval request unexpectedly performs historical replay"] : []),
    ...(request.semantics.performsReleaseOrPublish ? ["default-on approval request unexpectedly performs release/publish"] : []),
    ...(request.semantics.movesSecretsOrCredentials ? ["default-on approval request unexpectedly moves secrets/credentials"] : []),
    ...(records.some((record) => record.kind === "unknown") ? ["default-on approval evidence contains an unsupported kind"] : []),
  ].filter(Boolean));
}

function classifyEvidence(records: TerminalBriefSidecarDefaultOnApprovalEvidenceRecord[]): ReceiptClassificationCore {
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
  request: TerminalBriefSidecarDefaultOnApprovalRequestPacket,
  classification: ReceiptClassificationCore,
  blockers: string[],
  records: TerminalBriefSidecarDefaultOnApprovalEvidenceRecord[],
): TerminalBriefSidecarDefaultOnApprovalEvidenceIngestorState {
  if (blockers.length > 0) return "blocked";
  if (request.state === "blocked") return "blocked";
  if (request.state !== "approval_request_draft_ready") return "insufficient";
  if (records.some((record) => record.conflict) || records.some((record) => record.kind === "conflict")) return "conflicting";
  if (hasFreshPositive(records) && classification.rejected) return "conflicting";
  if (classification.rejected) return "rejected";
  if (records.length > 0 && records.every((record) => record.stale)) return "stale";
  if (classification.receiptProofAccepted && classification.approvalGrantAccepted) return "accepted";
  return "insufficient";
}

function reasonForState(
  state: TerminalBriefSidecarDefaultOnApprovalEvidenceIngestorState,
  classification: ReceiptClassificationCore,
  blockers: string[],
  records: TerminalBriefSidecarDefaultOnApprovalEvidenceRecord[],
): string {
  if (state === "blocked" && blockers.length) return blockers[0];
  if (state === "accepted") return "operator-visible receipt proof and matching default-on approval grant evidence accepted as source-only evidence";
  if (state === "conflicting") return "receipt or default-on approval grant evidence conflicts with the approval request";
  if (state === "rejected") return "operator rejected default-on approval";
  if (state === "stale") return "default-on approval evidence is stale or expired";
  if (classification.providerAccepted && !classification.receiptProofAccepted) return "provider accepted is transport evidence only and is not visibility proof";
  if (classification.receiptProofAccepted && !classification.approvalGrantAccepted) return "visibility/manual receipt is present but matching default-on approval grant evidence is missing";
  if (!classification.receiptProofAccepted && classification.approvalGrantAccepted) return "approval grant evidence is present but operator-visible receipt proof is missing";
  if (records.length === 0) return "no default-on approval evidence supplied";
  return "default-on approval evidence is insufficient";
}

function reasonForRecord(
  kind: TerminalBriefSidecarDefaultOnApprovalEvidenceKind,
  stale: boolean,
  conflict: boolean,
): string {
  if (conflict) return "evidence conflicts with requested default-on action or target";
  if (stale) return "evidence is stale or expired";
  if (kind === "provider_accepted") return "provider accepted is transport evidence only, not operator-visible proof";
  if (kind === "current_session_visible") return "current session visibility can satisfy receipt proof";
  if (kind === "manual_operator_confirmation") return "manual operator confirmation can satisfy receipt proof";
  if (kind === "approval_grant") return "approval grant evidence is source evidence only and does not grant approval by itself";
  if (kind === "rejected") return "operator rejected approval";
  if (kind === "expired") return "approval evidence expired";
  if (kind === "conflict") return "explicit conflict marker";
  return "unsupported evidence kind";
}

function nextActionsForState(state: TerminalBriefSidecarDefaultOnApprovalEvidenceIngestorState): string[] {
  if (state === "accepted") {
    return [
      "feed accepted no-live default-on approval evidence into a separate default-on enablement gate",
      "keep default-on enablement, provider send, terminal ACK, deploy, and DB mutation behind separate approval/runtime gates",
    ];
  }
  if (state === "insufficient") {
    return [
      "collect current-session-visible or manual operator confirmation plus matching default-on approval grant evidence",
      "do not treat provider accepted evidence as visibility proof or approval grant",
    ];
  }
  if (state === "stale") {
    return [
      "refresh receipt and approval evidence before default-on enablement gate review",
      "do not enable default-on from stale approval evidence",
    ];
  }
  if (state === "conflicting") {
    return [
      "resolve conflicting receipt or approval evidence before default-on enablement gate review",
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
    "do not use blocked evidence as default-on approval proof",
  ];
}

function hasFreshPositive(records: TerminalBriefSidecarDefaultOnApprovalEvidenceRecord[]): boolean {
  return records.some((record) => !record.stale && !record.conflict && ["provider_accepted", "current_session_visible", "manual_operator_confirmation", "approval_grant"].includes(record.kind));
}

function isStrongReceiptKind(kind: TerminalBriefSidecarDefaultOnApprovalEvidenceKind): boolean {
  return kind === "current_session_visible" || kind === "manual_operator_confirmation" || kind === "approval_grant";
}

function isNegativeKind(kind: TerminalBriefSidecarDefaultOnApprovalEvidenceKind): boolean {
  return kind === "rejected" || kind === "expired" || kind === "unknown";
}

function buildEvidenceIngestorIdempotencyKey(
  request: TerminalBriefSidecarDefaultOnApprovalRequestPacket,
  state: TerminalBriefSidecarDefaultOnApprovalEvidenceIngestorState,
  records: TerminalBriefSidecarDefaultOnApprovalEvidenceRecord[],
  maxAgeMs: number,
): string {
  const base = JSON.stringify({
    label: "terminal-brief-sidecar-default-on-approval-evidence-ingestor",
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
  return "tb-sidecar-default-on-approval-evidence:" + createHash("sha256").update(base).digest("hex").slice(0, 24);
}

function titleForState(state: TerminalBriefSidecarDefaultOnApprovalEvidenceIngestorState): string {
  if (state === "accepted") return "Accepted: Terminal Brief default-on approval evidence";
  if (state === "insufficient") return "Insufficient: Terminal Brief default-on approval evidence";
  if (state === "stale") return "Stale: Terminal Brief default-on approval evidence";
  if (state === "conflicting") return "Conflicting: Terminal Brief default-on approval evidence";
  if (state === "rejected") return "Rejected: Terminal Brief default-on approval";
  return "Blocked: Terminal Brief default-on approval evidence";
}

function list(items: unknown[]): string {
  return items.length ? items.join(",") : "none";
}

function isTerminalBriefSidecarDefaultOnApprovalRequestPacket(
  value: unknown,
): value is TerminalBriefSidecarDefaultOnApprovalRequestPacket {
  return isRecord(value) && value.kind === "a2a-broker.terminal-brief-sidecar-default-on-approval-request.packet";
}

