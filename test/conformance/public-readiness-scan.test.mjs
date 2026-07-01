import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repo = path.resolve(new URL('../..', import.meta.url).pathname);
const script = path.join(repo, 'scripts/public-readiness-scan.mjs');
function run(files, env = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'public-readiness-'));
  for (const [name, body] of Object.entries(files)) {
    const p = path.join(cwd, name); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body);
  }
  return spawnSync(process.execPath, [script], { cwd, env: { ...process.env, ...env }, encoding: 'utf8' });
}

test('private a2a-plane URL fails closed', () => {
  const r = run({ 'README.md': 'see https://github.com/jinwon-int/a2a-plane/issues/1' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /private-a2a-plane-link/);
});

test('internal identifiers warn by default and fail in strict mode', () => {
  const warn = run({ 'docs/operators.md': 'seoseo broker placeholder' });
  assert.equal(warn.status, 0, warn.stderr);
  assert.match(warn.stdout, /internal-node-identifier/);
  const fail = run({ 'docs/operators.md': 'seoseo broker placeholder' }, { PUBLIC_READINESS_STRICT_INTERNAL: '1' });
  assert.notEqual(fail.status, 0);
});
