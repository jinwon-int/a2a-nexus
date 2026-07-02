import test from 'node:test';
import assert from 'node:assert/strict';

import { buildAssignments, normalizeCapacity, parseArgs, runHealthCheck } from './no-live-a2a-a2ad-health-check.mjs';

test('no-live health helper normalizes current and legacy capacity shapes', () => {
  assert.deepEqual(normalizeCapacity({ totals: { workers: 1, online: 1 }, items: [{ nodeId: 'w1', status: 'online', counts: { active: 0 } }] }), {
    totals: { workers: 1, online: 1 },
    items: [{ nodeId: 'w1', status: 'online', counts: { active: 0 } }],
  });
  const legacy = normalizeCapacity({ workers: [{ nodeId: 'w2', status: 'stale', counts: { queued: 2, claimed: 1, running: 0, stale: 1, active: 3 } }] });
  assert.equal(legacy.totals.workers, 1);
  assert.equal(legacy.totals.staleWorkers, 1);
  assert.equal(legacy.totals.queued, 2);
  assert.equal(legacy.items[0].nodeId, 'w2');
});

test('no-live health helper includes parent round metadata for all A2A/A2AD assignments', () => {
  const args = parseArgs([
    '--team', 'team2',
    '--broker-id', 'brokerBeta',
    '--base-url', 'http://127.0.0.1:8787',
    '--a2a-worker', 'workerTheta',
    '--a2ad-workers', 'workerEpsilon,workerZeta,workerEta',
  ]);
  const assignments = buildAssignments(args, 'run-1');
  assert.equal(assignments.length, 4);
  assert.deepEqual(assignments.map((a) => a.worker), ['workerTheta', 'workerEpsilon', 'workerZeta', 'workerEta']);
  for (const [index, assignment] of assignments.entries()) {
    assert.equal(assignment.task.payload.parentRoundId, 'run-1');
    assert.equal(assignment.task.payload.parentRoundTotal, 4);
    assert.equal(assignment.task.payload.parentRoundOrder, index + 1);
    assert.equal(assignment.task.payload.noLive, true);
    assert.equal(assignment.task.payload.sourceOnly, true);
  }
  assert.deepEqual(assignments.slice(1).map((a) => a.task.payload.dialecticRole), ['thesis', 'antithesis', 'synthesis']);
});

test('no-live health helper probes current route first and falls back to legacy admin route', async () => {
  const calls = [];
  const taskStates = new Map();
  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(String(url));
    calls.push({ path: parsed.pathname + parsed.search, method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : undefined });
    if (parsed.pathname === '/workers/capacity') {
      return jsonResponse(200, { totals: { workers: 4, online: 4, active: 0 }, items: [] });
    }
    if (parsed.pathname === '/schedz') {
      return jsonResponse(404, { error: { message: 'not found' } });
    }
    if (parsed.pathname === '/admin/schedz') {
      return jsonResponse(200, { ok: true });
    }
    if (parsed.pathname === '/audit') {
      return jsonResponse(200, { items: [] });
    }
    if (parsed.pathname === '/tasks' && init.method === 'POST') {
      const body = JSON.parse(init.body);
      assert.equal(body.payload.parentRoundTotal, 4);
      taskStates.set(body.id, { ...body, status: 'succeeded', output: { analysisStatus: 'done' } });
      return jsonResponse(201, taskStates.get(body.id));
    }
    if (parsed.pathname.startsWith('/tasks/')) {
      const id = decodeURIComponent(parsed.pathname.slice('/tasks/'.length));
      return jsonResponse(200, taskStates.get(id));
    }
    return jsonResponse(500, { error: { message: `unexpected ${parsed.pathname}` } });
  };

  const result = await runHealthCheck(parseArgs([
    '--team', 'team2',
    '--broker-id', 'brokerBeta',
    '--base-url', 'http://broker.test',
    '--a2a-worker', 'workerTheta',
    '--a2ad-workers', 'workerEpsilon,workerZeta,workerEta',
    '--execute',
    '--poll-ms', '1',
  ]), { fetchImpl, env: {} });

  assert.equal(result.ok, true);
  assert.equal(result.items.length, 4);
  assert.ok(calls.some((call) => call.path === '/schedz'));
  assert.ok(calls.some((call) => call.path === '/admin/schedz'));
});

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return JSON.stringify(body);
    },
  };
}
