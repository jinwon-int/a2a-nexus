import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { evaluateFailingBaseline } from './check-tck-failing-baseline.mjs';

const brokerDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (rel) => JSON.parse(readFileSync(resolve(brokerDir, rel), 'utf8'));

const MUST_MEASUREMENT = {
  date: '2026-06-11',
  level: 'must',
  transport: 'jsonrpc',
  categories: { jsonrpc: { pass: 12, total: 75 } },
};
const HISTORY = { measurements: [MUST_MEASUREMENT] };

function coarse(overrides = {}) {
  return { category: 'jsonrpc', level: 'must', transport: 'jsonrpc', date: '2026-06-11', pass: 12, total: 75, ...overrides };
}

function baseWith(overrides = {}) {
  return {
    schemaVersion: 1,
    provenance: { NOT_a_per_test_run: true },
    coarseBaseline: coarse(),
    subCategories: [
      'jsonrpc-error-codes-and-errorinfo',
      'jsonrpc-task-not-found-and-invalid-task',
      'jsonrpc-artifact-message-projection',
      'jsonrpc-streaming-subscribe-ordering',
      'jsonrpc-version-negotiation',
    ].map((id, index) => ({
      id,
      pytestNodeIdSelectors: [`tests/compatibility/jsonrpc/test_synthetic.py::test_category_${index}`],
      measuredPassTotal: null,
      promotionReadiness: 'blocked-pending-fresh-run',
      sourceKind: 'prose-derived',
      pendingEmission: true,
    })),
    ...overrides,
  };
}

test('GREEN: the committed docs/tck-failing-categories.json passes against committed history', () => {
  const baseline = readJson('docs/tck-failing-categories.json');
  const history = readJson('docs/tck-history.json');
  assert.deepEqual(evaluateFailingBaseline(baseline, history), []);
});

test('GREEN: a well-formed synthetic baseline passes', () => {
  assert.deepEqual(evaluateFailingBaseline(baseWith(), HISTORY), []);
});

// ── coarse-baseline anchoring (review issue 2) ──────────────────────────────

test('RED: coarseBaseline pass/total disagreeing with the anchored measurement fails', () => {
  const failures = evaluateFailingBaseline(baseWith({ coarseBaseline: coarse({ pass: 20 }) }), HISTORY);
  assert.match(failures.join('\n'), /coarseBaseline \(20\/75\) must match the anchored must\/jsonrpc measurement 12\/75/);
});

test('RED: a coarseBaseline date that matches no measurement fails (stale/mis-anchored date)', () => {
  const failures = evaluateFailingBaseline(baseWith({ coarseBaseline: coarse({ date: '2099-12-31' }) }), HISTORY);
  assert.match(failures.join('\n'), /finds no tck-history measurement at date 2099-12-31 level must transport jsonrpc/);
});

test('GREEN: an unrelated should/jsonrpc row does NOT re-anchor the MUST baseline', () => {
  const history = {
    measurements: [
      MUST_MEASUREMENT,
      { date: '2026-06-11', level: 'should', transport: 'jsonrpc', categories: { jsonrpc: { pass: 1, total: 5 } } },
    ],
  };
  assert.deepEqual(evaluateFailingBaseline(baseWith(), history), []);
});

test('RED: a coarseBaseline missing level/transport pinning fails', () => {
  const failures = evaluateFailingBaseline(baseWith({ coarseBaseline: { category: 'jsonrpc', date: '2026-06-11', pass: 12, total: 75 } }), HISTORY);
  assert.match(failures.join('\n'), /coarseBaseline must pin \{ category:"jsonrpc", level:"must", transport:"jsonrpc", date, pass, total \}/);
});

// ── emission-state transition (review issues 1 & 3) ─────────────────────────

test('RED: a missing (non-boolean) pendingEmission fails', () => {
  const b = baseWith();
  delete b.subCategories[0].pendingEmission;
  assert.match(evaluateFailingBaseline(b, HISTORY).join('\n'), /pendingEmission must be an explicit boolean/);
});

test('RED: pendingEmission=true with a measured pass/total fails (no unmeasured conformance)', () => {
  const b = baseWith();
  b.subCategories[0].measuredPassTotal = { pass: 5, total: 10 };
  assert.match(evaluateFailingBaseline(b, HISTORY).join('\n'), /pendingEmission=true requires measuredPassTotal=null/);
});

test('RED: pendingEmission=false but sourceKind not official-tck fails', () => {
  const b = baseWith();
  b.subCategories[0].pendingEmission = false; // still prose-derived, no measured
  assert.match(evaluateFailingBaseline(b, HISTORY).join('\n'), /pendingEmission=false requires sourceKind=official-tck/);
});

test('RED: pendingEmission=false without a measuredPassTotal fails', () => {
  const b = baseWith();
  b.subCategories[0].sourceKind = 'official-tck';
  b.subCategories[0].pendingEmission = false; // official-tck but no measured record
  assert.match(evaluateFailingBaseline(b, HISTORY).join('\n'), /pendingEmission=false requires a measuredPassTotal \{pass,total\}/);
});

test('GREEN: the supported emission-complete representation passes', () => {
  const b = baseWith();
  b.subCategories[0] = {
    ...b.subCategories[0],
    sourceKind: 'official-tck',
    pendingEmission: false,
    measuredPassTotal: { pass: 8, total: 8 },
    promotionReadiness: 'candidate-pending-fresh-run',
  };
  assert.deepEqual(evaluateFailingBaseline(b, HISTORY), []);
});

test('GREEN: a promoted sub-category is allowed only from the emission-complete state', () => {
  const b = baseWith();
  b.subCategories[0] = {
    ...b.subCategories[0],
    sourceKind: 'official-tck',
    pendingEmission: false,
    measuredPassTotal: { pass: 8, total: 8 },
    promotionReadiness: 'promoted',
  };
  assert.deepEqual(evaluateFailingBaseline(b, HISTORY), []);
});

test('RED: promoted while pendingEmission=true fails (cannot promote unmeasured)', () => {
  const b = baseWith();
  b.subCategories[0].promotionReadiness = 'promoted'; // still pendingEmission=true, prose-derived
  const msg = evaluateFailingBaseline(b, HISTORY).join('\n');
  assert.match(msg, /cannot be 'promoted' while pendingEmission=true/);
  assert.match(msg, /'promoted' requires sourceKind=official-tck, pendingEmission=false, and a measuredPassTotal/);
});

test('RED: promoted + official-tck but pendingEmission missing fails (issue 1 bypass closed)', () => {
  const b = baseWith();
  b.subCategories[0].sourceKind = 'official-tck';
  b.subCategories[0].measuredPassTotal = { pass: 8, total: 8 };
  b.subCategories[0].promotionReadiness = 'promoted';
  delete b.subCategories[0].pendingEmission; // the exact bypass the review flagged
  const msg = evaluateFailingBaseline(b, HISTORY).join('\n');
  assert.match(msg, /pendingEmission must be an explicit boolean/);
  assert.match(msg, /'promoted' requires sourceKind=official-tck, pendingEmission=false, and a measuredPassTotal/);
});

// ── shape / provenance guards ───────────────────────────────────────────────

test('RED: missing the honesty provenance marker fails', () => {
  assert.match(evaluateFailingBaseline(baseWith({ provenance: {} }), HISTORY).join('\n'), /provenance\.NOT_a_per_test_run must be an explicit boolean/);
});

test('RED: a per-test measuredPassTotal must match the anchored history row', () => {
  const baseline = readJson('docs/tck-failing-categories.json');
  const history = readJson('docs/tck-history.json');
  baseline.subCategories[0].measuredPassTotal.pass += 1;
  assert.match(
    evaluateFailingBaseline(baseline, history).join('\n'),
    /measuredPassTotal \(7\/13\) must match anchored history 6\/13/,
  );
});

test('RED: a per-test baseline requires sufficient outcome accounting', () => {
  const baseline = readJson('docs/tck-failing-categories.json');
  const history = readJson('docs/tck-history.json');
  history.measurements.at(-1).pytestOutcomeAccounting.sufficientForMeasurement = false;
  assert.match(
    evaluateFailingBaseline(baseline, history).join('\n'),
    /per-test baseline requires sufficientForMeasurement=true/,
  );
});

test('RED: a per-test baseline cannot leave a sub-category pending emission', () => {
  const baseline = readJson('docs/tck-failing-categories.json');
  const history = readJson('docs/tck-history.json');
  baseline.subCategories[0].pendingEmission = true;
  baseline.subCategories[0].sourceKind = 'code-derived';
  baseline.subCategories[0].measuredPassTotal = null;
  assert.match(
    evaluateFailingBaseline(baseline, history).join('\n'),
    /per-test baseline requires every subCategory to be emission-complete/,
  );
});

test('RED: a missing required sub-category fails', () => {
  const b = baseWith();
  b.subCategories.pop();
  assert.match(evaluateFailingBaseline(b, HISTORY).join('\n'), /missing required subCategory jsonrpc-version-negotiation/);
});

test('RED: an invalid promotionReadiness value fails', () => {
  const b = baseWith();
  b.subCategories[0].promotionReadiness = 'promoted-now';
  assert.match(evaluateFailingBaseline(b, HISTORY).join('\n'), /invalid promotionReadiness promoted-now/);
});

test('RED: an invalid sourceKind fails', () => {
  const b = baseWith();
  b.subCategories[0].sourceKind = 'vibes';
  assert.match(evaluateFailingBaseline(b, HISTORY).join('\n'), /sourceKind must be one of/);
});

test('RED: missing pytest node-id selectors fails', () => {
  const b = baseWith();
  delete b.subCategories[0].pytestNodeIdSelectors;
  assert.match(evaluateFailingBaseline(b, HISTORY).join('\n'), /needs non-empty pytestNodeIdSelectors/);
});

test('RED: selectors that can classify one node into two categories fail', () => {
  const b = baseWith();
  b.subCategories[0].pytestNodeIdSelectors = ['tests/compatibility/jsonrpc/test_overlap.py::TestErrors::test_task'];
  b.subCategories[1].pytestNodeIdSelectors = ['tests/compatibility/jsonrpc/test_overlap.py::TestErrors::test_task'];
  assert.match(evaluateFailingBaseline(b, HISTORY).join('\n'), /selectors overlap across/);
});

test('edge: missing inputs are reported, not thrown', () => {
  assert.deepEqual(evaluateFailingBaseline(null, HISTORY), ['missing docs/tck-failing-categories.json']);
  assert.deepEqual(evaluateFailingBaseline(baseWith(), null), ['missing docs/tck-history.json']);
});
