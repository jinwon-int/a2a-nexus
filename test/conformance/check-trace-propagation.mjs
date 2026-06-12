/**
 * Conformance check: distributed-trace (via.traceId) propagation.
 *
 * Verifies, against the compiled broker + docker-runner outputs, that a
 * single trace id flows end to end:
 *   requester (via.traceId)
 *     -> broker task record
 *     -> A2A task projection metadata (GetTask visibility)
 *     -> worker handler env (A2A_TRACE_ID)
 *     -> docker run args (A2A_TRACE_ID env + a2a.trace.id label)
 *
 * Safety: in-process module checks only. No live broker/worker/container,
 * provider send, deploy, DB mutation, or terminal-outbox ACK.
 */
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const root = process.cwd();
const TRACE = 'trace-conformance-abc123';

// This check verifies behavior against the compiled packages. test:conformance
// can run before the package build step (release-gate ordering), so build any
// package whose dist entry is missing — self-sufficient, no external state.
function ensureBuilt(pkg, distEntry) {
  if (existsSync(path.join(root, distEntry))) return;
  const res = spawnSync('npm', ['run', 'build', '-w', `packages/${pkg}`], { cwd: root, stdio: 'inherit' });
  if (res.status !== 0) {
    throw new Error(`failed to build packages/${pkg} for the trace-propagation conformance check`);
  }
}
ensureBuilt('broker', 'packages/broker/dist/core/broker.js');
ensureBuilt('docker-runner', 'packages/docker-runner/dist/runner.js');

// ── 1. Broker projection exposes via.traceId ──────────────────────────────
const broker = await import(pathToFileURL(path.join(root, 'packages/broker/dist/core/broker.js')).href);
const projection = await import(
  pathToFileURL(path.join(root, 'packages/broker/dist/a2a/task-projection.js')).href
);

const b = new broker.InMemoryA2ABroker();
b.registerWorker({
  nodeId: 'worker-trace',
  role: 'analyst',
  capabilities: {
    canAnalyze: true, canBackfill: false, canPatchWorkspace: false,
    canPromoteLive: false, workspaceIds: ['t'], environments: ['research'],
  },
});
const task = b.createTask({
  intent: 'analyze',
  requester: { id: 'hub', kind: 'node', role: 'hub' },
  target: { id: 'worker-trace', kind: 'node', role: 'analyst' },
  assignedWorkerId: 'worker-trace',
  message: 'trace me',
  via: { traceId: TRACE, transport: 'jsonrpc' },
});

const projected = projection.projectBrokerTask(b.getTask(task.id));
assert.equal(projected.metadata.via?.traceId, TRACE, 'task projection metadata must expose via.traceId');
const listed = projection.projectBrokerTaskForList(b.getTask(task.id));
assert.equal(listed.metadata.via?.traceId, TRACE, 'list projection must expose via.traceId');

// ── 2. Worker external handler injects A2A_TRACE_ID ────────────────────────
const worker = await import(pathToFileURL(path.join(root, 'packages/broker/dist/worker.js')).href);
// A handler script that echoes its A2A_TRACE_ID back as evidence.
const { mkdtempSync, writeFileSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const scriptDir = mkdtempSync(path.join(tmpdir(), 'a2a-trace-conf-'));
const scriptPath = path.join(scriptDir, 'echo-trace.mjs');
writeFileSync(
  scriptPath,
  [
    'for await (const c of process.stdin) void c;',
    "process.stdout.write(JSON.stringify({ result: { summary: 'ok', output: { traceId: process.env.A2A_TRACE_ID ?? null } } }));",
  ].join('\n'),
);
const handler = worker.createExternalWorkerHandler({ command: process.execPath, args: [scriptPath], timeoutMs: 5000 });
const outcome = await handler(b.getTask(task.id));
assert.equal(outcome.result.output.traceId, TRACE, 'worker handler must inject A2A_TRACE_ID from task.via.traceId');

// ── 3. Docker run args carry the trace env + label ─────────────────────────
const runner = await import(
  pathToFileURL(path.join(root, 'packages/docker-runner/dist/runner.js')).href
);
const args = runner.buildRunArgs(
  { rootDir: root, image: 'example/image:ci', defaultTimeoutMs: 1000 },
  { id: 'task-trace', traceId: TRACE, command: 'echo', repos: [] },
  '/tmp/work',
  'run-1',
);
assert.ok(args.includes(`A2A_TRACE_ID=${TRACE}`), 'docker run args must inject A2A_TRACE_ID');
assert.ok(args.some((a) => a.startsWith('a2a.trace.id=')), 'docker run args must label the trace id');

console.log(JSON.stringify({ ok: true, check: 'trace-propagation', traceId: TRACE, hops: ['projection', 'list-projection', 'worker-env', 'container-env', 'container-label'] }));
