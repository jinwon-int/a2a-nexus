import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
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
      parentRoundId: "brokeralpha-1032-parent-round",
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
  assert.equal(plan.taskPayload?.crossBrokerHandoff?.parentRoundId, "brokeralpha-1032-parent-round");
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
        parentRoundId: "brokeralpha-parent-round-1",
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

const HANDOFF_SPEC = {
  ...BASE_SPEC,
  parentRoundId: "brokerbeta-child-round",
  brokerOfRecordId: "brokerbeta",
  originBrokerId: "brokeralpha",
  operatorFacingOwner: "parent" as const,
};
const COMPLETE_HANDOFF = {
  parentRoundId: "brokeralpha-parent-round",
  originBrokerId: "brokeralpha",
  handoffBrokerId: "brokerbeta",
  originTaskId: "brokeralpha-parent-task-1",
};

function assertHandoffBlocked(plan: ReturnType<typeof buildA2ADispatchPlan>, pattern: RegExp): void {
  assert.equal(plan.decision.value, "blocked");
  assert.equal(plan.taskPayload, null);
  assert.ok(
    plan.decision.blockers.some((blocker) => blocker.startsWith("[cross_broker_handoff_parent]") && pattern.test(blocker)),
    `expected a cross_broker_handoff_parent blocker matching ${pattern}, got ${JSON.stringify(plan.decision.blockers)}`,
  );
}

test("#2331 cross-broker handoff without a handoff parentRoundId is blocked (no local parentRoundId fallback)", () => {
  const { parentRoundId: _omitted, ...withoutParent } = COMPLETE_HANDOFF;
  const plan = buildA2ADispatchPlan({ ...HANDOFF_SPEC, crossBrokerHandoff: withoutParent });

  assertHandoffBlocked(plan, /crossBrokerHandoff\.parentRoundId is required/);
});

test("#2331 cross-broker handoff without originTaskId is blocked", () => {
  const { originTaskId: _omitted, ...withoutOriginTask } = COMPLETE_HANDOFF;
  const plan = buildA2ADispatchPlan({ ...HANDOFF_SPEC, crossBrokerHandoff: withoutOriginTask });

  assertHandoffBlocked(plan, /originTaskId is required/);
});

test("#2331 cross-broker handoff naming the local parent round or run id is blocked as self-reference", () => {
  const sameAsParent = buildA2ADispatchPlan({
    ...HANDOFF_SPEC,
    crossBrokerHandoff: { ...COMPLETE_HANDOFF, parentRoundId: HANDOFF_SPEC.parentRoundId },
  });
  assertHandoffBlocked(sameAsParent, /self-reference/);

  const sameAsRun = buildA2ADispatchPlan({
    ...HANDOFF_SPEC,
    crossBrokerHandoff: { ...COMPLETE_HANDOFF, parentRoundId: HANDOFF_SPEC.runId },
  });
  assertHandoffBlocked(sameAsRun, /self-reference/);

  const { parentRoundId: _local, ...specWithoutLocalParent } = HANDOFF_SPEC;
  const defaultedToRun = buildA2ADispatchPlan({
    ...specWithoutLocalParent,
    crossBrokerHandoff: { ...COMPLETE_HANDOFF, parentRoundId: ` ${HANDOFF_SPEC.runId} ` },
  });
  assertHandoffBlocked(defaultedToRun, /self-reference/);
});

test("#2331 complete cross-broker handoff keeps the origin parent round in the task payload", () => {
  const plan = buildA2ADispatchPlan({ ...HANDOFF_SPEC, crossBrokerHandoff: COMPLETE_HANDOFF });

  assert.equal(plan.decision.value, "go");
  assert.equal(plan.metadata.parentRoundId, "brokerbeta-child-round");
  assert.deepEqual(plan.taskPayload?.crossBrokerHandoff, {
    ...COMPLETE_HANDOFF,
    childWorkerId: BASE_SPEC.worker,
  });
});

const HELPER_CLI = resolve(dirname(fileURLToPath(import.meta.url)), "../../scripts/a2a-dispatch-helper.mjs");
const CLI_BASE_ARGS = [
  "--team-id", "team2",
  "--worker", "workerepsilon",
  "--lane", "2",
  "--run-id", "a2a-team2-handoff-20260602T130000Z",
  "--parent-round-id", "brokerbeta-child-round",
  "--parent-issue", "https://github.com/jinwon-int/a2a-broker/issues/1032",
  "--child-issue", "https://github.com/jinwon-int/a2a-broker/issues/1137",
  "--broker-of-record-id", "brokerbeta",
  "--origin-broker-id", "brokeralpha",
  "--operator-facing-owner", "parent",
  "--cross-broker-handoff",
  "--handoff-broker-id", "brokerbeta",
  "--handoff-origin-broker-id", "brokeralpha",
];

function runHelperCli(extraArgs: string[]) {
  const result = spawnSync(process.execPath, [HELPER_CLI, ...CLI_BASE_ARGS, ...extraArgs, "--json"], { encoding: "utf8" });
  return { status: result.status, plan: JSON.parse(result.stdout) as ReturnType<typeof buildA2ADispatchPlan> };
}

test("#2331 helper CLI blocks --cross-broker-handoff without --handoff-parent-round-id (no --parent-round-id fallback)", () => {
  const { status, plan } = runHelperCli(["--handoff-origin-task-id", "brokeralpha-parent-task-1"]);

  assert.equal(status, 1);
  assertHandoffBlocked(plan, /crossBrokerHandoff\.parentRoundId is required/);
});

test("#2331 helper CLI blocks --cross-broker-handoff without --handoff-origin-task-id", () => {
  const { status, plan } = runHelperCli(["--handoff-parent-round-id", "brokeralpha-parent-round"]);

  assert.equal(status, 1);
  assertHandoffBlocked(plan, /originTaskId is required/);
});

test("#2331 helper CLI blocks a self-referencing --handoff-parent-round-id", () => {
  const { status, plan } = runHelperCli([
    "--handoff-parent-round-id", "brokerbeta-child-round",
    "--handoff-origin-task-id", "brokeralpha-parent-task-1",
  ]);

  assert.equal(status, 1);
  assertHandoffBlocked(plan, /self-reference/);
});

test("#2331 helper CLI accepts a complete cross-broker handoff", () => {
  const { status, plan } = runHelperCli([
    "--handoff-parent-round-id", "brokeralpha-parent-round",
    "--handoff-origin-task-id", "brokeralpha-parent-task-1",
  ]);

  assert.equal(status, 0);
  assert.equal(plan.decision.value, "go");
  assert.equal(plan.taskPayload?.crossBrokerHandoff?.parentRoundId, "brokeralpha-parent-round");
  assert.equal(plan.taskPayload?.crossBrokerHandoff?.originTaskId, "brokeralpha-parent-task-1");
});
