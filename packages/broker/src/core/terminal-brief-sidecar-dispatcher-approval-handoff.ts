import { unique } from "./collections.js";
import { numberValue } from "./value-text.js";
import { isRecord } from "./value-guards.js";
import { createHash } from "node:crypto";

import type { TerminalBriefSidecarDispatcherPreflightSealPacket } from "./terminal-brief-sidecar-dispatcher-preflight-seal.js";
import { approvalSensitiveActionsExcluded, optionalString } from "./terminal-brief-value-guards.js";

export type TerminalBriefSidecarDispatcherApprovalHandoffState =
  | "dispatcher_approval_handoff_ready"
  | "waiting_for_dispatcher_preflight_seal"
  | "seal_expired"
  | "integrity_failed"
  | "blocked";

export interface TerminalBriefSidecarDispatcherApprovalHandoffOptions {
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
  approvalReference?: string;
  approval_reference?: string;
  approvalWindowMinutes?: number;
  approval_window_minutes?: number;
  handoffReference?: string;
  handoff_reference?: string;
  finalizer?: string;
  finalizer_id?: string;
  requiredReply?: string;
  required_reply?: string;
}

export interface TerminalBriefSidecarDispatcherApprovalHandoffPacket {
  kind: "a2a-broker.terminal-brief-sidecar-dispatcher-approval-handoff.packet";
  version: 1;
  generatedAt: string;
  mode: string;
  parentRoundId?: string;
  state: TerminalBriefSidecarDispatcherApprovalHandoffState;
  dryRunOnly: true;
  sourceOnlyNoLive: true;
  idempotencyKey: string;
  source: {
    dispatcherPreflightSealKind: TerminalBriefSidecarDispatcherPreflightSealPacket["kind"];
    dispatcherPreflightSealState: TerminalBriefSidecarDispatcherPreflightSealPacket["state"];
    dispatcherPreflightSealIdempotencyKey: string;
    dispatcherPreflightSealReady: boolean;
    dispatchDraftState: TerminalBriefSidecarDispatcherPreflightSealPacket["source"]["dispatchDraftState"];
    dispatchRequestReference: string;
    executorAdapterId: string;
    executionGateReference: string;
    sealReference: string;
    envelopeHash: string;
    envelopeExpiresAt: string;
    envelopeIntegrityVerified: boolean;
    commandIntent: string;
    operatorTarget: string;
    providerAcceptedIsVisibilityProof: false;
  };
  approvalHandoffDraft: {
    draftOnly: true;
    status: "draft_not_sent" | "not_ready";
    requestedAction: string;
    requestedBy: string;
    operatorTarget: string;
    operatorChannel?: string;
    approvalReference: string;
    handoffReference: string;
    approvalExpiresAt?: string;
    dispatchRequired: boolean;
    dispatchPermitted: false;
    approvalGrantPermitted: false;
    approvalGrantExecutionPermitted: false;
    startExecutorDispatchPermitted: false;
    executorInvocationPermitted: false;
    processSpawnPermitted: false;
    sidecarStartPermitted: false;
    defaultOnPermitted: false;
    liveActivationPermitted: false;
    providerSendPermitted: false;
    terminalAckPermitted: false;
    executionPermitted: false;
    dbMutationPermitted: false;
    transcriptDraft: string;
    requiredReply: string;
  };
  dispatcherApprovalBoundary: {
    handoffOnly: true;
    sourcePacketIds: string[];
    finalizerRequired: true;
    separateOperatorApprovalRequired: true;
    separateDispatcherPathRequired: true;
    approvalCanBeRequestedBy: string;
    approvalCanBeDeliveredBy: Array<"openclaw" | "hermes" | "mobilealpha" | "external">;
    mustNotTreatProviderAcceptedAsVisibilityProof: true;
    forbiddenBeforeSeparateApproval: string[];
  };
  readiness: {
    sourceCriteriaMet: boolean;
    dispatcherApprovalHandoffReady: boolean;
    approvalRequestDispatchPermitted: false;
    approvalGrantPermitted: false;
    approvalGrantExecutionPermitted: false;
    startExecutorDispatchPermitted: false;
    executorInvocationPermitted: false;
    processSpawnPermitted: false;
    sidecarStartPermitted: false;
    defaultOnPermitted: false;
    liveActivationPermitted: false;
    providerSendPermitted: false;
    terminalAckPermitted: false;
    executionPermitted: false;
    dbMutationPermitted: false;
    missingEvidence: string[];
    blockers: string[];
    nextAction: string;
  };
  blockers: string[];
  nextActions: string[];
  approvalSensitiveActionsExcluded: string[];
  integrationContract: {
    transport: "json";
    dispatcherApprovalHandoffVersion: 1;
    harnessNeutral: true;
    openclawMessageSendRequired: false;
    hermesAdapterCompatible: true;
    mobilealphaAdapterCompatible: true;
    externalHarnessCompatible: true;
    consumesDispatcherPreflightSealPacket: true;
    rendersApprovalHandoffDraft: true;
    sendsApprovalRequest: false;
    grantsApproval: false;
    executesApprovalGrant: false;
    dispatchesStartExecutor: false;
    invokesExecutor: false;
    spawnsProcess: false;
    startsSidecar: false;
    enablesDefaultOn: false;
    executesAction: false;
  };
  semantics: {
    dispatcherApprovalHandoffOnly: true;
    sourceOnlyNoLive: true;
    handoffDoesNotSendApprovalRequest: true;
    handoffDoesNotGrantApproval: true;
    handoffDoesNotDispatchExecutor: true;
    handoffDoesNotAuthorizeRuntime: true;
    messageBodyIsDraftOnly: true;
    sealedEnvelopeIsReviewMetadataOnly: true;
    providerAcceptedIsVisibilityProof: false;
    terminalAckEligibleDoesNotPermitAck: true;
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

export function buildTerminalBriefSidecarDispatcherApprovalHandoff(
  seal: TerminalBriefSidecarDispatcherPreflightSealPacket,
  options: TerminalBriefSidecarDispatcherApprovalHandoffOptions = {},
): TerminalBriefSidecarDispatcherApprovalHandoffPacket {
  const generatedAt = options.now ?? new Date().toISOString();
  const expired = isExpired(seal.sealedEnvelope.expiresAt, generatedAt);
  const blockers = buildBlockers(seal, expired);
  const missingEvidence = missingEvidenceFor(seal, expired);
  const state = stateFor(seal, expired, blockers);
  const ready = state === "dispatcher_approval_handoff_ready";
  const requestedAction = optionalString(options.requestedAction ?? options.requested_action)
    ?? "approve_terminal_brief_sidecar_dispatcher_path";
  const requestedBy = optionalString(options.requestedBy ?? options.requested_by)
    ?? optionalString(options.finalizer ?? options.finalizer_id)
    ?? seal.sealedEnvelope.sealOwner
    ?? "broker-finalizer";
  const operatorTarget = optionalString(options.operatorTarget ?? options.operator_target)
    ?? seal.source.operatorTarget
    ?? "operator";
  const operatorChannel = optionalString(options.operatorChannel ?? options.operator_channel);
  const approvalReference = optionalString(options.approvalReference ?? options.approval_reference)
    ?? buildApprovalReference(seal);
  const handoffReference = optionalString(options.handoffReference ?? options.handoff_reference)
    ?? buildHandoffReference(seal);
  const approvalExpiresAt = approvalExpiry(generatedAt, options);
  const requiredReply = optionalString(options.requiredReply ?? options.required_reply)
    ?? "approve_terminal_brief_sidecar_dispatcher_path " + approvalReference;
  const transcriptDraft = buildTranscriptDraft(
    seal,
    requestedAction,
    requestedBy,
    operatorTarget,
    approvalReference,
    handoffReference,
    requiredReply,
    approvalExpiresAt,
    ready,
  );

  return {
    kind: "a2a-broker.terminal-brief-sidecar-dispatcher-approval-handoff.packet",
    version: 1,
    generatedAt,
    mode: options.mode ?? seal.mode,
    parentRoundId: seal.parentRoundId,
    state,
    dryRunOnly: true,
    sourceOnlyNoLive: true,
    idempotencyKey: buildIdempotencyKey(seal, generatedAt, approvalReference, handoffReference, state),
    source: {
      dispatcherPreflightSealKind: seal.kind,
      dispatcherPreflightSealState: seal.state,
      dispatcherPreflightSealIdempotencyKey: seal.idempotencyKey,
      dispatcherPreflightSealReady: seal.readiness.dispatcherPreflightSealReady,
      dispatchDraftState: seal.source.dispatchDraftState,
      dispatchRequestReference: seal.source.dispatchRequestReference,
      executorAdapterId: seal.source.executorAdapterId,
      executionGateReference: seal.source.executionGateReference,
      sealReference: seal.sealedEnvelope.sealReference,
      envelopeHash: seal.sealedEnvelope.envelopeHash,
      envelopeExpiresAt: seal.sealedEnvelope.expiresAt,
      envelopeIntegrityVerified: seal.sealedEnvelope.integrityVerified,
      commandIntent: seal.sealedEnvelope.commandIntent,
      operatorTarget,
      providerAcceptedIsVisibilityProof: false,
    },
    approvalHandoffDraft: {
      draftOnly: true,
      status: ready ? "draft_not_sent" : "not_ready",
      requestedAction,
      requestedBy,
      operatorTarget,
      operatorChannel,
      approvalReference,
      handoffReference,
      approvalExpiresAt,
      dispatchRequired: ready,
      dispatchPermitted: false,
      approvalGrantPermitted: false,
      approvalGrantExecutionPermitted: false,
      startExecutorDispatchPermitted: false,
      executorInvocationPermitted: false,
      processSpawnPermitted: false,
      sidecarStartPermitted: false,
      defaultOnPermitted: false,
      liveActivationPermitted: false,
      providerSendPermitted: false,
      terminalAckPermitted: false,
      executionPermitted: false,
      dbMutationPermitted: false,
      transcriptDraft,
      requiredReply,
    },
    dispatcherApprovalBoundary: {
      handoffOnly: true,
      sourcePacketIds: [seal.idempotencyKey, seal.source.dispatchDraftIdempotencyKey, seal.source.executionGateReference],
      finalizerRequired: true,
      separateOperatorApprovalRequired: true,
      separateDispatcherPathRequired: true,
      approvalCanBeRequestedBy: requestedBy,
      approvalCanBeDeliveredBy: ["openclaw", "hermes", "mobilealpha", "external"],
      mustNotTreatProviderAcceptedAsVisibilityProof: true,
      forbiddenBeforeSeparateApproval: forbiddenBeforeSeparateApproval(),
    },
    readiness: {
      sourceCriteriaMet: ready,
      dispatcherApprovalHandoffReady: ready,
      approvalRequestDispatchPermitted: false,
      approvalGrantPermitted: false,
      approvalGrantExecutionPermitted: false,
      startExecutorDispatchPermitted: false,
      executorInvocationPermitted: false,
      processSpawnPermitted: false,
      sidecarStartPermitted: false,
      defaultOnPermitted: false,
      liveActivationPermitted: false,
      providerSendPermitted: false,
      terminalAckPermitted: false,
      executionPermitted: false,
      dbMutationPermitted: false,
      missingEvidence,
      blockers: [
        ...blockers,
        "dispatcher approval handoff is not an approval send or approval grant",
        "runtime execution requires later separate approved dispatcher path",
      ],
      nextAction: nextActionFor(state),
    },
    blockers,
    nextActions: nextActionsFor(state),
    approvalSensitiveActionsExcluded: approvalSensitiveActionsExcluded(),
    integrationContract: {
      transport: "json",
      dispatcherApprovalHandoffVersion: 1,
      harnessNeutral: true,
      openclawMessageSendRequired: false,
      hermesAdapterCompatible: true,
      mobilealphaAdapterCompatible: true,
      externalHarnessCompatible: true,
      consumesDispatcherPreflightSealPacket: true,
      rendersApprovalHandoffDraft: true,
      sendsApprovalRequest: false,
      grantsApproval: false,
      executesApprovalGrant: false,
      dispatchesStartExecutor: false,
      invokesExecutor: false,
      spawnsProcess: false,
      startsSidecar: false,
      enablesDefaultOn: false,
      executesAction: false,
    },
    semantics: {
      dispatcherApprovalHandoffOnly: true,
      sourceOnlyNoLive: true,
      handoffDoesNotSendApprovalRequest: true,
      handoffDoesNotGrantApproval: true,
      handoffDoesNotDispatchExecutor: true,
      handoffDoesNotAuthorizeRuntime: true,
      messageBodyIsDraftOnly: true,
      sealedEnvelopeIsReviewMetadataOnly: true,
      providerAcceptedIsVisibilityProof: false,
      terminalAckEligibleDoesNotPermitAck: true,
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

export function extractTerminalBriefSidecarDispatcherApprovalHandoffSeal(
  input: unknown,
): TerminalBriefSidecarDispatcherPreflightSealPacket {
  const envelope = isRecord(input) ? input : {};
  const candidates = [
    input,
    envelope.dispatcherPreflightSealPacket,
    envelope.dispatcherPreflightSeal,
    envelope.sidecarDispatcherPreflightSealPacket,
    envelope.sidecarDispatcherPreflightSeal,
    envelope.preflightSealPacket,
    envelope.packet,
  ];
  const packet = candidates.find(isTerminalBriefSidecarDispatcherPreflightSealPacket);
  if (!packet) {
    throw new Error("expected a Terminal Brief sidecar dispatcher preflight seal packet");
  }
  return packet;
}

export function extractTerminalBriefSidecarDispatcherApprovalHandoffOptions(
  input: unknown,
): TerminalBriefSidecarDispatcherApprovalHandoffOptions {
  const envelope = isRecord(input) ? input : {};
  const candidate = envelope.dispatcherApprovalHandoff
    ?? envelope.dispatcherApprovalHandoffOptions
    ?? envelope.approvalHandoff
    ?? envelope.options;
  return isRecord(candidate) ? candidate as TerminalBriefSidecarDispatcherApprovalHandoffOptions : {};
}

export function renderTerminalBriefSidecarDispatcherApprovalHandoffMarkdown(
  packet: TerminalBriefSidecarDispatcherApprovalHandoffPacket,
): string {
  return [
    titleForState(packet.state),
    "Mode: " + packet.mode,
    "Parent round: " + (packet.parentRoundId ?? "unknown"),
    "State: " + packet.state + " dryRunOnly=" + packet.dryRunOnly + " sourceOnlyNoLive=" + packet.sourceOnlyNoLive,
    "Idempotency: " + packet.idempotencyKey,
    "Source seal: state=" + packet.source.dispatcherPreflightSealState
      + " ready=" + packet.source.dispatcherPreflightSealReady
      + " integrityVerified=" + packet.source.envelopeIntegrityVerified
      + " sealReference=" + packet.source.sealReference,
    "Approval handoff: reference=" + packet.approvalHandoffDraft.handoffReference
      + " requestedAction=" + packet.approvalHandoffDraft.requestedAction
      + " dispatchPermitted=" + packet.approvalHandoffDraft.dispatchPermitted
      + " approvalGrantPermitted=" + packet.approvalHandoffDraft.approvalGrantPermitted,
    "",
    "Readiness: sourceCriteriaMet=" + packet.readiness.sourceCriteriaMet
      + " dispatcherApprovalHandoffReady=" + packet.readiness.dispatcherApprovalHandoffReady
      + " approvalRequestDispatchPermitted=" + packet.readiness.approvalRequestDispatchPermitted
      + " startExecutorDispatchPermitted=" + packet.readiness.startExecutorDispatchPermitted
      + " executorInvocationPermitted=" + packet.readiness.executorInvocationPermitted
      + " processSpawnPermitted=" + packet.readiness.processSpawnPermitted
      + " terminalAckPermitted=" + packet.readiness.terminalAckPermitted
      + " executionPermitted=" + packet.readiness.executionPermitted,
    ...(packet.blockers.length ? ["", "Blockers:", ...packet.blockers.map((blocker) => "- " + blocker)] : []),
    "",
    "Next actions:",
    ...packet.nextActions.map((action) => "- " + action),
    "",
    "Safety: dispatcher approval handoff only; does not send approval, grant approval, dispatch/invoke executor, spawn a process, start sidecar, enable default-on, send providers, ACK/replay terminal rows, mutate GitHub/DB/TaskFlow state, restart/deploy, replay history, release, publish, or move secrets.",
  ].join("\n");
}

function buildBlockers(
  seal: TerminalBriefSidecarDispatcherPreflightSealPacket,
  expired: boolean,
): string[] {
  return unique([
    ...seal.blockers,
    ...(seal.state !== "dispatcher_preflight_seal_ready" ? ["dispatcher preflight seal state is " + seal.state] : []),
    ...(!seal.readiness.dispatcherPreflightSealReady ? ["dispatcher preflight seal is not ready"] : []),
    ...(!seal.readiness.sourceCriteriaMet ? ["dispatcher preflight source criteria are not met"] : []),
    ...(!seal.sealedEnvelope.integrityVerified ? ["sealed envelope integrity is not verified"] : []),
    ...(expired ? ["sealed envelope expired at " + seal.sealedEnvelope.expiresAt] : []),
    ...(seal.readiness.approvalRequestDispatchPermitted !== false ? ["seal unexpectedly permits approval dispatch"] : []),
    ...(seal.readiness.approvalGrantPermitted !== false ? ["seal unexpectedly permits approval grant"] : []),
    ...(seal.readiness.approvalGrantExecutionPermitted !== false ? ["seal unexpectedly permits approval grant execution"] : []),
    ...(seal.readiness.startExecutorDispatchPermitted !== false ? ["seal unexpectedly permits executor dispatch"] : []),
    ...(seal.readiness.executorInvocationPermitted !== false ? ["seal unexpectedly permits executor invocation"] : []),
    ...(seal.readiness.processSpawnPermitted !== false ? ["seal unexpectedly permits process spawn"] : []),
    ...(seal.readiness.sidecarStartPermitted !== false ? ["seal unexpectedly permits sidecar start"] : []),
    ...(seal.readiness.defaultOnPermitted !== false ? ["seal unexpectedly permits default-on"] : []),
    ...(seal.readiness.liveActivationPermitted !== false ? ["seal unexpectedly permits live activation"] : []),
    ...(seal.readiness.providerSendPermitted !== false ? ["seal unexpectedly permits provider send"] : []),
    ...(seal.readiness.terminalAckPermitted !== false ? ["seal unexpectedly permits terminal ACK"] : []),
    ...(seal.readiness.executionPermitted !== false ? ["seal unexpectedly permits execution"] : []),
    ...(seal.readiness.dbMutationPermitted !== false ? ["seal unexpectedly permits DB mutation"] : []),
    ...(!seal.sealedEnvelope.sealOnly ? ["sealed envelope is not seal-only"] : []),
    ...(!seal.sealedEnvelope.metadataOnly ? ["sealed envelope is not metadata-only"] : []),
    ...(seal.sealedEnvelope.secretValuesIncluded ? ["sealed envelope unexpectedly includes secret values"] : []),
    ...(seal.sealedEnvelope.writesRuntimeState ? ["sealed envelope unexpectedly writes runtime state"] : []),
    ...(seal.integrationContract.sendsApprovalRequest ? ["seal unexpectedly sends approval request"] : []),
    ...(seal.integrationContract.grantsApproval ? ["seal unexpectedly grants approval"] : []),
    ...(seal.integrationContract.executesApprovalGrant ? ["seal unexpectedly executes approval grant"] : []),
    ...(seal.integrationContract.dispatchesStartExecutor ? ["seal unexpectedly dispatches start executor"] : []),
    ...(seal.integrationContract.invokesExecutor ? ["seal unexpectedly invokes executor"] : []),
    ...(seal.integrationContract.spawnsProcess ? ["seal unexpectedly spawns process"] : []),
    ...(seal.integrationContract.startsSidecar ? ["seal unexpectedly starts sidecar"] : []),
    ...(seal.integrationContract.executesAction ? ["seal unexpectedly executes action"] : []),
    ...(seal.semantics.performsProviderSend ? ["seal unexpectedly performs provider send"] : []),
    ...(seal.semantics.performsTerminalAck ? ["seal unexpectedly performs terminal ACK"] : []),
    ...(seal.semantics.performsRuntimeRestartOrDeploy ? ["seal unexpectedly performs restart/deploy"] : []),
    ...(seal.semantics.performsDbMutation ? ["seal unexpectedly performs DB mutation"] : []),
    ...(seal.semantics.performsHistoricalReplay ? ["seal unexpectedly performs historical replay"] : []),
    ...(seal.semantics.performsReleaseOrPublish ? ["seal unexpectedly performs release/publish"] : []),
    ...(seal.semantics.movesSecretsOrCredentials ? ["seal unexpectedly moves secrets/credentials"] : []),
  ].filter(Boolean));
}

function missingEvidenceFor(
  seal: TerminalBriefSidecarDispatcherPreflightSealPacket,
  expired: boolean,
): string[] {
  const missing: string[] = [];
  if (seal.state !== "dispatcher_preflight_seal_ready") missing.push("ready_dispatcher_preflight_seal");
  if (!seal.readiness.dispatcherPreflightSealReady) missing.push("dispatcher_preflight_seal_ready");
  if (!seal.readiness.sourceCriteriaMet) missing.push("source_criteria");
  if (!seal.sealedEnvelope.integrityVerified) missing.push("envelope_integrity");
  if (expired) missing.push("fresh_sealed_envelope");
  return unique(missing);
}

function stateFor(
  seal: TerminalBriefSidecarDispatcherPreflightSealPacket,
  expired: boolean,
  blockers: string[],
): TerminalBriefSidecarDispatcherApprovalHandoffState {
  if (seal.state === "integrity_failed" || !seal.sealedEnvelope.integrityVerified) return "integrity_failed";
  if (expired) return "seal_expired";
  if (hasUnsafeNoLiveViolation(seal) || seal.state === "blocked") return "blocked";
  if (seal.state !== "dispatcher_preflight_seal_ready") return "waiting_for_dispatcher_preflight_seal";
  return blockers.length ? "blocked" : "dispatcher_approval_handoff_ready";
}

function hasUnsafeNoLiveViolation(seal: TerminalBriefSidecarDispatcherPreflightSealPacket): boolean {
  return seal.readiness.approvalRequestDispatchPermitted !== false
    || seal.readiness.approvalGrantPermitted !== false
    || seal.readiness.approvalGrantExecutionPermitted !== false
    || seal.readiness.startExecutorDispatchPermitted !== false
    || seal.readiness.executorInvocationPermitted !== false
    || seal.readiness.processSpawnPermitted !== false
    || seal.readiness.sidecarStartPermitted !== false
    || seal.readiness.defaultOnPermitted !== false
    || seal.readiness.liveActivationPermitted !== false
    || seal.readiness.providerSendPermitted !== false
    || seal.readiness.terminalAckPermitted !== false
    || seal.readiness.executionPermitted !== false
    || seal.readiness.dbMutationPermitted !== false
    || seal.integrationContract.sendsApprovalRequest
    || seal.integrationContract.grantsApproval
    || seal.integrationContract.executesApprovalGrant
    || seal.integrationContract.dispatchesStartExecutor
    || seal.integrationContract.invokesExecutor
    || seal.integrationContract.spawnsProcess
    || seal.integrationContract.startsSidecar
    || seal.integrationContract.executesAction
    || seal.semantics.performsProviderSend
    || seal.semantics.performsTerminalAck
    || seal.semantics.performsRuntimeRestartOrDeploy
    || seal.semantics.performsDbMutation
    || seal.semantics.performsHistoricalReplay
    || seal.semantics.performsReleaseOrPublish
    || seal.semantics.movesSecretsOrCredentials;
}

function buildTranscriptDraft(
  seal: TerminalBriefSidecarDispatcherPreflightSealPacket,
  requestedAction: string,
  requestedBy: string,
  operatorTarget: string,
  approvalReference: string,
  handoffReference: string,
  requiredReply: string,
  approvalExpiresAt: string | undefined,
  ready: boolean,
): string {
  return [
    "Terminal Brief sidecar dispatcher approval handoff",
    "Status: " + (ready ? "draft_not_sent" : "not_ready"),
    "Action: " + requestedAction,
    "Requested by: " + requestedBy,
    "Operator target: " + operatorTarget,
    "Approval reference: " + approvalReference,
    "Handoff reference: " + handoffReference,
    "Seal reference: " + seal.sealedEnvelope.sealReference,
    "Dispatch request: " + seal.source.dispatchRequestReference,
    "Executor adapter: " + seal.source.executorAdapterId,
    ...(approvalExpiresAt ? ["Approval expires at: " + approvalExpiresAt] : []),
    "Required reply: " + requiredReply,
    "Safety: this is a source-only handoff draft. It does not send the request, grant approval, dispatch or invoke an executor, spawn a process, start sidecar, enable default-on, send providers, ACK terminal rows, mutate DB/GitHub/TaskFlow, restart/deploy, replay history, release, publish, or move secrets.",
  ].join("\n");
}

function nextActionFor(state: TerminalBriefSidecarDispatcherApprovalHandoffState): string {
  if (state === "dispatcher_approval_handoff_ready") {
    return "broker finalizer may review this handoff and choose a separately approved sender before any dispatcher approval request dispatch";
  }
  if (state === "waiting_for_dispatcher_preflight_seal") return "wait for a ready dispatcher preflight seal packet";
  if (state === "seal_expired") return "refresh the dispatcher preflight seal before handoff";
  if (state === "integrity_failed") return "rebuild the dispatcher preflight seal from the current dispatch request draft";
  return "resolve blocked dispatcher approval handoff evidence";
}

function nextActionsFor(state: TerminalBriefSidecarDispatcherApprovalHandoffState): string[] {
  return [
    nextActionFor(state),
    "do not send approval, grant approval, dispatch executor, invoke executor, spawn process, start sidecar, ACK terminal rows, or mutate state from this packet",
  ];
}

function forbiddenBeforeSeparateApproval(): string[] {
  return [
    "approval request dispatch",
    "approval grant or approval grant execution",
    "start executor dispatch or executor invocation",
    "process spawn",
    "sidecar start/stop/restart/apply",
    "Terminal Brief default-on enablement",
    "live provider/Hermes/mobilealpha/Telegram/OpenClaw send",
    "terminal ACK/replay or receipt DB mutation",
    "TaskFlow or broker DB mutation",
    "production deploy/restart, historical replay, release, publish, or secret movement",
  ];
}

function approvalExpiry(
  generatedAt: string,
  options: TerminalBriefSidecarDispatcherApprovalHandoffOptions,
): string | undefined {
  const minutes = numberValue(options.approvalWindowMinutes ?? options.approval_window_minutes);
  if (!minutes) return undefined;
  return new Date(Date.parse(generatedAt) + minutes * 60 * 1000).toISOString();
}

function isExpired(expiresAt: string, now: string): boolean {
  return Date.parse(expiresAt) <= Date.parse(now);
}

function buildApprovalReference(seal: TerminalBriefSidecarDispatcherPreflightSealPacket): string {
  return "dispatcher-approval:" + createHash("sha256").update(seal.idempotencyKey).digest("hex").slice(0, 16);
}

function buildHandoffReference(seal: TerminalBriefSidecarDispatcherPreflightSealPacket): string {
  return "dispatcher-approval-handoff:" + createHash("sha256").update(seal.sealedEnvelope.envelopeHash).digest("hex").slice(0, 16);
}

function buildIdempotencyKey(
  seal: TerminalBriefSidecarDispatcherPreflightSealPacket,
  generatedAt: string,
  approvalReference: string,
  handoffReference: string,
  state: TerminalBriefSidecarDispatcherApprovalHandoffState,
): string {
  const base = JSON.stringify({
    label: "terminal-brief-sidecar-dispatcher-approval-handoff",
    seal: seal.idempotencyKey,
    generatedAt,
    approvalReference,
    handoffReference,
    state,
  });
  return "tb-sidecar-dispatcher-approval-handoff:" + createHash("sha256").update(base).digest("hex").slice(0, 24);
}

function titleForState(state: TerminalBriefSidecarDispatcherApprovalHandoffState): string {
  if (state === "dispatcher_approval_handoff_ready") return "Ready: Terminal Brief sidecar dispatcher approval handoff";
  if (state === "waiting_for_dispatcher_preflight_seal") return "Waiting: Terminal Brief sidecar dispatcher preflight seal";
  if (state === "seal_expired") return "Expired: Terminal Brief sidecar dispatcher approval handoff";
  if (state === "integrity_failed") return "Integrity failed: Terminal Brief sidecar dispatcher approval handoff";
  return "Blocked: Terminal Brief sidecar dispatcher approval handoff";
}

function isTerminalBriefSidecarDispatcherPreflightSealPacket(
  value: unknown,
): value is TerminalBriefSidecarDispatcherPreflightSealPacket {
  return isRecord(value) && value.kind === "a2a-broker.terminal-brief-sidecar-dispatcher-preflight-seal.packet";
}

