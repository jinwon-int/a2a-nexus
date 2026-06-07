import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildA2AWorkModeDecisionEvidence,
  buildA2AWorkModePreDispatchDecision,
  extractA2AWorkModePreDispatchDecisionInput,
  renderA2AWorkModePreDispatchDecisionMarkdown,
} from "./work-mode-pre-dispatch-decision.js";

const NOW = "2026-06-06T21:00:00.000Z";

test("narrow known-path work defaults to solo", () => {
  const fixture = JSON.parse(readFileSync("fixtures/work-mode-pre-dispatch/solo-known-path.json", "utf8"));
  const packet = buildA2AWorkModePreDispatchDecision({ ...fixture, now: NOW });

  assert.equal(packet.kind, "a2a-broker.work-mode-pre-dispatch-decision.packet");
  assert.equal(packet.recommendation.mode, "solo");
  assert.equal(packet.recommendation.confidence, "high");
  assert.equal(packet.recommendation.workerDispatchAllowedByThisPacket, false);
  assert.equal(packet.safetyBoundaries.serviceRestart, false);
  assert.equal(packet.safetyBoundaries.terminalAckOrReplay, false);
});

test("candidate review with healthy workers recommends Team1 evidence", () => {
  const fixture = JSON.parse(readFileSync("fixtures/work-mode-pre-dispatch/team1-candidate-review.json", "utf8"));
  const packet = buildA2AWorkModePreDispatchDecision({ ...fixture, now: NOW });

  assert.equal(packet.recommendation.mode, "team1");
  assert.equal(packet.recommendation.confidence, "high");
  assert.equal(packet.recommendation.evidenceOnlyHelpers, true);
  assert.equal(packet.recommendation.requiredDispatchFlags.includes("one-finalizer-required"), true);
  assert.equal(packet.recommendation.requiredDispatchFlags.includes("safe-parent-wording"), true);
  assert.equal(packet.recommendation.finalizerOwner, "seoseo");
});

test("Team1 decision evidence preserves finalizer and capacity snapshot provenance", () => {
  const fixture = JSON.parse(readFileSync("fixtures/work-mode-pre-dispatch/team1-candidate-review.json", "utf8"));
  const packet = buildA2AWorkModePreDispatchDecision({
    ...fixture,
    now: NOW,
    workers: {
      ...fixture.workers,
      snapshotSource: "/workers/capacity",
      snapshotAt: "2026-06-06T20:59:00.000Z",
    },
  });
  const evidence = buildA2AWorkModeDecisionEvidence(packet);

  assert.equal(evidence.mode, "team1");
  assert.equal(evidence.finalizerOwner, "seoseo");
  assert.equal(evidence.capacityState, "healthy");
  assert.equal(evidence.capacitySnapshotSource, "/workers/capacity");
  assert.equal(evidence.capacitySnapshotAt, "2026-06-06T20:59:00.000Z");
  assert.equal(evidence.sourceOnlyDecision, true);
  assert.equal(evidence.workerDispatchAllowedByThisPacket, false);
});

test("live or sensitive boundaries force solo finalizer ownership", () => {
  const packet = buildA2AWorkModePreDispatchDecision({
    now: NOW,
    task: {
      taskId: "runtime-boundary",
      workProfile: "live_or_sensitive_boundary",
      ambiguity: "high",
      hasIndependentEvidenceLanes: true,
      hasMultipleCandidates: true,
    },
    workers: { capacityState: "healthy" },
    boundaries: { liveDeployOrRestart: true, credentialOrSecretChange: true },
  });

  assert.equal(packet.recommendation.mode, "solo");
  assert.equal(packet.recommendation.confidence, "high");
  assert.equal(packet.recommendation.blockers.includes("approval_sensitive_runtime_or_external_boundary"), true);
  assert.equal(packet.nextAction.includes("do not dispatch helpers"), true);
});

test("late supplemental review recommends hybrid when scoped and healthy", () => {
  const fixture = JSON.parse(readFileSync("fixtures/work-mode-pre-dispatch/hybrid-supplemental-review.json", "utf8"));
  const packet = buildA2AWorkModePreDispatchDecision({ ...fixture, now: NOW });

  assert.equal(packet.recommendation.mode, "hybrid");
  assert.equal(packet.recommendation.evidenceOnlyHelpers, true);
  assert.equal(packet.nextAction.includes("bounded hybrid helper request"), true);
});

test("unhealthy worker state forces solo even for ambiguous work", () => {
  const packet = buildA2AWorkModePreDispatchDecision({
    now: NOW,
    task: {
      taskId: "ambiguous-rca",
      workProfile: "ambiguous_rca",
      ambiguity: "high",
      hasIndependentEvidenceLanes: true,
      desiredOptimization: "confidence",
    },
    workers: { capacityState: "stale", staleTasks: 2 },
  });

  assert.equal(packet.recommendation.mode, "solo");
  assert.equal(packet.recommendation.blockers.includes("worker_capacity_stale"), true);
  assert.equal(packet.recommendation.blockers.includes("worker_stale_tasks_present"), true);
});

test("extractor accepts snake_case route envelope and markdown is explicit about no dispatch", () => {
  const input = extractA2AWorkModePreDispatchDecisionInput({
    work_mode_pre_dispatch_decision: {
      now: NOW,
      task: {
        task_id: "route-1",
        work_profile: "candidate_review",
        has_independent_evidence_lanes: true,
        has_multiple_candidates: true,
      },
      workers: { capacity_state: "healthy", stale_tasks: 0 },
      finalizer_owner: "seoseo",
    },
  });
  const packet = buildA2AWorkModePreDispatchDecision(input);
  const markdown = renderA2AWorkModePreDispatchDecisionMarkdown(packet);

  assert.equal(packet.generatedAt, NOW);
  assert.equal(packet.task.taskId, "route-1");
  assert.equal(packet.recommendation.mode, "team1");
  assert.equal(markdown.includes("No worker dispatch"), true);
  assert.equal(markdown.includes("workerDispatchAllowedByThisPacket**: false"), true);
});
