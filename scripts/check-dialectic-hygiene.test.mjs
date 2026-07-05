import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateDialecticHygiene } from './check-dialectic-hygiene.mjs';

function dialectic(overrides = {}) {
  return {
    kind: 'decision.dialectic',
    version: 1,
    taskId: 'dd-fixture-1',
    state: 'OPEN',
    meta: {
      topic: 'Evaluate gateway heartbeat polling changes with private details that should be summarized',
      domain: 'ops',
      urgency: 'high',
      openedAt: '2026-07-01T00:00:00.000Z',
      snapshotAt: '2026-07-01T00:01:00.000Z',
      expiresAt: '2026-07-01T01:00:00.000Z',
      openedBy: 'brokeralpha',
    },
    ...overrides,
  };
}

test('dialectic hygiene reports expired non-terminal decision dialectics without mutating state', () => {
  const result = evaluateDialecticHygiene([
    dialectic({ taskId: 'expired-open', state: 'OPEN' }),
    dialectic({ taskId: 'expired-thesis', state: 'THESIS_SUBMITTED' }),
    dialectic({ taskId: 'terminal-expired', state: 'EXPIRED' }),
    dialectic({ taskId: 'future-open', state: 'OPEN', meta: { ...dialectic().meta, expiresAt: '2026-07-03T00:00:00.000Z' } }),
  ], { now: '2026-07-02T00:00:00.000Z' });

  assert.equal(result.skipped, false);
  assert.deepEqual(result.candidates.map((candidate) => candidate.taskId), ['expired-open', 'expired-thesis']);
  assert.deepEqual(result.candidates.map((candidate) => candidate.recommendedTransition), ['EXPIRED', 'EXPIRED']);
  assert.equal(result.candidates[0].state, 'OPEN');
  assert.match(result.candidates[0].topic, /Evaluate gateway heartbeat/);
  assert.ok(result.candidates[0].topic.length <= 120);
});

test('dialectic hygiene skip reason is explicit when no read-model records are available', () => {
  const result = evaluateDialecticHygiene(null, { now: '2026-07-02T00:00:00.000Z' });
  assert.equal(result.skipped, true);
  assert.match(result.reason, /no dialectic records/i);
  assert.deepEqual(result.candidates, []);
});

test('dialectic hygiene rejects malformed expiresAt instead of silently passing', () => {
  assert.throws(
    () => evaluateDialecticHygiene([dialectic({ taskId: 'bad-date', meta: { ...dialectic().meta, expiresAt: 'not-a-date' } })], { now: '2026-07-02T00:00:00.000Z' }),
    /invalid expiresAt/,
  );
});
