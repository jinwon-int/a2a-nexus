// Terminal-status predicates and task diagnostic-status derivation extracted
// from broker.ts. Pure functions over status enums plus task timing; they hold
// no broker state.
import type {
  A2AExchangeState,
  ChangeProposal,
  TaskDiagnosticStatus,
  TaskRecord,
  TaskStatus,
} from "./types.js";

/**
 * Canonical terminal task statuses: the task has finished and will not change
 * again. `blocked` is deliberately absent — it is the pre-approval state
 * (created blocked -> approve -> queued, reject -> canceled), so a blocked task
 * is waiting on an operator, not done.
 */
export const TERMINAL_TASK_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
  "succeeded",
  "failed",
  "canceled",
]);

/**
 * Settled task statuses for reporting surfaces: terminal, or approval-pending
 * (`blocked`). Use this where a lane should stop counting as "in flight"
 * because it is either done or waiting on an operator. `blocked` is still not
 * terminal; use {@link TERMINAL_TASK_STATUSES} for completion semantics.
 */
export const SETTLED_TASK_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
  ...TERMINAL_TASK_STATUSES,
  "blocked",
]);

export function isTerminalExchangeStatus(status: A2AExchangeState["status"]): boolean {
  return status === "completed" || status === "failed";
}

export function isTerminalTaskStatus(status: TaskRecord["status"]): boolean {
  return TERMINAL_TASK_STATUSES.has(status);
}

export function isSettledTaskStatus(status: TaskRecord["status"]): boolean {
  return SETTLED_TASK_STATUSES.has(status);
}

/**
 * Resolve the timestamp that owns task-level staleness.
 *
 * Once a harness has published `lastProgressAt`, progress is authoritative:
 * generic worker heartbeats must not hide a handler/model that stopped making
 * progress. Tasks without a progress surface keep the legacy heartbeat ->
 * update -> claim -> create fallback. A future persisted progress timestamp is
 * ignored so clock skew or malformed state cannot suppress reaping forever;
 * new heartbeat writes are broker-bounded before they reach this function.
 */
export function resolveTaskStalenessSignalMs(task: TaskRecord, nowMs: number): number {
  const progressMs = parseBoundedTaskTimestamp(task.lastProgressAt, nowMs);
  if (progressMs !== undefined) return progressMs;

  for (const value of [task.lastHeartbeatAt, task.updatedAt, task.claimedAt, task.createdAt]) {
    const parsed = parseBoundedTaskTimestamp(value, nowMs);
    if (parsed !== undefined) return parsed;
  }
  return nowMs;
}

function parseBoundedTaskTimestamp(value: string | undefined, nowMs: number): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed <= nowMs ? parsed : undefined;
}

export function computeTaskDiagnosticStatus(
  task: TaskRecord,
  staleAfterMs: number,
  longRunningAfterMs: number,
  nowMs: number,
): TaskDiagnosticStatus {
  if (isTerminalTaskStatus(task.status)) {
    return "terminal";
  }

  if (task.status === "claimed" || task.status === "running") {
    const lastSignal = resolveTaskStalenessSignalMs(task, nowMs);
    const elapsed = nowMs - lastSignal;

    if (elapsed >= staleAfterMs) {
      return "stale";
    }

    const runningSince = task.claimedAt
      ? Date.parse(task.claimedAt)
      : Date.parse(task.createdAt);
    if (task.status === "running" && nowMs - runningSince > longRunningAfterMs) {
      return "long_running";
    }
  }

  return "active";
}

export function isTerminalProposalStatus(status: ChangeProposal["status"]): boolean {
  return status === "rejected" || status === "applied" || status === "rolled_back";
}
