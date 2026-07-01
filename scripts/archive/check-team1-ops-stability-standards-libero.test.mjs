import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const docPath = join(repoRoot, 'docs', 'validation', 'team1-ops-stability-standards-libero.md');

async function doc() {
  return readFile(docPath, 'utf8');
}

test('Team1 operations stability libero validation covers current run lanes', async () => {
  const content = await doc();

  assert.match(content, /a2a-ops-stability-and-standards-20260511T063530Z/);
  assert.match(content, /a2a-plane#232/);
  assert.match(content, /a2a-plane#235/);
  for (const issue of [
    'a2a-plane#233',
    'openclaw-plugin-a2a#267',
    'a2a-docker-runner#199',
    'a2a-broker#491',
    'a2a-docker-runner#200',
    'a2a-plane#234',
  ]) {
    assert.match(content, new RegExp(issue.replace('#', '#')));
  }
});

test('Team1 operations stability libero validation fails closed on non-terminal evidence', async () => {
  const content = await doc();

  assert.match(content, /Decision: `NO-GO \/ Waiting`/);
  assert.match(content, /Start-only or preflight-only/);
  assert.match(content, /PR, Done, or Block evidence/);
  assert.match(content, /baseline evidence cannot substitute for current lane closeout/i);
  assert.doesNotMatch(content, /Decision: `GO`|aggregate remains `GO`|source-public execution remains \*\*`GO`|is approval-ready|is release-ready|is standards-complete/i);
});

test('Team1 operations stability libero validation covers required matrix checks', async () => {
  const content = await doc();

  for (const phrase of [
    'Checkpoint/trace policy',
    'Inspector gate',
    'False-failure fix',
    'Broker semantics and agent-card',
    'Worker visibility',
    'Team2 parity',
    'Runtime/bootstrap hygiene',
    'Redacted evidence policy',
  ]) {
    assert.match(content, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }

  assert.match(content, /accepted-send\/non-ACK wording/);
  assert.match(content, /without exposing secrets or private host paths/);
});

test('Team1 operations stability libero validation excludes runtime context and raw private evidence', async () => {
  const content = await doc();

  for (const denyPath of ['AGENTS.md', 'SOUL.md', 'USER.md', 'TOOLS.md', 'HEARTBEAT.md', 'IDENTITY.md', '.openclaw/**']) {
    assert.match(content, new RegExp(denyPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(content, /fail closed before PR creation if any deny path enters branch or artifact evidence/);
  assert.match(content, /avoid secrets, tokens, host-private paths, raw session dumps, provider targets, chat IDs/);
  assert.doesNotMatch(content, /ghp_|github_pat_|Authorization:\s*Bearer|OPENCLAW_CACHE_BOUNDARY|Session ID:|chat_id\s*[:=]|\/root\//i);
});
