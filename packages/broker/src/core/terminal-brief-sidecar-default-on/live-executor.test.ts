import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import type { TerminalBriefSidecarDefaultOnFinalRuntimeMutationExecutorGatePacket } from "./final-runtime-mutation-executor-gate.js";
import {
  buildTerminalBriefSidecarDefaultOnFinalRuntimeMutationExecutorGate,
  extractTerminalBriefSidecarDefaultOnFinalRuntimeMutationExecutorGateEvidence,
  extractTerminalBriefSidecarDefaultOnFinalRuntimeMutationExecutorGateOptions,
} from "./final-runtime-mutation-executor-gate.js";
import {
  buildTerminalBriefSidecarDefaultOnLiveExecutor,
  extractTerminalBriefSidecarDefaultOnLiveExecutorGate,
  extractTerminalBriefSidecarDefaultOnLiveExecutorOptions,
  renderTerminalBriefSidecarDefaultOnLiveExecutorMarkdown,
} from "./live-executor.js";

const NOW = "2026-05-19T11:40:00.000Z";

function fixtureInput(): Record<string, unknown> {
  return JSON.parse(readFileSync(
    join(process.cwd(), "fixtures/terminal-brief/sidecar-default-on-execution-window-approval-evidence-ingestor.no-live.json"),
    "utf8",
  )) as Record<string, unknown>;
}

function readyGate(): TerminalBriefSidecarDefaultOnFinalRuntimeMutationExecutorGatePacket {
  const input = fixtureInput();
  return buildTerminalBriefSidecarDefaultOnFinalRuntimeMutationExecutorGate(
    extractTerminalBriefSidecarDefaultOnFinalRuntimeMutationExecutorGateEvidence(input),
    { ...extractTerminalBriefSidecarDefaultOnFinalRuntimeMutationExecutorGateOptions(input), now: NOW },
  );
}

test("live executor becomes review-ready from final runtime gate while awaiting final approval", () => {
  const packet = buildTerminalBriefSidecarDefaultOnLiveExecutor(readyGate(), { now: NOW });

  assert.equal(packet.kind, "a2a-broker.terminal-brief-sidecar-default-on-live-executor.packet");
  assert.equal(packet.state, "awaiting_final_live_execution_approval");
  assert.equal(packet.sourceOnlyNoLive, true);
  assert.equal(packet.source.finalRuntimeMutationExecutorGateReady, true);
  assert.equal(packet.source.finalRuntimeMutationExecutorGateState, "ready_for_final_runtime_mutation_executor_review");
  assert.equal(packet.source.configKey, "TERMINAL_BRIEF_SIDECAR_DEFAULT_ON");
  assert.equal(packet.liveExecutor.liveExecutorAvailable, true);
  assert.equal(packet.liveExecutor.failClosed, true);
  assert.equal(packet.liveExecutor.finalLiveExecutionApprovalRequired, true);
  assert.equal(packet.liveExecutor.finalLiveExecutionApprovalAccepted, false);
  assert.equal(packet.liveExecutor.executionArmed, false);
  assert.equal(packet.liveExecutor.executionPerformed, false);
  assert.equal(packet.liveExecutor.operations.length, 4);
  assert.equal(packet.liveExecutor.operations.every((operation) => operation.permitted === false), true);
  assert.equal(packet.liveExecutor.operations.every((operation) => operation.performed === false), true);
  assert.equal(packet.liveExecutor.operations.every((operation) => operation.requiresFinalApproval === true), true);
  assert.equal(packet.readiness.liveExecutorReviewReady, true);
  assert.equal(packet.readiness.finalLiveExecutionApprovalRequired, true);
  assert.equal(packet.readiness.finalLiveExecutionApprovalAccepted, false);
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
  assert.equal(packet.readiness.missingEvidence.includes("final_live_execution_approval"), true);
  assert.equal(packet.integrationContract.createsCheckpoint, false);
  assert.equal(packet.integrationContract.executesRollback, false);
  assert.equal(packet.integrationContract.writesConfig, false);
  assert.equal(packet.integrationContract.enablesDefaultOn, false);
  assert.equal(packet.integrationContract.dispatchesStartExecutor, false);
  assert.equal(packet.integrationContract.invokesExecutor, false);
  assert.equal(packet.integrationContract.spawnsProcess, false);
  assert.equal(packet.integrationContract.executesAction, false);
  assert.equal(packet.semantics.liveExecutorDoesNotExecuteWithoutFinalApproval, true);
  assert.equal(packet.semantics.finalApprovalStillRequired, true);
  assert.equal(packet.semantics.gateDoesNotCreateCheckpoint, true);
  assert.equal(packet.semantics.gateDoesNotWriteConfig, true);
  assert.equal(packet.semantics.gateDoesNotEnableDefaultOn, true);
  assert.equal(packet.semantics.defaultOnNotEnabledByThisPacket, true);
});

test("live executor maps non-ready source gate states without arming execution", () => {
  const base = readyGate();
  const waiting = buildTerminalBriefSidecarDefaultOnLiveExecutor({ ...base, state: "waiting_for_execution_window_approval_evidence" }, { now: NOW });
  const rejected = buildTerminalBriefSidecarDefaultOnLiveExecutor({ ...base, state: "approval_rejected" }, { now: NOW });
  const stale = buildTerminalBriefSidecarDefaultOnLiveExecutor({ ...base, state: "stale" }, { now: NOW });
  const conflicting = buildTerminalBriefSidecarDefaultOnLiveExecutor({ ...base, state: "conflicting" }, { now: NOW });

  assert.equal(waiting.state, "waiting_for_final_runtime_mutation_executor_gate");
  assert.equal(rejected.state, "approval_rejected");
  assert.equal(stale.state, "stale");
  assert.equal(conflicting.state, "conflicting");
  assert.equal(waiting.readiness.missingEvidence.includes("ready_final_runtime_mutation_executor_gate"), true);
  assert.equal(rejected.readiness.executionArmed, false);
  assert.equal(stale.readiness.configWritePermitted, false);
  assert.equal(conflicting.readiness.processSpawnPermitted, false);
});

test("live executor blocks unsafe source gate drift", () => {
  const unsafe = readyGate();
  unsafe.readiness.configWritePermitted = true as never;
  unsafe.integrationContract.executesAction = true as never;
  unsafe.semantics.gateDoesNotSpawnProcess = false as never;

  const packet = buildTerminalBriefSidecarDefaultOnLiveExecutor(unsafe, { now: NOW });

  assert.equal(packet.state, "blocked");
  assert.equal(packet.blockers.some((blocker) => blocker.includes("config write")), true);
  assert.equal(packet.blockers.some((blocker) => blocker.includes("executes action")), true);
  assert.equal(packet.blockers.some((blocker) => blocker.includes("gate does not spawn process")), true);
  assert.equal(packet.readiness.liveExecutorReviewReady, false);
  assert.equal(packet.readiness.configWritePermitted, false);
  assert.equal(packet.readiness.executionPermitted, false);
  assert.equal(packet.readiness.executionArmed, false);
});

test("live executor extractors can consume raw approval fixture and preserve no-live boundary", () => {
  const input = {
    ...fixtureInput(),
    defaultOnLiveExecutor: {
      now: NOW,
      finalizer: "brokeralpha",
      liveExecutorReference: "live-executor-800",
    },
  };

  assert.equal(extractTerminalBriefSidecarDefaultOnLiveExecutorGate(input).state, "ready_for_final_runtime_mutation_executor_review");
  assert.deepEqual(extractTerminalBriefSidecarDefaultOnLiveExecutorOptions(input), {
    now: NOW,
    finalizer: "brokeralpha",
    liveExecutorReference: "live-executor-800",
  });

  const packet = buildTerminalBriefSidecarDefaultOnLiveExecutor(
    extractTerminalBriefSidecarDefaultOnLiveExecutorGate(input),
    extractTerminalBriefSidecarDefaultOnLiveExecutorOptions(input),
  );
  const markdown = renderTerminalBriefSidecarDefaultOnLiveExecutorMarkdown(packet);

  assert.match(markdown, /Awaiting approval: Terminal Brief default-on live executor/);
  assert.match(markdown, /finalLiveExecutionApprovalAccepted=false/);
  assert.match(markdown, /configWritePermitted=false/);
  assert.match(markdown, /does not create checkpoints, execute rollback, write config, enable default-on/);
});
