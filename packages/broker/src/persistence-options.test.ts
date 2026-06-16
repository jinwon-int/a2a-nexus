import test from "node:test";
import assert from "node:assert/strict";

import { normalizePersistenceBackend, normalizeSqliteLoadSource } from "./persistence-options.js";

test("normalizePersistenceBackend accepts only sqlite and otherwise falls back to json-file (#819)", () => {
  assert.equal(normalizePersistenceBackend("sqlite"), "sqlite");
  assert.equal(normalizePersistenceBackend("SQLITE"), "sqlite");
  assert.equal(normalizePersistenceBackend("  sqlite  "), "sqlite");

  assert.equal(normalizePersistenceBackend(undefined), "json-file");
  assert.equal(normalizePersistenceBackend(""), "json-file");
  assert.equal(normalizePersistenceBackend("json-file"), "json-file");
  assert.equal(normalizePersistenceBackend("postgres"), "json-file");
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
