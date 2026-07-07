// Task cancellation machinery extracted from broker.ts (#1289 R4 L-broker-13
// — lifecycle lane 2/4). cancelTask gates actor authority and supersede
// evidence, then delegates to the cycle-safe recursive tree cancel; the
// single-record transition clears the checkpoint gate, records cancellation
// evidence, and preserves the tombstone-before-persist ordering verbatim.
// Pure move: state effects are callback-injected via TaskCancellationContext
// (the broker-exchange.ts pattern); InMemoryA2ABroker keeps cancelTask public
// and cancelTaskTree/cancelActiveExchangeTask as private delegators (both are
// bound into other extracted-module contexts).
import { BrokerError } from "./broker-error.js";
import { isoNow, sortedCopy, sortNewestFirst } from "./broker-helpers.js";
import { isTerminalTaskStatus } from "./broker-status-predicates.js";
import { cleanOptionalTaskCancelField } from "./broker-task-request-normalizers.js";
import type { TaskUpdateReason } from "./broker-contracts.js";
import type {
  A2AExchangeState,
  AuditAction,
  AuditEvent,
  TaskCancelRequest,
  TaskRecord,
  TombstoneReason,
} from "./types.js";

export interface TaskCancellationContext {
  tasks: ReadonlyMap<string, TaskRecord>;
  requireTask(id: string): TaskRecord;
  setTaskRecord(task: TaskRecord): void;
  syncExchangeStateFromTask(task: TaskRecord, nextStatus: A2AExchangeState["status"]): void;
  appendAuditEvent(input: {
    actorId: string;
    action: AuditAction;
    targetType: AuditEvent["targetType"];
    targetId: string;
    proposalId?: string;
    note?: string;
  }): AuditEvent;
  writeTombstone(task: TaskRecord, reason: TombstoneReason, context?: { actorId?: string; reason?: string }): void;
  persistState(): void;
  emitTaskEvent(task: TaskRecord, reason: TaskUpdateReason): void;
}

interface CancelTaskParams {
  actorId: string;
  reason?: string;
  sourceTaskId?: string;
  kind?: "superseded";
  supersededByTaskId?: string;
  supersededByPrUrl?: string;
  roundId?: string;
}

export function cancelTask(taskId: string, request: TaskCancelRequest, context: TaskCancellationContext): TaskRecord {
  const task = context.requireTask(taskId);
  if (!request.actor?.id) {
    throw new BrokerError("bad_request", "actor.id is required");
  }

  const actorId = request.actor.id;
  const actorRole = request.actor.role;
  const requesterMatch = actorId === task.requester.id;
  const workerMatch =
    actorId === task.claimedBy ||
    actorId === task.assignedWorkerId ||
    actorId === task.targetNodeId;

  if (
    actorRole !== "hub" &&
    actorRole !== "operator" &&
    !requesterMatch &&
    !workerMatch
  ) {
    throw new BrokerError(
      "policy_denied",
      "task cancellation requires a hub, operator, requester, or assigned worker actor",
    );
  }

  if (task.status === "succeeded" || task.status === "failed" || task.status === "canceled") {
    return task;
  }

  const supersededByTaskId = cleanOptionalTaskCancelField(request.supersededByTaskId);
  const supersededByPrUrl = cleanOptionalTaskCancelField(request.supersededByPrUrl);
  const roundId = cleanOptionalTaskCancelField(request.roundId);
  if (supersededByTaskId === task.id) {
    throw new BrokerError("bad_request", "supersededByTaskId must refer to a different task");
  }
  if (supersededByTaskId) {
    const winner = context.requireTask(supersededByTaskId);
    if (!isTerminalTaskStatus(winner.status)) {
      throw new BrokerError("invalid_transition", `cannot supersede task by non-terminal task ${supersededByTaskId}`);
    }
  }
  const superseded = Boolean(supersededByTaskId || supersededByPrUrl);
  const reason = request.reason ?? (superseded
    ? `superseded by ${supersededByPrUrl ?? supersededByTaskId}`
    : undefined);

  return cancelTaskTree(task, {
    actorId,
    reason,
    kind: superseded ? "superseded" : undefined,
    supersededByTaskId,
    supersededByPrUrl,
    roundId,
  }, context);
}

export function cancelActiveExchangeTask(exchange: A2AExchangeState, reason: string, context: TaskCancellationContext): void {
  if (!exchange.activeTaskId) {
    return;
  }
  const task = context.tasks.get(exchange.activeTaskId);
  if (!task) {
    return;
  }
  if (task.status === "succeeded" || task.status === "failed" || task.status === "canceled") {
    return;
  }
  cancelTaskRecord(task, {
    actorId: "broker",
    reason,
  }, context);
}

function cancelTaskRecord(
  task: TaskRecord,
  params: CancelTaskParams,
  context: TaskCancellationContext,
): TaskRecord {
  const canceledAt = isoNow();
  // Cancellation is one of the two contract-sanctioned exits from a
  // checkpoint (resume | cancel): clear the gate so terminal tasks never
  // carry stale checkpoint metadata.
  task.checkpoint = undefined;
  task.status = "canceled";
  task.claimedBy = undefined;
  task.claimedAt = undefined;
  task.completedAt = canceledAt;
  task.updatedAt = canceledAt;
  task.result = undefined;
  task.error = undefined;
  task.cancellation = {
    requestedAt: canceledAt,
    requestedBy: params.actorId,
    kind: params.kind ?? "operator_cancel",
    reason: params.reason,
    sourceTaskId: params.sourceTaskId,
    supersededByTaskId: params.supersededByTaskId,
    supersededByPrUrl: params.supersededByPrUrl,
    roundId: params.roundId,
  };
  context.setTaskRecord(task);
  context.syncExchangeStateFromTask(task, "queued");
  context.appendAuditEvent({
    actorId: params.actorId,
    action: "task.canceled",
    targetType: "task",
    targetId: task.id,
    proposalId: task.proposalId,
    note: params.reason,
  });
  // Tombstone before persist so a crash between the two cannot lose it
  // (writeTombstone mutates state but does not persist on its own).
  context.writeTombstone(task, "canceled", { actorId: params.actorId, reason: params.reason });
  context.persistState();
  context.emitTaskEvent(task, "canceled");
  return task;
}

export function cancelTaskTree(
  task: TaskRecord,
  params: CancelTaskParams,
  context: TaskCancellationContext,
  visited = new Set<string>(),
): TaskRecord {
  if (visited.has(task.id)) {
    return task;
  }
  visited.add(task.id);

  const canceledTask = cancelTaskRecord(task, params, context);
  for (const childTask of listChildTasks(task.id, context)) {
    if (isTerminalTaskStatus(childTask.status)) {
      continue;
    }
    cancelTaskTree(
      childTask,
      {
        actorId: params.actorId,
        reason: params.reason,
        sourceTaskId: task.id,
        kind: params.kind,
        supersededByTaskId: params.supersededByTaskId,
        supersededByPrUrl: params.supersededByPrUrl,
        roundId: params.roundId,
      },
      context,
      visited,
    );
  }

  return canceledTask;
}

function listChildTasks(parentTaskId: string, context: TaskCancellationContext): TaskRecord[] {
  return sortedCopy(
    [...context.tasks.values()].filter((task) => task.parentTaskId === parentTaskId),
    sortNewestFirst,
  );
}
