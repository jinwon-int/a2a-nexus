import { unique } from "./collections.js";
import { isRecord } from "./value-guards.js";
import { createHash } from "node:crypto";

import type { TerminalBriefSidecarDefaultOnCandidateFinalGatePacket } from "./terminal-brief-sidecar-default-on-candidate-final-gate.js";
import { optionalString } from "./terminal-brief-value-guards.js";

export type TerminalBriefSidecarDefaultOnApprovalRequestState =
  | "approval_request_draft_ready"
  | "waiting_for_default_on_candidate_final_gate"
  | "blocked";

export interface TerminalBriefSidecarDefaultOnApprovalRequestOptions {
  now?: string;
  mode?: string;
  requestedBy?: string;
  requested_by?: string;
  operatorTarget?: string;
  operator_target?: string;
  operatorChannel?: string;
  operator_channel?: string;
  approvalReference?: string;
  approval_reference?: string;
  approvalExpiresAt?: string;
  approval_expires_at?: string;
}

export interface TerminalBriefSidecarDefaultOnApprovalRequestPacket {
  kind: "a2a-broker.terminal-brief-sidecar-default-on-approval-request.packet";
  version: 1;
  generatedAt: string;
  mode: string;
  state: TerminalBriefSidecarDefaultOnApprovalRequestState;
  dryRunOnly: false;
  sourceOnlyNoLive: true;
  idempotencyKey: string;
  source: {
    finalGateState: TerminalBriefSidecarDefaultOnCandidateFinalGatePacket["state"];
    finalGateIdempotencyKey: string;
    finalGateReady: boolean;
    gateReference: string;
    observationState: string;
    operatorInstructionReference?: string;
  };
  approvalRequestDraft: {
    draftOnly: true;
    status: "draft_not_sent" | "not_ready";
    requestedAction: "approve_terminal_brief_default_on_enablement";
    requestedBy: string;
    operatorTarget: string;
    operatorChannel?: string;
    approvalReference: string;
    approvalExpiresAt?: string;
    dispatchRequired: boolean;
    dispatchPermitted: false;
    approvalGrantPermitted: false;
    defaultOnPermitted: false;
    liveActivationPermitted: false;
    providerSendPermitted: false;
    terminalAckPermitted: false;
    dbMutationPermitted: false;
    executionPermitted: false;
    transcriptDraft: string;
    requiredReply: string;
  };
  readiness: {
    sourceCriteriaMet: boolean;
    approvalRequestDraftReady: boolean;
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
    missingEvidence: string[];
    blockers: string[];
    nextAction: string;
  };
  blockers: string[];
  nextActions: string[];
  approvalSensitiveActionsExcluded: string[];
  integrationContract: {
    transport: "json";
    defaultOnApprovalRequestVersion: 1;
    consumesDefaultOnCandidateFinalGatePacket: true;
    rendersApprovalRequestDraft: true;
    sendsApprovalRequest: false;
    grantsApproval: false;
    enablesDefaultOn: false;
    sendsProvider: false;
    performsTerminalAck: false;
    mutatesDb: false;
    spawnsProcess: false;
    restartsSidecar: false;
    executesAction: false;
  };
  semantics: {
    approvalRequestDraftOnly: true;
    sourceOnlyNoLive: true;
    requestDoesNotGrantApproval: true;
    requestDoesNotEnableDefaultOn: true;
    requestDoesNotSendProviders: true;
    requestDoesNotAckTerminalRows: true;
    requestDoesNotMutateDb: true;
    providerAcceptedIsVisibilityProof: false;
    terminalAckEligibleDoesNotPermitAck: true;
    defaultOnNotEnabledByThisPacket: true;
    performsProviderSend: false;
    performsTerminalAck: false;
    performsRuntimeRestartOrDeploy: false;
    performsDbMutation: false;
    performsHistoricalReplay: false;
    performsReleaseOrPublish: false;
    movesSecretsOrCredentials: false;
  };
}

export function buildTerminalBriefSidecarDefaultOnApprovalRequest(
  finalGate: TerminalBriefSidecarDefaultOnCandidateFinalGatePacket,
  options: TerminalBriefSidecarDefaultOnApprovalRequestOptions = {},
): TerminalBriefSidecarDefaultOnApprovalRequestPacket {
  const generatedAt = options.now ?? new Date().toISOString();
  const blockers = buildBlockers(finalGate);
  const ready = finalGate.state === "ready_for_default_on_candidate_review" && blockers.length === 0;
  const state: TerminalBriefSidecarDefaultOnApprovalRequestState = ready
    ? "approval_request_draft_ready"
    : finalGate.state === "ready_for_default_on_candidate_review" ? "blocked" : "waiting_for_default_on_candidate_final_gate";
  const approvalReference = optionalString(options.approvalReference ?? options.approval_reference) ?? buildApprovalReference(finalGate);
  const requestedBy = optionalString(options.requestedBy ?? options.requested_by) ?? "broker-finalizer";
  const operatorTarget = optionalString(options.operatorTarget ?? options.operator_target) ?? "operator";
  const operatorChannel = optionalString(options.operatorChannel ?? options.operator_channel);
  const approvalExpiresAt = optionalString(options.approvalExpiresAt ?? options.approval_expires_at);
  return {
    kind: "a2a-broker.terminal-brief-sidecar-default-on-approval-request.packet",
    version: 1,
    generatedAt,
    mode: options.mode ?? "terminal-brief-default-on-approval-request-source-only",
    state,
    dryRunOnly: false,
    sourceOnlyNoLive: true,
    idempotencyKey: buildIdempotencyKey(finalGate, generatedAt, state, approvalReference),
    source: {
      finalGateState: finalGate.state,
      finalGateIdempotencyKey: finalGate.idempotencyKey,
      finalGateReady: finalGate.readiness.finalGateReady,
      gateReference: finalGate.candidateGate.gateReference,
      observationState: finalGate.source.observationState,
      operatorInstructionReference: finalGate.source.operatorInstructionReference,
    },
    approvalRequestDraft: {
      draftOnly: true,
      status: ready ? "draft_not_sent" : "not_ready",
      requestedAction: "approve_terminal_brief_default_on_enablement",
      requestedBy,
      operatorTarget,
      operatorChannel,
      approvalReference,
      approvalExpiresAt,
      dispatchRequired: ready,
      dispatchPermitted: false,
      approvalGrantPermitted: false,
      defaultOnPermitted: false,
      liveActivationPermitted: false,
      providerSendPermitted: false,
      terminalAckPermitted: false,
      dbMutationPermitted: false,
      executionPermitted: false,
      transcriptDraft: transcriptDraft(finalGate, approvalReference, approvalExpiresAt),
      requiredReply: "default-on 승인",
    },
    readiness: {
      sourceCriteriaMet: ready,
      approvalRequestDraftReady: ready,
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
      missingEvidence: missingEvidenceFor(finalGate),
      blockers: [
        ...blockers,
        "approval request draft is not a provider send or approval grant",
        "default-on, live send, terminal ACK, and DB mutation require later separate approved paths",
      ],
      nextAction: ready
        ? "send this draft only after operator chooses a delivery path, then ingest explicit default-on approval evidence"
        : "resolve default-on candidate final gate readiness before drafting approval request",
    },
    blockers,
    nextActions: ready
      ? [
        "review the default-on approval request draft",
        "send the approval request through an approved operator-visible path only as a separate action",
        "do not enable default-on until explicit default-on approval evidence is accepted by a later gate",
      ]
      : ["resolve default-on candidate final gate blockers before approval request draft"],
    approvalSensitiveActionsExcluded: [
      "sending the approval request",
      "granting approval or executing an approval grant",
      "Terminal Brief default-on enablement",
      "live provider/Hermes/Gongyung/Telegram/OpenClaw send",
      "terminal ACK/replay or terminal receipt DB mutation",
      "process spawn, sidecar start/stop/restart, or deploy",
      "GitHub mutation from the packet/route",
      "TaskFlow/broker DB mutation",
      "historical replay, release, publish, or secret movement",
    ],
    integrationContract: {
      transport: "json",
      defaultOnApprovalRequestVersion: 1,
      consumesDefaultOnCandidateFinalGatePacket: true,
      rendersApprovalRequestDraft: true,
      sendsApprovalRequest: false,
      grantsApproval: false,
      enablesDefaultOn: false,
      sendsProvider: false,
      performsTerminalAck: false,
      mutatesDb: false,
      spawnsProcess: false,
      restartsSidecar: false,
      executesAction: false,
    },
    semantics: {
      approvalRequestDraftOnly: true,
      sourceOnlyNoLive: true,
      requestDoesNotGrantApproval: true,
      requestDoesNotEnableDefaultOn: true,
      requestDoesNotSendProviders: true,
      requestDoesNotAckTerminalRows: true,
      requestDoesNotMutateDb: true,
      providerAcceptedIsVisibilityProof: false,
      terminalAckEligibleDoesNotPermitAck: true,
      defaultOnNotEnabledByThisPacket: true,
      performsProviderSend: false,
      performsTerminalAck: false,
      performsRuntimeRestartOrDeploy: false,
      performsDbMutation: false,
      performsHistoricalReplay: false,
      performsReleaseOrPublish: false,
      movesSecretsOrCredentials: false,
    },
  };
}

export function extractTerminalBriefSidecarDefaultOnApprovalRequestFinalGate(input: unknown): TerminalBriefSidecarDefaultOnCandidateFinalGatePacket {
  const envelope = isRecord(input) ? input : {};
  const candidates = [input, envelope.finalGatePacket, envelope.defaultOnCandidateFinalGatePacket, envelope.packet];
  const packet = candidates.find(isFinalGatePacket);
  if (!packet) throw new Error("expected a Terminal Brief default-on candidate final gate packet");
  return packet;
}

export function extractTerminalBriefSidecarDefaultOnApprovalRequestOptions(input: unknown): TerminalBriefSidecarDefaultOnApprovalRequestOptions {
  const envelope = isRecord(input) ? input : {};
  const candidate = envelope.defaultOnApprovalRequest ?? envelope.approvalRequest ?? envelope.options;
  return isRecord(candidate) ? candidate as TerminalBriefSidecarDefaultOnApprovalRequestOptions : {};
}

export function renderTerminalBriefSidecarDefaultOnApprovalRequestMarkdown(packet: TerminalBriefSidecarDefaultOnApprovalRequestPacket): string {
  return [
    packet.state === "approval_request_draft_ready"
      ? "Ready: Terminal Brief default-on approval request draft"
      : "Blocked: Terminal Brief default-on approval request draft",
    "Mode: " + packet.mode,
    "State: " + packet.state + " sourceOnlyNoLive=" + packet.sourceOnlyNoLive,
    "Idempotency: " + packet.idempotencyKey,
    "Request draft: status=" + packet.approvalRequestDraft.status
      + " requestedAction=" + packet.approvalRequestDraft.requestedAction
      + " dispatchPermitted=" + packet.approvalRequestDraft.dispatchPermitted
      + " defaultOnPermitted=" + packet.approvalRequestDraft.defaultOnPermitted
      + " providerSendPermitted=" + packet.approvalRequestDraft.providerSendPermitted
      + " terminalAckPermitted=" + packet.approvalRequestDraft.terminalAckPermitted,
    "Required reply: " + packet.approvalRequestDraft.requiredReply,
    ...(packet.blockers.length ? ["", "Blockers:", ...packet.blockers.map((blocker) => "- " + blocker)] : []),
    "",
    "Transcript draft:",
    packet.approvalRequestDraft.transcriptDraft,
    "",
    "Next actions:",
    ...packet.nextActions.map((action) => "- " + action),
    "",
    "Safety: approval request draft only; does not send request, grant approval, enable default-on, send providers, ACK/replay terminal rows, mutate DB/TaskFlow/GitHub state, spawn processes, restart/deploy, release, publish, or move secrets.",
  ].join("\n");
}

function buildBlockers(finalGate: TerminalBriefSidecarDefaultOnCandidateFinalGatePacket): string[] {
  return unique([
    ...finalGate.blockers,
    ...(finalGate.state !== "ready_for_default_on_candidate_review" ? ["final gate state is " + finalGate.state] : []),
    ...(!finalGate.readiness.finalGateReady ? ["final gate is not ready"] : []),
    ...(finalGate.readiness.defaultOnPermitted !== false ? ["final gate unexpectedly permits default-on"] : []),
    ...(finalGate.readiness.providerSendPermitted !== false ? ["final gate unexpectedly permits provider send"] : []),
    ...(finalGate.readiness.terminalAckPermitted !== false ? ["final gate unexpectedly permits terminal ACK"] : []),
    ...(finalGate.readiness.dbMutationPermitted !== false ? ["final gate unexpectedly permits DB mutation"] : []),
    ...(finalGate.integrationContract.enablesDefaultOn ? ["final gate unexpectedly enables default-on"] : []),
    ...(finalGate.integrationContract.sendsProvider ? ["final gate unexpectedly sends provider"] : []),
    ...(finalGate.integrationContract.performsTerminalAck ? ["final gate unexpectedly performs terminal ACK"] : []),
    ...(finalGate.integrationContract.mutatesDb ? ["final gate unexpectedly mutates DB"] : []),
    ...(finalGate.semantics.performsProviderSend ? ["final gate unexpectedly performs provider send"] : []),
    ...(finalGate.semantics.performsTerminalAck ? ["final gate unexpectedly performs terminal ACK"] : []),
    ...(finalGate.semantics.performsDbMutation ? ["final gate unexpectedly performs DB mutation"] : []),
    ...(finalGate.semantics.movesSecretsOrCredentials ? ["final gate unexpectedly moves secrets/credentials"] : []),
  ]);
}

function missingEvidenceFor(finalGate: TerminalBriefSidecarDefaultOnCandidateFinalGatePacket): string[] {
  const missing: string[] = [];
  if (finalGate.state !== "ready_for_default_on_candidate_review") missing.push("ready_default_on_candidate_final_gate");
  if (!finalGate.readiness.finalGateReady) missing.push("final_gate_ready");
  if (!finalGate.source.observationState) missing.push("bounded_observation_state");
  return unique(missing);
}

function transcriptDraft(finalGate: TerminalBriefSidecarDefaultOnCandidateFinalGatePacket, approvalReference: string, approvalExpiresAt?: string): string {
  return [
    "Terminal Brief default-on approval request",
    "",
    "Requested action: approve_terminal_brief_default_on_enablement",
    "Required reply: default-on 승인",
    "Approval reference: " + approvalReference,
    ...(approvalExpiresAt ? ["Expires at: " + approvalExpiresAt] : []),
    "",
    "Evidence summary:",
    "- final gate state: " + finalGate.state,
    "- final gate ready: " + finalGate.readiness.finalGateReady,
    "- gate reference: " + finalGate.candidateGate.gateReference,
    "- observation state: " + finalGate.source.observationState,
    "",
    "Safety boundaries:",
    "- This request is not default-on execution.",
    "- This request does not permit live provider send, terminal ACK/replay, DB mutation, process spawn, sidecar restart, release, publish, or secret movement.",
    "- A later gate must ingest explicit operator-visible default-on approval evidence before any runtime mutation.",
  ].join("\n");
}

function buildApprovalReference(finalGate: TerminalBriefSidecarDefaultOnCandidateFinalGatePacket): string {
  const base = JSON.stringify({ finalGate: finalGate.idempotencyKey, gateReference: finalGate.candidateGate.gateReference, observation: finalGate.source.observationState });
  return "tb-sidecar-default-on-approval:" + createHash("sha256").update(base).digest("hex").slice(0, 16);
}

function buildIdempotencyKey(finalGate: TerminalBriefSidecarDefaultOnCandidateFinalGatePacket, generatedAt: string, state: string, approvalReference: string): string {
  const base = JSON.stringify({ label: "terminal-brief-sidecar-default-on-approval-request", finalGate: finalGate.idempotencyKey, generatedAt, state, approvalReference });
  return "tb-sidecar-default-on-approval-request:" + createHash("sha256").update(base).digest("hex").slice(0, 24);
}

function isFinalGatePacket(value: unknown): value is TerminalBriefSidecarDefaultOnCandidateFinalGatePacket {
  return isRecord(value) && value.kind === "a2a-broker.terminal-brief-sidecar-default-on-candidate-final-gate.packet";
}

