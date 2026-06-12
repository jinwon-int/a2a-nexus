import assert from 'node:assert/strict';
import http from 'node:http';
import { spawnSync, spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  runDispatch,
  validateManifest,
  deriveLaneId,
  CLASS_CREATED,
  CLASS_ACCEPTED_UNCONFIRMED,
  CLASS_ALREADY_EXISTS,
  CLASS_FAILED,
} from './a2a-dispatch-round.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, 'a2a-dispatch-round.mjs');
const MOCK_BROKER = join(__dirname, 'a2a-dispatch-round.mock-broker.mjs');
const SECRET = 'edge-secret-do-not-leak-9f3a';

/**
 * Spawn the standalone mock broker as its own process (required for child-
 * process CLI tests — an in-process server would deadlock under spawnSync).
 */
function startBrokerProcess(mode) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [MOCK_BROKER, mode], { stdio: ['ignore', 'pipe', 'inherit'] });
    let buf = '';
    const timer = setTimeout(() => reject(new Error('mock broker did not start')), 5000);
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl !== -1) {
        clearTimeout(timer);
        const { port } = JSON.parse(buf.slice(0, nl));
        resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => { child.once('exit', r); child.kill(); }) });
      }
    });
    child.on('error', reject);
  });
}

// ─── Mock broker (node:http) ─────────────────────────────────────────────────

/**
 * Build a local mock broker.
 * @param {object} behavior
 *   behavior.post(req, body) => { status, json } controls POST /tasks per call.
 *   behavior.store is a Map of taskId -> task used to back GET /tasks/:id.
 */
function startMockBroker(behavior) {
  const store = behavior.store ?? new Map();
  let postCalls = 0;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const send = (status, obj) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(obj == null ? '' : JSON.stringify(obj));
      };
      const url = req.url ?? '';
      if (req.method === 'POST' && url === '/tasks') {
        const body = raw ? JSON.parse(raw) : {};
        const result = behavior.post(body, { call: postCalls++ , store });
        return send(result.status, result.json);
      }
      if (req.method === 'GET' && url.startsWith('/tasks/')) {
        const id = decodeURIComponent(url.slice('/tasks/'.length));
        if (store.has(id)) return send(200, store.get(id));
        return send(404, { error: { code: 'not_found' } });
      }
      return send(404, { error: { code: 'not_found' } });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        store,
        getPostCalls: () => postCalls,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

function makeManifest(brokerUrl, laneCount = 3) {
  return {
    roundId: 'pr-review-r2-20260612-195514',
    brokerUrl,
    requester: { id: 'libero', role: 'orchestrator' },
    defaults: { intent: 'pr-review' },
    lanes: Array.from({ length: laneCount }, (_, i) => ({
      target: { id: `worker-${i + 1}`, role: 'reviewer' },
      message: `Please review lane ${i + 1}`,
    })),
  };
}

// ─── validateManifest / deriveLaneId ─────────────────────────────────────────

test('deriveLaneId uses explicit id, else roundId:order', () => {
  assert.equal(deriveLaneId('r1', { id: 'explicit' }, 2), 'explicit');
  assert.equal(deriveLaneId('r1', {}, 2), 'r1:2');
});

test('validateManifest stamps parent-round metadata and derives ids', () => {
  const { errors, lanes } = validateManifest(makeManifest('http://x', 3));
  assert.equal(errors.length, 0);
  assert.equal(lanes.length, 3);
  assert.equal(lanes[0].id, 'pr-review-r2-20260612-195514:1');
  assert.equal(lanes[1].payload.parentRoundOrder, 2);
  assert.equal(lanes[1].payload.parentRoundTotal, 3);
  assert.equal(lanes[1].payload.parentRoundId, 'pr-review-r2-20260612-195514');
});

test('validateManifest honors explicit parentRoundOrder in lane payload', () => {
  const m = makeManifest('http://x', 2);
  m.lanes[0].payload = { parentRoundOrder: 9 };
  const { lanes } = validateManifest(m);
  assert.equal(lanes[0].payload.parentRoundOrder, 9);
  assert.equal(lanes[0].payload.parentRoundTotal, 2);
});

// ─── runDispatch: dry-run ────────────────────────────────────────────────────

test('dry-run validates and plans without network', async () => {
  const out = await runDispatch(makeManifest('http://unused', 2), { dryRun: true });
  assert.equal(out.exitCode, 0);
  assert.equal(out.mode, 'dry-run');
  assert.equal(out.lanes.length, 2);
});

test('dry-run rejects duplicate lane ids', async () => {
  const m = makeManifest('http://unused', 2);
  m.lanes[0].id = 'dup';
  m.lanes[1].id = 'dup';
  const out = await runDispatch(m, { dryRun: true });
  assert.equal(out.exitCode, 1);
  assert.ok(out.errors.some((e) => /duplicate lane id/.test(e)));
});

test('dry-run rejects empty message', async () => {
  const m = makeManifest('http://unused', 1);
  m.lanes[0].message = '   ';
  const out = await runDispatch(m, { dryRun: true });
  assert.equal(out.exitCode, 1);
  assert.ok(out.errors.some((e) => /message is required/.test(e)));
});

// ─── runDispatch: live (mock broker) ─────────────────────────────────────────

test('all lanes 201 -> exit 0, all created', async () => {
  const broker = await startMockBroker({
    post: (body) => ({ status: 201, json: { task: { id: body.id, status: 'queued' } } }),
  });
  try {
    const out = await runDispatch(makeManifest(broker.url, 3), { fetchImpl: fetch, secret: SECRET });
    assert.equal(out.exitCode, 0);
    assert.equal(out.ok, true);
    assert.equal(out.summary.counts[CLASS_CREATED], 3);
    assert.equal(broker.getPostCalls(), 3);
  } finally {
    await broker.close();
  }
});

test('one lane 500 -> exit 1, that lane failed, others still attempted', async () => {
  const broker = await startMockBroker({
    post: (body, ctx) => {
      if (ctx.call === 1) return { status: 500, json: { error: { code: 'internal' } } };
      return { status: 201, json: { task: { id: body.id, status: 'queued' } } };
    },
  });
  try {
    const out = await runDispatch(makeManifest(broker.url, 3), { fetchImpl: fetch, secret: SECRET });
    assert.equal(out.exitCode, 1);
    assert.equal(out.summary.counts[CLASS_FAILED], 1);
    assert.equal(out.summary.counts[CLASS_CREATED], 2);
    assert.equal(broker.getPostCalls(), 3, 'all lanes attempted despite the failure');
    const failed = out.results.find((r) => r.classification === CLASS_FAILED);
    assert.equal(failed.status, 500);
  } finally {
    await broker.close();
  }
});

test('503 queue_drain_timeout + task found on GET -> accepted-unconfirmed, exit 0', async () => {
  const store = new Map();
  const broker = await startMockBroker({
    store,
    post: (body, ctx) => {
      // Task IS created in memory; durable ack timed out.
      ctx.store.set(body.id, { id: body.id, status: 'queued' });
      return { status: 503, json: { error: { code: 'queue_drain_timeout' } } };
    },
  });
  try {
    const out = await runDispatch(makeManifest(broker.url, 2), { fetchImpl: fetch, secret: SECRET });
    assert.equal(out.exitCode, 0);
    assert.equal(out.summary.counts[CLASS_ACCEPTED_UNCONFIRMED], 2);
    const r = out.results[0];
    assert.equal(r.classification, CLASS_ACCEPTED_UNCONFIRMED);
    assert.ok(r.verifyHint, 'includes a verify hint');
  } finally {
    await broker.close();
  }
});

test('503 + task NOT found on GET -> failed, exit 1', async () => {
  const broker = await startMockBroker({
    post: () => ({ status: 503, json: { error: { code: 'queue_drain_timeout' } } }),
  });
  try {
    const out = await runDispatch(makeManifest(broker.url, 2), { fetchImpl: fetch, secret: SECRET });
    assert.equal(out.exitCode, 1);
    assert.equal(out.summary.counts[CLASS_FAILED], 2);
    assert.equal(out.results[0].errorCode, 'queue_drain_timeout');
  } finally {
    await broker.close();
  }
});

test('202 {task,durable:false} shape -> accepted-unconfirmed', async () => {
  const broker = await startMockBroker({
    post: (body) => ({ status: 202, json: { task: { id: body.id, status: 'queued' }, durable: false, ackTimeout: true } }),
  });
  try {
    const out = await runDispatch(makeManifest(broker.url, 2), { fetchImpl: fetch, secret: SECRET });
    assert.equal(out.exitCode, 0);
    assert.equal(out.summary.counts[CLASS_ACCEPTED_UNCONFIRMED], 2);
    assert.ok(out.results[0].verifyHint);
  } finally {
    await broker.close();
  }
});

test('duplicate (POST 409, GET finds task) -> already-exists', async () => {
  const store = new Map();
  const broker = await startMockBroker({
    store,
    post: (body, ctx) => {
      ctx.store.set(body.id, { id: body.id, status: 'queued' });
      return { status: 409, json: { error: { code: 'duplicate_task' } } };
    },
  });
  try {
    const out = await runDispatch(makeManifest(broker.url, 2), { fetchImpl: fetch, secret: SECRET });
    assert.equal(out.exitCode, 0);
    assert.equal(out.summary.counts[CLASS_ALREADY_EXISTS], 2);
  } finally {
    await broker.close();
  }
});

test('--verify re-fetches each lane and counts states', async () => {
  const store = new Map();
  const broker = await startMockBroker({
    store,
    post: (body, ctx) => {
      ctx.store.set(body.id, { id: body.id, status: 'queued' });
      return { status: 201, json: { task: { id: body.id, status: 'queued' } } };
    },
  });
  try {
    const out = await runDispatch(makeManifest(broker.url, 2), { fetchImpl: fetch, secret: SECRET, verify: true });
    assert.equal(out.exitCode, 0);
    assert.ok(out.verify);
    assert.equal(out.verify.rows.length, 2);
    assert.equal(out.verify.counts.queued, 2);
  } finally {
    await broker.close();
  }
});

test('missing A2A_EDGE_SECRET refuses to dispatch', async () => {
  const out = await runDispatch(makeManifest('http://unused', 1), { fetchImpl: fetch, secret: '' });
  assert.equal(out.exitCode, 1);
  assert.ok(out.errors.some((e) => /A2A_EDGE_SECRET/.test(e)));
});

// ─── Secret never leaks (child process, full output capture) ─────────────────

test('secret never appears in CLI output', async () => {
  const broker = await startBrokerProcess('ok');
  const dir = mkdtempSync(join(tmpdir(), 'a2a-dispatch-round-'));
  const manifestPath = join(dir, 'manifest.json');
  writeFileSync(manifestPath, JSON.stringify(makeManifest(broker.url, 2)));
  try {
    const proc = spawnSync(process.execPath, [SCRIPT, '--manifest', manifestPath, '--verify'], {
      encoding: 'utf8',
      env: { ...process.env, A2A_EDGE_SECRET: SECRET },
    });
    const combined = `${proc.stdout}\n${proc.stderr}`;
    assert.equal(proc.status, 0, combined);
    assert.ok(!combined.includes(SECRET), 'secret must not appear in output');
    assert.ok(!combined.includes('ALL DISPATCHED'), 'forbidden banner must not appear');
    assert.ok(/created=2/.test(combined));
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await broker.close();
  }
});

test('CLI exits 1 when a lane fails and prints no all-clear', async () => {
  const broker = await startBrokerProcess('fail-first');
  const dir = mkdtempSync(join(tmpdir(), 'a2a-dispatch-round-'));
  const manifestPath = join(dir, 'manifest.json');
  writeFileSync(manifestPath, JSON.stringify(makeManifest(broker.url, 2)));
  try {
    const proc = spawnSync(process.execPath, [SCRIPT, '--manifest', manifestPath], {
      encoding: 'utf8',
      env: { ...process.env, A2A_EDGE_SECRET: SECRET },
    });
    const combined = `${proc.stdout}\n${proc.stderr}`;
    assert.equal(proc.status, 1, combined);
    assert.ok(!combined.includes('ALL DISPATCHED'));
    assert.ok(/INCOMPLETE/.test(combined));
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await broker.close();
  }
});
