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
// Enforcement starts when the monitor itself landed (#1212 merge). The first
// live run found 51 checklist-incomplete closes in the trailing 14 days — the
// practice predates the rule's enforcement, so failing on legacy closes would
// bury real regressions in noise. Closes before the cutoff are reported as a
// legacy count only; closes at/after it are violations.
export const ENFORCEMENT_CUTOFF = '2026-07-02T06:00:00Z';
const UNCHECKED_BOX = /^\s*[-*]\s+\[ \]\s+\S/m;
const DISPOSITION_MARKER = /disposition/i;

/**
 * Pure evaluation over already-fetched issues. Each issue may carry
 * `commentBodies` (string[]) for exception verification. Returns
 * `{ violations, legacy }` — `legacy` counts checklist-incomplete closes that
 * predate the enforcement cutoff.
 */
export function evaluateClosedIssues(issues, { cutoff = ENFORCEMENT_CUTOFF } = {}) {
  const cutoffMs = Date.parse(cutoff);
  const violations = [];
  const legacy = [];
  for (const issue of issues) {
    if (issue.pull_request) continue; // issues API mixes PRs in
    if (issue.state_reason !== 'completed') continue;
    if (!issue.body || !UNCHECKED_BOX.test(issue.body)) continue;

    const labels = (issue.labels ?? []).map((label) => (typeof label === 'string' ? label : label.name));
    if (labels.includes(EXCEPTION_LABEL)) {
      const hasDisposition = (issue.commentBodies ?? []).some((body) => DISPOSITION_MARKER.test(body ?? ''));
      if (hasDisposition) continue;
      // Label without disposition is judged regardless of cutoff — the label
      // itself is a post-rule mechanism, so using it half-way is always wrong.
      violations.push({
        number: issue.number,
        title: issue.title,
        reason: `${EXCEPTION_LABEL} label present but no comment records an item-by-item disposition`,
      });
      continue;
    }
    const finding = {
      number: issue.number,
      title: issue.title,
      reason: 'closed as completed with unchecked task-list items and no closeout-exception label',
    };
    if (issue.closed_at && Date.parse(issue.closed_at) < cutoffMs) {
      legacy.push(finding);
    } else {
      violations.push(finding);
    }
  }
  return { violations, legacy };
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

  const { violations, legacy } = evaluateClosedIssues(issues);
  if (legacy.length) {
    console.log(`note: ${legacy.length} checklist-incomplete close(s) predate the ${ENFORCEMENT_CUTOFF} enforcement cutoff (reported only, not failed).`);
  }
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
