// #1504 P1: shared-state-v1-prune — offline, fail-closed physical prune.
//
// Host tools (`lsof`, `ps`) are stubbed on PATH, as in
// shared-state-fence-clear.test.mjs, so every guard outcome is exercised
// deterministically. Fixtures are real V1 stores built with the compiled
// schema (dist/ is built before this step in the test manifest).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { applySharedStateSqliteSchemaV1 } from "../dist/shared-state-sqlite-schema-v1.js";

const SCRIPT = fileURLToPath(new URL("./shared-state-v1-prune.mjs", import.meta.url));
const HOUR = 3_600_000;
const FLOOR = 1_790_000_000_000; // persisted clock floor of the fixture
const NS = "shadow.test";

function allowsExec(base) {
  let dir;
  try {
    dir = mkdtempSync(join(base, "v1-prune-exec-probe-"));
    writeFileSync(join(dir, "p"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    return spawnSync(join(dir, "p")).error === undefined;
  } catch {
    return false;
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}

const TMP_BASE = (() => {
  if (allowsExec(tmpdir())) return tmpdir();
  const fallback = join(dirname(SCRIPT), ".tmp");
  mkdirSync(fallback, { recursive: true });
  return fallback;
})();

function withTempDir(run) {
  const dir = mkdtempSync(join(TMP_BASE, "v1-prune-test-"));
  try {
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function shQuote(v) {
  return `'${v.replace(/'/g, `'\\''`)}'`;
}

// PATH is replaced wholesale, so stubs may only use shell builtins.
function shStub(lines, exitCode = 0) {
  return ["#!/bin/sh", ...lines.map((l) => `printf '%s\\n' ${shQuote(l)}`), `exit ${exitCode}`, ""].join("\n");
}

const LSOF_ZERO = shStub([], 1);
const PS_NO_BROKER = shStub(["  PID COMMAND", "    1 /sbin/init", "  842 node /srv/other/dist/worker.js"]);

function stubPath(dir, { lsof = LSOF_ZERO, ps = PS_NO_BROKER } = {}) {
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  if (lsof !== null) writeFileSync(join(bin, "lsof"), lsof, { mode: 0o755 });
  if (ps !== null) writeFileSync(join(bin, "ps"), ps, { mode: 0o755 });
  return bin;
}

function run(dir, args, stubs, { window = true } = {}) {
  const full = window && !args.includes("--max-rate-window-sec") && args.length > 0
    ? [...args, "--max-rate-window-sec", "60"]
    : args;
  return spawnSync(process.execPath, [SCRIPT, ...full], {
    encoding: "utf8",
    env: { ...process.env, PATH: stubPath(dir, stubs) },
  });
}

/**
 * A V1 store with: rate rows at floor-48h (prunable), floor-2h (kept under
 * 24h retention), floor (kept); nonces expiring at floor-1s (prunable),
 * floor+10s (active at the floor — kept even if the wall clock is later),
 * floor+1h (kept); plus an ownership row that must never change.
 */
function createStore(dir, { floor = FLOOR, withFloor = true, wal = true } = {}) {
  const file = join(dir, "state.json.shadow-v1.sqlite");
  const db = new DatabaseSync(file);
  assert.equal(applySharedStateSqliteSchemaV1(db).ok, true);
  // Serving-fence files are WAL; the shadow file keeps the default rollback journal.
  if (wal) db.exec("PRAGMA journal_mode = WAL");
  db.prepare(
    `INSERT OR REPLACE INTO shared_state_ownership (id, owner_token, lifecycle_epoch, acquired_at_unix_ms)
     VALUES (1, 'owner-x', '13', '1700000000000')`,
  ).run();
  if (withFloor) {
    db.prepare(
      `INSERT OR REPLACE INTO shared_state_clock_floor (id, clock_profile, persisted_floor_unix_ms)
       VALUES (1, 'wall', ?)`,
    ).run(String(floor));
  }
  const rate = db.prepare(
    `INSERT INTO shared_state_rate_cost (namespace, bucket_key_digest, event_at_unix_ms, cost, entry_ordinal)
     VALUES (?, ?, ?, 1, 1)`,
  );
  rate.run(NS, "b-48h", String(floor - 48 * HOUR));
  rate.run(NS, "b-2h", String(floor - 2 * HOUR));
  rate.run(NS, "b-now", String(floor));
  const nonce = db.prepare(
    `INSERT INTO shared_state_replay_nonce (namespace, key_digest, nonce_digest, expires_at_unix_ms)
     VALUES (?, 'k', ?, ?)`,
  );
  nonce.run(NS, "n-expired", String(floor - 1000));
  nonce.run(NS, "n-active-at-floor", String(floor + 10_000));
  nonce.run(NS, "n-future", String(floor + HOUR));
  db.close();
  return file;
}

function rows(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return {
      rate: db.prepare("SELECT bucket_key_digest AS k FROM shared_state_rate_cost ORDER BY k").all().map((r) => r.k),
      nonce: db.prepare("SELECT nonce_digest AS k FROM shared_state_replay_nonce ORDER BY k").all().map((r) => r.k),
      ownership: { ...db.prepare("SELECT owner_token, lifecycle_epoch, acquired_at_unix_ms FROM shared_state_ownership WHERE id = 1").get() },
    };
  } finally {
    db.close();
  }
}

function digest(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function artifacts(file) {
  return readdirSync(dirname(file)).filter((n) => n.includes(".prune-"));
}

function listing(file) {
  return readdirSync(dirname(file)).filter((n) => n !== "bin").sort();
}

const ALL_ROWS = {
  rate: ["b-2h", "b-48h", "b-now"],
  nonce: ["n-active-at-floor", "n-expired", "n-future"],
  ownership: { owner_token: "owner-x", lifecycle_epoch: "13", acquired_at_unix_ms: "1700000000000" },
};

function assertUntouched(file, before) {
  const names = listing(file);
  assert.deepEqual(rows(file), ALL_ROWS);
  assert.equal(digest(file), before);
  assert.deepEqual(artifacts(file), [], "no backup and no audit log");
  return names;
}

test("dry run (default) reports the exact plan and writes nothing", () => withTempDir((dir) => {
  const file = createStore(dir);
  const before = digest(file);
  const r = run(dir, ["--file", file, "--json", "--now-ms", String(FLOOR)]);
  assert.equal(r.status, 0, r.stderr);
  const report = JSON.parse(r.stdout);
  assert.equal(report.outcome, "dry_run");
  assert.deepEqual(report.planned, { rateCostPrunable: 1, rateCostTotal: 3, noncePrunable: 1, nonceTotal: 3 });
  assert.equal(report.replayCutoffUnixMs, String(FLOOR));
  assert.equal(report.rateCostCutoffUnixMs, String(FLOOR - 24 * HOUR));
  assert.match(r.stderr, /DRY RUN/);
  assertUntouched(file, before);
}));

test("--execute prunes exactly the planned rows, backs up, audits, and never touches ownership", () => withTempDir((dir) => {
  const file = createStore(dir);
  const r = run(dir, ["--file", file, "--execute", "--json", "--now-ms", String(FLOOR)]);
  assert.equal(r.status, 0, r.stderr);
  const report = JSON.parse(r.stdout);
  assert.equal(report.outcome, "pruned");
  assert.deepEqual(report.deleted, { rateCost: 1, replayNonce: 1 });
  assert.deepEqual(rows(file), {
    rate: ["b-2h", "b-now"],
    nonce: ["n-active-at-floor", "n-future"],
    ownership: ALL_ROWS.ownership,
  });
  assert.ok(existsSync(report.backupPath));
  const audit = readFileSync(`${file}.prune-audit.log`, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(audit.length, 1);
  assert.equal(audit[0].outcome, "pruned");
  // The backup is the pre-prune store.
  assert.deepEqual(rows(report.backupPath).rate, ALL_ROWS.rate);

  // Idempotent: a second run deletes nothing more.
  const again = run(dir, ["--file", file, "--execute", "--json", "--now-ms", String(FLOOR)]);
  assert.equal(again.status, 0, again.stderr);
  assert.deepEqual(JSON.parse(again.stdout).deleted, { rateCost: 0, replayNonce: 0 });
}));

test("replay cutoff is clamped to the persisted clock floor, not a wall clock that runs ahead", () => withTempDir((dir) => {
  const file = createStore(dir);
  // Wall clock 1 day ahead of the floor: n-active-at-floor would look expired
  // by wall time, but the adapter's now can still be at the floor.
  const r = run(dir, ["--file", file, "--execute", "--json", "--now-ms", String(FLOOR + 24 * HOUR)]);
  assert.equal(r.status, 0, r.stderr);
  const report = JSON.parse(r.stdout);
  assert.equal(report.replayCutoffUnixMs, String(FLOOR));
  assert.ok(rows(file).nonce.includes("n-active-at-floor"));
  assert.deepEqual(report.deleted, { rateCost: 1, replayNonce: 1 });
}));

test("a wall clock behind the floor lowers both cutoffs (never prunes more)", () => withTempDir((dir) => {
  const file = createStore(dir);
  const r = run(dir, ["--file", file, "--json", "--now-ms", String(FLOOR - 72 * HOUR)]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).planned, { rateCostPrunable: 0, rateCostTotal: 3, noncePrunable: 0, nonceTotal: 3 });
}));

test("longer retention keeps more rate rows", () => withTempDir((dir) => {
  const file = createStore(dir);
  const r = run(dir, ["--file", file, "--json", "--rate-retention-hours", "72", "--now-ms", String(FLOOR)]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).planned.rateCostPrunable, 0);
}));

test("--vacuum runs after the prune and reports sizes", () => withTempDir((dir) => {
  const file = createStore(dir);
  const r = run(dir, ["--file", file, "--execute", "--vacuum", "--json", "--now-ms", String(FLOOR)]);
  assert.equal(r.status, 0, r.stderr);
  const report = JSON.parse(r.stdout);
  assert.equal(report.vacuumed, true);
  assert.equal(typeof report.sizesAfter.main, "number");
}));

test("a store without a clock floor is left alone", () => withTempDir((dir) => {
  const file = createStore(dir, { withFloor: false });
  const r = run(dir, ["--file", file, "--execute", "--json"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).outcome, "no_clock_floor");
  assert.equal(rows(file).rate.length, 3);
  // Execute mode records the no-op; nothing is backed up.
  const audit = readFileSync(`${file}.prune-audit.log`, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(audit.map((e) => e.outcome), ["no_clock_floor"]);
  assert.deepEqual(artifacts(file).filter((n) => n.includes("backup")), []);
}));

test("fails closed when a process holds the file", () => withTempDir((dir) => {
  const file = createStore(dir);
  const before = digest(file);
  const lsof = shStub(["COMMAND   PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME", `node    4242 root   12u   REG  8,1  4096  77 ${file}`]);
  const r = run(dir, ["--file", file, "--execute"], { lsof });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /ABORT .*hold the file open/);
  assertUntouched(file, before);
}));

test("fails closed when a broker server process is running", () => withTempDir((dir) => {
  const file = createStore(dir);
  const before = digest(file);
  const ps = shStub(["  PID COMMAND", "    1 /sbin/init", "  900 node packages/broker/dist/server.js"]);
  const r = run(dir, ["--file", file, "--execute"], { ps });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /ABORT .*broker server process running/);
  assertUntouched(file, before);
}));

test("fails closed when lsof is missing or its output is not understood", () => withTempDir((dir) => {
  const file = createStore(dir);
  const before = digest(file);
  const missing = run(dir, ["--file", file, "--execute"], { lsof: null });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /inconclusive/);
  const weird = run(dir, ["--file", file, "--execute"], { lsof: shStub(["something odd"], 0) });
  assert.equal(weird.status, 1);
  assert.match(weird.stderr, /inconclusive/);
  assertUntouched(file, before);
}));

test("refuses a file that is not a V1 store and never initializes a schema", () => withTempDir((dir) => {
  const file = join(dir, "not-v1.sqlite");
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE t (x)");
  db.close();
  const r = run(dir, ["--file", file, "--execute"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not a shared-state V1 store/);
  const check = new DatabaseSync(file, { readOnly: true });
  const tables = check.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((t) => t.name);
  check.close();
  assert.deepEqual(tables, ["t"]);
}));

test("usage errors exit 2", () => withTempDir((dir) => {
  const file = createStore(dir);
  for (const args of [
    [],
    ["--file", file, "--vacuum"],
    ["--file", file, "--rate-retention-hours", "0"],
    ["--file", file, "--rate-retention-hours", "1.5"],
    ["--file", file, "--now-ms", "-1"],
    ["--file", file, "--bogus"],
  ]) {
    const r = run(dir, args);
    assert.equal(r.status, 2, `args=${JSON.stringify(args)} stderr=${r.stderr}`);
  }
}));

for (const wal of [true, false]) {
  test(`dry run leaves the directory listing unchanged (${wal ? "WAL" : "rollback journal"})`, () => withTempDir((dir) => {
    const file = createStore(dir, { wal });
    const before = listing(file);
    const hash = digest(file);
    const r = run(dir, ["--file", file, "--now-ms", String(FLOOR)]);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(listing(file), before, "no -wal/-shm/backup/audit left behind");
    assert.equal(digest(file), hash);
  }));

  test(`execute works on a ${wal ? "WAL" : "rollback-journal"} store`, () => withTempDir((dir) => {
    const file = createStore(dir, { wal });
    const r = run(dir, ["--file", file, "--execute", "--json", "--now-ms", String(FLOOR)]);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout).deleted, { rateCost: 1, replayNonce: 1 });
  }));
}

test("exact-cutoff and non-canonical rows are kept; planned equals deleted with the wall clock ahead", () => withTempDir((dir) => {
  const file = createStore(dir);
  const db = new DatabaseSync(file);
  const rate = db.prepare(
    `INSERT INTO shared_state_rate_cost (namespace, bucket_key_digest, event_at_unix_ms, cost, entry_ordinal)
     VALUES (?, ?, ?, 1, 1)`,
  );
  rate.run(NS, "b-at-cutoff", String(FLOOR - 24 * HOUR)); // == rate cutoff: counted still possible → keep
  rate.run(NS, "b-just-below", String(FLOOR - 24 * HOUR - 1));
  rate.run(NS, "b-noncanonical", `0${FLOOR - 48 * HOUR}`);
  const nonce = db.prepare(
    `INSERT INTO shared_state_replay_nonce (namespace, key_digest, nonce_digest, expires_at_unix_ms)
     VALUES (?, 'k', ?, ?)`,
  );
  nonce.run(NS, "n-at-floor", String(FLOOR)); // expires == effective now floor: keep
  nonce.run(NS, "n-noncanonical", " 1");
  db.close();

  const dry = run(dir, ["--file", file, "--json", "--now-ms", String(FLOOR + 5 * HOUR)]);
  assert.equal(dry.status, 0, dry.stderr);
  const planned = JSON.parse(dry.stdout).planned;
  const r = run(dir, ["--file", file, "--execute", "--json", "--now-ms", String(FLOOR + 5 * HOUR)]);
  assert.equal(r.status, 0, r.stderr);
  const report = JSON.parse(r.stdout);
  assert.deepEqual(report.deleted, { rateCost: planned.rateCostPrunable, replayNonce: planned.noncePrunable });
  assert.deepEqual(report.deleted, { rateCost: 2, replayNonce: 1 }); // b-48h + b-just-below; n-expired
  const left = rows(file);
  for (const k of ["b-at-cutoff", "b-noncanonical", "b-2h", "b-now"]) assert.ok(left.rate.includes(k), k);
  for (const k of ["n-at-floor", "n-noncanonical", "n-active-at-floor", "n-future"]) assert.ok(left.nonce.includes(k), k);
}));

test("retention must be longer than the largest rate window, and the window is required", () => withTempDir((dir) => {
  const file = createStore(dir);
  const missing = run(dir, ["--file", file], undefined, { window: false });
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /--max-rate-window-sec/);
  const tooShort = run(dir, ["--file", file, "--rate-retention-hours", "1", "--max-rate-window-sec", "7200"]);
  assert.equal(tooShort.status, 2);
  assert.match(tooShort.stderr, /must be longer/);
  const equal = run(dir, ["--file", file, "--rate-retention-hours", "1", "--max-rate-window-sec", "3600"]);
  assert.equal(equal.status, 2);
  const ok = run(dir, ["--file", file, "--rate-retention-hours", "2", "--max-rate-window-sec", "3600", "--now-ms", String(FLOOR)]);
  assert.equal(ok.status, 0, ok.stderr);
}));

test("an unwritable audit log aborts before any backup or delete", () => withTempDir((dir) => {
  const file = createStore(dir);
  const hash = digest(file);
  const r = run(dir, ["--file", file, "--execute", "--audit-log", join(dir, "no-such-dir", "audit.log"), "--now-ms", String(FLOOR)]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /ABORT .*audit log .* not writable/);
  assert.deepEqual(rows(file), ALL_ROWS);
  assert.equal(digest(file), hash);
  assert.deepEqual(artifacts(file), []);
}));

test("--vacuum writes a committed-prune audit line before the vacuum line", () => withTempDir((dir) => {
  const file = createStore(dir);
  const r = run(dir, ["--file", file, "--execute", "--vacuum", "--now-ms", String(FLOOR)]);
  assert.equal(r.status, 0, r.stderr);
  const audit = readFileSync(`${file}.prune-audit.log`, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(audit.map((a) => a.outcome), ["pruned", "pruned_vacuumed"]);
  assert.deepEqual(audit[0].deleted, { rateCost: 1, replayNonce: 1 });
}));

test("an out-of-range clock floor is refused", () => withTempDir((dir) => {
  const file = createStore(dir, { floor: 1 });
  const db = new DatabaseSync(file);
  db.prepare("UPDATE shared_state_clock_floor SET persisted_floor_unix_ms = ? WHERE id = 1").run("99999999999999999999");
  db.close();
  const r = run(dir, ["--file", file, "--execute"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /clock floor is not a canonical in-range/);
  assert.equal(rows(file).nonce.length, 3);
}));

test("a zero clock floor (adapter opened, never observed) prunes nothing", () => withTempDir((dir) => {
  const file = createStore(dir, { floor: 0 });
  const r = run(dir, ["--file", file, "--execute", "--json"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).outcome, "no_clock_floor");
  assert.equal(rows(file).rate.length, 3);
}));
