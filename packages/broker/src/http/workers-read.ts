// Worker read-path routes (GET /workers, /workers/capacity, /workers/:id),
// extracted from the server request closure into explicit-context handlers as
// the first route group of the #645 phase-3 dispatcher migration. Each handler
// declares exactly the state it needs (no closure capture over the server scope),
// so the read path is unit-testable in isolation and parallel PRs stop colliding
// on the single server.ts handler.

import type { ServerResponse } from "node:http";

import { BrokerError, InMemoryA2ABroker } from "../core/broker.js";
import { SqliteBrokerStateStore, type BrokerStateStore } from "../core/store.js";
import type { WorkerListFilters, WorkerRecord, WorkerView } from "../core/types.js";
import { sendJson } from "./response.js";
import { numberQueryParam, workerFiltersFromUrl } from "./read-path-filters.js";

/** Derive the requester-facing WorkerView (online/stale + plane fields) for a worker. */
export function toWorkerView(worker: WorkerRecord, offlineAfterMs: number): WorkerView {
  const status: WorkerView["status"] =
    Date.now() - Date.parse(worker.lastSeenAt) <= offlineAfterMs ? "online" : "stale";
  const workerPlane: WorkerView["workerPlane"] = status === "online" ? "online" : "unknown";
  const managementPlane: WorkerView["managementPlane"] = worker.managementPlane ?? "unknown";
  const updateEligible = workerPlane === "online" && managementPlane !== "disconnected";

  return {
    ...worker,
    status,
    workerPlane,
    managementPlane,
    updateEligible,
  };
}

function workerMatchesNonSqliteFilters(worker: WorkerRecord, filters: WorkerListFilters): boolean {
  if (filters.environment && !worker.capabilities.environments.includes(filters.environment)) {
    return false;
  }
  if (filters.workspaceId && !worker.capabilities.workspaceIds.includes(filters.workspaceId)) {
    return false;
  }
  return true;
}

function listWorkerViewsForReadPath(
  stateStore: BrokerStateStore,
  broker: InMemoryA2ABroker,
  offlineAfterMs: number,
  filters: WorkerListFilters,
): WorkerView[] {
  if (stateStore instanceof SqliteBrokerStateStore) {
    return stateStore
      .readHotWorkers({ role: filters.role })
      .filter((worker) => workerMatchesNonSqliteFilters(worker, filters))
      .map((worker) => redactWorkerProviderCapabilities(toWorkerView(worker, offlineAfterMs)));
  }
  return broker.listWorkerViews(offlineAfterMs, filters).map(redactWorkerProviderCapabilities);
}

function getWorkerViewForReadPath(
  stateStore: BrokerStateStore,
  broker: InMemoryA2ABroker,
  nodeId: string,
  offlineAfterMs: number,
): WorkerView | null {
  if (stateStore instanceof SqliteBrokerStateStore) {
    const worker = stateStore.readHotWorkers({ nodeId })[0];
    return worker ? redactWorkerProviderCapabilities(toWorkerView(worker, offlineAfterMs)) : null;
  }
  const worker = broker.getWorkerView(nodeId, offlineAfterMs);
  return worker ? redactWorkerProviderCapabilities(worker) : null;
}

function redactWorkerProviderCapabilities(worker: WorkerView): WorkerView {
  if (!worker.capabilities.providerCapabilities?.length) return worker;
  const { providerCapabilities: _providerCapabilities, ...capabilities } = worker.capabilities;
  return {
    ...worker,
    capabilities,
  };
}

export interface WorkersReadContext {
  res: ServerResponse;
  url: URL;
  stateStore: BrokerStateStore;
  broker: InMemoryA2ABroker;
  workerOfflineAfterMs: number;
}

export interface WorkersReadRouteContext extends WorkersReadContext {
  method: string | undefined;
  path: string;
  segments: readonly string[];
}

/** GET /workers — list worker views, honoring role/environment/workspace filters. */
export function handleWorkersListRequest(ctx: WorkersReadContext): void {
  const filters = workerFiltersFromUrl(ctx.url);
  const items = listWorkerViewsForReadPath(ctx.stateStore, ctx.broker, ctx.workerOfflineAfterMs, filters);
  sendJson(ctx.res, 200, { items });
}

/** GET /workers/capacity — capacity/availability summary. */
export function handleWorkerCapacityRequest(ctx: WorkersReadContext): void {
  sendJson(
    ctx.res,
    200,
    ctx.broker.getWorkerCapacitySummary({
      workerOfflineAfterMs: ctx.workerOfflineAfterMs,
      taskStaleAfterMs: numberQueryParam(ctx.url, "stale_after_ms") ?? ctx.workerOfflineAfterMs,
    }),
  );
}

/** GET /workers/:id — single worker view; 404 when unknown. */
export function handleWorkerByIdRequest(ctx: WorkersReadContext & { workerId: string }): void {
  const worker = getWorkerViewForReadPath(ctx.stateStore, ctx.broker, ctx.workerId, ctx.workerOfflineAfterMs);
  if (!worker) {
    throw new BrokerError("not_found", "worker not found");
  }
  sendJson(ctx.res, 200, worker);
}


/** Route dispatcher for worker read-path routes. Returns true only when handled. */
export function handleWorkersReadRouteIfMatched(ctx: WorkersReadRouteContext): boolean {
  if (ctx.method !== "GET") {
    return false;
  }

  if (ctx.path === "/workers") {
    handleWorkersListRequest(ctx);
    return true;
  }

  if (ctx.path === "/workers/capacity") {
    handleWorkerCapacityRequest(ctx);
    return true;
  }

  if (ctx.segments[0] === "workers" && ctx.segments[1] && ctx.segments.length === 2) {
    handleWorkerByIdRequest({
      ...ctx,
      workerId: ctx.segments[1],
    });
    return true;
  }

  return false;
}
