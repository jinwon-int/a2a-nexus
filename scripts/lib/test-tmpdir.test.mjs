import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { KEEP_TEST_TMPDIR_ENV, createRunTmpdir, describeCleanup } from './test-tmpdir.mjs';

function privateBase(t) {
  const base = mkdtempSync(join(tmpdir(), 'a2a-run-tmpdir-test-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  return base;
}

test("#2386: a child's os.tmpdir() mkdtemp lands in the run dir and cleanup removes it", (t) => {
  const base = privateBase(t);
  const run = createRunTmpdir('a2a-run-', { base, env: { PATH: process.env.PATH } });
  assert.equal(run.env.TMPDIR, run.dir);
  assert.equal(run.env.TMP, run.dir);
  assert.equal(run.env.TEMP, run.dir);

  const child = spawnSync(
    process.execPath,
    ['-e', "const fs=require('fs'),os=require('os'),p=require('path');fs.mkdtempSync(p.join(os.tmpdir(),'leak-'));fs.mkdtempSync(p.join(os.tmpdir(),'leak-'));"],
    { env: run.env, encoding: 'utf8' },
  );
  assert.equal(child.status, 0, child.stderr);
  assert.equal(readdirSync(run.dir).length, 2);
  assert.deepEqual(readdirSync(base), [run.dir.slice(base.length + 1)]);

  const summary = run.cleanup();
  assert.deepEqual(summary, { dir: run.dir, entries: 2, kept: false });
  assert.equal(existsSync(run.dir), false);
  assert.match(describeCleanup('runner', summary), /removed: 2 top-level entries left by tests/);
  // Idempotent.
  assert.equal(run.cleanup().kept, false);
});

test(`#2386: ${KEEP_TEST_TMPDIR_ENV}=1 keeps the run dir for debugging`, (t) => {
  const base = privateBase(t);
  const run = createRunTmpdir('a2a-run-', { base, env: { [KEEP_TEST_TMPDIR_ENV]: '1' } });
  const summary = run.cleanup();
  assert.equal(summary.kept, true);
  assert.equal(existsSync(run.dir), true);
  assert.match(describeCleanup('runner', summary), /kept/);
});

test('#2386: the parent environment is not mutated', (t) => {
  const base = privateBase(t);
  const parent = { TMPDIR: '/original', KEEP: 'x' };
  const run = createRunTmpdir('a2a-run-', { base, env: parent });
  assert.equal(parent.TMPDIR, '/original');
  assert.equal(run.env.KEEP, 'x');
  run.cleanup();
});
