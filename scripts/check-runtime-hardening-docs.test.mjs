import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repo = path.resolve(new URL('..', import.meta.url).pathname);
const script = path.join(repo, 'scripts/check-runtime-hardening-docs.mjs');

const COMPLETE = {
  'CHANGELOG.md': 'trusted-operator default network dropped to bridge; restore with A2A_DOCKER_RUNNER_NETWORK=host',
  'packages/broker/docs/process-local-security-limits.md': 'replay cache and rate limiter are process-local',
  'docs/known-limitations.md': 'see process-local-security-limits.md',
  'packages/docker-runner/docs/trusted-operator-hardening.md': 'A2A_DOCKER_RUNNER_NETWORK=host and A2A_DOCKER_RUNNER_USER=root are explicit escape hatches',
};

function run(files) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'hardening-docs-'));
  for (const [name, body] of Object.entries(files)) {
    const p = path.join(cwd, name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  }
  return spawnSync(process.execPath, [script], { cwd, encoding: 'utf8' });
}

test('complete artifact set passes', () => {
  const r = run(COMPLETE);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /runtime hardening docs gate ok/);
});

test('missing CHANGELOG trusted-default entry fails closed', () => {
  const r = run({ ...COMPLETE, 'CHANGELOG.md': 'unrelated release notes' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /changelog-trusted-default-entry/);
});

test('missing security-limits doc fails closed', () => {
  const files = { ...COMPLETE };
  delete files['packages/broker/docs/process-local-security-limits.md'];
  const r = run(files);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /missing file packages\/broker\/docs\/process-local-security-limits\.md/);
});

test('dropped known-limitations link fails closed', () => {
  const r = run({ ...COMPLETE, 'docs/known-limitations.md': 'limits exist but link was removed' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /known-limitations-links/);
});
