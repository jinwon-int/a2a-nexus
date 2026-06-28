// Operator read-path diagnostic routes (GET /alerts, GET /cleanup/candidates),
// extracted from the server request closure into explicit-context handlers
// (continuing the #645 dispatcher migration begun in workers-read.ts). Each
// handler declares exactly the state it needs via the route context — no closure
// capture over the server scope — so these read paths are unit-testable in
// isolation and stop colliding with the monolithic server.ts handler.
import type { ServerResponse } from "node:http";

import { InMemoryA2ABroker } from "../core/broker.js";
import { SqliteBrokerStateStore, type BrokerStateStore } from "../core/store.js";
import { assertRequesterHasRole, type RequesterIdentity } from "../core/request-security.js";
import { projectHotTableGrowth, type HotTableGrowthProjection } from "../core/hot-table-growth.js";
import { buildAlertScan } from "./dashboard-response.js";
import { numberQueryParam } from "./read-path-filters.js";
import { sendJson } from "./response.js";

const DEFAULT_ALERT_STALE_AFTER_MS = 120_000;
const DEFAULT_ALERT_LONG_RUNNING_AFTER_MS = 3_600_000;

export interface OperatorDiagnosticsReadRouteContext {
  method: string | undefined;
  path: string;
  res: ServerResponse;
  url: URL;
  broker: InMemoryA2ABroker;
  stateStore: BrokerStateStore;
  workerOfflineAfterMs: number;
  enforceRequesterIdentity: boolean;
  requesterIdentity: RequesterIdentity | null;
}

/** GET /alerts — operator alert scan with optional threshold overrides. */
export function handleAlertsRequest(ctx: OperatorDiagnosticsReadRouteContext): void {
  const hotTableGrowth: HotTableGrowthProjection | undefined =
    ctx.stateStore instanceof SqliteBrokerStateStore
      ? projectHotTableGrowth({
          current: ctx.stateStore.readHotTableLoadMetrics(),
          runtimeLoadLimits: ctx.stateStore.readHotTableRuntimeLoadLimits(),
        })
      : undefined;
  const result = buildAlertScan({
    broker: ctx.broker,
    staleAfterMs: numberQueryParam(ctx.url, "stale_after_ms") ?? DEFAULT_ALERT_STALE_AFTER_MS,
    longRunningAfterMs: numberQueryParam(ctx.url, "long_running_after_ms") ?? DEFAULT_ALERT_LONG_RUNNING_AFTER_MS,
    staleWarningMs: numberQueryParam(ctx.url, "stale_warning_ms") ?? undefined,
    staleCriticalMs: numberQueryParam(ctx.url, "stale_critical_ms") ?? undefined,
    longRunningWarningMs: numberQueryParam(ctx.url, "long_running_warning_ms") ?? undefined,
    longRunningCriticalMs: numberQueryParam(ctx.url, "long_running_critical_ms") ?? undefined,
    workerHeartbeatMissedAfterMs:
      numberQueryParam(ctx.url, "worker_heartbeat_missed_after_ms") ?? ctx.workerOfflineAfterMs,
    hotTableGrowth,
  });
  sendJson(ctx.res, 200, result);
}

/** GET /cleanup/candidates — read-only cleanup candidate discovery (issue #520). */
export function handleCleanupCandidatesRequest(ctx: OperatorDiagnosticsReadRouteContext): void {
  if (ctx.enforceRequesterIdentity) {
    assertRequesterHasRole(ctx.requesterIdentity, ["hub", "operator"], "cleanup.candidates.read");
  }
  const plan = ctx.broker.discoverCleanupCandidates({
    staleWorkerAfterMs: numberQueryParam(ctx.url, "stale_worker_after_ms") ?? undefined,
    staleTaskAfterMs: numberQueryParam(ctx.url, "stale_task_after_ms") ?? undefined,
    terminalOutboxBacklogAfterMs: numberQueryParam(ctx.url, "terminal_outbox_backlog_after_ms") ?? undefined,
    historicalTerminalAfterMs: numberQueryParam(ctx.url, "historical_terminal_after_ms") ?? undefined,
  });
  sendJson(ctx.res, 200, plan, {
    "cache-control": "no-store",
  });
}

/** Route dispatcher for operator read-path diagnostic routes. Returns true only when handled. */
export function handleOperatorDiagnosticsReadRouteIfMatched(
  ctx: OperatorDiagnosticsReadRouteContext,
): boolean {
  if (ctx.method !== "GET") {
    return false;
  }
  if (ctx.path === "/alerts") {
    handleAlertsRequest(ctx);
    return true;
  }
  if (ctx.path === "/cleanup/candidates") {
    handleCleanupCandidatesRequest(ctx);
    return true;
  }
  return false;
}
