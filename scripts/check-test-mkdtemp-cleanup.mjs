#!/usr/bin/env node
// Ratchet guard: no NEW test file may create temp dirs without cleaning up (#2386).
//
// A test file "leaks" when it calls mkdtemp/mkdtempSync but contains none of
// the cleanup markers below. Files that leaked when this guard landed are
// listed in scripts/test-mkdtemp-cleanup-baseline.json and stay allowed; any
// other leaking test file fails the gate. Fixing a baselined file is welcome:
// the guard then reports it as removable from the baseline (a notice, not a
// failure). The test runners also isolate TMPDIR per run (scripts/lib/
// test-tmpdir.mjs), so this guard is about tests that run outside them too
// (single-file `node --test`, IDEs, worker nodes).
//
// Usage: node scripts/check-test-mkdtemp-cleanup.mjs [--json] [--write-baseline]
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(SCRIPT_DIR, '..');
export const BASELINE_PATH = join(SCRIPT_DIR, 'test-mkdtemp-cleanup-baseline.json');

const TEST_FILE = /\.test\.(?:[cm]?js|[cm]?ts)$/;
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'coverage', '.local']);
const MKDTEMP = /\bmkdtemp(?:Sync)?\s*\(/;
// Any of these counts as the file taking responsibility for its temp dirs.
export const CLEANUP_MARKERS = [
  /\brmSync\s*\(/,
  /\brm\s*\(/,
  /\brmdirSync\s*\(/,
  /\brmdir\s*\(/,
  /\bafter(?:Each)?\s*\(/,
  /\bt\.after\s*\(/,
  /\bwithTempDir\s*\(/,
  /\bwithTmpDir\s*\(/,
];

export function leaksTempDirs(source) {
  if (!MKDTEMP.test(source)) return false;
  return !CLEANUP_MARKERS.some((marker) => marker.test(source));
}

export function listTestFiles(root = REPO_ROOT) {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (SKIP_DIRS.has(name)) continue;
      const path = join(dir, name);
      const info = statSync(path);
      if (info.isDirectory()) walk(path);
      else if (TEST_FILE.test(name)) out.push(relative(root, path).split(sep).join('/'));
    }
  };
  walk(root);
  return out.sort();
}

export function findLeakingTestFiles(root = REPO_ROOT) {
  return listTestFiles(root).filter((file) => leaksTempDirs(readFileSync(join(root, file), 'utf8')));
}

export function loadBaseline(path = BASELINE_PATH) {
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  if (!parsed || !Array.isArray(parsed.files)) throw new Error(`baseline ${path} needs a "files" array`);
  return parsed.files;
}

export function compareToBaseline(leaking, baseline) {
  const allowed = new Set(baseline);
  const current = new Set(leaking);
  return {
    newLeaks: leaking.filter((file) => !allowed.has(file)),
    removable: baseline.filter((file) => !current.has(file)),
  };
}

function main() {
  const args = new Set(process.argv.slice(2));
  const leaking = findLeakingTestFiles();
  if (args.has('--write-baseline')) {
    writeFileSync(
      BASELINE_PATH,
      `${JSON.stringify({
        note: 'Test files that call mkdtemp without any cleanup marker when the #2386 guard landed. Shrink only: fix a file, then remove it here.',
        files: leaking,
      }, null, 2)}\n`,
    );
    console.log(`test-mkdtemp-cleanup: wrote baseline with ${leaking.length} file(s)`);
    return;
  }
  const { newLeaks, removable } = compareToBaseline(leaking, loadBaseline());
  if (args.has('--json')) {
    console.log(JSON.stringify({ leaking: leaking.length, newLeaks, removable }, null, 2));
  }
  for (const file of removable) {
    console.log(`test-mkdtemp-cleanup: ${file} no longer leaks (or is gone) — remove it from the baseline`);
  }
  if (newLeaks.length) {
    for (const file of newLeaks) {
      console.error(
        `test-mkdtemp-cleanup: ${file} calls mkdtemp but never removes it — add rmSync(dir, { recursive: true, force: true }) in an after()/t.after()/finally`,
      );
    }
    process.exit(1);
  }
  console.log(`test-mkdtemp-cleanup: ok (${leaking.length} baselined leaking file(s), 0 new)`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
