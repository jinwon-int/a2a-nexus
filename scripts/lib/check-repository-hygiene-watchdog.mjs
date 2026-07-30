#!/usr/bin/env node
/**
 * Read-only merged-branch residue watchdog (#1507).
 *
 * The GitHub reader below is intentionally GET-only. It inventories branches
 * and closed pull requests, then reports same-repository PR head branches that
 * still exist after merge. It never deletes a branch or changes repository
 * settings.
 */
import process from 'node:process';

const PER_PAGE = 100;
const MAX_PAGES = 100;

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
 * branch still exists. Default, `main`, and protected branches are preserved.
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
    finding.pullRequests.push({
      number: pullRequest.number,
      mergedAt: pullRequest.merged_at,
      headSha: pullRequest.head?.sha ?? null,
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

function escapeWorkflowCommand(value) {
  return String(value).replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
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
  const findings = findMergedBranchResidue(state);
  return reportFindings(findings);
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
