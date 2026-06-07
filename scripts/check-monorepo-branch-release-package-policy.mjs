#!/usr/bin/env node
/**
 * Validate the #517 monorepo branch protection and release/package policy.
 *
 * Safety: source-only fixture/doc validation. No GitHub settings, release,
 * package, image, visibility, canonical flip, live dispatch, restart,
 * credential, DB, or Terminal ACK action is performed here.
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

const fixture = parseJson('fixtures/current-state/monorepo-branch-release-package-policy.json');
const pkg = parseJson('package.json');
const doc = readRel('docs/release/monorepo-branch-release-package-policy.md');
const reentryDoc = readRel('docs/monorepo-reentry-decision.md');
const currentStateDoc = readRel('docs/current-state.md');
const operatorsDoc = readRel('docs/operators.md');
const migrationDoc = readRel('docs/migration.md');
const releaseGate = readRel('scripts/release-gate.mjs') || '';

expect(doc !== null, 'missing docs/release/monorepo-branch-release-package-policy.md');

if (fixture) {
  expect(fixture.schema === 'a2a.monorepo-branch-release-package-policy.v1', 'fixture: unexpected schema');
  expect(fixture.issue === 'https://github.com/jinwon-int/a2a-plane/issues/517', 'fixture: issue must be #517');
  expect(fixture.decision === 'policy_documented_without_settings_or_release_changes', 'fixture: unexpected decision');
  expect(fixture.canonicalFlipApproved === false, 'fixture: canonical flip must not be approved');
  expect(fixture.branchProtectionChanged === false, 'fixture: branch protection must not be changed');
  expect(fixture.releaseOrPackagePublished === false, 'fixture: release/package publish must be false');
  expect(fixture.packageInventoryVerified === false, 'fixture: package inventory must remain unverified');
  expect(/read:packages/.test(fixture.packageInventoryBlocker || ''), 'fixture: package inventory blocker must mention read:packages');

  const repos = new Map((fixture.repos || []).map((repo) => [repo.repo, repo]));
  for (const repo of [
    'jinwon-int/a2a-plane',
    'jinwon-int/a2a-broker',
    'jinwon-int/a2a-docker-runner',
    'jinwon-int/openclaw-plugin-a2a',
  ]) {
    expect(repos.has(repo), `fixture: missing repo ${repo}`);
    expect(repos.get(repo)?.visibility === 'PUBLIC', `fixture: ${repo} visibility must be PUBLIC`);
    expect(repos.get(repo)?.defaultBranch === 'main', `fixture: ${repo} defaultBranch must be main`);
    expect(repos.get(repo)?.rulesets === 'none', `fixture: ${repo} rulesets must be none`);
    expect(repos.get(repo)?.requiredReviews === false, `fixture: ${repo} must not have required reviews yet`);
    expect(repos.get(repo)?.historicalTag === 'source-public-20260511', `fixture: ${repo} historical tag missing`);
  }
  expect(repos.get('jinwon-int/a2a-plane')?.branchProtection === 'none', 'fixture: a2a-plane branch protection must be none');
  expect(/linear_history/.test(repos.get('jinwon-int/openclaw-plugin-a2a')?.branchProtection || ''), 'fixture: plugin protection must note linear history');

  for (const gate of [
    'protected_a2a_plane_main',
    'required_root_checks',
    'path_aware_package_checks_or_rulesets',
    'required_pr_review',
    'codeowners_review_enforcement',
    'package_inventory_verification',
    'operator_final_signoff',
  ]) {
    expect((fixture.requiredBeforeCanonicalFlip || []).includes(gate), `fixture: missing gate ${gate}`);
  }

  expect(fixture.releasePolicy?.splitReposRemainCanonical === true, 'fixture: split repos must remain canonical');
  expect(fixture.releasePolicy?.githubReleases === 'no_go_without_separate_approval', 'fixture: GitHub Releases must be no-go');
  expect(fixture.releasePolicy?.npmPublish === 'no_go_without_separate_approval', 'fixture: npm publish must be no-go');
  expect(fixture.releasePolicy?.githubPackages === 'no_go_until_inventory_verified_and_approved', 'fixture: GitHub Packages must be no-go');
  expect(fixture.releasePolicy?.dockerGhcrPublish === 'no_go_without_separate_approval', 'fixture: Docker/GHCR publish must be no-go');

  for (const [key, value] of Object.entries(fixture.boundaries || {})) {
    expect(value === false, `fixture: boundary.${key} must be false`);
  }
}

if (doc) {
  for (const phrase of [
    'a2a-plane#517',
    'Branch Protection Policy',
    'Release And Package Policy',
    'read:packages',
    'source-public-20260511',
    'Required checks',
    'CODEOWNERS review',
    'GitHub Packages',
    'Docker/GHCR',
    'canonical flip gate remains closed',
    'No-live Boundary',
  ]) {
    expect(doc.toLowerCase().includes(phrase.toLowerCase()), `doc: missing phrase "${phrase}"`);
  }
  expect(/a2a-plane\/main/.test(doc), 'doc: must mention a2a-plane/main');
  expect(/404 Branch not protected/.test(doc), 'doc: must record a2a-plane branch protection 404');
  expect(/No releases returned/.test(doc), 'doc: must record release API result');
}

for (const [name, text] of [
  ['reentry doc', reentryDoc],
  ['current-state doc', currentStateDoc],
  ['operators doc', operatorsDoc],
  ['migration doc', migrationDoc],
]) {
  expect(text !== null, `${name}: missing`);
  expect(/#517/.test(text || ''), `${name}: must reference #517`);
  expect(/branch protection/i.test(text || ''), `${name}: must mention branch protection`);
  expect(/release\/package|release and package|package policy/i.test(text || ''), `${name}: must mention release/package policy`);
}

if (pkg) {
  expect(
    pkg.scripts?.['check:monorepo-branch-release-policy'] === 'node scripts/check-monorepo-branch-release-package-policy.mjs',
    'package.json: missing check:monorepo-branch-release-policy script'
  );
}
expect(/monorepo-branch-release-policy/.test(releaseGate), 'release gate must include monorepo branch/release policy check');

if (failures.length) {
  console.error(`monorepo branch/release/package policy validation failed:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}

console.log('monorepo branch/release/package policy ok');
