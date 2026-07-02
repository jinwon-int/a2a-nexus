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
  'team2-workerEta-r9b-terminal-brief-activation-readiness.md',
);

async function doc() {
  return readFile(docPath, 'utf8');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test('R9b validation binds the current issue, parent, run, and no-live scope', async () => {
  const content = await doc();

  for (const reference of [
    'a2a-plane#294',
    'a2a-broker#567',
    'a2a-r9b-terminal-brief-activation-readiness-20260513T152714Z',
    'Lane: `workerEta`',
    'Team2 libero cross-team validation and risk review',
    'repository evidence review only',
  ]) {
    assert.match(content, new RegExp(escapeRegExp(reference)));
  }

  for (const forbiddenClaim of [
    /live activation is approved/i,
    /approval executed/i,
    /reload completed/i,
    /restart completed/i,
    /live provider send completed/i,
    /terminal ACK completed/i,
  ]) {
    assert.doesNotMatch(content, forbiddenClaim);
  }
});

test('R9b aggregation counts terminal PR, Done, or Block evidence only', async () => {
  const content = await doc();

  for (const phrase of [
    'PR/Done/Block evidence only',
    'Start marker only',
    'cannot close or activate',
    'Decision: `NO-GO / Waiting` for live activation',
    '`GO_CANDIDATE` for operator review only',
    'Start-only evidence is excluded',
  ]) {
    assert.match(content, new RegExp(escapeRegExp(phrase), 'i'));
  }

  assert.match(content, /\| Start marker only \| No \| Shows work began; cannot close or activate\. \|/);
  assert.doesNotMatch(content, /\| Start marker only \| Yes/i);
  assert.doesNotMatch(content, /Start, queued, running[\s\S]{0,120}are closeout evidence/i);
});

test('R9b parent broker metadata is explicit and replay safe', async () => {
  const content = await doc();

  for (const phrase of [
    'parent broker of record is `brokerAlpha`',
    '`brokerBeta` may relay bounded Team2 child projections',
    '`parentRoundId`',
    '`originBrokerId`',
    '`parentBrokerId`',
    '`parentRoundTotal`',
    '`handoffBrokerId`',
    '`brokerOfRecord`',
    '`projectionKey`',
    '`terminalEvidenceKind`',
    '`noLiveFlags`',
    'liveProviderSend=false',
    'terminalOutboxAckMutated=false',
    'isApproval=false',
    'isTerminalAck=false',
    'isReadReceipt=false',
    'return the existing projection and create no second Terminal Brief entry',
  ]) {
    assert.match(content, new RegExp(escapeRegExp(phrase)));
  }
});

test('R9b compact parent-round titles cover all seven children', async () => {
  const content = await doc();

  const expectedTitles = [
    'A2A Terminal Brief 완료: workerGamma(1/7)',
    'A2A Terminal Brief 완료: workerBeta(2/7)',
    'A2A Terminal Brief 완료: workerAlpha(3/7)',
    'A2A Terminal Brief 완료: workerDelta(4/7)',
    'A2A Terminal Brief 완료: workerEpsilon(5/7)',
    'A2A Terminal Brief 완료: workerZeta(6/7)',
    'A2A Terminal Brief 완료: workerEta(7/7)',
  ];

  for (const title of expectedTitles) {
    assert.ok(title.length <= 80, `${title} must stay compact`);
    assert.match(content, new RegExp(escapeRegExp(title)));
  }

  assert.match(content, /A2A Terminal Brief 완료: workerEta\(7\)/);
  assert.match(content, /slash-question-mark denominator/);
  assert.doesNotMatch(content, /\| [^|]*A2A Terminal Brief 완료: [^|]*\(\d+\/\?\)[^|]* \|/);
});

test('R9b preserves parent-only notification ownership', async () => {
  const content = await doc();

  for (const phrase of [
    '`brokerAlpha` is the initiating parent broker and the only broker',
    'Team1 child brokers may publish redacted PR/Done/Block evidence',
    'must not send duplicate local parent-round Terminal Brief notifications',
    '`brokerBeta` may relay a bounded Team2 projection back to `brokerAlpha`',
    'must keep local child notification disabled',
    'must not own the operator-facing title',
  ]) {
    assert.match(content, new RegExp(escapeRegExp(phrase), 'i'));
  }

  assert.doesNotMatch(content, /handoff broker may notify locally|brokerBeta.*operator-facing title owner/i);
});

test('R9b receipt and ACK boundary proof remains non-approval', async () => {
  const content = await doc();

  for (const phrase of [
    'Provider accepted-send or message id',
    'Requester-visible receipt',
    'operator-visible receipt',
    'terminal ACK',
    'terminal-outbox ACK',
    'providerAccepted != operatorVisibleReceipt != terminalAck != approval',
    'No R9b evidence may promote provider acceptance',
  ]) {
    assert.match(content, new RegExp(escapeRegExp(phrase), 'i'));
  }

  assert.doesNotMatch(content, /provider id promoted to ACK|accepted-send promoted to approval|GitHub comments promoted to operator-visible receipt/i);
});

test('R9b GO/NO-GO packet and activation rollback stay approval gated', async () => {
  const content = await doc();

  for (const phrase of [
    'G1. All seven child lanes terminal',
    'G6. Replay/stale suppression',
    'G7. Fresh operator approval',
    'G8. Rollback/no-live restoration',
    'Fresh explicit operator approval',
    'No approval means no deploy, reload, restart, live provider send, terminal ACK, DB mutation, or replay',
    'One fresh canary at most',
    'Never use a historical outbox row',
    'Receipt-before-ACK check',
    'Rollback',
    'Abort path',
  ]) {
    assert.match(content, new RegExp(escapeRegExp(phrase)));
  }
});

test('R9b runtime bootstrap hygiene and safety deny-list are explicit', async () => {
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
    'live provider or Telegram message',
    'production databases',
    'terminal-outbox rows',
    'manual ACK/replay',
    'historical outbox replay',
    'force-push',
    'Report exact repo-relative or artifact-relative offending paths',
  ]) {
    assert.match(content, new RegExp(escapeRegExp(boundary), 'i'));
  }

  assert.doesNotMatch(content, /ghp_|github_pat_|Authorization:\s*Bearer|OPENCLAW_CACHE_BOUNDARY|chat_id\s*[:=]/i);
});
