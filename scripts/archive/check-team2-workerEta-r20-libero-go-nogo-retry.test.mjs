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
  'team2-workerEta-r20-libero-go-nogo-retry.md',
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

test('R20 libero validation binds issue, parent, run, lane, and safe no-live scope', async () => {
  const content = await doc();

  assertIncludesAll(content, [
    'a2a-plane#328',
    'a2a-broker#636',
    'r20-libero-go-nogo-retry-workerEta-20260514T2320Z',
    'Lane: `workerEta` / Team2 libero validation',
    'brokerBeta',
    'repository and GitHub evidence review only',
    'does not deploy, restart Gateway/broker/worker services',
    'does not deploy, restart Gateway/broker/worker services, reload runtime config, send a live provider or Telegram canary',
  ]);

  for (const forbiddenClaim of [
    /R20 closeout is `GO`/i,
    /production activation is approved/i,
    /operator approval executed/i,
    /live provider send completed/i,
    /terminal ACK completed/i,
    /operator-visible receipt completed/i,
  ]) {
    assert.doesNotMatch(content, forbiddenClaim);
  }
});

test('R20 validation matrix covers broker hot-table persistence, queue hygiene, stale PRs, and release-gate', async () => {
  const content = await doc();

  assertIncludesAll(content, [
    'Broker hot-table persistence',
    'R14 residual',
    '#620/#622/#626',
    'Queue/outbox hygiene',
    'fail-closed dry-run/reporting',
    'mutation path remains approval-gated',
    'Plane contract/release-gate stability policy',
    'no-live activation boundary',
    'PR #254',
    'source-only GO/NO-GO',
  ]);
});

test('R20 lane snapshot lists all workers and treats start-only evidence as waiting', async () => {
  const content = await doc();

  assertIncludesAll(content, [
    'jinwon-int/a2a-broker#620',
    'jinwon-int/a2a-broker#622',
    'jinwon-int/a2a-broker#626',
    'a2a-plane#328',
    'Start evidence only at validation snapshot',
    'Start, queued, running, provider accepted-send, GitHub comment creation, and PR creation are not terminal lane evidence',
    'PR, Done, or Block marker',
  ]);
});

test('R20 risk list covers hot-table OOM risk, queue hygiene, stale PR sequencing, and cross-round dependency', async () => {
  const content = await doc();

  assertIncludesAll(content, [
    'Risk list and runtime activation blockers',
    'Hot-table persistence completeness',
    'Queue hygiene boundedness',
    'Stale R14 PR merge sequencing',
    'Cross-round dependency',
    'R21 worker runtime repair',
  ]);
});

test('R20 runtime activation blockers include broker PR evidence, queue hygiene report, GO decision, and operator separation', async () => {
  const content = await doc();

  assertIncludesAll(content, [
    'Runtime activation blockers',
    'broker hot-table PR',
    'Queue/outbox hygiene fail-closed dry-run report exists',
    'source-only GO/NO-GO',
    'No sibling lane relies on Start-only evidence for final closeout',
    'Operator approval is a separate downstream action',
    'R21 runtime repair outcome is reviewed',
  ]);
});

test('R20 source-only GO/NO-GO semantics separate GO from runtime activation', async () => {
  const content = await doc();

  assertIncludesAll(content, [
    'Source-only GO/NO-GO decision',
    'NO-GO / Waiting',
    '`GO` is a source-only decision',
    'does not authorize runtime activation',
    'production deploy',
    'Terminal Brief ACK',
    'separate explicit operator approval',
    'Source execution remains `NO_GO`',
  ]);
});

test('R20 required checks include sibling terminal evidence and broker stale PR resolution', async () => {
  const content = await doc();

  assertIncludesAll(content, [
    'Broker stale PR lanes #620/#622/#626 each have terminal PR/Done/Block evidence',
    'Queue/outbox hygiene has an explicit fail-closed dry-run report',
    'npm run check:message-id-ack-boundary',
    'npm run check:team2-final-go-no-go-semantics-libero',
    'docs/tests only',
    'No production deploy/restart/reload, live provider/Telegram send, DB mutation/prune/migration',
  ]);
});

test('R20 bootstrap hygiene fails closed and does not include obvious secret/session leaks', async () => {
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

test('R20 verification performed section lists all inspected references', async () => {
  const content = await doc();

  assertIncludesAll(content, [
    'a2a-broker#636',
    'jinwon-int/a2a-broker/issues/620',
    'jinwon-int/a2a-broker/issues/622',
    'jinwon-int/a2a-broker/issues/626',
    'a2a-plane#328',
    '#497',
    '#294',
    'a2a-plane#254',
  ]);
});
