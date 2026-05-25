import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const docPath = join(repoRoot, 'docs', 'validation', 'team1-yukson-go-nogo-evidence-pack.md');

async function doc() {
  return readFile(docPath, 'utf8');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test('Team1/yukson GO/NO-GO evidence packet binds parent lane and run identifiers', async () => {
  const content = await doc();

  for (const reference of [
    '#461',
    '#462',
    'a2a-team1-go-nogo-evidence-pack-20260526T0658KST',
    'yukson',
  ]) {
    assert.match(content, new RegExp(escapeRegExp(reference)));
  }
});

test('Team1/yukson GO/NO-GO evidence packet references predecessor packs', async () => {
  const content = await doc();

  for (const reference of [
    'team1-yukson-release-readiness-four-repo-matrix.md',
    'team1-yukson-release-blocker-proof-matrix.md',
  ]) {
    assert.match(content, new RegExp(escapeRegExp(reference)));
  }
});

test('Team1/yukson GO/NO-GO evidence packet covers all four repos', async () => {
  const content = await doc();

  for (const repo of [
    'packages/broker',
    'packages/openclaw-plugin-a2a',
    'packages/docker-runner',
    'contracts/a2a',
  ]) {
    assert.match(content, new RegExp(escapeRegExp(repo)));
  }
});

test('Team1/yukson GO/NO-GO evidence packet covers evidence dimensions', async () => {
  const content = await doc();

  for (const dimension of [
    '2.1 Scanner Evidence',
    '2.2 No-Live Replay Proof',
    '2.3 Package/Build Checks',
    '2.4 Requester-Visible Evidence',
    '2.5 Terminal ACK Boundaries',
    '2.6 Approval Gates',
    '2.7 Rollback/No-Op Rules',
    '2.8 Remaining Decision Points',
  ]) {
    assert.match(content, new RegExp(escapeRegExp(dimension)));
  }
});

test('Team1/yukson GO/NO-GO evidence packet documents 12 final gates', async () => {
  const content = await doc();

  const expectedGates = [
    'orchestratorPlanBinding',
    'aggregatedGateMatrix',
    'releaseCandidateTagging',
    'ciGateCapsule',
    'operatorApprovalPacket',
    'scannerHistoryBinding',
    'idempotencyReplayProtection',
    'rollbackAbortRunbook',
    'runtimeBootstrapHygiene',
    'redactedEvidencePolicy',
    'publicPrivateBoundary',
    'crossLaneEvidenceBinding',
  ];

  for (const gate of expectedGates) {
    assert.match(content, new RegExp(escapeRegExp(gate)));
  }
});

test('Team1/yukson GO/NO-GO evidence packet references sibling lanes', async () => {
  const content = await doc();

  for (const lane of ['bangtong', 'sogyo', 'nosuk']) {
    assert.match(content, new RegExp(escapeRegExp(lane)));
  }

  // Each sibling issue URL
  for (const issueUrl of [
    'a2a-docker-runner/issues/337',
    'openclaw-plugin-a2a/issues/450',
    'a2a-broker/issues/923',
  ]) {
    assert.match(content, new RegExp(escapeRegExp(issueUrl)));
  }
});

test('Team1/yukson GO/NO-GO evidence packet fails closed as NO-GO', async () => {
  const content = await doc();

  assert.match(content, /Current aggregate decision: NO-GO/);
  assert.match(content, /Evidence packet verdict: NO-GO/);
  assert.match(content, /fail-closed/);

  // Must not claim GO or approval
  assert.doesNotMatch(content, /aggregate decision: GO|is approved|cleanup is authorized|Terminal Brief ACK completed/i);
});

test('Team1/yukson GO/NO-GO evidence packet preserves safety and non-actions', async () => {
  const content = await doc();

  for (const prohibitedAction of [
    'deploy',
    'restart',
    'mutate production databases',
    'ACK terminal-outbox',
    'Historical outbox replay',
    'send live provider/Telegram',
    'disclose secrets',
    'create a release',
    'force-push',
    'rewrite history',
    'change repository visibility',
  ]) {
    assert.match(content, new RegExp(escapeRegExp(prohibitedAction)));
  }

  assert.doesNotMatch(content, /ghp_|github_pat_|Authorization:\s*Bearer|OPENCLAW_CACHE_BOUNDARY|Session ID:|chat_id\s*[:=]|\/root\//i);
});

test('Team1/yukson GO/NO-GO evidence packet excludes runtime/bootstrap context', async () => {
  const content = await doc();

  for (const denyPath of ['AGENTS.md', 'SOUL.md', 'USER.md', 'TOOLS.md', 'HEARTBEAT.md', 'IDENTITY.md', '.openclaw/**']) {
    assert.match(content, new RegExp(escapeRegExp(denyPath)));
  }
});

test('Team1/yukson GO/NO-GO evidence packet includes verification output', async () => {
  const content = await doc();

  for (const cmd of [
    'check:layout',
    'check:terminal-brief-routing',
    'check:message-id-ack-boundary',
    'scan:public-readiness',
    'scan:readiness-gates',
    'scan:external-secrets',
    'test:release-gate',
    'test:conformance',
    'check:packages',
  ]) {
    assert.match(content, new RegExp(escapeRegExp(cmd)));
  }

  // Must include actual status indicators
  assert.match(content, /PASS/);
  assert.match(content, /FAIL/);
  assert.match(content, /382\/382/);
  assert.match(content, /0 findings/);
});

test('Team1/yukson GO/NO-GO evidence packet includes changed files section', async () => {
  const content = await doc();

  for (const changedFile of [
    'docs/validation/team1-yukson-go-nogo-evidence-pack.md',
    'scripts/check-team1-yukson-go-nogo-evidence-pack.test.mjs',
  ]) {
    assert.match(content, new RegExp(escapeRegExp(changedFile)));
  }
});

test('Team1/yukson GO/NO-GO evidence packet includes approval-sensitive blockers', async () => {
  const content = await doc();

  for (const blocker of [
    'externalScannerEvidence',
    'replaySafety',
    'terminalEvidence',
    'package-build',
    'operatorApproval',
    'crossLaneEvidenceBinding',
    'GO',
    'BLOCKING',
  ]) {
    assert.match(content, new RegExp(escapeRegExp(blocker)));
  }
});
