/**
 * Test for quickstart conformance check.
 *
 * Validates the check-quickstart-conformance module's core logic
 * without live network/provider assumptions.
 *
 * Safety: read-only unit tests. No deploy, no restart, no live send.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

// ── File existence checks ───────────────────────────────────────────────────

test('quickstart doc exists', () => {
  assert.ok(existsSync(join(repoRoot, 'docs', 'quickstart.md')));
});

test('canonical demo doc exists', () => {
  assert.ok(existsSync(join(repoRoot, 'docs', 'canonical-demo.md')));
});

test('canonical demo task example exists', () => {
  assert.ok(existsSync(join(repoRoot, 'examples', 'canonical-demo-task.json')));
});

test('local quickstart example and task fixture exist', () => {
  assert.ok(existsSync(join(repoRoot, 'examples', 'local', 'README.md')));
  assert.ok(existsSync(join(repoRoot, 'examples', 'local', 'local-quickstart-task.json')));
});

test('release gate script exists', () => {
  assert.ok(existsSync(join(repoRoot, 'scripts', 'release-gate.mjs')));
});

test('compatibility matrix exists', () => {
  assert.ok(existsSync(join(repoRoot, 'contracts', 'compatibility', 'matrix.md')));
});

// ── Quickstart structural validation ────────────────────────────────────────

test('quickstart contains required sections', async () => {
  const content = await readFile(join(repoRoot, 'docs', 'quickstart.md'), 'utf8');

  assert.match(content, /Five-minute local quickstart/i);
  assert.match(content, /Prerequisites/i);
  assert.match(content, /Node\.js 22/);
  assert.match(content, /Run the local A2A Nexus broker/i);
  assert.match(content, /Start a dummy or echo worker/i);
  assert.match(content, /Connect the reference OpenClaw plugin locally/i);
  assert.match(content, /Submit a no-live test task/i);
  assert.match(content, /Verify public-readiness checks/i);
  assert.match(content, /Safety checklist/i);
});

test('quickstart uses deterministic local paths only', async () => {
  const content = await readFile(join(repoRoot, 'docs', 'quickstart.md'), 'utf8');

  // Loopback broker URL
  assert.match(content, /127\.0\.0\.1:8787/);

  // Deterministic install command
  assert.match(content, /npm ci --ignore-scripts --include=dev/);

  // References npm run check and smoke:quickstart
  assert.match(content, /npm run check/);
  assert.match(content, /npm run smoke:quickstart/);
});

test('quickstart contains safety constraints', async () => {
  const content = await readFile(join(repoRoot, 'docs', 'quickstart.md'), 'utf8');

  assert.match(content, /Do not point this path at production/i);
  assert.match(content, /no production deploy/i);
  assert.match(content, /Never include real tokens/i);
  assert.match(content, /public-readiness scan must remain clean/i);
  assert.match(content, /accepted-send evidence only/i);
  assert.match(content, /not requester-visible receipt/i);
  assert.match(content, /(is not|not).*terminal ACK/i);
  assert.match(content, /replay-safe/i);
  assert.match(content, /idempotent/i);
});

// ── Canonical demo validation ───────────────────────────────────────────────

test('canonical demo contains safety boundary', async () => {
  const content = await readFile(join(repoRoot, 'docs', 'canonical-demo.md'), 'utf8');

  assert.match(content, /No-live safety boundary/i);
  assert.match(content, /must not perform production deploys/i);
  assert.match(content, /Expected terminal evidence/i);
  assert.match(content, /PR/);
  assert.match(content, /Done/);
  assert.match(content, /Block/);
});

// ── Release gate validation ─────────────────────────────────────────────────

test('release gate inventory keeps public-readiness and package checks', async () => {
  const inventory = JSON.parse(await readFile(join(repoRoot, 'docs', 'ops', 'release-gate-step-inventory.json'), 'utf8'));
  const byName = new Map(inventory.entries.map((entry) => [entry.name, entry]));

  // Gate steps invoke their scripts directly (node <script>); the npm aliases
  // stay in package.json as the human entry points.
  assert.deepEqual(byName.get('public-readiness'), {
    name: 'public-readiness',
    command: 'node',
    args: ['scripts/public-readiness-scan.mjs', '--strict-internal'],
    tier: 'public-readiness',
    owner: 'public-readiness',
    consumer: 'pr-gate',
    retirement: 'keep',
    retirementCondition:
      'Retire only when a narrower owner-scoped gate demonstrably covers the same invariant; no removal while it runs on the default release-gate path.',
    note: 'Public-readiness or visibility hygiene; do not retire as generic cleanup.',
  });
  assert.equal(byName.get('layout')?.tier, 'core');
  assert.deepEqual(byName.get('layout')?.args, ['scripts/check-layout.mjs']);
  assert.equal(byName.get('packages')?.tier, 'core');
  assert.deepEqual(byName.get('packages')?.args, ['scripts/check-packages.mjs']);
});

// ── Root package.json validation ────────────────────────────────────────────

test('root package.json check maps to release-gate', async () => {
  const pkg = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'));
  assert.strictEqual(pkg.scripts?.check, 'npm run release-gate');
});

test('root package.json has workspace-scoped build and smoke:quickstart scripts', async () => {
  const pkg = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'));
  assert.strictEqual(pkg.scripts?.build, 'npm run build -ws');
  assert.ok(typeof pkg.scripts?.['smoke:quickstart'] === 'string', 'missing smoke:quickstart script');
  assert.match(pkg.scripts?.['smoke:quickstart'] ?? '', /build/);
  assert.match(pkg.scripts?.['smoke:quickstart'] ?? '', /check:quickstart-conformance/);
  assert.match(pkg.scripts?.['smoke:quickstart'] ?? '', /test:release-gate/);
});

test('root package.json has quickstart-conformance script', async () => {
  const pkg = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'));
  assert.ok(pkg.scripts?.['check:quickstart-conformance'], 'missing check:quickstart-conformance script');
});

test('broker package exposes local broker and echo worker scripts', async () => {
  const pkg = JSON.parse(await readFile(join(repoRoot, 'packages', 'broker', 'package.json'), 'utf8'));
  assert.match(pkg.scripts?.['start:local'] ?? '', /127\.0\.0\.1:8787/);
  assert.match(pkg.scripts?.['worker:echo'] ?? '', /WORKER_HANDLER_BUILTIN=echo/);
});

test('local quickstart task fixture is no-live and targets echo worker', async () => {
  const task = JSON.parse(await readFile(join(repoRoot, 'examples', 'local', 'local-quickstart-task.json'), 'utf8'));
  assert.strictEqual(task.assignedWorkerId, 'local-echo-worker');
  assert.strictEqual(task.payload?.noLive, true);
  assert.strictEqual(task.payload?.replaySafe, true);
});

// ── Root CI workflow validation ─────────────────────────────────────────────

test('root CI workflow runs quickstart conformance', async () => {
  const content = await readFile(join(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf8');
  assert.match(content, /check:quickstart-conformance/);
});

// ── No live network URLs in quickstart ──────────────────────────────────────

test('quickstart contains no live external endpoints', async () => {
  const content = await readFile(join(repoRoot, 'docs', 'quickstart.md'), 'utf8');

  // Extract all URLs
  const urls = content.match(/https?:\/\/[^\s)]+/g) || [];

  // Allowed: loopback, localhost, github.com (repo refs only)
  const suspicious = urls.filter(
    (u) =>
      !u.startsWith('http://127.0.0.1') &&
      !u.startsWith('http://localhost') &&
      !u.startsWith('https://github.com/jinwon-int/')
  );

  assert.strictEqual(suspicious.length, 0, `live URLs in quickstart: ${suspicious.join(', ')}`);
});
