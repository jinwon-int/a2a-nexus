#!/usr/bin/env node
// Libero public preflight aggregate closeout (issue #44).
//
// Read-only by design. This consumes sanitized evidence for workerGamma, workerBeta,
// and workerAlpha lanes, then renders Done/Waiting/Block evidence. It never changes
// repository visibility, publishes artifacts, deploys, restarts services,
// mutates databases, sends live provider/Telegram messages, ACKs terminal
// outbox records, rotates secrets, rewrites history, or force-pushes.

import process from 'node:process';
import { readFile } from 'node:fs/promises';

export const ISSUE = '#44';
export const PARENT_ISSUE = '#40';
export const REQUIRED_WORKERS = ['workerGamma', 'workerBeta', 'workerAlpha'];

const ACTIVE_STATUSES = new Set(['queued', 'claimed', 'running', 'active', 'pending', 'waiting']);
const SUCCESS_STATUSES = new Set(['succeeded', 'success', 'completed', 'complete', 'done', 'ready']);
const BLOCKED_STATUSES = new Set(['blocked', 'failed', 'failure', 'canceled', 'cancelled', 'error']);
const UNSAFE_FLAGS = [
  'visibilityChanged',
  'publicVisibilityChanged',
  'npmPublished',
  'dockerPublished',
  'releaseCreated',
  'deployed',
  'gatewayRestarted',
  'brokerRestarted',
  'workerRestarted',
  'productionDbMutated',
  'providerMessageSent',
  'telegramMessageSent',
  'terminalOutboxAcked',
  'secretRotated',
  'secretDisclosed',
  'historyRewritten',
  'forcePushed',
];

function parseArgs(argv) {
  const readOption = (name) => {
    const prefix = `${name}=`;
    const inline = argv.find((arg) => arg.startsWith(prefix));
    if (inline) return inline.slice(prefix.length);
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  return {
    input: readOption('--input'),
    json: argv.includes('--json') || argv.includes('--format=json'),
    markdown: argv.includes('--markdown') || argv.includes('--format=markdown'),
  };
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function bool(value) {
  return value === true || value === 'true' || value === 'yes';
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '');
}

function safeToken(value, fallback = '<missing>') {
  if (value === undefined || value === null || value === '') return fallback;
  const text = String(value);
  if (/^[A-Za-z0-9._:#/-]{1,120}$/.test(text) && !/token|secret|chat_id|BROKER_EDGE_SECRET|\/work\/|\/root\//i.test(text)) return text;
  return `<${Array.isArray(value) ? 'array' : typeof value}>`;
}

function isHttpsUrl(value) {
  return typeof value === 'string' && /^https:\/\//.test(value);
}

function evidenceUrl(lane = {}) {
  const github = lane.github && typeof lane.github === 'object' ? lane.github : {};
  return firstDefined(
    lane.prUrl,
    lane.doneCommentUrl,
    lane.blockCommentUrl,
    lane.branchUrl,
    github.prUrl,
    github.doneCommentUrl,
    github.blockCommentUrl,
    github.branchUrl,
  );
}

function laneForWorker(evidence, workerId) {
  const lanes = asArray(firstDefined(evidence.lanes, evidence.workers, evidence.taskReport?.items));
  return lanes.find((lane) => firstDefined(lane.worker, lane.workerId, lane.targetNodeId, lane.assignedWorkerId, lane.github?.nodeId) === workerId);
}

function classifyLane(lane, workerId) {
  if (!lane) {
    return { workerId, state: 'waiting', status: 'missing', evidenceUrl: undefined, reason: 'No lane evidence supplied.' };
  }

  const status = String(firstDefined(lane.status, lane.state, lane.conclusion, lane.github?.status, 'unknown')).toLowerCase();
  const url = evidenceUrl(lane);
  const hasEvidence = isHttpsUrl(url);

  if (BLOCKED_STATUSES.has(status) || isHttpsUrl(lane.blockCommentUrl) || isHttpsUrl(lane.github?.blockCommentUrl)) {
    return { workerId, state: 'blocked', status, evidenceUrl: url, reason: 'Lane is blocked or failed.' };
  }
  if (SUCCESS_STATUSES.has(status)) {
    return hasEvidence
      ? { workerId, state: 'completed', status, evidenceUrl: url, reason: 'Completed with canonical HTTPS evidence.' }
      : { workerId, state: 'needs-evidence', status, evidenceUrl: url, reason: 'Terminal lane lacks PR/Done/Block/branch evidence.' };
  }
  if (ACTIVE_STATUSES.has(status) || status === 'unknown') {
    return { workerId, state: 'waiting', status, evidenceUrl: url, reason: 'Lane is not terminal yet.' };
  }
  return { workerId, state: 'blocked', status, evidenceUrl: url, reason: `Unrecognized lane status ${safeToken(status)}.` };
}

function scannerClean(evidence) {
  const scanner = evidence.scanner ?? evidence.scanners ?? {};
  const publicReadiness = firstDefined(scanner.publicReadiness?.ok, scanner.publicReadinessClean, evidence.publicReadinessClean);
  const external = firstDefined(
    scanner.externalSecretHistory?.ok,
    scanner.externalSecrets?.ok,
    scanner.externalSecretScan?.ok,
    scanner.externalScannerClean,
    evidence.externalScannerClean,
  );
  return {
    publicReadiness: publicReadiness === true,
    externalSecretHistory: external === true,
    ok: publicReadiness === true && external === true,
  };
}

function approvalState(evidence) {
  const approval = evidence.approval ?? {};
  const explicitVisibilityApproval = bool(firstDefined(approval.explicitVisibilityApproval, evidence.explicitVisibilityApproval, false));
  const operatorApprovalSeparated = bool(firstDefined(approval.operatorApprovalSeparated, approval.approvalSeparated, evidence.operatorApprovalSeparated, false));
  const visibilityExecutionSeparated = bool(firstDefined(approval.visibilityExecutionSeparated, approval.executionSeparated, evidence.visibilityExecutionSeparated, false));
  return {
    explicitVisibilityApproval,
    operatorApprovalSeparated,
    visibilityExecutionSeparated,
    separated: operatorApprovalSeparated && visibilityExecutionSeparated,
  };
}

function safetyState(evidence) {
  const source = evidence.safety ?? evidence;
  const unsafe = UNSAFE_FLAGS.filter((flag) => bool(source[flag]));
  const repositoryPrivate = firstDefined(evidence.repository?.private, evidence.repoPrivate, evidence.github?.private);
  if (repositoryPrivate !== true) unsafe.push('repositoryPrivateMissing');
  return { ok: unsafe.length === 0, unsafe };
}

function countByState(lanes) {
  return lanes.reduce((acc, lane) => ({ ...acc, [lane.state]: (acc[lane.state] ?? 0) + 1 }), {});
}

export function buildLiberoPublicPreflightCloseout(evidence, options = {}) {
  const requiredWorkers = options.requiredWorkers ?? evidence.requiredWorkers ?? REQUIRED_WORKERS;
  const lanes = requiredWorkers.map((workerId) => classifyLane(laneForWorker(evidence, workerId), workerId));
  const counts = countByState(lanes);
  const scanner = scannerClean(evidence);
  const approval = approvalState(evidence);
  const safety = safetyState(evidence);

  const blockers = [];
  if (!safety.ok) blockers.push(`unsafe or unverifiable safety flag(s): ${safety.unsafe.map((item) => safeToken(item)).join(', ')}`);
  if ((counts.blocked ?? 0) > 0) blockers.push(`${counts.blocked} lane(s) blocked`);
  if ((counts.needsEvidence ?? 0) > 0) blockers.push(`${counts.needsEvidence} terminal lane(s) missing canonical evidence`);
  if (!scanner.ok) blockers.push('scanner evidence is not clean for both public-readiness and external secret/history gates');
  if (!approval.separated) blockers.push('operator approval is not explicitly separated from visibility execution');

  const waiting = (counts.waiting ?? 0) > 0;
  const state = waiting ? 'waiting' : blockers.length > 0 ? 'blocked' : approval.explicitVisibilityApproval ? 'go-review-only' : 'ready-no-go';
  const ok = state === 'ready-no-go' || state === 'go-review-only';
  const visibilityDecision = state === 'go-review-only'
    ? 'GO authorized for operator-controlled visibility execution; renderer remains read-only.'
    : 'NO-GO for public visibility; await explicit operator approval.';

  return {
    kind: 'libero.public-preflight-closeout',
    issue: ISSUE,
    parent: PARENT_ISSUE,
    generatedAt: new Date(options.nowMs ?? Date.now()).toISOString(),
    requiredWorkers,
    lanes,
    counts,
    scanner,
    approval,
    safety,
    state,
    ok,
    blockers,
    visibilityDecision,
  };
}

export function renderLiberoPublicPreflightCloseoutMarkdown(report) {
  const title = report.state === 'waiting' ? 'Waiting' : report.ok ? 'Done' : 'Block';
  const counts = ['completed', 'waiting', 'blocked', 'needs-evidence']
    .map((state) => `${state}=${report.counts?.[state] ?? 0}`)
    .join(', ');
  return [
    `${title}: Team1 P0 libero public preflight aggregate`,
    `Issue: ${ISSUE} (parent ${PARENT_ISSUE})`,
    `Decision: ${report.visibilityDecision}`,
    `Required lanes: ${report.requiredWorkers.join(',')}`,
    `Lane counts: ${counts}`,
    `Scanners: public-readiness=${report.scanner.publicReadiness ? 'clean' : 'not-clean'}; external-secret/history=${report.scanner.externalSecretHistory ? 'clean' : 'not-clean'}`,
    `Approval separation: operator=${report.approval.operatorApprovalSeparated ? 'yes' : 'no'}; execution=${report.approval.visibilityExecutionSeparated ? 'yes' : 'no'}; explicit-visibility-approval=${report.approval.explicitVisibilityApproval ? 'yes' : 'no'}`,
    '',
    'Lane evidence:',
    ...report.lanes.map((lane) => `- ${lane.workerId} | ${lane.state} | ${safeToken(lane.evidenceUrl, 'missing-evidence')} | ${lane.reason}`),
    ...(report.blockers.length > 0 ? ['', 'Blockers:', ...report.blockers.map((blocker) => `- ${blocker}`)] : []),
    '',
    'Safety: read-only redacted evidence only; no visibility change, publish, release, deploy, restart, DB mutation, provider/Telegram send, terminal ACK, secret rotation/disclosure, history rewrite, or force-push.',
  ].join('\n');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.input) throw new Error('usage: node scripts/libero-public-preflight-closeout.mjs --input <sanitized-evidence.json> [--markdown|--json]');
  const evidence = JSON.parse(await readFile(options.input, 'utf8'));
  const report = buildLiberoPublicPreflightCloseout(evidence);
  if (options.markdown && !options.json) console.log(renderLiberoPublicPreflightCloseoutMarkdown(report));
  else console.log(JSON.stringify(report, null, 2));
  process.exit(report.ok ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`libero-public-preflight-closeout: ${safeToken(error.message)}`);
    process.exit(2);
  });
}
