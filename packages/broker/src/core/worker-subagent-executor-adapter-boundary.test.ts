import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { buildA2AWorkerSubagentOrchestrationPolicy } from "./worker-subagent-orchestration-policy.js";
import {
  buildA2AWorkerSubagentDryRunPlan,
  buildA2AWorkerSubagentEvidencePacket,
  buildA2AWorkerSubagentSynthesisPacket,
} from "./worker-subagent-dry-run.js";
import {
  buildA2AWorkerSubagentExecutorAdapterBoundary,
  renderA2AWorkerSubagentExecutorAdapterBoundaryMarkdown,
} from "./worker-subagent-executor-adapter-boundary.js";

const NOW = "2026-06-19T09:00:00.000Z";

function readySynthesis() {
  const policy = buildA2AWorkerSubagentOrchestrationPolicy({
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
  const dryRunPlan = buildA2AWorkerSubagentDryRunPlan({ now: NOW, finalizer: "brokeralpha", plannerPolicy: policy });
  const evidence = dryRunPlan.recommendation.roles.map((role, index) => buildA2AWorkerSubagentEvidencePacket({
    now: NOW,
    parentTaskId: "task-large-hybrid",
    workerId: "workergamma",
    subagentId: `workergamma-${role.role}-${index + 1}`,
    role: role.role,
    status: "done",
    claims: [`${role.role} evidence accepted`],
    evidenceRefs: ["packages/broker/src/core/worker-subagent-dry-run.ts"],
  }));
  const synthesis = buildA2AWorkerSubagentSynthesisPacket({
    now: NOW,
    finalizer: "brokeralpha",
    workerId: "workergamma",
    parentTaskId: "task-large-hybrid",
    dryRunPlan,
    subagentEvidence: evidence,
  });
  assert.equal(synthesis.state, "ready_for_finalizer_review");
  return { dryRunPlan, synthesis };
}

test("executor adapter boundary is default-off and never invokes runtime while disabled", () => {
  const { dryRunPlan, synthesis } = readySynthesis();
  let invoked = 0;

  const packet = buildA2AWorkerSubagentExecutorAdapterBoundary({
    now: NOW,
    dryRunPlan,
    synthesis,
    runtimeAdapter: () => {
      invoked += 1;
      throw new Error("runtime adapter must not be invoked while disabled");
    },
  });

  assert.equal(packet.kind, "a2a-broker.worker-subagent-executor-adapter-boundary.packet");
  assert.equal(packet.state, "disabled");
  assert.equal(packet.featureGate.enabled, false);
  assert.equal(packet.featureGate.taskOptIn, false);
  assert.equal(packet.featureGate.runtimeSpawnAllowed, false);
  assert.equal(packet.featureGate.depthLimit, 1);
  assert.equal(packet.runtime.actualSubagentSpawn, false);
  assert.equal(packet.runtime.executorInvocation, false);
  assert.equal(packet.runtime.processSpawn, false);
  assert.equal(packet.runtime.runtimeBehaviorChanged, false);
  assert.equal(packet.boundaries.brokerDispatch, false);
  assert.equal(packet.boundaries.dbMutation, false);
  assert.equal(packet.boundaries.deployOrRestart, false);
  assert.equal(packet.boundaries.providerSend, false);
  assert.equal(packet.boundaries.terminalAckOrReplay, false);
  assert.equal(packet.blockers.includes("feature gate disabled"), true);
  assert.equal(invoked, 0);
});

test("explicit gate and task opt-in can only mark adapter eligible, still with no spawn side effects", () => {
  const { dryRunPlan, synthesis } = readySynthesis();
  let invoked = 0;

  const packet = buildA2AWorkerSubagentExecutorAdapterBoundary({
    now: NOW,
    dryRunPlan,
    synthesis,
    featureGate: {
      enabled: true,
      taskOptIn: true,
      depthLimit: 1,
      workerActiveSubagents: 0,
      workerSubagentCap: 4,
      brokerActiveSubagents: 0,
      brokerSubagentCap: 12,
    },
    runtimeAdapter: () => {
      invoked += 1;
    },
  });

  assert.equal(packet.state, "eligible_pending_runtime_approval");
  assert.equal(packet.featureGate.enabled, true);
  assert.equal(packet.featureGate.taskOptIn, true);
  assert.equal(packet.featureGate.runtimeSpawnAllowed, false);
  assert.equal(packet.readiness.adapterBoundaryReady, true);
  assert.equal(packet.runtime.wouldEnterRuntimeAdapter, true);
  assert.equal(packet.runtime.actualSubagentSpawn, false);
  assert.equal(packet.runtime.executorInvocation, false);
  assert.equal(packet.runtime.processSpawn, false);
  assert.equal(invoked, 0);
  assert.equal(packet.nextAction.includes("future explicit runtime-spawn approval"), true);
});

test("adapter boundary blocks recursive depth, exhausted caps, and blocked synthesis", () => {
  const { dryRunPlan, synthesis } = readySynthesis();
  const recursive = buildA2AWorkerSubagentExecutorAdapterBoundary({
    now: NOW,
    dryRunPlan,
    synthesis,
    featureGate: { enabled: true, taskOptIn: true, depthLimit: 2 },
  });
  const exhausted = buildA2AWorkerSubagentExecutorAdapterBoundary({
    now: NOW,
    dryRunPlan,
    synthesis,
    featureGate: { enabled: true, taskOptIn: true, depthLimit: 1, workerActiveSubagents: 4, workerSubagentCap: 4 },
  });
  const blockedSynthesis = buildA2AWorkerSubagentSynthesisPacket({
    now: NOW,
    finalizer: "brokeralpha",
    workerId: "workergamma",
    parentTaskId: "task-large-hybrid",
    dryRunPlan,
    subagentEvidence: [buildA2AWorkerSubagentEvidencePacket({
      now: NOW,
      parentTaskId: "task-large-hybrid",
      workerId: "workergamma",
      subagentId: "workergamma-verifier-blocked",
      role: "verifier",
      status: "done",
      finalDecisionClaim: "merge_pr",
    })],
  });
  const fromBlockedSynthesis = buildA2AWorkerSubagentExecutorAdapterBoundary({
    now: NOW,
    dryRunPlan,
    synthesis: blockedSynthesis,
    featureGate: { enabled: true, taskOptIn: true, depthLimit: 1 },
  });

  assert.equal(recursive.state, "blocked");
  assert.equal(recursive.blockers.includes("depth limit must be exactly 1"), true);
  assert.equal(exhausted.state, "blocked");
  assert.equal(exhausted.blockers.includes("worker subagent cap exhausted"), true);
  assert.equal(fromBlockedSynthesis.state, "blocked");
  assert.equal(fromBlockedSynthesis.blockers.includes("synthesis is not ready for finalizer review"), true);

  for (const packet of [recursive, exhausted, fromBlockedSynthesis]) {
    assert.equal(packet.runtime.actualSubagentSpawn, false);
    assert.equal(packet.runtime.executorInvocation, false);
    assert.equal(packet.boundaries.releaseOrPublish, false);
    assert.equal(packet.boundaries.secretMovement, false);
  }
});

test("adapter boundary produces deterministic lane idempotency keys without importing child_process", () => {
  const { dryRunPlan, synthesis } = readySynthesis();
  const a = buildA2AWorkerSubagentExecutorAdapterBoundary({
    now: NOW,
    dryRunPlan,
    synthesis,
    featureGate: { enabled: true, taskOptIn: true, depthLimit: 1 },
  });
  const b = buildA2AWorkerSubagentExecutorAdapterBoundary({
    now: NOW,
    dryRunPlan,
    synthesis,
    featureGate: { enabled: true, taskOptIn: true, depthLimit: 1 },
  });

  assert.equal(a.idempotencyKey, b.idempotencyKey);
  assert.equal(a.laneIdempotencyKeys.length, dryRunPlan.recommendation.roles.length);
  assert.deepEqual(a.laneIdempotencyKeys, b.laneIdempotencyKeys);
  assert.equal(new Set(a.laneIdempotencyKeys).size, a.laneIdempotencyKeys.length);

  const source = readFileSync("src/core/worker-subagent-executor-adapter-boundary.ts", "utf8");
  assert.equal(source.includes("child_process"), false);
  assert.equal(source.includes("spawn("), false);
  assert.equal(source.includes("exec("), false);

  const markdown = renderA2AWorkerSubagentExecutorAdapterBoundaryMarkdown(a);
  assert.equal(markdown.includes("no runtime spawn"), true);
  assert.equal(markdown.includes("future explicit runtime-spawn approval"), true);
});
