import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  findDefaultBranchRunFailures,
  findMergedBranchResidue,
  formatFinding,
  formatRunFailure,
  readDefaultBranchWorkflowRuns,
  readRepositoryHygieneState,
  reportFindings,
  reportRunFailures,
} from './check-repository-hygiene-watchdog.mjs';

const repository = 'jinwon-int/a2a-nexus';
const mergedPull = (number, ref, overrides = {}) => ({
  number,
  merged_at: '2026-07-30T00:00:00Z',
  html_url: `https://github.com/${repository}/pull/${number}`,
  head: {
    ref,
    sha: `pr-${number}`,
    repo: { full_name: repository },
  },
  ...overrides,
});
const branch = (name, overrides = {}) => ({
  name,
  protected: false,
  commit: { sha: `branch-${name}` },
  ...overrides,
});

test('finds an existing branch attached to a merged same-repository PR', () => {
  const findings = findMergedBranchResidue({
    repository,
    defaultBranch: 'trunk',
    branches: [branch('feature/merged', { commit: { sha: 'pr-42' } })],
    pullRequests: [mergedPull(42, 'feature/merged')],
  });

  assert.deepEqual(findings, [
    {
      branch: 'feature/merged',
      headSha: 'pr-42',
      pullRequests: [
        {
          number: 42,
          mergedAt: '2026-07-30T00:00:00Z',
          headSha: 'pr-42',
          url: `https://github.com/${repository}/pull/42`,
        },
      ],
    },
  ]);
});

test('ignores an advanced or reused branch whose commit differs from the merged PR head', () => {
  const findings = findMergedBranchResidue({
    repository,
    defaultBranch: 'main',
    branches: [branch('feature/reused', { commit: { sha: 'current-active-work' } })],
    pullRequests: [
      mergedPull(21, 'feature/reused', {
        head: {
          ref: 'feature/reused',
          sha: 'previously-merged-head',
          repo: { full_name: repository },
        },
      }),
    ],
  });

  assert.deepEqual(findings, []);
});

test('ignores unmerged and deleted PR head branches', () => {
  const findings = findMergedBranchResidue({
    repository,
    defaultBranch: 'main',
    branches: [branch('closed-unmerged'), branch('unrelated')],
    pullRequests: [
      mergedPull(1, 'closed-unmerged', { merged_at: null }),
      mergedPull(2, 'already-deleted'),
    ],
  });

  assert.deepEqual(findings, []);
});

test('ignores fork-only heads even when a same-named branch exists in the base repository', () => {
  const forkPull = mergedPull(8, 'feature/from-fork');
  forkPull.head.repo.full_name = 'contributor/a2a-nexus';

  const findings = findMergedBranchResidue({
    repository,
    defaultBranch: 'main',
    branches: [branch('feature/from-fork')],
    pullRequests: [forkPull],
  });

  assert.deepEqual(findings, []);
});

test('ignores main, the repository default branch, and protected branches', () => {
  const findings = findMergedBranchResidue({
    repository,
    defaultBranch: 'stable',
    branches: [
      branch('main'),
      branch('stable'),
      branch('release/locked', { protected: true }),
    ],
    pullRequests: [
      mergedPull(1, 'main'),
      mergedPull(2, 'stable'),
      mergedPull(3, 'release/locked'),
    ],
  });

  assert.deepEqual(findings, []);
});

test('sorts branches and associated PR numbers deterministically', () => {
  const sameHead = (number, ref, sha) => mergedPull(number, ref, {
    head: { ref, sha, repo: { full_name: repository } },
  });
  const findings = findMergedBranchResidue({
    repository,
    defaultBranch: 'main',
    branches: [
      branch('z-last', { commit: { sha: 'z-head' } }),
      branch('a-first', { commit: { sha: 'a-head' } }),
    ],
    pullRequests: [
      sameHead(9, 'a-first', 'a-head'),
      sameHead(12, 'z-last', 'z-head'),
      sameHead(4, 'a-first', 'a-head'),
    ],
  });

  assert.deepEqual(findings.map((finding) => finding.branch), ['a-first', 'z-last']);
  assert.deepEqual(findings[0].pullRequests.map((pullRequest) => pullRequest.number), [4, 9]);
});

test('readRepositoryHygieneState paginates and makes only authenticated GET requests', async () => {
  const calls = [];
  const firstBranchPage = Array.from({ length: 100 }, (_, index) => branch(`branch-${index}`));
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    const parsed = new URL(url);
    let body;
    if (parsed.pathname === `/repos/${repository}`) {
      body = { default_branch: 'main' };
    } else if (parsed.pathname.endsWith('/branches')) {
      body = parsed.searchParams.get('page') === '1' ? firstBranchPage : [branch('branch-100')];
    } else if (parsed.pathname.endsWith('/pulls')) {
      body = [mergedPull(10, 'branch-100')];
    } else {
      assert.fail(`unexpected URL: ${url}`);
    }
    return { ok: true, status: 200, json: async () => body };
  };

  const state = await readRepositoryHygieneState({
    repository,
    token: 'test-token',
    apiBase: 'https://api.example.test',
    fetchImpl,
  });

  assert.equal(state.defaultBranch, 'main');
  assert.equal(state.branches.length, 101);
  assert.equal(state.pullRequests.length, 1);
  assert.ok(calls.every((call) => call.options.method === 'GET'));
  assert.ok(calls.every((call) => call.options.headers.authorization === 'Bearer test-token'));
  assert.ok(calls.some((call) => call.url.includes('state=closed')));
});

test('API failures and missing credentials fail closed', async () => {
  await assert.rejects(
    readRepositoryHygieneState({ repository, token: '' }),
    /GITHUB_TOKEN is required/,
  );
  await assert.rejects(
    readRepositoryHygieneState({
      repository,
      token: 'test-token',
      fetchImpl: async () => ({ ok: false, status: 403 }),
    }),
    /GitHub API GET failed \(403\)/,
  );
});

test('reportFindings emits a workflow warning and returns a failing status', () => {
  const errors = [];
  const finding = {
    branch: 'feature/residue',
    headSha: 'abc123',
    pullRequests: [{ number: 77 }],
  };

  assert.equal(reportFindings([finding], { error: (line) => errors.push(line) }), 1);
  assert.match(errors.join('\n'), /repository hygiene watchdog FAILED/);
  assert.match(errors.join('\n'), /::warning title=Merged branch residue::/);
  assert.match(formatFinding(finding), /feature\/residue at abc123.*#77/);
  assert.match(errors.join('\n'), /no branch or setting was changed/);
});

test('workflow is weekly plus manual, read-only, and does not persist checkout credentials', () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const workflow = fs.readFileSync(
    path.join(repoRoot, '.github/workflows/repository-hygiene-watchdog.yml'),
    'utf8',
  );

  assert.match(workflow, /^\s{2}schedule:/m);
  assert.match(workflow, /^\s{2}workflow_dispatch:/m);
  assert.match(workflow, /^permissions:\n  contents: read\n  pull-requests: read\n  actions: read$/m);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /node scripts\/lib\/check-repository-hygiene-watchdog\.mjs/);
  assert.doesNotMatch(workflow, /^\s+\w[\w-]*:\s*write\s*$/m);
});

const workflowRun = (id, overrides = {}) => ({
  id,
  name: 'ci',
  head_branch: 'main',
  conclusion: 'success',
  event: 'push',
  created_at: '2026-08-14T07:00:06Z',
  html_url: `https://github.com/${repository}/actions/runs/${id}`,
  ...overrides,
});

test('findDefaultBranchRunFailures reports no findings when every workflow is green on the default branch', () => {
  const findings = findDefaultBranchRunFailures({
    defaultBranch: 'main',
    runs: [
      workflowRun(1, { name: 'ci' }),
      workflowRun(2, { name: 'codeql', event: 'schedule', conclusion: 'success' }),
    ],
  });
  assert.deepEqual(findings, []);
});

test('findDefaultBranchRunFailures reports workflows whose latest default-branch run failed', () => {
  const findings = findDefaultBranchRunFailures({
    defaultBranch: 'main',
    runs: [
      workflowRun(1, { name: 'ci', conclusion: 'failure', event: 'push', created_at: '2026-08-14T07:00:06Z' }),
      workflowRun(2, { name: 'codeql' }),
    ],
  });
  assert.deepEqual(findings, [
    {
      workflow: 'ci',
      runId: 1,
      conclusion: 'failure',
      event: 'push',
      createdAt: '2026-08-14T07:00:06Z',
      url: `https://github.com/${repository}/actions/runs/1`,
    },
  ]);
});

test('a newer completed run of the same workflow clears an older failure', () => {
  const findings = findDefaultBranchRunFailures({
    defaultBranch: 'main',
    runs: [
      workflowRun(1, { name: 'ci', conclusion: 'failure' }),
      workflowRun(2, { name: 'ci', conclusion: 'success', created_at: '2026-08-14T08:00:00Z' }),
    ],
  });
  assert.deepEqual(findings, []);
});

test('pull-request and non-default-branch runs never raise a finding', () => {
  const findings = findDefaultBranchRunFailures({
    defaultBranch: 'main',
    runs: [
      workflowRun(1, { head_branch: 'feature/x', conclusion: 'failure' }),
      workflowRun(2, { head_branch: 'some-fork-branch', conclusion: 'failure' }),
    ],
  });
  assert.deepEqual(findings, []);
});

test('cancelled, timed-out, in-progress, and startup-free latest runs are not main redness', () => {
  const findings = findDefaultBranchRunFailures({
    defaultBranch: 'main',
    runs: [
      workflowRun(1, { name: 'auto-merge', conclusion: null }),
      workflowRun(2, { name: 'ci', conclusion: 'cancelled' }),
      workflowRun(3, { name: 'codeql', conclusion: 'timed_out' }),
    ],
  });
  assert.deepEqual(findings, []);
});

test('startup_failure is treated as main redness and findings sort by workflow name', () => {
  const findings = findDefaultBranchRunFailures({
    defaultBranch: 'main',
    runs: [
      workflowRun(1, { name: 'codeql', conclusion: 'startup_failure' }),
      workflowRun(2, { name: 'ci', conclusion: 'failure' }),
    ],
  });
  assert.deepEqual(
    findings.map((finding) => finding.workflow),
    ['ci', 'codeql'],
  );
});

test('readDefaultBranchWorkflowRuns unwraps workflow_runs pages and stops at a short page', async () => {
  const requests = [];
  const fetchImpl = async (url) => {
    requests.push(String(url));
    return {
      ok: true,
      json: async () => ({ workflow_runs: [workflowRun(3)] }),
    };
  };
  const runs = await readDefaultBranchWorkflowRuns({
    repository,
    defaultBranch: 'main',
    token: 'test-token',
    fetchImpl,
  });
  assert.equal(runs.length, 1);
  assert.equal(requests.length, 1);
  assert.match(requests[0], /branch=main/);
});

test('readDefaultBranchWorkflowRuns fails closed on a malformed page', async () => {
  await assert.rejects(
    readDefaultBranchWorkflowRuns({
      repository,
      defaultBranch: 'main',
      token: 'test-token',
      fetchImpl: async () => ({ ok: true, json: async () => ({ total_count: 1 }) }),
    }),
    /malformed workflow-runs page/,
  );
});

test('reportRunFailures emits a workflow warning and returns a failing status', () => {
  const errors = []
  const logs = [];
  const finding = {
    workflow: 'ci',
    runId: 31778278226,
    conclusion: 'failure',
    event: 'push',
    createdAt: '2026-08-14T07:00:06Z',
    url: 'https://github.com/jinwon-int/a2a-nexus/actions/runs/31778278226',
  };

  assert.equal(reportRunFailures([finding], { error: (line) => errors.push(line) }), 1);
  const joined = errors.join('\n');
  assert.match(joined, /repository hygiene watchdog FAILED: 1 workflow\(s\)/);
  assert.match(joined, /::warning title=Main branch CI redness::/);
  assert.match(formatRunFailure(finding), /ci: latest default-branch run 31778278226 concluded failure/);
  assert.match(joined, /no workflow or setting was changed here/);

  assert.equal(reportRunFailures([], { error: () => {}, log: (line) => logs.push(line) }), 0);
  assert.match(logs.join('\n'), /ok: the latest default-branch run of every workflow is not failed/);
});
