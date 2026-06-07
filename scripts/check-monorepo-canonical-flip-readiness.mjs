#!/usr/bin/env node
/**
 * Validate the #541 monorepo canonical-flip readiness packet.
 *
 * Safety: source-only fixture/doc validation. No canonical flip, branch
 * protection change, release, publish, deploy, restart, credential, DB,
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

const fixturePath = 'fixtures/current-state/monorepo-canonical-flip-readiness.json';
const docPath = 'docs/monorepo-canonical-flip-readiness.md';
const currentStatePath = 'docs/current-state.md';
const ciParityPath = 'docs/monorepo-ci-parity-matrix.md';
const importPath = 'docs/monorepo-import-rehearsal.md';

const fixture = parseJson(fixturePath);
const doc = readRel(docPath);
const currentState = readRel(currentStatePath);
const ciParity = readRel(ciParityPath);
const importDoc = readRel(importPath);
const pkg = parseJson('package.json');
const releaseGate = readRel('scripts/release-gate.mjs') || '';

expect(doc !== null, `missing ${docPath}`);

if (fixture) {
  expect(fixture.schema === 'a2a.monorepo-canonical-flip-readiness.v1', 'fixture: unexpected schema');
  expect(fixture.parentIssue === 'https://github.com/jinwon-int/a2a-plane/issues/511', 'fixture: parent issue must be #511');
  expect(fixture.phase4FreshImportCandidateIssue === 'https://github.com/jinwon-int/a2a-plane/issues/538', 'fixture: phase4 issue must be #538');
  expect(fixture.phase4FreshImportPr === 'https://github.com/jinwon-int/a2a-plane/pull/540', 'fixture: phase4 PR must be #540');
  expect(fixture.phase5ReadinessIssue === 'https://github.com/jinwon-int/a2a-plane/issues/541', 'fixture: phase5 issue must be #541');
  expect(fixture.phase4MergeCommit === '31273ce05b7e53655e3d8847a8d77ff1cd2f6d05', 'fixture: #540 merge commit mismatch');
  expect(fixture.phase4HeadCommit === 'a35f379840a768acf5bcb4656c0b1f26a7e05e19', 'fixture: #540 head commit mismatch');
  expect(fixture.canonicalFlipDecision === 'NO_GO_WAITING', 'fixture: decision must be NO_GO_WAITING');
  expect(fixture.canonicalImplementationSource === 'split_repos', 'fixture: split repos must remain canonical');
  expect(fixture.canonicalFlipApproved === false, 'fixture: canonical flip must not be approved');
  expect(fixture.packageOwnershipTransferred === false, 'fixture: package ownership must not transfer');
  expect(fixture.importMode === 'git_archive_tracked_tree_not_history_preserving', 'fixture: import mode must record non-history-preserving archive import');

  const expectedPackages = new Map([
    ['broker', ['jinwon-int/a2a-broker', 'f9f4af5a76649a37b8a3d492805b6e5f410683a6', 'packages/broker', 'broker']],
    ['docker-runner', ['jinwon-int/a2a-docker-runner', '269a0ef90737158b41f8da26241b9f7f4b14af5e', 'packages/docker-runner', 'docker-runner']],
    ['openclaw-plugin-a2a', ['jinwon-int/openclaw-plugin-a2a', 'a2e521271483ef0b6a29907c8228f0a442dd2db9', 'packages/openclaw-plugin-a2a', 'plugin']],
  ]);
  const packages = new Map((fixture.importedPackages || []).map((entry) => [entry.surface, entry]));
  expect(packages.size === expectedPackages.size, 'fixture: must contain exactly three imported packages');

  for (const [surface, [sourceRepo, sourceRef, targetPath, packageParityJob]] of expectedPackages) {
    const entry = packages.get(surface);
    expect(Boolean(entry), `fixture: missing ${surface}`);
    if (!entry) continue;
    expect(entry.sourceRepo === sourceRepo, `fixture: ${surface} source repo mismatch`);
    expect(entry.sourceRef === sourceRef, `fixture: ${surface} source ref mismatch`);
    expect(entry.targetPath === targetPath, `fixture: ${surface} target path mismatch`);
    expect(entry.packageParityJob === packageParityJob, `fixture: ${surface} package parity job mismatch`);
    expect(entry.status === 'package_ci_green_not_canonical', `fixture: ${surface} must be green but not canonical`);
  }

  for (const job of ['paths-filter', 'setup', 'contracts', 'layout', 'broker', 'plugin', 'docker-runner', 'check']) {
    expect((fixture.ciEvidence?.passedJobs || []).includes(job), `fixture: missing passed CI job ${job}`);
  }
  expect((fixture.ciEvidence?.skippedJobs || []).includes('docs'), 'fixture: docs skip must be recorded');
  expect(fixture.ciEvidence?.runId === '27099159202', 'fixture: CI run id mismatch');
  for (const checkStep of ['npm run check', 'npm run check:quickstart-conformance', 'npm run check:external-harness-conformance', 'npm run test:release-gate']) {
    expect((fixture.ciEvidence?.checkJobIncludes || []).includes(checkStep), `fixture: missing check job step ${checkStep}`);
  }

  expect(/keep_in_split_repos/.test(fixture.provenancePolicy?.closedIssuePrHistory || ''), 'fixture: split issue/PR history must stay in split repos');
  expect(/cite_split_repo_and_source_ref/.test(fixture.provenancePolicy?.futureCitations || ''), 'fixture: future citations must cite split refs');
  expect(/do_not_move_or_reuse/.test(fixture.provenancePolicy?.tagPolicy || ''), 'fixture: tags must not move or be reused');
  expect(fixture.provenancePolicy?.historyImport === 'not_performed', 'fixture: history import must be not performed');

  expect(/normal_pr_revert/.test(fixture.rollbackPolicy?.beforeFlip || ''), 'fixture: rollback must be normal PR revert before flip');
  expect(fixture.rollbackPolicy?.splitRepoRollbackRequired === false, 'fixture: split repo rollback must not be required before flip');
  expect(fixture.rollbackPolicy?.destructiveCleanupAllowed === false, 'fixture: destructive cleanup must be blocked');

  const goNoGo = fixture.goNoGoFields || {};
  for (const trueField of ['packageParityGreen', 'rootGateGreen', 'provenancePolicyRecorded', 'rollbackPathRecorded']) {
    expect(goNoGo[trueField] === true, `fixture: go/no-go ${trueField} must be true`);
  }
  for (const falseField of ['branchProtectionReady', 'releasePackagePolicyReady', 'splitRepoDispositionApproved', 'operatorCanonicalFlipApproval']) {
    expect(goNoGo[falseField] === false, `fixture: go/no-go ${falseField} must be false`);
  }
  expect(goNoGo.decision === 'NO_GO_WAITING', 'fixture: go/no-go decision must be NO_GO_WAITING');

  for (const gate of [
    'operator_canonical_flip_approval',
    'a2a_plane_main_branch_protection_or_ruleset_decision',
    'release_package_tag_policy_execution_approval',
    'split_repo_archival_or_read_only_disposition',
    'rollback_owner_and_post_flip_revert_path',
  ]) {
    expect((fixture.remainingGates || []).includes(gate), `fixture: missing remaining gate ${gate}`);
  }

  for (const [key, value] of Object.entries(fixture.boundaries || {})) {
    expect(value === false, `fixture: boundary.${key} must be false`);
  }
}

if (doc) {
  for (const phrase of [
    'NO_GO / Waiting',
    'split_repos',
    'not history-preserving',
    'CI Evidence',
    'Provenance Policy',
    'Rollback Path',
    'Remaining Gates',
    'GO / NO-GO Fields',
    'No-live Boundary',
  ]) {
    expect(doc.toLowerCase().includes(phrase.toLowerCase()), `doc: missing phrase "${phrase}"`);
  }
  for (const ref of ['a2a-plane#538', 'a2a-plane#540', 'a2a-plane#541', '31273ce05b7e53655e3d8847a8d77ff1cd2f6d05']) {
    expect(doc.includes(ref), `doc: missing ${ref}`);
  }
}

if (currentState) {
  expect(/a2a-plane#541/.test(currentState), 'current-state: must reference active #541');
  expect(/a2a-plane#540/.test(currentState), 'current-state: must reference merged #540');
  expect(/canonical-flip readiness/i.test(currentState), 'current-state: must describe canonical-flip readiness');
}

if (ciParity) {
  expect(/Phase-5 Canonical Flip Readiness/.test(ciParity), 'CI parity doc: must reference phase-5 readiness');
  expect(/NO_GO \/ Waiting/.test(ciParity), 'CI parity doc: must keep NO_GO / Waiting');
}

if (importDoc) {
  expect(/Phase-5 Canonical Flip Readiness/.test(importDoc), 'import doc: must reference phase-5 readiness');
  expect(/not history-preserving/i.test(importDoc), 'import doc: must record non-history-preserving import');
}

if (pkg) {
  expect(
    pkg.scripts?.['check:monorepo-canonical-flip-readiness'] === 'node scripts/check-monorepo-canonical-flip-readiness.mjs',
    'package.json: missing check:monorepo-canonical-flip-readiness script'
  );
}
expect(/monorepo-canonical-flip-readiness/.test(releaseGate), 'release gate must include canonical flip readiness check');

if (failures.length) {
  console.error(`monorepo canonical flip readiness validation failed:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}

console.log('monorepo canonical flip readiness ok');
