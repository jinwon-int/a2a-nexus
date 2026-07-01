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
  'team2-soonwook-r12-libero-cross-team-origin-routing-risk-review.md',
);

async function doc() {
  return readFile(docPath, 'utf8');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test('R12 risk review binds the current issue, parent, run, origin, and safety scope', async () => {
  const content = await doc();

  for (const reference of [
    'a2a-plane#302',
    'a2a-broker#598',
    'a2a-r12-origin-terminal-brief-guard-20260513T235116Z',
    'Origin/finalizer broker for this dispatch: `seoseo`',
    'Lane: `soonwook`',
    'Team2 libero cross-team origin-routing risk review',
    'repository and GitHub issue evidence only',
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

test('R12 required metadata contract is exact and fail-closed', async () => {
  const content = await doc();

  for (const phrase of [
    '`parentRoundId`',
    '`originBrokerId`',
    '`parentRoundTotal`',
    '`parentBrokerId` / Terminal Brief owner',
    '`terminalEvidenceKind`',
    '`a2a-r12-origin-terminal-brief-guard-20260513T235116Z`',
    '`seoseo` for this round',
    '`7`',
    'Must equal `originBrokerId`; `seoseo` for this round',
    '`PR`, `Done`, or `Block` only',
    'Start/running/provider accepted-send evidence is counted as terminal closeout',
  ]) {
    assert.match(content, new RegExp(escapeRegExp(phrase)));
  }

  assert.doesNotMatch(content, /Start\/running\/provider accepted-send evidence is allowed as terminal closeout/i);
  assert.doesNotMatch(content, /A2A Terminal Brief[^\n|]*\(\d+\/\?\)/i);
});

test('R12 Team2 handoff metadata is directionally explicit', async () => {
  const content = await doc();

  for (const phrase of [
    '`crossBrokerHandoff.parentRoundId`',
    '`crossBrokerHandoff.originBrokerId`',
    '`crossBrokerHandoff.handoffBrokerId`',
    '`a2a-r12-origin-terminal-brief-guard-20260513T235116Z`',
    '`seoseo`',
    '`gwakga`',
    'Handoff payload assumes Gwakga origin for a Seoseo-commanded round',
    'Handoff broker is absent, ambiguous, or treated as parent owner',
  ]) {
    assert.match(content, new RegExp(escapeRegExp(phrase)));
  }

  assert.doesNotMatch(content, /crossBrokerHandoff[\s\S]{0,120}optional/i);
});

test('R12 symmetric origin-routing is origin-based and not Seoseo-hardcoded', async () => {
  const content = await doc();

  for (const phrase of [
    'The guard must be origin-based, not Seoseo-hardcoded',
    'If `seoseo` initiates/commands the parent round',
    'owned by `seoseo`',
    'If `gwakga` initiates/commands a future parent round',
    'owned by `gwakga`',
    'Handoff/execution broker is not the Terminal Brief owner unless it is also the origin/parent broker',
    'Seoseo→Gwakga',
    'Gwakga→Seoseo',
    '30–60 second verification window',
  ]) {
    assert.match(content, new RegExp(escapeRegExp(phrase)));
  }

  assert.doesNotMatch(content, /Seoseo is always the parent Terminal Brief owner|Gwakga can never own parent aggregation/i);
});

test('R12 evidence snapshot covers all sibling lanes and terminal evidence boundaries', async () => {
  const content = await doc();

  for (const reference of [
    'a2a-broker#599',
    'openclaw-plugin-a2a#305',
    'a2a-broker#600',
    'a2a-plane#301',
    'a2a-broker#601',
    'a2a-docker-runner#249',
    'a2a-plane#302',
    'issuecomment-4446102891',
    'issuecomment-4446103638',
    'issuecomment-4446104273',
    'issuecomment-4446103922',
    'issuecomment-4446104403',
    'issuecomment-4446103689',
    'issuecomment-4446104078',
  ]) {
    assert.match(content, new RegExp(escapeRegExp(reference)));
  }

  for (const phrase of [
    'Start is not terminal evidence',
    'aggregate remains `NO-GO / Waiting`',
    'terminal PR/Done/Block evidence',
    'Start evidence across the seven child lanes',
  ]) {
    assert.match(content, new RegExp(escapeRegExp(phrase), 'i'));
  }

  assert.doesNotMatch(content, /Start marker only[\s\S]{0,80}Pass for activation/i);
  assert.doesNotMatch(content, /Start evidence[\s\S]{0,120}activation is approved/i);
});

test('R12 risk matrix preserves origin ownership, handoff containment, and ACK separation', async () => {
  const content = await doc();

  for (const phrase of [
    'Origin metadata propagation',
    'Symmetric parent ownership',
    'Handoff broker containment',
    'Receipt, provider, and ACK separation',
    'Replay/stale suppression',
    'Provider accepted-send/message id',
    'requester-visible receipt',
    'operator-visible receipt',
    'terminal ACK',
    'terminal-outbox ACK',
    'No live canary or ACK was authorized or attempted',
    'Duplicate Terminal Brief projection',
    'stale/backlog replay',
  ]) {
    assert.match(content, new RegExp(escapeRegExp(phrase), 'i'));
  }

  for (const forbiddenClaim of [
    /provider accepted-send is (?:a )?receipt/i,
    /messageId is (?:a )?terminal ACK/i,
    /handoff broker owns Seoseo-origin parent/i,
    /future Gwakga-origin proof is complete/i,
  ]) {
    assert.doesNotMatch(content, forbiddenClaim);
  }
});

test('R12 runtime bootstrap hygiene and verification commands are explicit', async () => {
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
    'npm run check:team2-soonwook-r12-libero-cross-team-origin-routing-risk-review',
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
