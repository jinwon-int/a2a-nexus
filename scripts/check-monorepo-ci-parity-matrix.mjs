#!/usr/bin/env node
/**
 * Validate the #514 monorepo CI parity matrix.
 *
 * Safety: source-only fixture/doc validation. No import, history rewrite,
 * release, publish, visibility, live dispatch, restart, credential, DB, or
 * Terminal ACK action is performed here.
 */
import { createDocCheckContext } from './lib/doc-check.mjs';

const { root, failures, fail, expect, readRel, parseJson } = createDocCheckContext();

const fixturePath = 'fixtures/current-state/monorepo-ci-parity-matrix.json';
const docPath = 'docs/monorepo-ci-parity-matrix.md';
const reentryDocPath = 'docs/monorepo-reentry-decision.md';
const currentStateDocPath = 'docs/current-state.md';
const packagePath = 'package.json';

const fixture = parseJson(fixturePath);
const doc = readRel(docPath);
const reentryDoc = readRel(reentryDocPath);
const currentStateDoc = readRel(currentStateDocPath);
const pkg = parseJson(packagePath);

expect(doc !== null, `missing ${docPath}`);
expect(reentryDoc !== null, `missing ${reentryDocPath}`);
expect(currentStateDoc !== null, `missing ${currentStateDocPath}`);

if (fixture) {
  expect(fixture.schema === 'a2a.monorepo-ci-parity-matrix.v1', 'fixture: unexpected schema');
  expect(fixture.parentIssue === 'https://github.com/jinwon-int/a2a-plane/issues/511', 'fixture: parentIssue must be #511');
  expect(fixture.childIssue === 'https://github.com/jinwon-int/a2a-plane/issues/514', 'fixture: childIssue must be #514');
  expect(fixture.refreshIssue === 'https://github.com/jinwon-int/a2a-plane/issues/528', 'fixture: refreshIssue must be #528');
  expect(fixture.phase2Issue === 'https://github.com/jinwon-int/a2a-plane/issues/530', 'fixture: phase2Issue must be #530');
  expect(fixture.phase4FreshImportCandidateIssue === 'https://github.com/jinwon-int/a2a-plane/issues/538', 'fixture: phase4FreshImportCandidateIssue must be #538');
  expect(fixture.phase2Decision === 'package_ci_parity_not_equal_or_stricter_yet', 'fixture: phase2 decision must keep parity blocked');
  expect(fixture.phase4CandidateDecision === 'package_ci_green_locally_but_canonical_flip_not_approved', 'fixture: phase4 decision must keep canonical flip blocked');
  expect(fixture.decision === 'record_ci_parity_matrix_without_canonical_flip', 'fixture: decision must be matrix-only');
  expect(fixture.canonicalUntilParityGreen === 'split_repos', 'fixture: split repos must remain canonical');
  expect(fixture.canonicalFlipApproved === false, 'fixture: canonical flip must not be approved');

  const expected = new Map([
    ['broker', ['jinwon-int/a2a-broker', 'packages/broker', 'f9f4af5a76649a37b8a3d492805b6e5f410683a6']],
    ['docker-runner', ['jinwon-int/a2a-docker-runner', 'packages/docker-runner', '269a0ef90737158b41f8da26241b9f7f4b14af5e']],
    ['openclaw-plugin-a2a', ['jinwon-int/openclaw-plugin-a2a', 'packages/openclaw-plugin-a2a', 'a2e521271483ef0b6a29907c8228f0a442dd2db9']],
  ]);
  const repos = new Map((fixture.sourceRepos || []).map((repo) => [repo.surface, repo]));
  expect(repos.size === expected.size, 'fixture: must contain exactly the three A2A implementation repos');

  for (const [surface, [sourceRepo, targetPath, sourceMain]] of expected) {
    const repo = repos.get(surface);
    expect(Boolean(repo), `fixture: missing source repo ${surface}`);
    if (!repo) continue;
    expect(repo.sourceRepo === sourceRepo, `fixture: ${surface} sourceRepo mismatch`);
    expect(repo.targetPath === targetPath, `fixture: ${surface} targetPath mismatch`);
    expect(repo.sourceMain === sourceMain, `fixture: ${surface} sourceMain mismatch`);
    expect(repo.parityStatus === 'fresh_import_candidate_package_ci_green_canonical_flip_blocked', `fixture: ${surface} parity must be candidate-green but flip-blocked`);
    expect((repo.sourceWorkflow?.actions || []).includes('actions/checkout@v5'), `fixture: ${surface} must record split checkout@v5`);
    expect((repo.sourceWorkflow?.actions || []).includes('actions/setup-node@v5'), `fixture: ${surface} must record split setup-node@v5`);
    expect((repo.planeJob?.actions || []).includes('actions/checkout@v5'), `fixture: ${surface} must record plane checkout@v5`);
    expect((repo.planeJob?.actions || []).includes('actions/setup-node@v5'), `fixture: ${surface} must record plane setup-node@v5`);
    expect((repo.sourceWorkflow?.commands || []).includes('npm ci'), `fixture: ${surface} source workflow must include npm ci`);
    expect((repo.planeJob?.commands || []).includes('npm ci --include=dev'), `fixture: ${surface} plane job must record npm ci --include=dev`);
    expect(!(repo.planeJob?.commands || []).some((command) => /--ignore-scripts/.test(command)), `fixture: ${surface} plane job must not ignore lifecycle scripts`);
    expect((repo.requiredBeforeAuthoritative || []).length >= 5, `fixture: ${surface} needs required-before-authoritative items`);
    expect((repo.knownDifferences || []).length >= 5, `fixture: ${surface} needs known differences`);
    expect(repo.phase2PackageParity?.equalOrStricter === false, `fixture: ${surface} phase2 parity must not be equal-or-stricter yet`);
    expect(repo.phase2PackageParity?.freshPrefixRehearsal?.sourceRef === sourceMain, `fixture: ${surface} phase2 source ref mismatch`);
    expect(
      Number.isInteger(repo.phase2PackageParity?.freshPrefixRehearsal?.statusCounts?.changed) &&
        Number.isInteger(repo.phase2PackageParity?.freshPrefixRehearsal?.statusCounts?.addedOrUntracked),
      `fixture: ${surface} must record phase2 rehearsal status counts`
    );
    expect(
      (repo.phase2PackageParity?.blockingGaps || []).length >= 5,
      `fixture: ${surface} must list blocking package CI gaps`
    );
    expect(
      (repo.phase2PackageParity?.requiredBeforeMirrorRefresh || []).length >= 5,
      `fixture: ${surface} must list required gates before mirror refresh`
    );
  }

  expect(!Array.from(repos.values()).some((repo) => /agent-olympics/i.test(repo.sourceRepo || '')), 'fixture: agent-olympics must not be a source repo');
  expect((fixture.outOfScopeRepos || []).some((repo) => repo.repo === 'jinwon-int/agent-olympics'), 'fixture: agent-olympics must be explicitly out of scope');

  for (const gate of [
    'test:conformance',
    'scan:external-secrets',
    'scan:readiness-gates',
    'check:monorepo-reentry',
    'check:monorepo-import-rehearsal',
    'check:monorepo-ci-parity',
  ]) {
    expect((fixture.sharedUmbrellaGates || []).includes(gate), `fixture: missing shared gate ${gate}`);
  }

  for (const [key, value] of Object.entries(fixture.boundaries || {})) {
    expect(value === false, `fixture: boundary.${key} must be false`);
  }
}

if (doc) {
  for (const phrase of [
    'CI Parity Matrix',
    'Split repo CI remains canonical',
    'Not green for canonical flip',
    'package-boundary gap',
    'Agent Olympics is out of scope',
    'canonical flip gate remains closed',
    'No-live Boundary',
    'Phase-2 Parity Gate',
    'a2a-plane#530',
  ]) {
    expect(doc.toLowerCase().includes(phrase.toLowerCase()), `doc: missing phrase "${phrase}"`);
  }
  expect(/a2a-plane#511/.test(doc), 'doc: must reference #511');
  expect(/a2a-plane#514/.test(doc), 'doc: must reference #514');
  expect(/a2a-plane#528/.test(doc), 'doc: must reference #528');
}

if (reentryDoc) {
  expect(/CI parity matrix/.test(reentryDoc), 'reentry doc: must reference CI parity matrix');
  expect(/Not green/.test(reentryDoc), 'reentry doc: CI parity gate must not be green');
}

if (currentStateDoc) {
  expect(/a2a-plane#514/.test(currentStateDoc), 'current-state doc: must reference completed #514');
  expect(/a2a-plane#515/.test(currentStateDoc), 'current-state doc: must reference completed #515');
  expect(/a2a-plane#517/.test(currentStateDoc), 'current-state doc: must keep #517 active');
  expect(/a2a-plane#528/.test(currentStateDoc), 'current-state doc: must reference completed #528');
  expect(/a2a-plane#530/.test(currentStateDoc), 'current-state doc: must reference completed #530');
  expect(/#531/.test(currentStateDoc), 'current-state doc: must reference the #531 merge closeout');
}

if (pkg) {
  expect(
    pkg.scripts?.['check:monorepo-ci-parity'] === 'node scripts/check-monorepo-ci-parity-matrix.mjs',
    'package.json: missing check:monorepo-ci-parity script'
  );
  const releaseGate = readRel('scripts/release-gate.mjs') || '';
  expect(/monorepo-ci-parity/.test(releaseGate), 'release gate must include monorepo CI parity check');
}

if (failures.length) {
  console.error(`monorepo CI parity matrix validation failed:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}

console.log('monorepo CI parity matrix ok');
