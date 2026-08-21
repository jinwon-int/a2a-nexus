/**
 * Tests for the V1 SQLite schema slice.
 *
 * These exercise schema creation, idempotent reapplication, fail-closed
 * version handling, and isolation from the legacy `broker_*` store. They
 * assert no adapter behavior, because this slice implements none.
 *
 * Every database is a temporary file removed at the end of its test. Nothing
 * here touches a configured or production database path.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  SHARED_STATE_SQLITE_SCHEMA_ERROR_CODES_V1,
  SHARED_STATE_SQLITE_SCHEMA_V1,
  applySharedStateSqliteSchemaV1,
  readSharedStateSqliteSchemaV1,
} from "./shared-state-sqlite-schema-v1.js";
import { SHARED_STATE_STORAGE_V1_VALUES as V } from "./shared-state-storage-contract-v1.js";

function withTemporaryDatabase<T>(run: (db: DatabaseSync) => T): T {
  const directory = mkdtempSync(join(tmpdir(), "shared-state-schema-v1-"));
  const db = new DatabaseSync(join(directory, "v1.db"));
  try {
    return run(db);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

function tableNames(db: DatabaseSync): string[] {
  return (
    db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table'
         ORDER BY name`,
      )
      .all() as { name: string }[]
  ).map((row) => row.name);
}

test("creates exactly the declared V1 tables and records its version", () => {
  withTemporaryDatabase((db) => {
    const applied = applySharedStateSqliteSchemaV1(db);
    assert.equal(applied.ok, true);
    if (!applied.ok) return;

    assert.equal(applied.value.created, true);
    assert.equal(
      applied.value.schemaVersion,
      SHARED_STATE_SQLITE_SCHEMA_V1.schemaVersion,
    );
    assert.equal(applied.value.contractVersion, V.versions.contract);
    assert.equal(
      applied.value.tableCount,
      SHARED_STATE_SQLITE_SCHEMA_V1.tables.length,
    );

    // No table beyond the declared set, and every declared table present.
    const present = tableNames(db).filter(
      (name) => !name.startsWith("sqlite_"),
    );
    assert.deepEqual(
      present.sort(),
      [...SHARED_STATE_SQLITE_SCHEMA_V1.tables].sort(),
    );
  });
});

test("reapplying the schema is a no-op", () => {
  withTemporaryDatabase((db) => {
    const first = applySharedStateSqliteSchemaV1(db);
    assert.equal(first.ok, true);
    if (!first.ok) return;
    assert.equal(first.value.created, true);
    const firstTables = tableNames(db);

    const second = applySharedStateSqliteSchemaV1(db);
    assert.equal(second.ok, true);
    if (!second.ok) return;
    // Already existed, so this run created nothing.
    assert.equal(second.value.created, false);
    assert.deepEqual(tableNames(db), firstTables);

    const third = applySharedStateSqliteSchemaV1(db);
    assert.equal(third.ok, true);
    assert.deepEqual(tableNames(db), firstTables);
  });
});

test("reads back the applied state without creating anything", () => {
  withTemporaryDatabase((db) => {
    const absent = readSharedStateSqliteSchemaV1(db);
    assert.equal(absent.ok, false);
    if (absent.ok) return;
    assert.equal(absent.error.code, "schema_not_applied");
    // The failed read created nothing.
    assert.deepEqual(
      tableNames(db).filter((name) => !name.startsWith("sqlite_")),
      [],
    );

    assert.equal(applySharedStateSqliteSchemaV1(db).ok, true);

    const present = readSharedStateSqliteSchemaV1(db);
    assert.equal(present.ok, true);
    if (!present.ok) return;
    assert.equal(present.value.created, false);
    assert.equal(
      present.value.tableCount,
      SHARED_STATE_SQLITE_SCHEMA_V1.tables.length,
    );
  });
});

test("fails closed on a foreign schema or contract version", () => {
  withTemporaryDatabase((db) => {
    assert.equal(applySharedStateSqliteSchemaV1(db).ok, true);
    const update = db.prepare(
      `UPDATE ${SHARED_STATE_SQLITE_SCHEMA_V1.metaTable}
       SET value = ? WHERE key = ?`,
    );

    // A future schema version is rejected, not migrated: V1 defines no
    // upgrade path, so adapting silently would be the permissive answer.
    update.run(
      String(SHARED_STATE_SQLITE_SCHEMA_V1.schemaVersion + 1),
      "schema_version",
    );
    const bumped = applySharedStateSqliteSchemaV1(db);
    assert.equal(bumped.ok, false);
    if (bumped.ok) return;
    assert.equal(bumped.error.code, "schema_version_mismatch");
    assert.equal(
      (readSharedStateSqliteSchemaV1(db) as { error: { code: string } })
        .error.code,
      "schema_version_mismatch",
    );

    update.run(
      String(SHARED_STATE_SQLITE_SCHEMA_V1.schemaVersion),
      "schema_version",
    );
    update.run("a2a.shared-state.storage/v0", "contract_version");
    const foreignContract = applySharedStateSqliteSchemaV1(db);
    assert.equal(foreignContract.ok, false);
    if (foreignContract.ok) return;
    assert.equal(foreignContract.error.code, "contract_version_mismatch");
  });
});

test("detects a dropped table instead of reporting success", () => {
  withTemporaryDatabase((db) => {
    assert.equal(applySharedStateSqliteSchemaV1(db).ok, true);
    db.exec("DROP TABLE shared_state_lease");

    // A read must not claim the schema is intact.
    const read = readSharedStateSqliteSchemaV1(db);
    assert.equal(read.ok, false);
    if (read.ok) return;
    assert.equal(read.error.code, "schema_table_missing");

    // Applying again repairs it, because every statement is IF NOT EXISTS.
    const repaired = applySharedStateSqliteSchemaV1(db);
    assert.equal(repaired.ok, true);
    if (!repaired.ok) return;
    assert.equal(
      repaired.value.tableCount,
      SHARED_STATE_SQLITE_SCHEMA_V1.tables.length,
    );
  });
});

test("stays isolated from a legacy broker database in the same directory", () => {
  const directory = mkdtempSync(join(tmpdir(), "shared-state-schema-v1-iso-"));
  const legacyPath = join(directory, "legacy.db");
  const v1Path = join(directory, "v1.db");
  const legacy = new DatabaseSync(legacyPath);
  const v1 = new DatabaseSync(v1Path);
  try {
    legacy.exec("CREATE TABLE broker_tasks (id TEXT PRIMARY KEY)");
    legacy.prepare("INSERT INTO broker_tasks (id) VALUES (?)").run("t-1");

    assert.equal(applySharedStateSqliteSchemaV1(v1).ok, true);

    // The V1 file carries no legacy table and the legacy file no V1 table.
    assert.equal(tableNames(v1).includes("broker_tasks"), false);
    assert.equal(tableNames(legacy).includes("shared_state_meta"), false);
    assert.deepEqual(
      tableNames(legacy).filter((name) => !name.startsWith("sqlite_")),
      ["broker_tasks"],
    );

    // Separate files mean separate write transactions rather than the
    // `database is locked` a shared file produces at busy_timeout=0.
    legacy.exec("BEGIN IMMEDIATE");
    v1.exec("BEGIN IMMEDIATE");
    v1.exec("COMMIT");
    legacy.exec("COMMIT");

    // The legacy row is untouched by anything this slice did. Compare the
    // column values: `node:sqlite` returns null-prototype rows.
    assert.deepEqual(
      (legacy.prepare("SELECT id FROM broker_tasks").all() as {
        id: string;
      }[]).map((row) => row.id),
      ["t-1"],
    );
  } finally {
    legacy.close();
    v1.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("declares no adapter behavior and pins its closed vocabulary", () => {
  // The slice ships schema only: two functions, no command surface.
  assert.equal(
    typeof applySharedStateSqliteSchemaV1,
    "function",
  );
  assert.equal(typeof readSharedStateSqliteSchemaV1, "function");

  assert.equal(
    SHARED_STATE_SQLITE_SCHEMA_V1.contractVersion,
    V.versions.contract,
  );
  // The V1 schema version is deliberately its own axis, not the legacy
  // store's SQLITE_SCHEMA_VERSION.
  assert.equal(SHARED_STATE_SQLITE_SCHEMA_V1.schemaVersion, 1);
  assert.equal(
    new Set(SHARED_STATE_SQLITE_SCHEMA_V1.tables).size,
    SHARED_STATE_SQLITE_SCHEMA_V1.tables.length,
  );
  for (const table of SHARED_STATE_SQLITE_SCHEMA_V1.tables) {
    assert.equal(table.startsWith("shared_state_"), true);
  }
  assert.equal(
    new Set(SHARED_STATE_SQLITE_SCHEMA_ERROR_CODES_V1).size,
    SHARED_STATE_SQLITE_SCHEMA_ERROR_CODES_V1.length,
  );
  // `schema_version_mismatch` is reused from the closed lifecycle and
  // readiness vocabulary rather than invented here.
  assert.equal(
    V.lifecycleReasonCodes.includes("schema_version_mismatch"),
    true,
  );
  assert.equal(
    V.readinessReasonCodes.includes("schema_version_mismatch"),
    true,
  );
});
