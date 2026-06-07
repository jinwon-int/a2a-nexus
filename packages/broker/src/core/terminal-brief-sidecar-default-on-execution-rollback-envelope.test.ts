import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import type { TerminalBriefSidecarDefaultOnRuntimeMutationPlanPacket } from "./terminal-brief-sidecar-default-on-runtime-mutation-plan.js";
import {
  buildTerminalBriefSidecarDefaultOnExecutionRollbackEnvelope,
  extractTerminalBriefSidecarDefaultOnExecutionRollbackEnvelopeOptions,
  extractTerminalBriefSidecarDefaultOnExecutionRollbackEnvelopePlan,
  renderTerminalBriefSidecarDefaultOnExecutionRollbackEnvelopeMarkdown,
} from "./terminal-brief-sidecar-default-on-execution-rollback-envelope.js";

const NOW = "2026-05-19T06:05:00.000Z";

function runtimePlan(
  overrides: Partial<TerminalBriefSidecarDefaultOnRuntimeMutationPlanPacket> = {},
): TerminalBriefSidecarDefaultOnRuntimeMutationPlanPacket {
  const input = JSON.parse(readFileSync(
    join(process.cwd(), "fixtures/terminal-brief/sidecar-default-on-execution-rollback-envelope.no-live.json"),
    "utf8",
  )) as { defaultOnRuntimeMutationPlanPacket: TerminalBriefSidecarDefaultOnRuntimeMutationPlanPacket };
  return { ...input.defaultOnRuntimeMutationPlanPacket, ...overrides };
}

test("builds a source-only execution rollback envelope from a ready runtime mutation plan", () => {
  const packet = buildTerminalBriefSidecarDefaultOnExecutionRollbackEnvelope(runtimePlan(), {
    now: NOW,
    finalizer: "seoseo",
    executorId: "terminal-brief-default-on-runtime-executor",
  });

  assert.equal(packet.kind, "a2a-broker.terminal-brief-sidecar-default-on-execution-rollback-envelope.packet");
  assert.equal(packet.state, "ready_for_execution_approval_review");
  assert.equal(packet.sourceOnlyNoLive, true);
  assert.equal(packet.readiness.executionEnvelopeReady, true);
  assert.equal(packet.executionRollbackEnvelope.envelopeOnly, true);
  assert.equal(packet.source.configChangeApplied, false);
  assert.equal(packet.source.executionEnvelopeExecutable, false);
  assert.equal(packet.executionRollbackEnvelope.executionPlan.commandExecutable, false);
  assert.equal(packet.executionRollbackEnvelope.executionPlan.envValuesIncluded, false);
  assert.equal(packet.executionRollbackEnvelope.executionPlan.secretValuesIncluded, false);
  assert.equal(packet.executionRollbackEnvelope.rollbackPlan.rollbackExecutable, false);
  assert.equal(packet.readiness.executionApprovalRequestPermitted, false);
  assert.equal(packet.readiness.runtimeMutationPermitted, false);
  assert.equal(packet.readiness.configWritePermitted, false);
  assert.equal(packet.readiness.defaultOnPermitted, false);
  assert.equal(packet.readiness.providerSendPermitted, false);
  assert.equal(packet.readiness.terminalAckPermitted, false);
  assert.equal(packet.readiness.dbMutationPermitted, false);
  assert.equal(packet.readiness.taskFlowMutationPermitted, false);
  assert.equal(packet.readiness.executionPermitted, false);
  assert.equal(packet.readiness.processSpawnPermitted, false);
  assert.equal(packet.readiness.sidecarStartPermitted, false);
  assert.equal(packet.readiness.sidecarRestartPermitted, false);
  assert.equal(packet.readiness.brokerRestartPermitted, false);
  assert.equal(packet.integrationContract.writesConfig, false);
  assert.equal(packet.integrationContract.enablesDefaultOn, false);
  assert.equal(packet.semantics.envelopeDoesNotExecute, true);
  assert.equal(packet.semantics.envelopeDoesNotWriteConfig, true);
});

test("waits when runtime mutation plan is not ready", () => {
  const waitingPlan = runtimePlan({
    state: "waiting_for_enablement_gate",
    readiness: {
      ...runtimePlan().readiness,
      sourceCriteriaMet: false,
      runtimeMutationPlanReady: false,
    },
  });
  const packet = buildTerminalBriefSidecarDefaultOnExecutionRollbackEnvelope(waitingPlan, { now: NOW });

  assert.equal(packet.state, "waiting_for_runtime_mutation_plan");
  assert.equal(packet.readiness.executionEnvelopeReady, false);
  assert.equal(packet.readiness.missingEvidence.includes("ready_runtime_mutation_plan"), true);
  assert.equal(packet.readiness.configWritePermitted, false);
});

test("blocks if runtime mutation plan drifts into execution permission", () => {
  const unsafe = runtimePlan();
  unsafe.readiness.configWritePermitted = true as never;
  const packet = buildTerminalBriefSidecarDefaultOnExecutionRollbackEnvelope(unsafe, { now: NOW });

  assert.equal(packet.state, "blocked");
  assert.equal(packet.readiness.configWritePermitted, false);
  assert.match(packet.blockers.join("\n"), /unexpectedly permits config write/);
});

test("extracts runtime mutation plan and options from envelopes", () => {
  const input = {
    defaultOnRuntimeMutationPlanPacket: runtimePlan(),
    defaultOnExecutionRollbackEnvelope: {
      mode: "fixture",
      finalizer: "seoseo",
      envelopeReference: "envelope-1",
      executorId: "executor-1",
    },
  };

  assert.equal(extractTerminalBriefSidecarDefaultOnExecutionRollbackEnvelopePlan(input).kind, "a2a-broker.terminal-brief-sidecar-default-on-runtime-mutation-plan.packet");
  assert.deepEqual(extractTerminalBriefSidecarDefaultOnExecutionRollbackEnvelopeOptions(input), {
    now: undefined,
    mode: "fixture",
    finalizer: "seoseo",
    envelopeReference: "envelope-1",
    operatorInstructionReference: undefined,
    executorId: "executor-1",
  });
});

test("renders markdown with execution boundary", () => {
  const packet = buildTerminalBriefSidecarDefaultOnExecutionRollbackEnvelope(runtimePlan(), { now: NOW });
  const markdown = renderTerminalBriefSidecarDefaultOnExecutionRollbackEnvelopeMarkdown(packet);

  assert.match(markdown, /Ready: Terminal Brief default-on execution\/rollback envelope/);
  assert.match(markdown, /configWritePermitted=false/);
  assert.match(markdown, /does not execute/);
});
