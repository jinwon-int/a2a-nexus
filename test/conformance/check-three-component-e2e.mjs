#!/usr/bin/env node
/**
 * Conformance check: three-component end-to-end round trip (#1215).
 *
 * Boots the real broker HTTP server on a loopback port, runs a real
 * A2ABrokerWorker with the builtin echo handler against it, and drives the
 * whole task lifecycle through the broker's typed HTTP client
 * client: create -> worker claim/start/complete -> terminal result readable
 * by the requester. Every hop crosses real HTTP; no in-process bypass and no
 * mock broker. This is the integration coverage that broker-only e2e tests
 * and doc-conformance checks cannot provide.
 */
import path from 'node:path';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');

// Same self-sufficiency pattern as check-trace-propagation.mjs: this check
// can run before the package build step, so build any missing dist entry.
function ensureBuilt(pkg, distEntry) {
  if (existsSync(path.join(root, distEntry))) return;
  const res = spawnSync('npm', ['run', 'build', '-w', `packages/${pkg}`], { cwd: root, stdio: 'inherit' });
  if (res.status !== 0) {
    throw new Error(`failed to build packages/${pkg} for the three-component e2e check`);
  }
}
ensureBuilt('broker', 'packages/broker/dist/server.js');
ensureBuilt('broker', 'packages/broker/dist/client/broker-client.js');

const { createBrokerServer } = await import(path.join(root, 'packages/broker/dist/server.js'));
const { emptySnapshot } = await import(path.join(root, 'packages/broker/dist/core/store.js'));
const { A2ABrokerWorker, createBuiltinWorkerHandler } = await import(path.join(root, 'packages/broker/dist/worker.js'));
const { createA2ABrokerClient } = await import(
  path.join(root, 'packages/broker/dist/client/broker-client.js')
);

const EDGE_SECRET = 'three-component-e2e-local-secret';
const WORKER_NODE_ID = 'e2e-echo-worker';

function createInMemoryStateStore() {
  let snapshot = emptySnapshot();
  return {
    load: () => snapshot,
    save: (next) => {
      snapshot = structuredClone(next);
    },
  };
}

async function startBroker() {
  const runtime = createBrokerServer({
    host: '127.0.0.1',
    port: 0,
    publicBaseUrl: 'http://127.0.0.1/',
    stateStore: createInMemoryStateStore(),
    edgeSecret: EDGE_SECRET,
    staleReaperEnabled: false,
  });
  runtime.server.listen(0, '127.0.0.1');
  await new Promise((resolve) => runtime.server.on('listening', resolve));
  const address = runtime.server.address();
  if (!address || typeof address === 'string') throw new Error('failed to bind e2e broker');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => runtime.server.close(() => resolve())),
  };
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

async function main() {
  const broker = await startBroker();
  const worker = new A2ABrokerWorker({
    brokerUrl: broker.baseUrl,
    edgeSecret: EDGE_SECRET,
    worker: {
      nodeId: WORKER_NODE_ID,
      role: 'analyst',
      displayName: 'E2E Echo Worker',
      capabilities: {
        canAnalyze: true,
        canBackfill: false,
        canPatchWorkspace: false,
        canPromoteLive: false,
        workspaceIds: ['e2e'],
        environments: ['research'],
      },
    },
    requesterKind: 'node',
    pollIntervalMs: 50,
    heartbeatIntervalMs: 1000,
    handlerTimeoutMs: 5000,
    pollReadinessProbe: true,
    userAgent: 'a2a-nexus-three-component-e2e',
    handler: createBuiltinWorkerHandler('echo'),
  });
  const client = createA2ABrokerClient({
    baseUrl: broker.baseUrl,
    edgeSecret: EDGE_SECRET,
    requester: { id: 'e2e-operator-node', kind: 'node', role: 'hub' },
    userAgent: 'a2a-nexus-three-component-e2e-client',
  });

  try {
    // 1. Worker registers over real HTTP and its poll path is reachable.
    await worker.register();
    await worker.verifyPollReadiness();

    // 2. Requester creates a task through the broker's typed client.
    const created = await client.createTask({
      intent: 'analyze',
      message: 'three-component e2e round trip',
      requester: { id: 'e2e-operator-node', kind: 'node', role: 'hub' },
      target: { id: WORKER_NODE_ID, kind: 'node', role: 'analyst' },
      assignedWorkerId: WORKER_NODE_ID,
    });
    assertEqual(created.status, 'queued', 'created task status');

    // 3. Worker polls, claims, starts, and completes the task (echo handler).
    const handled = await worker.runOnce();
    assertEqual(handled, 1, 'tasks handled by worker.runOnce()');

    // 4. Requester observes the terminal result through the client.
    const finished = await client.getTask(created.id);
    assertEqual(finished.status, 'succeeded', 'terminal task status');
    assertEqual(finished.claimedBy, WORKER_NODE_ID, 'claimedBy worker');
    if (!finished.result || typeof finished.result.summary !== 'string' || finished.result.summary.length === 0) {
      throw new Error(`terminal result missing echo summary: ${JSON.stringify(finished.result)}`);
    }
    if (!finished.completedAt) throw new Error('terminal task missing completedAt');

    console.log(
      `three-component e2e ok (broker http :${new URL(broker.baseUrl).port}, worker ${WORKER_NODE_ID} handled ${handled} task, terminal status ${finished.status})`,
    );
  } finally {
    await worker.stop().catch(() => {});
    await broker.close();
  }
}

main().catch((error) => {
  console.error(`three-component e2e FAILED: ${error.message}`);
  process.exit(1);
});
