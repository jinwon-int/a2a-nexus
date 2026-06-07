#!/usr/bin/env node
/**
 * Validate the #545 split-repo disposition and rollback owner packet.
 *
 * Safety: source-only fixture/doc validation. No split repository setting,
 * canonical flip, release, publish, deploy, restart, credential, DB,
 * provider send, or Terminal ACK action is performed here.
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

const fixture = parseJson('fixtures/current-state/monorepo-split-repo-disposition-rollback.json');
const doc = readRel('docs/monorepo-split-repo-disposition-rollback.md');
const currentState = readRel('docs/current-state.md');
const readiness = readRel('docs/monorepo-canonical-flip-readiness.md');
const branchPacket = readRel('docs/monorepo-branch-protection-approval-packet.md');
const pkg = parseJson('package.json');
const releaseGate = readRel('scripts/release-gate.mjs') || '';

expect(doc !== null, 'missing docs/monorepo-split-repo-disposition-rollback.md');

if (fixture) {
  expect(fixture.schema === 'a2a.monorepo-split-repo-disposition-rollback.v1', 'fixture: unexpected schema');
  expect(fixture.parentIssue === 'https://github.com/jinwon-int/a2a-plane/issues/511', 'fixture: parent issue must be #511');
  expect(fixture.phase4ImportPr === 'https://github.com/jinwon-int/a2a-plane/pull/540', 'fixture: phase4 PR must be #540');
  expect(fixture.phase5ReadinessPr === 'https://github.com/jinwon-int/a2a-plane/pull/542', 'fixture: phase5 PR must be #542');
  expect(fixture.phase6BranchProtectionPr === 'https://github.com/jinwon-int/a2a-plane/pull/544', 'fixture: phase6 PR must be #544');
  expect(fixture.phase7DispositionIssue === 'https://github.com/jinwon-int/a2a-plane/issues/545', 'fixture: phase7 issue must be #545');
  expect(fixture.phase4MergeCommit === '31273ce05b7e53655e3d8847a8d77ff1cd2f6d05', 'fixture: #540 merge commit mismatch');
  expect(fixture.phase5MergeCommit === '3a0f1abc6da4a16b3b6ea5a0a56e19d541082e4d', 'fixture: #542 merge commit mismatch');
  expect(fixture.phase6MergeCommit === 'ff4390a3fbcb0f7fb85235c78eb3facc4a667495', 'fixture: #544 merge commit mismatch');
  expect(fixture.splitRepoDispositionDecision === 'NO_GO_WAITING', 'fixture: split repo disposition decision must be NO_GO_WAITING');
  expect(fixture.rollbackOwnerDecision === 'NO_GO_WAITING', 'fixture: rollback owner decision must be NO_GO_WAITING');
  expect(fixture.canonicalFlipDecision === 'NO_GO_WAITING', 'fixture: canonical flip must remain NO_GO_WAITING');
  expect(fixture.splitReposRemainCanonical === true, 'fixture: split repos must remain canonical');
  expect(fixture.canonicalFlipApproved === false, 'fixture: canonical flip must not be approved');
  expect(fixture.packageOwnershipTransferred === false, 'fixture: package ownership must not transfer');

  const expected = new Map([
    ['broker', ['jinwon-int/a2a-broker', 'f9f4af5a76649a37b8a3d492805b6e5f410683a6', 'packages/broker']],
    ['docker-runner', ['jinwon-int/a2a-docker-runner', '269a0ef90737158b41f8da26241b9f7f4b14af5e', 'packages/docker-runner']],
    ['openclaw-plugin-a2a', ['jinwon-int/openclaw-plugin-a2a', 'a2e521271483ef0b6a29907c8228f0a442dd2db9', 'packages/openclaw-plugin-a2a']],
  ]);
  const repos = new Map((fixture.repositories || []).map((entry) => [entry.surface, entry]));
  expect(repos.size === expected.size, 'fixture: must contain exactly three repositories');
  for (const [surface, [repo, ref, targetPath]] of expected) {
    const entry = repos.get(surface);
    expect(Boolean(entry), `fixture: missing ${surface}`);
    if (!entry) continue;
    expect(entry.repo === repo, `fixture: ${surface} repo mismatch`);
    expect(entry.importedSourceRef === ref, `fixture: ${surface} source ref mismatch`);
    expect(entry.planeTargetPath === targetPath, `fixture: ${surface} target path mismatch`);
    expect(entry.currentDisposition === 'active_canonical', `fixture: ${surface} must remain active_canonical`);
  }

  for (const option of ['active_canonical', 'active_mirrored', 'read_only_archive', 'archived_redirect']) {
    expect((fixture.dispositionOptions || []).includes(option), `fixture: missing disposition option ${option}`);
  }
  expect(Array.isArray(fixture.approvedDispositionChanges), 'fixture: approvedDispositionChanges must be an array');
  expect(fixture.approvedDispositionChanges.length === 0, 'fixture: no disposition changes may be approved');

  const rollback = fixture.rollbackOwnerFields || {};
  expect(/normal_pr_revert/.test(rollback.beforeFlipPackageCandidateRegression || ''), 'fixture: before-flip rollback must be normal PR revert');
  for (const key of ['afterFlipPackageRegression', 'misappliedSplitRepoDisposition']) {
    expect(rollback[key] === 'unassigned', `fixture: ${key} must be unassigned`);
  }
  expect(/unassigned/.test(rollback.releasePackageRegression || ''), 'fixture: release/package rollback owner must be unassigned');

  const risks = fixture.acceptedRiskRegister || {};
  for (const key of [
    'trackedTreeImportNotHistoryPreserving',
    'closedIssuesPrsRemainInSplitRepos',
    'branchProtectionSettingsNotApplied',
    'splitRepoDispositionUndecided',
    'postFlipRollbackOwnerUnassigned',
    'releasePackageTagPolicyUnapproved',
  ]) {
    expect(typeof risks[key] === 'string' && risks[key].length > 0, `fixture: risk ${key} must be recorded`);
  }

  const goNoGo = fixture.goNoGoFields || {};
  for (const trueField of ['splitReposRemainCanonical', 'dispositionOptionsRecorded', 'rollbackOwnerFieldsRecorded', 'acceptedRiskRegisterRecorded']) {
    expect(goNoGo[trueField] === true, `fixture: go/no-go ${trueField} must be true`);
  }
  for (const falseField of ['splitRepoDispositionApproved', 'postFlipRollbackOwnerAssigned', 'canonicalFlipApproved']) {
    expect(goNoGo[falseField] === false, `fixture: go/no-go ${falseField} must be false`);
  }
  expect(goNoGo.decision === 'NO_GO_WAITING', 'fixture: go/no-go decision must be NO_GO_WAITING');

  for (const [key, value] of Object.entries(fixture.boundaries || {})) {
    expect(value === false, `fixture: boundary.${key} must be false`);
  }
}

if (doc) {
  for (const phrase of [
    'NO_GO / Waiting',
    'Current Source Lineage',
    'Disposition Options',
    'Rollback Owner Fields',
    'Accepted-risk Register',
    'No-live Boundary',
  ]) {
    expect(doc.toLowerCase().includes(phrase.toLowerCase()), `doc: missing phrase "${phrase}"`);
  }
  for (const ref of ['a2a-plane#540', 'a2a-plane#542', 'a2a-plane#544', 'a2a-plane#545']) {
    expect(doc.includes(ref), `doc: missing ${ref}`);
  }
}

if (currentState) {
  expect(/a2a-plane#545/.test(currentState), 'current-state: must reference active #545');
  expect(/split-repo disposition/i.test(currentState), 'current-state: must describe split-repo disposition');
}

if (readiness) {
  expect(/a2a-plane#545/.test(readiness), 'readiness doc: must reference #545');
  expect(/rollback owner/i.test(readiness), 'readiness doc: must reference rollback owner');
}

if (branchPacket) {
  expect(/a2a-plane#545/.test(branchPacket), 'branch packet doc: must reference #545');
  expect(/split-repo disposition/i.test(branchPacket), 'branch packet doc: must reference split-repo disposition');
}

if (pkg) {
  expect(
    pkg.scripts?.['check:monorepo-split-repo-disposition-rollback'] === 'node scripts/check-monorepo-split-repo-disposition-rollback.mjs',
    'package.json: missing check:monorepo-split-repo-disposition-rollback script'
  );
}
expect(/monorepo-split-repo-disposition-rollback/.test(releaseGate), 'release gate must include split-repo disposition check');

if (failures.length) {
  console.error(`monorepo split-repo disposition validation failed:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}

console.log('monorepo split-repo disposition rollback ok');
