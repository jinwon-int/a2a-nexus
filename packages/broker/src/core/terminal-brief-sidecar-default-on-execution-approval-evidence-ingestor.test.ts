import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import type { TerminalBriefSidecarDefaultOnExecutionApprovalRequestPacket } from "./terminal-brief-sidecar-default-on-execution-approval-request.js";
import {
  buildTerminalBriefSidecarDefaultOnExecutionApprovalRequest,
  extractTerminalBriefSidecarDefaultOnExecutionApprovalRequestEnvelope,
} from "./terminal-brief-sidecar-default-on-execution-approval-request.js";
import {
  buildTerminalBriefSidecarDefaultOnExecutionApprovalEvidenceIngestor,
  extractTerminalBriefSidecarDefaultOnExecutionApprovalEvidence,
  extractTerminalBriefSidecarDefaultOnExecutionApprovalEvidenceIngestorOptions,
  extractTerminalBriefSidecarDefaultOnExecutionApprovalRequestPacket,
  renderTerminalBriefSidecarDefaultOnExecutionApprovalEvidenceIngestorMarkdown,
} from "./terminal-brief-sidecar-default-on-execution-approval-evidence-ingestor.js";

const NOW = "2026-05-19T06:45:00.000Z";

function fixtureInput(): Record<string, unknown> {
  return JSON.parse(readFileSync(
    join(process.cwd(), "fixtures/terminal-brief/sidecar-default-on-execution-approval-request.no-live.json"),
    "utf8",
  )) as Record<string, unknown>;
}

function approvalRequest(
  overrides: Partial<TerminalBriefSidecarDefaultOnExecutionApprovalRequestPacket> = {},
): TerminalBriefSidecarDefaultOnExecutionApprovalRequestPacket {
  const packet = buildTerminalBriefSidecarDefaultOnExecutionApprovalRequest(
    extractTerminalBriefSidecarDefaultOnExecutionApprovalRequestEnvelope(fixtureInput()),
    {
      now: NOW,
      requestedBy: "seoseo",
      operatorTarget: "terminal-brief-default-on",
      operatorChannel: "telegram-direct",
      approvalWindowMinutes: 20,
    },
  );
  return { ...packet, ...overrides };
}

const acceptedEvidence = [
  {
    kind: "manual_operator_confirmation",
    observedAt: NOW,
    target: "terminal-brief-default-on",
    operatorId: "operator-a",
    source: "telegram-direct",
    note: "default-on execution 승인",
  },
  {
    kind: "approval_grant",
    observedAt: NOW,
    approvedAction: "approve_terminal_brief_default_on_execution",
    approvedTarget: "terminal-brief-default-on",
    operatorId: "operator-a",
    source: "telegram-direct",
    note: "default-on execution 승인",
  },
];

test("accepts manual receipt plus matching execution approval grant as no-live source evidence only", () => {
  const packet = buildTerminalBriefSidecarDefaultOnExecutionApprovalEvidenceIngestor(
    approvalRequest(),
    acceptedEvidence,
    { now: NOW },
  );

  assert.equal(packet.kind, "a2a-broker.terminal-brief-sidecar-default-on-execution-approval-evidence-ingestor.packet");
  assert.equal(packet.state, "accepted");
  assert.equal(packet.sourceOnlyNoLive, true);
  assert.equal(packet.receiptEvidenceAccepted, true);
  assert.equal(packet.approvalEvidenceAccepted, true);
  assert.equal(packet.classification.manualOperatorConfirmed, true);
  assert.equal(packet.classification.approvalGrantAccepted, true);
  assert.equal(packet.classification.providerAcceptedIsVisibilityProof, false);
  assert.equal(packet.classification.approvalGrantEvidenceExecutesGrant, false);
  assert.equal(packet.readiness.executionApprovalRequestDispatchPermitted, false);
  assert.equal(packet.readiness.approvalGrantPermitted, false);
  assert.equal(packet.readiness.runtimeMutationPermitted, false);
  assert.equal(packet.readiness.configWritePermitted, false);
  assert.equal(packet.readiness.defaultOnPermitted, false);
  assert.equal(packet.readiness.sidecarRestartPermitted, false);
  assert.equal(packet.readiness.providerSendPermitted, false);
  assert.equal(packet.readiness.terminalAckPermitted, false);
  assert.equal(packet.readiness.dbMutationPermitted, false);
  assert.equal(packet.readiness.taskFlowMutationPermitted, false);
  assert.equal(packet.readiness.executionPermitted, false);
  assert.equal(packet.readiness.processSpawnPermitted, false);
  assert.equal(packet.readiness.sidecarStartPermitted, false);
  assert.equal(packet.readiness.brokerRestartPermitted, false);
  assert.equal(packet.integrationContract.grantsApproval, false);
  assert.equal(packet.integrationContract.writesConfig, false);
  assert.equal(packet.integrationContract.enablesDefaultOn, false);
  assert.equal(packet.integrationContract.restartsSidecar, false);
  assert.equal(packet.integrationContract.executesAction, false);
  assert.equal(packet.semantics.approvalGrantEvidenceDoesNotGrantApproval, true);
  assert.equal(packet.semantics.executionApprovalEvidenceDoesNotEnableDefaultOn, true);
  assert.equal(packet.semantics.executionRequiresSeparateRuntimeExecutor, true);
  assert.equal(packet.semantics.performsProviderSend, false);
  assert.equal(packet.semantics.performsTerminalAck, false);
  assert.equal(packet.semantics.performsDbMutation, false);
});

test("provider accepted alone remains insufficient and is not visibility proof", () => {
  const packet = buildTerminalBriefSidecarDefaultOnExecutionApprovalEvidenceIngestor(
    approvalRequest(),
    [{ kind: "provider_accepted", observedAt: NOW, providerMessageId: "provider-782" }],
    { now: NOW },
  );

  assert.equal(packet.state, "insufficient");
  assert.equal(packet.classification.providerAccepted, true);
  assert.equal(packet.classification.receiptProofAccepted, false);
  assert.equal(packet.classification.approvalGrantAccepted, false);
  assert.equal(packet.receiptEvidenceAccepted, false);
  assert.match(packet.classification.reason, /provider accepted is transport evidence only/);
});

test("matching approval reference target is accepted as execution approval grant evidence", () => {
  const request = approvalRequest();
  const packet = buildTerminalBriefSidecarDefaultOnExecutionApprovalEvidenceIngestor(
    request,
    [
      { kind: "current_session_visible", observedAt: NOW, target: "terminal-brief-default-on" },
      {
        kind: "approval_grant",
        observedAt: NOW,
        approvedAction: "approve_terminal_brief_default_on_execution",
        approvedTarget: request.approvalRequestDraft.approvalReference,
      },
    ],
    { now: NOW },
  );

  assert.equal(packet.state, "accepted");
  assert.equal(packet.approvalEvidenceAccepted, true);
});

test("conflicting execution approval grant is classified as conflicting", () => {
  const packet = buildTerminalBriefSidecarDefaultOnExecutionApprovalEvidenceIngestor(
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

test("blocks unsafe execution approval request permission drift", () => {
  const unsafe = approvalRequest();
  unsafe.readiness.configWritePermitted = true as never;
  unsafe.approvalRequestDraft.executionPermitted = true as never;
  const packet = buildTerminalBriefSidecarDefaultOnExecutionApprovalEvidenceIngestor(
    unsafe,
    acceptedEvidence,
    { now: NOW },
  );

  assert.equal(packet.state, "blocked");
  assert.equal(packet.readiness.configWritePermitted, false);
  assert.equal(packet.readiness.executionPermitted, false);
  assert.match(packet.classification.reason, /config write|execution/);
});

test("extracts request, evidence, and options from envelopes", () => {
  const input = {
    defaultOnExecutionApprovalRequestPacket: approvalRequest(),
    executionApprovalEvidenceIngestor: { mode: "fixture", maxAgeMs: 1234 },
    evidence: acceptedEvidence,
  };

  assert.equal(
    extractTerminalBriefSidecarDefaultOnExecutionApprovalRequestPacket(input).kind,
    "a2a-broker.terminal-brief-sidecar-default-on-execution-approval-request.packet",
  );
  assert.deepEqual(extractTerminalBriefSidecarDefaultOnExecutionApprovalEvidence(input), acceptedEvidence);
  assert.deepEqual(
    extractTerminalBriefSidecarDefaultOnExecutionApprovalEvidenceIngestorOptions(input),
    { now: undefined, mode: "fixture", maxAgeMs: 1234 },
  );
});

test("renders markdown with execution approval safety boundary", () => {
  const packet = buildTerminalBriefSidecarDefaultOnExecutionApprovalEvidenceIngestor(
    approvalRequest(),
    acceptedEvidence,
    { now: NOW },
  );
  const markdown = renderTerminalBriefSidecarDefaultOnExecutionApprovalEvidenceIngestorMarkdown(packet);

  assert.match(markdown, /Accepted: Terminal Brief default-on execution approval evidence/);
  assert.match(markdown, /providerAcceptedIsVisibilityProof=false/);
  assert.match(markdown, /approvalGrantEvidenceExecutesGrant=false/);
  assert.match(markdown, /default-on is not enabled/);
});
