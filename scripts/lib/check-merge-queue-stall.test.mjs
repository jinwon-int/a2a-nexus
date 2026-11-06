import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_STALL_MINUTES,
  findMergeQueueStalls,
  formatStall,
  readMergeQueueState,
  reportStalls,
  runBelongsToEntry,
} from './check-merge-queue-stall.mjs';

const entry = (number, overrides = {}) => ({
  state: 'AWAITING_CHECKS',
  enqueuedAt: '2026-11-06T06:56:34Z',
  position: 1,
  headCommit: { oid: `group-${number}` },
  pullRequest: { number, url: `https://github.com/jinwon-int/a2a-nexus/pull/${number}` },
  enqueuer: { login: 'operator-account' },
  ...overrides,
});
const run = (overrides = {}) => ({
  event: 'merge_group',
  head_branch: 'gh-readonly-queue/main/pr-2500-3ed9402bc64430fd42a4dcbdc97dc03228fdc3eb',
  head_sha: 'other',
  created_at: '2026-11-06T08:03:06Z',
  ...overrides,
});
const minutesAfter = (iso, minutes) => Date.parse(iso) + minutes * 60000;

test('#2500 replay: a GITHUB_TOKEN enqueue with zero merge_group runs is a stall naming the cause', () => {
  const findings = findMergeQueueStalls({
    entries: [entry(2500, { enqueuer: { login: 'github-actions' } })],
    runs: [],
    now: minutesAfter('2026-11-06T06:56:34Z', 5),
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].pullRequest, 2500);
  assert.equal(findings[0].ageMinutes, 5);
  assert.equal(findings[0].tokenEnqueue, true);
  const message = formatStall(findings[0], { timeoutSeconds: 3600 });
  assert.match(message, /PR #2500 enqueued by github-actions/);
  assert.match(message, /0 merge_group runs/);
  assert.match(message, /removes it at 60 min \(checks_timed_out\)/);
  assert.match(message, /GITHUB_TOKEN.*#2501/);
});

test('#2500 replay: the human re-enqueue whose runs started 18 s later is healthy', () => {
  const findings = findMergeQueueStalls({
    entries: [entry(2500, { enqueuedAt: '2026-11-06T08:02:48Z', headCommit: { oid: '01bb2137' } })],
    runs: [run({ head_sha: '01bb2137' })],
    now: minutesAfter('2026-11-06T08:02:48Z', 4),
  });
  assert.deepEqual(findings, []);
});

test('an entry younger than the threshold is not reported yet', () => {
  const findings = findMergeQueueStalls({
    entries: [entry(1)],
    runs: [],
    now: minutesAfter('2026-11-06T06:56:34Z', DEFAULT_STALL_MINUTES - 0.5),
  });
  assert.deepEqual(findings, []);
});

test('only AWAITING_CHECKS entries are judged', () => {
  const now = minutesAfter('2026-11-06T06:56:34Z', 30);
  for (const state of ['QUEUED', 'LOCKED', 'MERGEABLE', 'UNMERGEABLE']) {
    assert.deepEqual(findMergeQueueStalls({ entries: [entry(1, { state })], runs: [], now }), [], state);
  }
});

test('a run matches by head branch prefix when the entry head commit is unknown', () => {
  const e = entry(2500, { headCommit: null });
  assert.equal(runBelongsToEntry(run(), e, { branch: 'main' }), true);
  // pr-25 must not match pr-2500's branch.
  assert.equal(runBelongsToEntry(run(), entry(25, { headCommit: null }), { branch: 'main' }), false);
  assert.equal(runBelongsToEntry(run(), e, { branch: 'trunk' }), false);
});

test('runs from an earlier admission of the same PR do not count', () => {
  const e = entry(2500, { enqueuedAt: '2026-11-06T09:00:00Z', headCommit: null });
  assert.equal(runBelongsToEntry(run({ created_at: '2026-11-06T08:03:06Z' }), e, { branch: 'main' }), false);
  const findings = findMergeQueueStalls({
    entries: [e],
    runs: [run({ created_at: '2026-11-06T08:03:06Z' })],
    now: minutesAfter('2026-11-06T09:00:00Z', 10),
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].tokenEnqueue, false);
});

test('non-merge_group runs never satisfy an entry', () => {
  const e = entry(2500, { headCommit: { oid: 'abc' } });
  assert.equal(runBelongsToEntry(run({ event: 'pull_request', head_sha: 'abc' }), e, { branch: 'main' }), false);
});

test('findings are ordered by queue position, then PR number', () => {
  const now = minutesAfter('2026-11-06T06:56:34Z', 20);
  const findings = findMergeQueueStalls({
    entries: [entry(9, { position: 2 }), entry(7, { position: 1 }), entry(3, { position: null })],
    runs: [],
    now,
  });
  assert.deepEqual(findings.map((f) => f.pullRequest), [7, 9, 3]);
});

test('input validation rejects bad shapes', () => {
  assert.throws(() => findMergeQueueStalls({ entries: null, runs: [], now: 0 }), TypeError);
  assert.throws(() => findMergeQueueStalls({ entries: [], runs: [], now: 'not a time' }), TypeError);
  assert.throws(() => findMergeQueueStalls({ entries: [], runs: [], now: 0, stallMinutes: 0 }), TypeError);
});

test('reportStalls exits 0 when clean and 1 with an annotation per stall', () => {
  const logs = [];
  const errors = [];
  assert.equal(reportStalls([], { log: (m) => logs.push(m), error: (m) => errors.push(m) }), 0);
  assert.equal(errors.length, 0);
  assert.match(logs[0], /ok/);

  const findings = findMergeQueueStalls({
    entries: [entry(2500, { enqueuer: { login: 'github-actions' } })],
    runs: [],
    now: minutesAfter('2026-11-06T06:56:34Z', 7),
  });
  assert.equal(reportStalls(findings, { log: () => {}, error: (m) => errors.push(m), timeoutSeconds: 3600 }), 1);
  assert.ok(errors.some((m) => m.startsWith('::error title=Merge queue entry without merge_group runs::PR #2500')));
  assert.ok(errors.some((m) => /read-only/.test(m)));
});

test('readMergeQueueState sends one GraphQL query and GET-only run reads', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), method: init.method, body: init.body });
    if (String(url).endsWith('/graphql')) {
      return Response.json({
        data: {
          repository: {
            defaultBranchRef: { name: 'main' },
            mergeQueue: {
              url: 'https://github.com/o/r/queue/main',
              configuration: { checkResponseTimeout: 3600 },
              entries: { nodes: [entry(2500)] },
            },
          },
        },
      });
    }
    return Response.json({ workflow_runs: [run()] });
  };
  const state = await readMergeQueueState({ repository: 'o/r', token: 't', branch: 'main', fetchImpl });
  assert.equal(state.queueEnabled, true);
  assert.equal(state.timeoutSeconds, 3600);
  assert.equal(state.entries.length, 1);
  assert.equal(state.runs.length, 1);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].method, 'POST');
  assert.doesNotMatch(JSON.parse(calls[0].body).query, /mutation/);
  assert.equal(calls[1].method, 'GET');
  const runsUrl = new URL(calls[1].url);
  assert.equal(runsUrl.searchParams.get('event'), 'merge_group');
  assert.equal(runsUrl.searchParams.get('created'), '>=2026-11-06T06:56:34.000Z');
});

test('readMergeQueueState skips run reads for an empty queue and reports a missing queue', async () => {
  let runReads = 0;
  const make = (mergeQueue) => async (url) => {
    if (String(url).endsWith('/graphql')) {
      return Response.json({ data: { repository: { defaultBranchRef: { name: 'main' }, mergeQueue } } });
    }
    runReads += 1;
    return Response.json({ workflow_runs: [] });
  };
  const empty = await readMergeQueueState({
    repository: 'o/r',
    fetchImpl: make({ url: 'u', configuration: { checkResponseTimeout: 3600 }, entries: { nodes: [] } }),
  });
  assert.equal(empty.queueEnabled, true);
  assert.deepEqual(empty.runs, []);
  const none = await readMergeQueueState({ repository: 'o/r', fetchImpl: make(null) });
  assert.equal(none.queueEnabled, false);
  assert.equal(runReads, 0);
});

test('readMergeQueueState surfaces GraphQL errors and HTTP failures', async () => {
  await assert.rejects(
    readMergeQueueState({ repository: 'o/r', fetchImpl: async () => Response.json({ errors: [{ message: 'boom' }] }) }),
    /boom/,
  );
  await assert.rejects(
    readMergeQueueState({ repository: 'o/r', fetchImpl: async () => new Response('x', { status: 502 }) }),
    /502/,
  );
  await assert.rejects(readMergeQueueState({ repository: 'bad', fetchImpl: async () => null }), /owner\/repository/);
});
