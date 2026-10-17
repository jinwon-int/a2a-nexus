// Per-run temp directory for test runners (#2386).
//
// Tests across this repo call mkdtemp under os.tmpdir() ~885 times and many
// never remove what they create; on worker nodes that re-run the suites, /tmp
// accumulated tens of thousands of entries. Instead of fixing every call site,
// the runners point TMPDIR/TMP/TEMP of the child test processes at one fresh
// directory and remove it when the run ends. `os.tmpdir()` re-reads TMPDIR on
// every call, so child code needs no change.
//
// Set A2A_KEEP_TEST_TMPDIR=1 to keep the directory for debugging.
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const KEEP_TEST_TMPDIR_ENV = 'A2A_KEEP_TEST_TMPDIR';

/**
 * Create a run-scoped temp directory and the environment that routes a child
 * process's temp files into it.
 *
 * @param {string} prefix mkdtemp prefix, e.g. "a2a-release-gate-"
 * @param {{ env?: NodeJS.ProcessEnv, base?: string }} [options]
 * @returns {{ dir: string, env: NodeJS.ProcessEnv, cleanup: () => { dir: string, entries: number, kept: boolean } }}
 */
export function createRunTmpdir(prefix, { env = process.env, base = tmpdir() } = {}) {
  const dir = mkdtempSync(join(base, prefix));
  const childEnv = { ...env, TMPDIR: dir, TMP: dir, TEMP: dir };
  let done = false;
  return {
    dir,
    env: childEnv,
    cleanup() {
      let entries = 0;
      try {
        entries = readdirSync(dir).length;
      } catch {
        entries = 0;
      }
      if (done) return { dir, entries, kept: false };
      done = true;
      if (env[KEEP_TEST_TMPDIR_ENV] === '1') return { dir, entries, kept: true };
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Best-effort: a cleanup failure must never change the test verdict.
      }
      return { dir, entries, kept: false };
    },
  };
}

/** One human-readable summary line for runner output. */
export function describeCleanup(label, { dir, entries, kept }) {
  return kept
    ? `${label}: test TMPDIR kept (${KEEP_TEST_TMPDIR_ENV}=1): ${dir} (${entries} top-level entries)`
    : `${label}: test TMPDIR removed: ${entries} top-level entries left by tests`;
}
