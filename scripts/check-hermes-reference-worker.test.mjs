import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

test('Hermes reference worker posts local evidence manifest as broker artifactIds', () => {
  const dir = mkdtempSync(join(tmpdir(), 'a2a-mobile-artifact-ids-'));
  const program = String.raw`
import json, os, runpy
m = runpy.run_path('examples/workers/hermes-reference-worker/a2a_worker.py', run_name='a2a_worker_test')
requests = []
task = {
    'id': 'mobile-artifact-task-1',
    'intent': 'analyze',
    'payload': {'mode': 'analysis-only', 'noLive': True, 'sourceOnly': True},
    'policyContext': {'liveImpact': False, 'targetEnvironment': 'research'},
}
def fake_request_json(method, path, body=None):
    requests.append({'method': method, 'path': path, 'body': body})
    if method == 'GET' and path.startswith('/tasks?'):
        return {'items': [task]}
    if path.endswith('/evidence'):
        return {'id': task['id'], 'status': 'succeeded', 'result': body['result'], 'artifactIds': body['result'].get('artifactIds', [])}
    return {}
globals_ = m['run_once'].__globals__
globals_['request_json'] = fake_request_json
globals_['ensure_registered'] = lambda: {'status': 'skipped'}
globals_['heartbeat'] = lambda: {}
globals_['poll'] = lambda: [task]
result = m['run_once']()
evidence_calls = [item for item in requests if item['path'].endswith('/evidence')]
assert len(evidence_calls) == 1, evidence_calls
body = evidence_calls[0]['body']
print(json.dumps({'runOnce': result, 'evidenceBody': body}, ensure_ascii=False, sort_keys=True))
`;
  const result = spawnSync('python3', ['-c', program], {
    encoding: 'utf8',
    env: {
      ...process.env,
      A2A_HERMES_ARTIFACT_ROOT: dir,
      A2A_WORKER_ID: 'gongyung',
      A2A_HERMES_RUNTIME_FLAVOR: 'termux-hermes',
    },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const output = JSON.parse(result.stdout);
  const artifactIds = output.evidenceBody.result.artifactIds;
  assert.ok(Array.isArray(artifactIds), 'result.artifactIds must be an array for broker promotion');
  assert.deepEqual(artifactIds, ['~/.hermes/a2a/artifacts/mobile-artifact-task-1/evidence.json']);
  assert.equal(output.evidenceBody.result.artifacts[0].kind, 'manifest');
});

test('Hermes reference worker uses isolated mobile workspace root when configured', () => {
  const workRoot = mkdtempSync(join(tmpdir(), 'a2a-mobile-work-root-'));
  const fallbackArtifactRoot = mkdtempSync(join(tmpdir(), 'a2a-mobile-fallback-artifacts-'));
  const program = String.raw`
import json, os, pathlib, runpy
m = runpy.run_path('examples/workers/hermes-reference-worker/a2a_worker.py', run_name='a2a_worker_test')
requests = []
task = {
    'id': 'mobile workspace/task:1',
    'intent': 'analyze',
    'payload': {'mode': 'analysis-only', 'noLive': True, 'sourceOnly': True},
    'policyContext': {'liveImpact': False, 'targetEnvironment': 'research'},
}
def fake_request_json(method, path, body=None):
    requests.append({'method': method, 'path': path, 'body': body})
    if method == 'GET' and path.startswith('/tasks?'):
        return {'items': [task]}
    if path.endswith('/evidence'):
        return {'id': task['id'], 'status': 'succeeded', 'result': body['result'], 'artifactIds': body['result'].get('artifactIds', [])}
    return {}
globals_ = m['run_once'].__globals__
globals_['request_json'] = fake_request_json
globals_['ensure_registered'] = lambda: {'status': 'skipped'}
globals_['heartbeat'] = lambda: {}
globals_['poll'] = lambda: [task]
result = m['run_once']()
evidence_body = [item['body'] for item in requests if item['path'].endswith('/evidence')][0]
safe_task = 'mobile_workspace_task_1'
workspace = pathlib.Path(os.environ['A2A_MOBILE_WORK_ROOT']) / os.environ['A2A_HOME_BROKER_ID'] / safe_task
print(json.dumps({
  'runOnce': result,
  'artifactIds': evidence_body['result'].get('artifactIds'),
  'artifactPath': evidence_body['result']['artifacts'][0]['path'],
  'workspaceExists': workspace.exists(),
  'subdirs': {name: (workspace / name).is_dir() for name in ['repo', 'artifacts', 'evidence', 'tmp']},
  'manifestExists': (workspace / 'evidence' / 'evidence.json').is_file(),
}, ensure_ascii=False, sort_keys=True))
`;
  const result = spawnSync('python3', ['-c', program], {
    encoding: 'utf8',
    env: {
      ...process.env,
      A2A_HERMES_ARTIFACT_ROOT: fallbackArtifactRoot,
      A2A_MOBILE_WORK_ROOT: workRoot,
      A2A_HOME_BROKER_ID: 'gwakga',
      A2A_WORKER_ID: 'daegyo',
      A2A_HERMES_RUNTIME_FLAVOR: 'termux-hermes',
    },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(output.artifactIds, ['~/.hermes/a2a-workspaces/gwakga/mobile_workspace_task_1/evidence/evidence.json']);
  assert.equal(output.artifactPath, '~/.hermes/a2a-workspaces/gwakga/mobile_workspace_task_1/evidence/evidence.json');
  assert.equal(output.workspaceExists, true);
  assert.deepEqual(output.subdirs, { repo: true, artifacts: true, evidence: true, tmp: true });
  assert.equal(output.manifestExists, true);
});

test('Hermes reference worker can produce opt-in model-backed analysis JSON', () => {
  const dir = mkdtempSync(join(tmpdir(), 'a2a-mobile-analysis-'));
  const fakeBridge = join(dir, 'fake-mobile-analysis.py');
  const capturePath = join(dir, 'stdin.json');
  writeFileSync(fakeBridge, String.raw`#!/usr/bin/env python3
import json, os, sys
payload = json.load(sys.stdin)
open(os.environ['CAPTURE_PATH'], 'w', encoding='utf-8').write(json.dumps(payload, ensure_ascii=False, sort_keys=True))
print(json.dumps({
  'analysisStatus': 'done',
  'summary': 'mobile model bridge produced substantive analysis',
  'findings': ['mobile worker inspected the no-live task context'],
  'recommendations': ['count this lane only when analysisStatus=done'],
  'evidenceRefs': [payload['task']['id']],
}, ensure_ascii=False))
`);
  chmodSync(fakeBridge, 0o755);

  const program = String.raw`
import json, os, runpy
m = runpy.run_path('examples/workers/hermes-reference-worker/a2a_worker.py', run_name='a2a_worker_test')
task = {
    'id': 'mobile-model-task-1',
    'intent': 'analyze',
    'payload': {'mode': 'analysis-only', 'noLive': True, 'sourceOnly': True},
    'policyContext': {'liveImpact': False, 'targetEnvironment': 'research'},
}
result = m['mobile_model_analysis_output'](task)
print(json.dumps(result, ensure_ascii=False, sort_keys=True))
`;
  const result = spawnSync('python3', ['-c', program], {
    encoding: 'utf8',
    env: {
      ...process.env,
      A2A_HERMES_REFERENCE_ANALYSIS_ENABLED: '1',
      A2A_HERMES_REFERENCE_ANALYSIS_COMMAND_JSON: JSON.stringify(['python3', fakeBridge]),
      A2A_WORKER_ID: 'gongyung',
      A2A_HERMES_RUNTIME_FLAVOR: 'termux-hermes',
      CAPTURE_PATH: capturePath,
    },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const output = JSON.parse(result.stdout);
  assert.equal(output.analysisKind, 'mobile_model_bridge');
  assert.equal(output.analysisStatus, 'done');
  assert.equal(output.evidenceClass, 'substantive');
  assert.equal(output.bridgeAdapter, 'hermes-reference-mobile');
  assert.deepEqual(output.findings, ['mobile worker inspected the no-live task context']);
  const captured = JSON.parse(readFileSync(capturePath, 'utf8'));
  assert.equal(captured.task.id, 'mobile-model-task-1');
  assert.equal(captured.workerId, 'gongyung');
  assert.equal(captured.runtimeFlavor, 'termux-hermes');
});

test('Hermes reference worker fails closed when opt-in model bridge emits invalid JSON', () => {
  const dir = mkdtempSync(join(tmpdir(), 'a2a-mobile-analysis-bad-'));
  const fakeBridge = join(dir, 'fake-bad-mobile-analysis.py');
  writeFileSync(fakeBridge, '#!/usr/bin/env python3\nprint("[Roadmap] prose is not JSON")\n');
  chmodSync(fakeBridge, 0o755);

  const program = String.raw`
import json, runpy
m = runpy.run_path('examples/workers/hermes-reference-worker/a2a_worker.py', run_name='a2a_worker_test')
task = {
    'id': 'mobile-model-task-bad-json',
    'intent': 'analyze',
    'payload': {'mode': 'analysis-only', 'noLive': True, 'sourceOnly': True},
    'policyContext': {'liveImpact': False, 'targetEnvironment': 'research'},
}
result = m['mobile_model_analysis_output'](task)
print(json.dumps(result, ensure_ascii=False, sort_keys=True))
`;
  const result = spawnSync('python3', ['-c', program], {
    encoding: 'utf8',
    env: {
      ...process.env,
      A2A_HERMES_REFERENCE_ANALYSIS_ENABLED: '1',
      A2A_HERMES_REFERENCE_ANALYSIS_COMMAND_JSON: JSON.stringify(['python3', fakeBridge]),
    },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const output = JSON.parse(result.stdout);
  assert.equal(output.analysisKind, 'mobile_model_bridge');
  assert.equal(output.analysisStatus, 'provider_or_model_failure');
  assert.equal(output.evidenceClass, 'provider_or_model_failure');
  assert.match(output.summary, /invalid JSON/i);
});

test('Hermes reference worker throttles mobile registration within TTL and re-registers after broker forgets worker', () => {
  const dir = mkdtempSync(join(tmpdir(), 'a2a-mobile-registration-'));
  const program = String.raw`
import json, os, pathlib, runpy
m = runpy.run_path('examples/workers/hermes-reference-worker/a2a_worker.py', run_name='a2a_worker_test')
requests = []
tasks = []
def fake_request_json(method, path, body=None):
    requests.append({'method': method, 'path': path, 'body': body})
    if path == '/workers/register':
        return {'status': 'registered'}
    if path.endswith('/heartbeat'):
        return {'status': 'heartbeat'}
    if method == 'GET' and path.startswith('/tasks?'):
        return {'items': tasks}
    return {}
g = m['request_json'].__globals__
g['request_json'] = fake_request_json
first = m['run_once']()
second = m['run_once']()
register_count_before_404 = len([r for r in requests if r['path'] == '/workers/register'])
heartbeat_calls = {'count': 0}
def heartbeat_then_404():
    heartbeat_calls['count'] += 1
    if heartbeat_calls['count'] == 1:
        raise RuntimeError('POST /workers/test/heartbeat failed: HTTP 404 worker not found')
    return {'status': 'heartbeat'}
g['heartbeat'] = heartbeat_then_404
third = m['run_once']()
print(json.dumps({
  'first': first,
  'second': second,
  'third': third,
  'registerCountBefore404': register_count_before_404,
  'registerCountAfter404': len([r for r in requests if r['path'] == '/workers/register']),
  'stateExists': pathlib.Path(os.environ['A2A_WORKER_REGISTRATION_STATE_PATH']).is_file(),
}, sort_keys=True))
`;
  const result = spawnSync('python3', ['-c', program], {
    encoding: 'utf8',
    env: {
      ...process.env,
      A2A_WORKER_ID: 'daegyo',
      A2A_BROKER_URL: 'http://127.0.0.1:18787',
      A2A_WORKER_REGISTRATION_STATE_PATH: join(dir, 'registration.json'),
      A2A_WORKER_REGISTER_REFRESH_SEC: '3600',
    },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const output = JSON.parse(result.stdout);
  assert.equal(output.registerCountBefore404, 1, 'second run_once must not re-register within TTL');
  assert.equal(output.registerCountAfter404, 2, 'heartbeat 404 must force re-register');
  assert.equal(output.stateExists, true);
  assert.equal(output.first.status, 'idle');
  assert.equal(output.second.status, 'idle');
  assert.equal(output.third.status, 'idle');
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
  assert.match(runbook, /only calls\s+`\/workers\/register` on first boot/);
  assert.match(runbook, /A2A_WORKER_REGISTER_REFRESH_SEC/);
  assert.match(runbook, /No provider send, Telegram send, Terminal Brief ACK\/replay, DB mutation/);
  assert.doesNotMatch(runbook, /A2A_EDGE_SECRET=.*[A-Za-z0-9_]{8,}/);
});
