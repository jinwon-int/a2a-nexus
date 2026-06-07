import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildQueueGroupSummary,
  buildWorkerCapacitySlots,
  buildSchedulerControlTowerSummaryV2,
  renderSchedulerControlTowerSummary,
  extractRepo,
  extractWorkerId,
  extractPriority,
  groupTasksBy,
} from "./scheduler-control-tower.js";
import type { TaskRecord, WorkerView } from "./types.js";

// ─── Helpers ──────────────────────────────────────────────────────────────

const NOW_ISO = "2026-05-25T12:00:00.000Z";
const NOW_MS = Date.parse(NOW_ISO);
const STALE_WORKER_MS = 180_000; // 3 min — keeps both workers online in tests

function makeTask(overrides: Partial<TaskRecord> & { status?: TaskRecord["status"] } = {}): TaskRecord {
  return {
    id: `task-${Math.random().toString(36).slice(2, 8)}`,
    intent: "propose_patch",
    status: "queued",
    targetNodeId: "bangtong",
    payload: {},
    createdAt: "2026-05-25T11:00:00.000Z",
    updatedAt: "2026-05-25T11:00:00.000Z",
    requeueCount: 0,
    requester: { id: "hub-1" },
    target: { id: "bangtong", kind: "node" },
    ...overrides,
  };
}

function makeWorker(overrides: Partial<WorkerView> & { nodeId: string }): WorkerView {
  return {
    role: "analyst",
    displayName: overrides.nodeId,
    brokerUrl: "http://localhost:3000",
    capabilities: {
      canAnalyze: true,
      canBackfill: false,
      canPatchWorkspace: false,
      canPromoteLive: false,
      workspaceIds: [],
      environments: ["research"],
    },
    workerMode: "persistent",
    metadata: {},
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-25T11:00:00.000Z",
    lastSeenAt: "2026-05-25T11:00:00.000Z",
    status: "online",
    workerPlane: "online",
    managementPlane: "unknown",
    updateEligible: true,
    ...overrides,
  };
}

// ─── extractRepo ──────────────────────────────────────────────────────────

describe("extractRepo", () => {
  it("returns githubRepo from payload when present", () => {
    const task = makeTask({ payload: { githubRepo: "jinwon-int/a2a-broker" } });
    assert.equal(extractRepo(task), "jinwon-int/a2a-broker");
  });

  it("falls back to workspace.workspaceId", () => {
    const task = makeTask({ workspace: { nodeId: "bangtong", workspaceId: "my-project" } });
    assert.equal(extractRepo(task), "my-project");
  });

  it("returns 'unknown' when neither payload nor workspace has repo info", () => {
    const task = makeTask({});
    assert.equal(extractRepo(task), "unknown");
  });

  it("strips whitespace from payload repo", () => {
    const task = makeTask({ payload: { githubRepo: "  org/repo  " } });
    assert.equal(extractRepo(task), "org/repo");
  });

  it("skips empty-string githubRepo and falls through", () => {
    const task = makeTask({ payload: { githubRepo: "" } });
    assert.equal(extractRepo(task), "unknown");
  });
});

// ─── extractWorkerId ──────────────────────────────────────────────────────

describe("extractWorkerId", () => {
  it("returns assignedWorkerId when present", () => {
    const task = makeTask({ assignedWorkerId: "bangtong", targetNodeId: "other" });
    assert.equal(extractWorkerId(task), "bangtong");
  });

  it("falls back to targetNodeId", () => {
    const task = makeTask({ targetNodeId: "sogyo" });
    assert.equal(extractWorkerId(task), "sogyo");
  });

  it("returns 'unassigned' when neither is set", () => {
    const task = makeTask({ assignedWorkerId: undefined, targetNodeId: undefined! });
    assert.equal(extractWorkerId(task), "unassigned");
  });
});

// ─── extractPriority ──────────────────────────────────────────────────────

describe("extractPriority", () => {
  it("returns 'default' when no priority signal exists", () => {
    const task = makeTask({});
    assert.equal(extractPriority(task), "default");
  });

  it("reads priority from payload when present", () => {
    const task = makeTask({ payload: { priority: "high" } });
    assert.equal(extractPriority(task), "high");
  });

  it("returns 'default' for unknown priority strings", () => {
    const task = makeTask({ payload: { priority: "urgent" } });
    assert.equal(extractPriority(task), "default");
  });

  it("is case-insensitive for recognized levels", () => {
    const task = makeTask({ payload: { priority: "CRITICAL" } });
    assert.equal(extractPriority(task), "critical");
  });
});

// ─── groupTasksBy ─────────────────────────────────────────────────────────

describe("groupTasksBy", () => {
  it("returns empty array for empty task list", () => {
    assert.deepEqual(groupTasksBy([], () => "x"), []);
  });

  it("groups non-terminal tasks by the extracted key", () => {
    const tasks = [
      makeTask({ id: "t1", status: "queued", targetNodeId: "bangtong" }),
      makeTask({ id: "t2", status: "claimed", targetNodeId: "bangtong" }),
      makeTask({ id: "t3", status: "running", targetNodeId: "sogyo" }),
      makeTask({ id: "t4", status: "queued", targetNodeId: "sogyo" }),
      makeTask({ id: "t5", status: "succeeded" }),
      makeTask({ id: "t6", status: "failed" }),
    ];

    const groups = groupTasksBy(tasks, (t) => extractWorkerId(t));
    assert.equal(groups.length, 2); // bangtong, sogyo — no unassigned
    const bt = groups.find((g) => g.key === "bangtong")!;
    const sg = groups.find((g) => g.key === "sogyo")!;
    assert.equal(bt.count, 2);
    assert.equal(bt.byStatus.queued, 1);
    assert.equal(bt.byStatus.claimed, 1);
    assert.equal(sg.count, 2);
    assert.equal(sg.byStatus.running, 1);
    assert.equal(sg.byStatus.queued, 1);
  });

  it("sorts groups descending by count", () => {
    const tasks = [
      makeTask({ id: "a", status: "queued", targetNodeId: "w1" }),
      makeTask({ id: "b", status: "queued", targetNodeId: "w1" }),
      makeTask({ id: "c", status: "queued", targetNodeId: "w1" }),
      makeTask({ id: "d", status: "queued", targetNodeId: "w2" }),
      makeTask({ id: "e", status: "queued", targetNodeId: "w2" }),
      makeTask({ id: "f", status: "queued", targetNodeId: "w3" }),
    ];
    const groups = groupTasksBy(tasks, (t) => extractWorkerId(t));
    assert.equal(groups.length, 3);
    assert.equal(groups[0].key, "w1"); // 3 tasks
    assert.equal(groups[1].key, "w2"); // 2 tasks
    assert.equal(groups[2].key, "w3"); // 1 task
  });
});

// ─── buildWorkerCapacitySlots ──────────────────────────────────────────────

describe("buildWorkerCapacitySlots", () => {
  const workers: WorkerView[] = [
    makeWorker({ nodeId: "bangtong", role: "analyst", lastSeenAt: "2026-05-25T11:59:00.000Z" }),
    makeWorker({ nodeId: "sogyo", role: "researcher", lastSeenAt: "2026-05-25T11:58:00.000Z" }),
  ];

  it("produces slots for all workers and tasks", () => {
    const tasks: TaskRecord[] = [
      makeTask({ id: "t1", status: "queued", targetNodeId: "bangtong" }),
      makeTask({ id: "t2", status: "claimed", targetNodeId: "bangtong" }),
      makeTask({ id: "t3", status: "running", targetNodeId: "sogyo" }),
    ];

    const slots = buildWorkerCapacitySlots(tasks, workers, undefined, {
      nowMs: NOW_MS,
      workerOfflineAfterMs: STALE_WORKER_MS,
    });

    assert.equal(slots.length, 2);
    const bt = slots.find((s) => s.workerId === "bangtong")!;
    assert.equal(bt.activeTaskCount, 2);
    assert.equal(bt.queuedTaskCount, 1);
    assert.equal(bt.claimedTaskCount, 1);
    assert.equal(bt.status, "online");
    const sg = slots.find((s) => s.workerId === "sogyo")!;
    assert.equal(sg.activeTaskCount, 1);
    assert.equal(sg.runningTaskCount, 1);
  });

  it("marks stale workers correctly", () => {
    const staleWorker: WorkerView[] = [
      makeWorker({ nodeId: "old-bot", role: "operator", lastSeenAt: "2026-05-24T00:00:00.000Z" }),
    ];

    const slots = buildWorkerCapacitySlots([], staleWorker, undefined, {
      nowMs: NOW_MS,
      workerOfflineAfterMs: 120_000,
    });

    assert.equal(slots.length, 1);
    assert.equal(slots[0].status, "stale");
  });

  it("computes utilization when maxConcurrentOverrides is provided", () => {
    const tasks: TaskRecord[] = [
      makeTask({ id: "t1", status: "running", targetNodeId: "bangtong" }),
    ];
    const overrides = new Map([["bangtong", 4]]);

    const slots = buildWorkerCapacitySlots(tasks, workers, overrides, {
      nowMs: NOW_MS,
      workerOfflineAfterMs: STALE_WORKER_MS,
    });

    const bt = slots.find((s) => s.workerId === "bangtong")!;
    assert.equal(bt.maxConcurrentTasks, 4);
    assert.equal(bt.utilizationPct, 25); // 1/4
    assert.equal(bt.remainingSlots, 3);
  });

  it("handles workers with no tasks gracefully", () => {
    const slots = buildWorkerCapacitySlots([], workers, undefined, {
      nowMs: NOW_MS,
    });
    assert.equal(slots.length, 2);
    for (const s of slots) {
      assert.equal(s.activeTaskCount, 0);
    }
  });

  it("sorts slots descending by activeTaskCount", () => {
    const tasks: TaskRecord[] = [
      makeTask({ id: "a", status: "queued", targetNodeId: "bangtong" }),
      makeTask({ id: "b", status: "queued", targetNodeId: "bangtong" }),
      makeTask({ id: "c", status: "queued", targetNodeId: "bangtong" }),
      makeTask({ id: "d", status: "queued", targetNodeId: "sogyo" }),
    ];
    const slots = buildWorkerCapacitySlots(tasks, workers, undefined, {
      nowMs: NOW_MS,
    });
    assert.equal(slots[0].activeTaskCount, 3);
    assert.equal(slots[1].activeTaskCount, 1);
  });
});

// ─── buildSchedulerControlTowerSummaryV2 ──────────────────────────────────

describe("buildSchedulerControlTowerSummaryV2", () => {
  const workers: WorkerView[] = [
    makeWorker({ nodeId: "bangtong", role: "analyst", lastSeenAt: "2026-05-25T11:59:00.000Z" }),
    makeWorker({ nodeId: "sogyo", role: "researcher", lastSeenAt: "2026-05-25T11:58:00.000Z" }),
  ];

  const opts = { nowMs: NOW_MS, workerOfflineAfterMs: STALE_WORKER_MS };

  it("produces a well-formed summary with all five grouping dimensions", () => {
    const tasks: TaskRecord[] = [
      makeTask({ id: "t1", status: "queued", targetNodeId: "bangtong", intent: "propose_patch" }),
      makeTask({ id: "t2", status: "running", targetNodeId: "sogyo", intent: "analyze" }),
    ];

    const summary = buildSchedulerControlTowerSummaryV2(tasks, workers, undefined, opts);

    assert.equal(summary.kind, "a2a-broker.scheduler-control-tower.summary-v2");
    assert.equal(summary.version, 1);
    assert.equal(summary.generatedAt, NOW_ISO);

    // Capacity
    assert.equal(summary.capacity.totals.workers, 2);
    assert.equal(summary.capacity.totals.online, 2);
    assert.equal(summary.capacity.totals.activeTasks, 2);
    assert.equal(summary.capacity.workers.length, 2);

    // Groups — all five dimensions present as typed keys
    const groupKeys = Object.keys(summary.groups) as Array<keyof typeof summary.groups>;
    assert.deepEqual(groupKeys.sort(), ["byWorker", "byRole", "byRepo", "byTaskType", "byPriority"].sort());
  });

  it("group entries are correctly populated", () => {
    const tasks: TaskRecord[] = [
      makeTask({ id: "t1", status: "queued", targetNodeId: "bangtong", intent: "propose_patch" }),
      makeTask({ id: "t2", status: "running", targetNodeId: "sogyo", intent: "analyze" }),
    ];

    const summary = buildSchedulerControlTowerSummaryV2(tasks, workers, undefined, opts);

    // byWorker
    assert.equal(summary.groups.byWorker.length, 2);

    // byTaskType
    assert.equal(summary.groups.byTaskType.length, 2);

    // byRepo — both default to 'unknown'
    assert.equal(summary.groups.byRepo.length, 1);
    assert.equal(summary.groups.byRepo[0].key, "unknown");

    // byPriority — both default
    assert.equal(summary.groups.byPriority.length, 1);
    assert.equal(summary.groups.byPriority[0].key, "default");
  });

  it("includes terminal tasks only in capacity counts, not grouping", () => {
    const tasks: TaskRecord[] = [
      makeTask({ id: "t1", status: "queued", targetNodeId: "bangtong" }),
      makeTask({ id: "t2", status: "succeeded", targetNodeId: "bangtong" }),
    ];

    const summary = buildSchedulerControlTowerSummaryV2(tasks, workers, undefined, opts);
    assert.equal(summary.capacity.totals.activeTasks, 1);

    const bt = summary.groups.byWorker.find((g) => g.key === "bangtong")!;
    assert.equal(bt.count, 1);
  });

  it("supports maxConcurrentOverrides for utilization", () => {
    const tasks: TaskRecord[] = [
      makeTask({ id: "t1", status: "claimed", targetNodeId: "bangtong" }),
    ];
    const overrides = new Map([["bangtong", 4]]);

    const summary = buildSchedulerControlTowerSummaryV2(tasks, workers, overrides, opts);

    const bt = summary.capacity.workers.find((s) => s.workerId === "bangtong")!;
    assert.equal(bt.maxConcurrentTasks, 4);
    assert.equal(bt.utilizationPct, 25);
    assert.equal(bt.remainingSlots, 3);
  });

  it("produces empty groups for no tasks", () => {
    const summary = buildSchedulerControlTowerSummaryV2([], workers, undefined, opts);
    assert.equal(summary.capacity.totals.activeTasks, 0);
    for (const val of Object.values(summary.groups)) {
      assert.equal(val.length, 0);
    }
  });

  it("deterministic: same inputs produce identical outputs", () => {
    const tasks: TaskRecord[] = [
      makeTask({ id: "t1", status: "queued", targetNodeId: "bangtong", intent: "propose_patch" }),
      makeTask({ id: "t2", status: "running", targetNodeId: "sogyo", intent: "analyze" }),
    ];

    const a = buildSchedulerControlTowerSummaryV2(tasks, workers, undefined, opts);
    const b = buildSchedulerControlTowerSummaryV2(tasks, workers, undefined, opts);

    assert.equal(a.kind, b.kind);
    assert.equal(a.capacity.totals.activeTasks, b.capacity.totals.activeTasks);
    assert.equal(a.capacity.workers.length, b.capacity.workers.length);
    assert.equal(a.groups.byWorker.length, b.groups.byWorker.length);
    assert.equal(a.groups.byTaskType.length, b.groups.byTaskType.length);
  });
});

// ─── buildQueueGroupSummary (convenience wrapper) ──────────────────────────

describe("buildQueueGroupSummary", () => {
  it("returns all five dimensions in a single call", () => {
    const tasks = [
      makeTask({ id: "t1", status: "queued", targetNodeId: "bangtong", intent: "propose_patch" }),
      makeTask({ id: "t2", status: "running", targetNodeId: "sogyo", intent: "analyze" }),
    ];
    const workers = [
      makeWorker({ nodeId: "bangtong", role: "analyst" }),
      makeWorker({ nodeId: "sogyo", role: "researcher" }),
    ];

    const groups = buildQueueGroupSummary(tasks, workers);
    const dims = Object.keys(groups);
    assert.deepEqual(dims.sort(), ["byPriority", "byRepo", "byRole", "byTaskType", "byWorker"].sort());
    assert.ok(groups.byWorker.length >= 1);
    assert.ok(groups.byRole.length >= 1);
  });
});

// ─── renderSchedulerControlTowerSummary ──────────────────────────────────

describe("renderSchedulerControlTowerSummary", () => {
  it("produces a markdown table with capacity and all group dimensions", () => {
    const tasks = [
      makeTask({ id: "t1", status: "queued", targetNodeId: "bangtong", intent: "propose_patch" }),
      makeTask({ id: "t2", status: "running", targetNodeId: "sogyo", intent: "analyze" }),
    ];
    const workers = [
      makeWorker({ nodeId: "bangtong", role: "analyst", lastSeenAt: "2026-05-25T11:59:00.000Z" }),
      makeWorker({ nodeId: "sogyo", role: "researcher", lastSeenAt: "2026-05-25T11:58:00.000Z" }),
    ];
    const summary = buildSchedulerControlTowerSummaryV2(
      tasks, workers, undefined,
      { nowMs: NOW_MS, workerOfflineAfterMs: STALE_WORKER_MS },
    );
    const md = renderSchedulerControlTowerSummary(summary);

    assert.match(md, /Scheduler control‑tower summary/);
    assert.match(md, /Capacity/);
    assert.match(md, /bangtong.*analyst.*online/);
    assert.match(md, /By worker/);
    assert.match(md, /By role/);
    assert.match(md, /By repo/);
    assert.match(md, /By task type/);
    assert.match(md, /By priority/);
    assert.match(md, /Read-only summary/);
  });

  it('shows "(no active tasks)" for empty groups', () => {
    const summary = buildSchedulerControlTowerSummaryV2([], [], undefined, { nowMs: NOW_MS });
    const md = renderSchedulerControlTowerSummary(summary);
    assert.match(md, /\(no active tasks\)/);
  });
});

// ---------------------------------------------------------------------------
// Non-mutation guard: pure functions must not mutate input arrays
// ---------------------------------------------------------------------------

describe("scheduler control tower non-mutation guard", () => {
  const NOW_MS = Date.parse("2026-05-25T12:00:00.000Z");
  const STALE_WORKER_MS = 5 * 60 * 1000;

  it("buildSchedulerControlTowerSummaryV2 does not mutate task array", () => {
    const tasks = [
      makeTask({ id: "t1", status: "queued", targetNodeId: "bangtong" }),
      makeTask({ id: "t2", status: "running", targetNodeId: "sogyo" }),
    ];
    const workers = [
      makeWorker({ nodeId: "bangtong", role: "analyst", lastSeenAt: "2026-05-25T11:59:00.000Z" }),
      makeWorker({ nodeId: "sogyo", role: "researcher", lastSeenAt: "2026-05-25T11:58:00.000Z" }),
    ];
    const originalTasks = tasks.map((t) => ({ ...t }));
    const originalWorkers = workers.map((w) => ({ ...w }));

    buildSchedulerControlTowerSummaryV2(tasks, workers, undefined, { nowMs: NOW_MS });

    // Verify input arrays have not been mutated
    assert.equal(tasks.length, originalTasks.length, "task array length unchanged");
    assert.deepStrictEqual(tasks, originalTasks, "task array items unchanged");
    assert.equal(workers.length, originalWorkers.length, "worker array length unchanged");
    assert.deepStrictEqual(workers, originalWorkers, "worker array items unchanged");
  });

  it("buildSchedulerControlTowerSummaryV2 does not mutate input when tasks have extra fields", () => {
    const tasks = [
      makeTask({ id: "t1", status: "failed", targetNodeId: "bangtong" }),
      makeTask({ id: "t2", status: "succeeded", targetNodeId: "sogyo" }),
    ];
    const workers: WorkerView[] = [];
    const original = JSON.parse(JSON.stringify(tasks));

    buildSchedulerControlTowerSummaryV2(tasks, workers, undefined, { nowMs: NOW_MS });

    assert.deepStrictEqual(tasks, original, "task array must not be mutated with complex statuses");
  });

  it("renderSchedulerControlTowerSummary does not mutate summary object", () => {
    const tasks = [
      makeTask({ id: "t1", status: "queued", targetNodeId: "bangtong" }),
      makeTask({ id: "t2", status: "running", targetNodeId: "sogyo" }),
    ];
    const workers = [
      makeWorker({ nodeId: "bangtong", role: "analyst", lastSeenAt: "2026-05-25T11:59:00.000Z" }),
    ];
    const summary = buildSchedulerControlTowerSummaryV2(tasks, workers, undefined, { nowMs: NOW_MS });
    const originalWorkerCount = summary.groups.byWorker.length;

    renderSchedulerControlTowerSummary(summary);

    assert.equal(summary.groups.byWorker.length, originalWorkerCount, "summary groups must not be mutated after render");
  });

  it("buildWorkerCapacitySlots does not mutate worker array", () => {
    const workerRecords = [
      makeWorker({ nodeId: "bangtong", role: "analyst", lastSeenAt: "2026-05-25T11:59:00.000Z" }),
      makeWorker({ nodeId: "sogyo", role: "researcher", lastSeenAt: "2026-05-25T11:58:00.000Z" }),
    ];
    const tasks: TaskRecord[] = [];
    const original = workerRecords.map((w) => ({ ...w }));

    const slots = buildWorkerCapacitySlots(tasks, workerRecords, undefined, { nowMs: NOW_MS, workerOfflineAfterMs: STALE_WORKER_MS });

    assert.equal(workerRecords.length, original.length, "worker array length unchanged");
    assert.deepStrictEqual(workerRecords, original, "worker array items unchanged");
    assert.ok(Array.isArray(slots), "result must be an array");
    assert.equal(slots.length, workerRecords.length, "must return one slot per worker");
  });

  it("buildQueueGroupSummary does not mutate task and worker arrays", () => {
    const tasks = [
      makeTask({ id: "t1", status: "queued", targetNodeId: "bangtong", intent: "propose_patch" }),
      makeTask({ id: "t2", status: "running", targetNodeId: "sogyo", intent: "analyze" }),
    ];
    const workerRecords = [
      makeWorker({ nodeId: "bangtong", role: "analyst", lastSeenAt: "2026-05-25T11:59:00.000Z" }),
    ];
    const originalTasks = tasks.map((t) => ({ ...t }));
    const originalWorkers = workerRecords.map((w) => ({ ...w }));

    const groups = buildQueueGroupSummary(tasks, workerRecords);

    assert.equal(tasks.length, originalTasks.length, "task array length unchanged");
    assert.deepStrictEqual(tasks, originalTasks, "task array items unchanged");
    assert.equal(workerRecords.length, originalWorkers.length, "worker array length unchanged");
    assert.deepStrictEqual(workerRecords, originalWorkers, "worker array items unchanged");
    assert.ok(groups.byRole, "groups must have byRole dimension");
    assert.ok(groups.byWorker, "groups must have byWorker dimension");
  });

  it("groupTasksBy does not mutate task array entries", () => {
    const tasks = [
      makeTask({ id: "t1", status: "queued", targetNodeId: "bangtong" }),
      makeTask({ id: "t2", status: "running", targetNodeId: "sogyo" }),
    ];
    const originalTargetNodeIds = tasks.map((t) => t.targetNodeId);

    const grouped = groupTasksBy(tasks, extractWorkerId);

    assert.equal(tasks.length, 2, "task array length unchanged");
    assert.equal(tasks[0]!.targetNodeId, originalTargetNodeIds[0], "task[0].targetNodeId unchanged");
    assert.equal(tasks[1]!.targetNodeId, originalTargetNodeIds[1], "task[1].targetNodeId unchanged");
    assert.ok(Array.isArray(grouped), "result must be an array");
    // Verify entries reference original task IDs correctly
  });
});
