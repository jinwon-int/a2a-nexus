import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  CURRENT_BROKER_STATE_VERSION,
  JsonFileBrokerStateStore,
  SqliteArtifactRuntimeRepository,
  SqliteAuditRuntimeRepository,
  SqliteBrokerStateStore,
  SqliteExchangeMessageRuntimeRepository,
  SqliteExchangeRuntimeRepository,
  SqliteProposalRuntimeRepository,
  SqliteTaskRuntimeRepository,
  SqliteTombstoneRuntimeRepository,
  SqliteValidationRuntimeRepository,
  SqliteWorkerRuntimeRepository,
  buildHotEntityHintCoverage,
  emptySnapshot,
  serializeBrokerSnapshot,
  writeBrokerSnapshotFile,
  type BrokerSnapshot,
} from "./store.js";
import {
  BROKER_CLEANUP_CONFIRMATION,
  buildBrokerCleanupPlan,
  executeBrokerCleanupPlan,
  validateCleanupExecution,
} from "./broker-cleanup.js";
import type { TerminalTaskOutboxEvent } from "./terminal-event-outbox.js";
import {
  withTempFile, readSqliteCount, makeWorker, makeExchange, makeExchangeMessage,
  makeProposal, makeArtifact, makeValidation, makeTask, makeTombstone,
  makeAuditEvent, makeTerminalOutboxEvent, makeOutboxEvent,
} from "./store-test-helpers.js";

test("SqliteBrokerStateStore.readHotTableLoadMetrics returns per-table counts and max payload sizes", () => {
  const temp = withTempFile("hot-metrics.db");
  try {
    const store = new SqliteBrokerStateStore(temp.filePath);

    // Seed with known counts using save (which writes to hot tables)
    const t0 = "2026-04-27T00:00:00.000Z";
    const tasks: BrokerSnapshot["tasks"] = Array.from({ length: 5 }, (_, i) => ({
      ...makeTask(`task-${i}`, "succeeded", "worker-0"),
      createdAt: t0,
      updatedAt: t0,
    }));
    const auditEvents = Array.from({ length: 10 }, (_, i) =>
      makeAuditEvent(`audit-${i}`, "task.created", "task-0", t0),
    );
    const workers = [makeWorker("worker-0")];
    const terminalOutbox = [
      makeOutboxEvent("outbox-acked", "task-0", 0, t0, t0),
      makeOutboxEvent("outbox-unacked", "task-1", 1, t0, null),
    ];
    const tombstones = [makeTombstone("task-0", "failed", t0)];

    store.save(
      {
        ...emptySnapshot(),
        tasks,
        auditEvents,
        workers,
        terminalOutbox,
        tombstones,
      },
      {},
    );

    const metrics = store.readHotTableLoadMetrics();

    // Verify task counts and payload size
    assert.ok(metrics.tables["broker_tasks"], "broker_tasks should exist");
    assert.equal(metrics.tables["broker_tasks"].count, 5, "task count");
    assert.ok(metrics.tables["broker_tasks"].maxPayloadBytes > 0, "tasks should have nonzero max payload");
    assert.deepEqual(metrics.tables["broker_tasks"].runtimeLoad, {
      limit: 2000,
      loadedCount: 5,
      skippedCount: 0,
      activeCount: 0,
      terminalCount: 5,
    });

    // Verify audit event counts
    assert.equal(metrics.tables["broker_audit_events"].count, 10, "audit event count");
    assert.deepEqual(metrics.tables["broker_audit_events"].runtimeLoad, {
      limit: 5000,
      loadedCount: 10,
      skippedCount: 0,
    });

    // Verify terminal outbox with unacked count
    assert.equal(metrics.tables["broker_terminal_outbox"].count, 2, "terminal outbox count");
    assert.equal(metrics.tables["broker_terminal_outbox"].unackedCount, 1, "unacked count should be 1");
    assert.deepEqual(metrics.tables["broker_terminal_outbox"].runtimeLoad, {
      limit: 1000,
      loadedCount: 2,
      skippedCount: 0,
    });

    // Verify tombstone counts
    assert.equal(metrics.tables["broker_tombstones"].count, 1, "tombstone count");

    // Verify worker counts
    assert.equal(metrics.tables["broker_workers"].count, 1, "worker count");

    // Verify empty tables report zero
    assert.equal(metrics.tables["broker_artifacts"].count, 0, "artifacts should be zero");
    assert.equal(metrics.tables["broker_validations"].count, 0, "validations should be zero");
  } finally {
    temp.cleanup();
  }
});

test("SqliteBrokerStateStore hot-table runtime load caps hydrate bounded rows and expose skipped counts", () => {
  const temp = withTempFile("hot-runtime-caps.db");
  try {
    const store = new SqliteBrokerStateStore(temp.filePath, {
      loadSource: "hot-tables",
      maxHotRuntimeTerminalTasks: 2,
      maxHotRuntimeAuditEvents: 3,
      maxHotRuntimeTerminalOutboxEvents: 1,
    });
    const t0 = "2026-04-27T00:00:00.000Z";
    const activeTasks: BrokerSnapshot["tasks"] = Array.from({ length: 3 }, (_, i) => ({
      ...makeTask(`active-${i}`, (["queued", "claimed", "running"] as const)[i], "worker-0"),
      createdAt: t0,
      updatedAt: t0,
    }));
    const terminalTasks: BrokerSnapshot["tasks"] = Array.from({ length: 5 }, (_, i) => ({
      ...makeTask(`terminal-${i}`, i % 2 === 0 ? "succeeded" : "failed", "worker-0"),
      createdAt: t0,
      updatedAt: `2026-04-27T00:00:0${i}.000Z`,
    }));
    const auditEvents = Array.from({ length: 6 }, (_, i) =>
      makeAuditEvent(`audit-cap-${i}`, "task.created", `terminal-${i % terminalTasks.length}`, t0),
    );
    const terminalOutbox = Array.from({ length: 4 }, (_, i) =>
      makeOutboxEvent(`outbox-cap-${i}`, `terminal-${i}`, i, `2026-04-27T00:00:0${i}.000Z`, i === 0 ? null : t0),
    );

    store.save({
      ...emptySnapshot(),
      tasks: [...activeTasks, ...terminalTasks],
      auditEvents,
      terminalOutbox,
    }, {});

    const loaded = store.load();
    assert.equal(loaded.tasks.length, 5, "active tasks plus the newest two terminal tasks hydrate");
    assert.equal(loaded.auditEvents.length, 3, "audit runtime hydration respects configured cap");
    assert.equal(loaded.terminalOutbox?.length ?? 0, 1, "terminal outbox runtime hydration respects configured cap");

    const metrics = store.readHotTableLoadMetrics();
    assert.deepEqual(metrics.tables["broker_tasks"].runtimeLoad, {
      limit: 2,
      loadedCount: 5,
      skippedCount: 3,
      activeCount: 3,
      terminalCount: 5,
    });
    assert.deepEqual(metrics.tables["broker_audit_events"].runtimeLoad, {
      limit: 3,
      loadedCount: 3,
      skippedCount: 3,
    });
    assert.equal(metrics.tables["broker_terminal_outbox"].unackedCount, 1);
    assert.deepEqual(metrics.tables["broker_terminal_outbox"].runtimeLoad, {
      limit: 1,
      loadedCount: 1,
      skippedCount: 3,
    });
    assert.deepEqual(store.readHotTableRuntimeLoadLimits(), {
      terminalTasks: 2,
      auditEvents: 3,
      terminalOutboxEvents: 1,
    });
  } finally {
    temp.cleanup();
  }
});

test("SqliteBrokerStateStore.readHotRuntimeSnapshot survives representative load (hot-tables load source)", () => {
  const temp = withTempFile("hot-regr.db");
  try {
    // Create with hot-tables load source to exercise the exact regression path from #497
    const store = new SqliteBrokerStateStore(temp.filePath, { loadSource: "hot-tables" });

    // Seed representative data matching observed brokeralpha broker shape
    const t0 = "2026-04-27T00:00:00.000Z";
    const taskCount = 660;
    const auditCount = 1908;
    const workerCount = 21;
    const tombstoneCount = 177;
    const outboxCount = 389;
    const exchangeCount = 15;
    const exchangeMessageCount = 31;
    const proposalCount = 13;

    const tasks: BrokerSnapshot["tasks"] = Array.from({ length: taskCount }, (_, i) => ({
      ...makeTask(`task-r-${i}`, i % 4 === 0 ? "failed" : "succeeded", "worker-0"),
      createdAt: t0,
      updatedAt: t0,
    }));
    const auditEvents = Array.from({ length: auditCount }, (_, i) =>
      makeAuditEvent(`audit-r-${i}`, i % 3 === 0 ? "worker.heartbeat" : "task.created", "task-0", t0),
    );
    const workers = Array.from({ length: workerCount }, (_, i) =>
      makeWorker(`worker-r-${i}`),
    );
    const terminalOutbox = Array.from({ length: outboxCount }, (_, i) =>
      makeOutboxEvent(
        `outbox-r-${i}`,
        `task-r-${i % taskCount}`,
        i,
        t0,
        i < 200 ? null : t0,
      ),
    );
    const tombstones = Array.from({ length: tombstoneCount }, (_, i) =>
      makeTombstone(`task-r-${i}`, "failed", t0),
    );
    const exchanges = Array.from({ length: exchangeCount }, (_, i) =>
      makeExchange(`ex-r-${i}`, "worker-0", t0),
    );
    const exchangeMessages = Array.from({ length: exchangeMessageCount }, (_, i) =>
      makeExchangeMessage(`exmsg-r-${i}`, `ex-r-${i % exchangeCount}`, "root", undefined, t0),
    );
    const proposals = Array.from({ length: proposalCount }, (_, i) =>
      makeProposal(`proposal-r-${i}`, "submitted", "worker-0", t0),
    );

    const snapshot: BrokerSnapshot = {
      ...emptySnapshot(),
      tasks,
      auditEvents,
      workers,
      terminalOutbox,
      tombstones,
      exchanges,
      exchangeMessages,
      proposals,
    };

    store.save(snapshot, {});

    // Read back the entire hot-table snapshot — this is the exact code path
    // that caused OOM in issue #497
    const loaded = store.load();

    // Verify counts match (this asserts the read path is correct and doesn't crash)
    assert.equal(loaded.tasks.length, taskCount, "loaded task count should match seeded");
    assert.equal(loaded.auditEvents.length, auditCount, "loaded audit event count should match seeded");
    assert.equal(loaded.workers.length, workerCount, "loaded worker count should match seeded");
    assert.equal(loaded.terminalOutbox?.length ?? 0, outboxCount, "loaded terminal outbox count should match seeded");
    assert.equal(loaded.tombstones?.length ?? 0, tombstoneCount, "loaded tombstone count should match seeded");
    assert.equal(loaded.exchanges.length, exchangeCount, "loaded exchange count should match seeded");
    assert.equal(loaded.exchangeMessages.length, exchangeMessageCount, "loaded exchange message count should match seeded");
    assert.equal(loaded.proposals.length, proposalCount, "loaded proposal count should match seeded");

    // Verify structural integrity: all tasks have id and status
    assert.ok(loaded.tasks.every((t) => typeof t.id === "string" && typeof t.status === "string"), "all tasks have id and status");
    assert.ok(loaded.auditEvents.every((e) => typeof e.id === "string" && typeof e.action === "string"), "all audit events have id and action");
    assert.ok(loaded.workers.every((w) => typeof w.nodeId === "string"), "all workers have nodeId");

    // Verify readHotEntityMirrorStatus reports OK after consistent save/load
    const mirror = store.readHotEntityMirrorStatus();
    assert.ok(mirror.ok, `mirror status should be ok: ${JSON.stringify(mirror.mismatches)}`);
    assert.equal(mirror.mismatches.length, 0, "no mismatches after consistent load");

    // Verify readHotTableLoadMetrics gives correct counts
    const metrics = store.readHotTableLoadMetrics();
    assert.equal(metrics.tables["broker_tasks"].count, taskCount, "hot table metrics: task count");
    assert.equal(metrics.tables["broker_terminal_outbox"].unackedCount, 200, "hot table metrics: unacked count");
  } finally {
    temp.cleanup();
  }
});

test("SqliteBrokerStateStore planHotTaskRetention identifies prune candidates", () => {
  const temp = withTempFile("hot-retention.db");
  try {
    const store = new SqliteBrokerStateStore(temp.filePath);
    const t0 = "2026-04-27T00:00:00.000Z";

    // 500 terminal tasks + 160 active tasks
    const terminalTasks: BrokerSnapshot["tasks"] = Array.from({ length: 500 }, (_, i) => ({
      ...makeTask(`rt-${i}`, i % 3 === 0 ? "failed" : "succeeded", "worker-0"),
      createdAt: t0,
      updatedAt: t0,
    }));
    const activeTasks: BrokerSnapshot["tasks"] = Array.from({ length: 160 }, (_, i) => ({
      ...makeTask(`ra-${i}`, (["queued", "running", "claimed"] as const)[i % 3], "worker-0"),
      createdAt: t0,
      updatedAt: t0,
    }));

    store.save(
      { ...emptySnapshot(), tasks: [...terminalTasks, ...activeTasks], workers: [makeWorker("worker-0")] },
      {},
    );

    // Plan retention with a short window — should identify many terminal tasks for pruning
    const plan = store.planHotTaskRetention({
      retentionMs: 60 * 60 * 1000, // 1 hour
      maxTerminalRecords: 100,
    });

    // The plan should have retain and prune recommendations
    assert.equal(plan.table, "broker_tasks", "plan should target broker_tasks");
    assert.ok(plan.retainedIds.length >= 100, `should retain at least maxTerminalRecords (got ${plan.retainedIds.length})`);
    assert.ok(plan.pruneIds.length > 0, "should identify prune candidates");
  } finally {
    temp.cleanup();
  }
});

test("SqliteBrokerStateStore readHotRuntimeSnapshot caps non-terminal tasks with maxHotRuntimeNonTerminalTasks", () => {
  const temp = withTempFile("hot-nonterminal-cap.db");
  try {
    const store = new SqliteBrokerStateStore(temp.filePath, {
      loadSource: "hot-tables",
      maxHotRuntimeNonTerminalTasks: 3,
      maxHotRuntimeTerminalTasks: 2,
    });

    // 10 non-terminal tasks (queued/claimed/running) + 5 terminal tasks (succeeded/failed)
    const nonTerminal: BrokerSnapshot["tasks"] = Array.from({ length: 10 }, (_, i) => ({
      ...makeTask(`nt-${i}`, (["queued", "claimed", "running"] as const)[i % 3], "worker-0"),
      createdAt: `2026-04-27T00:0${i}:00.000Z`,
      updatedAt: `2026-04-27T00:0${i}:00.000Z`,
    }));
    const terminal: BrokerSnapshot["tasks"] = Array.from({ length: 5 }, (_, i) => ({
      ...makeTask(`t-${i}`, i % 2 === 0 ? "succeeded" : "failed", "worker-0"),
      createdAt: `2026-04-27T01:0${i}:00.000Z`,
      updatedAt: `2026-04-27T01:0${i}:00.000Z`,
    }));

    store.save({ ...emptySnapshot(), tasks: [...nonTerminal, ...terminal], workers: [makeWorker("worker-0")] });

    const hotSnapshot = store.readHotRuntimeSnapshot();
    const hotTasks = hotSnapshot.tasks;
    // Should have at most 3 non-terminal (ordered by updated_at DESC, id ASC) + at most 2 terminal
    assert.ok(hotTasks.length <= 5, `expected at most 5 hot tasks, got ${hotTasks.length}`);

    const nonTerminalIds = hotTasks
      .filter((t) => ["queued", "claimed", "running"].includes(t.status))
      .map((t) => t.id);
    assert.ok(nonTerminalIds.length <= 3, `expected at most 3 non-terminal tasks, got ${nonTerminalIds.length}`);
    // The most recent non-terminal tasks should be included
    assert.ok(nonTerminalIds.includes("nt-9"), "most recent non-terminal task should be included");
    assert.ok(nonTerminalIds.includes("nt-8"), "second most recent non-terminal task should be included");

    const terminalIds = hotTasks
      .filter((t) => ["succeeded", "failed", "canceled"].includes(t.status))
      .map((t) => t.id);
    assert.ok(terminalIds.length <= 2, `expected at most 2 terminal tasks, got ${terminalIds.length}`);

    store.close();
  } finally {
    temp.cleanup();
  }
});

test("SqliteBrokerStateStore readHotTerminalOutboxDiagnostics reports unacked staleness", () => {
  const temp = withTempFile("hot-outbox-diag.db");
  try {
    const store = new SqliteBrokerStateStore(temp.filePath);
    const now = new Date();
    const oldDate = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000).toISOString();

    const snapshot: BrokerSnapshot = {
      ...emptySnapshot(),
      terminalOutbox: [
        makeTerminalOutboxEvent("outbox-1", "task-1", oldDate),
        {
          ...makeTerminalOutboxEvent("outbox-2", "task-2", now.toISOString()),
          ack: {
            status: "receipt_confirmed" as const,
            evidence: "operator_visible" as const,
            acknowledgedAt: now.toISOString(),
          },
        },
        makeTerminalOutboxEvent("outbox-3", "task-3", oldDate),
      ],
    };
    store.save(snapshot);

    const diag = store.readHotTerminalOutboxDiagnostics();
    assert.equal(diag.total, 3);
    assert.equal(diag.acked, 1);
    assert.equal(diag.unacked, 2);
    assert.ok(diag.unackedRatio > 0.5);
    assert.ok(diag.oldestUnackedCreatedAt !== null);
    assert.ok(diag.oldestUnackedAgeMs !== null);
    assert.ok(diag.oldestUnackedAgeMs! > 12 * 24 * 60 * 60 * 1000, "oldest unacked should be >12 days old");
    assert.equal(diag.classification, "actionable_review_required");
    assert.equal(diag.actionableBacklog, true);
    assert.equal(diag.ageBuckets.gte14d, 2);
    assert.equal(Object.values(diag.byTerminalStatus).reduce((sum, count) => sum + count, 0), 2);
    assert.equal(Object.values(diag.byReceiptStatus).reduce((sum, count) => sum + count, 0), 2);
    // The oldest unacked warning should fire (>7 days)
    assert.ok(diag.warnings.some((w) => w.includes("days old")), "should warn about old unacked entry");

    store.close();
  } finally {
    temp.cleanup();
  }
});

test("SqliteBrokerStateStore incremental persist skips full snapshot serialization when hot hints present", () => {
  const temp = withTempFile("incremental-persist.db");
  try {
    const store = new SqliteBrokerStateStore(temp.filePath);
    const snapshot: BrokerSnapshot = {
      ...emptySnapshot(),
      tasks: [makeTask("task-1", "queued", "worker-a"), makeTask("task-2", "running", "worker-b")],
      auditEvents: [makeAuditEvent("audit-1", "task.created", "task-1"), makeAuditEvent("audit-2", "task.claimed", "task-2")],
      workers: [makeWorker("worker-a"), makeWorker("worker-b")],
      terminalOutbox: [makeTerminalOutboxEvent("outbox-1", "task-1", "2026-04-27T00:00:00.000Z"), makeTerminalOutboxEvent("outbox-2", "task-2", "2026-04-27T00:00:00.000Z")],
    };
    // Full persist: snapshot row MUST be written
    store.save(snapshot);

    let info = store.getPersistenceInfo();
    assert.ok(info.lastPersistAt !== undefined, "lastPersistAt should be set after persist");
    assert.equal(info.lastPersistSkippedFullSnapshot, false, "full persist should not skip snapshot");

    // Incremental persist: snapshot row should NOT be serialized again; only hot tables written
    const dirtyTask = { ...snapshot.tasks[0], status: "claimed" as const, claimedAt: "2026-05-01T00:00:00.000Z", updatedAt: "2026-05-01T00:00:00.000Z" };
    store.save(
      {
        ...emptySnapshot(),
        tasks: [dirtyTask, snapshot.tasks[1]],
        auditEvents: snapshot.auditEvents,
        terminalOutbox: snapshot.terminalOutbox,
      },
      {
        hotTasks: [dirtyTask],
        hotAuditEvents: [snapshot.auditEvents[0]],
      },
    );

    info = store.getPersistenceInfo();
    assert.equal(info.lastPersistSkippedFullSnapshot, true, "incremental persist should skip snapshot");
    assert.ok(info.lastHotHintCounts !== undefined, "hot hint counts should be recorded");
    assert.equal(info.lastHotHintCounts!.hotTasks, 1, "should report 1 dirty task hint");
    assert.equal(info.lastHotHintCounts!.hotAuditEvents, 1, "should report 1 dirty audit hint");

    // Verify hot table has the updated data
    const hotTasks = store.readHotTasks();
    const task1 = hotTasks.find((t) => t.id === "task-1");
    assert.equal(task1?.status, "claimed", "hot table should contain updated task");

    store.close();
  } finally {
    temp.cleanup();
  }
});

test("SqliteBrokerStateStore saves hot entity hints without a snapshot", () => {
  const temp = withTempFile("hot-only-persist.db");
  try {
    const store = new SqliteBrokerStateStore(temp.filePath, { maxBytes: 128 });
    const dirtyTask = {
      ...makeTask("task-hot-only", "queued", "worker-hot-only"),
      payload: { large: "x".repeat(1024) },
    };
    const audit = makeAuditEvent("audit-hot-only", "task.created", dirtyTask.id);

    store.saveHotEntities({
      hotTasks: [dirtyTask],
      hotAuditEvents: [audit],
      hotWorkers: [makeWorker("worker-hot-only")],
      hotTerminalOutboxEvents: [
        makeTerminalOutboxEvent("outbox-hot-only", dirtyTask.id, "2026-04-27T00:00:00.000Z"),
      ],
    });

    const info = store.getPersistenceInfo();
    assert.equal(info.lastPersistSkippedFullSnapshot, true);
    assert.equal(info.lastHotHintCounts?.hotTasks, 1);
    assert.equal(info.lastHotHintCounts?.hotAuditEvents, 1);
    assert.equal(info.lastHotHintCounts?.hotWorkers, 1);
    assert.equal(info.lastHotHintCounts?.hotTerminalOutboxEvents, 1);
    assert.equal(store.readHotTasks({ id: dirtyTask.id })[0]?.payload.large, "x".repeat(1024));
    assert.equal(store.readHotAuditEvents({ targetId: dirtyTask.id })[0]?.id, audit.id);
    assert.equal(store.readHotWorkers({ nodeId: "worker-hot-only" })[0]?.nodeId, "worker-hot-only");
    assert.equal(store.readHotTerminalOutbox().find((event) => event.id === "outbox-hot-only")?.payload.taskId, dirtyTask.id);

    store.close();
  } finally {
    temp.cleanup();
  }
});

test("SqliteBrokerStateStore getPersistenceInfo returns incremental persist diagnostics", () => {
  const temp = withTempFile("persist-diag.db");
  try {
    const store = new SqliteBrokerStateStore(temp.filePath);
    const snapshot: BrokerSnapshot = {
      ...emptySnapshot(),
      tasks: [makeTask("task-pd-1", "queued", "worker-a"), makeTask("task-pd-2", "running", "worker-b")],
      auditEvents: [makeAuditEvent("audit-pd-1", "task.created", "task-pd-1")],
      workers: [makeWorker("worker-a")],
    };
    // Full persist
    store.save(snapshot);
    let info = store.getPersistenceInfo();
    assert.ok(info.lastPersistAt !== undefined, "lastPersistAt should be set");
    assert.equal(info.lastPersistSkippedFullSnapshot, false, "full persist should not skip snapshot");
    assert.equal(info.lastHotHintCounts, undefined, "no hot hints should mean no hot hint counts");

    // Incremental persist with hints
    const dirtyTask = { ...snapshot.tasks[0], status: "claimed" as const, claimedAt: "2026-05-01T00:00:00.000Z", updatedAt: "2026-05-01T00:00:00.000Z" };
    store.save(
      {
        ...emptySnapshot(),
        tasks: [dirtyTask, snapshot.tasks[1]],
        auditEvents: snapshot.auditEvents,
        workers: snapshot.workers,
      },
      {
        hotTasks: [dirtyTask],
        hotWorkers: [snapshot.workers[0]],
      },
    );

    info = store.getPersistenceInfo();
    assert.ok(info.lastPersistAt !== undefined, "lastPersistAt should still be set");
    assert.equal(info.lastPersistSkippedFullSnapshot, true, "incremental persist should skip snapshot");
    assert.ok(info.lastHotHintCounts !== undefined, "hot hint counts should be present");
    assert.equal(info.lastHotHintCounts!.hotTasks, 1, "should report 1 dirty task");
    assert.equal(info.lastHotHintCounts!.hotWorkers, 1, "should report 1 dirty worker");
    // No terminal outbox events were dirty
    assert.equal(info.lastHotHintCounts!.hotTerminalOutboxEvents, 0, "no terminal outbox hints");

    store.close();
  } finally {
    temp.cleanup();
  }
});

test("BrokerCleanupPlan totalPruneCandidates=0 when all candidates are non-terminal or blocked (actionability gap)", () => {
  const temp = withTempFile("actionability-gap.db");
  try {
    const staleWorkerId = "stale-active-w";
    const store = new SqliteBrokerStateStore(temp.filePath);
    store.save({
      ...emptySnapshot(),
      tasks: [
        // Active (claimed) task assigned to stale worker — prevents worker pruning
        {
          ...makeTask("active-task", "claimed", staleWorkerId),
          claimedBy: staleWorkerId,
          updatedAt: "2026-04-27T00:00:00.000Z",
        },
        // Another old queued task — non-terminal, not a retention target
        {
          ...makeTask("queued-old", "queued", "worker-b"),
          updatedAt: "2026-04-27T00:00:00.000Z",
        },
      ],
      workers: [
        makeWorker(staleWorkerId),
        makeWorker("worker-b"),
      ],
      auditEvents: [
        makeAuditEvent("audit-old-1", "task.created", "active-task"),
        makeAuditEvent("audit-old-2", "task.created", "queued-old"),
      ],
    });

    const plan = buildBrokerCleanupPlan(store, {
      nowMs: Date.parse("2026-04-27T01:00:00.000Z"),
      taskRetentionMs: 30 * 60 * 1000,
      maxTerminalTasks: 100,
      auditRetentionMs: 30 * 60 * 1000,
      maxAuditEvents: 100,
      workerRetentionMs: 30 * 60 * 1000,
      maxInactiveWorkers: 0,
    });

    // Plan summary reflects no prunable rows
    assert.equal(plan.summary.candidateTables, 0, "no tables should have prune candidates");
    assert.equal(plan.summary.totalPruneCandidates, 0, "totalPruneCandidates should be 0");
    assert.equal(plan.summary.highestRisk, "low");

    // Verify each table individually has pruneCount 0
    for (const tablePlan of plan.tables) {
      assert.equal(
        tablePlan.pruneCount,
        0,
        `table ${tablePlan.table} should have 0 prune count: found ${tablePlan.pruneCount} candidates`,
      );
    }

    // Reason: no terminal tasks past retention, stale worker protected by active task,
    // queued task is non-terminal so not a retention target.
    const taskPlan = plan.tables.find((t) => t.table === "broker_tasks");
    assert.equal(taskPlan?.pruneCount, 0, "no terminal tasks past retention window");

    const workerPlan = plan.tables.find((t) => t.table === "broker_workers");
    assert.equal(workerPlan?.pruneCount, 0, "stale worker has active task so it is retained");

    // verify the store was NOT mutated
    assert.equal(store.readHotTasks().length, 2, "plan must not mutate task rows");
    assert.equal(store.readHotWorkers().length, 2, "plan must not mutate worker rows");
    store.close();
  } finally {
    temp.cleanup();
  }
});

test("BrokerCleanupPlan totalPruneCandidates=0 when only queued residue exists (no terminal tasks)", () => {
  const temp = withTempFile("queued-residue-gap.db");
  try {
    const store = new SqliteBrokerStateStore(temp.filePath);
    store.save({
      ...emptySnapshot(),
      tasks: [
        {
          ...makeTask("residue-task-1", "queued", "worker-active"),
          updatedAt: "2026-04-27T00:00:00.000Z",
        },
        {
          ...makeTask("residue-task-2", "queued", "worker-active"),
          updatedAt: "2026-04-27T00:00:00.000Z",
        },
      ],
      workers: [makeWorker("worker-active")],
    });

    const plan = buildBrokerCleanupPlan(store, {
      nowMs: Date.parse("2026-04-27T01:00:00.000Z"),
      taskRetentionMs: 30 * 60 * 1000,
      maxTerminalTasks: 0,
      auditRetentionMs: 30 * 60 * 1000,
      maxAuditEvents: 100,
      workerRetentionMs: 30 * 60 * 1000,
      maxInactiveWorkers: 0,
    });

    // Queued tasks are non-terminal; retention planner only prunes terminal tasks
    assert.equal(
      plan.summary.totalPruneCandidates,
      0,
      "queued residue is not a retention pruning target",
    );
    // Worker is still active (recent lastSeenAt) so not pruned
    assert.equal(
      plan.tables.find((t) => t.table === "broker_workers")?.pruneCount,
      0,
      "active worker is not a prune candidate",
    );

    store.close();
  } finally {
    temp.cleanup();
  }
});
