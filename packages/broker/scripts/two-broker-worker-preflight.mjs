#!/usr/bin/env node
// Compare two broker worker lists before cutover and fail closed when the same
// worker id is online on both brokers. The script only performs GET requests;
// optional safety evidence is loaded from a local sanitized JSON file.

import process from 'node:process';
import { readFile } from 'node:fs/promises';

const SAFETY_GATES = [
  ['productionDeploy', 'production deploy'],
  ['gatewayRestart', 'Gateway restart/reload'],
  ['liveProviderCanary', 'live provider/Telegram canary or send'],
  ['dbMutation', 'DB mutation/prune/migration'],
  ['terminalAckOrReplay', 'terminal ACK/replay or historical outbox replay'],
  ['release', 'release/tag publication'],
  ['providerAcceptedMessageIdAsAck', 'provider accepted/message-id counted as terminal ACK'],
];

export function normalizeWorkerId(worker) {
  if (!worker || typeof worker !== 'object') return null;
  const id = worker.workerId ?? worker.nodeId ?? worker.id;
  return typeof id === 'string' && id.trim() ? id.trim() : null;
}

export function onlineWorkers(workers) {
  if (!Array.isArray(workers)) return [];
  return workers
    .map((worker) => ({ worker, workerId: normalizeWorkerId(worker) }))
    .filter(({ worker, workerId }) => workerId && worker.status === 'online');
}

function knownWorkers(workers) {
  if (!Array.isArray(workers)) return [];
  return workers
    .map((worker) => ({ worker, workerId: normalizeWorkerId(worker) }))
    .filter(({ workerId }) => workerId);
}

export function findDuplicateOnlineWorkerIds(brokeralphaWorkers, brokerbetaWorkers) {
  const brokeralphaById = new Map();
  const brokerbetaById = new Map();

  for (const entry of onlineWorkers(brokeralphaWorkers)) brokeralphaById.set(entry.workerId, entry.worker);
  for (const entry of onlineWorkers(brokerbetaWorkers)) brokerbetaById.set(entry.workerId, entry.worker);

  return [...brokeralphaById.keys()]
    .filter((workerId) => brokerbetaById.has(workerId))
    .sort()
    .map((workerId) => ({
      workerId,
      brokeralpha: summarizeWorker(brokeralphaById.get(workerId)),
      brokerbeta: summarizeWorker(brokerbetaById.get(workerId)),
    }));
}

export function findStaleOrInactiveCrossBrokerWorkerIds(brokeralphaWorkers, brokerbetaWorkers) {
  const brokeralphaById = new Map();
  const brokerbetaById = new Map();

  for (const entry of knownWorkers(brokeralphaWorkers)) brokeralphaById.set(entry.workerId, entry.worker);
  for (const entry of knownWorkers(brokerbetaWorkers)) brokerbetaById.set(entry.workerId, entry.worker);

  return [...brokeralphaById.keys()]
    .filter((workerId) => brokerbetaById.has(workerId))
    .filter((workerId) => brokeralphaById.get(workerId)?.status !== 'online' || brokerbetaById.get(workerId)?.status !== 'online')
    .sort()
    .map((workerId) => ({
      workerId,
      brokeralpha: summarizeWorker(brokeralphaById.get(workerId)),
      brokerbeta: summarizeWorker(brokerbetaById.get(workerId)),
      distinction: 'non-blocking unless either side is fresh/online without an approved replacement plan',
    }));
}

export function extractBrokerRevision(health) {
  const build = health?.build;
  return {
    brokerId: health?.brokerId ?? null,
    version: health?.version ?? null,
    revision: build?.revision ?? health?.revision ?? (typeof build === 'string' ? build : null) ?? null,
    source: build?.source ?? null,
  };
}

export function extractWorkerRevision(worker) {
  return worker?.revision
    ?? worker?.buildRevision
    ?? worker?.build?.revision
    ?? worker?.metadata?.revision
    ?? worker?.metadata?.buildRevision
    ?? worker?.metadata?.gitSha
    ?? worker?.metadata?.imageDigest
    ?? null;
}

export function evaluateSafetyGates(evidence = {}) {
  const gates = Object.fromEntries(SAFETY_GATES.map(([key, label]) => [key, {
    ok: evidence?.[key] !== true,
    attempted: evidence?.[key] === true,
    label,
  }]));
  const blockers = Object.entries(gates)
    .filter(([, gate]) => !gate.ok)
    .map(([key, gate]) => `${key}: ${gate.label} is not allowed by this no-live preflight`);
  return { ok: blockers.length === 0, gates, blockers };
}

export function buildPreflightResult({ brokeralphaWorkers, brokerbetaWorkers, brokeralphaHealth, brokerbetaHealth, safetyEvidence = {} }) {
  const duplicates = findDuplicateOnlineWorkerIds(brokeralphaWorkers, brokerbetaWorkers);
  const staleOrInactiveCrossBrokerWorkers = findStaleOrInactiveCrossBrokerWorkerIds(brokeralphaWorkers, brokerbetaWorkers);
  const safety = evaluateSafetyGates(safetyEvidence);
  return {
    ok: duplicates.length === 0 && safety.ok,
    brokerRevisions: {
      brokeralpha: extractBrokerRevision(brokeralphaHealth),
      brokerbeta: extractBrokerRevision(brokerbetaHealth),
    },
    workerRevisionSummary: {
      brokeralpha: summarizeWorkerRevisions(brokeralphaWorkers),
      brokerbeta: summarizeWorkerRevisions(brokerbetaWorkers),
    },
    brokeralphaOnline: onlineWorkers(brokeralphaWorkers).length,
    brokerbetaOnline: onlineWorkers(brokerbetaWorkers).length,
    duplicates,
    staleOrInactiveCrossBrokerWorkers,
    rollbackNotes: [
      'This preflight does not execute rollback. Rollback requires a fresh explicit operator approval and the approved worker/broker runbook.',
      'Provider accepted/message-id evidence is non-ACK; terminal ACK/replay remains prohibited unless separately approved with receipt-confirmed evidence.',
    ],
    safety,
  };
}

function summarizeWorker(worker) {
  return {
    nodeId: worker.nodeId ?? null,
    workerId: worker.workerId ?? worker.nodeId ?? worker.id ?? null,
    status: worker.status ?? null,
    role: worker.role ?? null,
    displayName: worker.displayName ?? null,
    lastSeenAt: worker.lastSeenAt ?? null,
    workerMode: worker.workerMode ?? null,
    brokerId: worker.brokerId ?? worker.metadata?.brokerId ?? null,
    homeBrokerId: worker.homeBrokerId ?? worker.metadata?.homeBrokerId ?? null,
    teamId: worker.teamId ?? worker.metadata?.teamId ?? null,
    revision: extractWorkerRevision(worker),
  };
}

function summarizeWorkerRevisions(workers) {
  return knownWorkers(workers).map(({ worker, workerId }) => ({
    workerId,
    status: worker.status ?? null,
    revision: extractWorkerRevision(worker) ?? 'unknown',
    brokerId: worker.brokerId ?? worker.metadata?.brokerId ?? null,
    homeBrokerId: worker.homeBrokerId ?? worker.metadata?.homeBrokerId ?? null,
    teamId: worker.teamId ?? worker.metadata?.teamId ?? null,
  })).sort((a, b) => a.workerId.localeCompare(b.workerId));
}

function getArg(argv, name) {
  const idx = argv.indexOf(name);
  if (idx !== -1) return argv[idx + 1];
  return argv.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);
}

export function parseArgs(argv, env = process.env) {
  return {
    brokeralphaUrl: getArg(argv, '--brokeralpha-url') || env.brokeralpha_BROKER_URL || env.A2A_brokeralpha_BROKER_URL,
    brokerbetaUrl: getArg(argv, '--brokerbeta-url') || env.brokerbeta_BROKER_URL || env.A2A_brokerbeta_BROKER_URL,
    safetyEvidence: getArg(argv, '--safety-evidence'),
    json: argv.includes('--json'),
  };
}

function brokerUrl(baseUrl, path) {
  const url = new URL(baseUrl);
  url.pathname = `${url.pathname.replace(/\/$/, '')}/${path.replace(/^\//, '')}`;
  url.search = '';
  url.hash = '';
  return url;
}

function workersUrl(baseUrl) {
  return brokerUrl(baseUrl, '/workers');
}

function healthUrl(baseUrl) {
  return brokerUrl(baseUrl, '/health');
}

export async function fetchWorkerList(baseUrl, fetchImpl = fetch) {
  const url = workersUrl(baseUrl);
  const response = await fetchImpl(url, { method: 'GET', headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  const body = await response.json();
  if (!Array.isArray(body?.items)) throw new Error(`${url} did not return a worker items array`);
  return body.items;
}

export async function fetchBrokerHealth(baseUrl, fetchImpl = fetch) {
  const url = healthUrl(baseUrl);
  const response = await fetchImpl(url, { method: 'GET', headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return response.json();
}

async function readSafetyEvidence(path) {
  if (!path) return {};
  const parsed = JSON.parse(await readFile(path, 'utf8'));
  return parsed?.safety ?? parsed;
}

function printHuman(result) {
  console.log('A2A two-broker worker cutover preflight');
  console.log(`brokeralpha broker revision: ${result.brokerRevisions.brokeralpha.revision ?? 'unknown'} (${result.brokerRevisions.brokeralpha.brokerId ?? 'brokerId unknown'})`);
  console.log(`brokerbeta broker revision: ${result.brokerRevisions.brokerbeta.revision ?? 'unknown'} (${result.brokerRevisions.brokerbeta.brokerId ?? 'brokerId unknown'})`);
  console.log(`brokeralpha online workers: ${result.brokeralphaOnline}`);
  console.log(`brokerbeta online workers: ${result.brokerbetaOnline}`);

  if (result.duplicates.length === 0) {
    console.log('PASS duplicate online workerIds: none found across brokeralpha and brokerbeta');
  } else {
    console.log('FAIL duplicate online workerIds: found across brokeralpha and brokerbeta');
    for (const duplicate of result.duplicates) {
      console.log(`- ${duplicate.workerId}: brokeralpha status=${duplicate.brokeralpha.status ?? 'unknown'} revision=${duplicate.brokeralpha.revision ?? 'unknown'} lastSeenAt=${duplicate.brokeralpha.lastSeenAt ?? 'unknown'}, brokerbeta status=${duplicate.brokerbeta.status ?? 'unknown'} revision=${duplicate.brokerbeta.revision ?? 'unknown'} lastSeenAt=${duplicate.brokerbeta.lastSeenAt ?? 'unknown'}`);
    }
  }

  if (result.staleOrInactiveCrossBrokerWorkers.length > 0) {
    console.log('NOTE stale/inactive cross-broker workerIds are distinguished from duplicate-online blockers:');
    for (const worker of result.staleOrInactiveCrossBrokerWorkers) {
      console.log(`- ${worker.workerId}: brokeralpha status=${worker.brokeralpha.status ?? 'unknown'} revision=${worker.brokeralpha.revision ?? 'unknown'}, brokerbeta status=${worker.brokerbeta.status ?? 'unknown'} revision=${worker.brokerbeta.revision ?? 'unknown'}`);
    }
  }

  if (!result.safety.ok) {
    console.log('FAIL safety gates:');
    for (const blocker of result.safety.blockers) console.log(`- ${blocker}`);
  } else {
    console.log('PASS safety gates: no deploy/restart/canary/DB/ACK/release action reported; provider accepted/message-id evidence is non-ACK');
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.brokeralphaUrl || !options.brokerbetaUrl) {
    console.error('fatal: provide --brokeralpha-url/--brokerbeta-url or brokeralpha_BROKER_URL/brokerbeta_BROKER_URL');
    process.exit(2);
  }

  const [brokeralphaWorkers, brokerbetaWorkers, brokeralphaHealth, brokerbetaHealth, safetyEvidence] = await Promise.all([
    fetchWorkerList(options.brokeralphaUrl),
    fetchWorkerList(options.brokerbetaUrl),
    fetchBrokerHealth(options.brokeralphaUrl),
    fetchBrokerHealth(options.brokerbetaUrl),
    readSafetyEvidence(options.safetyEvidence),
  ]);

  const result = buildPreflightResult({ brokeralphaWorkers, brokerbetaWorkers, brokeralphaHealth, brokerbetaHealth, safetyEvidence });

  if (options.json) console.log(JSON.stringify(result, null, 2));
  else printHuman(result);

  process.exit(result.ok ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`fatal: ${error.message}`);
    process.exit(2);
  });
}
