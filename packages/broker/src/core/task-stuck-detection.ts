/**
 * Stuck task detection for the scheduler/control-tower.
 *
 * Detects tasks that are stuck in non-terminal phases (queued, claimed,
 * running) beyond configurable time thresholds. Produces operator-visible
 * blocker signals for each phase and computes retry cap enforcement.
 *
 * Pure functions: read-only analysis of task records. No mutation.
 *
 * Reference: a2a-plane#434 / a2a-broker#907 lane 3/4 (workeralpha).
 */

import {
  type BackoffConfig,
  type BackoffSchedule,
  buildBackoffSchedule,
} from "./execution-backoff.js";
import type { TaskError, TaskRecord, TaskStatus } from "./types.js";

// ---------------------------------------------------------------------------
// Phase stale thresholds
// ---------------------------------------------------------------------------

/**
 * Time thresholds (in ms) for each non-terminal phase.
 * A task is "stale" when it has been in that status longer than the threshold.
 */
export interface StalePhaseThresholds {
  /** Max time a task can stay in "queued" before being considered stale. */
  queuedStaleAfterMs: number;
  /** Max time a task can stay in "claimed" before being considered stale. */
  claimedStaleAfterMs: number;
  /** Max time a task can stay in "running" before being considered stale. */
  runningStaleAfterMs: number;
}

export const DEFAULT_STALE_PHASE_THRESHOLDS: StalePhaseThresholds = {
  queuedStaleAfterMs: 300_000, // 5 min
  claimedStaleAfterMs: 120_000, // 2 min
  runningStaleAfterMs: 600_000, // 10 min
};

/**
 * Per-phase retry caps.
 * Controls how many times a task can be recycled through each phase
 * before it reaches a dead-letter / operator-blocker state.
 */
export interface PhaseRetryCaps {
  /** Max retries from "queued" back to "queued" (requeues before phase escalation). */
  maxQueuedRetries: number;
  /** Max retries from "claimed" back to "claimed" or "queued". */
  maxClaimedRetries: number;
  /** Max retries from "running" back to "queued/running". */
  maxRunningRetries: number;
}

export const DEFAULT_PHASE_RETRY_CAPS: PhaseRetryCaps = {
  maxQueuedRetries: 3,
  maxClaimedRetries: 3,
  maxRunningRetries: 3,
};

export const DEFAULT_REPEATED_ERROR_THRESHOLD = 2;

/**
 * Combined stale detection and retry policy configuration for the
 * scheduler/control-tower lane.
 */
export interface SchedulerControlTowerConfig {
  /** Label for the lane (e.g. "workeralpha-lane-3"). */
  laneLabel: string;
  /** Time thresholds for stale detection per phase. */
  staleThresholds: StalePhaseThresholds;
  /** Per-phase retry caps. */
  retryCaps: PhaseRetryCaps;
  /** Optional backoff config override for retry scheduling. */
  backoffConfig?: BackoffConfig;
  /** Consecutive identical normalized error signatures needed for early-stop. */
  repeatedErrorThreshold: number;
}

export const DEFAULT_SCHEDULER_CONTROL_TOWER_CONFIG: SchedulerControlTowerConfig =
  {
    laneLabel: "default",
    staleThresholds: { ...DEFAULT_STALE_PHASE_THRESHOLDS },
    retryCaps: { ...DEFAULT_PHASE_RETRY_CAPS },
    repeatedErrorThreshold: DEFAULT_REPEATED_ERROR_THRESHOLD,
  };

// ---------------------------------------------------------------------------
// Stuck task diagnostics
// ---------------------------------------------------------------------------

export type StuckPhase = "queued" | "claimed" | "running";

export type StuckVerdict =
  | "stale"
  | "repeated_error_early_stop"
  | "retry_cap_exceeded"
  | "fresh"; // not stale, within threshold

/**
 * Per-task stuck diagnosis result.
 */
export interface StuckTaskDiagnosis {
  /** Task id. */
  taskId: string;
  /** Current status of the task. */
  currentStatus: TaskStatus;
  /** The phase in which the task is stuck (only for non-terminal phases). */
  stuckPhase?: StuckPhase;
  /** Verdict based on phase thresholds and retry caps. */
  verdict: StuckVerdict;
  /** Age of the task in its current status (ms). */
  ageMs: number;
  /** Threshold that was applied (ms). */
  thresholdMs: number;
  /** How many times the task has been requeued in this phase. */
  phaseRequeueCount: number;
  /** Max allowed retries for this phase. */
  maxPhaseRetries: number;
  /** Normalized repeated error signature when verdict is repeated_error_early_stop. */
  errorSignature?: string;
  /** Number of trailing errors considered for repeated-error detection. */
  repeatedErrorCount?: number;
}

// ---------------------------------------------------------------------------
// Operator-visible blocker
// ---------------------------------------------------------------------------

export type BlockerSeverity = "info" | "warning" | "critical";

export interface OperatorBlocker {
  /** Stable identifier for this blocker. */
  id: string;
  /** Human-readable title. */
  title: string;
  /** Detailed description. */
  description: string;
  /** Severity level. */
  severity: BlockerSeverity;
  /** Affected task ids (capped at 20 to keep messages bounded). */
  affectedTaskIds: string[];
  /** Affected phase. */
  phase?: StuckPhase;
  /** Total count of affected tasks (may exceed affectedTaskIds.length). */
  totalAffected: number;
  /** ISO timestamp when the blocker was generated. */
  generatedAt: string;
  /** Suggested operator action. */
  recommendedAction: string;
}

// ---------------------------------------------------------------------------
// Aggregate stuck task report
// ---------------------------------------------------------------------------

export interface StuckTaskReport {
  kind: "a2a-broker.scheduler.stuck-task-report.v1";
  generatedAt: string;
  /** Lane label for traceability. */
  laneLabel: string;
  /** Config snapshot used for this report. */
  config: {
    staleThresholds: StalePhaseThresholds;
    retryCaps: PhaseRetryCaps;
    repeatedErrorThreshold: number;
  };
  /** Total non-terminal tasks analyzed. */
  totalActiveTasks: number;
  /** Per-phase breakdown of stale tasks. */
  staleByPhase: {
    queued: number;
    claimed: number;
    running: number;
  };
  /** Tasks that have exceeded retry caps. */
  capExceededByPhase: {
    queued: number;
    claimed: number;
    running: number;
  };
  /** Tasks whose trailing error signatures repeated enough to early-stop. */
  repeatedErrorByPhase: {
    queued: number;
    claimed: number;
    running: number;
  };
  /** Detailed per-task diagnoses (capped at 50 entries). */
  diagnoses: StuckTaskDiagnosis[];
  /** Operator-visible blockers generated from this report. */
  blockers: OperatorBlocker[];
  /** Overall assessment. */
  severity: "ok" | "warning" | "critical";
  /** Retry backoff schedule if computed. */
  backoffSchedule?: BackoffSchedule;
}

// ---------------------------------------------------------------------------
// Detection functions
// ---------------------------------------------------------------------------

/**
 * Determine the stuck phase for a given task status.
 */
export function getStuckPhase(status: TaskStatus): StuckPhase | undefined {
  if (status === "queued") return "queued";
  if (status === "claimed") return "claimed";
  if (status === "running") return "running";
  return undefined;
}

/**
 * Get the stale threshold for a given phase.
 */
export function getStaleThresholdMs(
  phase: StuckPhase,
  thresholds: StalePhaseThresholds,
): number {
  switch (phase) {
    case "queued":
      return thresholds.queuedStaleAfterMs;
    case "claimed":
      return thresholds.claimedStaleAfterMs;
    case "running":
      return thresholds.runningStaleAfterMs;
  }
}

/**
 * Get the retry cap for a given phase.
 */
export function getPhaseRetryCap(
  phase: StuckPhase,
  caps: PhaseRetryCaps,
): number {
  switch (phase) {
    case "queued":
      return caps.maxQueuedRetries;
    case "claimed":
      return caps.maxClaimedRetries;
    case "running":
      return caps.maxRunningRetries;
  }
}

/**
 * Determine the age of a task in its current status.
 * Uses `updatedAt` as the last status-transition timestamp.
 * Falls back to `createdAt` if updatedAt is not reliable.
 */
export function computeTaskPhaseAge(
  task: TaskRecord,
  nowMs: number,
): number {
  // Prefer updatedAt as the closest proxy for last status change.
  // For terminal tasks or unknown timestamps, fall back to createdAt.
  const updated = Date.parse(task.updatedAt);
  if (Number.isFinite(updated)) return nowMs - updated;

  const created = Date.parse(task.createdAt);
  if (Number.isFinite(created)) return nowMs - created;

  return 0;
}


export type RepeatedErrorDiagnosticOptions = {
  repeatedErrorThreshold?: number;
};

export function normalizeErrorSignature(error: TaskError | string | null | undefined): string {
  if (error == null) return "";
  const code = typeof error === "object" && typeof error.code === "string" ? error.code : "";
  const message = typeof error === "string" ? error : (typeof error.message === "string" ? error.message : "");
  const raw = `${code} ${message}`.trim();
  if (!raw) return "";
  return raw
    .toLowerCase()
    .replace(/\b\d{4}-\d{2}-\d{2}t\d{2}:\d{2}:\d{2}(?:\.\d+)?z\b/g, "<iso-ts>")
    .replace(/\b\d{13}\b/g, "<epoch-ms>")
    .replace(/\/tmp\/\S+/g, "<tmp-path>")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, "<uuid>")
    .replace(/\b[0-9a-f]{12,}\b/g, "<hex>")
    .replace(/\bpid\s*=\s*\d+\b/g, "pid=<pid>")
    .replace(/\b\d+(?:\.\d+)?\s*ms\b/g, "<duration-ms>")
    .replace(/\b\d+(?:\.\d+)?\s*s\b/g, "<duration-s>")
    .replace(/\s+/g, " ")
    .trim();
}

export function hasRepeatedErrorSignature(history: TaskError[], threshold: number): boolean {
  const needed = Math.max(1, Math.floor(threshold));
  if (history.length < needed) return false;
  const signatures = history.slice(-needed).map(normalizeErrorSignature).filter(Boolean);
  if (signatures.length < needed) return false;
  return signatures.every((signature) => signature === signatures[0]);
}

function repeatedErrorSignature(task: TaskRecord, threshold: number): { signature?: string; count: number } {
  const history = [...(task.errorHistory ?? [])];
  if (task.error) history.push(task.error);
  const needed = Math.max(1, Math.floor(threshold));
  if (!hasRepeatedErrorSignature(history, needed)) return { count: 0 };
  return { signature: normalizeErrorSignature(history[history.length - 1]), count: needed };
}


/**
 * Diagnose a single task for stuck status.
 *
 * Returns a diagnosis only when the task is in a non-terminal phase
 * that has a stale threshold (queued, claimed, running). Terminal
 * and blocked tasks are returned as "fresh" with no stuckPhase.
 */
export function diagnoseTask(
  task: TaskRecord,
  thresholds: StalePhaseThresholds,
  retryCaps: PhaseRetryCaps,
  nowMs: number,
  options?: RepeatedErrorDiagnosticOptions,
): StuckTaskDiagnosis {
  const phase = getStuckPhase(task.status);
  if (!phase) {
    return {
      taskId: task.id,
      currentStatus: task.status,
      verdict: "fresh",
      ageMs: computeTaskPhaseAge(task, nowMs),
      thresholdMs: 0,
      phaseRequeueCount: task.requeueCount ?? 0,
      maxPhaseRetries: 0,
      repeatedErrorCount: 0,
    };
  }

  const ageMs = computeTaskPhaseAge(task, nowMs);
  const thresholdMs = getStaleThresholdMs(phase, thresholds);
  const maxPhaseRetries = getPhaseRetryCap(phase, retryCaps);
  const requeueCount = task.requeueCount ?? 0;

  // Check retry cap first (cap exceeded is a stronger signal)
  if (requeueCount >= maxPhaseRetries) {
    return {
      taskId: task.id,
      currentStatus: task.status,
      stuckPhase: phase,
      verdict: "retry_cap_exceeded",
      ageMs,
      thresholdMs,
      phaseRequeueCount: requeueCount,
      maxPhaseRetries,
      repeatedErrorCount: 0,
    };
  }

  const repeated = repeatedErrorSignature(
    task,
    options?.repeatedErrorThreshold ?? DEFAULT_REPEATED_ERROR_THRESHOLD,
  );
  if (repeated.signature) {
    return {
      taskId: task.id,
      currentStatus: task.status,
      stuckPhase: phase,
      verdict: "repeated_error_early_stop",
      ageMs,
      thresholdMs,
      phaseRequeueCount: requeueCount,
      maxPhaseRetries,
      errorSignature: repeated.signature,
      repeatedErrorCount: repeated.count,
    };
  }

  // Check stale threshold
  if (ageMs >= thresholdMs) {
    return {
      taskId: task.id,
      currentStatus: task.status,
      stuckPhase: phase,
      verdict: "stale",
      ageMs,
      thresholdMs,
      phaseRequeueCount: requeueCount,
      maxPhaseRetries,
      repeatedErrorCount: 0,
    };
  }

  return {
    taskId: task.id,
    currentStatus: task.status,
    stuckPhase: phase,
    verdict: "fresh",
    ageMs,
    thresholdMs,
    phaseRequeueCount: requeueCount,
    maxPhaseRetries,
    repeatedErrorCount: 0,
  };
}

/**
 * Run stuck task detection across a set of task records.
 * Pure function — no mutation, no side effects.
 */
export function detectStuckTasks(
  tasks: TaskRecord[],
  config?: Partial<SchedulerControlTowerConfig>,
  nowMs?: number,
): StuckTaskReport {
  const mergedConfig: SchedulerControlTowerConfig = {
    ...DEFAULT_SCHEDULER_CONTROL_TOWER_CONFIG,
    ...config,
    staleThresholds: {
      ...DEFAULT_STALE_PHASE_THRESHOLDS,
      ...config?.staleThresholds,
    },
    retryCaps: {
      ...DEFAULT_PHASE_RETRY_CAPS,
      ...config?.retryCaps,
    },
    repeatedErrorThreshold: config?.repeatedErrorThreshold ?? DEFAULT_REPEATED_ERROR_THRESHOLD,
  };

  const timeNow = nowMs ?? Date.now();
  const generatedAt = new Date(timeNow).toISOString();

  // Diagnose each non-terminal task
  const diagnoses: StuckTaskDiagnosis[] = [];
  const staleByPhase: StuckTaskReport["staleByPhase"] = {
    queued: 0,
    claimed: 0,
    running: 0,
  };
  const capExceededByPhase: StuckTaskReport["capExceededByPhase"] = {
    queued: 0,
    claimed: 0,
    running: 0,
  };
  const repeatedErrorByPhase: StuckTaskReport["repeatedErrorByPhase"] = {
    queued: 0,
    claimed: 0,
    running: 0,
  };

  const nonTerminalStatuses = new Set<TaskStatus>([
    "queued",
    "claimed",
    "running",
    "blocked",
  ]);

  for (const task of tasks) {
    if (!nonTerminalStatuses.has(task.status)) continue;

    const diagnosis = diagnoseTask(
      task,
      mergedConfig.staleThresholds,
      mergedConfig.retryCaps,
      timeNow,
      { repeatedErrorThreshold: mergedConfig.repeatedErrorThreshold },
    );

    // Collect diagnoses (cap at 50)
    if (diagnoses.length < 50) {
      diagnoses.push(diagnosis);
    }

    // Aggregate counts
    if (diagnosis.verdict === "retry_cap_exceeded" && diagnosis.stuckPhase) {
      capExceededByPhase[diagnosis.stuckPhase]++;
    } else if (diagnosis.verdict === "repeated_error_early_stop" && diagnosis.stuckPhase) {
      repeatedErrorByPhase[diagnosis.stuckPhase]++;
    } else if (diagnosis.verdict === "stale" && diagnosis.stuckPhase) {
      staleByPhase[diagnosis.stuckPhase]++;
    }
  }

  // Build operator blockers
  const blockers = buildOperatorBlockers(
    diagnoses,
    mergedConfig.staleThresholds,
    mergedConfig.retryCaps,
    generatedAt,
  );

  // Compute overall severity
  const severity = computeReportSeverity(blockers);

  // Compute backoff schedule from max retry caps (queued as representative)
  const maxAttempts = Math.max(
    mergedConfig.retryCaps.maxQueuedRetries,
    mergedConfig.retryCaps.maxClaimedRetries,
    mergedConfig.retryCaps.maxRunningRetries,
    1,
  );
  const backoffSchedule = buildBackoffSchedule(
    maxAttempts,
    config?.backoffConfig,
  );

  return {
    kind: "a2a-broker.scheduler.stuck-task-report.v1",
    generatedAt,
    laneLabel: mergedConfig.laneLabel,
    config: {
      staleThresholds: { ...mergedConfig.staleThresholds },
      retryCaps: { ...mergedConfig.retryCaps },
      repeatedErrorThreshold: mergedConfig.repeatedErrorThreshold,
    },
    totalActiveTasks: tasks.filter((t) =>
      nonTerminalStatuses.has(t.status),
    ).length,
    staleByPhase,
    capExceededByPhase,
    repeatedErrorByPhase,
    diagnoses,
    blockers,
    severity,
    backoffSchedule,
  };
}

// ---------------------------------------------------------------------------
// Operator blocker construction
// ---------------------------------------------------------------------------

/**
 * Build operator-visible blockers from a set of task diagnoses.
 */
export function buildOperatorBlockers(
  diagnoses: StuckTaskDiagnosis[],
  thresholds: StalePhaseThresholds,
  caps: PhaseRetryCaps,
  generatedAt: string,
): OperatorBlocker[] {
  const blockers: OperatorBlocker[] = [];
  const phases: StuckPhase[] = ["queued", "claimed", "running"];

  for (const phase of phases) {
    const staleTasks = diagnoses.filter(
      (d) => d.stuckPhase === phase && d.verdict === "stale",
    );
    const capExceededTasks = diagnoses.filter(
      (d) => d.stuckPhase === phase && d.verdict === "retry_cap_exceeded",
    );
    const repeatedErrorTasks = diagnoses.filter(
      (d) => d.stuckPhase === phase && d.verdict === "repeated_error_early_stop",
    );

    if (staleTasks.length > 0) {
      const maxAgeMs = Math.max(...staleTasks.map((d) => d.ageMs));
      const thresholdMs = getStaleThresholdMs(phase, thresholds);
      blockers.push({
        id: `stale-${phase}-${generatedAt}`,
        title: `Stale ${phase} tasks detected`,
        description:
          `${staleTasks.length} task(s) have been in "${phase}" status ` +
          `for ≥${Math.round(thresholdMs / 1000)}s ` +
          `(oldest: ${Math.round(maxAgeMs / 1000)}s).`,
        severity: "warning",
        affectedTaskIds: staleTasks
          .slice(0, 20)
          .map((d) => d.taskId),
        phase,
        totalAffected: staleTasks.length,
        generatedAt,
        recommendedAction:
          `Review ${phase} tasks and consider manual requeue or cancellation. ` +
          `If the worker is unavailable, mark tasks for reassignment.`,
      });
    }

    if (capExceededTasks.length > 0) {
      const cap = getPhaseRetryCap(phase, caps);
      blockers.push({
        id: `cap-exceeded-${phase}-${generatedAt}`,
        title: `Retry cap exceeded for ${phase} tasks`,
        description:
          `${capExceededTasks.length} task(s) have exceeded the ` +
          `maximum ${cap} retries for "${phase}" phase. ` +
          `Further automatic retries are blocked.`,
        severity: "critical",
        affectedTaskIds: capExceededTasks
          .slice(0, 20)
          .map((d) => d.taskId),
        phase,
        totalAffected: capExceededTasks.length,
        generatedAt,
        recommendedAction:
          `Operator intervention required: manually triage ` +
          `${capExceededTasks.length} task(s) that exceeded the ` +
          `${phase} retry cap. Options: cancel, reassign, or mark ` +
          `as dead-lettered.`,
      });
    }

    if (repeatedErrorTasks.length > 0) {
      blockers.push({
        id: `repeated-error-${phase}-${generatedAt}`,
        title: `Repeated error early-stop for ${phase} tasks`,
        description:
          `${repeatedErrorTasks.length} task(s) have repeated the same ` +
          `normalized error signature in "${phase}" phase. Automatic retry ` +
          `should stop until the unresolved failure is triaged.`,
        severity: "critical",
        affectedTaskIds: repeatedErrorTasks.slice(0, 20).map((d) => d.taskId),
        phase,
        totalAffected: repeatedErrorTasks.length,
        generatedAt,
        recommendedAction:
          `Operator intervention required: inspect the repeated error signature, ` +
          `fix the underlying worker/tool/config issue, then requeue or cancel the task explicitly.`,
      });
    }
  }

  return blockers;
}

/**
 * Compute overall report severity from blockers.
 */
export function computeReportSeverity(
  blockers: OperatorBlocker[],
): "ok" | "warning" | "critical" {
  if (blockers.some((b) => b.severity === "critical")) return "critical";
  if (blockers.some((b) => b.severity === "warning")) return "warning";
  return "ok";
}
