import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  buildTerminalBriefSidecarDefaultOnFinalLiveExecution,
  extractTerminalBriefSidecarDefaultOnFinalLiveExecutionGate,
  extractTerminalBriefSidecarDefaultOnFinalLiveExecutionOptions,
  type TerminalBriefSidecarDefaultOnFinalLiveExecutionPacket,
} from "./final-live-execution.js";
import {
  buildTerminalBriefSidecarDefaultOnExecutionWindowRequestDraft,
  extractTerminalBriefSidecarDefaultOnExecutionWindowRequestDraftFinalLiveExecution,
  extractTerminalBriefSidecarDefaultOnExecutionWindowRequestDraftOptions,
  renderTerminalBriefSidecarDefaultOnExecutionWindowRequestDraftMarkdown,
} from "./execution-window-request-draft.js";

const NOW = "2026-05-19T09:50:00.000Z";

function readyFinalLiveExecution(): TerminalBriefSidecarDefaultOnFinalLiveExecutionPacket {
  const input = JSON.parse(readFileSync(
    join(process.cwd(), "fixtures/terminal-brief/sidecar-default-on-final-live-execution.no-live.json"),
    "utf8",
  )) as Record<string, unknown>;
  return buildTerminalBriefSidecarDefaultOnFinalLiveExecution(
    extractTerminalBriefSidecarDefaultOnFinalLiveExecutionGate(input),
    extractTerminalBriefSidecarDefaultOnFinalLiveExecutionOptions(input),
  );
}

test("default-on execution window request draft becomes ready without sending request or permitting mutation", () => {
  const packet = buildTerminalBriefSidecarDefaultOnExecutionWindowRequestDraft(readyFinalLiveExecution(), {
    now: NOW,
    requestedBy: "brokeralpha",
    operatorTarget: "terminal-brief-default-on",
    executionWindowReference: "tb-sidecar-default-on-execution-window:fixture-794",
    approvalWindowMinutes: 10,
  });

  assert.equal(packet.kind, "a2a-broker.terminal-brief-sidecar-default-on-execution-window-request-draft.packet");
  assert.equal(packet.state, "execution_window_request_draft_ready");
  assert.equal(packet.sourceOnlyNoLive, true);
  assert.equal(packet.source.finalLiveExecutionReviewReady, true);
  assert.equal(packet.executionWindowRequestDraft.status, "draft_not_sent");
  assert.equal(packet.executionWindowRequestDraft.requiredReply, "fresh operator execution window 승인");
  assert.equal(packet.executionWindowRequestDraft.dispatchPermitted, false);
  assert.equal(packet.executionWindowRequestDraft.checkpointCreationPermitted, false);
  assert.equal(packet.executionWindowRequestDraft.runtimeMutationPermitted, false);
  assert.equal(packet.executionWindowRequestDraft.configWritePermitted, false);
  assert.equal(packet.executionWindowRequestDraft.defaultOnPermitted, false);
  assert.equal(packet.executionWindowRequestDraft.sidecarRestartPermitted, false);
  assert.equal(packet.executionWindowRequestDraft.startExecutorDispatchPermitted, false);
  assert.equal(packet.executionWindowRequestDraft.executorInvocationPermitted, false);
  assert.equal(packet.executionWindowRequestDraft.executionPermitted, false);
  assert.equal(packet.executionWindowRequestDraft.processSpawnPermitted, false);
  assert.equal(packet.readiness.executionWindowRequestDraftReady, true);
  assert.equal(packet.readiness.executionWindowRequestDispatchPermitted, false);
  assert.equal(packet.readiness.checkpointCreationPermitted, false);
  assert.equal(packet.readiness.rollbackExecutionPermitted, false);
  assert.equal(packet.readiness.configWritePermitted, false);
  assert.equal(packet.readiness.defaultOnPermitted, false);
  assert.equal(packet.readiness.sidecarRestartPermitted, false);
  assert.equal(packet.readiness.providerSendPermitted, false);
  assert.equal(packet.readiness.terminalAckPermitted, false);
  assert.equal(packet.readiness.dbMutationPermitted, false);
  assert.equal(packet.readiness.taskFlowMutationPermitted, false);
  assert.equal(packet.readiness.executionPermitted, false);
  assert.equal(packet.readiness.processSpawnPermitted, false);
  assert.equal(packet.integrationContract.sendsExecutionWindowRequest, false);
  assert.equal(packet.integrationContract.createsCheckpoint, false);
  assert.equal(packet.integrationContract.writesConfig, false);
  assert.equal(packet.integrationContract.enablesDefaultOn, false);
  assert.equal(packet.integrationContract.restartsSidecar, false);
  assert.equal(packet.integrationContract.invokesExecutor, false);
  assert.equal(packet.integrationContract.executesAction, false);
  assert.equal(packet.semantics.requestDoesNotCreateCheckpoint, true);
  assert.equal(packet.semantics.requestDoesNotWriteConfig, true);
  assert.equal(packet.semantics.requestDoesNotEnableDefaultOn, true);
});

test("default-on execution window request draft waits for non-ready final live execution states", () => {
  const base = readyFinalLiveExecution();
  const waiting = buildTerminalBriefSidecarDefaultOnExecutionWindowRequestDraft(
    { ...base, state: "waiting_for_runtime_executor_gate" },
    { now: NOW },
  );
  const rejected = buildTerminalBriefSidecarDefaultOnExecutionWindowRequestDraft({ ...base, state: "approval_rejected" }, { now: NOW });
  const stale = buildTerminalBriefSidecarDefaultOnExecutionWindowRequestDraft({ ...base, state: "stale" }, { now: NOW });
  const conflicting = buildTerminalBriefSidecarDefaultOnExecutionWindowRequestDraft({ ...base, state: "conflicting" }, { now: NOW });

  assert.equal(waiting.state, "waiting_for_final_live_execution_review");
  assert.equal(rejected.state, "approval_rejected");
  assert.equal(stale.state, "stale");
  assert.equal(conflicting.state, "conflicting");
  assert.equal(waiting.readiness.missingEvidence.includes("ready_final_live_execution_packet"), true);
  assert.equal(rejected.readiness.configWritePermitted, false);
  assert.equal(stale.readiness.checkpointCreationPermitted, false);
  assert.equal(conflicting.readiness.executionPermitted, false);
});

test("default-on execution window request draft blocks unsafe final live execution drift", () => {
  const unsafe = readyFinalLiveExecution();
  unsafe.readiness.configWritePermitted = true as never;
  unsafe.integrationContract.createsCheckpoint = true as never;
  const packet = buildTerminalBriefSidecarDefaultOnExecutionWindowRequestDraft(unsafe, { now: NOW });

  assert.equal(packet.state, "blocked");
  assert.equal(packet.blockers.some((blocker) => blocker.includes("config write")), true);
  assert.equal(packet.blockers.some((blocker) => blocker.includes("creates checkpoint")), true);
  assert.equal(packet.readiness.configWritePermitted, false);
  assert.equal(packet.readiness.checkpointCreationPermitted, false);
});

test("default-on execution window request extractors and markdown preserve no-live boundary", () => {
  const input = {
    defaultOnFinalLiveExecutionPacket: readyFinalLiveExecution(),
    executionWindowRequestDraft: {
      now: NOW,
      requestedBy: "brokeralpha",
      executionWindowReference: "tb-sidecar-default-on-execution-window:fixture-794",
      approvalWindowMinutes: 10,
    },
  };

  assert.equal(
    extractTerminalBriefSidecarDefaultOnExecutionWindowRequestDraftFinalLiveExecution(input).state,
    "ready_for_final_live_execution_review",
  );
  assert.deepEqual(extractTerminalBriefSidecarDefaultOnExecutionWindowRequestDraftOptions(input), {
    now: NOW,
    requestedBy: "brokeralpha",
    executionWindowReference: "tb-sidecar-default-on-execution-window:fixture-794",
    approvalWindowMinutes: 10,
  });

  const packet = buildTerminalBriefSidecarDefaultOnExecutionWindowRequestDraft(
    extractTerminalBriefSidecarDefaultOnExecutionWindowRequestDraftFinalLiveExecution(input),
    extractTerminalBriefSidecarDefaultOnExecutionWindowRequestDraftOptions(input),
  );
  const markdown = renderTerminalBriefSidecarDefaultOnExecutionWindowRequestDraftMarkdown(packet);

  assert.match(markdown, /Ready: Terminal Brief default-on execution window request draft/);
  assert.match(markdown, /requiredReply="fresh operator execution window 승인"/);
  assert.match(markdown, /checkpointCreationPermitted=false/);
  assert.match(markdown, /does not send the request, grant approval, create checkpoint/);
});
