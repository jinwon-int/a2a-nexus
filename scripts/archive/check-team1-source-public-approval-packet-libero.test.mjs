import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const docPath = join(repoRoot, 'docs', 'validation', 'team1-source-public-approval-packet-libero.md');

async function doc() {
  return readFile(docPath, 'utf8');
}

test('Team1 source-public approval packet matrix covers current run lanes and outputs', async () => {
  const content = await doc();

  assert.match(content, /a2a-source-release-gate-20260510T113438Z/);
  assert.match(content, /a2a-broker#475/);
  assert.match(content, /openclaw-plugin-a2a#254/);
  assert.match(content, /a2a-docker-runner#173/);
  assert.match(content, /a2a-plane#193/);
  assert.match(content, /Closeout refreshed at/);
  assert.match(content, /broker#478/);
  assert.match(content, /openclaw-plugin-a2a#255/);
  assert.match(content, /a2a-docker-runner#176/);
  assert.match(content, /A `Start` marker alone would not have been sufficient approval-packet evidence/);
});

test('Team1 source-public approval packet matrix covers remaining approval gates', async () => {
  const content = await doc();

  assert.match(content, /Broker\/plugin\/runner packets/);
  assert.match(content, /Scanner\/history evidence/);
  assert.match(content, /Source visibility boundary/);
  assert.match(content, /Terminal\/replay\/readiness gates/);
  assert.match(content, /License\/support\/docs gaps/);
  assert.match(content, /Exact operator approvals/);
  assert.match(content, /Runtime\/bootstrap hygiene/);
});

test('Team1 source-public approval packet matrix preserves fail-closed and non-ACK posture', async () => {
  const content = await doc();

  assert.match(content, /source-public execution remains NO-GO \/ Waiting/);
  assert.match(content, /Public-readiness scans are not a substitute for external history\/secret evidence/);
  assert.match(content, /Provider message id\/send success is accepted-send evidence only/);
  assert.match(content, /Tests, scanner success, provider IDs, and Start\/PR\/Done\/Block comments are not operator approval/);
  assert.match(content, /not as release, source-public visibility, or community-post approval/);
  assert.doesNotMatch(content, /public-readiness GO|Final GO|visibility change was performed|terminal ACK evidence from provider|raw session dump publication as evidence/i);
});

test('Team1 source-public approval packet matrix keeps private source and runtime context out of evidence', async () => {
  const content = await doc();

  assert.match(content, /does not copy private source material/);
  assert.match(content, /Branch diff, PR text, issue comments, and artifacts must exclude runtime\/bootstrap context files and raw session dumps/);
  assert.match(content, /Fail closed before PR creation if runtime\/bootstrap paths enter the branch or artifact evidence/);
  assert.doesNotMatch(content, /ghp_|github_pat_|BROKER_EDGE_SECRET|Authorization:\s*Bearer|chat_id|OPENCLAW_CACHE_BOUNDARY/i);
});
