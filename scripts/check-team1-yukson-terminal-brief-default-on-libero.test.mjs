import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const docPath = join(repoRoot, 'docs', 'validation', 'team1-yukson-terminal-brief-default-on-libero.md');

async function doc() {
  return readFile(docPath, 'utf8');
}

test('Team1/yukson default-on libero covers current run and parent/worker issue references', async () => {
  const content = await doc();

  assert.match(content, /a2a-terminal-brief-default-on-prod-observe-20260519T152200Z-yukson/);
  assert.match(content, /a2a-broker#802/);
  assert.match(content, /a2a-plane#389/);
  assert.match(content, /Lane: 4\/4/);
  assert.match(content, /default-on production observation/);
});

test('Team1/yukson default-on libero fails closed on Start-only evidence', async () => {
  const content = await doc();

  assert.match(content, /Decision: `NO-GO \/ Waiting`/);
  assert.match(content, /Start marker proves work began; it is not observation-readiness evidence/);
  assert.match(content, /Start evidence/);
  assert.match(content, /`NO-GO \/ Waiting`/);
  assert.doesNotMatch(content, /Decision: `GO`|aggregate decision remains \*\*`GO`|Observation is safe to proceed/i);
});

test('Team1/yukson default-on libero documents all six observation gates', async () => {
  const content = await doc();

  for (const phrase of [
    'G1. Default-on non-duplicate send',
    'G2. Default-on non-ACK boundary',
    'G3. Default-on runtime context safety',
    'G4. Default-on cross-broker parity',
    'G5. Prior activation context preserved',
    'G6. Rollback/restoration',
  ]) {
    assert.match(content, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('Team1/yukson default-on libero preserves one-shot and receipt/ACK boundaries', async () => {
  const content = await doc();

  assert.match(content, /at most one send attempt per task lifecycle/);
  assert.match(content, /must not auto-ACK terminal-outbox rows/);
  assert.match(content, /Provider accepted-send, message id, and Gateway outbound success remain non-ACK evidence only/);
  assert.match(content, /unconfirmed rows unacked and replayable/);
  assert.doesNotMatch(content, /auto-ACK completed|default-on ACK is authorized|observation completes ACK|provides ACK evidence|treated as terminal ACK|promoted to ACK/i);
});

test('Team1/yukson default-on libero documents rollback and abort safety', async () => {
  const content = await doc();

  assert.match(content, /Rollback \/ abort procedure/);
  assert.match(content, /Disable default-on observation first/);
  assert.match(content, /Do not ACK terminal-outbox rows based on observation-period provider accepted-send evidence/);
  assert.match(content, /Check for unintended ACK mutations/);
  assert.match(content, /Restore no-live config/);
});

test('Team1/yukson default-on libero documents runtime context and redaction hygiene', async () => {
  const content = await doc();

  for (const denyPath of ['AGENTS.md', 'SOUL.md', 'USER.md', 'TOOLS.md', 'HEARTBEAT.md', 'IDENTITY.md', '.openclaw/**']) {
    assert.match(content, new RegExp(denyPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(content, /if any OpenClaw runtime\/bootstrap context file would enter/);
  assert.match(content, /avoid secrets, provider targets, chat IDs, raw session dumps, private host paths/);
  assert.doesNotMatch(content, /ghp_|github_pat_|Authorization:\s*Bearer|OPENCLAW_CACHE_BOUNDARY|Session ID:|chat_id\s*[:=]/i);
});

test('Team1/yukson default-on libero covers sibling lane expectations', async () => {
  const content = await doc();

  assert.match(content, /Broker stability lane/);
  assert.match(content, /Plugin observation lane/);
  assert.match(content, /Runner observation lane/);
  assert.match(content, /Team2 parity lane/);
});
