import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const docPath = join(repoRoot, 'docs', 'validation', 'team1-source-public-execution-orchestrator-libero.md');

async function doc() {
  return readFile(docPath, 'utf8');
}

test('Team1 source-public execution orchestrator matrix covers the current run lanes', async () => {
  const content = await doc();

  assert.match(content, /a2a-source-public-execution-orchestrator-20260511T023207Z/);
  assert.match(content, /a2a-plane#218/);
  assert.match(content, /a2a-plane#219/);
  assert.match(content, /a2a-plane#212/);
});

test('Team1 source-public execution orchestrator matrix validates execution plan structure', async () => {
  const content = await doc();

  assert.match(content, /Execution plan integrity/);
  assert.match(content, /executionMode, actionManifest, scannerBinding, rollbackRunbook, abortRunbook, idempotencyKey/);
  assert.match(content, /Action manifest determinism/);
  assert.match(content, /Scanner\/history binding/);
  assert.match(content, /Rollback\/abort runbook/);
  assert.match(content, /Idempotency\/replay protection/);
  assert.match(content, /Preflight failure semantics/);
  assert.match(content, /Operator execution gate/);
  assert.match(content, /Cross-broker handoff/);
});

test('Team1 source-public execution orchestrator matrix preserves no-live and dry-run lock', async () => {
  const content = await doc();

  assert.match(content, /Execution mode is correctly locked/);
  assert.match(content, /source-public execution remains no-go/i);
  assert.match(content, /execution mode locked to dry-run\/simulate/);
  assert.match(content, /Source-public execution remains NO-GO \/ Waiting/);
  assert.doesNotMatch(content, /source-public execution GO|Final GO|visibility change was performed|live Telegram send completed|terminal ACK evidence from provider/i);
});

test('Team1 source-public execution orchestrator matrix keeps operator approval separate', async () => {
  const content = await doc();

  assert.match(content, /Operator execution gate/);
  assert.match(content, /operatorExecutionGate is separate from operatorApproval/);
  assert.match(content, /Start, PR, Done, Block, test, scanner, and provider-id evidence are not approval/);
  assert.match(content, /not bundled with deploys\/restarts\/DB mutations\/provider sends\/terminal ACKs/);
});

test('Team1 source-public execution orchestrator matrix validates rollback and abort paths', async () => {
  const content = await doc();

  assert.match(content, /4-step rollback runbook/);
  assert.match(content, /6 failure-mode abort runbook/);
  assert.match(content, /Neither references deploy, restart, provider send, DB mutation, or ACK/);
});

test('Team1 source-public execution orchestrator matrix excludes private material and runtime context', async () => {
  const content = await doc();

  assert.match(content, /does not include raw lane transcripts, credentials, provider targets, or private source snippets/);
  assert.match(content, /Fail closed if runtime\/bootstrap paths enter the branch or artifact evidence/);
  assert.doesNotMatch(content, /ghp_|github_pat_|BROKER_EDGE_SECRET|Authorization:\s*Bearer|chat_id|OPENCLAW_CACHE_BOUNDARY|Session ID:/i);
});
