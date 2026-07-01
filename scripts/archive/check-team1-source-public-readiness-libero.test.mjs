import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const docPath = join(repoRoot, 'docs', 'validation', 'team1-source-public-readiness-libero.md');

async function doc() {
  return readFile(docPath, 'utf8');
}

test('Team1 source public-readiness libero matrix covers the required lanes and gates', async () => {
  const content = await doc();

  assert.match(content, /a2a-team1-source-public-readiness-20260510T054829Z/);
  assert.match(content, /a2a-broker#469/);
  assert.match(content, /openclaw-plugin-a2a#251/);
  assert.match(content, /a2a-docker-runner#168/);
  assert.match(content, /Terminal evidence and replay safety/);
  assert.match(content, /Scanner\/readiness/);
  assert.match(content, /Source visibility boundary/);
  assert.match(content, /Explicit approval separation/);
});

test('Team1 source public-readiness libero matrix preserves fail-closed wording', async () => {
  const content = await doc();

  assert.match(content, /public-readiness still NO-GO/);
  assert.match(content, /no-change evidence\/RCA/);
  assert.match(content, /accepted-send evidence remains non-ACK/);
  assert.match(content, /Tests, scanner success, provider IDs, and PR\/Done\/Block comments are not approval/);
  assert.doesNotMatch(content, /public-readiness GO|Final GO|visibility change was performed|terminal ACK evidence from provider/i);
});

test('Team1 source public-readiness libero matrix records source visibility without copying private material', async () => {
  const content = await doc();

  assert.match(content, /`a2a-plane(?: \(internal tracker, private\))?` public/);
  assert.match(content, /`jinwon-int\/a2a-broker`, `jinwon-int\/openclaw-plugin-a2a`, and `jinwon-int\/a2a-docker-runner` remain private source repositories/);
  assert.match(content, /without copying private material/);
  assert.doesNotMatch(content, /ghp_|github_pat_|BROKER_EDGE_SECRET|Authorization:\s*Bearer|chat_id|OPENCLAW_CACHE_BOUNDARY/i);
});
