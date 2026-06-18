#!/usr/bin/env node
/**
 * Validate the #553 a2a-nexus split-repo disposition and rollback owner packet.
 *
 * Safety: source-only fixture/doc validation. No split repository setting,
 * canonical flip, release, publish, deploy, restart, credential, DB,
 * provider send, Terminal ACK, archive, read-only, or redirect action is
 * performed here.
 */
import { createDocCheckContext } from './lib/doc-check.mjs';

const { root, failures, fail, expect, readRel, parseJson } = createDocCheckContext();

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
  expect(fixture.snapshotDate === '2026-06-10', 'fixture: snapshot date must be 2026-06-10');
  expect(fixture.parentIssue === 'https://github.com/jinwon-int/a2a-nexus/issues/553', 'fixture: parent issue must be a2a-nexus#553');
  expect(fixture.operatorApprovalPr === 'https://github.com/jinwon-int/a2a-nexus/pull/563', 'fixture: operator approval PR must be #563');
  expect(fixture.operatorApprovalMergeCommit === '910a796b9540cb839a8fa4a1148aa38a90694eea', 'fixture: #563 merge commit mismatch');
  expect(fixture.branchProtectionPacketPr === 'https://github.com/jinwon-int/a2a-nexus/pull/564', 'fixture: branch-protection packet PR must be #564');
  expect(fixture.activeRuleset?.id === 17499616, 'fixture: active ruleset id must be 17499616');
  expect(fixture.activeRuleset?.name === 'a2a-nexus-main-required-checks', 'fixture: active ruleset name mismatch');
  expect(fixture.activeRuleset?.enforcement === 'active', 'fixture: active ruleset must be enforced');
  expect(/^a2a-splitdisposition-20260610T\d{6}Z$/.test(fixture.a2aDecisionRound || ''), 'fixture: A2A decision round id must be recorded');

  expect(fixture.splitRepoDispositionDecision === 'NO_GO_WAITING_ACTIVE_CANONICAL_REMAINS', 'fixture: split repo disposition decision must keep active_canonical');
  expect(fixture.rollbackOwnerDecision === 'NO_GO_WAITING_PARTIAL_BEFORE_FLIP_PR_REVERT_OWNER_ONLY', 'fixture: rollback owner decision mismatch');
  expect(fixture.canonicalFlipDecision === 'GO_CANDIDATE_PR_FIRST_EXECUTION_SEPARATED', 'fixture: canonical flip must be PR-first candidate only');
  expect(fixture.splitReposRemainCanonical === true, 'fixture: split repos must remain canonical');
  expect(fixture.canonicalFlipApproved === false, 'fixture: canonical flip must not be approved');
  expect(fixture.packageOwnershipTransferred === false, 'fixture: package ownership must not transfer');

  const expected = new Map([
    ['broker', ['jinwon-int/a2a-broker', 'packages/broker']],
    ['docker-runner', ['jinwon-int/a2a-docker-runner', 'packages/docker-runner']],
    ['openclaw-plugin-a2a', ['jinwon-int/plugin-a2a', 'packages/openclaw-plugin-a2a']],
  ]);
  const repos = new Map((fixture.repositories || []).map((entry) => [entry.surface, entry]));
  expect(repos.size === expected.size, 'fixture: must contain exactly three repositories');
  for (const [surface, [repo, targetPath]] of expected) {
    const entry = repos.get(surface);
    expect(Boolean(entry), `fixture: missing ${surface}`);
    if (!entry) continue;
    expect(entry.repo === repo, `fixture: ${surface} repo mismatch`);
    expect(entry.defaultBranch === 'main', `fixture: ${surface} default branch must be main`);
    expect(entry.monorepoTargetPath === targetPath, `fixture: ${surface} target path mismatch`);
    expect(entry.currentDisposition === 'active_canonical', `fixture: ${surface} must remain active_canonical`);
    expect(entry.candidateDisposition === 'active_canonical', `fixture: ${surface} candidate must remain active_canonical`);
  }
  expect(repos.get('openclaw-plugin-a2a')?.legacyRepoAlias === 'jinwon-int/openclaw-plugin-a2a', 'fixture: plugin legacy alias must be recorded');

  for (const option of ['active_canonical', 'active_mirrored', 'read_only_archive', 'archived_redirect']) {
    expect((fixture.dispositionOptions || []).includes(option), `fixture: missing disposition option ${option}`);
  }
  expect(Array.isArray(fixture.approvedDispositionChanges), 'fixture: approvedDispositionChanges must be an array');
  expect(fixture.approvedDispositionChanges.length === 0, 'fixture: no disposition changes may be approved');
  expect(fixture.candidateOnlyDisposition === 'active_mirrored', 'fixture: active_mirrored may only be candidate-only');

  const rollback = fixture.rollbackOwnerFields || {};
  expect(/normal_pr_revert/.test(rollback.beforeFlipPackageCandidateRegression || ''), 'fixture: before-flip rollback must be normal PR revert');
  for (const key of ['activeMirroredConflict', 'afterFlipPackageRegression', 'misappliedSplitRepoDisposition']) {
    expect(/unassigned/.test(rollback[key] || ''), `fixture: ${key} must be unassigned`);
  }
  expect(/unassigned/.test(rollback.releasePackageRegression || ''), 'fixture: release/package rollback owner must be unassigned');

  const evidence = fixture.workerEvidence || [];
  expect(evidence.length === 6, 'fixture: worker evidence must include six Team1+Team2 workers');
  for (const worker of ['sogyo', 'nosuk', 'bangtong', 'dungae', 'jingun', 'soonwook']) {
    const item = evidence.find((entry) => entry.worker === worker);
    expect(Boolean(item), `fixture: missing worker evidence for ${worker}`);
    if (!item) continue;
    expect(item.status === 'succeeded', `fixture: ${worker} evidence must be succeeded`);
    expect(item.taskId === `${fixture.a2aDecisionRound}-${worker}`, `fixture: ${worker} task id must match round`);
    expect(typeof item.summary === 'string' && item.summary.length > 20, `fixture: ${worker} summary must be recorded`);
  }
  for (const [worker, broker] of Object.entries({ sogyo: 'seoseo', nosuk: 'seoseo', bangtong: 'seoseo', dungae: 'gwakga', jingun: 'gwakga', soonwook: 'gwakga' })) {
    expect(evidence.find((entry) => entry.worker === worker)?.broker === broker, `fixture: ${worker} broker attribution mismatch`);
  }

  const risks = fixture.acceptedRiskRegister || {};
  for (const key of [
    'trackedTreeImportNotHistoryPreserving',
    'closedIssuesPrsRemainInSplitRepos',
    'branchProtectionRulesetApplied',
    'splitRepoDispositionUndecided',
    'postFlipRollbackOwnerUnassigned',
    'releasePackageTagPolicyUnapproved',
    'pluginRepoAliasDrift',
  ]) {
    expect(typeof risks[key] === 'string' && risks[key].length > 0, `fixture: risk ${key} must be recorded`);
  }

  const goNoGo = fixture.goNoGoFields || {};
  for (const trueField of ['splitReposRemainCanonical', 'a2aNexusRulesetApplied', 'dispositionOptionsRecorded', 'rollbackOwnerFieldsRecorded', 'acceptedRiskRegisterRecorded']) {
    expect(goNoGo[trueField] === true, `fixture: go/no-go ${trueField} must be true`);
  }
  for (const falseField of ['splitRepoDispositionApproved', 'activeMirroredApproved', 'readOnlyArchiveApproved', 'archivedRedirectApproved', 'postFlipRollbackOwnerAssigned', 'packageOwnershipTransferred', 'canonicalFlipApproved']) {
    expect(goNoGo[falseField] === false, `fixture: go/no-go ${falseField} must be false`);
  }
  expect(goNoGo.decision === 'NO_GO_WAITING_ACTIVE_CANONICAL_REMAINS', 'fixture: go/no-go decision must keep active_canonical');

  for (const [key, value] of Object.entries(fixture.boundaries || {})) {
    expect(value === false, `fixture: boundary.${key} must be false`);
  }
}

if (doc) {
  for (const phrase of [
    'a2a-nexus#553',
    'a2a-nexus#563',
    'a2a-nexus#564',
    'NO_GO / Waiting',
    'Current Source Lineage',
    'A2A Review Evidence',
    'Disposition Options',
    'Rollback Owner Fields',
    'Accepted-risk Register',
    'Required Follow-up Before Execution',
    'No-live Boundary',
    'active_canonical',
    'active_mirrored',
    'read_only_archive',
    'archived_redirect',
    'jinwon-int/plugin-a2a',
  ]) {
    expect(doc.toLowerCase().includes(phrase.toLowerCase()), `doc: missing phrase "${phrase}"`);
  }
  for (const worker of ['sogyo', 'nosuk', 'bangtong', 'dungae', 'jingun', 'soonwook']) {
    expect(doc.includes(`\`${worker}\``), `doc: missing worker ${worker}`);
  }
  for (const forbidden of ['archive/read-only/redirect actions remain `GO`', 'canonicalFlipApproved` | `true`']) {
    expect(!doc.includes(forbidden), `doc: forbidden approval wording ${forbidden}`);
  }
}

if (currentState) {
  expect(/a2a-nexus#553/.test(currentState), 'current-state: must reference active #553');
  expect(/monorepo-split-repo-disposition-rollback\.md/.test(currentState), 'current-state: must reference split-repo disposition packet');
  expect(/active_canonical/.test(currentState), 'current-state: must record active_canonical posture');
}

if (readiness) {
  expect(/a2a-nexus#553/.test(readiness), 'readiness doc: must reference active #553 lane');
  expect(/rollback owner/i.test(readiness), 'readiness doc: must reference rollback owner');
}

if (branchPacket) {
  expect(/a2a-nexus#553/.test(branchPacket), 'branch packet doc: must reference #553');
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
