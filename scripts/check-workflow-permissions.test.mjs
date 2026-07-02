import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { evaluateWorkflowPermissions, loadWorkflowFiles } from './check-workflow-permissions.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(repo, 'scripts/check-workflow-permissions.mjs');

const GOOD = 'name: ok\non: push\npermissions:\n  contents: read\njobs: {}\n';
const MISSING = 'name: bad\non: push\njobs:\n  build:\n    permissions:\n      contents: read\n';
const WRITE_ALL = 'name: bad\non: push\npermissions: write-all\njobs: {}\n';

test('workflow with a top-level permissions block passes', () => {
  assert.deepEqual(evaluateWorkflowPermissions([{ name: 'ok.yml', content: GOOD }]), []);
});

test('job-level-only permissions do not satisfy the top-level requirement', () => {
  const failures = evaluateWorkflowPermissions([{ name: 'bad.yml', content: MISSING }]);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /bad\.yml: missing top-level permissions block/);
});

test('write-all fails closed', () => {
  const failures = evaluateWorkflowPermissions([{ name: 'lazy.yml', content: WRITE_ALL }]);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /write-all/);
});

test('an empty workflows directory fails closed', () => {
  assert.deepEqual(evaluateWorkflowPermissions([]), [
    'no workflow files found under .github/workflows — fail closed',
  ]);
});

test('every committed workflow declares a top-level permissions block', () => {
  const files = loadWorkflowFiles(path.join(repo, '.github/workflows'));
  assert.ok(files.length >= 5, 'expected the known workflow set to be present');
  assert.deepEqual(evaluateWorkflowPermissions(files), []);
});

test('cli fails closed when a workflow is missing the block', () => {
  const r = spawnSync(process.execPath, [script], {
    cwd: repo,
    env: { ...process.env, WORKFLOWS_DIR: 'does-not-exist' },
    encoding: 'utf8',
  });
  assert.notEqual(r.status, 0);
});
