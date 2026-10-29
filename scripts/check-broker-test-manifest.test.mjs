import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  auditTestCoverage,
  commandsFromManifest,
  expandTestPatterns,
  loadTestManifest,
  testFilePatterns,
} from '../packages/broker/scripts/run-test-manifest.mjs';

// #2386: remove every temp dir this file creates.
const trackedTempDirs = [];
function trackTempDir(dir) {
  trackedTempDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of trackedTempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');
const BROKER_ROOT = join(REPO_ROOT, 'packages/broker');
const MANIFEST = join(BROKER_ROOT, 'scripts/test-manifest.json');

test('broker test manifest preserves the legacy command sequence', () => {
  const manifest = loadTestManifest(MANIFEST);
  const commands = commandsFromManifest(manifest);
  assert.equal(commands.length, manifest.entries.length);
  assert.equal(commands.join(' && '), manifest.legacyEquivalent);
});

test('broker package test delegates to the manifest runner', () => {
  const pkg = JSON.parse(readFileSync(join(BROKER_ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.test, 'node scripts/run-test-manifest.mjs');
});

test('broker test manifest --list prints the exact command set without running tests', () => {
  const manifest = loadTestManifest(MANIFEST);
  const res = spawnSync(process.execPath, [join(BROKER_ROOT, 'scripts/run-test-manifest.mjs'), '--list'], {
    cwd: BROKER_ROOT,
    encoding: 'utf8',
  });
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(res.stdout.trim().split('\n'), commandsFromManifest(manifest));
});

test('broker test manifest runner propagates failing command exit codes', () => {
  const dir = trackTempDir(mkdtempSync(join(tmpdir(), 'broker-test-manifest-')));
  const manifestPath = join(dir, 'test-manifest.json');
  writeFileSync(manifestPath, JSON.stringify({
    entries: [
      { name: 'fail', command: `${process.execPath} -e "process.exit(7)"` },
    ],
  }));
  const res = spawnSync(process.execPath, [join(BROKER_ROOT, 'scripts/run-test-manifest.mjs')], {
    cwd: BROKER_ROOT,
    env: { ...process.env, BROKER_TEST_MANIFEST_PATH: manifestPath },
    encoding: 'utf8',
  });
  assert.equal(res.status, 7);
  assert.match(res.stdout, /broker test manifest: step 1\/1/);
});

// #2453 PR-0: silent-test-loss guard (analyze.md Risks 1).

function treeWith(files) {
  const dir = trackTempDir(mkdtempSync(join(tmpdir(), 'broker-test-audit-')));
  for (const rel of files) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), '');
  }
  return dir;
}

test('testFilePatterns reads node --test operands, unquoting globs and skipping flags and other commands', () => {
  assert.deepEqual(
    testFilePatterns(`npm run build:tests && node --check a.mjs && node --test --test-concurrency=12 x.test.mjs 'dist/core/**/*.test.js' "dist/a/*.test.js"`),
    ['x.test.mjs', 'dist/core/**/*.test.js', 'dist/a/*.test.js'],
  );
  assert.deepEqual(testFilePatterns('npm run clean:dist'), []);
});

test('the core glob is recursive and does not double-count with a flat glob', () => {
  const dir = treeWith(['dist/core/a.test.js', 'dist/core/execution/b.test.js', 'dist/core/c.js']);
  assert.deepEqual(expandTestPatterns(['dist/core/*.test.js'], dir).files, [join('dist', 'core', 'a.test.js')]);
  const recursive = expandTestPatterns(['dist/core/**/*.test.js', 'dist/core/*.test.js'], dir);
  assert.deepEqual(recursive.files, [join('dist', 'core', 'a.test.js'), join('dist', 'core', 'execution', 'b.test.js')]);
  assert.deepEqual(recursive.empty, []);
});

test('the real manifest runs dist/core tests recursively', () => {
  const manifest = loadTestManifest(MANIFEST);
  const patterns = manifest.entries.flatMap((entry) => testFilePatterns(entry.command));
  assert.ok(patterns.includes('dist/core/**/*.test.js'), 'dist/core test glob must recurse into domain directories');
  assert.ok(!patterns.includes('dist/core/*.test.js'), 'the flat dist/core glob would silently skip moved tests');
});

test('auditTestCoverage fails a step whose patterns match 0 files and warns on a dead pattern', () => {
  const dir = treeWith(['src/core/a.test.ts', 'dist/core/a.test.js']);
  const audit = auditTestCoverage(
    { entries: [
      { name: 'ok', command: `node --test 'dist/core/**/*.test.js' dist/gone/*.test.js` },
      { name: 'empty', command: 'node --test dist/moved/*.test.js' },
    ] },
    dir,
  );
  assert.equal(audit.perEntry.get('ok'), 1);
  assert.equal(audit.perEntry.get('empty'), 0);
  assert.equal(audit.errors.length, 1);
  assert.match(audit.errors[0], /empty runs node --test but its patterns match 0 test files/);
  assert.deepEqual(audit.warnings, ['ok: pattern matches no file: dist/gone/*.test.js', 'empty: pattern matches no file: dist/moved/*.test.js']);
});

test('auditTestCoverage fails when a compiled test with a source is matched by no step (moved out of a flat glob)', () => {
  const dir = treeWith([
    'src/core/a.test.ts', 'dist/core/a.test.js',
    'src/core/execution/b.test.ts', 'dist/core/execution/b.test.js',
    'dist/core/stale.test.js', // cached output whose source is gone: ignored
  ]);
  const flat = auditTestCoverage({ entries: [{ name: 'flat', command: 'node --test dist/core/*.test.js' }] }, dir);
  assert.deepEqual(flat.uncovered, [join('dist', 'core', 'execution', 'b.test.js')]);
  assert.equal(flat.errors.length, 1);
  const recursive = auditTestCoverage({ entries: [{ name: 'rec', command: `node --test 'dist/core/**/*.test.js'` }] }, dir);
  assert.deepEqual(recursive.errors, []);
  assert.equal(recursive.total, 3);
});

test('broker test manifest runner fails before running a test step that matches no files', () => {
  const dir = trackTempDir(mkdtempSync(join(tmpdir(), 'broker-test-manifest-empty-')));
  const manifestPath = join(dir, 'test-manifest.json');
  writeFileSync(manifestPath, JSON.stringify({ entries: [{ name: 'gone', command: 'node --test dist/__no_such_dir__/*.test.js' }] }));
  const res = spawnSync(process.execPath, [join(BROKER_ROOT, 'scripts/run-test-manifest.mjs')], {
    cwd: BROKER_ROOT,
    env: { ...process.env, BROKER_TEST_MANIFEST_PATH: manifestPath },
    encoding: 'utf8',
  });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /gone runs node --test but its patterns match 0 test files/);
  assert.doesNotMatch(res.stdout, /step 1\/1: node --test/);
});
