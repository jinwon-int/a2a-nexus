import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { evaluateWorkflowActionPinning, loadWorkflowFiles } from './check-workflow-action-pinning.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(repo, 'scripts/check-workflow-action-pinning.mjs');
const SHA = '0123456789abcdef0123456789abcdef01234567';

const GOOD = `name: ok\non: push\npermissions:\n  contents: read\njobs:\n  build:\n    steps:\n      - uses: actions/checkout@${SHA} # v7\n`;
const TAG_PINNED = 'name: bad\non: push\njobs:\n  build:\n    steps:\n      - uses: actions/checkout@v7\n';
const MISSING_TAG_COMMENT = `name: bad\non: push\njobs:\n  build:\n    steps:\n      - uses: actions/checkout@${SHA}\n`;
const LOCAL_ACTION = 'name: ok\non: push\njobs:\n  build:\n    steps:\n      - uses: ./.github/actions/local\n';

test('workflow with full SHA pin and source tag comment passes', () => {
  assert.deepEqual(evaluateWorkflowActionPinning([{ name: 'ok.yml', content: GOOD }]), []);
});

test('tag-pinned workflow action fails closed', () => {
  const failures = evaluateWorkflowActionPinning([{ name: 'bad.yml', content: TAG_PINNED }]);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /not pinned to a full commit SHA/);
});

test('SHA-pinned workflow action keeps source tag comment for updateability', () => {
  const failures = evaluateWorkflowActionPinning([{ name: 'bad.yml', content: MISSING_TAG_COMMENT }]);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /trailing comment/);
});

test('local actions are exempt from external SHA pinning', () => {
  assert.deepEqual(evaluateWorkflowActionPinning([{ name: 'local.yml', content: LOCAL_ACTION }]), []);
});

test('an empty workflows directory fails closed', () => {
  assert.deepEqual(evaluateWorkflowActionPinning([]), [
    'no workflow files found under .github/workflows — fail closed',
  ]);
});

test('every committed external workflow action is SHA-pinned', () => {
  const files = loadWorkflowFiles(path.join(repo, '.github/workflows'));
  assert.ok(files.length >= 5, 'expected the known workflow set to be present');
  assert.deepEqual(evaluateWorkflowActionPinning(files), []);
});

test('cli fails closed on a tag-pinned workflow action', () => {
  const r = spawnSync(process.execPath, [script], {
    cwd: repo,
    env: { ...process.env, WORKFLOWS_DIR: 'does-not-exist' },
    encoding: 'utf8',
  });
  assert.notEqual(r.status, 0);
});
