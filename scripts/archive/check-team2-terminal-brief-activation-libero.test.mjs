import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const docPath = join(repoRoot, 'docs', 'validation', 'team2-terminal-brief-activation-libero.md');

async function doc() {
  return readFile(docPath, 'utf8');
}

test('Team2 Terminal Brief activation libero covers current run and all sibling lanes', async () => {
  const content = await doc();

  assert.match(content, /terminal-brief-activation-20260511T080211Z/);
  assert.match(content, /a2a-plane#241/);
  assert.match(content, /a2a-plane#244/);
  for (const issue of [
    'a2a-plane#242',
    'openclaw-plugin-a2a#269',
    'a2a-docker-runner#204',
    'a2a-plane#243',
    'a2a-broker#493',
    'a2a-docker-runner#205',
  ]) {
    assert.match(content, new RegExp(issue.replace('#', '#')));
  }
});

test('Team2 Terminal Brief activation libero fails closed on Start-only evidence', async () => {
  const content = await doc();

  assert.match(content, /Decision: `NO-GO \/ Waiting`/);
  assert.match(content, /Start evidence/);
  assert.match(content, /Start marker only/);
  assert.match(content, /no terminal PR, Done, or Block closeout evidence/i);
  assert.match(content, /aggregate remains `NO-GO \/ Waiting`/);
  assert.doesNotMatch(content, /Decision: `GO`|aggregate remains `GO`|activationReady: true|live canary send completed/i);
});

test('Team2 Terminal Brief activation libero preserves approval, receipt, and ACK separation', async () => {
  const content = await doc();

  for (const phrase of [
    'explicit operator approval',
    'single allowed canary live provider send',
    'Provider accepted-send',
    'non-ACK',
    'operator-visible receipt',
    'terminal ACK',
    'terminal-outbox ACK',
    'GitHub comments remain requester-visible ledger evidence only',
  ]) {
    assert.match(content, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
  }

  assert.doesNotMatch(content, /provider id promoted to ACK|accepted-send promoted to approval|GitHub comments promoted to operator-visible receipt/i);
});

test('Team2 Terminal Brief activation libero documents Docker-only limitation without substituting service commands', async () => {
  const content = await doc();

  assert.match(content, /Docker runner environment reports Docker\/Compose unavailable/);
  assert.match(content, /Docker-only deployment evidence/);
  assert.match(content, /Docker\/Compose was unavailable/);
  assert.match(content, /broker deployment remains an external\/operator evidence gate/);
  assert.doesNotMatch(content, /systemctl|service install|openclaw gateway stop|openclaw gateway start/i);
});

test('Team2 Terminal Brief activation libero keeps no-live safety gates and runtime hygiene explicit', async () => {
  const content = await doc();

  for (const phrase of [
    'does not deploy or restart',
    'live provider or Telegram send',
    'production databases',
    'change secrets',
    'force-push',
    'repository visibility',
    'raw session dump',
  ]) {
    assert.match(content, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
  }

  for (const denyPath of ['AGENTS.md', 'SOUL.md', 'USER.md', 'TOOLS.md', 'HEARTBEAT.md', 'IDENTITY.md', '.openclaw/**']) {
    assert.match(content, new RegExp(denyPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(content, /report exact repo-relative paths/);
  assert.doesNotMatch(content, /ghp_|github_pat_|Authorization:\s*Bearer|OPENCLAW_CACHE_BOUNDARY|chat_id\s*[:=]/i);
});
