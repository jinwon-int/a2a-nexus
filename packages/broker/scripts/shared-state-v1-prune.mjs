#!/usr/bin/env node
/**
 * #1504 Phase 7 prerequisite P1: offline physical prune of shared-state V1
 * replay-nonce and rate-cost rows.
 *
 * Why: the reserve/consume paths deliberately leave expired nonces and
 * out-of-window rate rows on disk (#2081 — physical cleanup timing must never
 * be observable in a logical answer). `pruneSharedStateSqliteV1` exists to
 * remove them, but nothing calls it. The T1 shadow file
 * (`state.json.shadow-v1.sqlite`) grew to ~1.0 GB (~65 MB/day since
 * 2026-09-10). Once Phase 7 turns the serving V1 replay/rate primitives on,
 * the serving-fence file grows at the same rate, which lengthens fence
 * backups and drains.
 *
 * Why OFFLINE only: both V1 connections in the broker run with SQLite
 * `timeout: 0`. An external writer holding `BEGIN IMMEDIATE` makes a live
 * serving transaction fail as `store_failure` → 503, and a live shadow
 * observation fail → counted as `unexplained` (the Phase 6/7 blocking
 * class). So this tool refuses to run unless the broker is provably down,
 * using the same fail-closed `lsof`/`ps` guards as `shared-state-fence-clear`
 * (scripts/lib/shared-state-offline-guards.mjs). Phase 7 already stops the
 * broker for a 15-minute drain; that is the intended slot. A runtime periodic
 * prune inside the broker is a separate, later decision.
 *
 * Do not "just dry-run" against a live store either: the shadow runtime opens
 * its file with no pragmas (rollback-journal mode, not WAL). In that mode even
 * a reader's SHARED lock blocks the shadow's commit, and with `timeout: 0` the
 * blocked observation is counted as `unexplained`. The guards below therefore
 * run before the file is opened at all, in both dry-run and execute modes.
 *
 * Correctness (spec §4.2 / "cleanup MUST NOT remove a logically active
 * record"):
 *   - replay: a nonce is active while now < expires_at. The adapter's
 *     effective now is never below the persisted clock floor, so the replay
 *     cutoff is min(wall clock, persisted floor). Everything strictly below it
 *     is expired for every future evaluation.
 *   - rate: an entry counts while event_at > now - window. The rate cutoff is
 *     min(wall clock, floor) - retention. Retention (default 24h, minimum 1h)
 *     must exceed every configured rate window, so the operator states the
 *     largest window in use (`--max-rate-window-sec`, from the broker's
 *     RATE_LIMIT_WINDOW_SEC / WORKER_RATE_LIMIT_WINDOW_SEC) and the tool
 *     refuses unless retention > that window.
 *   - A missing or zero clock floor ("0" is what adapter open writes before
 *     any observation) yields cutoff 0: nothing is pruned.
 * The deletes are `pruneSharedStateSqliteV1` itself (one BEGIN IMMEDIATE,
 * idempotent, canonical-decimal rows only). Ownership/epoch/lease/outbox rows
 * are never touched. The dry-run counts use the same predicates
 * (`countSharedStateSqlitePrunableV1`), so the plan equals the execution.
 *
 * Usage (T1 host, broker stopped, from packages/broker with a built dist/):
 *   node scripts/shared-state-v1-prune.mjs --file <v1.sqlite>              # dry run (default)
 *   node scripts/shared-state-v1-prune.mjs --file <v1.sqlite> --execute    # backup + prune + audit
 *   node scripts/shared-state-v1-prune.mjs --file <v1.sqlite> --execute --vacuum
 *
 * Options:
 *   --file <path>               Required. A shared-state V1 SQLite file (shadow or serving).
 *   --execute                   Actually delete. Without it nothing is written anywhere.
 *   --vacuum                    After the prune, VACUUM to return freed pages to the OS
 *                               (needs free disk ≈ the file size). Requires --execute.
 *   --max-rate-window-sec <n>   Required. Largest rate window the broker uses (seconds).
 *   --rate-retention-hours <n>  Rate-cost retention, integer ≥ 1 (default 24); must be
 *                               longer than --max-rate-window-sec.
 *   --audit-log <path>          JSON-lines audit log (default <file>.prune-audit.log).
 *   --now-ms <ms>               Override the wall clock (reproducibility/tests); the
 *                               floor clamp still applies.
 *   --json                      Emit the final report as JSON on stdout.
 *
 * Exit codes: 0 success (including dry run and "nothing to prune"), 1
 * fail-closed abort or unexpected error, 2 usage error, 3 the prune committed
 * (and was audited) but the requested VACUUM failed.
 */
import { appendFileSync, copyFileSync, existsSync, statSync, unlinkSync } from "node:fs";
import os from "node:os";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";

import { checkFileOccupancy, checkNoBrokerProcess } from "./lib/shared-state-offline-guards.mjs";
import {
  countSharedStateSqlitePrunableV1,
  pruneSharedStateSqliteV1,
  readSharedStateSqliteClockFloorV1,
} from "../dist/shared-state-sqlite-adapter-v1.js";

const TOOL = "shared-state-v1-prune";
const DEFAULT_RETENTION_HOURS = 24;
const MIN_RETENTION_HOURS = 1;
const HOUR_MS = 3_600_000n;
const MAX_SAFE_MS = BigInt(Number.MAX_SAFE_INTEGER);
const REQUIRED_TABLES = ["shared_state_rate_cost", "shared_state_replay_nonce", "shared_state_clock_floor", "shared_state_ownership"];

function logStatus(message) {
  process.stderr.write(`[${TOOL}] ${message}\n`);
}

function abort(reason) {
  logStatus(`ABORT — ${reason}`);
  process.exit(1);
}

function usage(exitCode, message) {
  if (message) process.stderr.write(`${message}\n\n`);
  process.stderr.write(
    `usage: node scripts/${TOOL}.mjs --file <v1.sqlite> [--execute [--vacuum]] `
    + `--max-rate-window-sec <n> [--rate-retention-hours <n>] [--audit-log <path>] [--now-ms <ms>] [--json]\n`
    + "Runs only while no process holds the file (lsof) and no broker server runs (ps).\n",
  );
  process.exit(exitCode);
}

function parseArgs(argv) {
  const opts = { execute: false, vacuum: false, json: false, retentionHours: DEFAULT_RETENTION_HOURS };
  const valueFlags = new Set(["--file", "--rate-retention-hours", "--max-rate-window-sec", "--audit-log", "--now-ms"]);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") usage(0);
    else if (arg === "--execute") opts.execute = true;
    else if (arg === "--vacuum") opts.vacuum = true;
    else if (arg === "--json") opts.json = true;
    else if (valueFlags.has(arg)) {
      const value = argv[++i];
      if (value === undefined || value === "") usage(2, `${arg} needs a value`);
      if (arg === "--file") opts.file = value;
      else if (arg === "--audit-log") opts.auditLog = value;
      else if (arg === "--rate-retention-hours") {
        if (!/^[1-9][0-9]*$/.test(value) || Number(value) < MIN_RETENTION_HOURS) {
          usage(2, `--rate-retention-hours must be an integer ≥ ${MIN_RETENTION_HOURS}`);
        }
        opts.retentionHours = Number(value);
      } else if (arg === "--max-rate-window-sec") {
        if (!/^[1-9][0-9]{0,9}$/.test(value)) usage(2, "--max-rate-window-sec must be a positive integer");
        opts.maxRateWindowSec = Number(value);
      } else if (arg === "--now-ms") {
        if (!/^(0|[1-9][0-9]{0,15})$/.test(value)) usage(2, "--now-ms must be a non-negative integer");
        opts.nowMs = BigInt(value);
      }
    } else usage(2, `unknown argument: ${arg}`);
  }
  if (!opts.file) usage(2, "missing required --file <v1.sqlite>");
  if (opts.vacuum && !opts.execute) usage(2, "--vacuum requires --execute");
  if (opts.maxRateWindowSec === undefined) {
    usage(2, "missing required --max-rate-window-sec <n> (largest of RATE_LIMIT_WINDOW_SEC / WORKER_RATE_LIMIT_WINDOW_SEC)");
  }
  if (opts.retentionHours * 3600 <= opts.maxRateWindowSec) {
    usage(2, `--rate-retention-hours (${opts.retentionHours}h) must be longer than --max-rate-window-sec (${opts.maxRateWindowSec}s); `
      + "a shorter retention would delete rows still inside a rate window");
  }
  opts.auditLog ??= `${opts.file}.prune-audit.log`;
  return opts;
}

function fileSizes(file) {
  const out = {};
  for (const suffix of ["", "-wal", "-shm"]) {
    const p = `${file}${suffix}`;
    if (existsSync(p)) out[suffix === "" ? "main" : suffix.slice(1)] = statSync(p).size;
  }
  return out;
}

function backupFile(file) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${file}.prune-backup-${timestamp}`;
  copyFileSync(file, backupPath);
  const siblingBackups = [];
  for (const suffix of ["-wal", "-shm"]) {
    if (existsSync(`${file}${suffix}`)) {
      copyFileSync(`${file}${suffix}`, `${backupPath}${suffix}`);
      siblingBackups.push(`${backupPath}${suffix}`);
    }
  }
  return { backupPath, siblingBackups };
}

function existingSidecars(file) {
  return new Set(["-wal", "-shm"].filter((suffix) => existsSync(`${file}${suffix}`)));
}

/**
 * A read-only open of a WAL-mode store makes SQLite create `-shm` (and an
 * empty `-wal`). A dry run must leave the directory as it found it, so remove
 * exactly the sidecars this run created — only after our connection is closed
 * and while the guards have established nobody else has the file open. A
 * non-empty `-wal` is never removed.
 */
function removeSidecarsCreatedByUs(file, before) {
  for (const suffix of ["-wal", "-shm"]) {
    const p = `${file}${suffix}`;
    if (before.has(suffix) || !existsSync(p)) continue;
    if (suffix === "-wal" && statSync(p).size !== 0) continue;
    unlinkSync(p);
  }
}

function missingTables(db) {
  const present = new Set(
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name),
  );
  return REQUIRED_TABLES.filter((name) => !present.has(name));
}

function minBig(a, b) {
  return a < b ? a : b;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const { file } = opts;
  const invokedAt = new Date().toISOString();
  let invokedBy;
  try { invokedBy = os.userInfo().username; } catch { invokedBy = "unknown"; }

  if (!existsSync(file)) abort(`${file} does not exist`);

  const occupancy = checkFileOccupancy(file);
  if (!occupancy.ok) abort(`file-occupancy check inconclusive: ${occupancy.reason}`);
  if (occupancy.holders.length > 0) {
    abort(
      `${occupancy.holders.length} process(es) still hold the file open: `
      + occupancy.holders.map((h) => `${h.command} pid=${h.pid}`).join(", ")
      + ". Stop the broker first; a concurrent writer here makes live requests fail.",
    );
  }
  logStatus("file-occupancy check: 0 holders.");
  const brokers = checkNoBrokerProcess();
  if (!brokers.ok) abort(`broker-process check inconclusive: ${brokers.reason}`);
  if (brokers.matches.length > 0) {
    abort(`broker server process running: ${brokers.matches.map((m) => `pid=${m.pid}`).join(", ")}. Stop it first.`);
  }
  logStatus("broker-process check: 0 running broker processes.");

  // Execute mode: prove the audit log is writable BEFORE anything changes, so
  // a committed prune can always be recorded.
  if (opts.execute) {
    try {
      appendFileSync(opts.auditLog, "", { encoding: "utf8", mode: 0o600 });
    } catch (error) {
      abort(`audit log ${opts.auditLog} is not writable (${error.code ?? error.message}); nothing was changed.`);
    }
  }

  // Read-only inspection first: a dry run must never write, and a file that
  // is not a V1 store must never be initialized.
  const sidecarsBefore = existingSidecars(file);
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    db.prepare("SELECT 1 FROM sqlite_master LIMIT 1").get();
  } catch (error) {
    if (db?.isOpen) db.close();
    abort(
      `cannot read ${file} read-only (${error instanceof Error ? error.message : String(error)}). `
      + "A hot rollback journal or unrecovered WAL means the last writer crashed; recover by starting "
      + "the broker once, stop it, then re-run. Nothing was changed.",
    );
  }
  const missing = missingTables(db);
  if (missing.length > 0) {
    db.close();
    removeSidecarsCreatedByUs(file, sidecarsBefore);
    abort(`${file} is not a shared-state V1 store (missing tables: ${missing.join(", ")}); refusing to touch it.`);
  }
  const floorText = readSharedStateSqliteClockFloorV1(db);
  const wallNowMs = opts.nowMs ?? BigInt(Date.now());
  const retentionMs = BigInt(opts.retentionHours) * HOUR_MS;

  const base = {
    tool: TOOL,
    file,
    invokedAt,
    invokedBy,
    checks: {
      fileOccupancy: { method: occupancy.method, filesChecked: occupancy.filesChecked, holders: occupancy.holders },
      brokerProcesses: { method: brokers.method, matches: brokers.matches },
    },
    rateRetentionHours: opts.retentionHours,
    maxRateWindowSec: opts.maxRateWindowSec,
    wallNowUnixMs: wallNowMs.toString(),
    clockFloorUnixMs: floorText,
    sizesBefore: fileSizes(file),
  };

  if (floorText !== null && (!/^(0|[1-9][0-9]*)$/.test(floorText) || BigInt(floorText) > MAX_SAFE_MS)) {
    db.close();
    removeSidecarsCreatedByUs(file, sidecarsBefore);
    abort(`persisted clock floor is not a canonical in-range millisecond value (${JSON.stringify(floorText)}); refusing to prune.`);
  }
  if (floorText === null || floorText === "0") {
    db.close();
    if (!opts.execute) removeSidecarsCreatedByUs(file, sidecarsBefore);
    const report = { ...base, dryRun: !opts.execute, outcome: "no_clock_floor" };
    if (opts.execute) appendFileSync(opts.auditLog, `${JSON.stringify(report)}\n`, { encoding: "utf8", mode: 0o600 });
    logStatus("persisted clock floor is absent or 0 — this store never observed a transaction; nothing to prune.");
    if (opts.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exit(0);
  }

  const effectiveNowMs = minBig(wallNowMs, BigInt(floorText));
  const rateCutoffMs = effectiveNowMs > retentionMs ? effectiveNowMs - retentionMs : 0n;
  const options = { nowUnixMs: effectiveNowMs, rateCostCutoffUnixMs: rateCutoffMs };
  const planned = countSharedStateSqlitePrunableV1(db, options);
  db.close();
  if (!opts.execute) removeSidecarsCreatedByUs(file, sidecarsBefore);

  const withPlan = {
    ...base,
    replayCutoffUnixMs: effectiveNowMs.toString(),
    rateCostCutoffUnixMs: rateCutoffMs.toString(),
    planned: {
      rateCostPrunable: planned.rateCostPrunable,
      rateCostTotal: planned.rateCostTotal,
      noncePrunable: planned.noncePrunable,
      nonceTotal: planned.nonceTotal,
    },
  };
  logStatus(
    `plan: rate_cost ${planned.rateCostPrunable}/${planned.rateCostTotal} rows < ${rateCutoffMs}, `
    + `replay_nonce ${planned.noncePrunable}/${planned.nonceTotal} rows < ${effectiveNowMs} `
    + `(floor ${floorText}, retention ${opts.retentionHours}h).`,
  );

  if (!opts.execute) {
    logStatus("DRY RUN: nothing was written (no backup, no delete, no audit entry). Re-run with --execute.");
    if (opts.json) process.stdout.write(`${JSON.stringify({ ...withPlan, dryRun: true, outcome: "dry_run" }, null, 2)}\n`);
    process.exit(0);
  }

  const { backupPath, siblingBackups } = backupFile(file);
  logStatus(`backed up ${file} to ${backupPath}${siblingBackups.length ? ` (+ ${siblingBackups.join(", ")})` : ""}.`);

  const audit = (entry) => appendFileSync(opts.auditLog, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
  const emit = (report, code) => {
    if (opts.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exit(code);
  };

  db = new DatabaseSync(file);
  let pruned;
  try {
    pruned = pruneSharedStateSqliteV1(db, options);
  } finally {
    if (pruned === undefined || pruned.rateCostDeleted < 0 || pruned.nonceDeleted < 0) db.close();
  }
  if (pruned.rateCostDeleted < 0 || pruned.nonceDeleted < 0) {
    const report = { ...withPlan, dryRun: false, outcome: "prune_rolled_back", backupPath, siblingBackups };
    audit(report);
    logStatus(`prune transaction failed and was rolled back; the file is unchanged (backup kept). audit log: ${opts.auditLog}`);
    if (opts.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exit(1);
  }

  // Record the committed prune immediately — before VACUUM can fail.
  const report = {
    ...withPlan,
    dryRun: false,
    outcome: "pruned",
    deleted: { rateCost: pruned.rateCostDeleted, replayNonce: pruned.nonceDeleted },
    backupPath,
    siblingBackups,
  };
  audit(report);
  logStatus(
    `pruned rate_cost=${pruned.rateCostDeleted} replay_nonce=${pruned.nonceDeleted} (committed). audit log: ${opts.auditLog}`,
  );

  if (!opts.vacuum) {
    db.close();
    emit({ ...report, vacuumed: false, sizesAfter: fileSizes(file) }, 0);
  }
  try {
    db.exec("VACUUM");
  } catch (error) {
    db.close();
    const failed = {
      ...report,
      outcome: "pruned_vacuum_failed",
      vacuumed: false,
      vacuumError: error instanceof Error ? error.message : String(error),
      sizesAfter: fileSizes(file),
    };
    audit(failed);
    logStatus(`VACUUM failed (${failed.vacuumError}); the prune itself is committed and audited.`);
    emit(failed, 3);
  }
  db.close();
  const vacuumedReport = { ...report, outcome: "pruned_vacuumed", vacuumed: true, sizesAfter: fileSizes(file) };
  audit(vacuumedReport);
  logStatus(`vacuumed; size ${report.sizesBefore.main} → ${vacuumedReport.sizesAfter.main} bytes.`);
  emit(vacuumedReport, 0);
}

try {
  main();
} catch (error) {
  logStatus(`unexpected error: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exit(1);
}
