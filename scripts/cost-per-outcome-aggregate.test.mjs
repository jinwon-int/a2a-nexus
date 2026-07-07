// #1303 M5-b join CLI tests: operator cost inputs × effective M1 ledger rows
// (supersedes-aware) → metric entries with derived costPerAccepted, explicit
// unmatched reporting, gate-checked output, and idempotent re-runs.
import test from 'node:test';
import assert from 'node:assert/strict';

import { aggregateCostPerOutcome } from './cost-per-outcome-aggregate.mjs';
import { evaluateCostPerOutcome, NO_ACCEPTED_MARKER } from './check-cost-per-outcome.mjs';

const LEDGER = {
  entries: [
    {
      id: 'lr-old',
      adapterClass: 'hermes-analysis',
      modelClass: 'mixed',
      taskClass: 'review',
      window: '2026-07',
      dispatchedCount: 10,
      acceptancePassCount: 1,
    },
    {
      // Correction: replaces lr-old before any aggregation (M1 semantics).
      id: 'lr-corrected',
      supersedes: 'lr-old',
      adapterClass: 'hermes-analysis',
      modelClass: 'mixed',
      taskClass: 'review',
      window: '2026-07',
      dispatchedCount: 10,
      acceptancePassCount: 4,
    },
    {
      id: 'lr-zero-accepted',
      adapterClass: 'source-only',
      modelClass: 'none',
      taskClass: 'review',
      window: '2026-07',
      dispatchedCount: 3,
      acceptancePassCount: 0,
    },
  ],
};

function costs(entries) {
  return { entries };
}

test('join uses effective (corrected) ledger rows and derives costPerAccepted', () => {
  const { doc, unmatched } = aggregateCostPerOutcome({
    costs: costs([{ adapterClass: 'hermes-analysis', modelClass: 'mixed', taskClass: 'review', window: '2026-07', costUnitsSpent: 10 }]),
    ledger: LEDGER,
    existing: { entries: [] },
  });
  assert.deepEqual(unmatched, []);
  assert.equal(doc.entries.length, 1);
  const joined = doc.entries[0];
  assert.equal(joined.acceptedCount, 4, 'the superseded row (acceptancePassCount 1) must not leak into the join');
  assert.equal(joined.dispatchedCount, 10);
  assert.equal(joined.costPerAccepted, 2.5);
  assert.deepEqual(joined.sourceEntryIds, ['lr-corrected']);
  assert.deepEqual(evaluateCostPerOutcome(doc), [], 'the join must always satisfy the gate');
});

test('zero-accepted axes produce the marker, never a division result', () => {
  const { doc } = aggregateCostPerOutcome({
    costs: costs([{ adapterClass: 'source-only', modelClass: 'none', taskClass: 'review', window: '2026-07', costUnitsSpent: 3 }]),
    ledger: LEDGER,
    existing: { entries: [] },
  });
  assert.equal(doc.entries[0].costPerAccepted, NO_ACCEPTED_MARKER);
});

test('cost inputs without a ledger row land in unmatched, not in the metric file', () => {
  const { doc, unmatched } = aggregateCostPerOutcome({
    costs: costs([{ adapterClass: 'vps-claude', modelClass: 'sonnet-class', taskClass: 'implement', window: '2026-07', costUnitsSpent: 7 }]),
    ledger: LEDGER,
    existing: { entries: [] },
  });
  assert.equal(doc.entries.length, 0);
  assert.equal(unmatched.length, 1);
  assert.equal(unmatched[0].adapterClass, 'vps-claude');
});

test('idempotent: re-running the same join yields a byte-identical document', () => {
  const input = {
    costs: costs([
      { adapterClass: 'hermes-analysis', modelClass: 'mixed', taskClass: 'review', window: '2026-07', costUnitsSpent: 10 },
      { adapterClass: 'source-only', modelClass: 'none', taskClass: 'review', window: '2026-07', costUnitsSpent: 3 },
    ]),
    ledger: LEDGER,
  };
  const first = aggregateCostPerOutcome({ ...input, existing: { entries: [] } });
  const second = aggregateCostPerOutcome({ ...input, existing: first.doc });
  assert.equal(JSON.stringify(second.doc), JSON.stringify(first.doc));
});

test('merge preserves untouched existing entries and replaces re-joined axes', () => {
  const existing = {
    entries: [{
      id: 'cpo-untouched-axis',
      adapterClass: 'other-class',
      modelClass: 'none',
      taskClass: 'review',
      window: '2026-06',
      costUnitsSpent: 1,
      acceptedCount: 1,
      dispatchedCount: 1,
      costPerAccepted: 1,
    }],
  };
  const { doc } = aggregateCostPerOutcome({
    costs: costs([{ adapterClass: 'hermes-analysis', modelClass: 'mixed', taskClass: 'review', window: '2026-07', costUnitsSpent: 20 }]),
    ledger: LEDGER,
    existing,
  });
  assert.equal(doc.entries.length, 2);
  assert.ok(doc.entries.some((entry) => entry.id === 'cpo-untouched-axis'));
  assert.equal(doc.entries.find((entry) => entry.id !== 'cpo-untouched-axis').costPerAccepted, 5);
});
