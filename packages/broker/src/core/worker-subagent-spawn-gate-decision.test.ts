import assert from "node:assert/strict";
import test from "node:test";

import { buildA2AWorkerSelfAssessmentCapacity } from "./worker-self-assessment-capacity.js";
import { buildA2AWorkerSubagentOrchestrationPolicy } from "a2a-attestation";
import { buildA2AWorkerSubagentPlannerHandoff } from "./worker-subagent-planner-handoff.js";
import { buildA2AWorkerSubagentSpawnAuthorizationRequest } from "./worker-subagent-spawn-authorization-request.js";
import { buildA2AWorkerSubagentBudgetCounter } from "a2a-attestation";
import {
  buildA2AWorkerSubagentSpawnGateDecision,
  extractA2AWorkerSubagentSpawnGateDecisionInput,
  renderA2AWorkerSubagentSpawnGateDecisionMarkdown,
  type SpawnGateAuthorizationView,
} from "a2a-attestation";

const NOW = "2026-05-19T02:20:00.000Z";

function readySpawnAuthorization() {
  const assessment = buildA2AWorkerSelfAssessmentCapacity({
    now: NOW,
    workerId: "workergamma",
    task: {
      taskId: "task-large-independent",
      size: "large",
      coupling: "low",
      hasIndependentSubtasks: true,
      writeSets: ["src/a.ts", "src/b.ts"],
    },
    host: {
      cpuLoadPct: 42,
      memoryUsedPct: 55,
      ioPressure: "low",
      eventLoopDegraded: false,
      gatewayPressure: "low",
      activeSubagents: 0,
      workerSubagentCap: 3,
      brokerActiveSubagents: 4,
      brokerSubagentCap: 12,
    },
  });
  assert.ok(assessment.plannerInput);
  const plannerPolicy = buildA2AWorkerSubagentOrchestrationPolicy(assessment.plannerInput);
  const handoff = buildA2AWorkerSubagentPlannerHandoff({
    now: NOW,
    finalizer: "brokeralpha",
    selfAssessment: assessment,
    plannerPolicy,
  });
  return buildA2AWorkerSubagentSpawnAuthorizationRequest(handoff, { now: NOW, finalizer: "brokeralpha" });
}

const READY_VIEW: SpawnGateAuthorizationView = {
  state: "authorization_request_draft_ready",
  workerId: "workergamma",
  taskId: "task-x",
  plannerParallelismHint: 3,
  oneFinalizerRequired: true,
  writeSetIsolationRequired: true,
};

test("authorizes a real spawn-authorization packet within budget and count", () => {
  const auth = readySpawnAuthorization();
  const budget = buildA2AWorkerSubagentBudgetCounter({
    now: NOW,
    workerId: "workergamma",
    usage: { taskTokensSpent: 14000, taskTokenCeiling: 20000, brokerTokensSpent: 460000, brokerTokenCeiling: 500000 },
  });
  const input = extractA2AWorkerSubagentSpawnGateDecisionInput({
    spawnAuthorization: auth,
    budgetCounter: budget,
    requestedSpawn: { subagents: [{ role: "implementer", writeSet: ["src/a.ts"] }, { role: "implementer", writeSet: ["src/b.ts"] }] },
  });
  const packet = buildA2AWorkerSubagentSpawnGateDecision({ ...input, now: NOW });

  assert.equal(packet.kind, "a2a-broker.worker-subagent-spawn-gate-decision.packet");
  assert.equal(packet.state, "authorized");
  assert.equal(packet.disposition, "spawn_authorized");
  assert.equal(packet.requestedSubagentCount, 2);
  assert.ok(packet.effectiveCeiling >= 2);
  assert.equal(packet.authorizedSubagentCount, 2);
  assert.deepEqual(packet.blockers, []);
  assert.equal(packet.boundaries.actualSubagentSpawn, false);
  assert.equal(packet.semantics.producesBindingVerdict, true);
  assert.equal(packet.semantics.enforcesSpawn, false);
});

test("refuses when the budget counter is exhausted (shrink-only ceiling 0)", () => {
  const auth = readySpawnAuthorization();
  const budget = buildA2AWorkerSubagentBudgetCounter({
    now: NOW,
    workerId: "workergamma",
    usage: { taskTokensSpent: 20000, taskTokenCeiling: 20000 },
  });
  const input = extractA2AWorkerSubagentSpawnGateDecisionInput({
    spawnAuthorization: auth,
    budgetCounter: budget,
    requestedSpawn: { subagents: [{ role: "implementer", writeSet: ["src/a.ts"] }] },
  });
  const packet = buildA2AWorkerSubagentSpawnGateDecision({ ...input, now: NOW });

  assert.equal(packet.state, "refused");
  assert.equal(packet.effectiveCeiling, 0);
  assert.equal(packet.authorizedSubagentCount, 0);
  assert.ok(packet.blockers.some((b) => b.startsWith("budget_within_ceiling")));
});

test("refuses when requested count exceeds the policy ceiling", () => {
  const packet = buildA2AWorkerSubagentSpawnGateDecision({
    now: NOW,
    authorization: { ...READY_VIEW, plannerParallelismHint: 1 },
    requestedSpawn: { subagents: [{ role: "implementer" }, { role: "implementer" }, { role: "verifier" }] },
  });
  assert.equal(packet.state, "refused");
  assert.equal(packet.effectiveCeiling, 1);
  assert.ok(packet.blockers.some((b) => b.startsWith("count_within_ceiling")));
});

test("refuses when implementer write sets overlap", () => {
  const packet = buildA2AWorkerSubagentSpawnGateDecision({
    now: NOW,
    authorization: READY_VIEW,
    requestedSpawn: { subagents: [{ role: "implementer", writeSet: ["src/shared.ts"] }, { role: "implementer", writeSet: ["src/shared.ts"] }] },
  });
  assert.equal(packet.state, "refused");
  assert.ok(packet.blockers.some((b) => b.startsWith("write_set_isolation")));
});

test("refuses when the authorization draft is not ready", () => {
  const packet = buildA2AWorkerSubagentSpawnGateDecision({
    now: NOW,
    authorization: { ...READY_VIEW, state: "blocked" },
    requestedSpawn: { subagents: [{ role: "explorer" }] },
  });
  assert.equal(packet.state, "refused");
  assert.ok(packet.blockers.some((b) => b.startsWith("authorization_ready")));
});

test("authorizes with a review note when no budget counter is supplied", () => {
  const packet = buildA2AWorkerSubagentSpawnGateDecision({
    now: NOW,
    authorization: READY_VIEW,
    requestedSpawn: { subagents: [{ role: "explorer" }, { role: "verifier" }] },
  });
  assert.equal(packet.state, "authorized");
  assert.equal(packet.blockers.length, 0);
  assert.ok(packet.reviews.some((r) => r.startsWith("budget_within_ceiling")));
  assert.equal(packet.authorizedSubagentCount, 2);
});

test("zero requested sub-agents is always authorized (escape hatch)", () => {
  const packet = buildA2AWorkerSubagentSpawnGateDecision({
    now: NOW,
    authorization: READY_VIEW,
    requestedSpawn: { subagents: [] },
  });
  assert.equal(packet.state, "authorized");
  assert.equal(packet.authorizedSubagentCount, 0);
});

test("markdown states source-only binding-verdict boundary", () => {
  const packet = buildA2AWorkerSubagentSpawnGateDecision({
    now: NOW,
    authorization: READY_VIEW,
    requestedSpawn: { subagents: [{ role: "explorer" }] },
  });
  const markdown = renderA2AWorkerSubagentSpawnGateDecisionMarkdown(packet);
  assert.equal(markdown.includes("source-only spawn gate decision"), true);
  assert.equal(markdown.includes("does not itself spawn"), true);
});
