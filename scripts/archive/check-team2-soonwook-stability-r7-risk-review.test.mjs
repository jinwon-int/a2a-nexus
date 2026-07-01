import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const docPath = join(repoRoot, 'docs', 'validation', 'team2-soonwook-stability-r7-risk-review.md');

async function doc() {
  return readFile(docPath, 'utf8');
}

test('Stability R7 risk review binds the current parent, lane, run, and sibling evidence', async () => {
  const content = await doc();

  for (const reference of [
    'a2a-broker#548',
    'a2a-plane#282',
    'a2a-stability-r7-20260513T101831Z',
    'a2a-broker#549',
    'a2a-broker#550',
    'a2a-docker-runner#237',
    'a2a-docker-runner#238',
    'openclaw-plugin-a2a#294',
    'a2a-plane#281',
  ]) {
    assert.match(content, new RegExp(reference.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }

  assert.match(content, /Start evidence only|no terminal PR\/Done\/Block evidence observed/);
  assert.doesNotMatch(content, /a2a-broker#539|a2a-plane#276/);
});

test('Stability R7 compatibility matrix preserves read-only semantics and patch-lane no-diff guards', async () => {
  const content = await doc();

  for (const phrase of [
    'Compatibility matrix',
    'intent=verify',
    'intent=analyze',
    'read-only modes',
    'github-propose-patch',
    'real diff/PR or Block evidence',
    'PR-less evidence is valid only for explicit read-only/libero work',
    'no-diff patch-lane protection remains mandatory',
  ]) {
    assert.match(content, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }

  assert.doesNotMatch(content, /empty patch output.*is acceptable Done|no repository changes.*patch.*success/i);
});

test('Stability R7 risk review keeps broker liveness, canary, and receipt gates blocked until evidence exists', async () => {
  const content = await doc();

  for (const phrase of [
    'NO-GO / Waiting',
    'Broker CPU/heap/OOM from hot-table growth',
    'Bounded state access/persistence',
    'health output with memory/table/outbox counts',
    'provider accepted-send',
    'Telegram message ids',
    'No-live canary/replay proof',
    'explicit operator approval',
    'a2a-broker#497',
    'a2a-broker#527',
    'a2a-broker#294',
  ]) {
    assert.match(content, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }

  assert.doesNotMatch(content, /GO for broker OOM closure|GO for live canary authorization|terminal ACK\/read receipt completed/i);
});

test('Stability R7 Terminal Brief evidence remains no-live, non-ACK, and approval-separated', async () => {
  const content = await doc();

  for (const phrase of [
    'Stable projection key',
    'child issue/PR/Done/Block URLs',
    'no-provider-send/no-ACK/no-read-receipt flags',
    'no historical replay',
    'production activation remains blocked',
    'fresh explicit operator approval',
  ]) {
    assert.match(content, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }

  assert.doesNotMatch(content, /messageId.*is terminal ACK|provider accepted.*is read receipt|Terminal Brief is deployment approval/i);
});

test('Stability R7 artifact hygiene fails closed on runtime bootstrap leakage', async () => {
  const content = await doc();

  for (const denyPath of ['AGENTS.md', 'SOUL.md', 'USER.md', 'TOOLS.md', 'HEARTBEAT.md', 'IDENTITY.md', '.openclaw/**']) {
    assert.match(content, new RegExp(denyPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }

  for (const phrase of [
    'git status --short --ignored',
    'denied paths enter the branch or artifact evidence',
    'bounded, redacted, and repository-relative',
    'secrets',
    'raw logs',
    'host-private paths',
  ]) {
    assert.match(content, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});
