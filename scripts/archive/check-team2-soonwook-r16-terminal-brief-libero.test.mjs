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
  'team2-soonwook-r16-terminal-brief-libero.md',
);

async function doc() {
  return readFile(docPath, 'utf8');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function assertIncludesAll(content, references, flags = '') {
  for (const reference of references) {
    assert.match(content, new RegExp(escapeRegExp(reference), flags));
  }
}

test('R16 libero validation binds issue, parent, run, lane, and safe no-live scope', async () => {
  const content = await doc();

  assertIncludesAll(content, [
    'a2a-plane#316',
    'a2a-broker#631',
    'r16-terminal-brief-libero-soonwook-20260514T0937Z',
    'Lane: `soonwook` / Team2 libero validation',
    'issuecomment-4449532046',
    'repository and GitHub evidence review only',
    'does not deploy, restart Gateway/broker/worker services',
    'does not deploy, restart Gateway/broker/worker services, reload runtime config, send a live provider or Telegram canary',
  ]);

  for (const forbiddenClaim of [
    /R16 closeout is `GO`/i,
    /production activation is approved/i,
    /operator approval executed/i,
    /live provider send completed/i,
    /terminal ACK completed/i,
    /operator-visible receipt completed/i,
  ]) {
    assert.doesNotMatch(content, forbiddenClaim);
  }
});

test('R16 matrix covers broker payload, plugin observability, cursor, backlog, and ACK boundaries', async () => {
  const content = await doc();

  assertIncludesAll(content, [
    'Broker payload metadata preservation',
    '`parentRoundId`',
    '`originBrokerId`',
    '`brokerOfRecordId`',
    '`parentRoundOrder`/`parentRoundIndex`',
    '`parentRoundTotal`',
    '`childWorkerId`',
    '`title`/`terminalBriefTitle`',
    'Plugin terminal-outbox poller attempt observability',
    'attempt count/timestamp',
    'redacted provider adapter result',
    'Cursor, allowlist, and backlog behavior',
    'safe cursor/`after_id` baseline',
    'No historical replay, manual ACK/replay, or DB mutation',
    'Provider accepted-send versus receipt/ACK/read boundary',
    'requester-visible receipt',
    'operator-visible receipt',
    'read visibility',
    'terminal ACK',
    'terminal-outbox ACK',
  ]);

  assert.doesNotMatch(content, /provider accepted-send(?:\s+evidence)? is (?:a )?(?:requester-visible |operator-visible )?receipt/i);
  assert.doesNotMatch(content, /message IDs? (?:are|is) (?:a )?terminal ACK/i);
});

test('R16 lane snapshot lists all workers and treats start-only evidence as waiting', async () => {
  const content = await doc();

  assertIncludesAll(content, [
    '`dungae` | [openclaw-plugin-a2a#313]',
    '`jingun` | [a2a-broker#632]',
    '`soonwook` | a2a-plane#316',
    'Start evidence only at validation snapshot',
    'Start evidence plus this PR after runner closeout',
    'Start, queued, running, provider accepted-send, GitHub comment creation, and PR creation are not terminal lane evidence',
    'PR, Done, or Block marker',
  ]);
});

test('R16 canary checklist distinguishes pass criteria from fail and abort criteria', async () => {
  const content = await doc();

  assertIncludesAll(content, [
    'Future operator-approved canary checklist',
    'fresh explicit operator approval',
    'approved task or terminal-outbox id',
    'maxProviderSends=1',
    'Pass criteria',
    'exactly one bounded notification attempt',
    'No historical/backlog row is attempted, replayed, ACKed, pruned, or mutated',
    'Provider accepted-send is reported as non-ACK evidence only',
    'Fail / abort criteria',
    'Attempts remain zero',
    'More than one provider send is attempted',
    'manual DB mutation, prune, terminal ACK, replay, historical task replay',
  ]);
});

test('R16 required checks include sibling terminal evidence and local ACK-boundary verification', async () => {
  const content = await doc();

  assertIncludesAll(content, [
    'Broker lane #632 has PR/Done/Block evidence',
    'Plugin lane #313 has PR/Done/Block evidence',
    'npm run check:message-id-ack-boundary',
    'docs/tests/package wiring only',
    'No production deploy/restart/reload, live provider/Telegram send, DB mutation/prune/migration, Terminal Brief ACK/replay',
  ]);
});

test('R16 bootstrap hygiene fails closed and does not include obvious secret/session leaks', async () => {
  const content = await doc();

  assertIncludesAll(content, [
    'OpenClaw runtime/bootstrap context files',
    'AGENTS.md',
    'SOUL.md',
    'USER.md',
    'TOOLS.md',
    'HEARTBEAT.md',
    'IDENTITY.md',
    '.openclaw/**',
    'BOOTSTRAP.md',
    'MEMORY.md',
    'memory/**',
    'offending paths',
  ]);

  assert.doesNotMatch(content, /ghp_|github_pat_|Authorization:\s*Bearer|OPENCLAW_CACHE_BOUNDARY|raw session dump/i);
});
