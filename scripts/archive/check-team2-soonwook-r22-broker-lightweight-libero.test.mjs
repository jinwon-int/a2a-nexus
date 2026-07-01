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
  'team2-soonwook-r22-broker-lightweight-libero.md',
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

test('R22 libero validation binds issue, parent, run, lane, and safe no-live scope', async () => {
  const content = await doc();

  assertIncludesAll(content, [
    'a2a-plane#332',
    'a2a-broker#497',
    'r22-broker-lightweight-20260515T015139Z',
    'Lane: `soonwook` / Team2 libero validation',
    'Gwakga',
    'repository and GitHub evidence review only',
    'does not deploy, restart Gateway/broker/worker services',
    'does not deploy, restart Gateway/broker/worker services, reload runtime config, send a live provider or Telegram canary',
  ]);

  for (const forbiddenClaim of [
    /R22 closeout is `GO`/i,
    /production activation is approved/i,
    /operator approval executed/i,
    /live provider send completed/i,
    /terminal ACK completed/i,
    /operator-visible receipt completed/i,
  ]) {
    assert.doesNotMatch(content, forbiddenClaim);
  }
});

test('R22 validation matrix covers broker lightweight round, R14 residuals, cross-broker semantics, and routing guard', async () => {
  const content = await doc();

  assertIncludesAll(content, [
    'Broker hot-table state growth',
    'lightweight/performance round',
    'a2a-broker#497',
    '#617/#618/#619',
    'R14 residual',
    'Cross-broker Terminal Brief owner semantics',
    'Seoseo remains parent/origin broker',
    'operatorFacingTerminalBriefSender',
    'parent-terminal-brief-aggregation.md',
    'terminal-brief-parent-origin-routing.json',
    'terminal-brief-routing-contract.ts',
    'broker-handoff-protocol.md',
    'crossBrokerHandoff',
    'four receipt levels',
    'providerAccepted',
    'no-live validation artifact',
  ]);
});

test('R22 lane snapshot lists all workers and treats start-only evidence as waiting', async () => {
  const content = await doc();

  assertIncludesAll(content, [
    'jinwon-int/a2a-broker#617',
    'jinwon-int/a2a-broker#618',
    'jinwon-int/a2a-broker#619',
    'a2a-plane#332',
    'Start evidence only at validation snapshot',
    'Start, queued, running, provider accepted-send, GitHub comment creation, and PR creation are not terminal lane evidence',
    'PR, Done, or Block marker',
  ]);
});

test('R22 risk list covers lightweight scope ambiguity, hot-table retention, two-broker safety, diagnostics, and cross-broker regression', async () => {
  const content = await doc();

  assertIncludesAll(content, [
    'Risk list and runtime activation blockers',
    'Lightweight/performance scope ambiguity',
    'Hot-table retention completeness',
    'Two-broker deploy safety dependency',
    'Secret-safe diagnostics timing',
    'Cross-broker Terminal Brief owner regression',
  ]);
});

test('R22 runtime activation blockers include R14 evidence, lightweight lanes, cross-broker revalidation, and operator separation', async () => {
  const content = await doc();

  assertIncludesAll(content, [
    'Runtime activation blockers',
    'terminal Done/PR/Block evidence',
    'Lightweight-specific lane issues',
    'source-only GO/NO-GO',
    'No sibling lane relies on Start-only evidence for final closeout',
    'Operator approval is a separate downstream action',
  ]);
});

test('R22 source-only GO/NO-GO semantics separate GO from runtime activation', async () => {
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

test('R22 required checks include sibling terminal evidence, cross-broker invariants, and routing guard integrity', async () => {
  const content = await doc();

  assertIncludesAll(content, [
    'R14 residual broker lanes #617/#618/#619 each have terminal PR/Done/Block evidence',
    'Lightweight/performance gap assessment',
    'cross-broker Terminal Brief owner semantics',
    'terminal-brief-routing-contract',
    'parent-terminal-brief-aggregation.md',
    'broker-handoff-protocol.md',
    'Terminal Brief routing guard integrity',
    'npm run check:message-id-ack-boundary',
    'npm run check:team2-final-go-no-go-semantics-libero',
    'docs/tests only',
    'No production deploy/restart/reload, live provider/Telegram send, DB mutation/prune/migration',
  ]);
});

test('R22 bootstrap hygiene fails closed and does not include obvious secret/session leaks', async () => {
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

test('R22 verification performed section lists all inspected references', async () => {
  const content = await doc();

  assertIncludesAll(content, [
    'a2a-broker#497',
    'a2a-broker#294',
    'a2a-plane#332',
    'jinwon-int/a2a-broker/issues/617',
    'jinwon-int/a2a-broker/issues/618',
    'jinwon-int/a2a-broker/issues/619',
    'a2a-broker#615',
    'crossBrokerHandoff',
    'terminal-brief-routing-contract.ts',
    'parent-terminal-brief-aggregation.md',
    'broker-handoff-protocol.md',
    'terminal-brief-parent-origin-routing.json',
  ]);
});

test('R22 fixture invariant is confirmed in validation document', async () => {
  const content = await doc();

  assertIncludesAll(content, [
    'initiatingBroker == parentBrokerId == originBrokerId == operatorFacingTerminalBriefSender',
    'four-case',
    'Seoseo',
    'Gwakga',
  ]);
});
