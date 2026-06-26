#!/usr/bin/env node
import process from 'node:process';

const DAY_MS = 24 * 60 * 60 * 1000;

export function parseArgs(argv = process.argv.slice(2)) {
  const args = { queuedLimit: 200, outboxLimit: 200, json: true };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') {
      args.json = true;
      continue;
    }
    if (!arg.startsWith('--')) throw new Error(`unexpected argument: ${arg}`);
    const key = arg.slice(2).replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${arg} requires a value`);
    args[key] = value;
    i += 1;
  }
  for (const required of ['baseUrl', 'brokerId', 'officialTeam']) {
    if (!args[required]) throw new Error(`--${required.replace(/[A-Z]/g, (ch) => `-${ch.toLowerCase()}`)} is required`);
  }
  args.officialWorkers = String(args.officialWorkers ?? '').split(',').map((item) => item.trim()).filter(Boolean);
  args.team2Workers = String(args.team2Workers ?? 'dungae,jingun,soonwook,daegyo,gongmyoung,gongyung').split(',').map((item) => item.trim()).filter(Boolean);
  args.queuedLimit = Number(args.queuedLimit ?? 200);
  args.outboxLimit = Number(args.outboxLimit ?? 200);
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
    ...(secret ? { 'x-a2a-edge-secret': secret } : {}),
    'x-a2a-requester-id': 'ops-readonly-residue-report',
    'x-a2a-requester-role': 'operator',
  };
}

async function requestJson(fetchImpl, baseUrl, secret, path) {
  const response = await fetchImpl(new URL(path, baseUrl), { method: 'GET', headers: headers(secret) });
  const text = await response.text();
  let parsed = {};
  if (text) {
    try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
  }
  if (!response.ok) {
    const error = new Error(parsed?.error?.message || parsed?.message || text || `GET ${path} failed`);
    error.status = response.status;
    error.body = parsed;
    throw error;
  }
  return parsed;
}

async function tryPaths(fetchImpl, baseUrl, secret, paths) {
  const attempts = [];
  for (const path of paths) {
    try {
      const body = await requestJson(fetchImpl, baseUrl, secret, path);
      return { ok: true, path, body, attempts: [...attempts, { path, ok: true }] };
    } catch (error) {
      attempts.push({ path, ok: false, status: error.status ?? null, message: error.message });
    }
  }
  return { ok: false, path: null, body: null, attempts };
}

function taskWorkerId(task) {
  return task?.assignedWorkerId || task?.targetNodeId || task?.target?.id || 'unknown';
}

function taskUpdatedAt(task) {
  return task?.statusSinceAt || task?.queuedAt || task?.updatedAt || task?.createdAt || null;
}

function ageMsFromIso(iso, nowMs) {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? Math.max(0, nowMs - ms) : null;
}

function bucketAge(ageMs) {
  if (ageMs === null) return 'unknown';
  if (ageMs < DAY_MS) return '<1d';
  if (ageMs < 7 * DAY_MS) return '1-7d';
  if (ageMs < 14 * DAY_MS) return '7-14d';
  return '>=14d';
}

function increment(map, key) {
  map[key || 'unknown'] = (map[key || 'unknown'] ?? 0) + 1;
}

export function classifyQueuedTasks(tasks, args, nowMs = Date.now()) {
  const official = new Set(args.officialWorkers ?? []);
  const team2 = new Set(args.team2Workers ?? []);
  const byWorker = {};
  const byAgeBucket = {};
  const rows = [];
  for (const task of tasks.filter((item) => item?.status === 'queued' || !item?.status)) {
    const worker = taskWorkerId(task);
    const updatedAt = taskUpdatedAt(task);
    const ageMs = ageMsFromIso(updatedAt, nowMs);
    const ageBucket = bucketAge(ageMs);
    const crossTeamSuspect = args.officialTeam === 'team1' && team2.has(worker) && !official.has(worker);
    increment(byWorker, worker);
    increment(byAgeBucket, ageBucket);
    rows.push({
      id: task.id,
      status: task.status ?? 'queued',
      worker,
      updatedAt,
      ageMs,
      ageBucket,
      taskOrigin: task.taskOrigin ?? task.origin ?? 'unknown',
      payloadOrigin: task.payload?.originBrokerId || task.payload?.brokerOfRecordId || task.payload?.teamScope || task.payload?.source || null,
      crossTeamSuspect,
      safetyImpact: crossTeamSuspect ? 'capacity-noise-no-mutation-without-approval' : 'review-before-action',
    });
  }
  return {
    total: rows.length,
    crossTeamSuspect: rows.filter((row) => row.crossTeamSuspect).length,
    byWorker,
    byAgeBucket,
    rows,
    mutationPlan: {
      reviewed: false,
      allowedNow: false,
      reason: 'read-only classifier only; cancel/requeue/prune requires explicit follow-up approval',
      rollbackNotes: [
        'Before mutation, export task rows and audit rows for each selected id.',
        'Prefer targeted cancel/requeue by id; avoid broad prune commands.',
        'If a row is still meaningful, requeue to the official broker/worker instead of deleting history.',
      ],
    },
  };
}

export function classifyTerminalOutboxDiagnostics(diag, nowMs = Date.now()) {
  const outbox = diag ?? {};
  const oldestAgeMs = outbox.oldestUnackedAgeMs ?? (outbox.oldestUnackedCreatedAt ? ageMsFromIso(outbox.oldestUnackedCreatedAt, nowMs) : null);
  const ackEligibleUnacked = Number(outbox.ackEligibleUnacked ?? outbox.unacked ?? 0);
  const ackIneligibleUnacked = Number(outbox.ackIneligibleUnacked ?? 0);
  let classification = 'clean';
  if (ackEligibleUnacked > 0 && oldestAgeMs !== null && oldestAgeMs >= 7 * DAY_MS) {
    classification = 'actionable-review-required';
  } else if (ackEligibleUnacked > 0) {
    classification = 'recent-unacked-watch';
  } else if (ackIneligibleUnacked > 0) {
    classification = 'ack-ineligible-historical-residue';
  }
  return {
    classification,
    total: Number(outbox.total ?? 0),
    rawUnacked: Number(outbox.rawUnacked ?? 0),
    ackEligibleUnacked,
    ackIneligibleUnacked,
    oldestUnackedCreatedAt: outbox.oldestUnackedCreatedAt ?? null,
    oldestUnackedAgeMs: oldestAgeMs,
    ageBucket: bucketAge(oldestAgeMs),
    warnings: Array.isArray(outbox.warnings) ? outbox.warnings : [],
    safeNextStep: ackEligibleUnacked > 0
      ? 'classify destination/task/round with bounded reads; do not ACK/replay/prune without explicit approval'
      : 'no ACK mutation needed from this diagnostic alone',
  };
}

export async function runReport(args, { fetchImpl = globalThis.fetch, env = process.env } = {}) {
  if (!fetchImpl) throw new Error('fetch is not available');
  const baseUrl = args.baseUrl.endsWith('/') ? args.baseUrl : `${args.baseUrl}/`;
  const secret = edgeSecretFromEnv(env);
  const nowMs = Date.now();
  const capacity = await tryPaths(fetchImpl, baseUrl, secret, ['/workers/capacity']);
  const queued = await tryPaths(fetchImpl, baseUrl, secret, [
    `/tasks?status=queued&detail=full&limit=${encodeURIComponent(args.queuedLimit)}`,
    `/tasks?status=queued&limit=${encodeURIComponent(args.queuedLimit)}`,
  ]);
  const health = await tryPaths(fetchImpl, baseUrl, secret, ['/health']);
  const cleanup = await tryPaths(fetchImpl, baseUrl, secret, ['/admin/cleanup/dry-run', '/cleanup/dry-run']);
  const queuedItems = Array.isArray(queued.body?.items) ? queued.body.items : (Array.isArray(queued.body?.tasks) ? queued.body.tasks : []);
  const terminalDiag = health.body?.persistence?.terminalOutboxDiagnostics || health.body?.terminalOutboxDiagnostics || null;
  return {
    ok: true,
    brokerId: args.brokerId,
    officialTeam: args.officialTeam,
    generatedAt: new Date(nowMs).toISOString(),
    routeProbe: { capacity: capacity.attempts, queued: queued.attempts, health: health.attempts, cleanup: cleanup.attempts },
    capacity: capacity.body ?? null,
    queuedResidue: classifyQueuedTasks(queuedItems, args, nowMs),
    terminalOutbox: classifyTerminalOutboxDiagnostics(terminalDiag, nowMs),
    cleanupDryRun: cleanup.ok ? cleanup.body : null,
    safety: {
      readOnly: true,
      mutationsPerformed: false,
      forbiddenWithoutApproval: ['task cancel/requeue/prune', 'terminal outbox ACK', 'terminal outbox replay', 'database prune'],
    },
  };
}

async function main() {
  const result = await runReport(parseArgs());
  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
    process.exit(1);
  });
}
