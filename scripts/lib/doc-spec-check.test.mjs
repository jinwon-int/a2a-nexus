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
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { 'check:demo': 'node scripts/check-demo.mjs' } }));
    writeFileSync(join(dir, 'docs/ops/release-gate-step-inventory.json'), JSON.stringify({ entries: [{ name: 'demo', tier: 'core', args: ['run', 'check:demo'] }] }));
    writeFileSync(join(dir, 'docs/ops/registry.json'), JSON.stringify({ checks: [{
      id: 'demo',
      fixture: 'fixtures/f.json',
      doc: 'doc.md',
      currentState: 'state.md',
      packageScript: { name: 'check:demo', command: 'node scripts/check-demo.mjs' },
      releaseGateStep: { name: 'demo', tier: 'core', args: ['run', 'check:demo'] },
      assertions: [
        { path: 'schema', equals: 'demo.v1' },
        { path: 'items', arraySome: { name: 'a', ok: true } },
        { source: 'doc', includes: 'registry' },
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
