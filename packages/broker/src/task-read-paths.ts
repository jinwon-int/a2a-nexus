// Task list/diagnostics read-path projection, filtering, and query helpers
// extracted from server.ts. These operate on a broker passed as a parameter and
// hold no module state; validation failures throw BrokerError. Kept in src/ (not
// http/) so the inline import("./core/...") specifiers in the moved code remain
// valid unchanged.
import { BrokerError } from "./core/broker-error.js";
import { SqliteBrokerStateStore } from "./core/store.js";
import { failureReadbackFromError } from "./core/task-error-details.js";
import type { InMemoryA2ABroker, TaskDiagnosticsOptions } from "./core/broker.js";
import type { BrokerStateStore, SqliteTaskListItemProjection } from "./core/store.js";
import type {
  AuditEvent,
  AuditListFilters,
  CreateTaskRequest,
  TaskDiagnosticReport,
  TaskKind,
  TaskListFilters,
  TaskOrigin,
  TaskRecord,
  TaskStatus,
  TaskTombstone,
  WorkerRecord,
} from "./core/types.js";

export function listAuditEventsForReadPath(
  stateStore: BrokerStateStore,
  broker: InMemoryA2ABroker,
  filters: AuditListFilters,
) {
  if (stateStore instanceof SqliteBrokerStateStore) {
    return stateStore.readHotAuditEvents(filters);
  }
  return broker.listAuditEvents(filters);
}

export function assertCreateTaskPayloadWithinLimit(body: CreateTaskRequest, maxTaskPayloadBytes: number): void {
  if (!body.payload) {
    return;
  }
  const payloadBytes = Buffer.byteLength(JSON.stringify(body.payload), "utf8");
  if (payloadBytes <= maxTaskPayloadBytes) {
    return;
  }
  throw new BrokerError(
    "bad_request",
    `task payload exceeds configured limit (${payloadBytes} bytes > ${maxTaskPayloadBytes} bytes); externalize large sourceBundle content and submit only references or summaries`,
    {
      payloadBytes,
      maxTaskPayloadBytes,
      externalize: ["payload.sourceBundle", "payload.sourceEvidence", "payload.embeddedSourceEvidence"],
    },
  );
}

export interface TaskListItem {
  id: string;
  intent: TaskKind;
  status: TaskStatus;
  targetNodeId: string;
  requester: TaskRecord["requester"];
  target: TaskRecord["target"];
  exchangeId?: string;
  parentTaskId?: string;
  proposalId?: string;
  assignedWorkerId?: string;
  claimedBy?: string;
  taskOrigin?: TaskOrigin;
  artifactIds?: string[];
  resultSummary?: string;
  error?: Pick<NonNullable<TaskRecord["error"]>, "code" | "message"> & { details?: Record<string, unknown> };
  requeueCount?: number;
  createdAt: string;
  updatedAt: string;
  claimedAt?: string;
  completedAt?: string;
}

export function projectTaskListItem(task: TaskRecord): TaskListItem {
  const artifactIds = task.result?.artifactIds ?? task.artifactIds;
  const failureReadback = task.error ? failureReadbackFromError(task.error) : undefined;
  return {
    id: task.id,
    intent: task.intent,
    status: task.status,
    targetNodeId: task.targetNodeId,
    requester: task.requester,
    target: task.target,
    exchangeId: task.exchangeId,
    parentTaskId: task.parentTaskId,
    proposalId: task.proposalId,
    assignedWorkerId: task.assignedWorkerId,
    claimedBy: task.claimedBy,
    taskOrigin: task.taskOrigin,
    artifactIds,
    resultSummary: task.result?.summary ?? task.result?.note,
    error: task.error
      ? {
          code: task.error.code,
          message: task.error.message,
          ...(failureReadback ? { details: failureReadback } : {}),
        }
      : undefined,
    requeueCount: task.requeueCount,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    claimedAt: task.claimedAt,
    completedAt: task.completedAt,
  };
}

const ACTIVE_READ_PATH_STATUSES = new Set<TaskStatus>(["queued"]);

export function shouldFilterSqliteActiveReadPath(filters: TaskListFilters): boolean {
  return filters.includeStaleReadPath !== true && (!filters.status || ACTIVE_READ_PATH_STATUSES.has(filters.status));
}

export function taskIsLiveInMutationMap(broker: InMemoryA2ABroker, task: { id: string; status: TaskStatus }): boolean {
  if (!ACTIVE_READ_PATH_STATUSES.has(task.status)) return true;
  return Boolean(broker.getTask(task.id));
}

// Widening factor for the active read path's paged liveness fetch below.
const ACTIVE_READ_PATH_OVERFETCH_FACTOR = 4;
// Beyond this fetch size fall back to the unbounded scan rather than paging.
const ACTIVE_READ_PATH_MAX_OVERFETCH = 10_000;

/**
 * Page the active (liveness-filtered) SQLite read path at the requested limit
 * instead of scanning the whole queued set per request. Stale hot rows are
 * rare, so the first fetch normally satisfies the page; when filtering leaves
 * it short, widen the fetch — each widened read is a superset in the same
 * order, so the result matches the previous unbounded scan exactly.
 */
function collectLiveActiveReadPathItems<T extends { id: string; status: TaskStatus }>(
  broker: InMemoryA2ABroker,
  requestedLimit: number | undefined,
  read: (limit: number | undefined) => T[],
): T[] {
  let fetchLimit = requestedLimit;
  for (;;) {
    const items = read(fetchLimit);
    const exhausted = fetchLimit === undefined || items.length < fetchLimit;
    const live = items.filter((task) => taskIsLiveInMutationMap(broker, task));
    if (exhausted || requestedLimit === undefined || live.length >= requestedLimit) {
      return requestedLimit === undefined ? live : live.slice(0, requestedLimit);
    }
    const widened = fetchLimit === undefined ? undefined : fetchLimit * ACTIVE_READ_PATH_OVERFETCH_FACTOR;
    fetchLimit = widened !== undefined && widened > ACTIVE_READ_PATH_MAX_OVERFETCH ? undefined : widened;
  }
}

export function listAllTasksForStatsReadPath(
  stateStore: BrokerStateStore,
  broker: InMemoryA2ABroker,
): TaskRecord[] {
  if (stateStore instanceof SqliteBrokerStateStore) {
    return stateStore.readHotTasks();
  }
  return broker.listTasks();
}

export function listTasksForReadPath(
  stateStore: BrokerStateStore,
  broker: InMemoryA2ABroker,
  filters: TaskListFilters,
): TaskRecord[] {
  if (stateStore instanceof SqliteBrokerStateStore && canUseSqliteTaskHotRead(filters)) {
    const sqliteFilters = {
      status: filters.status,
      targetNodeId: filters.targetNodeId,
      intent: filters.intent,
      assignedWorkerId: filters.assignedWorkerId,
      taskOrigin: filters.taskOrigin,
    };
    if (!shouldFilterSqliteActiveReadPath(filters)) {
      return stateStore.readHotTasks({ ...sqliteFilters, limit: filters.limit }).slice(0, filters.limit);
    }
    return collectLiveActiveReadPathItems(broker, filters.limit, (limit) =>
      stateStore.readHotTasks({ ...sqliteFilters, limit }));
  }
  return broker.listTasks(filters);
}

export function listTaskItemsForReadPath(
  stateStore: BrokerStateStore,
  broker: InMemoryA2ABroker,
  filters: TaskListFilters,
): TaskListItem[] {
  if (stateStore instanceof SqliteBrokerStateStore && canUseSqliteTaskHotRead(filters)) {
    const sqliteFilters = {
      status: filters.status,
      targetNodeId: filters.targetNodeId,
      intent: filters.intent,
      assignedWorkerId: filters.assignedWorkerId,
      taskOrigin: filters.taskOrigin,
    };
    if (!shouldFilterSqliteActiveReadPath(filters)) {
      return stateStore
        .readHotTaskListItems({ ...sqliteFilters, limit: filters.limit })
        .slice(0, filters.limit)
        .map(projectSqliteTaskListItem);
    }
    return collectLiveActiveReadPathItems(broker, filters.limit, (limit) =>
      stateStore.readHotTaskListItems({ ...sqliteFilters, limit })).map(projectSqliteTaskListItem);
  }
  return broker.listTasks(filters).map(projectTaskListItem);
}

export function projectSqliteTaskListItem(task: SqliteTaskListItemProjection): TaskListItem {
  return {
    id: task.id,
    intent: task.intent,
    status: task.status,
    targetNodeId: task.targetNodeId,
    requester: task.requester,
    target: task.target,
    exchangeId: task.exchangeId,
    parentTaskId: task.parentTaskId,
    proposalId: task.proposalId,
    assignedWorkerId: task.assignedWorkerId,
    claimedBy: task.claimedBy,
    taskOrigin: task.taskOrigin,
    artifactIds: task.artifactIds,
    resultSummary: task.resultSummary,
    error: task.error,
    requeueCount: task.requeueCount,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    claimedAt: task.claimedAt,
    completedAt: task.completedAt,
  };
}

export function getTaskForReadPath(
  stateStore: BrokerStateStore,
  broker: InMemoryA2ABroker,
  taskId: string,
  options: { includeStaleReadPath?: boolean } = {},
): TaskRecord | null {
  if (stateStore instanceof SqliteBrokerStateStore) {
    const task = stateStore.readHotTasks({ id: taskId })[0] ?? null;
    if (task && options.includeStaleReadPath !== true && !taskIsLiveInMutationMap(broker, task)) {
      return null;
    }
    return task;
  }
  return broker.getTask(taskId);
}

export function getTaskDiagnosticsForReadPath(
  stateStore: BrokerStateStore,
  broker: InMemoryA2ABroker,
  taskId: string,
  options: TaskDiagnosticsOptions,
): TaskDiagnosticReport {
  if (stateStore instanceof SqliteBrokerStateStore) {
    const task = stateStore.readHotTasks({ id: taskId })[0];
    if (!task) {
      throw new BrokerError("not_found", "task not found");
    }
    const assignedWorker = task.assignedWorkerId
      ? stateStore.readHotWorkers({ nodeId: task.assignedWorkerId })[0] ?? null
      : null;
    const lastRequeueEvent = latestAuditEvent(stateStore.readHotAuditEvents({
      targetId: taskId,
      action: "task.requeued",
    }));
    return broker.getTaskDiagnosticsForRecord(task, options, {
      tombstone: stateStore.readHotTombstones({ taskId })[0] ?? null,
      assignedWorker,
      lastRequeueEvent,
    });
  }
  return broker.getTaskDiagnostics(taskId, options);
}

export function listTaskDiagnosticsForReadPath(
  stateStore: BrokerStateStore,
  broker: InMemoryA2ABroker,
  options: TaskDiagnosticsOptions,
): TaskDiagnosticReport[] {
  if (stateStore instanceof SqliteBrokerStateStore) {
    const tombstonesByTaskId = new Map<string, TaskTombstone>(
      stateStore.readHotTombstones().map((tombstone) => [tombstone.taskId, tombstone]),
    );
    const workersByNodeId = new Map<string, WorkerRecord>(
      stateStore.readHotWorkers().map((worker) => [worker.nodeId, worker]),
    );
    const latestRequeueEventByTaskId = new Map<string, AuditEvent>();
    for (const event of stateStore.readHotAuditEvents({ action: "task.requeued" })) {
      const existing = latestRequeueEventByTaskId.get(event.targetId);
      if (!existing || event.createdAt > existing.createdAt) {
        latestRequeueEventByTaskId.set(event.targetId, event);
      }
    }
    return stateStore.readHotTasks().map((task) => broker.getTaskDiagnosticsForRecord(task, options, {
      tombstone: tombstonesByTaskId.get(task.id) ?? null,
      assignedWorker: task.assignedWorkerId ? workersByNodeId.get(task.assignedWorkerId) ?? null : null,
      lastRequeueEvent: latestRequeueEventByTaskId.get(task.id) ?? null,
    }));
  }
  return broker.listTasks().map((task) => broker.getTaskDiagnostics(task.id, options));
}

export function latestAuditEvent(events: AuditEvent[]): AuditEvent | null {
  let latest: AuditEvent | null = null;
  for (const event of events) {
    if (!latest || event.createdAt > latest.createdAt) {
      latest = event;
    }
  }
  return latest;
}

export function canUseSqliteTaskHotRead(filters: TaskListFilters): boolean {
  return !(
    filters.exchangeId ||
    filters.proposalId ||
    filters.claimedBy
  );
}

export function mapBrokerDiagnosticsToSnapshot(
  diagnostics: import("./core/store.js").BrokerHotTerminalOutboxDiagnostics,
): NonNullable<import("./core/release-evidence.js").ReleaseEvidenceExportOptions["terminalOutboxDiagnostics"]> {
  return {
    total: diagnostics.total,
    acked: diagnostics.acked,
    unacked: diagnostics.unacked,
    unackedRatio: diagnostics.unackedRatio,
    oldestUnackedAgeMs: diagnostics.oldestUnackedAgeMs,
    oldestUnackedCreatedAt: diagnostics.oldestUnackedCreatedAt,
    ackEligibleUnacked: diagnostics.ackEligibleUnacked,
    warnings: diagnostics.warnings,
  };
}
