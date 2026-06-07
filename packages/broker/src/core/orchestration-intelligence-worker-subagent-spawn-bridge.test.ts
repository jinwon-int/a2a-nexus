import assert from "node:assert/strict";
import test from "node:test";

import { buildA2AWorkerSelfAssessmentCapacity } from "./worker-self-assessment-capacity.js";
import { buildA2AWorkerSubagentOrchestrationPolicy } from "./worker-subagent-orchestration-policy.js";
import {
  buildA2AWorkerSubagentPlannerHandoff,
  type A2AWorkerSubagentPlannerHandoffPacket,
} from "./worker-subagent-planner-handoff.js";
import { buildA2AWorkerSubagentSpawnAuthorizationRequest } from "./worker-subagent-spawn-authorization-request.js";
import {
  buildOIWorkerSubagentSpawnAuthorizationBridgePacket,
  buildOIWorkerSubagentSpawnAuthorizationBridgePacketFromInput,
  renderOIWorkerSubagentSpawnAuthorizationBridgeMarkdown,
} from "./orchestration-intelligence-worker-subagent-spawn-bridge.js";
import type { OIWorkerSpawnApprovalDecisionEvidencePacket } from "./orchestration-intelligence-worker-spawn-approval-decision-evidence.js";

const NOW = "2026-06-01T12:00:00.000Z";

function readyV1AuthorizationRequest(): ReturnType<typeof buildA2AWorkerSubagentSpawnAuthorizationRequest> {
  const assessment = buildA2AWorkerSelfAssessmentCapacity({
    now: NOW,
    workerId: "bangtong",
    task: {
      taskId: "task-feature-gamma",
      size: "large",
      coupling: "low",
      hasIndependentSubtasks: true,
      writeSets: ["src/core/feature-gamma.ts", "test/feature-gamma.test.ts"],
    },
    host: {
      cpuLoadPct: 35,
      memoryUsedPct: 45,
      ioPressure: "low",
      eventLoopDegraded: false,
      gatewayPressure: "low",
      activeSubagents: 1,
      workerSubagentCap: 3,
      brokerActiveSubagents: 3,
      brokerSubagentCap: 12,
    },
  });
  assert.ok(assessment.plannerInput);
  const plannerPolicy = buildA2AWorkerSubagentOrchestrationPolicy(assessment.plannerInput);
  const handoff = buildA2AWorkerSubagentPlannerHandoff({
    now: NOW,
    finalizer: "seoseo",
    selfAssessment: assessment,
    plannerPolicy,
  });
  return buildA2AWorkerSubagentSpawnAuthorizationRequest(handoff, {
    now: NOW,
    finalizer: "seoseo",
    operatorTarget: "operator",
    authorizationReference: "subagent-spawn-auth-gamma",
    requestReference: "subagent-spawn-request-gamma",
    approvalWindowMinutes: 30,
  });
}

function acceptedWorkerSpawnApprovalDecisionEvidence(
  overrides: Partial<{
    state: string;
    sourceOnly: boolean;
    workerSpawnApprovalPresent: boolean;
    grantsExecutionApproval: boolean;
    workerSpawned: boolean;
  }> = {},
): OIWorkerSpawnApprovalDecisionEvidencePacket {
  const state = overrides.state ?? "worker_spawn_approval_evidence_accepted";
  const sourceOnly = overrides.sourceOnly ?? true;
  const workerSpawnApprovalPresent = overrides.workerSpawnApprovalPresent ?? true;
  const grantsExecutionApproval = overrides.grantsExecutionApproval ?? false;
  const workerSpawned = overrides.workerSpawned ?? false;

  return {
    kind: "a2a-broker.orchestration-intelligence.worker-spawn-approval-decision-evidence.packet",
    version: 1,
    generatedAt: NOW,
    runId: "oi-v2-worker-spawn-decision-accepted",
    recorder: "gwakga",
    sourceOnly,
    state,
    idempotencyKey: `oi-worker-spawn-decision:${state}:${workerSpawnApprovalPresent}`,
    runtimeReadinessEvidencePatch: {
      runtimeExecutorDesignReviewed: true,
      explicitRuntimeApprovalPresent: true,
      brokerDispatchApprovalPresent: true,
      workerSpawnApprovalPresent,
      daegyoMobileScopeResolved: false,
      rollbackAbortCriteriaDocumented: true,
      liveBoundaryPlanDocumented: true,
      validationEvidenceFresh: true,
    },
    safety: {
      workerSpawnApprovalDecisionEvidenceOnly: true,
      sourceOnly,
      grantsExecutionApproval,
      workerSpawnApprovalEvidenceAccepted: state === "worker_spawn_approval_evidence_accepted",
      runtimeExecutorCreated: false,
      runtimeExecutorEnabled: false,
      brokerDispatchCreated: false,
      workerSpawned,
      daegyoScopeExpanded: false,
      providerSend: false,
      terminalAckReplay: false,
      dbMutation: false,
      deployOrRestart: false,
      credentialMovement: false,
      releasePublished: false,
    },
  } as unknown as OIWorkerSpawnApprovalDecisionEvidencePacket;
}

test("builds bridge packet from ready v1 authorization request without granting spawn", () => {
  const v1 = readyV1AuthorizationRequest();
  const bridge = buildOIWorkerSubagentSpawnAuthorizationBridgePacket(v1, {
    now: NOW,
    workerSpawnApprovalDecisionEvidence: acceptedWorkerSpawnApprovalDecisionEvidence(),
    operatorTarget: "seo-jin-on",
    targetRepo: "jinwon-int/a2a-broker",
    targetIssueNumber: 968,
  });

  assert.equal(
    bridge.kind,
    "a2a-broker.orchestration-intelligence.worker-subagent-spawn-authorization-bridge.packet",
  );
  assert.equal(bridge.version, 1);
  assert.equal(bridge.sourceOnly, true);
  assert.equal(bridge.state, "bridge_ready");
  assert.equal(bridge.workerId, "bangtong");
  assert.equal(bridge.taskId, "task-feature-gamma");
  assert.equal(bridge.finalizer, "seoseo");
  assert.equal(bridge.v1AuthorizationRequestIdempotencyKey, v1.idempotencyKey);
  assert.equal(
    bridge.workerSpawnApprovalDecisionEvidenceIdempotencyKey,
    acceptedWorkerSpawnApprovalDecisionEvidence().idempotencyKey,
  );
  assert.equal(
    bridge.oiV2Source.workerSpawnApprovalDecisionEvidenceState,
    "worker_spawn_approval_evidence_accepted",
  );
  assert.equal(bridge.oiV2Source.workerSpawnApprovalPresent, true);

  // V1 source trace must match
  assert.equal(bridge.v1Source.authorizationRequestState, "authorization_request_draft_ready");
  assert.equal(bridge.v1Source.plannerHandoffIdempotencyKey, v1.source.plannerHandoffIdempotencyKey);
  assert.equal(bridge.v1Source.selfAssessmentIdempotencyKey, v1.source.selfAssessmentIdempotencyKey);
  assert.equal(bridge.v1Source.plannerPolicyIdempotencyKey, v1.source.plannerPolicyIdempotencyKey);
  assert.equal(bridge.v1Source.plannerParallelismHint, v1.source.plannerParallelismHint);
  assert.deepEqual(bridge.v1Source.recommendedRoles, v1.source.recommendedRoles);
  assert.equal(bridge.v1Source.authorizationReference, "subagent-spawn-auth-gamma");
  assert.equal(bridge.v1Source.requestReference, "subagent-spawn-request-gamma");

  // OI v2 bridge output
  assert.equal(bridge.oiV2Output.bridgeAction, "bridge_to_oi_worker_spawn_approval_request");
  assert.match(bridge.oiV2Output.requestedApprovalPhrase, /APPROVE OI V2 WORKER SPAWN AUTHORIZATION BRIDGE/);
  assert.equal(bridge.oiV2Output.operatorTarget, "seo-jin-on");
  assert.ok(bridge.oiV2Output.spawnScope.length > 0);
  assert.ok(bridge.oiV2Output.workerTeamConstraints.length > 0);
  assert.ok(bridge.oiV2Output.allowedWorkerClasses.length > 0);
  assert.ok(bridge.oiV2Output.noLiveExclusions.length > 0);
  assert.ok(bridge.oiV2Output.requiredConditions.length > 0);
  assert.ok(bridge.oiV2Output.rollbackAbortRequirements.length > 0);
  assert.ok(bridge.oiV2Output.expiryOrRevocation.length > 0);
  assert.ok(bridge.oiV2Output.nonGoals.length > 0);
  assert.ok(bridge.oiV2Output.evidenceFieldsRequiredForFutureApproval.length > 0);

  // All checks pass
  assert.ok(bridge.checks.every((check) => check.status === "pass"));
  assert.deepEqual(bridge.blockers, []);

  // Source-only boundaries
  assert.equal(bridge.boundaries.sourceOnly, true);
  assert.equal(bridge.boundaries.actualSubagentSpawn, false);
  assert.equal(bridge.boundaries.brokerDispatch, false);
  assert.equal(bridge.boundaries.workerClaim, false);
  assert.equal(bridge.boundaries.executorInvocation, false);
  assert.equal(bridge.boundaries.processSpawn, false);
  assert.equal(bridge.boundaries.taskFlowMutation, false);
  assert.equal(bridge.boundaries.dbMutation, false);
  assert.equal(bridge.boundaries.deployOrRestart, false);
  assert.equal(bridge.boundaries.providerSend, false);
  assert.equal(bridge.boundaries.terminalAckOrReplay, false);
  assert.equal(bridge.boundaries.releaseOrPublish, false);
  assert.equal(bridge.boundaries.secretMovement, false);

  // Safety semantics
  assert.equal(bridge.semantics.bridgePacketOnly, true);
  assert.equal(bridge.semantics.sourceOnly, true);
  assert.equal(bridge.semantics.doesNotGrantAuthorization, true);
  assert.equal(bridge.semantics.doesNotSpawnSubagents, true);
  assert.equal(bridge.semantics.doesNotDispatchBrokerWork, true);
  assert.equal(bridge.semantics.doesNotCreateTaskFlowRecords, true);
  assert.equal(bridge.semantics.doesNotMutateDb, true);
  assert.equal(bridge.semantics.performsProviderSend, false);
  assert.equal(bridge.semantics.performsTerminalAck, false);
  assert.equal(bridge.semantics.performsRuntimeRestartOrDeploy, false);
  assert.equal(bridge.semantics.performsHistoricalReplay, false);
  assert.equal(bridge.semantics.performsReleaseOrPublish, false);
  assert.equal(bridge.semantics.movesSecretsOrCredentials, false);
});

test("fails closed when upstream OI v2 worker spawn approval decision evidence is missing", () => {
  const v1 = readyV1AuthorizationRequest();
  const bridge = buildOIWorkerSubagentSpawnAuthorizationBridgePacket(v1, {
    now: NOW,
  });

  assert.equal(bridge.state, "bridge_worker_spawn_decision_evidence_not_accepted");
  assert.equal(bridge.workerSpawnApprovalDecisionEvidenceIdempotencyKey, null);
  assert.equal(bridge.oiV2Source.workerSpawnApprovalDecisionEvidenceState, "missing");
  assert.equal(bridge.oiV2Source.workerSpawnApprovalPresent, false);
  assert.ok(
    bridge.blockers.some((blocker) =>
      blocker.includes("worker_spawn_approval_decision_evidence_accepted")
    ),
  );
  assert.equal(bridge.boundaries.actualSubagentSpawn, false);
  assert.equal(bridge.semantics.doesNotGrantAuthorization, true);
});

test("fails closed when v1 authorization request is not ready", () => {
  // Create a v1 request with non-ready state by passing "blocked" handoff
  const assessment = buildA2AWorkerSelfAssessmentCapacity({
    now: NOW,
    workerId: "bangtong",
    task: {
      taskId: "task-blocked",
      size: "large",
      coupling: "high",
      hasIndependentSubtasks: false,
    },
    host: {
      cpuLoadPct: 35,
      memoryUsedPct: 45,
      ioPressure: "low",
      eventLoopDegraded: false,
      gatewayPressure: "low",
      activeSubagents: 1,
      workerSubagentCap: 3,
      brokerActiveSubagents: 3,
      brokerSubagentCap: 12,
    },
  });
  assert.ok(assessment.plannerInput);
  const plannerPolicy = buildA2AWorkerSubagentOrchestrationPolicy(assessment.plannerInput);
  const handoff = buildA2AWorkerSubagentPlannerHandoff({
    now: NOW,
    finalizer: "seoseo",
    selfAssessment: assessment,
    plannerPolicy,
  });
  // With high coupling and large size, the planner policy yields parallelismHint=0
  // which may produce a "blocked" or non-ready handoff. Build the v1 request.
  const v1 = buildA2AWorkerSubagentSpawnAuthorizationRequest(handoff, {
    now: NOW,
    finalizer: "seoseo",
  });

  const bridge = buildOIWorkerSubagentSpawnAuthorizationBridgePacket(v1, {
    now: NOW,
    workerSpawnApprovalDecisionEvidence: acceptedWorkerSpawnApprovalDecisionEvidence(),
  });

  // The bridge should detect the non-ready state and block or flag it
  assert.notEqual(bridge.state, "bridge_ready");
  assert.equal(bridge.oiV2Output.bridgeAction, "blocked_bridge_preconditions");
  assert.ok(bridge.blockers.length > 0);

  // Safety invariants always hold even in blocked state
  assert.equal(bridge.boundaries.actualSubagentSpawn, false);
  assert.equal(bridge.semantics.doesNotGrantAuthorization, true);
  assert.equal(bridge.semantics.doesNotSpawnSubagents, true);
});

test("blocks bridge when v1 boundaries have unsafe drift", () => {
  const v1 = readyV1AuthorizationRequest();
  // Mutate the boundaries to simulate unsafe drift
  const mutated = {
    ...v1,
    boundaries: { ...v1.boundaries, actualSubagentSpawn: true as false },
  };

  const bridge = buildOIWorkerSubagentSpawnAuthorizationBridgePacket(
    mutated as typeof v1,
    {
      now: NOW,
      workerSpawnApprovalDecisionEvidence: acceptedWorkerSpawnApprovalDecisionEvidence(),
    },
  );

  assert.equal(bridge.state, "bridge_blocked_v1_boundary_drift");
  assert.equal(bridge.oiV2Output.bridgeAction, "forbidden_safety_invariant");
  assert.ok(bridge.blockers.some((blocker) => blocker.includes("boundaries")));
  assert.ok(bridge.blockers.some((blocker) => blocker.includes("unsafe")));

  // Safety invariants always hold
  assert.equal(bridge.boundaries.actualSubagentSpawn, false);
  assert.equal(bridge.semantics.doesNotGrantAuthorization, true);
});

test("blocks bridge when v1 semantics have unsafe drift", () => {
  const v1 = readyV1AuthorizationRequest();
  // Mutate the semantics to simulate an unsafe drift
  const mutated = {
    ...v1,
    semantics: { ...v1.semantics, authorizationRequestDraftOnly: false as true },
  };

  const bridge = buildOIWorkerSubagentSpawnAuthorizationBridgePacket(
    mutated as typeof v1,
    {
      now: NOW,
      workerSpawnApprovalDecisionEvidence: acceptedWorkerSpawnApprovalDecisionEvidence(),
    },
  );

  assert.equal(bridge.state, "bridge_blocked_v1_boundary_drift");
  assert.equal(bridge.oiV2Output.bridgeAction, "forbidden_safety_invariant");
  assert.ok(bridge.blockers.length > 0);
});

test("builds from input envelope with nested v1 packet", () => {
  const v1 = readyV1AuthorizationRequest();
  const input = {
    v1AuthorizationRequest: v1,
    workerSpawnApprovalDecisionEvidence: acceptedWorkerSpawnApprovalDecisionEvidence(),
  };

  const bridge = buildOIWorkerSubagentSpawnAuthorizationBridgePacketFromInput(input, {
    now: NOW,
    operatorTarget: "seo-jin-on",
    targetRepo: "jinwon-int/a2a-broker",
    targetIssueNumber: 968,
  });

  assert.equal(bridge.state, "bridge_ready");
  assert.equal(bridge.workerId, "bangtong");
  assert.equal(bridge.v1AuthorizationRequestIdempotencyKey, v1.idempotencyKey);
});

test("builds from input envelope with nested packet key", () => {
  const v1 = readyV1AuthorizationRequest();
  const input = { packet: v1 };

  const bridge = buildOIWorkerSubagentSpawnAuthorizationBridgePacketFromInput(input, {
    now: NOW,
    workerSpawnApprovalDecisionEvidence: acceptedWorkerSpawnApprovalDecisionEvidence(),
    operatorTarget: "operator",
  });

  assert.equal(bridge.state, "bridge_ready");
  assert.equal(bridge.finalizer, "seoseo");
});

test("throws on invalid input", () => {
  assert.throws(
    () => buildOIWorkerSubagentSpawnAuthorizationBridgePacketFromInput({}),
    /expected.*A2AWorkerSubagentSpawnAuthorizationRequestPacket/,
  );
  assert.throws(
    () => buildOIWorkerSubagentSpawnAuthorizationBridgePacketFromInput(null),
    /expected.*A2AWorkerSubagentSpawnAuthorizationRequestPacket/,
  );
  assert.throws(
    () => buildOIWorkerSubagentSpawnAuthorizationBridgePacketFromInput(42),
    /expected.*A2AWorkerSubagentSpawnAuthorizationRequestPacket/,
  );
});

test("renders bridge packet markdown with safety disclaimer", () => {
  const v1 = readyV1AuthorizationRequest();
  const bridge = buildOIWorkerSubagentSpawnAuthorizationBridgePacket(v1, {
    now: NOW,
    workerSpawnApprovalDecisionEvidence: acceptedWorkerSpawnApprovalDecisionEvidence(),
    operatorTarget: "seo-jin-on",
    targetRepo: "jinwon-int/a2a-broker",
    targetIssueNumber: 968,
  });
  const markdown = renderOIWorkerSubagentSpawnAuthorizationBridgeMarkdown(bridge);

  assert.match(markdown, /Orchestration Intelligence v2/);
  assert.match(markdown, /bridge_ready/);
  assert.match(markdown, /subagent-spawn-auth-gamma/);
  assert.match(markdown, /APPROVE OI V2 WORKER SPAWN AUTHORIZATION BRIDGE/);
  assert.match(markdown, /source-only bridge packet/);
  assert.match(markdown, /does not grant authorization/);
  assert.match(markdown, /All mutation\/action boundaries remain false/);
  assert.match(markdown, /bangtong/);
  assert.match(markdown, /seoseo/);
  assert.match(markdown, /seo-jin-on/);
});

test("bridge packet idempotency key changes when v1 key or state changes", () => {
  const v1 = readyV1AuthorizationRequest();
  const bridge1 = buildOIWorkerSubagentSpawnAuthorizationBridgePacket(v1, {
    now: NOW,
    workerSpawnApprovalDecisionEvidence: acceptedWorkerSpawnApprovalDecisionEvidence(),
    operatorTarget: "seo-jin-on",
  });

  const bridge2 = buildOIWorkerSubagentSpawnAuthorizationBridgePacket(v1, {
    now: NOW,
    workerSpawnApprovalDecisionEvidence: acceptedWorkerSpawnApprovalDecisionEvidence(),
    operatorTarget: "seo-jin-on",
  });

  // Same inputs produce same idempotency key
  assert.equal(bridge1.idempotencyKey, bridge2.idempotencyKey);

  // Different operatorTarget produces different key
  const bridge3 = buildOIWorkerSubagentSpawnAuthorizationBridgePacket(v1, {
    now: NOW,
    workerSpawnApprovalDecisionEvidence: acceptedWorkerSpawnApprovalDecisionEvidence(),
    operatorTarget: "different-operator",
  });
  assert.notEqual(bridge1.idempotencyKey, bridge3.idempotencyKey);

  // Different v1 packet (different idempotencyKey) produces different key
  const v1b = readyV1AuthorizationRequest();
  const keyField = "idempotency" + "Key";
  const v1bWithDifferentKey = {
    ...v1b,
    [keyField]: [v1b[keyField as "idempotencyKey"], "v2"].join("-"),
  } as typeof v1b;
  const bridge4 = buildOIWorkerSubagentSpawnAuthorizationBridgePacket(
    v1bWithDifferentKey,
    {
      now: NOW,
      workerSpawnApprovalDecisionEvidence: acceptedWorkerSpawnApprovalDecisionEvidence(),
      operatorTarget: "seo-jin-on",
    },
  );
  assert.notEqual(bridge1.idempotencyKey, bridge4.idempotencyKey);
});

test("bridge packet preserves roles from v1 authorization request", () => {
  const v1 = readyV1AuthorizationRequest();
  const bridge = buildOIWorkerSubagentSpawnAuthorizationBridgePacket(v1, {
    now: NOW,
    workerSpawnApprovalDecisionEvidence: acceptedWorkerSpawnApprovalDecisionEvidence(),
  });

  // The v1 recommended roles should appear in the bridge output
  assert.deepEqual(bridge.v1Source.recommendedRoles, v1.source.recommendedRoles);
  assert.ok(bridge.oiV2Output.spawnScope.some((scope) =>
    v1.source.recommendedRoles.some((role) => scope.includes(role)),
  ));
});

test("bridge packet finalizer and workerId match v1 source", () => {
  const v1 = readyV1AuthorizationRequest();
  const bridge = buildOIWorkerSubagentSpawnAuthorizationBridgePacket(v1, {
    now: NOW,
    workerSpawnApprovalDecisionEvidence: acceptedWorkerSpawnApprovalDecisionEvidence(),
  });

  assert.equal(bridge.finalizer, v1.finalizer);
  assert.equal(bridge.workerId, v1.workerId);
  assert.equal(bridge.taskId, v1.taskId);
  assert.equal(
    bridge.v1Source.plannerHandoffIdempotencyKey,
    v1.source.plannerHandoffIdempotencyKey,
  );
});
