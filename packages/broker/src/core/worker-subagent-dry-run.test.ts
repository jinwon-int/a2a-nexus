import assert from "node:assert/strict";
import test from "node:test";

import { buildA2AWorkerSubagentOrchestrationPolicy } from "a2a-attestation";
import {
  buildA2AWorkerSubagentDryRunPlan,
  buildA2AWorkerSubagentEvidencePacket,
  buildA2AWorkerSubagentSynthesisPacket,
  renderA2AWorkerSubagentDryRunPlanMarkdown,
} from "./worker-subagent-dry-run.js";

const NOW = "2026-06-19T08:20:00.000Z";

function largePolicy() {
  return buildA2AWorkerSubagentOrchestrationPolicy({
    now: NOW,
    task: {
      taskId: "task-large-hybrid",
      size: "large",
      coupling: "low",
      hasIndependentSubtasks: true,
      writeSets: ["packages/broker/src/core/a.ts", "packages/broker/src/core/b.ts"],
    },
    host: {
      workerId: "workergamma",
      cpuLoadPct: 25,
      memoryUsedPct: 35,
      ioPressure: "low",
      eventLoopDegraded: false,
      gatewayPressure: "low",
      activeSubagents: 0,
      workerSubagentCap: 4,
      brokerActiveSubagents: 0,
      brokerSubagentCap: 12,
    },
  });
}

test("dry-run plan records 3-4 role recommendation while feature gate remains default-off", () => {
  const policy = largePolicy();
  assert.equal(policy.decision.parallelismHint, 4);

  const plan = buildA2AWorkerSubagentDryRunPlan({ now: NOW, finalizer: "brokeralpha", plannerPolicy: policy });

  assert.equal(plan.kind, "a2a-broker.worker-subagent-dry-run.plan");
  assert.equal(plan.state, "recommendation_recorded");
  assert.equal(plan.finalizer, "brokeralpha");
  assert.equal(plan.dryRunOnly, true);
  assert.equal(plan.featureGate.enabled, false);
  assert.equal(plan.featureGate.runtimeSpawnAllowed, false);
  assert.equal(plan.featureGate.depthLimit, 1);
  assert.equal(plan.recommendation.parallelismHint, 4);
  assert.deepEqual(plan.recommendation.roles.map((role) => role.role), ["explorer", "implementer", "implementer", "verifier"]);
  assert.equal(plan.runtime.wouldSpawnSubagents, false);
  assert.equal(plan.runtime.actualSubagentSpawn, false);
  assert.equal(plan.runtime.executorInvocation, false);
  assert.equal(plan.boundaries.brokerDispatch, false);
  assert.equal(plan.boundaries.providerSend, false);
  assert.equal(plan.boundaries.terminalAckOrReplay, false);

  const markdown = renderA2AWorkerSubagentDryRunPlanMarkdown(plan);
  assert.equal(markdown.includes("dry-run only"), true);
  assert.equal(markdown.includes("runtime spawn disabled"), true);
});

test("dry-run plan fails closed to solo/direct for unsafe or low-value fanout cases", () => {
  const sensitive = buildA2AWorkerSubagentOrchestrationPolicy({
    now: NOW,
    task: { taskId: "task-sensitive", size: "large", coupling: "low", sensitive: true, hasIndependentSubtasks: true },
    host: { workerId: "workerbeta", cpuLoadPct: 20, memoryUsedPct: 30, activeSubagents: 0, workerSubagentCap: 4 },
  });
  const small = buildA2AWorkerSubagentOrchestrationPolicy({
    now: NOW,
    task: { taskId: "task-small", size: "small", coupling: "medium", hasIndependentSubtasks: false },
    host: { workerId: "workerbeta", cpuLoadPct: 20, memoryUsedPct: 30, activeSubagents: 0, workerSubagentCap: 4 },
  });
  const pressure = buildA2AWorkerSubagentOrchestrationPolicy({
    now: NOW,
    task: { taskId: "task-pressure", size: "large", coupling: "low", hasIndependentSubtasks: true, writeSets: ["a", "b"] },
    host: { workerId: "workerbeta", cpuLoadPct: 20, memoryUsedPct: 91, eventLoopDegraded: true, activeSubagents: 0, workerSubagentCap: 4 },
  });

  for (const policy of [sensitive, small, pressure]) {
    const plan = buildA2AWorkerSubagentDryRunPlan({ now: NOW, plannerPolicy: policy });
    assert.equal(plan.runtime.wouldSpawnSubagents, false);
    assert.equal(plan.runtime.actualSubagentSpawn, false);
    assert.equal(plan.boundaries.mandatoryProductionSpawn, false);
  }

  assert.equal(buildA2AWorkerSubagentDryRunPlan({ now: NOW, plannerPolicy: sensitive }).recommendation.parallelismHint, 0);
  assert.equal(buildA2AWorkerSubagentDryRunPlan({ now: NOW, plannerPolicy: small }).recommendation.parallelismHint, 1);
  assert.equal(buildA2AWorkerSubagentDryRunPlan({ now: NOW, plannerPolicy: pressure }).recommendation.parallelismHint, 0);
});

test("subagent evidence packet blocks final-decision claims and side effects", () => {
  const packet = buildA2AWorkerSubagentEvidencePacket({
    now: NOW,
    parentTaskId: "task-large-hybrid",
    workerId: "workergamma",
    subagentId: "workergamma-verifier-1",
    role: "verifier",
    status: "done",
    claims: ["tests pass"],
    evidenceRefs: ["packages/broker/src/core/worker-subagent-dry-run.test.ts"],
    testsRun: ["npx tsx --test src/core/worker-subagent-dry-run.test.ts"],
    finalDecisionClaim: "merge_pr",
    sideEffects: { gitCommit: true },
  });

  assert.equal(packet.kind, "a2a-broker.worker-subagent-evidence.packet");
  assert.equal(packet.sourceOnly, true);
  assert.equal(packet.state, "blocked");
  assert.equal(packet.decisionAuthority.subagentMayCloseOrMerge, false);
  assert.equal(packet.decisionAuthority.subagentMayDeployOrRestart, false);
  assert.equal(packet.decisionAuthority.subagentMayAckOrReplayTerminal, false);
  assert.equal(packet.decisionAuthority.subagentMaySendProviders, false);
  assert.equal(packet.blockers.includes("subagent attempted final decision: merge_pr"), true);
  assert.equal(packet.blockers.includes("subagent reported side effects"), true);
});

test("synthesis packet requires finalizer ownership and preserves evidence-only boundaries", () => {
  const policy = largePolicy();
  const plan = buildA2AWorkerSubagentDryRunPlan({ now: NOW, finalizer: "brokeralpha", plannerPolicy: policy });
  const explorer = buildA2AWorkerSubagentEvidencePacket({
    now: NOW,
    parentTaskId: "task-large-hybrid",
    workerId: "workergamma",
    subagentId: "workergamma-explorer-1",
    role: "explorer",
    status: "done",
    claims: ["policy scaffold exists but runtime spawn is absent"],
    evidenceRefs: ["packages/broker/src/core/worker-subagent-orchestration-policy.ts"],
  });
  const verifier = buildA2AWorkerSubagentEvidencePacket({
    now: NOW,
    parentTaskId: "task-large-hybrid",
    workerId: "workergamma",
    subagentId: "workergamma-verifier-1",
    role: "verifier",
    status: "done",
    claims: ["feature gate remains default-off"],
    evidenceRefs: ["packages/broker/src/core/worker-subagent-dry-run.ts"],
    finalDecisionClaim: "close_issue",
  });

  const packet = buildA2AWorkerSubagentSynthesisPacket({
    now: NOW,
    finalizer: "brokeralpha",
    workerId: "workergamma",
    parentTaskId: "task-large-hybrid",
    dryRunPlan: plan,
    subagentEvidence: [explorer, verifier],
  });

  assert.equal(packet.kind, "a2a-broker.worker-subagent-synthesis.packet");
  assert.equal(packet.state, "blocked");
  assert.equal(packet.finalizer, "brokeralpha");
  assert.equal(packet.finalizerDecisionRequired, true);
  assert.equal(packet.subagentsMayNotCloseOrMerge, true);
  assert.equal(packet.boundaries.actualSubagentSpawn, false);
  assert.equal(packet.boundaries.processSpawn, false);
  assert.equal(packet.boundaries.dbMutation, false);
  assert.equal(packet.boundaries.deployOrRestart, false);
  assert.equal(packet.blockers.includes("subagent workergamma-verifier-1 is blocked"), true);
  assert.deepEqual(packet.acceptedEvidenceIds, [explorer.id]);
});
