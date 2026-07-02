#!/usr/bin/env node
/**
 * Closeout hygiene monitor (#1210): detect issues closed as "completed" while
 * their body task-list still has unchecked items.
 *
 * docs/operators.md requires the finalizer to reconcile every checklist item
 * against artifacts before close, but #1204 and #1198 were closed complete
 * with open checkboxes — the rule had no enforcement. This monitor makes that
 * state machine-visible. Exceptions are allowed only via the
 * `closeout-exception` label plus an issue comment recording an item-by-item
 * disposition.
 *
 * This is a monitoring gate, not a fail-closed release gate: without a
 * GITHUB_TOKEN it skips with an explicit message (local runs, forks), and it
 * only reads issues — it never mutates issue state.
 */
import process from 'node:process';

export const EXCEPTION_LABEL = 'closeout-exception';
const UNCHECKED_BOX = /^\s*[-*]\s+\[ \]\s+\S/m;
const DISPOSITION_MARKER = /disposition/i;

/**
 * Pure evaluation over already-fetched issues. Each issue may carry
 * `commentBodies` (string[]) for exception verification.
 */
export function evaluateClosedIssues(issues) {
  const violations = [];
  for (const issue of issues) {
    if (issue.pull_request) continue; // issues API mixes PRs in
    if (issue.state_reason !== 'completed') continue;
    if (!issue.body || !UNCHECKED_BOX.test(issue.body)) continue;

    const labels = (issue.labels ?? []).map((label) => (typeof label === 'string' ? label : label.name));
    if (labels.includes(EXCEPTION_LABEL)) {
      const hasDisposition = (issue.commentBodies ?? []).some((body) => DISPOSITION_MARKER.test(body ?? ''));
      if (hasDisposition) continue;
      violations.push({
        number: issue.number,
        title: issue.title,
        reason: `${EXCEPTION_LABEL} label present but no comment records an item-by-item disposition`,
      });
      continue;
    }
    violations.push({
      number: issue.number,
      title: issue.title,
      reason: 'closed as completed with unchecked task-list items and no closeout-exception label',
    });
  }
  return violations;
}

async function githubJson(token, url) {
  const res = await fetch(url, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
    },
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status} for ${url}`);
  return res.json();
}

async function main() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    console.log('issue closeout hygiene: skipped (no GITHUB_TOKEN; monitoring gate only runs where issue read access exists)');
    return 0;
  }
  const repo = process.env.GITHUB_REPOSITORY || 'jinwon-int/a2a-nexus';
  const daysArg = process.argv.indexOf('--days');
  const days = daysArg !== -1 ? Number(process.argv[daysArg + 1]) : 14;
  if (!Number.isFinite(days) || days <= 0) throw new Error('--days must be a positive number');
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const issues = await githubJson(
    token,
    `https://api.github.com/repos/${repo}/issues?state=closed&since=${since}&per_page=100`,
  );
  for (const issue of issues) {
    const labels = (issue.labels ?? []).map((label) => (typeof label === 'string' ? label : label.name));
    if (!issue.pull_request && labels.includes(EXCEPTION_LABEL) && issue.body && UNCHECKED_BOX.test(issue.body)) {
      const comments = await githubJson(token, `${issue.comments_url}?per_page=100`);
      issue.commentBodies = comments.map((comment) => comment.body);
    }
  }

  const violations = evaluateClosedIssues(issues);
  if (violations.length) {
    console.error(`issue closeout hygiene FAILED (${violations.length} violation(s) in the last ${days} day(s)):`);
    for (const violation of violations) {
      console.error(`  - #${violation.number} "${violation.title}": ${violation.reason}`);
    }
    console.error('Reopen the issue or apply the closeout-exception label with an item-by-item disposition comment (docs/operators.md).');
    return 1;
  }
  console.log(`issue closeout hygiene ok (${issues.filter((issue) => !issue.pull_request).length} closed issue(s) checked, last ${days} day(s))`);
  return 0;
}

const isDirectRun = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (isDirectRun) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(`issue closeout hygiene errored: ${error.message}`);
      process.exit(1);
    },
  );
}
