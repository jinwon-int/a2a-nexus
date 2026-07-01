import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const docPath = join(repoRoot, 'docs', 'validation', 'team1-source-public-approval-rehearsal-libero.md');

async function doc() {
  return readFile(docPath, 'utf8');
}

test('Team1 source-public approval rehearsal libero matrix covers current run lanes and outputs', async () => {
  const content = await doc();

  assert.match(content, /a2a-source-public-approval-rehearsal-20260511T014240Z/);
  assert.match(content, /a2a-plane#211/);
  assert.match(content, /a2a-plane#212/);
  assert.match(content, /Reviewed at:/);
  assert.match(content, /GO_CANDIDATE/);
  assert.match(content, /NEEDS_OPERATOR_APPROVAL/);
});

test('Team1 source-public approval rehearsal libero matrix covers approval rehearsal gates', async () => {
  const content = await doc();

  assert.match(content, /approvalPacketIntegrity/);
  assert.match(content, /rehearsalIdempotencyProof/);
  assert.match(content, /rollbackAbortPath/);
  assert.match(content, /Broker\/plugin\/runner packets/);
  assert.match(content, /Scanner\/history evidence/);
  assert.match(content, /Source visibility boundary/);
  assert.match(content, /Terminal\/replay\/readiness gates/);
  assert.match(content, /Exact operator approvals/);
  assert.match(content, /Runtime\/bootstrap hygiene/);
});

test('Team1 source-public approval rehearsal libero matrix preserves fail-closed and non-ACK posture', async () => {
  const content = await doc();

  assert.match(content, /source-public execution is still NO_GO/);
  assert.match(content, /source-public execution remains NO_GO/i);
  assert.match(content, /NO_GO for execution/);
  assert.match(content, /Provider message ID\/send success is not terminal ACK evidence; it is accepted-send evidence only/);
  assert.match(content, /no approval, release, or visibility change is executed/);
  assert.doesNotMatch(content, /public-readiness GO|Final GO|visibility change was performed|terminal ACK evidence from provider|raw session dump publication as evidence/i);
});

test('Team1 source-public approval rehearsal libero matrix documents rollback/abort path', async () => {
  const content = await doc();

  assert.match(content, /Rollback:.*Delete the approval rehearsal/);
  assert.match(content, /Abort:.*Halt all approval-rehearsal processing/);
  assert.match(content, /no-live/);
  assert.match(content, /No partial state/);
});

test('Team1 source-public approval rehearsal libero matrix keeps private source and runtime context out of evidence', async () => {
  const content = await doc();

  assert.match(content, /\.gitignore.*excludes/);
  assert.match(content, /Branch diff, PR text, issue comments, and artifacts must exclude runtime\/bootstrap context files/);
  assert.match(content, /AGENTS\.md/);
  assert.match(content, /\.openclaw/);
  assert.doesNotMatch(content, /ghp_|github_pat_|BROKER_EDGE_SECRET|Authorization:\s*Bearer|chat_id|OPENCLAW_CACHE_BOUNDARY/i);
});
