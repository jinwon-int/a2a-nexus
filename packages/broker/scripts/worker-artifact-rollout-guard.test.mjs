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
    sourceOnlyBridge: join(scripts, 'source-only-local-analysis-bridge.mjs'),
  };

  writeFileSync(files.sourceHandler, handlerSource);
  writeFileSync(files.compatHandler, handlerSource);
  writeFileSync(files.sourceWorkerModelPolicy, workerModelPolicySource);
  writeFileSync(files.compatWorkerModelPolicy, workerModelPolicySource);
  writeFileSync(files.sourceBridge, 'bridge-ok\n');
  writeFileSync(files.compatBridge, bridgeHandlersContent);
  writeFileSync(files.sourceOnlyBridge, 'source-only-bridge-ok\n');

  chmodSync(files.sourceHandler, 0o755);
  chmodSync(files.compatHandler, handlersExecutable ? 0o755 : 0o644);
  chmodSync(files.sourceBridge, 0o755);
  chmodSync(files.compatBridge, 0o755);
  chmodSync(files.sourceOnlyBridge, 0o755);

  return { root, files };
}

function runGuard(root, env = {}) {
  const childEnv = { ...process.env, A2A_WORKER_ROOT: root, ...env };
  for (const key of ['A2A_HERMES_ANALYSIS_BIN', 'A2A_OPENCLAW_ANALYSIS_BIN', 'OPENCLAW_BIN', 'A2A_WORKER_ENV_PATH', 'WORKER_ENV_PATH']) {
    if (!(key in env)) delete childEnv[key];
  }
  return spawnSync(process.execPath, [guardPath, '--deployed'], {
    cwd: resolve('.'),
    env: childEnv,
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

test('deployed guard accepts a configured standard source-only analysis bridge', () => {
  const { root, files } = makeWorkerRoot();
  const result = runGuard(root, { A2A_HERMES_ANALYSIS_BIN: files.sourceOnlyBridge });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, true);
  assert.equal(output.results.some((r) => r.guard === 'configured-analysis-bridge-artifacts' && r.ok === true), true);
});

test('deployed guard fails closed when env file points at a missing node-specific analysis bridge', () => {
  const { root } = makeWorkerRoot();
  const envPath = join(root, 'worker.env');
  writeFileSync(envPath, [
    'WORKER_ID=worker-custom',
    `A2A_HERMES_ANALYSIS_BIN=${join(root, 'scripts', 'custom-source-analysis-bridge.mjs')}`,
    '',
  ].join('\n'));
  const result = runGuard(root, { A2A_WORKER_ENV_PATH: envPath });
  assert.notEqual(result.status, 0);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, false);
  const guardResult = output.results.find((r) => r.guard === 'configured-analysis-bridge-artifacts');
  assert.equal(guardResult?.ok, false);
  assert.match(JSON.stringify(guardResult), /custom-source-analysis-bridge\.mjs/);
});
