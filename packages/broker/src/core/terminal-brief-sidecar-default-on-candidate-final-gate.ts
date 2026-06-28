import { unique } from "./collections.js";
import { numberValue } from "./value-text.js";
import { isRecord } from "./value-guards.js";
import { createHash } from "node:crypto";
import { optionalString } from "./terminal-brief-value-guards.js";

export type TerminalBriefSidecarDefaultOnCandidateFinalGateState =
  | "ready_for_default_on_candidate_review"
  | "waiting_for_bounded_observation"
  | "blocked";

export interface TerminalBriefSidecarBoundedDryRunObservationPacket {
  kind: "seoseo.terminal-brief-sidecar-bounded-dry-run-observation";
  generatedAt?: string;
  operatorInstructionReference?: string;
  windowSeconds?: number;
  state?: string;
  blockers?: string[];
  summary?: {
    processCount?: number;
    nRestarts?: string | number;
    spoolBefore?: number;
    spoolAfter?: number;
    spoolDelta?: number;
    cursorBefore?: string;
    cursorAfter?: string;
    brokerOk?: boolean;
    gatewayReady?: boolean;
    gatewayEventLoopDegraded?: boolean | null;
  };
  safety?: {
    dryRunOnly?: boolean;
    spoolOnly?: boolean;
    liveProviderSendPermitted?: boolean;
    terminalAckPermitted?: boolean;
    dbMutationPermitted?: boolean;
    defaultOnPermitted?: boolean;
    processSpawnPerformed?: boolean;
    sidecarRestartPerformed?: boolean;
  };
}

export interface TerminalBriefSidecarDefaultOnCandidateFinalGateOptions {
  now?: string;
  mode?: string;
  reviewOwner?: string;
  review_owner?: string;
  gateReference?: string;
  gate_reference?: string;
  minObservationSeconds?: number;
  min_observation_seconds?: number;
}

export interface TerminalBriefSidecarDefaultOnCandidateFinalGatePacket {
  kind: "a2a-broker.terminal-brief-sidecar-default-on-candidate-final-gate.packet";
  version: 1;
  generatedAt: string;
  mode: string;
  state: TerminalBriefSidecarDefaultOnCandidateFinalGateState;
  dryRunOnly: true;
  sourceOnlyNoLive: true;
  idempotencyKey: string;
  source: {
    observationKind: TerminalBriefSidecarBoundedDryRunObservationPacket["kind"];
    observationState: string;
    observationGeneratedAt?: string;
    operatorInstructionReference?: string;
    windowSeconds: number;
    minObservationSeconds: number;
  };
  candidateGate: {
    reviewOnly: true;
    defaultOnCandidate: true;
    defaultOnEnabled: false;
    reviewOwner: string;
    gateReference: string;
    checklist: Array<{
      id: string;
      label: string;
      status: "ready" | "blocked";
      evidence: string[];
      permitted: false;
    }>;
    abortConditions: string[];
    rollbackChecklist: string[];
  };
  readiness: {
    sourceCriteriaMet: boolean;
    finalGateReady: boolean;
    defaultOnPermitted: false;
    liveActivationPermitted: false;
    providerSendPermitted: false;
    terminalAckPermitted: false;
    executionPermitted: false;
    dbMutationPermitted: false;
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
    defaultOnCandidateFinalGateVersion: 1;
    consumesBoundedDryRunObservationPacket: true;
    rendersDefaultOnCandidateFinalGate: true;
    enablesDefaultOn: false;
    sendsProvider: false;
    performsTerminalAck: false;
    mutatesDb: false;
    spawnsProcess: false;
    restartsSidecar: false;
    executesAction: false;
  };
  semantics: {
    finalGateReviewOnly: true;
    sourceOnlyNoLive: true;
    candidateDoesNotEnableDefaultOn: true;
    observationDoesNotAuthorizeLiveSend: true;
    terminalAckEligibleDoesNotPermitAck: true;
    providerAcceptedIsVisibilityProof: false;
    executionNotPermitted: true;
    processSpawnNotPermitted: true;
    sidecarStartNotPermitted: true;
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

export function buildTerminalBriefSidecarDefaultOnCandidateFinalGate(
  observation: TerminalBriefSidecarBoundedDryRunObservationPacket,
  options: TerminalBriefSidecarDefaultOnCandidateFinalGateOptions = {},
): TerminalBriefSidecarDefaultOnCandidateFinalGatePacket {
  const generatedAt = options.now ?? new Date().toISOString();
  const minObservationSeconds = numberValue(options.minObservationSeconds ?? options.min_observation_seconds) ?? 300;
  const blockers = buildBlockers(observation, minObservationSeconds);
  const state = observation.state === "bounded_dry_run_observation_passed" && blockers.length === 0
    ? "ready_for_default_on_candidate_review"
    : observation.state === "bounded_dry_run_observation_passed" ? "blocked" : "waiting_for_bounded_observation";
  const ready = state === "ready_for_default_on_candidate_review";
  const gateReference = optionalString(options.gateReference ?? options.gate_reference) ?? buildGateReference(observation);
  return {
    kind: "a2a-broker.terminal-brief-sidecar-default-on-candidate-final-gate.packet",
    version: 1,
    generatedAt,
    mode: options.mode ?? "terminal-brief-default-on-candidate-source-only",
    state,
    dryRunOnly: true,
    sourceOnlyNoLive: true,
    idempotencyKey: buildIdempotencyKey(observation, generatedAt, state, gateReference),
    source: {
      observationKind: observation.kind,
      observationState: optionalString(observation.state) ?? "unknown",
      observationGeneratedAt: optionalString(observation.generatedAt),
      operatorInstructionReference: optionalString(observation.operatorInstructionReference),
      windowSeconds: numberValue(observation.windowSeconds) ?? 0,
      minObservationSeconds,
    },
    candidateGate: {
      reviewOnly: true,
      defaultOnCandidate: true,
      defaultOnEnabled: false,
      reviewOwner: optionalString(options.reviewOwner ?? options.review_owner) ?? "broker-finalizer",
      gateReference,
      checklist: buildChecklist(observation, minObservationSeconds),
      abortConditions: [
        "sidecar service is not active or has multiple processes",
        "NRestarts is non-zero during the observation window",
        "dry-run/spool-only command boundary cannot be proven",
        "spool delta is non-zero before default-on review",
        "broker /livez or Gateway /readyz is not healthy",
        "Gateway event loop is degraded",
        "any live provider send, terminal ACK, DB mutation, or default-on mutation is requested by this packet",
      ],
      rollbackChecklist: [
        "do not enable default-on from this packet",
        "keep live provider send disabled",
        "keep terminal ACK/replay disabled",
        "collect separate operator approval before any default-on mutation",
        "record sanitized evidence only",
      ],
    },
    readiness: {
      sourceCriteriaMet: ready,
      finalGateReady: ready,
      defaultOnPermitted: false,
      liveActivationPermitted: false,
      providerSendPermitted: false,
      terminalAckPermitted: false,
      executionPermitted: false,
      dbMutationPermitted: false,
      processSpawnPermitted: false,
      sidecarStartPermitted: false,
      missingEvidence: missingEvidenceFor(observation, minObservationSeconds),
      blockers: [
        ...blockers,
        "default-on candidate final gate is review-only",
        "default-on, live send, terminal ACK, and DB mutation require later separate approved paths",
      ],
      nextAction: ready
        ? "review the default-on candidate gate and request separate explicit approval before any default-on mutation"
        : "collect a passing bounded dry-run observation before default-on candidate review",
    },
    blockers,
    nextActions: ready
      ? [
        "review the default-on candidate gate",
        "request separate explicit operator approval before any default-on mutation, live provider send, terminal ACK, or DB mutation",
      ]
      : ["resolve bounded dry-run observation blockers before default-on candidate review"],
    approvalSensitiveActionsExcluded: [
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
      defaultOnCandidateFinalGateVersion: 1,
      consumesBoundedDryRunObservationPacket: true,
      rendersDefaultOnCandidateFinalGate: true,
      enablesDefaultOn: false,
      sendsProvider: false,
      performsTerminalAck: false,
      mutatesDb: false,
      spawnsProcess: false,
      restartsSidecar: false,
      executesAction: false,
    },
    semantics: {
      finalGateReviewOnly: true,
      sourceOnlyNoLive: true,
      candidateDoesNotEnableDefaultOn: true,
      observationDoesNotAuthorizeLiveSend: true,
      terminalAckEligibleDoesNotPermitAck: true,
      providerAcceptedIsVisibilityProof: false,
      executionNotPermitted: true,
      processSpawnNotPermitted: true,
      sidecarStartNotPermitted: true,
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

export function extractTerminalBriefSidecarDefaultOnCandidateFinalGateObservation(input: unknown): TerminalBriefSidecarBoundedDryRunObservationPacket {
  const envelope = isRecord(input) ? input : {};
  const candidates = [input, envelope.observationPacket, envelope.boundedDryRunObservationPacket, envelope.packet];
  const packet = candidates.find(isObservationPacket);
  if (!packet) throw new Error("expected a Terminal Brief bounded dry-run observation packet");
  return packet;
}

export function extractTerminalBriefSidecarDefaultOnCandidateFinalGateOptions(input: unknown): TerminalBriefSidecarDefaultOnCandidateFinalGateOptions {
  const envelope = isRecord(input) ? input : {};
  const candidate = envelope.defaultOnCandidateFinalGate ?? envelope.finalGate ?? envelope.options;
  return isRecord(candidate) ? candidate as TerminalBriefSidecarDefaultOnCandidateFinalGateOptions : {};
}

export function renderTerminalBriefSidecarDefaultOnCandidateFinalGateMarkdown(packet: TerminalBriefSidecarDefaultOnCandidateFinalGatePacket): string {
  return [
    packet.state === "ready_for_default_on_candidate_review"
      ? "Ready: Terminal Brief default-on candidate final gate"
      : "Blocked: Terminal Brief default-on candidate final gate",
    "Mode: " + packet.mode,
    "State: " + packet.state + " dryRunOnly=" + packet.dryRunOnly + " sourceOnlyNoLive=" + packet.sourceOnlyNoLive,
    "Idempotency: " + packet.idempotencyKey,
    "Observation: state=" + packet.source.observationState + " windowSeconds=" + packet.source.windowSeconds,
    "Readiness: finalGateReady=" + packet.readiness.finalGateReady
      + " defaultOnPermitted=" + packet.readiness.defaultOnPermitted
      + " providerSendPermitted=" + packet.readiness.providerSendPermitted
      + " terminalAckPermitted=" + packet.readiness.terminalAckPermitted
      + " dbMutationPermitted=" + packet.readiness.dbMutationPermitted,
    ...(packet.blockers.length ? ["", "Blockers:", ...packet.blockers.map((blocker) => "- " + blocker)] : []),
    "",
    "Checklist:",
    ...packet.candidateGate.checklist.map((item) => "- [" + item.status + "] " + item.label),
    "",
    "Next actions:",
    ...packet.nextActions.map((action) => "- " + action),
    "",
    "Safety: review-only; does not enable default-on, send providers, ACK/replay terminal rows, mutate DB/TaskFlow/GitHub state, spawn processes, restart/deploy, release, publish, or move secrets.",
  ].join("\n");
}

function buildChecklist(observation: TerminalBriefSidecarBoundedDryRunObservationPacket, minObservationSeconds: number): TerminalBriefSidecarDefaultOnCandidateFinalGatePacket["candidateGate"]["checklist"] {
  const summary = observation.summary ?? {};
  const safety = observation.safety ?? {};
  return [
    checklistItem("observation_state", "Bounded dry-run observation passed", observation.state === "bounded_dry_run_observation_passed", ["state=" + (observation.state ?? "unknown")]),
    checklistItem("observation_window", "Observation window meets minimum", (numberValue(observation.windowSeconds) ?? 0) >= minObservationSeconds, ["windowSeconds=" + (observation.windowSeconds ?? "unknown"), "min=" + minObservationSeconds]),
    checklistItem("single_process", "Exactly one sidecar process observed", summary.processCount === 1, ["processCount=" + String(summary.processCount ?? "unknown")]),
    checklistItem("no_restarts", "No sidecar restarts observed", String(summary.nRestarts ?? "unknown") === "0", ["NRestarts=" + String(summary.nRestarts ?? "unknown")]),
    checklistItem("spool_stable", "Spool file did not grow during observation", summary.spoolDelta === 0, ["spoolDelta=" + String(summary.spoolDelta ?? "unknown")]),
    checklistItem("broker_gateway_ready", "Broker and Gateway readiness stayed healthy", summary.brokerOk === true && summary.gatewayReady === true && summary.gatewayEventLoopDegraded === false, ["brokerOk=" + String(summary.brokerOk), "gatewayReady=" + String(summary.gatewayReady), "eventLoopDegraded=" + String(summary.gatewayEventLoopDegraded)]),
    checklistItem("runtime_safety", "Runtime safety flags remain no-live", safety.dryRunOnly === true && safety.spoolOnly === true && safety.liveProviderSendPermitted === false && safety.terminalAckPermitted === false && safety.dbMutationPermitted === false && safety.defaultOnPermitted === false, ["dryRunOnly=" + String(safety.dryRunOnly), "spoolOnly=" + String(safety.spoolOnly), "liveProviderSendPermitted=" + String(safety.liveProviderSendPermitted), "terminalAckPermitted=" + String(safety.terminalAckPermitted), "dbMutationPermitted=" + String(safety.dbMutationPermitted), "defaultOnPermitted=" + String(safety.defaultOnPermitted)]),
  ];
}

function checklistItem(id: string, label: string, ready: boolean, evidence: string[]) {
  return { id, label, status: ready ? "ready" as const : "blocked" as const, evidence, permitted: false as const };
}

function buildBlockers(observation: TerminalBriefSidecarBoundedDryRunObservationPacket, minObservationSeconds: number): string[] {
  return unique([
    ...((observation.blockers ?? []).filter(Boolean)),
    ...(observation.state !== "bounded_dry_run_observation_passed" ? ["bounded observation state is " + (observation.state ?? "unknown")] : []),
    ...((numberValue(observation.windowSeconds) ?? 0) < minObservationSeconds ? ["observation window is below minimum"] : []),
    ...(observation.summary?.processCount !== 1 ? ["sidecar process count is not one"] : []),
    ...(String(observation.summary?.nRestarts ?? "unknown") !== "0" ? ["sidecar NRestarts is not zero"] : []),
    ...(observation.summary?.spoolDelta !== 0 ? ["spool delta is not zero"] : []),
    ...(observation.summary?.brokerOk !== true ? ["broker livez is not ok"] : []),
    ...(observation.summary?.gatewayReady !== true ? ["gateway readyz is not ready"] : []),
    ...(observation.summary?.gatewayEventLoopDegraded !== false ? ["gateway event loop is degraded or missing"] : []),
    ...(observation.safety?.dryRunOnly !== true ? ["dry-run-only safety proof is missing"] : []),
    ...(observation.safety?.spoolOnly !== true ? ["spool-only safety proof is missing"] : []),
    ...(observation.safety?.liveProviderSendPermitted !== false ? ["live provider send is not explicitly false"] : []),
    ...(observation.safety?.terminalAckPermitted !== false ? ["terminal ACK is not explicitly false"] : []),
    ...(observation.safety?.dbMutationPermitted !== false ? ["DB mutation is not explicitly false"] : []),
    ...(observation.safety?.defaultOnPermitted !== false ? ["default-on permission is not explicitly false"] : []),
    ...(observation.safety?.processSpawnPerformed !== false ? ["process spawn performed flag is not false"] : []),
    ...(observation.safety?.sidecarRestartPerformed !== false ? ["sidecar restart performed flag is not false"] : []),
  ]);
}

function missingEvidenceFor(observation: TerminalBriefSidecarBoundedDryRunObservationPacket, minObservationSeconds: number): string[] {
  const missing: string[] = [];
  if (observation.state !== "bounded_dry_run_observation_passed") missing.push("passing_bounded_dry_run_observation");
  if ((numberValue(observation.windowSeconds) ?? 0) < minObservationSeconds) missing.push("minimum_observation_window");
  if (!observation.summary) missing.push("observation_summary");
  if (!observation.safety) missing.push("runtime_safety_summary");
  return unique(missing);
}

function buildIdempotencyKey(observation: TerminalBriefSidecarBoundedDryRunObservationPacket, generatedAt: string, state: string, gateReference: string): string {
  const base = JSON.stringify({ label: "terminal-brief-sidecar-default-on-candidate-final-gate", observation, generatedAt, state, gateReference });
  return "tb-sidecar-default-on-candidate-final-gate:" + createHash("sha256").update(base).digest("hex").slice(0, 24);
}

function buildGateReference(observation: TerminalBriefSidecarBoundedDryRunObservationPacket): string {
  const base = JSON.stringify({ generatedAt: observation.generatedAt, state: observation.state, windowSeconds: observation.windowSeconds, summary: observation.summary });
  return "tb-sidecar-default-on-candidate:" + createHash("sha256").update(base).digest("hex").slice(0, 16);
}

function isObservationPacket(value: unknown): value is TerminalBriefSidecarBoundedDryRunObservationPacket {
  return isRecord(value) && value.kind === "seoseo.terminal-brief-sidecar-bounded-dry-run-observation";
}

