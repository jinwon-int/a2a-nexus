import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const docPath = join(
  repoRoot,
  'docs',
  'validation',
  'team1-bangtong-r26-no-live-terminal-brief-integration-rehearsal.md',
);

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function assertIncludesAll(content, references, flags = '') {
  for (const reference of references) {
    assert.match(content, new RegExp(escapeRegExp(reference), flags));
  }
}

function assertExcludesAll(content, references, flags = '') {
  for (const reference of references) {
    assert.doesNotMatch(content, new RegExp(escapeRegExp(reference), flags));
  }
}

async function doc() {
  return readFile(docPath, 'utf8');
}

test('R26 rehearsal doc exists and references the correct lane metadata', async () => {
  const content = await doc();

  assertIncludesAll(content, [
    'a2a-r26-team1-no-live-terminal-brief-integration-rehearsal-20260515T1832Z',
    'a2a-plane#360',
    'a2a-plane#361',
    'Team1/bangtong',
    'Seoseo',
  ]);
});

test('R26 rehearsal doc references R25 merged artifacts', async () => {
  const content = await doc();

  assertIncludesAll(content, [
    'a2a-plane#359',
    'a2a-docker-runner#275',
    'team1-bangtong-r25-ops-readiness-terminal-brief.md',
    'R25 ops-readiness gate definition',
  ]);
});

test('R26 rehearsal doc defines all five rehearsal domains (R1–R5)', async () => {
  const content = await doc();

  for (const domain of [
    'R1. Production safety gate compliance',
    'R2. Rollback rehearsal',
    'R3. Default-off verification',
    'R4. Operator approval boundary definition',
    'R5. Runtime/bootstrap hygiene',
  ]) {
    assert.match(content, new RegExp(escapeRegExp(domain)));
  }
});

test('R26 rehearsal doc defines pass/fail criteria for each R1 gate', async () => {
  const content = await doc();

  assertIncludesAll(content, [
    'R1.1',
    'R1.2',
    'R1.3',
    'R1.4',
    'R1.5',
    'R1.6',
    'check-contract-fixtures.mjs',
    'check:terminal-brief-routing',
    'check-terminal-evidence-ack-boundary.mjs',
    'check-message-id-ack-boundary',
  ]);
});

test('R26 rehearsal doc defines pass/fail criteria for each R2 rollback step', async () => {
  const content = await doc();

  assertIncludesAll(content, [
    'R2.1',
    'R2.2',
    'R2.3',
    'R2.4',
    'R2.5',
    'pre-deploy broker image tag',
    'Rollback safety invariants',
    'Post-rollback verification',
  ]);
});

test('R26 rehearsal doc defines pass/fail criteria for each R3 default-off step', async () => {
  const content = await doc();

  assertIncludesAll(content, [
    'R3.1',
    'R3.2',
    'R3.3',
    'R3.4',
    'R3.5',
    'R3.6',
    'terminalBriefEnabled: false',
    'liveProviderSend: false',
    'notificationDisabled: true',
    'productionAckAttempted: false',
    'relayEnabled: false',
  ]);
});

test('R26 rehearsal doc defines pass/fail criteria for each R4 approval step', async () => {
  const content = await doc();

  assertIncludesAll(content, [
    'R4.1',
    'R4.2',
    'R4.3',
    'R4.4',
    'separate comment',
    'no-approval zone',
    'revocation',
  ]);
});

test('R26 rehearsal doc defines R5 hygiene steps', async () => {
  const content = await doc();

  assertIncludesAll(content, [
    'R5.1',
    'R5.2',
    'R5.3',
    'AGENTS.md',
    'SOUL.md',
    'USER.md',
    'TOOLS.md',
    'HEARTBEAT.md',
    'IDENTITY.md',
    '.openclaw',
    'GitHub PAT tokens',
    'authorization bearer headers',
    'cache boundary markers',
  ]);
});

test('R26 rehearsal doc includes safety boundary, verification commands, and evidence packet schema', async () => {
  const content = await doc();

  assertIncludesAll(content, [
    'Safety boundary',
    'production deploy',
    'Gateway/broker/worker restart',
    'live provider/Telegram canary',
    'production DB mutation',
    'terminal-outbox ACK',
    'historical outbox replay',
    'secret movement',
    'Rehearsal verification commands',
    'check-team1-bangtong-r26-no-live-terminal-brief-integration-rehearsal.test.mjs',
    'check-team1-bangtong-r25-ops-readiness-terminal-brief.test.mjs',
    'Rehearsal evidence packet',
    'REHEARSAL_PASS',
    'REHEARSAL_FAIL',
  ]);
});

test('R26 rehearsal doc defines activation gate advancement conditions', async () => {
  const content = await doc();

  assertIncludesAll(content, [
    'Activation gate advancement',
    'GO condition',
    'NO-GO conditions',
    'BLOCK conditions',
  ]);
});

test('R26 rehearsal doc includes residual risks and closeout boundary', async () => {
  const content = await doc();

  assertIncludesAll(content, [
    'Residual risks',
    'Team2 PR may change scope',
    'Rehearsal does not test live Gateway notification bridge',
    'Config drift between rehearsal and activation',
    'Operator approval may be bundled',
    'Closeout boundary',
    'does not activate',
    'accept Team2 code',
    'grant operator approval',
  ]);
});

test('R26 rehearsal doc does not claim production activation or operator approval', async () => {
  const content = await doc();

  // The doc should use "no-live" framing and explicitly deny activation.
  assert.match(content, /no-live.*rehearsal/i);
  assert.match(content, /Did not deploy or restart/i);
  assert.match(content, /Did not grant or imply operator approval/i);

  // Should not claim live activation or approval was granted
  assertExcludesAll(content, [
    'has been activated in production',
    'operator approval has been granted',
    'this lane activated Terminal Brief',
    'this rehearsal activated',
  ], 'i');
});

test('R26 rehearsal doc guards against secret-shaped content', async () => {
  const content = await doc();

  assert.doesNotMatch(content, /Authorization:\s*Bearer [A-Za-z0-9+/]+|OPENCLAW_CACHE_BOUNDARY|raw session dump|chat_id\s*[:=]\s*\d+|\/root\//i);
});

test('R5.1 — git diff guard paths report no OpenClaw context files in the branch', () => {
  const result = execSync(
    'git diff --name-only -- AGENTS.md SOUL.md USER.md TOOLS.md HEARTBEAT.md IDENTITY.md .openclaw',
    { cwd: repoRoot, encoding: 'utf8', stdio: 'pipe' },
  );
  assert.equal(result.trim(), '', `Guard paths detected in diff: ${result}`);
});

test('R5.2 — no guard path files exist in the checkout', () => {
  for (const path of [
    'AGENTS.md',
    'SOUL.md',
    'USER.md',
    'TOOLS.md',
    'HEARTBEAT.md',
    'IDENTITY.md',
  ]) {
    const fullPath = join(repoRoot, path);
    assert.ok(
      !existsSync(fullPath),
      `Guard path ${path} exists at ${fullPath}`,
    );
  }
});
