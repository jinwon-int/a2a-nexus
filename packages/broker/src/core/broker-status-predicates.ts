// Terminal-status predicates and task diagnostic-status derivation extracted
// from broker.ts. Pure functions over status enums plus task timing; they hold
// no broker state.
import type {
  A2AExchangeState,
  ChangeProposal,
  TaskDiagnosticStatus,
  TaskRecord,
} from "./types.js";

export function isTerminalExchangeStatus(status: A2AExchangeState["status"]): boolean {
  return status === "completed" || status === "failed";
}

export function isTerminalTaskStatus(status: TaskRecord["status"]): boolean {
  return status === "succeeded" || status === "failed" || status === "canceled";
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
    const lastSignal = task.lastHeartbeatAt
      ? Date.parse(task.lastHeartbeatAt)
      : task.claimedAt
        ? Date.parse(task.claimedAt)
        : Date.parse(task.createdAt);
    const elapsed = nowMs - lastSignal;

    if (elapsed > staleAfterMs) {
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
