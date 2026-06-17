import { InMemoryA2ABroker } from "../core/broker.js";
import { InMemoryRateLimiter, type RateLimitPressureSnapshot } from "../core/request-security.js";
import type { BrokerDashboard } from "../core/types.js";
import { projectAlerts, type AlertScanResult } from "../core/alert-projection.js";
import type { BrokerHotEntityDiagnostics } from "../core/store.js";
import type { HotTableGrowthProjection } from "../core/hot-table-growth.js";
import {
  buildOperatorDashboardSnapshot,
  type OperatorDashboardSnapshot,
} from "../core/operator-dashboard-snapshot.js";
import type {
  BrokerBuildInfo,
  BrokerPersistenceQueueDiagnostics,
  BrokerStaleReaperStatus,
} from "../server.js";

const DEFAULT_DASHBOARD_RECENT_HISTORY_LIMIT = 10;
const DEFAULT_DASHBOARD_OLDEST_PENDING_LIMIT = 5;
const DEFAULT_DASHBOARD_PENDING_ACTION_LIMIT = 5;
const DEFAULT_ALERT_STALE_AFTER_MS = 120_000;
const DEFAULT_ALERT_LONG_RUNNING_AFTER_MS = 3_600_000;

export interface DashboardAttentionItem {
  code: string;
  severity: "info" | "warn" | "critical";
  count: number;
  summary: string;
}

export interface DashboardAttentionSummary {
  highestSeverity: "none" | DashboardAttentionItem["severity"];
  items: DashboardAttentionItem[];
}

export type OperatorSummary = BrokerDashboard & {
  version: string;
  build: BrokerBuildInfo;
  staleReaper: BrokerStaleReaperStatus;
  requestPressure: {
    general: RateLimitPressureSnapshot;
    worker: RateLimitPressureSnapshot;
  };
  attention: DashboardAttentionSummary;
  operatorSnapshot: OperatorDashboardSnapshot;
  hotEntityDiagnostics?: BrokerHotEntityDiagnostics;
  persistenceQueue: BrokerPersistenceQueueDiagnostics;
};

export function buildDashboardAttention(input: {
  dashboard: BrokerDashboard;
  staleReaper: BrokerStaleReaperStatus;
  persistenceQueue: BrokerPersistenceQueueDiagnostics;
  requestPressure: {
    general: RateLimitPressureSnapshot;
    worker: RateLimitPressureSnapshot;
  };
}): DashboardAttentionSummary {
  const items: DashboardAttentionItem[] = [];

  const staleAssignments = input.dashboard.observability.queuePressure.staleWorkerAssignments;
  if (staleAssignments > 0) {
    items.push({
      code: "stale-worker-assignments",
      severity: "critical",
      count: staleAssignments,
      summary: `${staleAssignments} claimed/running task(s) are assigned to stale workers`,
    });
  }

  const staleWorkers = input.dashboard.observability.workerHealth.staleWorkersWithActiveTasks.length;
  if (staleWorkers > 0) {
    items.push({
      code: "stale-workers-with-active-tasks",
      severity: "critical",
      count: staleWorkers,
      summary: `${staleWorkers} stale worker(s) still have active tasks`,
    });
  }

  const claimedAgeThresholdSec = Math.max(1, input.staleReaper.olderThanSec || 0);
  const oldestClaimed = input.dashboard.observability.queuePressure.oldestClaimed;
  if (oldestClaimed && oldestClaimed.statusAgeSec >= claimedAgeThresholdSec) {
    items.push({
      code: "aged-claimed-task",
      severity: oldestClaimed.statusAgeSec >= claimedAgeThresholdSec * 2 ? "critical" : "warn",
      count: 1,
      summary: `claimed task ${oldestClaimed.id} has been waiting ${oldestClaimed.statusAgeSec}s since claim`,
    });
  }

  const runningAgeThresholdSec = claimedAgeThresholdSec;
  const oldestRunning = input.dashboard.observability.queuePressure.oldestRunning;
  if (oldestRunning && oldestRunning.statusAgeSec >= runningAgeThresholdSec) {
    items.push({
      code: "aged-running-task",
      severity: oldestRunning.statusAgeSec >= runningAgeThresholdSec * 2 ? "critical" : "warn",
      count: 1,
      summary: `running task ${oldestRunning.id} has been active ${oldestRunning.statusAgeSec}s since start`,
    });
  }

  const recentDeadLetters = Math.max(
    input.dashboard.observability.recovery.recentDeadLetters.length,
    input.staleReaper.lastDeadLettered ?? 0,
  );
  if (recentDeadLetters > 0) {
    items.push({
      code: "dead-lettered-tasks",
      severity: "warn",
      count: recentDeadLetters,
      summary: `${recentDeadLetters} task(s) were dead-lettered and need operator review`,
    });
  }

  const recentRequeues = input.staleReaper.lastRequeued ?? 0;
  if (recentRequeues > 0) {
    items.push({
      code: "stale-reaper-requeues",
      severity: "info",
      count: recentRequeues,
      summary: `stale reaper requeued ${recentRequeues} task(s) on the last sweep`,
    });
  }

  if (input.persistenceQueue.state === "saturated") {
    items.push({
      code: "persistence-queue-saturated",
      severity: "warn",
      count: input.persistenceQueue.inFlight,
      summary: `persistence queue saturated: ${input.persistenceQueue.inFlight} in-flight write(s)`,
    });
  } else if (input.persistenceQueue.state === "aborted" || input.persistenceQueue.state === "unavailable") {
    items.push({
      code: "persistence-queue-unavailable",
      severity: "critical",
      count: input.persistenceQueue.inFlight,
      summary: `persistence queue ${input.persistenceQueue.state}`,
    });
  } else if (input.persistenceQueue.state === "draining" || input.persistenceQueue.closing) {
    items.push({
      code: "persistence-queue-draining",
      severity: "info",
      count: input.persistenceQueue.inFlight,
      summary: `persistence queue draining: ${input.persistenceQueue.inFlight} in-flight write(s)`,
    });
  }

  const saturatedGeneralKeys = input.requestPressure.general.busiest.filter((entry) => entry.remaining === 0).length;
  const saturatedWorkerKeys = input.requestPressure.worker.busiest.filter((entry) => entry.remaining === 0).length;
  const saturatedKeys = saturatedGeneralKeys + saturatedWorkerKeys;
  if (saturatedKeys > 0) {
    items.push({
      code: "rate-limit-saturation",
      severity: "warn",
      count: saturatedKeys,
      summary: `${saturatedKeys} rate-limit key(s) are currently saturated`,
    });
  }

  return {
    highestSeverity: highestDashboardAttentionSeverity(items),
    items,
  };
}

function highestDashboardAttentionSeverity(items: DashboardAttentionItem[]): DashboardAttentionSummary["highestSeverity"] {
  let highest: DashboardAttentionSummary["highestSeverity"] = "none";
  for (const item of items) {
    if (item.severity === "critical") {
      return "critical";
    }
    if (item.severity === "warn") {
      highest = highest === "none" || highest === "info" ? "warn" : highest;
      continue;
    }
    if (item.severity === "info" && highest === "none") {
      highest = "info";
    }
  }
  return highest;
}

export function buildDashboardResponse(input: {
  broker: InMemoryA2ABroker;
  workerOfflineAfterSec: number;
  getStaleReaperStatus: () => BrokerStaleReaperStatus;
  rateLimiter: InMemoryRateLimiter;
  workerRateLimiter: InMemoryRateLimiter;
  version: string;
  build: BrokerBuildInfo;
  recentHistoryLimit?: number;
  oldestPendingLimit?: number;
  pendingActionLimit?: number;
  hotEntityDiagnostics?: BrokerHotEntityDiagnostics;
  persistenceQueue: BrokerPersistenceQueueDiagnostics;
}): OperatorSummary {
  const dashboard = input.broker.getDashboard({
    offlineAfterMs: input.workerOfflineAfterSec * 1000,
    recentHistoryLimit: input.recentHistoryLimit ?? DEFAULT_DASHBOARD_RECENT_HISTORY_LIMIT,
    oldestPendingLimit: input.oldestPendingLimit ?? DEFAULT_DASHBOARD_OLDEST_PENDING_LIMIT,
    pendingActionLimit: input.pendingActionLimit ?? DEFAULT_DASHBOARD_PENDING_ACTION_LIMIT,
  });
  const staleReaper = input.getStaleReaperStatus();
  const requestPressure = {
    general: input.rateLimiter.snapshot(),
    worker: input.workerRateLimiter.snapshot(),
  };
  return {
    ...dashboard,
    version: input.version,
    build: input.build,
    staleReaper,
    requestPressure,
    attention: buildDashboardAttention({
      dashboard,
      staleReaper,
      persistenceQueue: input.persistenceQueue,
      requestPressure,
    }),
    operatorSnapshot: buildOperatorDashboardSnapshot({
      broker: input.broker,
      dashboard,
      staleReaper,
    }),
    hotEntityDiagnostics: input.hotEntityDiagnostics,
    persistenceQueue: input.persistenceQueue,
  };
}

export function buildAlertScan(input: {
  broker: InMemoryA2ABroker;
  staleAfterMs?: number;
  longRunningAfterMs?: number;
  staleWarningMs?: number;
  staleCriticalMs?: number;
  longRunningWarningMs?: number;
  longRunningCriticalMs?: number;
  workerHeartbeatMissedAfterMs: number;
  nowMs?: number;
  /** Optional hot-table growth projection for storage-growth alerts. */
  hotTableGrowth?: HotTableGrowthProjection | null;
}): AlertScanResult {
  const staleAfterMs = input.staleAfterMs ?? DEFAULT_ALERT_STALE_AFTER_MS;
  const longRunningAfterMs = input.longRunningAfterMs ?? DEFAULT_ALERT_LONG_RUNNING_AFTER_MS;
  const allTasks = input.broker.listTasks();
  const reports = allTasks.map((task) =>
    input.broker.getTaskDiagnostics(task.id, { staleAfterMs, longRunningAfterMs }),
  );

  return projectAlerts(reports, {
    staleWarningMs: input.staleWarningMs,
    staleCriticalMs: input.staleCriticalMs,
    longRunningWarningMs: input.longRunningWarningMs,
    longRunningCriticalMs: input.longRunningCriticalMs,
    workers: input.broker.listWorkers(),
    workerHeartbeatMissedAfterMs: input.workerHeartbeatMissedAfterMs,
    nowMs: input.nowMs,
    hotTableGrowth: input.hotTableGrowth,
  });
}
