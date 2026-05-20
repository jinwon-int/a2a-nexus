import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const docPath = join(repoRoot, 'docs', 'validation', 'team1-source-parent-round-dispatch-guardrails-libero.md');

async function doc() {
  return readFile(docPath, 'utf8');
}

test('Team1 source-only parent-round dispatch guardrails doc covers round metadata', async () => {
  const content = await doc();

  assert.match(content, /a2a-team1-post-bangtong-readiness-20260520T110014Z/);
  assert.match(content, /parentRoundId=/);
  assert.match(content, /parentRoundTotal=4/);
  assert.match(content, /parentRoundOrder=4/);
  assert.match(content, /parentRoundProgress=0/);
  assert.match(content, /originBrokerId=seoseo/);
  assert.match(content, /brokerOfRecordId=seoseo/);
  assert.match(content, /team1/);
});

test('Team1 source-only parent-round dispatch guardrails doc covers all 12 guards', async () => {
  const content = await doc();

  // Each guardrail G1 through G12 must be present
  for (let i = 1; i <= 12; i++) {
    assert.match(content, new RegExp(`G${i}[\\s—]`), `Missing guardrail G${i}`);
  }
});

test('Team1 source-only parent-round dispatch guardrails doc covers fail-closed criteria', async () => {
  const content = await doc();

  assert.match(content, /[Ff]ail.closed/);
  assert.match(content, /Block evidence/);
  assert.match(content, /rejected/);
  assert.match(content, /Guardrail state at this snapshot/);
});

test('Team1 source-only parent-round dispatch guardrails doc covers guardrail ownership key', async () => {
  const content = await doc();

  assert.match(content, /✓/);
  assert.match(content, /✗/);
  assert.match(content, /contract-level/);
  assert.match(content, /runtime.*enforcement/);
  assert.match(content, /a2a-broker#598/);
  assert.match(content, /a2a-broker#608/);
  assert.match(content, /a2a-broker#829/);
});

test('Team1 source-only parent-round dispatch guardrails doc preserves no-live and non-ACK posture', async () => {
  const content = await doc();

  assert.match(content, /source-only/);
  assert.match(content, /no.live/);
  assert.match(content, /no.*provider.*send/);
  assert.match(content, /no production deploy/);
  assert.match(content, /no.*terminal.*ACK/);
  assert.match(content, /no.*credential/);
  assert.match(content, /Approval separation/);
  assert.doesNotMatch(content, /public-readiness GO|Final GO|visibility change was performed|terminal ACK evidence from provider|raw session dump publication as evidence/i);
});

test('Team1 source-only parent-round dispatch guardrails doc keeps private source and runtime context out of evidence', async () => {
  const content = await doc();

  assert.match(content, /must not copy private source material/);
  assert.match(content, /Branch diff, PR text, issue comments, and artifacts must exclude.*runtime.*bootstrap context/);
  assert.match(content, /Fail closed; do not create PR/);
  assert.doesNotMatch(content, /ghp_|github_pat_|BROKER_EDGE_SECRET|Authorization:\s*Bearer|chat_id|OPENCLAW_CACHE_BOUNDARY/i);
});

test('Team1 source-only parent-round dispatch guardrails doc references sibling prior artifacts', async () => {
  const content = await doc();

  // Must reference the prior Team1 source-only artifacts
  assert.match(content, /team1-source-public-readiness-libero/);
  assert.match(content, /team1-source-public-approval-packet-libero/);
  assert.match(content, /team1-source-dryrun-orchestrator-libero/);
  assert.match(content, /team1-source-public-approval-rehearsal-libero/);
  assert.match(content, /team1-source-public-execution-orchestrator-libero/);
});

test('Team1 source-only parent-round dispatch guardrails doc references key contracts', async () => {
  const content = await doc();

  assert.match(content, /parent-terminal-brief-aggregation.md/);
  assert.match(content, /broker-handoff-protocol.md/);
  assert.match(content, /canonical-progress-validation-matrix.md/);
  assert.match(content, /github-dispatch-payload.md/);
});

test('Team1 source-only parent-round dispatch guardrails doc covers merge and closeout order', async () => {
  const content = await doc();

  assert.match(content, /Merge and closeout order/);
  assert.match(content, /round:merge-preflight/);
  assert.match(content, /NO-GO \/ Waiting/);
  assert.match(content, /Safety confirmation/);
});
