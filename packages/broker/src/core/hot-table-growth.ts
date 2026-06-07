/**
 * Hot-table growth projection for broker diagnostics.
 *
 * Pure function: takes current hot-table load metrics and an optional prior
 * snapshot to compute growth rates, projected saturation timelines, and
 * structured warnings for operators.
 *
 * Design:
 *   - Stateless: pure function of input metrics, no side effects.
 *   - No production mutation: read-only projection only.
 *   - Deterministic: same inputs → same output.
 *
 * Used by: health endpoint (via store), migration-health-gate, canary gates.
 * Reference: #533 Team1/Bangtong diagnostics for #497/#294 stability gates.
 */
import type { BrokerHotTableLoadMetrics, BrokerHotTableRuntimeLoadLimits } from "./store.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type HotTableGrowthSeverity = "ok" | "warning" | "critical";
export type HotTableOperatorAction = "observe" | "investigate" | "approval_required";

export interface HotTableGrowthTableProjection {
  table: string;
  currentCount: number;
  maxPayloadBytes: number;
  /** Estimated total in-memory footprint (bytes) for this table. */
  estimatedMemoryBytes: number;
  /** Runtime load cap for this table, if applicable. */
  runtimeLimit: number | null;
  /** Rows loaded into heap under the current cap. */
  runtimeLoaded: number;
  /** Rows skipped from heap hydration. */
  runtimeSkipped: number;
  /** Count at the prior snapshot, if available. */
  priorCount: number | null;
  /** Absolute delta since prior snapshot. */
  growthDelta: number;
  /** Growth rate as a fraction (delta / priorCount). Null if no prior. */
  growthRate: number | null;
  /** Severity of this table's state. */
  severity: HotTableGrowthSeverity;
  /**
   * Operator-facing action tier for this table.
   *
   * `severity="warning"` can represent steady-state bounded operation
   * (for example audit rows near their runtime cap with no skipped rows) or a
   * condition that deserves investigation. This field makes that distinction
   * explicit for `/health`, `/alerts`, and Terminal Brief consumers.
   */
  operatorAction?: HotTableOperatorAction;
  /** Short reason for the operator action classification. */
  operatorActionReason?: string;
  /** Human-readable summary of the table's state. */
  summary: string;
}

export interface HotTableGrowthProjection {
  kind: "broker.hot-table-growth.projection";
  generatedAt: string;
  /** Whether this includes a prior comparison. */
  hasPrior: boolean;
  /** Prior snapshot timestamp, if available. */
  priorGeneratedAt: string | null;
  /** Total estimated hot-table memory footprint across all tables. */
  totalEstimatedMemoryBytes: number;
  /** Aggregate severity across all tables. */
  overallSeverity: HotTableGrowthSeverity;
  /** Aggregate operator action recommended by the projection. */
  operatorAction?: HotTableOperatorAction;
  /** Short reason for the aggregate operator action classification. */
  operatorActionReason?: string;
  /** Per-table projections. */
  tables: HotTableGrowthTableProjection[];
  /** Active runtime load limits. */
  runtimeLoadLimits: BrokerHotTableRuntimeLoadLimits;
  /** Aggregate warnings. */
  warnings: string[];
  /** Whether the warnings array was truncated because it exceeded `maxWarnings`. */
  warningsTruncated: boolean;
  /**
   * Process memory snapshot at the time of projection.
   * Present when `processMemory` was supplied in options.
   */
  processMemory?: {
    rssBytes: number;
    heapTotalBytes: number;
    heapUsedBytes: number;
    heapLimitBytes: number;
    heapUsedRatio: number;
  };
  /**
   * Snapshot persistence metrics.
   * Present when `snapshotMetrics` was supplied in options.
   */
  snapshotMetrics?: {
    lastSnapshotBytes: number | null;
    lastPersistDurationMs: number | null;
    lastSnapshotAt: string | null;
  };
  /**
   * Readiness degradation assessment — flags that the broker may be near
   * OOM or unable to hydrate critical table rows into live memory.
   */
  readinessDegradation?: {
    /** True when heap usage exceeds 80% of the heap limit. */
    heapPressure: boolean;
    /** True when hot-table estimated memory exceeds 50% of available heap. */
    memoryPressure: boolean;
    /** True when any table has a critical runtime skipped ratio. */
    hydrationPressure: boolean;
    /** True when any pressure flag is set (overall risky indicator). */
    overallRisky: boolean;
    /**
     * Warning-level precursor to {@link overallRisky}.
     * True when a pressure signal is elevated but not yet critical
     * (e.g. heap > 60%, memory > 35% of heap, warning-level skipped rows).
     * Allows the health endpoint to warn operators before the broker
     * reaches critical degradation.
     */
    overallWarning: boolean;
    /**
     * Adaptive load limits computed by the heap budget guard.
     * Present when `processMemory` was supplied.
     * These show what the guard recommends to keep hot-table loads within budget.
     */
    adaptiveLoadLimits?: AdaptiveLoadLimits;
  };
}

// ---------------------------------------------------------------------------
// Default thresholds
// ---------------------------------------------------------------------------

/** Default warning threshold: total hot entities exceed this many rows. */
export const DEFAULT_HOT_TABLE_GROWTH_WARNING_ROWS = 2_000;
/** Default critical threshold: total hot entities exceed this many rows. */
export const DEFAULT_HOT_TABLE_GROWTH_CRITICAL_ROWS = 10_000;
/** Default warning threshold: single table exceeds this many rows. */
export const DEFAULT_SINGLE_TABLE_WARNING_ROWS = 1_000;
/** Default single-table critical row threshold. */
export const DEFAULT_SINGLE_TABLE_CRITICAL_ROWS = 5_000;
/** Default warning: growth rate > 50% between snapshots. */
export const DEFAULT_GROWTH_RATE_WARNING = 0.5;
/** Default warning: estimated memory > 100 MB. */
export const DEFAULT_MEMORY_WARNING_BYTES = 100 * 1024 * 1024;
/** Default critical: estimated memory > 500 MB. */
export const DEFAULT_MEMORY_CRITICAL_BYTES = 500 * 1024 * 1024;
/** Default warning: runtime skipped ratio > 0.3 (30% of rows skipped from heap). */
export const DEFAULT_SKIPPED_RATIO_WARNING = 0.3;
/** Default critical: runtime skipped ratio > 0.7. */
export const DEFAULT_SKIPPED_RATIO_CRITICAL = 0.7;
/**
 * Warning threshold for runtime-capped audit rows.
 *
 * Audit rows are retention evidence and can be intentionally protected by the
 * cleanup planner. A count above the generic 1k single-table threshold is not
 * actionable by itself while the table is comfortably below the runtime cap,
 * not skipping hydration rows, and not creating memory/growth pressure.
 */
export const DEFAULT_AUDIT_RUNTIME_LIMIT_WARNING_RATIO = 0.8;

/**
 * Overshoot ratio for broker_audit_events critical classification.
 *
 * When the audit row count exceeds the runtime cap by more than this
 * fraction, the table is classified as critical regardless of other
 * pressure signals — the cap itself is not holding.
 *
 * At the default cap of 5,000, a 20% overshoot means counts > 6,000
 * are critical by count alone.
 */
export const DEFAULT_AUDIT_CAP_OVERSHOOT_CRITICAL_RATIO = 0.2;

/** Default maximum number of warnings to include in the projection. */
export const DEFAULT_MAX_WARNINGS = 10;

/** Default heap pressure ratio (critical): heap used > 80% of limit. */
export const DEFAULT_HEAP_PRESSURE_RATIO = 0.8;

/** Default heap warning ratio: heap used > 60% of limit. */
export const DEFAULT_HEAP_WARNING_RATIO = 0.6;

/** Default memory pressure ratio (critical): hot-table memory > 50% of available heap. */
export const DEFAULT_MEMORY_PRESSURE_RATIO = 0.5;

/** Default memory warning ratio: hot-table memory > 35% of available heap. */
export const DEFAULT_MEMORY_PRESSURE_WARNING_RATIO = 0.35;

/** Default hydration warning threshold: any table with warning-level skipped ratio (>30%). */
export const DEFAULT_HYDRATION_SKIPPED_WARNING_RATIO = 0.3;

/**
 * Default heap budget guard: when heap pressure is active, load limits are
 * reduced below original caps by dividing by this factor.
 * E.g. 2 → terminal task limit halved.
 */
export const DEFAULT_HEAP_BUDGET_REDUCTION_FACTOR = 2;

/**
 * Default heap budget guard: minimum fraction of the original limit to retain
 * even under extreme heap pressure. Prevents starvation.
 * E.g. 0.25 → never reduce below 25% of the original limit.
 */
export const DEFAULT_HEAP_BUDGET_MINIMUM_FRACTION = 0.25;

export interface HotTableGrowthProjectionOptions {
  /** Current metrics from the broker health endpoint. */
  current: BrokerHotTableLoadMetrics;
  /** Optional prior metrics for growth-rate comparison. */
  prior?: BrokerHotTableLoadMetrics | null;
  /** Prior snapshot timestamp. */
  priorGeneratedAt?: string;
  /** Current runtime load limits. */
  runtimeLoadLimits?: BrokerHotTableRuntimeLoadLimits;
  /** Generated-at timestamp override (for testing). */
  generatedAt?: string;
  /** Maximum number of warnings to include. Extra warnings are dropped and
   *  `warningsTruncated` is set to `true`. Default: {@link DEFAULT_MAX_WARNINGS}. */
  maxWarnings?: number;
  /** Process memory snapshot (from `process.memoryUsage()` + `v8.getHeapStatistics()`).
   *  When supplied, enables `processMemory` and `readinessDegradation` on the projection. */
  processMemory?: {
    rssBytes: number;
    heapTotalBytes: number;
    heapUsedBytes: number;
    heapLimitBytes: number;
  };
  /** Snapshot persistence metrics. When supplied, enables `snapshotMetrics` on the projection. */
  snapshotMetrics?: {
    lastSnapshotBytes?: number | null;
    lastPersistDurationMs?: number | null;
    lastSnapshotAt?: string | null;
  };
  /**
   * Heap budget guard configuration. When omitted, defaults are used.
   * The guard computes adaptive runtime load limits from process memory
   * state and the configured reduction factor.
   */
  heapBudgetGuard?: {
    /** Reduction factor applied to limits under heap pressure. Default: 2. */
    reductionFactor?: number;
    /** Minimum fraction of the original limit to retain. Default: 0.25 (25%). */
    minimumFraction?: number;
  };
  /** Custom thresholds. */
  thresholds?: {
    totalWarningRows?: number;
    totalCriticalRows?: number;
    singleTableWarningRows?: number;
    singleTableCriticalRows?: number;
    growthRateWarning?: number;
    memoryWarningBytes?: number;
    memoryCriticalBytes?: number;
    skippedRatioWarning?: number;
    skippedRatioCritical?: number;
  };
}

// ---------------------------------------------------------------------------
// Adaptive load limits (heap budget guard)
// ---------------------------------------------------------------------------

/**
 * Adaptive load limits computed by the heap budget guard.
 *
 * These are recommendations for what the runtime load limits
 * should be reduced to under heap/memory pressure so that
 * hot-table hydration stays within the process heap budget.
 */
export interface AdaptiveLoadLimits {
  /** Original terminal task limit before reduction. */
  originalTerminalTaskLimit: number;
  /** Recommended terminal task limit after reduction. */
  adaptiveTerminalTaskLimit: number;
  /** Original audit event limit before reduction. */
  originalAuditEventLimit: number;
  /** Recommended audit event limit after reduction. */
  adaptiveAuditEventLimit: number;
  /** Original terminal outbox limit before reduction. */
  originalOutboxLimit: number;
  /** Recommended terminal outbox limit after reduction. */
  adaptiveOutboxLimit: number;
  /** Whether the guard was triggered (any limit changed). */
  guardTriggered: boolean;
  /** Why the guard reduced limits, if triggered. */
  guardReason: string | null;
  /** Reduction factor that was applied. */
  reductionFactor: number;
}

/**
 * Compute adaptive runtime load limits from process memory state and
 * the configured runtime load limits.
 *
 * Pure function: same inputs → same outputs, no side effects.
 *
 * Design:
 *   - If heap usage > 80% (heapPressure), divide all hot-table load limits
 *     by `reductionFactor` (default 2), subject to a minimum fraction of the
 *     original (default 25%).
 *   - If heap usage is safe but hot-table memory > 50% of heap limit
 *     (memoryPressure), apply the same reduction.
 *   - If neither pressure source is active, return the original limits unchanged
 *     (guard not triggered).
 *   - The guard never reduces a limit below `Math.max(1, Math.floor(original * minFraction))`.
 */
export function computeAdaptiveLoadLimits(
  processMemory: {
    heapUsedBytes: number;
    heapLimitBytes: number;
  },
  totalEstimatedMemoryBytes: number,
  runtimeLoadLimits: BrokerHotTableRuntimeLoadLimits,
  options?: {
    reductionFactor?: number;
    minimumFraction?: number;
  },
): AdaptiveLoadLimits {
  const reductionFactor = options?.reductionFactor ?? DEFAULT_HEAP_BUDGET_REDUCTION_FACTOR;
  const minimumFraction = options?.minimumFraction ?? DEFAULT_HEAP_BUDGET_MINIMUM_FRACTION;
  const heapUsedRatio =
    processMemory.heapLimitBytes > 0
      ? processMemory.heapUsedBytes / processMemory.heapLimitBytes
      : 0;

  const heapPressure = heapUsedRatio > DEFAULT_HEAP_PRESSURE_RATIO;
  const memoryPressure =
    processMemory.heapLimitBytes > 0 &&
    totalEstimatedMemoryBytes / processMemory.heapLimitBytes > DEFAULT_MEMORY_PRESSURE_RATIO;

  const guardTriggered = heapPressure || memoryPressure;

  const reduce = (original: number): number => {
    if (!guardTriggered || original <= 0) return original;
    const reduced = Math.floor(original / reductionFactor);
    const floor = Math.max(1, Math.floor(original * minimumFraction));
    return Math.max(reduced, floor);
  };

  const originalTerminalTaskLimit = runtimeLoadLimits.terminalTasks;
  const originalAuditEventLimit = runtimeLoadLimits.auditEvents;
  const originalOutboxLimit = runtimeLoadLimits.terminalOutboxEvents;

  const adaptiveTerminalTaskLimit = reduce(originalTerminalTaskLimit);
  const adaptiveAuditEventLimit = reduce(originalAuditEventLimit);
  const adaptiveOutboxLimit = reduce(originalOutboxLimit);

  const reasons: string[] = [];
  if (heapPressure) reasons.push(`heap at ${(heapUsedRatio * 100).toFixed(0)}% (threshold 80%)`);
  if (memoryPressure) reasons.push(`hot-table memory at ${((totalEstimatedMemoryBytes / processMemory.heapLimitBytes) * 100).toFixed(0)}% of heap (threshold 50%)`);

  return {
    originalTerminalTaskLimit,
    adaptiveTerminalTaskLimit,
    originalAuditEventLimit,
    adaptiveAuditEventLimit,
    originalOutboxLimit,
    adaptiveOutboxLimit,
    guardTriggered,
    guardReason: guardTriggered ? `Reduction factor ${reductionFactor}: ${reasons.join("; ")}` : null,
    reductionFactor,
  };
}

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

export function projectHotTableGrowth(
  options: HotTableGrowthProjectionOptions,
): HotTableGrowthProjection {
  const { current, prior, priorGeneratedAt, runtimeLoadLimits, generatedAt } = options;
  const t = { ...defaultThresholds(), ...options.thresholds };

  const hasPrior = prior !== undefined && prior !== null;
  const tables = Object.entries(current.tables).map(
    ([table, entry]): HotTableGrowthTableProjection => {
      const priorEntry = prior?.tables[table];
      const priorCount = priorEntry?.count ?? null;
      const growthDelta = priorCount !== null ? entry.count - priorCount : 0;
      const growthRate = priorCount !== null && priorCount > 0
        ? growthDelta / priorCount
        : null;
      const estimatedMemoryBytes = entry.count * entry.maxPayloadBytes;
      const runtimeLoad = entry.runtimeLoad;

      const severity = computeTableSeverity(table, entry.count, estimatedMemoryBytes, growthRate, runtimeLoad, t);
      const operatorAction = computeTableOperatorAction(table, entry.count, estimatedMemoryBytes, growthRate, runtimeLoad, severity, t);
      const summary = buildTableSummary(table, entry.count, estimatedMemoryBytes, growthDelta, growthRate, runtimeLoad);

      return {
        table,
        currentCount: entry.count,
        maxPayloadBytes: entry.maxPayloadBytes,
        estimatedMemoryBytes,
        runtimeLimit: runtimeLoad?.limit ?? null,
        runtimeLoaded: runtimeLoad?.loadedCount ?? entry.count,
        runtimeSkipped: runtimeLoad?.skippedCount ?? 0,
        priorCount,
        growthDelta,
        growthRate,
        severity,
        operatorAction: operatorAction.action,
        operatorActionReason: operatorAction.reason,
        summary,
      };
    },
  );

  const totalEstimatedMemoryBytes = tables.reduce(
    (sum, table) => sum + table.estimatedMemoryBytes,
    0,
  );

  const overallSeverity = computeOverallSeverity(tables, totalEstimatedMemoryBytes, t);
  const aggregateAction = computeAggregateOperatorAction(tables, totalEstimatedMemoryBytes, t);
  const maxWarnings = normalizeMaxWarnings(options.maxWarnings);
  const warnings = buildWarnings(tables, totalEstimatedMemoryBytes, hasPrior, t, maxWarnings);

  const processMemory = options.processMemory
    ? {
        rssBytes: options.processMemory.rssBytes,
        heapTotalBytes: options.processMemory.heapTotalBytes,
        heapUsedBytes: options.processMemory.heapUsedBytes,
        heapLimitBytes: options.processMemory.heapLimitBytes,
        heapUsedRatio:
          options.processMemory.heapLimitBytes > 0
            ? Math.round((options.processMemory.heapUsedBytes / options.processMemory.heapLimitBytes) * 1000) / 1000
            : 0,
      }
    : undefined;

  const snapshotMetrics = options.snapshotMetrics
    ? {
        lastSnapshotBytes: options.snapshotMetrics.lastSnapshotBytes ?? null,
        lastPersistDurationMs: options.snapshotMetrics.lastPersistDurationMs ?? null,
        lastSnapshotAt: options.snapshotMetrics.lastSnapshotAt ?? null,
      }
    : undefined;

  const readinessDegradation = processMemory
    ? computeReadinessDegradation(
        tables,
        totalEstimatedMemoryBytes,
        processMemory,
        runtimeLoadLimits ?? {
          terminalTasks: 0,
          auditEvents: 0,
          terminalOutboxEvents: 0,
        },
        options.heapBudgetGuard,
      )
    : undefined;

  return {
    kind: "broker.hot-table-growth.projection",
    generatedAt: generatedAt ?? new Date().toISOString(),
    hasPrior,
    priorGeneratedAt: priorGeneratedAt ?? null,
    totalEstimatedMemoryBytes,
    overallSeverity,
    operatorAction: aggregateAction.action,
    operatorActionReason: aggregateAction.reason,
    tables,
    runtimeLoadLimits: runtimeLoadLimits ?? {
      terminalTasks: 0,
      auditEvents: 0,
      terminalOutboxEvents: 0,
    },
    warnings,
    warningsTruncated: warnings.length < countWarnings(tables, totalEstimatedMemoryBytes, hasPrior, t),
    ...(processMemory !== undefined ? { processMemory } : {}),
    ...(snapshotMetrics !== undefined ? { snapshotMetrics } : {}),
    ...(readinessDegradation !== undefined ? { readinessDegradation } : {}),
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function defaultThresholds() {
  return {
    totalWarningRows: DEFAULT_HOT_TABLE_GROWTH_WARNING_ROWS,
    totalCriticalRows: DEFAULT_HOT_TABLE_GROWTH_CRITICAL_ROWS,
    singleTableWarningRows: DEFAULT_SINGLE_TABLE_WARNING_ROWS,
    singleTableCriticalRows: DEFAULT_SINGLE_TABLE_CRITICAL_ROWS,
    growthRateWarning: DEFAULT_GROWTH_RATE_WARNING,
    memoryWarningBytes: DEFAULT_MEMORY_WARNING_BYTES,
    memoryCriticalBytes: DEFAULT_MEMORY_CRITICAL_BYTES,
    skippedRatioWarning: DEFAULT_SKIPPED_RATIO_WARNING,
    skippedRatioCritical: DEFAULT_SKIPPED_RATIO_CRITICAL,
  };
}

function computeTableSeverity(
  table: string,
  count: number,
  estimatedMemoryBytes: number,
  growthRate: number | null,
  runtimeLoad: { limit: number; loadedCount: number; skippedCount: number } | undefined,
  t: ReturnType<typeof defaultThresholds>,
): HotTableGrowthSeverity {
  // Only check meaningful tables
  if (count === 0) return "ok";

  // Critical: single table rows exceed critical threshold
  if (table === "broker_tasks" && count >= t.singleTableCriticalRows) return "critical";

  // For broker_audit_events, count at the single-table critical threshold is
  // not sufficient for critical severity in steady state (self-pruning ring
  // buffer at the runtime cap). Require an actual pressure signal: memory
  // pressure, skipped hydration, unbounded growth, or count materially
  // exceeding the runtime cap. Falls through to the shared memory/skipped
  // critical checks below, then to warning checks.
  if (table === "broker_audit_events" && count >= t.singleTableCriticalRows) {
    // Count materially exceeding the runtime cap (20%+ over) → cap is not holding
    if (
      runtimeLoad?.limit
      && count > Math.floor(runtimeLoad.limit * (1 + DEFAULT_AUDIT_CAP_OVERSHOOT_CRITICAL_RATIO))
    ) {
      return "critical";
    }
    // Unbounded growth: high growth rate while at or above the critical threshold
    if (growthRate !== null && growthRate >= t.growthRateWarning) return "critical";
    // Fall through to memory/skipped critical checks below
  }

  // Critical: memory exceeds critical threshold
  if (estimatedMemoryBytes >= t.memoryCriticalBytes) return "critical";

  // Critical: large fraction of rows skipped from heap hydration
  if (runtimeLoad && runtimeLoad.skippedCount > 0) {
    const skippedRatio = runtimeLoad.skippedCount / (runtimeLoad.loadedCount + runtimeLoad.skippedCount);
    if (skippedRatio >= t.skippedRatioCritical) return "critical";
  }

  // Warning: single table rows exceed warning threshold.
  if (exceedsSingleTableWarningThreshold(table, count, runtimeLoad, t)) return "warning";

  // Warning: growth rate is high
  if (growthRate !== null && growthRate >= t.growthRateWarning) return "warning";

  // Warning: memory exceeds warning threshold
  if (estimatedMemoryBytes >= t.memoryWarningBytes) return "warning";

  // Warning: some rows skipped from heap
  if (runtimeLoad && runtimeLoad.skippedCount > 0) {
    const skippedRatio = runtimeLoad.skippedCount / (runtimeLoad.loadedCount + runtimeLoad.skippedCount);
    if (skippedRatio >= t.skippedRatioWarning) return "warning";
  }

  return "ok";
}

function exceedsSingleTableWarningThreshold(
  table: string,
  count: number,
  runtimeLoad: { limit: number; loadedCount: number; skippedCount: number } | undefined,
  t: ReturnType<typeof defaultThresholds>,
): boolean {
  if (count < t.singleTableWarningRows) return false;

  if (
    table === "broker_audit_events"
    && runtimeLoad
    && runtimeLoad.limit > 0
    && t.singleTableWarningRows === DEFAULT_SINGLE_TABLE_WARNING_ROWS
  ) {
    const runtimeCapWarningRows = Math.floor(runtimeLoad.limit * DEFAULT_AUDIT_RUNTIME_LIMIT_WARNING_RATIO);
    return count >= Math.max(t.singleTableWarningRows, runtimeCapWarningRows);
  }

  return true;
}

function computeTableOperatorAction(
  table: string,
  count: number,
  estimatedMemoryBytes: number,
  growthRate: number | null,
  runtimeLoad: { limit: number; loadedCount: number; skippedCount: number } | undefined,
  severity: HotTableGrowthSeverity,
  t: ReturnType<typeof defaultThresholds>,
): { action: HotTableOperatorAction; reason: string } {
  if (severity === "critical") {
    return { action: "approval_required", reason: "critical hot-table pressure requires an approved recovery plan before mutation" };
  }
  if (severity === "ok") {
    return { action: "observe", reason: "below hot-table warning thresholds" };
  }

  const skippedRows = runtimeLoad?.skippedCount ?? 0;
  if (skippedRows > 0) {
    return { action: "investigate", reason: "runtime hydration skipped rows; inspect retention and load caps" };
  }
  if (estimatedMemoryBytes >= t.memoryWarningBytes) {
    return { action: "investigate", reason: "table memory exceeds warning threshold; trend before changing caps or pruning" };
  }
  if (growthRate !== null && growthRate >= t.growthRateWarning) {
    return { action: "investigate", reason: "table growth rate exceeds warning threshold; confirm it is bounded" };
  }
  if (isAuditRuntimeCapObservation(table, count, estimatedMemoryBytes, growthRate, runtimeLoad, t)) {
    return { action: "observe", reason: "audit table is near runtime cap with no skipped rows or memory pressure; no prune action needed" };
  }

  return { action: "investigate", reason: "warning threshold crossed; inspect before any operator action" };
}

function computeOverallSeverity(
  tables: HotTableGrowthTableProjection[],
  totalMemory: number,
  t: ReturnType<typeof defaultThresholds>,
): HotTableGrowthSeverity {
  if (tables.some((table) => table.severity === "critical")) return "critical";
  if (totalMemory >= t.memoryCriticalBytes) return "critical";

  if (tables.some((table) => table.severity === "warning")) return "warning";
  if (totalMemory >= t.memoryWarningBytes) return "warning";

  return "ok";
}

function computeAggregateOperatorAction(
  tables: HotTableGrowthTableProjection[],
  totalMemory: number,
  t: ReturnType<typeof defaultThresholds>,
): { action: HotTableOperatorAction; reason: string } {
  if (tables.some((table) => table.operatorAction === "approval_required")) {
    return { action: "approval_required", reason: "one or more hot tables are critical; mutation/restart/prune needs explicit approval" };
  }
  if (tables.some((table) => table.operatorAction === "investigate")) {
    return { action: "investigate", reason: "one or more warning tables need follow-up before any mutation" };
  }
  if (totalMemory >= t.memoryCriticalBytes) {
    return { action: "approval_required", reason: "total hot-table memory exceeds critical threshold" };
  }
  if (totalMemory >= t.memoryWarningBytes) {
    return { action: "observe", reason: "total hot-table memory exceeds warning threshold, but no table has pressure signals; monitor trend" };
  }
  return { action: "observe", reason: "no hot-table operator action required" };
}

function buildTableSummary(
  table: string,
  count: number,
  memoryBytes: number,
  growthDelta: number,
  growthRate: number | null,
  runtimeLoad: { limit: number; loadedCount: number; skippedCount: number } | undefined,
): string {
  const parts: string[] = [];
  parts.push(`${table}: ${count} rows`);
  parts.push(`~${formatBytes(memoryBytes)} in-memory`);

  if (growthRate !== null && growthRate !== 0) {
    const direction = growthDelta > 0 ? "+" : "";
    const pct = (growthRate * 100).toFixed(1);
    parts.push(`${direction}${pct}% growth`);
  }

  if (runtimeLoad) {
    // Runtime cap context: at or near limit, not skipping rows → self-pruning
    // ring buffer in steady state. This is a retention-policy design signal
    // (the configured runtime cap is the operating limit), not necessarily a
    // cleanup-needed signal.
    if (runtimeLoad.limit > 0 && count >= runtimeLoad.limit && runtimeLoad.skippedCount === 0) {
      parts.push(`at runtime cap`);
    }

    // Skipped rows from heap hydration → hydrate/memory pressure
    if (runtimeLoad.skippedCount > 0) {
      const skippedRatio = (
        runtimeLoad.skippedCount /
        (runtimeLoad.loadedCount + runtimeLoad.skippedCount) * 100
      ).toFixed(0);
      parts.push(`${runtimeLoad.skippedCount} rows (${skippedRatio}%) skipped from heap`);
    }
  }

  return parts.join(", ");
}

function buildWarnings(
  tables: HotTableGrowthTableProjection[],
  totalMemory: number,
  hasPrior: boolean,
  t: ReturnType<typeof defaultThresholds>,
  maxWarnings = DEFAULT_MAX_WARNINGS,
): string[] {
  const warnings: string[] = [];

  for (const table of tables) {
    if (table.severity === "critical") {
      appendBounded(warnings, `CRITICAL: ${table.summary}`, maxWarnings);
    } else if (table.severity === "warning") {
      appendBounded(warnings, `WARNING: ${table.summary}`, maxWarnings);
    }
  }

  if (totalMemory >= t.memoryWarningBytes && warnings.length < maxWarnings) {
    warnings.push(
      `Total hot-table memory ~${formatBytes(totalMemory)} exceeds warning threshold ${formatBytes(t.memoryWarningBytes)}`,
    );
  }

  if (!hasPrior && warnings.length < maxWarnings) {
    warnings.push("No prior snapshot available; growth rate could not be computed. Run again after an interval for differential analysis.");
  }

  // Runtime-cap context: when a table is at its runtime limit without skipped
  // rows and without memory pressure, this is steady-state ring-buffer
  // operation, not a cleanup-needed condition. Guidance: adjust retention
  // policy (maxAuditEvents / BROKER_HOT_RUNTIME_MAX_AUDIT_EVENTS) or sampling
  // interval (BROKER_HEARTBEAT_AUDIT_SAMPLE_INTERVAL_MS) to shift the cap,
  // or run approved cleanup plan only when cleanup dry-run shows prune
  // candidates with actionability "advisory".
  const auditAtCap = tables.find(
    (table) =>
      table.table === "broker_audit_events" &&
      isAuditRuntimeCapObservation(
        table.table,
        table.currentCount,
        table.estimatedMemoryBytes,
        table.growthRate,
        table.runtimeLimit !== null
          ? { limit: table.runtimeLimit, loadedCount: table.runtimeLoaded, skippedCount: table.runtimeSkipped }
          : undefined,
        t,
      ) &&
      table.severity !== "critical",
  );
  if (auditAtCap && warnings.length < maxWarnings) {
    warnings.push(
      `broker_audit_events near runtime cap (${auditAtCap.currentCount}/${auditAtCap.runtimeLimit}), ` +
      `no rows skipped from heap, ~${formatBytes(auditAtCap.estimatedMemoryBytes)}. ` +
      `This is steady-state ring-buffer operation — no prune action needed. ` +
      `To reduce the cap: adjust BROKER_HOT_RUNTIME_MAX_AUDIT_EVENTS or audit retention policy.`,
    );
  }

  return warnings;
}

/**
 * Count the total number of warnings that would be emitted without truncation.
 */
function countWarnings(
  tables: HotTableGrowthTableProjection[],
  totalMemory: number,
  hasPrior: boolean,
  t: ReturnType<typeof defaultThresholds>,
): number {
  let count = 0;
  for (const table of tables) {
    if (table.severity === "critical" || table.severity === "warning") {
      count++;
    }
  }
  if (totalMemory >= t.memoryWarningBytes) count++;
  if (!hasPrior) count++;
  // Account for potential audit-at-cap context note
  const auditAtCap = tables.find(
    (table) =>
      table.table === "broker_audit_events" &&
      isAuditRuntimeCapObservation(
        table.table,
        table.currentCount,
        table.estimatedMemoryBytes,
        table.growthRate,
        table.runtimeLimit !== null
          ? { limit: table.runtimeLimit, loadedCount: table.runtimeLoaded, skippedCount: table.runtimeSkipped }
          : undefined,
        t,
      ) &&
      table.severity !== "critical",
  );
  if (auditAtCap) count++;
  return count;
}

function isAuditRuntimeCapObservation(
  table: string,
  count: number,
  estimatedMemoryBytes: number,
  growthRate: number | null,
  runtimeLoad: { limit: number; loadedCount: number; skippedCount: number } | undefined,
  t: ReturnType<typeof defaultThresholds>,
): boolean {
  if (table !== "broker_audit_events" || !runtimeLoad || runtimeLoad.limit <= 0) return false;
  const warningRows = Math.floor(runtimeLoad.limit * DEFAULT_AUDIT_RUNTIME_LIMIT_WARNING_RATIO);
  return count >= warningRows
    && runtimeLoad.skippedCount === 0
    && estimatedMemoryBytes < t.memoryWarningBytes
    && (growthRate === null || growthRate < t.growthRateWarning);
}

/** Push `item` onto `arr` if the array is shorter than `max`. */
function appendBounded<T>(arr: T[], item: T, max: number): void {
  if (arr.length < max) {
    arr.push(item);
  }
}

function normalizeMaxWarnings(value: number | undefined): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 1) {
    return Math.floor(value);
  }
  return DEFAULT_MAX_WARNINGS;
}

function computeReadinessDegradation(
  tables: HotTableGrowthTableProjection[],
  totalEstimatedMemoryBytes: number,
  processMemory: { heapUsedBytes: number; heapLimitBytes: number; heapUsedRatio: number },
  runtimeLoadLimits: BrokerHotTableRuntimeLoadLimits,
  heapBudgetGuard?: { reductionFactor?: number; minimumFraction?: number },
): {
  heapPressure: boolean;
  memoryPressure: boolean;
  hydrationPressure: boolean;
  overallRisky: boolean;
  overallWarning: boolean;
  adaptiveLoadLimits?: AdaptiveLoadLimits;
} {
  const heapPressure = processMemory.heapUsedRatio > DEFAULT_HEAP_PRESSURE_RATIO;
  const memoryPressure =
    processMemory.heapLimitBytes > 0 &&
    totalEstimatedMemoryBytes / processMemory.heapLimitBytes > DEFAULT_MEMORY_PRESSURE_RATIO;
  const hydrationPressure = tables.some((t) => t.severity === "critical" && t.runtimeSkipped > 0);
  const heapWarning = processMemory.heapUsedRatio > DEFAULT_HEAP_WARNING_RATIO;
  const memoryWarning =
    processMemory.heapLimitBytes > 0 &&
    totalEstimatedMemoryBytes / processMemory.heapLimitBytes > DEFAULT_MEMORY_PRESSURE_WARNING_RATIO;
  const hydrationWarning = tables.some(
    (t) => t.severity === "warning" && t.runtimeSkipped > 0,
  ) || hydrationPressure; // also include critical-level hydration

  const risky = heapPressure || memoryPressure || hydrationPressure;

  const adaptiveLoadLimits = computeAdaptiveLoadLimits(
    { heapUsedBytes: processMemory.heapUsedBytes, heapLimitBytes: processMemory.heapLimitBytes },
    totalEstimatedMemoryBytes,
    runtimeLoadLimits,
    heapBudgetGuard,
  );

  return {
    heapPressure,
    memoryPressure,
    hydrationPressure,
    overallRisky: risky,
    overallWarning:
      heapWarning || memoryWarning || hydrationWarning || risky,
    adaptiveLoadLimits: adaptiveLoadLimits.guardTriggered ? adaptiveLoadLimits : undefined,
  };
}

function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}
