import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import type { TerminalBriefSidecarDefaultOnRuntimeExecutorGatePacket } from "./terminal-brief-sidecar-default-on-runtime-executor-gate.js";
import {
  buildTerminalBriefSidecarDefaultOnRuntimeExecutorGate,
  extractTerminalBriefSidecarDefaultOnRuntimeExecutorGateEvidence,
  extractTerminalBriefSidecarDefaultOnRuntimeExecutorGateOptions,
} from "./terminal-brief-sidecar-default-on-runtime-executor-gate.js";
import {
  buildTerminalBriefSidecarDefaultOnFinalLiveExecution,
  extractTerminalBriefSidecarDefaultOnFinalLiveExecutionGate,
  extractTerminalBriefSidecarDefaultOnFinalLiveExecutionOptions,
  renderTerminalBriefSidecarDefaultOnFinalLiveExecutionMarkdown,
} from "./terminal-brief-sidecar-default-on-final-live-execution.js";

const NOW = "2026-05-19T09:05:00.000Z";

function fixtureInput(): Record<string, unknown> {
  return JSON.parse(readFileSync(
    join(process.cwd(), "fixtures/terminal-brief/sidecar-default-on-runtime-executor-gate.no-live.json"),
    "utf8",
  )) as Record<string, unknown>;
}

function readyGate(): TerminalBriefSidecarDefaultOnRuntimeExecutorGatePacket {
  const input = fixtureInput();
  return buildTerminalBriefSidecarDefaultOnRuntimeExecutorGate(
    extractTerminalBriefSidecarDefaultOnRuntimeExecutorGateEvidence(input),
    extractTerminalBriefSidecarDefaultOnRuntimeExecutorGateOptions(input),
  );
}

test("default-on final live execution packet becomes review-ready without permitting execution", () => {
  const packet = buildTerminalBriefSidecarDefaultOnFinalLiveExecution(readyGate(), {
    now: NOW,
    finalizer: "seoseo",
    checkpointReference: "checkpoint-792",
    targetConfigFile: "/root/.openclaw/a2a-broker/terminal-brief-sidecar.env",
    backupLocation: "/root/.openclaw/a2a-broker/terminal-brief-sidecar.env.pre-default-on.fixture-792.bak",
    executionCommand: "set TERMINAL_BRIEF_SIDECAR_DEFAULT_ON=true in approved config",
    rollbackCommand: "restore checkpoint backup to approved config",
  });

  assert.equal(packet.kind, "a2a-broker.terminal-brief-sidecar-default-on-final-live-execution.packet");
  assert.equal(packet.state, "ready_for_final_live_execution_review");
  assert.equal(packet.sourceOnlyNoLive, true);
  assert.equal(packet.source.runtimeExecutorGateReady, true);
  assert.equal(packet.finalLiveExecution.reviewOnly, true);
  assert.equal(packet.finalLiveExecution.checkpoint.required, true);
  assert.equal(packet.finalLiveExecution.checkpoint.checkpointReference, "checkpoint-792");
  assert.equal(packet.finalLiveExecution.checkpoint.createsCheckpointInThisPacket, false);
  assert.equal(packet.finalLiveExecution.executionPlan.executesInThisPacket, false);
  assert.equal(packet.finalLiveExecution.executionPlan.containsSecretValues, false);
  assert.equal(packet.readiness.finalLiveExecutionReviewReady, true);
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
  assert.equal(packet.readiness.checkpointCreationPermitted, false);
  assert.equal(packet.readiness.rollbackExecutionPermitted, false);
  assert.equal(packet.integrationContract.writesConfig, false);
  assert.equal(packet.integrationContract.enablesDefaultOn, false);
  assert.equal(packet.integrationContract.createsCheckpoint, false);
  assert.equal(packet.integrationContract.executesRollback, false);
  assert.equal(packet.integrationContract.invokesExecutor, false);
  assert.equal(packet.integrationContract.executesAction, false);
  assert.equal(packet.semantics.packetDoesNotWriteConfig, true);
  assert.equal(packet.semantics.packetDoesNotEnableDefaultOn, true);
  assert.equal(packet.semantics.packetDoesNotCreateCheckpoint, true);
  assert.equal(packet.semantics.packetDoesNotExecuteRollback, true);
});

test("default-on final live execution packet waits for non-ready executor gate states", () => {
  const base = readyGate();
  const waiting = buildTerminalBriefSidecarDefaultOnFinalLiveExecution({ ...base, state: "waiting_for_runtime_execution_approval_evidence" }, { now: NOW });
  const rejected = buildTerminalBriefSidecarDefaultOnFinalLiveExecution({ ...base, state: "approval_rejected" }, { now: NOW });
  const stale = buildTerminalBriefSidecarDefaultOnFinalLiveExecution({ ...base, state: "stale" }, { now: NOW });
  const conflicting = buildTerminalBriefSidecarDefaultOnFinalLiveExecution({ ...base, state: "conflicting" }, { now: NOW });

  assert.equal(waiting.state, "waiting_for_runtime_executor_gate");
  assert.equal(rejected.state, "approval_rejected");
  assert.equal(stale.state, "stale");
  assert.equal(conflicting.state, "conflicting");
  assert.equal(waiting.readiness.missingEvidence.includes("ready_runtime_executor_gate"), true);
  assert.equal(rejected.readiness.defaultOnPermitted, false);
  assert.equal(stale.readiness.sidecarRestartPermitted, false);
  assert.equal(conflicting.readiness.executionPermitted, false);
});

test("default-on final live execution packet blocks unsafe source gate drift", () => {
  const unsafe = readyGate();
  unsafe.readiness.configWritePermitted = true as never;
  unsafe.integrationContract.invokesExecutor = true as never;
  const packet = buildTerminalBriefSidecarDefaultOnFinalLiveExecution(unsafe, { now: NOW });

  assert.equal(packet.state, "blocked");
  assert.equal(packet.blockers.some((blocker) => blocker.includes("config write")), true);
  assert.equal(packet.blockers.some((blocker) => blocker.includes("invokes executor")), true);
  assert.equal(packet.readiness.configWritePermitted, false);
  assert.equal(packet.readiness.executorInvocationPermitted, false);
});

test("default-on final live execution extractors and markdown preserve no-live boundary", () => {
  const input = {
    defaultOnRuntimeExecutorGatePacket: readyGate(),
    finalLiveExecution: {
      now: NOW,
      finalizer: "seoseo",
      checkpointReference: "checkpoint-792",
      targetConfigFile: "/root/.openclaw/a2a-broker/terminal-brief-sidecar.env",
    },
  };

  assert.equal(extractTerminalBriefSidecarDefaultOnFinalLiveExecutionGate(input).state, "ready_for_runtime_executor_review");
  assert.deepEqual(extractTerminalBriefSidecarDefaultOnFinalLiveExecutionOptions(input), {
    now: NOW,
    finalizer: "seoseo",
    checkpointReference: "checkpoint-792",
    targetConfigFile: "/root/.openclaw/a2a-broker/terminal-brief-sidecar.env",
  });

  const packet = buildTerminalBriefSidecarDefaultOnFinalLiveExecution(
    extractTerminalBriefSidecarDefaultOnFinalLiveExecutionGate(input),
    extractTerminalBriefSidecarDefaultOnFinalLiveExecutionOptions(input),
  );
  const markdown = renderTerminalBriefSidecarDefaultOnFinalLiveExecutionMarkdown(packet);

  assert.match(markdown, /Ready: Terminal Brief default-on final live execution packet/);
  assert.match(markdown, /configWritePermitted=false/);
  assert.match(markdown, /checkpointCreationPermitted=false/);
  assert.match(markdown, /does not write config, enable default-on/);
});
