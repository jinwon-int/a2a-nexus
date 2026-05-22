import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const docPath = join(repoRoot, 'docs', 'validation', 'team1-nosuk-terminal-brief-ownership-canary.md');

async function doc() {
  return readFile(docPath, 'utf8');
}

test('Team1/nosuk ownership canary doc references the required parent and child issues', async () => {
  const content = await doc();

  for (const reference of [
    'a2a-broker#863',
    'a2a-plane#413',
    'a2a-plane#409',
    'openclaw-plugin-a2a#445',
    'a2a-plane#414',
    'a2a-broker#864',
    'a2a-broker#865',
    'a2a-plane#415',
  ]) {
    assert.match(content, new RegExp(reference.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }

  assert.match(content, /terminal-brief-all-hands-20260521-863-l03-nosuk/);
  assert.match(content, /nosuk/);
  assert.match(content, /3\/7/);
});

test('Team1/nosuk ownership canary doc defines parent broker ownership gates', async () => {
  const content = await doc();

  for (const gate of [
    'P1. Seoseo is sole parent broker',
    'P2. Parent metadata in every child dispatch',
    'P3. Parent-only notification ownership',
    'P4. Parent projection stability',
    'P5. Provider accepted-send = non-ACK',
  ]) {
    assert.match(content, new RegExp(gate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('Team1/nosuk ownership canary doc defines Team2 child suppression gates', async () => {
  const content = await doc();

  for (const gate of [
    'S1. Gwakga suppresses local operator brief',
    'S2. Gwakga relays cross-broker projection correctly',
    'S3. No duplicate local child Terminal Brief',
    'S4. Team2 terminal evidence format',
    'S5. Order suppression by broker of record',
  ]) {
    assert.match(content, new RegExp(gate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('Team1/nosuk ownership canary doc defines combined acceptance matrix across all 7 lanes', async () => {
  const content = await doc();

  for (const gate of [
    'A1. Metadata propagation',
    'A2. Compact title format',
    'A3. Parent-only aggregate ownership',
    'A4. Receipt/ACK boundary',
    'A5. Symmetric routing',
    'A6. Replay/idempotency',
    'A7. Team2 suppression',
    'A8. Evidence hygiene',
    'A9. Runtime/bootstrap hygiene',
  ]) {
    assert.match(content, new RegExp(gate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('Team1/nosuk ownership canary doc includes the 7-child title proof table with suppression rules', async () => {
  const content = await doc();

  for (const worker of ['bangtong', 'sogyo', 'nosuk', 'yukson', 'dungae', 'jingun', 'soonwook']) {
    assert.match(content, new RegExp(worker));
  }

  // Team2 rows must mention suppression
  assert.match(content, /suppressed/);
  assert.match(content, /Gwakga relays projection only/);

  // All rows use (n/7) format
  assert.match(content, /1\/7/);
  assert.match(content, /7\/7/);
});

test('Team1/nosuk ownership canary doc preserves terminal evidence and artifact hygiene boundaries', async () => {
  const content = await doc();

  for (const phrase of [
    'not receipt, ACK, or approval',
    'provider accepted-send',
    'Not proof of: provider delivery, operator receipt, approval, or terminal-outbox ACK',
    'liveProviderSend=false',
    'terminalOutboxAckMutated=false',
  ]) {
    assert.match(content, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }

  for (const denyPath of ['AGENTS.md', 'SOUL.md', 'USER.md', 'TOOLS.md', 'HEARTBEAT.md', 'IDENTITY.md', '.openclaw/**']) {
    assert.match(content, new RegExp(denyPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }

  assert.doesNotMatch(content, /ghp_|github_pat_|Authorization:\s*Bearer|OPENCLAW_CACHE_BOUNDARY|Session ID:|chat_id\s*[:=]|\/root\//i);
});

test('Team1/nosuk ownership canary doc remains fail-closed for live activation', async () => {
  const content = await doc();

  assert.match(content, /NO-GO \/ Waiting/);
  assert.match(content, /GO_CANDIDATE/);

  for (const prohibitedAction of [
    'deploy',
    'restart',
    'live provider',
    'terminal-outbox ACK',
    'historical outbox replay',
    'secret',
    'release',
    'force-push',
    'approval without fresh explicit operator approval',
  ]) {
    assert.match(content, new RegExp(prohibitedAction.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
  }

  assert.doesNotMatch(content, /this lane claims aggregate activation GO|live canary has been authorized by this lane|deploy\/reload approval has been granted/);
});

test('Team1/nosuk ownership canary doc suppresses 1/1 and 1/2 local brief patterns', async () => {
  const content = await doc();

  // Must explicitly mention that Team2 must not use 1/1 or 1/2
  assert.match(content, /1\/1|1\/2/);
  assert.match(content, /not produce a local operator-facing Terminal Brief with a 1\/1 or 1\/2 count/);
  assert.match(content, /Gwakga must not emit a local `1\/1` or `1\/2` brief/);
});

test('Team1/nosuk ownership canary doc sibling lane matrix is complete', async () => {
  const content = await doc();

  for (const phrase of [
    'Lane | Worker',
    '1 | bangtong',
    '2 | sogyo',
    '3 | nosuk',
    '4 | yukson',
    '5 | dungae',
    '6 | jingun',
    '7 | soonwook',
    'Required suppression rule',
  ]) {
    assert.match(content, new RegExp(phrase.replace(/[|*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
  }
});

test('Team1/nosuk ownership canary doc includes a safety confirmation section', async () => {
  const content = await doc();

  for (const phrase of [
    'Did not deploy or restart',
    'Did not mutate production databases',
    'Did not send any live provider',
    'Did not perform manual Terminal Brief ACK/replay',
    'Did not change secrets',
    'Did not rewrite history',
    'Did not execute approval',
    'Provider accepted/message-id evidence is provider-accepted evidence only',
    'Confirmed runtime/bootstrap hygiene',
  ]) {
    assert.match(content, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});
