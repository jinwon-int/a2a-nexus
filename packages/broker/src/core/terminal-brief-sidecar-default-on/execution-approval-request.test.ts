import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import type { TerminalBriefSidecarDefaultOnExecutionRollbackEnvelopePacket } from "./execution-rollback-envelope.js";
import {
  buildTerminalBriefSidecarDefaultOnExecutionApprovalRequest,
  extractTerminalBriefSidecarDefaultOnExecutionApprovalRequestEnvelope,
  extractTerminalBriefSidecarDefaultOnExecutionApprovalRequestOptions,
  renderTerminalBriefSidecarDefaultOnExecutionApprovalRequestMarkdown,
} from "./execution-approval-request.js";

const NOW = "2026-05-19T06:10:00.000Z";

function fixtureInput(): Record<string, unknown> {
  return JSON.parse(readFileSync(
    join(process.cwd(), "fixtures/terminal-brief/sidecar-default-on-execution-approval-request.no-live.json"),
    "utf8",
  )) as Record<string, unknown>;
}

function readyEnvelope(
  overrides: Partial<TerminalBriefSidecarDefaultOnExecutionRollbackEnvelopePacket> = {},
): TerminalBriefSidecarDefaultOnExecutionRollbackEnvelopePacket {
  return {
    ...extractTerminalBriefSidecarDefaultOnExecutionApprovalRequestEnvelope(fixtureInput()),
    ...overrides,
  };
}

test("builds source-only execution approval request draft without dispatch or runtime actions", () => {
  const packet = buildTerminalBriefSidecarDefaultOnExecutionApprovalRequest(readyEnvelope(), { now: NOW });

  assert.equal(packet.kind, "a2a-broker.terminal-brief-sidecar-default-on-execution-approval-request.packet");
  assert.equal(packet.state, "execution_approval_request_draft_ready");
  assert.equal(packet.sourceOnlyNoLive, true);
  assert.equal(packet.readiness.sourceCriteriaMet, true);
  assert.equal(packet.readiness.executionApprovalRequestDraftReady, true);
  assert.equal(packet.approvalRequestDraft.status, "draft_not_sent");
  assert.equal(packet.approvalRequestDraft.dispatchPermitted, false);
  assert.equal(packet.approvalRequestDraft.approvalGrantPermitted, false);
  assert.equal(packet.approvalRequestDraft.runtimeMutationPermitted, false);
  assert.equal(packet.approvalRequestDraft.configWritePermitted, false);
  assert.equal(packet.approvalRequestDraft.defaultOnPermitted, false);
  assert.equal(packet.approvalRequestDraft.sidecarRestartPermitted, false);
  assert.equal(packet.approvalRequestDraft.providerSendPermitted, false);
  assert.equal(packet.approvalRequestDraft.terminalAckPermitted, false);
  assert.equal(packet.approvalRequestDraft.dbMutationPermitted, false);
  assert.equal(packet.approvalRequestDraft.taskFlowMutationPermitted, false);
  assert.equal(packet.approvalRequestDraft.executionPermitted, false);
  assert.equal(packet.approvalRequestDraft.processSpawnPermitted, false);
  assert.equal(packet.readiness.executionApprovalRequestDispatchPermitted, false);
  assert.equal(packet.readiness.runtimeMutationPermitted, false);
  assert.equal(packet.readiness.configWritePermitted, false);
  assert.equal(packet.readiness.defaultOnPermitted, false);
  assert.equal(packet.readiness.sidecarRestartPermitted, false);
  assert.equal(packet.readiness.brokerRestartPermitted, false);
  assert.equal(packet.integrationContract.sendsApprovalRequest, false);
  assert.equal(packet.integrationContract.grantsApproval, false);
  assert.equal(packet.integrationContract.writesConfig, false);
  assert.equal(packet.integrationContract.enablesDefaultOn, false);
  assert.equal(packet.integrationContract.restartsSidecar, false);
  assert.equal(packet.integrationContract.executesAction, false);
  assert.equal(packet.executionApprovalBoundary.separateOperatorApprovalRequired, true);
  assert.equal(packet.executionApprovalBoundary.separateExecutorRequired, true);
  assert.equal(packet.semantics.requestDraftIsNotSend, true);
  assert.equal(packet.semantics.requestDoesNotExecuteEnvelope, true);
  assert.equal(packet.semantics.requestDoesNotWriteConfig, true);
  assert.equal(packet.semantics.requestDoesNotEnableDefaultOn, true);
  assert.equal(packet.semantics.requestDoesNotRestartSidecar, true);
  assert.equal(packet.semantics.performsProviderSend, false);
  assert.equal(packet.semantics.performsTerminalAck, false);
  assert.equal(packet.semantics.performsRuntimeRestartOrDeploy, false);
  assert.equal(packet.semantics.performsDbMutation, false);
});

test("waits when execution rollback envelope is incomplete", () => {
  const source = readyEnvelope({
    state: "waiting_for_runtime_mutation_plan",
    readiness: {
      ...readyEnvelope().readiness,
      sourceCriteriaMet: false,
      executionEnvelopeReady: false,
      missingEvidence: ["ready_runtime_mutation_plan"],
    },
  });
  const packet = buildTerminalBriefSidecarDefaultOnExecutionApprovalRequest(source, { now: NOW });

  assert.equal(packet.state, "waiting_for_execution_rollback_envelope");
  assert.equal(packet.approvalRequestDraft.status, "not_ready");
  assert.equal(packet.readiness.sourceCriteriaMet, false);
  assert.ok(packet.readiness.missingEvidence.includes("ready_execution_rollback_envelope"));
  assert.ok(packet.readiness.missingEvidence.includes("execution_envelope_ready"));
});

test("propagates stale conflicting and rejected states", () => {
  assert.equal(
    buildTerminalBriefSidecarDefaultOnExecutionApprovalRequest(readyEnvelope({ state: "stale" }), { now: NOW }).state,
    "stale",
  );
  assert.equal(
    buildTerminalBriefSidecarDefaultOnExecutionApprovalRequest(readyEnvelope({ state: "conflicting" }), { now: NOW }).state,
    "conflicting",
  );
  assert.equal(
    buildTerminalBriefSidecarDefaultOnExecutionApprovalRequest(readyEnvelope({ state: "rejected" }), { now: NOW }).state,
    "rejected",
  );
});

test("blocks unsafe permission drift from source envelope", () => {
  const unsafe = readyEnvelope();
  unsafe.readiness.configWritePermitted = true as never;
  unsafe.executionRollbackEnvelope.executionPlan.commandExecutable = true as never;
  const packet = buildTerminalBriefSidecarDefaultOnExecutionApprovalRequest(unsafe, { now: NOW });

  assert.equal(packet.state, "blocked");
  assert.ok(packet.blockers.some((blocker) => blocker.includes("config write")));
  assert.ok(packet.blockers.some((blocker) => blocker.includes("command execution")));
  assert.equal(packet.readiness.configWritePermitted, false);
  assert.equal(packet.readiness.executionPermitted, false);
});

test("extractors accept aliases and markdown keeps request-only boundary", () => {
  const input = {
    executionRollbackEnvelopePacket: readyEnvelope(),
    executionApprovalRequest: {
      now: NOW,
      requestedBy: "brokeralpha",
      operatorTarget: "jinwon",
      approvalWindowMinutes: 20,
    },
  };
  const packet = buildTerminalBriefSidecarDefaultOnExecutionApprovalRequest(
    extractTerminalBriefSidecarDefaultOnExecutionApprovalRequestEnvelope(input),
    extractTerminalBriefSidecarDefaultOnExecutionApprovalRequestOptions(input),
  );
  const markdown = renderTerminalBriefSidecarDefaultOnExecutionApprovalRequestMarkdown(packet);

  assert.equal(packet.approvalRequestDraft.requestedBy, "brokeralpha");
  assert.equal(packet.approvalRequestDraft.operatorTarget, "jinwon");
  assert.equal(packet.approvalRequestDraft.approvalExpiresAt, "2026-05-19T06:30:00.000Z");
  assert.match(markdown, /execution approval request draft/);
  assert.match(markdown, /does not send request, grant approval, execute envelope, write config/);
});
