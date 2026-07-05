import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateDecisionQualityLedger, summarizeDecisionQualityLedger } from './check-decision-quality-ledger.mjs';

const validLedger = {
  entries: [
    {
      id: 'dql-20260705-da3-001',
      dialecticId: 'dd-task-01',
      scope: 'DA3 decision quality seed',
      topic: 'gateway heartbeat polling',
      verdict: 'PROCEED_WITH_GUARDRAILS',
      outcomeRecorded: true,
      outcomeMatchedVerdict: 'partial',
      recordedAt: '2026-07-05',
      evidenceRefs: ['gh:jinwon-int/a2a-nexus#1295'],
      notes: 'Outcome partially matched the guardrailed decision; finalizer recorded the judgment.',
      confidence: { thesis: 0.72, antithesis: 0.64, minimum: 0.64 },
    },
    {
      id: 'dql-20260705-da3-002',
      dialecticId: 'dd-task-02',
      scope: 'DA3 decision quality seed',
      topic: 'expired dialectic cleanup',
      verdict: 'WAIT',
      outcomeRecorded: false,
      outcomeMatchedVerdict: 'pending',
      recordedAt: '2026-07-05',
      evidenceRefs: ['gh:jinwon-int/a2a-nexus#1295'],
      notes: 'Pending operator/finalizer outcome judgment.',
    },
  ],
};

test('decision quality ledger accepts valid closed verdict/outcome taxonomy and summarizes counts', () => {
  assert.deepEqual(evaluateDecisionQualityLedger(validLedger), []);
  assert.deepEqual(summarizeDecisionQualityLedger(validLedger), {
    entries: 2,
    verdicts: { PROCEED_WITH_GUARDRAILS: 1, WAIT: 1 },
    outcomeMatchedVerdict: { partial: 1, pending: 1 },
    outcomeRecorded: { true: 1, false: 1 },
  });
});

test('decision quality ledger fails closed for unknown verdict, invalid outcome match, duplicate id, and bad confidence', () => {
  const invalid = structuredClone(validLedger);
  invalid.entries[1].id = invalid.entries[0].id;
  invalid.entries[0].verdict = 'APPROVE';
  invalid.entries[0].outcomeMatchedVerdict = 'maybe';
  invalid.entries[0].confidence.thesis = 1.5;

  const failures = evaluateDecisionQualityLedger(invalid);
  assert.ok(failures.some((failure) => failure.includes('verdict')));
  assert.ok(failures.some((failure) => failure.includes('outcomeMatchedVerdict')));
  assert.ok(failures.some((failure) => failure.includes('duplicate id')));
  assert.ok(failures.some((failure) => failure.includes('confidence.thesis')));
});

test('decision quality ledger requires human/finalizer evidence and notes for oracle independence', () => {
  const invalid = { entries: [{ id: 'dql-empty', verdict: 'VETO', outcomeRecorded: true, outcomeMatchedVerdict: 'yes' }] };
  const failures = evaluateDecisionQualityLedger(invalid);
  assert.ok(failures.some((failure) => failure.includes('evidenceRefs')));
  assert.ok(failures.some((failure) => failure.includes('notes')));
  assert.ok(failures.some((failure) => failure.includes('topic')));
});
