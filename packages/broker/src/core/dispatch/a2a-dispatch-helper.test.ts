import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
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
  const spec = {
    ...BASE_SPEC,
    brokerOfRecordId: "brokerbeta",
    originBrokerId: "brokeralpha",
    operatorFacingOwner: "parent" as const,
    crossBrokerHandoff: {
      parentRoundId: "brokeralpha-parent-round-1",
      handoffBrokerId: "brokerbeta",
      originBrokerId: "brokeralpha",
      originTaskId: "brokeralpha-parent-task-1",
      childWorkerId: "workerepsilon",
    },
  };
  // #2556: execute mode needs the minting broker's registry entry for the round.
  const unproven = buildA2ADispatchPlan(spec, { dryRun: false, execute: true });
  const plan = buildA2ADispatchPlan(spec, {
    dryRun: false,
    execute: true,
    parentRoundRegistrationReceipt: registryEntryFor(unproven),
  });

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

const HELPER_CLI = resolve(dirname(fileURLToPath(import.meta.url)), "../../../scripts/a2a-dispatch-helper.mjs");
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

// ---- #2339 PR-1b: parent round registration pre-steps (helper stays source-only)

test("#2339 PR-1b cross-broker plan prints the mint and anchor requests to run first", () => {
  const plan = buildA2ADispatchPlan({ ...HANDOFF_SPEC, parentRoundTotal: 8, crossBrokerHandoff: COMPLETE_HANDOFF });

  assert.equal(plan.decision.value, "go");
  assert.deepEqual(plan.parentRoundRegistration, {
    mintingBrokerId: "brokeralpha",
    mint: {
      method: "POST",
      path: "/a2a/parent-rounds",
      body: {
        parentRoundId: "brokeralpha-parent-round",
        initiatingBrokerId: "brokeralpha",
        teamScope: "team2",
        handoffBrokerId: "brokerbeta",
        parentRoundTotal: 8,
      },
    },
    anchors: [
      { method: "POST", path: "/a2a/parent-rounds/brokeralpha-parent-round/anchors", body: { anchor: "brokeralpha-parent-task-1" } },
      { method: "POST", path: "/a2a/parent-rounds/brokeralpha-parent-round/anchors", body: { anchor: plan.deterministicTaskId.taskId } },
    ],
    expect: "mint 201 minted or 200 replayed, anchors 201 added or 200 present; a 409 conflict blocks the dispatch",
  });
  const registryActions = plan.dispatchActions.filter((action) => action.startsWith("[registry]"));
  assert.equal(registryActions.length, 4);
  assert.match(registryActions[0]!, /not performed by this helper/);
  assert.ok(
    plan.dispatchActions.indexOf(registryActions[0]!) < plan.dispatchActions.findIndex((action) => action.startsWith("[dispatch] broker /tasks")),
    "registration is listed before task creation",
  );
  assert.equal(plan.metadata.sourceOnly, true);
});

test("#2339 PR-1b the minting broker falls back to --origin-broker-id and common omits teamScope", () => {
  const { originBrokerId: _omitted, ...handoffWithoutOrigin } = COMPLETE_HANDOFF;
  const plan = buildA2ADispatchPlan({
    ...HANDOFF_SPEC,
    teamId: "common",
    parentRoundTotal: 3,
    crossBrokerHandoff: handoffWithoutOrigin,
  });

  assert.equal(plan.parentRoundRegistration?.mintingBrokerId, "brokeralpha");
  assert.equal(plan.parentRoundRegistration?.mint.body.teamScope, undefined);
});

test("#2339 PR-1b a cross-broker plan without any minting broker id is blocked", () => {
  const { originBrokerId: _a, ...specWithoutOrigin } = HANDOFF_SPEC;
  const { originBrokerId: _b, ...handoffWithoutOrigin } = COMPLETE_HANDOFF;
  const plan = buildA2ADispatchPlan({ ...specWithoutOrigin, crossBrokerHandoff: handoffWithoutOrigin });

  assert.equal(plan.decision.value, "blocked");
  assert.equal(plan.parentRoundRegistration, null);
  assert.ok(plan.decision.blockers.some((blocker) => blocker.startsWith("[parent_round_registry]")));
});

test("#2339 PR-1b local and blocked plans carry no registration", () => {
  assert.equal(buildA2ADispatchPlan({ ...BASE_SPEC }).parentRoundRegistration, null);
  const { originTaskId: _omitted, ...withoutOriginTask } = COMPLETE_HANDOFF;
  assert.equal(buildA2ADispatchPlan({ ...HANDOFF_SPEC, crossBrokerHandoff: withoutOriginTask }).parentRoundRegistration, null);
});

test("#2339 PR-1c the child payload carries the registered round's teamScope and initiatingBrokerId (spec item 2)", () => {
  const plan = buildA2ADispatchPlan({ ...HANDOFF_SPEC, parentRoundTotal: 8, crossBrokerHandoff: COMPLETE_HANDOFF });
  assert.equal(plan.taskPayload?.initiatingBrokerId, "brokeralpha");
  assert.equal(plan.taskPayload?.teamScope, "team2");

  const common = buildA2ADispatchPlan({ ...HANDOFF_SPEC, teamId: "common", parentRoundTotal: 3, crossBrokerHandoff: COMPLETE_HANDOFF });
  assert.equal(common.taskPayload?.initiatingBrokerId, "brokeralpha");
  assert.equal(common.taskPayload?.teamScope, undefined);
  assert.equal(buildA2ADispatchPlan({ ...BASE_SPEC }).taskPayload?.initiatingBrokerId, undefined, "local plans are unchanged");
});

// ---- #2556: execute mode needs proof that the [registry] pre-steps ran

/** The registry entry the minting broker returns once a plan's pre-steps ran. */
function registryEntryFor(plan: ReturnType<typeof buildA2ADispatchPlan>, overrides: Record<string, unknown> = {}) {
  const registration = plan.parentRoundRegistration;
  assert.ok(registration, "the plan carries the registration pre-steps");
  return {
    parentRoundId: registration.mint.body.parentRoundId,
    originBrokerId: registration.mintingBrokerId,
    parentBrokerId: registration.mintingBrokerId,
    initiatingBrokerId: registration.mint.body.initiatingBrokerId,
    ...(registration.mint.body.handoffBrokerId ? { handoffBrokerId: registration.mint.body.handoffBrokerId } : {}),
    parentRoundTotal: registration.mint.body.parentRoundTotal,
    kind: "local-origin",
    mintedAt: "2026-11-27T03:00:00.000Z",
    mintedBy: { requesterId: "operator-1", role: "operator" },
    anchors: registration.anchors.map((anchor) => anchor.body.anchor).sort(),
    ...overrides,
  };
}

const RECEIPT_SPEC = { ...HANDOFF_SPEC, parentRoundTotal: 8, crossBrokerHandoff: COMPLETE_HANDOFF };
const EXECUTE = { dryRun: false, execute: true };

function assertReceiptBlocked(plan: ReturnType<typeof buildA2ADispatchPlan>, pattern: RegExp): void {
  assert.equal(plan.decision.value, "blocked");
  assert.equal(plan.taskPayload, null);
  assert.ok(
    plan.decision.blockers.some((blocker) => blocker.startsWith("[parent_round_registry_receipt]") && pattern.test(blocker)),
    `expected a parent_round_registry_receipt blocker matching ${pattern}, got ${JSON.stringify(plan.decision.blockers)}`,
  );
  assert.ok(plan.dispatchActions.some((action) => action.includes("createTask: blocked")));
}

test("#2556 a dry-run handoff plan still goes without a receipt and says one is needed before --execute", () => {
  const plan = buildA2ADispatchPlan(RECEIPT_SPEC);

  assert.equal(plan.decision.value, "go");
  assert.deepEqual(plan.parentRoundRegistrationReceipt, { status: "missing", issues: [], anchorsRegistered: 0, anchorsRequired: 2 });
  assert.ok(plan.dispatchActions.includes("[registry-receipt] not supplied: required before --execute"));
  assert.ok(plan.taskPayload, "dry-run planning is unchanged");
});

test("#2556 execute mode blocks a cross-broker handoff whose parent round registration is not proven", () => {
  const plan = buildA2ADispatchPlan(RECEIPT_SPEC, EXECUTE);

  assertReceiptBlocked(plan, /requires the minting broker's registry entry for parent round brokeralpha-parent-round/);
  assert.equal(plan.parentRoundRegistrationReceipt?.status, "missing");
  // The pre-steps to run stay in the blocked plan, with the execute-mode child task id.
  assert.equal(plan.parentRoundRegistration?.anchors[1]?.body.anchor, plan.deterministicTaskId.taskId);
  assert.ok(plan.dispatchActions.some((action) => action.startsWith("[registry] pre-step (not performed by this helper)")));
});

test("#2556 execute mode goes once the minting broker's entry matches the plan", () => {
  const unproven = buildA2ADispatchPlan(RECEIPT_SPEC, EXECUTE);
  const entry = registryEntryFor(unproven);

  for (const receipt of [{ entry }, entry]) {
    const plan = buildA2ADispatchPlan(RECEIPT_SPEC, { ...EXECUTE, parentRoundRegistrationReceipt: receipt });

    assert.equal(plan.decision.value, "warn_go");
    assert.deepEqual(plan.decision.blockers, []);
    assert.deepEqual(plan.parentRoundRegistrationReceipt, {
      status: "verified",
      issues: [],
      mintedAt: "2026-11-27T03:00:00.000Z",
      anchorsRegistered: 2,
      anchorsRequired: 2,
    });
    assert.ok(plan.dispatchActions.some((action) => action.startsWith("[registry-receipt] verified: parentRoundId=brokeralpha-parent-round ")));
    assert.equal(plan.taskPayload?.crossBrokerHandoff?.parentRoundId, "brokeralpha-parent-round");
    assert.deepEqual(plan.config, EXECUTE, "the receipt is input evidence and is not echoed in the plan");
    assert.equal(plan.deterministicTaskId.taskId, unproven.deterministicTaskId.taskId, "the receipt does not change the child task id");
  }
});

test("#2556 broker ids compare case-insensitively and an entry without a handoff broker is accepted", () => {
  const unproven = buildA2ADispatchPlan(RECEIPT_SPEC, EXECUTE);
  const { handoffBrokerId: _omitted, ...withoutHandoff } = registryEntryFor(unproven, { parentBrokerId: "BrokerAlpha" });
  const plan = buildA2ADispatchPlan(RECEIPT_SPEC, { ...EXECUTE, parentRoundRegistrationReceipt: { entry: withoutHandoff } });

  assert.equal(plan.parentRoundRegistrationReceipt?.status, "verified");
  assert.equal(plan.decision.value, "warn_go");
});

test("#2556 a receipt that does not match the plan blocks it", () => {
  const unproven = buildA2ADispatchPlan(RECEIPT_SPEC, EXECUTE);
  const cases: Array<[unknown, RegExp]> = [
    ["minted", /not a parent-round registry entry/],
    [{ status: "unknown_round" }, /not a parent-round registry entry/],
    [registryEntryFor(unproven, { parentRoundId: "another-round" }), /is for parent round "another-round"/],
    [registryEntryFor(unproven, { kind: "foreign-handoff" }), /"foreign-handoff", not local-origin/],
    [registryEntryFor(unproven, { parentBrokerId: "brokerbeta" }), /registered parent broker is "brokerbeta"/],
    [registryEntryFor(unproven, { handoffBrokerId: "brokergamma" }), /registered handoff broker is "brokergamma".*routing_mismatch/],
    [registryEntryFor(unproven, { mintedAt: "" }), /no valid mintedAt/],
    [registryEntryFor(unproven, { anchors: ["brokeralpha-parent-task-1"] }), new RegExp(`anchor "${unproven.deterministicTaskId.taskId}" is not registered`)],
    [registryEntryFor(unproven, { anchors: [] }), /anchor "brokeralpha-parent-task-1" is not registered/],
  ];
  for (const [receipt, pattern] of cases) {
    const plan = buildA2ADispatchPlan(RECEIPT_SPEC, { ...EXECUTE, parentRoundRegistrationReceipt: receipt });
    assertReceiptBlocked(plan, pattern);
    assert.equal(plan.parentRoundRegistrationReceipt?.status, "invalid");
  }
  // A receipt that is supplied and wrong is an error in dry-run too.
  const dryRun = buildA2ADispatchPlan(RECEIPT_SPEC, { parentRoundRegistrationReceipt: registryEntryFor(unproven, { kind: "foreign-handoff" }) });
  assert.equal(dryRun.decision.value, "blocked");
});

test("#2556 anchors registered from the dry-run plan do not prove the execute-mode child", () => {
  const dryRun = buildA2ADispatchPlan(RECEIPT_SPEC);
  const execute = buildA2ADispatchPlan(RECEIPT_SPEC, EXECUTE);
  assert.notEqual(dryRun.deterministicTaskId.taskId, execute.deterministicTaskId.taskId, "the task id pre-image carries the mode");

  const plan = buildA2ADispatchPlan(RECEIPT_SPEC, { ...EXECUTE, parentRoundRegistrationReceipt: registryEntryFor(dryRun) });

  assertReceiptBlocked(plan, new RegExp(`anchor "${execute.deterministicTaskId.taskId}" is not registered`));
  assert.equal(plan.parentRoundRegistrationReceipt?.anchorsRegistered, 1);
});

test("#2556 a plan without a cross-broker handoff has no receipt check", () => {
  const plan = buildA2ADispatchPlan(BASE_SPEC, { ...EXECUTE, parentRoundRegistrationReceipt: { entry: {} } });

  assert.equal(plan.parentRoundRegistrationReceipt, null);
  assert.ok(!plan.decision.blockers.some((blocker) => blocker.startsWith("[parent_round_registry_receipt]")));
});

test("#2556 helper CLI: --execute needs --parent-round-registration-receipt for a cross-broker handoff", () => {
  const handoffArgs = ["--handoff-parent-round-id", "brokeralpha-parent-round", "--handoff-origin-task-id", "brokeralpha-parent-task-1", "--execute"];
  const blocked = runHelperCli(handoffArgs);
  assert.equal(blocked.status, 1);
  assertReceiptBlocked(blocked.plan, /--parent-round-registration-receipt/);

  const dir = mkdtempSync(join(tmpdir(), "a2a-dispatch-receipt-"));
  try {
    const receiptPath = join(dir, "entry.json");
    writeFileSync(receiptPath, JSON.stringify({ entry: registryEntryFor(blocked.plan) }));
    const proven = runHelperCli([...handoffArgs, "--parent-round-registration-receipt", receiptPath]);
    assert.equal(proven.status, 0);
    assert.equal(proven.plan.parentRoundRegistrationReceipt?.status, "verified");
    assert.equal(proven.plan.decision.value, "warn_go");

    const unreadable = spawnSync(
      process.execPath,
      [HELPER_CLI, ...CLI_BASE_ARGS, ...handoffArgs, "--parent-round-registration-receipt", join(dir, "missing.json"), "--json"],
      { encoding: "utf8" },
    );
    assert.equal(unreadable.status, 2);
    assert.match(unreadable.stderr, /registration receipt error/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- #2556: the execute-mode Team2 gate reads the team2 broker from the broker-team registry

const DEPLOYED_BROKER_TEAMS = [
  { brokerId: "northbroker", teamId: "team1" as const },
  { brokerId: "southbroker", teamId: "team2" as const },
];
const DEPLOYED_HANDOFF_SPEC = {
  ...BASE_SPEC,
  parentRoundId: "southbroker-child-round",
  parentRoundTotal: 1,
  parentRoundOrder: 1,
  brokerOfRecordId: "southbroker",
  originBrokerId: "northbroker",
  operatorFacingOwner: "parent" as const,
  crossBrokerHandoff: {
    parentRoundId: "northbroker-parent-round",
    originBrokerId: "northbroker",
    handoffBrokerId: "southbroker",
    originTaskId: "northbroker-parent-task-1",
  },
};

function team2GateBlockers(plan: ReturnType<typeof buildA2ADispatchPlan>): string[] {
  return plan.decision.blockers.filter((blocker) => blocker.startsWith("[team2_broker_of_record_handoff]"));
}

test("#2556 without a broker-team registry the Team2 gate still expects the placeholder broker id", () => {
  const plan = buildA2ADispatchPlan(DEPLOYED_HANDOFF_SPEC, EXECUTE);

  assert.equal(plan.decision.value, "blocked");
  assert.equal(team2GateBlockers(plan).length, 1);
  assert.match(team2GateBlockers(plan)[0]!, /must target brokerbeta \(the broker registered for team2\)/);
  assert.equal(plan.parentRoundRegistration, null, "an earlier blocker means no registration pre-steps are planned");
});

test("#2556 with the deployment's broker-team registry a Team2 handoff reaches the registration receipt gate", () => {
  const unproven = buildA2ADispatchPlan(DEPLOYED_HANDOFF_SPEC, { ...EXECUTE, brokerTeams: DEPLOYED_BROKER_TEAMS });

  assert.deepEqual(team2GateBlockers(unproven), []);
  assertReceiptBlocked(unproven, /registry entry for parent round northbroker-parent-round/);
  assert.equal(unproven.parentRoundRegistration?.mintingBrokerId, "northbroker");
  assert.equal(unproven.parentRoundRegistration?.mint.body.handoffBrokerId, "southbroker");

  const proven = buildA2ADispatchPlan(DEPLOYED_HANDOFF_SPEC, {
    ...EXECUTE,
    brokerTeams: DEPLOYED_BROKER_TEAMS,
    parentRoundRegistrationReceipt: { entry: registryEntryFor(unproven) },
  });
  assert.equal(proven.decision.value, "warn_go");
  assert.equal(proven.taskPayload?.brokerOfRecordId, "southbroker");
  assert.equal(proven.deterministicTaskId.taskId, unproven.deterministicTaskId.taskId, "the registry does not change the child task id");
});

test("#2556 the Team2 gate accepts a local round on the team2 broker and compares ids case-insensitively", () => {
  const local = buildA2ADispatchPlan(
    { ...BASE_SPEC, brokerOfRecordId: "SouthBroker", originBrokerId: "southbroker" },
    { ...EXECUTE, brokerTeams: DEPLOYED_BROKER_TEAMS },
  );

  assert.deepEqual(team2GateBlockers(local), []);
  assert.equal(local.decision.value, "warn_go");
});

test("#2556 the Team2 gate still blocks a round aimed at another broker", () => {
  const onTeam1Broker = buildA2ADispatchPlan(
    { ...BASE_SPEC, brokerOfRecordId: "northbroker", originBrokerId: "northbroker" },
    { ...EXECUTE, brokerTeams: DEPLOYED_BROKER_TEAMS },
  );
  assert.match(team2GateBlockers(onTeam1Broker)[0]!, /must target southbroker \(the broker registered for team2\)/);

  // The placeholder id is no longer special once a registry is given.
  const placeholder = buildA2ADispatchPlan(
    { ...BASE_SPEC, brokerOfRecordId: "brokerbeta", originBrokerId: "brokerbeta" },
    { ...EXECUTE, brokerTeams: DEPLOYED_BROKER_TEAMS },
  );
  assert.equal(team2GateBlockers(placeholder).length, 1);

  const noTeam2Broker = buildA2ADispatchPlan(
    { ...BASE_SPEC, brokerOfRecordId: "southbroker", originBrokerId: "southbroker" },
    { ...EXECUTE, brokerTeams: [DEPLOYED_BROKER_TEAMS[0]!] },
  );
  assert.match(team2GateBlockers(noTeam2Broker)[0]!, /no broker is registered for team2/);
});

test("#2556 the broker-team registry leaves dry-run plans and other teams alone", () => {
  const dryRun = buildA2ADispatchPlan(DEPLOYED_HANDOFF_SPEC, { brokerTeams: DEPLOYED_BROKER_TEAMS });
  const withoutRegistry = buildA2ADispatchPlan(DEPLOYED_HANDOFF_SPEC);

  assert.equal(dryRun.decision.value, "go");
  assert.deepEqual(dryRun.taskPayload, withoutRegistry.taskPayload);
  assert.equal(dryRun.deterministicTaskId.taskId, withoutRegistry.deterministicTaskId.taskId);
});

const DEPLOYED_CLI_ARGS = [
  "--team-id", "team2",
  "--worker", "workerepsilon",
  "--lane", "1",
  "--run-id", "a2a-team2-deployed-handoff-20261127T040000Z",
  "--parent-round-id", "southbroker-child-round",
  "--parent-round-total", "1",
  "--parent-issue", "https://github.com/jinwon-int/a2a-broker/issues/1032",
  "--child-issue", "https://github.com/jinwon-int/a2a-broker/issues/1137",
  "--broker-of-record-id", "southbroker",
  "--origin-broker-id", "northbroker",
  "--operator-facing-owner", "parent",
  "--cross-broker-handoff",
  "--handoff-broker-id", "southbroker",
  "--handoff-origin-broker-id", "northbroker",
  "--handoff-parent-round-id", "northbroker-parent-round",
  "--handoff-origin-task-id", "northbroker-parent-task-1",
  "--execute",
  "--json",
];

function runDeployedCli(extraArgs: string[], env: Record<string, string> = {}) {
  const { A2A_TERMINAL_BRIEF_BROKER_TEAMS: _inherited, ...cleanEnv } = process.env;
  return spawnSync(process.execPath, [HELPER_CLI, ...DEPLOYED_CLI_ARGS, ...extraArgs], { encoding: "utf8", env: { ...cleanEnv, ...env } });
}

test("#2556 helper CLI: --broker-teams (or the env var) feeds the Team2 gate", () => {
  const placeholder = runDeployedCli([]);
  assert.equal(placeholder.status, 1);
  assert.equal(team2GateBlockers(JSON.parse(placeholder.stdout)).length, 1);

  for (const result of [
    runDeployedCli(["--broker-teams", "northbroker=team1,southbroker=team2"]),
    runDeployedCli([], { A2A_TERMINAL_BRIEF_BROKER_TEAMS: "northbroker=team1,southbroker=team2" }),
  ]) {
    const plan = JSON.parse(result.stdout) as ReturnType<typeof buildA2ADispatchPlan>;
    assert.equal(result.status, 1, "still blocked, but only by the registration receipt");
    assert.deepEqual(team2GateBlockers(plan), []);
    assertReceiptBlocked(plan, /--parent-round-registration-receipt/);
  }

  // The flag wins over the env var.
  const flagWins = runDeployedCli(["--broker-teams", "northbroker=team1,southbroker=team2"], { A2A_TERMINAL_BRIEF_BROKER_TEAMS: "southbroker=team1,northbroker=team2" });
  assert.deepEqual(team2GateBlockers(JSON.parse(flagWins.stdout)), []);

  const malformed = runDeployedCli(["--broker-teams", "northbroker=team3"]);
  assert.equal(malformed.status, 2);
  assert.match(malformed.stderr, /broker teams error: .*must be <brokerId>=team1\|team2/);
});
