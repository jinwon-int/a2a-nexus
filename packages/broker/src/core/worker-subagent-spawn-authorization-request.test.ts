import assert from "node:assert/strict";
import test from "node:test";

import { buildA2AWorkerSelfAssessmentCapacity } from "./worker-self-assessment-capacity.js";
import { buildA2AWorkerSubagentOrchestrationPolicy } from "./worker-subagent-orchestration-policy.js";
import {
  buildA2AWorkerSubagentPlannerHandoff,
  type A2AWorkerSubagentPlannerHandoffPacket,
} from "./worker-subagent-planner-handoff.js";
import {
  buildA2AWorkerSubagentSpawnAuthorizationRequest,
  extractA2AWorkerSubagentSpawnAuthorizationRequestHandoff,
  extractA2AWorkerSubagentSpawnAuthorizationRequestOptions,
  renderA2AWorkerSubagentSpawnAuthorizationRequestMarkdown,
} from "./worker-subagent-spawn-authorization-request.js";

const NOW = "2026-05-19T02:20:00.000Z";

function readyHandoff(
  overrides: Partial<A2AWorkerSubagentPlannerHandoffPacket> = {},
): A2AWorkerSubagentPlannerHandoffPacket {
  const assessment = buildA2AWorkerSelfAssessmentCapacity({
    now: NOW,
    workerId: "bangtong",
    task: {
      taskId: "task-large-independent",
      size: "large",
      coupling: "low",
      hasIndependentSubtasks: true,
      writeSets: ["src/core/planner.ts", "docs/planner.md", "test/planner.test.ts"],
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
  const packet = buildA2AWorkerSubagentPlannerHandoff({
    now: NOW,
    finalizer: "seoseo",
    selfAssessment: assessment,
    plannerPolicy,
  });
  return { ...packet, ...overrides } as A2AWorkerSubagentPlannerHandoffPacket;
}

test("spawn authorization request renders draft without spawning subagents", () => {
  const packet = buildA2AWorkerSubagentSpawnAuthorizationRequest(readyHandoff(), {
    now: NOW,
    finalizer: "seoseo",
    operatorTarget: "operator",
    authorizationReference: "subagent-spawn-auth-766",
    requestReference: "subagent-spawn-request-766",
    approvalWindowMinutes: 10,
  });

  assert.equal(packet.kind, "a2a-broker.worker-subagent-spawn-authorization-request.packet");
  assert.equal(packet.state, "authorization_request_draft_ready");
  assert.equal(packet.finalizer, "seoseo");
  assert.equal(packet.workerId, "bangtong");
  assert.equal(packet.source.plannerHandoffReady, true);
  assert.deepEqual(packet.source.recommendedRoles, ["explorer", "implementer", "verifier"]);
  assert.equal(packet.authorizationRequestDraft.draftOnly, true);
  assert.equal(packet.authorizationRequestDraft.status, "draft_not_sent");
  assert.equal(packet.authorizationRequestDraft.dispatchPermitted, false);
  assert.equal(packet.authorizationRequestDraft.authorizationGrantPermitted, false);
  assert.equal(packet.authorizationRequestDraft.actualSubagentSpawnPermitted, false);
  assert.equal(packet.authorizationRequestDraft.brokerDispatchPermitted, false);
  assert.equal(packet.authorizationRequestDraft.workerClaimPermitted, false);
  assert.equal(packet.authorizationRequestDraft.executorInvocationPermitted, false);
  assert.equal(packet.authorizationRequestDraft.processSpawnPermitted, false);
  assert.equal(packet.authorizationRequestDraft.taskFlowMutationPermitted, false);
  assert.equal(packet.authorizationRequestDraft.dbMutationPermitted, false);
  assert.equal(packet.authorizationRequestDraft.providerSendPermitted, false);
  assert.equal(packet.authorizationRequestDraft.terminalAckPermitted, false);
  assert.equal(packet.authorizationRequestDraft.requestedSubagents.length, 3);
  assert.equal(packet.authorizationRequestDraft.requestedSubagents.every((agent) => agent.evidenceRequired), true);
  assert.equal(packet.finalizerReview.oneFinalizerRequired, true);
  assert.equal(packet.finalizerReview.evidenceOnlySubagents, true);
  assert.equal(packet.finalizerReview.writeSetIsolationRequired, true);
  assert.equal(packet.boundaries.actualSubagentSpawn, false);
  assert.equal(packet.boundaries.brokerDispatch, false);
  assert.equal(packet.boundaries.taskFlowMutation, false);
  assert.equal(packet.boundaries.dbMutation, false);
  assert.equal(packet.semantics.requestDoesNotGrantAuthorization, true);
  assert.equal(packet.semantics.requestDoesNotSpawnSubagents, true);
});

test("spawn authorization request waits for blocked planner handoff", () => {
  const source = readyHandoff({
    state: "blocked",
    review: {
      ...readyHandoff().review,
      blockers: ["planner policy worker does not match self-assessment worker"],
    },
  });
  const packet = buildA2AWorkerSubagentSpawnAuthorizationRequest(source, { now: NOW });

  assert.equal(packet.state, "waiting_for_planner_handoff");
  assert.equal(packet.authorizationRequestDraft.status, "not_ready");
  assert.equal(packet.finalizerReview.blockers.includes("planner policy worker does not match self-assessment worker"), true);
  assert.equal(packet.authorizationRequestDraft.actualSubagentSpawnPermitted, false);
});

test("spawn authorization request blocks unsafe boundary drift", () => {
  const unsafe = readyHandoff();
  unsafe.boundaries.actualSubagentSpawn = true as false;
  const packet = buildA2AWorkerSubagentSpawnAuthorizationRequest(unsafe, { now: NOW });

  assert.equal(packet.state, "blocked");
  assert.equal(packet.finalizerReview.blockers.some((blocker) => blocker.includes("actual subagent spawn")), true);
  assert.equal(packet.authorizationRequestDraft.actualSubagentSpawnPermitted, false);
});

test("spawn authorization request extractors and markdown preserve source-only boundary", () => {
  const source = readyHandoff();
  const input = {
    plannerHandoffPacket: source,
    spawnAuthorizationRequest: {
      finalizer_id: "seoseo",
      operator_target: "operator",
      authorization_reference: "subagent-spawn-auth-766",
    },
  };

  assert.equal(extractA2AWorkerSubagentSpawnAuthorizationRequestHandoff(input).idempotencyKey, source.idempotencyKey);
  assert.equal(extractA2AWorkerSubagentSpawnAuthorizationRequestOptions(input).finalizer_id, "seoseo");

  const packet = buildA2AWorkerSubagentSpawnAuthorizationRequest(
    extractA2AWorkerSubagentSpawnAuthorizationRequestHandoff(input),
    { ...extractA2AWorkerSubagentSpawnAuthorizationRequestOptions(input), now: NOW },
  );
  const markdown = renderA2AWorkerSubagentSpawnAuthorizationRequestMarkdown(packet);

  assert.equal(packet.authorizationRequestDraft.authorizationReference, "subagent-spawn-auth-766");
  assert.equal(markdown.includes("authorization request draft only"), true);
  assert.equal(markdown.includes("actualSubagentSpawnPermitted=false"), true);
});
