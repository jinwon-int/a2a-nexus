import assert from "node:assert/strict";
import test from "node:test";

import {
  buildBrokerCleanupPlan,
} from "./broker-cleanup.js";
import type { AuditEvent } from "./types.js";
import { SqliteBrokerStateStore, emptySnapshot } from "./store.js";
import {
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrokerSnapshot } from "./store.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function withTempFile(name: string): {
  dir: string;
  filePath: string;
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), "a2a-broker-cleanup-"));
  return {
    dir,
    filePath: join(dir, name),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function makeTask(
  id: string,
  status: string,
  assignedWorkerId: string,
): BrokerSnapshot["tasks"][number] {
  return {
    id,
    intent: "analyze",
    requester: { id: "requester", kind: "session", role: "hub" },
    target: { id: assignedWorkerId, kind: "node", role: "analyst" },
    message: id,
    targetNodeId: assignedWorkerId,
    assignedWorkerId,
    payload: { correlationId: `corr-${id}` },
    status,
    createdAt: "2026-05-18T00:00:00.000Z",
    updatedAt: "2026-05-18T00:00:00.000Z",
    taskOrigin: "api",
  } as BrokerSnapshot["tasks"][number];
}

function makeWorker(nodeId: string, lastSeenAt: string): BrokerSnapshot["workers"][number] {
  return {
    nodeId,
    role: "analyst",
    capabilities: {
      canAnalyze: true,
      canBackfill: false,
      canPatchWorkspace: false,
      canPromoteLive: false,
      workspaceIds: ["default"],
      environments: ["research"],
    },
    createdAt: lastSeenAt,
    updatedAt: lastSeenAt,
    lastSeenAt,
  };
}

// ---------------------------------------------------------------------------
// Actionability: terminal tasks retained by cap
// ---------------------------------------------------------------------------

test("BrokerCleanupPlan actionability: terminal tasks under cap are retention_not_due", () => {
  const temp = withTempFile("state.sqlite");
  try {
    // Tasks at "2026-05-18T00:00:00Z", now is "2026-05-19T00:00:00Z" — 24h later
    // Retention is 1h, cap is 5000. All terminal tasks are past retention but under cap.
    const taskData = [
      { ...makeTask("task-failed-retained", "failed", "worker-a"), completedAt: "2026-05-18T00:00:00.000Z" },
      { ...makeTask("task-succeeded-retained", "succeeded", "worker-b"), completedAt: "2026-05-18T00:01:00.000Z" },
      { ...makeTask("task-canceled-retained", "canceled", "worker-c"), completedAt: "2026-05-18T00:02:00.000Z" },
      // running task — no completedAt
      { ...makeTask("task-running-active", "running", "worker-d") },
    ];
    delete (taskData[3] as { completedAt?: string }).completedAt;

    const store = new SqliteBrokerStateStore(temp.filePath);
    store.save({
      ...emptySnapshot(),
      tasks: taskData as unknown[] as BrokerSnapshot["tasks"],
      workers: [
        makeWorker("worker-a", "2026-05-18T00:00:00.000Z"),
        makeWorker("worker-b", "2026-05-18T00:01:00.000Z"),
        makeWorker("worker-c", "2026-05-18T00:02:00.000Z"),
        makeWorker("worker-d", "2026-05-19T00:00:00.000Z"),
      ],
    });

    const nowMs = Date.parse("2026-05-19T00:00:00.000Z");
    const plan = buildBrokerCleanupPlan(store, {
      nowMs,
      taskRetentionMs: 3_600_000, // 1h
      maxTerminalTasks: 5000, // generous cap — all terminal tasks retained
      workerRetentionMs: 1_000_000_000, // no worker pruning in this test
      maxInactiveWorkers: 5000,
    });

    const taskTable = plan.tables.find((t) => t.table === "broker_tasks");
    assert.ok(taskTable, "task table plan must exist");

    // 3 terminal tasks past the 1h retention window, but retained because
    // maxTerminalTasks (5000) exceeds their count.
    assert.equal(taskTable.retainedByCapCount, 3);
    assert.equal(taskTable.pruneCount, 0);
    // When retainedByCapCount > 0 and no prune candidates exist, actionability
    // must be retention_not_due — these are NOT executable cleanup items.
    assert.equal(
      taskTable.actionability,
      "retention_not_due",
      `expected "retention_not_due" but got "${taskTable.actionability}"`,
    );

    // Verify the plan notes reference retention_not_due
    assert.ok(
      plan.notes.some((note) => note.includes("retention_not_due")),
      "plan notes should mention retention_not_due actionability",
    );

    store.close();
  } finally {
    temp.cleanup();
  }
});

test("BrokerCleanupPlan actionability: terminal tasks exceeding cap become advisory", () => {
  const temp = withTempFile("state.sqlite");
  try {
    // Tasks past retention AND past the max terminal cap become prune candidates.
    const tasks = [
      { ...makeTask("task-old-1", "succeeded", "worker-a"), completedAt: "2026-05-18T00:00:00.000Z" },
      { ...makeTask("task-old-2", "failed", "worker-b"), completedAt: "2026-05-18T00:00:00.000Z" },
      { ...makeTask("task-old-3", "canceled", "worker-c"), completedAt: "2026-05-18T00:00:00.000Z" },
      { ...makeTask("task-old-4", "succeeded", "worker-d"), completedAt: "2026-05-18T00:00:00.000Z" },
    ];
    // One recent terminal task that will be retained by cap
    const recentTerminal = {
      ...makeTask("task-recent", "succeeded", "worker-e"),
      completedAt: "2026-05-18T23:30:00.000Z",
    };

    const allTasks = [...tasks, recentTerminal];

    const store = new SqliteBrokerStateStore(temp.filePath);
    store.save({
      ...emptySnapshot(),
      tasks: allTasks as unknown[] as BrokerSnapshot["tasks"],
      workers: [
        makeWorker("worker-a", "2026-05-18T00:00:00.000Z"),
        makeWorker("worker-b", "2026-05-18T00:01:00.000Z"),
        makeWorker("worker-c", "2026-05-18T00:02:00.000Z"),
        makeWorker("worker-d", "2026-05-18T00:03:00.000Z"),
        makeWorker("worker-e", "2026-05-19T00:00:00.000Z"),
      ],
    });

    const nowMs = Date.parse("2026-05-19T00:00:00.000Z");
    const plan = buildBrokerCleanupPlan(store, {
      nowMs,
      taskRetentionMs: 3_600_000, // 1h
      maxTerminalTasks: 2, // only the 2 most recent old tasks are retained by cap
      workerRetentionMs: 1_000_000_000, // no worker pruning
      maxInactiveWorkers: 5000,
    });

    const taskTable = plan.tables.find((t) => t.table === "broker_tasks");
    assert.ok(taskTable, "task table plan must exist");

    // 4 old terminal tasks past retention; 1 recent terminal under retention.
    // Cap of 2 means 2 oldest are pruned, 2 are retained by cap.
    assert.equal(taskTable.retainedByCapCount, 2);
    assert.ok(taskTable.pruneCount >= 1, "pruneCount should be > 0 when cap limits retention");

    // When pruneCount > 0, actionability is advisory (not executable without approval)
    assert.equal(taskTable.actionability, "advisory");

    store.close();
  } finally {
    temp.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Actionability: stale workers with no active tasks
// ---------------------------------------------------------------------------

test("BrokerCleanupPlan actionability: stale workers with no active tasks are advisory", () => {
  const temp = withTempFile("state.sqlite");
  try {
    const nowMs = Date.parse("2026-05-19T00:00:00.000Z");

    // Worker with no active tasks, past retention and past cap
    const staleNoTasks = makeWorker("stale-no-tasks", "2026-04-01T00:00:00.000Z");

    // Worker that is still active (recent lastSeenAt) — should be retained
    const activeWorker = makeWorker("active-worker", "2026-05-19T00:00:00.000Z");

    const store = new SqliteBrokerStateStore(temp.filePath);
    store.save({
      ...emptySnapshot(),
      workers: [staleNoTasks, activeWorker],
    });

    const plan = buildBrokerCleanupPlan(store, {
      nowMs,
      workerRetentionMs: 3_600_000, // 1h
      maxInactiveWorkers: 0, // zero cap — no stale workers retained by cap
    });

    const workerTable = plan.tables.find((t) => t.table === "broker_workers");
    assert.ok(workerTable, "worker table plan must exist");

    // The stale worker should be a prune candidate
    assert.ok(workerTable.pruneCount >= 1, "stale worker should be a prune candidate");

    // Workers with no active tasks must be classified as advisory by default
    assert.equal(
      workerTable.actionability,
      "advisory",
      `expected "advisory" for stale workers with no active tasks, got "${workerTable.actionability}"`,
    );
    assert.ok(
      workerTable.executionBlockedByDefault,
      "worker pruning must be blocked by default",
    );

    // Verify plan notes mention advisory actionability
    assert.ok(
      plan.notes.some((note) => note.includes("advisory")),
      "plan notes should mention advisory actionability",
    );

    store.close();
  } finally {
    temp.cleanup();
  }
});

test("BrokerCleanupPlan actionability: stale workers under cap have retainedByCapCount and retention_not_due", () => {
  const temp = withTempFile("state.sqlite");
  try {
    const nowMs = Date.parse("2026-05-19T00:00:00.000Z");

    // Worker past retention window but under maxInactiveWorkers cap
    const staleRetained = makeWorker("stale-retained", "2026-04-01T00:00:00.000Z");

    const store = new SqliteBrokerStateStore(temp.filePath);
    store.save({
      ...emptySnapshot(),
      workers: [staleRetained],
    });

    const plan = buildBrokerCleanupPlan(store, {
      nowMs,
      workerRetentionMs: 3_600_000, // 1h
      maxInactiveWorkers: 100, // generous cap — retains the stale worker
    });

    const workerTable = plan.tables.find((t) => t.table === "broker_workers");
    assert.ok(workerTable, "worker table plan must exist");

    // The stale worker is past retention but retained by the cap
    assert.equal(workerTable.retainedByCapCount, 1);
    assert.equal(workerTable.pruneCount, 0);
    // When retainedByCapCount > 0 and no prune candidates, actionability is retention_not_due
    assert.equal(workerTable.actionability, "retention_not_due");

    store.close();
  } finally {
    temp.cleanup();
  }
});

test("BrokerCleanupPlan actionability: worker with active tasks is protected", () => {
  const temp = withTempFile("state.sqlite");
  try {
    const nowMs = Date.parse("2026-05-19T00:00:00.000Z");

    // Worker that hasn't been seen recently
    const workerWithTasks = makeWorker("busy-worker", "2026-05-01T00:00:00.000Z");

    // Active task assigned to this worker
    const activeTask = {
      ...makeTask("task-active-for-worker", "running", "busy-worker"),
      createdAt: "2026-05-19T00:00:00.000Z",
      updatedAt: "2026-05-19T00:00:00.000Z",
    };
    delete (activeTask as { completedAt?: string }).completedAt;

    const store = new SqliteBrokerStateStore(temp.filePath);
    store.save({
      ...emptySnapshot(),
      tasks: [activeTask] as unknown[] as BrokerSnapshot["tasks"],
      workers: [workerWithTasks],
    });

    const plan = buildBrokerCleanupPlan(store, {
      nowMs,
      workerRetentionMs: 3_600_000, // 1h
      maxInactiveWorkers: 100,
    });

    const workerTable = plan.tables.find((t) => t.table === "broker_workers");
    assert.ok(workerTable, "worker table plan must exist");

    // Worker is protected because it has active tasks, so pruneCount should be 0
    assert.equal(workerTable.pruneCount, 0, "worker with active tasks must be protected from pruning");

    store.close();
  } finally {
    temp.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Verify plan summary includes actionability context
// ---------------------------------------------------------------------------

test("BrokerCleanupPlan executionRequires includes actionability guardrails", () => {
  const temp = withTempFile("state.sqlite");
  try {
    const nowMs = Date.parse("2026-05-19T00:00:00.000Z");

    const staleWorker = makeWorker("stale-w", "2026-04-01T00:00:00.000Z");
    const store = new SqliteBrokerStateStore(temp.filePath);
    store.save({
      ...emptySnapshot(),
      workers: [staleWorker],
    });

    const plan = buildBrokerCleanupPlan(store, {
      nowMs,
      workerRetentionMs: 3_600_000,
      maxInactiveWorkers: 0,
    });

    // The executionRequires should include the standard guards
    assert.ok(
      plan.summary.executionRequires.some((req) => req.includes("allowWorkerPrune")),
      "worker prune requires allowWorkerPrune=true",
    );
    assert.ok(
      plan.summary.executionRequires.some((req) => req.includes("approvalToken")),
      "execution requires approvalToken",
    );

    store.close();
  } finally {
    temp.cleanup();
  }
});

test("BrokerCleanupPlan with no prune candidates returns highestRisk low and retention_not_due", () => {
  const temp = withTempFile("state.sqlite");
  try {
    const nowMs = Date.parse("2026-05-19T00:00:00.000Z");

    // Recent tasks and workers within all retention windows
    const recentTask = {
      ...makeTask("task-recent", "succeeded", "worker-a"),
      completedAt: "2026-05-19T00:00:00.000Z",
    };
    const recentWorker = makeWorker("worker-a", "2026-05-19T00:00:00.000Z");

    const store = new SqliteBrokerStateStore(temp.filePath);
    store.save({
      ...emptySnapshot(),
      tasks: [recentTask] as unknown[] as BrokerSnapshot["tasks"],
      workers: [recentWorker],
    });

    const plan = buildBrokerCleanupPlan(store, {
      nowMs,
      taskRetentionMs: 3_600_000_000, // very generous retention — nothing is old
      maxTerminalTasks: 5000,
      workerRetentionMs: 3_600_000_000,
      maxInactiveWorkers: 5000,
    });

    assert.equal(plan.summary.highestRisk, "low");
    assert.equal(plan.summary.totalPruneCandidates, 0);
    assert.equal(plan.summary.candidateTables, 0);

    store.close();
  } finally {
    temp.cleanup();
  }
});

test("BrokerCleanupPlan: audit events at maxAuditEvents cap with no prune candidates are retention_not_due", () => {
  const temp = withTempFile("state.sqlite");
  try {
    const nowMs = Date.parse("2026-05-29T12:00:00.000Z");
    const auditRetentionMs = 7 * 24 * 60 * 60 * 1000; // 7 days

    // Create audit events at the maxAuditEvents cap (5000). All are within the
    // retention window (recent), so no retention candidates should be prunable.
    // This tests the "at runtime cap, no prune candidates" scenario.
    const auditEvents: AuditEvent[] = [];
    for (let i = 0; i < 5000; i++) {
      auditEvents.push({
        id: `audit-${i}`,
        actorId: "worker-heartbeat",
        action: "worker.heartbeat" as const,
        targetType: "worker",
        targetId: `worker-${i % 10}`,
        createdAt: new Date(nowMs - 60_000).toISOString(), // 1 minute ago — within retention
      } as AuditEvent);
    }

    const store = new SqliteBrokerStateStore(temp.filePath);
    store.save({
      ...emptySnapshot(),
      auditEvents,
    });

    const plan = buildBrokerCleanupPlan(store, {
      nowMs,
      auditRetentionMs,
      maxAuditEvents: 5000,
      taskRetentionMs: 3_600_000_000, // keep everything
      maxTerminalTasks: 5000,
      workerRetentionMs: 3_600_000_000,
      maxInactiveWorkers: 5000,
    });

    const auditTable = plan.tables.find((t) => t.table === "broker_audit_events");
    assert.ok(auditTable, "audit table plan must exist");

    // All audit events are within the retention window → pruneCount = 0
    assert.equal(
      auditTable!.pruneCount,
      0,
      `expected pruneCount 0 for recent audit events, got ${auditTable!.pruneCount}`,
    );
    // retainedByCapCount should reflect how many retention-capable rows were
    // retained by maxRecords (maxAuditEvents). Since all 5000 rows are within
    // the retention window and the cap allows all 5000, retainedByCapCount
    // is 5000 — the cap is actively retaining every row.
    assert.equal(
      auditTable!.retainedByCapCount,
      5000,
      `expected retainedByCapCount 5000 (all rows within retention retained by cap), got ${auditTable!.retainedByCapCount}`,
    );
    // With pruneCount === 0, actionability must be retention_not_due
    assert.equal(
      auditTable!.actionability,
      "retention_not_due",
      `expected retention_not_due, got "${auditTable!.actionability}"`,
    );
    // The plan summary should reflect zero prune candidates
    assert.equal(plan.summary.totalPruneCandidates, 0);
    assert.equal(plan.summary.candidateTables, 0);
    assert.equal(plan.summary.highestRisk, "low");

    store.close();
  } finally {
    temp.cleanup();
  }
});

test("BrokerCleanupPlan: old audit events at cap with retention past due produce advisory prune candidates", () => {
  const temp = withTempFile("state.sqlite");
  try {
    const nowMs = Date.parse("2026-05-29T12:00:00.000Z");
    const auditRetentionMs = 7 * 24 * 60 * 60 * 1000; // 7 days

    // Create 6000 audit events — 5000 within retention, 1000 past retention.
    // The past-retention 1000 should be prune candidates (advisory actionability).
    const auditEvents: AuditEvent[] = [];
    for (let i = 0; i < 5000; i++) {
      auditEvents.push({
        id: `audit-recent-${i}`,
        actorId: "worker-heartbeat",
        action: "worker.heartbeat" as const,
        targetType: "worker",
        targetId: `worker-${i % 10}`,
        createdAt: new Date(nowMs - 60_000).toISOString(), // 1 minute ago — within retention
      } as AuditEvent);
    }
    for (let i = 0; i < 1000; i++) {
      auditEvents.push({
        id: `audit-old-${i}`,
        actorId: "worker-heartbeat",
        action: "worker.heartbeat" as const,
        targetType: "worker",
        targetId: `worker-${i % 10}`,
        createdAt: new Date(nowMs - auditRetentionMs - 60_000).toISOString(), // just past retention
      } as AuditEvent);
    }

    const store = new SqliteBrokerStateStore(temp.filePath);
    store.save({
      ...emptySnapshot(),
      auditEvents,
    });

    const plan = buildBrokerCleanupPlan(store, {
      nowMs,
      auditRetentionMs,
      maxAuditEvents: 5000,
      taskRetentionMs: 3_600_000_000,
      maxTerminalTasks: 5000,
      workerRetentionMs: 3_600_000_000,
      maxInactiveWorkers: 5000,
    });

    const auditTable = plan.tables.find((t) => t.table === "broker_audit_events");
    assert.ok(auditTable, "audit table plan must exist");

    // Past-retention events are not within the recent set; maxAuditEvents=5000
    // retains the 5000 recent ones by their timestamps. The older 1000 are
    // prune candidates.
    assert.ok(
      auditTable!.pruneCount > 0,
      `expected pruneCount > 0 for old audit events, got ${auditTable!.pruneCount}`,
    );
    // With pruneCount > 0, actionability is advisory
    assert.equal(
      auditTable!.actionability,
      "advisory",
      `expected advisory, got "${auditTable!.actionability}"`,
    );
    // Plan summary should reflect the prune candidates
    assert.equal(plan.summary.totalPruneCandidates, auditTable!.pruneCount);
    assert.ok(plan.summary.candidateTables >= 1);

    store.close();
  } finally {
    temp.cleanup();
  }
});
