import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const docPath = join(repoRoot, 'docs', 'specs', 'a2a-team1-dispatch-wrapper', 'runbook.md');

async function doc() {
  return readFile(docPath, 'utf8');
}

test('Dispatch-wrapper runbook covers round spec shape', async () => {
  const content = await doc();

  assert.match(content, /round spec shape/i);
  assert.match(content, /parentRound(Id|Title|Total|Order)/i);
  assert.match(content, /"order":\s*\d/);
  assert.match(content, /"worker":/);
  assert.match(content, /"repo":/);
  assert.match(content, /"role":/);
});

test('Dispatch-wrapper runbook covers required parentRound metadata', async () => {
  const content = await doc();

  assert.match(content, /parentRoundId/);
  assert.match(content, /parentRoundTotal/);
  assert.match(content, /parentRoundOrder/);
  assert.match(content, /parentRoundProgress/);
  assert.match(content, /originBrokerId/);
  assert.match(content, /brokerOfRecordId/);
  assert.match(content, /parentBrokerId/);
  assert.match(content, /Fail-closed/);
});

test('Dispatch-wrapper runbook covers default dry-run behavior', async () => {
  const content = await doc();

  assert.match(content, /dry.run/i);
  assert.match(content, /default mode/i);
  assert.match(content, /`--dry-run`/);
  assert.match(content, /explicit.*--execute/);
  // Text spans lines; use [\s\S] to match across newlines
  assert.match(content, /without[\s\S]*`--execute`[\s\S]*`--dry-run`[\s\S]*treated as/i);
});

test('Dispatch-wrapper runbook covers explicit execute mode', async () => {
  const content = await doc();

  assert.match(content, /--execute/);
  assert.match(content, /explicit/);
});

test('Dispatch-wrapper runbook covers approval boundaries', async () => {
  const content = await doc();

  assert.match(content, /approval boundar/i);
  assert.match(content, /policy context/i);
  assert.match(content, /source-only/);
  assert.match(content, /no.live.impact/i);
  assert.match(content, /override/i);
  assert.match(content, /operator approval/i);
  assert.match(content, /prohibited action/i);
});

test('Dispatch-wrapper runbook covers sanitized run record', async () => {
  const content = await doc();

  assert.match(content, /sanitized.*run.*record/i);
  assert.match(content, /runId/);
  assert.match(content, /executionMode/);
  assert.match(content, /idempotencyKey/);
  assert.match(content, /safetyConfirmation/);
  assert.match(content, /redaction rule/i);
  assert.match(content, /Secret values|no secret|secret.*values/i);
});

test('Dispatch-wrapper runbook covers idempotency expectations', async () => {
  const content = await doc();

  assert.match(content, /idempotenc/i);
  assert.match(content, /replay/);
  assert.match(content, /key/);
  assert.match(content, /409 Conflict/);
  assert.match(content, /duplicate/);
});

test('Dispatch-wrapper runbook covers worker-online preflight', async () => {
  const content = await doc();

  assert.match(content, /worker.online/i);
  assert.match(content, /preflight/i);
  assert.match(content, /doctor/);
  assert.match(content, /health/);
  assert.match(content, /bangtong/);
  assert.match(content, /sogyo/);
  assert.match(content, /nosuk/);
  assert.match(content, /yukson/);
});

test('Dispatch-wrapper runbook covers read-only follow-up check', async () => {
  const content = await doc();

  assert.match(content, /follow.up/i);
  assert.match(content, /read.only/i);
  assert.match(content, /interval/i);
  assert.match(content, /terminal state/i);
});

test('Dispatch-wrapper runbook covers finalizer closeout handoff', async () => {
  const content = await doc();

  assert.match(content, /finalizer/i);
  assert.match(content, /closeout/i);
  assert.match(content, /handoff/i);
  assert.match(content, /seoseo/);
  assert.match(content, /aggregate decision/i);
  assert.match(content, /go\/nogo/i);
});

test('Dispatch-wrapper runbook covers go/nogo matrix gates G1-G9', async () => {
  const content = await doc();

  for (let i = 1; i <= 9; i++) {
    assert.match(content, new RegExp(`G${i}[\\s—|]`), `Missing gate G${i}`);
  }
});

test('Dispatch-wrapper runbook preserves no-live and non-ACK posture', async () => {
  const content = await doc();

  assert.match(content, /no.live.impact/i);
  assert.match(content, /no.*production.*deploy/i);
  assert.match(content, /no.*provider.*send/i);
  assert.match(content, /no.*terminal.*ACK/i);
  assert.match(content, /no.*credential.*movement/i);
  assert.match(content, /approval separation/i);
  assert.match(content, /send.acceptance/i);
});

test('Dispatch-wrapper runbook keeps private source and runtime context out of evidence', async () => {
  const content = await doc();

  assert.match(content, /must never contain/);
  assert.match(content, /secret value/i);
  assert.match(content, /no.*secret/i);
  assert.doesNotMatch(content, /ghp_|github_pat_|BROKER_EDGE_SECRET|Authorization:\s*Bearer|chat_id|OPENCLAW_CACHE_BOUNDARY/i);
});

test('Dispatch-wrapper runbook references related documents', async () => {
  const content = await doc();

  assert.match(content, /Related document/i);
  assert.match(content, /parent-round closeout/i);
  assert.match(content, /broker handoff/i);
  assert.match(content, /task lifecycle/i);
  assert.match(content, /terminal semantics/i);
});
