#!/usr/bin/env node
/**
 * Validate the a2a-nexus canonical source flip execution handoff packet.
 * Safety: source-only fixture/doc validation. No live action is performed here.
 */
import fs from 'node:fs';
import path from 'node:path';
const root = process.cwd();
const failures = [];
function fail(message) { failures.push(message); }
function expect(condition, message) { if (!condition) fail(message); }
function readRel(rel) { try { return fs.readFileSync(path.join(root, rel), 'utf8'); } catch { return null; } }
function parseJson(rel) { const text = readRel(rel); if (text === null) { fail(`missing ${rel}`); return null; } try { return JSON.parse(text); } catch (error) { fail(`${rel}: invalid JSON: ${error instanceof Error ? error.message : String(error)}`); return null; } }
const fixture = parseJson('fixtures/current-state/monorepo-canonical-source-flip-execution-handoff.json');
const doc = readRel('docs/monorepo-canonical-source-flip-execution-handoff.md');
const currentState = readRel('docs/current-state.md');
const pkg = parseJson('package.json');
const releaseGate = readRel('scripts/release-gate.mjs') || '';
expect(doc !== null, 'missing docs/monorepo-canonical-source-flip-execution-handoff.md');
if (fixture) {
  expect(fixture.schema === 'a2a.monorepo-canonical-source-flip-execution-handoff.v1', 'fixture: unexpected schema');
  expect(fixture.tracker === 'https://github.com/jinwon-int/a2a-nexus/issues/553', 'fixture: tracker must be #553');
  expect(fixture.repo === 'jinwon-int/a2a-nexus', 'fixture: repo mismatch');
  expect(fixture.sourceCommit === 'b8e863d5a251a6603f3caf9329d1bb0dfb5c6fe0', 'fixture: source commit mismatch');
  expect(fixture.priorPackets?.finalOperatorSignoffCanonicalSourcePacket === 'https://github.com/jinwon-int/a2a-nexus/pull/567', 'fixture: PR #567 must be prior packet');
  expect(fixture.activeRuleset?.id === 17499616, 'fixture: active ruleset id mismatch');
  expect(fixture.activeRuleset?.enforcement === 'active', 'fixture: ruleset must be active');
  expect(fixture.activeRuleset?.target === 'main', 'fixture: ruleset target must be main');
  expect(fixture.activeRuleset?.requiredApprovingReviews === 1, 'fixture: must require one approving review');
  for (const check of ['paths-filter', 'setup', 'layout', 'contracts', 'check']) expect((fixture.activeRuleset?.requiredStatusChecks || []).includes(check), `fixture: missing required check ${check}`);
  expect(Array.isArray(fixture.activeRuleset?.bypassActors) && fixture.activeRuleset.bypassActors.length === 0, 'fixture: bypass actors must be empty');
  expect(fixture.handoffDecision === 'GO_PR_FIRST_SOURCE_ONLY', 'fixture: handoff decision mismatch');
  expect(fixture.actualCanonicalFlipExecution === 'NO_GO_WAITING_SEPARATE_APPROVAL_REQUIRED', 'fixture: actual execution must remain NO_GO');
  expect(fixture.canonicalSourceDeclaration === 'GO_CANDIDATE_PR_FIRST_SOURCE_ONLY', 'fixture: canonical declaration mismatch');
  for (const candidate of ['packages/broker','packages/docker-runner','packages/openclaw-plugin-a2a']) expect((fixture.canonicalSourceCandidates || []).includes(candidate), `fixture: missing candidate ${candidate}`);
  const evidence = fixture.a2aEvidence || {};
  expect(evidence.primaryRound === 'a2a-canonicalflip-20260610T131555Z', 'fixture: primary round mismatch');
  expect((evidence.supplementalRounds || []).includes('a2a-canonicalflip-retry-20260610T132021Z'), 'fixture: missing supplemental round');
  expect((evidence.supplementalRounds || []).includes('a2a-canonicalflip-sogyo-retry-20260610T132313Z'), 'fixture: missing sogyo supplemental round');
  expect(evidence.usableAnalysisCount >= 5, 'fixture: must record at least five usable analyses');
  expect(evidence.dissentRecorded === true, 'fixture: must record dissent guardrail');
  for (const worker of ['sogyo','nosuk','bangtong','dungae','jingun','soonwook']) expect((evidence.workers || []).some((entry) => entry.worker === worker), `fixture: missing A2A worker ${worker}`);
  expect((evidence.workers || []).some((entry) => entry.worker === 'sogyo' && entry.dissent === true), 'fixture: must record Sogyo dissent');
  expect(/actual execution-sensitive action/.test(evidence.finalizerSynthesis || ''), 'fixture: synthesis must keep execution actions on hold');
  const goNoGo = fixture.goNoGoFields || {};
  for (const trueField of ['finalOperatorSignoffPacketMerged','a2aNexusRulesetActive','requiredReviewEnforced','requiredChecksNamed','canonicalSourceCandidatesNamed','rollbackAbortOwnerRecorded','sourceOnlyA2aEvidenceRecorded','handoffPrAllowed']) expect(goNoGo[trueField] === true, `fixture: go/no-go ${trueField} must be true`);
  for (const falseField of ['actualCanonicalFlipApproved','packageOwnershipTransferred','splitRepoDispositionExecuted','releasePublishDeployApproved','settingsMutationApproved']) expect(goNoGo[falseField] === false, `fixture: go/no-go ${falseField} must be false`);
  expect(goNoGo.decision === 'GO_PR_FIRST_SOURCE_ONLY__EXECUTION_NO_GO_WAITING', 'fixture: decision mismatch');
  for (const approval of ['actual_canonical_flip_execution','split_repo_archive_readonly_redirect','package_ownership_transfer','release_tag_github_release','npm_publish','docker_ghcr_publish','deploy_restart','db_mutation_or_replay','secret_or_credential_movement','provider_or_telegram_send','terminal_ack_or_replay']) expect((fixture.remainingSeparateApprovals || []).includes(approval), `fixture: missing remaining approval ${approval}`);
  expect(/normal PR revert/.test(fixture.rollbackPolicy?.beforeActualExecution || ''), 'fixture: before-execution rollback must be PR revert');
  expect(/not_defined_here/.test(fixture.rollbackPolicy?.afterActualExecution || ''), 'fixture: after-execution rollback must be deferred');
  expect(fixture.rollbackPolicy?.destructiveCleanupAllowed === false, 'fixture: destructive cleanup must be blocked');
  const boundaries = fixture.boundaries || {};
  expect(boundaries.sourceOnly === true, 'fixture: sourceOnly boundary must be true');
  for (const [key, value] of Object.entries(boundaries)) if (key !== 'sourceOnly') expect(value === false, `fixture: boundary.${key} must be false`);
}
if (doc) {
  for (const phrase of ['GO_PR_FIRST_SOURCE_ONLY','NO_GO / Waiting','PR #567','rulesetId = 17499616','A2A Evidence','Dissent / guardrail','Remaining Separate Approvals','No-live Boundary']) expect(doc.includes(phrase), `doc: missing phrase ${phrase}`);
}
if (currentState) {
  expect(/monorepo-canonical-source-flip-execution-handoff\.md/.test(currentState), 'current-state: must reference canonical source flip execution handoff doc');
  expect(/GO_PR_FIRST_SOURCE_ONLY/.test(currentState), 'current-state: must record GO_PR_FIRST_SOURCE_ONLY');
  expect(/actual canonical flip execution remains separate/i.test(currentState), 'current-state: must keep actual execution separate');
}
if (pkg) expect(pkg.scripts?.['check:monorepo-canonical-source-flip-execution-handoff'] === 'node scripts/check-monorepo-canonical-source-flip-execution-handoff.mjs', 'package.json: missing canonical source flip execution handoff check script');
expect(/monorepo-canonical-source-flip-execution-handoff/.test(releaseGate), 'release gate: missing canonical source flip execution handoff step');
if (failures.length) { console.error(`monorepo canonical source flip execution handoff validation failed:\n- ${failures.join('\n- ')}`); process.exit(1); }
console.log('monorepo canonical source flip execution handoff ok');
