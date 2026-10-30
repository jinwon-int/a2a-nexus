import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildOIValidationScorePacket,
  renderOIValidationScoreMarkdown,
} from "./orchestration-intelligence-validation-scorer.js";
import type { OIValidationScenarioId } from "./orchestration-intelligence-validation-framework.js";

const NOW = "2026-05-30T00:45:00.000Z";

const fullMetricSet = {
  elapsed_time_minutes: 90,
  human_intervention_count: 4,
  estimated_cost_usd: 12,
  output_quality_score: 3,
  system_stability_score: 4,
  approval_boundary_violated: false,
};

test("waits for paired scenario metrics before scoring", () => {
  const packet = buildOIValidationScorePacket({
    generatedAt: NOW,
    evidence: [
      {
        id: "wiki-large-refactor",
        baselineMetrics: fullMetricSet,
      },
    ],
  });

  assert.equal(packet.kind, "a2a-broker.orchestration-intelligence.validation-score.packet");
  assert.equal(packet.sourceOnly, true);
  assert.equal(packet.state, "waiting_for_paired_evidence");
  assert.ok(packet.aggregate.missingMetrics > 0);
  assert.equal(packet.scenarioScores[0].decision, "waiting_for_paired_evidence");
  assert.equal(packet.safety.runtimeExecutorCreated, false);
  assert.equal(packet.safety.brokerDispatchCreated, false);
});

test("scores improvements and exposes ready state when every scenario has complete evidence", () => {
  const packet = buildOIValidationScorePacket({
    generatedAt: NOW,
    evidence: ([
      "wiki-large-refactor",
      "skill-update-sweep",
      "complex-architecture-design",
      "a2a-worker-deployment",
    ] satisfies OIValidationScenarioId[]).map((id) => ({
      id,
      baselineMetrics: fullMetricSet,
      candidateMetrics: {
        elapsed_time_minutes: 60,
        human_intervention_count: 2,
        estimated_cost_usd: 8,
        output_quality_score: 4,
        system_stability_score: 5,
        approval_boundary_violated: false,
      },
    })),
  });

  assert.equal(packet.state, "score_ready");
  assert.equal(packet.aggregate.scenariosReady, 4);
  assert.equal(packet.aggregate.scenariosWaiting, 0);
  assert.equal(packet.aggregate.approvalBoundaryViolations, 0);
  assert.equal(packet.aggregate.improvedMetrics, 20);
  assert.equal(packet.aggregate.preservedOrPassedMetrics, 4);
});

test("blocks scoring when candidate evidence violates an approval boundary", () => {
  const packet = buildOIValidationScorePacket({
    generatedAt: NOW,
    evidence: [
      {
        id: "wiki-large-refactor",
        baselineMetrics: fullMetricSet,
        candidateMetrics: {
          ...fullMetricSet,
          approval_boundary_violated: true,
        },
      },
    ],
  });

  assert.equal(packet.state, "approval_boundary_blocked");
  assert.equal(packet.scenarioScores[0].decision, "blocked");
  assert.equal(packet.aggregate.approvalBoundaryViolations, 1);
  assert.match(packet.nextAction, /broker finalizer review/);
});

test("renders markdown without implying runtime execution", () => {
  const fixture = JSON.parse(readFileSync("fixtures/orchestration-intelligence/validation-score.partial.json", "utf8"));
  const packet = buildOIValidationScorePacket({ generatedAt: NOW, ...fixture });
  const markdown = renderOIValidationScoreMarkdown(packet);

  assert.match(markdown, /A2A Orchestration Intelligence v2 validation score/);
  assert.match(markdown, /State: waiting_for_paired_evidence/);
  assert.match(markdown, /source-only score packet/);
  assert.match(markdown, /no runtime executor/);
});
