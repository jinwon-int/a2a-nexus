import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import type { TerminalBriefSidecarDefaultOnExecutionApprovalEvidenceIngestorPacket } from "./terminal-brief-sidecar-default-on-execution-approval-evidence-ingestor.js";
import {
  buildTerminalBriefSidecarDefaultOnExecutionApprovalEvidenceIngestor,
  extractTerminalBriefSidecarDefaultOnExecutionApprovalEvidence,
  extractTerminalBriefSidecarDefaultOnExecutionApprovalEvidenceIngestorOptions,
  extractTerminalBriefSidecarDefaultOnExecutionApprovalRequestPacket,
} from "./terminal-brief-sidecar-default-on-execution-approval-evidence-ingestor.js";
import {
  buildTerminalBriefSidecarDefaultOnRuntimeExecutionFinalGate,
  extractTerminalBriefSidecarDefaultOnRuntimeExecutionFinalGateEvidence,
  extractTerminalBriefSidecarDefaultOnRuntimeExecutionFinalGateOptions,
  renderTerminalBriefSidecarDefaultOnRuntimeExecutionFinalGateMarkdown,
} from "./terminal-brief-sidecar-default-on-runtime-execution-final-gate.js";

const NOW = "2026-05-19T07:25:00.000Z";

function fixtureInput(): Record<string, unknown> {
  return JSON.parse(readFileSync(
    join(process.cwd(), "fixtures/terminal-brief/sidecar-default-on-execution-approval-evidence-ingestor.no-live.json"),
    "utf8",
  )) as Record<string, unknown>;
}

function acceptedEvidence(): TerminalBriefSidecarDefaultOnExecutionApprovalEvidenceIngestorPacket {
  const input = fixtureInput();
  return buildTerminalBriefSidecarDefaultOnExecutionApprovalEvidenceIngestor(
    extractTerminalBriefSidecarDefaultOnExecutionApprovalRequestPacket(input),
    extractTerminalBriefSidecarDefaultOnExecutionApprovalEvidence(input),
    { ...extractTerminalBriefSidecarDefaultOnExecutionApprovalEvidenceIngestorOptions(input), now: NOW, maxAgeMs: 3_600_000 },
  );
}

test("default-on runtime execution final gate becomes ready from accepted evidence without permitting execution", () => {
  const packet = buildTerminalBriefSidecarDefaultOnRuntimeExecutionFinalGate(acceptedEvidence(), { now: NOW });

  assert.equal(packet.kind, "a2a-broker.terminal-brief-sidecar-default-on-runtime-execution-final-gate.packet");
  assert.equal(packet.state, "ready_for_runtime_execution_final_review");
  assert.equal(packet.sourceOnlyNoLive, true);
  assert.equal(packet.finalGate.gateReady, true);
  assert.equal(packet.source.receiptEvidenceAccepted, true);
  assert.equal(packet.source.approvalEvidenceAccepted, true);
  assert.equal(packet.source.configKey, "TERMINAL_BRIEF_SIDECAR_DEFAULT_ON");
  assert.equal(packet.readiness.runtimeExecutionFinalGateReady, true);
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
  assert.equal(packet.semantics.finalGateDoesNotWriteConfig, true);
  assert.equal(packet.semantics.finalGateDoesNotEnableDefaultOn, true);
  assert.equal(packet.semantics.finalGateDoesNotRestartSidecar, true);
  assert.equal(packet.semantics.executionNotPermitted, true);
});

test("default-on runtime execution final gate waits for non-accepted evidence states", () => {
  const base = acceptedEvidence();
  const waiting = buildTerminalBriefSidecarDefaultOnRuntimeExecutionFinalGate({ ...base, state: "insufficient" }, { now: NOW });
  const rejected = buildTerminalBriefSidecarDefaultOnRuntimeExecutionFinalGate({ ...base, state: "rejected" }, { now: NOW });
  const stale = buildTerminalBriefSidecarDefaultOnRuntimeExecutionFinalGate({ ...base, state: "stale" }, { now: NOW });
  const conflicting = buildTerminalBriefSidecarDefaultOnRuntimeExecutionFinalGate({ ...base, state: "conflicting" }, { now: NOW });

  assert.equal(waiting.state, "waiting_for_execution_approval_evidence");
  assert.equal(rejected.state, "approval_rejected");
  assert.equal(stale.state, "stale");
  assert.equal(conflicting.state, "conflicting");
  assert.equal(waiting.readiness.missingEvidence.includes("accepted_execution_approval_evidence"), true);
  assert.equal(rejected.readiness.defaultOnPermitted, false);
  assert.equal(stale.readiness.sidecarRestartPermitted, false);
  assert.equal(conflicting.readiness.executionPermitted, false);
});

test("default-on runtime execution final gate blocks unsafe source drift", () => {
  const unsafe = acceptedEvidence();
  unsafe.readiness.configWritePermitted = true as never;
  unsafe.integrationContract.executesAction = true as never;
  const packet = buildTerminalBriefSidecarDefaultOnRuntimeExecutionFinalGate(unsafe, { now: NOW });

  assert.equal(packet.state, "blocked");
  assert.equal(packet.blockers.some((blocker) => blocker.includes("config write")), true);
  assert.equal(packet.blockers.some((blocker) => blocker.includes("executes action")), true);
  assert.equal(packet.readiness.configWritePermitted, false);
  assert.equal(packet.readiness.executionPermitted, false);
});

test("default-on runtime execution final gate extractors and markdown preserve no-live boundary", () => {
  const input = {
    defaultOnExecutionApprovalEvidenceIngestorPacket: acceptedEvidence(),
    runtimeExecutionFinalGate: { now: NOW, finalizer: "brokeralpha", executionGateReference: "runtime-final-gate-784" },
  };

  assert.equal(extractTerminalBriefSidecarDefaultOnRuntimeExecutionFinalGateEvidence(input).state, "accepted");
  assert.deepEqual(extractTerminalBriefSidecarDefaultOnRuntimeExecutionFinalGateOptions(input), {
    now: NOW,
    finalizer: "brokeralpha",
    executionGateReference: "runtime-final-gate-784",
  });

  const packet = buildTerminalBriefSidecarDefaultOnRuntimeExecutionFinalGate(
    extractTerminalBriefSidecarDefaultOnRuntimeExecutionFinalGateEvidence(input),
    extractTerminalBriefSidecarDefaultOnRuntimeExecutionFinalGateOptions(input),
  );
  const markdown = renderTerminalBriefSidecarDefaultOnRuntimeExecutionFinalGateMarkdown(packet);

  assert.match(markdown, /Ready: Terminal Brief default-on runtime execution final gate/);
  assert.match(markdown, /configWritePermitted=false/);
  assert.match(markdown, /does not write config, enable default-on, restart sidecar/);
});
