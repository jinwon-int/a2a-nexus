import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { runChecks } from './run-conformance.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER = join(HERE, 'run-conformance.mjs');
const REPO_ROOT = resolve(HERE, '../..');

function runRunner(args = []) {
  return spawnSync(process.execPath, [RUNNER, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
}

async function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'a2a-conformance-test-'));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('--list prints the public-safe conformance check allowlist', () => {
  const res = runRunner(['--list']);
  assert.equal(res.status, 0, res.stderr);
  const lines = res.stdout.trim().split('\n');
  assert.ok(lines.includes('check-contract-fixtures.mjs'));
  assert.ok(lines.includes('check-terminal-evidence-ack-boundary.mjs'));
  assert.ok(lines.includes('check-task-attempt-failure-sharing.mjs'));
  assert.ok(lines.includes('check-wave-plan-dag-v2.mjs'));
  assert.equal(lines.includes('check-a2a-tck-plan.mjs'), false, 'planning-only TCK checker stays excluded');
  assert.equal(lines.includes('public-readiness-go-nogo.test.mjs'), false, 'release go/no-go checker stays excluded');
});

test('--json emits a stable machine-readable summary with pass counts', () => {
  const res = runRunner(['--json']);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stderr, '', 'json mode keeps stderr empty on success');
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.schemaVersion, 'a2a-nexus-conformance.v1');
  assert.equal(parsed.ok, true);
  assert.equal(parsed.total, parsed.checks.length);
  assert.equal(parsed.failed, 0);
  assert.equal(parsed.passed, parsed.total);
  assert.ok(parsed.total >= 10);
  for (const check of parsed.checks) {
    assert.equal(typeof check.name, 'string');
    assert.equal(check.status, 'pass');
    assert.equal(typeof check.durationMs, 'number');
  }
});

test('runChecks returns actionable failed check details and non-zero status', async () => {
  await withTempDir(async (dir) => {
    writeFileSync(join(dir, 'pass.mjs'), "console.log('pass ok')\n");
    writeFileSync(join(dir, 'fail.mjs'), "console.error('intentional failure detail')\nprocess.exit(7)\n");
    const result = await runChecks(['pass.mjs', 'fail.mjs'], { baseDir: dir });
    assert.equal(result.ok, false);
    assert.equal(result.total, 2);
    assert.equal(result.passed, 1);
    assert.equal(result.failed, 1);
    assert.equal(result.exitCode, 7);
    assert.deepEqual(result.checks.map((c) => c.status), ['pass', 'fail']);
    assert.match(result.checks[1].output, /intentional failure detail/);
  });
});
