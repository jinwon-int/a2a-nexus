import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import type { TerminalBriefSidecarDefaultOnRuntimeExecutionApprovalEvidenceIngestorPacket } from "./runtime-execution-approval-evidence-ingestor.js";
import {
  buildTerminalBriefSidecarDefaultOnRuntimeExecutionApprovalEvidenceIngestor,
  extractTerminalBriefSidecarDefaultOnRuntimeExecutionApprovalEvidence,
  extractTerminalBriefSidecarDefaultOnRuntimeExecutionApprovalEvidenceIngestorOptions,
  extractTerminalBriefSidecarDefaultOnRuntimeExecutionRequestDraftPacket,
} from "./runtime-execution-approval-evidence-ingestor.js";
import {
  buildTerminalBriefSidecarDefaultOnRuntimeExecutorGate,
  extractTerminalBriefSidecarDefaultOnRuntimeExecutorGateEvidence,
  extractTerminalBriefSidecarDefaultOnRuntimeExecutorGateOptions,
  renderTerminalBriefSidecarDefaultOnRuntimeExecutorGateMarkdown,
} from "./runtime-executor-gate.js";

const NOW = "2026-05-19T07:25:00.000Z";

function fixtureInput(): Record<string, unknown> {
  return JSON.parse(readFileSync(
    join(process.cwd(), "fixtures/terminal-brief/sidecar-default-on-runtime-execution-approval-evidence-ingestor.no-live.json"),
    "utf8",
  )) as Record<string, unknown>;
}

function acceptedEvidence(): TerminalBriefSidecarDefaultOnRuntimeExecutionApprovalEvidenceIngestorPacket {
  const input = fixtureInput();
  return buildTerminalBriefSidecarDefaultOnRuntimeExecutionApprovalEvidenceIngestor(
    extractTerminalBriefSidecarDefaultOnRuntimeExecutionRequestDraftPacket(input),
    extractTerminalBriefSidecarDefaultOnRuntimeExecutionApprovalEvidence(input),
    { ...extractTerminalBriefSidecarDefaultOnRuntimeExecutionApprovalEvidenceIngestorOptions(input), now: NOW, maxAgeMs: 3_600_000 },
  );
}

test("default-on runtime executor gate becomes ready from accepted evidence without permitting execution", () => {
  const packet = buildTerminalBriefSidecarDefaultOnRuntimeExecutorGate(acceptedEvidence(), { now: NOW });

  assert.equal(packet.kind, "a2a-broker.terminal-brief-sidecar-default-on-runtime-executor-gate.packet");
  assert.equal(packet.state, "ready_for_runtime_executor_review");
  assert.equal(packet.sourceOnlyNoLive, true);
  assert.equal(packet.executorGate.gateReady, true);
  assert.equal(packet.source.receiptEvidenceAccepted, true);
  assert.equal(packet.source.approvalEvidenceAccepted, true);
  assert.equal(packet.source.configKey, "TERMINAL_BRIEF_SIDECAR_DEFAULT_ON");
  assert.equal(packet.readiness.runtimeExecutorGateReady, true);
  assert.equal(packet.readiness.approvalRequestDispatchPermitted, false);
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
  assert.equal(packet.integrationContract.writesConfig, false);
  assert.equal(packet.integrationContract.enablesDefaultOn, false);
  assert.equal(packet.integrationContract.restartsSidecar, false);
  assert.equal(packet.integrationContract.dispatchesStartExecutor, false);
  assert.equal(packet.integrationContract.invokesExecutor, false);
  assert.equal(packet.integrationContract.executesAction, false);
  assert.equal(packet.semantics.acceptedEvidenceDoesNotAuthorizeRuntime, true);
  assert.equal(packet.semantics.executorGateDoesNotWriteConfig, true);
  assert.equal(packet.semantics.executorGateDoesNotEnableDefaultOn, true);
  assert.equal(packet.semantics.executorGateDoesNotRestartSidecar, true);
  assert.equal(packet.semantics.executionNotPermitted, true);
});

test("default-on runtime executor gate waits for non-accepted evidence states", () => {
  const base = acceptedEvidence();
  const waiting = buildTerminalBriefSidecarDefaultOnRuntimeExecutorGate({ ...base, state: "insufficient" }, { now: NOW });
  const rejected = buildTerminalBriefSidecarDefaultOnRuntimeExecutorGate({ ...base, state: "rejected" }, { now: NOW });
  const stale = buildTerminalBriefSidecarDefaultOnRuntimeExecutorGate({ ...base, state: "stale" }, { now: NOW });
  const conflicting = buildTerminalBriefSidecarDefaultOnRuntimeExecutorGate({ ...base, state: "conflicting" }, { now: NOW });

  assert.equal(waiting.state, "waiting_for_runtime_execution_approval_evidence");
  assert.equal(rejected.state, "approval_rejected");
  assert.equal(stale.state, "stale");
  assert.equal(conflicting.state, "conflicting");
  assert.equal(waiting.readiness.missingEvidence.includes("accepted_runtime_execution_approval_evidence"), true);
  assert.equal(rejected.readiness.defaultOnPermitted, false);
  assert.equal(stale.readiness.sidecarRestartPermitted, false);
  assert.equal(conflicting.readiness.executionPermitted, false);
});

test("default-on runtime executor gate blocks unsafe source drift", () => {
  const unsafe = acceptedEvidence();
  unsafe.readiness.configWritePermitted = true as never;
  unsafe.integrationContract.executesAction = true as never;
  const packet = buildTerminalBriefSidecarDefaultOnRuntimeExecutorGate(unsafe, { now: NOW });

  assert.equal(packet.state, "blocked");
  assert.equal(packet.blockers.some((blocker) => blocker.includes("config write")), true);
  assert.equal(packet.blockers.some((blocker) => blocker.includes("executes action")), true);
  assert.equal(packet.readiness.configWritePermitted, false);
  assert.equal(packet.readiness.executionPermitted, false);
});

test("default-on runtime executor gate extractors and markdown preserve no-live boundary", () => {
  const input = {
    defaultOnRuntimeExecutionApprovalEvidenceIngestorPacket: acceptedEvidence(),
    runtimeExecutorGate: { now: NOW, finalizer: "brokeralpha", runtimeExecutorGateReference: "runtime-executor-gate-790" },
  };

  assert.equal(extractTerminalBriefSidecarDefaultOnRuntimeExecutorGateEvidence(input).state, "accepted");
  assert.deepEqual(extractTerminalBriefSidecarDefaultOnRuntimeExecutorGateOptions(input), {
    now: NOW,
    finalizer: "brokeralpha",
    runtimeExecutorGateReference: "runtime-executor-gate-790",
  });

  const packet = buildTerminalBriefSidecarDefaultOnRuntimeExecutorGate(
    extractTerminalBriefSidecarDefaultOnRuntimeExecutorGateEvidence(input),
    extractTerminalBriefSidecarDefaultOnRuntimeExecutorGateOptions(input),
  );
  const markdown = renderTerminalBriefSidecarDefaultOnRuntimeExecutorGateMarkdown(packet);

  assert.match(markdown, /Ready: Terminal Brief default-on runtime executor gate/);
  assert.match(markdown, /configWritePermitted=false/);
  assert.match(markdown, /does not write config, enable default-on, restart sidecar/);
});
