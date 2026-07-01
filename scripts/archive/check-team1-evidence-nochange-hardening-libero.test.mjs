import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const docPath = join(repoRoot, 'docs', 'validation', 'team1-evidence-nochange-hardening-libero.md');

async function doc() {
  return readFile(docPath, 'utf8');
}

test('Team1 evidence-only no-change hardening matrix covers required lanes and gates', async () => {
  const content = await doc();

  assert.match(content, /a2a-evidence-nochange-hardening-20260510T100150Z/);
  assert.match(content, /a2a-docker-runner#169/);
  assert.match(content, /a2a-broker#471/);
  assert.match(content, /openclaw-plugin-a2a#252/);
  assert.match(content, /Broker outcome vocabulary/);
  assert.match(content, /Plugin\/Gateway mapping/);
  assert.match(content, /No-change evidence semantics/);
  assert.match(content, /Scanner\/readiness fail-closed posture/);
  assert.match(content, /Source visibility boundary/);
  assert.match(content, /Explicit approval separation/);
});

test('Team1 evidence-only no-change hardening matrix preserves non-ACK and fail-closed semantics', async () => {
  const content = await doc();

  assert.match(content, /public-readiness still NO-GO/);
  assert.match(content, /accepted-send evidence remains non-ACK/);
  assert.match(content, /Empty diff is evidence input, not a terminal result/);
  assert.match(content, /PR\/Done\/Block evidence, scanner success, accepted-send\/provider message IDs, and tests are not approval/);
  assert.match(content, /Round closeout OK after sibling PR merges/);
  assert.doesNotMatch(content, /public-readiness GO|Final GO|visibility change was performed|terminal ACK evidence from provider/i);
});

test('Team1 evidence-only no-change hardening matrix keeps private source and runtime context out of evidence', async () => {
  const content = await doc();

  assert.match(content, /`a2a-plane \(internal tracker, private\)` is public/);
  assert.match(content, /`jinwon-int\/a2a-broker`, `jinwon-int\/openclaw-plugin-a2a`, and `jinwon-int\/a2a-docker-runner` remain private/);
  assert.match(content, /Do not copy private material/);
  assert.match(content, /OpenClaw runtime\/bootstrap evidence publication/);
  assert.doesNotMatch(content, /ghp_|github_pat_|BROKER_EDGE_SECRET|Authorization:\s*Bearer|chat_id|OPENCLAW_CACHE_BOUNDARY/i);
});
