import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const docPath = join(repoRoot, 'docs', 'validation', 'team1-workerDelta-r15-allhands-structured-terminal-brief-lane.md');

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function doc() {
  return readFile(docPath, 'utf8');
}

test('R15 all-hands lane document binds issue, lane metadata, and parent round', async () => {
  const content = await doc();

  // Issue reference
  assert.match(content, new RegExp(escapeRegExp('a2a-plane#311')));

  // Round and origin metadata
  assert.match(content, new RegExp(escapeRegExp('a2a-r15-allhands-structured-terminal-brief-20260514T065457Z-04-workerDelta')));
  assert.match(content, /origin broker.*brokerAlpha/i);
  assert.match(content, /Team1\/workerDelta/);
  assert.match(content, /Order: 4\/7/);
  assert.match(content, /workerDelta\(4\/7\)/);
});

test('R15 all-hands lane document defines metadata propagation matrix', async () => {
  const content = await doc();

  for (const field of [
    'parentRoundId',
    'originBrokerId',
    'parentBrokerId',
    'handoffBrokerId',
    'parentRoundTotal',
    'parentRoundOrder',
    'childTaskId',
    'childBrokerOfRecord',
  ]) {
    assert.match(content, new RegExp(escapeRegExp(field)));
  }

  // Metadata flow sections
  assert.match(content, /Direct child metadata flow|Handoff child metadata flow/);
  assert.match(content, /handoffBrokerId=brokerBeta/);
  assert.match(content, /originBrokerId=brokerAlpha/);
  assert.match(content, /parentRoundTotal=7/);
});

test('R15 all-hands lane document defines origin fan-in contract matrix', async () => {
  const content = await doc();

  // Matrix header
  assert.match(content, /Origin fan-in contract matrix/);

  // All 4 combination indices
  assert.match(content, /\| 1 \|.*brokerAlpha.*brokerAlpha/);
  assert.match(content, /\| 2 \|.*brokerAlpha.*brokerAlpha/);
  assert.match(content, /\| 3 \|.*brokerAlpha.*brokerAlpha/);
  assert.match(content, /\| 4 \|.*brokerAlpha.*brokerAlpha/);

  // Symmetric pair coverage
  assert.match(content, /v0 \(origin=parent, direct\)/);
  assert.match(content, /brokerAlpha-origin handoff/);

  // Origin fan-in invariants (at least 3 of 6)
  const invariants = [
    'finite',
    'symmetric pair',
    'originBrokerId is immutable',
    'handoffBrokerId may equal parentBrokerId',
    'no broker may render',
    'accept projections only',
  ];
  const invariantCount = invariants.filter(i => content.includes(i)).length;
  assert.ok(invariantCount >= 3, `Expected at least 3 invariants, found ${invariantCount}`);

  // Asymmetric fail-closed conditions
  assert.match(content, /parentBrokerId.*notification omits/);
  assert.match(content, /parent-only notification ownership violated/);
});

test('R15 all-hands lane document lists acceptance gates with pass/fail/current status', async () => {
  const content = await doc();

  for (const gate of ['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8', 'G9', 'G10']) {
    assert.match(content, new RegExp(`${gate}\\.\\s`));
  }

  // Gate descriptions
  for (const phrase of [
    'Metadata propagation completeness',
    'Origin fan-in contract matrix coverage',
    'Concise title with known total',
    'Body/evidence separation',
    'Parent-only notification ownership',
    'Symmetric origin-broker routing',
    'Receipt/ACK boundary',
    'Post-dispatch metadata verification',
    'Runtime/bootstrap hygiene',
    'Fresh explicit operator approval',
  ]) {
    assert.match(content, new RegExp(escapeRegExp(phrase)));
  }

  // GO/NO-GO matrix
  assert.match(content, /GO for acceptance matrix/);
  assert.match(content, /GO_CANDIDATE/);
  assert.match(content, /NO-GO \/ Waiting/);
  assert.match(content, /BLOCK/);
});

test('R15 all-hands lane document includes 7-child title proof table', async () => {
  const content = await doc();

  // All 7 workers
  for (const worker of ['workerGamma', 'workerBeta', 'workerAlpha', 'workerDelta', 'workerEpsilon', 'workerZeta', 'workerEta']) {
    assert.match(content, new RegExp(escapeRegExp(worker)));
  }

  // All 7 title patterns with n/7
  for (let i = 1; i <= 7; i++) {
    assert.match(content, new RegExp(escapeRegExp(`${i}/7`)));
  }

  // Coverage table
  assert.match(content, /Origin fan-in contract matrix.*coverage of this round/);
});

test('R15 all-hands lane document preserves safety and runtime bootstrap hygiene', async () => {
  const content = await doc();

  for (const denyPath of [
    'AGENTS.md',
    'SOUL.md',
    'USER.md',
    'TOOLS.md',
    'HEARTBEAT.md',
    'IDENTITY.md',
    '.openclaw/**',
  ]) {
    assert.match(content, new RegExp(escapeRegExp(denyPath)));
  }

  for (const safety of [
    'did not deploy',
    'restart',
    'mutate production databases',
    'terminal-outbox ACK',
    'send any live provider',
    'change secrets',
    'force-push',
    'report exact',
    'PASS',
  ]) {
    assert.match(content, new RegExp(escapeRegExp(safety), 'i'));
  }

  assert.doesNotMatch(content, /approval executed|terminal ACK completed|live provider send completed|repository visibility changed/i);
});

test('R15 all-hands lane document includes closeout boundary and residual risk matrix', async () => {
  const content = await doc();

  for (const phrase of [
    'Closeout boundary',
    'R15 residual risk matrix',
    'Metadata propagation',
    'Origin fan-in coverage',
    'Concise title correctness',
    'Parent-only ownership',
    'Receipt/ACK separation',
    'Replay/stale suppression',
    'Runtime/bootstrap hygiene',
  ]) {
    assert.match(content, new RegExp(escapeRegExp(phrase)));
  }

  // Decision
  assert.match(content, /GO_CANDIDATE.*Needs finalizer closeout/);
  assert.doesNotMatch(content, /R15 activation GO (completed|authorized|confirmed)/i);
  assert.doesNotMatch(content, /live canary (confirmed|completed|authorized)/i);
  assert.match(content, /must not claim R15 activation GO/);
  assert.match(content, /must not claim.*live canary authorization/);
  assert.doesNotMatch(content, /live canary.*(authorized|confirmed|completed)/i);
});

test('R15 all-hands lane document specifies local validation commands', async () => {
  const content = await doc();

  for (const cmd of [
    'npm run check:layout',
    'npm run check:terminal-brief-routing',
    'npm run check:team1-workerDelta-plane-gates',
    'npm run check:message-id-ack-boundary',
    'npm run check:contract-fixtures',
    'npm run check:team1-workerDelta-r15-allhands-structured-terminal-brief-lane',
    'git status --short --ignored',
  ]) {
    assert.match(content, new RegExp(escapeRegExp(cmd)));
  }
});
