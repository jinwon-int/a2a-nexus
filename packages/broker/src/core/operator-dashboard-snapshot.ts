import type { BrokerDashboard, TaskDiagnosticReport, TaskKind, TaskRecord, TaskStatus } from "./types.js";

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
}

export interface OperatorDashboardBrokerProjection {
  listTasks(): TaskRecord[];
  getTaskDiagnostics(id: string, options: { staleAfterMs: number; longRunningAfterMs?: number }): TaskDiagnosticReport;
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
}): OperatorDashboardSnapshot {
  const tasks = input.broker.listTasks();
  const byStatus = { ...input.dashboard.queue.byStatus } as Record<TaskStatus, number>;
  const terminalStatuses = new Set<TaskStatus>(["succeeded", "failed", "canceled"]);
  const activeStatuses = new Set<TaskStatus>(["blocked", "queued", "claimed", "running"]);
  const attentionItems: OperatorAttentionItem[] = [];

  for (const task of tasks) {
    const report = input.broker.getTaskDiagnostics(task.id, {
      staleAfterMs: input.staleAfterMs ?? Math.max(1, input.staleReaper.olderThanSec) * 1000,
      longRunningAfterMs: input.longRunningAfterMs,
    });
    const statusAgeSec = Math.floor(report.currentStatusDurationMs / 1000);
    const whoClaimed = task.claimedBy ?? task.assignedWorkerId ?? null;
    const base = {
      taskId: task.id,
      status: task.status,
      intent: task.intent,
      targetNodeId: task.targetNodeId,
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
  };
}
