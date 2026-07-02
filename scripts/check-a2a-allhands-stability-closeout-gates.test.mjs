import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const docPath = join(repoRoot, 'docs', 'validation', 'a2a-allhands-stability-closeout-gates.md');

async function doc() {
  return readFile(docPath, 'utf8');
}

test('all-hands closeout gates bind the current parent lane and required trackers', async () => {
  const content = await doc();

  for (const reference of [
    'a2a-broker#539',
    'a2a-plane#276',
    'a2a-broker#527',
    'a2a-broker#497',
    'a2a-broker#294',
  ]) {
    assert.match(content, new RegExp(reference.replace('#', '#')));
  }

  assert.doesNotMatch(content, /a2a-broker#532|a2a-plane#272/);
});

test('all-hands closeout gates validate #527 read-only libero evidence without weakening patch no-diff guards', async () => {
  const content = await doc();

  for (const phrase of [
    'intent=verify',
    'intent=analyze',
    'github-read-only-validation',
    'read-only-analysis',
    'Start marker plus a Done or Block marker',
    'no repository changes and no PR',
    'github-propose-patch',
    'real diff and PR',
    'OpenClaw produced no repository changes; refusing false Done.',
  ]) {
    assert.match(content, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }

  assert.match(content, /a2a-plane#240/);
  assert.match(content, /issues\/239/);
  assert.match(content, /npm run check:layout/);
  assert.match(content, /npm run check:no-diff-closeout-guidance/);
  assert.doesNotMatch(content, /no-diff patch task.*success|empty diff.*clean Done/i);
});

test('all-hands closeout gates keep #497 and #294 as approval-gated residual trackers', async () => {
  const content = await doc();

  for (const phrase of [
    'process memory',
    'terminal outbox total/acked/unacked',
    'dry-run-first cleanup/prune controls',
    'provider accepted-send',
    'non-ACK',
    'isApproval: false',
    'isTerminalAck: false',
    'isReadReceipt: false',
    'fresh one-shot allowlist',
    'queue hygiene',
  ]) {
    assert.match(content, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }

  assert.match(content, /remain open residual-risk trackers/);
  assert.doesNotMatch(content, /a2a-broker#497.*closed/i);
  assert.doesNotMatch(content, /a2a-broker#294.*closed/i);
});

test('all-hands closeout gates define brokerAlpha-origin cross-broker Terminal Brief evidence rules', async () => {
  const content = await doc();

  for (const phrase of [
    'brokerAlpha is the initiating parent broker',
    'handed off through brokerBeta',
    'stable projection key or idempotency marker',
    'child issue or PR/Done/Block evidence URL',
    'no provider send',
    'no terminal-outbox ACK',
    'no read receipt',
    'no approval',
    'no historical outbox replay',
    'NO-GO / Waiting',
  ]) {
    assert.match(content, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('all-hands closeout gates preserve runtime bootstrap and no-live boundaries', async () => {
  const content = await doc();

  for (const denyPath of ['AGENTS.md', 'SOUL.md', 'USER.md', 'TOOLS.md', 'HEARTBEAT.md', 'IDENTITY.md', '.openclaw/**']) {
    assert.match(content, new RegExp(denyPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }

  for (const boundary of [
    'does not deploy',
    'restart',
    'mutate production databases',
    'terminal-outbox rows',
    'send provider or Telegram messages',
    'force-push',
    'report the exact repo-relative offending paths',
  ]) {
    assert.match(content, new RegExp(boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
  }

  assert.match(content, /aggregate broker readiness remains `NO-GO \/ Waiting`/);
  assert.doesNotMatch(content, /approval executed|terminal ACK completed|live provider send completed|repository visibility changed/i);
});
