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
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PACKAGE_CI_SURFACES } from './run-monorepo-package-ci-parity.mjs';
import {
  CORE_SOURCE_FLOORS as BROKER_CORE_SOURCE_FLOORS,
} from '../packages/broker/scripts/coverage-baseline-report.mjs';
import {
  CORE_SOURCE_FLOORS as PLUGIN_CORE_SOURCE_FLOORS,
} from '../packages/openclaw-plugin-a2a/scripts/coverage-baseline-report.mjs';
import {
  evaluateQualityFloorContract,
  EXPECTED_COVERAGE_BASELINE_COMMAND,
  EXPECTED_BROKER_FLOORS,
  EXPECTED_PLUGIN_FLOORS,
  EXPECTED_RUNNER_FLOORS,
} from './check-promotion-capstone-conformance.mjs';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const capstonePath = join(repoRoot, 'docs', 'promotion-capstone.md');

async function capstone() {
  return readFile(capstonePath, 'utf8');
}

const packageContracts = [
  { name: 'broker', dir: 'packages/broker', floor: 'enforced', noUnusedLocals: undefined },
  { name: 'docker-runner', dir: 'packages/docker-runner', floor: 'enforced', noUnusedLocals: true },
  { name: 'openclaw-plugin-a2a', dir: 'packages/openclaw-plugin-a2a', floor: 'enforced', noUnusedLocals: true },
];

function validQualityContract(name = 'docker-runner') {
  const dir = name === 'openclaw-plugin-a2a' ? 'packages/openclaw-plugin-a2a' : `packages/${name}`;
  const expectedFloors = name === 'broker'
    ? EXPECTED_BROKER_FLOORS
    : name === 'docker-runner'
      ? EXPECTED_RUNNER_FLOORS
      : EXPECTED_PLUGIN_FLOORS;
  return {
    name,
    dir,
    coverageCommand: EXPECTED_COVERAGE_BASELINE_COMMAND,
    reporterTestPresent: true,
    baseline: {
      schema: 'a2a-nexus.coverage-baseline.v1',
      floor: { metric: 'line', modules: { ...expectedFloors } },
    },
    surface: {
      commands: [['npm', ['run', 'coverage:baseline', '-w', dir]]],
      metadata: {
        requiredScripts: ['coverage:baseline'],
        requiredFiles: ['scripts/coverage-baseline-report.mjs'],
      },
    },
    noUnusedLocals: name === 'broker' ? undefined : true,
    expectedNoUnusedLocals: name === 'broker' ? undefined : true,
  };
}

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
  assert.match(section, /broker[^\n]*#1506[^\n]*Enforced[^\n]*Pending/i);
  assert.match(section, /docker-runner[^\n]*#1576[^\n]*Enforced[^\n]*Enabled/i);
  assert.match(section, /openclaw-plugin-a2a[^\n]*#1506[^\n]*Enforced[^\n]*Enabled/i);
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
  for (const [module, values] of Object.entries({
    'dist/core/broker-policy.js': [84, '85\\.06'],
    'dist/core/provenance.js': [98, '99\\.00'],
    'dist/core/release-evidence.js': [97, '98\\.66'],
  })) {
    assert.match(
      section,
      new RegExp(`${module.replace('.', '\\.')}[^\\n]*${values[0]}%[^\\n]*${values[1]}%`),
    );
  }
  for (const [module, values] of Object.entries({
    'dist/src/handoff-visibility-policy.js': [80, '81\\.61'],
    'dist/src/recovery-guard.js': [95, '96\\.85'],
    'dist/src/wake-envelope.js': [93, '94\\.95'],
  })) {
    assert.match(
      section,
      new RegExp(`${module.replace('.', '\\.')}[^\\n]*${values[0]}%[^\\n]*${values[1]}%`),
    );
  }
  assert.match(section, /broker `noUnusedLocals`/i);
  assert.match(section, /async-safety approval/i);
  assert.match(section, /#1506/);
});

test('package coverage commands, reporter files, and parity metadata stay aligned', async () => {
  for (const { name, dir } of packageContracts) {
    const manifest = JSON.parse(await readFile(join(repoRoot, dir, 'package.json'), 'utf8'));
    assert.strictEqual(manifest.scripts?.['coverage:baseline'], EXPECTED_COVERAGE_BASELINE_COMMAND);
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

test('quality-floor evaluator accepts exact contracts and ignores floor key order', () => {
  assert.notStrictEqual(EXPECTED_BROKER_FLOORS, BROKER_CORE_SOURCE_FLOORS);
  assert.deepEqual(EXPECTED_BROKER_FLOORS, BROKER_CORE_SOURCE_FLOORS);
  assert.notStrictEqual(EXPECTED_PLUGIN_FLOORS, PLUGIN_CORE_SOURCE_FLOORS);
  assert.deepEqual(EXPECTED_PLUGIN_FLOORS, PLUGIN_CORE_SOURCE_FLOORS);
  for (const name of ['broker', 'docker-runner', 'openclaw-plugin-a2a']) {
    assert.deepEqual(evaluateQualityFloorContract(validQualityContract(name)), []);
  }
  const reordered = validQualityContract();
  reordered.baseline.floor.modules = Object.fromEntries(
    Object.entries(EXPECTED_RUNNER_FLOORS).reverse(),
  );
  assert.deepEqual(evaluateQualityFloorContract(reordered), []);
});

test('quality-floor evaluator rejects inert commands and missing parity evidence', () => {
  const contract = validQualityContract('broker');
  contract.coverageCommand = 'echo coverage-baseline-report.test.mjs coverage-baseline-report.mjs';
  contract.reporterTestPresent = false;
  contract.surface.commands = [];
  contract.surface.metadata.requiredScripts = [];
  contract.surface.metadata.requiredFiles = [];
  assert.deepEqual(evaluateQualityFloorContract(contract), [
    'broker: coverage:baseline command drifted',
    'broker: missing coverage baseline reporter test',
    'broker: PACKAGE_CI_SURFACES missing coverage:baseline command',
    'broker: PACKAGE_CI_SURFACES metadata missing coverage:baseline',
    'broker: PACKAGE_CI_SURFACES metadata missing coverage reporter',
  ]);
});

test('quality-floor evaluator rejects schema, floor-mode, and noUnusedLocals drift', () => {
  const contract = validQualityContract('openclaw-plugin-a2a');
  contract.baseline.schema = 'wrong.schema';
  contract.baseline.floor = {};
  contract.noUnusedLocals = false;
  assert.deepEqual(evaluateQualityFloorContract(contract), [
    'openclaw-plugin-a2a: reporter schema drifted',
    'openclaw-plugin-a2a: reporter line-floor mode drifted',
    'openclaw-plugin-a2a: #1506 per-module floors drifted: null',
    'openclaw-plugin-a2a: noUnusedLocals must be enabled',
  ]);
});

test('quality-floor evaluator rejects missing, lowered, or additional plugin floors', () => {
  for (const mutate of [
    (floors) => { delete floors['dist/src/wake-envelope.js']; },
    (floors) => { floors['dist/src/recovery-guard.js'] = 94; },
    (floors) => { floors['extra.js'] = 100; },
  ]) {
    const contract = validQualityContract('openclaw-plugin-a2a');
    mutate(contract.baseline.floor.modules);
    assert.match(
      evaluateQualityFloorContract(contract).join('\n'),
      /openclaw-plugin-a2a: #1506 per-module floors drifted/,
    );
  }
});

test('quality-floor evaluator rejects missing, lowered, or additional runner floors', () => {
  for (const mutate of [
    (floors) => { delete floors['runner.js']; },
    (floors) => { floors['runner.js'] = 84; },
    (floors) => { floors['extra.js'] = 100; },
  ]) {
    const contract = validQualityContract();
    mutate(contract.baseline.floor.modules);
    assert.match(
      evaluateQualityFloorContract(contract).join('\n'),
      /docker-runner: #1576 per-module floors drifted/,
    );
  }
});

test('quality-floor evaluator rejects missing, lowered, or additional broker floors', () => {
  for (const mutate of [
    (floors) => { delete floors['dist/core/release-evidence.js']; },
    (floors) => { floors['dist/core/broker-policy.js'] = 83; },
    (floors) => { floors['extra.js'] = 100; },
  ]) {
    const contract = validQualityContract('broker');
    mutate(contract.baseline.floor.modules);
    assert.match(
      evaluateQualityFloorContract(contract).join('\n'),
      /broker: #1506 per-module floors drifted/,
    );
  }
});

test('integrated checker evaluates the live reporter exports without side effects', () => {
  const result = spawnSync(process.execPath, [join(repoRoot, 'scripts', 'check-promotion-capstone-conformance.mjs')], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  assert.strictEqual(result.status, 0, result.stderr);
  assert.match(result.stdout, /quality floors/);
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
