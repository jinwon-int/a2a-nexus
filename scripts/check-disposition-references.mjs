#!/usr/bin/env node
/**
 * Disposition reference checker (#1220) — the reconciliation-quality half of
 * the closeout monitor pair.
 *
 * check-issue-closeout-hygiene.mjs (#1210) catches closes with NO disposition;
 * this check catches dispositions that point at nothing. For issues closed
 * recently, every disposition comment's citations — PR numbers, workflow run
 * links, backticked repo paths — must resolve to something that exists. A
 * finalizer table that names a PR that was never opened, a run that never
 * happened, or a file that is not in the tree is not a reconciliation.
 *
 * Monitoring gate, read-only: skips without GITHUB_TOKEN, never mutates issue
 * state. Repo paths are checked against the local checkout (the workflow runs
 * after actions/checkout on the default branch).
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const DISPOSITION_MARKER = /disposition/i;
const PR_REF = /(?:^|[\s(|])#(\d{2,6})\b/g;
const RUN_LINK = /actions\/runs\/(\d+)/g;
const BACKTICK_PATH = /`([A-Za-z0-9._/-]+\/[A-Za-z0-9._-]+\.[A-Za-z0-9]+)`/g;

/** Extract verifiable citations from a disposition comment body. */
export function extractDispositionReferences(body) {
  const issueOrPrNumbers = new Set();
  const runIds = new Set();
  const paths = new Set();
  for (const match of body.matchAll(PR_REF)) issueOrPrNumbers.add(Number(match[1]));
  for (const match of body.matchAll(RUN_LINK)) runIds.add(match[1]);
  for (const match of body.matchAll(BACKTICK_PATH)) {
    const candidate = match[1];
    if (!candidate.startsWith('http') && !candidate.includes('..')) paths.add(candidate);
  }
  return {
    issueOrPrNumbers: [...issueOrPrNumbers],
    runIds: [...runIds],
    paths: [...paths],
  };
}

/**
 * Judge extracted references with injected existence probes
 * ({ issueOrPrExists(n), runExists(id), pathExists(p) } — sync or async).
 */
export async function evaluateDispositionReferences(source, refs, probes) {
  const violations = [];
  for (const number of refs.issueOrPrNumbers) {
    if (!(await probes.issueOrPrExists(number))) {
      violations.push({ source, reason: `cites #${number}, which does not exist as an issue or PR` });
    }
  }
  for (const runId of refs.runIds) {
    if (!(await probes.runExists(runId))) {
      violations.push({ source, reason: `cites workflow run ${runId}, which does not exist` });
    }
  }
  for (const repoPath of refs.paths) {
    if (!(await probes.pathExists(repoPath))) {
      violations.push({ source, reason: `cites repo path \`${repoPath}\`, which is not in the tree` });
    }
  }
  return violations;
}

async function githubJson(token, url, { allow404 = false } = {}) {
  const res = await fetch(url, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
    },
  });
  if (allow404 && res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub API ${res.status} for ${url}`);
  return res.json();
}

async function main() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    console.log('disposition references: skipped (no GITHUB_TOKEN; monitoring gate only runs where issue read access exists)');
    return 0;
  }
  const repo = process.env.GITHUB_REPOSITORY || 'jinwon-int/a2a-nexus';
  const daysArg = process.argv.indexOf('--days');
  const days = daysArg !== -1 ? Number(process.argv[daysArg + 1]) : 14;
  if (!Number.isFinite(days) || days <= 0) throw new Error('--days must be a positive number');
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const repoRoot = process.cwd();

  const probes = {
    issueOrPrExists: async (number) =>
      (await githubJson(token, `https://api.github.com/repos/${repo}/issues/${number}`, { allow404: true })) !== null,
    runExists: async (runId) =>
      (await githubJson(token, `https://api.github.com/repos/${repo}/actions/runs/${runId}`, { allow404: true })) !== null,
    pathExists: (repoPath) => fs.existsSync(path.join(repoRoot, repoPath)),
  };

  const issues = await githubJson(
    token,
    `https://api.github.com/repos/${repo}/issues?state=closed&since=${since}&per_page=100`,
  );
  const violations = [];
  let dispositionsChecked = 0;
  for (const issue of issues) {
    if (issue.pull_request) continue;
    if (!issue.comments) continue;
    const comments = await githubJson(token, `${issue.comments_url}?per_page=100`);
    for (const comment of comments) {
      if (!comment.body || !DISPOSITION_MARKER.test(comment.body)) continue;
      dispositionsChecked += 1;
      const refs = extractDispositionReferences(comment.body);
      violations.push(...(await evaluateDispositionReferences(`#${issue.number}`, refs, probes)));
    }
  }

  if (violations.length) {
    console.error(`disposition references FAILED (${violations.length} dead citation(s) across ${dispositionsChecked} disposition(s), last ${days} day(s)):`);
    for (const violation of violations) console.error(`  - ${violation.source}: ${violation.reason}`);
    console.error('Fix the disposition comment so every cited artifact exists (docs/operators.md, finalizer judgment rules).');
    return 1;
  }
  console.log(`disposition references ok (${dispositionsChecked} disposition(s) verified, last ${days} day(s))`);
  return 0;
}

const isDirectRun = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (isDirectRun) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(`disposition references errored: ${error.message}`);
      process.exit(1);
    },
  );
}
