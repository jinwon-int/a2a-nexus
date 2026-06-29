#!/usr/bin/env node
// A2A round artifact scanner.
//
// Read-only by design. Consumes broker task snapshots plus optional open PR list
// and detects post-round GitHub evidence drift: cross-repo PR/comment URLs,
// missing completion evidence for patch lanes, and open PR artifacts that still
// require finalizer review. It performs no GitHub writes, broker mutations,
// deploys, restarts, sends, ACK/replay, or secret movement.

import { readFile } from 'node:fs/promises';
import process from 'node:process';

const SAFE_URL_RE = /^https:\/\//;
const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'blocked', 'canceled', 'cancelled']);
const COMPLETION_KEYS = new Set(['prUrl', 'doneCommentUrl', 'blockCommentUrl', 'doneUrl', 'blockUrl']);
const URL_KEY_RE = /(url|Url|URL)$/;

function readOption(argv, name) {
  const inline = argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function usage() {
  return [
    'Usage: node scripts/a2a-round-artifact-scan.mjs --input tasks.json --repo owner/repo [--open-prs prs.json] [--json|--markdown]',
    '',
    'Reads task snapshots and optional open PR JSON. Source-only/read-only: no GitHub writes or broker mutations.',
  ].join('\n');
}

function isHttpsUrl(value) {
  return typeof value === 'string' && SAFE_URL_RE.test(value);
}

function sanitize(value) {
  if (typeof value !== 'string') return value;
  return value
    .replace(/gh[pousr]_[A-Za-z0-9_]+/g, '[redacted-token]')
    .replace(/\b(Authorization\s*[:=]\s*Bearer\s+)[^\s"']+/gi, '$1[redacted]')
    .replace(/\b(TOKEN|SECRET|KEY|PASSWORD)=\S+/gi, '$1=[redacted]')
    .replace(/([?&](?:token|access_token|api_key|key)=)[^&\s]+/gi, '$1[redacted]')
    .slice(0, 300);
}

function parseRepoFromGitHubUrl(url) {
  if (!isHttpsUrl(url)) return undefined;
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== 'github.com') return undefined;
    const [, owner, repo] = parsed.pathname.split('/');
    return owner && repo ? `${owner}/${repo}` : undefined;
  } catch {
    return undefined;
  }
}

function extractTasks(snapshot) {
  if (Array.isArray(snapshot)) return snapshot;
  if (Array.isArray(snapshot?.items)) return snapshot.items;
  if (Array.isArray(snapshot?.tasks)) return snapshot.tasks;
  if (Array.isArray(snapshot?.taskReport?.items)) return snapshot.taskReport.items;
  if (Array.isArray(snapshot?.operatorTaskReport?.items)) return snapshot.operatorTaskReport.items;
  throw new Error('task snapshot must be an array or an object with .items/.tasks/.taskReport.items array');
}

function taskWorker(task = {}) {
  return sanitize(task.assignedWorkerId ?? task.targetNodeId ?? task.claimedBy ?? task.worker ?? task.target?.id ?? 'unknown');
}

function maybeJson(value) {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function collectUrlEvidence(value, out = [], path = []) {
  const decoded = maybeJson(value);
  if (typeof decoded === 'string') {
    const lastKey = path.at(-1) ?? 'textUrl';
    if (URL_KEY_RE.test(lastKey) && isHttpsUrl(decoded)) {
      out.push({ key: lastKey, url: sanitize(decoded) });
      return out;
    }
    for (const match of decoded.matchAll(/https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/(?:pull|issues)\/\d+(?:#[A-Za-z0-9_.:-]+)?/g)) {
      out.push({ key: URL_KEY_RE.test(lastKey) ? lastKey : 'textUrl', url: sanitize(match[0]) });
    }
    return out;
  }
  if (!decoded || typeof decoded !== 'object') return out;
  if (Array.isArray(decoded)) {
    decoded.forEach((item, index) => collectUrlEvidence(item, out, [...path, String(index)]));
    return out;
  }
  for (const [key, nested] of Object.entries(decoded)) {
    if (URL_KEY_RE.test(key) && isHttpsUrl(nested)) out.push({ key, url: sanitize(nested) });
    else collectUrlEvidence(nested, out, [...path, key]);
  }
  return out;
}

function taskEvidenceUrls(task) {
  const roots = [
    task.github,
    task.payload?.github,
    task.result,
    task.result?.output,
    task.result?.payload,
    task.output,
    task.error,
    task.error?.details,
    task.error?.details?.stdout,
    task.error?.details?.stderr,
  ];
  const seen = new Set();
  const urls = [];
  for (const root of roots) {
    for (const entry of collectUrlEvidence(root)) {
      const id = `${entry.key}\u0000${entry.url}`;
      if (seen.has(id)) continue;
      seen.add(id);
      urls.push(entry);
    }
  }
  return urls;
}

function isLaneIdentityKey(key) {
  return key === 'issueUrl';
}

function hasCompletionEvidence(urls) {
  return urls.some((entry) => COMPLETION_KEYS.has(entry.key));
}

function normalizePrArtifact(pr) {
  const number = pr?.number ?? pr?.pr ?? pr?.id;
  return {
    number,
    title: sanitize(pr?.title ?? ''),
    headRefName: sanitize(pr?.headRefName ?? pr?.head ?? pr?.branch ?? ''),
    url: sanitize(pr?.url ?? pr?.html_url ?? ''),
    state: sanitize(pr?.state ?? 'unknown'),
  };
}

function prMatchesRoundTask(pr, tasks) {
  const haystack = `${pr.title ?? ''} ${pr.headRefName ?? ''} ${pr.url ?? ''}`;
  return tasks.some((task) => {
    const id = String(task.id ?? '');
    if (id && haystack.includes(id)) return true;
    const worker = taskWorker(task);
    const issue = String(task.payload?.issue ?? task.payload?.issueNumber ?? task.issue ?? task.laneIssue ?? '');
    return worker !== 'unknown' && issue && haystack.includes(worker) && haystack.includes(issue.replace(/^#/, ''));
  });
}

export function buildA2ARoundArtifactScan(snapshot, options = {}) {
  const expectedRepo = options.repo ?? options.expectedRepo;
  if (!expectedRepo) throw new Error('--repo owner/repo is required');
  const tasks = extractTasks(snapshot);
  const openPrs = Array.isArray(options.openPrs) ? options.openPrs : [];
  const canonicalEvidence = [];
  const crossRepoEvidence = [];
  const missingCompletionEvidence = [];

  for (const task of tasks) {
    const urls = taskEvidenceUrls(task);
    const taskId = sanitize(task.id ?? task.taskId ?? 'unknown');
    const worker = taskWorker(task);
    const status = sanitize(task.status ?? 'unknown');
    for (const entry of urls) {
      const repo = parseRepoFromGitHubUrl(entry.url);
      if (!repo) continue;
      const item = { taskId, worker, status, key: entry.key, url: entry.url, repo, expectedRepo };
      if (repo === expectedRepo && !isLaneIdentityKey(entry.key)) canonicalEvidence.push(item);
      else if (repo !== expectedRepo) crossRepoEvidence.push(item);
    }
    const intent = sanitize(task.intent ?? task.payload?.intent ?? '');
    if (intent === 'propose_patch' && TERMINAL_STATUSES.has(String(status)) && !hasCompletionEvidence(urls)) {
      missingCompletionEvidence.push({
        taskId,
        worker,
        status,
        intent,
        reason: 'propose_patch terminal lane lacks canonical prUrl/doneCommentUrl/blockCommentUrl evidence',
      });
    }
  }

  const openPrArtifacts = openPrs.map(normalizePrArtifact).filter((pr) => prMatchesRoundTask(pr, tasks));
  const counts = {
    canonicalEvidence: canonicalEvidence.length,
    crossRepoEvidence: crossRepoEvidence.length,
    missingCompletionEvidence: missingCompletionEvidence.length,
    openPrArtifacts: openPrArtifacts.length,
  };
  const ok = counts.crossRepoEvidence === 0 && counts.missingCompletionEvidence === 0 && counts.openPrArtifacts === 0;
  const summary = `A2A round artifact scan: tasks=${tasks.length}, canonical evidence=${counts.canonicalEvidence}, cross-repo evidence=${counts.crossRepoEvidence}, missing completion evidence=${counts.missingCompletionEvidence}, open PR artifacts=${counts.openPrArtifacts}`;
  return {
    kind: 'broker.a2a-round-artifact-scan',
    generatedAt: new Date(options.nowMs ?? Date.now()).toISOString(),
    expectedRepo,
    totalTasks: tasks.length,
    counts,
    ok,
    summary,
    crossRepoEvidence,
    missingCompletionEvidence,
    openPrArtifacts,
  };
}

export function renderA2ARoundArtifactScanMarkdown(report) {
  const title = report.ok ? 'PASS' : 'BLOCK';
  return [
    `${title}: A2A round artifact scan`,
    `Expected repo: ${report.expectedRepo}`,
    report.summary,
    '',
    'Cross-repo evidence:',
    ...(report.crossRepoEvidence.length ? report.crossRepoEvidence.map((item) => `- ${item.taskId} ${item.worker} ${item.key}: ${item.url} (repo=${item.repo})`) : ['- none']),
    '',
    'Missing patch completion evidence:',
    ...(report.missingCompletionEvidence.length ? report.missingCompletionEvidence.map((item) => `- ${item.taskId} ${item.worker}: ${item.reason}`) : ['- none']),
    '',
    'Open PR artifacts requiring finalizer review:',
    ...(report.openPrArtifacts.length ? report.openPrArtifacts.map((pr) => `- #${pr.number} ${pr.headRefName}: ${pr.url}`) : ['- none']),
    '',
    'Safety: read-only scan only; no GitHub writes, broker mutation, deploy, restart, send, ACK/replay, or secret movement.',
  ].join('\n');
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(usage());
    return;
  }
  const input = readOption(argv, '--input');
  const repo = readOption(argv, '--repo');
  const openPrsPath = readOption(argv, '--open-prs');
  if (!input || !repo) {
    console.error(usage());
    process.exit(2);
  }
  const snapshot = JSON.parse(await readFile(input, 'utf8'));
  const openPrs = openPrsPath ? JSON.parse(await readFile(openPrsPath, 'utf8')) : [];
  const report = buildA2ARoundArtifactScan(snapshot, { repo, openPrs });
  if (argv.includes('--json') || argv.includes('--format=json')) console.log(JSON.stringify(report, null, 2));
  else console.log(renderA2ARoundArtifactScanMarkdown(report));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error('a2a-round-artifact-scan: ' + sanitize(message));
    process.exit(1);
  });
}
