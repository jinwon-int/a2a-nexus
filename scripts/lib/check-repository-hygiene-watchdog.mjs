#!/usr/bin/env node
/**
 * Read-only repository hygiene watchdog (#1507, 2026-08-15 review follow-up).
 *
 * The GitHub reader below is intentionally GET-only. Two checks run per pass:
 *
 * 1. Merged-branch residue: inventories branches and closed pull requests,
 *    then reports same-repository PR head branches that still point to the
 *    exact commit that was merged.
 * 2. Default-branch run redness: reports every workflow whose LATEST run on
 *    the default branch concluded `failure`/`startup_failure`. Motivation: the
 *    2026-08-14 main push CI failed on a transient `dorny/paths-filter`
 *    archive download error (run 31778278226) and stayed red because no
 *    recurring lane watched main; the weekly cadence of this watchdog is the
 *    bounded safety net for exactly that class of incident.
 *
 * It never deletes a branch, re-runs a workflow, or changes repository
 * settings.
 */
import process from 'node:process';

const PER_PAGE = 100;
const MAX_PAGES = 100;

/** Run conclusions that count as "this lane is red on the default branch". */
const DEFAULT_BRANCH_FAILURE_CONCLUSIONS = new Set(['failure', 'startup_failure']);

function normalizedRepository(value) {
  return String(value ?? '').trim().toLowerCase();
}

function compareText(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function assertRepository(repository) {
  if (!/^[^/\s]+\/[^/\s]+$/.test(repository)) {
    throw new Error('GITHUB_REPOSITORY must have the form owner/repository');
  }
}

function repositoryPath(repository) {
  assertRepository(repository);
  return repository
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/');
}

/**
 * Return deterministic findings for merged, same-repository PR heads whose
 * branch still points to that PR's head commit. Default, `main`, and protected
 * branches are preserved.
 */
export function findMergedBranchResidue({
  repository,
  defaultBranch,
  branches,
  pullRequests,
}) {
  assertRepository(repository);
  if (!Array.isArray(branches) || !Array.isArray(pullRequests)) {
    throw new TypeError('branches and pullRequests must be arrays');
  }

  const candidates = new Map();
  for (const branch of branches) {
    if (!branch || typeof branch.name !== 'string' || branch.name.length === 0) continue;
    if (branch.name === 'main' || branch.name === defaultBranch || branch.protected === true) continue;
    candidates.set(branch.name, {
      branch: branch.name,
      headSha: branch.commit?.sha ?? null,
      pullRequests: [],
    });
  }

  const expectedRepository = normalizedRepository(repository);
  for (const pullRequest of pullRequests) {
    if (!pullRequest?.merged_at) continue;
    if (normalizedRepository(pullRequest.head?.repo?.full_name) !== expectedRepository) continue;

    const finding = candidates.get(pullRequest.head?.ref);
    if (!finding) continue;
    const pullRequestHeadSha = pullRequest.head?.sha;
    if (
      typeof finding.headSha !== 'string'
      || finding.headSha.length === 0
      || typeof pullRequestHeadSha !== 'string'
      || pullRequestHeadSha.length === 0
      || finding.headSha !== pullRequestHeadSha
    ) continue;
    finding.pullRequests.push({
      number: pullRequest.number,
      mergedAt: pullRequest.merged_at,
      headSha: pullRequestHeadSha,
      url: pullRequest.html_url ?? null,
    });
  }

  return [...candidates.values()]
    .filter((finding) => finding.pullRequests.length > 0)
    .map((finding) => ({
      ...finding,
      pullRequests: finding.pullRequests.sort((a, b) => a.number - b.number),
    }))
    .sort((a, b) => compareText(a.branch, b.branch));
}

function githubHeaders(token) {
  return {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
  };
}

async function getJson({ url, token, fetchImpl }) {
  const response = await fetchImpl(url, {
    method: 'GET',
    headers: githubHeaders(token),
  });
  if (!response.ok) {
    throw new Error(`GitHub API GET failed (${response.status}) for ${url}`);
  }
  return response.json();
}

async function getAllPages({ apiBase, path, query = {}, token, fetchImpl }) {
  const items = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const url = new URL(path, `${apiBase.replace(/\/+$/, '')}/`);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
    url.searchParams.set('per_page', String(PER_PAGE));
    url.searchParams.set('page', String(page));

    const pageItems = await getJson({ url: url.toString(), token, fetchImpl });
    if (!Array.isArray(pageItems)) {
      throw new TypeError(`GitHub API GET returned a non-array page for ${url}`);
    }
    items.push(...pageItems);
    if (pageItems.length < PER_PAGE) return items;
  }
  throw new Error(`GitHub API pagination exceeded the ${MAX_PAGES}-page safety limit for ${path}`);
}

/** Fetch the complete read-only input used by the pure evaluator. */
export async function readRepositoryHygieneState({
  repository,
  token,
  apiBase = 'https://api.github.com',
  fetchImpl = globalThis.fetch,
}) {
  assertRepository(repository);
  if (!token) throw new Error('GITHUB_TOKEN is required');
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch implementation is required');

  const repoPath = `/repos/${repositoryPath(repository)}`;
  const metadata = await getJson({
    url: new URL(repoPath, `${apiBase.replace(/\/+$/, '')}/`).toString(),
    token,
    fetchImpl,
  });
  if (typeof metadata?.default_branch !== 'string' || metadata.default_branch.length === 0) {
    throw new TypeError('GitHub repository response is missing default_branch');
  }

  const [branches, pullRequests] = await Promise.all([
    getAllPages({
      apiBase,
      path: `${repoPath}/branches`,
      token,
      fetchImpl,
    }),
    getAllPages({
      apiBase,
      path: `${repoPath}/pulls`,
      query: { state: 'closed', sort: 'updated', direction: 'desc' },
      token,
      fetchImpl,
    }),
  ]);

  return {
    repository,
    defaultBranch: metadata.default_branch,
    branches,
    pullRequests,
  };
}

/**
 * Fetch every workflow run recorded for the default branch (all workflows,
 * newest first per GitHub's default ordering). GET-only like the reader above.
 */
export async function readDefaultBranchWorkflowRuns({
  repository,
  defaultBranch,
  token,
  apiBase = 'https://api.github.com',
  fetchImpl = globalThis.fetch,
}) {
  assertRepository(repository);
  if (typeof defaultBranch !== 'string' || defaultBranch.length === 0) {
    throw new TypeError('defaultBranch must be a non-empty string');
  }
  if (!token) throw new Error('GITHUB_TOKEN is required');
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch implementation is required');

  const repoPath = `/repos/${repositoryPath(repository)}/actions/runs`;
  const runs = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const url = new URL(repoPath, `${apiBase.replace(/\/+$/, '')}/`);
    url.searchParams.set('branch', defaultBranch);
    url.searchParams.set('per_page', String(PER_PAGE));
    url.searchParams.set('page', String(page));

    const payload = await getJson({ url: url.toString(), token, fetchImpl });
    if (!payload || !Array.isArray(payload.workflow_runs)) {
      throw new TypeError(`GitHub API GET returned a malformed workflow-runs page for ${url}`);
    }
    runs.push(...payload.workflow_runs);
    if (payload.workflow_runs.length < PER_PAGE) return runs;
  }
  throw new Error(`GitHub API pagination exceeded the ${MAX_PAGES}-page safety limit for ${repoPath}`);
}

function escapeWorkflowCommand(value) {
  return String(value).replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
}

/**
 * Return deterministic findings for workflows whose latest default-branch run
 * failed. Runs from other branches (pull requests, feature branches) are
 * ignored; an older failed run of the same workflow is cleared by any newer
 * completed run regardless of its conclusion. Runs that are still in progress,
 * cancelled, timed out, skipped, or neutral conclusions (success, neutral)
 * do not raise a finding: a superseded or deliberately cancelled run is not
 * main redness. GitHub run ids are monotonic, so the highest id per workflow
 * name is the latest run.
 */
export function findDefaultBranchRunFailures({ defaultBranch, runs }) {
  if (typeof defaultBranch !== 'string' || defaultBranch.length === 0) {
    throw new TypeError('defaultBranch must be a non-empty string');
  }
  if (!Array.isArray(runs)) throw new TypeError('runs must be an array');

  const latest = new Map();
  for (const run of runs) {
    if (!run || typeof run !== 'object') continue;
    if (run.head_branch !== defaultBranch) continue;
    const workflow =
      typeof run.name === 'string' && run.name.length > 0
        ? run.name
        : typeof run.path === 'string' && run.path.length > 0
          ? run.path
          : 'unknown workflow';
    const current = latest.get(workflow);
    if (!current || Number(run.id ?? 0) > Number(current.id ?? 0)) {
      latest.set(workflow, run);
    }
  }

  return [...latest.entries()]
    .filter(([, run]) => DEFAULT_BRANCH_FAILURE_CONCLUSIONS.has(String(run.conclusion ?? '')))
    .map(([workflow, run]) => ({
      workflow,
      runId: run.id ?? null,
      conclusion: run.conclusion ?? null,
      event: run.event ?? null,
      createdAt: run.created_at ?? null,
      url: run.html_url ?? null,
    }))
    .sort((a, b) => compareText(a.workflow, b.workflow));
}

export function formatRunFailure(finding) {
  const at = finding.createdAt ? ` (created ${finding.createdAt})` : '';
  const event = finding.event ? `, event ${finding.event}` : '';
  return `${finding.workflow}: latest default-branch run ${finding.runId} concluded ${finding.conclusion}${event}${at}: ${finding.url ?? 'no url'}`;
}

export function reportRunFailures(findings, { error = console.error, log = console.log } = {}) {
  if (findings.length === 0) {
    log('repository hygiene watchdog ok: the latest default-branch run of every workflow is not failed');
    return 0;
  }

  error(`repository hygiene watchdog FAILED: ${findings.length} workflow(s) have their latest default-branch run failed`);
  for (const finding of findings) {
    const message = formatRunFailure(finding);
    error(`::warning title=Main branch CI redness::${escapeWorkflowCommand(message)}`);
    error(`  - ${message}`);
  }
  error(
    'This check is read-only: re-run the failed jobs or fix the cause in a reviewed PR. Transient runner/infrastructure failures (for example a pinned-action archive download error) are resolved by re-running the failed jobs; no workflow or setting was changed here.',
  );
  return 1;
}

export function formatFinding(finding) {
  const prs = finding.pullRequests.map((pullRequest) => `#${pullRequest.number}`).join(', ');
  const sha = finding.headSha ? ` at ${finding.headSha}` : '';
  return `${finding.branch}${sha} remains after merged same-repository PR(s) ${prs}`;
}

export function reportFindings(findings, { error = console.error, log = console.log } = {}) {
  if (findings.length === 0) {
    log('repository hygiene watchdog ok: no merged same-repository PR head branches remain');
    return 0;
  }

  error(`repository hygiene watchdog FAILED: ${findings.length} merged PR head branch(es) still exist`);
  for (const finding of findings) {
    const message = formatFinding(finding);
    error(`::warning title=Merged branch residue::${escapeWorkflowCommand(message)}`);
    error(`  - ${message}`);
  }
  error(
    'This check is read-only: review the branches and use a separately approved cleanup process; no branch or setting was changed.',
  );
  return 1;
}

async function main() {
  const repository = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;
  if (!repository) throw new Error('GITHUB_REPOSITORY is required');

  const state = await readRepositoryHygieneState({
    repository,
    token,
    apiBase: process.env.GITHUB_API_URL || 'https://api.github.com',
  });
  const residueFindings = findMergedBranchResidue(state);
  const residueExit = reportFindings(residueFindings);

  const runs = await readDefaultBranchWorkflowRuns({
    repository,
    defaultBranch: state.defaultBranch,
    token,
    apiBase: process.env.GITHUB_API_URL || 'https://api.github.com',
  });
  const runFindings = findDefaultBranchRunFailures({
    defaultBranch: state.defaultBranch,
    runs,
  });
  const runExit = reportRunFailures(runFindings);

  return Math.max(residueExit, runExit);
}

const isDirectRun =
  process.argv[1] && new URL(import.meta.url).pathname === process.argv[1];
if (isDirectRun) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(`repository hygiene watchdog errored: ${error.message}`);
      process.exit(1);
    },
  );
}
