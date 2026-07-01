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
  'team2-soonwook-r23-terminal-brief-taskflow-monorepo-libero.md',
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

test('R23 libero validation binds issue, parent, run, lane, and safe no-live scope', async () => {
  const content = await doc();

  assertIncludesAll(content, [
    'a2a-plane#338',
    'a2a-plane#335',
    'a2a-r23-terminal-brief-spec-taskflow-monorepo-20260515T055352Z',
    'Lane: `soonwook` / Team2 libero validation (Terminal Brief / TaskFlow / monorepo end-to-end matrix)',
    'Seoseo',
    'Gwakga',
    'repository and GitHub evidence review only',
    'does not deploy, restart Gateway/broker/worker services',
    'does not deploy, restart Gateway/broker/worker services, reload runtime config, send a live provider or Telegram canary',
  ]);

  for (const forbiddenClaim of [
    /R23 closeout is `GO`/i,
    /production activation is approved/i,
    /operator approval executed/i,
    /live provider send completed/i,
    /terminal ACK completed/i,
    /operator-visible receipt completed/i,
  ]) {
    assert.doesNotMatch(content, forbiddenClaim);
  }
});

test('R23 validation matrix covers Terminal Brief, TaskFlow, and monorepo domains', async () => {
  const content = await doc();

  // Domain 1 — Terminal Brief gates
  assertIncludesAll(content, [
    'Domain 1 — Terminal Brief',
    'Four-case parent-origin routing invariant',
    'initiatingBroker == parentBrokerId == originBrokerId == operatorFacingTerminalBriefSender',
    'Cross-broker Terminal Brief owner semantics',
    'terminal-brief-routing-contract.ts',
    'broker-handoff-protocol.md',
    'terminal-evidence-ack-boundary.md',
    'accepted-send',
    'providerAccepted',
    'parent-terminal-brief-aggregation.md',
    'terminal-brief-parent-origin-routing.json',
    'crossBrokerHandoff',
    'parentRoundId',
  ]);

  // Domain 2 — TaskFlow gates
  assertIncludesAll(content, [
    'Domain 2 — TaskFlow',
    'TaskFlow bridge design doc',
    'docs/taskflow/a2a-spec-first-bridge.md',
    'TaskFlow runtime dry-run command',
    'a2a-spec-first-taskflow-runtime',
    'TaskFlow state model safety',
    'runtimeAutomationEnabled',
    'TaskFlow child lane linkage',
    'plane-contract',
    'broker-routing',
    'plugin-relay',
    'libero-validation',
  ]);

  // Domain 3 — Monorepo gates
  assertIncludesAll(content, [
    'Domain 3 — Monorepo',
    'Release gate coverage',
    'check:layout',
    'test:conformance',
    'check:packages',
    'check:terminal-brief-routing',
    'check:message-id-ack-boundary',
    'scan:public-readiness',
    'scan:readiness-gates',
    'scan:external-secrets',
    'Compatibility matrix',
    'contracts/compatibility/matrix.md',
    'Public-readiness scan',
  ]);
});

test('R23 lane snapshot lists the validation lane and treats start-only evidence as waiting', async () => {
  const content = await doc();

  assertIncludesAll(content, [
    'a2a-plane#338',
    'soonwook',
    'Start evidence plus this validation document and test',
    'Start, queued, running, provider accepted-send, GitHub comment creation, and PR creation are not terminal lane evidence',
    'PR, Done, or Block marker',
  ]);
});

test('R23 risk list covers TB/TF integration gap, spec-first version drift, monorepo gate completeness, relay window safety, and bootstrap hygiene', async () => {
  const content = await doc();

  assertIncludesAll(content, [
    'Risk list and runtime activation blockers',
    'Terminal Brief / TaskFlow integration gap',
    'Spec-first packet version drift',
    'Monorepo release gate coverage completeness',
    'Cross-broker relay window safety',
    'Runtime bootstrap hygiene drift',
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
  ]);
});

test('R23 runtime activation blockers include all domain-specific requirements and operator separation', async () => {
  const content = await doc();

  assertIncludesAll(content, [
    'Runtime activation blockers',
    'Terminal Brief parent-origin routing contract v1 has been deployed',
    'TaskFlow bridge design has been implemented as a managed TaskFlow runtime',
    'TaskFlow dry-run command passes',
    'Monorepo release gate includes a cross-domain end-to-end check',
    'Cross-broker relay window is explicitly opened by operator approval',
    'source-only GO/NO-GO',
    'No sibling lane relies on Start-only evidence for final closeout',
    'Runtime bootstrap hygiene is confirmed',
    'Operator approval is a separate downstream action',
  ]);
});

test('R23 source-only GO/NO-GO semantics separate GO from runtime activation', async () => {
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

test('R23 required checks include Terminal Brief, TaskFlow, monorepo gates, sibling evidence, and bootstrap hygiene', async () => {
  const content = await doc();

  assertIncludesAll(content, [
    'parent-terminal-brief-aggregation.md',
    'terminal-brief-parent-origin-routing.json',
    'terminal-brief-routing-contract.ts',
    'broker-handoff-protocol.md',
    'docs/taskflow/a2a-spec-first-bridge.md',
    'a2a-spec-first-taskflow-runtime',
    'npm run check:message-id-ack-boundary',
    'npm run check:team2-final-go-no-go-semantics-libero',
    'npm run check',
    'check-team2-soonwook-r23-terminal-brief-taskflow-monorepo-libero.test.mjs',
    'adds documentation/test evidence only and does not create runtime/bootstrap files',
    'No production deploy/restart/reload, live provider/Telegram send, DB mutation/prune/migration',
  ]);
});

test('R23 bootstrap hygiene fails closed and does not include obvious secret/session leaks', async () => {
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

test('R23 verification performed section lists all inspected references', async () => {
  const content = await doc();

  assertIncludesAll(content, [
    'a2a-plane#338',
    'a2a-plane#335',
    'parent-terminal-brief-aggregation.md',
    'terminal-brief-parent-origin-routing.json',
    'terminal-brief-routing-contract.ts',
    'broker-handoff-protocol.md',
    'handoff-scenarios.ts',
    'two-broker-safety-matrix.ts',
    'terminal-evidence-ack-boundary.md',
    'docs/taskflow/a2a-spec-first-bridge.md',
    'a2a-spec-first-taskflow-runtime',
    'a2a-spec-first-taskflow-bridge',
    'a2a-spec-first-taskflow-runtime-dryrun.json',
    'docs/release-gate.md',
    'contracts/compatibility/matrix.md',
    'public-readiness-scan.mjs',
  ]);
});

test('R23 fixture invariant and parent-round metadata are confirmed in validation document', async () => {
  const content = await doc();

  assertIncludesAll(content, [
    'initiatingBroker == parentBrokerId == originBrokerId == operatorFacingTerminalBriefSender',
    'four-case',
    'Seoseo',
    'Gwakga',
    'parentRoundId',
    'originBrokerId',
    'handoffBrokerId',
    'no-live validation artifact',
  ]);
});
