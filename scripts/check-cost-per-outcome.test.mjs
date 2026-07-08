// #1303 M5-a cost-per-outcome gate tests: fail-closed schema, currency-marker
// rejection (normalized units only — real prices never enter the repo),
// derived costPerAccepted consistency with the divide-by-zero marker, M1
// anonymity axis guard, and ledger-alignment warnings.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  evaluateCostPerOutcome,
  evaluateLedgerAlignmentWarnings,
  derivedCostPerAccepted,
  NO_ACCEPTED_MARKER,
} from './check-cost-per-outcome.mjs';

function entry(overrides = {}) {
  return {
    id: 'cpo-hermes-analysis-mixed-review-2026-07',
    adapterClass: 'hermes-analysis',
    modelClass: 'mixed',
    taskClass: 'review',
    window: '2026-07',
    costUnitsSpent: 12.5,
    acceptedCount: 5,
    dispatchedCount: 10,
    costPerAccepted: 2.5,
    sourceEntryIds: ['lr-1'],
    ...overrides,
  };
}

test('a well-formed metric passes and zero-accepted uses the marker', () => {
  assert.deepEqual(evaluateCostPerOutcome({ entries: [entry()] }), []);
  const zero = entry({ acceptedCount: 0, costPerAccepted: NO_ACCEPTED_MARKER });
  assert.deepEqual(evaluateCostPerOutcome({ entries: [zero] }), []);
  assert.equal(derivedCostPerAccepted(10, 0), NO_ACCEPTED_MARKER);
  assert.equal(derivedCostPerAccepted(10, 4), 2.5);
});

test('fail-closed: negative cost, accepted > dispatched, unknown fields, duplicate ids', () => {
  const failures = evaluateCostPerOutcome({
    entries: [
      entry({ costUnitsSpent: -1 }),
      entry({ id: 'cpo-2', acceptedCount: 11 }),
      entry({ id: 'cpo-3', surprise: 1 }),
      entry(),
    ],
  });
  assert.ok(failures.some((f) => /costUnitsSpent must be a non-negative/.test(f)), failures.join('; '));
  assert.ok(failures.some((f) => /acceptedCount must be <= dispatchedCount/.test(f)));
  assert.ok(failures.some((f) => /unknown field 'surprise'/.test(f)));
  assert.ok(failures.some((f) => /duplicate id/.test(f)));
});

test('real-currency markers are rejected anywhere in an entry (normalized units only)', () => {
  for (const poisoned of [
    entry({ id: 'cpo-a', window: '2026-07', taskClass: 'review $12' }),
    entry({ id: 'cpo-b', sourceEntryIds: ['spent 4 USD on this'] }),
    entry({ id: 'cpo-c', modelClass: 'mixed-₩900' }),
  ]) {
    const failures = evaluateCostPerOutcome({ entries: [poisoned] });
    assert.ok(failures.some((f) => /real-currency marker/.test(f)), `expected currency rejection: ${JSON.stringify(poisoned)}`);
  }
});

test('divide-by-zero must never hide: numeric costPerAccepted with zero accepted fails', () => {
  const failures = evaluateCostPerOutcome({ entries: [entry({ acceptedCount: 0, costPerAccepted: 0 })] });
  assert.ok(failures.some((f) => f.includes(NO_ACCEPTED_MARKER)), failures.join('; '));
  const stale = evaluateCostPerOutcome({ entries: [entry({ costPerAccepted: 9.99 })] });
  assert.ok(stale.some((f) => /costPerAccepted must be/.test(f)), 'derived value drift must fail');
});

test('axes inherit the M1 anonymity guard', () => {
  const failures = evaluateCostPerOutcome({ entries: [entry({ adapterClass: 'worker-alpha7' })] });
  assert.ok(failures.some((f) => /anonymous class/.test(f)), failures.join('; '));
});

test('axis combinations absent from the M1 ledger warn, never silently pass', () => {
  const ledger = {
    entries: [
      { id: 'lr-1', adapterClass: 'hermes-analysis', modelClass: 'mixed', taskClass: 'review', window: '2026-07' },
      // A correction supersedes lr-1 on a DIFFERENT axis; the original axis
      // must no longer count as ledger-backed.
      { id: 'lr-2', supersedes: 'lr-1', adapterClass: 'hermes-analysis', modelClass: 'mixed', taskClass: 'review', window: '2026-08' },
    ],
  };
  const aligned = evaluateLedgerAlignmentWarnings({ entries: [entry({ window: '2026-08' })] }, ledger);
  assert.deepEqual(aligned, []);
  const drifted = evaluateLedgerAlignmentWarnings({ entries: [entry()] }, ledger);
  assert.equal(drifted.length, 1);
  assert.match(drifted[0], /no matching M1 ledger row/);
});
