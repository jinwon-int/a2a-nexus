import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const docPath = join(
  repoRoot,
  'docs',
  'validation',
  'team2-soonwook-r9-concise-terminal-brief-runtime-readiness.md',
);

async function doc() {
  return readFile(docPath, 'utf8');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test('R9 validation binds the correct parent, lane, runtime tracker, and brokers', async () => {
  const content = await doc();

  for (const reference of [
    'a2a-broker#560',
    'a2a-plane#290',
    'openclaw-plugin-a2a#298',
    'a2a-r9-concise-brief-runtime-20260513T134143Z',
    'Parent broker: `seoseo`',
    'Handoff broker for Team2/Gwakga children: `gwakga`',
    'Known parent-round total: `7`',
  ]) {
    assert.match(content, new RegExp(escapeRegExp(reference)));
  }

  assert.doesNotMatch(content, /a2a-broker#553.*Parent:/i);
});

test('R9 validation preserves parent aggregation metadata and replay semantics', async () => {
  const content = await doc();

  for (const phrase of [
    '`parentRoundId`',
    '`originBrokerId`',
    '`parentBrokerId`',
    '`parentRoundTotal`',
    '`brokerOfRecord`',
    '`crossBrokerHandoff.parentRoundId`',
    '`crossBrokerHandoff.originParentBrokerId`',
    '`projectionKey`',
    'returns the existing projection and creates no second Terminal Brief entry',
    'If any required parent metadata is missing, rewritten, or inconsistent',
  ]) {
    assert.match(content, new RegExp(escapeRegExp(phrase)));
  }

  for (const flag of [
    'liveProviderSend=false',
    'terminalOutboxAckMutated=false',
    'isApproval=false',
    'isTerminalAck=false',
    'isReadReceipt=false',
  ]) {
    assert.match(content, new RegExp(escapeRegExp(flag)));
  }
});

test('R9 no-live proof renders compact known-total titles for all seven children', async () => {
  const content = await doc();

  const expectedTitles = [
    'A2A Terminal Brief 완료: bangtong(1/7)',
    'A2A Terminal Brief 완료: sogyo(2/7)',
    'A2A Terminal Brief 완료: nosuk(3/7)',
    'A2A Terminal Brief 완료: yukson(4/7)',
    'A2A Terminal Brief 완료: dungae(5/7)',
    'A2A Terminal Brief 완료: jingun(6/7)',
    'A2A Terminal Brief 완료: soonwook(7/7)',
  ];

  for (const title of expectedTitles) {
    assert.ok(title.length <= 80, `${title} must stay compact`);
    assert.match(content, new RegExp(escapeRegExp(title)));
  }

  for (const issue of [
    'a2a-broker#561',
    'openclaw-plugin-a2a#299',
    'a2a-broker#562',
    'a2a-plane#289',
    'a2a-broker#563',
    'a2a-docker-runner#243',
    'a2a-plane#290',
  ]) {
    assert.match(content, new RegExp(escapeRegExp(issue)));
  }

  assert.match(content, /A2A Terminal Brief 완료: soonwook\(7\)/);
  assert.doesNotMatch(content, /\(\d+\/\?\)|A2A Terminal Brief 완료: soonwook\(7\/\?\)/);
});

test('R9 validation enforces parent-only notification ownership', async () => {
  const content = await doc();

  for (const phrase of [
    'seoseo` is the initiating parent broker and the only broker',
    'must not send duplicate local Terminal Brief notifications',
    'Gwakga must relay a bounded projection back to `seoseo`',
    'keep local child notification disabled',
    'Provider accepted-send',
    'not read receipts',
    'not Terminal Brief ACK',
  ]) {
    assert.match(content, new RegExp(escapeRegExp(phrase), 'i'));
  }

  assert.doesNotMatch(content, /handoff broker may notify locally|child broker owns operator-facing title/i);
});

test('R9 activation plan remains no-live and approval gated', async () => {
  const content = await doc();

  for (const phrase of [
    'Decision: `NO-GO / Waiting` for live activation',
    'GO_CANDIDATE` for the no-live readiness packet',
    'did not execute the steps below',
    'Fresh explicit operator approval',
    'No approval means no reload/restart',
    'One fresh canary at most',
    'never a historical outbox row or replayed backlog item',
    'Restore no-live posture',
    'terminalOutboxAckMutated=false',
  ]) {
    assert.match(content, new RegExp(escapeRegExp(phrase)));
  }

  for (const forbiddenClaim of [
    /live activation is approved/i,
    /operator approval was executed/i,
    /reload completed/i,
    /restart completed/i,
    /live provider send completed/i,
    /Terminal Brief ACK completed/i,
  ]) {
    assert.doesNotMatch(content, forbiddenClaim);
  }
});

test('R9 validation keeps runtime bootstrap hygiene explicit', async () => {
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

  for (const boundary of [
    'does not deploy',
    'restart',
    'reload',
    'live provider or Telegram canary',
    'production databases',
    'terminal-outbox rows',
    'manual ACK/replay',
    'historical outbox replay',
    'force-push',
    'Report exact repo-relative or artifact-relative paths',
  ]) {
    assert.match(content, new RegExp(escapeRegExp(boundary), 'i'));
  }

  assert.doesNotMatch(content, /ghp_|github_pat_|Authorization:\s*Bearer|OPENCLAW_CACHE_BOUNDARY|chat_id\s*[:=]/i);
});
