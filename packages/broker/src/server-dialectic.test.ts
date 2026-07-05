import test from "node:test";
import assert from "node:assert/strict";
import { DECISION_DIALECTIC_KIND, DECISION_DIALECTIC_VERSION, type DecisionDialecticTaskInputV1, type DecisionDialecticTaskV1 } from "./decision-dialectic/types.js";
import { DecisionDialecticExecutionError, extractDecisionDialecticTaskInput, applyDecisionDialecticPatch } from "./decision-dialectic/execution.js";
import { TRADING_DIALECTIC_KIND, TRADING_DIALECTIC_VERSION, type TradingDialecticTaskInputV1, type TradingDialecticTaskV1 } from "./trading-dialectic/types.js";
import { startTestServer, jsonHeaders, registerTestWorker } from "./server-test-helpers.js";

function buildTradingDialecticTaskFixture(
  overrides: Partial<TradingDialecticTaskV1> = {},
): TradingDialecticTaskV1 {
  return {
    kind: TRADING_DIALECTIC_KIND,
    version: TRADING_DIALECTIC_VERSION,
    taskId: "td-task-01",
    revision: 4,
    state: "EXECUTION_ROUTED",
    meta: {
      symbol: "BTCUSDT",
      venue: "binance",
      marketType: "perp",
      side: "long",
      accountRef: "acct-live-01",
      timeHorizon: "intraday",
      urgency: "normal",
      strategyId: "mean-revert-01",
      riskBudgetRef: "risk-live-01",
      snapshotAt: "2026-04-19T09:00:00.000Z",
      dataFreshnessMs: 1500,
      openedAt: "2026-04-19T09:00:00.000Z",
      expiresAt: "2026-04-19T10:00:00.000Z",
      openedBy: "brokeralpha",
    },
    roles: {
      thesisAgent: { agentId: "workergamma" },
      antithesisAgent: { agentId: "dengae" },
      synthAgent: { agentId: "brokeralpha" },
    },
    context: {
      marketSnapshot: { bid: 64000, ask: 64010 },
      contextRefs: ["ctx-01"],
      maxProbeRiskR: 0.5,
      maxFullRiskR: 1,
      maxLeverage: 5,
      maxTimestampDriftMs: 2000,
    },
    thesis: {
      author: { agentId: "workergamma" },
      submittedAt: "2026-04-19T09:05:00.000Z",
      regimeHypothesis: "trend-up",
      tradeIdea: "long perp",
      whyNow: "breakout confirmed",
      entryPlan: "limit at pullback",
      invalidation: "below prior swing",
      targets: ["64500", "65000"],
      confidence: 0.7,
      evidenceRefs: ["ev-01"],
      assumptions: ["liquidity holds"],
      riskNotes: ["watch funding"],
    },
    antithesis: {
      author: { agentId: "dengae" },
      submittedAt: "2026-04-19T09:10:00.000Z",
      counterView: "false breakout risk",
      alternativeRegime: "chop",
      whyThesisMayFail: "thin volume",
      failureModes: ["liquidity vacuum"],
      contradictions: ["weakening RSI"],
      vetoFlags: [],
      evidenceRefs: ["ev-02"],
      confidence: 0.6,
    },
    rebuttal: {
      author: { agentId: "workergamma" },
      submittedAt: "2026-04-19T09:15:00.000Z",
      response: "volume returning post-open",
      defendedClaims: ["trend intact"],
      concededRisks: ["funding spike risk"],
      residualRisks: ["news event"],
    },
    synthesis: {
      author: { agentId: "brokeralpha" },
      submittedAt: "2026-04-19T09:20:00.000Z",
      preserve: ["entry plan"],
      discard: ["aggressive sizing"],
      metaRule: "probe-first under low conviction",
      verdict: "EXECUTE_PROBE",
      triggerSet: ["price>64200"],
      sizeRule: "0.5R",
      killSwitch: ["price<63500"],
      unresolved: ["funding outcome"],
    },
    decision: {
      action: "EXECUTE_PROBE",
      routeTo: "workergamma",
      ttlSec: 600,
      hardVeto: false,
      executionPolicyRef: "policy-probe-v1",
      decisionBasisRevision: 4,
    },
    ...overrides,
  };
}

function buildTradingDialecticPayload(
  overrides: Partial<TradingDialecticTaskV1> = {},
  phase: TradingDialecticTaskInputV1["contract"]["phase"] = "synthesis",
): TradingDialecticTaskInputV1 {
  return {
    contract: {
      kind: TRADING_DIALECTIC_KIND,
      version: TRADING_DIALECTIC_VERSION,
      phase,
      task: buildTradingDialecticTaskFixture(overrides),
    },
  };
}

function buildDecisionDialecticTaskFixture(
  overrides: Partial<DecisionDialecticTaskV1> = {},
): DecisionDialecticTaskV1 {
  return {
    kind: DECISION_DIALECTIC_KIND,
    version: DECISION_DIALECTIC_VERSION,
    taskId: "dd-task-01",
    revision: 3,
    state: "DECISION_ROUTED",
    meta: {
      topic: "gateway-heartbeat-polling",
      domain: "operations",
      urgency: "high",
      openedAt: "2026-05-18T00:00:00.000Z",
      snapshotAt: "2026-05-18T00:02:00.000Z",
      expiresAt: "2026-05-18T06:00:00.000Z",
      openedBy: "brokeralpha",
      contextRefs: ["wiki:pages/a2a/dialectic-mode.md"],
      tags: ["a2ad", "ops"],
    },
    roles: {
      thesisAgent: { agentId: "workerbeta", teamId: "team1", roleHint: "thesis" },
      antithesisAgent: { agentId: "workeralpha", teamId: "team1", roleHint: "antithesis" },
      rebuttalAgent: { agentId: "workergamma", teamId: "team1", roleHint: "rebuttal" },
      synthAgent: { agentId: "workerdelta", teamId: "team1", roleHint: "synthesis" },
    },
    context: {
      brief: "Evaluate whether to reduce heartbeat polling pressure.",
      objective: "Keep operator liveness without overloading broker foreground sessions.",
      constraints: ["no production restart in this task", "no provider send"],
      decisionCriteria: ["liveness preserved", "event loop pressure reduced"],
      evidenceRefs: ["gh:jinwon-int/a2a-broker#489"],
      availableTools: ["logs", "unit-tests"],
      hardVetoPolicy: ["would require unapproved restart", "drops operator visibility"],
      domainContext: {
        brokerId: "brokeralpha",
        team: "team1",
      },
    },
    thesis: {
      author: { agentId: "workerbeta" },
      submittedAt: "2026-05-18T00:05:00.000Z",
      claim: "Reduce redundant idle polling.",
      proposal: "Bound idle polling and keep explicit heartbeat updates.",
      rationale: "The operator channel should stay responsive during closeout rounds.",
      expectedBenefits: ["lower event-loop pressure", "clearer liveness signal"],
      evidenceRefs: ["ev-01"],
      assumptions: ["foreground sessions remain the report channel"],
      risks: ["over-reducing polling may hide stalls"],
      confidence: 0.72,
    },
    antithesis: {
      author: { agentId: "workeralpha" },
      submittedAt: "2026-05-18T00:10:00.000Z",
      counterClaim: "Too much reduction can hide worker stalls.",
      whyThesisMayFail: "Operators rely on visible heartbeat signals.",
      failureModes: ["stale status", "silent failure"],
      contradictions: ["liveness and lower polling trade off"],
      vetoFlags: [
        {
          code: "drops_operator_visibility",
          reason: "A change that removes visible heartbeat evidence must block.",
          severity: "warn",
        },
      ],
      evidenceRefs: ["ev-02"],
      confidence: 0.64,
    },
    rebuttal: {
      author: { agentId: "workergamma" },
      submittedAt: "2026-05-18T00:15:00.000Z",
      response: "Keep heartbeat summaries while bounding duplicate scans.",
      defendedClaims: ["operator visibility remains explicit"],
      concededRisks: ["some polling is still needed"],
      residualRisks: ["misconfigured interval"],
    },
    synthesis: {
      author: { agentId: "workerdelta" },
      submittedAt: "2026-05-18T00:20:00.000Z",
      preserve: ["explicit heartbeat signal"],
      discard: ["unbounded duplicate polling"],
      decisionRule: "Proceed only as a bounded no-live implementation.",
      verdict: "PROCEED_WITH_GUARDRAILS",
      guardrails: ["no restart", "unit tests only"],
      followups: ["separate live canary approval"],
      unresolved: ["production interval tuning"],
    },
    decision: {
      action: "PROCEED_WITH_GUARDRAILS",
      routeTo: "workerdelta",
      ttlSec: 1800,
      hardVeto: false,
      decisionPolicyRef: "decision-dialectic-no-live-v1",
      decisionBasisRevision: 3,
    },
    ...overrides,
  };
}

function buildDecisionDialecticPayload(
  overrides: Partial<DecisionDialecticTaskV1> = {},
  phase: DecisionDialecticTaskInputV1["contract"]["phase"] = "synthesis",
): DecisionDialecticTaskInputV1 {
  return {
    contract: {
      kind: DECISION_DIALECTIC_KIND,
      version: DECISION_DIALECTIC_VERSION,
      phase,
      task: buildDecisionDialecticTaskFixture(overrides),
    },
  };
}

test("decision-dialectic rejects non-independent roles using agentId/nodeId aliases", () => {
  const base = buildDecisionDialecticTaskFixture();
  const invalidThesisAntithesis = buildDecisionDialecticPayload({
    roles: {
      ...base.roles,
      thesisAgent: { agentId: "workerbeta", nodeId: "workerbeta-node" },
      antithesisAgent: { agentId: "workeralpha", nodeId: "workerbeta" },
    },
  });

  assert.throws(
    () => extractDecisionDialecticTaskInput(invalidThesisAntithesis as unknown as Record<string, unknown>),
    (error) => error instanceof DecisionDialecticExecutionError && error.code === "dialectic_roles_not_independent",
  );

  const invalidSynth = buildDecisionDialecticPayload({
    roles: {
      ...base.roles,
      thesisAgent: { agentId: "workerbeta", nodeId: "workerbeta-node" },
      synthAgent: { agentId: "workerbeta-node" },
    },
  });

  assert.throws(
    () => extractDecisionDialecticTaskInput(invalidSynth as unknown as Record<string, unknown>),
    (error) => error instanceof DecisionDialecticExecutionError && error.code === "dialectic_roles_not_independent",
  );
});

test("decision-dialectic warns on non-substantive antithesis by default", () => {
  const task = buildDecisionDialecticTaskFixture({
    revision: 1,
    state: "THESIS_SUBMITTED",
    antithesis: undefined,
    rebuttal: undefined,
    synthesis: undefined,
    decision: undefined,
    outcome: undefined,
  });

  const updated = applyDecisionDialecticPatch(task, {
    patchId: "patch-antithesis-weak",
    taskId: task.taskId,
    expectedRevision: 1,
    authorAgent: "workeralpha",
    at: "2026-05-18T00:10:00.000Z",
    op: "append.antithesis",
    payload: {
      author: { agentId: "workeralpha" },
      submittedAt: "2026-05-18T00:10:00.000Z",
      counterClaim: "Reduce redundant idle polling.",
      whyThesisMayFail: "It may fail.",
      failureModes: [],
      contradictions: ["unclear"],
      vetoFlags: [],
      evidenceRefs: ["ev-01"],
      confidence: 0.4,
    },
  });

  assert.equal(updated.state, "ANTITHESIS_SUBMITTED");
  assert.deepEqual(
    updated.substanceWarnings?.map((warning) => warning.code).sort(),
    [
      "antithesis_contradiction_not_cross_referenced",
      "antithesis_failure_modes_not_substantive",
      "antithesis_missing_independent_evidence",
    ],
  );
});

test("decision-dialectic enforce mode rejects non-substantive antithesis", () => {
  const task = buildDecisionDialecticTaskFixture({
    revision: 1,
    state: "THESIS_SUBMITTED",
    antithesis: undefined,
    rebuttal: undefined,
    synthesis: undefined,
    decision: undefined,
    outcome: undefined,
    context: {
      ...buildDecisionDialecticTaskFixture().context,
      domainContext: { decisionDialecticSubstanceGate: "enforce" },
    },
  });

  assert.throws(
    () => applyDecisionDialecticPatch(task, {
      patchId: "patch-antithesis-weak-enforce",
      taskId: task.taskId,
      expectedRevision: 1,
      authorAgent: "workeralpha",
      at: "2026-05-18T00:10:00.000Z",
      op: "append.antithesis",
      payload: {
        author: { agentId: "workeralpha" },
        submittedAt: "2026-05-18T00:10:00.000Z",
        counterClaim: "Reduce redundant idle polling.",
        whyThesisMayFail: "It may fail.",
        failureModes: [],
        contradictions: ["unclear"],
        vetoFlags: [],
        evidenceRefs: ["ev-01"],
        confidence: 0.4,
      },
    }),
    (error) => error instanceof DecisionDialecticExecutionError && error.code === "antithesis_not_substantive",
  );
});

test("decision-dialectic accepts substantive antithesis without warnings", () => {
  const task = buildDecisionDialecticTaskFixture({
    revision: 1,
    state: "THESIS_SUBMITTED",
    antithesis: undefined,
    rebuttal: undefined,
    synthesis: undefined,
    decision: undefined,
    outcome: undefined,
  });

  const updated = applyDecisionDialecticPatch(task, {
    patchId: "patch-antithesis-strong",
    taskId: task.taskId,
    expectedRevision: 1,
    authorAgent: "workeralpha",
    at: "2026-05-18T00:10:00.000Z",
    op: "append.antithesis",
    payload: {
      author: { agentId: "workeralpha" },
      submittedAt: "2026-05-18T00:10:00.000Z",
      counterClaim: "Reduced idle polling can hide heartbeat stalls.",
      whyThesisMayFail: "The proposal assumes explicit heartbeat updates always survive scheduler pressure.",
      failureModes: ["heartbeat updates stall while duplicate scans are bounded"],
      contradictions: ["The thesis claim about lower event-loop pressure conflicts with the assumption that foreground sessions remain the report channel"],
      vetoFlags: [],
      evidenceRefs: ["ev-02"],
      confidence: 0.62,
    },
  });

  assert.equal(updated.state, "ANTITHESIS_SUBMITTED");
  assert.deepEqual(updated.substanceWarnings ?? [], []);
});

test("decision-dialectic warns on rebuttal with no risk acknowledgement", () => {
  const task = buildDecisionDialecticTaskFixture({
    revision: 2,
    state: "ANTITHESIS_SUBMITTED",
    rebuttal: undefined,
    synthesis: undefined,
    decision: undefined,
    outcome: undefined,
  });

  const updated = applyDecisionDialecticPatch(task, {
    patchId: "patch-rebuttal-empty-risks",
    taskId: task.taskId,
    expectedRevision: 2,
    authorAgent: "workergamma",
    at: "2026-05-18T00:15:00.000Z",
    op: "append.rebuttal",
    payload: {
      author: { agentId: "workergamma" },
      submittedAt: "2026-05-18T00:15:00.000Z",
      response: "The thesis still stands.",
      defendedClaims: ["operator visibility remains explicit"],
      concededRisks: [],
      residualRisks: [],
    },
  });

  assert.equal(updated.state, "REBUTTAL_SUBMITTED");
  assert.deepEqual(updated.substanceWarnings?.map((warning) => warning.code), [
    "rebuttal_missing_risk_acknowledgement",
  ]);
});

test("decision-dialectic read model returns generic stage rail and dynamic role routing", async () => {
  const server = await startTestServer({
    edgeSecret: "test-edge-secret",
    enforceRequesterIdentity: true,
  });
  try {
    await registerTestWorker(server.baseUrl, "workerbeta", "analyst", "test-edge-secret");
    const createRes = await fetch(`${server.baseUrl}/tasks`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "hub-a",
        "x-a2a-requester-role": "hub",
      }),
      body: JSON.stringify({
        intent: "analyze",
        requester: { id: "hub-a", kind: "node", role: "hub" },
        target: { id: "workerbeta", kind: "node", role: "analyst" },
        assignedWorkerId: "workerbeta",
        message: "evaluate generic decision dialectic",
        payload: buildDecisionDialecticPayload(),
      }),
    });
    assert.equal(createRes.status, 201);
    const task = await createRes.json();

    const readRes = await fetch(`${server.baseUrl}/tasks/${task.id}/decision-dialectic`, {
      headers: {
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "hub-a",
        "x-a2a-requester-role": "hub",
      },
    });
    assert.equal(readRes.status, 200);
    const body = await readRes.json();

    assert.equal(body.kind, "decision.dialectic");
    assert.equal(body.version, 1);
    assert.equal(body.brokerTaskId, task.id);
    assert.equal(body.contract.taskId, "dd-task-01");
    assert.equal(body.contract.state, "DECISION_ROUTED");
    assert.equal(body.contract.phase, "synthesis");
    assert.equal(body.meta.topic, "gateway-heartbeat-polling");
    assert.equal(body.meta.domain, "operations");
    assert.equal(body.roles.thesisAgent.agentId, "workerbeta");
    assert.equal(body.roles.antithesisAgent.agentId, "workeralpha");
    assert.equal(body.roles.rebuttalAgent.agentId, "workergamma");
    assert.equal(body.roles.synthAgent.agentId, "workerdelta");
    assert.equal(body.context.domainContext.brokerId, "brokeralpha");

    const stageNames = ["thesis", "antithesis", "rebuttal", "synthesis", "outcome"];
    for (const stage of stageNames) {
      assert.ok(body.stages[stage], `expected stage ${stage}`);
      assert.equal(body.stages[stage].name, stage);
    }
    assert.equal(body.stages.thesis.author.agentId, "workerbeta");
    assert.equal(body.stages.antithesis.vetoFlags[0].code, "drops_operator_visibility");
    assert.deepEqual(body.substanceWarnings, []);
    assert.equal(body.stages.synthesis.verdict, "PROCEED_WITH_GUARDRAILS");
    assert.equal(body.stages.outcome.present, false);

    assert.equal(body.decisionCard.present, true);
    assert.equal(body.decisionCard.verdict, "PROCEED_WITH_GUARDRAILS");
    assert.equal(body.decisionCard.route, "workerdelta");
    assert.equal(body.decisionCard.hardVeto, false);
    assert.equal(body.decisionCard.decisionPolicyRef, "decision-dialectic-no-live-v1");
    assert.equal(body.decisionCard.decisionBasisRevision, 3);
    assert.equal(body.decisionCard.ttlSec, 1800);
    assert.equal(body.decisionCard.decidedBy.agentId, "workerdelta");
    assert.equal(body.summary.confidence.thesis, 0.72);
    assert.equal(body.summary.confidence.antithesis, 0.64);
    assert.equal(body.summary.confidence.minimum, 0.64);
    assert.equal(body.summary.confidence.lowConfidence, false);
    assert.match(body.summary.headline, /confidence thesis 0\.72\/antithesis 0\.64/);
    assert.match(body.summary.decision, /PROCEED_WITH_GUARDRAILS/);
  } finally {
    await server.close();
  }
});

test("decision-dialectic execution advances phase tasks and applies ordered patches", async () => {
  const server = await startTestServer({
    brokerId: "brokeralpha",
    teamId: "team1",
    edgeSecret: "test-edge-secret",
    enforceRequesterIdentity: true,
  });
  try {
    for (const workerId of ["workerbeta", "workeralpha", "workergamma", "workerdelta"]) {
      await registerTestWorker(server.baseUrl, workerId, "analyst", "test-edge-secret");
    }

    const createRes = await fetch(`${server.baseUrl}/tasks`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "hub-a",
        "x-a2a-requester-role": "hub",
      }),
      body: JSON.stringify({
        intent: "analyze",
        requester: { id: "hub-a", kind: "node", role: "hub" },
        target: { id: "workerbeta", kind: "node", role: "analyst" },
        assignedWorkerId: "workerbeta",
        brokerOfRecord: "brokeralpha",
        teamId: "team1",
        message: "run generic decision dialectic",
        payload: buildDecisionDialecticPayload(
          {
            revision: 0,
            state: "OPEN",
            thesis: undefined,
            antithesis: undefined,
            rebuttal: undefined,
            synthesis: undefined,
            decision: undefined,
            outcome: undefined,
          },
          "thesis",
        ),
      }),
    });
    assert.equal(createRes.status, 201);
    const parent = await createRes.json();
    const fixture = buildDecisionDialecticTaskFixture();

    const advanceThesisRes = await fetch(`${server.baseUrl}/tasks/${parent.id}/decision-dialectic/advance`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "hub-a",
        "x-a2a-requester-role": "hub",
      }),
      body: JSON.stringify({}),
    });
    assert.equal(advanceThesisRes.status, 201);
    const thesisAdvance = await advanceThesisRes.json();
    assert.equal(thesisAdvance.phase, "thesis");
    assert.equal(thesisAdvance.parentTaskId, parent.id);
    assert.equal(thesisAdvance.childTask.parentTaskId, parent.id);
    assert.equal(thesisAdvance.childTask.targetNodeId, "workerbeta");
    assert.equal(thesisAdvance.childTask.assignedWorkerId, "workerbeta");
    assert.equal(thesisAdvance.childTask.payload.promptSpec.schemaName, "decisionDialectic.thesis.v1");
    assert.equal(thesisAdvance.childTask.payload.execution.expectedRevision, 0);
    assert.equal(thesisAdvance.childTask.brokerOfRecord, "brokeralpha");
    assert.equal(thesisAdvance.childTask.teamId, "team1");

    const thesisPatchRes = await fetch(`${server.baseUrl}/tasks/${parent.id}/decision-dialectic/patch`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "workerbeta",
        "x-a2a-requester-role": "analyst",
      }),
      body: JSON.stringify({
        op: "append.thesis",
        patchId: "patch-thesis-1",
        taskId: "dd-task-01",
        expectedRevision: 0,
        authorAgent: "workerbeta",
        at: "2026-05-18T00:05:00.000Z",
        payload: fixture.thesis,
      }),
    });
    assert.equal(thesisPatchRes.status, 200);
    const thesisReadModel = await thesisPatchRes.json();
    assert.equal(thesisReadModel.contract.revision, 1);
    assert.equal(thesisReadModel.contract.state, "THESIS_SUBMITTED");
    assert.equal(thesisReadModel.contract.phase, "antithesis");
    assert.equal(thesisReadModel.stages.thesis.present, true);

    const advanceAntithesisRes = await fetch(`${server.baseUrl}/tasks/${parent.id}/decision-dialectic/advance`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "hub-a",
        "x-a2a-requester-role": "hub",
      }),
      body: JSON.stringify({}),
    });
    assert.equal(advanceAntithesisRes.status, 201);
    const antithesisAdvance = await advanceAntithesisRes.json();
    assert.equal(antithesisAdvance.phase, "antithesis");
    assert.equal(antithesisAdvance.childTask.targetNodeId, "workeralpha");
    assert.equal(antithesisAdvance.childTask.payload.execution.expectedRevision, 1);

    for (const patch of [
      {
        op: "append.antithesis",
        patchId: "patch-antithesis-1",
        expectedRevision: 1,
        authorAgent: "workeralpha",
        payload: fixture.antithesis,
      },
      {
        op: "append.rebuttal",
        patchId: "patch-rebuttal-1",
        expectedRevision: 2,
        authorAgent: "workergamma",
        payload: fixture.rebuttal,
      },
      {
        op: "set.synthesis_decision",
        patchId: "patch-synthesis-1",
        expectedRevision: 3,
        authorAgent: "workerdelta",
        payload: {
          author: { agentId: "workerdelta" },
          submittedAt: "2026-05-18T00:20:00.000Z",
          synthesis: fixture.synthesis,
          decision: fixture.decision,
        },
      },
    ]) {
      const patchRes = await fetch(`${server.baseUrl}/tasks/${parent.id}/decision-dialectic/patch`, {
        method: "POST",
        headers: jsonHeaders({
          "x-a2a-edge-secret": "test-edge-secret",
          "x-a2a-requester-id": patch.authorAgent,
          "x-a2a-requester-role": "analyst",
        }),
        body: JSON.stringify({
          ...patch,
          taskId: "dd-task-01",
          at: "2026-05-18T00:20:00.000Z",
        }),
      });
      assert.equal(patchRes.status, 200);
    }

    const readRes = await fetch(`${server.baseUrl}/tasks/${parent.id}/decision-dialectic`, {
      headers: {
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "hub-a",
        "x-a2a-requester-role": "hub",
      },
    });
    assert.equal(readRes.status, 200);
    const readModel = await readRes.json();
    assert.equal(readModel.contract.revision, 4);
    assert.equal(readModel.contract.state, "DECISION_ROUTED");
    assert.equal(readModel.contract.phase, "outcome");
    assert.equal(readModel.decisionCard.verdict, "PROCEED_WITH_GUARDRAILS");
    assert.equal(readModel.decisionCard.route, "workerdelta");
  } finally {
    await server.close();
  }
});

test("decision-dialectic execution rejects out-of-order patches", async () => {
  const server = await startTestServer({
    edgeSecret: "test-edge-secret",
    enforceRequesterIdentity: true,
  });
  try {
    await registerTestWorker(server.baseUrl, "workerbeta", "analyst", "test-edge-secret");
    await registerTestWorker(server.baseUrl, "workeralpha", "analyst", "test-edge-secret");
    const createRes = await fetch(`${server.baseUrl}/tasks`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "hub-a",
        "x-a2a-requester-role": "hub",
      }),
      body: JSON.stringify({
        intent: "analyze",
        requester: { id: "hub-a", kind: "node", role: "hub" },
        target: { id: "workerbeta", kind: "node", role: "analyst" },
        assignedWorkerId: "workerbeta",
        message: "run generic decision dialectic",
        payload: buildDecisionDialecticPayload(
          {
            revision: 0,
            state: "OPEN",
            thesis: undefined,
            antithesis: undefined,
            rebuttal: undefined,
            synthesis: undefined,
            decision: undefined,
            outcome: undefined,
          },
          "thesis",
        ),
      }),
    });
    assert.equal(createRes.status, 201);
    const parent = await createRes.json();
    const fixture = buildDecisionDialecticTaskFixture();

    const patchRes = await fetch(`${server.baseUrl}/tasks/${parent.id}/decision-dialectic/patch`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "workeralpha",
        "x-a2a-requester-role": "analyst",
      }),
      body: JSON.stringify({
        op: "append.antithesis",
        patchId: "patch-antithesis-early",
        taskId: "dd-task-01",
        expectedRevision: 0,
        authorAgent: "workeralpha",
        at: "2026-05-18T00:10:00.000Z",
        payload: fixture.antithesis,
      }),
    });
    assert.equal(patchRes.status, 409);
    const body = await patchRes.json();
    assert.equal(body.error.code, "invalid_transition");
    assert.match(body.error.message, /thesis is required/);
  } finally {
    await server.close();
  }
});

test("decision-dialectic route returns 404 when task is not a decision.dialectic", async () => {
  const server = await startTestServer({
    edgeSecret: "test-edge-secret",
    enforceRequesterIdentity: true,
  });
  try {
    await registerTestWorker(server.baseUrl, "workergamma", "live-trader", "test-edge-secret");
    const createRes = await fetch(`${server.baseUrl}/tasks`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "hub-a",
        "x-a2a-requester-role": "hub",
      }),
      body: JSON.stringify({
        intent: "analyze",
        requester: { id: "hub-a", kind: "node", role: "hub" },
        target: { id: "workergamma", kind: "node", role: "live-trader" },
        assignedWorkerId: "workergamma",
        message: "trade BTCUSDT",
        payload: buildTradingDialecticPayload(),
      }),
    });
    assert.equal(createRes.status, 201);
    const task = await createRes.json();

    const readRes = await fetch(`${server.baseUrl}/tasks/${task.id}/decision-dialectic`, {
      headers: {
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "hub-a",
        "x-a2a-requester-role": "hub",
      },
    });
    assert.equal(readRes.status, 404);
    const body = await readRes.json();
    assert.equal(body.error.code, "not_found");
    assert.match(body.error.message, /decision\.dialectic/);
  } finally {
    await server.close();
  }
});

test("trading-dialectic read model returns operator stage rail and decision card", async () => {
  const server = await startTestServer({
    edgeSecret: "test-edge-secret",
    enforceRequesterIdentity: true,
  });
  try {
    await registerTestWorker(server.baseUrl, "workergamma", "live-trader", "test-edge-secret");
    const createRes = await fetch(`${server.baseUrl}/tasks`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "hub-a",
        "x-a2a-requester-role": "hub",
      }),
      body: JSON.stringify({
        intent: "analyze",
        requester: { id: "hub-a", kind: "node", role: "hub" },
        target: { id: "workergamma", kind: "node", role: "live-trader" },
        assignedWorkerId: "workergamma",
        message: "trade BTCUSDT",
        payload: buildTradingDialecticPayload(),
      }),
    });
    assert.equal(createRes.status, 201);
    const task = await createRes.json();

    const readRes = await fetch(`${server.baseUrl}/tasks/${task.id}/trading-dialectic`, {
      headers: {
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "hub-a",
        "x-a2a-requester-role": "hub",
      },
    });
    assert.equal(readRes.status, 200);
    const body = await readRes.json();

    assert.equal(body.kind, "trading.dialectic");
    assert.equal(body.version, 1);
    assert.equal(body.brokerTaskId, task.id);
    assert.equal(body.contract.taskId, "td-task-01");
    assert.equal(body.contract.revision, 4);
    assert.equal(body.contract.state, "EXECUTION_ROUTED");
    assert.equal(body.contract.phase, "synthesis");
    assert.equal(body.meta.symbol, "BTCUSDT");
    assert.equal(body.roles.synthAgent.agentId, "brokeralpha");

    const stageNames = ["thesis", "antithesis", "rebuttal", "synthesis", "outcome"];
    for (const stage of stageNames) {
      assert.ok(body.stages[stage], `expected stage ${stage}`);
      assert.equal(body.stages[stage].name, stage);
    }
    assert.equal(body.stages.thesis.present, true);
    assert.equal(body.stages.thesis.author.agentId, "workergamma");
    assert.equal(body.stages.thesis.at, "2026-04-19T09:05:00.000Z");
    assert.equal(body.stages.antithesis.present, true);
    assert.deepEqual(body.stages.antithesis.vetoFlags, []);
    assert.equal(body.stages.synthesis.present, true);
    assert.equal(body.stages.synthesis.verdict, "EXECUTE_PROBE");
    assert.equal(body.stages.outcome.present, false);
    assert.equal(body.stages.outcome.data, undefined);

    assert.equal(body.decisionCard.present, true);
    assert.equal(body.decisionCard.verdict, "EXECUTE_PROBE");
    assert.equal(body.decisionCard.route, "workergamma");
    assert.equal(body.decisionCard.hardVeto, false);
    assert.equal(body.decisionCard.executionPolicyRef, "policy-probe-v1");
    assert.equal(body.decisionCard.decisionBasisRevision, 4);
    assert.equal(body.decisionCard.ttlSec, 600);
    assert.equal(body.decisionCard.decidedBy.agentId, "brokeralpha");
    assert.equal(body.decisionCard.decidedAt, "2026-04-19T09:20:00.000Z");

    assert.equal(typeof body.summary.headline, "string");
    assert.equal(typeof body.summary.decision, "string");
    assert.match(body.summary.decision, /EXECUTE_PROBE/);
  } finally {
    await server.close();
  }
});

test("trading-dialectic read model omits absent decision card and stages", async () => {
  const server = await startTestServer({
    edgeSecret: "test-edge-secret",
    enforceRequesterIdentity: true,
  });
  try {
    await registerTestWorker(server.baseUrl, "workergamma", "live-trader", "test-edge-secret");
    const createRes = await fetch(`${server.baseUrl}/tasks`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "hub-a",
        "x-a2a-requester-role": "hub",
      }),
      body: JSON.stringify({
        intent: "analyze",
        requester: { id: "hub-a", kind: "node", role: "hub" },
        target: { id: "workergamma", kind: "node", role: "live-trader" },
        assignedWorkerId: "workergamma",
        message: "early stage trade",
        payload: buildTradingDialecticPayload(
          {
            state: "THESIS_SUBMITTED",
            revision: 1,
            antithesis: undefined,
            rebuttal: undefined,
            synthesis: undefined,
            decision: undefined,
            outcome: undefined,
          },
          "thesis",
        ),
      }),
    });
    assert.equal(createRes.status, 201);
    const task = await createRes.json();

    const readRes = await fetch(`${server.baseUrl}/tasks/${task.id}/trading-dialectic`, {
      headers: {
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "hub-a",
        "x-a2a-requester-role": "hub",
      },
    });
    assert.equal(readRes.status, 200);
    const body = await readRes.json();

    assert.equal(body.contract.state, "THESIS_SUBMITTED");
    assert.equal(body.contract.phase, "thesis");
    assert.equal(body.stages.thesis.present, true);
    assert.equal(body.stages.antithesis.present, false);
    assert.equal(body.stages.synthesis.present, false);
    assert.equal(body.stages.synthesis.verdict, undefined);
    assert.equal(body.stages.outcome.present, false);
    assert.equal(body.decisionCard.present, false);
    assert.equal(body.decisionCard.verdict, undefined);
    assert.equal(body.decisionCard.route, undefined);
  } finally {
    await server.close();
  }
});

test("trading-dialectic route returns 404 when task is not a trading.dialectic", async () => {
  const server = await startTestServer({
    edgeSecret: "test-edge-secret",
    enforceRequesterIdentity: true,
  });
  try {
    await registerTestWorker(server.baseUrl, "worker-a", "analyst", "test-edge-secret");
    const createRes = await fetch(`${server.baseUrl}/tasks`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "hub-a",
        "x-a2a-requester-role": "hub",
      }),
      body: JSON.stringify({
        intent: "analyze",
        requester: { id: "hub-a", kind: "node", role: "hub" },
        target: { id: "worker-a", kind: "node", role: "analyst" },
        assignedWorkerId: "worker-a",
        message: "non-dialectic task",
      }),
    });
    assert.equal(createRes.status, 201);
    const task = await createRes.json();

    const readRes = await fetch(`${server.baseUrl}/tasks/${task.id}/trading-dialectic`, {
      headers: {
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "hub-a",
        "x-a2a-requester-role": "hub",
      },
    });
    assert.equal(readRes.status, 404);
    const body = await readRes.json();
    assert.equal(body.error.code, "not_found");
    assert.match(body.error.message, /trading\.dialectic/);

    const missingRes = await fetch(
      `${server.baseUrl}/tasks/does-not-exist/trading-dialectic`,
      {
        headers: {
          "x-a2a-edge-secret": "test-edge-secret",
          "x-a2a-requester-id": "hub-a",
          "x-a2a-requester-role": "hub",
        },
      },
    );
    assert.equal(missingRes.status, 404);
    const missingBody = await missingRes.json();
    assert.equal(missingBody.error.code, "not_found");
    assert.match(missingBody.error.message, /task not found/);
  } finally {
    await server.close();
  }
});

test("trading-dialectic route rejects unsupported version with 400", async () => {
  const server = await startTestServer({
    edgeSecret: "test-edge-secret",
    enforceRequesterIdentity: true,
  });
  try {
    await registerTestWorker(server.baseUrl, "worker-a", "analyst", "test-edge-secret");
    const createRes = await fetch(`${server.baseUrl}/tasks`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "hub-a",
        "x-a2a-requester-role": "hub",
      }),
      body: JSON.stringify({
        intent: "analyze",
        requester: { id: "hub-a", kind: "node", role: "hub" },
        target: { id: "worker-a", kind: "node", role: "analyst" },
        assignedWorkerId: "worker-a",
        message: "future-version contract",
        payload: {
          contract: {
            kind: TRADING_DIALECTIC_KIND,
            version: 99,
            phase: "thesis",
            task: buildTradingDialecticTaskFixture(),
          },
        },
      }),
    });
    assert.equal(createRes.status, 201);
    const task = await createRes.json();

    const readRes = await fetch(`${server.baseUrl}/tasks/${task.id}/trading-dialectic`, {
      headers: {
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "hub-a",
        "x-a2a-requester-role": "hub",
      },
    });
    assert.equal(readRes.status, 400);
    const body = await readRes.json();
    assert.equal(body.error.code, "bad_request");
    assert.match(body.error.message, /unsupported.*version/);
  } finally {
    await server.close();
  }
});
