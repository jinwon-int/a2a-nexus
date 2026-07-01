import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const docPath = join(repoRoot, 'docs', 'validation', 'team1-yukson-r27-canary-hardening-libero.md');

async function doc() {
  return readFile(docPath, 'utf8');
}

test('R27 canary hardening libero matrix covers required run metadata', async () => {
  const content = await doc();

  assert.match(content, /R27 canary hardening/);
  assert.match(content, /a2a-r27-team1-terminal-brief-canary-hardening-20260516T121247Z-yukson-retry1/);
  assert.match(content, /#364/);
  assert.match(content, /yukson/);
  assert.match(content, /retry/);
  assert.match(content, /worker handler compat path/);
});

test('R27 canary hardening libero matrix covers all nine gates', async () => {
  const content = await doc();

  assert.match(content, /C1\. Receipt-gate canary completeness/);
  assert.match(content, /C2\. No-live activation boundary/);
  assert.match(content, /C3\. Session isolation & worker handler compat path/);
  assert.match(content, /C4\. Intent-router canary dispatch/);
  assert.match(content, /C5\. Broker rehearsal manifest integration/);
  assert.match(content, /C6\. Terminal Brief activation gate separation/);
  assert.match(content, /C7\. Provider accepted-send non-ACK boundary/);
  assert.match(content, /C8\. Canary evidence hygiene/);
  assert.match(content, /C9\. Runtime\/bootstrap hygiene/);
});

test('R27 canary hardening libero matrix preserves non-ACK and fail-closed semantics', async () => {
  const content = await doc();

  assert.match(content, /no-live/);
  assert.match(content, /providerCalled=false/);
  assert.match(content, /productionAckAttempted=false/);
  assert.match(content, /provider_send_success.*rejected/);
  assert.match(content, /aggregate verdict.*NO-GO/);
  assert.match(content, /accept.*operator approval/);
  assert.doesNotMatch(content, /GO for activation|Final GO|activation approved|production impact authorized/i);
});

test('R27 canary hardening libero matrix keeps runtime and bootstrap context out of evidence', async () => {
  const content = await doc();

  assert.match(content, /AGENTS\.md/);
  assert.match(content, /SOUL\.md/);
  assert.match(content, /[Ff]ail[ -]closed/);
  assert.doesNotMatch(content, /ghp_|github_pat_|BROKER_EDGE_SECRET|Authorization:\s*Bearer|chat_id|OPENCLAW/);
});

test('R27 canary hardening libero matrix references key canary source modules', async () => {
  const content = await doc();

  assert.match(content, /receipt-gate-canary\.ts/);
  assert.match(content, /session-isolation\.ts/);
  assert.match(content, /intent-router\.ts/);
  assert.match(content, /broker-rehearsal-manifest\.ts/);
  assert.match(content, /worker\.ts/);
  assert.match(content, /R20 stability gate/);
});

test('R27 canary hardening libero matrix has proper safety confirmation', async () => {
  const content = await doc();

  assert.match(content, /Safety confirmation/);
  assert.match(content, /did not perform production deploys/);
  assert.match(content, /did not perform.*live provider/);
  assert.match(content, /not perform.*terminal-outbox ACKs/);
  assert.match(content, /not perform.*secret/);
});
