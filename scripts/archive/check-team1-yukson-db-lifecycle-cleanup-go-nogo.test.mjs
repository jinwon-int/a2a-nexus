import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const docPath = join(repoRoot, 'docs', 'validation', 'team1-yukson-db-lifecycle-cleanup-go-nogo.md');

async function doc() {
  return readFile(docPath, 'utf8');
}

test('Team1/yukson DB lifecycle cleanup matrix binds the required trackers', async () => {
  const content = await doc();

  for (const reference of [
    'a2a-plane#265',
    'a2a-broker#519',
    'a2a-broker#497',
    'a2a-broker#294',
    'a2a-plane#75',
  ]) {
    assert.match(content, new RegExp(reference.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('Team1/yukson DB lifecycle cleanup matrix covers lifecycle GO/NO-GO gates', async () => {
  const content = await doc();

  for (const gate of [
    'G1. Cleanup API contract',
    'G2. Safe-prune dry-run evidence',
    'G3. Backup and restore proof',
    'G4. Deploy and canary evidence',
    'G5. Queue/outbox safety',
    'G6. Rollback and abort plan',
    'G7. Approval boundary',
    'G8. Runtime/bootstrap artifact hygiene',
  ]) {
    assert.match(content, new RegExp(gate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }

  for (const phrase of [
    'target tables/entities',
    'idempotency keys',
    'Redacted dry-run output',
    'A fresh backup exists',
    'pre/post `/health`',
    'heap/RSS',
    'Abort must win',
    'separate operator approval',
  ]) {
    assert.match(content, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('Team1/yukson DB lifecycle cleanup matrix remains fail-closed for production mutation', async () => {
  const content = await doc();

  assert.match(content, /Decision: `NO-GO \/ Waiting`/);
  assert.match(content, /production cleanup remains `NO-GO \/ Waiting`/);
  assert.match(content, /Real broker cleanup remains blocked until every GO gate below has linked evidence and a separate operator approval/);

  for (const prohibitedAction of [
    'production DB mutation',
    'prune',
    'migration',
    'deploy',
    'restart',
    'live provider send',
    'terminal ACK',
    'secret change',
    'release',
    'force-push',
  ]) {
    assert.match(content, new RegExp(prohibitedAction.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }

  assert.doesNotMatch(content, /Decision: `GO`|cleanup is authorized|production cleanup is approved/i);
});

test('Team1/yukson DB lifecycle cleanup matrix preserves terminal evidence and artifact hygiene boundaries', async () => {
  const content = await doc();

  for (const phrase of [
    'provider accepted-send evidence as terminal ACK/read/visibility',
    'accepted-send labeled non-ACK',
    'never forges ACK from accepted-send evidence',
    'raw session/runtime dump',
  ]) {
    assert.match(content, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }

  for (const denyPath of ['AGENTS.md', 'SOUL.md', 'USER.md', 'TOOLS.md', 'HEARTBEAT.md', 'IDENTITY.md', '.openclaw/**']) {
    assert.match(content, new RegExp(denyPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }

  assert.doesNotMatch(content, /ghp_|github_pat_|Authorization:\s*Bearer|OPENCLAW_CACHE_BOUNDARY|Session ID:|chat_id\s*[:=]|\/root\//i);
});
