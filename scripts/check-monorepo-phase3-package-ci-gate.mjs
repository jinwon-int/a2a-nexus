#!/usr/bin/env node
/**
 * Validate the #534 monorepo phase-3 package CI parity gate.
 *
 * Safety: source-only fixture/doc validation. No import, package mirror
 * refresh, history rewrite, release, publish, visibility, live dispatch,
 * restart, credential, DB, or Terminal ACK action is performed here.
 */
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const failures = [];

function fail(message) {
  failures.push(message);
}

function expect(condition, message) {
  if (!condition) fail(message);
}

function readRel(rel) {
  try {
    return fs.readFileSync(path.join(root, rel), 'utf8');
  } catch {
    return null;
  }
}

function parseJson(rel) {
  const text = readRel(rel);
  if (text === null) {
    fail(`missing ${rel}`);
    return null;
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    fail(`${rel}: invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

const fixturePath = 'fixtures/current-state/monorepo-phase3-package-ci-gate.json';
const docs = [
  ['docs/monorepo-ci-parity-matrix.md', 'Phase-3 Package CI Gate'],
  ['docs/monorepo-import-rehearsal.md', 'Phase-3 Package CI Gate'],
  ['docs/current-state.md', 'a2a-plane#534'],
];
const fixture = parseJson(fixturePath);
const pkg = parseJson('package.json');
const releaseGate = readRel('scripts/release-gate.mjs') || '';
const workflow = readRel('.github/workflows/ci.yml') || '';
const packageCiRunner = readRel('scripts/run-monorepo-package-ci-parity.mjs') || '';

if (fixture) {
  expect(fixture.schema === 'a2a.monorepo-phase3-package-ci-gate.v1', 'fixture: unexpected schema');
  expect(fixture.issue === 'https://github.com/jinwon-int/a2a-plane/issues/534', 'fixture: issue must be #534');
  expect(fixture.implementationIssue === 'https://github.com/jinwon-int/a2a-plane/issues/536', 'fixture: implementationIssue must be #536');
  expect(fixture.freshImportCandidateIssue === 'https://github.com/jinwon-int/a2a-plane/issues/538', 'fixture: freshImportCandidateIssue must be #538');
  expect(fixture.parentIssue === 'https://github.com/jinwon-int/a2a-plane/issues/511', 'fixture: parentIssue must be #511');
  expect(fixture.phase2Issue === 'https://github.com/jinwon-int/a2a-plane/issues/530', 'fixture: phase2Issue must be #530');
  expect(fixture.gateStatus === 'blocked', 'fixture: phase-3 gate must remain blocked');
  expect(fixture.canonicalUntilGateGreen === 'split_repos', 'fixture: split repos must remain canonical');
  expect(fixture.mirrorRefreshAllowed === false, 'fixture: mirror refresh must not be allowed');
  expect(fixture.canonicalFlipApproved === false, 'fixture: canonical flip must not be approved');
  expect(fixture.packageJobsMustBeEqualOrStricter === true, 'fixture: must require equal-or-stricter package jobs');
  expect(fixture.packageCiJobsWired === true, 'fixture: package CI jobs must be wired');
  expect(fixture.packageCiParityJobScript === 'scripts/run-monorepo-package-ci-parity.mjs', 'fixture: package CI runner mismatch');

  for (const gate of [
    'record_actions_v4_v5_policy',
    'record_npm_ci_lifecycle_policy',
    'preserve_package_local_scanners',
    'preserve_release_dry_run_without_publish',
    'preserve_package_metadata_and_bin_exports',
    'prove_package_jobs_before_mirror_refresh',
  ]) {
    expect((fixture.requiredGlobalGates || []).includes(gate), `fixture: missing global gate ${gate}`);
  }

  const expected = new Map([
    ['broker', 'packages/broker'],
    ['docker-runner', 'packages/docker-runner'],
    ['openclaw-plugin-a2a', 'packages/openclaw-plugin-a2a'],
  ]);
  const surfaces = new Map((fixture.surfaces || []).map((surface) => [surface.surface, surface]));
  expect(surfaces.size === expected.size, 'fixture: must contain exactly three implementation surfaces');

  for (const [surfaceName, targetPath] of expected) {
    const surface = surfaces.get(surfaceName);
    expect(Boolean(surface), `fixture: missing ${surfaceName}`);
    if (!surface) continue;
    expect(surface.targetPath === targetPath, `fixture: ${surfaceName} targetPath mismatch`);
    expect(surface.gateStatus === 'blocked', `fixture: ${surfaceName} gate must be blocked`);
    expect(surface.packageCiJobStatus === 'wired', `fixture: ${surfaceName} package CI job must be wired`);
    expect(surface.mirrorRefreshAllowed === false, `fixture: ${surfaceName} mirror refresh must be false`);
    expect((surface.sourceCiCommands || []).includes('npm ci'), `fixture: ${surfaceName} must record source npm ci`);
    expect((surface.requiredPackageJobBeforeMirrorRefresh || []).length >= 6, `fixture: ${surfaceName} must list required package job gates`);
    expect((surface.blockingGaps || []).length >= 1, `fixture: ${surfaceName} must list blocking gaps`);
    expect((surface.packageCiEvidence || []).some((item) => item.includes('run-monorepo-package-ci-parity')), `fixture: ${surfaceName} must list package CI runner evidence`);
  }

  const broker = surfaces.get('broker');
  expect((broker?.requiredPackageJobBeforeMirrorRefresh || []).some((gate) => /generate-build-info/.test(gate)), 'fixture: broker must preserve build-info generation');
  expect((broker?.requiredPackageJobBeforeMirrorRefresh || []).some((gate) => /node --check scripts\/team1-dispatch-wrapper/.test(gate)), 'fixture: broker must preserve script syntax checks');

  const runner = surfaces.get('docker-runner');
  for (const gate of ['npm run build', 'npm run lint', 'npm test', 'pre-pr-bootstrap-guard', 'chaos:e2e', 'release-candidate-parity-audit']) {
    expect((runner?.requiredPackageJobBeforeMirrorRefresh || []).some((item) => item.includes(gate)), `fixture: docker-runner missing ${gate}`);
  }

  const plugin = surfaces.get('openclaw-plugin-a2a');
  for (const gate of ['scan:public-readiness', 'smoke:a2a-conformance', 'openclaw.plugin.json', 'prepack', 'bin/files exports']) {
    expect((plugin?.requiredPackageJobBeforeMirrorRefresh || []).some((item) => item.includes(gate)), `fixture: plugin missing ${gate}`);
  }

  for (const [key, value] of Object.entries(fixture.boundaries || {})) {
    expect(value === false, `fixture: boundary.${key} must be false`);
  }
}

for (const [docPath, phrase] of docs) {
  const doc = readRel(docPath);
  expect(doc !== null, `missing ${docPath}`);
  if (doc) expect(doc.includes(phrase), `${docPath}: missing ${phrase}`);
}

if (pkg) {
  expect(
    pkg.scripts?.['check:monorepo-phase3-package-ci-gate'] === 'node scripts/check-monorepo-phase3-package-ci-gate.mjs',
    'package.json: missing check:monorepo-phase3-package-ci-gate script'
  );
  expect(
    pkg.scripts?.['check:monorepo-package-ci-parity-jobs'] === 'node scripts/run-monorepo-package-ci-parity.mjs broker && node scripts/run-monorepo-package-ci-parity.mjs openclaw-plugin-a2a && node scripts/run-monorepo-package-ci-parity.mjs docker-runner',
    'package.json: missing check:monorepo-package-ci-parity-jobs script'
  );
}
expect(/monorepo-phase3-package-ci-gate/.test(releaseGate), 'release gate must include phase-3 package CI gate check');
expect(/monorepo-package-ci-parity-jobs/.test(releaseGate), 'release gate must include package CI parity jobs check');
expect(/actions\/checkout@v5/.test(workflow), 'workflow must use actions/checkout@v5');
expect(/actions\/setup-node@v5/.test(workflow), 'workflow must use actions/setup-node@v5');
expect(!/ignore-scripts/.test(workflow), 'workflow package installs must not suppress lifecycle scripts');
for (const surfaceName of ['broker', 'docker-runner', 'openclaw-plugin-a2a']) {
  expect(workflow.includes(`node scripts/run-monorepo-package-ci-parity.mjs ${surfaceName}`), `workflow missing package CI parity runner for ${surfaceName}`);
  expect(packageCiRunner.includes(surfaceName), `package CI runner missing ${surfaceName}`);
}

if (failures.length) {
  console.error(`monorepo phase-3 package CI gate validation failed:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}

console.log('monorepo phase-3 package CI gate ok');
