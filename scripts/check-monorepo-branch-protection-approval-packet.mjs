#!/usr/bin/env node
/**
 * Validate the #543 monorepo branch-protection approval packet.
 *
 * Safety: source-only fixture/doc validation. No GitHub settings, canonical
 * flip, release, publish, deploy, restart, credential, DB, provider send, or
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

const fixturePath = 'fixtures/current-state/monorepo-branch-protection-approval-packet.json';
const docPath = 'docs/monorepo-branch-protection-approval-packet.md';
const currentStatePath = 'docs/current-state.md';
const ciParityPath = 'docs/monorepo-ci-parity-matrix.md';
const readinessPath = 'docs/monorepo-canonical-flip-readiness.md';

const fixture = parseJson(fixturePath);
const doc = readRel(docPath);
const currentState = readRel(currentStatePath);
const ciParity = readRel(ciParityPath);
const readiness = readRel(readinessPath);
const pkg = parseJson('package.json');
const releaseGate = readRel('scripts/release-gate.mjs') || '';

expect(doc !== null, `missing ${docPath}`);

if (fixture) {
  expect(fixture.schema === 'a2a.monorepo-branch-protection-approval-packet.v1', 'fixture: unexpected schema');
  expect(fixture.parentIssue === 'https://github.com/jinwon-int/a2a-plane/issues/511', 'fixture: parent issue must be #511');
  expect(fixture.phase5ReadinessIssue === 'https://github.com/jinwon-int/a2a-plane/issues/541', 'fixture: phase5 issue must be #541');
  expect(fixture.phase5ReadinessPr === 'https://github.com/jinwon-int/a2a-plane/pull/542', 'fixture: phase5 PR must be #542');
  expect(fixture.phase6ApprovalPacketIssue === 'https://github.com/jinwon-int/a2a-plane/issues/543', 'fixture: phase6 issue must be #543');
  expect(fixture.phase5MergeCommit === '3a0f1abc6da4a16b3b6ea5a0a56e19d541082e4d', 'fixture: #542 merge commit mismatch');
  expect(fixture.phase5HeadCommit === '71fb92a4bede59f76c4599867f19843ced162b6e', 'fixture: #542 head commit mismatch');
  expect(fixture.branchProtectionDecision === 'NO_GO_WAITING', 'fixture: branch protection decision must be NO_GO_WAITING');
  expect(fixture.canonicalFlipDecision === 'NO_GO_WAITING', 'fixture: canonical flip must remain NO_GO_WAITING');
  expect(fixture.settingsChanged === false, 'fixture: settings must not be changed');
  expect(fixture.canonicalFlipApproved === false, 'fixture: canonical flip must not be approved');
  expect(fixture.packageOwnershipTransferred === false, 'fixture: package ownership must not transfer');

  const posture = fixture.liveReadOnlyPosture || {};
  expect(posture.repository === 'jinwon-int/a2a-plane', 'fixture: posture repository mismatch');
  expect(posture.branch === 'main', 'fixture: posture branch mismatch');
  expect(posture.branchProtectionApi === '404_branch_not_protected', 'fixture: branch protection API result mismatch');
  expect(posture.rulesetsApi === 'empty_array', 'fixture: rulesets API result mismatch');
  expect(posture.branchProtectionCurrentlyAbsent === true, 'fixture: branch protection absence must be true');
  expect(posture.rulesetsCurrentlyAbsent === true, 'fixture: rulesets absence must be true');

  const ci = fixture.latestMonorepoCiEvidence || {};
  expect(ci.pr === 'https://github.com/jinwon-int/a2a-plane/pull/542', 'fixture: latest CI PR mismatch');
  expect(ci.runId === '27099569029', 'fixture: latest CI run id mismatch');
  expect(ci.headCommit === '71fb92a4bede59f76c4599867f19843ced162b6e', 'fixture: latest CI head mismatch');
  expect(ci.mergeCommit === '3a0f1abc6da4a16b3b6ea5a0a56e19d541082e4d', 'fixture: latest CI merge commit mismatch');
  for (const job of ['paths-filter', 'setup', 'contracts', 'layout', 'broker', 'plugin', 'docker-runner', 'check']) {
    expect((ci.passedJobs || []).includes(job), `fixture: missing passed CI job ${job}`);
  }
  expect((ci.skippedJobs || []).includes('docs'), 'fixture: docs skip must be recorded');

  const required = fixture.requiredCheckCandidate || {};
  for (const job of ['paths-filter', 'setup', 'layout', 'contracts', 'check']) {
    expect((required.alwaysRequired || []).includes(job), `fixture: missing always-required check ${job}`);
  }
  for (const [job, pathHint] of [
    ['broker', 'packages/broker/**'],
    ['docker-runner', 'packages/docker-runner/**'],
    ['plugin', 'packages/openclaw-plugin-a2a/**'],
  ]) {
    expect(Array.isArray(required.pathAwarePackageChecks?.[job]), `fixture: missing path-aware package check ${job}`);
    expect((required.pathAwarePackageChecks?.[job] || []).includes(pathHint), `fixture: ${job} missing path hint ${pathHint}`);
  }
  expect(required.docsJobPathFiltered === true, 'fixture: docs job must remain path filtered');
  expect(required.skippedPackageJobsAreNotFreshnessProof === true, 'fixture: skipped package jobs must not be freshness proof');

  const decisions = fixture.reviewAndRulesetDecisions || {};
  for (const key of ['protectedMain', 'requiredPrReview', 'upToDateBranchOrMergeQueue', 'staleReviewDismissal']) {
    expect(decisions[key] === 'not_applied', `fixture: ${key} must be not_applied`);
  }
  expect(/not_applied/.test(decisions.codeownersReview || ''), 'fixture: CODEOWNERS review must not be applied');
  expect(decisions.adminCoverage === 'operator_must_decide_explicitly', 'fixture: admin coverage must require operator decision');
  for (const pattern of ['.github/workflows/**', 'scripts/**', 'packages/**', 'contracts/**', 'fixtures/**', 'scanner/**']) {
    expect((decisions.criticalPathRulesets || []).includes(pattern), `fixture: missing critical path ${pattern}`);
  }

  for (const requirement of [
    'repository_and_branch_or_ruleset_target',
    'required_checks_and_path_aware_package_behavior',
    'pr_review_count_and_codeowners_choice',
    'stale_review_up_to_date_merge_queue_admin_coverage_choices',
    'settings_only_rollback_or_noop_path',
    'separate_from_canonical_flip_release_deploy_send_or_credentials',
  ]) {
    expect((fixture.approvalRequirements || []).includes(requirement), `fixture: missing approval requirement ${requirement}`);
  }

  const rollback = fixture.rollbackPolicy || {};
  expect(/no_source_rollback_required/.test(rollback.declinedApproval || ''), 'fixture: declined approval must require no source rollback');
  expect(/settings_only_revert/.test(rollback.misappliedSettings || ''), 'fixture: misapplied settings rollback must be settings-only');
  for (const falseField of ['sourceHistoryRewriteAllowed', 'forcePushAllowed', 'packagePublishAllowed', 'splitRepoArchiveAllowed', 'canonicalOwnershipTransferAllowed']) {
    expect(rollback[falseField] === false, `fixture: rollback.${falseField} must be false`);
  }

  const goNoGo = fixture.goNoGoFields || {};
  for (const trueField of ['latestMonorepoCiGreen', 'branchProtectionCurrentlyAbsent', 'rulesetsCurrentlyAbsent', 'requiredCheckCandidateRecorded']) {
    expect(goNoGo[trueField] === true, `fixture: go/no-go ${trueField} must be true`);
  }
  for (const falseField of ['operatorBranchProtectionApproval', 'settingsChanged', 'canonicalFlipApproved']) {
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
    '404 Branch not protected',
    'rulesets',
    'Required-check Candidate',
    'Approval Text Shape',
    'Rollback / No-op Path',
    'GO / NO-GO Fields',
    'No-live Boundary',
  ]) {
    expect(doc.toLowerCase().includes(phrase.toLowerCase()), `doc: missing phrase "${phrase}"`);
  }
  for (const ref of ['a2a-plane#541', 'a2a-plane#542', 'a2a-plane#543', '27099569029', '71fb92a4bede59f76c4599867f19843ced162b6e']) {
    expect(doc.includes(ref), `doc: missing ${ref}`);
  }
}

if (currentState) {
  expect(/a2a-plane#543/.test(currentState), 'current-state: must reference active #543');
  expect(/a2a-plane#542/.test(currentState), 'current-state: must reference completed #542');
  expect(/branch protection approval packet/i.test(currentState), 'current-state: must describe branch protection approval packet');
}

if (ciParity) {
  expect(/Phase-6 Branch Protection Approval Packet/.test(ciParity), 'CI parity doc: must reference phase-6 approval packet');
  expect(/NO_GO \/ Waiting/.test(ciParity), 'CI parity doc: must keep NO_GO / Waiting');
}

if (readiness) {
  expect(/a2a-plane#543/.test(readiness), 'readiness doc: must reference #543');
  expect(/branch protection approval packet/i.test(readiness), 'readiness doc: must reference branch protection approval packet');
}

if (pkg) {
  expect(
    pkg.scripts?.['check:monorepo-branch-protection-approval-packet'] === 'node scripts/check-monorepo-branch-protection-approval-packet.mjs',
    'package.json: missing check:monorepo-branch-protection-approval-packet script'
  );
}
expect(/monorepo-branch-protection-approval-packet/.test(releaseGate), 'release gate must include branch protection approval packet check');

if (failures.length) {
  console.error(`monorepo branch protection approval packet validation failed:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}

console.log('monorepo branch protection approval packet ok');
