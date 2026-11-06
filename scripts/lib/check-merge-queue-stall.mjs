#!/usr/bin/env node
/**
 * Read-only merge-queue stall watchdog (a2a-nexus#2501, part 3).
 *
 * Incident (2026-11-06, PR #2500): `auto-merge.yml` admitted a PR to the merge
 * queue with the workflow `GITHUB_TOKEN`. Events performed with that token do
 * not start new workflow runs, so no `merge_group` run was ever created for the
 * queue entry. The entry sat in `AWAITING_CHECKS` until the queue's
 * `checkResponseTimeout` (3600 s) removed it as `checks_timed_out` 63 minutes
 * later. A human re-enqueue started the four required runs within 18 seconds.
 *
 * This watchdog makes that state visible minutes after admission instead of an
 * hour later. A finding is a queue entry that is
 *   - in state `AWAITING_CHECKS`,
 *   - older than the threshold (default 5 minutes), and
 *   - has zero `merge_group` workflow runs created since it was enqueued.
 *
 * Healthy entries get their `merge_group` runs within seconds, so a 5-minute
 * window with zero runs is not "slow CI"; it means nothing will ever report.
 *
 * Reads only: one GraphQL query (POST, but a query — no mutation is sent) and
 * GET requests for workflow runs. It never dequeues, re-enqueues, re-runs, or
 * changes repository settings; the operator decides the remedy.
 */
import process from 'node:process';

export const DEFAULT_STALL_MINUTES = 5;
const RUNS_PER_PAGE = 100;
const RUNS_MAX_PAGES = 5;

/** Actors whose enqueue is known not to trigger `merge_group` workflows. */
const TOKEN_ACTOR_LOGINS = new Set(['github-actions', 'github-actions[bot]']);

const MERGE_QUEUE_QUERY = `query($owner: String!, $name: String!, $branch: String!) {
  repository(owner: $owner, name: $name) {
    defaultBranchRef { name }
    mergeQueue(branch: $branch) {
      url
      configuration { checkResponseTimeout }
      entries(first: 100) {
        nodes {
          state
          enqueuedAt
          position
          headCommit { oid }
          pullRequest { number url }
          enqueuer { login }
        }
      }
    }
  }
}`;

function assertRepository(repository) {
  if (!/^[^/\s]+\/[^/\s]+$/.test(String(repository ?? ''))) {
    throw new Error('GITHUB_REPOSITORY must have the form owner/repository');
  }
}

function parseTime(value) {
  const ms = Date.parse(String(value ?? ''));
  return Number.isFinite(ms) ? ms : null;
}

/**
 * True when `run` is a `merge_group` run that belongs to `entry` and was
 * created at or after the entry's admission. A run from an earlier admission of
 * the same PR (same `pr-<n>-` head branch) does not count.
 */
export function runBelongsToEntry(run, entry, { branch }) {
  if (!run || run.event !== 'merge_group') return false;
  const enqueuedAt = parseTime(entry.enqueuedAt);
  const createdAt = parseTime(run.created_at);
  if (enqueuedAt !== null && (createdAt === null || createdAt < enqueuedAt)) return false;

  const headOid = entry.headCommit?.oid;
  if (typeof headOid === 'string' && headOid.length > 0 && run.head_sha === headOid) return true;

  const number = entry.pullRequest?.number;
  if (!Number.isInteger(number)) return false;
  const prefix = `gh-readonly-queue/${branch}/pr-${number}-`;
  return typeof run.head_branch === 'string' && run.head_branch.startsWith(prefix);
}

/**
 * Return deterministic stall findings, ordered by queue position then PR.
 */
export function findMergeQueueStalls({
  entries,
  runs,
  now,
  branch = 'main',
  stallMinutes = DEFAULT_STALL_MINUTES,
}) {
  if (!Array.isArray(entries) || !Array.isArray(runs)) {
    throw new TypeError('entries and runs must be arrays');
  }
  const nowMs = typeof now === 'number' ? now : parseTime(now);
  if (nowMs === null) throw new TypeError('now must be a timestamp');
  if (!(Number.isFinite(stallMinutes) && stallMinutes > 0)) {
    throw new TypeError('stallMinutes must be a positive number');
  }

  const findings = [];
  for (const entry of entries) {
    if (!entry || entry.state !== 'AWAITING_CHECKS') continue;
    const enqueuedAt = parseTime(entry.enqueuedAt);
    if (enqueuedAt === null) continue;
    const ageMinutes = (nowMs - enqueuedAt) / 60000;
    if (ageMinutes < stallMinutes) continue;
    if (runs.some((run) => runBelongsToEntry(run, entry, { branch }))) continue;

    const enqueuer = entry.enqueuer?.login ?? null;
    findings.push({
      pullRequest: entry.pullRequest?.number ?? null,
      url: entry.pullRequest?.url ?? null,
      position: entry.position ?? null,
      enqueuedAt: entry.enqueuedAt,
      ageMinutes: Math.floor(ageMinutes),
      enqueuer,
      tokenEnqueue: enqueuer !== null && TOKEN_ACTOR_LOGINS.has(enqueuer),
    });
  }
  return findings.sort(
    (a, b) => (a.position ?? Infinity) - (b.position ?? Infinity) || (a.pullRequest ?? 0) - (b.pullRequest ?? 0),
  );
}

function escapeWorkflowCommand(value) {
  return String(value).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

export function formatStall(finding, { timeoutSeconds } = {}) {
  const pr = finding.pullRequest === null ? 'unknown PR' : `PR #${finding.pullRequest}`;
  const by = finding.enqueuer ? ` by ${finding.enqueuer}` : '';
  const timeout = Number.isFinite(timeoutSeconds)
    ? `; the queue removes it at ${Math.round(timeoutSeconds / 60)} min (checks_timed_out)`
    : '';
  const cause = finding.tokenEnqueue
    ? ' Cause: the enqueue used the workflow GITHUB_TOKEN, which never starts merge_group workflows (#2501). Re-enqueue with a person account.'
    : '';
  return `${pr} enqueued${by} at ${finding.enqueuedAt} is AWAITING_CHECKS for ${finding.ageMinutes} min with 0 merge_group runs${timeout}.${cause}`;
}

export function reportStalls(findings, { error = console.error, log = console.log, timeoutSeconds } = {}) {
  if (findings.length === 0) {
    log('merge-queue stall watchdog ok: every AWAITING_CHECKS entry has merge_group runs (or is younger than the threshold)');
    return 0;
  }
  error(`merge-queue stall watchdog FAILED: ${findings.length} queue entr${findings.length === 1 ? 'y has' : 'ies have'} no merge_group runs`);
  for (const finding of findings) {
    const message = formatStall(finding, { timeoutSeconds });
    error(`::error title=Merge queue entry without merge_group runs::${escapeWorkflowCommand(message)}`);
    error(`  - ${message}${finding.url ? ` ${finding.url}` : ''}`);
  }
  error('This check is read-only: nothing was dequeued, re-enqueued, or re-run.');
  return 1;
}

function githubHeaders(token) {
  const headers = {
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
  };
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}

async function readJson(response, what) {
  if (!response.ok) throw new Error(`GitHub API ${what} failed (${response.status})`);
  return response.json();
}

/**
 * Read the merge queue and the `merge_group` runs created since the oldest
 * entry was admitted.
 */
export async function readMergeQueueState({
  repository,
  token,
  branch,
  apiBase = 'https://api.github.com',
  graphqlUrl,
  fetchImpl = globalThis.fetch,
}) {
  assertRepository(repository);
  const [owner, name] = repository.split('/');
  const base = apiBase.replace(/\/+$/, '');
  const gqlResponse = await fetchImpl(graphqlUrl ?? `${base}/graphql`, {
    method: 'POST',
    headers: { ...githubHeaders(token), 'content-type': 'application/json' },
    body: JSON.stringify({ query: MERGE_QUEUE_QUERY, variables: { owner, name, branch: branch ?? 'main' } }),
  });
  const gql = await readJson(gqlResponse, 'GraphQL merge queue query');
  if (Array.isArray(gql.errors) && gql.errors.length > 0) {
    throw new Error(`GitHub GraphQL errors: ${gql.errors.map((e) => e.message).join('; ')}`);
  }
  const repo = gql.data?.repository;
  const resolvedBranch = branch ?? repo?.defaultBranchRef?.name ?? 'main';
  const queue = repo?.mergeQueue ?? null;
  const entries = queue?.entries?.nodes ?? [];
  const timeoutSeconds = queue?.configuration?.checkResponseTimeout ?? null;

  const enqueuedTimes = entries.map((entry) => parseTime(entry?.enqueuedAt)).filter((t) => t !== null);
  if (enqueuedTimes.length === 0) {
    return { branch: resolvedBranch, queueEnabled: queue !== null, entries, runs: [], timeoutSeconds };
  }
  const since = new Date(Math.min(...enqueuedTimes)).toISOString();

  const runs = [];
  for (let page = 1; page <= RUNS_MAX_PAGES; page += 1) {
    const url = new URL(`${base}/repos/${owner}/${name}/actions/runs`);
    url.searchParams.set('event', 'merge_group');
    url.searchParams.set('created', `>=${since}`);
    url.searchParams.set('per_page', String(RUNS_PER_PAGE));
    url.searchParams.set('page', String(page));
    const response = await fetchImpl(url.toString(), { method: 'GET', headers: githubHeaders(token) });
    const body = await readJson(response, 'GET workflow runs');
    const pageRuns = Array.isArray(body.workflow_runs) ? body.workflow_runs : [];
    runs.push(...pageRuns);
    if (pageRuns.length < RUNS_PER_PAGE) break;
  }
  return { branch: resolvedBranch, queueEnabled: queue !== null, entries, runs, timeoutSeconds };
}

async function main() {
  const repository = process.env.GITHUB_REPOSITORY;
  if (!repository) throw new Error('GITHUB_REPOSITORY is required');
  const stallMinutes = process.env.MERGE_QUEUE_STALL_MINUTES
    ? Number(process.env.MERGE_QUEUE_STALL_MINUTES)
    : DEFAULT_STALL_MINUTES;
  const state = await readMergeQueueState({
    repository,
    token: process.env.GITHUB_TOKEN,
    branch: process.env.MERGE_QUEUE_BRANCH || undefined,
    apiBase: process.env.GITHUB_API_URL || 'https://api.github.com',
    graphqlUrl: process.env.GITHUB_GRAPHQL_URL || undefined,
  });
  if (!state.queueEnabled) {
    console.log(`merge-queue stall watchdog ok: no merge queue on ${state.branch}`);
    return 0;
  }
  const findings = findMergeQueueStalls({
    entries: state.entries,
    runs: state.runs,
    now: Date.now(),
    branch: state.branch,
    stallMinutes,
  });
  return reportStalls(findings, { timeoutSeconds: state.timeoutSeconds ?? undefined });
}

const isDirectRun = process.argv[1] && new URL(import.meta.url).pathname === process.argv[1];
if (isDirectRun) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(`merge-queue stall watchdog errored: ${error.message}`);
      process.exit(1);
    },
  );
}
