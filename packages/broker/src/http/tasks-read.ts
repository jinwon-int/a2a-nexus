// Task read routes (GET /tasks/diagnostics, GET /tasks/:id, GET
// /tasks/:id/diagnostics), extracted from the server request closure into
// explicit-context handlers (continuing the #645 dispatcher migration). All are
// read-only; the dispatcher preserves the original precedence — the bulk
// /tasks/diagnostics scan and the :id/diagnostics report are matched before the
// single-task /tasks/:id lookup.
import type { ServerResponse } from "node:http";

import { BrokerError, InMemoryA2ABroker } from "../core/broker.js";
import type { BrokerStateStore } from "../core/store.js";
import {
  getTaskDiagnosticsForReadPath,
  getTaskForReadPath,
  listTaskDiagnosticsForReadPath,
} from "../task-read-paths.js";
import { numberQueryParam } from "./read-path-filters.js";
import { sendJson } from "./response.js";

export interface TasksReadRouteContext {
  method: string | undefined;
  path: string;
  segments: string[];
  res: ServerResponse;
  url: URL;
  broker: InMemoryA2ABroker;
  stateStore: BrokerStateStore;
}

/** GET /tasks/diagnostics — bulk diagnostic scan across tasks. */
export function handleTasksDiagnosticsRequest(ctx: TasksReadRouteContext): void {
  const staleAfterMs = numberQueryParam(ctx.url, "stale_after_ms") ?? 120_000;
  const longRunningAfterMs = numberQueryParam(ctx.url, "long_running_after_ms") ?? 3_600_000;
  const reports = listTaskDiagnosticsForReadPath(ctx.stateStore, ctx.broker, { staleAfterMs, longRunningAfterMs });
  sendJson(ctx.res, 200, { items: reports, generatedAt: new Date().toISOString() });
}

/** GET /tasks/:id/diagnostics — monitoring-friendly diagnostic report for one task. */
export function handleTaskDiagnosticsByIdRequest(ctx: TasksReadRouteContext & { taskId: string }): void {
  const report = getTaskDiagnosticsForReadPath(ctx.stateStore, ctx.broker, ctx.taskId, {
    staleAfterMs: numberQueryParam(ctx.url, "stale_after_ms") ?? undefined,
    longRunningAfterMs: numberQueryParam(ctx.url, "long_running_after_ms") ?? undefined,
  });
  sendJson(ctx.res, 200, report);
}

/** GET /tasks/:id — single task view; 404 when unknown. */
export function handleTaskByIdRequest(ctx: TasksReadRouteContext & { taskId: string }): void {
  const task = getTaskForReadPath(ctx.stateStore, ctx.broker, ctx.taskId, {
    includeStaleReadPath: ctx.url.searchParams
      .getAll("include")
      .flatMap((value) => value.split(","))
      .map((value) => value.trim())
      .includes("stale_read_path"),
  });
  if (!task) {
    throw new BrokerError("not_found", "task not found");
  }
  sendJson(ctx.res, 200, task);
}

/** Route dispatcher for task read routes. Returns true only when handled. */
export function handleTasksReadRouteIfMatched(ctx: TasksReadRouteContext): boolean {
  if (ctx.method !== "GET") {
    return false;
  }
  // /tasks/diagnostics must win over the /tasks/:id lookup (its id would be "diagnostics").
  if (ctx.path === "/tasks/diagnostics") {
    handleTasksDiagnosticsRequest(ctx);
    return true;
  }
  if (ctx.segments[0] === "tasks" && ctx.segments[1] && ctx.segments[2] === "diagnostics" && ctx.segments.length === 3) {
    handleTaskDiagnosticsByIdRequest({ ...ctx, taskId: ctx.segments[1] });
    return true;
  }
  if (ctx.segments[0] === "tasks" && ctx.segments[1] && ctx.segments.length === 2) {
    handleTaskByIdRequest({ ...ctx, taskId: ctx.segments[1] });
    return true;
  }
  return false;
}
