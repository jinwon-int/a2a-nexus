import test from "node:test";
import assert from "node:assert/strict";
import { buildFinalizerApprovalEnvelopeDraft } from "./core/complexity-finalizer-approval-envelope-draft.js";
import { startTestServer, jsonHeaders } from "./server-test-helpers.js";

test("POST /workers/subagent-orchestration/plan returns read-only capacity planner packet", async () => {
  const server = await startTestServer({ edgeSecret: "test-edge-secret" });
  try {
    const res = await fetch(
      server.baseUrl + "/workers/subagent-orchestration/plan",
      {
        method: "POST",
        headers: jsonHeaders({
          "x-a2a-edge-secret": "test-edge-secret",
          "x-a2a-requester-id": "worker-a",
          "x-a2a-requester-role": "analyst",
        }),
        body: JSON.stringify({
          now: "2026-05-19T01:40:00.000Z",
          task: {
            taskId: "task-large-independent",
            size: "large",
            coupling: "low",
            hasIndependentSubtasks: true,
            writeSets: ["src/feature.ts", "docs/feature.md", "test/feature.test.ts"],
          },
          host: {
            workerId: "worker-a",
            cpuLoadPct: 35,
            memoryUsedPct: 45,
            ioPressure: "low",
            eventLoopDegraded: false,
            gatewayPressure: "low",
            activeSubagents: 0,
            workerSubagentCap: 3,
            brokerActiveSubagents: 2,
            brokerSubagentCap: 12,
          },
        }),
      },
    );

    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const body = await res.json();
    assert.equal(body.kind, "a2a-broker.worker-subagent-orchestration-policy.packet");
    assert.equal(body.generatedAt, "2026-05-19T01:40:00.000Z");
    assert.equal(body.decision.parallelismHint, 3);
    assert.deepEqual(body.decision.recommendedSubagents.map((agent: Record<string, unknown>) => agent.role), ["explorer", "implementer", "verifier"]);
    assert.equal(body.decision.oneFinalizerRequired, true);
    assert.equal(body.decision.evidenceOnlySubagents, true);
    assert.equal(body.decision.writeSetIsolationRequired, true);
    assert.equal(body.boundaries.runtimeBehaviorChanged, false);
    assert.equal(body.boundaries.mandatoryProductionSpawn, false);
    assert.equal(body.boundaries.brokerDispatchSemanticsChanged, false);
    assert.equal(body.boundaries.taskFlowMutation, false);
    assert.equal(body.boundaries.dbMutation, false);
    assert.equal(body.boundaries.deployOrRestart, false);
    assert.equal(body.boundaries.secretMovement, false);
  } finally {
    await server.close();
  }
});

test("POST /complexity-orchestration/recommendation returns classification plus no-live recommendation packet", async () => {
  const server = await startTestServer({ edgeSecret: "test-edge-secret" });
  try {
    const res = await fetch(
      server.baseUrl + "/complexity-orchestration/recommendation",
      {
        method: "POST",
        headers: jsonHeaders({
          "x-a2a-edge-secret": "test-edge-secret",
          "x-a2a-requester-id": "operator-a",
          "x-a2a-requester-role": "operator",
        }),
        body: JSON.stringify({
          intent: "propose_patch",
          targetEnvironment: "research",
          policyContext: { requiresApproval: true },
          artifactCount: 2,
        }),
      },
    );

    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");

    const body = await res.json();
    assert.equal(body.kind, "a2a-broker.complexity-orchestration-recommendation-packet");
    assert.equal(body.version, 1);
    assert.ok(typeof body.generatedAt === "string");
    assert.ok(typeof body.idempotencyKey === "string");
    assert.ok(body.idempotencyKey.startsWith("complexity-orch-recommendation:"));

    // Classification — propose_patch is base="complex" (ordinal 2), +1 approval +0 env = 3 => "critical"
    assert.equal(body.classification.level, "critical");
    assert.ok(typeof body.classification.reason === "string");
    assert.equal(body.classification.origin, "offset-adjusted");
    assert.equal(body.classification.signals.baseLevel, "complex");
    assert.equal(body.classification.signals.totalOffset, 1);
    assert.equal(body.classification.signals.requiresApproval, true);
    assert.equal(body.classification.signals.intentRecognized, true);

    // Recommendation — critical maps to operator_review
    assert.equal(body.recommendation.complexity, "critical");
    assert.equal(body.recommendation.action, "operator_review");
    assert.equal(body.recommendation.parallelismHint, 0);
    assert.equal(body.recommendation.confidence, "high");
    assert.ok(typeof body.recommendation.rationale === "string");
    assert.equal(body.recommendation.recommendedRoles.length, 0);
    assert.ok(typeof body.recommendation.safetyGate === "string");

    // No-live boundaries
    assert.equal(body.boundaries.runtimeBehaviorChanged, false);
    assert.equal(body.boundaries.mandatoryProductionSpawn, false);
    assert.equal(body.boundaries.brokerDispatchSemanticsChanged, false);
    assert.equal(body.boundaries.taskFlowMutation, false);
    assert.equal(body.boundaries.dbMutation, false);
    assert.equal(body.boundaries.deployOrRestart, false);
    assert.equal(body.boundaries.secretMovement, false);
  } finally {
    await server.close();
  }
});

test("POST /complexity-orchestration/recommendation rejects missing intent as bad_request", async () => {
  const server = await startTestServer({ edgeSecret: "test-edge-secret" });
  try {
    const res = await fetch(
      server.baseUrl + "/complexity-orchestration/recommendation",
      {
        method: "POST",
        headers: jsonHeaders({
          "x-a2a-edge-secret": "test-edge-secret",
          "x-a2a-requester-id": "operator-a",
          "x-a2a-requester-role": "operator",
        }),
        body: JSON.stringify({
          targetEnvironment: "research",
        }),
      },
    );

    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error?.code, "bad_request");
    assert.ok(typeof body.error?.message === "string");
  } finally {
    await server.close();
  }
});

test("POST /complexity-orchestration/recommendation rejects empty body as bad_request", async () => {
  const server = await startTestServer({ edgeSecret: "test-edge-secret" });
  try {
    const res = await fetch(
      server.baseUrl + "/complexity-orchestration/recommendation",
      {
        method: "POST",
        headers: jsonHeaders({
          "x-a2a-edge-secret": "test-edge-secret",
          "x-a2a-requester-id": "operator-a",
          "x-a2a-requester-role": "operator",
        }),
        body: JSON.stringify({}),
      },
    );

    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error?.code, "bad_request");
    assert.ok(typeof body.error?.message === "string");
  } finally {
    await server.close();
  }
});

test("POST /complexity-orchestration/recommendation accepts simple intent and returns direct_execution", async () => {
  const server = await startTestServer({ edgeSecret: "test-edge-secret" });
  try {
    const res = await fetch(
      server.baseUrl + "/complexity-orchestration/recommendation",
      {
        method: "POST",
        headers: jsonHeaders({
          "x-a2a-edge-secret": "test-edge-secret",
          "x-a2a-requester-id": "analyst-a",
          "x-a2a-requester-role": "analyst",
        }),
        body: JSON.stringify({
          intent: "analyze",
          targetEnvironment: "research",
        }),
      },
    );

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.kind, "a2a-broker.complexity-orchestration-recommendation-packet");
    assert.equal(body.classification.level, "simple");
    assert.equal(body.recommendation.action, "direct_execution");
    assert.equal(body.recommendation.parallelismHint, 0);
    assert.equal(body.recommendation.confidence, "high");
    assert.equal(body.boundaries.runtimeBehaviorChanged, false);
    assert.equal(body.boundaries.taskFlowMutation, false);
    assert.equal(body.boundaries.dbMutation, false);
  } finally {
    await server.close();
  }
});

test("POST /complexity-execution-plan/draft returns execution plan draft from supplied recommendation", async () => {
  const server = await startTestServer({ edgeSecret: "test-edge-secret" });
  try {
    // First, get a complexity orchestration recommendation packet.
    const recRes = await fetch(
      server.baseUrl + "/complexity-orchestration/recommendation",
      {
        method: "POST",
        headers: jsonHeaders({
          "x-a2a-edge-secret": "test-edge-secret",
          "x-a2a-requester-id": "operator-a",
          "x-a2a-requester-role": "operator",
        }),
        body: JSON.stringify({
          intent: "propose_patch",
          targetEnvironment: "research",
          policyContext: { requiresApproval: true },
          artifactCount: 2,
        }),
      },
    );
    assert.equal(recRes.status, 200);
    const recommendation = await recRes.json();
    assert.equal(recommendation.kind, "a2a-broker.complexity-orchestration-recommendation-packet");

    // Now supply it to the execution-plan/draft route.
    const res = await fetch(
      server.baseUrl + "/complexity-execution-plan/draft",
      {
        method: "POST",
        headers: jsonHeaders({
          "x-a2a-edge-secret": "test-edge-secret",
          "x-a2a-requester-id": "operator-a",
          "x-a2a-requester-role": "operator",
        }),
        body: JSON.stringify(recommendation),
      },
    );

    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");

    const body = await res.json();
    assert.equal(body.kind, "a2a-broker.complexity-execution-plan-draft.packet");
    assert.equal(body.version, 1);
    assert.ok(typeof body.generatedAt === "string");
    assert.ok(typeof body.idempotencyKey === "string");
    assert.ok(body.idempotencyKey.startsWith("complexity-execution-plan:"));
    assert.ok(typeof body.sourceEnvelopeIdempotencyKey === "string");
    assert.ok(body.sourceEnvelopeIdempotencyKey.startsWith("complexity-finalizer-approval-envelope:"));
    assert.equal(body.sourceRecommendationIdempotencyKey, recommendation.idempotencyKey);

    // Critical complexity → operator_review (source action) → operator_review_required (execution blocked)
    assert.equal(body.action, "operator_review");
    assert.equal(body.envelopeCategory, "operator_review_required");
    assert.equal(body.executionMode, "operator_review_gated");
    assert.equal(body.decision, "plan_ready");
    assert.equal(body.executionBlocked, true);
    assert.equal(body.approvalRequired, true);
    assert.deepEqual(body.blockers, []);
    assert.ok(Array.isArray(body.steps));
    assert.ok(body.steps.length > 0);
    assert.ok(body.steps.every((step: { executionBlocked: unknown }) => step.executionBlocked === true));

    // No-live boundaries
    assert.equal(body.boundaries.runtimeBehaviorChanged, false);
    assert.equal(body.boundaries.mandatoryProductionSpawn, false);
    assert.equal(body.boundaries.brokerDispatchSemanticsChanged, false);
    assert.equal(body.boundaries.taskFlowMutation, false);
    assert.equal(body.boundaries.dbMutation, false);
    assert.equal(body.boundaries.deployOrRestart, false);
    assert.equal(body.boundaries.secretMovement, false);
    assert.equal(body.boundaries.approvalGranted, false);
    assert.equal(body.boundaries.executionDispatched, false);
    assert.equal(body.semantics.planDraftOnly, true);
    assert.equal(body.semantics.approvalNotGranted, true);
    assert.equal(body.semantics.planStepsNotExecuted, true);
    assert.equal(body.semantics.createsTaskFlowRecords, false);
  } finally {
    await server.close();
  }
});

test("POST /complexity-execution-plan/draft accepts supplied approval envelope wrapper", async () => {
  const server = await startTestServer({ edgeSecret: "test-edge-secret" });
  try {
    const recRes = await fetch(
      server.baseUrl + "/complexity-orchestration/recommendation",
      {
        method: "POST",
        headers: jsonHeaders({
          "x-a2a-edge-secret": "test-edge-secret",
          "x-a2a-requester-id": "analyst-a",
          "x-a2a-requester-role": "analyst",
        }),
        body: JSON.stringify({
          intent: "analyze",
          targetEnvironment: "research",
        }),
      },
    );
    assert.equal(recRes.status, 200);
    const recommendation = await recRes.json();
    const envelopeDraft = buildFinalizerApprovalEnvelopeDraft(recommendation);

    const res = await fetch(
      server.baseUrl + "/complexity-execution-plan/draft",
      {
        method: "POST",
        headers: jsonHeaders({
          "x-a2a-edge-secret": "test-edge-secret",
          "x-a2a-requester-id": "analyst-a",
          "x-a2a-requester-role": "analyst",
        }),
        body: JSON.stringify({ envelopeDraft }),
      },
    );

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.kind, "a2a-broker.complexity-execution-plan-draft.packet");
    assert.equal(body.envelopeCategory, "approval_not_required");
    assert.equal(body.executionMode, "autonomous");
    assert.equal(body.decision, "plan_approval_not_needed");
    assert.equal(body.executionBlocked, false);
    assert.equal(body.approvalRequired, false);
    assert.equal(body.boundaries.executionDispatched, false);
    assert.equal(body.boundaries.approvalGranted, false);
    assert.equal(body.semantics.planDraftOnly, true);
  } finally {
    await server.close();
  }
});

test("POST /complexity-execution-plan/draft rejects invalid input", async () => {
  const server = await startTestServer({ edgeSecret: "test-edge-secret" });
  try {
    const res = await fetch(
      server.baseUrl + "/complexity-execution-plan/draft",
      {
        method: "POST",
        headers: jsonHeaders({
          "x-a2a-edge-secret": "test-edge-secret",
          "x-a2a-requester-id": "operator-a",
          "x-a2a-requester-role": "operator",
        }),
        body: JSON.stringify({ kind: "wrong-kind" }),
      },
    );

    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error?.code, "bad_request");
    assert.ok(typeof body.error?.message === "string");
  } finally {
    await server.close();
  }
});
