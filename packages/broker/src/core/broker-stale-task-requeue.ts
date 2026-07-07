// Stale-task requeue engine extracted from broker.ts (#1289 R4 L-broker-10).
// One sweep, three outcomes: requeue a stale claimed/running task back to
// queued, dead-letter it to failed when maxRequeueAttempts is exhausted, or
// cancel it when its checkpoint timed out without resume (contract §1.4/§2.3).
// Driven by the in-process stale reaper and POST /tasks/requeue_stale. Pure
// move — state effects are callback-injected via StaleTaskRequeueContext (the
// broker-exchange.ts pattern); InMemoryA2ABroker keeps public delegators.
import { REQUEUE_EXHAUSTED_ERROR_CODE } from "./broker-error.js";
import { getTaskRequeueReason } from "./broker-task-diagnostics.js";
import { isWorkerStale } from "./broker-worker-status.js";
import type { TaskUpdateReason } from "./broker-contracts.js";
import type {
  A2AExchangeState,
  AuditAction,
  AuditEvent,
  TaskCancelRequest,
  TaskRecord,
  TombstoneReason,
  WorkerRecord,
} from "./types.js";

export interface StaleTaskRequeueContext {
  tasks: ReadonlyMap<string, TaskRecord>;
  workers: ReadonlyMap<string, WorkerRecord>;
  maxRequeueAttempts: number;
  checkpointTimeoutMs: number;
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
  writeTombstone(task: TaskRecord, reason: TombstoneReason): void;
  persistState(): void;
  emitTaskEvent(task: TaskRecord, reason: TaskUpdateReason): void;
  cancelTask(taskId: string, request: TaskCancelRequest): TaskRecord;
}

export function requeueStaleTasks(
  olderThanMs: number,
  options: {
    nowMs?: number;
    workerOfflineAfterMs?: number;
  } | undefined,
  context: StaleTaskRequeueContext,
): TaskRecord[] {
  const result = requeueStaleTasksDetailed(olderThanMs, options, context);
  return result.requeued;
}

/**
 * Same as {@link requeueStaleTasks} but also surfaces the tasks that were dead-lettered to
 * `failed` because they exceeded `maxRequeueAttempts`. Kept as a separate method so the
 * existing public `requeueStaleTasks` signature stays backwards-compatible for the manual
 * `POST /tasks/requeue_stale` response and the in-process stale reaper.
 */
export function requeueStaleTasksDetailed(
  olderThanMs: number,
  options: {
    nowMs?: number;
    workerOfflineAfterMs?: number;
  } | undefined,
  context: StaleTaskRequeueContext,
): { requeued: TaskRecord[]; deadLettered: TaskRecord[] } {
  const thresholdMs = Math.max(0, olderThanMs);
  const nowMs = options?.nowMs ?? Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const staleWorkerIds =
    options?.workerOfflineAfterMs && options.workerOfflineAfterMs >= 0
      ? new Set(listStaleWorkerIds(options.workerOfflineAfterMs, nowMs, context))
      : new Set<string>();
  const requeued: TaskRecord[] = [];
  const deadLettered: TaskRecord[] = [];

  const expiredCheckpointTaskIds: string[] = [];
  for (const task of context.tasks.values()) {
    // Contract §1.4/§2.3: a checkpoint that is never resumed transitions to
    // cancelled when its timeout expires (collected first; cancelTask
    // mutates and persists, so it runs after this scan).
    if (
      task.checkpoint &&
      context.checkpointTimeoutMs > 0 &&
      (task.status === "claimed" || task.status === "running") &&
      nowMs - Date.parse(task.checkpoint.recordedAt) >= context.checkpointTimeoutMs
    ) {
      expiredCheckpointTaskIds.push(task.id);
      continue;
    }
    const requeueReason = getTaskRequeueReason(task, thresholdMs, staleWorkerIds, nowMs);
    if (!requeueReason) {
      continue;
    }

    const currentRequeues = task.requeueCount ?? 0;
    const previousStatus = task.status;

    if (context.maxRequeueAttempts > 0 && currentRequeues >= context.maxRequeueAttempts) {
      // Dead-letter: mark failed so operators see the real state instead of an endless
      // requeue loop. Preserve `claimedBy` and the final `requeueCount` for forensics.
      task.status = "failed";
      task.updatedAt = nowIso;
      task.completedAt = nowIso;
      task.error = {
        code: REQUEUE_EXHAUSTED_ERROR_CODE,
        message: `dead-lettered after ${currentRequeues} automatic requeue${
          currentRequeues === 1 ? "" : "s"
        }: ${requeueReason}`,
        details: {
          requeueCount: currentRequeues,
          maxRequeueAttempts: context.maxRequeueAttempts,
          previousStatus,
          lastRequeueReason: requeueReason,
        },
      };
      context.setTaskRecord(task);
      context.syncExchangeStateFromTask(task, "failed");
      context.appendAuditEvent({
        actorId: "broker",
        action: "task.failed",
        targetType: "task",
        targetId: task.id,
        proposalId: task.proposalId,
        note: task.error.message,
      });
      deadLettered.push(task);
      context.writeTombstone(task, "dead_lettered");
      continue;
    }

    task.status = "queued";
    task.claimedBy = undefined;
    task.claimedAt = undefined;
    task.completedAt = undefined;
    task.attemptId = undefined;
    task.updatedAt = nowIso;
    task.requeueCount = currentRequeues + 1;
    context.setTaskRecord(task);
    context.syncExchangeStateFromTask(task, "queued");
    context.appendAuditEvent({
      actorId: "broker",
      action: "task.requeued",
      targetType: "task",
      targetId: task.id,
      proposalId: task.proposalId,
      note: `requeued ${previousStatus} task without reassignment (attempt ${task.requeueCount}): ${requeueReason}`,
    });
    requeued.push(task);
  }

  if (requeued.length > 0 || deadLettered.length > 0) {
    context.persistState();
  }

  for (const task of deadLettered) {
    context.emitTaskEvent(task, "dead_lettered");
  }
  for (const task of requeued) {
    context.emitTaskEvent(task, "requeued");
  }

  // Expired checkpoints transition to cancelled (contract §1.4/§2.3:
  // "transition to cancelled if the timeout expires without resume").
  // cancelTask clears the lifecycle gate, records cancellation evidence,
  // audits, persists, and emits the terminal update.
  for (const taskId of expiredCheckpointTaskIds) {
    const expired = context.tasks.get(taskId);
    if (!expired?.checkpoint) {
      continue;
    }
    const checkpoint = expired.checkpoint;
    context.cancelTask(taskId, {
      actor: { id: "broker", kind: "service", role: "operator" },
      reason: `${checkpoint.state} checkpoint ${checkpoint.checkpointId} expired after ${context.checkpointTimeoutMs}ms without resume`,
    });
  }

  return { requeued, deadLettered };
}

export function listStaleWorkerIds(
  offlineAfterMs: number,
  nowMs: number,
  context: Pick<StaleTaskRequeueContext, "workers">,
): string[] {
  return [...context.workers.values()]
    .filter((worker) => isWorkerStale(worker.lastSeenAt, offlineAfterMs, nowMs))
    .map((worker) => worker.nodeId);
}
