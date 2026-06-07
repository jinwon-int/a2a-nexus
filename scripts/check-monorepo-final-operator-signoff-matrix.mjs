#!/usr/bin/env node
/**
 * Validate the #549 final operator sign-off matrix.
 *
 * Safety: source-only fixture/doc validation. No canonical flip, package
 * ownership transfer, GitHub settings change, split-repo disposition action,
 * release, tag, publish, deploy, restart, credential, DB, provider send, or
 * Terminal ACK action is performed here.
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

const fixture = parseJson('fixtures/current-state/monorepo-final-operator-signoff-matrix.json');
const doc = readRel('docs/monorepo-final-operator-signoff-matrix.md');
const currentState = readRel('docs/current-state.md');
const readiness = readRel('docs/monorepo-canonical-flip-readiness.md');
const splitDisposition = readRel('docs/monorepo-split-repo-disposition-rollback.md');
const releasePacket = readRel('docs/monorepo-release-package-tag-approval-packet.md');
const branchPacket = readRel('docs/monorepo-branch-protection-approval-packet.md');
const pkg = parseJson('package.json');
const releaseGate = readRel('scripts/release-gate.mjs') || '';

expect(doc !== null, 'missing docs/monorepo-final-operator-signoff-matrix.md');

if (fixture) {
  expect(fixture.schema === 'a2a.monorepo-final-operator-signoff-matrix.v1', 'fixture: unexpected schema');
  expect(fixture.parentIssue === 'https://github.com/jinwon-int/a2a-plane/issues/511', 'fixture: parent issue must be #511');
  expect(fixture.phase9FinalSignoffIssue === 'https://github.com/jinwon-int/a2a-plane/issues/549', 'fixture: phase9 issue must be #549');

  const priorPackets = fixture.priorPackets || {};
  const expectedPriorPackets = {
    phase4ImportPr: 'https://github.com/jinwon-int/a2a-plane/pull/540',
    phase5ReadinessPr: 'https://github.com/jinwon-int/a2a-plane/pull/542',
    phase6BranchProtectionPr: 'https://github.com/jinwon-int/a2a-plane/pull/544',
    phase7DispositionPr: 'https://github.com/jinwon-int/a2a-plane/pull/546',
    phase8ReleasePackageTagPr: 'https://github.com/jinwon-int/a2a-plane/pull/548',
    phase4MergeCommit: '31273ce05b7e53655e3d8847a8d77ff1cd2f6d05',
    phase5MergeCommit: '3a0f1abc6da4a16b3b6ea5a0a56e19d541082e4d',
    phase6MergeCommit: 'ff4390a3fbcb0f7fb85235c78eb3facc4a667495',
    phase7MergeCommit: '03cb496a145c130186f6d08a3fd9fd12dc04ef31',
    phase8MergeCommit: '7aefab9f870ccc5ed7ecfff8bcfaf6554f6b22e6',
  };
  for (const [key, value] of Object.entries(expectedPriorPackets)) {
    expect(priorPackets[key] === value, `fixture: priorPackets.${key} mismatch`);
  }

  for (const key of [
    'operatorFinalDecision',
    'canonicalFlipDecision',
    'packageOwnershipDecision',
    'releasePackageTagDecision',
    'branchProtectionDecision',
    'splitRepoDispositionDecision',
    'rollbackOwnerDecision',
  ]) {
    expect(fixture[key] === 'NO_GO_WAITING', `fixture: ${key} must be NO_GO_WAITING`);
  }

  const expectedAreas = new Set([
    'branch_protection_or_ruleset',
    'split_repo_disposition',
    'release_tag_and_github_release',
    'npm_publish',
    'docker_ghcr_publish',
    'package_ownership_transfer',
    'canonical_flip',
  ]);
  const rows = fixture.signoffRows || [];
  expect(rows.length === expectedAreas.size, 'fixture: signoffRows must contain seven rows');
  const seenAreas = new Set();
  for (const row of rows) {
    expect(expectedAreas.has(row.area), `fixture: unexpected signoff row ${row.area}`);
    expect(!seenAreas.has(row.area), `fixture: duplicate signoff row ${row.area}`);
    seenAreas.add(row.area);
    expect(row.decision === 'NO_GO_WAITING', `fixture: ${row.area} decision must be NO_GO_WAITING`);
    expect(row.operatorOwner === 'unassigned', `fixture: ${row.area} operatorOwner must be unassigned`);
    expect(row.rollbackOwner === 'unassigned', `fixture: ${row.area} rollbackOwner must be unassigned`);
    expect(row.approved === false, `fixture: ${row.area} approved must be false`);
    expect(typeof row.evidence === 'string' && row.evidence.startsWith('docs/'), `fixture: ${row.area} must point to docs evidence`);

    if (row.decision === 'GO' || row.approved === true) {
      expect(row.operatorOwner !== 'unassigned', `fixture: ${row.area} GO requires operator owner`);
      expect(row.rollbackOwner !== 'unassigned', `fixture: ${row.area} GO requires rollback owner`);
      expect(row.evidence !== 'unassigned', `fixture: ${row.area} GO requires evidence`);
    }
  }
  for (const area of expectedAreas) {
    expect(seenAreas.has(area), `fixture: missing signoff row ${area}`);
  }

  const goNoGo = fixture.goNoGoFields || {};
  expect(goNoGo.priorPacketsRecorded === true, 'fixture: prior packets must be recorded');
  for (const falseField of [
    'branchProtectionApprovalReady',
    'splitRepoDispositionApproved',
    'releasePackageTagApproved',
    'packageOwnershipTransferApproved',
    'rollbackOwnerAssigned',
    'canonicalFlipApproved',
    'operatorFinalApproval',
  ]) {
    expect(goNoGo[falseField] === false, `fixture: go/no-go ${falseField} must be false`);
  }
  expect(goNoGo.decision === 'NO_GO_WAITING', 'fixture: go/no-go decision must be NO_GO_WAITING');

  for (const condition of [
    'operator_owner_unassigned',
    'rollback_owner_unassigned',
    'latest_green_ci_evidence_unassigned',
    'live_or_destructive_action_bundled_with_flip',
  ]) {
    expect((fixture.abortConditions || []).includes(condition), `fixture: missing abort condition ${condition}`);
  }

  for (const [key, value] of Object.entries(fixture.boundaries || {})) {
    expect(value === false, `fixture: boundary.${key} must be false`);
  }
}

if (doc) {
  for (const phrase of [
    'a2a-plane#549',
    'NO_GO / Waiting',
    'Final Sign-off Matrix',
    'Prior Packet Evidence',
    'Abort Conditions',
    'No-live Boundary',
    '7aefab9f870ccc5ed7ecfff8bcfaf6554f6b22e6',
  ]) {
    expect(doc.toLowerCase().includes(phrase.toLowerCase()), `doc: missing phrase "${phrase}"`);
  }
}

for (const [name, text] of [
  ['current-state doc', currentState],
  ['canonical readiness doc', readiness],
  ['split disposition doc', splitDisposition],
  ['release packet doc', releasePacket],
  ['branch packet doc', branchPacket],
]) {
  expect(text !== null, `${name}: missing`);
  expect(/a2a-plane#549/.test(text || ''), `${name}: must reference #549`);
}

if (pkg) {
  expect(
    pkg.scripts?.['check:monorepo-final-operator-signoff'] === 'node scripts/check-monorepo-final-operator-signoff-matrix.mjs',
    'package.json: missing check:monorepo-final-operator-signoff script'
  );
}
expect(/monorepo-final-operator-signoff/.test(releaseGate), 'release gate must include final operator sign-off check');

if (failures.length) {
  console.error(`monorepo final operator sign-off validation failed:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}

console.log('monorepo final operator sign-off matrix ok');
