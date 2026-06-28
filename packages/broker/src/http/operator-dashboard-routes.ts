// Operator dashboard read routes (GET /dashboard, GET /control-tower), extracted
// from the server request closure into explicit-context handlers (continuing the
// #645 dispatcher migration). Both build the same dashboard snapshot; control-tower
// role-gates and wraps it in a read-only control-tower envelope. The server-level
// shape types (build info / persistence-queue / stale-reaper) are imported type-only
// from ../server.js, matching dashboard-response.ts.
import type { ServerResponse } from "node:http";

import { InMemoryA2ABroker } from "../core/broker.js";
import { SqliteBrokerStateStore, type BrokerStateStore } from "../core/store.js";
import {
  assertRequesterHasRole,
  InMemoryRateLimiter,
  type RequesterIdentity,
} from "../core/request-security.js";
import { summarizeTerminalBriefInbox } from "../core/terminal-brief-query-api.js";
import { readPersistenceQueueDiagnostics } from "../persistence-queue-diagnostics.js";
import { buildDashboardResponse } from "./dashboard-response.js";
import { numberQueryParam } from "./read-path-filters.js";
import { sendJson } from "./response.js";
import type {
  BrokerBuildInfo,
  BrokerPersistenceQueueDiagnosticsProvider,
  BrokerStaleReaperStatus,
} from "../server.js";

export interface OperatorDashboardRouteContext {
  method: string | undefined;
  path: string;
  res: ServerResponse;
  url: URL;
  broker: InMemoryA2ABroker;
  stateStore: BrokerStateStore;
  brokerId: string | undefined;
  workerOfflineAfterSec: number;
  getStaleReaperStatus: () => BrokerStaleReaperStatus;
  rateLimiter: InMemoryRateLimiter;
  workerRateLimiter: InMemoryRateLimiter;
  buildInfo: { version: string; build: BrokerBuildInfo };
  persistenceQueueDiagnosticsProvider: BrokerPersistenceQueueDiagnosticsProvider | undefined;
  enforceRequesterIdentity: boolean;
  requesterIdentity: RequesterIdentity | null;
}

/** Build the dashboard snapshot shared by /dashboard and /control-tower. */
function buildDashboardSnapshot(ctx: OperatorDashboardRouteContext) {
  return buildDashboardResponse({
    broker: ctx.broker,
    workerOfflineAfterSec: ctx.workerOfflineAfterSec,
    getStaleReaperStatus: ctx.getStaleReaperStatus,
    rateLimiter: ctx.rateLimiter,
    workerRateLimiter: ctx.workerRateLimiter,
    version: ctx.buildInfo.version,
    build: ctx.buildInfo.build,
    recentHistoryLimit: numberQueryParam(ctx.url, "recent_history_limit") ?? 10,
    oldestPendingLimit: numberQueryParam(ctx.url, "oldest_pending_limit") ?? 5,
    pendingActionLimit: numberQueryParam(ctx.url, "pending_action_limit") ?? 5,
    hotEntityDiagnostics: ctx.stateStore instanceof SqliteBrokerStateStore
      ? ctx.stateStore.readHotEntityDiagnostics()
      : undefined,
    persistenceQueue: readPersistenceQueueDiagnostics(ctx.persistenceQueueDiagnosticsProvider),
  });
}

/** GET /dashboard — full operator dashboard response. */
export function handleDashboardRequest(ctx: OperatorDashboardRouteContext): void {
  sendJson(ctx.res, 200, buildDashboardSnapshot(ctx));
}

/** GET /control-tower — read-only control-tower projection over the dashboard. */
export function handleControlTowerRequest(ctx: OperatorDashboardRouteContext): void {
  if (ctx.enforceRequesterIdentity) {
    assertRequesterHasRole(ctx.requesterIdentity, ["hub", "operator"], "control_tower.read");
  }
  const dashboard = buildDashboardSnapshot(ctx);
  sendJson(ctx.res, 200, {
    kind: "a2a-broker.control-tower.snapshot",
    generatedAt: dashboard.generatedAt,
    brokerId: ctx.brokerId,
    version: ctx.buildInfo.version,
    build: ctx.buildInfo.build,
    queue: dashboard.operatorSnapshot.taskStatusSummary,
    recovery: dashboard.operatorSnapshot.recoverySummary,
    attention: dashboard.attention,
    workerCapacity: ctx.broker.getWorkerCapacitySummary({
      workerOfflineAfterMs: ctx.workerOfflineAfterSec * 1000,
      taskStaleAfterMs: numberQueryParam(ctx.url, "stale_after_ms") ?? ctx.workerOfflineAfterSec * 1000,
    }),
    terminalBrief: summarizeTerminalBriefInbox(ctx.broker.getTerminalTaskEventOutbox()),
    safety: {
      readOnly: true,
      performsMutation: false,
      forbiddenActions: ["manual_ack", "replay", "prune", "provider_send", "restart", "deploy", "db_mutation"],
    },
  }, {
    "cache-control": "no-store",
  });
}

/** Route dispatcher for operator dashboard read routes. Returns true only when handled. */
export function handleOperatorDashboardRouteIfMatched(ctx: OperatorDashboardRouteContext): boolean {
  if (ctx.method !== "GET") {
    return false;
  }
  if (ctx.path === "/dashboard") {
    handleDashboardRequest(ctx);
    return true;
  }
  if (ctx.path === "/control-tower") {
    handleControlTowerRequest(ctx);
    return true;
  }
  return false;
}
