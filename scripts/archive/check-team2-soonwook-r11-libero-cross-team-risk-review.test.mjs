import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const docPath = join(
  repoRoot,
  'docs',
  'validation',
  'team2-soonwook-r11-libero-cross-team-risk-review.md',
);

async function doc() {
  return readFile(docPath, 'utf8');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test('R11 risk review binds the current issue, parent, run, and safety scope', async () => {
  const content = await doc();

  for (const reference of [
    'a2a-plane#298',
    'a2a-broker#539',
    'a2a-r11-stability-activation-gates-20260513T231046Z',
    'Lane: `soonwook`',
    'Team2 libero cross-team risk review',
    'repository and GitHub issue/PR evidence only',
  ]) {
    assert.match(content, new RegExp(escapeRegExp(reference)));
  }

  for (const forbiddenClaim of [
    /activation is approved/i,
    /approval executed/i,
    /deploy completed/i,
    /reload completed/i,
    /live provider send completed/i,
    /terminal ACK completed/i,
  ]) {
    assert.doesNotMatch(content, forbiddenClaim);
  }
});

test('R11 evidence snapshot covers all sibling lanes and terminal evidence boundaries', async () => {
  const content = await doc();

  for (const reference of [
    'a2a-broker#592',
    'openclaw-plugin-a2a#303',
    'a2a-broker#593',
    'a2a-plane#297',
    'a2a-plane#299',
    'a2a-broker#594',
    'a2a-docker-runner#247',
    'a2a-plane#298',
    'issuecomment-4445895575',
    'issuecomment-4445894434',
    'issuecomment-4445893715',
    'issuecomment-4445906682',
    'issuecomment-4445898175',
    'issuecomment-4445898262',
  ]) {
    assert.match(content, new RegExp(escapeRegExp(reference)));
  }

  for (const phrase of [
    'Start is not terminal evidence',
    'Counts as in-flight PR evidence only',
    'not merge, deploy, receipt, ACK, or approval',
    'aggregate remains `NO-GO / Waiting`',
    'terminal PR/Done/Block evidence',
  ]) {
    assert.match(content, new RegExp(escapeRegExp(phrase), 'i'));
  }

  assert.doesNotMatch(content, /Start marker only[\s\S]{0,80}Pass for activation/i);
  assert.doesNotMatch(content, /PR marker[\s\S]{0,120}approval/i);
});

test('R11 risk matrix preserves read-only semantics and patch-lane no-diff guards', async () => {
  const content = await doc();

  for (const phrase of [
    'Read-only/libero lane semantics',
    '`intent=verify`',
    '`intent=analyze`',
    '`github-propose-patch`',
    'real diff/PR or Block evidence',
    'no-change validation is reported as infrastructure failure',
    'empty patch task is marked Done',
  ]) {
    assert.match(content, new RegExp(escapeRegExp(phrase)));
  }

  assert.doesNotMatch(content, /empty patch task is acceptable|no-diff patch task.*Done/i);
});

test('R11 risk matrix keeps hot-table, queue, receipt, canary, and ACK risks blocked', async () => {
  const content = await doc();

  for (const phrase of [
    'Hot-table CPU/memory and queue stability',
    'bounded state access',
    'CPU/heap-safe hot-table behavior',
    'queue pressure/stale task visibility',
    'no unapproved production DB mutation/prune/migration',
    'Receipt, canary, and ACK boundaries',
    'Provider accepted-send/message id',
    'operator-visible receipt and terminal ACK are separate gates',
    'No live canary or ACK was authorized or attempted',
  ]) {
    assert.match(content, new RegExp(escapeRegExp(phrase), 'i'));
  }

  for (const forbiddenClaim of [
    /hot-table closure is complete/i,
    /provider accepted-send is (?:a )?receipt/i,
    /messageId is (?:a )?terminal ACK/i,
  ]) {
    assert.doesNotMatch(content, forbiddenClaim);
  }
});

test('R11 Terminal Brief aggregation and activation remain parent-owned and approval-gated', async () => {
  const content = await doc();

  for (const phrase of [
    'Parent `seoseo` aggregation counts terminal PR/Done/Block evidence only',
    'Team2/Gwakga projections are bounded, idempotent',
    'local notifications stay disabled',
    'Any attempt to count Start/running/provider evidence as terminal',
    'let `gwakga` own or duplicate the parent notification',
    'create duplicate Terminal Brief rows from projection replay',
    'replay a historical outbox row',
    'fresh explicit operator approval',
    'ACK-safe receipt path',
  ]) {
    assert.match(content, new RegExp(escapeRegExp(phrase)));
  }

  assert.doesNotMatch(content, /Gwakga owns the parent notification|historical outbox replay is allowed/i);
});

test('R11 runtime bootstrap hygiene and verification commands are explicit', async () => {
  const content = await doc();

  for (const denyPath of [
    'AGENTS.md',
    'SOUL.md',
    'USER.md',
    'TOOLS.md',
    'HEARTBEAT.md',
    'IDENTITY.md',
    '.openclaw/**',
  ]) {
    assert.match(content, new RegExp(escapeRegExp(denyPath)));
  }

  for (const phrase of [
    'npm run check:team2-soonwook-r11-libero-cross-team-risk-review',
    'npm run check:message-id-ack-boundary',
    'npm run check:layout',
    'git status --short --ignored',
    'Branch diff, PR body, issue comments, and artifact evidence exclude secrets',
    'Offending paths must be reported exactly',
  ]) {
    assert.match(content, new RegExp(escapeRegExp(phrase), 'i'));
  }

  assert.doesNotMatch(content, /ghp_|github_pat_|Authorization:\s*Bearer|OPENCLAW_CACHE_BOUNDARY|chat_id\s*[:=]/i);
});
