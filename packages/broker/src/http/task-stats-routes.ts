import type { ServerResponse } from "node:http";

import { BrokerError, InMemoryA2ABroker } from "../core/broker.js";
import { deriveTaskWorkerClass } from "../core/broker-policy.js";
import { aggregateTaskStats } from "../core/task-stats.js";
import type { BrokerStateStore } from "../core/store.js";
import type { TaskRecord } from "../core/types.js";
import { listAllTasksForStatsReadPath } from "../task-read-paths.js";
import { sendJson } from "./response.js";

const DEFAULT_STATS_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export interface TaskStatsRouteContext {
  method: string | undefined;
  path: string;
  res: ServerResponse;
  url: URL;
  broker: InMemoryA2ABroker;
  stateStore: BrokerStateStore;
}

function parseIsoParam(value: string | null, field: string): Date | null {
  if (value === null || value.trim() === "") return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new BrokerError("bad_request", `${field} must be a valid ISO timestamp`);
  }
  return parsed;
}

export function parseTaskStatsWindow(url: URL, now = new Date()): { since: Date; until: Date } {
  const until = parseIsoParam(url.searchParams.get("until"), "until") ?? now;
  const since = parseIsoParam(url.searchParams.get("since"), "since") ?? new Date(until.getTime() - DEFAULT_STATS_WINDOW_MS);
  if (since.getTime() > until.getTime()) {
    throw new BrokerError("bad_request", "since must be <= until");
  }
  if (until.getTime() - since.getTime() > DEFAULT_STATS_WINDOW_MS) {
    throw new BrokerError("bad_request", "stats window must not exceed 7 days");
  }
  return { since, until };
}

export function workerClassForStatsTask(broker: InMemoryA2ABroker, task: TaskRecord): string {
  const workerId = task.assignedWorkerId ?? task.targetNodeId;
  const worker = workerId ? broker.getWorker(workerId) : null;
  return deriveTaskWorkerClass({
    sourceOnly: task.payload?.sourceOnly === true,
    payloadMode: typeof task.payload?.mode === "string" ? task.payload.mode : undefined,
    workerFound: Boolean(worker),
    workerMode: worker?.workerMode,
  });
}

export function handleTaskStatsRouteIfMatched(ctx: TaskStatsRouteContext): boolean {
  if (ctx.method !== "GET" || ctx.path !== "/stats/tasks") {
    return false;
  }
  const window = parseTaskStatsWindow(ctx.url);
  const tasks = listAllTasksForStatsReadPath(ctx.stateStore, ctx.broker);
  try {
    const stats = aggregateTaskStats(tasks, {
      ...window,
      workerClassForTask: (task) => workerClassForStatsTask(ctx.broker, task),
    });
    sendJson(ctx.res, 200, stats);
    return true;
  } catch (error) {
    if (error instanceof Error) {
      throw new BrokerError("bad_request", error.message);
    }
    throw error;
  }
}
