/**
 * Startup state-source checks (#1504 §4, spec section 7.1 step 2).
 *
 * Pins the fail-closed behavior for opening a durable state source: version
 * markers (schema_version, state_version), the grade↔backend capability rule,
 * the one-shot startup clock observation, and the snapshot envelope version
 * bound. This file does not attach the worker-lane V1 adapter to the broker
 * runtime, change defaults, or claim adapter conformance.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { createBrokerServer } from "./server.js";
import { withEnv } from "./server-test-helpers.js";
import { CURRENT_BROKER_STATE_VERSION, JsonFileBrokerStateStore, SqliteBrokerStateStore } from "./core/store.js";
import { emptySnapshot } from "./core/store-snapshot-io.js";
import {
  STARTUP_CLOCK_BACKWARD_TOLERANCE_MS,
  evaluateGradeBackendCapabilityV1,
  evaluatePersistedClockV1,
  evaluatePersistedSchemaVersionV1,
  evaluatePersistedStateVersionV1,
} from "./shared-state-startup-checks-v1.js";

function tempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "a2a-broker-startup-checks-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function readMetadata(dbFile: string, key: string): string | undefined {
  const db = new DatabaseSync(dbFile);
  try {
    const row = db.prepare("SELECT value FROM broker_metadata WHERE key = ?").get(key) as
      | { value?: string }
      | undefined;
    return row?.value;
  } finally {
    db.close();
  }
}

function writeMetadata(dbFile: string, key: string, value: string): void {
  const db = new DatabaseSync(dbFile);
  try {
    db.prepare("INSERT INTO broker_metadata (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  } finally {
    db.close();
  }
}

function assertStartupCheckError(error: unknown, code: string): void {
  const message = error instanceof Error ? error.message : String(error);
  assert.match(
    message,
    new RegExp(`shared-state startup check failed: ${code}`),
    `expected a ${code} startup refusal, got: ${message}`,
  );
}

// ---------------------------------------------------------------------------
// Pure evaluators
// ---------------------------------------------------------------------------

test("schema_version evaluator: absent/equal/older open, newer and garbage refuse", () => {
  const known = 13;
  assert.equal(evaluatePersistedSchemaVersionV1({ observed: undefined, known }), undefined);
  assert.equal(evaluatePersistedSchemaVersionV1({ observed: null, known }), undefined);
  assert.equal(evaluatePersistedSchemaVersionV1({ observed: "", known }), undefined);
  assert.equal(evaluatePersistedSchemaVersionV1({ observed: "13", known }), undefined);
  assert.equal(evaluatePersistedSchemaVersionV1({ observed: "12", known }), undefined, "older stays on the in-place forward-upgrade path");
  const newer = evaluatePersistedSchemaVersionV1({ observed: "14", known });
  assert.equal(newer?.code, "schema_version_newer");
  assert.match(newer!.detail, /14/);
  const garbage = evaluatePersistedSchemaVersionV1({ observed: "not-a-number", known });
  assert.equal(garbage?.code, "schema_version_newer");
});

test("state_version evaluator: absent/equal/older open, newer refuses", () => {
  const known = CURRENT_BROKER_STATE_VERSION;
  assert.equal(evaluatePersistedStateVersionV1({ observed: String(known), known }), undefined);
  assert.equal(evaluatePersistedStateVersionV1({ observed: String(known - 1), known }), undefined);
  const newer = evaluatePersistedStateVersionV1({ observed: String(known + 1), known });
  assert.equal(newer?.code, "state_version_newer");
});

test("grade/backend capability: single-writer-durable demands sqlite; other grades unrestricted", () => {
  const mismatch = evaluateGradeBackendCapabilityV1({ configuredGrade: "single-writer-durable", backend: "json-file" });
  assert.equal(mismatch?.code, "grade_backend_mismatch");
  assert.match(mismatch!.detail, /single-writer-durable/);
  assert.match(mismatch!.detail, /json-file/);
  assert.equal(evaluateGradeBackendCapabilityV1({ configuredGrade: "single-writer-durable", backend: "sqlite" }), undefined);
  assert.equal(evaluateGradeBackendCapabilityV1({ configuredGrade: "single-process", backend: "json-file" }), undefined);
  assert.equal(evaluateGradeBackendCapabilityV1({ configuredGrade: "single-process", backend: "sqlite" }), undefined);
  // shared-state-ha is refused by the grade parser before this check runs; the
  // capability check itself adds no opinion about it.
  assert.equal(evaluateGradeBackendCapabilityV1({ configuredGrade: "shared-state-ha", backend: "json-file" }), undefined);
});

test("clock evaluator: missing/unparsable markers open; boundary is inclusive per section 4.2", () => {
  const now = 1_700_000_000_000;
  assert.equal(evaluatePersistedClockV1({ persistedAtIso: undefined, nowUnixMs: now }), undefined);
  assert.equal(evaluatePersistedClockV1({ persistedAtIso: "", nowUnixMs: now }), undefined);
  assert.equal(evaluatePersistedClockV1({ persistedAtIso: "not-a-timestamp", nowUnixMs: now }), undefined);
  // Far past, and a small future step: open.
  assert.equal(evaluatePersistedClockV1({ persistedAtIso: new Date(now - 86_400_000).toISOString(), nowUnixMs: now }), undefined);
  assert.equal(evaluatePersistedClockV1({ persistedAtIso: new Date(now + 60_000).toISOString(), nowUnixMs: now }), undefined);
  // Exactly the tolerance is safe (section 4.2 equality rule); one ms more refuses.
  const atTolerance = new Date(now + STARTUP_CLOCK_BACKWARD_TOLERANCE_MS).toISOString();
  assert.equal(evaluatePersistedClockV1({ persistedAtIso: atTolerance, nowUnixMs: now }), undefined);
  const beyond = evaluatePersistedClockV1({
    persistedAtIso: new Date(now + STARTUP_CLOCK_BACKWARD_TOLERANCE_MS + 1).toISOString(),
    nowUnixMs: now,
  });
  assert.equal(beyond?.code, "clock_backward_beyond_tolerance");
  assert.match(beyond!.detail, /tolerance/);
});

// ---------------------------------------------------------------------------
// SqliteBrokerStateStore constructor guard
// ---------------------------------------------------------------------------

test("fresh sqlite store initializes and records known version markers", () => {
  const tmp = tempDir();
  try {
    const dbFile = join(tmp.dir, "state.sqlite");
    const store = new SqliteBrokerStateStore(dbFile);
    store.save(emptyishSnapshot());
    store.close();
    assert.equal(readMetadata(dbFile, "schema_version"), "13");
    assert.equal(readMetadata(dbFile, "state_version"), String(CURRENT_BROKER_STATE_VERSION));
    assert.ok(readMetadata(dbFile, "last_persist_at"), "a persist must leave a durable clock marker");
  } finally {
    tmp.cleanup();
  }
});

test("reopening the same store passes its own checks (upgrade-on-open unaffected)", () => {
  const tmp = tempDir();
  try {
    const dbFile = join(tmp.dir, "state.sqlite");
    const first = new SqliteBrokerStateStore(dbFile);
    first.save(emptyishSnapshot());
    first.close();
    const second = new SqliteBrokerStateStore(dbFile);
    assert.equal(second.load().version, CURRENT_BROKER_STATE_VERSION);
    second.close();
  } finally {
    tmp.cleanup();
  }
});

test("newer schema_version metadata refuses store construction", () => {
  const tmp = tempDir();
  try {
    const dbFile = join(tmp.dir, "state.sqlite");
    const store = new SqliteBrokerStateStore(dbFile);
    store.close();
    writeMetadata(dbFile, "schema_version", "14");
    assert.throws(() => new SqliteBrokerStateStore(dbFile), (error: unknown) => {
      assertStartupCheckError(error, "schema_version_newer");
      return true;
    });
  } finally {
    tmp.cleanup();
  }
});

test("newer state_version metadata refuses store construction", () => {
  const tmp = tempDir();
  try {
    const dbFile = join(tmp.dir, "state.sqlite");
    const store = new SqliteBrokerStateStore(dbFile);
    store.close();
    writeMetadata(dbFile, "state_version", String(CURRENT_BROKER_STATE_VERSION + 1));
    assert.throws(() => new SqliteBrokerStateStore(dbFile), (error: unknown) => {
      assertStartupCheckError(error, "state_version_newer");
      return true;
    });
  } finally {
    tmp.cleanup();
  }
});

test("last durable write in the future beyond tolerance refuses; within tolerance opens", () => {
  const tmp = tempDir();
  try {
    const dbFile = join(tmp.dir, "state.sqlite");
    const store = new SqliteBrokerStateStore(dbFile);
    store.save(emptyishSnapshot());
    store.close();
    writeMetadata(dbFile, "last_persist_at", new Date(Date.now() + STARTUP_CLOCK_BACKWARD_TOLERANCE_MS + 60_000).toISOString());
    assert.throws(() => new SqliteBrokerStateStore(dbFile), (error: unknown) => {
      assertStartupCheckError(error, "clock_backward_beyond_tolerance");
      return true;
    });
    // A step inside the tolerance (e.g. bounded NTP correction) stays openable.
    writeMetadata(dbFile, "last_persist_at", new Date(Date.now() + 60_000).toISOString());
    const reopened = new SqliteBrokerStateStore(dbFile);
    reopened.close();
  } finally {
    tmp.cleanup();
  }
});

test("a pre-versioning database with an empty metadata table still opens (upgrade path)", () => {
  const tmp = tempDir();
  try {
    const dbFile = join(tmp.dir, "legacy.sqlite");
    const db = new DatabaseSync(dbFile);
    db.exec("CREATE TABLE broker_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    db.close();
    const store = new SqliteBrokerStateStore(dbFile);
    store.close();
    assert.equal(readMetadata(dbFile, "schema_version"), "13");
  } finally {
    tmp.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Snapshot envelope version bound (JSON file store + SQLite canonical payload)
// ---------------------------------------------------------------------------

test("a JSON snapshot with a newer envelope version fails closed at load", () => {
  const tmp = tempDir();
  try {
    const stateFile = join(tmp.dir, "state.json");
    writeFileSync(
      stateFile,
      JSON.stringify({ version: CURRENT_BROKER_STATE_VERSION + 1, tasks: [] }),
      "utf8",
    );
    const store = new JsonFileBrokerStateStore(stateFile);
    assert.throws(() => store.load(), /state_version_newer/);
  } finally {
    tmp.cleanup();
  }
});

test("the SQLite canonical snapshot payload with a newer version fails closed at load", () => {
  const tmp = tempDir();
  try {
    const dbFile = join(tmp.dir, "state.sqlite");
    const store = new SqliteBrokerStateStore(dbFile);
    store.save(emptyishSnapshot());
    store.close();
    const db = new DatabaseSync(dbFile);
    try {
      const row = db.prepare("SELECT payload FROM broker_snapshots WHERE id = 1").get() as { payload: string };
      const poisoned = JSON.parse(row.payload);
      poisoned.version = CURRENT_BROKER_STATE_VERSION + 1;
      db.prepare("UPDATE broker_snapshots SET payload = ? WHERE id = 1").run(JSON.stringify(poisoned));
    } finally {
      db.close();
    }
    const reopened = new SqliteBrokerStateStore(dbFile);
    assert.throws(() => reopened.load(), /state_version_newer/);
    reopened.close();
  } finally {
    tmp.cleanup();
  }
});

// ---------------------------------------------------------------------------
// createBrokerServer capability check
// ---------------------------------------------------------------------------

test("single-writer-durable with the default sqlite backend constructs", async () => {
  const tmp = tempDir();
  try {
    await withEnv({
      BROKER_DEPLOYMENT_GRADE: "single-writer-durable",
      BROKER_EXPECTED_PROCESS_COUNT: "1",
      BROKER_PERSISTENCE_BACKEND: undefined,
    }, async () => {
      const runtime = createBrokerServer({
        host: "127.0.0.1",
        port: 0,
        publicBaseUrl: "https://broker.test/",
        stateFile: join(tmp.dir, "state.json"),
        sqliteFile: join(tmp.dir, "state.sqlite"),
      });
      runtime.server.close();
    });
  } finally {
    tmp.cleanup();
  }
});

test("single-writer-durable with an explicit json-file backend refuses before listen", async () => {
  const tmp = tempDir();
  try {
    await withEnv({
      BROKER_DEPLOYMENT_GRADE: "single-writer-durable",
      BROKER_EXPECTED_PROCESS_COUNT: "1",
      BROKER_PERSISTENCE_BACKEND: "json-file",
    }, async () => {
      assert.throws(
        () =>
          createBrokerServer({
            host: "127.0.0.1",
            port: 0,
            publicBaseUrl: "https://broker.test/",
            stateFile: join(tmp.dir, "state.json"),
          }),
        /shared-state startup check failed: grade_backend_mismatch/,
      );
    });
  } finally {
    tmp.cleanup();
  }
});

function emptyishSnapshot() {
  return emptySnapshot();
}
