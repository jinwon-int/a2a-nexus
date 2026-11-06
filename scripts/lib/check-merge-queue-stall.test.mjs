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

const rulesBody = [{ type: 'pull_request' }, { type: 'merge_queue', parameters: { check_response_timeout_minutes: 60 } }];
const queueData = (entries, extra = {}) => ({
  data: {
    repository: {
      defaultBranchRef: { name: 'main' },
      mergeQueue: entries === null ? null : { url: 'https://github.com/o/r/queue/main', entries: { nodes: entries } },
    },
  },
  ...extra,
});
const fakeGithub = ({ gql, rules = () => Response.json(rulesBody), runs = () => Response.json({ workflow_runs: [run()] }) }) => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const u = String(url);
    calls.push({ url: u, method: init.method, body: init.body });
    if (u.endsWith('/graphql')) return gql();
    if (u.includes('/rules/branches/')) return rules();
    return runs();
  };
  return { calls, fetchImpl };
};

test('readMergeQueueState sends one GraphQL query and GET-only reads', async () => {
  const gh = fakeGithub({ gql: () => Response.json(queueData([entry(2500)])) });
  const state = await readMergeQueueState({ repository: 'o/r', token: 't', branch: 'main', fetchImpl: gh.fetchImpl });
  assert.equal(state.queueEnabled, true);
  assert.equal(state.timeoutSeconds, 3600, 'timeout comes from the REST merge_queue rule');
  assert.equal(state.entries.length, 1);
  assert.equal(state.runs.length, 1);
  assert.equal(gh.calls.filter((c) => c.method === 'POST').length, 1);
  assert.ok(gh.calls.every((c) => c.method === 'GET' || c.url.endsWith('/graphql')));
  const query = JSON.parse(gh.calls[0].body).query;
  assert.doesNotMatch(query, /mutation/);
  // #2501 follow-up: the workflow GITHUB_TOKEN is refused mergeQueue.configuration
  // (FORBIDDEN, probed 2026-11-06), so the query must never ask for it.
  assert.doesNotMatch(query, /configuration/);
  const runsUrl = new URL(gh.calls.find((c) => c.url.includes('/actions/runs')).url);
  assert.equal(runsUrl.searchParams.get('event'), 'merge_group');
  assert.equal(runsUrl.searchParams.get('created'), '>=2026-11-06T06:56:34.000Z');
});

test('an integration-token refusal of the optional enqueuer field is tolerated', async () => {
  const forbidden = { type: 'FORBIDDEN', path: ['repository', 'mergeQueue', 'entries', 'nodes', 0, 'enqueuer'], message: 'Resource not accessible by integration' };
  const gh = fakeGithub({ gql: () => Response.json(queueData([entry(2500, { enqueuer: null })], { errors: [forbidden] })) });
  const state = await readMergeQueueState({ repository: 'o/r', branch: 'main', fetchImpl: gh.fetchImpl });
  assert.equal(state.entries.length, 1);
  const [finding] = findMergeQueueStalls({ entries: state.entries, runs: [], now: minutesAfter('2026-11-06T06:56:34Z', 6) });
  assert.equal(finding.enqueuer, null);
  assert.equal(finding.tokenEnqueue, false);
  assert.match(formatStall(finding), /PR #2500 enqueued at .* 0 merge_group runs/);
});

test('any other GraphQL error fails closed and names its path', async () => {
  const forbidden = { type: 'FORBIDDEN', path: ['repository', 'mergeQueue', 'entries'], message: 'Resource not accessible by integration' };
  const gh = fakeGithub({ gql: () => Response.json(queueData([], { errors: [forbidden] })) });
  await assert.rejects(
    readMergeQueueState({ repository: 'o/r', fetchImpl: gh.fetchImpl }),
    /Resource not accessible by integration \(path repository\.mergeQueue\.entries\)/,
  );
});

test('an unreadable rules endpoint only drops the timeout from the message', async () => {
  const gh = fakeGithub({ gql: () => Response.json(queueData([entry(1)])), rules: () => new Response('no', { status: 403 }) });
  const state = await readMergeQueueState({ repository: 'o/r', fetchImpl: gh.fetchImpl });
  assert.equal(state.timeoutSeconds, null);
  const [finding] = findMergeQueueStalls({ entries: state.entries, runs: [], now: minutesAfter('2026-11-06T06:56:34Z', 6) });
  assert.doesNotMatch(formatStall(finding, { timeoutSeconds: state.timeoutSeconds ?? undefined }), /removes it at/);
});

test('readMergeQueueState skips run reads for an empty queue and reports a missing queue', async () => {
  const empty = fakeGithub({ gql: () => Response.json(queueData([])) });
  const emptyState = await readMergeQueueState({ repository: 'o/r', fetchImpl: empty.fetchImpl });
  assert.equal(emptyState.queueEnabled, true);
  assert.deepEqual(emptyState.runs, []);
  assert.equal(empty.calls.some((c) => c.url.includes('/actions/runs')), false);
  const none = fakeGithub({ gql: () => Response.json(queueData(null)) });
  assert.equal((await readMergeQueueState({ repository: 'o/r', fetchImpl: none.fetchImpl })).queueEnabled, false);
  assert.equal(none.calls.some((c) => c.url.includes('/actions/runs')), false);
});

test('readMergeQueueState surfaces HTTP failures and bad repository names', async () => {
  await assert.rejects(
    readMergeQueueState({ repository: 'o/r', fetchImpl: async () => new Response('x', { status: 502 }) }),
    /502/,
  );
  await assert.rejects(readMergeQueueState({ repository: 'bad', fetchImpl: async () => null }), /owner\/repository/);
});
