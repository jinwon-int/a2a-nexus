import assert from "node:assert/strict";
import test from "node:test";

import { DatabaseSync } from "node:sqlite";

import { SqliteBrokerStateStore, type BrokerSnapshot } from "./store.js";
import { buildBrokerCleanupPlan, executeBrokerCleanupPlan } from "./broker-cleanup.js";
import { withTempFile, makeTask, makeWorker, makeAuditEvent } from "./store-test-helpers.js";

const OLD = "2026-01-01T00:00:00.000Z";

/**
 * Seed a store whose hot tables carry terminal rows old enough to be prune
 * candidates, then overwrite the canonical snapshot row with a payload larger
 * than maxBytes — the state observed live on T2: hot tables authoritative, a
 * stale oversized canonical blob that normal operation never rewrites.
 */
function seedWithOversizedCanonicalSnapshot(filePath: string, maxBytes: number) {
  const seed = new SqliteBrokerStateStore(filePath, { loadSource: "hot-tables" });
  const tasks: BrokerSnapshot["tasks"] = Array.from({ length: 40 }, (_, i) => ({
    ...makeTask(`task-${i}`, "succeeded", "worker-0"),
    createdAt: OLD,
    updatedAt: OLD,
  }));
  const auditEvents = Array.from({ length: 20 }, (_, i) => makeAuditEvent(`audit-${i}`, "task.created", `task-${i % 40}`, OLD));
  seed.save({
    ...(seed.load()),
    tasks,
    auditEvents,
    workers: [makeWorker("worker-0")],
  } as BrokerSnapshot);
  seed.close();

  // Force the canonical row oversized, the way a long-running broker did.
  const raw = new DatabaseSync(filePath);
  const bloated = JSON.stringify({ padding: "x".repeat(maxBytes + 4096) });
  raw.prepare("INSERT INTO broker_snapshots (id, version, payload, updated_at) VALUES (1, 8, ?, ?) " +
    "ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at")
    .run(bloated, OLD);
  raw.close();
}

/**
 * #1776 regression. `syncCanonicalSnapshotWithHotRetentionPlans` used the
 * throwing snapshot reader, so on a live broker `executeBrokerCleanupPlan`
 * deleted the hot rows and then threw `broker snapshot exceeds max size` —
 * the one path able to repair an oversized canonical snapshot was the one path
 * blocked by it, and the prune was left half-applied.
 */
test("cleanup execution repairs an oversized canonical snapshot instead of dead-ending on it", () => {
  const temp = withTempFile("canonical-repair.db");
  const maxBytes = 64 * 1024;
  try {
    seedWithOversizedCanonicalSnapshot(temp.filePath, maxBytes);

    const store = new SqliteBrokerStateStore(temp.filePath, { loadSource: "hot-tables", maxBytes });
    try {
      const plan = buildBrokerCleanupPlan(store, { nowMs: Date.parse("2026-06-01T00:00:00.000Z"), maxTerminalTasks: 10 });
      const taskPlan = plan.tables.find((t) => t.table === "broker_tasks");
      assert.ok(taskPlan && taskPlan.pruneCount > 0, "fixture must produce real prune candidates");

      const result = executeBrokerCleanupPlan(store, plan, {
        approvalToken: plan.planId,
        confirmation: "APPLY_BROKER_CLEANUP_PLAN",
        backupProof: "test-backup",
      });

      // The sync no longer throws, and it repaired rather than skipped.
      assert.equal(result.canonicalSnapshotSync.synced, true);
      assert.equal(result.canonicalSnapshotSync.rebuiltFromHotTables, true);
      assert.match(String(result.canonicalSnapshotSync.reason), /canonical_snapshot_unreadable_too_large/);
      assert.equal(result.canonicalSnapshotSync.error, undefined);

      // The rows really were pruned, and the canonical row is readable again.
      const info = store.getPersistenceInfo();
      const taskMetrics = info.hotTableLoadMetrics?.tables?.["broker_tasks"];
      assert.ok(taskMetrics && taskMetrics.count < 40, "hot task rows should be pruned");
      assert.notEqual(info.hotEntityMirror?.canonicalSnapshot?.status, "unreadable");
    } finally {
      store.close();
    }
  } finally {
    temp.cleanup();
  }
});

/**
 * The repair rebuilds from hot tables, so it is only correct when the hot
 * tables are the source of truth. With a canonical load source the canonical
 * row may hold records the hot tables never had — fail closed and name it.
 */
test("an unreadable canonical snapshot is not rebuilt when the canonical row is the load source", () => {
  const temp = withTempFile("canonical-repair-guard.db");
  const maxBytes = 64 * 1024;
  try {
    seedWithOversizedCanonicalSnapshot(temp.filePath, maxBytes);

    const store = new SqliteBrokerStateStore(temp.filePath, { loadSource: "snapshot", maxBytes });
    try {
      const plan = buildBrokerCleanupPlan(store, { nowMs: Date.parse("2026-06-01T00:00:00.000Z"), maxTerminalTasks: 10 });
      const result = executeBrokerCleanupPlan(store, plan, {
        approvalToken: plan.planId,
        confirmation: "APPLY_BROKER_CLEANUP_PLAN",
        backupProof: "test-backup",
      });
      assert.equal(result.canonicalSnapshotSync.synced, false);
      assert.match(String(result.canonicalSnapshotSync.reason), /canonical_snapshot_unreadable_too_large/);
      assert.equal(result.canonicalSnapshotSync.rebuiltFromHotTables, undefined);
      // Still a structured result, not a thrown stack trace.
      assert.ok(Array.isArray(result.results));
    } finally {
      store.close();
    }
  } finally {
    temp.cleanup();
  }
});

test("an absent canonical snapshot is still reported as a non-failure", () => {
  const temp = withTempFile("canonical-absent.db");
  try {
    const store = new SqliteBrokerStateStore(temp.filePath, { loadSource: "hot-tables" });
    try {
      const tasks: BrokerSnapshot["tasks"] = Array.from({ length: 20 }, (_, i) => ({
        ...makeTask(`task-${i}`, "succeeded", "worker-0"),
        createdAt: OLD,
        updatedAt: OLD,
      }));
      store.save({ ...store.load(), tasks, workers: [makeWorker("worker-0")] } as BrokerSnapshot);

      const raw = new DatabaseSync(temp.filePath);
      raw.exec("DELETE FROM broker_snapshots;");
      raw.close();

      const plan = buildBrokerCleanupPlan(store, { nowMs: Date.parse("2026-06-01T00:00:00.000Z"), maxTerminalTasks: 5 });
      const result = executeBrokerCleanupPlan(store, plan, {
        approvalToken: plan.planId,
        confirmation: "APPLY_BROKER_CLEANUP_PLAN",
        backupProof: "test-backup",
      });
      assert.equal(result.canonicalSnapshotSync.synced, false);
      assert.equal(result.canonicalSnapshotSync.reason, "no_canonical_snapshot");
      assert.equal(result.canonicalSnapshotSync.error, undefined);
    } finally {
      store.close();
    }
  } finally {
    temp.cleanup();
  }
});
