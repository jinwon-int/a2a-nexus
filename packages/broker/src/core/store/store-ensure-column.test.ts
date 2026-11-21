/**
 * #2573: `ensureColumn` raced another connection opening the same fresh
 * database ("duplicate column name: goal_id" from the worker-thread writer).
 * These tests replay that interleaving deterministically: the first
 * `PRAGMA table_info` read is the stale view taken before the other writer's
 * ALTER, and the ALTER then runs against a table that already has the column.
 */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { ensureColumnWith, isDuplicateColumnError, type EnsureColumnOps } from "./store-ensure-column.js";

function columnsOf(db: DatabaseSync, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name);
}

function opsFor(db: DatabaseSync, table: string, staleReads = 0): EnsureColumnOps & { alters: string[] } {
  let reads = 0;
  const alters: string[] = [];
  return {
    alters,
    listColumns: () => (reads++ < staleReads ? columnsOf(db, table).filter((name) => name !== "goal_id") : columnsOf(db, table)),
    exec: (sql) => {
      alters.push(sql);
      db.exec(sql);
    },
  };
}

test("#2573 ensureColumnWith adds a missing column", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE broker_tasks (id TEXT PRIMARY KEY)");
  const ops = opsFor(db, "broker_tasks");
  assert.equal(ensureColumnWith(ops, "broker_tasks", "goal_id", "TEXT"), "added");
  assert.deepEqual(columnsOf(db, "broker_tasks"), ["id", "goal_id"]);
  assert.equal(ops.alters.length, 1);
  db.close();
});

test("#2573 ensureColumnWith is a no-op when the column is already there", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE broker_tasks (id TEXT PRIMARY KEY, goal_id TEXT)");
  const ops = opsFor(db, "broker_tasks");
  assert.equal(ensureColumnWith(ops, "broker_tasks", "goal_id", "TEXT"), "present");
  assert.equal(ops.alters.length, 0);
  db.close();
});

test("#2573 ensureColumnWith accepts a column another writer added between the check and the ALTER", () => {
  const db = new DatabaseSync(":memory:");
  // The other connection already won: the column exists, but our check saw the
  // table before its ALTER landed.
  db.exec("CREATE TABLE broker_tasks (id TEXT PRIMARY KEY, goal_id TEXT)");
  const ops = opsFor(db, "broker_tasks", 1);
  assert.equal(ensureColumnWith(ops, "broker_tasks", "goal_id", "TEXT"), "added-concurrently");
  assert.equal(ops.alters.length, 1, "the ALTER was attempted and lost the race");
  assert.deepEqual(columnsOf(db, "broker_tasks"), ["id", "goal_id"]);
  db.close();
});

test("#2573 the same interleaving without the fix fails with duplicate column name (reproduction)", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE broker_tasks (id TEXT PRIMARY KEY, goal_id TEXT)");
  assert.throws(
    () => db.exec("ALTER TABLE broker_tasks ADD COLUMN goal_id TEXT"),
    (error: unknown) => isDuplicateColumnError(error),
  );
  db.close();
});

test("#2573 ensureColumnWith rethrows a duplicate-column error when the column is still absent", () => {
  const ops: EnsureColumnOps = {
    listColumns: () => ["id"],
    exec: () => {
      throw new Error("duplicate column name: goal_id");
    },
  };
  assert.throws(() => ensureColumnWith(ops, "broker_tasks", "goal_id", "TEXT"), /duplicate column name/);
});

test("#2573 ensureColumnWith rethrows any other ALTER failure unchanged", () => {
  const db = new DatabaseSync(":memory:");
  const ops = opsFor(db, "missing_table");
  assert.throws(() => ensureColumnWith(ops, "missing_table", "goal_id", "TEXT"), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /no such table/);
    assert.equal(isDuplicateColumnError(error), false);
    return true;
  });
  db.close();
});
