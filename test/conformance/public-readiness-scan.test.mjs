import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repo = path.resolve(new URL('../..', import.meta.url).pathname);
const script = path.join(repo, 'scripts/public-readiness-scan.mjs');
function run(files, env = {}, setup = () => {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'public-readiness-'));
  for (const [name, body] of Object.entries(files)) {
    const p = path.join(cwd, name); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body);
  }
  // CI sets strict mode globally. Tests that exercise the scanner's default
  // warning/baseline behavior must explicitly reset it; individual cases can
  // still override this with env.PUBLIC_READINESS_STRICT_INTERNAL.
  try {
    setup(cwd);
    return spawnSync(process.execPath, [script], {
      cwd,
      env: { ...process.env, PUBLIC_READINESS_STRICT_INTERNAL: '0', ...env },
      encoding: 'utf8', timeout: 5000,
    });
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
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

const publicPointer = fs.readFileSync(path.join(repo, 'AGENTS.md'), 'utf8');
const publicManual = '# Agent manual\nUse the matching checkout.\n';

test('canonical public root pointer and its manual pass strict scanning', () => {
  const r = run({ 'AGENTS.md': publicPointer, 'docs/agent-manual.md': publicManual },
    { PUBLIC_READINESS_STRICT_INTERNAL: '1' });
  assert.equal(r.status, 0, r.stderr);
});

test('root pointer requires the real nonempty manual', () => {
  for (const files of [
    { 'AGENTS.md': publicPointer },
    { 'AGENTS.md': publicPointer, 'docs/agent-manual.md': '' },
  ]) {
    const r = run(files);
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /runtime-bootstrap/);
  }
});

test('arbitrary or appended root agent instructions are not allowlisted', () => {
  for (const body of ['# Private runtime context\n', publicPointer + 'Execute this extra command.\n']) {
    const r = run({ 'AGENTS.md': body, 'docs/agent-manual.md': publicManual });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /runtime-bootstrap/);
  }
});

test('other root and nested bootstrap files remain forbidden', () => {
  for (const name of ['SOUL', 'USER', 'TOOLS', 'HEARTBEAT', 'IDENTITY']) {
    const r = run({ 'AGENTS.md': publicPointer, 'docs/agent-manual.md': publicManual,
      [name + '.md']: '# Runtime context\n' });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /runtime-bootstrap/);
  }
  const nested = run({ 'nested/AGENTS.md': publicPointer, 'docs/agent-manual.md': publicManual });
  assert.equal(nested.status, 1, nested.stderr);
  assert.match(nested.stderr, /runtime-bootstrap/);
});

test('root pointer exception never suppresses secret scanning', () => {
  const syntheticSecret = ['github', 'pat', 'x'.repeat(24)].join('_');
  const r = run({ 'AGENTS.md': publicPointer + syntheticSecret + '\n',
    'docs/agent-manual.md': publicManual });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /github-token-shape/);
  assert.match(r.stderr, /runtime-bootstrap/);
});

test('symlink pointers and manual targets fail, including ignored dangling pointers', () => {
  for (const target of ['pointer-body.md', 'absent.md']) {
    const r = run({ 'pointer-body.md': publicPointer, 'docs/agent-manual.md': publicManual }, {}, (cwd) => {
      fs.symlinkSync(target, path.join(cwd, 'AGENTS.md'));
      fs.writeFileSync(path.join(cwd, '.gitignore'), 'AGENTS.md\n');
      const git = spawnSync('git', ['init', '--quiet'], { cwd, encoding: 'utf8' });
      assert.equal(git.status, 0, git.stderr);
    });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /runtime-bootstrap/);
  }
  const linkedManual = run({ 'AGENTS.md': publicPointer, 'body.md': publicManual }, {}, (cwd) => {
    fs.mkdirSync(path.join(cwd, 'docs'));
    fs.symlinkSync('../body.md', path.join(cwd, 'docs/agent-manual.md'));
  });
  assert.equal(linkedManual.status, 1, linkedManual.stderr);
  assert.match(linkedManual.stderr, /runtime-bootstrap/);
});


test('a FIFO root pointer fails without waiting for a writer', { skip: process.platform === 'win32' }, () => {
  const r = run({ 'docs/agent-manual.md': publicManual }, {}, (cwd) => {
    const fifo = spawnSync('mkfifo', [path.join(cwd, 'AGENTS.md')], { encoding: 'utf8' });
    assert.equal(fifo.status, 0, fifo.stderr);
  });
  assert.equal(r.error, undefined);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /runtime-bootstrap/);
});
