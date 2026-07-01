import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const docPath = join(repoRoot, 'docs', 'validation', 'team1-yukson-public-readiness-after-78261-close.md');

async function doc() {
  return readFile(docPath, 'utf8');
}

test('Team1/yukson post-78261 matrix ties the lane to #75, #94, and #261', async () => {
  const content = await doc();

  assert.match(content, /a2a-plane#75|#75/);
  assert.match(content, /a2a-plane#94|#94/);
  assert.match(content, /a2a-plane#261|#261/);
  assert.match(content, /openclaw\/openclaw#78261/);
  assert.match(content, /closed\/superseded/);
});

test('Team1/yukson post-78261 matrix preserves provider accepted-send non-ACK boundary', async () => {
  const content = await doc();

  for (const phrase of [
    'provider accepted-send evidence only',
    'must stay separate from read/visibility',
    'requester receipt',
    'operator receipt',
    'human-seen proof',
    'terminal ACK',
    'terminal-outbox ACK',
  ]) {
    assert.match(content, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }

  assert.match(content, /`providerMessageId`, `providerAccepted`, `sendStatus: accepted`, and `sendStatus: sent` as non-ACK signals/);
  assert.doesNotMatch(content, /provider-message-id-as-terminal-ACK claim/i);
  assert.doesNotMatch(content, /messageId-as-receipt claim/i);
});

test('Team1/yukson post-78261 matrix keeps all readiness gates fail-closed', async () => {
  const content = await doc();

  for (const gate of [
    '#75 / post-#78261 terminal evidence vocabulary',
    '#75 / replay-safe Terminal Brief proof',
    '#94 / public compatibility policy',
    'External scanner/readiness',
    'Runtime/bootstrap and artifact hygiene',
    'Explicit operator approval separation',
  ]) {
    assert.match(content, new RegExp(gate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }

  assert.match(content, /NO-GO \/ Waiting/);
  assert.match(content, /Local source checks are useful, but they do not replace external scanner evidence/);
  assert.doesNotMatch(content, /public-readiness GO|Final GO|visibility change was performed|terminal ACK completed/i);
});

test('Team1/yukson post-78261 matrix documents runtime hygiene and unsafe-action exclusions', async () => {
  const content = await doc();

  for (const denyPath of ['AGENTS.md', 'SOUL.md', 'USER.md', 'TOOLS.md', 'HEARTBEAT.md', 'IDENTITY.md', '.openclaw/**']) {
    assert.match(content, new RegExp(denyPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }

  for (const prohibitedAction of [
    'live provider or Telegram sends',
    'production database mutations',
    'terminal-outbox ACKs',
    'secret rotations/disclosures',
    'repository visibility changes',
    'release publication',
    'force-pushes',
    'raw session dump publication',
  ]) {
    assert.match(content, new RegExp(prohibitedAction.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }

  assert.doesNotMatch(content, /ghp_|github_pat_|Authorization:\s*Bearer|OPENCLAW_CACHE_BOUNDARY|Session ID:|chat_id\s*[:=]/i);
});
