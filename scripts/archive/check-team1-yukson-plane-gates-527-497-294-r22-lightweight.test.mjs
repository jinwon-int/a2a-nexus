import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const docPath = join(repoRoot, 'docs', 'validation', 'team1-yukson-plane-gates-527-497-294-r22-lightweight.md');

async function doc() {
  return readFile(docPath, 'utf8');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test('R22 lightweight doc binds parent, lane, and roadmap trackers', async () => {
  const content = await doc();

  for (const reference of [
    'a2a-plane#331',
    'a2a-broker#497',
    'a2a-broker#294',
    'a2a-r22-broker-lightweight-20260515T015139Z',
  ]) {
    assert.match(content, new RegExp(escapeRegExp(reference)));
  }
});

test('R22 lightweight doc references existing gate packet without replacement', async () => {
  const content = await doc();

  assert.match(content, /team1-yukson-plane-gates-527-497-294\.md/);
  assert.match(content, /does not overwrite or replace/);
  assert.match(content, /remains the authoritative gate matrix/);
});

test('R22 lightweight doc cross-checks all three team1 sibling roadmap inputs', async () => {
  const content = await doc();

  for (const worker of ['bangtong', 'nosuk', 'sogyo']) {
    assert.match(content, new RegExp(`\\*\\*${escapeRegExp(worker)}\\*\\*`));
    assert.match(content, new RegExp(`docs/roadmap/team1-input-${escapeRegExp(worker)}-2026-05-09\\.md`));
  }
});

test('R22 lightweight doc defines #497 acceptance criteria including memory, latency, regression, and read-only guards', async () => {
  const content = await doc();

  for (const criterion of [
    'R1. Memory bound for hot-table loading',
    'R2. /health p95 latency under load',
    'R3. /health p99 latency under load',
    'R4. No behavior regression for task lifecycle',
    'R5. No DB mutation assumptions',
    'R6. No deploy/restart assumptions',
    'R7. Terminal outbox independence',
    'R8. Heap RSS bounded under steady growth',
  ]) {
    assert.match(content, new RegExp(escapeRegExp(criterion)));
  }
});

test('R22 lightweight doc defines #294 safety verification criteria', async () => {
  const content = await doc();

  for (const criterion of [
    'S1. Accepted-send non-ACK boundary preserved',
    'S2. Terminal Brief safety wording preserved',
    'S3. No-live canary wording intact',
    'S4. Replay safety invariant',
    'S5. Read-only lightweight acceptance',
  ]) {
    assert.match(content, new RegExp(escapeRegExp(criterion)));
  }
});

test('R22 lightweight doc has fail-closed no-live/no-ACK boundary checklist', async () => {
  const content = await doc();

  for (const check of [
    'AGENTS.md',
    'SOUL.md',
    'USER.md',
    'TOOLS.md',
    'HEARTBEAT.md',
    'IDENTITY.md',
    '.openclaw/**',
    'no production deploy',
    'no terminal-outbox ACK claim',
    'no live Telegram/provider send claim',
    'accepted-send evidence only',
    'evidence ledger entries',
    'not terminal ACK',
    'bounded and redacted',
  ]) {
    assert.match(content, new RegExp(escapeRegExp(check), 'i'));
  }
});

test('R22 lightweight doc preserves NO-GO / Waiting and safety wording', async () => {
  const content = await doc();

  assert.match(content, /`NO-GO \/ Waiting`/);
  assert.match(content, /remains blocked until explicit operator approval/i);
  assert.match(content, /explicit operator approval/);

  for (const prohibitedAction of [
    'deploy',
    'restart',
    'mutate',
    'DB mutation',
    'live send',
    'terminal ACK',
    'secret',
    'force-push',
    'rewrite Git history',
    'Change repository visibility',
  ]) {
    assert.match(content, new RegExp(escapeRegExp(prohibitedAction), 'i'));
  }

  // Must not claim GO or authorization
  assert.doesNotMatch(content, /Decision: `GO`/);
  assert.doesNotMatch(content, /production activation is (released|approved|authorized)/i);
});

test('R22 lightweight doc safety confirmation block lists all safety-gated activities', async () => {
  const content = await doc();

  for (const action of [
    'production deploy',
    'restart',
    'production database',
    'live provider',
    'Telegram messages',
    'ACK terminal-outbox',
    'rotate',
    'secrets',
    'force-push',
    'rewrite Git history',
    'repository visibility',
  ]) {
    assert.match(content, new RegExp(escapeRegExp(action), 'i'));
  }

  // No raw secrets or unsafe patterns
  assert.doesNotMatch(content, /ghp_|github_pat_|Authorization:\s*Bearer|OPENCLAW_CACHE_BOUNDARY|Session ID:|chat_id\s*[:=]|\/root\//i);
});
