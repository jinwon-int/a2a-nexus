import assert from "node:assert/strict";
import test from "node:test";

import type { TerminalBriefSidecarBoundedDryRunObservationPacket } from "./terminal-brief-sidecar-default-on-candidate-final-gate.js";
import {
  buildTerminalBriefSidecarDefaultOnCandidateFinalGate,
  extractTerminalBriefSidecarDefaultOnCandidateFinalGateObservation,
  extractTerminalBriefSidecarDefaultOnCandidateFinalGateOptions,
  renderTerminalBriefSidecarDefaultOnCandidateFinalGateMarkdown,
} from "./terminal-brief-sidecar-default-on-candidate-final-gate.js";

const NOW = "2026-05-19T03:31:00.000Z";

function observation(overrides: Partial<TerminalBriefSidecarBoundedDryRunObservationPacket> = {}): TerminalBriefSidecarBoundedDryRunObservationPacket {
  return {
    kind: "brokeralpha.terminal-brief-sidecar-bounded-dry-run-observation",
    generatedAt: NOW,
    operatorInstructionReference: "telegram:1000000001:53345",
    windowSeconds: 300,
    state: "bounded_dry_run_observation_passed",
    blockers: [],
    summary: {
      processCount: 1,
      nRestarts: "0",
      spoolBefore: 2,
      spoolAfter: 2,
      spoolDelta: 0,
      cursorBefore: "178 1779161103",
      cursorAfter: "178 1779161403",
      brokerOk: true,
      gatewayReady: true,
      gatewayEventLoopDegraded: false,
    },
    safety: {
      dryRunOnly: true,
      spoolOnly: true,
      liveProviderSendPermitted: false,
      terminalAckPermitted: false,
      dbMutationPermitted: false,
      defaultOnPermitted: false,
      processSpawnPerformed: false,
      sidecarRestartPerformed: false,
    },
    ...overrides,
  };
}

test("default-on candidate final gate becomes ready from passing bounded observation without enabling default-on", () => {
  const packet = buildTerminalBriefSidecarDefaultOnCandidateFinalGate(observation(), {
    now: NOW,
    reviewOwner: "broker-finalizer",
    minObservationSeconds: 300,
  });

  assert.equal(packet.kind, "a2a-broker.terminal-brief-sidecar-default-on-candidate-final-gate.packet");
  assert.equal(packet.state, "ready_for_default_on_candidate_review");
  assert.equal(packet.readiness.finalGateReady, true);
  assert.equal(packet.candidateGate.defaultOnCandidate, true);
  assert.equal(packet.candidateGate.defaultOnEnabled, false);
  assert.equal(packet.readiness.defaultOnPermitted, false);
  assert.equal(packet.readiness.providerSendPermitted, false);
  assert.equal(packet.readiness.terminalAckPermitted, false);
  assert.equal(packet.readiness.dbMutationPermitted, false);
  assert.equal(packet.readiness.processSpawnPermitted, false);
  assert.equal(packet.readiness.sidecarStartPermitted, false);
  assert.equal(packet.integrationContract.enablesDefaultOn, false);
  assert.equal(packet.integrationContract.sendsProvider, false);
  assert.equal(packet.integrationContract.performsTerminalAck, false);
  assert.equal(packet.integrationContract.mutatesDb, false);
  assert.equal(packet.semantics.candidateDoesNotEnableDefaultOn, true);
  assert.equal(packet.semantics.observationDoesNotAuthorizeLiveSend, true);
  assert.equal(packet.blockers.length, 0);
});

test("default-on candidate final gate blocks unsafe observation evidence", () => {
  const packet = buildTerminalBriefSidecarDefaultOnCandidateFinalGate(observation({
    summary: {
      ...observation().summary!,
      spoolAfter: 3,
      spoolDelta: 1,
    },
  }), { now: NOW });

  assert.equal(packet.state, "blocked");
  assert.equal(packet.readiness.finalGateReady, false);
  assert.equal(packet.blockers.includes("spool delta is not zero"), true);
  assert.equal(packet.readiness.defaultOnPermitted, false);
  assert.equal(packet.readiness.providerSendPermitted, false);
});

test("default-on candidate final gate waits for a non-passing observation", () => {
  const packet = buildTerminalBriefSidecarDefaultOnCandidateFinalGate(observation({
    state: "blocked",
    blockers: ["gateway readyz not ready"],
  }), { now: NOW });

  assert.equal(packet.state, "waiting_for_bounded_observation");
  assert.equal(packet.readiness.missingEvidence.includes("passing_bounded_dry_run_observation"), true);
  assert.equal(packet.readiness.defaultOnPermitted, false);
});

test("default-on candidate final gate extracts observation and options from envelopes", () => {
  const input = {
    observationPacket: observation(),
    defaultOnCandidateFinalGate: {
      mode: "review",
      minObservationSeconds: 120,
      gateReference: "gate-1",
    },
  };

  assert.equal(extractTerminalBriefSidecarDefaultOnCandidateFinalGateObservation(input).kind, "brokeralpha.terminal-brief-sidecar-bounded-dry-run-observation");
  assert.deepEqual(extractTerminalBriefSidecarDefaultOnCandidateFinalGateOptions(input), input.defaultOnCandidateFinalGate);
});

test("default-on candidate final gate renders markdown with safety boundary", () => {
  const packet = buildTerminalBriefSidecarDefaultOnCandidateFinalGate(observation(), { now: NOW });
  const markdown = renderTerminalBriefSidecarDefaultOnCandidateFinalGateMarkdown(packet);

  assert.match(markdown, /Ready: Terminal Brief default-on candidate final gate/);
  assert.match(markdown, /defaultOnPermitted=false/);
  assert.match(markdown, /does not enable default-on/);
});
