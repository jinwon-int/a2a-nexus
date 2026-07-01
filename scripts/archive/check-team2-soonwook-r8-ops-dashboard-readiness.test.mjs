import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const docPath = join(repoRoot, 'docs', 'validation', 'team2-soonwook-r8-ops-dashboard-readiness.md');

async function doc() {
  return readFile(docPath, 'utf8');
}

function escaped(reference) {
  return new RegExp(reference.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
}

test('R8 ops dashboard validation binds the parent, lane, run, and sibling issues', async () => {
  const content = await doc();

  for (const reference of [
    'a2a-broker#553',
    'a2a-plane#286',
    'a2a-r8-ops-dashboard-20260513T111122Z',
    'a2a-broker#554',
    'openclaw-plugin-a2a#296',
    'a2a-broker#555',
    'a2a-plane#285',
    'a2a-broker#556',
    'a2a-docker-runner#241',
  ]) {
    assert.match(content, escaped(reference));
  }

  assert.match(content, /GitHub-current fleet update/);
  assert.match(content, /Start-only|Start marker only|Start markers only/);
  assert.doesNotMatch(content, /a2a-stability-r7-20260513T101831Z|a2a-broker#548/);
});

test('R8 dashboard/read-model gates require bounded current evidence and stale task clarity', async () => {
  const content = await doc();

  for (const phrase of [
    'Bounded two-broker dashboard/read model',
    'worker online state',
    'active task count',
    'stale task count',
    'queue pressure',
    'terminal-outbox ambiguity',
    'bounded queries or cached summaries',
    'Current workers, stale historical workers, queued tasks, claimed/running tasks, terminal tasks, and residue cleanup candidates',
    'Cleanup remains proposal-only',
  ]) {
    assert.match(content, escaped(phrase));
  }

  assert.doesNotMatch(content, /cleanup is authorized from this lane|unbounded hot-table snapshots are acceptable|age alone proves safe cleanup/i);
});

test('R8 PR-less validation and operator UX boundaries stay receipt-safe', async () => {
  const content = await doc();

  for (const phrase of [
    'PR-less validation evidence',
    'Read-only/libero tasks can close with bounded Done/Block evidence',
    'patch-producing lanes still fail closed on no diff',
    'Receipt-safe operator UX',
    'Provider accepted-send',
    'provider message ids',
    'GitHub comments',
    'dashboard projection',
    'Terminal Brief text remain evidence inputs only',
  ]) {
    assert.match(content, escaped(phrase));
  }

  assert.doesNotMatch(content, /provider `accepted` alone is requester-visible receipt|messageId alone is terminal ACK|GitHub comment success alone is operator-visible receipt/i);
});

test('R8 Terminal Brief pre-activation remains NO-GO until evidence and approval gates exist', async () => {
  const content = await doc();

  for (const phrase of [
    'Decision: `NO-GO / Waiting`',
    'Pre-activation GO requires sibling terminal evidence',
    'no-live replay/stale suppression proof',
    'separately approved one-shot canary',
    'ACK-safe receipt evidence',
    'rollback/no-live restoration',
    'separate operator approval',
    'production activation and Terminal Brief pre-activation GO',
  ]) {
    assert.match(content, escaped(phrase));
  }

  assert.doesNotMatch(content, /Decision: `GO`|live provider\/Telegram send is approved|Terminal Brief ACK completed|operator approval executed/i);
});

test('R8 artifact hygiene fails closed on runtime bootstrap leakage', async () => {
  const content = await doc();

  for (const denyPath of ['AGENTS.md', 'SOUL.md', 'USER.md', 'TOOLS.md', 'HEARTBEAT.md', 'IDENTITY.md', '.openclaw/**']) {
    assert.match(content, escaped(denyPath));
  }

  for (const phrase of [
    'fail closed if the branch diff or artifact evidence contains actual OpenClaw runtime/bootstrap context files',
    'repo-relative paths',
    'host-private paths',
    'raw session dumps',
    'provider targets',
    'chat IDs',
    'secrets',
    'Provider message-id/send success remains provider-accepted evidence only',
  ]) {
    assert.match(content, escaped(phrase));
  }
});
