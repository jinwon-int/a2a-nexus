import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import type { TerminalBriefSidecarDefaultOnExecutionWindowApprovalEvidenceIngestorPacket } from "./terminal-brief-sidecar-default-on-execution-window-approval-evidence-ingestor.js";
import {
  buildTerminalBriefSidecarDefaultOnExecutionWindowApprovalEvidenceIngestor,
  extractTerminalBriefSidecarDefaultOnExecutionWindowApprovalEvidence,
  extractTerminalBriefSidecarDefaultOnExecutionWindowApprovalEvidenceIngestorOptions,
  extractTerminalBriefSidecarDefaultOnExecutionWindowApprovalEvidenceRequestDraft,
} from "./terminal-brief-sidecar-default-on-execution-window-approval-evidence-ingestor.js";
import {
  buildTerminalBriefSidecarDefaultOnFinalRuntimeMutationExecutorGate,
  extractTerminalBriefSidecarDefaultOnFinalRuntimeMutationExecutorGateEvidence,
  extractTerminalBriefSidecarDefaultOnFinalRuntimeMutationExecutorGateOptions,
  renderTerminalBriefSidecarDefaultOnFinalRuntimeMutationExecutorGateMarkdown,
} from "./terminal-brief-sidecar-default-on-final-runtime-mutation-executor-gate.js";

const NOW = "2026-05-19T11:10:00.000Z";

function fixtureInput(): Record<string, unknown> {
  return JSON.parse(readFileSync(
    join(process.cwd(), "fixtures/terminal-brief/sidecar-default-on-execution-window-approval-evidence-ingestor.no-live.json"),
    "utf8",
  )) as Record<string, unknown>;
}

function acceptedEvidence(): TerminalBriefSidecarDefaultOnExecutionWindowApprovalEvidenceIngestorPacket {
  const input = fixtureInput();
  return buildTerminalBriefSidecarDefaultOnExecutionWindowApprovalEvidenceIngestor(
    extractTerminalBriefSidecarDefaultOnExecutionWindowApprovalEvidenceRequestDraft(input),
    extractTerminalBriefSidecarDefaultOnExecutionWindowApprovalEvidence(input),
    { ...extractTerminalBriefSidecarDefaultOnExecutionWindowApprovalEvidenceIngestorOptions(input), now: NOW },
  );
}

test("final runtime mutation executor gate becomes ready from accepted execution window evidence without permitting execution", () => {
  const packet = buildTerminalBriefSidecarDefaultOnFinalRuntimeMutationExecutorGate(acceptedEvidence(), { now: NOW });

  assert.equal(packet.kind, "a2a-broker.terminal-brief-sidecar-default-on-final-runtime-mutation-executor-gate.packet");
  assert.equal(packet.state, "ready_for_final_runtime_mutation_executor_review");
  assert.equal(packet.sourceOnlyNoLive, true);
  assert.equal(packet.finalRuntimeMutationExecutorGate.gateReady, true);
  assert.equal(packet.source.receiptEvidenceAccepted, true);
  assert.equal(packet.source.approvalEvidenceAccepted, true);
  assert.equal(packet.source.executionWindowApprovalEvidenceAccepted, true);
  assert.equal(packet.source.requiredReply, "fresh operator execution window 승인");
  assert.equal(packet.source.configKey, "TERMINAL_BRIEF_SIDECAR_DEFAULT_ON");
  assert.equal(packet.readiness.finalRuntimeMutationExecutorGateReady, true);
  assert.equal(packet.readiness.executionWindowRequestDispatchPermitted, false);
  assert.equal(packet.readiness.approvalGrantPermitted, false);
  assert.equal(packet.readiness.approvalGrantExecutionPermitted, false);
  assert.equal(packet.readiness.checkpointCreationPermitted, false);
  assert.equal(packet.readiness.rollbackExecutionPermitted, false);
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
  assert.equal(packet.integrationContract.createsCheckpoint, false);
  assert.equal(packet.integrationContract.executesRollback, false);
  assert.equal(packet.integrationContract.writesConfig, false);
  assert.equal(packet.integrationContract.enablesDefaultOn, false);
  assert.equal(packet.integrationContract.restartsSidecar, false);
  assert.equal(packet.integrationContract.dispatchesStartExecutor, false);
  assert.equal(packet.integrationContract.invokesExecutor, false);
  assert.equal(packet.integrationContract.executesAction, false);
  assert.equal(packet.semantics.acceptedEvidenceDoesNotAuthorizeRuntime, true);
  assert.equal(packet.semantics.gateDoesNotCreateCheckpoint, true);
  assert.equal(packet.semantics.gateDoesNotWriteConfig, true);
  assert.equal(packet.semantics.gateDoesNotEnableDefaultOn, true);
  assert.equal(packet.semantics.gateDoesNotInvokeExecutor, true);
  assert.equal(packet.semantics.executionNotPermitted, true);
});

test("final runtime mutation executor gate maps non-accepted evidence states without permitting mutation", () => {
  const base = acceptedEvidence();
  const waiting = buildTerminalBriefSidecarDefaultOnFinalRuntimeMutationExecutorGate({ ...base, state: "insufficient" }, { now: NOW });
  const rejected = buildTerminalBriefSidecarDefaultOnFinalRuntimeMutationExecutorGate({ ...base, state: "rejected" }, { now: NOW });
  const stale = buildTerminalBriefSidecarDefaultOnFinalRuntimeMutationExecutorGate({ ...base, state: "stale" }, { now: NOW });
  const conflicting = buildTerminalBriefSidecarDefaultOnFinalRuntimeMutationExecutorGate({ ...base, state: "conflicting" }, { now: NOW });

  assert.equal(waiting.state, "waiting_for_execution_window_approval_evidence");
  assert.equal(rejected.state, "approval_rejected");
  assert.equal(stale.state, "stale");
  assert.equal(conflicting.state, "conflicting");
  assert.equal(waiting.readiness.missingEvidence.includes("accepted_execution_window_approval_evidence"), true);
  assert.equal(rejected.readiness.configWritePermitted, false);
  assert.equal(stale.readiness.defaultOnPermitted, false);
  assert.equal(conflicting.readiness.processSpawnPermitted, false);
});

test("final runtime mutation executor gate blocks unsafe source drift", () => {
  const unsafe = acceptedEvidence();
  unsafe.readiness.checkpointCreationPermitted = true as never;
  unsafe.readiness.configWritePermitted = true as never;
  unsafe.integrationContract.executesAction = true as never;
  const packet = buildTerminalBriefSidecarDefaultOnFinalRuntimeMutationExecutorGate(unsafe, { now: NOW });

  assert.equal(packet.state, "blocked");
  assert.equal(packet.blockers.some((blocker) => blocker.includes("checkpoint creation")), true);
  assert.equal(packet.blockers.some((blocker) => blocker.includes("config write")), true);
  assert.equal(packet.blockers.some((blocker) => blocker.includes("executes action")), true);
  assert.equal(packet.readiness.checkpointCreationPermitted, false);
  assert.equal(packet.readiness.configWritePermitted, false);
  assert.equal(packet.readiness.executionPermitted, false);
});

test("final runtime mutation executor gate extractors can consume raw approval fixture and preserve no-live boundary", () => {
  const input = {
    ...fixtureInput(),
    finalRuntimeMutationExecutorGate: {
      now: NOW,
      finalizer: "seoseo",
      finalRuntimeMutationExecutorGateReference: "final-runtime-mutation-executor-gate-798",
    },
  };

  assert.equal(extractTerminalBriefSidecarDefaultOnFinalRuntimeMutationExecutorGateEvidence(input).state, "accepted");
  assert.deepEqual(extractTerminalBriefSidecarDefaultOnFinalRuntimeMutationExecutorGateOptions(input), {
    now: NOW,
    finalizer: "seoseo",
    finalRuntimeMutationExecutorGateReference: "final-runtime-mutation-executor-gate-798",
  });

  const packet = buildTerminalBriefSidecarDefaultOnFinalRuntimeMutationExecutorGate(
    extractTerminalBriefSidecarDefaultOnFinalRuntimeMutationExecutorGateEvidence(input),
    extractTerminalBriefSidecarDefaultOnFinalRuntimeMutationExecutorGateOptions(input),
  );
  const markdown = renderTerminalBriefSidecarDefaultOnFinalRuntimeMutationExecutorGateMarkdown(packet);

  assert.match(markdown, /Ready: Terminal Brief default-on final runtime mutation executor gate/);
  assert.match(markdown, /checkpointCreationPermitted=false/);
  assert.match(markdown, /configWritePermitted=false/);
  assert.match(markdown, /does not create checkpoints, execute rollback, write config, enable default-on/);
});
