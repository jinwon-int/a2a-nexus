import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildA2ADispatchPlan,
  buildA2ADispatchTaskId,
  resolveA2AParentRoundMetadata,
} from "./a2a-dispatch-helper.js";
import {
  buildA2AWorkModeDecisionEvidence,
  buildA2AWorkModePreDispatchDecision,
} from "./work-mode-pre-dispatch-decision.js";

const BASE_SPEC = {
  teamId: "team2" as const,
  lane: 2,
  worker: "workerepsilon",
  runId: "a2a-team2-common-dispatch-20260602T130000Z",
  parentIssueUrl: "https://github.com/jinwon-int/a2a-broker/issues/1032",
  childIssueUrl: "https://github.com/jinwon-int/a2a-broker/issues/1137",
  childIssue: "#1137",
};

function validTeam1DecisionEvidence() {
  return buildA2AWorkModeDecisionEvidence(
    buildA2AWorkModePreDispatchDecision({
      now: "2026-06-07T06:00:00.000Z",
      finalizerOwner: "brokeralpha",
      task: {
        taskId: "a2a-dispatch-helper-test",
        workProfile: "candidate_review",
        ambiguity: "high",
        hasIndependentEvidenceLanes: true,
        hasMultipleCandidates: true,
      },
      workers: {
        capacityState: "healthy",
        staleTasks: 0,
        snapshotSource: "/workers/capacity",
        snapshotAt: "2026-06-07T05:59:00.000Z",
      },
    }),
  );
}

test("resolveA2AParentRoundMetadata derives Team2 order from lane and total from team default", () => {
  const result = resolveA2AParentRoundMetadata(BASE_SPEC);

  assert.equal(result.issues.length, 0);
  assert.equal(result.metadata?.parentRoundId, BASE_SPEC.runId);
  assert.equal(result.metadata?.parentRoundTotal, 4);
  assert.equal(result.metadata?.parentRoundOrder, 2);
  assert.equal(result.metadata?.parentRoundTotalSource, "team-default");
  assert.equal(result.metadata?.parentRoundOrderSource, "lane");
});

test("buildA2ADispatchPlan supports explicit cross-team totals such as 8 lanes", () => {
  const plan = buildA2ADispatchPlan({
    ...BASE_SPEC,
    lane: 6,
    parentRoundId: "a2a-1032-cross-team-round",
    parentRoundTotal: 8,
    parentRoundOrder: 6,
    brokerOfRecordId: "brokeralpha",
    originBrokerId: "brokeralpha",
    operatorFacingOwner: "parent",
    crossBrokerHandoff: {
      handoffBrokerId: "brokerbeta",
      childWorkerId: "workerepsilon",
      originBrokerId: "brokeralpha",
      originTaskId: "brokeralpha-parent-task-1",
    },
  });

  assert.equal(plan.decision.value, "go");
  assert.equal(plan.metadata.parentRoundId, "a2a-1032-cross-team-round");
  assert.equal(plan.metadata.parentRoundTotal, 8);
  assert.equal(plan.metadata.parentRoundOrder, 6);
  assert.equal(plan.taskPayload?.parentRoundTotal, 8);
  assert.equal(plan.taskPayload?.parentRoundOrder, 6);
  assert.equal(plan.taskPayload?.brokerOfRecordId, "brokeralpha");
  assert.equal(plan.taskPayload?.operatorFacingOwner, "parent");
  assert.equal(plan.taskPayload?.crossBrokerHandoff?.parentRoundId, "a2a-1032-cross-team-round");
  assert.equal(plan.taskPayload?.crossBrokerHandoff?.handoffBrokerId, "brokerbeta");
  assert.equal(plan.roundManifest?.metadata?.parentRoundTotal, "8");
  assert.equal(plan.roundManifest?.expectedWorkers[0].metadata?.parentRoundOrder, "6");
});

test("buildA2ADispatchPlan derives round total and order from actual dispatch workers", () => {
  const plan = buildA2ADispatchPlan({
    ...BASE_SPEC,
    lane: 5,
    worker: "workerdelta",
    parentRoundTotal: 9,
    parentRoundOrder: 9,
    dispatchWorkers: ["workerbeta", "workeralpha", "workergamma", "workerdelta"],
  });

  assert.equal(plan.decision.value, "go");
  assert.equal(plan.metadata.parentRoundTotal, 4);
  assert.equal(plan.metadata.parentRoundOrder, 4);
  assert.equal(plan.metadata.parentRoundTotalSource, "dispatch-workers");
  assert.equal(plan.metadata.parentRoundOrderSource, "dispatch-workers");
  assert.deepEqual(plan.taskPayload?.dispatchedWorkers, ["workerbeta", "workeralpha", "workergamma", "workerdelta"]);
  assert.equal(plan.taskPayload?.parentRoundTotal, 4);
  assert.equal(plan.taskPayload?.parentRoundOrder, 4);
});

test("buildA2ADispatchPlan blocks invalid parentRoundOrder before createTask", () => {
  const plan = buildA2ADispatchPlan(
    {
      ...BASE_SPEC,
      parentRoundTotal: 3,
      parentRoundOrder: 5,
    },
    { dryRun: false, execute: true },
  );

  assert.equal(plan.decision.value, "blocked");
  assert.ok(plan.decision.blockers.some((blocker) => blocker.includes("parentRoundOrder must be <= parentRoundTotal")));
  assert.ok(plan.dispatchActions.some((action) => action.includes("createTask: blocked")));
  assert.equal(plan.taskPayload, null);
});

test("common/ad-hoc dispatch requires an explicit total or assignment count", () => {
  const missing = buildA2ADispatchPlan({
    ...BASE_SPEC,
    teamId: "common",
  });

  assert.equal(missing.decision.value, "blocked");
  assert.ok(missing.decision.blockers.some((blocker) => blocker.includes("parentRoundTotal is required for common")));

  const derived = buildA2ADispatchPlan({
    ...BASE_SPEC,
    teamId: "common",
    assignmentCount: 8,
    parentRoundOrder: 7,
  });

  assert.equal(derived.decision.value, "go");
  assert.equal(derived.metadata.parentRoundTotal, 8);
  assert.equal(derived.metadata.parentRoundOrder, 7);
  assert.equal(derived.metadata.parentRoundTotalSource, "assignment-count");
});

test("read-only/evidence lanes carry allowNoChanges and readOnlyValidation with parent metadata", () => {
  const plan = buildA2ADispatchPlan({
    ...BASE_SPEC,
    readOnlyAudit: true,
    allowNoChanges: true,
    readOnlyValidation: true,
  });

  assert.equal(plan.decision.value, "go");
  assert.equal(plan.metadata.allowNoChanges, true);
  assert.equal(plan.metadata.readOnlyValidation, true);
  assert.equal(plan.taskPayload?.allowNoChanges, true);
  assert.equal(plan.taskPayload?.readOnlyValidation, true);
  assert.equal(plan.taskPayload?.parentRoundId, BASE_SPEC.runId);
  assert.equal(plan.roundManifest?.metadata?.allowNoChanges, "true");
  assert.equal(plan.roundManifest?.expectedWorkers[0].metadata?.readOnlyValidation, "true");
});

test("Team2 execute-mode requires brokerbeta broker-of-record handoff evidence", () => {
  const plan = buildA2ADispatchPlan(
    {
      ...BASE_SPEC,
      brokerOfRecordId: "brokeralpha",
      originBrokerId: "brokeralpha",
    },
    { dryRun: false, execute: true },
  );

  assert.equal(plan.decision.value, "blocked");
  assert.ok(plan.decision.blockers.some((blocker) => blocker.includes("team2_broker_of_record_handoff")));
  assert.ok(plan.dispatchActions.some((action) => action.includes("createTask: blocked")));
  assert.equal(plan.taskPayload, null);
});

test("Team2 execute-mode allows explicit brokerbeta cross-broker handoff", () => {
  const plan = buildA2ADispatchPlan(
    {
      ...BASE_SPEC,
      brokerOfRecordId: "brokerbeta",
      originBrokerId: "brokeralpha",
      operatorFacingOwner: "parent",
      crossBrokerHandoff: {
        handoffBrokerId: "brokerbeta",
        originBrokerId: "brokeralpha",
        originTaskId: "brokeralpha-parent-task-1",
        childWorkerId: "workerepsilon",
      },
    },
    { dryRun: false, execute: true },
  );

  assert.equal(plan.decision.value, "warn_go");
  assert.equal(plan.taskPayload?.brokerOfRecordId, "brokerbeta");
  assert.equal(plan.taskPayload?.crossBrokerHandoff?.handoffBrokerId, "brokerbeta");
});

test("Team1/common execute-mode requires work-mode decision evidence", () => {
  const plan = buildA2ADispatchPlan(
    {
      ...BASE_SPEC,
      teamId: "common",
      assignmentCount: 4,
    },
    { dryRun: false, execute: true },
  );

  assert.equal(plan.decision.value, "blocked");
  assert.ok(plan.decision.blockers.some((blocker) => blocker.includes("work_mode_decision_evidence")));
  assert.ok(plan.dispatchActions.some((action) => action.includes("createTask: blocked")));
});

test("Team1/common execute-mode persists work-mode decision evidence", () => {
  const workModeDecision = validTeam1DecisionEvidence();
  const plan = buildA2ADispatchPlan(
    {
      ...BASE_SPEC,
      teamId: "common",
      assignmentCount: 4,
      workModeDecision,
    },
    { dryRun: false, execute: true },
  );

  assert.equal(plan.decision.value, "warn_go");
  assert.equal(plan.taskPayload?.workModeDecision?.idempotencyKey, workModeDecision.idempotencyKey);
  assert.equal(plan.metadata.workModeDecision?.finalizerOwner, "brokeralpha");
  assert.equal(plan.roundManifest?.metadata?.workModeDecisionIdempotencyKey, workModeDecision.idempotencyKey);
  assert.ok(plan.dispatchActions.some((action) => action.includes("[work-mode] decision")));
});

test("buildA2ADispatchTaskId is deterministic for same Team2/common inputs", () => {
  const first = buildA2ADispatchTaskId(BASE_SPEC, { dryRun: true, execute: false });
  const second = buildA2ADispatchTaskId(BASE_SPEC, { dryRun: true, execute: false });
  const differentOrder = buildA2ADispatchTaskId(
    { ...BASE_SPEC, parentRoundTotal: 8, parentRoundOrder: 3 },
    { dryRun: true, execute: false },
  );

  assert.equal(first.taskId, second.taskId);
  assert.notEqual(first.taskId, differentOrder.taskId);
  assert.match(first.taskId, /^team2-/);
});
