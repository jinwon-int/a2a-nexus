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
  'team2-workerEta-r13-terminal-brief-realround-libero.md',
);

async function doc() {
  return readFile(docPath, 'utf8');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test('R13 libero validation binds the current issue, parent, guard, run, and lane metadata', async () => {
  const content = await doc();

  for (const reference of [
    'a2a-plane#306',
    'a2a-broker#607',
    'a2a-broker#598',
    'a2a-r13-terminal-brief-realround-20260514T013556Z',
    'Origin/finalizer broker for this dispatch: `brokerAlpha`',
    'Team2 handoff broker when applicable: `brokerBeta`',
    'Lane: `workerEta`',
    'Order: `7/7`',
    'Target compact title: `A2A Terminal Brief 완료: workerEta(7/7)`',
    'repository and GitHub issue evidence only',
  ]) {
    assert.match(content, new RegExp(escapeRegExp(reference)));
  }

  for (const forbiddenClaim of [
    /parent finalizer closeout is approved/i,
    /#598 full closure is approved/i,
    /approval executed/i,
    /deploy completed/i,
    /reload completed/i,
    /live provider send completed/i,
    /terminal ACK completed/i,
  ]) {
    assert.doesNotMatch(content, forbiddenClaim);
  }
});

test('R13 required parent metadata and compact title contract are exact and fail-closed', async () => {
  const content = await doc();

  for (const phrase of [
    '`parentRoundId`',
    '`originBrokerId`',
    '`parentRoundTotal`',
    '`parentRoundOrder` / lane order',
    '`parentBrokerId` / Terminal Brief owner',
    '`terminalEvidenceKind`',
    '`a2a-r13-terminal-brief-realround-20260514T013556Z`',
    '`brokerAlpha`',
    '`7`',
    '`1/7` through `7/7`; this lane is `7/7`',
    'Must equal `originBrokerId`; `brokerAlpha` for this round',
    '`PR`, `Done`, or `Block` only',
    'Start/running/provider accepted-send evidence is counted as terminal closeout',
    '`A2A Terminal Brief 완료: <worker>(n/7)`',
    '`A2A Terminal Brief 완료: workerEta(7/7)`',
  ]) {
    assert.match(content, new RegExp(escapeRegExp(phrase)));
  }

  assert.doesNotMatch(content, /Start\/running\/provider accepted-send evidence is allowed as terminal closeout/i);
  assert.doesNotMatch(content, /A2A Terminal Brief[^\n|]*\(\d+\/\?\)/i);
});

test('R13 Team2 handoff metadata is directionally explicit and does not own parent aggregation', async () => {
  const content = await doc();

  for (const phrase of [
    '`crossBrokerHandoff.parentRoundId`',
    '`crossBrokerHandoff.originBrokerId`',
    '`crossBrokerHandoff.handoffBrokerId`',
    '`a2a-r13-terminal-brief-realround-20260514T013556Z`',
    '`brokerAlpha`',
    '`brokerBeta`',
    'Handoff payload assumes brokerBeta origin for this brokerAlpha-commanded round',
    'Handoff broker is absent, ambiguous, or treated as parent owner',
    'brokerBeta may execute Team2 handoff work and relay bounded child evidence',
    'brokerBeta must not own, duplicate, ACK, or close the brokerAlpha-origin parent Terminal Brief',
  ]) {
    assert.match(content, new RegExp(escapeRegExp(phrase)));
  }

  assert.doesNotMatch(content, /crossBrokerHandoff[\s\S]{0,120}optional/i);
  assert.doesNotMatch(content, /brokerBeta owns the brokerAlpha-origin parent/i);
});

test('R13 evidence snapshot covers all seven lanes, compact titles, and terminal evidence boundaries', async () => {
  const content = await doc();

  for (const reference of [
    'a2a-broker#608',
    'openclaw-plugin-a2a#307',
    'a2a-broker#609',
    'a2a-plane#305',
    'a2a-broker#610',
    'a2a-docker-runner#251',
    'a2a-plane#306',
    'issuecomment-4446617399',
    'issuecomment-4446618127',
    'issuecomment-4446620137',
    'issuecomment-4446622958',
    'issuecomment-4446623706',
    'issuecomment-4446624377',
    'issuecomment-4446625430',
    'issuecomment-4446632710',
    'issuecomment-4446626360',
    'issuecomment-4446630702',
    'issuecomment-4446629898',
    'issuecomment-4446632488',
    'issuecomment-4446629640',
    'issuecomment-4446638467',
  ]) {
    assert.match(content, new RegExp(escapeRegExp(reference)));
  }

  for (const title of [
    'A2A Terminal Brief 완료: workerGamma(1/7)',
    'A2A Terminal Brief 완료: workerBeta(2/7)',
    'A2A Terminal Brief 완료: workerAlpha(3/7)',
    'A2A Terminal Brief 완료: workerDelta(4/7)',
    'A2A Terminal Brief 완료: workerEpsilon(5/7)',
    'A2A Terminal Brief 완료: workerZeta(6/7)',
    'A2A Terminal Brief 완료: workerEta(7/7)',
  ]) {
    assert.match(content, new RegExp(escapeRegExp(title)));
  }

  for (const phrase of [
    'Start is not terminal evidence',
    'aggregate remains `NO-GO / Waiting`',
    'terminal PR/Done/Block evidence',
    'no sibling lane had terminal PR, Done, or Block evidence',
  ]) {
    assert.match(content, new RegExp(escapeRegExp(phrase), 'i'));
  }

  assert.doesNotMatch(content, /Start marker[\s\S]{0,100}Pass for parent closeout/i);
});

test('R13 risk matrix preserves #598 guard, parent ownership, and receipt ACK separation', async () => {
  const content = await doc();

  for (const phrase of [
    'Guard completeness for #598',
    'Compact title behavior',
    'Parent-only ownership',
    'Receipt and ACK safety',
    'Replay/stale suppression',
    'Provider accepted/message-id',
    'non-ACK evidence',
    'requester-visible receipt',
    'operator-visible receipt',
    'terminal ACK',
    'terminal-outbox ACK',
    'No live canary, manual ACK, historical replay, deploy, restart, or DB mutation',
    'Stale/backlog terminal rows',
  ]) {
    assert.match(content, new RegExp(escapeRegExp(phrase), 'i'));
  }

  for (const forbiddenClaim of [
    /provider accepted-send is (?:a )?receipt/i,
    /message id is (?:a )?terminal ACK/i,
    /brokerBeta execution lanes can steal/i,
    /historical terminal-outbox replay is allowed/i,
  ]) {
    assert.doesNotMatch(content, forbiddenClaim);
  }
});

test('R13 runtime bootstrap hygiene and verification commands are explicit', async () => {
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
    'npm run check:team2-workerEta-r13-terminal-brief-realround-libero',
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
