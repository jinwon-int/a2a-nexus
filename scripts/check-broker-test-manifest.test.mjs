import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { commandsFromManifest, loadTestManifest } from '../packages/broker/scripts/run-test-manifest.mjs';

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
