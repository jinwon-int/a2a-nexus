/**
 * Fail-closed "is this shared-state file really offline?" guards, shared by
 * the host-side shared-state operator tools (#2129 `shared-state-fence-clear`,
 * #1504 P1 `shared-state-v1-prune`). Moved verbatim out of
 * `shared-state-fence-clear.mjs`; behavior is unchanged and still covered by
 * that script's tests (stub `lsof`/`ps` on PATH).
 *
 * Both checks return `{ ok: true, ... }` only on an output shape they fully
 * understood, and `{ ok: false, reason }` (inconclusive) on anything else.
 */
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

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
export const BROKER_PROCESS_PATTERN = /(?:^|[\s/\\])(?:packages[/\\]broker[/\\])?dist[/\\]server\.js(?=\s|$)/;

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
export function checkFileOccupancy(filePath) {
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
export function checkNoBrokerProcess() {
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
