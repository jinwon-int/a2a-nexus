import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import type { TerminalBriefSidecarDefaultOnRuntimeExecutionRequestDraftPacket } from "./terminal-brief-sidecar-default-on-runtime-execution-request-draft.js";
import {
  buildTerminalBriefSidecarDefaultOnRuntimeExecutionRequestDraft,
  extractTerminalBriefSidecarDefaultOnRuntimeExecutionRequestDraftFinalGate,
  extractTerminalBriefSidecarDefaultOnRuntimeExecutionRequestDraftOptions,
} from "./terminal-brief-sidecar-default-on-runtime-execution-request-draft.js";
import {
  buildTerminalBriefSidecarDefaultOnRuntimeExecutionApprovalEvidenceIngestor,
  extractTerminalBriefSidecarDefaultOnRuntimeExecutionApprovalEvidence,
  extractTerminalBriefSidecarDefaultOnRuntimeExecutionApprovalEvidenceIngestorOptions,
  extractTerminalBriefSidecarDefaultOnRuntimeExecutionRequestDraftPacket,
  renderTerminalBriefSidecarDefaultOnRuntimeExecutionApprovalEvidenceIngestorMarkdown,
} from "./terminal-brief-sidecar-default-on-runtime-execution-approval-evidence-ingestor.js";

const NOW = "2026-05-19T08:03:00.000Z";

function fixtureInput(): Record<string, unknown> {
  return JSON.parse(readFileSync(
    join(process.cwd(), "fixtures/terminal-brief/sidecar-default-on-runtime-execution-approval-evidence-ingestor.no-live.json"),
    "utf8",
  )) as Record<string, unknown>;
}

function requestDraft(
  overrides: Partial<TerminalBriefSidecarDefaultOnRuntimeExecutionRequestDraftPacket> = {},
): TerminalBriefSidecarDefaultOnRuntimeExecutionRequestDraftPacket {
  const input = fixtureInput();
  const packet = buildTerminalBriefSidecarDefaultOnRuntimeExecutionRequestDraft(
    extractTerminalBriefSidecarDefaultOnRuntimeExecutionRequestDraftFinalGate(input),
    extractTerminalBriefSidecarDefaultOnRuntimeExecutionRequestDraftOptions(input),
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
    note: "execute default-on runtime mutation 승인",
  },
  {
    kind: "approval_grant",
    observedAt: NOW,
    approvedAction: "execute_terminal_brief_default_on_runtime_mutation",
    approvedTarget: "tb-sidecar-default-on-runtime-execution-request:fixture-786",
    operatorId: "operator-a",
    source: "telegram-direct",
    note: "execute default-on runtime mutation 승인",
  },
];

test("accepts manual receipt plus matching runtime execution approval grant as no-live source evidence only", () => {
  const packet = buildTerminalBriefSidecarDefaultOnRuntimeExecutionApprovalEvidenceIngestor(
    requestDraft(),
    acceptedEvidence,
    { now: NOW },
  );

  assert.equal(packet.kind, "a2a-broker.terminal-brief-sidecar-default-on-runtime-execution-approval-evidence-ingestor.packet");
  assert.equal(packet.state, "accepted");
  assert.equal(packet.sourceOnlyNoLive, true);
  assert.equal(packet.receiptEvidenceAccepted, true);
  assert.equal(packet.approvalEvidenceAccepted, true);
  assert.equal(packet.classification.manualOperatorConfirmed, true);
  assert.equal(packet.classification.approvalGrantAccepted, true);
  assert.equal(packet.classification.providerAcceptedIsVisibilityProof, false);
  assert.equal(packet.classification.approvalGrantEvidenceExecutesGrant, false);
  assert.equal(packet.source.requestedAction, "execute_terminal_brief_default_on_runtime_mutation");
  assert.equal(packet.readiness.runtimeExecutionRequestDispatchPermitted, false);
  assert.equal(packet.readiness.approvalGrantPermitted, false);
  assert.equal(packet.readiness.approvalGrantExecutionPermitted, false);
  assert.equal(packet.readiness.runtimeMutationPermitted, false);
  assert.equal(packet.readiness.configWritePermitted, false);
  assert.equal(packet.readiness.defaultOnPermitted, false);
  assert.equal(packet.readiness.sidecarRestartPermitted, false);
  assert.equal(packet.readiness.providerSendPermitted, false);
  assert.equal(packet.readiness.terminalAckPermitted, false);
  assert.equal(packet.readiness.dbMutationPermitted, false);
  assert.equal(packet.readiness.taskFlowMutationPermitted, false);
  assert.equal(packet.readiness.startExecutorDispatchPermitted, false);
  assert.equal(packet.readiness.executorInvocationPermitted, false);
  assert.equal(packet.readiness.executionPermitted, false);
  assert.equal(packet.readiness.processSpawnPermitted, false);
  assert.equal(packet.readiness.sidecarStartPermitted, false);
  assert.equal(packet.readiness.brokerRestartPermitted, false);
  assert.equal(packet.readiness.gatewayRestartPermitted, false);
  assert.equal(packet.integrationContract.sendsExecutionRequest, false);
  assert.equal(packet.integrationContract.grantsApproval, false);
  assert.equal(packet.integrationContract.executesApprovalGrant, false);
  assert.equal(packet.integrationContract.writesConfig, false);
  assert.equal(packet.integrationContract.enablesDefaultOn, false);
  assert.equal(packet.integrationContract.dispatchesStartExecutor, false);
  assert.equal(packet.integrationContract.invokesExecutor, false);
  assert.equal(packet.integrationContract.executesAction, false);
  assert.equal(packet.semantics.approvalGrantEvidenceDoesNotGrantApproval, true);
  assert.equal(packet.semantics.runtimeExecutionApprovalEvidenceDoesNotEnableDefaultOn, true);
  assert.equal(packet.semantics.runtimeExecutionRequiresSeparateRuntimeExecutor, true);
  assert.equal(packet.semantics.performsProviderSend, false);
  assert.equal(packet.semantics.performsTerminalAck, false);
  assert.equal(packet.semantics.performsDbMutation, false);
});

test("provider accepted alone remains insufficient and is not visibility proof", () => {
  const packet = buildTerminalBriefSidecarDefaultOnRuntimeExecutionApprovalEvidenceIngestor(
    requestDraft(),
    [{ kind: "provider_accepted", observedAt: NOW, providerMessageId: "provider-788" }],
    { now: NOW },
  );

  assert.equal(packet.state, "insufficient");
  assert.equal(packet.classification.providerAccepted, true);
  assert.equal(packet.classification.receiptProofAccepted, false);
  assert.equal(packet.classification.approvalGrantAccepted, false);
  assert.equal(packet.receiptEvidenceAccepted, false);
  assert.match(packet.classification.reason, /provider accepted is transport evidence only/);
});

test("matching operator target is accepted as runtime execution approval grant evidence", () => {
  const packet = buildTerminalBriefSidecarDefaultOnRuntimeExecutionApprovalEvidenceIngestor(
    requestDraft(),
    [
      { kind: "current_session_visible", observedAt: NOW, target: "terminal-brief-default-on" },
      {
        kind: "approval_grant",
        observedAt: NOW,
        approvedAction: "execute_terminal_brief_default_on_runtime_mutation",
        approvedTarget: "terminal-brief-default-on",
      },
    ],
    { now: NOW },
  );

  assert.equal(packet.state, "accepted");
  assert.equal(packet.approvalEvidenceAccepted, true);
});

test("conflicting runtime execution approval grant is classified as conflicting", () => {
  const packet = buildTerminalBriefSidecarDefaultOnRuntimeExecutionApprovalEvidenceIngestor(
    requestDraft(),
    [
      { kind: "manual_operator_confirmation", observedAt: NOW, target: "terminal-brief-default-on" },
      {
        kind: "approval_grant",
        observedAt: NOW,
        approvedAction: "execute_wrong_action",
        approvedTarget: "terminal-brief-default-on",
      },
    ],
    { now: NOW },
  );

  assert.equal(packet.state, "conflicting");
  assert.equal(packet.classification.approvalGrantAccepted, false);
  assert.equal(packet.evidence.conflictingKinds.includes("approval_grant"), true);
});

test("blocks unsafe runtime execution request permission drift", () => {
  const unsafe = requestDraft();
  unsafe.readiness.configWritePermitted = true as never;
  unsafe.executionRequestDraft.executionPermitted = true as never;
  const packet = buildTerminalBriefSidecarDefaultOnRuntimeExecutionApprovalEvidenceIngestor(
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
    defaultOnRuntimeExecutionRequestDraftPacket: requestDraft(),
    runtimeExecutionApprovalEvidenceIngestor: { mode: "fixture", maxAgeMs: 1234 },
    evidence: acceptedEvidence,
  };

  assert.equal(
    extractTerminalBriefSidecarDefaultOnRuntimeExecutionRequestDraftPacket(input).kind,
    "a2a-broker.terminal-brief-sidecar-default-on-runtime-execution-request-draft.packet",
  );
  assert.deepEqual(extractTerminalBriefSidecarDefaultOnRuntimeExecutionApprovalEvidence(input), acceptedEvidence);
  assert.deepEqual(
    extractTerminalBriefSidecarDefaultOnRuntimeExecutionApprovalEvidenceIngestorOptions(input),
    { now: undefined, mode: "fixture", maxAgeMs: 1234 },
  );
});

test("renders markdown with runtime execution approval safety boundary", () => {
  const packet = buildTerminalBriefSidecarDefaultOnRuntimeExecutionApprovalEvidenceIngestor(
    requestDraft(),
    acceptedEvidence,
    { now: NOW },
  );
  const markdown = renderTerminalBriefSidecarDefaultOnRuntimeExecutionApprovalEvidenceIngestorMarkdown(packet);

  assert.match(markdown, /Accepted: Terminal Brief default-on runtime execution approval evidence/);
  assert.match(markdown, /approvalGrantEvidenceExecutesGrant=false/);
  assert.match(markdown, /configWritePermitted=false/);
  assert.match(markdown, /executorInvocationPermitted=false/);
  assert.match(markdown, /does not grant or execute approval/);
});
