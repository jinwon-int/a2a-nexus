import assert from "node:assert/strict";
import test from "node:test";

import type { TerminalBriefSidecarDefaultOnApprovalEvidenceIngestorPacket } from "./terminal-brief-sidecar-default-on-approval-evidence-ingestor.js";
import {
  buildTerminalBriefSidecarDefaultOnEnablementGate,
  extractTerminalBriefSidecarDefaultOnEnablementGateApprovalEvidence,
  extractTerminalBriefSidecarDefaultOnEnablementGateOptions,
  renderTerminalBriefSidecarDefaultOnEnablementGateMarkdown,
} from "./terminal-brief-sidecar-default-on-enablement-gate.js";

const NOW = "2026-05-19T05:25:00.000Z";

function approvalEvidence(
  overrides: Partial<TerminalBriefSidecarDefaultOnApprovalEvidenceIngestorPacket> = {},
): TerminalBriefSidecarDefaultOnApprovalEvidenceIngestorPacket {
  const base: TerminalBriefSidecarDefaultOnApprovalEvidenceIngestorPacket = {
    kind: "a2a-broker.terminal-brief-sidecar-default-on-approval-evidence-ingestor.packet",
    version: 1,
    generatedAt: NOW,
    mode: "fixture-source-only/no-live",
    state: "accepted",
    dryRunOnly: false,
    sourceOnlyNoLive: true,
    receiptEvidenceAccepted: true,
    approvalEvidenceAccepted: true,
    idempotencyKey: "tb-sidecar-default-on-approval-evidence:fixture-774",
    source: {
      defaultOnApprovalRequestState: "approval_request_draft_ready",
      defaultOnApprovalRequestIdempotencyKey: "tb-sidecar-default-on-approval-request:fixture-772",
      requestedAction: "approve_terminal_brief_default_on_enablement",
      requestedBy: "brokeralpha",
      operatorTarget: "terminal-brief-default-on",
      operatorChannel: "telegram",
      approvalReference: "tb-sidecar-default-on-approval:fixture-772",
      dispatchRequired: true,
      dispatchPermitted: false,
    },
    evidence: {
      received: 3,
      acceptedKinds: ["current_session_visible", "approval_grant"],
      staleKinds: [],
      conflictingKinds: [],
      rejectedKinds: [],
      records: [],
    },
    classification: {
      providerAccepted: true,
      currentSessionVisible: true,
      manualOperatorConfirmed: false,
      approvalGrantAccepted: true,
      receiptProofAccepted: true,
      rejected: false,
      expired: false,
      stale: false,
      terminalAckEligible: true,
      providerAcceptedIsVisibilityProof: false,
      reason: "operator-visible receipt proof and matching default-on approval grant evidence accepted as source-only evidence",
    },
    readiness: {
      sourceCriteriaMet: true,
      receiptEvidenceAccepted: true,
      approvalEvidenceAccepted: true,
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
      blockers: [
        "approval grant evidence does not grant approval in this ingestor",
        "default-on approval evidence still requires a separate runtime mutation gate",
      ],
      nextAction: "feed accepted no-live default-on approval evidence into a separate default-on enablement gate",
    },
    blockers: [],
    nextActions: [],
    approvalSensitiveActionsExcluded: [],
    integrationContract: {
      transport: "json",
      evidenceSchemaVersion: 1,
      harnessNeutral: true,
      openclawMessageSendRequired: false,
      hermesAdapterCompatible: true,
      mobilealphaAdapterCompatible: true,
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
  return { ...base, ...overrides };
}

test("builds a source-only enablement gate from accepted default-on approval evidence", () => {
  const packet = buildTerminalBriefSidecarDefaultOnEnablementGate(approvalEvidence(), {
    now: NOW,
    finalizer: "brokeralpha",
    runtimeTarget: "terminal-brief-sidecar",
  });

  assert.equal(packet.kind, "a2a-broker.terminal-brief-sidecar-default-on-enablement-gate.packet");
  assert.equal(packet.state, "ready_for_default_on_enablement_review");
  assert.equal(packet.sourceOnlyNoLive, true);
  assert.equal(packet.readiness.enablementGateReady, true);
  assert.equal(packet.source.receiptEvidenceAccepted, true);
  assert.equal(packet.source.approvalEvidenceAccepted, true);
  assert.equal(packet.source.providerAcceptedIsVisibilityProof, false);
  assert.equal(packet.readiness.approvalRequestDispatchPermitted, false);
  assert.equal(packet.readiness.approvalGrantPermitted, false);
  assert.equal(packet.readiness.defaultOnPermitted, false);
  assert.equal(packet.readiness.providerSendPermitted, false);
  assert.equal(packet.readiness.terminalAckPermitted, false);
  assert.equal(packet.readiness.dbMutationPermitted, false);
  assert.equal(packet.readiness.executionPermitted, false);
  assert.equal(packet.readiness.processSpawnPermitted, false);
  assert.equal(packet.readiness.sidecarStartPermitted, false);
  assert.equal(packet.integrationContract.enablesDefaultOn, false);
  assert.equal(packet.integrationContract.approvalGrantEvidenceExecutesGrant, false);
  assert.equal(packet.semantics.gateDoesNotEnableDefaultOn, true);
  assert.equal(packet.semantics.approvalEvidenceDoesNotExecuteGrant, true);
});

test("waits when default-on approval evidence is insufficient", () => {
  const insufficient = approvalEvidence({
    state: "insufficient",
    receiptEvidenceAccepted: false,
    approvalEvidenceAccepted: false,
    classification: {
      ...approvalEvidence().classification,
      receiptProofAccepted: false,
      approvalGrantAccepted: false,
    },
  });
  const packet = buildTerminalBriefSidecarDefaultOnEnablementGate(insufficient, { now: NOW });

  assert.equal(packet.state, "waiting_for_accepted_approval_evidence");
  assert.equal(packet.readiness.enablementGateReady, false);
  assert.equal(packet.readiness.missingEvidence.includes("accepted_default_on_approval_evidence"), true);
  assert.equal(packet.readiness.defaultOnPermitted, false);
});

test("blocks if approval evidence drifts into runtime permission", () => {
  const unsafe = approvalEvidence();
  unsafe.readiness.defaultOnPermitted = true as never;
  const packet = buildTerminalBriefSidecarDefaultOnEnablementGate(unsafe, { now: NOW });

  assert.equal(packet.state, "blocked");
  assert.equal(packet.readiness.defaultOnPermitted, false);
  assert.match(packet.blockers.join("\n"), /unexpectedly permits default-on/);
});

test("extracts approval evidence and options from envelopes", () => {
  const input = {
    defaultOnApprovalEvidenceIngestorPacket: approvalEvidence(),
    defaultOnEnablementGate: {
      mode: "fixture",
      finalizer: "brokeralpha",
      gateReference: "gate-1",
      runtimeTarget: "sidecar",
    },
  };

  assert.equal(extractTerminalBriefSidecarDefaultOnEnablementGateApprovalEvidence(input).kind, "a2a-broker.terminal-brief-sidecar-default-on-approval-evidence-ingestor.packet");
  assert.deepEqual(extractTerminalBriefSidecarDefaultOnEnablementGateOptions(input), {
    now: undefined,
    mode: "fixture",
    finalizer: "brokeralpha",
    gateReference: "gate-1",
    runtimeTarget: "sidecar",
    operatorInstructionReference: undefined,
  });
});

test("renders markdown with runtime mutation boundary", () => {
  const packet = buildTerminalBriefSidecarDefaultOnEnablementGate(approvalEvidence(), { now: NOW });
  const markdown = renderTerminalBriefSidecarDefaultOnEnablementGateMarkdown(packet);

  assert.match(markdown, /Ready: Terminal Brief default-on enablement gate/);
  assert.match(markdown, /defaultOnPermitted=false/);
  assert.match(markdown, /does not enable default-on/);
});
