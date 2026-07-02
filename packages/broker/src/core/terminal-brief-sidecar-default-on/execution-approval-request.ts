import { unique } from "../collections.js";
import { isRecord } from "../value-guards.js";
import { createHash } from "node:crypto";

import type { TerminalBriefSidecarDefaultOnExecutionRollbackEnvelopePacket } from "./execution-rollback-envelope.js";
import { optionalString } from "../value-text.js";

export type TerminalBriefSidecarDefaultOnExecutionApprovalRequestState =
  | "execution_approval_request_draft_ready"
  | "waiting_for_execution_rollback_envelope"
  | "stale"
  | "conflicting"
  | "rejected"
  | "blocked";

export interface TerminalBriefSidecarDefaultOnExecutionApprovalRequestOptions {
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
  finalizer?: string;
  finalizer_id?: string;
}

export interface TerminalBriefSidecarDefaultOnExecutionApprovalRequestPacket {
  kind: "a2a-broker.terminal-brief-sidecar-default-on-execution-approval-request.packet";
  version: 1;
  generatedAt: string;
  mode: string;
  state: TerminalBriefSidecarDefaultOnExecutionApprovalRequestState;
  dryRunOnly: false;
  sourceOnlyNoLive: true;
  idempotencyKey: string;
  source: {
    executionRollbackEnvelopeKind: TerminalBriefSidecarDefaultOnExecutionRollbackEnvelopePacket["kind"];
    executionRollbackEnvelopeState: TerminalBriefSidecarDefaultOnExecutionRollbackEnvelopePacket["state"];
    executionRollbackEnvelopeIdempotencyKey: string;
    executionEnvelopeReady: boolean;
    envelopeReference: string;
    planReference: string;
    gateReference: string;
    approvalReference: string;
    runtimeTarget: string;
    executorId: string;
    configKey: string;
    proposedValue: string;
    configChangeApplied: false;
    commandExecutable: false;
    envValuesIncluded: false;
    secretValuesIncluded: false;
    rollbackExecutable: false;
    providerAcceptedIsVisibilityProof: false;
    approvalGrantEvidenceExecutesGrant: false;
  };
  approvalRequestDraft: {
    draftOnly: true;
    status: "draft_not_sent" | "not_ready";
    requestedAction: string;
    requestedBy: string;
    operatorTarget: string;
    operatorChannel?: string;
    approvalReference: string;
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
    executionPermitted: false;
    processSpawnPermitted: false;
    transcriptDraft: string;
    requiredReply: string;
  };
  executionApprovalBoundary: {
    requestOnly: true;
    sourcePacketIds: string[];
    finalizerRequired: true;
    separateOperatorApprovalRequired: true;
    separateExecutorRequired: true;
    approvalCanBeRequestedBy: string;
    approvalCanBeDeliveredBy: Array<"openclaw" | "hermes" | "mobilealpha" | "external">;
    mustNotTreatProviderAcceptedAsVisibilityProof: true;
    forbiddenBeforeSeparateApproval: string[];
  };
  readiness: {
    sourceCriteriaMet: boolean;
    executionApprovalRequestDraftReady: boolean;
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
    missingEvidence: string[];
    blockers: string[];
    nextAction: string;
  };
  blockers: string[];
  nextActions: string[];
  approvalSensitiveActionsExcluded: string[];
  integrationContract: {
    transport: "json";
    executionApprovalRequestVersion: 1;
    consumesExecutionRollbackEnvelopePacket: true;
    rendersApprovalRequestDraft: true;
    sendsApprovalRequest: false;
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
    executionApprovalRequestDraftOnly: true;
    sourceOnlyNoLive: true;
    requestDraftIsNotSend: true;
    requestDoesNotGrantApproval: true;
    requestDoesNotExecuteEnvelope: true;
    requestDoesNotWriteConfig: true;
    requestDoesNotEnableDefaultOn: true;
    requestDoesNotRestartSidecar: true;
    requestDoesNotSendProviders: true;
    requestDoesNotAckTerminalRows: true;
    requestDoesNotMutateDb: true;
    requestDoesNotMutateTaskFlow: true;
    providerAcceptedIsVisibilityProof: false;
    defaultOnNotEnabledByThisPacket: true;
    executionNotPermitted: true;
    processSpawnNotPermitted: true;
    sidecarStartNotPermitted: true;
    sidecarRestartNotPermitted: true;
    brokerRestartNotPermitted: true;
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

export function buildTerminalBriefSidecarDefaultOnExecutionApprovalRequest(
  envelope: TerminalBriefSidecarDefaultOnExecutionRollbackEnvelopePacket,
  options: TerminalBriefSidecarDefaultOnExecutionApprovalRequestOptions = {},
): TerminalBriefSidecarDefaultOnExecutionApprovalRequestPacket {
  const generatedAt = options.now ?? new Date().toISOString();
  const blockers = buildBlockers(envelope);
  const missingEvidence = missingEvidenceFor(envelope);
  const state = stateFor(envelope, blockers, missingEvidence);
  const ready = state === "execution_approval_request_draft_ready";
  const requestedBy = optionalString(options.requestedBy ?? options.requested_by)
    ?? optionalString(options.finalizer ?? options.finalizer_id)
    ?? envelope.executionRollbackEnvelope.finalizer
    ?? "broker-finalizer";
  const operatorTarget = optionalString(options.operatorTarget ?? options.operator_target) ?? "operator";
  const operatorChannel = optionalString(options.operatorChannel ?? options.operator_channel);
  const requestedAction = optionalString(options.requestedAction ?? options.requested_action)
    ?? "approve_terminal_brief_default_on_execution";
  const approvalReference = optionalString(options.approvalReference ?? options.approval_reference)
    ?? buildApprovalReference(envelope);
  const approvalExpiresAt = approvalExpiry(generatedAt, options);
  const transcriptDraft = buildTranscriptDraft(
    envelope,
    requestedAction,
    requestedBy,
    operatorTarget,
    approvalReference,
    approvalExpiresAt,
    ready,
  );

  return {
    kind: "a2a-broker.terminal-brief-sidecar-default-on-execution-approval-request.packet",
    version: 1,
    generatedAt,
    mode: options.mode ?? "terminal-brief-default-on-execution-approval-request-source-only",
    state,
    dryRunOnly: false,
    sourceOnlyNoLive: true,
    idempotencyKey: buildIdempotencyKey(envelope, generatedAt, requestedAction, requestedBy, operatorTarget, state),
    source: {
      executionRollbackEnvelopeKind: envelope.kind,
      executionRollbackEnvelopeState: envelope.state,
      executionRollbackEnvelopeIdempotencyKey: envelope.idempotencyKey,
      executionEnvelopeReady: envelope.readiness.executionEnvelopeReady,
      envelopeReference: envelope.executionRollbackEnvelope.envelopeReference,
      planReference: envelope.source.planReference,
      gateReference: envelope.source.gateReference,
      approvalReference: envelope.source.approvalReference,
      runtimeTarget: envelope.executionRollbackEnvelope.runtimeTarget,
      executorId: envelope.executionRollbackEnvelope.executorId,
      configKey: envelope.source.configKey,
      proposedValue: envelope.source.proposedValue,
      configChangeApplied: false,
      commandExecutable: false,
      envValuesIncluded: false,
      secretValuesIncluded: false,
      rollbackExecutable: false,
      providerAcceptedIsVisibilityProof: false,
      approvalGrantEvidenceExecutesGrant: false,
    },
    approvalRequestDraft: {
      draftOnly: true,
      status: ready ? "draft_not_sent" : "not_ready",
      requestedAction,
      requestedBy,
      operatorTarget,
      operatorChannel,
      approvalReference,
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
      executionPermitted: false,
      processSpawnPermitted: false,
      transcriptDraft,
      requiredReply: "default-on execution 승인",
    },
    executionApprovalBoundary: {
      requestOnly: true,
      sourcePacketIds: [envelope.source.runtimeMutationPlanIdempotencyKey, envelope.idempotencyKey],
      finalizerRequired: true,
      separateOperatorApprovalRequired: true,
      separateExecutorRequired: true,
      approvalCanBeRequestedBy: requestedBy,
      approvalCanBeDeliveredBy: ["openclaw", "hermes", "mobilealpha", "external"],
      mustNotTreatProviderAcceptedAsVisibilityProof: true,
      forbiddenBeforeSeparateApproval: forbiddenBeforeSeparateApproval(),
    },
    readiness: {
      sourceCriteriaMet: ready,
      executionApprovalRequestDraftReady: ready,
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
      missingEvidence,
      blockers: [
        ...blockers,
        "execution approval request draft is not sent and does not grant approval",
        "config write, default-on enablement, and sidecar restart require a later approved executor path",
      ],
      nextAction: ready
        ? "broker finalizer may review this draft and choose a separate operator-visible delivery path"
        : "collect a ready source-only execution/rollback envelope before drafting execution approval",
    },
    blockers,
    nextActions: ready
      ? [
        "review the source-only execution approval request draft",
        "send the approval request only as a separate operator-approved action",
        "do not write config, restart sidecar, or enable default-on from this packet",
      ]
      : nextActionsForState(state),
    approvalSensitiveActionsExcluded: [
      "sending the execution approval request",
      "granting approval or executing an approval grant",
      "writing config or enabling Terminal Brief default-on",
      "starting, stopping, or restarting the Terminal Brief sidecar",
      "live provider/Hermes/mobilealpha/Telegram/OpenClaw send",
      "terminal ACK/replay or terminal receipt DB mutation",
      "process spawn, executor invocation, broker restart, or deploy",
      "GitHub mutation from the packet/route",
      "TaskFlow/broker DB mutation",
      "historical replay, release, publish, or secret movement",
    ],
    integrationContract: {
      transport: "json",
      executionApprovalRequestVersion: 1,
      consumesExecutionRollbackEnvelopePacket: true,
      rendersApprovalRequestDraft: true,
      sendsApprovalRequest: false,
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
      executionApprovalRequestDraftOnly: true,
      sourceOnlyNoLive: true,
      requestDraftIsNotSend: true,
      requestDoesNotGrantApproval: true,
      requestDoesNotExecuteEnvelope: true,
      requestDoesNotWriteConfig: true,
      requestDoesNotEnableDefaultOn: true,
      requestDoesNotRestartSidecar: true,
      requestDoesNotSendProviders: true,
      requestDoesNotAckTerminalRows: true,
      requestDoesNotMutateDb: true,
      requestDoesNotMutateTaskFlow: true,
      providerAcceptedIsVisibilityProof: false,
      defaultOnNotEnabledByThisPacket: true,
      executionNotPermitted: true,
      processSpawnNotPermitted: true,
      sidecarStartNotPermitted: true,
      sidecarRestartNotPermitted: true,
      brokerRestartNotPermitted: true,
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

export function extractTerminalBriefSidecarDefaultOnExecutionApprovalRequestEnvelope(
  input: unknown,
): TerminalBriefSidecarDefaultOnExecutionRollbackEnvelopePacket {
  const envelope = isRecord(input) ? input : {};
  const candidates = [
    input,
    envelope.defaultOnExecutionRollbackEnvelopePacket,
    envelope.executionRollbackEnvelopePacket,
    envelope.envelopePacket,
    envelope.packet,
  ];
  const packet = candidates.find(isTerminalBriefSidecarDefaultOnExecutionRollbackEnvelopePacket);
  if (!packet) throw new Error("expected a Terminal Brief sidecar default-on execution/rollback envelope packet");
  return packet;
}

export function extractTerminalBriefSidecarDefaultOnExecutionApprovalRequestOptions(
  input: unknown,
): TerminalBriefSidecarDefaultOnExecutionApprovalRequestOptions {
  const envelope = isRecord(input) ? input : {};
  const options = isRecord(envelope.defaultOnExecutionApprovalRequest)
    ? envelope.defaultOnExecutionApprovalRequest
    : isRecord(envelope.executionApprovalRequest)
      ? envelope.executionApprovalRequest
      : isRecord(envelope.approvalRequest)
        ? envelope.approvalRequest
        : isRecord(envelope.options)
          ? envelope.options
          : {};
  return {
    now: optionalString(options.now),
    mode: optionalString(options.mode),
    requestedAction: optionalString(options.requestedAction ?? options.requested_action),
    requestedBy: optionalString(options.requestedBy ?? options.requested_by),
    operatorTarget: optionalString(options.operatorTarget ?? options.operator_target),
    operatorChannel: optionalString(options.operatorChannel ?? options.operator_channel),
    approvalReference: optionalString(options.approvalReference ?? options.approval_reference),
    approvalWindowMinutes: optionalNumber(options.approvalWindowMinutes ?? options.approval_window_minutes),
    finalizer: optionalString(options.finalizer ?? options.finalizer_id),
  };
}

export function renderTerminalBriefSidecarDefaultOnExecutionApprovalRequestMarkdown(
  packet: TerminalBriefSidecarDefaultOnExecutionApprovalRequestPacket,
): string {
  return [
    packet.state === "execution_approval_request_draft_ready"
      ? "Ready: Terminal Brief default-on execution approval request draft"
      : "Blocked: Terminal Brief default-on execution approval request draft",
    "Mode: " + packet.mode,
    "State: " + packet.state + " sourceOnlyNoLive=" + packet.sourceOnlyNoLive,
    "Idempotency: " + packet.idempotencyKey,
    "Source envelope: state=" + packet.source.executionRollbackEnvelopeState
      + " executionEnvelopeReady=" + packet.source.executionEnvelopeReady
      + " commandExecutable=" + packet.source.commandExecutable
      + " rollbackExecutable=" + packet.source.rollbackExecutable,
    "Request draft: status=" + packet.approvalRequestDraft.status
      + " requestedAction=" + packet.approvalRequestDraft.requestedAction
      + " dispatchPermitted=" + packet.approvalRequestDraft.dispatchPermitted
      + " configWritePermitted=" + packet.approvalRequestDraft.configWritePermitted
      + " defaultOnPermitted=" + packet.approvalRequestDraft.defaultOnPermitted
      + " sidecarRestartPermitted=" + packet.approvalRequestDraft.sidecarRestartPermitted,
    "Required reply: " + packet.approvalRequestDraft.requiredReply,
    ...(packet.readiness.missingEvidence.length ? ["Missing evidence:", ...packet.readiness.missingEvidence.map((item) => "- " + item)] : []),
    ...(packet.blockers.length ? ["", "Blockers:", ...packet.blockers.map((blocker) => "- " + blocker)] : []),
    "",
    "Transcript draft:",
    packet.approvalRequestDraft.transcriptDraft,
    "",
    "Next actions:",
    ...packet.nextActions.map((action) => "- " + action),
    "",
    "Safety: execution approval request draft only; does not send request, grant approval, execute envelope, write config, enable default-on, send providers, ACK/replay terminal rows, mutate DB/TaskFlow/GitHub state, spawn processes, restart/deploy sidecar or broker, release, publish, or move secrets.",
  ].join("\n");
}

function buildBlockers(envelope: TerminalBriefSidecarDefaultOnExecutionRollbackEnvelopePacket): string[] {
  return unique([
    ...envelope.blockers,
    ...(envelope.state === "blocked" ? ["execution/rollback envelope is blocked"] : []),
    ...(envelope.source.configChangeApplied !== false ? ["source envelope unexpectedly reports applied config change"] : []),
    ...(envelope.source.executionEnvelopeExecutable !== false ? ["source envelope unexpectedly exposes executable envelope"] : []),
    ...(envelope.executionRollbackEnvelope.executionPlan.commandTemplateIncluded !== false ? ["source envelope unexpectedly includes command template"] : []),
    ...(envelope.executionRollbackEnvelope.executionPlan.commandExecutable !== false ? ["source envelope unexpectedly permits command execution"] : []),
    ...(envelope.executionRollbackEnvelope.executionPlan.envValuesIncluded !== false ? ["source envelope unexpectedly includes env values"] : []),
    ...(envelope.executionRollbackEnvelope.executionPlan.secretValuesIncluded !== false ? ["source envelope unexpectedly includes secret values"] : []),
    ...(envelope.executionRollbackEnvelope.rollbackPlan.rollbackExecutable !== false ? ["source envelope unexpectedly exposes executable rollback"] : []),
    ...(envelope.readiness.executionApprovalRequestPermitted !== false ? ["source envelope unexpectedly permits execution approval request dispatch"] : []),
    ...(envelope.readiness.runtimeMutationPermitted !== false ? ["source envelope unexpectedly permits runtime mutation"] : []),
    ...(envelope.readiness.configWritePermitted !== false ? ["source envelope unexpectedly permits config write"] : []),
    ...(envelope.readiness.defaultOnPermitted !== false ? ["source envelope unexpectedly permits default-on"] : []),
    ...(envelope.readiness.liveActivationPermitted !== false ? ["source envelope unexpectedly permits live activation"] : []),
    ...(envelope.readiness.providerSendPermitted !== false ? ["source envelope unexpectedly permits provider send"] : []),
    ...(envelope.readiness.terminalAckPermitted !== false ? ["source envelope unexpectedly permits terminal ACK"] : []),
    ...(envelope.readiness.dbMutationPermitted !== false ? ["source envelope unexpectedly permits DB mutation"] : []),
    ...(envelope.readiness.taskFlowMutationPermitted !== false ? ["source envelope unexpectedly permits TaskFlow mutation"] : []),
    ...(envelope.readiness.executionPermitted !== false ? ["source envelope unexpectedly permits execution"] : []),
    ...(envelope.readiness.processSpawnPermitted !== false ? ["source envelope unexpectedly permits process spawn"] : []),
    ...(envelope.readiness.sidecarStartPermitted !== false ? ["source envelope unexpectedly permits sidecar start"] : []),
    ...(envelope.readiness.sidecarRestartPermitted !== false ? ["source envelope unexpectedly permits sidecar restart"] : []),
    ...(envelope.readiness.brokerRestartPermitted !== false ? ["source envelope unexpectedly permits broker restart"] : []),
    ...(envelope.integrationContract.writesConfig ? ["source envelope unexpectedly writes config"] : []),
    ...(envelope.integrationContract.enablesDefaultOn ? ["source envelope unexpectedly enables default-on"] : []),
    ...(envelope.integrationContract.sendsProvider ? ["source envelope unexpectedly sends provider"] : []),
    ...(envelope.integrationContract.performsTerminalAck ? ["source envelope unexpectedly performs terminal ACK"] : []),
    ...(envelope.integrationContract.mutatesDb ? ["source envelope unexpectedly mutates DB"] : []),
    ...(envelope.integrationContract.mutatesTaskFlow ? ["source envelope unexpectedly mutates TaskFlow"] : []),
    ...(envelope.integrationContract.spawnsProcess ? ["source envelope unexpectedly spawns process"] : []),
    ...(envelope.integrationContract.startsSidecar ? ["source envelope unexpectedly starts sidecar"] : []),
    ...(envelope.integrationContract.restartsSidecar ? ["source envelope unexpectedly restarts sidecar"] : []),
    ...(envelope.integrationContract.restartsBroker ? ["source envelope unexpectedly restarts broker"] : []),
    ...(envelope.integrationContract.executesAction ? ["source envelope unexpectedly executes action"] : []),
    ...(envelope.semantics.envelopeDoesNotExecute !== true ? ["source envelope does not preserve no-execution boundary"] : []),
    ...(envelope.semantics.envelopeDoesNotWriteConfig !== true ? ["source envelope does not preserve config write boundary"] : []),
    ...(envelope.semantics.envelopeDoesNotEnableDefaultOn !== true ? ["source envelope does not preserve default-on boundary"] : []),
    ...(envelope.semantics.envelopeDoesNotRestartSidecar !== true ? ["source envelope does not preserve sidecar restart boundary"] : []),
    ...(envelope.semantics.performsProviderSend ? ["source envelope unexpectedly performs provider send"] : []),
    ...(envelope.semantics.performsTerminalAck ? ["source envelope unexpectedly performs terminal ACK"] : []),
    ...(envelope.semantics.performsRuntimeRestartOrDeploy ? ["source envelope unexpectedly performs restart/deploy"] : []),
    ...(envelope.semantics.performsDbMutation ? ["source envelope unexpectedly performs DB mutation"] : []),
    ...(envelope.semantics.createsTaskFlowRecords ? ["source envelope unexpectedly creates TaskFlow records"] : []),
    ...(envelope.semantics.performsHistoricalReplay ? ["source envelope unexpectedly performs historical replay"] : []),
    ...(envelope.semantics.performsReleaseOrPublish ? ["source envelope unexpectedly performs release/publish"] : []),
    ...(envelope.semantics.movesSecretsOrCredentials ? ["source envelope unexpectedly moves secrets/credentials"] : []),
  ]);
}

function missingEvidenceFor(envelope: TerminalBriefSidecarDefaultOnExecutionRollbackEnvelopePacket): string[] {
  const missing: string[] = [];
  if (envelope.state !== "ready_for_execution_approval_review") missing.push("ready_execution_rollback_envelope");
  if (!envelope.readiness.executionEnvelopeReady) missing.push("execution_envelope_ready");
  if (!envelope.readiness.sourceCriteriaMet) missing.push("execution_envelope_source_criteria");
  if (envelope.executionRollbackEnvelope.executionPlan.commandExecutable !== false) missing.push("non_executable_command_metadata");
  if (envelope.executionRollbackEnvelope.rollbackPlan.rollbackExecutable !== false) missing.push("non_executable_rollback_metadata");
  return unique(missing);
}

function stateFor(
  envelope: TerminalBriefSidecarDefaultOnExecutionRollbackEnvelopePacket,
  blockers: string[],
  missingEvidence: string[],
): TerminalBriefSidecarDefaultOnExecutionApprovalRequestState {
  if (envelope.state === "stale") return "stale";
  if (envelope.state === "conflicting") return "conflicting";
  if (envelope.state === "rejected") return "rejected";
  if (blockers.length > 0 || envelope.state === "blocked") return "blocked";
  if (missingEvidence.length > 0) return "waiting_for_execution_rollback_envelope";
  return "execution_approval_request_draft_ready";
}

function nextActionsForState(state: TerminalBriefSidecarDefaultOnExecutionApprovalRequestState): string[] {
  if (state === "waiting_for_execution_rollback_envelope") {
    return [
      "collect a ready source-only execution/rollback envelope",
      "do not request execution approval from incomplete evidence",
    ];
  }
  if (state === "stale") return ["refresh execution/rollback envelope before execution approval request review"];
  if (state === "conflicting") return ["resolve conflicting execution/rollback envelope evidence before approval request review"];
  if (state === "rejected") return ["do not enable default-on; collect a new approval path only if the operator changes the decision"];
  return ["recover blocked execution/rollback envelope before approval request review"];
}

function buildTranscriptDraft(
  envelope: TerminalBriefSidecarDefaultOnExecutionRollbackEnvelopePacket,
  requestedAction: string,
  requestedBy: string,
  operatorTarget: string,
  approvalReference: string,
  approvalExpiresAt: string | undefined,
  ready: boolean,
): string {
  const lines = [
    "[Terminal Brief default-on execution approval request draft]",
    "Requested action: " + requestedAction,
    "Requested by: " + requestedBy,
    "Operator target: " + operatorTarget,
    "Approval reference: " + approvalReference,
    "Source envelope: " + envelope.executionRollbackEnvelope.envelopeReference,
    "Runtime target: " + envelope.executionRollbackEnvelope.runtimeTarget,
    "Config key: " + envelope.source.configKey,
    "Proposed value: " + envelope.source.proposedValue,
    "Executor id: " + envelope.executionRollbackEnvelope.executorId,
    "Ready: " + ready,
    "Reply exactly: default-on execution 승인",
    "Boundary: this is only a draft; it does not send the request, grant approval, execute, write config, enable default-on, restart sidecar, send providers, ACK terminal rows, mutate DB/TaskFlow/GitHub state, release, publish, or move secrets.",
  ];
  if (approvalExpiresAt) lines.splice(5, 0, "Approval expires at: " + approvalExpiresAt);
  return lines.join("\n");
}

function forbiddenBeforeSeparateApproval(): string[] {
  return [
    "sending this execution approval request",
    "treating this draft as approval grant evidence",
    "executing the source envelope",
    "writing TERMINAL_BRIEF_SIDECAR_DEFAULT_ON",
    "enabling Terminal Brief default-on",
    "starting or restarting the Terminal Brief sidecar",
    "sending providers or ACKing/replaying terminal rows",
    "mutating broker DB or TaskFlow state",
    "spawning a process, invoking an executor, restarting broker, deploying, releasing, publishing, or moving secrets",
  ];
}

function approvalExpiry(
  generatedAt: string,
  options: TerminalBriefSidecarDefaultOnExecutionApprovalRequestOptions,
): string | undefined {
  const minutes = optionalNumber(options.approvalWindowMinutes ?? options.approval_window_minutes);
  if (!minutes) return undefined;
  const base = Date.parse(generatedAt);
  if (!Number.isFinite(base)) return undefined;
  return new Date(base + minutes * 60_000).toISOString();
}

function buildApprovalReference(envelope: TerminalBriefSidecarDefaultOnExecutionRollbackEnvelopePacket): string {
  const base = JSON.stringify({
    envelope: envelope.idempotencyKey,
    envelopeReference: envelope.executionRollbackEnvelope.envelopeReference,
    runtimeTarget: envelope.executionRollbackEnvelope.runtimeTarget,
  });
  return "tb-sidecar-default-on-execution-approval:" + createHash("sha256").update(base).digest("hex").slice(0, 16);
}

function buildIdempotencyKey(
  envelope: TerminalBriefSidecarDefaultOnExecutionRollbackEnvelopePacket,
  generatedAt: string,
  requestedAction: string,
  requestedBy: string,
  operatorTarget: string,
  state: string,
): string {
  const base = JSON.stringify({
    label: "terminal-brief-sidecar-default-on-execution-approval-request",
    envelope: envelope.idempotencyKey,
    generatedAt,
    requestedAction,
    requestedBy,
    operatorTarget,
    state,
  });
  return "tb-sidecar-default-on-execution-approval-request:" + createHash("sha256").update(base).digest("hex").slice(0, 24);
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function isTerminalBriefSidecarDefaultOnExecutionRollbackEnvelopePacket(
  value: unknown,
): value is TerminalBriefSidecarDefaultOnExecutionRollbackEnvelopePacket {
  return isRecord(value) && value.kind === "a2a-broker.terminal-brief-sidecar-default-on-execution-rollback-envelope.packet";
}

