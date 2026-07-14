import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  FLOOR_SCHEMA,
  classifyFile,
  countUnsafeSuppressions,
  evaluateFloor,
} from './check-source-quality-floors.mjs';

test('classifyFile buckets source vs test/generated/archive/other', () => {
  assert.equal(classifyFile('packages/broker/src/core/policy.ts'), 'source');
  assert.equal(classifyFile('packages/broker/src/core/policy.test.ts'), 'test');
  assert.equal(classifyFile('packages/broker/dist/core/policy.js'), 'generated');
  assert.equal(classifyFile('packages/broker/src/build-info.json'), 'generated');
  assert.equal(classifyFile('docs/history/archive/old.ts'), 'archive');
  assert.equal(classifyFile('scripts/check-source-quality-floors.mjs'), 'other');
  // Non-src .ts is not source (suppressions only enforced in the src bundle).
  assert.equal(classifyFile('packages/broker/tools/gen.ts'), 'other');
});

test('countUnsafeSuppressions counts @ts-ignore / @ts-nocheck / eslint-disable', () => {
  const text = [
    'const a = 1;',
    '// @ts-ignore because reasons',
    '/* @ts-nocheck */',
    'foo(); // eslint-disable-line no-console',
    '/* eslint-disable */',
    'bar();',
  ].join('\n');
  assert.equal(countUnsafeSuppressions(text), 4);
});

test('countUnsafeSuppressions flags bare @ts-expect-error but allows explained ones', () => {
  assert.equal(countUnsafeSuppressions('// @ts-expect-error'), 1);
  assert.equal(countUnsafeSuppressions('// @ts-expect-error   '), 1);
  assert.equal(countUnsafeSuppressions('// @ts-expect-error: '), 1);
  // Explained forms are the SAFE alternative and must not count.
  assert.equal(countUnsafeSuppressions('// @ts-expect-error upstream types are wrong'), 0);
  assert.equal(countUnsafeSuppressions('// @ts-expect-error: legacy API shape'), 0);
});

test('countUnsafeSuppressions returns 0 for clean source', () => {
  assert.equal(countUnsafeSuppressions('export const x: number = 1;\nfunction f() { return x; }'), 0);
});

const MANIFEST_AT_ZERO = {
  $schema: FLOOR_SCHEMA,
  floors: { unsafeSuppressions: { max: 0 } },
};

test('evaluateFloor passes when measured equals the floor', () => {
  assert.deepEqual(evaluateFloor(0, MANIFEST_AT_ZERO), { ok: true, failures: [] });
  assert.deepEqual(evaluateFloor(3, { $schema: FLOOR_SCHEMA, floors: { unsafeSuppressions: { max: 3 } } }), {
    ok: true,
    failures: [],
  });
});

test('evaluateFloor fails closed when measured exceeds the floor', () => {
  const result = evaluateFloor(1, MANIFEST_AT_ZERO);
  assert.equal(result.ok, false);
  assert.match(result.failures[0], /exceeds floor 0/);
});

test('evaluateFloor demands a ratchet-down when measured drops below the floor', () => {
  const result = evaluateFloor(1, { $schema: FLOOR_SCHEMA, floors: { unsafeSuppressions: { max: 3 } } });
  assert.equal(result.ok, false);
  assert.match(result.failures[0], /Ratchet the floor down/);
});

test('evaluateFloor fails closed on a malformed or wrong-schema manifest', () => {
  assert.equal(evaluateFloor(0, null).ok, false);
  assert.equal(evaluateFloor(0, {}).ok, false);
  assert.equal(evaluateFloor(0, { $schema: 'wrong', floors: { unsafeSuppressions: { max: 0 } } }).ok, false);
  assert.equal(evaluateFloor(0, { $schema: FLOOR_SCHEMA, floors: {} }).ok, false);
  assert.equal(
    evaluateFloor(0, { $schema: FLOOR_SCHEMA, floors: { unsafeSuppressions: { max: -1 } } }).ok,
    false,
  );
});
