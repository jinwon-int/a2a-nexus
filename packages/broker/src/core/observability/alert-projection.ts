/**
 * Alert projection for monitoring-friendly status.
 *
 * Scans task diagnostic reports and produces structured alerts for downstream
 * consumers (dashboard UI, notification channels, gateway RPC surface).
 *
 * Design principles:
 *   - Stateless: pure function of diagnostic reports, no side effects.
 *   - Deterministic: same input always produces same alerts.
 *   - Composable: alerts are plain data, easy to filter/route.
 */
import { jsonSafeSpendInteger } from "../store-schemas.js";
import type {
  BudgetEnforcementMode,
  BudgetEvaluation,
  TaskDiagnosticReport,
  TaskError,
  TaskTombstone,
  WorkerRecord,
} from "../types.js";
import type { HotTableGrowthProjection } from "./hot-table-growth.js";

// ---------------------------------------------------------------------------
// Alert types
// ---------------------------------------------------------------------------

export type AlertSeverity = "info" | "warning" | "critical";

export type AlertKind =
  | "task_stale"
  | "task_long_running"
  | "task_dead_lettered"
  | "task_worker_lost"
  | "task_timeout"
  | "task_failed"
  | "task_canceled"
  | "queue_pressure"
  | "worker.heartbeat_missed"
  | "gateway.unhealthy"
  | "hot_table_growth"
  // #2499 slice 4: a monthly spend budget at its warn threshold / exhausted.
  | "budget_warn"
  | "budget_exhausted"
  // #2523: a durable write failed; the broker refuses mutations until a recovery save succeeds.
  | "persistence_degraded";

/** #2499 slice 4: `budget` subjects are `${budgetId}:${periodKey}` (one alert per budget and period). */
export type AlertSubjectKind = "task" | "worker" | "gateway" | "storage" | "budget";

export interface Alert {
  /** Unique alert id (deterministic: `${kind}:${subject.id}`). */
  id: string;
  kind: AlertKind;
  severity: AlertSeverity;
  /** The broker-owned entity this alert is about. */
  subject: {
    kind: AlertSubjectKind;
    id: string;
  };
  /** Present for task-scoped alerts. */
  taskId?: string;
  /** Present for worker-scoped alerts. */
  workerId?: string;
  /** Human-readable summary. */
  summary: string;
  /** ISO timestamp when the condition was detected. */
  detectedAt: string;
  /** Relevant timing in milliseconds. */
  durationMs?: number;
  /** Additional context. */
  metadata: Record<string, unknown>;
}

export interface AlertScanResult {
  /** When this scan was computed. */
  scannedAt: string;
  /** Total number of tasks scanned. */
  totalScanned: number;
  /** Alerts grouped by severity. */
  alerts: Alert[];
  /** Quick counts by severity. */
  counts: Record<AlertSeverity, number>;
  /** Quick counts by kind. */
  countsByKind: Record<AlertKind, number>;
}

const ALERT_ERROR_MESSAGE_MAX_CHARS = 1_000;
const ALERT_ERROR_SUMMARY_MAX_CHARS = 240;

// ---------------------------------------------------------------------------
// Alert projection — pure function
// ---------------------------------------------------------------------------

export interface AlertProjectionOptions {
  /** Staleness threshold for "critical" (default: 10 min). */
  staleCriticalMs?: number;
  /** Staleness threshold for "warning" (default: 2 min). */
  staleWarningMs?: number;
  /** Long-running threshold for "warning" (default: 1 hr). */
  longRunningWarningMs?: number;
  /** Long-running threshold for "critical" (default: 4 hr). */
  longRunningCriticalMs?: number;
  /** Queue pressure: number of queued tasks for warning. */
  queuePressureWarning?: number;
  /** Queue pressure: number of queued tasks for critical. */
  queuePressureCritical?: number;
  /** Hot-table growth projection to scan for storage-growth alerts. */
  hotTableGrowth?: HotTableGrowthProjection | null;
  /** Worker records to scan for missed heartbeats. */
  workers?: WorkerRecord[];
  /** Threshold after which a worker heartbeat is considered missed. */
  workerHeartbeatMissedAfterMs?: number;
  /**
   * #2499 slice 4: budget alerts precomputed by the broker's stale-reaper
   * sweep (InMemoryA2ABroker.getBudgetAlerts). Taken as given: the
   * projection reads no store.
   */
  budgetAlerts?: Alert[];
  /** #2523: the broker's persistence alert (InMemoryA2ABroker.getPersistenceAlerts), taken as given. */
  persistenceAlerts?: Alert[];
  /** Current time override (for testing). */
  nowMs?: number;
}

export function projectAlerts(
  reports: TaskDiagnosticReport[],
  options?: AlertProjectionOptions,
): AlertScanResult {
  const nowMs = options?.nowMs ?? Date.now();
  const now = new Date(nowMs).toISOString();
  const staleWarningMs = options?.staleWarningMs ?? 120_000;
  const staleCriticalMs = options?.staleCriticalMs ?? 600_000;
  const longRunningCriticalMs = options?.longRunningCriticalMs ?? 14_400_000;
  const workerHeartbeatMissedAfterMs = options?.workerHeartbeatMissedAfterMs ?? staleWarningMs;

  const alerts: Alert[] = [];

  for (const report of reports) {
    // Stale tasks
    if (report.diagnosticStatus === "stale") {
      const stalenessMs = report.stalenessMs ?? report.currentStatusDurationMs;
      const severity: AlertSeverity =
        stalenessMs >= staleCriticalMs ? "critical" : "warning";
      alerts.push(
        makeAlert("task_stale", severity, report, now, {
          summary: `Task ${report.taskId} is stale (no heartbeat for ${Math.round(stalenessMs / 1000)}s)`,
          durationMs: stalenessMs,
          extra: {
            stalenessMs,
            intent: report.task.intent,
            targetNodeId: report.task.targetNodeId,
            assignedWorkerId: report.task.assignedWorkerId,
          },
        }),
      );
    }

    // Long-running tasks
    if (report.diagnosticStatus === "long_running") {
      const durationMs = report.currentStatusDurationMs;
      const severity: AlertSeverity =
        durationMs >= longRunningCriticalMs ? "critical" : "warning";
      alerts.push(
        makeAlert("task_long_running", severity, report, now, {
          summary: `Task ${report.taskId} has been running for ${Math.round(durationMs / 60000)}m`,
          durationMs,
          extra: {
            intent: report.task.intent,
            targetNodeId: report.task.targetNodeId,
          },
        }),
      );
    }

    // Terminal alerts from tombstones
    if (report.diagnosticStatus === "terminal" && report.tombstone) {
      const ts = report.tombstone;
      const terminalAlert = projectTerminalAlert(report, ts, now);
      if (terminalAlert) {
        alerts.push(terminalAlert);
      }
    }
  }

  // Hot-table growth alerts from storage pressure
  if (options?.hotTableGrowth) {
    const growthAlerts = projectHotTableGrowthAlerts(options.hotTableGrowth, now);
    alerts.push(...growthAlerts);
  }

  // #2499 slice 4: budget alerts come precomputed (no store read here).
  alerts.push(...(options?.budgetAlerts ?? []));
  alerts.push(...(options?.persistenceAlerts ?? []));

  for (const worker of options?.workers ?? []) {
    const lastSeenMs = Date.parse(worker.lastSeenAt);
    if (!Number.isFinite(lastSeenMs)) {
      continue;
    }
    const lastSeenAgeMs = nowMs - lastSeenMs;
    if (lastSeenAgeMs < workerHeartbeatMissedAfterMs) {
      continue;
    }
    alerts.push(
      makeWorkerAlert("worker.heartbeat_missed", "warning", worker, now, {
        summary: `Worker ${worker.nodeId} missed heartbeat (${Math.round(lastSeenAgeMs / 1000)}s since last seen)`,
        durationMs: lastSeenAgeMs,
      }),
    );
  }

  // Sort: critical first, then warning, then info
  const severityOrder: Record<AlertSeverity, number> = {
    critical: 0,
    warning: 1,
    info: 2,
  };
  alerts.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

  const counts = { critical: 0, warning: 0, info: 0 };
  const countsByKind = {} as Record<AlertKind, number>;
  for (const alert of alerts) {
    counts[alert.severity]++;
    countsByKind[alert.kind] = (countsByKind[alert.kind] ?? 0) + 1;
  }

  return {
    scannedAt: now,
    totalScanned: reports.length,
    alerts,
    counts,
    countsByKind,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function projectTerminalAlert(
  report: TaskDiagnosticReport,
  tombstone: TaskTombstone,
  now: string,
): Alert | null {
  switch (tombstone.tombstoneReason) {
    case "dead_lettered":
      return makeAlert("task_dead_lettered", "critical", report, now, {
        summary: `Task ${report.taskId} dead-lettered after ${tombstone.requeueCount} requeues`,
        durationMs: tombstone.durationMs,
        extra: {
          requeueCount: tombstone.requeueCount,
          error: tombstone.error,
        },
      });
    case "worker_lost":
      return makeAlert("task_worker_lost", "warning", report, now, {
        summary: `Task ${report.taskId} terminated: assigned worker went offline`,
        durationMs: tombstone.durationMs,
        extra: {
          assignedWorkerId: report.task.assignedWorkerId,
        },
      });
    case "timeout":
      return makeAlert("task_timeout", "warning", report, now, {
        summary: `Task ${report.taskId} timed out after ${Math.round(tombstone.durationMs / 1000)}s`,
        durationMs: tombstone.durationMs,
      });
    case "failed":
      return makeAlert("task_failed", "info", report, now, {
        summary: `Task ${report.taskId} failed: ${compactAlertErrorSummary(tombstone.error)}`,
        durationMs: tombstone.durationMs,
        extra: { error: compactAlertError(tombstone.error) },
      });
    case "canceled":
      return makeAlert("task_canceled", "info", report, now, {
        summary: `Task ${report.taskId} was canceled`,
        durationMs: tombstone.durationMs,
      });
    default:
      return null;
  }
}

/**
 * Max hot-table growth alerts emitted per projection to keep alert payloads compact.
 */
const MAX_HOT_TABLE_GROWTH_ALERTS = 5;

/**
 * Project hot-table growth warnings/criticals into structured alerts.
 *
 * Produces at most {@link MAX_HOT_TABLE_GROWTH_ALERTS} alerts to keep
 * operator event payloads bounded. Each alert has a deterministic id based on
 * the table name (e.g. `"hot_table_growth:broker_tasks"`) so the operator
 * event stream can track open/resolve transitions.
 *
 * Design:
 *   - Pure function: same inputs → same outputs.
 *   - Each alert carries compact summary + severity + estimated memory bytes.
 *   - Alerts are deduped by table so the alert-open/resolve loop works.
 *   - Tables with severity "ok" produce no alert (existing alert resolves naturally).
 */
export function projectHotTableGrowthAlerts(
  projection: HotTableGrowthProjection,
  detectedAt: string,
): Alert[] {
  const alerts: Alert[] = [];

  for (const table of projection.tables) {
    if (table.severity === "ok") continue;
    if (alerts.length >= MAX_HOT_TABLE_GROWTH_ALERTS) break;

    const kind: AlertKind = "hot_table_growth";
    alerts.push({
      id: `hot_table_growth:${table.table}`,
      kind,
      severity: table.severity,
      subject: { kind: "storage", id: table.table },
      summary: table.severity === "critical"
        ? `CRITICAL: ${table.summary}`
        : `WARNING: ${table.summary}`,
      detectedAt,
      metadata: {
        table: table.table,
        currentCount: table.currentCount,
        estimatedMemoryBytes: table.estimatedMemoryBytes,
        growthDelta: table.growthDelta,
        growthRate: table.growthRate,
        runtimeSkipped: table.runtimeSkipped,
        severity: table.severity,
        runtimeLimit: table.runtimeLimit,
        operatorAction: table.operatorAction ?? (table.severity === "critical" ? "approval_required" : "investigate"),
        operatorActionReason: table.operatorActionReason ?? "legacy projection without operator action classification",
      },
    });
  }

  return alerts;
}

/** #2499 slice 4: which limit an alert is about. */
export type BudgetAlertLimit = "usd" | "tokens";

/**
 * #2499 slice 4: the alert for one budget evaluated against one period, or
 * null when neither limit reached `warnPct`. `budget_exhausted` (critical)
 * when either limit is exhausted, else `budget_warn` (warning) when either
 * limit reached `warnPct` percent; exhausted supersedes warn, so one budget
 * and period project at most one of the two. Either limit counts: an alert is
 * visibility, not a per-worker refusal (Decision 4 is about claims). The id is
 * `${kind}:${budgetId}:${periodKey}`, so "once per budget and period" is
 * structural: the operator differ opens it once, and it resolves when the
 * period rolls (a new id) or the condition no longer holds. The metadata
 * carries ids, numbers and modes only (no worker-provided text); token
 * counts go through jsonSafeSpendInteger (bigint-safe JSON). Pure.
 */
export function projectBudgetAlert(input: {
  evaluation: BudgetEvaluation;
  enforcement: { configuredMode: BudgetEnforcementMode; effectiveMode: BudgetEnforcementMode | null };
  detectedAt: string;
}): Alert | null {
  const { evaluation } = input;
  const { budget } = evaluation;
  const exhausted: BudgetAlertLimit[] = [];
  if (evaluation.usdExhausted) exhausted.push("usd");
  if (evaluation.tokensExhausted) exhausted.push("tokens");
  // #2520: the evaluator's warn decision (evaluateBudgetUsage), not a
  // recomputation; `usdWarn` / `tokensWarn` name the limits that crossed.
  const atWarn: BudgetAlertLimit[] = [];
  if (evaluation.warn) {
    if (evaluation.usdWarn) atWarn.push("usd");
    if (evaluation.tokensWarn) atWarn.push("tokens");
  }
  const kind: AlertKind | null = exhausted.length > 0 ? "budget_exhausted" : atWarn.length > 0 ? "budget_warn" : null;
  if (kind === null) return null;
  const limits = kind === "budget_exhausted" ? exhausted : atWarn;
  const subjectId = `${budget.id}:${evaluation.periodKey}`;
  return {
    id: `${kind}:${subjectId}`,
    kind,
    severity: kind === "budget_exhausted" ? "critical" : "warning",
    subject: { kind: "budget", id: subjectId },
    summary: kind === "budget_exhausted"
      ? `Budget ${budget.id} (${budget.scopeType}) exhausted for ${evaluation.periodKey}: ${limits.join(" and ")} limit reached`
      : `Budget ${budget.id} (${budget.scopeType}) reached ${budget.warnPct}% of its ${limits.join(" and ")} limit for ${evaluation.periodKey}`,
    detectedAt: input.detectedAt,
    metadata: {
      budgetId: budget.id,
      scopeType: budget.scopeType,
      scopeId: budget.scopeId,
      period: budget.period,
      periodKey: evaluation.periodKey,
      limits,
      usdSpent: evaluation.usdSpent,
      limitUsd: budget.limitUsd ?? null,
      tokensSpent: jsonSafeSpendInteger(evaluation.tokensSpent),
      limitTokens: budget.limitTokens ?? null,
      warnPct: budget.warnPct,
      enforce: budget.enforce,
      configuredMode: input.enforcement.configuredMode,
      effectiveMode: input.enforcement.effectiveMode,
    },
  };
}

/**
 * #2523: the fields of the broker's durable-write health the alert reads (a
 * narrow port, so observability does not depend on the store domain).
 */
export interface PersistenceDegradedAlertInput {
  state: "ok" | "degraded";
  degradedSince: string | null;
  lastFailure: { at: string; topology: string } | null;
  failuresTotal: number;
}

/**
 * #2523: the critical alert while broker persistence is degraded (a durable
 * write failed, so mutations are refused with 503 `state_unavailable`), else
 * null. One subject per broker, so the operator differ opens it when the
 * state opens and resolves it when a recovery save clears it. Pure.
 */
export function projectPersistenceDegradedAlert(health: PersistenceDegradedAlertInput): Alert | null {
  if (health.state !== "degraded") return null;
  return {
    id: "persistence_degraded:broker-persistence",
    kind: "persistence_degraded",
    severity: "critical",
    subject: { kind: "storage", id: "broker-persistence" },
    summary: "Broker persistence degraded: a durable write failed; mutations are refused with 503 until a recovery save succeeds",
    detectedAt: health.degradedSince ?? health.lastFailure?.at ?? new Date(0).toISOString(),
    metadata: {
      degradedSince: health.degradedSince,
      lastFailureAt: health.lastFailure?.at ?? null,
      lastFailureTopology: health.lastFailure?.topology ?? null,
      failuresTotal: health.failuresTotal,
      operatorAction: "check disk space and SQLite errors in the broker log (broker.persistence.degraded)",
    },
  };
}

function compactAlertErrorSummary(error: TaskError | undefined): string {
  return truncateForAlert(error?.message ?? "unknown error", ALERT_ERROR_SUMMARY_MAX_CHARS);
}

function compactAlertError(error: TaskError | undefined): Record<string, unknown> | undefined {
  if (!error) {
    return undefined;
  }

  const message = truncateForAlert(error.message, ALERT_ERROR_MESSAGE_MAX_CHARS);
  return {
    ...(error.code ? { code: error.code } : {}),
    message,
    ...(error.message.length > message.length ? { messageTruncated: true } : {}),
    ...(error.details ? { detailsOmitted: true, detailsBytes: safeJsonByteLength(error.details) } : {}),
  };
}

function truncateForAlert(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxChars - 1))}…`;
}

function safeJsonByteLength(value: unknown): number | undefined {
  try {
    return Buffer.byteLength(JSON.stringify(value));
  } catch {
    return undefined;
  }
}

function makeAlert(
  kind: AlertKind,
  severity: AlertSeverity,
  report: TaskDiagnosticReport,
  detectedAt: string,
  opts: {
    summary: string;
    durationMs?: number;
    extra?: Record<string, unknown>;
  },
): Alert {
  return {
    id: `${kind}:${report.taskId}`,
    kind,
    severity,
    subject: {
      kind: "task",
      id: report.taskId,
    },
    taskId: report.taskId,
    summary: opts.summary,
    detectedAt,
    durationMs: opts.durationMs,
    metadata: {
      intent: report.task.intent,
      targetNodeId: report.task.targetNodeId,
      assignedWorkerId: report.task.assignedWorkerId,
      diagnosticStatus: report.diagnosticStatus,
      ...opts.extra,
    },
  };
}

function makeWorkerAlert(
  kind: AlertKind,
  severity: AlertSeverity,
  worker: WorkerRecord,
  detectedAt: string,
  opts: {
    summary: string;
    durationMs?: number;
    extra?: Record<string, unknown>;
  },
): Alert {
  return {
    id: `${kind}:${worker.nodeId}`,
    kind,
    severity,
    subject: {
      kind: "worker",
      id: worker.nodeId,
    },
    workerId: worker.nodeId,
    summary: opts.summary,
    detectedAt,
    durationMs: opts.durationMs,
    metadata: {
      workerId: worker.nodeId,
      role: worker.role,
      displayName: worker.displayName,
      lastSeenAt: worker.lastSeenAt,
      ...opts.extra,
    },
  };
}
