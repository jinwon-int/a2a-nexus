import { unique } from "./collections.js";
import { isRecord } from "./value-guards.js";
import { createHash } from "node:crypto";

import type { TerminalBriefSidecarDefaultOnEnablementGatePacket } from "./terminal-brief-sidecar-default-on-enablement-gate.js";
import { optionalString } from "./value-text.js";

export type TerminalBriefSidecarDefaultOnRuntimeMutationPlanState =
  | "ready_for_runtime_mutation_review"
  | "waiting_for_enablement_gate"
  | "stale"
  | "conflicting"
  | "rejected"
  | "blocked";

export interface TerminalBriefSidecarDefaultOnRuntimeMutationPlanOptions {
  now?: string;
  mode?: string;
  finalizer?: string;
  finalizer_id?: string;
  planReference?: string;
  plan_reference?: string;
  runtimeTarget?: string;
  runtime_target?: string;
  operatorInstructionReference?: string;
  operator_instruction_reference?: string;
  configKey?: string;
  config_key?: string;
  proposedValue?: string;
  proposed_value?: string;
}

export interface TerminalBriefSidecarDefaultOnRuntimeMutationPlanPacket {
  kind: "a2a-broker.terminal-brief-sidecar-default-on-runtime-mutation-plan.packet";
  version: 1;
  generatedAt: string;
  mode: string;
  state: TerminalBriefSidecarDefaultOnRuntimeMutationPlanState;
  dryRunOnly: false;
  sourceOnlyNoLive: true;
  idempotencyKey: string;
  source: {
    enablementGateKind: TerminalBriefSidecarDefaultOnEnablementGatePacket["kind"];
    enablementGateState: TerminalBriefSidecarDefaultOnEnablementGatePacket["state"];
    enablementGateIdempotencyKey: string;
    gateReference: string;
    approvalReference: string;
    requestedAction: string;
    requestedBy: string;
    operatorTarget: string;
    providerAcceptedIsVisibilityProof: false;
    approvalGrantEvidenceExecutesGrant: false;
  };
  runtimeMutationPlan: {
    planOnly: true;
    planReference: string;
    finalizer: string;
    runtimeTarget: string;
    operatorInstructionReference?: string;
    configChange: {
      key: string;
      proposedValue: string;
      valueContainsSecret: false;
      applied: false;
    };
    requiredPreflight: string[];
    requiredApproval: string[];
    executionEnvelope: {
      executable: false;
      commandIncluded: false;
      envValuesIncluded: false;
      secretValuesIncluded: false;
      operatorMustApproveRuntimeMutation: true;
    };
    abortConditions: string[];
    rollbackChecklist: string[];
  };
  readiness: {
    sourceCriteriaMet: boolean;
    runtimeMutationPlanReady: boolean;
    runtimeMutationPermitted: false;
    configWritePermitted: false;
    approvalRequestDispatchPermitted: false;
    approvalGrantPermitted: false;
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
    runtimeMutationPlanVersion: 1;
    consumesDefaultOnEnablementGatePacket: true;
    rendersRuntimeMutationPlan: true;
    providerAcceptedIsVisibilityProof: false;
    approvalGrantEvidenceExecutesGrant: false;
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
    runtimeMutationPlanOnly: true;
    sourceOnlyNoLive: true;
    acceptedGateIsInputOnly: true;
    approvalEvidenceDoesNotExecuteGrant: true;
    planDoesNotWriteConfig: true;
    planDoesNotEnableDefaultOn: true;
    planDoesNotSendProviders: true;
    planDoesNotAckTerminalRows: true;
    planDoesNotMutateDb: true;
    planDoesNotMutateTaskFlow: true;
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

export function buildTerminalBriefSidecarDefaultOnRuntimeMutationPlan(
  enablementGate: TerminalBriefSidecarDefaultOnEnablementGatePacket,
  options: TerminalBriefSidecarDefaultOnRuntimeMutationPlanOptions = {},
): TerminalBriefSidecarDefaultOnRuntimeMutationPlanPacket {
  const generatedAt = options.now ?? new Date().toISOString();
  const blockers = buildBlockers(enablementGate);
  const missingEvidence = missingEvidenceFor(enablementGate);
  const state = stateFor(enablementGate, blockers, missingEvidence);
  const ready = state === "ready_for_runtime_mutation_review";
  const planReference = optionalString(options.planReference ?? options.plan_reference) ?? buildPlanReference(enablementGate);
  const finalizer = optionalString(options.finalizer ?? options.finalizer_id) ?? enablementGate.enablementGate.finalizer;
  const runtimeTarget = optionalString(options.runtimeTarget ?? options.runtime_target) ?? enablementGate.enablementGate.runtimeTarget;
  const operatorInstructionReference = optionalString(options.operatorInstructionReference ?? options.operator_instruction_reference);
  const configKey = optionalString(options.configKey ?? options.config_key) ?? "TERMINAL_BRIEF_SIDECAR_DEFAULT_ON";
  const proposedValue = optionalString(options.proposedValue ?? options.proposed_value) ?? "true";

  return {
    kind: "a2a-broker.terminal-brief-sidecar-default-on-runtime-mutation-plan.packet",
    version: 1,
    generatedAt,
    mode: options.mode ?? "terminal-brief-default-on-runtime-mutation-plan-source-only",
    state,
    dryRunOnly: false,
    sourceOnlyNoLive: true,
    idempotencyKey: buildIdempotencyKey(enablementGate, generatedAt, state, planReference),
    source: {
      enablementGateKind: enablementGate.kind,
      enablementGateState: enablementGate.state,
      enablementGateIdempotencyKey: enablementGate.idempotencyKey,
      gateReference: enablementGate.enablementGate.gateReference,
      approvalReference: enablementGate.source.approvalReference,
      requestedAction: enablementGate.source.requestedAction,
      requestedBy: enablementGate.source.requestedBy,
      operatorTarget: enablementGate.source.operatorTarget,
      providerAcceptedIsVisibilityProof: false,
      approvalGrantEvidenceExecutesGrant: false,
    },
    runtimeMutationPlan: {
      planOnly: true,
      planReference,
      finalizer,
      runtimeTarget,
      operatorInstructionReference,
      configChange: {
        key: configKey,
        proposedValue,
        valueContainsSecret: false,
        applied: false,
      },
      requiredPreflight: [
        "confirm both brokers are on the expected source revision before any later runtime mutation",
        "confirm sidecar runtime is healthy and single-process before any later default-on change",
        "confirm operator-visible approval still applies to this exact runtime target",
        "confirm rollback command/path is available before any later mutation",
      ],
      requiredApproval: [
        "fresh explicit operator approval for the runtime mutation step",
        "broker finalizer confirmation that source-only gates remain clean",
      ],
      executionEnvelope: {
        executable: false,
        commandIncluded: false,
        envValuesIncluded: false,
        secretValuesIncluded: false,
        operatorMustApproveRuntimeMutation: true,
      },
      abortConditions: [
        "enablement gate is stale, conflicting, rejected, blocked, or not ready",
        "any source packet permits default-on/provider send/terminal ACK/DB mutation",
        "operator approval is ambiguous, stale, or not tied to this runtime target",
        "broker or sidecar health is degraded before the later mutation step",
      ],
      rollbackChecklist: [
        "leave default-on disabled until a later approved runtime mutation",
        "preserve this plan and all source evidence for broker finalizer review",
        "do not ACK/replay terminal rows from this plan",
      ],
    },
    readiness: {
      sourceCriteriaMet: ready,
      runtimeMutationPlanReady: ready,
      runtimeMutationPermitted: false,
      configWritePermitted: false,
      approvalRequestDispatchPermitted: false,
      approvalGrantPermitted: false,
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
        "runtime mutation plan is source-only and does not write config or mutate runtime state",
        "actual default-on enablement requires a later explicit runtime approval and execution path",
      ],
      nextAction: ready
        ? "broker finalizer may review this plan and request separate runtime mutation approval"
        : "collect a ready source-only default-on enablement gate before runtime mutation review",
    },
    blockers,
    nextActions: ready
      ? [
        "review the source-only runtime mutation plan",
        "request a separate explicit approval before any config or service change",
        "do not enable default-on from this packet",
      ]
      : nextActionsForState(state),
    approvalSensitiveActionsExcluded: [
      "sending approval requests",
      "granting approval or executing an approval grant",
      "writing config or enabling Terminal Brief default-on",
      "live provider/Hermes/Gongyung/Telegram/OpenClaw send",
      "terminal ACK/replay or terminal receipt DB mutation",
      "process spawn, sidecar start/stop/restart, broker restart, or deploy",
      "GitHub mutation from the packet/route",
      "TaskFlow/broker DB mutation",
      "historical replay, release, publish, or secret movement",
    ],
    integrationContract: {
      transport: "json",
      runtimeMutationPlanVersion: 1,
      consumesDefaultOnEnablementGatePacket: true,
      rendersRuntimeMutationPlan: true,
      providerAcceptedIsVisibilityProof: false,
      approvalGrantEvidenceExecutesGrant: false,
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
      runtimeMutationPlanOnly: true,
      sourceOnlyNoLive: true,
      acceptedGateIsInputOnly: true,
      approvalEvidenceDoesNotExecuteGrant: true,
      planDoesNotWriteConfig: true,
      planDoesNotEnableDefaultOn: true,
      planDoesNotSendProviders: true,
      planDoesNotAckTerminalRows: true,
      planDoesNotMutateDb: true,
      planDoesNotMutateTaskFlow: true,
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

export function extractTerminalBriefSidecarDefaultOnRuntimeMutationPlanEnablementGate(
  input: unknown,
): TerminalBriefSidecarDefaultOnEnablementGatePacket {
  const envelope = isRecord(input) ? input : {};
  const candidates = [
    input,
    envelope.defaultOnEnablementGate,
    envelope.defaultOnEnablementGatePacket,
    envelope.enablementGate,
    envelope.enablementGatePacket,
    envelope.packet,
  ];
  const packet = candidates.find(isTerminalBriefSidecarDefaultOnEnablementGatePacket);
  if (!packet) {
    throw new Error("expected a Terminal Brief sidecar default-on enablement gate packet");
  }
  return packet;
}

export function extractTerminalBriefSidecarDefaultOnRuntimeMutationPlanOptions(
  input: unknown,
): TerminalBriefSidecarDefaultOnRuntimeMutationPlanOptions {
  const envelope = isRecord(input) ? input : {};
  const options = isRecord(envelope.defaultOnRuntimeMutationPlan)
    ? envelope.defaultOnRuntimeMutationPlan
    : isRecord(envelope.runtimeMutationPlan)
      ? envelope.runtimeMutationPlan
      : isRecord(envelope.options)
        ? envelope.options
        : {};
  return {
    now: optionalString(options.now),
    mode: optionalString(options.mode),
    finalizer: optionalString(options.finalizer ?? options.finalizer_id),
    planReference: optionalString(options.planReference ?? options.plan_reference),
    runtimeTarget: optionalString(options.runtimeTarget ?? options.runtime_target),
    operatorInstructionReference: optionalString(options.operatorInstructionReference ?? options.operator_instruction_reference),
    configKey: optionalString(options.configKey ?? options.config_key),
    proposedValue: optionalString(options.proposedValue ?? options.proposed_value),
  };
}

export function renderTerminalBriefSidecarDefaultOnRuntimeMutationPlanMarkdown(
  packet: TerminalBriefSidecarDefaultOnRuntimeMutationPlanPacket,
): string {
  return [
    packet.state === "ready_for_runtime_mutation_review"
      ? "Ready: Terminal Brief default-on runtime mutation plan"
      : "Blocked: Terminal Brief default-on runtime mutation plan",
    "Mode: " + packet.mode,
    "State: " + packet.state + " sourceOnlyNoLive=" + packet.sourceOnlyNoLive,
    "Idempotency: " + packet.idempotencyKey,
    "Enablement gate: state=" + packet.source.enablementGateState
      + " providerAcceptedIsVisibilityProof=" + packet.source.providerAcceptedIsVisibilityProof
      + " approvalGrantEvidenceExecutesGrant=" + packet.source.approvalGrantEvidenceExecutesGrant,
    "Plan: reference=" + packet.runtimeMutationPlan.planReference
      + " finalizer=" + packet.runtimeMutationPlan.finalizer
      + " runtimeTarget=" + packet.runtimeMutationPlan.runtimeTarget
      + " configKey=" + packet.runtimeMutationPlan.configChange.key
      + " applied=" + packet.runtimeMutationPlan.configChange.applied,
    "Readiness: runtimeMutationPlanReady=" + packet.readiness.runtimeMutationPlanReady
      + " runtimeMutationPermitted=" + packet.readiness.runtimeMutationPermitted
      + " configWritePermitted=" + packet.readiness.configWritePermitted
      + " defaultOnPermitted=" + packet.readiness.defaultOnPermitted
      + " sidecarRestartPermitted=" + packet.readiness.sidecarRestartPermitted,
    ...(packet.readiness.missingEvidence.length ? ["Missing evidence:", ...packet.readiness.missingEvidence.map((item) => "- " + item)] : []),
    ...(packet.blockers.length ? ["", "Blockers:", ...packet.blockers.map((blocker) => "- " + blocker)] : []),
    "",
    "Required preflight:",
    ...packet.runtimeMutationPlan.requiredPreflight.map((item) => "- " + item),
    "",
    "Next actions:",
    ...packet.nextActions.map((action) => "- " + action),
    "",
    "Safety: runtime mutation plan only; does not write config, enable default-on, send providers, ACK/replay terminal rows, mutate DB/TaskFlow/GitHub state, spawn processes, restart/deploy sidecar or broker, release, publish, or move secrets.",
  ].join("\n");
}

function buildBlockers(enablementGate: TerminalBriefSidecarDefaultOnEnablementGatePacket): string[] {
  return unique([
    ...enablementGate.blockers,
    ...(enablementGate.state === "blocked" ? ["default-on enablement gate is blocked"] : []),
    ...(enablementGate.state === "conflicting" ? ["default-on enablement gate is conflicting"] : []),
    ...(enablementGate.state === "rejected" ? ["default-on enablement gate is rejected"] : []),
    ...(enablementGate.state === "stale" ? ["default-on enablement gate is stale"] : []),
    ...(enablementGate.source.providerAcceptedIsVisibilityProof !== false ? ["enablement gate unexpectedly treats provider accepted as visibility proof"] : []),
    ...(enablementGate.integrationContract.approvalGrantEvidenceExecutesGrant ? ["enablement gate unexpectedly executes approval grant evidence"] : []),
    ...(enablementGate.readiness.approvalRequestDispatchPermitted !== false ? ["enablement gate unexpectedly permits approval request dispatch"] : []),
    ...(enablementGate.readiness.approvalGrantPermitted !== false ? ["enablement gate unexpectedly permits approval grant"] : []),
    ...(enablementGate.readiness.defaultOnPermitted !== false ? ["enablement gate unexpectedly permits default-on"] : []),
    ...(enablementGate.readiness.liveActivationPermitted !== false ? ["enablement gate unexpectedly permits live activation"] : []),
    ...(enablementGate.readiness.providerSendPermitted !== false ? ["enablement gate unexpectedly permits provider send"] : []),
    ...(enablementGate.readiness.terminalAckPermitted !== false ? ["enablement gate unexpectedly permits terminal ACK"] : []),
    ...(enablementGate.readiness.dbMutationPermitted !== false ? ["enablement gate unexpectedly permits DB mutation"] : []),
    ...(enablementGate.readiness.executionPermitted !== false ? ["enablement gate unexpectedly permits execution"] : []),
    ...(enablementGate.readiness.processSpawnPermitted !== false ? ["enablement gate unexpectedly permits process spawn"] : []),
    ...(enablementGate.readiness.sidecarStartPermitted !== false ? ["enablement gate unexpectedly permits sidecar start"] : []),
    ...(enablementGate.integrationContract.enablesDefaultOn ? ["enablement gate unexpectedly enables default-on"] : []),
    ...(enablementGate.integrationContract.sendsProvider ? ["enablement gate unexpectedly sends provider"] : []),
    ...(enablementGate.integrationContract.performsTerminalAck ? ["enablement gate unexpectedly performs terminal ACK"] : []),
    ...(enablementGate.integrationContract.mutatesDb ? ["enablement gate unexpectedly mutates DB"] : []),
    ...(enablementGate.integrationContract.spawnsProcess ? ["enablement gate unexpectedly spawns process"] : []),
    ...(enablementGate.integrationContract.startsSidecar ? ["enablement gate unexpectedly starts sidecar"] : []),
    ...(enablementGate.integrationContract.restartsSidecar ? ["enablement gate unexpectedly restarts sidecar"] : []),
    ...(enablementGate.integrationContract.executesAction ? ["enablement gate unexpectedly executes action"] : []),
    ...(enablementGate.semantics.gateDoesNotEnableDefaultOn !== true ? ["enablement gate does not preserve default-on boundary"] : []),
    ...(enablementGate.semantics.approvalEvidenceDoesNotExecuteGrant !== true ? ["enablement gate does not preserve approval grant boundary"] : []),
    ...(enablementGate.semantics.performsProviderSend ? ["enablement gate unexpectedly performs provider send"] : []),
    ...(enablementGate.semantics.performsTerminalAck ? ["enablement gate unexpectedly performs terminal ACK"] : []),
    ...(enablementGate.semantics.performsRuntimeRestartOrDeploy ? ["enablement gate unexpectedly performs restart/deploy"] : []),
    ...(enablementGate.semantics.performsDbMutation ? ["enablement gate unexpectedly performs DB mutation"] : []),
    ...(enablementGate.semantics.createsTaskFlowRecords ? ["enablement gate unexpectedly creates TaskFlow records"] : []),
    ...(enablementGate.semantics.performsHistoricalReplay ? ["enablement gate unexpectedly performs historical replay"] : []),
    ...(enablementGate.semantics.performsReleaseOrPublish ? ["enablement gate unexpectedly performs release/publish"] : []),
    ...(enablementGate.semantics.movesSecretsOrCredentials ? ["enablement gate unexpectedly moves secrets/credentials"] : []),
  ].filter(Boolean));
}

function missingEvidenceFor(enablementGate: TerminalBriefSidecarDefaultOnEnablementGatePacket): string[] {
  const missing: string[] = [];
  if (enablementGate.state !== "ready_for_default_on_enablement_review") missing.push("ready_default_on_enablement_gate");
  if (!enablementGate.readiness.enablementGateReady) missing.push("enablement_gate_ready");
  if (!enablementGate.readiness.sourceCriteriaMet) missing.push("enablement_gate_source_criteria");
  if (!enablementGate.source.receiptEvidenceAccepted) missing.push("operator_visible_receipt_evidence");
  if (!enablementGate.source.approvalEvidenceAccepted) missing.push("matching_default_on_approval_grant_evidence");
  return unique(missing);
}

function stateFor(
  enablementGate: TerminalBriefSidecarDefaultOnEnablementGatePacket,
  blockers: string[],
  missingEvidence: string[],
): TerminalBriefSidecarDefaultOnRuntimeMutationPlanState {
  if (blockers.length > 0) return "blocked";
  if (enablementGate.state === "stale") return "stale";
  if (enablementGate.state === "conflicting") return "conflicting";
  if (enablementGate.state === "rejected") return "rejected";
  if (missingEvidence.length > 0) return "waiting_for_enablement_gate";
  return "ready_for_runtime_mutation_review";
}

function nextActionsForState(state: TerminalBriefSidecarDefaultOnRuntimeMutationPlanState): string[] {
  if (state === "waiting_for_enablement_gate") {
    return [
      "collect a ready source-only default-on enablement gate",
      "do not write config or enable default-on from incomplete evidence",
    ];
  }
  if (state === "stale") return ["refresh default-on enablement evidence before runtime mutation review"];
  if (state === "conflicting") return ["resolve conflicting default-on enablement evidence before runtime mutation review"];
  if (state === "rejected") return ["do not enable default-on; collect a new approval path only if the operator changes the decision"];
  return ["recover blocked enablement gate before runtime mutation review"];
}

function buildPlanReference(enablementGate: TerminalBriefSidecarDefaultOnEnablementGatePacket): string {
  const base = JSON.stringify({
    enablementGate: enablementGate.idempotencyKey,
    gateReference: enablementGate.enablementGate.gateReference,
    runtimeTarget: enablementGate.enablementGate.runtimeTarget,
  });
  return "tb-sidecar-default-on-runtime-mutation-plan:" + createHash("sha256").update(base).digest("hex").slice(0, 16);
}

function buildIdempotencyKey(
  enablementGate: TerminalBriefSidecarDefaultOnEnablementGatePacket,
  generatedAt: string,
  state: string,
  planReference: string,
): string {
  const base = JSON.stringify({
    label: "terminal-brief-sidecar-default-on-runtime-mutation-plan",
    enablementGate: enablementGate.idempotencyKey,
    generatedAt,
    state,
    planReference,
  });
  return "tb-sidecar-default-on-runtime-mutation-plan:" + createHash("sha256").update(base).digest("hex").slice(0, 24);
}

function isTerminalBriefSidecarDefaultOnEnablementGatePacket(
  value: unknown,
): value is TerminalBriefSidecarDefaultOnEnablementGatePacket {
  return isRecord(value) && value.kind === "a2a-broker.terminal-brief-sidecar-default-on-enablement-gate.packet";
}

