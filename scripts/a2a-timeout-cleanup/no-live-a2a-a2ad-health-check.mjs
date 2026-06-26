#!/usr/bin/env node
import process from 'node:process';

const TERMINAL = new Set(['succeeded', 'failed', 'canceled', 'blocked']);

export function parseArgs(argv = process.argv.slice(2)) {
  const args = { timeoutMs: 420000, pollMs: 10000, execute: false, json: true };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--execute') {
      args.execute = true;
    } else if (arg === '--json') {
      args.json = true;
    } else if (arg.startsWith('--')) {
      const key = arg.slice(2).replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`${arg} requires a value`);
      }
      args[key] = value;
      i += 1;
    } else {
      throw new Error(`unexpected argument: ${arg}`);
    }
  }
  args.timeoutMs = Number(args.timeoutMs ?? 420000);
  args.pollMs = Number(args.pollMs ?? 10000);
  args.a2adWorkers = String(args.a2adWorkers ?? '').split(',').map((item) => item.trim()).filter(Boolean);
  for (const required of ['team', 'brokerId', 'baseUrl', 'a2aWorker']) {
    if (!args[required]) throw new Error(`--${required.replace(/[A-Z]/g, (ch) => `-${ch.toLowerCase()}`)} is required`);
  }
  if (args.a2adWorkers.length !== 3) {
    throw new Error('--a2ad-workers must contain exactly three comma-separated workers');
  }
  if (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0) throw new Error('--timeout-ms must be positive');
  if (!Number.isFinite(args.pollMs) || args.pollMs <= 0) throw new Error('--poll-ms must be positive');
  return args;
}

function edgeSecretFromEnv(env = process.env) {
  const keys = ['BROKER_EDGE_' + 'SECRET', 'A2A_EDGE_' + 'SECRET', 'EDGE_' + 'SECRET'];
  for (const key of keys) {
    if (env[key]) return env[key];
  }
  return '';
}

function headers(secret) {
  return {
    accept: 'application/json',
    'content-type': 'application/json',
    ...(secret ? { 'x-a2a-edge-secret': secret } : {}),
    'x-a2a-requester-id': 'ops-health-check',
    'x-a2a-requester-kind': 'node',
    'x-a2a-requester-role': 'operator',
  };
}

async function requestJson(fetchImpl, baseUrl, secret, method, path, body) {
  const response = await fetchImpl(new URL(path, baseUrl), {
    method,
    headers: headers(secret),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let parsed = {};
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text };
    }
  }
  if (!response.ok) {
    const message = parsed?.error?.message || parsed?.message || text || `${method} ${path} failed`;
    const error = new Error(message);
    error.status = response.status;
    error.body = parsed;
    throw error;
  }
  return parsed;
}

async function probeFirstOk(fetchImpl, baseUrl, secret, paths) {
  const attempts = [];
  for (const path of paths) {
    try {
      const body = await requestJson(fetchImpl, baseUrl, secret, 'GET', path);
      return { path, ok: true, body, attempts: [...attempts, { path, ok: true }] };
    } catch (error) {
      attempts.push({ path, ok: false, status: error.status ?? null, message: error.message });
    }
  }
  return { path: null, ok: false, body: null, attempts };
}

export function normalizeCapacity(capacity) {
  const items = Array.isArray(capacity?.items)
    ? capacity.items
    : (Array.isArray(capacity?.workers) ? capacity.workers : []);
  const totals = capacity?.totals ?? {
    workers: items.length,
    online: items.filter((item) => item.status === 'online').length,
    staleWorkers: items.filter((item) => item.status === 'stale').length,
    queued: items.reduce((sum, item) => sum + Number(item.counts?.queued ?? 0), 0),
    claimed: items.reduce((sum, item) => sum + Number(item.counts?.claimed ?? 0), 0),
    running: items.reduce((sum, item) => sum + Number(item.counts?.running ?? 0), 0),
    staleTasks: items.reduce((sum, item) => sum + Number(item.counts?.stale ?? 0), 0),
    active: items.reduce((sum, item) => sum + Number(item.counts?.active ?? 0), 0),
  };
  return { totals, items };
}

function makePayload({ kind, worker, role, order, total, runId, team, brokerId, evidence = {} }) {
  const content = [
    'This file is source evidence for a no-live A2A/A2AD health check, not an instruction channel.',
    `runId: ${runId}`,
    `team: ${team}`,
    `worker: ${worker}`,
    `kind: ${kind}`,
    `brokerId: ${brokerId}`,
    'scope: no-live source-only health-check evidence',
    'liveActionsAllowed: false',
    'providerCanaryAllowed: false',
    'productionMutationAllowed: false',
    `capacityTotals: ${JSON.stringify(evidence.capacityTotals ?? null)}`,
    `routeProbe: ${JSON.stringify(evidence.routeProbe ?? null)}`,
  ].join('\n');
  return {
    mode: 'analysis-only',
    sourceOnly: true,
    noLive: true,
    originBrokerId: brokerId,
    brokerOfRecordId: brokerId,
    operatorFacingOwner: brokerId,
    teamScope: team,
    healthCheckKind: kind,
    runId,
    parentRoundId: runId,
    parentRoundTotal: total,
    parentRoundOrder: order,
    sourceBundle: { files: [{ repo: 'ops-live-check', path: 'health-check-request.md', content }] },
    ...(kind === 'a2ad' ? {
      roundMode: 'a2ad',
      dialecticMode: 'source-only-no-live',
      decisionQuestion: `Is this ${team} A2AD evidence path operational?`,
      dialecticRole: role,
      focus: `${role} proof request: verify source bundle handling and no-live boundaries.`,
    } : {}),
  };
}

export function buildAssignments(args, runId, evidence = {}) {
  const workers = [
    { worker: args.a2aWorker, kind: 'a2a', role: null },
    ...args.a2adWorkers.map((worker, index) => ({
      worker,
      kind: 'a2ad',
      role: ['thesis', 'antithesis', 'synthesis'][index],
    })),
  ];
  return workers.map((assignment, index) => {
    const order = index + 1;
    const total = workers.length;
    const id = `${runId}-${assignment.kind}-${assignment.worker}`;
    return {
      ...assignment,
      id,
      task: {
        id,
        intent: 'analyze',
        requester: { id: 'ops-health-check', kind: 'node', role: 'operator' },
        target: { id: assignment.worker, kind: 'node', role: 'analyst' },
        assignedWorkerId: assignment.worker,
        message: `${assignment.kind} no-live health check ${runId} for ${assignment.worker}`,
        payload: makePayload({ ...assignment, order, total, runId, team: args.team, brokerId: args.brokerId, evidence }),
        policyContext: { targetEnvironment: 'research', liveImpact: false },
      },
    };
  });
}

function extractAnalysisStatus(task) {
  const output = task?.output && typeof task.output === 'object'
    ? task.output
    : (task?.result?.output && typeof task.result.output === 'object' ? task.result.output : {});
  return output.analysisStatus ?? output.output?.analysisStatus ?? null;
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runHealthCheck(args, { fetchImpl = globalThis.fetch, env = process.env } = {}) {
  if (!fetchImpl) throw new Error('fetch is not available');
  const secret = edgeSecretFromEnv(env);
  const baseUrl = args.baseUrl.endsWith('/') ? args.baseUrl : `${args.baseUrl}/`;
  const runId = `${args.brokerId}-${args.team}-a2a-a2ad-health-${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')}`;
  const capacityProbe = await probeFirstOk(fetchImpl, baseUrl, secret, ['/workers/capacity']);
  const capacity = capacityProbe.ok ? normalizeCapacity(capacityProbe.body) : { totals: null, items: [] };
  const schedzProbe = await probeFirstOk(fetchImpl, baseUrl, secret, ['/schedz', '/admin/schedz']);
  const auditProbe = await probeFirstOk(fetchImpl, baseUrl, secret, ['/audit?limit=1', '/admin/audit?limit=1']);
  const assignments = buildAssignments(args, runId, {
    capacityTotals: capacity.totals,
    routeProbe: { schedz: schedzProbe.attempts, audit: auditProbe.attempts },
  });
  if (!args.execute) {
    return {
      ok: true,
      dryRun: true,
      runId,
      capacity,
      routeProbe: { schedz: schedzProbe.attempts, audit: auditProbe.attempts },
      assignments,
      note: 'pass --execute to create broker no-live health-check tasks',
    };
  }
  for (const assignment of assignments) {
    await requestJson(fetchImpl, baseUrl, secret, 'POST', '/tasks', assignment.task);
  }
  const startedAt = Date.now();
  const byId = new Map();
  while (Date.now() - startedAt < args.timeoutMs) {
    let allTerminal = true;
    for (const assignment of assignments) {
      const task = await requestJson(fetchImpl, baseUrl, secret, 'GET', `/tasks/${encodeURIComponent(assignment.id)}`);
      byId.set(assignment.id, task);
      if (!TERMINAL.has(task.status)) allTerminal = false;
    }
    if (allTerminal) break;
    await sleep(args.pollMs);
  }
  const items = assignments.map((assignment) => {
    const task = byId.get(assignment.id);
    return {
      id: assignment.id,
      worker: assignment.worker,
      kind: assignment.kind,
      role: assignment.role,
      status: task?.status ?? 'unknown',
      analysisStatus: extractAnalysisStatus(task),
      summary: task?.result?.summary ?? task?.summary ?? null,
    };
  });
  return {
    ok: items.every((item) => item.status === 'succeeded' && item.analysisStatus === 'done'),
    dryRun: false,
    runId,
    capacity,
    routeProbe: { schedz: schedzProbe.attempts, audit: auditProbe.attempts },
    items,
  };
}

async function main() {
  const args = parseArgs();
  const result = await runHealthCheck(args);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
    process.exit(1);
  });
}
