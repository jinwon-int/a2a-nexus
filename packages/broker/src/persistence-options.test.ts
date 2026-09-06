import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_BROKER_PERSISTENCE_BACKEND,
  normalizePersistenceBackend,
  normalizeSqliteLoadSource,
} from "./persistence-options.js";

test("normalizePersistenceBackend accepts sqlite and keeps json-file opt-in (#819)", () => {
  assert.equal(normalizePersistenceBackend("sqlite"), "sqlite");
  assert.equal(normalizePersistenceBackend("SQLITE"), "sqlite");
  assert.equal(normalizePersistenceBackend("  sqlite  "), "sqlite");

  assert.equal(normalizePersistenceBackend("json-file"), "json-file");
  assert.equal(normalizePersistenceBackend("  JSON-FILE  "), "json-file");
  assert.equal(normalizePersistenceBackend("json_file"), "json-file");
  assert.equal(normalizePersistenceBackend("json"), "json-file");
  assert.equal(normalizePersistenceBackend("file"), "json-file");
});

test("normalizePersistenceBackend defaults to sqlite; json-file stays reachable for rollback (perf pass)", () => {
  // The json-file store rewrites and fsyncs the whole snapshot on every
  // persisted mutation, so an unconfigured broker no longer inherits it.
  assert.equal(normalizePersistenceBackend(undefined), DEFAULT_BROKER_PERSISTENCE_BACKEND);
  assert.equal(normalizePersistenceBackend(""), "sqlite");
  assert.equal(normalizePersistenceBackend("   "), "sqlite");
  assert.equal(DEFAULT_BROKER_PERSISTENCE_BACKEND, "sqlite");
  // Unknown values resolve to the default rather than silently selecting the
  // slow store, and the documented rollback token still works.
  assert.equal(normalizePersistenceBackend("postgres"), "sqlite");
  assert.equal(normalizePersistenceBackend("json-file"), "json-file");
});

test("normalizeSqliteLoadSource accepts hot-table aliases and otherwise falls back to snapshot (#819)", () => {
  assert.equal(normalizeSqliteLoadSource("hot-tables"), "hot-tables");
  assert.equal(normalizeSqliteLoadSource("hot-table"), "hot-tables");
  assert.equal(normalizeSqliteLoadSource("hot-runtime"), "hot-tables");
  assert.equal(normalizeSqliteLoadSource("hot_runtime"), "hot-tables");
  assert.equal(normalizeSqliteLoadSource(" HOT_TABLE "), "hot-tables");

  assert.equal(normalizeSqliteLoadSource(undefined), "snapshot");
  assert.equal(normalizeSqliteLoadSource(""), "snapshot");
  assert.equal(normalizeSqliteLoadSource("snapshot"), "snapshot");
  assert.equal(normalizeSqliteLoadSource("full-scan"), "snapshot");
});
