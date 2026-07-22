#!/usr/bin/env node
/**
 * Promotion capstone conformance check.
 *
 * Safety: read-only validation. No deploy, no restart, no live send, no
 * provider/Telegram traffic, and no production broker assumptions.
 */
import { createDocCheckContext } from './lib/doc-check.mjs';
import { PACKAGE_CI_SURFACES } from './run-monorepo-package-ci-parity.mjs';

const { root, failures, fail, expect, readRel } = createDocCheckContext();

function parseJson(rel) {
  const text = readRel(rel);
  if (!text) {
    fail(`missing ${rel}`);
    return {};
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    fail(`${rel}: invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
    return {};
  }
}

function expectMatch(text, regex, message) {
  expect(Boolean(text && regex.test(text)), message);
}

function boundedSource(rel, startMarker, endMarker) {
  const text = readRel(rel);
  if (!text) {
    fail(`missing ${rel}`);
    return '';
  }
  const start = text.indexOf(startMarker);
  const nextStart = start < 0 ? -1 : text.indexOf(startMarker, start + startMarker.length);
  const end = start < 0 ? -1 : text.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || nextStart >= 0 || end < 0) {
    fail(`${rel}: missing or ambiguous bounded markers ${startMarker} ... ${endMarker}`);
    return '';
  }
  return text.slice(start, end);
}

const packages = [
  { name: 'broker', dir: 'packages/broker', noUnusedLocals: undefined, floor: 'measure-only' },
  { name: 'docker-runner', dir: 'packages/docker-runner', noUnusedLocals: true, floor: 'enforced' },
  { name: 'openclaw-plugin-a2a', dir: 'packages/openclaw-plugin-a2a', noUnusedLocals: true, floor: 'measure-only' },
];

const expectedRunnerFloors = {
  'config.js': 94,
  'execution-orchestrator.js': 96,
  'execution-proof.js': 95,
  'execution-proof-signing.js': 90,
  'redaction.js': 95,
  'runner.js': 85,
};

const capstonePath = 'docs/promotion-capstone.md';
const capstone = readRel(capstonePath);
expect(capstone !== null, `missing ${capstonePath}`);

if (capstone) {
  expectMatch(capstone, /Promotion-ready quickstart capstone/i, 'capstone: missing title');
  expectMatch(capstone, /5-minute path/i, 'capstone: missing 5-minute path');
  expectMatch(capstone, /20-minute path/i, 'capstone: missing 20-minute path');
  expectMatch(capstone, /fresh checkout/i, 'capstone: missing fresh checkout language');
  expectMatch(capstone, /npm ci --ignore-scripts --include=dev/, 'capstone: missing deterministic install command');
  expectMatch(capstone, /npm run smoke:quickstart/, 'capstone: missing smoke:quickstart command');
  expectMatch(capstone, /127\.0\.0\.1:8787/, 'capstone: missing loopback broker URL');
  expectMatch(capstone, /local-echo-worker/, 'capstone: missing echo worker id');

  for (const rel of [
    'packages/broker',
    'packages/openclaw-plugin-a2a',
    'packages/docker-runner',
    'docs/external-harness-quickstart.md',
    'fixtures/external-harness/no-live-conformance.json',
  ]) {
    expect(capstone.includes(rel), `capstone: missing package/doc boundary ${rel}`);
  }

  for (const marker of [
    /no-live/i,
    /local-only/i,
    /no production deploy/i,
    /no Gateway\/broker\/worker restart/i,
    /no Telegram send/i,
    /no provider send/i,
    /placeholder-only/i,
    /Stable/i,
    /Experimental/i,
    /#649/,
    /#663/,
    /#665/,
    /stale split docs/i,
    /missing env/i,
    /broker-id routing/i,
    /no-live evidence-only tasks/i,
  ]) {
    expectMatch(capstone, marker, `capstone: missing marker ${marker}`);
  }

  const qualityFloorSection = boundedSource(
    capstonePath,
    '## Quality-floor consistency',
    '\n## Named CI lane',
  );
  for (const marker of [
    /a2a-nexus\.coverage-baseline\.v1/,
    /broker[^\n]*measure-only[^\n]*Pending/i,
    /docker-runner[^\n]*#1576[^\n]*Enforced[^\n]*Enabled/i,
    /openclaw-plugin-a2a[^\n]*measure-only[^\n]*Enabled/i,
    /config\.js[^\n]*94%/,
    /execution-orchestrator\.js[^\n]*96%/,
    /execution-proof\.js[^\n]*95%/,
    /execution-proof-signing\.js[^\n]*90%/,
    /redaction\.js[^\n]*95%/,
    /runner\.js[^\n]*85%/,
    /broker and plugin coverage floors/i,
    /broker `noUnusedLocals`/i,
    /async-safety approval/i,
    /#1506/,
  ]) {
    expectMatch(qualityFloorSection, marker, `capstone quality-floor section: missing marker ${marker}`);
  }

  const urls = capstone.match(/https?:\/\/[^\s)]+/g) || [];
  const suspicious = urls.filter((url) => !url.startsWith('http://127.0.0.1') && !url.startsWith('http://localhost') && !url.startsWith('https://github.com/jinwon-int/a2a-nexus'));
  expect(suspicious.length === 0, `capstone: live/external URLs not allowed: ${suspicious.join(', ')}`);
}

for (const packageContract of packages) {
  const { name, dir, noUnusedLocals, floor } = packageContract;
  const manifest = parseJson(`${dir}/package.json`);
  const baselineCommand = manifest.scripts?.['coverage:baseline'] ?? '';
  expectMatch(baselineCommand, /coverage-baseline-report\.test\.mjs/, `${name}: coverage:baseline must run reporter tests`);
  expectMatch(baselineCommand, /coverage-baseline-report\.mjs/, `${name}: coverage:baseline must run reporter`);

  const reporterRel = `${dir}/scripts/coverage-baseline-report.mjs`;
  const reporterTestRel = `${dir}/scripts/coverage-baseline-report.test.mjs`;
  expect(readRel(reporterTestRel) !== null, `${name}: missing coverage baseline reporter test`);
  const baselineBuilder = boundedSource(reporterRel, 'export function buildBaseline', '\nfunction main()');
  expectMatch(
    baselineBuilder,
    /schema:\s*'a2a-nexus\.coverage-baseline\.v1'/,
    `${name}: reporter must expose a2a-nexus.coverage-baseline.v1`,
  );
  expectMatch(
    baselineBuilder,
    floor === 'enforced' ? /floor:\s*\{\s*metric:\s*'line',\s*modules:\s*floors\s*\}/ : /floor:\s*null/,
    `${name}: reporter floor mode drifted from ${floor}`,
  );

  const surface = PACKAGE_CI_SURFACES[name];
  expect(Boolean(surface), `${name}: missing PACKAGE_CI_SURFACES entry`);
  if (surface) {
    expect(
      surface.commands.some(
        ([command, args]) => command === 'npm' && args.join(' ') === `run coverage:baseline -w ${dir}`,
      ),
      `${name}: PACKAGE_CI_SURFACES missing coverage:baseline command`,
    );
    expect(
      surface.metadata?.requiredScripts?.includes('coverage:baseline'),
      `${name}: PACKAGE_CI_SURFACES metadata missing coverage:baseline`,
    );
    expect(
      surface.metadata?.requiredFiles?.includes('scripts/coverage-baseline-report.mjs'),
      `${name}: PACKAGE_CI_SURFACES metadata missing coverage reporter`,
    );
  }

  const tsconfig = parseJson(`${dir}/tsconfig.json`);
  expect(
    tsconfig.compilerOptions?.noUnusedLocals === noUnusedLocals,
    `${name}: noUnusedLocals must be ${noUnusedLocals === true ? 'enabled' : 'pending'}`,
  );
}

const runnerFloorSource = boundedSource(
  'packages/docker-runner/scripts/coverage-baseline-report.mjs',
  'export const CORE_SOURCE_FLOORS = Object.freeze({',
  '\n});',
);
const actualRunnerFloors = Object.fromEntries(
  [...runnerFloorSource.matchAll(/^\s*'([^']+\.js)':\s*(\d+),?\s*$/gm)].map((match) => [match[1], Number(match[2])]),
);
expect(
  JSON.stringify(actualRunnerFloors) === JSON.stringify(expectedRunnerFloors),
  `docker-runner: #1576 per-module floors drifted: ${JSON.stringify(actualRunnerFloors)}`,
);

const pkg = parseJson('package.json');
expectMatch(pkg.scripts?.['check:promotion-capstone'] ?? '', /check-promotion-capstone-conformance\.mjs/, 'package.json: missing check:promotion-capstone script');
expectMatch(pkg.scripts?.['smoke:quickstart'] ?? '', /check:promotion-capstone/, 'package.json: smoke:quickstart must include capstone check');

const ci = readRel('.github/workflows/ci.yml');
expect(ci !== null, 'missing .github/workflows/ci.yml');
if (ci) {
  expectMatch(ci, /promotion-capstone:/, 'ci: missing promotion-capstone job');
  expectMatch(ci, /npm run check:promotion-capstone/, 'ci: promotion-capstone job must run capstone check');
  expectMatch(ci, /npm run smoke:quickstart/, 'ci: promotion-capstone job must run five-minute smoke path');
}

const quickstart = readRel('docs/quickstart.md');
if (quickstart) {
  expectMatch(quickstart, /(?:docs\/)?promotion-capstone\.md/, 'quickstart: must link promotion capstone');
}

if (failures.length) {
  console.error(`promotion capstone conformance failed:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}

console.log('promotion capstone conformance ok: docs, no-live boundaries, quality floors, package scripts, and named CI lane validated');
