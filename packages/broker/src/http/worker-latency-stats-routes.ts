// GET /stats/workers — advisory per-worker latency profiles (hub/operator only).
//
// Unlike GET /stats/tasks (which deliberately omits worker identifiers from a
// public-safe aggregate), this surface attributes latency and failure mix to
// concrete worker ids, so it is hub/operator role-gated when requester
// identity enforcement is on. The view is read-only advisory data for
// dispatch tie-breaks (#1815 items 1/6) — see docs/worker-latency-advisory.md
// for the consumption contract; it grants no routing authority by itself.

import type { ServerResponse } from "node:http";

import { BrokerError, type InMemoryA2ABroker } from "../core/broker.js";
import { assertRequesterHasRole, type RequesterIdentity } from "../core/request-security.js";
import { aggregateWorkerLatencyProfiles } from "../core/task-stats.js";
import type { BrokerStateStore } from "../core/store.js";
import { listAllTasksForStatsReadPath, listAuditEventsForReadPath } from "../task-read-paths.js";
import { sendJson } from "./response.js";
import { parseTaskStatsWindow } from "./task-stats-routes.js";

export interface WorkerLatencyStatsRouteContext {
  method: string | undefined;
  path: string;
  res: ServerResponse;
  url: URL;
  broker: InMemoryA2ABroker;
  stateStore: BrokerStateStore;
  enforceRequesterIdentity: boolean;
  requesterIdentity: RequesterIdentity | null;
}

export function handleWorkerLatencyStatsRouteIfMatched(ctx: WorkerLatencyStatsRouteContext): boolean {
  if (ctx.method !== "GET" || ctx.path !== "/stats/workers") {
    return false;
  }
  if (ctx.enforceRequesterIdentity) {
    assertRequesterHasRole(ctx.requesterIdentity, ["hub", "operator"], "worker_latency_profiles.read");
  }
  const window = parseTaskStatsWindow(ctx.url);
  const tasks = listAllTasksForStatsReadPath(ctx.stateStore, ctx.broker);
  const auditEvents = listAuditEventsForReadPath(ctx.stateStore, ctx.broker, {});
  const response = aggregateWorkerLatencyProfiles(tasks, auditEvents, {
    maxWorkers: parseMaxWorkersParam(ctx.url),
    window: { sinceMs: window.since.getTime(), untilMs: window.until.getTime() },
  });
  sendJson(ctx.res, 200, {
    ...response,
    window: { since: window.since.toISOString(), until: window.until.toISOString() },
  });
  return true;
}

function parseMaxWorkersParam(url: URL): number | undefined {
  const raw = url.searchParams.get("maxWorkers");
  if (raw === null) return undefined;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new BrokerError("bad_request", "maxWorkers must be a positive integer");
  }
  return parsed;
}
