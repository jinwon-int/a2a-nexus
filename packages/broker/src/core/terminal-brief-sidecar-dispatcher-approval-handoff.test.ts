import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildTerminalBriefSidecarDispatcherPreflightSeal,
  extractTerminalBriefSidecarDispatcherPreflightSealDraft,
  extractTerminalBriefSidecarDispatcherPreflightSealOptions,
  extractTerminalBriefSidecarDispatcherRuntimeEvidence,
  type TerminalBriefSidecarDispatcherPreflightSealPacket,
} from "./terminal-brief-sidecar-dispatcher-preflight-seal.js";
import {
  buildTerminalBriefSidecarDispatcherApprovalHandoff,
  extractTerminalBriefSidecarDispatcherApprovalHandoffOptions,
  extractTerminalBriefSidecarDispatcherApprovalHandoffSeal,
  renderTerminalBriefSidecarDispatcherApprovalHandoffMarkdown,
} from "./terminal-brief-sidecar-dispatcher-approval-handoff.js";

const SEAL_NOW = "2026-05-19T03:45:00.000Z";
const NOW = "2026-05-19T03:46:00.000Z";

function readySeal(
  overrides: Partial<TerminalBriefSidecarDispatcherPreflightSealPacket> = {},
): TerminalBriefSidecarDispatcherPreflightSealPacket {
  const fixture = JSON.parse(readFileSync("fixtures/terminal-brief/sidecar-dispatcher-preflight-seal.no-live.json", "utf8"));
  const packet = buildTerminalBriefSidecarDispatcherPreflightSeal(
    extractTerminalBriefSidecarDispatcherPreflightSealDraft(fixture),
    extractTerminalBriefSidecarDispatcherRuntimeEvidence(fixture),
    {
      ...extractTerminalBriefSidecarDispatcherPreflightSealOptions(fixture),
      now: SEAL_NOW,
    },
  );
  return { ...packet, ...overrides } as TerminalBriefSidecarDispatcherPreflightSealPacket;
}

test("dispatcher approval handoff becomes ready without sending approval or dispatching executor", () => {
  const packet = buildTerminalBriefSidecarDispatcherApprovalHandoff(readySeal(), {
    now: NOW,
    requestedBy: "broker-finalizer",
    operatorTarget: "operator",
    operatorChannel: "telegram",
    approvalReference: "dispatcher-approval-757",
    handoffReference: "dispatcher-approval-handoff-757",
    approvalWindowMinutes: 10,
  });

  assert.equal(packet.kind, "a2a-broker.terminal-brief-sidecar-dispatcher-approval-handoff.packet");
  assert.equal(packet.state, "dispatcher_approval_handoff_ready");
  assert.equal(packet.source.dispatcherPreflightSealReady, true);
  assert.equal(packet.source.envelopeIntegrityVerified, true);
  assert.equal(packet.approvalHandoffDraft.draftOnly, true);
  assert.equal(packet.approvalHandoffDraft.status, "draft_not_sent");
  assert.equal(packet.approvalHandoffDraft.dispatchPermitted, false);
  assert.equal(packet.approvalHandoffDraft.approvalGrantPermitted, false);
  assert.equal(packet.approvalHandoffDraft.approvalGrantExecutionPermitted, false);
  assert.equal(packet.approvalHandoffDraft.startExecutorDispatchPermitted, false);
  assert.equal(packet.approvalHandoffDraft.executorInvocationPermitted, false);
  assert.equal(packet.approvalHandoffDraft.processSpawnPermitted, false);
  assert.equal(packet.approvalHandoffDraft.sidecarStartPermitted, false);
  assert.equal(packet.approvalHandoffDraft.defaultOnPermitted, false);
  assert.equal(packet.approvalHandoffDraft.providerSendPermitted, false);
  assert.equal(packet.approvalHandoffDraft.terminalAckPermitted, false);
  assert.equal(packet.approvalHandoffDraft.executionPermitted, false);
  assert.equal(packet.approvalHandoffDraft.dbMutationPermitted, false);
  assert.equal(packet.dispatcherApprovalBoundary.separateOperatorApprovalRequired, true);
  assert.equal(packet.readiness.dispatcherApprovalHandoffReady, true);
  assert.equal(packet.readiness.approvalRequestDispatchPermitted, false);
  assert.equal(packet.readiness.approvalGrantPermitted, false);
  assert.equal(packet.readiness.startExecutorDispatchPermitted, false);
  assert.equal(packet.readiness.executorInvocationPermitted, false);
  assert.equal(packet.readiness.processSpawnPermitted, false);
  assert.equal(packet.readiness.sidecarStartPermitted, false);
  assert.equal(packet.readiness.providerSendPermitted, false);
  assert.equal(packet.readiness.terminalAckPermitted, false);
  assert.equal(packet.readiness.executionPermitted, false);
  assert.equal(packet.readiness.dbMutationPermitted, false);
  assert.equal(packet.integrationContract.rendersApprovalHandoffDraft, true);
  assert.equal(packet.integrationContract.sendsApprovalRequest, false);
  assert.equal(packet.integrationContract.grantsApproval, false);
  assert.equal(packet.integrationContract.dispatchesStartExecutor, false);
  assert.equal(packet.integrationContract.invokesExecutor, false);
  assert.equal(packet.integrationContract.spawnsProcess, false);
  assert.equal(packet.integrationContract.startsSidecar, false);
  assert.equal(packet.semantics.dispatcherApprovalHandoffOnly, true);
  assert.equal(packet.semantics.handoffDoesNotSendApprovalRequest, true);
  assert.equal(packet.semantics.handoffDoesNotDispatchExecutor, true);
});

test("dispatcher approval handoff waits for unready seal, expiry, and integrity failure", () => {
  const waiting = buildTerminalBriefSidecarDispatcherApprovalHandoff(readySeal({
    state: "runtime_evidence_missing",
    readiness: {
      ...readySeal().readiness,
      sourceCriteriaMet: false,
      dispatcherPreflightSealReady: false,
    },
  }), { now: NOW });
  const expired = buildTerminalBriefSidecarDispatcherApprovalHandoff(readySeal(), {
    now: "2026-05-19T03:56:00.000Z",
  });
  const integrity = buildTerminalBriefSidecarDispatcherApprovalHandoff(readySeal({
    state: "integrity_failed",
    sealedEnvelope: {
      ...readySeal().sealedEnvelope,
      integrityVerified: false,
    },
  }), { now: NOW });

  assert.equal(waiting.state, "waiting_for_dispatcher_preflight_seal");
  assert.equal(expired.state, "seal_expired");
  assert.equal(integrity.state, "integrity_failed");
  assert.equal(waiting.readiness.approvalRequestDispatchPermitted, false);
  assert.equal(expired.readiness.executionPermitted, false);
  assert.equal(integrity.readiness.terminalAckPermitted, false);
});

test("dispatcher approval handoff blocks unsafe seal drift", () => {
  const unsafe = readySeal();
  unsafe.readiness.executorInvocationPermitted = true as false;
  const packet = buildTerminalBriefSidecarDispatcherApprovalHandoff(unsafe, { now: NOW });

  assert.equal(packet.state, "blocked");
  assert.equal(packet.blockers.some((blocker) => blocker.includes("executor invocation")), true);
  assert.equal(packet.readiness.executorInvocationPermitted, false);
});

test("dispatcher approval handoff extractors and markdown preserve source-only boundary", () => {
  const source = readySeal();
  const input = {
    dispatcherPreflightSealPacket: source,
    dispatcherApprovalHandoff: {
      requested_by: "brokeralpha",
      operator_channel: "telegram",
      approval_reference: "dispatcher-approval-757",
      required_reply: "approve_terminal_brief_sidecar_dispatcher_path dispatcher-approval-757",
    },
  };

  assert.equal(extractTerminalBriefSidecarDispatcherApprovalHandoffSeal(input).idempotencyKey, source.idempotencyKey);
  assert.equal(extractTerminalBriefSidecarDispatcherApprovalHandoffOptions(input).requested_by, "brokeralpha");

  const packet = buildTerminalBriefSidecarDispatcherApprovalHandoff(
    extractTerminalBriefSidecarDispatcherApprovalHandoffSeal(input),
    { ...extractTerminalBriefSidecarDispatcherApprovalHandoffOptions(input), now: NOW },
  );
  const markdown = renderTerminalBriefSidecarDispatcherApprovalHandoffMarkdown(packet);

  assert.equal(packet.approvalHandoffDraft.requestedBy, "brokeralpha");
  assert.equal(markdown.includes("does not send approval"), true);
  assert.equal(markdown.includes("executorInvocationPermitted=false"), true);
  assert.equal(packet.readiness.approvalRequestDispatchPermitted, false);
});
