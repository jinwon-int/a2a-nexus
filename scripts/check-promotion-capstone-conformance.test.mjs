/**
 * Promotion capstone conformance tests.
 *
 * Safety: read-only doc/CI validation. No deploy, no restart, no live provider
 * send, no Telegram send, and no production broker assumptions.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PACKAGE_CI_SURFACES } from './run-monorepo-package-ci-parity.mjs';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const capstonePath = join(repoRoot, 'docs', 'promotion-capstone.md');

async function capstone() {
  return readFile(capstonePath, 'utf8');
}

const packageContracts = [
  { name: 'broker', dir: 'packages/broker', floor: 'measure-only', noUnusedLocals: undefined },
  { name: 'docker-runner', dir: 'packages/docker-runner', floor: 'enforced', noUnusedLocals: true },
  { name: 'openclaw-plugin-a2a', dir: 'packages/openclaw-plugin-a2a', floor: 'measure-only', noUnusedLocals: true },
];

function boundedSource(content, startMarker, endMarker) {
  const start = content.indexOf(startMarker);
  assert.notStrictEqual(start, -1, `missing start marker: ${startMarker}`);
  assert.strictEqual(content.indexOf(startMarker, start + startMarker.length), -1, `ambiguous start marker: ${startMarker}`);
  const end = content.indexOf(endMarker, start + startMarker.length);
  assert.notStrictEqual(end, -1, `missing end marker: ${endMarker}`);
  return content.slice(start, end);
}

test('promotion capstone doc exists', () => {
  assert.ok(existsSync(capstonePath));
});

test('promotion capstone defines canonical five-minute local loopback smoke path', async () => {
  const content = await capstone();
  assert.match(content, /5-minute path/i);
  assert.match(content, /fresh checkout/i);
  assert.match(content, /npm ci --ignore-scripts --include=dev/);
  assert.match(content, /npm run smoke:quickstart/);
  assert.match(content, /127\.0\.0\.1:8787/);
  assert.match(content, /local-echo-worker/);
  assert.match(content, /packages\/broker/);
});

test('promotion capstone defines twenty-minute package-boundary path', async () => {
  const content = await capstone();
  assert.match(content, /20-minute path/i);
  assert.match(content, /packages\/broker/);
  assert.match(content, /packages\/openclaw-plugin-a2a/);
  assert.match(content, /packages\/docker-runner/);
  assert.match(content, /docs\/external-harness-quickstart\.md/);
  assert.match(content, /fixtures\/external-harness\/no-live-conformance\.json/);
});

test('promotion capstone is explicitly no-live and secret-free', async () => {
  const content = await capstone();
  assert.match(content, /no-live/i);
  assert.match(content, /local-only/i);
  assert.match(content, /no production deploy/i);
  assert.match(content, /no Gateway\/broker\/worker restart/i);
  assert.match(content, /no Telegram send/i);
  assert.match(content, /no provider send/i);
  assert.match(content, /placeholder-only/i);
  const urls = content.match(/https?:\/\/[^\s)]+/g) || [];
  const suspicious = urls.filter(
    (url) =>
      !url.startsWith('http://127.0.0.1') &&
      !url.startsWith('http://localhost') &&
      !url.startsWith('https://github.com/jinwon-int/a2a-nexus')
  );
  assert.strictEqual(suspicious.length, 0, `live URLs in capstone: ${suspicious.join(', ')}`);
});

test('promotion capstone marks stable vs experimental and links parent trackers', async () => {
  const content = await capstone();
  assert.match(content, /Stable/i);
  assert.match(content, /Experimental/i);
  assert.match(content, /#649/);
  assert.match(content, /#663/);
  assert.match(content, /#665/);
});

test('promotion capstone has required troubleshooting topics', async () => {
  const content = await capstone();
  for (const topic of [
    /stale split docs/i,
    /missing env/i,
    /broker-id routing/i,
    /no-live evidence-only tasks/i,
  ]) {
    assert.match(content, topic);
  }
});

test('promotion capstone records the live-main quality-floor consistency contract', async () => {
  const content = await capstone();
  const section = boundedSource(content, '## Quality-floor consistency', '\n## Named CI lane');
  assert.match(section, /a2a-nexus\.coverage-baseline\.v1/);
  assert.match(section, /broker[^\n]*measure-only[^\n]*Pending/i);
  assert.match(section, /docker-runner[^\n]*#1576[^\n]*Enforced[^\n]*Enabled/i);
  assert.match(section, /openclaw-plugin-a2a[^\n]*measure-only[^\n]*Enabled/i);
  for (const [module, floor] of Object.entries({
    'config.js': 94,
    'execution-orchestrator.js': 96,
    'execution-proof.js': 95,
    'execution-proof-signing.js': 90,
    'redaction.js': 95,
    'runner.js': 85,
  })) {
    assert.match(section, new RegExp(`${module.replace('.', '\\.')}[^\\n]*${floor}%`));
  }
  assert.match(section, /broker and plugin coverage floors/i);
  assert.match(section, /broker `noUnusedLocals`/i);
  assert.match(section, /async-safety approval/i);
  assert.match(section, /#1506/);
});

test('package coverage commands, reporter files, and parity metadata stay aligned', async () => {
  for (const { name, dir } of packageContracts) {
    const manifest = JSON.parse(await readFile(join(repoRoot, dir, 'package.json'), 'utf8'));
    assert.match(manifest.scripts?.['coverage:baseline'] ?? '', /coverage-baseline-report\.test\.mjs/);
    assert.match(manifest.scripts?.['coverage:baseline'] ?? '', /coverage-baseline-report\.mjs/);
    assert.ok(existsSync(join(repoRoot, dir, 'scripts', 'coverage-baseline-report.mjs')));
    assert.ok(existsSync(join(repoRoot, dir, 'scripts', 'coverage-baseline-report.test.mjs')));

    const surface = PACKAGE_CI_SURFACES[name];
    assert.ok(surface, `${name}: missing PACKAGE_CI_SURFACES entry`);
    assert.ok(surface.commands.some(
      ([command, args]) => command === 'npm' && args.join(' ') === `run coverage:baseline -w ${dir}`,
    ));
    assert.ok(surface.metadata.requiredScripts.includes('coverage:baseline'));
    assert.ok(surface.metadata.requiredFiles.includes('scripts/coverage-baseline-report.mjs'));
  }
});

test('reporters expose one schema with live-main floor modes and #1576 module floors', async () => {
  for (const { dir, floor } of packageContracts) {
    const reporter = await readFile(join(repoRoot, dir, 'scripts', 'coverage-baseline-report.mjs'), 'utf8');
    const builder = boundedSource(reporter, 'export function buildBaseline', '\nfunction main()');
    assert.match(builder, /schema:\s*'a2a-nexus\.coverage-baseline\.v1'/);
    assert.match(
      builder,
      floor === 'enforced' ? /floor:\s*\{\s*metric:\s*'line',\s*modules:\s*floors\s*\}/ : /floor:\s*null/,
    );
  }

  const runnerReporter = await readFile(
    join(repoRoot, 'packages/docker-runner/scripts/coverage-baseline-report.mjs'),
    'utf8',
  );
  const floorSource = boundedSource(
    runnerReporter,
    'export const CORE_SOURCE_FLOORS = Object.freeze({',
    '\n});',
  );
  const floors = Object.fromEntries(
    [...floorSource.matchAll(/^\s*'([^']+\.js)':\s*(\d+),?\s*$/gm)].map((match) => [match[1], Number(match[2])]),
  );
  assert.deepEqual(floors, {
    'config.js': 94,
    'execution-orchestrator.js': 96,
    'execution-proof.js': 95,
    'execution-proof-signing.js': 90,
    'redaction.js': 95,
    'runner.js': 85,
  });
});

test('parsed tsconfigs keep noUnusedLocals enabled for runner/plugin and pending for broker', async () => {
  for (const { name, dir, noUnusedLocals } of packageContracts) {
    const tsconfig = JSON.parse(await readFile(join(repoRoot, dir, 'tsconfig.json'), 'utf8'));
    assert.strictEqual(
      tsconfig.compilerOptions?.noUnusedLocals,
      noUnusedLocals,
      `${name}: noUnusedLocals contract drift`,
    );
  }
});

test('root package exposes named promotion capstone check', async () => {
  const pkg = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'));
  assert.match(pkg.scripts?.['check:promotion-capstone'] ?? '', /check-promotion-capstone-conformance\.mjs/);
});

test('ci exposes named promotion-capstone lane for the five-minute path', async () => {
  const ci = await readFile(join(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf8');
  assert.match(ci, /promotion-capstone:/);
  assert.match(ci, /npm run check:promotion-capstone/);
  assert.match(ci, /npm run smoke:quickstart/);
});
