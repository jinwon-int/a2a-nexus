import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const SCRIPT = fileURLToPath(new URL("./shared-state-fence-clear.mjs", import.meta.url));

// Mirrors shared-state-sqlite-schema-v1.ts's shared_state_ownership shape
// exactly, but is deliberately reimplemented here (not imported from dist)
// so these tests do not depend on a build and can construct fixtures the
// schema helper itself would refuse to leave in a "stuck" shape.
function createFenceFixture(directory, { ownerToken, lifecycleEpoch = "3", acquiredAtUnixMs = "1700000000000" }) {
  const file = join(directory, "state.json.shared-state-v1.sqlite");
  const db = new DatabaseSync(file, { timeout: 0 });
  db.exec("PRAGMA journal_mode=WAL");
  db.exec(
    `CREATE TABLE shared_state_ownership (
       id INTEGER PRIMARY KEY CHECK (id = 1),
       owner_token TEXT,
       lifecycle_epoch TEXT NOT NULL,
       acquired_at_unix_ms TEXT
     ) STRICT`,
  );
  db.prepare(
    `INSERT INTO shared_state_ownership (id, owner_token, lifecycle_epoch, acquired_at_unix_ms)
     VALUES (1, ?, ?, ?)`,
  ).run(ownerToken, lifecycleEpoch, acquiredAtUnixMs);
  db.close();
  return file;
}

function readOwnershipRowDirect(file) {
  const db = new DatabaseSync(file, { timeout: 0, readOnly: true });
  try {
    return db.prepare(`SELECT owner_token, lifecycle_epoch, acquired_at_unix_ms FROM shared_state_ownership WHERE id = 1`).get();
  } finally {
    db.close();
  }
}

async function withTempDir(run) {
  const directory = mkdtempSync(join(tmpdir(), "fence-clear-test-"));
  try {
    // Must await here (not just return the promise): several callbacks have
    // real async gaps (e.g. waiting for a spawned process to be observable
    // to `ps`), and without awaiting, `finally` would rmSync the directory
    // out from under the still-running callback.
    return await run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function runScript(args, options = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...options.env },
  });
}

function auditLogEntries(auditLogPath) {
  if (!existsSync(auditLogPath)) return [];
  return readFileSync(auditLogPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

// ---------------------------------------------------------------------------
// Fail-closed path 1: a file-lock holder exists.
// ---------------------------------------------------------------------------

test("refuses to clear when a file lock holder exists on the fence file", async () => {
  await withTempDir(async (directory) => {
    const file = createFenceFixture(directory, { ownerToken: "stale-owner-token" });

    // Hold the file open from *this* process so `lsof` finds a real holder —
    // exercising the actual lsof-based check, not a stub of it.
    const holderDb = new DatabaseSync(file, { timeout: 0 });
    try {
      const result = runScript(["--file", file, "--json"]);
      assert.notEqual(result.status, 0, `expected non-zero exit; stderr=${result.stderr}`);
      assert.match(result.stderr, /ABORT/);
      assert.match(result.stderr, /still hold the fence file open/);

      // Nothing was mutated.
      const row = readOwnershipRowDirect(file);
      assert.equal(row.owner_token, "stale-owner-token");
      assert.equal(auditLogEntries(`${file}.fence-clear-audit.log`).length, 0);
    } finally {
      holderDb.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Fail-closed path 2: a broker process is running.
// ---------------------------------------------------------------------------

test("refuses to clear when a broker process is detected", async () => {
  await withTempDir(async (directory) => {
    const file = createFenceFixture(directory, { ownerToken: "stale-owner-token" });

    // Make a real OS process whose command line matches the broker's actual
    // entrypoint shape (packages/broker/dist/server.js), so the ps-based
    // detection is exercised for real rather than mocked.
    const fakeBrokerDir = join(directory, "packages", "broker", "dist");
    mkdirSync(fakeBrokerDir, { recursive: true });
    const fakeBrokerPath = join(fakeBrokerDir, "server.js");
    writeFileSync(fakeBrokerPath, "setInterval(() => {}, 1000);\n");
    const fakeBroker = spawn(process.execPath, [fakeBrokerPath], { stdio: "ignore" });
    try {
      // Give `ps` a moment to be able to observe the new process.
      await new Promise((resolve) => setTimeout(resolve, 200));

      const result = runScript(["--file", file, "--json"]);
      assert.notEqual(result.status, 0, `expected non-zero exit; stderr=${result.stderr}`);
      assert.match(result.stderr, /ABORT/);
      assert.match(result.stderr, /broker process\(es\) are running/);

      const row = readOwnershipRowDirect(file);
      assert.equal(row.owner_token, "stale-owner-token");
    } finally {
      fakeBroker.kill("SIGKILL");
    }
  });
});

// ---------------------------------------------------------------------------
// Fail-closed path 3: the checks themselves cannot be performed.
// ---------------------------------------------------------------------------

test("refuses to clear when the file-occupancy check itself cannot run (lsof missing)", async () => {
  await withTempDir(async (directory) => {
    const file = createFenceFixture(directory, { ownerToken: "stale-owner-token" });

    const emptyBinDir = join(directory, "empty-bin");
    mkdirSync(emptyBinDir, { recursive: true });
    const result = runScript(["--file", file], { env: { PATH: emptyBinDir } });

    assert.notEqual(result.status, 0, `expected non-zero exit; stderr=${result.stderr}`);
    assert.match(result.stderr, /ABORT/);
    assert.match(result.stderr, /file-occupancy check could not be performed confidently/);

    const row = readOwnershipRowDirect(file);
    assert.equal(row.owner_token, "stale-owner-token");
  });
});

test("refuses to clear when the broker-process check itself cannot run (ps missing)", async () => {
  await withTempDir(async (directory) => {
    const file = createFenceFixture(directory, { ownerToken: "stale-owner-token" });

    // A PATH with a working lsof stub (reports zero holders) but no ps at
    // all, so the file-occupancy check passes and the process check is the
    // one that fails to run.
    const stubBinDir = join(directory, "stub-bin");
    mkdirSync(stubBinDir, { recursive: true });
    const lsofStub = join(stubBinDir, "lsof");
    writeFileSync(lsofStub, "#!/bin/sh\nexit 1\n", { mode: 0o755 });

    const result = runScript(["--file", file], { env: { PATH: stubBinDir } });

    assert.notEqual(result.status, 0, `expected non-zero exit; stderr=${result.stderr}`);
    assert.match(result.stderr, /ABORT/);
    assert.match(result.stderr, /broker-process check could not be performed confidently/);

    const row = readOwnershipRowDirect(file);
    assert.equal(row.owner_token, "stale-owner-token");
  });
});

// ---------------------------------------------------------------------------
// Happy path.
// ---------------------------------------------------------------------------

test("clears owner_token, preserves lifecycle_epoch, backs up the file, and writes an audit log when both checks pass", async () => {
  await withTempDir(async (directory) => {
    const file = createFenceFixture(directory, {
      ownerToken: "11111111-1111-1111-1111-111111111111",
      lifecycleEpoch: "7",
      acquiredAtUnixMs: "1736000000000",
    });

    const result = runScript(["--file", file, "--json"]);
    assert.equal(result.status, 0, `expected success; stderr=${result.stderr}`);

    const row = readOwnershipRowDirect(file);
    assert.equal(row.owner_token, null);
    assert.equal(row.lifecycle_epoch, "7", "lifecycle_epoch must never be touched by this tool");
    assert.equal(row.acquired_at_unix_ms, "1736000000000");

    const report = JSON.parse(result.stdout);
    assert.equal(report.outcome, "cleared");
    assert.equal(report.previousOwnerToken, "11111111-1111-1111-1111-111111111111");
    assert.equal(report.lifecycleEpoch, "7");
    assert.ok(existsSync(report.backupPath), "backup file must exist");
    const backedUpRow = readOwnershipRowDirect(report.backupPath);
    assert.equal(backedUpRow.owner_token, "11111111-1111-1111-1111-111111111111", "backup must be pre-clear");

    const auditLogPath = `${file}.fence-clear-audit.log`;
    const entries = auditLogEntries(auditLogPath);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].outcome, "cleared");
    assert.equal(entries[0].previousOwnerToken, "11111111-1111-1111-1111-111111111111");
    assert.equal(entries[0].backupPath, report.backupPath);
    assert.equal(typeof entries[0].invokedBy, "string");
    assert.ok(entries[0].invokedBy.length > 0);
    assert.equal(typeof entries[0].invokedAt, "string");
    assert.deepEqual(entries[0].checks.fileOccupancy.holders, []);
    assert.deepEqual(entries[0].checks.brokerProcesses.matches, []);
  });
});

test("is a no-op that still succeeds when owner_token is already NULL", async () => {
  await withTempDir(async (directory) => {
    const file = createFenceFixture(directory, { ownerToken: null, lifecycleEpoch: "4" });

    const result = runScript(["--file", file, "--json"]);
    assert.equal(result.status, 0, `expected success; stderr=${result.stderr}`);

    const report = JSON.parse(result.stdout);
    assert.equal(report.outcome, "already_clear");

    const row = readOwnershipRowDirect(file);
    assert.equal(row.owner_token, null);
    assert.equal(row.lifecycle_epoch, "4");
  });
});

// ---------------------------------------------------------------------------
// --dry-run.
// ---------------------------------------------------------------------------

test("--dry-run reports intent without writing a backup, mutating the row, or logging an audit entry", async () => {
  await withTempDir(async (directory) => {
    const file = createFenceFixture(directory, {
      ownerToken: "22222222-2222-2222-2222-222222222222",
      lifecycleEpoch: "9",
    });

    const result = runScript(["--file", file, "--dry-run", "--json"]);
    assert.equal(result.status, 0, `expected success; stderr=${result.stderr}`);
    assert.match(result.stderr, /DRY RUN/);

    const report = JSON.parse(result.stdout);
    assert.equal(report.outcome, "dry_run");
    assert.equal(report.dryRun, true);
    assert.equal(report.previousOwnerToken, "22222222-2222-2222-2222-222222222222");

    const row = readOwnershipRowDirect(file);
    assert.equal(row.owner_token, "22222222-2222-2222-2222-222222222222", "dry run must not mutate the row");
    assert.equal(row.lifecycle_epoch, "9");

    assert.equal(existsSync(`${file}.fence-clear-audit.log`), false, "dry run must write no audit-log entry");
  });
});

// ---------------------------------------------------------------------------
// Misc CLI behavior.
// ---------------------------------------------------------------------------

test("aborts with a usage error when --file is missing", () => {
  const result = runScript([]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Missing required --file/);
});

test("fails closed when the file does not look like a fence file (schema mismatch)", async () => {
  await withTempDir(async (directory) => {
    const file = join(directory, "not-a-fence.sqlite");
    const db = new DatabaseSync(file, { timeout: 0 });
    db.exec("CREATE TABLE unrelated (id INTEGER PRIMARY KEY) STRICT");
    db.close();

    const result = runScript(["--file", file]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /ABORT/);
    assert.match(result.stderr, /may not be a shared-state serving fence file/);
  });
});
