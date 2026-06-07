#!/usr/bin/env node
/**
 * Validate the #551 monorepo operator approval handoff packet.
 *
 * Safety: source-only fixture/doc validation. This does not approve or perform
 * canonical flip, package ownership transfer, GitHub settings changes,
 * split-repo disposition actions, releases, tags, publishing, deployments,
 * restarts, credential movement, provider sends, or Terminal ACK/replay.
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

const fixture = parseJson('fixtures/current-state/monorepo-operator-approval-handoff.json');
const doc = readRel('docs/monorepo-operator-approval-handoff.md');
const currentState = readRel('docs/current-state.md');
const finalMatrix = readRel('docs/monorepo-final-operator-signoff-matrix.md');
const pkg = parseJson('package.json');
const releaseGate = readRel('scripts/release-gate.mjs') || '';

expect(doc !== null, 'missing docs/monorepo-operator-approval-handoff.md');

if (fixture) {
  expect(fixture.schema === 'a2a.monorepo-operator-approval-handoff.v1', 'fixture: unexpected schema');
  expect(fixture.parentIssue === 'https://github.com/jinwon-int/a2a-plane/issues/511', 'fixture: parent issue must be #511');
  expect(fixture.phase9FinalSignoffIssue === 'https://github.com/jinwon-int/a2a-plane/issues/549', 'fixture: phase9 issue must be #549');
  expect(fixture.phase9FinalSignoffPr === 'https://github.com/jinwon-int/a2a-plane/pull/550', 'fixture: phase9 PR must be #550');
  expect(fixture.phase9MergeCommit === '7200a91a92bbdbc82855a5a22321d704fdf2ca29', 'fixture: phase9 merge commit mismatch');
  expect(fixture.phase10OperatorHandoffIssue === 'https://github.com/jinwon-int/a2a-plane/issues/551', 'fixture: phase10 issue must be #551');
  expect(fixture.latestGreenCiRun === 'https://github.com/jinwon-int/a2a-plane/actions/runs/27101515372', 'fixture: latest green CI run mismatch');
  expect(fixture.operatorHandoffDecision === 'NO_GO_WAITING', 'fixture: operatorHandoffDecision must be NO_GO_WAITING');

  const response = fixture.operatorResponse || {};
  expect(response.status === 'UNANSWERED', 'fixture: operator response must remain UNANSWERED');
  expect(response.humanOperatorOwner === 'unassigned', 'fixture: humanOperatorOwner must be unassigned');
  expect(response.rollbackOwner === 'unassigned', 'fixture: rollbackOwner must be unassigned');
  expect(response.targetCommit === 'unassigned', 'fixture: targetCommit must be unassigned');
  expect(response.acceptedRiskRegister === 'unanswered', 'fixture: acceptedRiskRegister must be unanswered');
  expect(response.approvalSeparatedFromExecution === false, 'fixture: approval separation must not be asserted by source-only handoff');

  const expectedAreas = new Set([
    'branch_protection_or_ruleset',
    'split_repo_disposition',
    'release_tag_and_github_release',
    'npm_publish',
    'docker_ghcr_publish',
    'package_ownership_transfer',
    'canonical_flip',
  ]);
  const questions = fixture.questions || [];
  expect(questions.length === expectedAreas.size, 'fixture: questions must contain seven areas');
  const seenAreas = new Set();
  for (const question of questions) {
    expect(expectedAreas.has(question.area), `fixture: unexpected question area ${question.area}`);
    expect(!seenAreas.has(question.area), `fixture: duplicate question area ${question.area}`);
    seenAreas.add(question.area);
    expect(question.defaultDecision === 'HOLD', `fixture: ${question.area} defaultDecision must be HOLD`);
    expect(typeof question.sourceEvidence === 'string' && question.sourceEvidence.startsWith('docs/'), `fixture: ${question.area} must cite docs evidence`);
  }
  for (const area of expectedAreas) {
    expect(seenAreas.has(area), `fixture: missing question area ${area}`);
  }

  for (const condition of [
    'human_operator_owner_named',
    'rollback_owner_named',
    'exact_target_named',
    'latest_green_ci_run_recorded',
    'approval_separate_from_execution',
  ]) {
    expect((fixture.approvalPreconditions || []).includes(condition), `fixture: missing approval precondition ${condition}`);
  }

  for (const [key, value] of Object.entries(fixture.boundaries || {})) {
    expect(value === false, `fixture: boundary.${key} must be false`);
  }

  if (response.status === 'APPROVED' || fixture.operatorHandoffDecision === 'GO_CANDIDATE') {
    expect(response.humanOperatorOwner !== 'unassigned', 'fixture: approval requires named human operator owner');
    expect(response.rollbackOwner !== 'unassigned', 'fixture: approval requires named rollback owner');
    expect(response.targetCommit !== 'unassigned', 'fixture: approval requires exact target commit');
    expect(response.acceptedRiskRegister !== 'unanswered', 'fixture: approval requires accepted risks');
    expect(response.approvalSeparatedFromExecution === true, 'fixture: approval must remain separate from execution');
  }
}

if (doc) {
  for (const phrase of [
    'a2a-plane#551',
    'a2a-plane#550',
    '7200a91a92bbdbc82855a5a22321d704fdf2ca29',
    'Operator Response Block',
    'UNANSWERED',
    'NO_GO / Waiting',
    'No-live Boundary',
  ]) {
    expect(doc.toLowerCase().includes(phrase.toLowerCase()), `doc: missing phrase "${phrase}"`);
  }
}

expect(/a2a-plane#551/.test(currentState || ''), 'current-state doc: must reference #551');
expect(/a2a-plane#550/.test(currentState || ''), 'current-state doc: must reference #550');
expect(/a2a-plane#551/.test(finalMatrix || ''), 'final sign-off matrix: must reference #551 handoff');

if (pkg) {
  expect(
    pkg.scripts?.['check:monorepo-operator-approval-handoff'] === 'node scripts/check-monorepo-operator-approval-handoff.mjs',
    'package.json: missing check:monorepo-operator-approval-handoff script'
  );
}
expect(/monorepo-operator-approval-handoff/.test(releaseGate), 'release gate must include operator approval handoff check');

if (failures.length) {
  console.error(`monorepo operator approval handoff validation failed:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}

console.log('monorepo operator approval handoff ok');
