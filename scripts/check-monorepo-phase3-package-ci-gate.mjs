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

if (fixture) {
  expect(fixture.schema === 'a2a.monorepo-phase3-package-ci-gate.v1', 'fixture: unexpected schema');
  expect(fixture.issue === 'https://github.com/jinwon-int/a2a-plane/issues/534', 'fixture: issue must be #534');
  expect(fixture.parentIssue === 'https://github.com/jinwon-int/a2a-plane/issues/511', 'fixture: parentIssue must be #511');
  expect(fixture.phase2Issue === 'https://github.com/jinwon-int/a2a-plane/issues/530', 'fixture: phase2Issue must be #530');
  expect(fixture.gateStatus === 'blocked', 'fixture: phase-3 gate must remain blocked');
  expect(fixture.canonicalUntilGateGreen === 'split_repos', 'fixture: split repos must remain canonical');
  expect(fixture.mirrorRefreshAllowed === false, 'fixture: mirror refresh must not be allowed');
  expect(fixture.canonicalFlipApproved === false, 'fixture: canonical flip must not be approved');
  expect(fixture.packageJobsMustBeEqualOrStricter === true, 'fixture: must require equal-or-stricter package jobs');

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
    expect(surface.mirrorRefreshAllowed === false, `fixture: ${surfaceName} mirror refresh must be false`);
    expect((surface.sourceCiCommands || []).includes('npm ci'), `fixture: ${surfaceName} must record source npm ci`);
    expect((surface.requiredPackageJobBeforeMirrorRefresh || []).length >= 6, `fixture: ${surfaceName} must list required package job gates`);
    expect((surface.blockingGaps || []).length >= 5, `fixture: ${surfaceName} must list blocking gaps`);
  }

  const broker = surfaces.get('broker');
  expect((broker?.requiredPackageJobBeforeMirrorRefresh || []).some((gate) => /generate-build-info/.test(gate)), 'fixture: broker must preserve build-info generation');
  expect((broker?.requiredPackageJobBeforeMirrorRefresh || []).some((gate) => /node --check scripts\/team1-dispatch-wrapper/.test(gate)), 'fixture: broker must preserve script syntax checks');

  const runner = surfaces.get('docker-runner');
  for (const gate of ['npm run build', 'npm run lint', 'npm test', 'pre-pr-bootstrap-guard', 'chaos:e2e', 'tag-release-candidate']) {
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
}
expect(/monorepo-phase3-package-ci-gate/.test(releaseGate), 'release gate must include phase-3 package CI gate check');

if (failures.length) {
  console.error(`monorepo phase-3 package CI gate validation failed:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}

console.log('monorepo phase-3 package CI gate ok');
