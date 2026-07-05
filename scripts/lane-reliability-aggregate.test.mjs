import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateLaneReliability } from './lane-reliability-aggregate.mjs';
import { evaluateLaneReliabilityLedger } from './check-lane-reliability-ledger.mjs';

const tasks = [
  {
    id: 'round-1:lane-a',
    status: 'succeeded',
    parentRoundId: 'round-1',
    output: {
      evidenceClass: 'substantive',
      validations: [
        { kind: 'acceptance', verdict: 'pass' },
        { kind: 'review', verdict: 'pass' },
      ],
    },
  },
  {
    id: 'round-1:lane-b',
    status: 'succeeded',
    parentRoundId: 'round-1',
    output: {
      evidenceClass: 'readiness_only',
      validations: [{ kind: 'acceptance', verdict: 'fail' }],
    },
  },
  {
    id: 'round-1:lane-c',
    status: 'failed',
    parentRoundId: 'round-1',
    output: { evidenceClass: 'provider_or_model_failure' },
  },
];

test('lane reliability aggregate merges finalizer readback into one anonymous ledger entry', () => {
  const ledger = aggregateLaneReliability({
    ledger: { entries: [] },
    tasks,
    adapterClass: 'hermes-analysis',
    modelClass: 'frontier',
    taskClass: 'review',
    window: '2026-07',
  });
  assert.deepEqual(evaluateLaneReliabilityLedger(ledger), []);
  assert.equal(ledger.entries.length, 1);
  assert.deepEqual(ledger.entries[0], {
    id: 'lr-hermes-analysis-frontier-review-2026-07',
    adapterClass: 'hermes-analysis',
    modelClass: 'frontier',
    taskClass: 'review',
    window: '2026-07',
    dispatchedCount: 3,
    substantiveCount: 1,
    acceptancePassCount: 1,
    acceptanceFailCount: 1,
    reviewPassCount: 1,
    evidenceClassBreakdown: {
      substantive: 1,
      readiness_only: 1,
      provider_or_model_failure: 1,
    },
    sourceRoundIds: ['round-1'],
  });
});

test('lane reliability aggregate is idempotent for an already-counted source round', () => {
  const once = aggregateLaneReliability({ ledger: { entries: [] }, tasks, adapterClass: 'hermes-analysis', modelClass: 'frontier', taskClass: 'review', window: '2026-07' });
  const twice = aggregateLaneReliability({ ledger: once, tasks, adapterClass: 'hermes-analysis', modelClass: 'frontier', taskClass: 'review', window: '2026-07' });
  assert.deepEqual(twice, once);
});

test('lane reliability aggregate fails closed on unknown or missing evidence classes before writing a misleading ledger', () => {
  assert.throws(() => aggregateLaneReliability({
    ledger: { entries: [] },
    tasks: [{ id: 'round-2:lane-a', parentRoundId: 'round-2', output: { evidenceClass: 'mystery' } }],
    adapterClass: 'hermes-analysis',
    modelClass: 'frontier',
    taskClass: 'review',
    window: '2026-07',
  }), /unknown evidence class/);
  assert.throws(() => aggregateLaneReliability({
    ledger: { entries: [] },
    tasks: [{ id: 'round-2:lane-b', parentRoundId: 'round-2', status: 'succeeded' }],
    adapterClass: 'hermes-analysis',
    modelClass: 'frontier',
    taskClass: 'review',
    window: '2026-07',
  }), /missing evidence class/);
});
