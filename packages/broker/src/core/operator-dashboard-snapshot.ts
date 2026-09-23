import { TERMINAL_TASK_STATUSES, type BrokerDashboard, type TaskDiagnosticReport, type TaskKind, type TaskLaneDecision, type TaskLaneReasonCode, type TaskRecord, type TaskStatus } from "./types.js";

/**
 * Precomputed diagnostics shared between the dashboard snapshot and the alert
 * scan (#2078 A): one full task/tombstone/audit pass per operator snapshot,
 * stamped with the staleAfterMs the reports were classified with so a consumer
 * needing different thresholds can re-classify locally instead of re-running
 * the pass.
 */
export interface SharedTaskDiagnostics {
  reports: TaskDiagnosticReport[];
  staleAfterMs: number;
  longRunningAfterMs?: number;
}

/** Bound for OperatorLaneSummary.recentRejudgments; newest entries win. */
const MAX_RECENT_LANE_REJUDGMENTS = 10;

export interface OperatorTaskStatusSummary {
  total: number;
  active: number;
  terminal: number;
  byStatus: Record<TaskStatus, number>;
}

export interface OperatorAttentionItem {
  code: "stale_worker" | "stale_task" | "long_running" | "dead_lettered" | "requeued";
  severity: "info" | "warn" | "critical";
  taskId: string;
  status: TaskStatus;
  intent: TaskKind;
  targetNodeId: string;
  /** Create-time shadow lane decision when the record has one (fast-lane v1). */
  laneDecision?: TaskLaneDecision;
  /** Operator re-judged lane when present; observational, never a lifecycle input. */
  laneRejudgedTo?: TaskLaneDecision;
  assignedWorkerId?: string;
  claimedBy?: string;
  requeueCount: number;
  statusAgeSec: number;
  whyStuck: string;
  whoClaimed: string | null;
  whatNext: string;
  lastHeartbeatAt?: string;
  completedAt?: string;
  errorCode?: string;
  errorMessage?: string;
}

/** One operator lane re-judgment (#1601) surfaced for operator review. */
export interface OperatorRecentLaneRejudgment {
  taskId: string;
  status: TaskStatus;
  at: string;
  actorId: string;
  from: TaskLaneDecision;
  to: TaskLaneDecision;
  reasonCode: TaskLaneReasonCode;
  note?: string;
}

/**
 * #1601/#2208 fast-lane visibility for operators: counts over the create-time
 * shadow lane assignments plus the operator re-judgments. Read-only projection
 * only — `laneAssignment` stays immutable and a re-judgment never changes
 * lifecycle, scheduling, or execution behavior.
 */
export interface OperatorLaneSummary {
  /** Tasks carrying a create-time shadow assignment (records created before fast-lane v1 have none). */
  assigned: number;
  byDecision: { fast: number; full: number };
  /** Tasks with an operator re-judgment (v1 corrects fast -> full only). */
  rejudged: number;
  /** Newest-first re-judgment entries, bounded by MAX_RECENT_LANE_REJUDGMENTS. */
  recentRejudgments: OperatorRecentLaneRejudgment[];
}

export interface OperatorDashboardSnapshot {
  generatedAt: string;
  workers: BrokerDashboard["workers"];
  taskStatusSummary: OperatorTaskStatusSummary;
  recoverySummary: {
    stale: {
      staleWorkerAssignments: number;
      staleWorkersWithActiveTasks: BrokerDashboard["observability"]["workerHealth"]["staleWorkersWithActiveTasks"];
      oldestClaimed?: BrokerDashboard["observability"]["queuePressure"]["oldestClaimed"];
      oldestRunning?: BrokerDashboard["observability"]["queuePressure"]["oldestRunning"];
    };
    retry: {
      totalRequeued: number;
      maxRequeueAttempts: number;
      recentRequeues: BrokerDashboard["observability"]["recovery"]["recentRequeues"];
    };
    deadLetter: {
      totalDeadLettered: number;
      recentDeadLetters: BrokerDashboard["observability"]["recovery"]["recentDeadLetters"];
    };
  };
  attentionItems: OperatorAttentionItem[];
  laneSummary: OperatorLaneSummary;
}

export interface OperatorDashboardBrokerProjection {
  listTasks(): TaskRecord[];
  getTaskDiagnostics(id: string, options: { staleAfterMs: number; longRunningAfterMs?: number }): TaskDiagnosticReport;
  /** Optional batched variant; when present the snapshot builds every report in one pass. */
  listTaskDiagnostics?(options: { staleAfterMs: number; longRunningAfterMs?: number }): TaskDiagnosticReport[];
}

export interface OperatorDashboardStaleReaperProjection {
  olderThanSec: number;
  maxRequeueAttempts: number;
}

export function buildOperatorDashboardSnapshot(input: {
  broker: OperatorDashboardBrokerProjection;
  dashboard: BrokerDashboard;
  staleReaper: OperatorDashboardStaleReaperProjection;
  staleAfterMs?: number;
  longRunningAfterMs?: number;
  /**
   * Precomputed reports (#2078 A). Must have been classified with the same
   * thresholds this snapshot derives; when absent the pass runs here as before.
   */
  taskDiagnostics?: SharedTaskDiagnostics;
}): OperatorDashboardSnapshot {
  const tasks = input.broker.listTasks();
  const byStatus = { ...input.dashboard.queue.byStatus } as Record<TaskStatus, number>;
  const terminalStatuses: ReadonlySet<TaskStatus> = new Set<TaskStatus>(TERMINAL_TASK_STATUSES);
  const activeStatuses = new Set<TaskStatus>(["blocked", "queued", "claimed", "running"]);
  const attentionItems: OperatorAttentionItem[] = [];
  const diagnosticsOptions = {
    staleAfterMs: input.staleAfterMs ?? Math.max(1, input.staleReaper.olderThanSec) * 1000,
    longRunningAfterMs: input.longRunningAfterMs,
  };
  const sharedReports = input.taskDiagnostics
    && input.taskDiagnostics.staleAfterMs === diagnosticsOptions.staleAfterMs
    && input.taskDiagnostics.longRunningAfterMs === diagnosticsOptions.longRunningAfterMs
    ? input.taskDiagnostics.reports
    : undefined;
  const reportsByTaskId = sharedReports
    ? new Map(sharedReports.map((report) => [report.taskId, report]))
    : input.broker.listTaskDiagnostics
      ? new Map(input.broker.listTaskDiagnostics(diagnosticsOptions).map((report) => [report.taskId, report]))
      : undefined;

  for (const task of tasks) {
    const report = reportsByTaskId?.get(task.id)
      ?? input.broker.getTaskDiagnostics(task.id, diagnosticsOptions);
    const statusAgeSec = Math.floor(report.currentStatusDurationMs / 1000);
    const whoClaimed = task.claimedBy ?? task.assignedWorkerId ?? null;
    const base = {
      taskId: task.id,
      status: task.status,
      intent: task.intent,
      targetNodeId: task.targetNodeId,
      laneDecision: task.laneAssignment?.decision,
      laneRejudgedTo: task.laneRejudgment?.to,
      assignedWorkerId: task.assignedWorkerId,
      claimedBy: task.claimedBy,
      requeueCount: task.requeueCount ?? 0,
      statusAgeSec,
      whoClaimed,
      lastHeartbeatAt: task.lastHeartbeatAt,
    };

    if (task.status === "failed" && task.error?.code === "exceeded_requeue_limit") {
      attentionItems.push({
        ...base,
        code: "dead_lettered",
        severity: "critical",
        whyStuck: `task exceeded the stale requeue limit (${task.requeueCount ?? 0}/${input.staleReaper.maxRequeueAttempts})`,
        whatNext: "inspect the failed attempt evidence, fix or replace the worker, then create/reassign follow-up work",
        completedAt: task.completedAt,
        errorCode: task.error.code,
        errorMessage: task.error.message,
      });
      continue;
    }

    if (report.brokerHints.staleWorker && (task.status === "claimed" || task.status === "running")) {
      attentionItems.push({
        ...base,
        code: "stale_worker",
        severity: "critical",
        whyStuck: `${whoClaimed ?? task.targetNodeId} claimed/owns the task but its worker heartbeat is stale`,
        whatNext: "check the worker process; if it is not recovering, requeue stale tasks or reassign to a healthy worker",
      });
      continue;
    }

    if (report.diagnosticStatus === "stale") {
      attentionItems.push({
        ...base,
        code: "stale_task",
        severity: "warn",
        whyStuck: report.interruption?.summary ?? `task has had no fresh heartbeat for ${statusAgeSec}s`,
        whatNext: "ask the claimant for progress; if no evidence arrives, run stale requeue or reassign",
      });
      continue;
    }

    if (report.diagnosticStatus === "long_running") {
      attentionItems.push({
        ...base,
        code: "long_running",
        severity: "warn",
        whyStuck: `running longer than the configured operator threshold (${statusAgeSec}s)`,
        whatNext: "request progress evidence or split/cancel the task if it cannot finish promptly",
      });
      continue;
    }

    if ((task.requeueCount ?? 0) > 0 && (task.status === "queued" || task.status === "claimed" || task.status === "running")) {
      attentionItems.push({
        ...base,
        code: "requeued",
        severity: "info",
        whyStuck: `task has already been requeued ${task.requeueCount} time(s) after stale execution attempts`,
        whatNext: "prefer a healthy worker and watch for another stale attempt before the dead-letter cap",
      });
    }
  }

  // #1601/#2208 lane visibility: counted from the same listTasks pass — no
  // extra broker reads. Re-judgments are surfaced newest-first for review.
  const byLaneDecision: OperatorLaneSummary["byDecision"] = { fast: 0, full: 0 };
  let laneAssigned = 0;
  let laneRejudged = 0;
  const recentRejudgments: OperatorRecentLaneRejudgment[] = [];
  for (const task of tasks) {
    if (task.laneAssignment) {
      laneAssigned += 1;
      const decision = task.laneAssignment.decision;
      if (decision === "fast" || decision === "full") {
        byLaneDecision[decision] += 1;
      }
    }
    const rejudgment = task.laneRejudgment;
    if (rejudgment) {
      laneRejudged += 1;
      recentRejudgments.push({
        taskId: task.id,
        status: task.status,
        at: rejudgment.at,
        actorId: rejudgment.actorId,
        from: rejudgment.from,
        to: rejudgment.to,
        reasonCode: rejudgment.reasonCode,
        ...(rejudgment.note === undefined ? {} : { note: rejudgment.note }),
      });
    }
  }
  recentRejudgments.sort((left, right) => right.at.localeCompare(left.at) || left.taskId.localeCompare(right.taskId));
  recentRejudgments.length = Math.min(recentRejudgments.length, MAX_RECENT_LANE_REJUDGMENTS);

  attentionItems.sort((left, right) => {
    const severityRank = { critical: 0, warn: 1, info: 2 } as const;
    const severityCmp = severityRank[left.severity] - severityRank[right.severity];
    if (severityCmp !== 0) return severityCmp;
    const ageCmp = right.statusAgeSec - left.statusAgeSec;
    if (ageCmp !== 0) return ageCmp;
    return left.taskId.localeCompare(right.taskId);
  });

  return {
    generatedAt: input.dashboard.generatedAt,
    workers: input.dashboard.workers,
    taskStatusSummary: {
      total: tasks.length,
      active: tasks.filter((task) => activeStatuses.has(task.status)).length,
      terminal: tasks.filter((task) => terminalStatuses.has(task.status)).length,
      byStatus,
    },
    recoverySummary: {
      stale: {
        staleWorkerAssignments: input.dashboard.observability.queuePressure.staleWorkerAssignments,
        staleWorkersWithActiveTasks: input.dashboard.observability.workerHealth.staleWorkersWithActiveTasks,
        oldestClaimed: input.dashboard.observability.queuePressure.oldestClaimed,
        oldestRunning: input.dashboard.observability.queuePressure.oldestRunning,
      },
      retry: {
        totalRequeued: input.dashboard.observability.recovery.totalRequeued,
        maxRequeueAttempts: input.staleReaper.maxRequeueAttempts,
        recentRequeues: input.dashboard.observability.recovery.recentRequeues,
      },
      deadLetter: {
        totalDeadLettered: input.dashboard.observability.recovery.totalDeadLettered,
        recentDeadLetters: input.dashboard.observability.recovery.recentDeadLetters,
      },
    },
    attentionItems,
    laneSummary: {
      assigned: laneAssigned,
      byDecision: byLaneDecision,
      rejudged: laneRejudged,
      recentRejudgments,
    },
  };
}
