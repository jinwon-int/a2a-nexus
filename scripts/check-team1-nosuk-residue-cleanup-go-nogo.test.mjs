import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const docPath = join(repoRoot, 'docs', 'validation', 'team1-nosuk-residue-cleanup-go-nogo.md');

async function doc() {
  return readFile(docPath, 'utf8');
}

test('Team1/nosuk residue cleanup matrix binds the required trackers', async () => {
  const content = await doc();

  for (const reference of [
    'a2a-plane#397',
    'a2a-broker#835',
    'a2a-broker#294',
    'a2a-broker#342',
    'a2a-broker#497',
    'a2a-broker#519',
    'a2a-plane#75',
  ]) {
    assert.match(content, new RegExp(reference.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('Team1/nosuk residue cleanup matrix covers residue cleanup GO/NO-GO gates', async () => {
  const content = await doc();

  for (const gate of [
    'G1. Residue scan contract (read-only)',
    'G2. Dry-run residue report',
    'G3. Backup and restore proof',
    'G4. Operator-approved action plan',
    'G5. Terminal-outbox ACK boundary',
    'G6. Historical outbox replay safety',
    'G7. Legacy residue quarantine expiry',
    'G8. Stale worker and backlog reporting',
    'G9. Rollback and abort plan',
    'G10. Runtime/bootstrap artifact hygiene',
  ]) {
    assert.match(content, new RegExp(gate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }

  for (const phrase of [
    'legacy residue',
    'current post-cutoff gap',
    'read-only scan',
    'dry-run',
    'operator approval',
    'separate operator',
    'provider-send-only evidence',
    'accepted-send evidence',
    'rollback',
    'quarantine',
  ]) {
    assert.match(content, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('Team1/nosuk residue cleanup matrix remains fail-closed for production mutation', async () => {
  const content = await doc();

  assert.match(content, /Decision: `NO-GO \/ Waiting`/);
  assert.match(content, /no cleanup action.*is authorized/);

  for (const prohibitedAction of [
    'production DB mutation',
    'prune',
    'migration',
    'deploy',
    'restart',
    'live provider send',
    'terminal ACK',
    'historical outbox replay',
    'secret change',
    'release',
    'force-push',
  ]) {
    assert.match(content, new RegExp(prohibitedAction.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }

  assert.doesNotMatch(content, /Decision: `GO`|cleanup is authorized|residue cleanup is approved/i);
});

test('Team1/nosuk residue cleanup matrix preserves terminal evidence and artifact hygiene boundaries', async () => {
  const content = await doc();

  for (const phrase of [
    'accepted-send is not terminal ACK/read/visibility proof',
    'accepted-send evidence',
    'never confused with terminal ACK/visibility',
    'raw session/runtime dump',
    'providerCalled=false',
    'productionAckAttempted=false',
  ]) {
    assert.match(content, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }

  for (const denyPath of ['AGENTS.md', 'SOUL.md', 'USER.md', 'TOOLS.md', 'HEARTBEAT.md', 'IDENTITY.md', '.openclaw/**']) {
    assert.match(content, new RegExp(denyPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }

  assert.doesNotMatch(content, /ghp_|github_pat_|Authorization:\s*Bearer|OPENCLAW_CACHE_BOUNDARY|Session ID:|chat_id\s*[:=]|\/root\//i);
});

test('Team1/nosuk residue cleanup matrix distinguishes legacy residue from current gaps', async () => {
  const content = await doc();

  assert.match(content, /Legacy residue|Current post-cutoff gap/);
  assert.match(content, /2026-05-04T07:10:00.000Z/);
  assert.match(content, /2026-05-11T07:10:00.000Z/);
  assert.match(content, /quarantined|quarantine/);
});
