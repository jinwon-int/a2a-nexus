import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const docPath = join(repoRoot, 'docs', 'validation', 'team1-workerDelta-public-readiness-gate-synthesis.md');

async function doc() {
  return readFile(docPath, 'utf8');
}

test('Team1/workerDelta synthesis ties #75, #294, #497, #263, and #511 into one lane', async () => {
  const content = await doc();

  for (const reference of [
    'a2a-plane#75',
    'a2a-broker#294',
    'a2a-broker#497',
    'a2a-plane#263',
    'a2a-broker#511',
    'openclaw/openclaw#78261',
  ]) {
    assert.match(content, new RegExp(reference.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('Team1/workerDelta synthesis preserves accepted-send versus terminal evidence boundary', async () => {
  const content = await doc();

  for (const phrase of [
    'provider accepted-send evidence',
    'requester-visible receipt',
    'operator-visible receipt',
    'human-seen proof',
    'terminal ACK',
    'terminal-outbox ACK',
    'accepted-send-only evidence',
  ]) {
    assert.match(content, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }

  assert.match(content, /`providerMessageId`, `providerAccepted`, `accepted`, `sent`/);
  assert.doesNotMatch(content, /provider message ids? (prove|proved|are) (operator-visible )?receipt/i);
  assert.doesNotMatch(content, /accepted-send.*terminal ACK is safe/i);
});

test('Team1/workerDelta synthesis keeps public-readiness fail-closed until every gate is evidenced', async () => {
  const content = await doc();

  for (const gate of [
    'G1. Accepted-send vocabulary',
    'G2. Terminal evidence',
    'G3. Replay-safe canary proof',
    'G4. Broker state-growth risk from #497',
    'G5. Scanner/readiness evidence',
    'G6. Runtime/bootstrap artifact hygiene',
    'G7. Explicit approvals',
  ]) {
    assert.match(content, new RegExp(gate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }

  assert.match(content, /Decision: `NO-GO \/ Waiting`/);
  assert.match(content, /Keep `#75` open and `NO-GO \/ Waiting` until G1-G7 are all satisfied/);
  assert.match(content, /local `scan:public-readiness` can support review, but it is not external secret\/history scanner evidence/i);
  assert.doesNotMatch(content, /Decision: `GO`|aggregate decision is `GO`/i);
});

test('Team1/workerDelta synthesis documents runtime hygiene and unsafe-action exclusions', async () => {
  const content = await doc();

  for (const denyPath of ['AGENTS.md', 'SOUL.md', 'USER.md', 'TOOLS.md', 'HEARTBEAT.md', 'IDENTITY.md', '.openclaw/**']) {
    assert.match(content, new RegExp(denyPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }

  for (const prohibitedAction of [
    'deploy or restart services',
    'live provider/Telegram messages',
    'production databases',
    'terminal-outbox rows',
    'repository visibility',
    'rotate or disclose secrets',
    'release',
    'force-push',
    'raw session dump',
  ]) {
    assert.match(content, new RegExp(prohibitedAction.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }

  assert.doesNotMatch(content, /ghp_|github_pat_|Authorization:\s*Bearer|OPENCLAW_CACHE_BOUNDARY|Session ID:|chat_id\s*[:=]|\/root\//i);
});
