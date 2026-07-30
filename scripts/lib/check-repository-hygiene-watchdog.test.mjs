import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  findMergedBranchResidue,
  formatFinding,
  readRepositoryHygieneState,
  reportFindings,
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
    branches: [branch('feature/merged')],
    pullRequests: [mergedPull(42, 'feature/merged')],
  });

  assert.deepEqual(findings, [
    {
      branch: 'feature/merged',
      headSha: 'branch-feature/merged',
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
  const findings = findMergedBranchResidue({
    repository,
    defaultBranch: 'main',
    branches: [branch('z-last'), branch('a-first')],
    pullRequests: [
      mergedPull(9, 'a-first'),
      mergedPull(12, 'z-last'),
      mergedPull(4, 'a-first'),
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
  assert.match(workflow, /^permissions:\n  contents: read\n  pull-requests: read$/m);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /node scripts\/lib\/check-repository-hygiene-watchdog\.mjs/);
  assert.doesNotMatch(workflow, /^\s+\w[\w-]*:\s*write\s*$/m);
});
