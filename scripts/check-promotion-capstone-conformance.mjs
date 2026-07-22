#!/usr/bin/env node
/**
 * Promotion capstone conformance check.
 *
 * Safety: read-only validation. No deploy, no restart, no live send, no
 * provider/Telegram traffic, and no production broker assumptions.
 */
import { createDocCheckContext } from './lib/doc-check.mjs';
import { PACKAGE_CI_SURFACES } from './run-monorepo-package-ci-parity.mjs';
import {
  buildBaseline as buildBrokerBaseline,
  CORE_SOURCE_FLOORS as BROKER_CORE_SOURCE_FLOORS,
} from '../packages/broker/scripts/coverage-baseline-report.mjs';
import {
  buildBaseline as buildRunnerBaseline,
  CORE_SOURCE_FLOORS,
} from '../packages/docker-runner/scripts/coverage-baseline-report.mjs';
import { buildBaseline as buildPluginBaseline } from '../packages/openclaw-plugin-a2a/scripts/coverage-baseline-report.mjs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const EXPECTED_COVERAGE_BASELINE_COMMAND =
  'npm run build && node --test scripts/coverage-baseline-report.test.mjs && node scripts/coverage-baseline-report.mjs';

// The reporter owns the broker floor values; the capstone imports that exact
// object so tests, documentation checks, and runtime enforcement cannot drift.
export const EXPECTED_BROKER_FLOORS = BROKER_CORE_SOURCE_FLOORS;

export const EXPECTED_RUNNER_FLOORS = Object.freeze({
  'config.js': 94,
  'execution-orchestrator.js': 96,
  'execution-proof.js': 95,
  'execution-proof-signing.js': 90,
  'redaction.js': 95,
  'runner.js': 85,
});

function sortedRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  return Object.fromEntries(Object.entries(record).sort(([left], [right]) => left.localeCompare(right)));
}

export function evaluateQualityFloorContract(contract) {
  const failures = [];
  const add = (condition, message) => {
    if (!condition) failures.push(message);
  };
  const { name, dir, coverageCommand, reporterTestPresent, baseline, surface, noUnusedLocals, expectedNoUnusedLocals } = contract;

  add(
    coverageCommand === EXPECTED_COVERAGE_BASELINE_COMMAND,
    `${name}: coverage:baseline command drifted`,
  );
  add(reporterTestPresent === true, `${name}: missing coverage baseline reporter test`);
  add(baseline?.schema === 'a2a-nexus.coverage-baseline.v1', `${name}: reporter schema drifted`);
  if (name === 'broker') {
    add(baseline?.floor?.metric === 'line', `${name}: reporter line-floor mode drifted`);
    add(
      JSON.stringify(sortedRecord(baseline?.floor?.modules)) === JSON.stringify(sortedRecord(EXPECTED_BROKER_FLOORS)),
      `${name}: #1506 per-module floors drifted: ${JSON.stringify(sortedRecord(baseline?.floor?.modules))}`,
    );
  } else if (name === 'docker-runner') {
    add(baseline?.floor?.metric === 'line', `${name}: reporter line-floor mode drifted`);
    add(
      JSON.stringify(sortedRecord(baseline?.floor?.modules)) === JSON.stringify(sortedRecord(EXPECTED_RUNNER_FLOORS)),
      `${name}: #1576 per-module floors drifted: ${JSON.stringify(sortedRecord(baseline?.floor?.modules))}`,
    );
  } else {
    add(baseline?.floor === null, `${name}: reporter must remain measure-only`);
  }

  add(Boolean(surface), `${name}: missing PACKAGE_CI_SURFACES entry`);
  if (surface) {
    add(
      surface.commands.some(
        ([command, args]) => command === 'npm' && args.join(' ') === `run coverage:baseline -w ${dir}`,
      ),
      `${name}: PACKAGE_CI_SURFACES missing coverage:baseline command`,
    );
    add(
      surface.metadata?.requiredScripts?.includes('coverage:baseline'),
      `${name}: PACKAGE_CI_SURFACES metadata missing coverage:baseline`,
    );
    add(
      surface.metadata?.requiredFiles?.includes('scripts/coverage-baseline-report.mjs'),
      `${name}: PACKAGE_CI_SURFACES metadata missing coverage reporter`,
    );
  }
  add(
    noUnusedLocals === expectedNoUnusedLocals,
    `${name}: noUnusedLocals must be ${expectedNoUnusedLocals === true ? 'enabled' : 'pending'}`,
  );
  return failures;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {

const { failures, fail, expect, readRel } = createDocCheckContext();

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
  { name: 'broker', dir: 'packages/broker', noUnusedLocals: undefined, buildBaseline: buildBrokerBaseline },
  { name: 'docker-runner', dir: 'packages/docker-runner', noUnusedLocals: true, buildBaseline: buildRunnerBaseline },
  { name: 'openclaw-plugin-a2a', dir: 'packages/openclaw-plugin-a2a', noUnusedLocals: true, buildBaseline: buildPluginBaseline },
];

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
    /broker[^\n]*#1506[^\n]*Enforced[^\n]*Pending/i,
    /docker-runner[^\n]*#1576[^\n]*Enforced[^\n]*Enabled/i,
    /openclaw-plugin-a2a[^\n]*measure-only[^\n]*Enabled/i,
    /config\.js[^\n]*94%/,
    /execution-orchestrator\.js[^\n]*96%/,
    /execution-proof\.js[^\n]*95%/,
    /execution-proof-signing\.js[^\n]*90%/,
    /redaction\.js[^\n]*95%/,
    /runner\.js[^\n]*85%/,
    /broker-policy\.js[^\n]*84%[^\n]*85\.06%/,
    /provenance\.js[^\n]*98%[^\n]*99\.00%/,
    /release-evidence\.js[^\n]*97%[^\n]*98\.66%/,
    /plugin coverage floor/i,
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
  const { name, dir, noUnusedLocals, buildBaseline } = packageContract;
  const manifest = parseJson(`${dir}/package.json`);
  const reporterTestRel = `${dir}/scripts/coverage-baseline-report.test.mjs`;
  const surface = PACKAGE_CI_SURFACES[name];
  const tsconfig = parseJson(`${dir}/tsconfig.json`);
  const baseline = name === 'docker-runner'
    ? buildBaseline([], {
      coveragePercent: null,
      fileLineCoverage: { ...CORE_SOURCE_FLOORS },
      testExitCode: 0,
      note: 'promotion-capstone contract probe',
    })
    : name === 'broker'
      ? buildBaseline(name, [], {
        coveragePercent: 100,
        fileLineCoverage: { ...EXPECTED_BROKER_FLOORS },
        testExitCode: 0,
        reportValid: true,
        reportFailures: [],
        note: 'promotion-capstone contract probe',
      })
      : buildBaseline(name, [], { coveragePercent: null, note: 'promotion-capstone contract probe' });
  for (const message of evaluateQualityFloorContract({
    name,
    dir,
    coverageCommand: manifest.scripts?.['coverage:baseline'] ?? '',
    reporterTestPresent: readRel(reporterTestRel) !== null,
    baseline,
    surface,
    noUnusedLocals: tsconfig.compilerOptions?.noUnusedLocals,
    expectedNoUnusedLocals: noUnusedLocals,
  })) {
    fail(message);
  }
}

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
}
