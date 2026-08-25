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
  // CI sets strict mode globally. Tests that exercise the scanner's default
  // warning/baseline behavior must explicitly reset it; individual cases can
  // still override this with env.PUBLIC_READINESS_STRICT_INTERNAL.
  return spawnSync(process.execPath, [script], {
    cwd,
    env: { ...process.env, PUBLIC_READINESS_STRICT_INTERNAL: '0', ...env },
    encoding: 'utf8',
  });
}

test('private a2a-plane URL fails closed', () => {
  const r = run({ 'README.md': 'see https://github.com/jinwon-int/a2a-plane/issues/1' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /private-a2a-plane-link/);
});

// Assembled at runtime so this test file never contains a scanner-matchable
// internal node identifier literal (the repo-wide scan would fail closed on it).
const internalIdentifierFixture = ['seo', 'seo'].join('') + ' broker placeholder';

test('internal identifiers warn by default and fail in strict mode', () => {
  const warn = run({ 'docs/operators.md': internalIdentifierFixture });
  assert.equal(warn.status, 0, warn.stderr);
  assert.match(warn.stdout, /internal-node-identifier/);
  const fail = run({ 'docs/operators.md': internalIdentifierFixture }, { PUBLIC_READINESS_STRICT_INTERNAL: '1' });
  assert.notEqual(fail.status, 0);
});


test('operator honorific variants fail closed', () => {
  const r = run({ 'docs/public-readiness.md': '\uC9C4\uC6D0\uB2D8 approval placeholder' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /operator-personal-name/);
});

test('internal identifier baseline ratchet fails when warnings exceed baseline', () => {
  const r = run({
    'docs/operators.md': internalIdentifierFixture,
    'docs/readiness/public-readiness-baseline.json': JSON.stringify({ internalNodeIdentifier: { warningCount: 0, fileCount: 0 } }),
  });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /internal-node-baseline-exceeded/);
});
