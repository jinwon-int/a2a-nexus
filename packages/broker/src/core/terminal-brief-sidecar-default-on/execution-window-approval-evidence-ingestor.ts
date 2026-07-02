import { unique } from "../collections.js";
import { isRecord } from "../value-guards.js";
import { createHash } from "node:crypto";

import type { TerminalBriefSidecarDefaultOnExecutionWindowRequestDraftPacket } from "./execution-window-request-draft.js";

export type TerminalBriefSidecarDefaultOnExecutionWindowApprovalEvidenceState =
  | "accepted"
  | "insufficient"
  | "rejected"
  | "stale"
  | "conflicting"
  | "blocked";

export type TerminalBriefSidecarDefaultOnExecutionWindowEvidenceKind =
  | "current_session_visible"
  | "manual_operator_confirmation"
  | "provider_accepted"
  | "approval_grant"
  | "approval_rejection"
  | "expired"
  | "conflict"
  | "unknown";

export interface TerminalBriefSidecarDefaultOnExecutionWindowEvidenceRecord {
  kind: TerminalBriefSidecarDefaultOnExecutionWindowEvidenceKind;
  evidenceId?: string;
  observedAt?: string;
  approvalReference?: string;
  executionWindowReference?: string;
  requestedAction?: string;
  operatorTarget?: string;
  replyText?: string;
  source?: string;
  note?: string;
}

export interface TerminalBriefSidecarDefaultOnExecutionWindowApprovalEvidenceIngestorOptions {
  now?: string;
  mode?: string;
  finalizer?: string;
  finalizerId?: string;
}

export interface TerminalBriefSidecarDefaultOnExecutionWindowApprovalEvidenceIngestorPacket {
  kind: "a2a-broker.terminal-brief-sidecar-default-on-execution-window-approval-evidence-ingestor.packet";
  version: 1;
  generatedAt: string;
  mode: string;
  state: TerminalBriefSidecarDefaultOnExecutionWindowApprovalEvidenceState;
  dryRunOnly: false;
  sourceOnlyNoLive: true;
  idempotencyKey: string;
  receiptEvidenceAccepted: boolean;
  approvalEvidenceAccepted: boolean;
  source: {
    executionWindowRequestDraftKind: TerminalBriefSidecarDefaultOnExecutionWindowRequestDraftPacket["kind"];
    executionWindowRequestDraftState: TerminalBriefSidecarDefaultOnExecutionWindowRequestDraftPacket["state"];
    executionWindowRequestDraftIdempotencyKey: string;
    executionWindowRequestDraftReady: boolean;
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
  classification: {
    receiptProofAccepted: boolean;
    approvalGrantEvidenceAccepted: boolean;
    providerAcceptedIsVisibilityProof: false;
    approvalGrantEvidenceExecutesGrant: false;
    terminalAckEligibleDoesNotPermitAck: true;
    acceptedReceiptKinds: Array<"current_session_visible" | "manual_operator_confirmation">;
    acceptedApprovalEvidenceIds: string[];
    rejectedEvidenceIds: string[];
    staleEvidenceIds: string[];
    conflictingEvidenceIds: string[];
    unsupportedEvidenceIds: string[];
    reasons: string[];
  };
  readiness: {
    sourceCriteriaMet: boolean;
    executionWindowApprovalEvidenceAccepted: boolean;
    receiptEvidenceAccepted: boolean;
    approvalEvidenceAccepted: boolean;
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
  evidenceRecords: TerminalBriefSidecarDefaultOnExecutionWindowEvidenceRecord[];
  blockers: string[];
  nextActions: string[];
  approvalSensitiveActionsExcluded: string[];
  integrationContract: {
    transport: "json";
    executionWindowApprovalEvidenceVersion: 1;
    consumesExecutionWindowRequestDraftPacket: true;
    classifiesReceiptEvidence: true;
    classifiesApprovalEvidence: true;
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
    executionWindowApprovalEvidenceOnly: true;
    sourceOnlyNoLive: true;
    providerAcceptedIsVisibilityProof: false;
    approvalGrantEvidenceExecutesGrant: false;
    approvalEvidenceDoesNotGrantApproval: true;
    approvalEvidenceDoesNotCreateCheckpoint: true;
    approvalEvidenceDoesNotExecuteRollback: true;
    approvalEvidenceDoesNotWriteConfig: true;
    approvalEvidenceDoesNotEnableDefaultOn: true;
    approvalEvidenceDoesNotRestartSidecar: true;
    approvalEvidenceDoesNotDispatchExecutor: true;
    approvalEvidenceDoesNotInvokeExecutor: true;
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

export function buildTerminalBriefSidecarDefaultOnExecutionWindowApprovalEvidenceIngestor(
  request: TerminalBriefSidecarDefaultOnExecutionWindowRequestDraftPacket,
  evidenceRecords: TerminalBriefSidecarDefaultOnExecutionWindowEvidenceRecord[],
  options: TerminalBriefSidecarDefaultOnExecutionWindowApprovalEvidenceIngestorOptions = {},
): TerminalBriefSidecarDefaultOnExecutionWindowApprovalEvidenceIngestorPacket {
  const generatedAt = options.now ?? new Date().toISOString();
  const sourceIssues = sourceBlockers(request);
  const classification = classifyEvidence(request, evidenceRecords);
  const state = stateFor(sourceIssues, classification, evidenceRecords);
  const receiptEvidenceAccepted = state === "accepted" && classification.receiptProofAccepted;
  const approvalEvidenceAccepted = state === "accepted" && classification.approvalGrantEvidenceAccepted;
  const blockers = unique([
    ...sourceIssues,
    ...classification.reasons,
    ...(state === "accepted" ? [] : ["execution window approval evidence is not accepted"]),
  ]);

  return {
    kind: "a2a-broker.terminal-brief-sidecar-default-on-execution-window-approval-evidence-ingestor.packet",
    version: 1,
    generatedAt,
    mode: options.mode ?? "terminal-brief-default-on-execution-window-approval-evidence-ingestor-source-only",
    state,
    dryRunOnly: false,
    sourceOnlyNoLive: true,
    idempotencyKey: buildIdempotencyKey(request, evidenceRecords, generatedAt, state),
    receiptEvidenceAccepted,
    approvalEvidenceAccepted,
    source: {
      executionWindowRequestDraftKind: request.kind,
      executionWindowRequestDraftState: request.state,
      executionWindowRequestDraftIdempotencyKey: request.idempotencyKey,
      executionWindowRequestDraftReady: request.readiness.executionWindowRequestDraftReady,
      executionWindowReference: request.executionWindowRequestDraft.executionWindowReference,
      requestedAction: request.executionWindowRequestDraft.requestedAction,
      requestedBy: request.executionWindowRequestDraft.requestedBy,
      operatorTarget: request.executionWindowRequestDraft.operatorTarget,
      requiredReply: request.executionWindowRequestDraft.requiredReply,
      checkpointReference: request.source.checkpointReference,
      targetConfigFile: request.source.targetConfigFile,
      backupLocation: request.source.backupLocation,
      runtimeTarget: request.source.runtimeTarget,
      configKey: request.source.configKey,
      proposedValue: request.source.proposedValue,
      executorId: request.source.executorId,
    },
    classification: {
      receiptProofAccepted: classification.receiptProofAccepted,
      approvalGrantEvidenceAccepted: classification.approvalGrantEvidenceAccepted,
      providerAcceptedIsVisibilityProof: false,
      approvalGrantEvidenceExecutesGrant: false,
      terminalAckEligibleDoesNotPermitAck: true,
      acceptedReceiptKinds: classification.acceptedReceiptKinds,
      acceptedApprovalEvidenceIds: classification.acceptedApprovalEvidenceIds,
      rejectedEvidenceIds: classification.rejectedEvidenceIds,
      staleEvidenceIds: classification.staleEvidenceIds,
      conflictingEvidenceIds: classification.conflictingEvidenceIds,
      unsupportedEvidenceIds: classification.unsupportedEvidenceIds,
      reasons: classification.reasons,
    },
    readiness: {
      sourceCriteriaMet: state === "accepted",
      executionWindowApprovalEvidenceAccepted: state === "accepted",
      receiptEvidenceAccepted,
      approvalEvidenceAccepted,
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
      missingEvidence: missingEvidence(request, classification),
      blockers: [
        ...blockers,
        "execution window approval evidence is source-only and does not execute default-on",
        "checkpoint creation, config write, default-on enablement, and sidecar apply require a later explicit runtime mutation executor",
      ],
      nextAction: nextActionFor(state),
    },
    evidenceRecords: evidenceRecords.map(normalizeRecord),
    blockers,
    nextActions: nextActionsFor(state),
    approvalSensitiveActionsExcluded: approvalSensitiveActionsExcluded(),
    integrationContract: {
      transport: "json",
      executionWindowApprovalEvidenceVersion: 1,
      consumesExecutionWindowRequestDraftPacket: true,
      classifiesReceiptEvidence: true,
      classifiesApprovalEvidence: true,
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
      executionWindowApprovalEvidenceOnly: true,
      sourceOnlyNoLive: true,
      providerAcceptedIsVisibilityProof: false,
      approvalGrantEvidenceExecutesGrant: false,
      approvalEvidenceDoesNotGrantApproval: true,
      approvalEvidenceDoesNotCreateCheckpoint: true,
      approvalEvidenceDoesNotExecuteRollback: true,
      approvalEvidenceDoesNotWriteConfig: true,
      approvalEvidenceDoesNotEnableDefaultOn: true,
      approvalEvidenceDoesNotRestartSidecar: true,
      approvalEvidenceDoesNotDispatchExecutor: true,
      approvalEvidenceDoesNotInvokeExecutor: true,
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

export function extractTerminalBriefSidecarDefaultOnExecutionWindowApprovalEvidenceRequestDraft(
  input: unknown,
): TerminalBriefSidecarDefaultOnExecutionWindowRequestDraftPacket {
  const envelope = isRecord(input) ? input : {};
  const candidates = [
    input,
    envelope.defaultOnExecutionWindowRequestDraftPacket,
    envelope.executionWindowRequestDraftPacket,
    envelope.executionWindowRequestDraft,
    envelope.requestDraft,
    envelope.packet,
  ];
  const packet = candidates.find(isExecutionWindowRequestDraftPacket);
  if (!packet) throw new Error("expected a Terminal Brief sidecar default-on execution window request draft packet");
  return packet;
}

export function extractTerminalBriefSidecarDefaultOnExecutionWindowApprovalEvidence(
  input: unknown,
): TerminalBriefSidecarDefaultOnExecutionWindowEvidenceRecord[] {
  const envelope = isRecord(input) ? input : {};
  const source = isRecord(envelope.executionWindowApprovalEvidence)
    ? envelope.executionWindowApprovalEvidence
    : isRecord(envelope.approvalEvidence)
      ? envelope.approvalEvidence
      : isRecord(envelope.evidence)
        ? envelope.evidence
        : envelope;
  const records = Array.isArray(source.records)
    ? source.records
    : Array.isArray(source.evidenceRecords)
      ? source.evidenceRecords
      : [];
  return records.map(toEvidenceRecord);
}

export function extractTerminalBriefSidecarDefaultOnExecutionWindowApprovalEvidenceIngestorOptions(
  input: unknown,
): TerminalBriefSidecarDefaultOnExecutionWindowApprovalEvidenceIngestorOptions {
  const envelope = isRecord(input) ? input : {};
  const options = isRecord(envelope.defaultOnExecutionWindowApprovalEvidenceIngestor)
    ? envelope.defaultOnExecutionWindowApprovalEvidenceIngestor
    : isRecord(envelope.executionWindowApprovalEvidenceIngestor)
      ? envelope.executionWindowApprovalEvidenceIngestor
      : isRecord(envelope.options)
        ? envelope.options
        : {};
  return options as TerminalBriefSidecarDefaultOnExecutionWindowApprovalEvidenceIngestorOptions;
}

export function renderTerminalBriefSidecarDefaultOnExecutionWindowApprovalEvidenceMarkdown(
  packet: TerminalBriefSidecarDefaultOnExecutionWindowApprovalEvidenceIngestorPacket,
): string {
  return [
    titleForState(packet.state),
    "Mode: " + packet.mode,
    "State: " + packet.state + " sourceOnlyNoLive=" + packet.sourceOnlyNoLive,
    "Idempotency: " + packet.idempotencyKey,
    "Request draft: state=" + packet.source.executionWindowRequestDraftState
      + " ready=" + packet.source.executionWindowRequestDraftReady
      + " reference=" + packet.source.executionWindowReference,
    "Evidence: receiptEvidenceAccepted=" + packet.receiptEvidenceAccepted
      + " approvalEvidenceAccepted=" + packet.approvalEvidenceAccepted
      + " providerAcceptedIsVisibilityProof=" + packet.classification.providerAcceptedIsVisibilityProof
      + " approvalGrantEvidenceExecutesGrant=" + packet.classification.approvalGrantEvidenceExecutesGrant,
    "Readiness: checkpointCreationPermitted=" + packet.readiness.checkpointCreationPermitted
      + " configWritePermitted=" + packet.readiness.configWritePermitted
      + " defaultOnPermitted=" + packet.readiness.defaultOnPermitted
      + " sidecarRestartPermitted=" + packet.readiness.sidecarRestartPermitted
      + " executorInvocationPermitted=" + packet.readiness.executorInvocationPermitted
      + " executionPermitted=" + packet.readiness.executionPermitted
      + " processSpawnPermitted=" + packet.readiness.processSpawnPermitted,
    ...(packet.blockers.length ? ["", "Blockers:", ...packet.blockers.map((blocker) => "- " + blocker)] : []),
    "",
    "Next actions:",
    ...packet.nextActions.map((action) => "- " + action),
    "",
    "Safety: execution window approval evidence only; evidence does not send requests, grant or execute approval, create checkpoints, write config, enable default-on, restart/apply sidecar, dispatch/invoke executors, spawn processes, send providers, ACK/replay terminal rows, mutate GitHub/DB/TaskFlow state, restart Gateway/broker, release, publish, or move secrets.",
  ].join("\n");
}

function sourceBlockers(request: TerminalBriefSidecarDefaultOnExecutionWindowRequestDraftPacket): string[] {
  return unique([
    ...request.blockers,
    ...(request.state !== "execution_window_request_draft_ready" ? ["execution window request draft state is " + request.state] : []),
    ...(!request.readiness.executionWindowRequestDraftReady ? ["execution window request draft is not ready"] : []),
    ...(request.sourceOnlyNoLive !== true ? ["execution window request draft is not source-only no-live"] : []),
    ...(request.executionWindowRequestDraft.status !== "draft_not_sent" ? ["execution window request draft status is not draft_not_sent"] : []),
    ...(request.executionWindowRequestDraft.dispatchPermitted !== false ? ["request draft unexpectedly permits dispatch"] : []),
    ...(request.executionWindowRequestDraft.approvalGrantPermitted !== false ? ["request draft unexpectedly permits approval grant"] : []),
    ...(request.executionWindowRequestDraft.checkpointCreationPermitted !== false ? ["request draft unexpectedly permits checkpoint creation"] : []),
    ...(request.executionWindowRequestDraft.configWritePermitted !== false ? ["request draft unexpectedly permits config write"] : []),
    ...(request.executionWindowRequestDraft.defaultOnPermitted !== false ? ["request draft unexpectedly permits default-on"] : []),
    ...(request.executionWindowRequestDraft.sidecarRestartPermitted !== false ? ["request draft unexpectedly permits sidecar restart"] : []),
    ...(request.executionWindowRequestDraft.executorInvocationPermitted !== false ? ["request draft unexpectedly permits executor invocation"] : []),
    ...(request.executionWindowRequestDraft.executionPermitted !== false ? ["request draft unexpectedly permits execution"] : []),
    ...(request.executionWindowRequestDraft.processSpawnPermitted !== false ? ["request draft unexpectedly permits process spawn"] : []),
    ...(request.readiness.executionWindowRequestDispatchPermitted !== false ? ["readiness unexpectedly permits request dispatch"] : []),
    ...(request.readiness.approvalGrantPermitted !== false ? ["readiness unexpectedly permits approval grant"] : []),
    ...(request.readiness.approvalGrantExecutionPermitted !== false ? ["readiness unexpectedly permits approval grant execution"] : []),
    ...(request.readiness.checkpointCreationPermitted !== false ? ["readiness unexpectedly permits checkpoint creation"] : []),
    ...(request.readiness.rollbackExecutionPermitted !== false ? ["readiness unexpectedly permits rollback execution"] : []),
    ...(request.readiness.configWritePermitted !== false ? ["readiness unexpectedly permits config write"] : []),
    ...(request.readiness.defaultOnPermitted !== false ? ["readiness unexpectedly permits default-on"] : []),
    ...(request.readiness.sidecarRestartPermitted !== false ? ["readiness unexpectedly permits sidecar restart"] : []),
    ...(request.readiness.providerSendPermitted !== false ? ["readiness unexpectedly permits provider send"] : []),
    ...(request.readiness.terminalAckPermitted !== false ? ["readiness unexpectedly permits terminal ACK"] : []),
    ...(request.readiness.dbMutationPermitted !== false ? ["readiness unexpectedly permits DB mutation"] : []),
    ...(request.readiness.taskFlowMutationPermitted !== false ? ["readiness unexpectedly permits TaskFlow mutation"] : []),
    ...(request.readiness.startExecutorDispatchPermitted !== false ? ["readiness unexpectedly permits start executor dispatch"] : []),
    ...(request.readiness.executorInvocationPermitted !== false ? ["readiness unexpectedly permits executor invocation"] : []),
    ...(request.readiness.executionPermitted !== false ? ["readiness unexpectedly permits execution"] : []),
    ...(request.readiness.processSpawnPermitted !== false ? ["readiness unexpectedly permits process spawn"] : []),
    ...(request.integrationContract.sendsExecutionWindowRequest ? ["request draft unexpectedly sends execution window request"] : []),
    ...(request.integrationContract.grantsApproval ? ["request draft unexpectedly grants approval"] : []),
    ...(request.integrationContract.createsCheckpoint ? ["request draft unexpectedly creates checkpoint"] : []),
    ...(request.integrationContract.writesConfig ? ["request draft unexpectedly writes config"] : []),
    ...(request.integrationContract.enablesDefaultOn ? ["request draft unexpectedly enables default-on"] : []),
    ...(request.integrationContract.restartsSidecar ? ["request draft unexpectedly restarts sidecar"] : []),
    ...(request.integrationContract.executesAction ? ["request draft unexpectedly executes action"] : []),
    ...(request.semantics.requestDoesNotGrantApproval !== true ? ["request draft does not preserve approval boundary"] : []),
    ...(request.semantics.requestDoesNotCreateCheckpoint !== true ? ["request draft does not preserve checkpoint boundary"] : []),
    ...(request.semantics.requestDoesNotWriteConfig !== true ? ["request draft does not preserve config boundary"] : []),
    ...(request.semantics.requestDoesNotEnableDefaultOn !== true ? ["request draft does not preserve default-on boundary"] : []),
  ]);
}

function classifyEvidence(
  request: TerminalBriefSidecarDefaultOnExecutionWindowRequestDraftPacket,
  records: TerminalBriefSidecarDefaultOnExecutionWindowEvidenceRecord[],
) {
  const normalized = records.map(normalizeRecord);
  const acceptedReceiptKinds = unique(normalized
    .filter((record) => record.kind === "current_session_visible" || record.kind === "manual_operator_confirmation")
    .map((record) => record.kind as "current_session_visible" | "manual_operator_confirmation"));
  const matchingApprovalRecords = normalized.filter((record) => record.kind === "approval_grant" && matchesApproval(request, record));
  const approvalMismatches = normalized.filter((record) => record.kind === "approval_grant" && !matchesApproval(request, record));
  const rejectedEvidenceIds = normalized.filter((record) => record.kind === "approval_rejection").map(recordId);
  const staleEvidenceIds = normalized.filter((record) => record.kind === "expired").map(recordId);
  const conflictingEvidenceIds = normalized.filter((record) => record.kind === "conflict").map(recordId);
  const unsupportedEvidenceIds = normalized.filter((record) => record.kind === "unknown").map(recordId);

  return {
    receiptProofAccepted: acceptedReceiptKinds.length > 0,
    approvalGrantEvidenceAccepted: matchingApprovalRecords.length > 0,
    acceptedReceiptKinds,
    acceptedApprovalEvidenceIds: matchingApprovalRecords.map(recordId),
    rejectedEvidenceIds,
    staleEvidenceIds,
    conflictingEvidenceIds,
    unsupportedEvidenceIds,
    reasons: unique([
      ...(records.length === 0 ? ["no execution window approval evidence supplied"] : []),
      ...(acceptedReceiptKinds.length === 0 ? ["current session visibility or manual operator confirmation is required"] : []),
      ...(matchingApprovalRecords.length === 0 ? ["matching fresh operator execution window approval grant evidence is required"] : []),
      ...approvalMismatches.map((record) => "approval grant evidence does not match request draft: " + recordId(record)),
      ...(normalized.some((record) => record.kind === "provider_accepted") ? ["provider_accepted is not visibility proof"] : []),
      ...(rejectedEvidenceIds.length ? ["approval rejection evidence is present"] : []),
      ...(staleEvidenceIds.length ? ["expired approval evidence is present"] : []),
      ...(conflictingEvidenceIds.length ? ["conflicting approval evidence is present"] : []),
      ...(unsupportedEvidenceIds.length ? ["unsupported approval evidence is present"] : []),
    ]),
  };
}

function stateFor(
  sourceIssues: string[],
  classification: ReturnType<typeof classifyEvidence>,
  records: TerminalBriefSidecarDefaultOnExecutionWindowEvidenceRecord[],
): TerminalBriefSidecarDefaultOnExecutionWindowApprovalEvidenceState {
  if (sourceIssues.length) return "blocked";
  if (classification.rejectedEvidenceIds.length) return "rejected";
  if (classification.staleEvidenceIds.length) return "stale";
  if (classification.conflictingEvidenceIds.length) return "conflicting";
  if (classification.unsupportedEvidenceIds.length) return "blocked";
  if (records.length === 0 || !classification.receiptProofAccepted || !classification.approvalGrantEvidenceAccepted) return "insufficient";
  return "accepted";
}

function missingEvidence(
  request: TerminalBriefSidecarDefaultOnExecutionWindowRequestDraftPacket,
  classification: ReturnType<typeof classifyEvidence>,
): string[] {
  return unique([
    ...(request.state !== "execution_window_request_draft_ready" ? ["ready_execution_window_request_draft"] : []),
    ...(!request.readiness.executionWindowRequestDraftReady ? ["execution_window_request_draft_ready"] : []),
    ...(!classification.receiptProofAccepted ? ["operator_visible_receipt_evidence"] : []),
    ...(!classification.approvalGrantEvidenceAccepted ? ["matching_execution_window_approval_grant_evidence"] : []),
  ]);
}

function matchesApproval(
  request: TerminalBriefSidecarDefaultOnExecutionWindowRequestDraftPacket,
  record: TerminalBriefSidecarDefaultOnExecutionWindowEvidenceRecord,
): boolean {
  const approvalReference = record.approvalReference ?? record.executionWindowReference;
  const referenceMatches = !approvalReference || approvalReference === request.executionWindowRequestDraft.executionWindowReference;
  const actionMatches = !record.requestedAction || record.requestedAction === request.executionWindowRequestDraft.requestedAction;
  const targetMatches = !record.operatorTarget || record.operatorTarget === request.executionWindowRequestDraft.operatorTarget;
  const replyMatches = !record.replyText || normalizeReply(record.replyText) === normalizeReply(request.executionWindowRequestDraft.requiredReply);
  return referenceMatches && actionMatches && targetMatches && replyMatches;
}

function nextActionFor(state: TerminalBriefSidecarDefaultOnExecutionWindowApprovalEvidenceState): string {
  if (state === "accepted") return "feed accepted source-only execution window approval evidence into a separate final runtime mutation executor gate";
  if (state === "rejected") return "stop this default-on execution path unless a new execution window request is approved";
  if (state === "stale") return "refresh execution window approval evidence before runtime mutation review";
  if (state === "conflicting") return "resolve conflicting execution window approval evidence before runtime mutation review";
  if (state === "insufficient") return "collect operator-visible receipt evidence and a matching approval grant reply first";
  return "recover blocked request or unsupported evidence before runtime mutation review";
}

function nextActionsFor(state: TerminalBriefSidecarDefaultOnExecutionWindowApprovalEvidenceState): string[] {
  return [
    nextActionFor(state),
    "do not create checkpoints, write config, enable default-on, restart/apply sidecar, dispatch/invoke executor, spawn process, send provider, ACK terminal rows, or mutate state from this evidence packet",
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
    "live provider/Hermes/mobilealpha/Telegram/OpenClaw send",
    "terminal ACK/replay or terminal receipt DB mutation",
    "start executor dispatch, executor invocation, or process spawn",
    "GitHub PR merge, issue close, or comment post from the packet/route",
    "TaskFlow record creation or broker DB mutation",
    "Gateway/broker restart, production deploy, historical replay, release, publish, or secret movement",
  ];
}

function normalizeRecord(value: TerminalBriefSidecarDefaultOnExecutionWindowEvidenceRecord): TerminalBriefSidecarDefaultOnExecutionWindowEvidenceRecord {
  return {
    ...value,
    kind: evidenceKind(value.kind),
  };
}

function toEvidenceRecord(value: unknown): TerminalBriefSidecarDefaultOnExecutionWindowEvidenceRecord {
  const record = isRecord(value) ? value : {};
  return {
    kind: evidenceKind(record.kind),
    evidenceId: stringValue(record.evidenceId ?? record.evidence_id ?? record.id),
    observedAt: stringValue(record.observedAt ?? record.observed_at),
    approvalReference: stringValue(record.approvalReference ?? record.approval_reference),
    executionWindowReference: stringValue(record.executionWindowReference ?? record.execution_window_reference),
    requestedAction: stringValue(record.requestedAction ?? record.requested_action),
    operatorTarget: stringValue(record.operatorTarget ?? record.operator_target),
    replyText: stringValue(record.replyText ?? record.reply_text ?? record.text),
    source: stringValue(record.source),
    note: stringValue(record.note),
  };
}

function evidenceKind(value: unknown): TerminalBriefSidecarDefaultOnExecutionWindowEvidenceKind {
  if (value === "current_session_visible"
    || value === "manual_operator_confirmation"
    || value === "provider_accepted"
    || value === "approval_grant"
    || value === "approval_rejection"
    || value === "expired"
    || value === "conflict") return value;
  return "unknown";
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function recordId(record: TerminalBriefSidecarDefaultOnExecutionWindowEvidenceRecord): string {
  return record.evidenceId ?? record.kind + ":" + (record.observedAt ?? "unknown-time");
}

function normalizeReply(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function buildIdempotencyKey(
  request: TerminalBriefSidecarDefaultOnExecutionWindowRequestDraftPacket,
  records: TerminalBriefSidecarDefaultOnExecutionWindowEvidenceRecord[],
  generatedAt: string,
  state: TerminalBriefSidecarDefaultOnExecutionWindowApprovalEvidenceState,
): string {
  const base = JSON.stringify({
    label: "terminal-brief-sidecar-default-on-execution-window-approval-evidence-ingestor",
    request: request.idempotencyKey,
    records: records.map((record) => ({
      kind: record.kind,
      evidenceId: record.evidenceId,
      approvalReference: record.approvalReference ?? record.executionWindowReference,
      requestedAction: record.requestedAction,
      operatorTarget: record.operatorTarget,
      replyText: record.replyText,
    })),
    generatedAt,
    state,
  });
  return "tb-sidecar-default-on-execution-window-approval-evidence:" + createHash("sha256").update(base).digest("hex").slice(0, 24);
}

function titleForState(state: TerminalBriefSidecarDefaultOnExecutionWindowApprovalEvidenceState): string {
  if (state === "accepted") return "Accepted: Terminal Brief default-on execution window approval evidence";
  if (state === "insufficient") return "Insufficient: Terminal Brief default-on execution window approval evidence";
  if (state === "rejected") return "Rejected: Terminal Brief default-on execution window approval evidence";
  if (state === "stale") return "Stale: Terminal Brief default-on execution window approval evidence";
  if (state === "conflicting") return "Conflicting: Terminal Brief default-on execution window approval evidence";
  return "Blocked: Terminal Brief default-on execution window approval evidence";
}

function isExecutionWindowRequestDraftPacket(
  value: unknown,
): value is TerminalBriefSidecarDefaultOnExecutionWindowRequestDraftPacket {
  return isRecord(value) && value.kind === "a2a-broker.terminal-brief-sidecar-default-on-execution-window-request-draft.packet";
}
