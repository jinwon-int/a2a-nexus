import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { evaluateScorecard, evaluateScorecardWarnings, FAILURE_CATEGORIES } from './check-round-quality-scorecard.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(repo, 'scripts/check-round-quality-scorecard.mjs');

const VALID_ENTRY = {
  id: 'round-x',
  window: { from: '2026-07-01', to: '2026-07-02' },
  scope: 'test scope',
  metrics: { carryOverCount: 1, falseFindingCount: 0, reworkIssueCount: 2 },
  evidence: ['carry-over: a -> b'],
  recordedAt: '2026-07-02',
};

test('valid entry passes', () => {
  assert.deepEqual(evaluateScorecard({ entries: [VALID_ENTRY] }), []);
});

test('missing required metric, negative count, and bad date fail closed', () => {
  const failures = evaluateScorecard({
    entries: [
      { ...VALID_ENTRY, metrics: { carryOverCount: 1, falseFindingCount: 0 } },
      { ...VALID_ENTRY, id: 'round-y', metrics: { ...VALID_ENTRY.metrics, carryOverCount: -1 } },
      { ...VALID_ENTRY, id: 'round-z', recordedAt: 'yesterday' },
    ],
  });
  assert.ok(failures.some((f) => f.includes('metrics.reworkIssueCount is required')));
  assert.ok(failures.some((f) => f.includes('metrics.carryOverCount must be a non-negative integer')));
  assert.ok(failures.some((f) => f.includes('recordedAt must be YYYY-MM-DD')));
});

test('duplicate ids and empty evidence fail closed', () => {
  const failures = evaluateScorecard({ entries: [VALID_ENTRY, { ...VALID_ENTRY }, { ...VALID_ENTRY, id: 'round-y', evidence: [] }] });
  assert.ok(failures.some((f) => f.includes('duplicate id')));
  assert.ok(failures.some((f) => f.includes('evidence must be a non-empty string array')));
});

test('failureBreakdown accepts known categories with an evidence narrative', () => {
  assert.deepEqual(FAILURE_CATEGORIES, ['spec_ambiguity', 'implementation_defect', 'environment', 'acceptance_misconfigured', 'scope_drift', 'other']);
  const failures = evaluateScorecard({
    entries: [{
      ...VALID_ENTRY,
      failureBreakdown: { implementation_defect: 1, other: 1 },
      evidence: [
        'failure classification: implementation_defect: 1 — lane B patch reverted a guard',
        'failure classification: other: 1 — container image pull flaked once, not reproducible',
      ],
    }],
  });
  assert.deepEqual(failures, []);
});

test('failureBreakdown unknown keys, negative counts, and unevidenced categories fail closed', () => {
  const failures = evaluateScorecard({
    entries: [
      { ...VALID_ENTRY, failureBreakdown: { typo_category: 1 } },
      { ...VALID_ENTRY, id: 'round-y', failureBreakdown: { spec_ambiguity: -5 } },
      { ...VALID_ENTRY, id: 'round-z', failureBreakdown: { environment: 2 }, evidence: ['no classification narrative at all'] },
      { ...VALID_ENTRY, id: 'round-w', failureBreakdown: ['environment'] },
    ],
  });
  assert.ok(failures.some((f) => f.includes('failureBreakdown.typo_category is not a known failure category')));
  assert.ok(failures.some((f) => f.includes('failureBreakdown.spec_ambiguity must be a non-negative integer')));
  assert.ok(failures.some((f) => f.includes('failureBreakdown.environment is counted but no evidence line explains it')));
  assert.ok(failures.some((f) => f.includes('failureBreakdown must be an object mapping failure categories to counts')));
});

test('zero-count categories do not require an evidence narrative', () => {
  assert.deepEqual(evaluateScorecard({ entries: [{ ...VALID_ENTRY, failureBreakdown: { scope_drift: 0 } }] }), []);
});

test('substantive lane metrics require paired non-inverted counts', () => {
  assert.deepEqual(evaluateScorecard({
    entries: [{ ...VALID_ENTRY, metrics: { ...VALID_ENTRY.metrics, substantiveLaneCount: 2, dispatchedLaneCount: 10 } }],
  }), []);
  const failures = evaluateScorecard({
    entries: [
      { ...VALID_ENTRY, metrics: { ...VALID_ENTRY.metrics, substantiveLaneCount: 2 } },
      { ...VALID_ENTRY, id: 'round-y', metrics: { ...VALID_ENTRY.metrics, substantiveLaneCount: 11, dispatchedLaneCount: 10 } },
    ],
  });
  assert.ok(failures.some((f) => f.includes('metrics.dispatchedLaneCount is required')));
  assert.ok(failures.some((f) => f.includes('metrics.substantiveLaneCount must be <= metrics.dispatchedLaneCount')));
});

test('other-majority streak emits a warning without failing the scorecard', () => {
  const doc = { entries: [
    {
      ...VALID_ENTRY,
      id: 'new-other-a',
      failureBreakdown: { other: 3, environment: 1 },
      evidence: [
        'failure classification: other: 3 — no repo-visible failure readback excerpts, so narrower classification is impossible',
        'failure classification: environment: 1 — worker runtime missing binary',
      ],
    },
    {
      ...VALID_ENTRY,
      id: 'new-other-b',
      failureBreakdown: { other: 2 },
      evidence: ['failure classification: other: 2 — no bounded logs surfaced'],
    },
  ] };
  assert.deepEqual(evaluateScorecard(doc), []);
  const warnings = evaluateScorecardWarnings(doc, { otherMajorityWindow: 2 });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /failureBreakdown\.other majority/);
});

test('other-majority warning can ignore legacy baseline entries', () => {
  const doc = { entries: [
    {
      ...VALID_ENTRY,
      id: 'legacy-other-a',
      failureBreakdown: { other: 2 },
      evidence: ['failure classification: other: 2 — legacy no logs'],
    },
    {
      ...VALID_ENTRY,
      id: 'new-other-b',
      failureBreakdown: { other: 2 },
      evidence: ['failure classification: other: 2 — still no logs'],
    },
  ] };
  assert.deepEqual(evaluateScorecardWarnings(doc, {
    otherMajorityWindow: 2,
    ignoreEntryIds: ['legacy-other-a'],
  }), []);
});

test('low substantive-lane ratio streak emits a warning without failing the scorecard', () => {
  const doc = { entries: [
    {
      ...VALID_ENTRY,
      id: 'dialectic-a',
      metrics: { ...VALID_ENTRY.metrics, substantiveLaneCount: 2, dispatchedLaneCount: 10 },
    },
    {
      ...VALID_ENTRY,
      id: 'dialectic-b',
      metrics: { ...VALID_ENTRY.metrics, substantiveLaneCount: 1, dispatchedLaneCount: 4 },
    },
  ] };
  assert.deepEqual(evaluateScorecard(doc), []);
  const warnings = evaluateScorecardWarnings(doc, { substantiveLaneWindow: 2, substantiveLaneThreshold: 0.5 });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /substantive lane ratio below 0\.5/);
});

test('committed baseline scorecard validates and records the 2026-07 track', () => {
  const doc = JSON.parse(fs.readFileSync(path.join(repo, 'docs/ops/round-quality-scorecard.json'), 'utf8'));
  assert.deepEqual(evaluateScorecard(doc), []);
  assert.deepEqual(evaluateScorecardWarnings(doc), []);
  const baseline = doc.entries.find((entry) => entry.id === 'improvement-track-2026-07');
  assert.ok(baseline, 'baseline entry for the 2026-07 improvement track must exist');
  assert.equal(baseline.metrics.carryOverCount, 2);
  assert.equal(baseline.metrics.falseFindingCount, 2);
  const r1 = doc.entries.find((entry) => entry.id === 'a2a-nexus-1219-q2-closeout-2026-07-02');
  assert.ok(r1, 'the r1 acceptance round entry must exist');
  assert.equal(r1.failureBreakdown?.other, 2, 'the two r1 lane failures must carry the retro #1236 classification');
  const v4 = doc.entries.find((entry) => entry.id === 'a2a-nexus-v4-dispatch-wave-20260704');
  assert.ok(v4, 'the V4 dispatch wave entry must exist');
  assert.equal(v4.metrics.substantiveLaneCount, 2);
  assert.equal(v4.metrics.dispatchedLaneCount, 10);
});

test('cli fails closed on a malformed scorecard file', () => {
  const tmp = path.join(fs.mkdtempSync(path.join(repo, 'node_modules/.tmp-scorecard-')), 'bad.json');
  fs.writeFileSync(tmp, JSON.stringify({ entries: [{ id: 'bad' }] }));
  const r = spawnSync(process.execPath, [script], {
    cwd: repo,
    env: { ...process.env, ROUND_QUALITY_SCORECARD: tmp },
    encoding: 'utf8',
  });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /round quality scorecard FAILED/);
});
