import assert from "node:assert/strict";
import test from "node:test";

import type { TerminalBriefSidecarDefaultOnCandidateFinalGatePacket } from "./terminal-brief-sidecar-default-on-candidate-final-gate.js";
import {
  buildTerminalBriefSidecarDefaultOnApprovalRequest,
  extractTerminalBriefSidecarDefaultOnApprovalRequestFinalGate,
  extractTerminalBriefSidecarDefaultOnApprovalRequestOptions,
  renderTerminalBriefSidecarDefaultOnApprovalRequestMarkdown,
} from "./terminal-brief-sidecar-default-on-approval-request.js";

const NOW = "2026-05-19T03:56:00.000Z";

function finalGate(overrides: Partial<TerminalBriefSidecarDefaultOnCandidateFinalGatePacket> = {}): TerminalBriefSidecarDefaultOnCandidateFinalGatePacket {
  const base = {
    kind: "a2a-broker.terminal-brief-sidecar-default-on-candidate-final-gate.packet",
    version: 1,
    generatedAt: NOW,
    mode: "terminal-brief-default-on-candidate-source-only",
    state: "ready_for_default_on_candidate_review",
    dryRunOnly: true,
    sourceOnlyNoLive: true,
    idempotencyKey: "tb-sidecar-default-on-candidate-final-gate:fixture",
    source: {
      observationKind: "brokeralpha.terminal-brief-sidecar-bounded-dry-run-observation",
      observationState: "bounded_dry_run_observation_passed",
      observationGeneratedAt: NOW,
      operatorInstructionReference: "telegram:1000000001:53345",
      windowSeconds: 300,
      minObservationSeconds: 300,
    },
    candidateGate: {
      reviewOnly: true,
      defaultOnCandidate: true,
      defaultOnEnabled: false,
      reviewOwner: "broker-finalizer",
      gateReference: "tb-sidecar-default-on-candidate:fixture",
      checklist: [],
      abortConditions: [],
      rollbackChecklist: [],
    },
    readiness: {
      sourceCriteriaMet: true,
      finalGateReady: true,
      defaultOnPermitted: false,
      liveActivationPermitted: false,
      providerSendPermitted: false,
      terminalAckPermitted: false,
      executionPermitted: false,
      dbMutationPermitted: false,
      processSpawnPermitted: false,
      sidecarStartPermitted: false,
      missingEvidence: [],
      blockers: [],
      nextAction: "review the default-on candidate gate",
    },
    blockers: [],
    nextActions: [],
    approvalSensitiveActionsExcluded: [],
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
  } satisfies TerminalBriefSidecarDefaultOnCandidateFinalGatePacket;
  return { ...base, ...overrides } as TerminalBriefSidecarDefaultOnCandidateFinalGatePacket;
}

test("default-on approval request draft becomes ready without sending or enabling default-on", () => {
  const packet = buildTerminalBriefSidecarDefaultOnApprovalRequest(finalGate(), {
    now: NOW,
    requestedBy: "broker-finalizer",
    operatorTarget: "operator-a",
    operatorChannel: "telegram:1000000001",
  });

  assert.equal(packet.kind, "a2a-broker.terminal-brief-sidecar-default-on-approval-request.packet");
  assert.equal(packet.state, "approval_request_draft_ready");
  assert.equal(packet.approvalRequestDraft.status, "draft_not_sent");
  assert.equal(packet.approvalRequestDraft.requestedAction, "approve_terminal_brief_default_on_enablement");
  assert.equal(packet.approvalRequestDraft.requiredReply, "default-on 승인");
  assert.equal(packet.readiness.approvalRequestDraftReady, true);
  assert.equal(packet.readiness.approvalRequestDispatchPermitted, false);
  assert.equal(packet.readiness.approvalGrantPermitted, false);
  assert.equal(packet.readiness.defaultOnPermitted, false);
  assert.equal(packet.readiness.providerSendPermitted, false);
  assert.equal(packet.readiness.terminalAckPermitted, false);
  assert.equal(packet.readiness.dbMutationPermitted, false);
  assert.equal(packet.integrationContract.sendsApprovalRequest, false);
  assert.equal(packet.integrationContract.enablesDefaultOn, false);
  assert.equal(packet.integrationContract.sendsProvider, false);
  assert.equal(packet.integrationContract.performsTerminalAck, false);
  assert.equal(packet.integrationContract.mutatesDb, false);
  assert.equal(packet.semantics.requestDoesNotEnableDefaultOn, true);
  assert.equal(packet.semantics.requestDoesNotSendProviders, true);
});

test("default-on approval request blocks unsafe final gate", () => {
  const packet = buildTerminalBriefSidecarDefaultOnApprovalRequest(finalGate({
    readiness: {
      ...finalGate().readiness,
      defaultOnPermitted: true as false,
    },
  }), { now: NOW });

  assert.equal(packet.state, "blocked");
  assert.equal(packet.readiness.approvalRequestDraftReady, false);
  assert.equal(packet.blockers.includes("final gate unexpectedly permits default-on"), true);
  assert.equal(packet.readiness.defaultOnPermitted, false);
});

test("default-on approval request waits for non-ready final gate", () => {
  const packet = buildTerminalBriefSidecarDefaultOnApprovalRequest(finalGate({
    state: "blocked",
    readiness: {
      ...finalGate().readiness,
      finalGateReady: false,
    },
    blockers: ["spool delta is not zero"],
  }), { now: NOW });

  assert.equal(packet.state, "waiting_for_default_on_candidate_final_gate");
  assert.equal(packet.readiness.missingEvidence.includes("ready_default_on_candidate_final_gate"), true);
  assert.equal(packet.readiness.defaultOnPermitted, false);
});

test("default-on approval request extracts final gate and options from envelopes", () => {
  const input = {
    finalGatePacket: finalGate(),
    defaultOnApprovalRequest: {
      mode: "review",
      operatorTarget: "operator-a",
      approvalReference: "approval-1",
    },
  };

  assert.equal(extractTerminalBriefSidecarDefaultOnApprovalRequestFinalGate(input).kind, "a2a-broker.terminal-brief-sidecar-default-on-candidate-final-gate.packet");
  assert.deepEqual(extractTerminalBriefSidecarDefaultOnApprovalRequestOptions(input), input.defaultOnApprovalRequest);
});

test("default-on approval request markdown includes required reply and safety boundary", () => {
  const packet = buildTerminalBriefSidecarDefaultOnApprovalRequest(finalGate(), { now: NOW });
  const markdown = renderTerminalBriefSidecarDefaultOnApprovalRequestMarkdown(packet);

  assert.match(markdown, /Ready: Terminal Brief default-on approval request draft/);
  assert.match(markdown, /Required reply: default-on 승인/);
  assert.match(markdown, /does not send request, grant approval, enable default-on/);
});
