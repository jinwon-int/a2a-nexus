import { isRecord } from "./value-guards.js";
import { createHash } from "node:crypto";

import type { TerminalBriefSidecarDefaultOnApprovalEvidenceIngestorPacket } from "./terminal-brief-sidecar-default-on-approval-evidence-ingestor.js";
import { optionalString } from "./value-text.js";

export type TerminalBriefSidecarDefaultOnEnablementGateState =
  | "ready_for_default_on_enablement_review"
  | "waiting_for_accepted_approval_evidence"
  | "stale"
  | "conflicting"
  | "rejected"
  | "blocked";

export interface TerminalBriefSidecarDefaultOnEnablementGateOptions {
  now?: string;
  mode?: string;
  finalizer?: string;
  finalizer_id?: string;
  gateReference?: string;
  gate_reference?: string;
  runtimeTarget?: string;
  runtime_target?: string;
  operatorInstructionReference?: string;
  operator_instruction_reference?: string;
}

export interface TerminalBriefSidecarDefaultOnEnablementGatePacket {
  kind: "a2a-broker.terminal-brief-sidecar-default-on-enablement-gate.packet";
  version: 1;
  generatedAt: string;
  mode: string;
  state: TerminalBriefSidecarDefaultOnEnablementGateState;
  dryRunOnly: false;
  sourceOnlyNoLive: true;
  idempotencyKey: string;
  source: {
    approvalEvidenceKind: TerminalBriefSidecarDefaultOnApprovalEvidenceIngestorPacket["kind"];
    approvalEvidenceState: TerminalBriefSidecarDefaultOnApprovalEvidenceIngestorPacket["state"];
    approvalEvidenceIdempotencyKey: string;
    approvalReference: string;
    requestedAction: string;
    requestedBy: string;
    operatorTarget: string;
    operatorChannel?: string;
    receiptEvidenceAccepted: boolean;
    approvalEvidenceAccepted: boolean;
    providerAcceptedIsVisibilityProof: false;
  };
  enablementGate: {
    reviewOnly: true;
    gateReference: string;
    finalizer: string;
    runtimeTarget: string;
    operatorInstructionReference?: string;
    requiredAcceptedEvidence: string[];
    preRuntimeChecklist: string[];
    abortConditions: string[];
    rollbackChecklist: string[];
  };
  readiness: {
    sourceCriteriaMet: boolean;
    enablementGateReady: boolean;
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
    enablementGateVersion: 1;
    consumesDefaultOnApprovalEvidenceIngestorPacket: true;
    rendersDefaultOnEnablementGate: true;
    providerAcceptedIsVisibilityProof: false;
    approvalGrantEvidenceExecutesGrant: false;
    enablesDefaultOn: false;
    sendsProvider: false;
    performsTerminalAck: false;
    mutatesDb: false;
    spawnsProcess: false;
    startsSidecar: false;
    restartsSidecar: false;
    executesAction: false;
  };
  semantics: {
    finalGateReviewOnly: true;
    sourceOnlyNoLive: true;
    acceptedEvidenceIsInputOnly: true;
    approvalEvidenceDoesNotExecuteGrant: true;
    gateDoesNotEnableDefaultOn: true;
    gateDoesNotSendProviders: true;
    gateDoesNotAckTerminalRows: true;
    gateDoesNotMutateDb: true;
    providerAcceptedIsVisibilityProof: false;
    terminalAckEligibleDoesNotPermitAck: true;
    defaultOnNotEnabledByThisPacket: true;
    executionNotPermitted: true;
    processSpawnNotPermitted: true;
    sidecarStartNotPermitted: true;
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

export function buildTerminalBriefSidecarDefaultOnEnablementGate(
  approvalEvidence: TerminalBriefSidecarDefaultOnApprovalEvidenceIngestorPacket,
  options: TerminalBriefSidecarDefaultOnEnablementGateOptions = {},
): TerminalBriefSidecarDefaultOnEnablementGatePacket {
  const generatedAt = options.now ?? new Date().toISOString();
  const blockers = buildBlockers(approvalEvidence);
  const missingEvidence = missingEvidenceFor(approvalEvidence);
  const state = stateFor(approvalEvidence, blockers, missingEvidence);
  const ready = state === "ready_for_default_on_enablement_review";
  const gateReference = optionalString(options.gateReference ?? options.gate_reference) ?? buildGateReference(approvalEvidence);
  const finalizer = optionalString(options.finalizer ?? options.finalizer_id) ?? "broker-finalizer";
  const runtimeTarget = optionalString(options.runtimeTarget ?? options.runtime_target) ?? approvalEvidence.source.operatorTarget;
  const operatorInstructionReference = optionalString(options.operatorInstructionReference ?? options.operator_instruction_reference);
  return {
    kind: "a2a-broker.terminal-brief-sidecar-default-on-enablement-gate.packet",
    version: 1,
    generatedAt,
    mode: options.mode ?? "terminal-brief-default-on-enablement-gate-source-only",
    state,
    dryRunOnly: false,
    sourceOnlyNoLive: true,
    idempotencyKey: buildIdempotencyKey(approvalEvidence, generatedAt, state, gateReference),
    source: {
      approvalEvidenceKind: approvalEvidence.kind,
      approvalEvidenceState: approvalEvidence.state,
      approvalEvidenceIdempotencyKey: approvalEvidence.idempotencyKey,
      approvalReference: approvalEvidence.source.approvalReference,
      requestedAction: approvalEvidence.source.requestedAction,
      requestedBy: approvalEvidence.source.requestedBy,
      operatorTarget: approvalEvidence.source.operatorTarget,
      operatorChannel: approvalEvidence.source.operatorChannel,
      receiptEvidenceAccepted: approvalEvidence.receiptEvidenceAccepted,
      approvalEvidenceAccepted: approvalEvidence.approvalEvidenceAccepted,
      providerAcceptedIsVisibilityProof: false,
    },
    enablementGate: {
      reviewOnly: true,
      gateReference,
      finalizer,
      runtimeTarget,
      operatorInstructionReference,
      requiredAcceptedEvidence: [
        "accepted default-on approval evidence ingestor packet",
        "operator-visible receipt proof",
        "matching default-on approval_grant evidence",
        "provider_accepted classified as non-visibility proof",
      ],
      preRuntimeChecklist: [
        "verify broker and sidecar runtime revisions before any later mutation",
        "verify dry-run sidecar remains healthy and single-process",
        "verify abort and rollback path before default-on runtime change",
        "request a fresh explicit operator approval for the runtime mutation step",
      ],
      abortConditions: [
        "approval evidence is stale, conflicting, rejected, or blocked",
        "provider accepted is treated as visibility proof",
        "any source packet permits default-on/provider send/terminal ACK/DB mutation",
        "sidecar process or broker health is degraded before the runtime step",
      ],
      rollbackChecklist: [
        "leave default-on disabled until a later approved runtime mutation",
        "preserve approval evidence packet and gate output for broker finalizer review",
        "do not ACK/replay terminal rows from this gate",
      ],
    },
    readiness: {
      sourceCriteriaMet: ready,
      enablementGateReady: ready,
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
      missingEvidence,
      blockers: [
        ...blockers,
        "default-on enablement gate is source-only and does not mutate runtime state",
        "runtime default-on change requires a later explicit approval and mutation path",
      ],
      nextAction: ready
        ? "broker finalizer may review this gate and request separate runtime mutation approval"
        : "collect accepted default-on approval evidence before enablement gate review",
    },
    blockers,
    nextActions: ready
      ? [
        "review the source-only default-on enablement gate",
        "prepare a separate runtime mutation plan without executing it",
        "do not enable default-on until a later explicit runtime approval",
      ]
      : nextActionsForState(state),
    approvalSensitiveActionsExcluded: [
      "sending approval requests",
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
      enablementGateVersion: 1,
      consumesDefaultOnApprovalEvidenceIngestorPacket: true,
      rendersDefaultOnEnablementGate: true,
      providerAcceptedIsVisibilityProof: false,
      approvalGrantEvidenceExecutesGrant: false,
      enablesDefaultOn: false,
      sendsProvider: false,
      performsTerminalAck: false,
      mutatesDb: false,
      spawnsProcess: false,
      startsSidecar: false,
      restartsSidecar: false,
      executesAction: false,
    },
    semantics: {
      finalGateReviewOnly: true,
      sourceOnlyNoLive: true,
      acceptedEvidenceIsInputOnly: true,
      approvalEvidenceDoesNotExecuteGrant: true,
      gateDoesNotEnableDefaultOn: true,
      gateDoesNotSendProviders: true,
      gateDoesNotAckTerminalRows: true,
      gateDoesNotMutateDb: true,
      providerAcceptedIsVisibilityProof: false,
      terminalAckEligibleDoesNotPermitAck: true,
      defaultOnNotEnabledByThisPacket: true,
      executionNotPermitted: true,
      processSpawnNotPermitted: true,
      sidecarStartNotPermitted: true,
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

export function extractTerminalBriefSidecarDefaultOnEnablementGateApprovalEvidence(
  input: unknown,
): TerminalBriefSidecarDefaultOnApprovalEvidenceIngestorPacket {
  const envelope = isRecord(input) ? input : {};
  const candidates = [
    input,
    envelope.defaultOnApprovalEvidence,
    envelope.defaultOnApprovalEvidencePacket,
    envelope.defaultOnApprovalEvidenceIngestorPacket,
    envelope.approvalEvidence,
    envelope.approvalEvidencePacket,
    envelope.packet,
  ];
  const packet = candidates.find(isTerminalBriefSidecarDefaultOnApprovalEvidenceIngestorPacket);
  if (!packet) {
    throw new Error("expected a Terminal Brief sidecar default-on approval evidence ingestor packet");
  }
  return packet;
}

export function extractTerminalBriefSidecarDefaultOnEnablementGateOptions(
  input: unknown,
): TerminalBriefSidecarDefaultOnEnablementGateOptions {
  const envelope = isRecord(input) ? input : {};
  const options = isRecord(envelope.defaultOnEnablementGate)
    ? envelope.defaultOnEnablementGate
    : isRecord(envelope.enablementGate)
      ? envelope.enablementGate
      : isRecord(envelope.options)
        ? envelope.options
        : {};
  return {
    now: optionalString(options.now),
    mode: optionalString(options.mode),
    finalizer: optionalString(options.finalizer ?? options.finalizer_id),
    gateReference: optionalString(options.gateReference ?? options.gate_reference),
    runtimeTarget: optionalString(options.runtimeTarget ?? options.runtime_target),
    operatorInstructionReference: optionalString(options.operatorInstructionReference ?? options.operator_instruction_reference),
  };
}

export function renderTerminalBriefSidecarDefaultOnEnablementGateMarkdown(
  packet: TerminalBriefSidecarDefaultOnEnablementGatePacket,
): string {
  return [
    packet.state === "ready_for_default_on_enablement_review"
      ? "Ready: Terminal Brief default-on enablement gate"
      : "Blocked: Terminal Brief default-on enablement gate",
    "Mode: " + packet.mode,
    "State: " + packet.state + " sourceOnlyNoLive=" + packet.sourceOnlyNoLive,
    "Idempotency: " + packet.idempotencyKey,
    "Approval evidence: state=" + packet.source.approvalEvidenceState
      + " receiptEvidenceAccepted=" + packet.source.receiptEvidenceAccepted
      + " approvalEvidenceAccepted=" + packet.source.approvalEvidenceAccepted
      + " providerAcceptedIsVisibilityProof=" + packet.source.providerAcceptedIsVisibilityProof,
    "Gate: reference=" + packet.enablementGate.gateReference
      + " finalizer=" + packet.enablementGate.finalizer
      + " runtimeTarget=" + packet.enablementGate.runtimeTarget,
    "Readiness: enablementGateReady=" + packet.readiness.enablementGateReady
      + " defaultOnPermitted=" + packet.readiness.defaultOnPermitted
      + " providerSendPermitted=" + packet.readiness.providerSendPermitted
      + " terminalAckPermitted=" + packet.readiness.terminalAckPermitted
      + " dbMutationPermitted=" + packet.readiness.dbMutationPermitted,
    ...(packet.readiness.missingEvidence.length ? ["Missing evidence:", ...packet.readiness.missingEvidence.map((item) => "- " + item)] : []),
    ...(packet.blockers.length ? ["", "Blockers:", ...packet.blockers.map((blocker) => "- " + blocker)] : []),
    "",
    "Pre-runtime checklist:",
    ...packet.enablementGate.preRuntimeChecklist.map((item) => "- " + item),
    "",
    "Next actions:",
    ...packet.nextActions.map((action) => "- " + action),
    "",
    "Safety: enablement gate only; does not enable default-on, send providers, ACK/replay terminal rows, mutate DB/TaskFlow/GitHub state, spawn processes, restart/deploy sidecar, release, publish, or move secrets.",
  ].join("\n");
}

function buildBlockers(approvalEvidence: TerminalBriefSidecarDefaultOnApprovalEvidenceIngestorPacket): string[] {
  return unique([
    ...approvalEvidence.blockers,
    ...(approvalEvidence.state === "blocked" ? ["default-on approval evidence packet is blocked"] : []),
    ...(approvalEvidence.state === "conflicting" ? ["default-on approval evidence packet is conflicting"] : []),
    ...(approvalEvidence.state === "rejected" ? ["default-on approval evidence packet is rejected"] : []),
    ...(approvalEvidence.state === "stale" ? ["default-on approval evidence packet is stale"] : []),
    ...(approvalEvidence.classification.providerAcceptedIsVisibilityProof !== false ? ["approval evidence unexpectedly treats provider accepted as visibility proof"] : []),
    ...(approvalEvidence.readiness.approvalRequestDispatchPermitted !== false ? ["approval evidence unexpectedly permits approval request dispatch"] : []),
    ...(approvalEvidence.readiness.approvalGrantPermitted !== false ? ["approval evidence unexpectedly permits approval grant"] : []),
    ...(approvalEvidence.readiness.defaultOnPermitted !== false ? ["approval evidence unexpectedly permits default-on"] : []),
    ...(approvalEvidence.readiness.providerSendPermitted !== false ? ["approval evidence unexpectedly permits provider send"] : []),
    ...(approvalEvidence.readiness.terminalAckPermitted !== false ? ["approval evidence unexpectedly permits terminal ACK"] : []),
    ...(approvalEvidence.readiness.dbMutationPermitted !== false ? ["approval evidence unexpectedly permits DB mutation"] : []),
    ...(approvalEvidence.readiness.executionPermitted !== false ? ["approval evidence unexpectedly permits execution"] : []),
    ...(approvalEvidence.readiness.processSpawnPermitted !== false ? ["approval evidence unexpectedly permits process spawn"] : []),
    ...(approvalEvidence.readiness.sidecarStartPermitted !== false ? ["approval evidence unexpectedly permits sidecar start"] : []),
    ...(approvalEvidence.integrationContract.grantsApproval ? ["approval evidence unexpectedly grants approval"] : []),
    ...(approvalEvidence.integrationContract.enablesDefaultOn ? ["approval evidence unexpectedly enables default-on"] : []),
    ...(approvalEvidence.integrationContract.sendsProvider ? ["approval evidence unexpectedly sends provider"] : []),
    ...(approvalEvidence.integrationContract.performsTerminalAck ? ["approval evidence unexpectedly performs terminal ACK"] : []),
    ...(approvalEvidence.integrationContract.mutatesDb ? ["approval evidence unexpectedly mutates DB"] : []),
    ...(approvalEvidence.integrationContract.spawnsProcess ? ["approval evidence unexpectedly spawns process"] : []),
    ...(approvalEvidence.integrationContract.startsSidecar ? ["approval evidence unexpectedly starts sidecar"] : []),
    ...(approvalEvidence.integrationContract.executesAction ? ["approval evidence unexpectedly executes action"] : []),
    ...(approvalEvidence.semantics.approvalGrantEvidenceDoesNotGrantApproval !== true ? ["approval evidence does not preserve grant evidence boundary"] : []),
    ...(approvalEvidence.semantics.defaultOnApprovalEvidenceDoesNotEnableDefaultOn !== true ? ["approval evidence does not preserve default-on boundary"] : []),
    ...(approvalEvidence.semantics.performsProviderSend ? ["approval evidence unexpectedly performs provider send"] : []),
    ...(approvalEvidence.semantics.performsTerminalAck ? ["approval evidence unexpectedly performs terminal ACK"] : []),
    ...(approvalEvidence.semantics.performsRuntimeRestartOrDeploy ? ["approval evidence unexpectedly performs restart/deploy"] : []),
    ...(approvalEvidence.semantics.performsDbMutation ? ["approval evidence unexpectedly performs DB mutation"] : []),
    ...(approvalEvidence.semantics.performsHistoricalReplay ? ["approval evidence unexpectedly performs historical replay"] : []),
    ...(approvalEvidence.semantics.performsReleaseOrPublish ? ["approval evidence unexpectedly performs release/publish"] : []),
    ...(approvalEvidence.semantics.movesSecretsOrCredentials ? ["approval evidence unexpectedly moves secrets/credentials"] : []),
  ].filter(Boolean));
}

function missingEvidenceFor(approvalEvidence: TerminalBriefSidecarDefaultOnApprovalEvidenceIngestorPacket): string[] {
  const missing: string[] = [];
  if (approvalEvidence.state !== "accepted") missing.push("accepted_default_on_approval_evidence");
  if (!approvalEvidence.receiptEvidenceAccepted) missing.push("operator_visible_receipt_evidence");
  if (!approvalEvidence.approvalEvidenceAccepted) missing.push("matching_default_on_approval_grant_evidence");
  if (!approvalEvidence.classification.receiptProofAccepted) missing.push("receipt_proof_classification");
  if (!approvalEvidence.classification.approvalGrantAccepted) missing.push("approval_grant_classification");
  return unique(missing);
}

function stateFor(
  approvalEvidence: TerminalBriefSidecarDefaultOnApprovalEvidenceIngestorPacket,
  blockers: string[],
  missingEvidence: string[],
): TerminalBriefSidecarDefaultOnEnablementGateState {
  if (blockers.length > 0) return "blocked";
  if (approvalEvidence.state === "stale") return "stale";
  if (approvalEvidence.state === "conflicting") return "conflicting";
  if (approvalEvidence.state === "rejected") return "rejected";
  if (missingEvidence.length > 0) return "waiting_for_accepted_approval_evidence";
  return "ready_for_default_on_enablement_review";
}

function nextActionsForState(state: TerminalBriefSidecarDefaultOnEnablementGateState): string[] {
  if (state === "waiting_for_accepted_approval_evidence") {
    return [
      "ingest operator-visible receipt proof plus matching default-on approval grant evidence",
      "do not treat provider accepted as approval or visibility evidence",
    ];
  }
  if (state === "stale") return ["refresh default-on approval evidence before gate review"];
  if (state === "conflicting") return ["resolve conflicting default-on approval evidence before gate review"];
  if (state === "rejected") return ["do not enable default-on; collect a new approval request only if the operator changes the decision"];
  return ["recover blocked evidence source before gate review"];
}

function buildGateReference(approvalEvidence: TerminalBriefSidecarDefaultOnApprovalEvidenceIngestorPacket): string {
  const base = JSON.stringify({
    approvalEvidence: approvalEvidence.idempotencyKey,
    approvalReference: approvalEvidence.source.approvalReference,
    operatorTarget: approvalEvidence.source.operatorTarget,
  });
  return "tb-sidecar-default-on-enablement-gate:" + createHash("sha256").update(base).digest("hex").slice(0, 16);
}

function buildIdempotencyKey(
  approvalEvidence: TerminalBriefSidecarDefaultOnApprovalEvidenceIngestorPacket,
  generatedAt: string,
  state: string,
  gateReference: string,
): string {
  const base = JSON.stringify({
    label: "terminal-brief-sidecar-default-on-enablement-gate",
    approvalEvidence: approvalEvidence.idempotencyKey,
    generatedAt,
    state,
    gateReference,
  });
  return "tb-sidecar-default-on-enablement-gate:" + createHash("sha256").update(base).digest("hex").slice(0, 24);
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function isTerminalBriefSidecarDefaultOnApprovalEvidenceIngestorPacket(
  value: unknown,
): value is TerminalBriefSidecarDefaultOnApprovalEvidenceIngestorPacket {
  return isRecord(value) && value.kind === "a2a-broker.terminal-brief-sidecar-default-on-approval-evidence-ingestor.packet";
}

