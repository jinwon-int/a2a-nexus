import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { evaluateClosedIssues, EXCEPTION_LABEL } from './check-issue-closeout-hygiene.mjs';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'check-issue-closeout-hygiene.mjs');

// Shaped after #1204: closed as completed by the implementing agent while all
// four task-list items were still unchecked.
const ISSUE_1204_SHAPE = {
  number: 1204,
  title: 'C6: runtime hardening',
  state_reason: 'completed',
  labels: [{ name: 'enhancement' }],
  body: '## 작업 단위\n\n- [ ] PR 1: process handlers\n- [ ] PR 2: docs\n- [ ] PR 3: hardening\n- [ ] PR 4: e2e\n',
};

test('completed close with unchecked boxes is a violation (#1204 shape)', () => {
  const violations = evaluateClosedIssues([ISSUE_1204_SHAPE]);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].number, 1204);
  assert.match(violations[0].reason, /unchecked task-list/);
});

test('closeout-exception label with disposition comment passes', () => {
  const violations = evaluateClosedIssues([
    {
      ...ISSUE_1204_SHAPE,
      labels: [{ name: EXCEPTION_LABEL }],
      commentBodies: ['Finalizer disposition: PR 1 done, PR 2 deferred to #1209, PR 3 done, PR 4 deferred to #1209.'],
    },
  ]);
  assert.equal(violations.length, 0);
});

test('closeout-exception label without disposition comment is still a violation', () => {
  const violations = evaluateClosedIssues([
    { ...ISSUE_1204_SHAPE, labels: [{ name: EXCEPTION_LABEL }], commentBodies: ['lgtm'] },
  ]);
  assert.equal(violations.length, 1);
  assert.match(violations[0].reason, /no comment records an item-by-item disposition/);
});

test('fully checked task list, not_planned closes, and PRs are ignored', () => {
  const violations = evaluateClosedIssues([
    { ...ISSUE_1204_SHAPE, body: '- [x] PR 1\n- [x] PR 2\n' },
    { ...ISSUE_1204_SHAPE, number: 2, state_reason: 'not_planned' },
    { ...ISSUE_1204_SHAPE, number: 3, pull_request: { url: 'x' } },
    { ...ISSUE_1204_SHAPE, number: 4, body: 'no checkboxes here' },
  ]);
  assert.equal(violations.length, 0);
});

test('runs without GITHUB_TOKEN skip cleanly (monitoring gate, not fail-closed)', () => {
  const env = { ...process.env };
  delete env.GITHUB_TOKEN;
  const r = spawnSync(process.execPath, [script], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /skipped \(no GITHUB_TOKEN/);
});
