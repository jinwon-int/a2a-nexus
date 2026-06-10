#!/usr/bin/env node
/**
 * Validate the a2a-nexus monorepo branch-protection / ruleset execution packet.
 *
 * Safety: source-only fixture/doc validation. No GitHub settings, canonical
 * flip, release, publish, deploy, restart, credential, DB, provider send, or
 * Terminal ACK action is performed here.
 */
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const failures = [];

function fail(message) { failures.push(message); }
function expect(condition, message) { if (!condition) fail(message); }
function readRel(rel) {
  try { return fs.readFileSync(path.join(root, rel), 'utf8'); } catch { return null; }
}
function parseJson(rel) {
  const text = readRel(rel);
  if (text === null) { fail(`missing ${rel}`); return null; }
  try { return JSON.parse(text); } catch (error) {
    fail(`${rel}: invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

const fixturePath = 'fixtures/current-state/monorepo-branch-protection-approval-packet.json';
const docPath = 'docs/monorepo-branch-protection-approval-packet.md';
const currentStatePath = 'docs/current-state.md';
const readinessPath = 'docs/monorepo-canonical-flip-readiness.md';

const fixture = parseJson(fixturePath);
const doc = readRel(docPath);
const currentState = readRel(currentStatePath);
const readiness = readRel(readinessPath);
const pkg = parseJson('package.json');
const workflow = readRel('.github/workflows/ci.yml') || '';
const releaseGate = readRel('scripts/release-gate.mjs') || '';

expect(doc !== null, `missing ${docPath}`);

if (fixture) {
  expect(fixture.schema === 'a2a.monorepo-branch-protection-approval-packet.v1', 'fixture: unexpected schema');
  expect(fixture.parentIssue === 'https://github.com/jinwon-int/a2a-nexus/issues/553', 'fixture: parent issue must be a2a-nexus#553');
  expect(fixture.operatorApprovalPr === 'https://github.com/jinwon-int/a2a-nexus/pull/563', 'fixture: operator approval PR must be #563');
  expect(fixture.operatorApprovalMergeCommit === '910a796b9540cb839a8fa4a1148aa38a90694eea', 'fixture: operator approval merge commit mismatch');
  expect(fixture.a2aDecisionRound === 'a2a-branchpacket-20260610T093001Z', 'fixture: A2A decision round mismatch');
  expect(fixture.branchProtectionDecision === 'PACKET_READY_WAITING_SCOPED_APPROVAL', 'fixture: branch protection decision must be packet-ready waiting scoped approval');
  expect(fixture.canonicalFlipDecision === 'GO_CANDIDATE_PR_FIRST_EXECUTION_SEPARATED', 'fixture: canonical flip must remain execution-separated');
  expect(fixture.settingsChanged === false, 'fixture: settings must not be changed');
  expect(fixture.canonicalFlipApproved === false, 'fixture: canonical flip execution must not be approved');
  expect(fixture.packageOwnershipTransferred === false, 'fixture: package ownership must not transfer');

  const posture = fixture.liveReadOnlyPosture || {};
  expect(posture.repository === 'jinwon-int/a2a-nexus', 'fixture: posture repository must be a2a-nexus');
  expect(posture.branch === 'main', 'fixture: posture branch mismatch');
  expect(posture.branchProtectionApi === '404_branch_not_protected', 'fixture: branch protection API result mismatch');
  expect(posture.rulesetsApi === 'empty_array', 'fixture: rulesets API result mismatch');
  expect(posture.branchProtectionCurrentlyAbsent === true, 'fixture: branch protection absence must be true');
  expect(posture.rulesetsCurrentlyAbsent === true, 'fixture: rulesets absence must be true');

  const ci = fixture.latestMonorepoCiEvidence || {};
  expect(ci.pr === 'https://github.com/jinwon-int/a2a-nexus/pull/563', 'fixture: latest CI PR must be #563');
  expect(ci.runId === '27264318468', 'fixture: latest CI run id mismatch');
  expect(ci.headCommit === '784c2a7f88d55a568e14424a1798dded2963bd21', 'fixture: latest CI head mismatch');
  expect(ci.mergeCommit === '910a796b9540cb839a8fa4a1148aa38a90694eea', 'fixture: latest CI merge commit mismatch');
  for (const job of ['paths-filter', 'setup', 'layout', 'broker', 'plugin', 'contracts', 'check']) {
    expect((ci.passedJobs || []).includes(job), `fixture: missing passed CI job ${job}`);
  }
  for (const job of ['docker-runner', 'docs']) {
    expect((ci.skippedJobs || []).includes(job), `fixture: missing skipped CI job ${job}`);
  }

  const inventory = fixture.workflowJobInventory || {};
  for (const job of ['paths-filter', 'setup', 'layout', 'broker', 'docker-runner', 'plugin', 'contracts', 'docs', 'check']) {
    expect((inventory.jobs || []).includes(job), `fixture: missing workflow job ${job}`);
    expect(new RegExp(`^\\s{2}${job}:`, 'm').test(workflow), `workflow: missing job ${job}`);
  }

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
  expect(required.missingRequiredCheckWouldBlockAllMerges === true, 'fixture: missing required checks must be treated as merge blockers');

  const exec = fixture.executionPacket || {};
  expect(exec.targetRepository === 'jinwon-int/a2a-nexus', 'fixture: execution target repo mismatch');
  expect(exec.targetBranch === 'main', 'fixture: execution target branch mismatch');
  expect(exec.settingsMutationNow === false, 'fixture: execution packet must not mutate settings now');
  expect(/evaluate/i.test(exec.evaluateOnlyPhase || ''), 'fixture: evaluate-only phase must be recorded');
  expect(/scoped approval/i.test(exec.enforcePhase || ''), 'fixture: enforce phase must require scoped approval');
  expect(exec.recommendedRulesetName === 'a2a-nexus-main-required-checks', 'fixture: ruleset name mismatch');
  expect(exec.recommendedRequiredReviewCount === 1, 'fixture: review count must be one');
  expect(exec.adminCoverage === 'include_admins_unless_operator_explicitly_exempts', 'fixture: admin coverage default mismatch');
  expect(/seoseo finalizer/.test(exec.rollbackOwner || ''), 'fixture: rollback owner must name seoseo finalizer');
  for (const pattern of ['.github/workflows/**', 'scripts/**', 'packages/**', 'contracts/**', 'fixtures/**', 'scanner/**']) {
    expect((exec.criticalPathRulesets || []).includes(pattern), `fixture: missing critical path ${pattern}`);
  }
  expect((exec.abortConditions || []).length >= 5, 'fixture: abort conditions must be recorded');

  for (const requirement of [
    'repository_and_branch_or_ruleset_target',
    'required_checks_and_path_aware_package_behavior',
    'pr_review_count_and_codeowners_choice',
    'stale_review_up_to_date_merge_queue_admin_coverage_choices',
    'settings_only_rollback_or_noop_path',
    'separate_from_canonical_flip_release_deploy_send_or_credentials',
    'fresh_scoped_operator_approval_before_settings_mutation',
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
  for (const trueField of ['latestMonorepoCiGreen', 'branchProtectionCurrentlyAbsent', 'rulesetsCurrentlyAbsent', 'requiredCheckCandidateRecorded', 'executionPacketRecorded']) {
    expect(goNoGo[trueField] === true, `fixture: go/no-go ${trueField} must be true`);
  }
  for (const falseField of ['operatorBranchProtectionApproval', 'settingsChanged', 'canonicalFlipApproved']) {
    expect(goNoGo[falseField] === false, `fixture: go/no-go ${falseField} must be false`);
  }
  expect(goNoGo.decision === 'PACKET_READY_WAITING_SCOPED_APPROVAL', 'fixture: go/no-go decision mismatch');

  for (const [key, value] of Object.entries(fixture.boundaries || {})) {
    expect(value === false, `fixture: boundary.${key} must be false`);
  }
}

if (doc) {
  for (const phrase of [
    'a2a-nexus#553',
    'a2a-nexus#563',
    'a2a-branchpacket-20260610T093001Z',
    'PACKET_READY',
    '404 Branch not protected',
    'Required-check Candidate',
    'Evaluation / Enforcement Phases',
    'Rollback / No-op Path',
    'Abort Conditions',
    'No-live Boundary',
  ]) {
    expect(doc.toLowerCase().includes(phrase.toLowerCase()), `doc: missing phrase "${phrase}"`);
  }
}

if (currentState) {
  expect(/a2a-nexus#553/.test(currentState), 'current-state: must reference active #553');
  expect(/branch protection/i.test(currentState), 'current-state: must describe branch protection work');
}

if (readiness) {
  expect(/GO_CANDIDATE/i.test(readiness), 'readiness doc: must keep GO_CANDIDATE posture');
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
