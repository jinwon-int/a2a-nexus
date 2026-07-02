import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const docPath = join(repoRoot, 'docs', 'validation', 'team1-workerDelta-plane-gates-527-497-294.md');

async function doc() {
  return readFile(docPath, 'utf8');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test('Team1/workerDelta plane gate packet binds parent, lane, and broker trackers', async () => {
  const content = await doc();

  for (const reference of [
    'a2a-broker#539',
    'a2a-plane#275',
    'a2a-broker#527',
    'a2a-broker#497',
    'a2a-broker#294',
    'a2a-plane#240',
  ]) {
    assert.match(content, new RegExp(escapeRegExp(reference)));
  }
});

test('Team1/workerDelta plane gate packet defines read-only GitHub validation lanes without weakening patch no-diff guards', async () => {
  const content = await doc();

  for (const phrase of [
    'intent=verify',
    'intent=analyze',
    'taskOrigin=github',
    'github-verify',
    'github-read-only-validation',
    'read-only-analysis',
    'Start plus Done/Block GitHub evidence comments',
    'No diff is required for read-only validation/libero lanes',
    'patch-producing lane posts Done with no diff or PR',
    'still fails closed as false Done',
  ]) {
    assert.match(content, new RegExp(escapeRegExp(phrase)));
  }

  assert.doesNotMatch(content, /patch-producing tasks? may complete without (a )?(diff|PR)/i);
});

test('Team1/workerDelta plane gate packet covers broker stability, receipt semantics, queue hygiene, and canary evidence', async () => {
  const content = await doc();

  for (const phrase of [
    'bounded SQLite hot-table loading',
    'process memory',
    'heap/RSS',
    'terminal outbox total/acked/unacked',
    'startup/steady-state memory remains bounded',
    'without forging ACK from provider accepted-send evidence',
    'receipt vocabulary distinguishes',
    'provider accepted-send',
    'non-ACK and non-read-receipt evidence',
    'no-delivery or no-real-ACK canary path',
    'one-shot allowlisted',
    'fresh task/outbox id',
  ]) {
    assert.match(content, new RegExp(escapeRegExp(phrase)));
  }
});

test('Team1/workerDelta plane gate packet remains no-live and approval-gated', async () => {
  const content = await doc();

  assert.match(content, /Decision: `NO-GO \/ Waiting`/);
  assert.match(content, /production activation remains `NO-GO \/ Waiting`/);
  assert.match(content, /separate explicit operator approval/);

  for (const prohibitedAction of [
    'deploy',
    'restart',
    'mutate production databases',
    'prune SQLite/WAL state',
    'ACK terminal-outbox rows',
    'replay historical outbox rows',
    'send Telegram/provider messages',
    'expose secrets',
    'publish a release',
    'force-push',
    'rewrite history',
    'change repository visibility',
  ]) {
    assert.match(content, new RegExp(escapeRegExp(prohibitedAction)));
  }

  assert.doesNotMatch(content, /Decision: `GO`|production activation is approved|cleanup is authorized|Terminal Brief ACK completed/i);
});

test('Team1/workerDelta plane gate packet preserves Terminal Brief and runtime artifact hygiene boundaries', async () => {
  const content = await doc();

  for (const phrase of [
    'no provider send',
    'no terminal-outbox ACK',
    'no read receipt',
    'no approval',
    'no production DB mutation',
    'no deploy/restart',
    'runtime/bootstrap hygiene confirmation',
    'Do not manually ACK/replay Terminal Brief rows',
  ]) {
    assert.match(content, new RegExp(escapeRegExp(phrase)));
  }

  for (const denyPath of ['AGENTS.md', 'SOUL.md', 'USER.md', 'TOOLS.md', 'HEARTBEAT.md', 'IDENTITY.md', '.openclaw/**']) {
    assert.match(content, new RegExp(escapeRegExp(denyPath)));
  }

  assert.doesNotMatch(content, /ghp_|github_pat_|Authorization:\s*Bearer|OPENCLAW_CACHE_BOUNDARY|Session ID:|chat_id\s*[:=]|\/root\//i);
});

test('Team1/workerDelta R7 addendum binds Stability R7 dispatch and deployment-readiness boundary', async () => {
  const content = await doc();

  for (const reference of [
    'a2a-broker#548',
    'a2a-plane#281',
    'Terminal Brief deployment-readiness evidence',
    'deployment-readiness approval boundary',
    'Gate D',
  ]) {
    assert.match(content, new RegExp(escapeRegExp(reference)));
  }

  // R7 risk matrix must define residual risks
  for (const risk of [
    'Provider acceptance treated as ACK',
    'Gateway outbound success mutated as receipt',
    'Canary send without operator approval',
    'Duplicate/replayed Terminal Brief events',
  ]) {
    assert.match(content, new RegExp(escapeRegExp(risk)));
  }

  // R7 deployment-readiness sub-gates
  for (const subGate of ['D.1', 'D.2', 'D.3', 'D.4', 'D.5', 'D.6']) {
    assert.match(content, new RegExp(subGate.replace('.', '\\.')));
  }

  // R7 must preserve pre-R7 gate references unchanged
  assert.match(content, /a2a-broker#539/);
  assert.match(content, /a2a-plane#275/);

  // R7 aggregate decision must remain NO-GO
  assert.match(content, /Terminal Brief live activation decision: `NO-GO \/ Waiting`/);

  // No secrets or unsafe patterns
  assert.doesNotMatch(content, /ghp_|github_pat_|Authorization:\s*Bearer|OPENCLAW_CACHE_BOUNDARY|Session ID:|chat_id\s*[:=]/i);
});
