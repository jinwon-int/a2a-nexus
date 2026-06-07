import assert from "node:assert/strict";
import { test } from "node:test";

import {
  evaluateWorkerForTask,
  rankWorkersForTask,
  runSchedulerDryRun,
  renderSchedulerDryRunMarkdown,
  intentToPreferredRole,
  workerSupportsTaskType,
  workerHasWorkspaceAccess,
  cardHasCapacity,
  cardSupportsTaskType,
  InMemorySchedulerCardLookup,
  type SchedulerDryRunTaskProfile,
  type SchedulerDryRunResult,
} from "./scheduler-dry-run.js";
import {
  createWorkerCapabilityCard,
  type CreateWorkerCapabilityCardOptions,
  type WorkerCapabilityCard,
} from "./worker-capability-card.js";
import type { WorkerView } from "./types.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeWorkerView(overrides: Partial<WorkerView> & { nodeId: string }): WorkerView {
  return {
    role: "analyst",
    displayName: undefined,
    brokerUrl: undefined,
    capabilities: {
      canAnalyze: true,
      canBackfill: true,
      canPatchWorkspace: true,
      canPromoteLive: false,
      workspaceIds: [],
      environments: ["research", "staging"],
    },
    workerMode: "persistent",
    metadata: undefined,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    lastSeenAt: "2026-01-01T00:00:00.000Z",
    status: "online",
    workerPlane: "online",
    managementPlane: "unknown",
    updateEligible: true,
    ...overrides,
  };
}

/** Shared default capabilities to avoid inline makeWorkerView nesting. */
const BASE_CAP: import("./types.js").WorkerCapabilities = {
  canAnalyze: true,
  canBackfill: true,
  canPatchWorkspace: true,
  canPromoteLive: false,
  workspaceIds: [],
  environments: ["research", "staging"],
};

function makeCapabilityCard(
  workerId: string,
  overrides?: Partial<CreateWorkerCapabilityCardOptions>,
): WorkerCapabilityCard {
  const worker: WorkerView = makeWorkerView({ nodeId: workerId });
  return createWorkerCapabilityCard(worker, {
    teamId: "team1",
    brokerOfRecord: "seoseo",
    assignmentRoles: ["implementation"],
    supportedTaskTypes: ["analyze", "propose_patch", "backfill"],
    skills: [],
    ...overrides,
  });
}

function makeCardLookup(...cards: WorkerCapabilityCard[]): InMemorySchedulerCardLookup {
  return new InMemorySchedulerCardLookup(cards);
}

// ── intentToPreferredRole ──────────────────────────────────────────────────

test("intentToPreferredRole maps propose_patch to implementation", () => {
  assert.equal(intentToPreferredRole("propose_patch"), "implementation");
});

test("intentToPreferredRole maps validate_change to libero", () => {
  assert.equal(intentToPreferredRole("validate_change"), "libero");
});

test("intentToPreferredRole returns undefined for unknown intents", () => {
  assert.equal(intentToPreferredRole("chat"), undefined);
});

// ── workerSupportsTaskType ─────────────────────────────────────────────────

test("workerSupportsTaskType checks canPatchWorkspace for propose_patch", () => {
  const worker = makeWorkerView({ nodeId: "yukson", capabilities: { ...BASE_CAP, canPatchWorkspace: true } });
  assert.equal(workerSupportsTaskType(worker, "propose_patch"), true);
});

test("workerSupportsTaskType returns false when capability missing", () => {
  const worker = makeWorkerView({ nodeId: "yukson", capabilities: { ...BASE_CAP, canPatchWorkspace: false } });
  assert.equal(workerSupportsTaskType(worker, "propose_patch"), false);
});

test("workerSupportsTaskType checks canAnalyze for analyze", () => {
  const worker = makeWorkerView({ nodeId: "yukson", capabilities: { ...BASE_CAP, canAnalyze: false } });
  assert.equal(workerSupportsTaskType(worker, "analyze"), false);
});

test("workerSupportsTaskType returns false for unknown intent", () => {
  const worker = makeWorkerView({ nodeId: "yukson" });
  assert.equal(workerSupportsTaskType(worker, "chat"), false);
});

// ── workerHasWorkspaceAccess ───────────────────────────────────────────────

test("workerHasWorkspaceAccess passes when no workspace constraint", () => {
  const worker = makeWorkerView({ nodeId: "yukson" });
  assert.equal(workerHasWorkspaceAccess(worker, undefined), true);
});

test("workerHasWorkspaceAccess passes when worker has no workspace filter", () => {
  const worker = makeWorkerView({ nodeId: "yukson", capabilities: { ...BASE_CAP, workspaceIds: [] } });
  assert.equal(workerHasWorkspaceAccess(worker, "jinwon-int/a2a-broker"), true);
});

test("workerHasWorkspaceAccess passes when worker has the required workspace", () => {
  const worker = makeWorkerView({
    nodeId: "yukson",
    capabilities: { ...BASE_CAP, workspaceIds: ["jinwon-int/a2a-broker"] },
  });
  assert.equal(workerHasWorkspaceAccess(worker, "jinwon-int/a2a-broker"), true);
});

test("workerHasWorkspaceAccess fails when worker lacks required workspace", () => {
  const worker = makeWorkerView({
    nodeId: "yukson",
    capabilities: { ...BASE_CAP, workspaceIds: ["other/repo"] },
  });
  assert.equal(workerHasWorkspaceAccess(worker, "jinwon-int/a2a-broker"), false);
});

// ── cardSupportsTaskType ───────────────────────────────────────────────────

test("cardSupportsTaskType checks supportedTaskTypes", () => {
  const card = makeCapabilityCard("yukson", { supportedTaskTypes: ["analyze", "propose_patch"] });
  assert.equal(cardSupportsTaskType(card, "propose_patch"), true);
  assert.equal(cardSupportsTaskType(card, "backfill"), false);
});

test("cardSupportsTaskType returns false for null card", () => {
  assert.equal(cardSupportsTaskType(null, "propose_patch"), false);
});

// ── cardHasCapacity ────────────────────────────────────────────────────────

test("cardHasCapacity passes when no capacity info", () => {
  assert.deepEqual(cardHasCapacity(null), { ok: true, current: undefined, max: undefined });
});

test("cardHasCapacity passes when max is undefined", () => {
  const card = makeCapabilityCard("yukson");
  card.capacity = { currentAssignedTasks: 3 };
  assert.deepEqual(cardHasCapacity(card), { ok: true, current: 3, max: undefined });
});

test("cardHasCapacity passes when under max", () => {
  const card = makeCapabilityCard("yukson");
  card.capacity = { maxConcurrentTasks: 3, currentAssignedTasks: 1 };
  assert.deepEqual(cardHasCapacity(card), { ok: true, current: 1, max: 3 });
});

test("cardHasCapacity fails when at max", () => {
  const card = makeCapabilityCard("yukson");
  card.capacity = { maxConcurrentTasks: 3, currentAssignedTasks: 3 };
  assert.deepEqual(cardHasCapacity(card), { ok: false, current: 3, max: 3 });
});

test("cardHasCapacity fails when over max", () => {
  const card = makeCapabilityCard("yukson");
  card.capacity = { maxConcurrentTasks: 2, currentAssignedTasks: 5 };
  assert.deepEqual(cardHasCapacity(card), { ok: false, current: 5, max: 2 });
});

// ── InMemorySchedulerCardLookup ────────────────────────────────────────────

test("InMemorySchedulerCardLookup finds card by worker id", () => {
  const card = makeCapabilityCard("yukson");
  const lookup = makeCardLookup(card);
  assert.equal(lookup.getCard("yukson")?.worker.id, "yukson");
});

test("InMemorySchedulerCardLookup returns null for unknown worker", () => {
  const lookup = makeCardLookup(makeCapabilityCard("yukson"));
  assert.equal(lookup.getCard("dungae"), null);
});

// ── evaluateWorkerForTask ─────────────────────────────────────────────────

const PATCH_TASK: SchedulerDryRunTaskProfile = {
  taskType: "propose_patch",
  workspaceId: "jinwon-int/a2a-broker",
  targetEnvironment: "research",
};

test("evaluateWorkerForTask recommends a capable worker with card", () => {
  const worker = makeWorkerView({
    nodeId: "yukson",
    capabilities: {
      canAnalyze: true,
      canBackfill: true,
      canPatchWorkspace: true,
      canPromoteLive: false,
      workspaceIds: ["jinwon-int/a2a-broker"],
      environments: ["research", "staging"],
    },
  });
  const card = makeCapabilityCard("yukson", { supportedTaskTypes: ["analyze", "propose_patch", "backfill"] });
  const evaluation = evaluateWorkerForTask(worker, PATCH_TASK, card);

  assert.equal(evaluation.workerId, "yukson");
  assert.equal(evaluation.recommended, true);
  assert.equal(evaluation.constraints.filter((c) => c.verdict === "fail").length, 0);
  assert.match(evaluation.summary, /passes all constraints/);
});

test("evaluateWorkerForTask skips a worker that lacks task-type support", () => {
  const worker = makeWorkerView({
    nodeId: "dungae",
    capabilities: {
      canAnalyze: true,
      canBackfill: true,
      canPatchWorkspace: false,
      canPromoteLive: false,
      workspaceIds: ["jinwon-int/a2a-broker"],
      environments: ["research"],
    },
  });
  const card = makeCapabilityCard("dungae", { supportedTaskTypes: ["analyze", "backfill"] });
  const evaluation = evaluateWorkerForTask(worker, PATCH_TASK, card);

  assert.equal(evaluation.recommended, false);
  assert.ok(evaluation.constraints.some((c) => c.constraint === "task_type_support" && c.verdict === "fail"));
});

test("evaluateWorkerForTask skips a worker that lacks workspace access", () => {
  const worker = makeWorkerView({
    nodeId: "dungae",
    capabilities: {
      canAnalyze: true,
      canBackfill: true,
      canPatchWorkspace: true,
      canPromoteLive: false,
      workspaceIds: ["other/repo"],
      environments: ["research"],
    },
  });
  const card = makeCapabilityCard("dungae", { supportedTaskTypes: ["analyze", "propose_patch"] });
  const evaluation = evaluateWorkerForTask(worker, PATCH_TASK, card);

  assert.equal(evaluation.recommended, false);
  assert.ok(evaluation.constraints.some((c) => c.constraint === "workspace_access" && c.verdict === "fail"));
});

test("evaluateWorkerForTask skips a worker at capacity", () => {
  const worker = makeWorkerView({ nodeId: "nosuk", capabilities: { ...BASE_CAP, canPatchWorkspace: true } });
  const card = makeCapabilityCard("nosuk", { supportedTaskTypes: ["analyze", "propose_patch", "backfill"] });
  card.capacity = { maxConcurrentTasks: 2, currentAssignedTasks: 2 };
  const evaluation = evaluateWorkerForTask(worker, PATCH_TASK, card);

  assert.equal(evaluation.recommended, false);
  assert.ok(evaluation.constraints.some((c) => c.constraint === "capacity_available" && c.verdict === "fail"));
});

test("evaluateWorkerForTask prefers libero for validation tasks", () => {
  const task: SchedulerDryRunTaskProfile = {
    taskType: "validate_change",
    preferValidationWorker: true,
  };

  // Libero worker with validate_change support
  const liberoWorker = makeWorkerView({ nodeId: "yukson" });
  const liberoCard = makeCapabilityCard("yukson", {
    teamId: "team1",
    assignmentRoles: ["libero"],
    supportedTaskTypes: ["analyze", "validate_change"],
  });

  // Regular implementation worker
  const implWorker = makeWorkerView({ nodeId: "dungae" });
  const implCard = makeCapabilityCard("dungae", {
    teamId: "team1",
    assignmentRoles: ["implementation"],
    supportedTaskTypes: ["analyze", "validate_change"],
  });

  const liberoEval = evaluateWorkerForTask(liberoWorker, task, liberoCard);
  const implEval = evaluateWorkerForTask(implWorker, task, implCard);

  assert.equal(liberoEval.recommended, true);
  assert.ok(liberoEval.constraints.some((c) => c.constraint === "validation_worker_preference" && c.verdict === "pass"));

  // Implementation worker should still pass but get a fail on validation preference
  // Actually it only fails validation preference if preferValidationWorker is set and not libero
  assert.equal(implEval.recommended, false); // fails validation_worker_preference
  assert.ok(implEval.constraints.some((c) => c.constraint === "validation_worker_preference" && c.verdict === "fail"));
});

test("evaluateWorkerForTask uses worker capabilities when no card available", () => {
  const worker = makeWorkerView({
    nodeId: "bangtong",
    capabilities: {
      canAnalyze: true,
      canBackfill: true,
      canPatchWorkspace: true,
      canPromoteLive: false,
      workspaceIds: ["jinwon-int/a2a-broker"],
      environments: ["research", "staging"],
    },
  });
  const evaluation = evaluateWorkerForTask(worker, PATCH_TASK, null);

  assert.equal(evaluation.recommended, true);
  assert.equal(evaluation.constraints.filter((c) => c.verdict === "fail").length, 0);
});

// ── rankWorkersForTask ────────────────────────────────────────────────────

test("rankWorkersForTask puts recommended before not-recommended", () => {
  const tasks: SchedulerDryRunTaskProfile = { taskType: "propose_patch" };
  const good = evaluateWorkerForTask(
    makeWorkerView({ nodeId: "yukson", capabilities: { ...BASE_CAP, canPatchWorkspace: true } }),
    tasks,
    makeCapabilityCard("yukson"),
  );
  const bad = evaluateWorkerForTask(
    makeWorkerView({ nodeId: "dungae", capabilities: { ...BASE_CAP, canPatchWorkspace: false } }),
    tasks,
    makeCapabilityCard("dungae", { supportedTaskTypes: ["analyze"] }),
  );

  const ranked = rankWorkersForTask([bad, good], tasks);
  assert.equal(ranked[0].workerId, "yukson");
  assert.equal(ranked[1].workerId, "dungae");
});

test("rankWorkersForTask puts assigned worker first", () => {
  const tasks: SchedulerDryRunTaskProfile = {
    taskType: "propose_patch",
    assignedWorkerId: "dungae",
  };
  const eval1 = evaluateWorkerForTask(
    makeWorkerView({ nodeId: "yukson", capabilities: { ...BASE_CAP, canPatchWorkspace: true } }),
    tasks,
    makeCapabilityCard("yukson"),
  );
  const eval2 = evaluateWorkerForTask(
    makeWorkerView({ nodeId: "dungae", capabilities: { ...BASE_CAP, canPatchWorkspace: true } }),
    tasks,
    makeCapabilityCard("dungae"),
  );

  const ranked = rankWorkersForTask([eval1, eval2], tasks);
  assert.equal(ranked[0].workerId, "dungae"); // assigned worker first
});

// ── runSchedulerDryRun ────────────────────────────────────────────────────

test("runSchedulerDryRun selects the best worker from candidates", () => {
  const task: SchedulerDryRunTaskProfile = {
    taskType: "propose_patch",
    workspaceId: "jinwon-int/a2a-broker",
  };

  const workers = [
    makeWorkerView({
      nodeId: "yukson",
      capabilities: { ...BASE_CAP, canPatchWorkspace: true, workspaceIds: ["jinwon-int/a2a-broker"] },
    }),
    makeWorkerView({
      nodeId: "dungae",
      capabilities: { ...BASE_CAP, canPatchWorkspace: true, workspaceIds: ["other/repo"] },
    }),
  ];

  const cards = makeCardLookup(
    makeCapabilityCard("yukson", { supportedTaskTypes: ["analyze", "propose_patch"] }),
    makeCapabilityCard("dungae", { supportedTaskTypes: ["analyze", "propose_patch"] }),
  );

  const result = runSchedulerDryRun(task, workers, cards);

  assert.equal(result.kind, "a2a-broker.scheduler-dry-run.v1");
  assert.equal(result.workerCount, 2);
  assert.equal(result.recommendation.selectedWorkerId, "yukson");
  assert.equal(result.recommendation.provisional, false);
  assert.equal(result.safety.noMutation, true);
  assert.equal(result.safety.noDispatch, true);
  assert.equal(result.safety.noClaim, true);
  assert.equal(result.safety.noDbMutation, true);
});

test("runSchedulerDryRun returns null when no workers available", () => {
  const task: SchedulerDryRunTaskProfile = { taskType: "propose_patch" };
  const result = runSchedulerDryRun(task, [], undefined);
  assert.equal(result.workerCount, 0);
  assert.equal(result.recommendation.selectedWorkerId, null);
  assert.match(result.recommendation.explanation, /No workers available/);
});

test("runSchedulerDryRun selects libero when preferValidationWorker is set", () => {
  const task: SchedulerDryRunTaskProfile = {
    taskType: "validate_change",
    preferValidationWorker: true,
  };

  const liberoWorker = makeWorkerView({ nodeId: "yukson" });
  const implWorker = makeWorkerView({ nodeId: "dungae" });

  const liberoCard = makeCapabilityCard("yukson", {
    teamId: "team1",
    assignmentRoles: ["libero"],
    supportedTaskTypes: ["analyze", "validate_change"],
  });
  const implCard = makeCapabilityCard("dungae", {
    teamId: "team1",
    assignmentRoles: ["implementation"],
    supportedTaskTypes: ["analyze", "validate_change"],
  });

  const cards = makeCardLookup(liberoCard, implCard);
  const result = runSchedulerDryRun(task, [implWorker, liberoWorker], cards);

  assert.equal(result.recommendation.selectedWorkerId, "yukson"); // libero preferred
});

test("runSchedulerDryRun handles capability-without-card workers", () => {
  const task: SchedulerDryRunTaskProfile = {
    taskType: "propose_patch",
  };

  const workers = [
    makeWorkerView({
      nodeId: "bangtong",
      capabilities: { ...BASE_CAP, canPatchWorkspace: true },
    }),
  ];

  // No cards — use worker capabilities directly
  const result = runSchedulerDryRun(task, workers, undefined);

  assert.equal(result.recommendation.selectedWorkerId, "bangtong");
  assert.equal(result.recommendation.provisional, false);
});

test("runSchedulerDryRun respects assigned worker when available", () => {
  const task: SchedulerDryRunTaskProfile = {
    taskType: "propose_patch",
    assignedWorkerId: "dungae",
  };

  const workers = [
    makeWorkerView({ nodeId: "yukson", capabilities: { ...BASE_CAP, canPatchWorkspace: true } }),
    makeWorkerView({ nodeId: "dungae", capabilities: { ...BASE_CAP, canPatchWorkspace: true } }),
  ];

  const cards = makeCardLookup(
    makeCapabilityCard("yukson"),
    makeCapabilityCard("dungae"),
  );

  const result = runSchedulerDryRun(task, workers, cards);
  assert.equal(result.recommendation.selectedWorkerId, "dungae");
});

// ── Environment constraints ────────────────────────────────────────────────

test("evaluateWorkerForTask respects target environment constraint", () => {
  const task: SchedulerDryRunTaskProfile = {
    taskType: "propose_patch",
    targetEnvironment: "live",
  };

  const worker = makeWorkerView({
    nodeId: "yukson",
    capabilities: { ...BASE_CAP, canPatchWorkspace: true, environments: ["research"] },
  });
  const card = makeCapabilityCard("yukson", { supportedTaskTypes: ["analyze", "propose_patch"] });
  card.assignment.environments = ["research"];

  const evaluation = evaluateWorkerForTask(worker, task, card);
  assert.equal(evaluation.recommended, false);
  assert.ok(evaluation.constraints.some((c) => c.constraint === "environment_match" && c.verdict === "fail"));
});

test("evaluateWorkerForTask passes environment constraint when environments match", () => {
  const task: SchedulerDryRunTaskProfile = {
    taskType: "propose_patch",
    targetEnvironment: "staging",
  };

  const worker = makeWorkerView({
    nodeId: "yukson",
    capabilities: { ...BASE_CAP, canPatchWorkspace: true, environments: ["research", "staging"] },
  });
  const card = makeCapabilityCard("yukson", { supportedTaskTypes: ["analyze", "propose_patch"] });
  card.assignment.environments = ["research", "staging"];

  const evaluation = evaluateWorkerForTask(worker, task, card);
  assert.equal(evaluation.recommended, true);
  assert.ok(evaluation.constraints.some((c) => c.constraint === "environment_match" && c.verdict === "pass"));
});

// ── No-mutation dry-run output ─────────────────────────────────────────────

test("runSchedulerDryRun produces no-mutation output with constraints", () => {
  const task: SchedulerDryRunTaskProfile = {
    taskType: "propose_patch",
    workspaceId: "jinwon-int/a2a-broker",
  };

  const yuksonBase = makeWorkerView({ nodeId: "yukson" });
  const dungaeBase = makeWorkerView({ nodeId: "dungae" });
  const workers = [
    makeWorkerView({ nodeId: "yukson", capabilities: { ...yuksonBase.capabilities, canPatchWorkspace: true, workspaceIds: ["jinwon-int/a2a-broker"] } }),
    makeWorkerView({ nodeId: "dungae", capabilities: { ...dungaeBase.capabilities, canPatchWorkspace: false, workspaceIds: ["jinwon-int/a2a-broker"] } }),
  ];

  const cards = makeCardLookup(
    makeCapabilityCard("yukson", { supportedTaskTypes: ["analyze", "propose_patch"] }),
    makeCapabilityCard("dungae", { supportedTaskTypes: ["analyze", "backfill"] }),
  );

  const result = runSchedulerDryRun(task, workers, cards);

  // Verify safety boundaries
  assert.equal(result.safety.noMutation, true);
  assert.equal(result.safety.noDispatch, true);

  // Verify evaluations per worker
  assert.equal(result.workerEvaluations.length, 2);

  // Yukson: should be recommended
  const yuksonResult = result.workerEvaluations.find((w) => w.workerId === "yukson");
  assert.ok(yuksonResult);
  assert.equal(yuksonResult.recommended, true);
  assert.ok(yuksonResult.constraints.length >= 4); // role, task_type, workspace, capacity
  assert.ok(yuksonResult.constraints.some((c) => c.constraint === "task_type_support" && c.verdict === "pass"));

  // Dungae: should NOT be recommended (no patch support)
  const dungaeResult = result.workerEvaluations.find((w) => w.workerId === "dungae");
  assert.ok(dungaeResult);
  assert.equal(dungaeResult.recommended, false);
  assert.ok(dungaeResult.constraints.some((c) => c.constraint === "task_type_support" && c.verdict === "fail"));

  // Verify selected worker
  assert.equal(result.recommendation.selectedWorkerId, "yukson");
});

// ── Markdown renderer ──────────────────────────────────────────────────────

test("renderSchedulerDryRunMarkdown produces readable output", () => {
  const task: SchedulerDryRunTaskProfile = {
    taskType: "propose_patch",
    workspaceId: "jinwon-int/a2a-broker",
  };

  const workers = [
    makeWorkerView({ nodeId: "yukson", capabilities: { ...BASE_CAP, canPatchWorkspace: true } }),
  ];

  const result = runSchedulerDryRun(task, workers);
  const markdown = renderSchedulerDryRunMarkdown(result);

  assert.match(markdown, /Scheduler Dry-Run Report/);
  assert.match(markdown, /Kind/);
  assert.match(markdown, /Task type/);
  assert.match(markdown, /Recommendation/);
  assert.match(markdown, /Worker Evaluations/);
  assert.match(markdown, /yukson/);
  assert.match(markdown, /No mutation/);
  assert.match(markdown, /No dispatch/);
});

test("renderSchedulerDryRunMarkdown shows empty state when no workers", () => {
  const task: SchedulerDryRunTaskProfile = { taskType: "propose_patch" };
  const result = runSchedulerDryRun(task, []);
  const markdown = renderSchedulerDryRunMarkdown(result);

  assert.match(markdown, /No workers available/);
});

// ── Edge cases ─────────────────────────────────────────────────────────────

test("edge: unknown task type falls through gracefully", () => {
  const task: SchedulerDryRunTaskProfile = { taskType: "chat" };
  const worker = makeWorkerView({ nodeId: "yukson" });
  const evaluation = evaluateWorkerForTask(worker, task, null);

  // Role is skipped (no preferred mapping), task_type uses worker capabilities (false for chat)
  assert.equal(evaluation.recommended, false);
  assert.ok(evaluation.constraints.some((c) => c.constraint === "task_type_support" && c.verdict === "fail"));
});

test("edge: identical dry-run inputs produce identical results", () => {
  const task: SchedulerDryRunTaskProfile = {
    taskType: "propose_patch",
    workspaceId: "jinwon-int/a2a-broker",
  };

  const worker = makeWorkerView({
    nodeId: "yukson",
    capabilities: { ...BASE_CAP, canPatchWorkspace: true, workspaceIds: ["jinwon-int/a2a-broker"] },
  });

  // Run twice; kinds/version/safety are deterministically the same
  const result1 = runSchedulerDryRun(task, [worker], undefined);
  const result2 = runSchedulerDryRun(task, [worker], undefined);

  assert.equal(result1.kind, result2.kind);
  assert.equal(result1.version, result2.version);
  assert.equal(result1.workerCount, result2.workerCount);
  assert.equal(result1.recommendation.selectedWorkerId, result2.recommendation.selectedWorkerId);

  // Worker evaluations should be structurally identical
  assert.equal(result1.workerEvaluations.length, result2.workerEvaluations.length);
  for (let i = 0; i < result1.workerEvaluations.length; i++) {
    assert.equal(result1.workerEvaluations[i].recommended, result2.workerEvaluations[i].recommended);
    assert.equal(result1.workerEvaluations[i].constraints.length, result2.workerEvaluations[i].constraints.length);
  }

  // Safety markers are always the same
  assert.deepEqual(result1.safety, result2.safety);
});

test("edge: empty worker list returns null selection", () => {
  const result = runSchedulerDryRun({ taskType: "analyze" }, []);
  assert.equal(result.recommendation.selectedWorkerId, null);
  assert.equal(result.workerCount, 0);
  assert.equal(result.workerEvaluations.length, 0);
});
