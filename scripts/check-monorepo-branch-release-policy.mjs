#!/usr/bin/env node
/**
 * Validate the #517 monorepo branch protection and release/package policy.
 *
 * Safety: source-only fixture/doc validation. No GitHub settings change,
 * branch protection mutation, tag/release/package publish, live dispatch,
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

const fixture = parseJson('fixtures/current-state/monorepo-branch-release-policy.json');
const doc = readRel('docs/monorepo-branch-release-policy.md');
const currentState = readRel('docs/current-state.md');
const reentry = readRel('docs/monorepo-reentry-decision.md');
const pkg = parseJson('package.json');
const releaseGate = readRel('scripts/release-gate.mjs') || '';

expect(doc !== null, 'missing docs/monorepo-branch-release-policy.md');
expect(currentState !== null, 'missing docs/current-state.md');
expect(reentry !== null, 'missing docs/monorepo-reentry-decision.md');

if (fixture) {
  expect(fixture.schema === 'a2a.monorepo-branch-release-policy.v1', 'fixture: unexpected schema');
  expect(fixture.parentIssue === 'https://github.com/jinwon-int/a2a-plane/issues/511', 'fixture: parentIssue must be #511');
  expect(fixture.childIssue === 'https://github.com/jinwon-int/a2a-plane/issues/517', 'fixture: childIssue must be #517');
  expect(fixture.decision === 'record_branch_release_policy_without_settings_or_publish_mutation', 'fixture: decision must be policy-only');
  expect(fixture.canonicalFlipApproved === false, 'fixture: canonical flip must be false');
  expect(fixture.liveProtectionSnapshot?.repo === 'jinwon-int/a2a-plane', 'fixture: protection snapshot repo mismatch');
  expect(fixture.liveProtectionSnapshot?.branch === 'main', 'fixture: protection snapshot branch mismatch');
  expect(fixture.liveProtectionSnapshot?.branchProtectionApi === '404_branch_not_protected', 'fixture: must record branch protection 404');
  expect(fixture.liveProtectionSnapshot?.settingsChanged === false, 'fixture: settingsChanged must be false');
  expect((fixture.requiredBeforeCanonicalFlip || []).length >= 6, 'fixture: missing canonical flip gates');
  expect((fixture.branchProtectionRequirements || []).length >= 7, 'fixture: missing branch protection requirements');
  expect((fixture.historicalTags || []).some((tag) => tag.tag === 'source-public-20260511' && tag.moveOrDeleteApproved === false), 'fixture: source-public tag policy missing');
  expect(fixture.packageNamespacePolicy?.dockerRunner === 'split_repo_retains_public_cli_package_trust_boundary', 'fixture: docker runner trust boundary missing');
  expect(fixture.splitReposRemainProvenanceArchives === true, 'fixture: split repos must remain provenance archives');
  expect(fixture.closedIssuePrTransfer === false, 'fixture: closed issue/PR transfer must be false');
  expect(/independent_repository/.test(fixture.agentOlympicsBoundary || ''), 'fixture: agent-olympics boundary must be independent');
  for (const [key, value] of Object.entries(fixture.boundaries || {})) {
    expect(value === false, `fixture: boundary.${key} must be false`);
  }
}

if (doc) {
  for (const phrase of [
    'Branch Protection And Release Policy',
    '404 Branch not protected',
    'required status checks',
    'source-public-20260511',
    'not semantic releases',
    'Docker runner',
    'split repos remain provenance archives',
    'Agent Olympics',
    'No-live Boundary',
  ]) {
    expect(doc.toLowerCase().includes(phrase.toLowerCase()), `doc: missing phrase "${phrase}"`);
  }
  expect(/a2a-plane#511/.test(doc), 'doc: must reference #511');
  expect(/a2a-plane#517/.test(doc), 'doc: must reference #517');
}

if (currentState) {
  expect(/a2a-plane#517/.test(currentState), 'current-state doc: must reference completed #517');
  expect(/monorepo-branch-release-policy/.test(currentState), 'current-state doc: must link branch/release policy');
}

if (reentry) {
  expect(/Branch protection/.test(reentry), 'reentry doc: must retain branch protection gate');
  expect(/Release\/package policy/.test(reentry), 'reentry doc: must retain release/package policy gate');
}

if (pkg) {
  expect(
    pkg.scripts?.['check:monorepo-branch-release-policy'] === 'node scripts/check-monorepo-branch-release-policy.mjs',
    'package.json: missing check:monorepo-branch-release-policy script'
  );
}
expect(/monorepo-branch-release-policy/.test(releaseGate), 'release gate must include monorepo branch/release policy check');

if (failures.length) {
  console.error(`monorepo branch/release policy validation failed:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}

console.log('monorepo branch/release policy ok');
