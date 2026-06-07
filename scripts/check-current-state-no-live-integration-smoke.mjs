#!/usr/bin/env node
/**
 * Validate the #506/#508 no-live integration smoke fixture.
 *
 * Safety: source-only fixture/doc validation. No live broker calls,
 * provider sends, GitHub mutations, deploys, restarts, or cleanup actions.
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

const fixturePath = 'fixtures/current-state/no-live-integration-smoke.json';
const docPath = 'docs/current-state-no-live-integration-smoke.md';
const currentStatePath = 'docs/current-state.md';
const packagePath = 'package.json';

const fixture = parseJson(fixturePath);
const doc = readRel(docPath);
const currentState = readRel(currentStatePath);
const pkg = parseJson(packagePath);

expect(doc !== null, `missing ${docPath}`);
expect(currentState !== null, `missing ${currentStatePath}`);

if (fixture) {
  expect(fixture.schema === 'a2a.current-state.no-live-integration-smoke.v1', 'fixture: unexpected schema');
  expect(fixture.mode === 'no-live', 'fixture: mode must be no-live');
  expect(fixture.sourceOnly === true, 'fixture: sourceOnly must be true');
  expect(fixture.finalizerRequired === true, 'fixture: finalizerRequired must be true');
  expect(fixture.replaySafe === true, 'fixture: replaySafe must be true');
  expect(fixture.parentIssue === 'https://github.com/jinwon-int/a2a-plane/issues/506', 'fixture: parentIssue must be #506');
  expect(fixture.trackingIssue === 'https://github.com/jinwon-int/a2a-plane/issues/508', 'fixture: trackingIssue must be #508');
  expect(fixture.route?.defaultMode === 'solo', 'fixture: default route must remain solo');
  expect(fixture.route?.finalizer === 'seoseo', 'fixture: finalizer must be seoseo');
  expect(fixture.route?.workerMutationAllowed === false, 'fixture: workers must not be allowed to mutate');

  const phases = Array.isArray(fixture.phases) ? fixture.phases : [];
  const requiredPhaseIds = [
    'broker-work-mode-decision',
    'docker-runner-readonly-nochange',
    'plugin-requester-visible-status',
    'agent-olympics-live-runner-boundary',
    'single-finalizer-packet',
  ];
  expect(phases.length === requiredPhaseIds.length, 'fixture: must define exactly five phases');

  const ids = new Set(phases.map((phase) => phase.id));
  for (const id of requiredPhaseIds) {
    expect(ids.has(id), `fixture: missing phase ${id}`);
  }

  const expectedOwners = new Map([
    ['broker-work-mode-decision', 'jinwon-int/a2a-broker'],
    ['docker-runner-readonly-nochange', 'jinwon-int/a2a-docker-runner'],
    ['plugin-requester-visible-status', 'jinwon-int/openclaw-plugin-a2a'],
    ['agent-olympics-live-runner-boundary', 'jinwon-int/agent-olympics'],
    ['single-finalizer-packet', 'jinwon-int/a2a-plane'],
  ]);

  for (const phase of phases) {
    expect(phase.ownerRepo === expectedOwners.get(phase.id), `fixture: ${phase.id} ownerRepo mismatch`);
    expect(/^https:\/\/github\.com\/jinwon-int\/[^/]+\/issues\/\d+$/.test(phase.childIssue || ''), `fixture: ${phase.id} missing child issue URL`);
    expect(phase.liveCallsAllowed === false, `fixture: ${phase.id} must not allow live calls`);
    expect(typeof phase.inputKind === 'string' && phase.inputKind.length > 8, `fixture: ${phase.id} missing inputKind`);
    expect(Array.isArray(phase.requiredAssertions) && phase.requiredAssertions.length >= 3, `fixture: ${phase.id} needs at least three required assertions`);
    expect(typeof phase.expectedOutput === 'string' && phase.expectedOutput.length > 12, `fixture: ${phase.id} missing expected output`);
  }

  const broker = phases.find((phase) => phase.id === 'broker-work-mode-decision');
  expect(broker?.requiredAssertions?.some((item) => /sourceOnlyDecision=true/.test(item)), 'broker phase: must assert sourceOnlyDecision=true');
  expect(broker?.requiredAssertions?.some((item) => /workerDispatchAllowedByThisPacket=false/.test(item)), 'broker phase: must assert worker dispatch disabled');
  expect(broker?.requiredAssertions?.some((item) => /solo.*blocks.*Team1|solo decision blocks Team1/i.test(item)), 'broker phase: must block solo-to-Team1 misuse');

  const runner = phases.find((phase) => phase.id === 'docker-runner-readonly-nochange');
  expect(runner?.requiredAssertions?.some((item) => /readOnlyValidation.*allowNoChanges/i.test(item)), 'runner phase: must link readOnlyValidation to allowNoChanges');
  expect(runner?.requiredAssertions?.some((item) => /status=no_changes_allowed/.test(item)), 'runner phase: must validate status=no_changes_allowed');
  expect(runner?.requiredAssertions?.some((item) => /openclaw_no_changes=allowed/.test(item)), 'runner phase: must validate openclaw_no_changes=allowed');

  const plugin = phases.find((phase) => phase.id === 'plugin-requester-visible-status');
  expect(plugin?.requiredAssertions?.some((item) => /brokerProtocolProfile/.test(item)), 'plugin phase: must assert brokerProtocolProfile projection');
  expect(plugin?.requiredAssertions?.some((item) => /not terminal ACK/i.test(item)), 'plugin phase: must separate provider accepted from terminal ACK');
  expect(plugin?.requiredAssertions?.some((item) => /do not notify or ACK/i.test(item)), 'plugin phase: must prevent evidence-only notify/ACK');

  const olympics = phases.find((phase) => phase.id === 'agent-olympics-live-runner-boundary');
  expect(olympics?.requiredAssertions?.some((item) => /blocked-missing-approval/.test(item)), 'Agent Olympics phase: must include blocked-missing-approval');
  expect(olympics?.requiredAssertions?.some((item) => /mode=dry_run.*transport=stub/.test(item)), 'Agent Olympics phase: must constrain dry-run-ready to stub transport');
  expect(olympics?.requiredAssertions?.some((item) => /not public A2A release readiness/i.test(item)), 'Agent Olympics phase: must not imply public release readiness');

  const finalizer = phases.find((phase) => phase.id === 'single-finalizer-packet');
  expect(finalizer?.requiredAssertions?.some((item) => /one finalizer/i.test(item)), 'finalizer phase: must enforce one finalizer');
  expect(finalizer?.requiredAssertions?.some((item) => /evidence packets, not merge or close authority/i.test(item)), 'finalizer phase: must keep workers evidence-only');

  for (const [key, value] of Object.entries(fixture.boundary || {})) {
    expect(value === false, `fixture: boundary.${key} must be false`);
  }

  const requiredFields = new Set(fixture.requiredFinalizerPacketFields || []);
  for (const field of [
    'tracker',
    'repoOwner',
    'lane',
    'evidenceLink',
    'noLiveBoundaryStatus',
    'finalizerDecision',
    'nextAction',
    'wikiOrRunbookFollowup',
  ]) {
    expect(requiredFields.has(field), `fixture: finalizer packet missing ${field}`);
  }

  const gapRepos = new Set((fixture.owningRepoGaps || []).map((gap) => gap.repo));
  for (const repo of [
    'jinwon-int/a2a-broker',
    'jinwon-int/a2a-docker-runner',
    'jinwon-int/openclaw-plugin-a2a',
    'jinwon-int/agent-olympics',
  ]) {
    expect(gapRepos.has(repo), `fixture: missing owning repo gap for ${repo}`);
  }
}

if (doc) {
  expect(/a2a-plane#508/.test(doc), 'doc: must reference #508');
  expect(/a2a-plane#506/.test(doc), 'doc: must reference parent #506');
  expect(/fixtures\/current-state\/no-live-integration-smoke\.json/.test(doc), 'doc: must reference fixture path');
  expect(/scripts\/check-current-state-no-live-integration-smoke\.mjs/.test(doc), 'doc: must reference validator path');
  expect(/Workers provide evidence only/i.test(doc), 'doc: must state workers provide evidence only');
  expect(/single finalizer/i.test(doc), 'doc: must state single finalizer');
  for (const phrase of [
    'live A2A dispatch',
    'provider or Telegram send',
    'DB mutation',
    'Terminal ACK/replay',
    'deploy/restart',
    'credential movement',
    'worker-owned GitHub mutation',
    'repo visibility change',
    'release/tag/npm/Docker publish',
    'force-push/history rewrite',
    'destructive checkout cleanup',
  ]) {
    expect(doc.includes(phrase), `doc: missing boundary phrase "${phrase}"`);
  }
}

if (currentState) {
  expect(/#508/.test(currentState), 'current-state doc: must reference #508');
  expect(/no-live smoke/i.test(currentState), 'current-state doc: must mention no-live smoke');
}

if (pkg) {
  expect(
    pkg.scripts?.['check:current-state-no-live-smoke'] === 'node scripts/check-current-state-no-live-integration-smoke.mjs',
    'package.json: missing check:current-state-no-live-smoke script'
  );
  expect(
    /check:current-state-no-live-smoke/.test(pkg.scripts?.['release-gate'] || '') ||
      /current-state-no-live-smoke/.test(readRel('scripts/release-gate.mjs') || ''),
    'release gate must include the no-live smoke check'
  );
}

if (failures.length) {
  console.error(`current-state no-live smoke validation failed:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}

console.log('current-state no-live integration smoke ok');
