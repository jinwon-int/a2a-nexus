import test from 'node:test';
import assert from 'node:assert/strict';

import { evaluateCurrentStateDrift } from './check-current-state-drift.mjs';

const SNAPSHOT = { issues: [{ number: 553, state: 'closed', closedAt: '2026-06-11' }] };

test('RED: a snapshot-closed issue framed as "Active coordination:" header fails', () => {
  const text = [
    '# A2A current state',
    '',
    '> **Active coordination:** [a2a-nexus#553](https://github.com/jinwon-int/a2a-nexus/issues/553)',
    '',
    'Body.',
  ].join('\n');
  const failures = evaluateCurrentStateDrift(text, SNAPSHOT);
  assert.ok(failures.length >= 1);
  assert.match(failures.join('\n'), /"Active coordination:" header names closed issue #553/);
});

test('RED: a narrative line framing a closed issue as active fails with line number', () => {
  const text = [
    '# A2A current state',
    '',
    'The active `a2a-nexus#553` monorepo canonical planning lane continues.',
  ].join('\n');
  const failures = evaluateCurrentStateDrift(text, SNAPSHOT);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /docs\/current-state\.md:3: issue #553 is closed \(closed 2026-06-11\) but this line frames it as active/);
});

test('GREEN: historical framing of the same closed issue passes', () => {
  const text = [
    '# A2A current state',
    '',
    '> **Active coordination:** repository hardening follow-ups; the monorepo canonical flip is complete (recorded below).',
    '',
    'The historical `a2a-nexus#553` monorepo canonical flip was executed and is complete.',
    'It is referenced here only as a completed record.',
  ].join('\n');
  const failures = evaluateCurrentStateDrift(text, SNAPSHOT);
  assert.deepEqual(failures, []);
});

test('GREEN: an OPEN snapshot issue framed as active does not fail', () => {
  const openSnapshot = { issues: [{ number: 999, state: 'open' }] };
  const text = 'The active `a2a-nexus#999` lane is ongoing.';
  assert.deepEqual(evaluateCurrentStateDrift(text, openSnapshot), []);
});

test('edge: empty/missing inputs are handled', () => {
  assert.deepEqual(evaluateCurrentStateDrift('anything', { issues: [] }), []);
  assert.deepEqual(evaluateCurrentStateDrift('anything', null), []);
  assert.deepEqual(evaluateCurrentStateDrift(null, SNAPSHOT), ['missing docs/current-state.md']);
});

test('precision: a closed issue merely mentioned in non-active prose is fine', () => {
  const text = 'See `a2a-nexus#553` for the completed canonical-flip history.';
  assert.deepEqual(evaluateCurrentStateDrift(text, SNAPSHOT), []);
});
