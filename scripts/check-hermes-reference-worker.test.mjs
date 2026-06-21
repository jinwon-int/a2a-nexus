import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const scriptPath = 'examples/workers/hermes-reference-worker/a2a_worker.py';
const fixturePath = 'examples/workers/hermes-reference-worker/hermes-local-smoke-task.json';
const readmePath = 'examples/workers/hermes-reference-worker/README.md';
const androidRunbookPath = 'docs/hermes-android-native-worker-runbook.md';

test('Hermes reference worker remains local-dry-run first', () => {
  const script = readFileSync(scriptPath, 'utf8');
  assert.match(script, /"analysis-only"/);
  assert.match(script, /"readonly-analysis"/);
  assert.match(script, /"read-only-analysis"/);
  assert.match(script, /"a2ad-analysis"/);
  assert.match(script, /"hermes-reference-dry-run"/);
  assert.match(script, /"local-hermes-smoke"/);
  assert.match(script, /refusing non-loopback broker URL/);
  assert.match(script, /A2A_HERMES_REFERENCE_ALLOW_NON_LOOPBACK/);
  assert.doesNotMatch(script, /api\.telegram\.org|terminal[-_ ]?outbox|provider send/i);
  assert.doesNotMatch(script, /requests\.post|requests\.get/);
});

test('Hermes reference worker accepts no-live mobile analysis modes but rejects live/write lanes', () => {
  const program = String.raw`
import json, runpy, sys
m = runpy.run_path('examples/workers/hermes-reference-worker/a2a_worker.py', run_name='a2a_worker_test')
is_safe = m['is_safe_local_task']
cases = [
  ({'intent': 'analyze', 'payload': {'noLive': True, 'mode': 'analysis-only'}, 'policyContext': {'liveImpact': False, 'targetEnvironment': 'research'}}, True, 'analysis-only accepted'),
  ({'intent': 'verify', 'payload': {'noLive': True, 'mode': 'readonly-analysis'}, 'policyContext': {'liveImpact': False, 'targetEnvironment': 'research'}}, True, 'readonly-analysis accepted'),
  ({'intent': 'analyze', 'payload': {'noLive': True, 'mode': 'read-only-analysis'}, 'policyContext': {'liveImpact': False, 'targetEnvironment': 'research'}}, True, 'read-only-analysis alias accepted'),
  ({'intent': 'analyze', 'payload': {'noLive': True, 'mode': 'a2ad-analysis'}, 'policyContext': {'liveImpact': False, 'targetEnvironment': 'research'}}, True, 'a2ad-analysis accepted'),
  ({'intent': 'analyze', 'payload': {'noLive': True, 'mode': 'analysis-only'}, 'policyContext': {'liveImpact': True, 'targetEnvironment': 'research'}}, False, 'liveImpact rejected'),
  ({'intent': 'analyze', 'payload': {'noLive': False, 'mode': 'analysis-only'}, 'policyContext': {'liveImpact': False, 'targetEnvironment': 'research'}}, False, 'noLive false rejected'),
  ({'intent': 'analyze', 'payload': {'noLive': True, 'mode': 'github-propose-patch'}, 'policyContext': {'liveImpact': False, 'targetEnvironment': 'research'}}, False, 'github write mode rejected'),
  ({'intent': 'analyze', 'payload': {'noLive': True, 'mode': 'analysis-only', 'providerSend': True}, 'policyContext': {'liveImpact': False, 'targetEnvironment': 'research'}}, False, 'provider send rejected'),
]
failures = []
for task, expected, label in cases:
    actual = is_safe(task)
    if actual is not expected:
        failures.append({'label': label, 'expected': expected, 'actual': actual})
if failures:
    print(json.dumps(failures, ensure_ascii=False), file=sys.stderr)
    raise SystemExit(1)
`;
  const result = spawnSync('python3', ['-c', program], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
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
