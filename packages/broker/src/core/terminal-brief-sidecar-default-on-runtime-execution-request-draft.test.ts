import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import type { TerminalBriefSidecarDefaultOnRuntimeExecutionFinalGatePacket } from "./terminal-brief-sidecar-default-on-runtime-execution-final-gate.js";
import {
  buildTerminalBriefSidecarDefaultOnRuntimeExecutionFinalGate,
  extractTerminalBriefSidecarDefaultOnRuntimeExecutionFinalGateEvidence,
  extractTerminalBriefSidecarDefaultOnRuntimeExecutionFinalGateOptions,
} from "./terminal-brief-sidecar-default-on-runtime-execution-final-gate.js";
import {
  buildTerminalBriefSidecarDefaultOnRuntimeExecutionRequestDraft,
  extractTerminalBriefSidecarDefaultOnRuntimeExecutionRequestDraftFinalGate,
  extractTerminalBriefSidecarDefaultOnRuntimeExecutionRequestDraftOptions,
  renderTerminalBriefSidecarDefaultOnRuntimeExecutionRequestDraftMarkdown,
} from "./terminal-brief-sidecar-default-on-runtime-execution-request-draft.js";

const NOW = "2026-05-19T07:40:00.000Z";

function fixtureInput(): Record<string, unknown> {
  return JSON.parse(readFileSync(
    join(process.cwd(), "fixtures/terminal-brief/sidecar-default-on-runtime-execution-final-gate.no-live.json"),
    "utf8",
  )) as Record<string, unknown>;
}

function readyFinalGate(): TerminalBriefSidecarDefaultOnRuntimeExecutionFinalGatePacket {
  const input = fixtureInput();
  return buildTerminalBriefSidecarDefaultOnRuntimeExecutionFinalGate(
    extractTerminalBriefSidecarDefaultOnRuntimeExecutionFinalGateEvidence(input),
    { ...extractTerminalBriefSidecarDefaultOnRuntimeExecutionFinalGateOptions(input), now: NOW },
  );
}

test("default-on runtime execution request draft becomes ready from final gate without permitting execution", () => {
  const packet = buildTerminalBriefSidecarDefaultOnRuntimeExecutionRequestDraft(readyFinalGate(), {
    now: NOW,
    requestedBy: "brokeralpha",
    operatorTarget: "terminal-brief-default-on",
    operatorChannel: "telegram-direct",
    executionRequestReference: "tb-sidecar-default-on-runtime-execution-request:fixture-786",
  });

  assert.equal(packet.kind, "a2a-broker.terminal-brief-sidecar-default-on-runtime-execution-request-draft.packet");
  assert.equal(packet.state, "runtime_execution_request_draft_ready");
  assert.equal(packet.sourceOnlyNoLive, true);
  assert.equal(packet.source.runtimeExecutionFinalGateReady, true);
  assert.equal(packet.source.gateReady, true);
  assert.equal(packet.source.configKey, "TERMINAL_BRIEF_SIDECAR_DEFAULT_ON");
  assert.equal(packet.executionRequestDraft.status, "draft_not_sent");
  assert.equal(packet.executionRequestDraft.dispatchRequired, true);
  assert.equal(packet.executionRequestDraft.dispatchPermitted, false);
  assert.equal(packet.executionRequestDraft.requiredReply, "execute default-on runtime mutation 승인");
  assert.equal(packet.readiness.runtimeExecutionRequestDraftReady, true);
  assert.equal(packet.readiness.runtimeExecutionRequestDispatchPermitted, false);
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
  assert.equal(packet.integrationContract.writesConfig, false);
  assert.equal(packet.integrationContract.enablesDefaultOn, false);
  assert.equal(packet.integrationContract.dispatchesStartExecutor, false);
  assert.equal(packet.integrationContract.invokesExecutor, false);
  assert.equal(packet.integrationContract.executesAction, false);
  assert.equal(packet.semantics.requestDoesNotExecuteRuntimeMutation, true);
  assert.equal(packet.semantics.requestDoesNotWriteConfig, true);
  assert.equal(packet.semantics.requestDoesNotEnableDefaultOn, true);
  assert.equal(packet.semantics.requestDoesNotRestartSidecar, true);
  assert.equal(packet.semantics.executionNotPermitted, true);
});

test("default-on runtime execution request draft waits for non-ready final gate states", () => {
  const base = readyFinalGate();
  const waiting = buildTerminalBriefSidecarDefaultOnRuntimeExecutionRequestDraft(
    { ...base, state: "waiting_for_execution_approval_evidence" },
    { now: NOW },
  );
  const rejected = buildTerminalBriefSidecarDefaultOnRuntimeExecutionRequestDraft({ ...base, state: "approval_rejected" }, { now: NOW });
  const stale = buildTerminalBriefSidecarDefaultOnRuntimeExecutionRequestDraft({ ...base, state: "stale" }, { now: NOW });
  const conflicting = buildTerminalBriefSidecarDefaultOnRuntimeExecutionRequestDraft({ ...base, state: "conflicting" }, { now: NOW });

  assert.equal(waiting.state, "waiting_for_runtime_execution_final_gate");
  assert.equal(rejected.state, "approval_rejected");
  assert.equal(stale.state, "stale");
  assert.equal(conflicting.state, "conflicting");
  assert.equal(waiting.readiness.missingEvidence.includes("ready_runtime_execution_final_gate"), true);
  assert.equal(rejected.readiness.defaultOnPermitted, false);
  assert.equal(stale.readiness.sidecarRestartPermitted, false);
  assert.equal(conflicting.readiness.executionPermitted, false);
});

test("default-on runtime execution request draft blocks unsafe final gate drift", () => {
  const unsafe = readyFinalGate();
  unsafe.readiness.configWritePermitted = true as never;
  unsafe.integrationContract.executesAction = true as never;
  const packet = buildTerminalBriefSidecarDefaultOnRuntimeExecutionRequestDraft(unsafe, { now: NOW });

  assert.equal(packet.state, "blocked");
  assert.equal(packet.blockers.some((blocker) => blocker.includes("config write")), true);
  assert.equal(packet.blockers.some((blocker) => blocker.includes("executes action")), true);
  assert.equal(packet.readiness.configWritePermitted, false);
  assert.equal(packet.readiness.executionPermitted, false);
});

test("default-on runtime execution request draft extractors and markdown preserve no-live boundary", () => {
  const input = {
    defaultOnRuntimeExecutionFinalGatePacket: readyFinalGate(),
    runtimeExecutionRequestDraft: {
      now: NOW,
      requestedBy: "brokeralpha",
      operatorTarget: "terminal-brief-default-on",
      executionRequestReference: "runtime-execution-request-786",
      approvalWindowMinutes: 30,
    },
  };

  assert.equal(extractTerminalBriefSidecarDefaultOnRuntimeExecutionRequestDraftFinalGate(input).state, "ready_for_runtime_execution_final_review");
  assert.deepEqual(extractTerminalBriefSidecarDefaultOnRuntimeExecutionRequestDraftOptions(input), {
    now: NOW,
    requestedBy: "brokeralpha",
    operatorTarget: "terminal-brief-default-on",
    executionRequestReference: "runtime-execution-request-786",
    approvalWindowMinutes: 30,
  });

  const packet = buildTerminalBriefSidecarDefaultOnRuntimeExecutionRequestDraft(
    extractTerminalBriefSidecarDefaultOnRuntimeExecutionRequestDraftFinalGate(input),
    extractTerminalBriefSidecarDefaultOnRuntimeExecutionRequestDraftOptions(input),
  );
  const markdown = renderTerminalBriefSidecarDefaultOnRuntimeExecutionRequestDraftMarkdown(packet);

  assert.match(markdown, /Ready: Terminal Brief default-on runtime execution request draft/);
  assert.match(markdown, /requiredReply="execute default-on runtime mutation 승인"/);
  assert.match(markdown, /configWritePermitted=false/);
  assert.match(markdown, /does not send the request, grant approval, write config, enable default-on/);
});
