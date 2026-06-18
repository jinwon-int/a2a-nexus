import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const REPO_ROOT = resolve(new URL('../..', import.meta.url).pathname);
const RUNNER = join(REPO_ROOT, 'scripts/lib/doc-spec-check.mjs');

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'doc-spec-check-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runDriver(source, cwd = REPO_ROOT) {
  return withTempDir((dir) => {
    const driver = join(dir, 'driver.mjs');
    writeFileSync(driver, source);
    return spawnSync(process.execPath, [driver], { cwd, encoding: 'utf8' });
  });
}

test('runDocSpecCheck passes a minimal registered doc spec', () => {
  withTempDir((dir) => {
    mkdirSync(join(dir, 'docs/ops'), { recursive: true });
    mkdirSync(join(dir, 'fixtures'), { recursive: true });
    writeFileSync(join(dir, 'fixtures/f.json'), JSON.stringify({ schema: 'demo.v1', items: [{ name: 'a', ok: true }] }));
    writeFileSync(join(dir, 'doc.md'), 'hello registry');
    writeFileSync(join(dir, 'state.md'), 'state registry');
    writeFileSync(join(dir, 'extra.md'), 'extra registry context');
    mkdirSync(join(dir, 'pkg'), { recursive: true });
    writeFileSync(join(dir, 'pkg/package.json'), JSON.stringify({ name: '@demo/package', bin: { demo: 'cli.js' } }));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { 'check:demo': 'node scripts/check-demo.mjs' } }));
    writeFileSync(join(dir, 'docs/ops/release-gate-step-inventory.json'), JSON.stringify({ entries: [{ name: 'demo', tier: 'core', args: ['run', 'check:demo'] }] }));
    writeFileSync(join(dir, 'docs/ops/registry.json'), JSON.stringify({ checks: [{
      id: 'demo',
      fixture: 'fixtures/f.json',
      doc: 'doc.md',
      currentState: 'state.md',
      extraDocs: { extra: 'extra.md' },
      extraJson: { metadata: 'pkg/package.json' },
      packageScript: { name: 'check:demo', command: 'node scripts/check-demo.mjs' },
      releaseGateStep: { name: 'demo', tier: 'core', args: ['run', 'check:demo'] },
      assertions: [
        { path: 'schema', equals: 'demo.v1' },
        { path: 'schema', oneOf: ['demo.v1', 'demo.v2'] },
        { path: 'schema', notEquals: 'bad.v1' },
        { path: 'items', arraySome: { name: 'a', ok: true } },
        { path: 'items', arrayNoneMatches: { name: 'b' } },
        { path: 'items', lengthEquals: 1 },
        { path: 'items', lengthEquals: 999, when: { path: 'schema', equals: 'not-active' } },
        { source: 'doc', includes: 'registry' },
        { source: 'extra', includes: 'context' },
        { source: 'metadata', path: 'name', equals: '@demo/package' },
        { source: 'metadata', path: 'bin.demo', equals: 'cli.js' },
        { source: 'currentState', matches: 'state' }
      ],
      successMessage: 'demo ok'
    }] }));
    const res = runDriver(
      `import { runDocSpecCheck } from ${JSON.stringify(RUNNER)};\n` +
      `runDocSpecCheck('demo', { registryPath: 'docs/ops/registry.json' });\n`,
      dir,
    );
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /demo ok/);
  });
});

test('runDocSpecCheck fails when arrayNoneMatches finds a matching object', () => {
  withTempDir((dir) => {
    mkdirSync(join(dir, 'docs/ops'), { recursive: true });
    mkdirSync(join(dir, 'fixtures'), { recursive: true });
    writeFileSync(join(dir, 'fixtures/f.json'), JSON.stringify({ items: [{ name: 'blocked' }] }));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: {} }));
    writeFileSync(join(dir, 'docs/ops/release-gate-step-inventory.json'), JSON.stringify({ entries: [] }));
    writeFileSync(join(dir, 'docs/ops/registry.json'), JSON.stringify({ checks: [{
      id: 'blocked-array',
      fixture: 'fixtures/f.json',
      assertions: [
        { path: 'items', arrayNoneMatches: { name: 'blocked' }, message: 'blocked item absent' }
      ]
    }] }));
    const res = runDriver(
      `import { runDocSpecCheck } from ${JSON.stringify(RUNNER)};\n` +
      `runDocSpecCheck('blocked-array', { registryPath: 'docs/ops/registry.json' });\n`,
      dir,
    );
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /blocked item absent/);
  });
});

test('runDocSpecCheck fails closed on missing registry entry', () => {
  withTempDir((dir) => {
    mkdirSync(join(dir, 'docs/ops'), { recursive: true });
    writeFileSync(join(dir, 'docs/ops/registry.json'), JSON.stringify({ checks: [] }));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: {} }));
    writeFileSync(join(dir, 'docs/ops/release-gate-step-inventory.json'), JSON.stringify({ entries: [] }));
    const res = runDriver(
      `import { runDocSpecCheck } from ${JSON.stringify(RUNNER)};\n` +
      `runDocSpecCheck('missing', { registryPath: 'docs/ops/registry.json' });\n`,
      dir,
    );
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /missing check missing/);
  });
});
