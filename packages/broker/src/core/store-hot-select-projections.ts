import { normalizeFailureClass } from "./task-error-details.js";
import type { TaskRecord } from "./types.js";
import type {
  SqliteTaskHotTableFilters,
  SqliteTaskListItemProjection,
} from "./store.js";

type SqliteHotEntityTable =
  | "broker_exchanges"
  | "broker_exchange_messages"
  | "broker_proposals"
  | "broker_artifacts"
  | "broker_validations"
  | "broker_tasks"
  | "broker_tombstones"
  | "broker_audit_events"
  | "broker_workers"
  | "broker_terminal_outbox";

/**
 * SQL expressions for task fields that live inside the JSON payload rather than
 * in a dedicated `broker_tasks` column.
 *
 * These exist so filters on them can be pushed into the SELECT. When they were
 * applied in JavaScript after the query, the SQL `LIMIT` had to be dropped —
 * limiting before an unapplied predicate would truncate matches — so a
 * `claimedBy` or round lookup read and zod-parsed every task row in the store.
 * `store.ts` creates a matching expression index for each of these, so the same
 * text must be used for the predicate and the index.
 */
export const TASK_CLAIMED_BY_SQL = "json_extract(payload, '$.claimedBy')";
export const TASK_EXCHANGE_ID_SQL = "json_extract(payload, '$.exchangeId')";
export const TASK_PROPOSAL_ID_SQL = "json_extract(payload, '$.proposalId')";

/**
 * Mirrors `hoistParentRoundFields`: the top-level field wins, an empty/blank
 * value falls through to the payload copy, and surrounding whitespace is
 * trimmed. `char(32,9,10,13,11,12)` is the ASCII whitespace set — SQLite's
 * one-argument `trim()` only strips spaces.
 */
export const TASK_PARENT_ROUND_ID_SQL =
  "coalesce(" +
  "nullif(trim(json_extract(payload, '$.parentRoundId'), char(32,9,10,13,11,12)), ''), " +
  "nullif(trim(json_extract(payload, '$.payload.parentRoundId'), char(32,9,10,13,11,12)), '')" +
  ")";

/** Payload-derived task filter predicates, in the order they are appended. */
export function hotTaskPayloadFilterPairs(filters: {
  claimedBy?: string;
  exchangeId?: string;
  proposalId?: string;
  parentRoundId?: string;
}): Array<[string, string | undefined]> {
  return [
    [TASK_CLAIMED_BY_SQL, filters.claimedBy],
    [TASK_EXCHANGE_ID_SQL, filters.exchangeId],
    [TASK_PROPOSAL_ID_SQL, filters.proposalId],
    [TASK_PARENT_ROUND_ID_SQL, filters.parentRoundId],
  ];
}

export function normalizeNonNegativeSqliteLimit(value: number | undefined, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.trunc(value));
  }
  return Math.max(0, Math.trunc(fallback));
}

export function normalizeOptionalSqliteLimit(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  return normalizeNonNegativeSqliteLimit(value, 0);
}

export function buildHotTableSelect(
  tableName: SqliteHotEntityTable,
  filters: Array<[string, string | undefined]>,
  orderBy: string,
  limit?: number,
): { sql: string; params: Array<string | number> } {
  const params: Array<string | number> = [];
  const clauses = filters.flatMap(([column, value]) => {
    if (!value) {
      return [];
    }
    params.push(value);
    return [`${column} = ?`];
  });
  const hasLimit = typeof limit === "number" && Number.isInteger(limit) && limit > 0;
  return {
    sql: `SELECT payload FROM ${tableName}${clauses.length ? ` WHERE ${clauses.join(" AND ")}` : ""} ORDER BY ${orderBy}${hasLimit ? " LIMIT ?" : ""}`,
    params: hasLimit ? [...params, limit] : params,
  };
}

export function buildHotTaskListItemSelect(filters: SqliteTaskHotTableFilters): { sql: string; params: Array<string | number> } {
  const params: Array<string | number> = [];
  const clauses = ([
    ["id", filters.id],
    ["status", filters.status],
    ["target_node_id", filters.targetNodeId],
    ["intent", filters.intent],
    ["assigned_worker_id", filters.assignedWorkerId],
    ["task_origin", filters.taskOrigin],
    ...hotTaskPayloadFilterPairs(filters),
  ] as Array<[string, string | undefined]>).flatMap(([column, value]) => {
    if (!value) {
      return [];
    }
    params.push(value);
    return [`${column} = ?`];
  });
  clauses.push("json_valid(payload)");
  const limit = filters.limit ?? (filters.maxRows !== undefined && filters.maxRows > 0
    ? normalizeOptionalSqliteLimit(filters.maxRows)
    : undefined);
  const hasLimit = typeof limit === "number" && Number.isInteger(limit) && limit > 0;
  return {
    sql: `SELECT
        id,
        status,
        intent,
        target_node_id AS targetNodeId,
        assigned_worker_id AS assignedWorkerId,
        task_origin AS taskOrigin,
        updated_at AS updatedAt,
        json_extract(payload, '$.requester') AS requester,
        json_extract(payload, '$.target') AS target,
        json_extract(payload, '$.exchangeId') AS exchangeId,
        json_extract(payload, '$.parentTaskId') AS parentTaskId,
        json_extract(payload, '$.proposalId') AS proposalId,
        json_extract(payload, '$.claimedBy') AS claimedBy,
        COALESCE(json_extract(payload, '$.result.artifactIds'), json_extract(payload, '$.artifactIds')) AS artifactIds,
        COALESCE(json_extract(payload, '$.result.summary'), json_extract(payload, '$.result.note')) AS resultSummary,
        json_extract(payload, '$.error') AS error,
        json_extract(payload, '$.requeueCount') AS requeueCount,
        json_extract(payload, '$.createdAt') AS createdAt,
        json_extract(payload, '$.claimedAt') AS claimedAt,
        json_extract(payload, '$.completedAt') AS completedAt
      FROM broker_tasks
      WHERE ${clauses.join(" AND ")}
      ORDER BY updated_at DESC, id ASC${hasLimit ? " LIMIT ?" : ""}`,
    params: hasLimit ? [...params, limit] : params,
  };
}

function projectListError(
  error: NonNullable<TaskRecord["error"]>,
): NonNullable<SqliteTaskListItemProjection["error"]> {
  const failureClass = normalizeFailureClass(error.details?.failureClass);
  return {
    code: error.code,
    message: error.message,
    ...(failureClass ? { details: { failureClass } } : {}),
  };
}

export function parseHotTaskListItemProjection(row: unknown): SqliteTaskListItemProjection[] {
  const record = row as Record<string, unknown>;
  const id = optionalStringValue(record.id);
  const intent = optionalStringValue(record.intent) as TaskRecord["intent"] | undefined;
  const status = optionalStringValue(record.status) as TaskRecord["status"] | undefined;
  const targetNodeId = optionalStringValue(record.targetNodeId);
  const requester = parseJsonColumn<TaskRecord["requester"]>(record.requester);
  const target = parseJsonColumn<TaskRecord["target"]>(record.target);
  const updatedAt = optionalStringValue(record.updatedAt);
  const createdAt = optionalStringValue(record.createdAt) ?? updatedAt;
  if (!id || !intent || !status || !targetNodeId || !requester || !target || !updatedAt || !createdAt) {
    return [];
  }
  const error = parseJsonColumn<TaskRecord["error"]>(record.error);
  return [omitUndefinedProperties({
    id,
    intent,
    status,
    targetNodeId,
    requester,
    target,
    exchangeId: optionalStringValue(record.exchangeId),
    parentTaskId: optionalStringValue(record.parentTaskId),
    proposalId: optionalStringValue(record.proposalId),
    assignedWorkerId: optionalStringValue(record.assignedWorkerId),
    claimedBy: optionalStringValue(record.claimedBy),
    taskOrigin: optionalStringValue(record.taskOrigin) as TaskRecord["taskOrigin"] | undefined,
    artifactIds: parseJsonColumn<string[]>(record.artifactIds),
    resultSummary: optionalStringValue(record.resultSummary),
    // The hot-table list projection dropped `details` wholesale, so on a
    // SQLite-backed broker — the production topology — every handler failure
    // read back as a bare `handler_exit_nonzero` with no way to tell a
    // seconds-long missing artifact from a minutes-long bridge failure
    // (#1597, routed from #1725 finding 2). failureClass is a closed
    // vocabulary, so projecting it costs nothing and leaks nothing; the rest
    // of `details` stays behind ?detail=full / GET /tasks/:id as before.
    error: error ? projectListError(error) : undefined,
    requeueCount: optionalNumberValue(record.requeueCount),
    createdAt,
    updatedAt,
    claimedAt: optionalStringValue(record.claimedAt),
    completedAt: optionalStringValue(record.completedAt),
  })];
}

function parseJsonColumn<T>(value: unknown): T | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    return value as T;
  }
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

function optionalStringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalNumberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function omitUndefinedProperties<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

export function normalizeRuntimeTaskListLimit(limit: number | undefined): number | undefined {
  return typeof limit === "number" && Number.isInteger(limit) && limit >= 0 ? limit : undefined;
}
