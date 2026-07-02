import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyQueuedTasks, classifyTerminalOutboxDiagnostics, parseArgs, runReport } from './a2a-readonly-broker-residue-report.mjs';

const nowMs = Date.parse('2026-06-26T12:00:00.000Z');

test('residue report classifies stale Team2-ish queued rows on Team1 as read-only capacity noise', () => {
  const args = parseArgs([
    '--base-url', 'http://broker.test',
    '--broker-id', 'brokerAlpha',
    '--official-team', 'team1',
    '--official-workers', 'workerGamma,workerAlpha,workerBeta,workerDelta,mobileAlpha',
    '--team2-workers', 'workerEpsilon,workerZeta,workerEta,mobileBeta,workerTheta',
  ]);
  const result = classifyQueuedTasks([
    { id: 'task-1', status: 'queued', assignedWorkerId: 'workerEpsilon', updatedAt: '2026-06-10T00:00:00.000Z', taskOrigin: 'operator', payload: { originBrokerId: 'brokerAlpha' } },
    { id: 'task-2', status: 'queued', targetNodeId: 'workerEta', updatedAt: '2026-06-20T00:00:00.000Z', payload: { teamScope: 'team2' } },
    { id: 'task-3', status: 'queued', assignedWorkerId: 'workerGamma', updatedAt: '2026-06-26T11:00:00.000Z' },
  ], args, nowMs);
  assert.equal(result.total, 3);
  assert.equal(result.crossTeamSuspect, 2);
  assert.equal(result.byWorker.workerEpsilon, 1);
  assert.equal(result.byAgeBucket['>=14d'], 1);
  assert.equal(result.mutationPlan.allowedNow, false);
  assert.match(result.mutationPlan.reason, /explicit follow-up approval/);
});

test('residue report classifies old ack-eligible terminal outbox as actionable review, not ACK approval', () => {
  const result = classifyTerminalOutboxDiagnostics({
    total: 633,
    rawUnacked: 403,
    ackEligibleUnacked: 265,
    ackIneligibleUnacked: 138,
    oldestUnackedCreatedAt: '2026-06-13T12:00:00.000Z',
    warnings: ['oldest unacked terminal outbox entry is 13 days old'],
  }, nowMs);
  assert.equal(result.classification, 'actionable-review-required');
  assert.equal(result.ageBucket, '7-14d');
  assert.match(result.safeNextStep, /do not ACK\/replay\/prune without explicit approval/);
});

test('residue report fetches read-only live shapes and never emits mutation authorization', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    const parsed = new URL(String(url));
    calls.push(parsed.pathname + parsed.search);
    if (parsed.pathname === '/workers/capacity') {
      return jsonResponse(200, { totals: { queued: 8 }, items: [{ nodeId: 'workerEpsilon', status: 'stale', counts: { queued: 7 } }] });
    }
    if (parsed.pathname === '/tasks') {
      return jsonResponse(200, { items: [{ id: 'queued-1', status: 'queued', assignedWorkerId: 'workerEpsilon', updatedAt: '2026-06-01T00:00:00.000Z' }] });
    }
    if (parsed.pathname === '/health') {
      return jsonResponse(200, { persistence: { terminalOutboxDiagnostics: { total: 1, rawUnacked: 1, ackEligibleUnacked: 1, oldestUnackedCreatedAt: '2026-06-01T00:00:00.000Z' } } });
    }
    if (parsed.pathname === '/admin/cleanup/dry-run') {
      return jsonResponse(404, { error: { message: 'not found' } });
    }
    if (parsed.pathname === '/cleanup/dry-run') {
      return jsonResponse(200, { totalCandidates: 1, summary: { queued_residue: 1 } });
    }
    return jsonResponse(500, { error: { message: `unexpected ${parsed.pathname}` } });
  };
  const report = await runReport(parseArgs([
    '--base-url', 'http://broker.test',
    '--broker-id', 'brokerAlpha',
    '--official-team', 'team1',
    '--official-workers', 'workerGamma,workerAlpha,workerBeta,workerDelta,mobileAlpha',
  ]), { fetchImpl, env: {} });
  assert.equal(report.safety.readOnly, true);
  assert.equal(report.safety.mutationsPerformed, false);
  assert.equal(report.queuedResidue.crossTeamSuspect, 1);
  assert.equal(report.terminalOutbox.classification, 'actionable-review-required');
  assert.ok(calls.some((path) => path.startsWith('/tasks?status=queued')));
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
