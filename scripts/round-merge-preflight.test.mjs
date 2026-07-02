import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const scriptPath = join(repoRoot, 'scripts', 'round-merge-preflight.mjs');

test('round merge preflight help documents local-only safety boundary', () => {
  const result = spawnSync(process.execPath, [scriptPath, '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /temporary local-only git worktree/i);
  assert.match(result.stdout, /never pushes/i);
  assert.match(result.stdout, /never changes main/i);
  assert.match(result.stdout, /deploys/i);
  assert.match(result.stdout, /terminal ACK/i);
});

test('round merge preflight refuses to run without PR numbers', () => {
  const result = spawnSync(process.execPath, [scriptPath], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Usage: npm run round:merge-preflight/);
});

test('Team1/workerDelta PR #253 closeout records package conflict and safe resolution', async () => {
  const artifact = await readFile(
    join(repoRoot, 'docs', 'validation', 'team1-workerDelta-pr253-closeout-libero.md'),
    'utf8',
  );

  assert.match(artifact, /a2a-plane#249/);
  assert.match(artifact, /a2a-plane#251/);
  assert.match(artifact, /a2a-plane#253/);
  assert.match(artifact, /a2a-plane#254/);
  assert.match(artifact, /CONFLICT \(content\): Merge conflict in package\.json/);
  assert.match(artifact, /253 254/);
  assert.match(artifact, /254 253/);
  assert.match(artifact, /scripts\/archive\/check-team1-config-schema-skew-libero\.test\.mjs/);
  assert.match(artifact, /scripts\/archive\/check-team2-config-schema-parity-libero\.test\.mjs/);
  assert.match(artifact, /NO-GO \/ Waiting/);
  assert.match(artifact, /AGENTS\.md/);
  assert.match(artifact, /\.openclaw\/\*\*/);
  assert.doesNotMatch(artifact, /Decision: `GO`|restart approved|deploy completed|terminal ACK complete/i);
});

test('release checklist requires merge-train preflight for multi-PR rounds', async () => {
  const checklist = await readFile(join(repoRoot, 'docs', 'release-checklist.md'), 'utf8');
  assert.match(checklist, /round:merge-preflight/);
  assert.match(checklist, /multi-PR/i);
});

test('Team2 plane/plugin merge-preflight artifact records the #249 blocker', async () => {
  const artifact = await readFile(
    join(repoRoot, 'docs', 'validation', 'team2-plane-plugin-merge-preflight-libero.md'),
    'utf8',
  );

  assert.match(artifact, /a2a-plane#249/);
  assert.match(artifact, /255 254 253/);
  assert.match(artifact, /255 253 254/);
  assert.match(artifact, /NO-GO \/ Blocked/);
  assert.match(artifact, /package\.json/);
  assert.match(artifact, /openclaw-plugin-a2a/);
  assert.match(artifact, /AGENTS\.md/);
  assert.match(artifact, /\.openclaw\/\*\*/);
});
