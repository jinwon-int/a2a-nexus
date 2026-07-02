import assert from "node:assert/strict";
import test from "node:test";

import type { TerminalBriefSidecarDefaultOnApprovalRequestPacket } from "./approval-request.js";
import {
  buildTerminalBriefSidecarDefaultOnApprovalEvidenceIngestor,
  extractTerminalBriefSidecarDefaultOnApprovalEvidence,
  extractTerminalBriefSidecarDefaultOnApprovalEvidenceIngestorOptions,
  extractTerminalBriefSidecarDefaultOnApprovalRequestPacket,
  renderTerminalBriefSidecarDefaultOnApprovalEvidenceIngestorMarkdown,
} from "./approval-evidence-ingestor.js";

const NOW = "2026-05-19T03:15:00.000Z";

function approvalRequest(
  overrides: Partial<TerminalBriefSidecarDefaultOnApprovalRequestPacket> = {},
): TerminalBriefSidecarDefaultOnApprovalRequestPacket {
  const base: TerminalBriefSidecarDefaultOnApprovalRequestPacket = {
    kind: "a2a-broker.terminal-brief-sidecar-default-on-approval-request.packet",
    version: 1,
    generatedAt: NOW,
    mode: "terminal-brief-default-on-approval-request-source-only",
    state: "approval_request_draft_ready",
    dryRunOnly: false,
    sourceOnlyNoLive: true,
    idempotencyKey: "tb-sidecar-default-on-approval-request:fixture-772",
    source: {
      finalGateState: "ready_for_default_on_candidate_review",
      finalGateIdempotencyKey: "tb-sidecar-default-on-final-gate:fixture-769",
      finalGateReady: true,
      gateReference: "default-on-gate-769",
      observationState: "bounded_observation_complete",
      operatorInstructionReference: "a2a-broker#772",
    },
    approvalRequestDraft: {
      draftOnly: true,
      status: "draft_not_sent",
      requestedAction: "approve_terminal_brief_default_on_enablement",
      requestedBy: "brokeralpha",
      operatorTarget: "terminal-brief-default-on",
      operatorChannel: "telegram",
      approvalReference: "tb-sidecar-default-on-approval:fixture-772",
      approvalExpiresAt: "2026-05-19T03:35:00.000Z",
      dispatchRequired: true,
      dispatchPermitted: false,
      approvalGrantPermitted: false,
      defaultOnPermitted: false,
      liveActivationPermitted: false,
      providerSendPermitted: false,
      terminalAckPermitted: false,
      dbMutationPermitted: false,
      executionPermitted: false,
      transcriptDraft: "Terminal Brief default-on approval request.",
      requiredReply: "default-on 승인",
    },
    readiness: {
      sourceCriteriaMet: true,
      approvalRequestDraftReady: true,
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
      blockers: [
        "approval request draft is not a provider send or approval grant",
        "default-on, live send, terminal ACK, and DB mutation require later separate approved paths",
      ],
      nextAction: "send this draft only after operator chooses a delivery path, then ingest explicit default-on approval evidence",
    },
    blockers: [],
    nextActions: [],
    approvalSensitiveActionsExcluded: [],
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
  return { ...base, ...overrides };
}

const acceptedEvidence = [
  { kind: "provider_accepted", observedAt: NOW, providerMessageId: "provider-772", target: "terminal-brief-default-on" },
  { kind: "current_session_visible", observedAt: NOW, receiptId: "visible-772", target: "terminal-brief-default-on" },
  {
    kind: "approval_grant",
    observedAt: NOW,
    approvedAction: "approve_terminal_brief_default_on_enablement",
    approvedTarget: "terminal-brief-default-on",
    operatorId: "operator-a",
  },
];

test("accepts visibility/manual receipt plus matching default-on approval grant as no-live evidence only", () => {
  const packet = buildTerminalBriefSidecarDefaultOnApprovalEvidenceIngestor(approvalRequest(), acceptedEvidence, { now: NOW });

  assert.equal(packet.kind, "a2a-broker.terminal-brief-sidecar-default-on-approval-evidence-ingestor.packet");
  assert.equal(packet.state, "accepted");
  assert.equal(packet.dryRunOnly, false);
  assert.equal(packet.sourceOnlyNoLive, true);
  assert.equal(packet.receiptEvidenceAccepted, true);
  assert.equal(packet.approvalEvidenceAccepted, true);
  assert.equal(packet.classification.providerAccepted, true);
  assert.equal(packet.classification.currentSessionVisible, true);
  assert.equal(packet.classification.approvalGrantAccepted, true);
  assert.equal(packet.classification.terminalAckEligible, true);
  assert.equal(packet.classification.providerAcceptedIsVisibilityProof, false);
  assert.equal(packet.readiness.approvalRequestDispatchPermitted, false);
  assert.equal(packet.readiness.approvalGrantPermitted, false);
  assert.equal(packet.readiness.defaultOnPermitted, false);
  assert.equal(packet.readiness.providerSendPermitted, false);
  assert.equal(packet.readiness.terminalAckPermitted, false);
  assert.equal(packet.readiness.dbMutationPermitted, false);
  assert.equal(packet.integrationContract.grantsApproval, false);
  assert.equal(packet.integrationContract.enablesDefaultOn, false);
  assert.equal(packet.integrationContract.mutatesDb, false);
  assert.equal(packet.semantics.approvalGrantEvidenceDoesNotGrantApproval, true);
  assert.equal(packet.semantics.defaultOnApprovalEvidenceDoesNotEnableDefaultOn, true);
  assert.equal(packet.semantics.performsTerminalAck, false);
});

test("provider accepted alone remains insufficient and is not visibility proof", () => {
  const packet = buildTerminalBriefSidecarDefaultOnApprovalEvidenceIngestor(
    approvalRequest(),
    [{ kind: "provider_accepted", observedAt: NOW, providerMessageId: "provider-772" }],
    { now: NOW },
  );

  assert.equal(packet.state, "insufficient");
  assert.equal(packet.classification.providerAccepted, true);
  assert.equal(packet.classification.receiptProofAccepted, false);
  assert.equal(packet.classification.approvalGrantAccepted, false);
  assert.equal(packet.receiptEvidenceAccepted, false);
  assert.match(packet.classification.reason, /provider accepted is transport evidence only/);
});

test("conflicting approval grant is rejected as conflicting evidence", () => {
  const packet = buildTerminalBriefSidecarDefaultOnApprovalEvidenceIngestor(
    approvalRequest(),
    [
      { kind: "manual_operator_confirmation", observedAt: NOW, target: "terminal-brief-default-on" },
      {
        kind: "approval_grant",
        observedAt: NOW,
        approvedAction: "approve_wrong_action",
        approvedTarget: "terminal-brief-default-on",
      },
    ],
    { now: NOW },
  );

  assert.equal(packet.state, "conflicting");
  assert.equal(packet.classification.approvalGrantAccepted, false);
  assert.equal(packet.evidence.conflictingKinds.includes("approval_grant"), true);
});

test("blocks unsafe default-on approval request permission drift", () => {
  const unsafe = approvalRequest();
  unsafe.readiness.defaultOnPermitted = true as never;
  const packet = buildTerminalBriefSidecarDefaultOnApprovalEvidenceIngestor(unsafe, acceptedEvidence, { now: NOW });

  assert.equal(packet.state, "blocked");
  assert.equal(packet.readiness.defaultOnPermitted, false);
  assert.match(packet.classification.reason, /unexpectedly permits default-on/);
});

test("extracts request, evidence, and options from envelopes", () => {
  const input = {
    defaultOnApprovalRequestPacket: approvalRequest(),
    defaultOnApprovalEvidenceIngestor: { mode: "fixture", maxAgeMs: 1234 },
    evidence: acceptedEvidence,
  };

  assert.equal(extractTerminalBriefSidecarDefaultOnApprovalRequestPacket(input).kind, "a2a-broker.terminal-brief-sidecar-default-on-approval-request.packet");
  assert.deepEqual(extractTerminalBriefSidecarDefaultOnApprovalEvidence(input), acceptedEvidence);
  assert.deepEqual(extractTerminalBriefSidecarDefaultOnApprovalEvidenceIngestorOptions(input), { now: undefined, mode: "fixture", maxAgeMs: 1234 });
});

test("renders markdown with default-on safety boundary", () => {
  const packet = buildTerminalBriefSidecarDefaultOnApprovalEvidenceIngestor(approvalRequest(), acceptedEvidence, { now: NOW });
  const markdown = renderTerminalBriefSidecarDefaultOnApprovalEvidenceIngestorMarkdown(packet);

  assert.match(markdown, /Accepted: Terminal Brief default-on approval evidence/);
  assert.match(markdown, /providerAcceptedIsVisibilityProof=false/);
  assert.match(markdown, /default-on is not enabled/);
});
