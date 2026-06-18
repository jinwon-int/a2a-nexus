#!/usr/bin/env node
/**
 * Validate the #553 a2a-nexus final operator sign-off / canonical source packet.
 *
 * Safety: source-only fixture/doc validation. No canonical flip execution,
 * package ownership transfer, GitHub settings change, split-repo disposition
 * action, release, tag, publish, deploy, restart, credential, DB, provider send,
 * Telegram send, or Terminal ACK/replay action is performed here.
 */
import { createDocCheckContext } from './lib/doc-check.mjs';

const { root, failures, fail, expect, readRel, parseJson } = createDocCheckContext();

const fixture = parseJson('fixtures/current-state/monorepo-final-operator-signoff-matrix.json');
const doc = readRel('docs/monorepo-final-operator-signoff-matrix.md');
const currentState = readRel('docs/current-state.md');
const readiness = readRel('docs/monorepo-canonical-flip-readiness.md');
const splitDisposition = readRel('docs/monorepo-split-repo-disposition-rollback.md');
const releasePacket = readRel('docs/monorepo-release-package-tag-approval-packet.md');
const branchPacket = readRel('docs/monorepo-branch-protection-approval-packet.md');
const operatorHandoff = readRel('docs/monorepo-operator-approval-handoff.md');
const pkg = parseJson('package.json');
const releaseGate = readRel('scripts/release-gate.mjs') || '';

expect(doc !== null, 'missing docs/monorepo-final-operator-signoff-matrix.md');

if (fixture) {
  expect(fixture.schema === 'a2a.monorepo-final-operator-signoff-matrix.v1', 'fixture: unexpected schema');
  expect(fixture.parentIssue === 'https://github.com/jinwon-int/a2a-nexus/issues/553', 'fixture: parent issue must be a2a-nexus#553');
  expect(fixture.historicalFinalSignoffIssue === 'https://github.com/jinwon-int/a2a-plane/issues/549', 'fixture: historical #549 must be retained');
  expect(/^a2a-finalpacket(?:-retry)?-20260610T\d{6}Z$/.test(fixture.a2aDecisionRound || ''), 'fixture: A2A final packet round id must be recorded');
  expect(fixture.latestMainCommit === 'bf36a68ab8a38c0fbea0710d979c165d4f9b07f9', 'fixture: latest main commit mismatch');

  const a2aEvidence = fixture.a2aEvidence || {};
  expect(a2aEvidence.primaryRound === 'a2a-finalpacket-retry-20260610T123212Z', 'fixture: primary A2A round mismatch');
  expect(a2aEvidence.supplementalRetryRound === 'a2a-finalpacket-jingun-retry-20260610T123834Z', 'fixture: supplemental Jingun retry round mismatch');
  expect(a2aEvidence.sourceOnly === true, 'fixture: A2A evidence must be source-only');
  expect(a2aEvidence.githubCommentsByWorkers === false, 'fixture: worker GitHub comments must remain disabled');
  const expectedWorkers = new Map([
    ['sogyo', 'Team1'],
    ['nosuk', 'Team1'],
    ['bangtong', 'Team1'],
    ['dungae', 'Team2'],
    ['jingun', 'Team2'],
    ['soonwook', 'Team2'],
  ]);
  const seenWorkers = new Set();
  for (const workerEvidence of a2aEvidence.workers || []) {
    expect(expectedWorkers.get(workerEvidence.worker) === workerEvidence.team, `fixture: unexpected A2A worker/team ${workerEvidence.worker}/${workerEvidence.team}`);
    expect(workerEvidence.analysisStatus === 'done', `fixture: ${workerEvidence.worker} A2A analysis must be done`);
    expect(typeof workerEvidence.taskId === 'string' && workerEvidence.taskId.length > 10, `fixture: ${workerEvidence.worker} task id must be recorded`);
    seenWorkers.add(workerEvidence.worker);
  }
  for (const worker of expectedWorkers.keys()) expect(seenWorkers.has(worker), `fixture: missing A2A worker ${worker}`);

  const priorPackets = fixture.priorPackets || {};
  const expectedPriorPackets = {
    activeDriftCloseoutPr: 'https://github.com/jinwon-int/a2a-nexus/pull/562',
    activeDriftCloseoutMergeCommit: '9669f9098459c9f17bdea0193bc428593b0ef2d5',
    operatorHandoffPr: 'https://github.com/jinwon-int/a2a-nexus/pull/563',
    operatorHandoffMergeCommit: '910a796b9540cb839a8fa4a1148aa38a90694eea',
    branchProtectionRulesetPr: 'https://github.com/jinwon-int/a2a-nexus/pull/564',
    branchProtectionRulesetMergeCommit: '33de5b493e4f4d156a5900ad4d924a138147329c',
    splitRepoDispositionPr: 'https://github.com/jinwon-int/a2a-nexus/pull/566',
    splitRepoDispositionMergeCommit: 'bf36a68ab8a38c0fbea0710d979c165d4f9b07f9',
    historicalFinalSignoffPr: 'https://github.com/jinwon-int/a2a-plane/pull/550',
    historicalFinalSignoffMergeCommit: '7200a91a92bbdbc82855a5a22321d704fdf2ca29',
  };
  for (const [key, value] of Object.entries(expectedPriorPackets)) {
    expect(priorPackets[key] === value, `fixture: priorPackets.${key} mismatch`);
  }

  const ruleset = fixture.activeRuleset || {};
  expect(ruleset.id === 17499616, 'fixture: active ruleset id mismatch');
  expect(ruleset.name === 'a2a-nexus-main-required-checks', 'fixture: active ruleset name mismatch');
  expect(ruleset.enforcement === 'active', 'fixture: active ruleset must be active');
  expect(ruleset.target === 'main', 'fixture: active ruleset target must be main');
  expect(ruleset.requiredApprovingReviews === 1, 'fixture: required approving reviews must be 1');
  for (const check of ['paths-filter', 'setup', 'layout', 'contracts', 'check']) {
    expect((ruleset.requiredChecks || []).includes(check), `fixture: active ruleset missing required check ${check}`);
  }
  expect(Array.isArray(ruleset.bypassActors) && ruleset.bypassActors.length === 0, 'fixture: no bypass actors expected');

  expect(fixture.operatorFinalDecision === 'GO_CANDIDATE_PR_FIRST_SOURCE_ONLY', 'fixture: operator final decision mismatch');
  expect(fixture.canonicalSourceDecision === 'GO_CANDIDATE_PR_FIRST_SOURCE_DECLARATION', 'fixture: canonical source decision mismatch');
  for (const [key, value] of [
    ['canonicalFlipDecision', 'NO_GO_EXECUTION_SEPARATE'],
    ['packageOwnershipDecision', 'NO_GO_EXECUTION_SEPARATE'],
    ['releasePackageTagDecision', 'NO_GO_WAITING'],
    ['branchProtectionDecision', 'RECORDED_ACTIVE_NO_FURTHER_CHANGE'],
    ['splitRepoDispositionDecision', 'RECORDED_ACTIVE_CANONICAL_REMAINS'],
  ]) {
    expect(fixture[key] === value, `fixture: ${key} mismatch`);
  }

  const candidates = fixture.canonicalSourceCandidates || [];
  const expectedCandidatePaths = new Set(['packages/broker', 'packages/docker-runner', 'packages/openclaw-plugin-a2a']);
  expect(candidates.length === expectedCandidatePaths.size, 'fixture: canonicalSourceCandidates must list three packages');
  for (const candidate of candidates) {
    expect(expectedCandidatePaths.has(candidate.path), `fixture: unexpected canonical source path ${candidate.path}`);
    expect(candidate.packetDecision === 'canonical_source_candidate', `fixture: ${candidate.path} must be source candidate only`);
    expect(candidate.executionApproved === false, `fixture: ${candidate.path} execution must be false`);
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
    expect(typeof row.evidence === 'string' && row.evidence.startsWith('docs/'), `fixture: ${row.area} must point to docs evidence`);
    expect(row.executionApproved === false, `fixture: ${row.area} executionApproved must be false`);
    if (['package_ownership_transfer', 'canonical_flip', 'branch_protection_or_ruleset', 'split_repo_disposition'].includes(row.area)) {
      expect(row.approvedForPrFirstPacket === true, `fixture: ${row.area} should be approved for PR-first packet only`);
    }
    if (row.area.includes('release') || row.area.includes('publish')) {
      expect(row.decision === 'NO_GO_WAITING', `fixture: ${row.area} must remain NO_GO_WAITING`);
    }
  }
  for (const area of expectedAreas) expect(seenAreas.has(area), `fixture: missing signoff row ${area}`);

  const goNoGo = fixture.goNoGoFields || {};
  expect(goNoGo.priorPacketsRecorded === true, 'fixture: prior packets must be recorded');
  expect(goNoGo.branchProtectionRulesetActive === true, 'fixture: branch ruleset must be active');
  expect(goNoGo.splitRepoDispositionPacketRecorded === true, 'fixture: split disposition packet must be recorded');
  expect(goNoGo.canonicalSourceDeclarationPrFirstApproved === true, 'fixture: canonical source declaration PR-first must be approved');
  for (const falseField of ['releasePackageTagApproved', 'packageOwnershipTransferApproved', 'canonicalFlipExecutionApproved', 'operatorFinalExecutionApproval']) {
    expect(goNoGo[falseField] === false, `fixture: go/no-go ${falseField} must be false`);
  }
  expect(goNoGo.decision === 'GO_CANDIDATE_PR_FIRST_SOURCE_ONLY', 'fixture: go/no-go decision mismatch');

  for (const condition of [
    'latest_green_ci_missing_or_red',
    'ruleset_disabled_or_required_checks_removed',
    'split_repo_archive_readonly_redirect_bundled',
    'release_package_tag_publish_bundled',
    'deploy_restart_db_secret_provider_terminal_ack_bundled',
    'registry_or_package_owner_transfer_bundled',
    'force_push_or_history_rewrite_bundled',
  ]) {
    expect((fixture.abortConditions || []).includes(condition), `fixture: missing abort condition ${condition}`);
  }

  for (const [key, value] of Object.entries(fixture.boundaries || {})) {
    expect(value === false, `fixture: boundary.${key} must be false`);
  }
}

if (doc) {
  for (const phrase of [
    'a2a-nexus#553',
    'a2a-plane#549',
    'a2a-plane#551',
    'GO_CANDIDATE / PR-first',
    'canonical source declaration',
    'bf36a68ab8a38c0fbea0710d979c165d4f9b07f9',
    '17499616',
    'No-live Boundary',
  ]) {
    expect(doc.toLowerCase().includes(phrase.toLowerCase()), `doc: missing phrase "${phrase}"`);
  }
}

for (const [name, text, pattern] of [
  ['current-state doc', currentState, /a2a-nexus#553/],
  ['canonical readiness doc', readiness, /a2a-nexus#553/],
  ['split disposition doc', splitDisposition, /a2a-nexus#553/],
  ['release packet doc', releasePacket, /a2a-plane#547|a2a-nexus#553/],
  ['branch packet doc', branchPacket, /a2a-nexus#553/],
  ['operator handoff doc', operatorHandoff, /a2a-nexus#553/],
]) {
  expect(text !== null, `${name}: missing`);
  expect(pattern.test(text || ''), `${name}: missing active lineage reference`);
}

if (pkg) {
  expect(pkg.scripts?.['check:monorepo-final-operator-signoff'] === 'node scripts/check-monorepo-final-operator-signoff-matrix.mjs', 'package.json: missing check:monorepo-final-operator-signoff script');
}
expect(/monorepo-final-operator-signoff/.test(releaseGate), 'release gate must include final operator sign-off check');

if (failures.length) {
  console.error(`monorepo final operator sign-off validation failed:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}

console.log('monorepo final operator sign-off matrix ok');
