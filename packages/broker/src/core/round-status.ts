// Round-status aggregation (#629). A pure summary over the tasks that share a
// parentRoundId, so operators can see completion progress for an A2A/A2AD round
// without a bespoke projection. Keyed on the top-level task.parentRoundId, which
// normalizeTaskRecord guarantees is populated even for payload-only dispatches.

import type { TaskRecord, TaskStatus } from "./types.js";

// Must enumerate every TaskStatus: byStatus is seeded from this list, so a
// missing state would leave its counter undefined and yield NaN on increment.
const TASK_STATUSES: readonly TaskStatus[] = [
  "blocked",
  "queued",
  "claimed",
  "running",
  "succeeded",
  "failed",
  "canceled",
];

/** Terminal lane states — a lane in one of these has finished for the round. */
const TERMINAL_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>(["succeeded", "failed", "canceled"]);

export interface RoundStatusLane {
  taskId: string;
  status: TaskStatus;
  parentRoundOrder?: number;
  assignedWorkerId?: string;
}

export interface RoundStatusSummary {
  parentRoundId: string;
  /** Expected lane count: the largest declared parentRoundTotal, else the matched count. */
  total: number;
  /** Tasks actually present for this round. */
  matched: number;
  byStatus: Record<TaskStatus, number>;
  /** Lanes in a terminal state (succeeded/failed/canceled). */
  completedCount: number;
  /**
   * Matched lanes that are not yet terminal (blocked/queued/running). This counts
   * only tasks actually present for the round — it does NOT include declared-but-
   * unseen lanes, so `completedCount + pendingCount === matched`, which may be less
   * than `total`. Use `expectedButMissingCount` for declared lanes with no task yet.
   */
  pendingCount: number;
  /** Declared-but-unseen lanes: max(0, total - matched). */
  expectedButMissingCount: number;
  /** completedCount / total, clamped to [0,1]; 0 when total is 0. */
  completionRate: number;
  lanes: RoundStatusLane[];
  /** Task ids of lanes that are not yet terminal. */
  incompleteTaskIds: string[];
}

/**
 * Summarize the lanes of a single parent round. Pure: pass the full task list
 * (e.g. broker.listTasks()) and the round id; tasks are matched on the top-level
 * parentRoundId field.
 */
export function summarizeRoundStatus(tasks: readonly TaskRecord[], parentRoundId: string): RoundStatusSummary {
  const byStatus = Object.fromEntries(TASK_STATUSES.map((s) => [s, 0])) as Record<TaskStatus, number>;
  const lanes: RoundStatusLane[] = [];
  const incompleteTaskIds: string[] = [];
  let declaredTotal = 0;

  for (const task of tasks) {
    if (task.parentRoundId !== parentRoundId) continue;
    byStatus[task.status] += 1;
    lanes.push({
      taskId: task.id,
      status: task.status,
      ...(task.parentRoundOrder !== undefined ? { parentRoundOrder: task.parentRoundOrder } : {}),
      ...(task.assignedWorkerId !== undefined ? { assignedWorkerId: task.assignedWorkerId } : {}),
    });
    if (!TERMINAL_STATUSES.has(task.status)) incompleteTaskIds.push(task.id);
    if (typeof task.parentRoundTotal === "number" && task.parentRoundTotal > declaredTotal) {
      declaredTotal = task.parentRoundTotal;
    }
  }

  lanes.sort((a, b) => (a.parentRoundOrder ?? Number.MAX_SAFE_INTEGER) - (b.parentRoundOrder ?? Number.MAX_SAFE_INTEGER));

  const matched = lanes.length;
  const completedCount = matched - incompleteTaskIds.length;
  const total = Math.max(declaredTotal, matched);
  const completionRate = total > 0 ? Math.min(1, completedCount / total) : 0;

  return {
    parentRoundId,
    total,
    matched,
    byStatus,
    completedCount,
    pendingCount: matched - completedCount,
    expectedButMissingCount: Math.max(0, total - matched),
    completionRate,
    lanes,
    incompleteTaskIds,
  };
}
