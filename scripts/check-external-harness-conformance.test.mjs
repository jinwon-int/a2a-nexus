/**
 * Tests for external harness conformance docs and fixture.
 *
 * Safety: read-only tests. No live broker, provider send, deploy, restart,
 * terminal ACK, or database access.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

test('external harness quickstart doc exists', () => {
  assert.ok(existsSync(join(repoRoot, 'docs', 'external-harness-quickstart.md')));
});

test('external harness no-live fixture exists', () => {
  assert.ok(existsSync(join(repoRoot, 'fixtures', 'external-harness', 'no-live-conformance.json')));
});

test('external harness quickstart documents no-live boundaries and stays harness-agnostic', async () => {
  const content = await readFile(join(repoRoot, 'docs', 'external-harness-quickstart.md'), 'utf8');

  assert.match(content, /External Harness Quickstart/i);
  // Harness-agnostic by naming several, not by defining them against OpenClaw.
  assert.match(content, /any agent harness/i);
  assert.ok(['Claude Code', 'Codex', 'Hermes', 'piri'].filter((n) => content.includes(n)).length >= 3);
  assert.match(content, /not a required dependency/i);
  assert.match(content, /no-live/i);
  assert.match(content, /Do not use this path with production brokers/i);
  assert.match(content, /check:external-harness-conformance/);
});

test('external harness quickstart preserves Terminal Brief receipt safety', async () => {
  const content = await readFile(join(repoRoot, 'docs', 'external-harness-quickstart.md'), 'utf8');

  assert.match(content, /current_session_visible/);
  assert.match(content, /manual_operator_receipt/);
  assert.match(content, /Provider accepted.*not.*terminal ACK/is);
  assert.match(content, /terminal-outbox rows/);
});

test('external harness quickstart frames final count as closeout input only', async () => {
  const content = await readFile(join(repoRoot, 'docs', 'external-harness-quickstart.md'), 'utf8');

  assert.match(content, /final count such as/);
  assert.match(content, /\(N\/N\)/);
  assert.match(content, /not an irreversible action by itself/);
  assert.match(content, /a2a-broker#689/);
  assert.match(content, /a2a-broker#690/);
});

test('external harness fixture is no-live and OpenClaw-agnostic', async () => {
  const fixture = JSON.parse(await readFile(join(repoRoot, 'fixtures', 'external-harness', 'no-live-conformance.json'), 'utf8'));

  assert.equal(fixture.schema, 'a2a.externalHarness.noLiveConformance.v1');
  assert.equal(fixture.mode, 'no-live');
  assert.equal(fixture.harness.usesOpenClawCli, false);
  assert.equal(fixture.broker.baseUrl, 'http://127.0.0.1:8787');
  assert.equal(fixture.broker.production, false);
  assert.equal(fixture.worker.id, fixture.task.assignedWorkerId);
  assert.equal(fixture.task.payload.noLive, true);
  assert.equal(fixture.task.payload.replaySafe, true);
});

test('external harness fixture preserves non-ACK receipt boundary', async () => {
  const fixture = JSON.parse(await readFile(join(repoRoot, 'fixtures', 'external-harness', 'no-live-conformance.json'), 'utf8'));

  assert.deepEqual(fixture.terminalBrief.ackEligibleConfirmationSources, [
    'current_session_visible',
    'manual_operator_receipt',
  ]);
  assert.ok(fixture.terminalBrief.nonAckEvidence.includes('provider_accepted'));
  assert.ok(fixture.terminalBrief.nonAckEvidence.includes('provider_sent'));
  assert.ok(fixture.terminalBrief.nonAckEvidence.includes('queue_accepted'));
  assert.ok(fixture.terminalBrief.nonAckEvidence.includes('spool_produced'));
});

test('external harness fixture keeps final count non-irreversible', async () => {
  const fixture = JSON.parse(await readFile(join(repoRoot, 'fixtures', 'external-harness', 'no-live-conformance.json'), 'utf8'));

  assert.equal(fixture.terminalBrief.finalCountExample.label, '(3/3)');
  assert.match(fixture.terminalBrief.finalCountExample.meaning, /not automatic irreversible action/);
});
