import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const docPath = join(repoRoot, 'docs', 'validation', 'team2-final-go-no-go-semantics-libero.md');

async function doc() {
  return readFile(docPath, 'utf8');
}

test('Team2 final GO/NO-GO semantics cross-check covers the final round lanes', async () => {
  const content = await doc();

  assert.match(content, /a2a-source-public-go-nogo-gate-20260511T052500Z/);
  assert.match(content, /a2a-plane#225/);
  assert.match(content, /a2a-plane#228/);
  for (const issue of [
    'a2a-plane#226',
    'openclaw-plugin-a2a#265',
    'a2a-docker-runner#195',
    'a2a-plane#227',
    'a2a-broker#488',
    'a2a-docker-runner#196',
  ]) {
    assert.match(content, new RegExp(issue.replace('#', '#')));
  }
});

test('Team2 final GO/NO-GO semantics fail closed on non-terminal evidence', async () => {
  const content = await doc();

  assert.match(content, /Final decision: `NO-GO \/ Waiting`/);
  assert.match(content, /Start evidence/);
  assert.match(content, /Start-only evidence is unresolved/);
  assert.match(content, /A PR marker is not enough by itself/);
  assert.match(content, /aggregate remains `NO-GO \/ Waiting`/);
  assert.doesNotMatch(content, /Final decision: `GO`|aggregate remains `GO`|source-public execution remains \*\*`GO`/i);
});

test('Team2 final GO/NO-GO semantics keep operator approval separate from execution', async () => {
  const content = await doc();

  assert.match(content, /Source-public execution remains \*\*`NO_GO`\*\*/);
  assert.match(content, /Operator approval is separate from technical readiness/);
  assert.match(content, /technical `GO_CANDIDATE`/);
  assert.match(content, /must still be read as review-ready only/);
  assert.match(content, /none of them are approval execution/);
  assert.doesNotMatch(content, /approval executed|release published|visibility change performed|live provider send completed|terminal ACK completed/i);
});

test('Team2 final GO/NO-GO semantics preserve Terminal Brief ACK and no-live boundaries', async () => {
  const content = await doc();

  for (const phrase of [
    'does not execute approval',
    'repository visibility change',
    'live provider or Telegram send',
    'Terminal Brief ACK',
    'production deploy/restart',
    'database mutation',
    'force-push',
    'automatic merge',
    'Provider accepted-send',
    'non-ACK evidence only',
  ]) {
    assert.match(content, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('Team2 final GO/NO-GO semantics documents runtime/bootstrap fail-closed hygiene', async () => {
  const content = await doc();

  for (const denyPath of ['AGENTS.md', 'SOUL.md', 'USER.md', 'TOOLS.md', 'HEARTBEAT.md', 'IDENTITY.md', '.openclaw/**']) {
    assert.match(content, new RegExp(denyPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(content, /report the exact repo-relative offending paths and block/);
  assert.match(content, /redacted scanner\/history evidence/);
  assert.doesNotMatch(content, /raw session dump|host-private path disclosure|provider target disclosure/i);
});
