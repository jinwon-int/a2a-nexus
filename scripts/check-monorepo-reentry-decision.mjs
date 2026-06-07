#!/usr/bin/env node
/**
 * Validate the #511 monorepo re-entry decision packet.
 *
 * Safety: source-only fixture/doc validation. No repo import, history rewrite,
 * release, publish, visibility, live dispatch, restart, credential, DB, or
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

const fixturePath = 'fixtures/current-state/monorepo-reentry-decision.json';
const docPath = 'docs/monorepo-reentry-decision.md';
const currentStatePath = 'docs/current-state.md';
const topologyPath = 'docs/topology-decision-record.md';
const readmePath = 'README.md';
const packagePath = 'package.json';

const fixture = parseJson(fixturePath);
const doc = readRel(docPath);
const currentState = readRel(currentStatePath);
const topology = readRel(topologyPath);
const readme = readRel(readmePath);
const pkg = parseJson(packagePath);

expect(doc !== null, `missing ${docPath}`);
expect(currentState !== null, `missing ${currentStatePath}`);
expect(topology !== null, `missing ${topologyPath}`);
expect(readme !== null, `missing ${readmePath}`);

if (fixture) {
  expect(fixture.schema === 'a2a.monorepo-reentry-decision.v1', 'fixture: unexpected schema');
  expect(fixture.decisionIssue === 'https://github.com/jinwon-int/a2a-plane/issues/511', 'fixture: decisionIssue must be #511');
  expect(fixture.previousDecisionIssue === 'https://github.com/jinwon-int/a2a-plane/issues/473', 'fixture: previousDecisionIssue must be #473');
  expect(fixture.priorWave === 'https://github.com/jinwon-int/a2a-plane/issues/506', 'fixture: priorWave must be #506');
  expect(fixture.decision === 'staged_umbrella_workspace_first', 'fixture: decision must be staged umbrella workspace first');
  expect(fixture.canonicalDuringPhase0And1 === 'split_repos', 'fixture: split repos must stay canonical during phase 0/1');
  expect(fixture.operatorReentryTrigger === true, 'fixture: operator re-entry trigger must be true');
  expect(fixture.canonicalFlipApproved === false, 'fixture: canonical flip must not be approved');

  const layout = new Set(fixture.targetLayout || []);
  for (const entry of [
    'packages/broker',
    'packages/docker-runner',
    'packages/openclaw-plugin-a2a',
    'contracts',
    'fixtures',
    'docs',
    'scripts',
    'scanner',
    '.github/workflows',
  ]) {
    expect(layout.has(entry), `fixture: targetLayout missing ${entry}`);
  }

  const repos = new Map((fixture.repos || []).map((repo) => [repo.repo, repo]));
  for (const repo of [
    'jinwon-int/a2a-plane',
    'jinwon-int/a2a-broker',
    'jinwon-int/a2a-docker-runner',
    'jinwon-int/openclaw-plugin-a2a',
  ]) {
    expect(repos.has(repo), `fixture: missing repo ${repo}`);
    expect(repos.get(repo)?.canonicalNow === true, `fixture: ${repo} must remain canonical now`);
  }
  expect(!repos.has('jinwon-int/agent-olympics'), 'fixture: agent-olympics must not be an A2A repo/package');

  const outOfScopeRepos = new Set((fixture.outOfScopeRepos || []).map((repo) => repo.repo));
  expect(outOfScopeRepos.has('jinwon-int/agent-olympics'), 'fixture: agent-olympics must be marked out of scope');

  const gates = new Set(fixture.requiredGatesBeforeCanonicalFlip || []);
  for (const gate of [
    'history_preserving_import_rehearsal',
    'ci_parity',
    'docs_migration',
    'codeowners',
    'a2a_plane_branch_protection_review',
    'release_package_policy',
    'operator_final_signoff',
  ]) {
    expect(gates.has(gate), `fixture: missing gate ${gate}`);
  }

  for (const phase of fixture.phasePlan || []) {
    if (phase.phase !== 'phase3_canonical_flip_decision') {
      expect(phase.canonicalFlip === false, `fixture: ${phase.phase} must not flip canonical source`);
    }
  }

  for (const [key, value] of Object.entries(fixture.boundaries || {})) {
    expect(value === false, `fixture: boundary.${key} must be false`);
  }
}

if (doc) {
  for (const phrase of [
    'staged umbrella workspace',
    'not an immediate canonical monorepo flip',
    'split implementation repos remain canonical',
    'outside the A2A monorepo',
    'Codex Read-Only Cross-Check Evidence',
    'not be counted as Team1/Team2 benchmark evidence',
    'history-preserving',
    'CODEOWNERS',
    'operator sign-off',
    'No-live',
  ]) {
    expect(doc.toLowerCase().includes(phrase.toLowerCase()), `doc: missing phrase "${phrase}"`);
  }
  expect(/a2a-plane#511/.test(doc), 'doc: must reference #511');
  expect(/a2a-plane\/issues\/473/.test(doc), 'doc: must reference #473');
  expect(/a2a-plane\/issues\/506/.test(doc), 'doc: must reference #506');
}

if (currentState) {
  expect(/#514/.test(currentState), 'current-state doc: must reference #514');
  expect(/#515/.test(currentState), 'current-state doc: must reference #515');
  expect(/#517/.test(currentState), 'current-state doc: must reference #517');
  expect(/a2a-broker#1320/.test(currentState), 'current-state doc: must reference a2a-broker#1320');
  expect(/a2a-broker#1321/.test(currentState), 'current-state doc: must reference a2a-broker#1321');
  expect(/#506.*closed|closed.*#506/i.test(currentState), 'current-state doc: must mark #506 closed/completed');
  expect(/#511.*Closed|Closed.*#511/i.test(currentState), 'current-state doc: must mark #511 closed/completed');
  expect(/#513.*Closed|Closed.*#513/i.test(currentState), 'current-state doc: must mark #513 closed/completed');
}

if (topology) {
  expect(/#511/.test(topology), 'topology decision record: must reference #511 re-entry');
  expect(/operator-initiated re-entry/i.test(topology), 'topology decision record: must mention operator-initiated re-entry');
}

if (readme) {
  expect(/#511/.test(readme), 'README: must reference #511');
  expect(/monorepo re-entry/i.test(readme), 'README: must mention monorepo re-entry');
}

if (pkg) {
  expect(
    pkg.scripts?.['check:monorepo-reentry'] === 'node scripts/check-monorepo-reentry-decision.mjs',
    'package.json: missing check:monorepo-reentry script'
  );
  const releaseGate = readRel('scripts/release-gate.mjs') || '';
  expect(/monorepo-reentry/.test(releaseGate), 'release gate must include monorepo re-entry check');
}

if (failures.length) {
  console.error(`monorepo re-entry decision validation failed:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}

console.log('monorepo re-entry decision ok');
