import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { evaluateFailingBaseline } from './check-tck-failing-baseline.mjs';

const brokerDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (rel) => JSON.parse(readFileSync(resolve(brokerDir, rel), 'utf8'));

const HISTORY = { measurements: [{ date: '2026-06-11', categories: { jsonrpc: { pass: 12, total: 75 } } }] };

function baseWith(overrides = {}) {
  return {
    schemaVersion: 1,
    provenance: { NOT_a_per_test_run: true },
    coarseBaseline: { pass: 12, total: 75 },
    subCategories: [
      'jsonrpc-error-codes-and-errorinfo',
      'jsonrpc-task-not-found-and-invalid-task',
      'jsonrpc-artifact-message-projection',
      'jsonrpc-streaming-subscribe-ordering',
      'jsonrpc-version-negotiation',
    ].map((id) => ({ id, measuredPassTotal: null, promotionReadiness: 'blocked-pending-fresh-run', sourceKind: 'prose-derived', pendingEmission: true })),
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

test('RED: coarseBaseline that disagrees with tck-history jsonrpc fails', () => {
  const failures = evaluateFailingBaseline(baseWith({ coarseBaseline: { pass: 20, total: 75 } }), HISTORY);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /coarseBaseline \(20\/75\) must match tck-history jsonrpc 12\/75/);
});

test('RED honesty: a sub-category claiming a measured pass/total fails', () => {
  const b = baseWith();
  b.subCategories[0].measuredPassTotal = { pass: 5, total: 10 };
  const failures = evaluateFailingBaseline(b, HISTORY);
  assert.match(failures.join('\n'), /measuredPassTotal must be null until the harness emits per-sub-category granularity/);
});

test('RED: missing the honesty provenance marker fails', () => {
  const failures = evaluateFailingBaseline(baseWith({ provenance: {} }), HISTORY);
  assert.match(failures.join('\n'), /provenance\.NOT_a_per_test_run must be true/);
});

test('RED: a missing required sub-category fails', () => {
  const b = baseWith();
  b.subCategories.pop();
  const failures = evaluateFailingBaseline(b, HISTORY);
  assert.match(failures.join('\n'), /missing required subCategory jsonrpc-version-negotiation/);
});

test('RED: an invalid promotionReadiness value fails', () => {
  const b = baseWith();
  b.subCategories[0].promotionReadiness = 'promoted-now';
  const failures = evaluateFailingBaseline(b, HISTORY);
  assert.match(failures.join('\n'), /invalid promotionReadiness promoted-now/);
});

test('RED provenance: an invalid sourceKind fails', () => {
  const b = baseWith();
  b.subCategories[0].sourceKind = 'vibes';
  assert.match(evaluateFailingBaseline(b, HISTORY).join('\n'), /sourceKind must be one of/);
});

test('RED provenance: a non-official-tck entry with pendingEmission=false fails', () => {
  const b = baseWith();
  b.subCategories[0].pendingEmission = false; // still prose-derived
  assert.match(evaluateFailingBaseline(b, HISTORY).join('\n'), /pendingEmission must stay true until sourceKind is official-tck/);
});

test('RED promotion: promoted without official-tck + emission-complete fails', () => {
  const b = baseWith();
  b.subCategories[0].promotionReadiness = 'promoted';
  assert.match(evaluateFailingBaseline(b, HISTORY).join('\n'), /cannot be 'promoted' without official-tck sourceKind/);
});

test('edge: missing inputs are reported, not thrown', () => {
  assert.deepEqual(evaluateFailingBaseline(null, HISTORY), ['missing docs/tck-failing-categories.json']);
  assert.deepEqual(evaluateFailingBaseline(baseWith(), null), ['missing docs/tck-history.json']);
});
