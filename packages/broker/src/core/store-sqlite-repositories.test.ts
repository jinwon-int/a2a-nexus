import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  SqliteBrokerStateStore,
  emptySnapshot,
  type BrokerSnapshot,
} from "./store.js";
import {
  BROKER_CLEANUP_CONFIRMATION,
  buildBrokerCleanupPlan,
  executeBrokerCleanupPlan,
  validateCleanupExecution,
} from "./broker-cleanup.js";
import {
  withTempFile, makeWorker, makeExchange, makeExchangeMessage,
  makeProposal, makeArtifact, makeValidation, makeTask, makeTombstone,
  makeAuditEvent, makeTerminalOutboxEvent, makeOutboxEvent,
} from "./store-test-helpers.js";

test("SqliteBrokerStateStore reports hot table mirror count drift", () => {
  const temp = withTempFile("state.sqlite");
  try {
    const snapshot: BrokerSnapshot = {
      ...emptySnapshot(),
      tasks: [makeTask("task-counted", "queued", "worker-a")],
    };

    const store = new SqliteBrokerStateStore(temp.filePath);
    store.save(snapshot);
    assert.deepEqual(store.readHotEntityMirrorStatus().mismatches, []);
    store.close();

    const db = new DatabaseSync(temp.filePath);
    try {
      db.exec("DELETE FROM broker_tasks");
    } finally {
      db.close();
    }

    const reloaded = new SqliteBrokerStateStore(temp.filePath);
    const status = reloaded.readHotEntityMirrorStatus();
    assert.equal(status.ok, false);
    assert.deepEqual(status.mismatches, [
      {
        table: "broker_tasks",
        snapshotKey: "tasks",
        tableCount: 0,
        snapshotCount: 1,
      },
    ]);
    reloaded.close();
  } finally {
    temp.cleanup();
  }
});

test("SqliteBrokerStateStore treats pruned audit hot rows as a retention window", () => {
  const temp = withTempFile("state.sqlite");
  try {
    const snapshot: BrokerSnapshot = {
      ...emptySnapshot(),
      auditEvents: [
        makeAuditEvent("audit-old", "task.created", "task-retained", "2026-04-27T00:00:00.000Z"),
        makeAuditEvent("audit-middle", "task.started", "task-retained", "2026-04-27T00:01:00.000Z"),
        makeAuditEvent("audit-new", "task.succeeded", "task-retained", "2026-04-27T00:02:00.000Z"),
      ],
    };

    const store = new SqliteBrokerStateStore(temp.filePath);
    store.save(snapshot);
    store.pruneHotAuditEventsToMax(1);

    const status = store.readHotEntityMirrorStatus();
    assert.equal(status.ok, true);
    assert.deepEqual(status.mismatches, []);
    assert.deepEqual(status.retentionWindows, [
      {
        table: "broker_audit_events",
        snapshotKey: "auditEvents",
        tableCount: 1,
        snapshotCount: 3,
        reason: "audit_hot_retention",
        prunedCount: 2,
      },
    ]);
    store.close();
  } finally {
    temp.cleanup();
  }
});

test("SqliteBrokerStateStore still reports audit hot-table id drift", () => {
  const temp = withTempFile("state.sqlite");
  try {
    const snapshot: BrokerSnapshot = {
      ...emptySnapshot(),
      auditEvents: [
        makeAuditEvent("audit-one", "task.created", "task-drift", "2026-04-27T00:00:00.000Z"),
        makeAuditEvent("audit-two", "task.started", "task-drift", "2026-04-27T00:01:00.000Z"),
      ],
    };

    const store = new SqliteBrokerStateStore(temp.filePath);
    store.save(snapshot);
    store.close();

    const db = new DatabaseSync(temp.filePath);
    try {
      db.prepare("UPDATE broker_audit_events SET id = ? WHERE id = ?").run("audit-rogue", "audit-two");
    } finally {
      db.close();
    }

    const reloaded = new SqliteBrokerStateStore(temp.filePath);
    const status = reloaded.readHotEntityMirrorStatus();
    assert.equal(status.ok, false);
    assert.deepEqual(status.mismatches, [
      {
        table: "broker_audit_events",
        snapshotKey: "auditEvents",
        tableCount: 2,
        snapshotCount: 2,
        reason: "id_drift",
      },
    ]);
    assert.equal(status.retentionWindows, undefined);
    reloaded.close();
  } finally {
    temp.cleanup();
  }
});

test("SqliteBrokerStateStore supports granular task and audit hot-table upserts", () => {
  const temp = withTempFile("state.sqlite");
  try {
    const store = new SqliteBrokerStateStore(temp.filePath);
    store.save({
      ...emptySnapshot(),
      tasks: [makeTask("task-upsert", "queued", "worker-a")],
      auditEvents: [makeAuditEvent("audit-upsert", "task.created", "task-upsert")],
    });

    const updatedTask = {
      ...makeTask("task-upsert", "succeeded", "worker-b"),
      completedAt: "2026-04-27T00:03:00.000Z",
      updatedAt: "2026-04-27T00:03:00.000Z",
    };
    const updatedAudit = makeAuditEvent("audit-upsert", "task.succeeded", "task-upsert", "2026-04-27T00:03:00.000Z");
    const appendedAudit = makeAuditEvent("audit-appended", "task.claimed", "task-upsert", "2026-04-27T00:02:00.000Z");

    store.upsertHotTasks([updatedTask]);
    store.upsertHotAuditEvents([updatedAudit, appendedAudit]);

    assert.deepEqual(
      store.readHotTasks({ id: "task-upsert" }),
      [updatedTask],
    );
    assert.deepEqual(
      store.readHotAuditEvents({ targetId: "task-upsert" }).map((event) => event.id),
      ["audit-upsert", "audit-appended"],
    );
    assert.deepEqual(store.readHotEntityTableCounts().broker_tasks, 1);
    assert.deepEqual(store.readHotEntityTableCounts().broker_audit_events, 2);
    store.close();
  } finally {
    temp.cleanup();
  }
});

test("SqliteBrokerStateStore save hints update dirty task and audit rows while preserving retained rows", () => {
  const temp = withTempFile("state.sqlite");
  try {
    const initialTask = makeTask("task-dirty", "queued", "worker-a");
    const retainedTask = makeTask("task-retained", "queued", "worker-b");
    const initialAudit = makeAuditEvent("audit-dirty", "task.created", "task-dirty");
    const retainedAudit = makeAuditEvent("audit-retained", "task.created", "task-retained");
    const store = new SqliteBrokerStateStore(temp.filePath);
    store.save({
      ...emptySnapshot(),
      tasks: [initialTask, retainedTask],
      auditEvents: [initialAudit, retainedAudit],
    });

    const dirtyTask = {
      ...initialTask,
      status: "claimed" as const,
      claimedBy: "worker-a",
      claimedAt: "2026-04-27T00:02:00.000Z",
      updatedAt: "2026-04-27T00:02:00.000Z",
    };
    const dirtyAudit = makeAuditEvent("audit-dirty-2", "task.claimed", "task-dirty", "2026-04-27T00:02:00.000Z");
    store.save(
      {
        ...emptySnapshot(),
        tasks: [dirtyTask, retainedTask],
        auditEvents: [initialAudit, retainedAudit, dirtyAudit],
      },
      {
        hotTasks: [dirtyTask],
        hotAuditEvents: [dirtyAudit],
      },
    );

    assert.deepEqual(store.readHotTasks().map((task) => task.id).sort(), ["task-dirty", "task-retained"]);
    assert.equal(store.readHotTasks({ id: "task-dirty" })[0]?.status, "claimed");
    assert.deepEqual(
      store.readHotAuditEvents({ targetId: "task-retained" }).map((event) => event.id),
      ["audit-retained"],
    );
    assert.equal(store.readHotEntityMirrorStatus().ok, true);

    store.save(
      {
        ...emptySnapshot(),
        tasks: [dirtyTask],
        auditEvents: [initialAudit, dirtyAudit],
      },
      {
        hotTasks: [],
        hotAuditEvents: [],
      },
    );
    assert.deepEqual(store.readHotTasks().map((task) => task.id), ["task-dirty"]);
    assert.deepEqual(store.readHotAuditEvents().map((event) => event.id).sort(), ["audit-dirty", "audit-dirty-2"]);
    store.close();
  } finally {
    temp.cleanup();
  }
});

test("SqliteBrokerStateStore keeps snapshot-only push configs current when saving with hot hints", () => {
  const temp = withTempFile("state.sqlite");
  try {
    const store = new SqliteBrokerStateStore(temp.filePath);
    const task = makeTask("task-push-sidecar", "queued", "worker-a");
    store.save({
      ...emptySnapshot(),
      tasks: [task],
      pushNotificationConfigs: [
        { taskId: task.id, id: "cfg-sidecar", url: "https://example.com/sidecar", token: "sidecar-secret" },
      ],
    });

    const claimedTask = {
      ...task,
      status: "claimed" as const,
      claimedBy: "worker-a",
      claimedAt: "2026-04-27T00:05:00.000Z",
      updatedAt: "2026-04-27T00:05:00.000Z",
    };
    store.save(
      {
        ...emptySnapshot(),
        tasks: [claimedTask],
        pushNotificationConfigs: [],
      },
      { hotTasks: [claimedTask] },
    );
    store.close();

    const reloaded = new SqliteBrokerStateStore(temp.filePath, { loadSource: "hot-tables" });
    const snapshot = reloaded.load();
    assert.deepEqual(snapshot.pushNotificationConfigs, []);
    assert.equal(snapshot.tasks[0]?.status, "claimed");
    reloaded.close();
  } finally {
    temp.cleanup();
  }
});

test("SqliteBrokerStateStore incremental hints leave unrelated hot tables untouched", () => {
  const temp = withTempFile("state.sqlite");
  try {
    const store = new SqliteBrokerStateStore(temp.filePath);
    const task = makeTask("task-stable", "succeeded", "worker-a");
    const outbox = makeTerminalOutboxEvent("outbox-stable", "task-stable", "2026-04-27T00:03:00.000Z");
    const worker = makeWorker("worker-a");
    const audit = makeAuditEvent("audit-stable", "task.succeeded", "task-stable");
    store.save({
      ...emptySnapshot(),
      tasks: [task],
      workers: [worker],
      auditEvents: [audit],
      terminalOutbox: [outbox],
    });

    const heartbeat = {
      ...worker,
      updatedAt: "2026-04-27T00:04:00.000Z",
      lastSeenAt: "2026-04-27T00:04:00.000Z",
    };
    const heartbeatAudit = {
      ...makeAuditEvent("worker-heartbeat:worker-a", "worker.heartbeat", "worker-a", "2026-04-27T00:04:00.000Z"),
      targetType: "worker",
    } satisfies BrokerSnapshot["auditEvents"][number];

    store.save(
      {
        ...emptySnapshot(),
        tasks: [task],
        workers: [heartbeat],
        auditEvents: [audit, heartbeatAudit],
        terminalOutbox: [outbox],
      },
      {
        hotWorkers: [heartbeat],
        hotAuditEvents: [heartbeatAudit],
      },
    );

    assert.deepEqual(store.readHotTasks().map((row) => row.id), ["task-stable"]);
    assert.deepEqual(store.readHotTerminalOutbox().map((row) => row.id), ["outbox-stable"]);
    assert.equal(store.readHotWorkers({ nodeId: "worker-a" })[0]?.lastSeenAt, heartbeat.lastSeenAt);
    assert.deepEqual(
      store.readHotAuditEvents().map((row) => row.id).sort(),
      ["audit-stable", "worker-heartbeat:worker-a"],
    );
    assert.equal(store.getPersistenceInfo().lastPersistSkippedFullSnapshot, true);
    store.close();
  } finally {
    temp.cleanup();
  }
});

test("SqliteBrokerStateStore plans task hot-table retention from DB rows", () => {
  const temp = withTempFile("state.sqlite");
  try {
    const oldFailed = {
      ...makeTask("task-old-failed", "failed", "worker-a"),
      completedAt: "2026-04-27T00:00:00.000Z",
      updatedAt: "2026-04-27T00:00:00.000Z",
    };
    const oldSucceeded = {
      ...makeTask("task-old-succeeded", "succeeded", "worker-a"),
      completedAt: "2026-04-27T00:01:00.000Z",
      updatedAt: "2026-04-27T00:01:00.000Z",
    };
    const oldProtected = {
      ...makeTask("task-old-protected", "canceled", "worker-a"),
      completedAt: "2026-04-27T00:02:00.000Z",
      updatedAt: "2026-04-27T00:02:00.000Z",
    };
    const recentTerminal = {
      ...makeTask("task-recent-terminal", "succeeded", "worker-a"),
      completedAt: "2026-04-27T00:45:00.000Z",
      updatedAt: "2026-04-27T00:45:00.000Z",
    };
    const running = {
      ...makeTask("task-running-old", "running", "worker-a"),
      updatedAt: "2026-04-27T00:00:00.000Z",
    };
    const store = new SqliteBrokerStateStore(temp.filePath);
    store.save({
      ...emptySnapshot(),
      tasks: [oldFailed, oldSucceeded, oldProtected, recentTerminal, running],
    });

    const plan = store.planHotTaskRetention({
      nowMs: Date.parse("2026-04-27T01:00:00.000Z"),
      retentionMs: 30 * 60 * 1000,
      maxTerminalRecords: 1,
      protectedTaskIds: ["task-old-protected"],
    });

    assert.equal(plan.table, "broker_tasks");
    assert.deepEqual(plan.pruneIds, ["task-old-failed"]);
    assert.deepEqual(plan.retainedIds, [
      "task-old-protected",
      "task-old-succeeded",
      "task-recent-terminal",
      "task-running-old",
    ]);
    store.close();
  } finally {
    temp.cleanup();
  }
});

test("SqliteBrokerStateStore plans audit hot-table retention with protected targets", () => {
  const temp = withTempFile("state.sqlite");
  try {
    const oldPruned = makeAuditEvent("audit-old-pruned", "task.failed", "task-pruned", "2026-04-27T00:00:00.000Z");
    const oldPrunedByAge = makeAuditEvent("audit-old-by-age", "task.succeeded", "task-kept", "2026-04-27T00:01:00.000Z");
    const oldProtected = makeAuditEvent("audit-old-protected", "task.created", "task-protected", "2026-04-27T00:02:00.000Z");
    const recent = makeAuditEvent("audit-recent", "task.claimed", "task-recent", "2026-04-27T00:45:00.000Z");
    const store = new SqliteBrokerStateStore(temp.filePath);
    store.save({
      ...emptySnapshot(),
      auditEvents: [oldPruned, oldPrunedByAge, oldProtected, recent],
    });

    const plan = store.planHotAuditRetention({
      nowMs: Date.parse("2026-04-27T01:00:00.000Z"),
      retentionMs: 30 * 60 * 1000,
      maxRecords: 1,
      protectedIds: { taskIds: ["task-protected"] },
    });

    assert.equal(plan.table, "broker_audit_events");
    assert.deepEqual(plan.pruneIds, ["audit-old-by-age", "audit-old-pruned"]);
    assert.deepEqual(plan.retainedIds, [
      "audit-old-protected",
      "audit-recent",
    ]);
    store.close();
  } finally {
    temp.cleanup();
  }
});

test("SqliteBrokerStateStore caps recent worker heartbeat audit rows even when worker is protected", () => {
  const temp = withTempFile("state.sqlite");
  try {
    const workerId = "worker-hot";
    const heartbeats = [
      makeAuditEvent("heartbeat-1", "worker.heartbeat", workerId, "2026-04-27T00:00:01.000Z"),
      makeAuditEvent("heartbeat-2", "worker.heartbeat", workerId, "2026-04-27T00:00:02.000Z"),
      makeAuditEvent("heartbeat-3", "worker.heartbeat", workerId, "2026-04-27T00:00:03.000Z"),
    ].map((event) => ({ ...event, targetType: "worker" as const }));
    const registered = {
      ...makeAuditEvent("worker-registered", "worker.registered", workerId, "2026-04-27T00:00:00.000Z"),
      targetType: "worker" as const,
    };
    const store = new SqliteBrokerStateStore(temp.filePath);
    store.save({
      ...emptySnapshot(),
      auditEvents: [registered, ...heartbeats],
    });

    const plan = store.planHotAuditRetention({
      nowMs: Date.parse("2026-04-27T00:01:00.000Z"),
      retentionMs: 60 * 60 * 1000,
      maxRecords: 2,
      protectedIds: { workerIds: [workerId] },
    });

    assert.deepEqual(plan.pruneIds, ["heartbeat-1"]);
    assert.deepEqual(plan.retainedIds, ["heartbeat-2", "heartbeat-3", "worker-registered"]);
    store.close();
  } finally {
    temp.cleanup();
  }
});

test("SqliteBrokerStateStore caps recent task heartbeat audit rows even when task is protected", () => {
  const temp = withTempFile("state.sqlite");
  try {
    const taskId = "task-hot";
    const heartbeats = [
      makeAuditEvent("task-heartbeat-1", "task.heartbeat", taskId, "2026-04-27T00:00:01.000Z"),
      makeAuditEvent("task-heartbeat-2", "task.heartbeat", taskId, "2026-04-27T00:00:02.000Z"),
      makeAuditEvent("task-heartbeat-3", "task.heartbeat", taskId, "2026-04-27T00:00:03.000Z"),
    ];
    const created = makeAuditEvent("task-created", "task.created", taskId, "2026-04-27T00:00:00.000Z");
    const store = new SqliteBrokerStateStore(temp.filePath);
    store.save({
      ...emptySnapshot(),
      auditEvents: [created, ...heartbeats],
    });

    const plan = store.planHotAuditRetention({
      nowMs: Date.parse("2026-04-27T00:01:00.000Z"),
      retentionMs: 60 * 60 * 1000,
      maxRecords: 2,
      protectedIds: { taskIds: [taskId] },
    });

    assert.deepEqual(plan.pruneIds, ["task-heartbeat-1"]);
    assert.deepEqual(plan.retainedIds, ["task-created", "task-heartbeat-2", "task-heartbeat-3"]);
    store.close();
  } finally {
    temp.cleanup();
  }
});

test("SqliteBrokerStateStore applies task and audit hot retention plans", () => {
  const temp = withTempFile("state.sqlite");
  try {
    const taskKeep = makeTask("task-keep", "succeeded", "worker-a");
    const taskPrune = makeTask("task-prune", "failed", "worker-a");
    const auditKeep = makeAuditEvent("audit-keep", "task.succeeded", "task-keep");
    const auditPrune = makeAuditEvent("audit-prune", "task.failed", "task-prune");
    const store = new SqliteBrokerStateStore(temp.filePath);
    store.save({
      ...emptySnapshot(),
      tasks: [taskKeep, taskPrune],
      auditEvents: [auditKeep, auditPrune],
    });

    const [taskResult, auditResult] = store.applyHotRetentionPlans([
      {
        table: "broker_tasks",
        cutoffMs: 0,
        retainedIds: ["task-keep"],
        pruneIds: ["task-prune", "task-missing"],
      },
      {
        table: "broker_audit_events",
        cutoffMs: 0,
        retainedIds: ["audit-keep"],
        pruneIds: ["audit-prune"],
      },
    ]);

    assert.deepEqual(taskResult, {
      table: "broker_tasks",
      retainedCount: 1,
      requestedPruneCount: 2,
      prunedCount: 1,
      remainingCount: 1,
    });
    assert.deepEqual(auditResult, {
      table: "broker_audit_events",
      retainedCount: 1,
      requestedPruneCount: 1,
      prunedCount: 1,
      remainingCount: 1,
    });
    assert.deepEqual(store.readHotTasks().map((task) => task.id), ["task-keep"]);
    assert.deepEqual(store.readHotAuditEvents().map((event) => event.id), ["audit-keep"]);
    store.close();
  } finally {
    temp.cleanup();
  }
});

test("SqliteBrokerStateStore canonical retention sync prunes push configs for pruned tasks", () => {
  const temp = withTempFile("state.sqlite");
  try {
    const taskKeep = makeTask("task-keep", "succeeded", "worker-a");
    const taskPrune = makeTask("task-prune", "failed", "worker-a");
    const store = new SqliteBrokerStateStore(temp.filePath);
    store.save({
      ...emptySnapshot(),
      tasks: [taskKeep, taskPrune],
      auditEvents: [makeAuditEvent("audit-keep", "task.succeeded", taskKeep.id)],
      pushNotificationConfigs: [
        { taskId: taskKeep.id, id: "cfg-keep", url: "https://example.com/keep", token: "keep-secret" },
        { taskId: taskPrune.id, id: "cfg-prune", url: "https://example.com/prune", token: "prune-secret" },
      ],
    });

    const result = store.syncCanonicalSnapshotWithHotRetentionPlans(
      [
        {
          table: "broker_tasks",
          cutoffMs: 0,
          retainedIds: [taskKeep.id],
          pruneIds: [taskPrune.id],
        },
      ],
      makeAuditEvent("audit-retention-sync", "broker.cleanup.applied", taskPrune.id),
    );

    assert.equal(result.synced, true);
    const snapshot = store.load();
    assert.deepEqual(snapshot.tasks.map((task) => task.id), [taskKeep.id]);
    assert.deepEqual(snapshot.pushNotificationConfigs?.map((config) => config.id), ["cfg-keep"]);
    assert.ok(!JSON.stringify(snapshot).includes("prune-secret"), "canonical snapshot must not retain pruned task push secrets");
    store.close();
  } finally {
    temp.cleanup();
  }
});

test("SqliteBrokerStateStore save hints prune missing task and audit rows through retention plans", () => {
  const temp = withTempFile("state.sqlite");
  try {
    const store = new SqliteBrokerStateStore(temp.filePath);
    const taskKeep = makeTask("task-keep", "queued", "worker-a");
    const taskPrune = makeTask("task-prune", "failed", "worker-a");
    const auditKeep = makeAuditEvent("audit-keep", "task.created", "task-keep");
    const auditPrune = makeAuditEvent("audit-prune", "task.failed", "task-prune");
    store.save({
      ...emptySnapshot(),
      tasks: [taskKeep, taskPrune],
      auditEvents: [auditKeep, auditPrune],
      pushNotificationConfigs: [
        { taskId: taskKeep.id, id: "cfg-keep", url: "https://example.com/keep", token: "keep-secret" },
        { taskId: taskPrune.id, id: "cfg-prune", url: "https://example.com/prune", token: "prune-secret" },
      ],
    });

    store.save(
      {
        ...emptySnapshot(),
        tasks: [taskKeep],
        auditEvents: [auditKeep],
      },
      {
        hotTasks: [taskKeep],
        hotAuditEvents: [auditKeep],
      },
    );

    assert.deepEqual(store.readHotTasks().map((task) => task.id), ["task-keep"]);
    assert.deepEqual(store.readHotAuditEvents().map((event) => event.id), ["audit-keep"]);
    assert.equal(store.readHotEntityMirrorStatus().ok, true);
    store.close();
  } finally {
    temp.cleanup();
  }
});

test("broker cleanup plan reports dry-run candidates with stable gates", () => {
  const temp = withTempFile("state.sqlite");
  try {
    const oldTerminal = {
      ...makeTask("cleanup-old-terminal", "failed", "worker-idle"),
      completedAt: "2026-04-27T00:00:00.000Z",
      updatedAt: "2026-04-27T00:00:00.000Z",
    };
    const active = {
      ...makeTask("cleanup-active", "running", "worker-active"),
      updatedAt: "2026-04-27T00:00:00.000Z",
    };
    const store = new SqliteBrokerStateStore(temp.filePath);
    store.save({
      ...emptySnapshot(),
      tasks: [oldTerminal, active],
      workers: [makeWorker("worker-idle"), makeWorker("worker-active")],
      auditEvents: [
        makeAuditEvent("cleanup-audit-old-terminal", "task.failed", oldTerminal.id, "2026-04-27T00:00:00.000Z"),
        makeAuditEvent("cleanup-audit-active", "task.started", active.id, "2026-04-27T00:00:00.000Z"),
      ],
      terminalOutbox: [
        makeOutboxEvent("cleanup-outbox-acked", oldTerminal.id, 1, "2026-04-27T00:00:00.000Z", "2026-04-27T00:00:00.000Z"),
        makeOutboxEvent("cleanup-outbox-unacked", oldTerminal.id, 2, "2026-04-27T00:00:00.000Z", null),
      ],
    });

    const plan = buildBrokerCleanupPlan(store, {
      nowMs: Date.parse("2026-04-27T01:00:00.000Z"),
      taskRetentionMs: 30 * 60 * 1000,
      maxTerminalTasks: 0,
      auditRetentionMs: 30 * 60 * 1000,
      maxAuditEvents: 0,
      workerRetentionMs: 30 * 60 * 1000,
      maxInactiveWorkers: 0,
      terminalOutboxRetentionMs: 30 * 60 * 1000,
      maxAcknowledgedTerminalOutboxEvents: 0,
    });

    assert.equal(plan.kind, "broker.cleanup.plan");
    assert.equal(plan.mode, "dry-run");
    assert.equal(plan.summary.totalPruneCandidates, 4);
    assert.equal(plan.summary.highestRisk, "high");
    assert.equal(plan.planId.length, 16);
    assert.deepEqual(plan.tables.find((table) => table.table === "broker_tasks")?.pruneIds, [oldTerminal.id]);
    assert.deepEqual(plan.tables.find((table) => table.table === "broker_audit_events")?.pruneIds, ["cleanup-audit-old-terminal"]);
    assert.deepEqual(plan.tables.find((table) => table.table === "broker_workers")?.pruneIds, ["worker-idle"]);
    assert.deepEqual(plan.tables.find((table) => table.table === "broker_terminal_outbox")?.pruneIds, ["cleanup-outbox-acked"]);
    assert.deepEqual(plan.tables.find((table) => table.table === "broker_terminal_outbox")?.retainedIds, ["cleanup-outbox-unacked"]);
    assert.equal(plan.tables.find((table) => table.table === "broker_workers")?.executionBlockedByDefault, true);
    assert.equal(plan.tables.find((table) => table.table === "broker_terminal_outbox")?.executionBlockedByDefault, true);
    assert.match(plan.notes.join("\n"), /Terminal outbox pruning is dry-run-only/);
    assert.equal(store.readHotTasks().length, 2, "dry-run plan must not mutate task rows");
    assert.equal(store.readHotTerminalOutbox().length, 2, "dry-run plan must not mutate terminal outbox rows");
    store.close();
  } finally {
    temp.cleanup();
  }
});

test("broker cleanup execution blocks terminal outbox pruning as dry-run-only", () => {
  const temp = withTempFile("state.sqlite");
  try {
    const store = new SqliteBrokerStateStore(temp.filePath);
    store.save({
      ...emptySnapshot(),
      terminalOutbox: [
        makeOutboxEvent("cleanup-outbox-acked", "task-outbox", 1, "2026-04-27T00:00:00.000Z", "2026-04-27T00:00:00.000Z"),
      ],
    });

    const plan = buildBrokerCleanupPlan(store, {
      nowMs: Date.parse("2026-04-27T01:00:00.000Z"),
      terminalOutboxRetentionMs: 30 * 60 * 1000,
      maxAcknowledgedTerminalOutboxEvents: 0,
    });

    assert.deepEqual(plan.tables.find((table) => table.table === "broker_terminal_outbox")?.pruneIds, ["cleanup-outbox-acked"]);
    assert.throws(
      () => executeBrokerCleanupPlan(store, plan, {
        approvalToken: plan.planId,
        confirmation: BROKER_CLEANUP_CONFIRMATION,
        backupProof: "sqlite backup: /tmp/backup.sqlite sha256=abc123",
      }),
      /terminal outbox prune candidates are dry-run-only/,
    );
    assert.equal(store.readHotTerminalOutbox().length, 1, "blocked execution must not mutate terminal outbox rows");
    store.close();
  } finally {
    temp.cleanup();
  }
});

test("broker cleanup execution requires approval, backup proof, and worker override", () => {
  const temp = withTempFile("state.sqlite");
  try {
    const oldTerminal = {
      ...makeTask("cleanup-exec-terminal", "failed", "worker-prune"),
      completedAt: "2026-04-27T00:00:00.000Z",
      updatedAt: "2026-04-27T00:00:00.000Z",
    };
    const store = new SqliteBrokerStateStore(temp.filePath);
    store.save({
      ...emptySnapshot(),
      tasks: [oldTerminal],
      workers: [makeWorker("worker-prune")],
      auditEvents: [makeAuditEvent("cleanup-exec-audit", "task.failed", oldTerminal.id, "2026-04-27T00:00:00.000Z")],
    });

    const plan = buildBrokerCleanupPlan(store, {
      nowMs: Date.parse("2026-04-27T01:00:00.000Z"),
      taskRetentionMs: 30 * 60 * 1000,
      maxTerminalTasks: 0,
      auditRetentionMs: 30 * 60 * 1000,
      maxAuditEvents: 0,
      workerRetentionMs: 30 * 60 * 1000,
      maxInactiveWorkers: 0,
    });

    assert.deepEqual(validateCleanupExecution(plan, {}), [
      "approvalToken does not match planId",
      `confirmation must equal ${BROKER_CLEANUP_CONFIRMATION}`,
      "backupProof is required before cleanup execution",
      "worker prune candidates require allowWorkerPrune=true because stale workers may still be valid home-broker records",
    ]);

    assert.throws(
      () => executeBrokerCleanupPlan(store, plan, {
        approvalToken: plan.planId,
        confirmation: BROKER_CLEANUP_CONFIRMATION,
        backupProof: "sqlite backup: /tmp/backup.sqlite sha256=abc123",
      }),
      /worker prune candidates require allowWorkerPrune=true/,
    );

    const result = executeBrokerCleanupPlan(store, plan, {
      approvalToken: plan.planId,
      confirmation: BROKER_CLEANUP_CONFIRMATION,
      backupProof: "sqlite backup: /tmp/backup.sqlite sha256=abc123",
      allowWorkerPrune: true,
    });

    assert.equal(result.kind, "broker.cleanup.execution");
    assert.deepEqual(result.results.map((item) => [item.table, item.prunedCount]), [
      ["broker_tasks", 1],
      ["broker_audit_events", 1],
      ["broker_workers", 1],
      ["broker_terminal_outbox", 0],
    ]);
    assert.equal(result.auditEvent.action, "broker.cleanup.applied");
    assert.equal(result.auditEvent.targetType, "broker");
    assert.equal(result.auditEvent.targetId, plan.planId);
    assert.equal(store.readHotTasks().length, 0);
    assert.deepEqual(store.readHotAuditEvents().map((event) => event.action), ["broker.cleanup.applied"]);
    assert.equal(store.readHotWorkers().length, 0);
    store.close();
  } finally {
    temp.cleanup();
  }
});

test("SqliteBrokerStateStore supports worker hot-table upserts and retention plans", () => {
  const temp = withTempFile("state.sqlite");
  try {
    const oldPruned = makeWorker("worker-old-pruned");
    const oldKeptByCap = {
      ...makeWorker("worker-old-kept"),
      lastSeenAt: "2026-04-27T00:01:00.000Z",
      updatedAt: "2026-04-27T00:01:00.000Z",
    };
    const oldProtected = {
      ...makeWorker("worker-old-protected"),
      lastSeenAt: "2026-04-27T00:02:00.000Z",
      updatedAt: "2026-04-27T00:02:00.000Z",
    };
    const recent = {
      ...makeWorker("worker-recent"),
      lastSeenAt: "2026-04-27T00:45:00.000Z",
      updatedAt: "2026-04-27T00:45:00.000Z",
    };
    const store = new SqliteBrokerStateStore(temp.filePath);
    store.save({
      ...emptySnapshot(),
      workers: [oldPruned, oldKeptByCap, oldProtected, recent],
    });

    const updatedRecent = {
      ...recent,
      displayName: "recent worker",
      lastSeenAt: "2026-04-27T00:50:00.000Z",
      updatedAt: "2026-04-27T00:50:00.000Z",
    };
    store.upsertHotWorkers([updatedRecent]);
    assert.equal(store.readHotWorkers({ nodeId: "worker-recent" })[0]?.displayName, "recent worker");

    const plan = store.planHotWorkerRetention({
      nowMs: Date.parse("2026-04-27T01:00:00.000Z"),
      retentionMs: 30 * 60 * 1000,
      maxInactiveWorkers: 1,
      protectedWorkerIds: ["worker-old-protected"],
    });
    assert.equal(plan.table, "broker_workers");
    assert.deepEqual(plan.pruneIds, ["worker-old-pruned"]);
    assert.deepEqual(plan.retainedIds, ["worker-old-kept", "worker-old-protected", "worker-recent"]);

    const result = store.applyHotRetentionPlan(plan);
    assert.deepEqual(result, {
      table: "broker_workers",
      retainedCount: 3,
      requestedPruneCount: 1,
      prunedCount: 1,
      remainingCount: 3,
    });
    assert.deepEqual(store.readHotWorkers().map((worker) => worker.nodeId).sort(), [
      "worker-old-kept",
      "worker-old-protected",
      "worker-recent",
    ]);
    store.close();
  } finally {
    temp.cleanup();
  }
});

test("SqliteBrokerStateStore save hints update dirty worker rows and prune missing workers", () => {
  const temp = withTempFile("state.sqlite");
  try {
    const store = new SqliteBrokerStateStore(temp.filePath);
    const workerKeep = makeWorker("worker-keep");
    const workerPrune = makeWorker("worker-prune");
    store.save({
      ...emptySnapshot(),
      workers: [workerKeep, workerPrune],
    });

    const dirtyWorker = {
      ...workerKeep,
      displayName: "kept worker",
      lastSeenAt: "2026-04-27T00:03:00.000Z",
      updatedAt: "2026-04-27T00:03:00.000Z",
    };
    store.save(
      {
        ...emptySnapshot(),
        workers: [dirtyWorker],
      },
      {
        hotWorkers: [dirtyWorker],
      },
    );

    assert.deepEqual(store.readHotWorkers().map((worker) => worker.nodeId), ["worker-keep"]);
    assert.equal(store.readHotWorkers({ nodeId: "worker-keep" })[0]?.displayName, "kept worker");
    assert.equal(store.readHotEntityMirrorStatus().ok, true);
    store.close();
  } finally {
    temp.cleanup();
  }
});

test("SqliteBrokerStateStore supports exchange hot-table upserts and hinted pruning", () => {
  const temp = withTempFile("state.sqlite");
  try {
    const store = new SqliteBrokerStateStore(temp.filePath);
    const exchangeKeep = makeExchange("exchange-keep", "worker-a");
    const exchangePrune = makeExchange("exchange-prune", "worker-a");
    const rootKeep = makeExchangeMessage("message-keep-root", "exchange-keep", "root");
    const rootPrune = makeExchangeMessage("message-prune-root", "exchange-prune", "root");
    store.save({
      ...emptySnapshot(),
      exchanges: [exchangeKeep, exchangePrune],
      exchangeMessages: [rootKeep, rootPrune],
    });

    const updatedExchange = {
      ...exchangeKeep,
      status: "running" as const,
      updatedAt: "2026-04-27T00:03:00.000Z",
    };
    const threadMessage = makeExchangeMessage(
      "message-keep-thread",
      "exchange-keep",
      "thread",
      "message-keep-root",
      "2026-04-27T00:03:00.000Z",
    );
    store.save(
      {
        ...emptySnapshot(),
        exchanges: [updatedExchange],
        exchangeMessages: [rootKeep, threadMessage],
      },
      {
        hotExchanges: [updatedExchange],
        hotExchangeMessages: [threadMessage],
      },
    );

    assert.deepEqual(store.readHotExchanges().map((exchange) => exchange.id), ["exchange-keep"]);
    assert.deepEqual(store.readHotExchangeMessages({ exchangeId: "exchange-keep" }).map((message) => message.id), [
      "message-keep-root",
      "message-keep-thread",
    ]);
    assert.equal(store.readHotEntityMirrorStatus().ok, true);
    store.close();
  } finally {
    temp.cleanup();
  }
});

test("SqliteBrokerStateStore supports proposal artifact and validation hot-table upserts and hinted pruning", () => {
  const temp = withTempFile("state.sqlite");
  try {
    const store = new SqliteBrokerStateStore(temp.filePath);
    const proposalKeep = makeProposal("proposal-keep", "submitted", "worker-a");
    const proposalPrune = makeProposal("proposal-prune", "rejected", "worker-a");
    const artifactKeep = makeArtifact("artifact-keep", "proposal-keep");
    const artifactPrune = makeArtifact("artifact-prune", "proposal-prune");
    const validationKeep = makeValidation("validation-keep", "proposal-keep");
    const validationPrune = makeValidation("validation-prune", "proposal-prune");
    store.save({
      ...emptySnapshot(),
      proposals: [proposalKeep, proposalPrune],
      artifacts: [artifactKeep, artifactPrune],
      validations: [validationKeep, validationPrune],
    });

    const updatedProposal = {
      ...proposalKeep,
      status: "validated" as const,
      artifactIds: [artifactKeep.id],
      updatedAt: "2026-04-27T00:03:00.000Z",
    };
    const updatedArtifact = {
      ...artifactKeep,
      summary: "kept artifact",
    };
    const updatedValidation = {
      ...validationKeep,
      verdict: "pass" as const,
    };
    store.save(
      {
        ...emptySnapshot(),
        proposals: [updatedProposal],
        artifacts: [updatedArtifact],
        validations: [updatedValidation],
      },
      {
        hotProposals: [updatedProposal],
        hotArtifacts: [updatedArtifact],
        hotValidations: [updatedValidation],
      },
    );

    assert.deepEqual(store.readHotProposals().map((proposal) => [proposal.id, proposal.status]), [["proposal-keep", "validated"]]);
    assert.deepEqual(store.readHotArtifacts().map((artifact) => [artifact.id, artifact.summary]), [["artifact-keep", "kept artifact"]]);
    assert.deepEqual(store.readHotValidations().map((validation) => [validation.id, validation.verdict]), [["validation-keep", "pass"]]);
    assert.equal(store.readHotEntityMirrorStatus().ok, true);
    store.close();
  } finally {
    temp.cleanup();
  }
});

test("SqliteBrokerStateStore supports tombstone hot-table reads and hinted pruning", () => {
  const temp = withTempFile("state.sqlite");
  try {
    const store = new SqliteBrokerStateStore(temp.filePath);
    const keep = makeTombstone("task-keep", "failed", "2026-04-27T00:03:00.000Z");
    const prune = makeTombstone("task-prune", "canceled", "2026-04-27T00:01:00.000Z");
    store.save({
      ...emptySnapshot(),
      tombstones: [keep, prune],
    });

    assert.deepEqual(store.readHotTombstones().map((tombstone) => tombstone.taskId), ["task-keep", "task-prune"]);
    assert.deepEqual(store.readHotTombstones({ tombstoneReason: "failed" }).map((tombstone) => tombstone.taskId), ["task-keep"]);
    assert.deepEqual(store.readHotTombstones({ since: "2026-04-27T00:02:00.000Z" }).map((tombstone) => tombstone.taskId), ["task-keep"]);

    const updated = { ...keep, durationMs: 180_000, tombstonedAt: "2026-04-27T00:04:00.000Z" };
    store.save(
      {
        ...emptySnapshot(),
        tombstones: [updated],
      },
      {
        hotTombstones: [updated],
      },
    );

    assert.deepEqual(store.readHotTombstones().map((tombstone) => [tombstone.taskId, tombstone.durationMs]), [["task-keep", 180_000]]);
    assert.equal(store.readHotEntityMirrorStatus().ok, true);
    store.close();
  } finally {
    temp.cleanup();
  }
});

test("SqliteBrokerStateStore migrates v2 task hot table with task origin column", () => {
  const temp = withTempFile("state.sqlite");
  try {
    const db = new DatabaseSync(temp.filePath);
    db.exec(`
      CREATE TABLE broker_tasks (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        intent TEXT NOT NULL,
        target_node_id TEXT NOT NULL,
        assigned_worker_id TEXT,
        updated_at TEXT NOT NULL,
        payload TEXT NOT NULL
      );
    `);
    db.close();

    const store = new SqliteBrokerStateStore(temp.filePath);
    const snapshot: BrokerSnapshot = {
      ...emptySnapshot(),
      tasks: [makeTask("task-migrated", "queued", "worker-a")],
    };
    store.save(snapshot);
    assert.deepEqual(
      store.readHotTasks({ taskOrigin: "api", targetNodeId: "worker-a" }).map((task) => task.id),
      ["task-migrated"],
    );
    assert.equal(store.getPersistenceInfo().schemaVersion, 11);
    store.close();
  } finally {
    temp.cleanup();
  }
});

test("SqliteBrokerStateStore accepts operator-origin hot task payloads", () => {
  const temp = withTempFile("state.sqlite");
  try {
    const store = new SqliteBrokerStateStore(temp.filePath);
    const operatorTask: BrokerSnapshot["tasks"][number] = {
      ...makeTask("task-operator", "queued", "worker-a"),
      taskOrigin: "operator",
    };
    store.save({
      ...emptySnapshot(),
      tasks: [operatorTask],
    });
    store.close();

    const reloaded = new SqliteBrokerStateStore(temp.filePath);
    assert.deepEqual(reloaded.readHotTasks({ taskOrigin: "operator" }).map((task) => task.id), ["task-operator"]);
    assert.equal(reloaded.load().tasks[0]!.taskOrigin, "operator");
    reloaded.close();
  } finally {
    temp.cleanup();
  }
});

