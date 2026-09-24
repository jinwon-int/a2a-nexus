import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { evaluateClosedIssues, fetchAllPages, EXCEPTION_LABEL, ENFORCEMENT_CUTOFF } from './check-issue-closeout-hygiene.mjs';

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

// #2254: the old main() fetched a single 100-item page of closed issues.
// When >100 closed items (issues and PRs are mixed in one list) were updated
// inside the window, older-created violations fell off the page and the gate
// silently passed — CI failed on #1800 while the same commit's local run
// reported "ok". These tests pin the paginated fetch.
function withStubbedFetch(handler) {
  const requested = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    requested.push(String(url));
    return handler(String(url), requested.length);
  };
  return () => {
    globalThis.fetch = realFetch;
  };
}

test('fetchAllPages walks past a full first page and dedupes across pages (#2254 regression)', async () => {
  const restore = withStubbedFetch((url, index) => {
    const page = Number(new URL(url).searchParams.get('page'));
    if (page !== index) throw new Error(`non-sequential page request: ${url}`);
    if (page === 1) {
      return { ok: true, status: 200, json: async () => Array.from({ length: 100 }, (_, i) => ({ number: 2000 + i })) };
    }
    // The old single-page fetch stopped here and never saw #1800.
    return { ok: true, status: 200, json: async () => [{ number: 2099 }, { number: 1800 }] };
  });
  try {
    const all = await fetchAllPages(
      'test-token',
      'https://api.github.com/repos/x/y/issues?state=closed&since=S&sort=created&direction=desc',
    );
    assert.equal(all.length, 101); // 100 unique from page 1 + #1800 (2099 deduped)
    assert.ok(all.some((item) => item.number === 1800));
  } finally {
    restore();
  }
});

test('fetchAllPages requests per_page=100 with sequential pages and preserves the caller sort', async () => {
  const restore = withStubbedFetch((url) => {
    const parsed = new URL(url);
    assert.equal(parsed.searchParams.get('per_page'), '100');
    assert.equal(parsed.searchParams.get('sort'), 'created');
    const page = Number(parsed.searchParams.get('page'));
    if (page === 1) {
      return { ok: true, status: 200, json: async () => Array.from({ length: 100 }, (_, i) => ({ number: i })) };
    }
    return { ok: true, status: 200, json: async () => [] };
  });
  try {
    const all = await fetchAllPages('test-token', 'https://api.github.com/repos/x/y/issues?sort=created&direction=desc');
    assert.equal(all.length, 100);
  } finally {
    restore();
  }
});

test('fetchAllPages fails closed instead of silently truncating past the page cap', async () => {
  const restore = withStubbedFetch(() => ({
    ok: true,
    status: 200,
    json: async () => Array.from({ length: 100 }, (_, i) => ({ number: i })),
  }));
  try {
    await assert.rejects(
      () => fetchAllPages('test-token', 'https://api.github.com/repos/x/y/issues?sort=created', { maxPages: 2 }),
      /exceeded 2 pages .* silently truncating/,
    );
  } finally {
    restore();
  }
});

test('fetchAllPages surfaces non-array payloads instead of treating them as an empty page', async () => {
  const restore = withStubbedFetch(() => ({ ok: true, status: 200, json: async () => ({ message: 'weird' }) }));
  try {
    await assert.rejects(
      () => fetchAllPages('test-token', 'https://api.github.com/repos/x/y/issues?sort=created'),
      /non-array payload/,
    );
  } finally {
    restore();
  }
});
