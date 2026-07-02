import assert from "node:assert/strict";
import test from "node:test";

import type { TerminalBriefSidecarDefaultOnEnablementGatePacket } from "./enablement-gate.js";
import {
  buildTerminalBriefSidecarDefaultOnRuntimeMutationPlan,
  extractTerminalBriefSidecarDefaultOnRuntimeMutationPlanEnablementGate,
  extractTerminalBriefSidecarDefaultOnRuntimeMutationPlanOptions,
  renderTerminalBriefSidecarDefaultOnRuntimeMutationPlanMarkdown,
} from "./runtime-mutation-plan.js";

const NOW = "2026-05-19T05:45:00.000Z";

function enablementGate(overrides: Partial<TerminalBriefSidecarDefaultOnEnablementGatePacket> = {}): TerminalBriefSidecarDefaultOnEnablementGatePacket {
  const base = {
    kind: "a2a-broker.terminal-brief-sidecar-default-on-enablement-gate.packet",
    version: 1,
    generatedAt: NOW,
    mode: "fixture-source-only/no-live",
    state: "ready_for_default_on_enablement_review",
    dryRunOnly: false,
    sourceOnlyNoLive: true,
    idempotencyKey: "tb-sidecar-default-on-enablement-gate:fixture-776",
    source: {
      approvalEvidenceKind: "a2a-broker.terminal-brief-sidecar-default-on-approval-evidence-ingestor.packet",
      approvalEvidenceState: "accepted",
      approvalEvidenceIdempotencyKey: "tb-sidecar-default-on-approval-evidence:fixture-774",
      approvalReference: "tb-sidecar-default-on-approval:fixture-772",
      requestedAction: "approve_terminal_brief_default_on_enablement",
      requestedBy: "brokeralpha",
      operatorTarget: "terminal-brief-default-on",
      operatorChannel: "telegram",
      receiptEvidenceAccepted: true,
      approvalEvidenceAccepted: true,
      providerAcceptedIsVisibilityProof: false,
    },
    enablementGate: {
      reviewOnly: true,
      gateReference: "tb-sidecar-default-on-enablement-gate:fixture-776",
      finalizer: "brokeralpha",
      runtimeTarget: "terminal-brief-sidecar",
      operatorInstructionReference: "a2a-broker#774",
      requiredAcceptedEvidence: [],
      preRuntimeChecklist: [],
      abortConditions: [],
      rollbackChecklist: [],
    },
    readiness: {
      sourceCriteriaMet: true,
      enablementGateReady: true,
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
      missingEvidence: [],
      blockers: [],
      nextAction: "broker finalizer may review this gate and request separate runtime mutation approval",
    },
    blockers: [],
    nextActions: [],
    approvalSensitiveActionsExcluded: [],
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
  } as TerminalBriefSidecarDefaultOnEnablementGatePacket;
  return { ...base, ...overrides };
}

test("builds a source-only runtime mutation plan from a ready default-on enablement gate", () => {
  const packet = buildTerminalBriefSidecarDefaultOnRuntimeMutationPlan(enablementGate(), {
    now: NOW,
    finalizer: "brokeralpha",
    runtimeTarget: "terminal-brief-sidecar",
  });

  assert.equal(packet.kind, "a2a-broker.terminal-brief-sidecar-default-on-runtime-mutation-plan.packet");
  assert.equal(packet.state, "ready_for_runtime_mutation_review");
  assert.equal(packet.sourceOnlyNoLive, true);
  assert.equal(packet.readiness.runtimeMutationPlanReady, true);
  assert.equal(packet.runtimeMutationPlan.planOnly, true);
  assert.equal(packet.runtimeMutationPlan.configChange.key, "TERMINAL_BRIEF_SIDECAR_DEFAULT_ON");
  assert.equal(packet.runtimeMutationPlan.configChange.proposedValue, "true");
  assert.equal(packet.runtimeMutationPlan.configChange.applied, false);
  assert.equal(packet.runtimeMutationPlan.executionEnvelope.executable, false);
  assert.equal(packet.source.providerAcceptedIsVisibilityProof, false);
  assert.equal(packet.source.approvalGrantEvidenceExecutesGrant, false);
  assert.equal(packet.readiness.runtimeMutationPermitted, false);
  assert.equal(packet.readiness.configWritePermitted, false);
  assert.equal(packet.readiness.defaultOnPermitted, false);
  assert.equal(packet.readiness.providerSendPermitted, false);
  assert.equal(packet.readiness.terminalAckPermitted, false);
  assert.equal(packet.readiness.dbMutationPermitted, false);
  assert.equal(packet.readiness.taskFlowMutationPermitted, false);
  assert.equal(packet.readiness.executionPermitted, false);
  assert.equal(packet.readiness.processSpawnPermitted, false);
  assert.equal(packet.readiness.sidecarStartPermitted, false);
  assert.equal(packet.readiness.sidecarRestartPermitted, false);
  assert.equal(packet.integrationContract.writesConfig, false);
  assert.equal(packet.integrationContract.enablesDefaultOn, false);
  assert.equal(packet.semantics.planDoesNotWriteConfig, true);
  assert.equal(packet.semantics.planDoesNotEnableDefaultOn, true);
});

test("waits when the enablement gate is not ready", () => {
  const waitingGate = enablementGate({
    state: "waiting_for_accepted_approval_evidence",
    readiness: {
      ...enablementGate().readiness,
      sourceCriteriaMet: false,
      enablementGateReady: false,
    },
  });
  const packet = buildTerminalBriefSidecarDefaultOnRuntimeMutationPlan(waitingGate, { now: NOW });

  assert.equal(packet.state, "waiting_for_enablement_gate");
  assert.equal(packet.readiness.runtimeMutationPlanReady, false);
  assert.equal(packet.readiness.missingEvidence.includes("ready_default_on_enablement_gate"), true);
  assert.equal(packet.readiness.configWritePermitted, false);
});

test("blocks if enablement gate drifts into runtime permission", () => {
  const unsafe = enablementGate();
  unsafe.readiness.defaultOnPermitted = true as never;
  const packet = buildTerminalBriefSidecarDefaultOnRuntimeMutationPlan(unsafe, { now: NOW });

  assert.equal(packet.state, "blocked");
  assert.equal(packet.readiness.defaultOnPermitted, false);
  assert.match(packet.blockers.join("\n"), /unexpectedly permits default-on/);
});

test("extracts enablement gate and options from envelopes", () => {
  const input = {
    defaultOnEnablementGatePacket: enablementGate(),
    defaultOnRuntimeMutationPlan: {
      mode: "fixture",
      finalizer: "brokeralpha",
      planReference: "plan-1",
      runtimeTarget: "sidecar",
      configKey: "TERMINAL_BRIEF_SIDECAR_DEFAULT_ON",
      proposedValue: "true",
    },
  };

  assert.equal(extractTerminalBriefSidecarDefaultOnRuntimeMutationPlanEnablementGate(input).kind, "a2a-broker.terminal-brief-sidecar-default-on-enablement-gate.packet");
  assert.deepEqual(extractTerminalBriefSidecarDefaultOnRuntimeMutationPlanOptions(input), {
    now: undefined,
    mode: "fixture",
    finalizer: "brokeralpha",
    planReference: "plan-1",
    runtimeTarget: "sidecar",
    operatorInstructionReference: undefined,
    configKey: "TERMINAL_BRIEF_SIDECAR_DEFAULT_ON",
    proposedValue: "true",
  });
});

test("renders markdown with config-write boundary", () => {
  const packet = buildTerminalBriefSidecarDefaultOnRuntimeMutationPlan(enablementGate(), { now: NOW });
  const markdown = renderTerminalBriefSidecarDefaultOnRuntimeMutationPlanMarkdown(packet);

  assert.match(markdown, /Ready: Terminal Brief default-on runtime mutation plan/);
  assert.match(markdown, /configWritePermitted=false/);
  assert.match(markdown, /does not write config/);
});
