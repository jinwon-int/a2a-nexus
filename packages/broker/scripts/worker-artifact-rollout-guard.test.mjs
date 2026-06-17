import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const testDir = dirname(fileURLToPath(import.meta.url));
const guardPath = join(testDir, 'worker-artifact-rollout-guard.mjs');

const handlerSource = `
import { resolveWorkerModelInputs } from './worker-model-policy.mjs';
const HANDLER_VERSION = '0.2.12';
const sourceSha256 = 'computed';
export const BUILD_INFO = {
  name: 'a2a-task-handler',
  version: HANDLER_VERSION,
  source: 'repo:scripts/a2a-task-handler.mjs',
  sourceSha256,
  contract: 'stdin A2A task JSON -> stdout WorkerHandlerOutcome JSON',
  credentialFree: true,
  hostNeutral: true,
};
`;

const workerModelPolicySource = `
export function resolveWorkerModelInputs() { return { model: 'minimax-m3', fromPayload: false }; }
`;

function makeWorkerRoot({ bridgeHandlersContent = 'bridge-ok\n', handlersExecutable = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'worker-artifact-'));
  const scripts = join(root, 'scripts');
  const handlers = join(root, 'handlers');
  mkdirSync(scripts);
  mkdirSync(handlers);

  const files = {
    sourceHandler: join(scripts, 'a2a-task-handler.mjs'),
    compatHandler: join(handlers, 'a2a-task-handler.mjs'),
    sourceWorkerModelPolicy: join(scripts, 'worker-model-policy.mjs'),
    compatWorkerModelPolicy: join(handlers, 'worker-model-policy.mjs'),
    sourceBridge: join(scripts, 'hermes-a2a-analysis-bridge.mjs'),
    compatBridge: join(handlers, 'hermes-a2a-analysis-bridge.mjs'),
  };

  writeFileSync(files.sourceHandler, handlerSource);
  writeFileSync(files.compatHandler, handlerSource);
  writeFileSync(files.sourceWorkerModelPolicy, workerModelPolicySource);
  writeFileSync(files.compatWorkerModelPolicy, workerModelPolicySource);
  writeFileSync(files.sourceBridge, 'bridge-ok\n');
  writeFileSync(files.compatBridge, bridgeHandlersContent);

  chmodSync(files.sourceHandler, 0o755);
  chmodSync(files.compatHandler, handlersExecutable ? 0o755 : 0o644);
  chmodSync(files.sourceBridge, 0o755);
  chmodSync(files.compatBridge, 0o755);

  return { root, files };
}

function runGuard(root) {
  return spawnSync(process.execPath, [guardPath, '--deployed'], {
    cwd: resolve('.'),
    env: { ...process.env, A2A_WORKER_ROOT: root },
    encoding: 'utf8',
  });
}

test('deployed guard fails closed when bridge compat path content drifts from scripts source', () => {
  const { root } = makeWorkerRoot({ bridgeHandlersContent: 'bridge-drift\n' });
  const result = runGuard(root);
  assert.notEqual(result.status, 0);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, false);
  assert.equal(output.results.some((r) => r.guard === 'bridge-compat-path' && r.ok === false), true);
});

test('deployed guard fails closed when handler executable bit drifts across scripts and handlers paths', () => {
  const { root } = makeWorkerRoot({ handlersExecutable: false });
  const result = runGuard(root);
  assert.notEqual(result.status, 0);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, false);
  assert.equal(output.results.some((r) => r.guard === 'artifact-executable-parity' && r.ok === false), true);
});

test('deployed guard fails closed when handler transitive support module is missing from handlers compat path', () => {
  const { root, files } = makeWorkerRoot();
  rmSync(files.compatWorkerModelPolicy);
  const result = runGuard(root);
  assert.notEqual(result.status, 0);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, false);
  assert.equal(output.results.some((r) => r.guard === 'handler-support-compat-path' && r.ok === false), true);
});
