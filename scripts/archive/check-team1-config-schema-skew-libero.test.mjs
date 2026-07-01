import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const docPath = join(repoRoot, 'docs', 'validation', 'team1-config-schema-skew-libero.md');

async function doc() {
  return readFile(docPath, 'utf8');
}

test('Team1 config/schema skew libero matrix covers parent incident and lane', async () => {
  const content = await doc();

  assert.match(content, /a2a-config-schema-skew-prevention-20260511T120400Z/);
  assert.match(content, /a2a-plane#249/);
  assert.match(content, /a2a-plane#251/);
  assert.match(content, /operatorEvents\.crossBrokers/);
  assert.match(content, /openclaw\.json/);
  assert.match(content, /openclaw\.plugin\.json/);
  assert.match(content, /must NOT have additional properties/);
});

test('Team1 config/schema skew libero matrix preserves fail-closed GO/NO-GO semantics', async () => {
  const content = await doc();

  assert.match(content, /Decision: `NO-GO \/ Waiting`/);
  assert.match(content, /A Start marker or an unmerged PR is not sufficient restart evidence/);
  assert.match(content, /If any required artifact is missing, stale, redacted beyond verification, or shows a schema\/config mismatch, the safe result is `NO-GO`/);
  assert.doesNotMatch(content, /Decision: `GO`|aggregate GO is safe|restart approved/i);
});

test('Team1 config/schema skew libero matrix requires pre-restart schema parity and status checks', async () => {
  const content = await doc();

  for (const phrase of [
    'Changed key inventory',
    'Manifest parity',
    'Backward compatibility',
    'Pre-restart health',
    'Restart authorization',
    'Rollback readiness',
    'schema parity validator',
    'openclaw status',
    'unknown keys still fail closed',
  ]) {
    assert.match(content, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('Team1 config/schema skew libero matrix documents evidence and recurrence prevention requirements', async () => {
  const content = await doc();

  for (const phrase of [
    'Evidence requirements for config changes',
    'Redacted key inventory and schema-path mapping',
    'Validator command, version/ref, input artifact digests',
    'Compatibility result proving old deployed config is accepted or safely migrated',
    'Rollback/abort instructions',
    'Recurrence prevention verification',
    'CI test that fails when a config fixture includes a key missing from plugin `configSchema`',
    'negative fixture proving unknown properties still fail closed',
  ]) {
    assert.match(content, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('Team1 config/schema skew libero matrix preserves no-live and runtime hygiene boundaries', async () => {
  const content = await doc();

  for (const phrase of [
    'does not deploy code',
    'restart Gateway/broker/worker services',
    'live provider or Telegram messages',
    'ACK terminal-outbox rows',
    'mutate production data',
    'source-public execution',
    'operator approval',
  ]) {
    assert.match(content, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }

  for (const denyPath of ['AGENTS.md', 'SOUL.md', 'USER.md', 'TOOLS.md', 'HEARTBEAT.md', 'IDENTITY.md', '.openclaw/**']) {
    assert.match(content, new RegExp(denyPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(content, /listing exact repo-relative offending paths/);
  assert.doesNotMatch(content, /ghp_|github_pat_|Authorization:\s*Bearer|OPENCLAW_CACHE_BOUNDARY|Session ID:|chat_id\s*[:=]|host-private path disclosure/i);
});
