import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const scriptPath = 'examples/workers/hermes-reference-worker/a2a_worker.py';
const fixturePath = 'examples/workers/hermes-reference-worker/hermes-local-smoke-task.json';
const readmePath = 'examples/workers/hermes-reference-worker/README.md';
const androidRunbookPath = 'docs/hermes-android-native-worker-runbook.md';

test('Hermes reference worker remains local-dry-run first', () => {
  const script = readFileSync(scriptPath, 'utf8');
  assert.match(script, /SAFE_LOCAL_MODES = \{"hermes-reference-dry-run", "local-hermes-smoke"\}/);
  assert.match(script, /refusing non-loopback broker URL/);
  assert.match(script, /A2A_HERMES_REFERENCE_ALLOW_NON_LOOPBACK/);
  assert.doesNotMatch(script, /api\.telegram\.org|terminal[-_ ]?outbox|provider send/i);
  assert.doesNotMatch(script, /requests\.post|requests\.get/);
});

test('Hermes local smoke task is assigned to the reference worker and no-live', () => {
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
  assert.equal(fixture.id, 'hermes-local-smoke-1');
  assert.equal(fixture.assignedWorkerId, 'hermes-agent-reference-worker');
  assert.equal(fixture.targetNodeId, 'hermes-agent-reference-worker');
  assert.equal(fixture.payload.mode, 'hermes-reference-dry-run');
  assert.equal(fixture.payload.noLive, true);
  assert.equal(fixture.policyContext.liveImpact, false);
});

test('Hermes reference worker persists local mobile-safe evidence manifests', () => {
  const script = readFileSync(scriptPath, 'utf8');
  assert.match(script, /a2a\.hermesWorker\.localEvidence\.v1/);
  assert.match(script, /A2A_HERMES_ARTIFACT_ROOT/);
  assert.match(script, /~\/\.hermes\/a2a\/artifacts/);
  assert.match(script, /gongyungProfile/);
  assert.match(script, /termux-hermes/);
  assert.match(script, /os\.replace/);
  assert.doesNotMatch(script, /api\.telegram\.org|provider send/i);
});

test('Hermes Android native runbook documents no-Gateway boot and reconnect path', () => {
  const readme = readFileSync(readmePath, 'utf8');
  const runbook = readFileSync(androidRunbookPath, 'utf8');

  assert.match(readme, /Android \/ Termux native profile/);
  assert.match(readme, /gatewayRequired=false/);
  assert.match(readme, /~\/\.hermes\/a2a\/artifacts/);
  assert.match(runbook, /not require a full OpenClaw Gateway install/);
  assert.match(runbook, /termux-wake-lock/);
  assert.match(runbook, /\.termux\/boot\/a2a-hermes-worker/);
  assert.match(runbook, /re-registers and heartbeats on every pass/);
  assert.match(runbook, /No provider send, Telegram send, Terminal Brief ACK\/replay, DB mutation/);
  assert.doesNotMatch(runbook, /A2A_EDGE_SECRET=.*[A-Za-z0-9_]{8,}/);
});
