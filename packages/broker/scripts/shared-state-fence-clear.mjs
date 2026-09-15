#!/usr/bin/env node
/**
 * #2129 operator tool: fail-closed clearing of a stuck shared-state serving
 * fence `owner_token`.
 *
 * Background: the serving fence (`src/shared-state-serving-fence-v1.ts`)
 * implements decision A1 from #1504 — there is no lease, so a broker
 * container that crashes (e.g. SIGKILLed by Docker Compose before it drains)
 * leaves `shared_state_ownership.owner_token` set. Every later broker on that
 * file then fails closed with `ownership_conflict` (`assertSharedStateServingFenceV1`),
 * because the design cannot tell "stale token, safe to clear" from "another
 * live broker holds this". That fail-closed behavior is intentional and
 * correct; #2129 is that on 2026-09-12 the only available recovery was a
 * hand-run `python3`/sqlite3 `UPDATE shared_state_ownership SET owner_token
 * = NULL WHERE id = 1`, done under incident pressure with no tooling, no
 * required verification, and no audit trail.
 *
 * This script is the tooled replacement. It clears `owner_token` ONLY after
 * verifying, itself, that:
 *   1. no OS process holds an open handle on the fence file (or its -wal/-shm
 *      siblings) — checked via `lsof`;
 *   2. no broker server process (`dist/server.js`) is running anywhere on
 *      this host — checked via `ps -eo pid,args`.
 *
 * If either check cannot be performed with confidence (the tool is missing,
 * errors, or returns something this script does not recognize), the script
 * aborts without touching anything — it never assumes "probably fine" on an
 * inconclusive check. This mirrors the fence's own fail-closed posture: an
 * operator tool that guesses wrong here re-creates the exact ownership_conflict
 * crash loop it exists to fix, or worse, lets two brokers write at once.
 *
 * `lifecycle_epoch` and `acquired_at_unix_ms` are never modified — the epoch
 * is bumped by the broker itself on its next successful acquisition
 * (`SharedStateSqliteAdapterV1.open()`), not by this tool.
 *
 * Usage:
 *   node scripts/shared-state-fence-clear.mjs --file <path/to/state.json.shared-state-v1.sqlite> --dry-run
 *   node scripts/shared-state-fence-clear.mjs --file <path/to/state.json.shared-state-v1.sqlite>
 *
 * Options:
 *   --file <path>       Required. The fence sqlite file — the same path the
 *                        broker resolves from BROKER_SHARED_STATE_FILE or
 *                        `${STATE_FILE}.shared-state-v1.sqlite`.
 *   --dry-run            Report what the checks found and what WOULD happen,
 *                        without writing anything (no backup, no UPDATE, no
 *                        audit-log entry — a dry run leaves no trace other
 *                        than its own stdout/stderr).
 *   --audit-log <path>   Where to append the JSON-lines audit log. Defaults
 *                        to `<file>.fence-clear-audit.log` next to the fence
 *                        file.
 *   --json               Emit the final report as JSON on stdout (in
 *                        addition to the human-readable stderr status lines).
 *
 * Exit codes: 0 on success (including "already clear" and dry-run), 1 on any
 * fail-closed abort or unexpected error, 2 on argument/usage errors.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync } from "node:fs";
import os from "node:os";
import process from "node:process";

// Kept in sync with shared-state-sqlite-schema-v1.ts's ownership row shape;
// this script deliberately does not import the schema-creation helper (see
// `readOwnershipRow` below) so it can never silently initialize a schema on
// a file that turns out not to be a real fence file.
const OWNERSHIP_ROW_ID = 1;
const DEFAULT_AUDIT_LOG_SUFFIX = ".fence-clear-audit.log";

// Matches the broker's actual running-process shape: `CMD ["node",
// "packages/broker/dist/server.js"]` in Dockerfile, `"start": "node
// dist/server.js"` in package.json. Matched against the full command line so
// it catches every documented invocation form:
//   node dist/server.js                              (bare, from packages/broker)
//   node packages/broker/dist/server.js              (repo-root relative)
//   /usr/local/bin/node /app/packages/broker/dist/server.js  (absolute)
// The leading boundary therefore admits whitespace as well as a path
// separator — anchoring only on `^` or a separator missed the bare form,
// which is exactly the one `npm start` produces. It stays a boundary rather
// than a bare substring so an unrelated `.../mydist/server.js` does not
// register as a broker.
const BROKER_PROCESS_PATTERN = /(?:^|[\s/\\])(?:packages[/\\]broker[/\\])?dist[/\\]server\.js(?=\s|$)/;

// `lsof` prints `COMMAND   PID USER ...` above its holder rows; `ps -eo
// pid,args` prints `  PID COMMAND` (some implementations say ARGS/CMD) above
// its process rows. Output that does not start with the expected header is
// not something this script can claim to have understood, so it fails closed
// rather than reading "no rows" as "zero holders".
const LSOF_HEADER_PATTERN = /^COMMAND\s+PID\b/i;
const PS_HEADER_PATTERN = /^\s*PID\s+(?:COMMAND|ARGS|CMD)\b/i;
const PS_ROW_PATTERN = /^\s*(\d+)\s+(\S.*)$/;

function inconclusive(reason) {
  return { ok: false, reason };
}

function describeExit(result) {
  return result.status === null ? `was killed by ${result.signal ?? "a signal"}` : `exited ${result.status}`;
}

function nonEmptyLines(text) {
  return (text ?? "").split("\n").filter((line) => line.trim() !== "");
}

function usage(exitCode) {
  const stream = exitCode === 0 ? process.stdout : process.stderr;
  stream.write(`Usage: node scripts/shared-state-fence-clear.mjs --file <fence.sqlite> [--dry-run] [--audit-log <path>] [--json]\n\n`);
  stream.write(`Fail-closed: clears shared_state_ownership.owner_token ONLY after verifying\n`);
  stream.write(`zero file-lock holders (lsof) and zero running broker processes (ps).\n`);
  stream.write(`lifecycle_epoch and acquired_at_unix_ms are never modified.\n\n`);
  stream.write(`Options:\n`);
  stream.write(`  --file <path>       Required. Path to the *.shared-state-v1.sqlite fence file.\n`);
  stream.write(`  --dry-run           Report findings and intended action; write nothing.\n`);
  stream.write(`  --audit-log <path>  Defaults to <file>.fence-clear-audit.log.\n`);
  stream.write(`  --json              Also print the final report as JSON on stdout.\n`);
  stream.write(`  --help              Show this help.\n`);
  process.exit(exitCode);
}

function argValue(argv, name) {
  const prefix = `${name}=`;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === name) return argv[i + 1];
    if (arg.startsWith(prefix)) return arg.slice(prefix.length);
  }
  return undefined;
}

function hasFlag(argv, name) {
  return argv.includes(name);
}

function logStatus(message) {
  process.stderr.write(`shared-state-fence-clear: ${message}\n`);
}

function abort(reason) {
  logStatus(`ABORT — ${reason}`);
  process.exit(1);
}

/**
 * "파일 점유자 0" (zero file-lock holders). `lsof <files>` exits 0 with a
 * header row plus one line per (process, file) holder, or exits 1 with empty
 * stdout/stderr when nothing holds any of the given files — a normal,
 * expected outcome, not an error. Exactly those two shapes are accepted.
 * Anything else — missing binary, non-empty stderr, output on the exit-1
 * "nothing found" path, exit 0 with empty/header-only/unparseable output, an
 * unexpected exit code or a signal death — is inconclusive and fails closed:
 * this script must never proceed on "lsof didn't clearly say zero."
 */
function checkFileOccupancy(filePath) {
  const candidates = [filePath, `${filePath}-wal`, `${filePath}-shm`].filter(existsSync);
  if (candidates.length === 0) {
    return inconclusive(`nothing left to probe: ${filePath} disappeared before the lsof check ran`);
  }
  const result = spawnSync("lsof", ["--", ...candidates], { encoding: "utf8" });
  if (result.error) {
    return inconclusive(`could not run lsof: ${result.error.message}`);
  }
  const stdout = (result.stdout ?? "").trim();
  const stderr = (result.stderr ?? "").trim();
  if (result.status === 0) {
    // Exit 0 means "holders found", so it must come with a header row and at
    // least one holder row. Empty, header-only, or unparseable output is a
    // shape this script does not recognize — never read it as zero holders.
    if (stderr !== "") {
      return inconclusive(`lsof exited 0 but also wrote to stderr: ${stderr}`);
    }
    const lines = nonEmptyLines(stdout);
    if (lines.length === 0) {
      return inconclusive("lsof exited 0 (holders found) but printed no output; zero holders is reported as exit 1 with no output");
    }
    if (!LSOF_HEADER_PATTERN.test(lines[0])) {
      return inconclusive(`lsof exited 0 with an unrecognized header row: ${JSON.stringify(lines[0])}`);
    }
    if (lines.length === 1) {
      return inconclusive("lsof exited 0 (holders found) with a header row but no holder rows");
    }
    const holders = [];
    for (const line of lines.slice(1)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 2 || !/^\d+$/.test(parts[1])) {
        return inconclusive(`lsof printed a holder row this script cannot parse: ${JSON.stringify(line)}`);
      }
      holders.push({ command: parts[0], pid: parts[1] });
    }
    return { ok: true, method: "lsof", filesChecked: candidates, holders };
  }
  if (result.status === 1) {
    // Exit 1 is the "nothing found" code, and it is only believable when it
    // comes with no output at all on either stream.
    if (stderr !== "") {
      return inconclusive(`lsof reported an error (exit 1): ${stderr}`);
    }
    if (stdout !== "") {
      return inconclusive(
        `lsof exited 1 (the "nothing found" code) but still printed output: ${JSON.stringify(nonEmptyLines(stdout)[0] ?? stdout)}`,
      );
    }
    return { ok: true, method: "lsof", filesChecked: candidates, holders: [] };
  }
  return inconclusive(`lsof ${describeExit(result)} (expected 0 or 1): ${stderr}`);
}

/**
 * "다른 브로커 프로세스 0" (zero other broker processes). Scans the host's
 * process table for anything running the broker's actual entrypoint
 * (`dist/server.js`, see Dockerfile's CMD and package.json's `start`
 * script), in its bare, repo-relative and absolute invocation forms. Any
 * failure to read or parse the process table — a non-zero exit, output on
 * stderr, a missing/unrecognized header, an empty table, or a single row
 * this script cannot parse — fails closed. This must never report "no broker
 * running" on an inconclusive read, and it must never reach that verdict by
 * skipping rows it did not understand.
 */
function checkNoBrokerProcess() {
  const result = spawnSync("ps", ["-eo", "pid,args"], { encoding: "utf8" });
  if (result.error) {
    return inconclusive(`could not run ps: ${result.error.message}`);
  }
  const stderr = (result.stderr ?? "").trim();
  if (result.status !== 0) {
    return inconclusive(`ps ${describeExit(result)}: ${stderr}`);
  }
  if (stderr !== "") {
    return inconclusive(`ps exited 0 but also wrote to stderr: ${stderr}`);
  }
  const lines = nonEmptyLines(result.stdout);
  if (lines.length === 0) {
    return inconclusive("ps exited 0 but printed no process table at all");
  }
  if (!PS_HEADER_PATTERN.test(lines[0])) {
    return inconclusive(`ps exited 0 with an unrecognized header row: ${JSON.stringify(lines[0])}`);
  }
  const rows = lines.slice(1);
  if (rows.length === 0) {
    // `ps -e` always sees at least itself, so a header with no rows means the
    // process table was not actually read — not that the host is idle.
    return inconclusive("ps exited 0 with a header row but no process rows");
  }
  const matches = [];
  for (const rawLine of rows) {
    const parsed = PS_ROW_PATTERN.exec(rawLine);
    if (parsed === null) {
      // A row this script cannot parse might be the broker. Skipping it would
      // turn an unreadable process table into a "no broker running" verdict.
      return inconclusive(`ps printed a process row this script cannot parse: ${JSON.stringify(rawLine)}`);
    }
    const [, pid, args] = parsed;
    if (BROKER_PROCESS_PATTERN.test(args.trim())) {
      matches.push({ pid, args: args.trim() });
    }
  }
  return { ok: true, method: "ps -eo pid,args", pattern: BROKER_PROCESS_PATTERN.source, matches };
}

/**
 * Reads the ownership row directly rather than through
 * `applySharedStateSqliteSchemaV1` — that helper creates the schema if it is
 * absent, which is the right behavior for the broker opening its own fence
 * but the wrong behavior for a clear tool: if `--file` does not point at a
 * real fence file, this script must fail closed on "table missing", never
 * silently initialize one.
 */
async function readOwnershipRow(filePath) {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(filePath, { timeout: 0 });
  try {
    const row = db
      .prepare(
        `SELECT owner_token, lifecycle_epoch, acquired_at_unix_ms
           FROM shared_state_ownership WHERE id = ?`,
      )
      .get(OWNERSHIP_ROW_ID);
    if (!row) {
      throw new Error(`no shared_state_ownership row with id=${OWNERSHIP_ROW_ID}`);
    }
    return {
      ownerToken: typeof row.owner_token === "string" ? row.owner_token : null,
      lifecycleEpoch: row.lifecycle_epoch,
      acquiredAtUnixMs: row.acquired_at_unix_ms,
    };
  } finally {
    db.close();
  }
}

async function clearOwnerToken(filePath) {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(filePath, { timeout: 0 });
  try {
    db.exec("PRAGMA journal_mode=WAL");
    db.exec("PRAGMA synchronous=FULL");
    db.exec("BEGIN IMMEDIATE");
    // Only owner_token, exactly as the incident's manual recovery command did
    // — lifecycle_epoch and acquired_at_unix_ms are left untouched.
    db.prepare(`UPDATE shared_state_ownership SET owner_token = NULL WHERE id = ?`)
      .run(OWNERSHIP_ROW_ID);
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // best-effort; the outer error is what matters
    }
    throw error;
  } finally {
    db.close();
  }
}

function backupFile(filePath) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${filePath}.fence-clear-backup-${timestamp}`;
  copyFileSync(filePath, backupPath);
  const siblingBackups = [];
  for (const suffix of ["-wal", "-shm"]) {
    const siblingPath = `${filePath}${suffix}`;
    if (existsSync(siblingPath)) {
      const siblingBackupPath = `${backupPath}${suffix}`;
      copyFileSync(siblingPath, siblingBackupPath);
      siblingBackups.push(siblingBackupPath);
    }
  }
  return { backupPath, siblingBackups };
}

function appendAuditLog(auditLogPath, entry) {
  appendFileSync(auditLogPath, `${JSON.stringify(entry)}\n`, { encoding: "utf8" });
}

async function main() {
  const argv = process.argv.slice(2);
  if (hasFlag(argv, "--help") || hasFlag(argv, "-h")) usage(0);

  const filePath = argValue(argv, "--file");
  if (!filePath) {
    process.stderr.write("Missing required --file <fence.sqlite>.\n\n");
    usage(2);
    return;
  }
  const dryRun = hasFlag(argv, "--dry-run");
  const emitJson = hasFlag(argv, "--json");
  const auditLogPath = argValue(argv, "--audit-log") ?? `${filePath}${DEFAULT_AUDIT_LOG_SUFFIX}`;

  if (!existsSync(filePath)) {
    abort(`fence file does not exist: ${filePath}`);
    return;
  }

  const invokedAt = new Date().toISOString();
  const invokedBy = os.userInfo().username;

  logStatus(`checking for file-lock holders on ${filePath} (and -wal/-shm siblings) via lsof...`);
  const occupancy = checkFileOccupancy(filePath);
  if (!occupancy.ok) {
    abort(`file-occupancy check could not be performed confidently — ${occupancy.reason}. Refusing to guess; clear nothing.`);
    return;
  }
  if (occupancy.holders.length > 0) {
    abort(
      `${occupancy.holders.length} process(es) still hold the fence file open: `
      + occupancy.holders.map((h) => `${h.command}(pid=${h.pid})`).join(", ")
      + ". A process with the file open may still be the legitimate owner (or mid-shutdown) — clearing now could race a live release.",
    );
    return;
  }
  logStatus("file-occupancy check: 0 holders.");

  logStatus("checking for running broker processes via ps...");
  const brokerProcesses = checkNoBrokerProcess();
  if (!brokerProcesses.ok) {
    abort(`broker-process check could not be performed confidently — ${brokerProcesses.reason}. Refusing to guess; clear nothing.`);
    return;
  }
  if (brokerProcesses.matches.length > 0) {
    abort(
      `${brokerProcesses.matches.length} broker process(es) are running on this host: `
      + brokerProcesses.matches.map((m) => `pid=${m.pid} (${m.args})`).join(", ")
      + ". Clearing the token while a broker may hold it risks a second, concurrent owner.",
    );
    return;
  }
  logStatus("broker-process check: 0 running broker processes.");

  let row;
  try {
    row = await readOwnershipRow(filePath);
  } catch (error) {
    abort(
      `could not read shared_state_ownership from ${filePath} — ${error instanceof Error ? error.message : String(error)}. `
      + "This may not be a shared-state serving fence file; refusing to modify it.",
    );
    return;
  }

  const baseReport = {
    tool: "shared-state-fence-clear",
    file: filePath,
    invokedAt,
    invokedBy,
    checks: {
      fileOccupancy: { method: occupancy.method, filesChecked: occupancy.filesChecked, holders: occupancy.holders },
      brokerProcesses: { method: brokerProcesses.method, matches: brokerProcesses.matches },
    },
    previousOwnerToken: row.ownerToken,
    lifecycleEpoch: row.lifecycleEpoch,
    acquiredAtUnixMs: row.acquiredAtUnixMs,
  };

  if (row.ownerToken === null) {
    logStatus("owner_token is already NULL — nothing to clear.");
    const report = { ...baseReport, dryRun, outcome: "already_clear" };
    if (!dryRun) {
      appendAuditLog(auditLogPath, report);
      logStatus(`audit log: ${auditLogPath}`);
    }
    if (emitJson) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exit(0);
    return;
  }

  if (dryRun) {
    logStatus(
      `DRY RUN: would back up ${filePath} (and -wal/-shm if present), then clear owner_token `
      + `(currently ${row.ownerToken}) on id=${OWNERSHIP_ROW_ID}. lifecycle_epoch (${row.lifecycleEpoch}) `
      + "would NOT be modified. No files were written; no audit-log entry was recorded for a dry run.",
    );
    const report = { ...baseReport, dryRun: true, outcome: "dry_run" };
    if (emitJson) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exit(0);
    return;
  }

  const { backupPath, siblingBackups } = backupFile(filePath);
  logStatus(`backed up fence file to ${backupPath}${siblingBackups.length > 0 ? ` (+ ${siblingBackups.join(", ")})` : ""}.`);

  await clearOwnerToken(filePath);
  logStatus(`cleared owner_token on ${filePath} (id=${OWNERSHIP_ROW_ID}); lifecycle_epoch left at ${row.lifecycleEpoch}.`);

  const report = {
    ...baseReport,
    dryRun: false,
    outcome: "cleared",
    backupPath,
    siblingBackups,
  };
  appendAuditLog(auditLogPath, report);
  logStatus(`audit log: ${auditLogPath}`);
  if (emitJson) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exit(0);
}

main().catch((error) => {
  logStatus(`unexpected error: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exit(1);
});
