import { unique } from "../collections.js";
import { isRecord } from "../value-guards.js";
import { createHash } from "node:crypto";

import type { TerminalBriefSidecarDefaultOnRuntimeMutationPlanPacket } from "./runtime-mutation-plan.js";
import { optionalString } from "../value-text.js";

export type TerminalBriefSidecarDefaultOnExecutionRollbackEnvelopeState =
  | "ready_for_execution_approval_review"
  | "waiting_for_runtime_mutation_plan"
  | "stale"
  | "conflicting"
  | "rejected"
  | "blocked";

export interface TerminalBriefSidecarDefaultOnExecutionRollbackEnvelopeOptions {
  now?: string;
  mode?: string;
  finalizer?: string;
  finalizer_id?: string;
  envelopeReference?: string;
  envelope_reference?: string;
  operatorInstructionReference?: string;
  operator_instruction_reference?: string;
  executorId?: string;
  executor_id?: string;
}

export interface TerminalBriefSidecarDefaultOnExecutionRollbackEnvelopePacket {
  kind: "a2a-broker.terminal-brief-sidecar-default-on-execution-rollback-envelope.packet";
  version: 1;
  generatedAt: string;
  mode: string;
  state: TerminalBriefSidecarDefaultOnExecutionRollbackEnvelopeState;
  dryRunOnly: false;
  sourceOnlyNoLive: true;
  idempotencyKey: string;
  source: {
    runtimeMutationPlanKind: TerminalBriefSidecarDefaultOnRuntimeMutationPlanPacket["kind"];
    runtimeMutationPlanState: TerminalBriefSidecarDefaultOnRuntimeMutationPlanPacket["state"];
    runtimeMutationPlanIdempotencyKey: string;
    planReference: string;
    gateReference: string;
    approvalReference: string;
    runtimeTarget: string;
    configKey: string;
    proposedValue: string;
    configChangeApplied: false;
    executionEnvelopeExecutable: false;
    providerAcceptedIsVisibilityProof: false;
    approvalGrantEvidenceExecutesGrant: false;
  };
  executionRollbackEnvelope: {
    envelopeOnly: true;
    envelopeReference: string;
    finalizer: string;
    executorId: string;
    runtimeTarget: string;
    operatorInstructionReference?: string;
    executionPlan: {
      commandTemplateIncluded: false;
      commandExecutable: false;
      configWriteStepIncluded: true;
      sidecarRestartStepIncluded: true;
      brokerRestartStepIncluded: false;
      envKeyNamesOnly: string[];
      envValuesIncluded: false;
      secretValuesIncluded: false;
      dryRunCheckRequired: true;
    };
    rollbackPlan: {
      rollbackTemplateIncluded: false;
      rollbackExecutable: false;
      disablesDefaultOn: true;
      restartScope: "sidecar-only-after-separate-approval";
      preservesTerminalRows: true;
      requiresFreshApproval: true;
    };
    preExecutionChecklist: string[];
    abortConditions: string[];
  };
  readiness: {
    sourceCriteriaMet: boolean;
    executionEnvelopeReady: boolean;
    executionApprovalRequestPermitted: false;
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
    executionRollbackEnvelopeVersion: 1;
    consumesRuntimeMutationPlanPacket: true;
    rendersExecutionRollbackEnvelope: true;
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
    executionRollbackEnvelopeOnly: true;
    sourceOnlyNoLive: true;
    runtimeMutationPlanIsInputOnly: true;
    envelopeDoesNotExecute: true;
    envelopeDoesNotWriteConfig: true;
    envelopeDoesNotEnableDefaultOn: true;
    envelopeDoesNotRestartSidecar: true;
    envelopeDoesNotSendProviders: true;
    envelopeDoesNotAckTerminalRows: true;
    envelopeDoesNotMutateDb: true;
    envelopeDoesNotMutateTaskFlow: true;
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

export function buildTerminalBriefSidecarDefaultOnExecutionRollbackEnvelope(
  plan: TerminalBriefSidecarDefaultOnRuntimeMutationPlanPacket,
  options: TerminalBriefSidecarDefaultOnExecutionRollbackEnvelopeOptions = {},
): TerminalBriefSidecarDefaultOnExecutionRollbackEnvelopePacket {
  const generatedAt = options.now ?? new Date().toISOString();
  const blockers = buildBlockers(plan);
  const missingEvidence = missingEvidenceFor(plan);
  const state = stateFor(plan, blockers, missingEvidence);
  const ready = state === "ready_for_execution_approval_review";
  const envelopeReference = optionalString(options.envelopeReference ?? options.envelope_reference) ?? buildEnvelopeReference(plan);
  const finalizer = optionalString(options.finalizer ?? options.finalizer_id) ?? plan.runtimeMutationPlan.finalizer;
  const executorId = optionalString(options.executorId ?? options.executor_id) ?? "terminal-brief-default-on-runtime-executor";
  const operatorInstructionReference = optionalString(options.operatorInstructionReference ?? options.operator_instruction_reference);

  return {
    kind: "a2a-broker.terminal-brief-sidecar-default-on-execution-rollback-envelope.packet",
    version: 1,
    generatedAt,
    mode: options.mode ?? "terminal-brief-default-on-execution-rollback-envelope-source-only",
    state,
    dryRunOnly: false,
    sourceOnlyNoLive: true,
    idempotencyKey: buildIdempotencyKey(plan, generatedAt, state, envelopeReference),
    source: {
      runtimeMutationPlanKind: plan.kind,
      runtimeMutationPlanState: plan.state,
      runtimeMutationPlanIdempotencyKey: plan.idempotencyKey,
      planReference: plan.runtimeMutationPlan.planReference,
      gateReference: plan.source.gateReference,
      approvalReference: plan.source.approvalReference,
      runtimeTarget: plan.runtimeMutationPlan.runtimeTarget,
      configKey: plan.runtimeMutationPlan.configChange.key,
      proposedValue: plan.runtimeMutationPlan.configChange.proposedValue,
      configChangeApplied: false,
      executionEnvelopeExecutable: false,
      providerAcceptedIsVisibilityProof: false,
      approvalGrantEvidenceExecutesGrant: false,
    },
    executionRollbackEnvelope: {
      envelopeOnly: true,
      envelopeReference,
      finalizer,
      executorId,
      runtimeTarget: plan.runtimeMutationPlan.runtimeTarget,
      operatorInstructionReference,
      executionPlan: {
        commandTemplateIncluded: false,
        commandExecutable: false,
        configWriteStepIncluded: true,
        sidecarRestartStepIncluded: true,
        brokerRestartStepIncluded: false,
        envKeyNamesOnly: [plan.runtimeMutationPlan.configChange.key],
        envValuesIncluded: false,
        secretValuesIncluded: false,
        dryRunCheckRequired: true,
      },
      rollbackPlan: {
        rollbackTemplateIncluded: false,
        rollbackExecutable: false,
        disablesDefaultOn: true,
        restartScope: "sidecar-only-after-separate-approval",
        preservesTerminalRows: true,
        requiresFreshApproval: true,
      },
      preExecutionChecklist: [
        "obtain fresh explicit operator approval for executing this envelope",
        "verify both brokers and the sidecar are on the expected revision",
        "verify rollback path before any later config write",
        "verify terminal rows remain unacknowledged/replayable before any later live send path",
      ],
      abortConditions: [
        "runtime mutation plan is stale, conflicting, rejected, blocked, or not ready",
        "any source packet permits config write/default-on/provider send/terminal ACK/DB mutation",
        "operator approval is ambiguous, stale, or not tied to this exact envelope",
        "broker or sidecar health is degraded before the later execution step",
      ],
    },
    readiness: {
      sourceCriteriaMet: ready,
      executionEnvelopeReady: ready,
      executionApprovalRequestPermitted: false,
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
        "execution/rollback envelope is source-only and does not execute or write config",
        "actual default-on execution requires later explicit runtime approval",
      ],
      nextAction: ready
        ? "broker finalizer may review this envelope and request separate execution approval"
        : "collect a ready runtime mutation plan before execution envelope review",
    },
    blockers,
    nextActions: ready
      ? [
        "review the source-only execution/rollback envelope",
        "request a separate explicit approval before any config write or sidecar restart",
        "do not execute this envelope from the packet",
      ]
      : nextActionsForState(state),
    approvalSensitiveActionsExcluded: [
      "sending execution approval requests",
      "granting approval or executing an approval grant",
      "writing config or enabling Terminal Brief default-on",
      "live provider/Hermes/mobilealpha/Telegram/OpenClaw send",
      "terminal ACK/replay or terminal receipt DB mutation",
      "process spawn, sidecar start/stop/restart, broker restart, or deploy",
      "GitHub mutation from the packet/route",
      "TaskFlow/broker DB mutation",
      "historical replay, release, publish, or secret movement",
    ],
    integrationContract: {
      transport: "json",
      executionRollbackEnvelopeVersion: 1,
      consumesRuntimeMutationPlanPacket: true,
      rendersExecutionRollbackEnvelope: true,
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
      executionRollbackEnvelopeOnly: true,
      sourceOnlyNoLive: true,
      runtimeMutationPlanIsInputOnly: true,
      envelopeDoesNotExecute: true,
      envelopeDoesNotWriteConfig: true,
      envelopeDoesNotEnableDefaultOn: true,
      envelopeDoesNotRestartSidecar: true,
      envelopeDoesNotSendProviders: true,
      envelopeDoesNotAckTerminalRows: true,
      envelopeDoesNotMutateDb: true,
      envelopeDoesNotMutateTaskFlow: true,
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

export function extractTerminalBriefSidecarDefaultOnExecutionRollbackEnvelopePlan(
  input: unknown,
): TerminalBriefSidecarDefaultOnRuntimeMutationPlanPacket {
  const envelope = isRecord(input) ? input : {};
  const candidates = [
    input,
    envelope.defaultOnRuntimeMutationPlan,
    envelope.defaultOnRuntimeMutationPlanPacket,
    envelope.runtimeMutationPlan,
    envelope.runtimeMutationPlanPacket,
    envelope.packet,
  ];
  const packet = candidates.find(isTerminalBriefSidecarDefaultOnRuntimeMutationPlanPacket);
  if (!packet) {
    throw new Error("expected a Terminal Brief sidecar default-on runtime mutation plan packet");
  }
  return packet;
}

export function extractTerminalBriefSidecarDefaultOnExecutionRollbackEnvelopeOptions(
  input: unknown,
): TerminalBriefSidecarDefaultOnExecutionRollbackEnvelopeOptions {
  const envelope = isRecord(input) ? input : {};
  const options = isRecord(envelope.defaultOnExecutionRollbackEnvelope)
    ? envelope.defaultOnExecutionRollbackEnvelope
    : isRecord(envelope.executionRollbackEnvelope)
      ? envelope.executionRollbackEnvelope
      : isRecord(envelope.options)
        ? envelope.options
        : {};
  return {
    now: optionalString(options.now),
    mode: optionalString(options.mode),
    finalizer: optionalString(options.finalizer ?? options.finalizer_id),
    envelopeReference: optionalString(options.envelopeReference ?? options.envelope_reference),
    operatorInstructionReference: optionalString(options.operatorInstructionReference ?? options.operator_instruction_reference),
    executorId: optionalString(options.executorId ?? options.executor_id),
  };
}

export function renderTerminalBriefSidecarDefaultOnExecutionRollbackEnvelopeMarkdown(
  packet: TerminalBriefSidecarDefaultOnExecutionRollbackEnvelopePacket,
): string {
  return [
    packet.state === "ready_for_execution_approval_review"
      ? "Ready: Terminal Brief default-on execution/rollback envelope"
      : "Blocked: Terminal Brief default-on execution/rollback envelope",
    "Mode: " + packet.mode,
    "State: " + packet.state + " sourceOnlyNoLive=" + packet.sourceOnlyNoLive,
    "Idempotency: " + packet.idempotencyKey,
    "Source plan: state=" + packet.source.runtimeMutationPlanState
      + " configChangeApplied=" + packet.source.configChangeApplied
      + " executionEnvelopeExecutable=" + packet.source.executionEnvelopeExecutable,
    "Envelope: reference=" + packet.executionRollbackEnvelope.envelopeReference
      + " finalizer=" + packet.executionRollbackEnvelope.finalizer
      + " executorId=" + packet.executionRollbackEnvelope.executorId
      + " runtimeTarget=" + packet.executionRollbackEnvelope.runtimeTarget,
    "Readiness: executionEnvelopeReady=" + packet.readiness.executionEnvelopeReady
      + " runtimeMutationPermitted=" + packet.readiness.runtimeMutationPermitted
      + " configWritePermitted=" + packet.readiness.configWritePermitted
      + " defaultOnPermitted=" + packet.readiness.defaultOnPermitted
      + " sidecarRestartPermitted=" + packet.readiness.sidecarRestartPermitted,
    ...(packet.readiness.missingEvidence.length ? ["Missing evidence:", ...packet.readiness.missingEvidence.map((item) => "- " + item)] : []),
    ...(packet.blockers.length ? ["", "Blockers:", ...packet.blockers.map((blocker) => "- " + blocker)] : []),
    "",
    "Pre-execution checklist:",
    ...packet.executionRollbackEnvelope.preExecutionChecklist.map((item) => "- " + item),
    "",
    "Next actions:",
    ...packet.nextActions.map((action) => "- " + action),
    "",
    "Safety: execution/rollback envelope only; does not execute, write config, enable default-on, send providers, ACK/replay terminal rows, mutate DB/TaskFlow/GitHub state, spawn processes, restart/deploy sidecar or broker, release, publish, or move secrets.",
  ].join("\n");
}

function buildBlockers(plan: TerminalBriefSidecarDefaultOnRuntimeMutationPlanPacket): string[] {
  return unique([
    ...plan.blockers,
    ...(plan.state === "blocked" ? ["runtime mutation plan is blocked"] : []),
    ...(plan.state === "conflicting" ? ["runtime mutation plan is conflicting"] : []),
    ...(plan.state === "rejected" ? ["runtime mutation plan is rejected"] : []),
    ...(plan.state === "stale" ? ["runtime mutation plan is stale"] : []),
    ...(plan.source.providerAcceptedIsVisibilityProof !== false ? ["runtime mutation plan unexpectedly treats provider accepted as visibility proof"] : []),
    ...(plan.source.approvalGrantEvidenceExecutesGrant !== false ? ["runtime mutation plan unexpectedly executes approval grant evidence"] : []),
    ...(plan.runtimeMutationPlan.configChange.applied !== false ? ["runtime mutation plan unexpectedly applied config change"] : []),
    ...(plan.runtimeMutationPlan.executionEnvelope.executable !== false ? ["runtime mutation plan unexpectedly exposes executable envelope"] : []),
    ...(plan.readiness.runtimeMutationPermitted !== false ? ["runtime mutation plan unexpectedly permits runtime mutation"] : []),
    ...(plan.readiness.configWritePermitted !== false ? ["runtime mutation plan unexpectedly permits config write"] : []),
    ...(plan.readiness.defaultOnPermitted !== false ? ["runtime mutation plan unexpectedly permits default-on"] : []),
    ...(plan.readiness.liveActivationPermitted !== false ? ["runtime mutation plan unexpectedly permits live activation"] : []),
    ...(plan.readiness.providerSendPermitted !== false ? ["runtime mutation plan unexpectedly permits provider send"] : []),
    ...(plan.readiness.terminalAckPermitted !== false ? ["runtime mutation plan unexpectedly permits terminal ACK"] : []),
    ...(plan.readiness.dbMutationPermitted !== false ? ["runtime mutation plan unexpectedly permits DB mutation"] : []),
    ...(plan.readiness.taskFlowMutationPermitted !== false ? ["runtime mutation plan unexpectedly permits TaskFlow mutation"] : []),
    ...(plan.readiness.executionPermitted !== false ? ["runtime mutation plan unexpectedly permits execution"] : []),
    ...(plan.readiness.processSpawnPermitted !== false ? ["runtime mutation plan unexpectedly permits process spawn"] : []),
    ...(plan.readiness.sidecarStartPermitted !== false ? ["runtime mutation plan unexpectedly permits sidecar start"] : []),
    ...(plan.readiness.sidecarRestartPermitted !== false ? ["runtime mutation plan unexpectedly permits sidecar restart"] : []),
    ...(plan.readiness.brokerRestartPermitted !== false ? ["runtime mutation plan unexpectedly permits broker restart"] : []),
    ...(plan.integrationContract.writesConfig ? ["runtime mutation plan unexpectedly writes config"] : []),
    ...(plan.integrationContract.enablesDefaultOn ? ["runtime mutation plan unexpectedly enables default-on"] : []),
    ...(plan.integrationContract.sendsProvider ? ["runtime mutation plan unexpectedly sends provider"] : []),
    ...(plan.integrationContract.performsTerminalAck ? ["runtime mutation plan unexpectedly performs terminal ACK"] : []),
    ...(plan.integrationContract.mutatesDb ? ["runtime mutation plan unexpectedly mutates DB"] : []),
    ...(plan.integrationContract.mutatesTaskFlow ? ["runtime mutation plan unexpectedly mutates TaskFlow"] : []),
    ...(plan.integrationContract.spawnsProcess ? ["runtime mutation plan unexpectedly spawns process"] : []),
    ...(plan.integrationContract.startsSidecar ? ["runtime mutation plan unexpectedly starts sidecar"] : []),
    ...(plan.integrationContract.restartsSidecar ? ["runtime mutation plan unexpectedly restarts sidecar"] : []),
    ...(plan.integrationContract.restartsBroker ? ["runtime mutation plan unexpectedly restarts broker"] : []),
    ...(plan.integrationContract.executesAction ? ["runtime mutation plan unexpectedly executes action"] : []),
    ...(plan.semantics.planDoesNotWriteConfig !== true ? ["runtime mutation plan does not preserve config write boundary"] : []),
    ...(plan.semantics.planDoesNotEnableDefaultOn !== true ? ["runtime mutation plan does not preserve default-on boundary"] : []),
    ...(plan.semantics.performsProviderSend ? ["runtime mutation plan unexpectedly performs provider send"] : []),
    ...(plan.semantics.performsTerminalAck ? ["runtime mutation plan unexpectedly performs terminal ACK"] : []),
    ...(plan.semantics.performsRuntimeRestartOrDeploy ? ["runtime mutation plan unexpectedly performs restart/deploy"] : []),
    ...(plan.semantics.performsDbMutation ? ["runtime mutation plan unexpectedly performs DB mutation"] : []),
    ...(plan.semantics.createsTaskFlowRecords ? ["runtime mutation plan unexpectedly creates TaskFlow records"] : []),
    ...(plan.semantics.performsHistoricalReplay ? ["runtime mutation plan unexpectedly performs historical replay"] : []),
    ...(plan.semantics.performsReleaseOrPublish ? ["runtime mutation plan unexpectedly performs release/publish"] : []),
    ...(plan.semantics.movesSecretsOrCredentials ? ["runtime mutation plan unexpectedly moves secrets/credentials"] : []),
  ].filter(Boolean));
}

function missingEvidenceFor(plan: TerminalBriefSidecarDefaultOnRuntimeMutationPlanPacket): string[] {
  const missing: string[] = [];
  if (plan.state !== "ready_for_runtime_mutation_review") missing.push("ready_runtime_mutation_plan");
  if (!plan.readiness.runtimeMutationPlanReady) missing.push("runtime_mutation_plan_ready");
  if (!plan.readiness.sourceCriteriaMet) missing.push("runtime_mutation_plan_source_criteria");
  if (plan.runtimeMutationPlan.configChange.applied !== false) missing.push("unapplied_config_change_metadata");
  if (plan.runtimeMutationPlan.executionEnvelope.executable !== false) missing.push("non_executable_execution_envelope");
  return unique(missing);
}

function stateFor(
  plan: TerminalBriefSidecarDefaultOnRuntimeMutationPlanPacket,
  blockers: string[],
  missingEvidence: string[],
): TerminalBriefSidecarDefaultOnExecutionRollbackEnvelopeState {
  if (blockers.length > 0) return "blocked";
  if (plan.state === "stale") return "stale";
  if (plan.state === "conflicting") return "conflicting";
  if (plan.state === "rejected") return "rejected";
  if (missingEvidence.length > 0) return "waiting_for_runtime_mutation_plan";
  return "ready_for_execution_approval_review";
}

function nextActionsForState(state: TerminalBriefSidecarDefaultOnExecutionRollbackEnvelopeState): string[] {
  if (state === "waiting_for_runtime_mutation_plan") {
    return [
      "collect a ready source-only runtime mutation plan",
      "do not execute or write config from incomplete evidence",
    ];
  }
  if (state === "stale") return ["refresh runtime mutation plan before execution envelope review"];
  if (state === "conflicting") return ["resolve conflicting runtime mutation plan evidence before execution envelope review"];
  if (state === "rejected") return ["do not enable default-on; collect a new approval path only if the operator changes the decision"];
  return ["recover blocked runtime mutation plan before execution envelope review"];
}

function buildEnvelopeReference(plan: TerminalBriefSidecarDefaultOnRuntimeMutationPlanPacket): string {
  const base = JSON.stringify({
    runtimeMutationPlan: plan.idempotencyKey,
    planReference: plan.runtimeMutationPlan.planReference,
    runtimeTarget: plan.runtimeMutationPlan.runtimeTarget,
  });
  return "tb-sidecar-default-on-execution-rollback-envelope:" + createHash("sha256").update(base).digest("hex").slice(0, 16);
}

function buildIdempotencyKey(
  plan: TerminalBriefSidecarDefaultOnRuntimeMutationPlanPacket,
  generatedAt: string,
  state: string,
  envelopeReference: string,
): string {
  const base = JSON.stringify({
    label: "terminal-brief-sidecar-default-on-execution-rollback-envelope",
    runtimeMutationPlan: plan.idempotencyKey,
    generatedAt,
    state,
    envelopeReference,
  });
  return "tb-sidecar-default-on-execution-rollback-envelope:" + createHash("sha256").update(base).digest("hex").slice(0, 24);
}

function isTerminalBriefSidecarDefaultOnRuntimeMutationPlanPacket(
  value: unknown,
): value is TerminalBriefSidecarDefaultOnRuntimeMutationPlanPacket {
  return isRecord(value) && value.kind === "a2a-broker.terminal-brief-sidecar-default-on-runtime-mutation-plan.packet";
}

