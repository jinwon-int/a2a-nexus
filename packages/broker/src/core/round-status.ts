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
const MAX_PARENT_AGGREGATE_REPORT_ITEMS = 50;
const MAX_EXACT_MISSING_ORDER_SCAN = 1000;

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

export interface RoundParentAggregateTaskReportItem {
  taskId: string;
  status: TaskStatus | "missing";
  final: boolean;
  stale: boolean;
  reportable: boolean;
  reportLine: string;
}

export interface RoundParentAggregateTaskReport {
  generatedAt: string;
  parentRoundId: string;
  total: number;
  active: number;
  terminal: number;
  stale: number;
  reportable: number;
  allTerminal: boolean;
  items: RoundParentAggregateTaskReportItem[];
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

  lanes.sort((a, b) => {
    const orderA = a.parentRoundOrder ?? Number.MAX_SAFE_INTEGER;
    const orderB = b.parentRoundOrder ?? Number.MAX_SAFE_INTEGER;
    if (orderA !== orderB) return orderA - orderB;
    return a.taskId.localeCompare(b.taskId);
  });

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

export function buildRoundParentAggregateTaskReport(
  tasks: readonly TaskRecord[],
  parentRoundId: string,
  options: { generatedAt?: string } = {},
): RoundParentAggregateTaskReport {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const summary = summarizeRoundStatus(tasks, parentRoundId);
  const byId = new Map(tasks.map((task) => [task.id, task] as const));
  const items: RoundParentAggregateTaskReportItem[] = summary.lanes.map((lane) => {
    const task = byId.get(lane.taskId);
    const final = TERMINAL_STATUSES.has(lane.status);
    const worker = lane.assignedWorkerId ?? task?.targetNodeId ?? task?.target?.id ?? "unassigned";
    const order = lane.parentRoundOrder !== undefined ? ` lane=${lane.parentRoundOrder}` : "";
    return {
      taskId: lane.taskId,
      status: lane.status,
      final,
      stale: false,
      reportable: true,
      reportLine: `${final ? "terminal" : "progress"}: ${worker}${order} task=${lane.taskId} status=${lane.status}`,
    };
  });

  appendMissingLaneItems(items, summary);

  return {
    generatedAt,
    parentRoundId,
    total: summary.total,
    active: Math.max(0, summary.total - summary.completedCount),
    terminal: summary.completedCount,
    stale: summary.expectedButMissingCount,
    reportable: items.filter((item) => item.reportable !== false).length,
    allTerminal: summary.total > 0 && summary.completedCount === summary.total,
    items,
  };
}

function appendMissingLaneItems(items: RoundParentAggregateTaskReportItem[], summary: RoundStatusSummary): void {
  if (summary.expectedButMissingCount <= 0) return;

  const orderedLanes: number[] = [];
  for (const lane of summary.lanes) {
    const order = lane.parentRoundOrder;
    if (typeof order === "number" && Number.isInteger(order) && order > 0 && order <= summary.total) {
      orderedLanes.push(order);
    }
  }
  const canNameExactMissingOrders =
    orderedLanes.length === summary.lanes.length
    && new Set(orderedLanes).size === orderedLanes.length
    && summary.total <= MAX_EXACT_MISSING_ORDER_SCAN;

  const remainingSlots = Math.max(0, MAX_PARENT_AGGREGATE_REPORT_ITEMS - items.length);
  if (remainingSlots === 0) return;

  const missingLabels: string[] = [];
  if (canNameExactMissingOrders) {
    const present = new Set(orderedLanes);
    for (let order = 1; order <= summary.total && missingLabels.length < remainingSlots; order += 1) {
      if (!present.has(order)) missingLabels.push(`expected lane ${order}/${summary.total}`);
    }
  } else {
    const toEmit = Math.min(summary.expectedButMissingCount, remainingSlots);
    for (let i = 1; i <= toEmit; i += 1) {
      missingLabels.push(`expected lane without task record ${i}/${summary.expectedButMissingCount}`);
    }
  }

  const omitted = summary.expectedButMissingCount - missingLabels.length;
  if (omitted > 0 && missingLabels.length === remainingSlots && remainingSlots > 0) {
    missingLabels[missingLabels.length - 1] = `${omitted + 1} expected lanes without task records omitted from this capped report`;
  }

  missingLabels.forEach((label, index) => {
    items.push({
      taskId: `${summary.parentRoundId}:missing:${index + 1}`,
      status: "missing",
      final: false,
      stale: true,
      reportable: true,
      reportLine: `missing: ${label} has no task record yet`,
    });
  });
}
