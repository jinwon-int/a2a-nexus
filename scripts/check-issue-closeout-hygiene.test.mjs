import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { evaluateClosedIssues, EXCEPTION_LABEL, ENFORCEMENT_CUTOFF } from './check-issue-closeout-hygiene.mjs';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'check-issue-closeout-hygiene.mjs');
const AFTER_CUTOFF = '2026-07-03T00:00:00Z';
const BEFORE_CUTOFF = '2026-07-01T00:00:00Z';

// Shaped after #1204: closed as completed by the implementing agent while all
// four task-list items were still unchecked.
const ISSUE_1204_SHAPE = {
  number: 1204,
  title: 'C6: runtime hardening',
  state_reason: 'completed',
  closed_at: AFTER_CUTOFF,
  labels: [{ name: 'enhancement' }],
  body: '## 작업 단위\n\n- [ ] PR 1: process handlers\n- [ ] PR 2: docs\n- [ ] PR 3: hardening\n- [ ] PR 4: e2e\n',
};

test('post-cutoff completed close with unchecked boxes is a violation (#1204 shape)', () => {
  const { violations, legacy } = evaluateClosedIssues([ISSUE_1204_SHAPE]);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].number, 1204);
  assert.match(violations[0].reason, /unchecked task-list/);
  assert.equal(legacy.length, 0);
});

test('pre-cutoff close is reported as legacy, not a violation', () => {
  assert.ok(Date.parse(BEFORE_CUTOFF) < Date.parse(ENFORCEMENT_CUTOFF));
  const { violations, legacy } = evaluateClosedIssues([{ ...ISSUE_1204_SHAPE, closed_at: BEFORE_CUTOFF }]);
  assert.equal(violations.length, 0);
  assert.equal(legacy.length, 1);
  assert.equal(legacy[0].number, 1204);
});

test('closeout-exception label with disposition comment passes', () => {
  const { violations } = evaluateClosedIssues([
    {
      ...ISSUE_1204_SHAPE,
      labels: [{ name: EXCEPTION_LABEL }],
      commentBodies: ['Finalizer disposition: PR 1 done, PR 2 deferred to #1209, PR 3 done, PR 4 deferred to #1209.'],
    },
  ]);
  assert.equal(violations.length, 0);
});

test('closeout-exception label without disposition comment is a violation even pre-cutoff', () => {
  const { violations } = evaluateClosedIssues([
    { ...ISSUE_1204_SHAPE, closed_at: BEFORE_CUTOFF, labels: [{ name: EXCEPTION_LABEL }], commentBodies: ['lgtm'] },
  ]);
  assert.equal(violations.length, 1);
  assert.match(violations[0].reason, /no comment records an item-by-item disposition/);
});

test('fully checked task list, not_planned closes, and PRs are ignored', () => {
  const { violations, legacy } = evaluateClosedIssues([
    { ...ISSUE_1204_SHAPE, body: '- [x] PR 1\n- [x] PR 2\n' },
    { ...ISSUE_1204_SHAPE, number: 2, state_reason: 'not_planned' },
    { ...ISSUE_1204_SHAPE, number: 3, pull_request: { url: 'x' } },
    { ...ISSUE_1204_SHAPE, number: 4, body: 'no checkboxes here' },
  ]);
  assert.equal(violations.length, 0);
  assert.equal(legacy.length, 0);
});

test('runs without GITHUB_TOKEN skip cleanly (monitoring gate, not fail-closed)', () => {
  const env = { ...process.env };
  delete env.GITHUB_TOKEN;
  const r = spawnSync(process.execPath, [script], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /skipped \(no GITHUB_TOKEN/);
});
