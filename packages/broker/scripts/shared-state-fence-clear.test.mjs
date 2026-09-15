import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
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

/**
 * The stub `lsof`/`ps` below live inside the per-test temp directory, so that
 * directory has to allow execution. Some sandboxes mount /tmp `noexec`; fall
 * back to a scratch directory beside this test file so the stub coverage
 * still runs there instead of silently disappearing.
 */
function allowsExec(base) {
  let probeDir;
  try {
    probeDir = mkdtempSync(join(base, "fence-clear-exec-probe-"));
    const probe = join(probeDir, "probe");
    writeFileSync(probe, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    return spawnSync(probe, { encoding: "utf8" }).error === undefined;
  } catch {
    return false;
  } finally {
    if (probeDir !== undefined) rmSync(probeDir, { recursive: true, force: true });
  }
}

function resolveTmpBase() {
  if (allowsExec(tmpdir())) return tmpdir();
  // `.tmp/` is gitignored repo-wide, so a scratch directory a hard kill left
  // behind here can never be picked up by a commit.
  const fallback = join(dirname(SCRIPT), ".tmp");
  mkdirSync(fallback, { recursive: true });
  return fallback;
}

const TMP_BASE = resolveTmpBase();

async function withTempDir(run) {
  const directory = mkdtempSync(join(TMP_BASE, "fence-clear-test-"));
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
// Stubbed `lsof`/`ps` on PATH.
//
// The checks shell out to host tools, so the only way to exercise the
// "what exactly counts as confident evidence" contract — and the invocation
// forms this host does not happen to be running — is to put stub binaries on
// PATH and drive the exact stdout/stderr/exit-code shapes. Tests that need a
// *real* tool are guarded below and skip where the tool is absent.
// ---------------------------------------------------------------------------

function shQuote(value) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

// PATH is replaced wholesale with the stub directory, so the stubs may only
// use shell builtins — `cat` and friends are not resolvable.
function shStub(stdoutLines, { exitCode = 0 } = {}) {
  return [
    "#!/bin/sh",
    ...stdoutLines.map((line) => `printf '%s\\n' ${shQuote(line)}`),
    `exit ${exitCode}`,
    "",
  ].join("\n");
}

// Real lsof's "nothing holds these files" answer: exit 1, no output at all.
const LSOF_ZERO_HOLDERS = shStub([], { exitCode: 1 });

function psTableStub(rows) {
  return shStub(["  PID COMMAND", ...rows]);
}

// A plausible broker-free process table in `ps -eo pid,args` shape.
const PS_NO_BROKER = psTableStub(["    1 /sbin/init", "  842 node /srv/unrelated/dist/worker.js"]);

function stubBin(directory, { lsof = LSOF_ZERO_HOLDERS, ps = PS_NO_BROKER, name = "stub-bin" } = {}) {
  const binDir = join(directory, name);
  mkdirSync(binDir, { recursive: true });
  if (lsof !== null) writeFileSync(join(binDir, "lsof"), lsof, { mode: 0o755 });
  if (ps !== null) writeFileSync(join(binDir, "ps"), ps, { mode: 0o755 });
  return binDir;
}

function hasTool(name) {
  return spawnSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).status === 0;
}

const SKIP_WITHOUT_LSOF = hasTool("lsof") ? false : "requires a real lsof on PATH";
const SKIP_WITHOUT_PS = hasTool("ps") ? false : "requires a real ps on PATH";

function backupArtifacts(file) {
  return readdirSync(dirname(file)).filter((entry) => entry.includes("fence-clear-backup"));
}

/**
 * The whole point of failing closed: a rejected run must leave the fence
 * exactly as it found it — token and epoch intact, no backup copies, no
 * audit-log entry claiming anything happened.
 */
function assertFixtureUntouched(file, { ownerToken, lifecycleEpoch = "3", acquiredAtUnixMs = "1700000000000" }) {
  const row = readOwnershipRowDirect(file);
  assert.equal(row.owner_token, ownerToken, "owner_token must survive a fail-closed abort");
  assert.equal(row.lifecycle_epoch, lifecycleEpoch, "lifecycle_epoch must survive a fail-closed abort");
  assert.equal(row.acquired_at_unix_ms, acquiredAtUnixMs);
  assert.deepEqual(backupArtifacts(file), [], "a rejected run must not write a backup");
  assert.equal(auditLogEntries(`${file}.fence-clear-audit.log`).length, 0, "a rejected run must not write an audit entry");
}

// ---------------------------------------------------------------------------
// Fail-closed path 1: a file-lock holder exists.
// ---------------------------------------------------------------------------

test("refuses to clear when a file lock holder exists on the fence file", { skip: SKIP_WITHOUT_LSOF }, async () => {
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

test("refuses to clear when lsof reports a holder row (stubbed lsof)", async () => {
  await withTempDir(async (directory) => {
    const file = createFenceFixture(directory, { ownerToken: "stale-owner-token" });
    const binDir = stubBin(directory, {
      lsof: shStub([
        "COMMAND   PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME",
        `node    4242 broker  22u  REG  259,3    32768  101 ${file}`,
      ]),
    });

    const result = runScript(["--file", file], { env: { PATH: binDir } });

    assert.notEqual(result.status, 0, `expected non-zero exit; stderr=${result.stderr}`);
    assert.match(result.stderr, /ABORT/);
    assert.match(result.stderr, /still hold the fence file open/);
    assert.match(result.stderr, /node\(pid=4242\)/);
    assertFixtureUntouched(file, { ownerToken: "stale-owner-token" });
  });
});

// ---------------------------------------------------------------------------
// Fail-closed path 2: a broker process is running.
//
// The broker is documented to run as a bare `node dist/server.js`
// (package.json `start`), as `node packages/broker/dist/server.js` from the
// repo root, and as an absolute-path container CMD. All three must be
// detected; a detector that only recognizes the layout this host happens to
// use reports "no broker running" while one is live.
// ---------------------------------------------------------------------------

const BROKER_INVOCATION_FORMS = [
  { label: "bare `node dist/server.js` (package.json start script)", row: " 1201 node dist/server.js" },
  { label: "repo-root relative `node packages/broker/dist/server.js`", row: " 1202 node packages/broker/dist/server.js" },
  { label: "absolute container CMD path", row: " 1203 /usr/local/bin/node /app/packages/broker/dist/server.js" },
  { label: "absolute path without the packages/broker prefix", row: " 1204 /usr/local/bin/node /srv/broker/dist/server.js" },
  { label: "explicitly relative `./dist/server.js`", row: " 1205 node ./dist/server.js" },
  { label: "bare invocation with trailing arguments", row: " 1206 node dist/server.js --port 8080" },
];

for (const form of BROKER_INVOCATION_FORMS) {
  test(`detects a running broker invoked as ${form.label}`, async () => {
    await withTempDir(async (directory) => {
      const file = createFenceFixture(directory, { ownerToken: "stale-owner-token" });
      const binDir = stubBin(directory, {
        ps: psTableStub(["    1 /sbin/init", form.row, "  999 node /srv/unrelated/dist/worker.js"]),
      });

      const result = runScript(["--file", file], { env: { PATH: binDir } });

      assert.notEqual(result.status, 0, `expected non-zero exit; stderr=${result.stderr}`);
      assert.match(result.stderr, /ABORT/);
      assert.match(result.stderr, /broker process\(es\) are running/);
      assert.equal(
        /(\d+) broker process\(es\) are running/.exec(result.stderr)?.[1],
        "1",
        `exactly the broker row must match; stderr=${result.stderr}`,
      );
      assertFixtureUntouched(file, { ownerToken: "stale-owner-token" });
    });
  });
}

test("--dry-run also refuses when a broker process is detected, and clears nothing", async () => {
  await withTempDir(async (directory) => {
    const file = createFenceFixture(directory, { ownerToken: "stale-owner-token" });
    const binDir = stubBin(directory, { ps: psTableStub(["    1 /sbin/init", " 1201 node dist/server.js"]) });

    const result = runScript(["--file", file, "--dry-run", "--json"], { env: { PATH: binDir } });

    assert.notEqual(result.status, 0, `expected non-zero exit; stderr=${result.stderr}`);
    assert.match(result.stderr, /broker process\(es\) are running/);
    assertFixtureUntouched(file, { ownerToken: "stale-owner-token" });
  });
});

test("does not mistake a non-broker command line for the broker entrypoint", async () => {
  await withTempDir(async (directory) => {
    const file = createFenceFixture(directory, { ownerToken: "stale-owner-token" });
    const binDir = stubBin(directory, {
      ps: psTableStub([
        "    1 /sbin/init",
        "  701 node /srv/app/mydist/server.js",
        "  702 node /srv/app/dist/server.js.bak",
        "  703 node /srv/app/dist/server.jsx",
        "  704 node /srv/app/dist/server-js",
      ]),
    });

    const result = runScript(["--file", file, "--json"], { env: { PATH: binDir } });

    assert.equal(result.status, 0, `expected success; stderr=${result.stderr}`);
    const report = JSON.parse(result.stdout);
    assert.equal(report.outcome, "cleared");
    assert.deepEqual(report.checks.brokerProcesses.matches, []);
  });
});

test("refuses to clear when a real broker-shaped process is running", { skip: SKIP_WITHOUT_PS }, async () => {
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
    // A stub lsof (zero holders) in front of the real PATH keeps this test
    // about `ps` alone, so it does not also require lsof to be installed.
    const binDir = stubBin(directory, { ps: null });
    try {
      // Give `ps` a moment to be able to observe the new process.
      await new Promise((resolve) => setTimeout(resolve, 200));

      const result = runScript(["--file", file, "--json"], { env: { PATH: `${binDir}:${process.env.PATH}` } });
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

    assertFixtureUntouched(file, { ownerToken: "stale-owner-token" });
  });
});

test("refuses to clear when the broker-process check itself cannot run (ps missing)", async () => {
  await withTempDir(async (directory) => {
    const file = createFenceFixture(directory, { ownerToken: "stale-owner-token" });

    // A PATH with a working lsof stub (reports zero holders) but no ps at
    // all, so the file-occupancy check passes and the process check is the
    // one that fails to run.
    const binDir = stubBin(directory, { ps: null });

    const result = runScript(["--file", file], { env: { PATH: binDir } });

    assert.notEqual(result.status, 0, `expected non-zero exit; stderr=${result.stderr}`);
    assert.match(result.stderr, /ABORT/);
    assert.match(result.stderr, /broker-process check could not be performed confidently/);

    assertFixtureUntouched(file, { ownerToken: "stale-owner-token" });
  });
});

// ---------------------------------------------------------------------------
// Fail-closed path 4: the check ran, but its output is not evidence.
//
// These are the shapes the docstrings promise to reject. Reading any of them
// as "zero holders" / "no broker running" would clear a token that may still
// be live — the exact outcome the tool exists to prevent.
// ---------------------------------------------------------------------------

const INCONCLUSIVE_LSOF_OUTPUTS = [
  {
    label: "exit 0 with no output at all",
    stub: "#!/bin/sh\nexit 0\n",
    expect: /printed no output/,
  },
  {
    label: "exit 0 with only the header row",
    stub: "#!/bin/sh\necho 'COMMAND   PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME'\nexit 0\n",
    expect: /header row but no holder rows/,
  },
  {
    label: "exit 0 with an unrecognized header",
    stub: "#!/bin/sh\necho 'unexpected output from some other tool'\nexit 0\n",
    expect: /unrecognized header row/,
  },
  {
    label: "exit 0 with a holder row that has no numeric pid",
    stub: "#!/bin/sh\necho 'COMMAND   PID USER'\necho 'node  <none> broker'\nexit 0\n",
    expect: /holder row this script cannot parse/,
  },
  {
    label: "exit 0 with a warning on stderr",
    stub: "#!/bin/sh\necho 'COMMAND   PID USER'\necho 'node  4242 broker'\necho 'lsof: WARNING: cannot stat() some mount' >&2\nexit 0\n",
    expect: /exited 0 but also wrote to stderr/,
  },
  {
    // The `nothing found` exit code paired with output is self-contradictory;
    // treating it as zero holders was the original defect.
    label: "exit 1 with output on stdout",
    stub: "#!/bin/sh\necho 'COMMAND   PID USER'\necho 'node  4242 broker'\nexit 1\n",
    expect: /but still printed output/,
  },
  {
    label: "an unexpected exit code",
    stub: "#!/bin/sh\necho 'lsof: illegal option' >&2\nexit 2\n",
    expect: /lsof exited 2 \(expected 0 or 1\)/,
  },
];

for (const scenario of INCONCLUSIVE_LSOF_OUTPUTS) {
  test(`rejects an inconclusive file-occupancy result: lsof ${scenario.label}`, async () => {
    await withTempDir(async (directory) => {
      const file = createFenceFixture(directory, { ownerToken: "stale-owner-token" });
      const binDir = stubBin(directory, { lsof: scenario.stub });

      const result = runScript(["--file", file], { env: { PATH: binDir } });

      assert.notEqual(result.status, 0, `expected non-zero exit; stderr=${result.stderr}`);
      assert.match(result.stderr, /file-occupancy check could not be performed confidently/);
      assert.match(result.stderr, scenario.expect);
      assertFixtureUntouched(file, { ownerToken: "stale-owner-token" });
    });
  });
}

const INCONCLUSIVE_PS_OUTPUTS = [
  {
    label: "exit 0 with no output at all",
    stub: "#!/bin/sh\nexit 0\n",
    expect: /printed no process table at all/,
  },
  {
    label: "exit 0 with only the header row",
    stub: "#!/bin/sh\necho '  PID COMMAND'\nexit 0\n",
    expect: /header row but no process rows/,
  },
  {
    label: "exit 0 with an unrecognized header",
    stub: "#!/bin/sh\necho 'some other tool entirely'\necho '    1 /sbin/init'\nexit 0\n",
    expect: /unrecognized header row/,
  },
  {
    // Silently skipping rows it cannot parse is how a malformed table becomes
    // a false "no broker running".
    label: "exit 0 with a row that has no numeric pid",
    stub: "#!/bin/sh\necho '  PID COMMAND'\necho '    1 /sbin/init'\necho 'garbled row without a pid'\nexit 0\n",
    expect: /process row this script cannot parse/,
  },
  {
    label: "exit 0 with a warning on stderr",
    stub: "#!/bin/sh\necho '  PID COMMAND'\necho '    1 /sbin/init'\necho 'ps: cannot read /proc/991/cmdline' >&2\nexit 0\n",
    expect: /exited 0 but also wrote to stderr/,
  },
  {
    label: "a non-zero exit",
    stub: "#!/bin/sh\necho 'ps: unsupported option' >&2\nexit 1\n",
    expect: /ps exited 1/,
  },
];

for (const scenario of INCONCLUSIVE_PS_OUTPUTS) {
  test(`rejects an inconclusive broker-process result: ps ${scenario.label}`, async () => {
    await withTempDir(async (directory) => {
      const file = createFenceFixture(directory, { ownerToken: "stale-owner-token" });
      const binDir = stubBin(directory, { ps: scenario.stub });

      const result = runScript(["--file", file], { env: { PATH: binDir } });

      assert.notEqual(result.status, 0, `expected non-zero exit; stderr=${result.stderr}`);
      assert.match(result.stderr, /broker-process check could not be performed confidently/);
      assert.match(result.stderr, scenario.expect);
      assertFixtureUntouched(file, { ownerToken: "stale-owner-token" });
    });
  });
}

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
    const binDir = stubBin(directory);

    const result = runScript(["--file", file, "--json"], { env: { PATH: binDir } });
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
    const binDir = stubBin(directory);

    const result = runScript(["--file", file, "--json"], { env: { PATH: binDir } });
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
    const binDir = stubBin(directory);

    const result = runScript(["--file", file, "--dry-run", "--json"], { env: { PATH: binDir } });
    assert.equal(result.status, 0, `expected success; stderr=${result.stderr}`);
    assert.match(result.stderr, /DRY RUN/);

    const report = JSON.parse(result.stdout);
    assert.equal(report.outcome, "dry_run");
    assert.equal(report.dryRun, true);
    assert.equal(report.previousOwnerToken, "22222222-2222-2222-2222-222222222222");

    const row = readOwnershipRowDirect(file);
    assert.equal(row.owner_token, "22222222-2222-2222-2222-222222222222", "dry run must not mutate the row");
    assert.equal(row.lifecycle_epoch, "9");

    assert.deepEqual(backupArtifacts(file), [], "dry run must not write a backup");
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
    const binDir = stubBin(directory);

    const result = runScript(["--file", file], { env: { PATH: binDir } });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /ABORT/);
    assert.match(result.stderr, /may not be a shared-state serving fence file/);
  });
});
