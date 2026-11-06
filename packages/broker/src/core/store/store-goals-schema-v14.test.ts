/**
 * SQLite schema 14 (#2499 slice 1): goal table, budget/spend tables, and the
 * `broker_tasks.goal_id` column. Pins the in-place v13 -> v14 upgrade (every
 * task row survives) and the store-level goal persistence surface.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { BrokerError } from "../broker-error.js";
import { CURRENT_BROKER_STATE_VERSION, SqliteBrokerStateStore } from "./store.js";
import type { GoalRecord, TaskRecord } from "../types.js";

const SCHEMA_14_TABLES = ["broker_goals", "broker_budgets", "broker_spend_events"] as const;
const SCHEMA_14_INDEXES = [
  "broker_goals_status_updated_idx",
  "broker_goals_updated_id_idx",
  "broker_budgets_scope_idx",
  "broker_spend_events_period_agent_idx",
  "broker_spend_events_period_lane_idx",
  "broker_spend_events_period_goal_idx",
  "broker_tasks_goal_status_idx",
] as const;

function tempDb(): { dbFile: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "a2a-broker-schema-v14-"));
  return { dbFile: join(dir, "state.sqlite"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function task(id: string, status: TaskRecord["status"], overrides: Partial<TaskRecord> = {}): TaskRecord {
  const at = `2026-11-0${(Number(id.replace(/\D/g, "")) % 9) + 1}T00:00:00.000Z`;
  return {
    id,
    intent: "analyze",
    requester: { id: "hub", kind: "node", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    targetNodeId: "worker-a",
    assignedWorkerId: "worker-a",
    payload: { note: id },
    status,
    createdAt: at,
    updatedAt: at,
    taskOrigin: "api",
    ...overrides,
  };
}

function goal(id: string, status: GoalRecord["status"], updatedAt: string): GoalRecord {
  return {
    id,
    title: `Goal ${id}`,
    objective: `Objective ${id}`,
    requester: { id: "operator", kind: "user", role: "operator" },
    status,
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt,
    taskAttachments: [],
    history: [
      { id: `${id}-e1`, goalId: id, to: "pursuing", reason: "operator_requested", createdAt: "2026-11-01T00:00:00.000Z" },
    ],
  };
}

function names(db: DatabaseSync, type: "table" | "index"): Set<string> {
  return new Set(
    (db.prepare("SELECT name FROM sqlite_master WHERE type = ?").all(type) as Array<{ name: string }>).map((row) => row.name),
  );
}

function columns(db: DatabaseSync, table: string): Set<string> {
  return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name));
}

function readSchemaVersion(db: DatabaseSync): string | undefined {
  return (db.prepare("SELECT value FROM broker_metadata WHERE key = 'schema_version'").get() as { value?: string } | undefined)?.value;
}

/**
 * Turn a freshly written store into a faithful schema-13 database: schema 14
 * is additive only, so removing exactly its additions yields the v13 shape.
 */
function downgradeToSchema13(dbFile: string): void {
  const db = new DatabaseSync(dbFile);
  try {
    db.exec("DROP INDEX broker_tasks_goal_status_idx");
    db.exec("ALTER TABLE broker_tasks DROP COLUMN goal_id");
    for (const table of SCHEMA_14_TABLES) db.exec(`DROP TABLE ${table}`);
    db.prepare("UPDATE broker_metadata SET value = '13' WHERE key = 'schema_version'").run();
  } finally {
    db.close();
  }
}

test("fresh store creates the schema 14 tables, goal_id column and indexes", () => {
  const { dbFile, cleanup } = tempDb();
  try {
    const store = new SqliteBrokerStateStore(dbFile);
    assert.equal(store.getPersistenceInfo().schemaVersion, 14);
    assert.equal(store.getPersistenceInfo().stateVersion, CURRENT_BROKER_STATE_VERSION, "snapshot state version is unchanged");
    store.close();
    const db = new DatabaseSync(dbFile);
    try {
      assert.equal(readSchemaVersion(db), "14");
      const tables = names(db, "table");
      for (const table of SCHEMA_14_TABLES) assert.ok(tables.has(table), `missing table ${table}`);
      const indexes = names(db, "index");
      for (const index of SCHEMA_14_INDEXES) assert.ok(indexes.has(index), `missing index ${index}`);
      assert.ok(columns(db, "broker_tasks").has("goal_id"));
      assert.deepEqual(
        [...columns(db, "broker_budgets")],
        ["id", "scope_type", "scope_id", "period", "limit_usd", "limit_tokens", "warn_pct", "enforce", "created_by", "created_at"],
      );
      assert.deepEqual(
        [...columns(db, "broker_spend_events")],
        ["task_id", "recorded_at", "period_key", "agent_id", "lane", "goal_id", "cost_usd", "input_tokens", "output_tokens", "cost_known"],
      );
      // Decision 1: a budget row must set at least one limit.
      assert.throws(
        () => db.prepare(
          "INSERT INTO broker_budgets (id, scope_type, scope_id, period, created_by, created_at) VALUES ('b1', 'agent', 'w', 'month', 'op', '2026-11-01T00:00:00.000Z')",
        ).run(),
        /CHECK constraint failed/,
      );
      // The spend ledger is keyed by task id: a second row for a task is refused.
      const insertSpend = db.prepare(
        "INSERT INTO broker_spend_events (task_id, recorded_at, period_key) VALUES ('t1', '2026-11-01T00:00:00.000Z', '2026-11')",
      );
      insertSpend.run();
      assert.throws(() => insertSpend.run(), /UNIQUE constraint failed/);
    } finally {
      db.close();
    }
  } finally {
    cleanup();
  }
});

test("a schema 13 store opens, upgrades to 14 in place, and keeps every task row", () => {
  const { dbFile, cleanup } = tempDb();
  try {
    const seed = new SqliteBrokerStateStore(dbFile);
    const tasks = [
      task("task-1", "queued"),
      task("task-2", "running", { claimedBy: "worker-a" }),
      task("task-3", "succeeded", { completedAt: "2026-11-03T01:00:00.000Z", result: { summary: "done" } }),
      task("task-4", "failed", { error: { message: "boom" } }),
      task("task-5", "blocked", { policyContext: { requiresApproval: true } }),
    ];
    seed.upsertHotTasks(tasks);
    seed.close();
    downgradeToSchema13(dbFile);

    const before = new DatabaseSync(dbFile);
    let v13Rows: Array<{ id: string; status: string; payload: string }>;
    try {
      assert.equal(readSchemaVersion(before), "13");
      assert.equal(columns(before, "broker_tasks").has("goal_id"), false);
      assert.equal(names(before, "table").has("broker_goals"), false);
      v13Rows = before.prepare("SELECT id, status, payload FROM broker_tasks ORDER BY id").all() as typeof v13Rows;
    } finally {
      before.close();
    }
    assert.equal(v13Rows.length, tasks.length);

    const upgraded = new SqliteBrokerStateStore(dbFile);
    try {
      assert.equal(upgraded.getPersistenceInfo().schemaVersion, 14);
      const reread = upgraded.readHotTasks().sort((a, b) => a.id.localeCompare(b.id));
      assert.deepEqual(reread.map((row) => row.id), tasks.map((row) => row.id));
      assert.deepEqual(reread, [...tasks].sort((a, b) => a.id.localeCompare(b.id)));
      // Pre-existing rows have no goal link.
      assert.deepEqual(upgraded.countGoalTasksByStatus("anything"), {});
    } finally {
      upgraded.close();
    }

    const after = new DatabaseSync(dbFile);
    try {
      assert.equal(readSchemaVersion(after), "14");
      const rows = after.prepare("SELECT id, status, payload, goal_id FROM broker_tasks ORDER BY id").all() as Array<{
        id: string;
        status: string;
        payload: string;
        goal_id: string | null;
      }>;
      assert.deepEqual(
        rows.map(({ id, status, payload }) => ({ id, status, payload })),
        v13Rows.map(({ id, status, payload }) => ({ id, status, payload })),
        "every v13 task row survives byte-for-byte",
      );
      assert.ok(rows.every((row) => row.goal_id === null));
      const tables = names(after, "table");
      for (const table of SCHEMA_14_TABLES) assert.ok(tables.has(table), `missing table ${table} after upgrade`);
      const indexes = names(after, "index");
      for (const index of SCHEMA_14_INDEXES) assert.ok(indexes.has(index), `missing index ${index} after upgrade`);
    } finally {
      after.close();
    }

    // Reopening an already-upgraded store is a no-op upgrade.
    const reopened = new SqliteBrokerStateStore(dbFile);
    assert.equal(reopened.readHotTasks().length, tasks.length);
    reopened.close();
  } finally {
    cleanup();
  }
});

test("goal rows: create-only insert, read, list (newest first, status filter, limit), invalid rows skipped", () => {
  const { dbFile, cleanup } = tempDb();
  const store = new SqliteBrokerStateStore(dbFile);
  try {
    store.insertGoal(goal("goal-a", "pursuing", "2026-11-01T00:00:00.000Z"));
    store.insertGoal(goal("goal-b", "paused", "2026-11-03T00:00:00.000Z"));
    store.insertGoal(goal("goal-c", "pursuing", "2026-11-02T00:00:00.000Z"));

    assert.equal(store.readGoal("goal-a")?.title, "Goal goal-a");
    assert.equal(store.readGoal("missing"), undefined);
    assert.deepEqual(store.listGoals().map((row) => row.id), ["goal-b", "goal-c", "goal-a"]);
    assert.deepEqual(store.listGoals({ status: "pursuing" }).map((row) => row.id), ["goal-c", "goal-a"]);
    assert.deepEqual(store.listGoals({ limit: 1 }).map((row) => row.id), ["goal-b"]);

    // Insert is create-only: an existing id is a 409-class conflict and the
    // stored row (record and indexed status) is left untouched.
    assert.throws(
      () => store.insertGoal(goal("goal-a", "achieved", "2026-11-04T00:00:00.000Z")),
      (error: unknown) =>
        error instanceof BrokerError &&
        error.code === "invalid_transition" &&
        /goal 'goal-a' already exists/.test(error.message) &&
        (error.details as { goalId?: string } | undefined)?.goalId === "goal-a",
    );
    assert.equal(store.readGoal("goal-a")?.status, "pursuing");
    assert.equal(store.readGoal("goal-a")?.updatedAt, "2026-11-01T00:00:00.000Z");
    assert.deepEqual(store.listGoals({ status: "pursuing" }).map((row) => row.id), ["goal-c", "goal-a"]);

    // A row that does not parse as a GoalRecord is skipped, never thrown.
    const db = new DatabaseSync(dbFile);
    try {
      db.prepare("INSERT INTO broker_goals (id, status, created_at, updated_at, payload) VALUES (?, ?, ?, ?, ?)")
        .run("goal-bad", "pursuing", "2026-11-05T00:00:00.000Z", "2026-11-05T00:00:00.000Z", JSON.stringify({ id: "goal-bad", status: "active" }));
    } finally {
      db.close();
    }
    assert.equal(store.readGoal("goal-bad"), undefined);
    assert.deepEqual(store.listGoals().map((row) => row.id), ["goal-b", "goal-c", "goal-a"]);
  } finally {
    store.close();
    cleanup();
  }
});

test("task goal_id column mirrors TaskRecord.goalId and feeds per-status counts", () => {
  const { dbFile, cleanup } = tempDb();
  const store = new SqliteBrokerStateStore(dbFile);
  try {
    store.upsertHotTasks([
      task("task-1", "queued", { goalId: "goal-x" }),
      task("task-2", "queued", { goalId: "goal-x" }),
      task("task-3", "succeeded", { goalId: "goal-x" }),
      task("task-4", "queued", { goalId: "goal-y" }),
      task("task-5", "queued"),
    ]);
    assert.deepEqual(store.countGoalTasksByStatus("goal-x"), { queued: 2, succeeded: 1 });
    assert.deepEqual(store.countGoalTasksByStatus("goal-y"), { queued: 1 });
    assert.deepEqual(store.countGoalTasksByStatus("goal-z"), {});

    // A status transition rewrites the column with the row.
    store.upsertHotTasks([task("task-1", "running", { goalId: "goal-x" })]);
    assert.deepEqual(store.countGoalTasksByStatus("goal-x"), { running: 1, queued: 1, succeeded: 1 });

    const db = new DatabaseSync(dbFile);
    try {
      const row = db.prepare("SELECT goal_id, payload FROM broker_tasks WHERE id = 'task-5'").get() as { goal_id: string | null; payload: string };
      assert.equal(row.goal_id, null);
      assert.equal("goalId" in JSON.parse(row.payload), false);
      const plan = db.prepare("EXPLAIN QUERY PLAN SELECT status, COUNT(*) FROM broker_tasks WHERE goal_id = ? GROUP BY status").all("goal-x") as Array<{ detail: string }>;
      assert.ok(plan.some((step) => /broker_tasks_goal_status_idx/.test(step.detail)), "goal count uses the goal_id index, not a payload scan");
    } finally {
      db.close();
    }
  } finally {
    store.close();
    cleanup();
  }
});

function assertFullSchema14(dbFile: string): void {
  const db = new DatabaseSync(dbFile);
  try {
    assert.equal(readSchemaVersion(db), "14");
    const tables = names(db, "table");
    for (const table of SCHEMA_14_TABLES) assert.ok(tables.has(table), `missing table ${table}`);
    const indexes = names(db, "index");
    for (const index of SCHEMA_14_INDEXES) assert.ok(indexes.has(index), `missing index ${index}`);
    assert.ok(columns(db, "broker_tasks").has("goal_id"), "missing broker_tasks.goal_id");
  } finally {
    db.close();
  }
}

test("a partially applied v14 upgrade (goal_id column present, tables and indexes missing, schema_version 13) re-runs to the full v14 shape", () => {
  const { dbFile, cleanup } = tempDb();
  try {
    const seed = new SqliteBrokerStateStore(dbFile);
    seed.upsertHotTasks([task("task-1", "queued", { goalId: "goal-x" }), task("task-2", "succeeded")]);
    seed.close();
    // Simulate an interrupted upgrade: the column (and its value) landed, the
    // tables and the goal index did not, and the version was never published.
    const db = new DatabaseSync(dbFile);
    try {
      db.exec("DROP INDEX broker_tasks_goal_status_idx");
      for (const table of SCHEMA_14_TABLES) db.exec(`DROP TABLE ${table}`);
      db.prepare("UPDATE broker_metadata SET value = '13' WHERE key = 'schema_version'").run();
      assert.ok(columns(db, "broker_tasks").has("goal_id"));
    } finally {
      db.close();
    }

    const reopened = new SqliteBrokerStateStore(dbFile);
    try {
      assert.equal(reopened.getPersistenceInfo().schemaVersion, 14);
      assert.equal(reopened.readHotTasks().length, 2);
      // ensureColumn is a no-op on the existing column: its values survive.
      assert.deepEqual(reopened.countGoalTasksByStatus("goal-x"), { queued: 1 });
      reopened.insertGoal(goal("goal-x", "pursuing", "2026-11-01T00:00:00.000Z"));
      assert.equal(reopened.readGoal("goal-x")?.id, "goal-x");
    } finally {
      reopened.close();
    }
    assertFullSchema14(dbFile);
  } finally {
    cleanup();
  }
});

test("a partially applied v14 upgrade (tables and column present, indexes missing, schema_version 13) re-runs to the full v14 shape", () => {
  const { dbFile, cleanup } = tempDb();
  try {
    const seed = new SqliteBrokerStateStore(dbFile);
    seed.insertGoal(goal("goal-kept", "pursuing", "2026-11-01T00:00:00.000Z"));
    seed.upsertHotTasks([task("task-1", "queued", { goalId: "goal-kept" })]);
    seed.close();
    const db = new DatabaseSync(dbFile);
    try {
      db.exec("DROP INDEX broker_goals_status_updated_idx");
      db.exec("DROP INDEX broker_spend_events_period_lane_idx");
      db.exec("DROP INDEX broker_tasks_goal_status_idx");
      db.prepare("UPDATE broker_metadata SET value = '13' WHERE key = 'schema_version'").run();
    } finally {
      db.close();
    }

    const reopened = new SqliteBrokerStateStore(dbFile);
    try {
      assert.equal(reopened.getPersistenceInfo().schemaVersion, 14);
      // Existing goal rows and task links are untouched by the re-run.
      assert.equal(reopened.readGoal("goal-kept")?.status, "pursuing");
      assert.deepEqual(reopened.countGoalTasksByStatus("goal-kept"), { queued: 1 });
    } finally {
      reopened.close();
    }
    assertFullSchema14(dbFile);
  } finally {
    cleanup();
  }
});

test("a store whose schema_version is newer than this binary (15 > 14) is refused with schema_version_newer", () => {
  const { dbFile, cleanup } = tempDb();
  try {
    const seed = new SqliteBrokerStateStore(dbFile);
    seed.insertGoal(goal("goal-future", "pursuing", "2026-11-01T00:00:00.000Z"));
    seed.close();
    const db = new DatabaseSync(dbFile);
    try {
      db.prepare("UPDATE broker_metadata SET value = '15' WHERE key = 'schema_version'").run();
    } finally {
      db.close();
    }

    assert.throws(
      () => new SqliteBrokerStateStore(dbFile),
      /shared-state startup check failed: schema_version_newer/,
    );

    // Fail closed before initialization: nothing was rewritten.
    const after = new DatabaseSync(dbFile);
    try {
      assert.equal(readSchemaVersion(after), "15");
      assert.equal((after.prepare("SELECT COUNT(*) AS n FROM broker_goals").get() as { n: number }).n, 1);
    } finally {
      after.close();
    }
  } finally {
    cleanup();
  }
});
