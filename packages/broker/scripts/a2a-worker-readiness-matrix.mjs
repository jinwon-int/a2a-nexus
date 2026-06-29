#!/usr/bin/env node
// A2A worker readiness matrix.
//
// Read-only by design. It joins broker capacity snapshots with a sanitized
// per-worker env/artifact audit and makes the important distinction explicit:
// online workers are not necessarily GitHub patch-capable workers. The script
// performs no SSH, GitHub writes, broker mutations, deploys, restarts, sends,
// ACK/replay, or secret movement.

import { readFile } from 'node:fs/promises';
import process from 'node:process';

function readOption(argv, name) {
  const inline = argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function usage() {
  return [
    'Usage: node scripts/a2a-worker-readiness-matrix.mjs --capacity capacity.json --audit audit.json [--json|--markdown]',
    '',
    'Inputs are sanitized JSON snapshots. Source-only/read-only: no live SSH, GitHub writes, broker mutations, or restarts.',
  ].join('\n');
}

function sanitize(value) {
  if (typeof value !== 'string') return value;
  return value
    .replace(/gh[pousr]_[A-Za-z0-9_]+/g, '[redacted-token]')
    .replace(/\b(TOKEN|SECRET|KEY|PASSWORD)=\S+/gi, '$1=[redacted]')
    .slice(0, 240);
}

function bool(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') return ['1', 'true', 'yes', 'y', 'present', 'ok'].includes(value.toLowerCase());
  return false;
}

function extractWorkers(snapshot) {
  if (Array.isArray(snapshot)) return snapshot;
  if (Array.isArray(snapshot?.workers)) return snapshot.workers;
  if (Array.isArray(snapshot?.items)) return snapshot.items;
  if (Array.isArray(snapshot?.data?.workers)) return snapshot.data.workers;
  throw new Error('worker snapshot must be an array or an object with .workers/.items array');
}

function workerId(worker = {}) {
  return sanitize(worker.id ?? worker.workerId ?? worker.nodeId ?? worker.name ?? worker.targetNodeId ?? 'unknown');
}

function normalizeCapacityWorker(worker = {}) {
  const id = workerId(worker);
  return {
    id,
    online: bool(worker.online ?? worker.status === 'online' ?? worker.connected ?? worker.healthy),
    active: Number(worker.active ?? worker.activeTasks ?? worker.counts?.active ?? 0) || 0,
    platform: sanitize(worker.platform ?? worker.metadata?.platform ?? worker.metadata?.runtime ?? 'unknown'),
  };
}

function normalizeAuditWorker(worker = {}) {
  const id = workerId(worker);
  return {
    id,
    hasClaudeConfig: bool(worker.hasClaudeConfig ?? worker.claudeConfigPresent ?? worker.claudeConfig ?? worker.env?.hasClaudeConfig),
    hasTrustedOperator: bool(worker.hasTrustedOperator ?? worker.trustedOperator ?? worker.env?.trustedOperator ?? worker.A2A_DOCKER_RUNNER_TRUSTED_OPERATOR),
    hasPatchBridge: bool(worker.hasPatchBridge ?? worker.patchBridgePresent ?? worker.bridge?.patch ?? worker.artifacts?.patchBridge),
    hasGitHubAuth: bool(worker.hasGitHubAuth ?? worker.githubAuthPresent ?? worker.ghAuth ?? worker.env?.hasGitHubAuth),
    mobile: bool(worker.mobile ?? worker.termux ?? worker.platform === 'termux'),
  };
}

function blockersFor({ capacity, audit }) {
  const blockers = [];
  if (!capacity.online) blockers.push('worker offline');
  if (!audit.hasClaudeConfig) blockers.push('missing Claude config');
  if (!audit.hasTrustedOperator) blockers.push('missing trusted-operator policy for GitHub mutation');
  if (!audit.hasPatchBridge) blockers.push('missing patch bridge script');
  if (!audit.hasGitHubAuth) blockers.push('missing GitHub auth');
  return blockers;
}

function dedupeCapacityWorkers(workers) {
  const byId = new Map();
  for (const worker of workers) {
    const current = byId.get(worker.id);
    if (!current) {
      byId.set(worker.id, worker);
      continue;
    }
    if (worker.online && !current.online) {
      byId.set(worker.id, worker);
      continue;
    }
    if (worker.online === current.online && worker.active > current.active) {
      byId.set(worker.id, worker);
    }
  }
  return [...byId.values()];
}

export function buildA2AWorkerReadinessMatrix(capacitySnapshot, auditSnapshot, options = {}) {
  let capacityWorkers = dedupeCapacityWorkers(extractWorkers(capacitySnapshot).map(normalizeCapacityWorker));
  const auditById = new Map(extractWorkers(auditSnapshot).map((worker) => {
    const normalized = normalizeAuditWorker(worker);
    return [normalized.id, normalized];
  }));
  if (options.onlyAudited) {
    capacityWorkers = capacityWorkers.filter((worker) => auditById.has(worker.id));
  }
  const workers = capacityWorkers.map((capacity) => {
    const audit = auditById.get(capacity.id) ?? {
      id: capacity.id,
      hasClaudeConfig: false,
      hasTrustedOperator: false,
      hasPatchBridge: false,
      hasGitHubAuth: false,
      mobile: capacity.platform === 'termux',
    };
    const blockers = blockersFor({ capacity, audit });
    const analysisCapable = capacity.online;
    const patchCapable = blockers.length === 0;
    return {
      id: capacity.id,
      online: capacity.online,
      active: capacity.active,
      platform: capacity.platform,
      analysisCapable,
      patchCapable,
      blockers,
      signals: {
        hasClaudeConfig: audit.hasClaudeConfig,
        hasTrustedOperator: audit.hasTrustedOperator,
        hasPatchBridge: audit.hasPatchBridge,
        hasGitHubAuth: audit.hasGitHubAuth,
        mobile: audit.mobile,
      },
    };
  });
  workers.sort((a, b) => a.id.localeCompare(b.id));
  const counts = {
    total: workers.length,
    online: workers.filter((worker) => worker.online).length,
    analysisCapable: workers.filter((worker) => worker.analysisCapable).length,
    patchCapable: workers.filter((worker) => worker.patchCapable).length,
    blockedPatch: workers.filter((worker) => !worker.patchCapable).length,
  };
  const ok = counts.total > 0 && counts.blockedPatch === 0;
  const summary = `A2A worker readiness: total=${counts.total}, online=${counts.online}, analysis-capable=${counts.analysisCapable}, patch-capable=${counts.patchCapable}, blocked-patch=${counts.blockedPatch}`;
  return {
    kind: 'broker.a2a-worker-readiness-matrix',
    generatedAt: new Date(options.nowMs ?? Date.now()).toISOString(),
    ok,
    counts,
    summary,
    workers,
  };
}

export function renderA2AWorkerReadinessMatrixMarkdown(report) {
  const title = report.ok ? 'PASS' : 'BLOCK';
  return [
    `${title}: A2A worker readiness matrix`,
    report.summary,
    '',
    '| worker | online | analysis | patch | blockers |',
    '|---|---:|---:|---:|---|',
    ...report.workers.map((worker) => `| ${worker.id} | ${worker.online ? 'yes' : 'no'} | ${worker.analysisCapable ? 'yes' : 'no'} | ${worker.patchCapable ? 'yes' : 'no'} | ${worker.blockers.join('; ') || 'none'} |`),
    '',
    'Safety: read-only matrix only; no SSH/live env changes, GitHub writes, broker mutation, deploy, restart, send, ACK/replay, or secret movement.',
  ].join('\n');
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(usage());
    return;
  }
  const capacityPath = readOption(argv, '--capacity');
  const auditPath = readOption(argv, '--audit');
  if (!capacityPath || !auditPath) {
    console.error(usage());
    process.exit(2);
  }
  const capacity = JSON.parse(await readFile(capacityPath, 'utf8'));
  const audit = JSON.parse(await readFile(auditPath, 'utf8'));
  const report = buildA2AWorkerReadinessMatrix(capacity, audit, { onlyAudited: argv.includes('--only-audited') });
  if (argv.includes('--json') || argv.includes('--format=json')) console.log(JSON.stringify(report, null, 2));
  else console.log(renderA2AWorkerReadinessMatrixMarkdown(report));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error('a2a-worker-readiness-matrix: ' + sanitize(message));
    process.exit(1);
  });
}
