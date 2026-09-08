import { sortWorkersNewestFirst } from "./broker-record-helpers.js";
import { workerMatchesFilters } from "./broker-list-filters.js";
import { sortedCopy } from "./broker-helpers.js";
import { chooseFresherWorkerRecord, normalizeWorkerRecord } from "./broker-worker-identity.js";
import { toWorkerViewRecord } from "./broker-worker-status.js";
import type { WorkerRuntimeRepository } from "./worker-repository.js";
import type { WorkerListFilters, WorkerRecord, WorkerView } from "./types.js";

export interface BrokerWorkerReadContext {
  workers: Map<string, WorkerRecord>;
  workerRepository?: WorkerRuntimeRepository;
}

/**
 * Map-first (#2078 B), mirroring readBrokerTask: every write path (including
 * the non-persisted heartbeat branch) updates the in-memory map and the
 * serving fence guarantees a single writer, so the cache is authoritative.
 * The repository is only a miss-path fallback that warms the map.
 */
export function readBrokerWorker(ctx: BrokerWorkerReadContext, nodeId: string): WorkerRecord | null {
  const cachedWorker = ctx.workers.get(nodeId);
  if (cachedWorker) {
    return cachedWorker;
  }
  const repositoryWorker = ctx.workerRepository?.getWorker(nodeId);
  if (repositoryWorker) {
    const worker = normalizeWorkerRecord(repositoryWorker);
    ctx.workers.set(worker.nodeId, worker);
    return worker;
  }
  return null;
}

export function readBrokerWorkerCachedFirst(ctx: BrokerWorkerReadContext, nodeId: string): WorkerRecord | null {
  return readBrokerWorker(ctx, nodeId);
}

export function listBrokerWorkers(ctx: BrokerWorkerReadContext, filters?: WorkerListFilters): WorkerRecord[] {
  if (ctx.workerRepository) {
    const workersById = new Map<string, WorkerRecord>();
    for (const worker of ctx.workerRepository.listWorkers(filters).map(normalizeWorkerRecord)) {
      const cachedWorker = ctx.workers.get(worker.nodeId) ?? null;
      workersById.set(worker.nodeId, chooseFresherWorkerRecord(cachedWorker, worker));
    }
    for (const worker of ctx.workers.values()) {
      const existing = workersById.get(worker.nodeId) ?? null;
      workersById.set(worker.nodeId, chooseFresherWorkerRecord(existing, worker));
    }
    const workers = [...workersById.values()];
    for (const worker of workers) {
      ctx.workers.set(worker.nodeId, worker);
    }
    return sortedCopy(
      workers.filter((worker) => workerMatchesFilters(worker, filters)),
      sortWorkersNewestFirst,
    );
  }
  return sortedCopy(
    [...ctx.workers.values()].filter((worker) => workerMatchesFilters(worker, filters)),
    sortWorkersNewestFirst,
  );
}

export function listBrokerWorkerViews(
  ctx: BrokerWorkerReadContext,
  offlineAfterMs: number,
  filters?: WorkerListFilters,
): WorkerView[] {
  return listBrokerWorkers(ctx, filters).map((worker) => toWorkerViewRecord(worker, offlineAfterMs));
}

export function readBrokerWorkerView(
  ctx: BrokerWorkerReadContext,
  nodeId: string,
  offlineAfterMs: number,
): WorkerView | null {
  const worker = readBrokerWorker(ctx, nodeId);
  if (!worker) return null;
  return toWorkerViewRecord(worker, offlineAfterMs);
}
