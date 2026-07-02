import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const docPath = join(repoRoot, 'packages', 'broker', 'docs', 'terminal-brief-live-activation-approval-checklist.md');

async function doc() {
  return readFile(docPath, 'utf8');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test('Team1/workerDelta live activation checklist binds issue, run, and broker', async () => {
  const content = await doc();

  assert.match(content, /a2a-plane#471/);
  assert.match(content, /a2a-team1-terminal-brief-activation-checklist-20260527T113808KST/);
  assert.match(content, /brokerAlpha remains Team1 broker\/finalizer of record/i);
});

test('Team1/workerDelta live activation checklist documents prerequisite documents', async () => {
  const content = await doc();

  for (const ref of ['[D1]', '[D2]', '[D3]', '[D4]', '[D5]', '[D6]', '[D7]', '[D8]', '[D9]', '[D10]', '[D11]', '[D12]', '[D13]']) {
    assert.match(content, new RegExp(escapeRegExp(ref)));
  }
});

test('Team1/workerDelta live activation checklist covers all required approval gate categories', async () => {
  const content = await doc();

  for (const phrase of [
    'Gate 0: Preflight',
    'Gate 1: Broker Deploy',
    'Gate 2: Gateway Plugin',
    'Gate 3: Bounded Live Canary',
    'Gate 4: Rollback',
    'Gate 5: Accepted-Send',
    'Gate 6: Explicit Approval',
    'Gate 7: Verification',
    'Gate 8: Risk Notes',
  ]) {
    assert.match(content, new RegExp(escapeRegExp(phrase)));
  }
});

test('Team1/workerDelta live activation checklist covers broker Docker-only deploy revision', async () => {
  const content = await doc();

  for (const phrase of [
    'Broker image built via Docker',
    'Docker Compose build',
    'Container deployed via `docker compose up -d`',
    'Post-deploy health',
    'Docker healthcheck',
  ]) {
    assert.match(content, new RegExp(escapeRegExp(phrase)));
  }
});

test('Team1/workerDelta live activation checklist covers Gateway plugin-level wiring', async () => {
  const content = await doc();

  for (const phrase of [
    'Plugin config prepared',
    'Plugin-level config only',
    'Phase 1',
    'Phase 2',
    'Phase 3',
    'Phase 4',
    'Gateway restart',
  ]) {
    assert.match(content, new RegExp(escapeRegExp(phrase)));
  }
});

test('Team1/workerDelta live activation checklist covers one bounded canary task', async () => {
  const content = await doc();

  for (const phrase of [
    'Fresh task defined',
    'One-shot fuse',
    'Backlog drained or explicitly blocked',
    'Exactly one send attempt',
    'Canary scope: one-shot only',
  ]) {
    assert.match(content, new RegExp(escapeRegExp(phrase)));
  }
});

test('Team1/workerDelta live activation checklist covers rollback/no-op behavior', async () => {
  const content = await doc();

  for (const phrase of [
    'Notification bridge disable path known',
    'Container stop/remove path known',
    'No-live default restore verified',
    'Rollback decision matrix',
    'UnACKed rows preserved',
  ]) {
    assert.match(content, new RegExp(escapeRegExp(phrase)));
  }
});

test('Team1/workerDelta live activation checklist covers accepted-send vs read/visibility/Terminal ACK separation', async () => {
  const content = await doc();

  for (const phrase of [
    'Provider accepted-send',
    'operator_visible',
    'operator_confirmed',
    'receipt_confirmed',
    'NOT ACK-eligible',
    'ACK-eligible',
    'never inferred from provider send',
  ]) {
    assert.match(content, new RegExp(escapeRegExp(phrase)));
  }
});

test('Team1/workerDelta live activation checklist covers explicit approval gates', async () => {
  const content = await doc();

  for (const action of [
    'Broker Docker deploy',
    'Gateway plugin config apply',
    'Gateway restart/reload',
    'Live provider/Telegram send',
    'Manual terminal-outbox ACK',
    'Production DB mutation',
    'Historical outbox replay',
    'Release/tag/npm publish',
    'Credential/secret change',
    'Repository visibility change',
  ]) {
    assert.match(content, new RegExp(escapeRegExp(action)));
  }
});

test('Team1/workerDelta live activation checklist states deploy/restart/live send/ACK/DB/release/credential need fresh operator approval', async () => {
  const content = await doc();

  assert.match(content, /fresh explicit operator approval/i);
  assert.match(content, /Every deploy, restart, live provider send, manual ACK, replay, DB mutation, release, and credential change requires fresh explicit operator approval/);
  assert.doesNotMatch(content, /implied approval|bundled approval|this document approves|by opening this issue, the operator agrees/i);
});

test('Team1/workerDelta live activation checklist documents risk notes and approval-sensitive blockers', async () => {
  const content = await doc();

  for (const risk of [
    'R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8',
    'Stale terminal-outbox rows replayed',
    'One-shot fuse not engaged',
    'Config typo or accident',
    'Gateway restart not coordinated',
    'Provider accepted-send treated as operator receipt',
    'Docker image drift',
    'Runtime/bootstrap context files',
    'Cross-team parity not verified',
  ]) {
    assert.match(content, new RegExp(escapeRegExp(risk)));
  }
});

test('Team1/workerDelta live activation checklist is no-live and fail-closed', async () => {
  const content = await doc();

  assert.match(content, /This document does not approve live activation/i);
  assert.match(content, /All items are read-only documentation/i);
  assert.doesNotMatch(content, /live activation completed|activation approved|GO for live was granted/i);
});

test('Team1/workerDelta live activation checklist documents runtime/bootstrap hygiene', async () => {
  const content = await doc();

  for (const denyPath of ['AGENTS.md', 'SOUL.md', 'USER.md', 'TOOLS.md', 'HEARTBEAT.md', 'IDENTITY.md', '.openclaw/**']) {
    assert.match(content, new RegExp(escapeRegExp(denyPath)));
  }
  assert.match(content, /fail closed if any OpenClaw[\s\S]*?would enter the branch diff/);
  assert.match(content, /avoid secrets, provider targets, chat IDs,[\s\S]*?private host paths/);
  assert.doesNotMatch(content, /ghp_|github_pat_|Authorization:\s*Bearer|OPENCLAW_CACHE_BOUNDARY|Session ID:|chat_id\s*[:=]/i);
});

test('Team1/workerDelta live activation checklist includes verification output section', async () => {
  const content = await doc();

  for (const command of [
    'terminal_outbox_preflight',
    'live_readiness_canary',
    'terminal_brief_activation_report',
    'docker compose ps',
    'openclaw gateway status',
  ]) {
    assert.match(content, new RegExp(escapeRegExp(command)));
  }
});

test('Team1/workerDelta live activation checklist includes changed files section', async () => {
  const content = await doc();

  assert.match(content, /Changed Files/i);
  assert.match(content, /terminal-brief-live-activation-approval-checklist\.md/);
  assert.match(content, /live-activation-checklist\.test\.mjs/);
  assert.match(content, /package\.json/);
});

test('Team1/workerDelta live activation checklist includes closeout evidence section', async () => {
  const content = await doc();

  assert.match(content, /Closeout Evidence/i);
  assert.match(content, /Start comment/i);
  assert.match(content, /#471/);
  assert.match(content, /PR:/);
  assert.match(content, /Done:/);
});
