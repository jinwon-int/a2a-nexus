import test from 'node:test';
import assert from 'node:assert/strict';
import { EVIDENCE_CLASSES } from './a2ad-finalizer-gate.mjs';
import { evaluateLaneReliabilityLedger, summarizeLaneReliabilityLedger } from './check-lane-reliability-ledger.mjs';

const validLedger = {
  entries: [
    {
      id: 'lr-hermes-analysis-frontier-review-2026-07',
      adapterClass: 'hermes-analysis',
      modelClass: 'frontier',
      taskClass: 'review',
      window: '2026-07',
      dispatchedCount: 4,
      substantiveCount: 2,
      acceptancePassCount: 1,
      acceptanceFailCount: 1,
      reviewPassCount: 1,
      evidenceClassBreakdown: {
        substantive: 2,
        readiness_only: 1,
        provider_or_model_failure: 1,
      },
      sourceRoundIds: ['a2a-nexus-m1-r1'],
    },
  ],
};

test('lane reliability ledger accepts anonymous axes and known finalizer evidence classes', () => {
  assert.deepEqual(evaluateLaneReliabilityLedger(validLedger), []);
  assert.deepEqual(summarizeLaneReliabilityLedger(validLedger), {
    entries: 1,
    dispatchedCount: 4,
    substantiveCount: 2,
    acceptancePassCount: 1,
    acceptanceFailCount: 1,
    reviewPassCount: 1,
    evidenceClassBreakdown: { substantive: 2, readiness_only: 1, provider_or_model_failure: 1 },
  });
});

test('lane reliability evidence taxonomy stays synchronized with finalizer exports', () => {
  for (const required of ['substantive', 'readiness_only', 'generic_ack', 'wrapper_only', 'empty_substantive_output', 'source_projection_payload_dropped', 'provider_or_model_failure', 'failed', 'missing_evidence']) {
    assert.ok(EVIDENCE_CLASSES.includes(required), `${required} must be exported by a2ad-finalizer-gate`);
  }
});

test('lane reliability ledger fails closed for unknown evidence class and invalid count invariants', () => {
  const invalid = structuredClone(validLedger);
  invalid.entries[0].evidenceClassBreakdown.mystery = 1;
  invalid.entries[0].substantiveCount = 5;
  invalid.entries[0].acceptancePassCount = 3;
  invalid.entries[0].acceptanceFailCount = 2;
  invalid.entries[0].reviewPassCount = 9;

  const failures = evaluateLaneReliabilityLedger(invalid);
  assert.ok(failures.some((failure) => failure.includes('mystery')));
  assert.ok(failures.some((failure) => failure.includes('substantiveCount')));
  assert.ok(failures.some((failure) => failure.includes('acceptancePassCount + acceptanceFailCount')));
  assert.ok(failures.some((failure) => failure.includes('reviewPassCount')));
});

test('lane reliability ledger rejects worker/node/url identifiers in anonymous axes', () => {
  const invalid = structuredClone(validLedger);
  invalid.entries[0].adapterClass = 'hermes-analysis-bangtong';
  invalid.entries[0].modelClass = 'https://example.invalid/model';
  invalid.entries[0].taskClass = 'gwakga-review';

  const failures = evaluateLaneReliabilityLedger(invalid);
  assert.ok(failures.some((failure) => failure.includes('adapterClass')));
  assert.ok(failures.some((failure) => failure.includes('modelClass')));
  assert.ok(failures.some((failure) => failure.includes('taskClass')));
});
