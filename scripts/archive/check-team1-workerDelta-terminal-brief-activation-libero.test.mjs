import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const docPath = join(repoRoot, 'docs', 'validation', 'team1-workerDelta-terminal-brief-activation-libero.md');

async function doc() {
  return readFile(docPath, 'utf8');
}

test('Team1/workerDelta Terminal Brief activation libero covers R11 run and sibling lanes', async () => {
  const content = await doc();

  assert.match(content, /a2a-r11-stability-activation-gates-20260513T231046Z/);
  assert.match(content, /a2a-broker#539/);
  assert.match(content, /a2a-plane#297/);
  for (const issue of [
    'a2a-broker#593',
    'a2a-broker#592',
    'openclaw-plugin-a2a#303',
    'a2a-broker#594',
    'a2a-docker-runner#247',
    'a2a-plane#298',
  ]) {
    assert.match(content, new RegExp(issue.replace('#', '#')));
  }
});

test('Team1/workerDelta activation matrix fails closed on refreshed Start-only evidence', async () => {
  const content = await doc();

  assert.match(content, /Decision: `NO-GO \/ Waiting`/);
  assert.match(content, /A Start marker proves work began; it is not activation evidence/);
  assert.match(content, /Start marker/);
  assert.match(content, /Current state/);
  assert.match(content, /until refreshed terminal PR\/Done\/Block evidence lands/);
  assert.doesNotMatch(content, /Decision: `GO`|aggregate decision remains \*\*`GO`|Current status\. \| `GO`/i);
});

test('Team1/workerDelta activation matrix documents deploy config canary receipt rollback gates', async () => {
  const content = await doc();

  for (const phrase of [
    'G1. Broker Docker deployment',
    'G2. Terminal-outbox readiness',
    'G3. Gateway notification bridge',
    'G4. Operator approval and one-shot send guard',
    'G5. Fresh canary smoke',
    'G6. Receipt evidence',
    'G7. Terminal ACK eligibility',
    'G8. Rollback/restoration',
    'G9. Cross-team parity/libero',
  ]) {
    assert.match(content, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('Team1/workerDelta activation matrix preserves one-shot and receipt/ACK boundaries', async () => {
  const content = await doc();

  assert.match(content, /separate operator approval explicitly authorizes the one fresh canary provider send/);
  assert.match(content, /provider accepted-send, message ids, or Terminal Brief text must not be treated as operator-visible receipt or terminal-outbox ACK/);
  assert.match(content, /live provider send count is exactly one for the fresh canary/);
  assert.match(content, /Do not ACK terminal-outbox rows from provider accepted-send, message id, or Gateway outbound success/);
  assert.doesNotMatch(content, /provider accepted-send is ACK|message id is receipt|Terminal Brief ACK completed/i);
});

test('Team1/workerDelta activation matrix includes rollback and safety evidence', async () => {
  const content = await doc();

  assert.match(content, /Rollback \/ abort procedure/);
  assert.match(content, /Stop\/remove only the Docker canary broker container/);
  assert.match(content, /Restore Gateway\/plugin state/);
  assert.match(content, /Do not ACK terminal-outbox rows from provider accepted-send/);
  assert.match(content, /Verify no duplicate send/);
});

test('Team1/workerDelta activation matrix documents runtime context and redaction hygiene', async () => {
  const content = await doc();

  for (const denyPath of ['AGENTS.md', 'SOUL.md', 'USER.md', 'TOOLS.md', 'HEARTBEAT.md', 'IDENTITY.md', '.openclaw/**']) {
    assert.match(content, new RegExp(denyPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(content, /fail closed if any OpenClaw runtime\/bootstrap context file would enter/);
  assert.match(content, /avoid secrets, provider targets, chat IDs, raw session dumps, private host paths/);
  assert.doesNotMatch(content, /ghp_|github_pat_|Authorization:\s*Bearer|OPENCLAW_CACHE_BOUNDARY|Session ID:|chat_id\s*[:=]/i);
});
