import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildOIValidationFrameworkPacket,
  renderOIValidationFrameworkMarkdown,
} from "./orchestration-intelligence-validation-framework.js";

const NOW = "2026-05-30T00:05:00.000Z";

test("builds a source-only validation framework with the four roadmap scenarios", () => {
  const packet = buildOIValidationFrameworkPacket({ generatedAt: NOW });

  assert.equal(packet.kind, "a2a-broker.orchestration-intelligence.validation-framework.packet");
  assert.equal(packet.sourceOnly, true);
  assert.deepEqual(packet.scenarios.map((scenario) => scenario.id), [
    "wiki-large-refactor",
    "skill-update-sweep",
    "complex-architecture-design",
    "a2a-worker-deployment",
  ]);
  assert.equal(packet.metrics.some((metric) => metric.name === "approval_boundary_violated"), true);
  assert.equal(packet.safety.runtimeExecutorCreated, false);
  assert.equal(packet.safety.brokerDispatchCreated, false);
  assert.equal(packet.safety.providerSend, false);
  assert.equal(packet.safety.dbMutation, false);
});

test("waits until every scenario has paired before and after evidence", () => {
  const packet = buildOIValidationFrameworkPacket({
    generatedAt: NOW,
    scenarios: [
      { id: "wiki-large-refactor", baselineEvidence: "collected", candidateEvidence: "collected" },
      { id: "skill-update-sweep", baselineEvidence: "collected" },
    ],
  });

  assert.equal(packet.readiness.state, "waiting_for_evidence");
  assert.deepEqual(packet.readiness.missingEvidence.slice(0, 3), [
    { scenarioId: "skill-update-sweep", slot: "candidate" },
    { scenarioId: "complex-architecture-design", slot: "baseline" },
    { scenarioId: "complex-architecture-design", slot: "candidate" },
  ]);
});

test("marks framework ready when all scenario evidence slots are collected", () => {
  const packet = buildOIValidationFrameworkPacket({
    generatedAt: NOW,
    scenarios: [
      { id: "wiki-large-refactor", baselineEvidence: "collected", candidateEvidence: "collected" },
      { id: "skill-update-sweep", baselineEvidence: "collected", candidateEvidence: "collected" },
      { id: "complex-architecture-design", baselineEvidence: "collected", candidateEvidence: "collected" },
      { id: "a2a-worker-deployment", baselineEvidence: "collected", candidateEvidence: "collected" },
    ],
  });

  assert.equal(packet.readiness.state, "framework_ready");
  assert.equal(packet.readiness.missingEvidence.length, 0);
  assert.match(packet.readiness.nextAction, /score paired scenario evidence/);
});

test("renders markdown without implying runtime action", () => {
  const fixture = JSON.parse(readFileSync("fixtures/orchestration-intelligence/validation-framework.partial.json", "utf8"));
  const packet = buildOIValidationFrameworkPacket(fixture);
  const markdown = renderOIValidationFrameworkMarkdown(packet);

  assert.match(markdown, /A2A Orchestration Intelligence v2 validation framework/);
  assert.match(markdown, /Readiness: waiting_for_evidence/);
  assert.match(markdown, /source-only framework/);
  assert.match(markdown, /no runtime executor/);
});
