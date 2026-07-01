import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const docPath = join(repoRoot, 'docs', 'validation', 'team1-source-dryrun-orchestrator-libero.md');

async function doc() {
  return readFile(docPath, 'utf8');
}

test('Team1 source-public dry-run orchestrator matrix covers the current run lanes', async () => {
  const content = await doc();

  assert.match(content, /a2a-source-dryrun-orchestrator-20260510T133022Z/);
  assert.match(content, /a2a-plane#197/);
  assert.match(content, /a2a-plane#198/);
  assert.match(content, /a2a-plane#199/);
  assert.match(content, /openclaw-plugin-a2a#256/);
  assert.match(content, /a2a-docker-runner#177/);
  assert.match(content, /a2a-broker#479/);
  assert.match(content, /a2a-docker-runner#178/);
  assert.match(content, /a2a-plane#200/);
});

test('Team1 source-public dry-run orchestrator matrix preserves no-live and fail-closed posture', async () => {
  const content = await doc();

  assert.match(content, /dry-run\/evidence tooling only/);
  assert.match(content, /source-public execution remains NO-GO \/ Waiting/);
  assert.match(content, /Start-only evidence is insufficient for aggregate source-public readiness/);
  assert.match(content, /Source-public execution remains NO-GO/);
  assert.match(content, /No dry-run result, test pass, scanner output, Start marker, PR, Done, or Block comment is approval/);
  assert.doesNotMatch(content, /source-public execution GO|Final GO|visibility change was performed|terminal ACK evidence from provider|live Telegram send completed/i);
});

test('Team1 source-public dry-run orchestrator matrix keeps approval separation explicit', async () => {
  const content = await doc();

  assert.match(content, /Operator approval must be explicit and separate/);
  assert.match(content, /Start, PR, Done, Block, test, scanner, and provider-id evidence are not approval/);
  assert.match(content, /terminal-outbox ACK/);
  assert.match(content, /community posts/);
  assert.match(content, /Future closeout must keep approval evidence distinct from dry-run success/);
});

test('Team1 source-public dry-run orchestrator matrix excludes private material and runtime context', async () => {
  const content = await doc();

  assert.match(content, /does not include raw lane transcripts, credentials, provider targets, or private source snippets/);
  assert.match(content, /Fail closed if runtime\/bootstrap context or private-source material enters branch diffs, PR text, issue comments, or artifacts/);
  assert.doesNotMatch(content, /ghp_|github_pat_|BROKER_EDGE_SECRET|Authorization:\s*Bearer|chat_id|OPENCLAW_CACHE_BOUNDARY|Session ID:/i);
});
