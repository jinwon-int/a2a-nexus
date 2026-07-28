/**
 * Ephemeral task-lineage read projection (#1635 P1-B).
 *
 * This module is deliberately pure: it accepts already-readable TaskRecord
 * values, builds one in-memory index, and answers bounded queries. It never
 * reads or writes a store, mutates tasks, schedules work, or participates in
 * completion/finalizer/verdict paths.
 */

import { createHash } from "node:crypto";

import { BrokerError } from "./broker-error.js";
import type { TaskKind, TaskRecord, TaskStatus } from "./types.js";

export const TASK_LINEAGE_DEFAULT_LIMIT = 200;
export const TASK_LINEAGE_MAX_LIMIT = 1_000;
export const TASK_LINEAGE_DEFAULT_MAX_DEPTH = 32;
export const TASK_LINEAGE_HARD_MAX_DEPTH = 128;
export const TASK_LINEAGE_MAX_CURSOR_LENGTH = 1_024;
export const TASK_LINEAGE_MAX_REFERENCE_IDS_PER_NODE = 100;
export const TASK_LINEAGE_MAX_DIAGNOSTIC_CODES = 16;

export const TASK_LINEAGE_NODE_KIND = "TaskLineageNodeV1" as const;
export const TASK_LINEAGE_CHILD_KIND = "TaskLineageChildV1" as const;
export const TASK_LINEAGE_CHILDREN_ANCHOR_KIND =
  "TaskLineageChildrenAnchorV1" as const;
export const TASK_LINEAGE_CHILDREN_REQUEST_KIND =
  "TaskLineageChildrenRequestV1" as const;
export const TASK_LINEAGE_CHILDREN_KIND = "TaskLineageChildrenV1" as const;
export const TASK_LINEAGE_LINEAGE_REQUEST_KIND =
  "TaskLineageLineageRequestV1" as const;
export const TASK_LINEAGE_LINEAGE_KIND = "TaskLineageLineageV1" as const;
export const TASK_LINEAGE_LEAVES_REQUEST_KIND =
  "TaskLineageLeavesRequestV1" as const;
export const TASK_LINEAGE_LEAVES_KIND = "TaskLineageLeavesV1" as const;
export const TASK_LINEAGE_FILTERS_KIND = "TaskLineageFiltersV1" as const;
export const TASK_LINEAGE_PAGINATION_KIND =
  "TaskLineagePaginationV1" as const;
export const TASK_LINEAGE_PAGE_KIND = "TaskLineagePageV1" as const;
export const TASK_LINEAGE_ROUND_HINT_KIND =
  "TaskLineageRoundCompletenessHintV1" as const;
export const TASK_LINEAGE_ANOMALY_KIND = "TaskLineageAnomalyV1" as const;
export const TASK_LINEAGE_DIAGNOSTICS_KIND =
  "TaskLineageDiagnosticsV1" as const;
export const TASK_LINEAGE_CURSOR_KIND = "TaskLineageCursorV1" as const;

const IDENTIFIER_PATTERN = /^[^\s\u0000-\u001f\u007f]{1,512}$/;
const RFC3339_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const HEX_64_PATTERN = /^[0-9a-f]{64}$/;
const CURSOR_PATTERN = /^tl1\.([A-Za-z0-9_-]+)$/;

const TASK_LINEAGE_INTENTS: readonly TaskKind[] = [
  "chat",
  "analyze",
  "verify",
  "backfill",
  "propose_patch",
  "propose_params",
  "validate_change",
  "apply_local_change",
  "promote_to_live",
  "rollback_live",
];
const TASK_LINEAGE_STATUSES: readonly TaskStatus[] = [
  "blocked",
  "queued",
  "claimed",
  "running",
  "succeeded",
  "failed",
  "canceled",
];
const TASK_LINEAGE_EDGE_TYPES = [
  "canonical_parent",
  "reference",
  "round_stamp",
] as const;
const TASK_LINEAGE_ANOMALY_CODES = [
  "task_lineage.parent_missing",
  "task_lineage.reference_unavailable",
  "task_lineage.duplicate_edge",
  "task_lineage.invalid_record",
  "task_lineage.duplicate_task_record",
  "task_lineage.reference_output_truncated",
  "task_lineage.round_total_unavailable",
  "task_lineage.round_total_conflict",
] as const;

const TASK_LINEAGE_INTENT_SET: ReadonlySet<TaskKind> =
  new Set(TASK_LINEAGE_INTENTS);
const TASK_LINEAGE_STATUS_SET: ReadonlySet<TaskStatus> =
  new Set(TASK_LINEAGE_STATUSES);
const TASK_LINEAGE_EDGE_TYPE_SET: ReadonlySet<TaskLineageEdgeTypeV1> =
  new Set(TASK_LINEAGE_EDGE_TYPES);
const TASK_LINEAGE_ANOMALY_CODE_SET: ReadonlySet<TaskLineageAnomalyCodeV1> =
  new Set(TASK_LINEAGE_ANOMALY_CODES);

export type TaskLineageEdgeTypeV1 =
  (typeof TASK_LINEAGE_EDGE_TYPES)[number];

export type TaskLineageAnomalyCodeV1 =
  (typeof TASK_LINEAGE_ANOMALY_CODES)[number];

export type TaskLineageValidationCode =
  | "unexpected_field"
  | "invalid_object"
  | "invalid_string"
  | "invalid_array"
  | "invalid_boolean"
  | "invalid_integer"
  | "invalid_enum"
  | "invalid_timestamp"
  | "duplicate_value"
  | "unknown_anchor"
  | "ambiguous_anchor"
  | "invalid_cursor"
  | "cursor_mismatch"
  | "cursor_position_unavailable";

/**
 * Safe validation failures expose a stable code and path only. They never
 * copy an input value, task id, cursor body, payload, or message into errors.
 */
export class TaskLineageValidationError extends BrokerError {
  constructor(
    readonly validationCode: TaskLineageValidationCode,
    readonly path: string,
  ) {
    super(
      "bad_request",
      `task lineage validation failed: ${validationCode} at ${path}`,
      { validationCode, path },
    );
    this.name = "TaskLineageValidationError";
  }
}

/** Structured, identifier-free canonical-parent cycle failure. */
export class TaskLineageCycleError extends BrokerError {
  constructor() {
    super("task_lineage_cycle", "task lineage cycle detected");
    this.name = "TaskLineageCycleError";
  }
}

export interface TaskLineageNodeV1 {
  kind: typeof TASK_LINEAGE_NODE_KIND;
  taskId: string;
  parentTaskId: string | null;
  parentMissing: boolean;
  parentRoundId?: string;
  referenceTaskIds: string[];
  intent: TaskKind;
  status: TaskStatus;
  requesterId: string;
  assignedWorkerId?: string;
  createdAt: string;
  depth: number;
}

export interface TaskLineageChildV1 {
  kind: typeof TASK_LINEAGE_CHILD_KIND;
  node: TaskLineageNodeV1;
  edges: TaskLineageEdgeTypeV1[];
  rejoin: boolean;
}

export type TaskLineageChildrenAnchorV1 =
  | {
      kind: typeof TASK_LINEAGE_CHILDREN_ANCHOR_KIND;
      taskId: string;
    }
  | {
      kind: typeof TASK_LINEAGE_CHILDREN_ANCHOR_KIND;
      parentRoundId: string;
    };

export interface TaskLineagePaginationV1 {
  kind: typeof TASK_LINEAGE_PAGINATION_KIND;
  limit: number;
  cursor?: string;
}

export interface TaskLineagePageV1 {
  kind: typeof TASK_LINEAGE_PAGE_KIND;
  limit: number;
  returned: number;
  nextCursor: string | null;
}

export interface TaskLineageFiltersV1 {
  kind: typeof TASK_LINEAGE_FILTERS_KIND;
  parentRoundId?: string;
  intent?: TaskKind;
  status?: TaskStatus[];
  since?: string;
  until?: string;
}

export interface TaskLineageChildrenRequestV1 {
  kind: typeof TASK_LINEAGE_CHILDREN_REQUEST_KIND;
  anchor: TaskLineageChildrenAnchorV1;
  pagination: TaskLineagePaginationV1;
}

export interface TaskLineageLineageRequestV1 {
  kind: typeof TASK_LINEAGE_LINEAGE_REQUEST_KIND;
  taskId: string;
  maxDepth: number;
}

export interface TaskLineageLeavesRequestV1 {
  kind: typeof TASK_LINEAGE_LEAVES_REQUEST_KIND;
  filters: TaskLineageFiltersV1;
  pagination: TaskLineagePaginationV1;
}

export interface TaskLineageRoundCompletenessHintV1 {
  kind: typeof TASK_LINEAGE_ROUND_HINT_KIND;
  parentRoundId: string;
  stampedTotal: number;
  observedChildren: number;
  complete: boolean;
}

export interface TaskLineageAnomalyV1 {
  kind: typeof TASK_LINEAGE_ANOMALY_KIND;
  code: TaskLineageAnomalyCodeV1;
  count: number;
}

export interface TaskLineageDiagnosticsV1 {
  kind: typeof TASK_LINEAGE_DIAGNOSTICS_KIND;
  source: "task_record_read_projection";
  scannedVisibleTasks: number;
  returnedNodes: number;
  anomalies: TaskLineageAnomalyV1[];
}

export interface TaskLineageChildrenV1 {
  kind: typeof TASK_LINEAGE_CHILDREN_KIND;
  anchor: TaskLineageChildrenAnchorV1;
  children: TaskLineageChildV1[];
  page: TaskLineagePageV1;
  round?: TaskLineageRoundCompletenessHintV1;
  diagnostics: TaskLineageDiagnosticsV1;
}

export interface TaskLineageLineageV1 {
  kind: typeof TASK_LINEAGE_LINEAGE_KIND;
  lineage: TaskLineageNodeV1[];
  truncated: boolean;
  rootReached: boolean;
  diagnostics: TaskLineageDiagnosticsV1;
}

export interface TaskLineageLeavesV1 {
  kind: typeof TASK_LINEAGE_LEAVES_KIND;
  filters: TaskLineageFiltersV1;
  leaves: TaskLineageNodeV1[];
  page: TaskLineagePageV1;
  diagnostics: TaskLineageDiagnosticsV1;
}

export interface TaskLineageCursorV1 {
  kind: typeof TASK_LINEAGE_CURSOR_KIND;
  queryHash: string;
  createdAt: string;
  taskIdHash: string;
}

export interface TaskLineageReadProjectionV1 {
  children(request: TaskLineageChildrenRequestV1): TaskLineageChildrenV1;
  lineage(request: TaskLineageLineageRequestV1): TaskLineageLineageV1;
  leaves(request: TaskLineageLeavesRequestV1): TaskLineageLeavesV1;
}

interface IndexedTask {
  task: TaskRecord;
  taskId: string;
  createdAt: string;
  createdAtMs: number;
  parentRecorded: boolean;
  parentTaskId?: string;
  parentRoundId?: string;
  parentRoundTotal?: number;
  referenceTaskIds: string[];
  invalidReferenceCount: number;
}

interface PageSlice<T> {
  items: T[];
  page: TaskLineagePageV1;
}

function fail(
  code: TaskLineageValidationCode,
  path: string,
): never {
  throw new TaskLineageValidationError(code, path);
}

function objectAt(
  value: unknown,
  path: string,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("invalid_object", path);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  path: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail("unexpected_field", `${path}.${key}`);
  }
}

function stringAt(
  value: unknown,
  path: string,
  options: { max?: number; pattern?: RegExp } = {},
): string {
  const max = options.max ?? 4_096;
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > max
    || (options.pattern && !options.pattern.test(value))
  ) {
    fail("invalid_string", path);
  }
  return value;
}

function identifierAt(value: unknown, path: string): string {
  return stringAt(value, path, {
    max: 512,
    pattern: IDENTIFIER_PATTERN,
  });
}

function optionalIdentifierAt(
  value: unknown,
  path: string,
): string | undefined {
  return value === undefined ? undefined : identifierAt(value, path);
}

function timestampAt(
  value: unknown,
  path: string,
  canonicalize = false,
): string {
  const timestamp = stringAt(value, path, {
    max: 40,
    pattern: RFC3339_PATTERN,
  });
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) fail("invalid_timestamp", path);
  return canonicalize ? new Date(parsed).toISOString() : timestamp;
}

function booleanAt(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") fail("invalid_boolean", path);
  return value;
}

function integerAt(
  value: unknown,
  path: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (
    !Number.isSafeInteger(value)
    || (value as number) < minimum
    || (value as number) > maximum
  ) {
    fail("invalid_integer", path);
  }
  return value as number;
}

function enumAt<T extends string>(
  value: unknown,
  allowed: ReadonlySet<T>,
  path: string,
): T {
  if (typeof value !== "string" || !allowed.has(value as T)) {
    fail("invalid_enum", path);
  }
  return value as T;
}

function arrayAt(
  value: unknown,
  path: string,
  options: { min?: number; max?: number } = {},
): unknown[] {
  if (
    !Array.isArray(value)
    || value.length < (options.min ?? 0)
    || value.length > (options.max ?? Number.MAX_SAFE_INTEGER)
  ) {
    fail("invalid_array", path);
  }
  return value;
}

function uniqueEnumArrayAt<T extends string>(
  value: unknown,
  allowed: ReadonlySet<T>,
  path: string,
  maximum: number,
): T[] {
  const values = arrayAt(value, path, { min: 1, max: maximum });
  const seen = new Set<T>();
  return values.map((entry, index) => {
    const item = enumAt(entry, allowed, `${path}[${index}]`);
    if (seen.has(item)) fail("duplicate_value", `${path}[${index}]`);
    seen.add(item);
    return item;
  });
}

function parsePaginationRequestAt(
  limitValue: unknown,
  cursorValue: unknown,
  path: string,
): TaskLineagePaginationV1 {
  const limit =
    limitValue === undefined
      ? TASK_LINEAGE_DEFAULT_LIMIT
      : integerAt(limitValue, `${path}.limit`, 1, TASK_LINEAGE_MAX_LIMIT);
  const cursor =
    cursorValue === undefined
      ? undefined
      : stringAt(cursorValue, `${path}.cursor`, {
          max: TASK_LINEAGE_MAX_CURSOR_LENGTH,
        });
  if (cursor !== undefined) parseTaskLineageCursorV1(cursor);
  return {
    kind: TASK_LINEAGE_PAGINATION_KIND,
    limit,
    ...(cursor ? { cursor } : {}),
  };
}

export function parseTaskLineageChildrenRequestV1(
  input: unknown,
): TaskLineageChildrenRequestV1 {
  const request = objectAt(input, "$");
  exactKeys(
    request,
    new Set(["taskId", "parentRoundId", "limit", "cursor"]),
    "$",
  );
  const taskId = optionalIdentifierAt(request.taskId, "$.taskId");
  const parentRoundId = optionalIdentifierAt(
    request.parentRoundId,
    "$.parentRoundId",
  );
  if (taskId && parentRoundId) fail("ambiguous_anchor", "$");
  if (!taskId && !parentRoundId) fail("unknown_anchor", "$");
  return {
    kind: TASK_LINEAGE_CHILDREN_REQUEST_KIND,
    anchor: taskId
      ? { kind: TASK_LINEAGE_CHILDREN_ANCHOR_KIND, taskId }
      : {
          kind: TASK_LINEAGE_CHILDREN_ANCHOR_KIND,
          parentRoundId: parentRoundId!,
        },
    pagination: parsePaginationRequestAt(
      request.limit,
      request.cursor,
      "$",
    ),
  };
}

export function parseTaskLineageLineageRequestV1(
  input: unknown,
): TaskLineageLineageRequestV1 {
  const request = objectAt(input, "$");
  exactKeys(request, new Set(["taskId", "maxDepth"]), "$");
  return {
    kind: TASK_LINEAGE_LINEAGE_REQUEST_KIND,
    taskId: identifierAt(request.taskId, "$.taskId"),
    maxDepth:
      request.maxDepth === undefined
        ? TASK_LINEAGE_DEFAULT_MAX_DEPTH
        : integerAt(
            request.maxDepth,
            "$.maxDepth",
            1,
            TASK_LINEAGE_HARD_MAX_DEPTH,
          ),
  };
}

export function parseTaskLineageLeavesRequestV1(
  input: unknown,
): TaskLineageLeavesRequestV1 {
  const request = objectAt(input, "$");
  exactKeys(
    request,
    new Set([
      "parentRoundId",
      "intent",
      "status",
      "since",
      "until",
      "limit",
      "cursor",
    ]),
    "$",
  );
  const since =
    request.since === undefined
      ? undefined
      : timestampAt(request.since, "$.since", true);
  const until =
    request.until === undefined
      ? undefined
      : timestampAt(request.until, "$.until", true);
  if (
    since !== undefined
    && until !== undefined
    && Date.parse(since) > Date.parse(until)
  ) {
    fail("invalid_timestamp", "$.until");
  }
  const status =
    request.status === undefined
      ? undefined
      : uniqueEnumArrayAt(
          request.status,
          TASK_LINEAGE_STATUS_SET,
          "$.status",
          TASK_LINEAGE_STATUSES.length,
        ).sort();
  return {
    kind: TASK_LINEAGE_LEAVES_REQUEST_KIND,
    filters: {
      kind: TASK_LINEAGE_FILTERS_KIND,
      ...(request.parentRoundId === undefined
        ? {}
        : {
            parentRoundId: identifierAt(
              request.parentRoundId,
              "$.parentRoundId",
            ),
          }),
      ...(request.intent === undefined
        ? {}
        : {
            intent: enumAt(
              request.intent,
              TASK_LINEAGE_INTENT_SET,
              "$.intent",
            ),
          }),
      ...(status ? { status } : {}),
      ...(since ? { since } : {}),
      ...(until ? { until } : {}),
    },
    pagination: parsePaginationRequestAt(
      request.limit,
      request.cursor,
      "$",
    ),
  };
}

export function parseTaskLineageCursorV1(
  input: unknown,
): TaskLineageCursorV1 {
  const cursor = stringAt(input, "$.cursor", {
    max: TASK_LINEAGE_MAX_CURSOR_LENGTH,
  });
  const match = CURSOR_PATTERN.exec(cursor);
  if (!match?.[1]) fail("invalid_cursor", "$.cursor");
  const encoded = match[1];
  let decoded: string;
  try {
    const bytes = Buffer.from(encoded, "base64url");
    if (bytes.length > 512 || bytes.toString("base64url") !== encoded) {
      fail("invalid_cursor", "$.cursor");
    }
    decoded = bytes.toString("utf8");
  } catch {
    fail("invalid_cursor", "$.cursor");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    fail("invalid_cursor", "$.cursor");
  }
  const value = objectAt(parsed, "$.cursor");
  exactKeys(
    value,
    new Set(["kind", "queryHash", "createdAt", "taskIdHash"]),
    "$.cursor",
  );
  if (value.kind !== TASK_LINEAGE_CURSOR_KIND) {
    fail("invalid_cursor", "$.cursor.kind");
  }
  const queryHash = stringAt(value.queryHash, "$.cursor.queryHash", {
    max: 64,
    pattern: HEX_64_PATTERN,
  });
  const taskIdHash = stringAt(value.taskIdHash, "$.cursor.taskIdHash", {
    max: 64,
    pattern: HEX_64_PATTERN,
  });
  return {
    kind: TASK_LINEAGE_CURSOR_KIND,
    queryHash,
    createdAt: timestampAt(value.createdAt, "$.cursor.createdAt"),
    taskIdHash,
  };
}

function parseTaskLineageNodeAt(
  input: unknown,
  path: string,
): TaskLineageNodeV1 {
  const node = objectAt(input, path);
  exactKeys(
    node,
    new Set([
      "kind",
      "taskId",
      "parentTaskId",
      "parentMissing",
      "parentRoundId",
      "referenceTaskIds",
      "intent",
      "status",
      "requesterId",
      "assignedWorkerId",
      "createdAt",
      "depth",
    ]),
    path,
  );
  if (node.kind !== TASK_LINEAGE_NODE_KIND) {
    fail("invalid_enum", `${path}.kind`);
  }
  const parentTaskId =
    node.parentTaskId === null
      ? null
      : identifierAt(node.parentTaskId, `${path}.parentTaskId`);
  const parentMissing = booleanAt(
    node.parentMissing,
    `${path}.parentMissing`,
  );
  if (parentTaskId !== null && parentMissing) {
    fail("invalid_boolean", `${path}.parentMissing`);
  }
  const referenceTaskIds = arrayAt(
    node.referenceTaskIds,
    `${path}.referenceTaskIds`,
    { max: TASK_LINEAGE_MAX_REFERENCE_IDS_PER_NODE },
  ).map((value, index) =>
    identifierAt(value, `${path}.referenceTaskIds[${index}]`),
  );
  if (new Set(referenceTaskIds).size !== referenceTaskIds.length) {
    fail("duplicate_value", `${path}.referenceTaskIds`);
  }
  return {
    kind: TASK_LINEAGE_NODE_KIND,
    taskId: identifierAt(node.taskId, `${path}.taskId`),
    parentTaskId,
    parentMissing,
    ...(node.parentRoundId === undefined
      ? {}
      : {
          parentRoundId: identifierAt(
            node.parentRoundId,
            `${path}.parentRoundId`,
          ),
        }),
    referenceTaskIds,
    intent: enumAt(node.intent, TASK_LINEAGE_INTENT_SET, `${path}.intent`),
    status: enumAt(node.status, TASK_LINEAGE_STATUS_SET, `${path}.status`),
    requesterId: identifierAt(node.requesterId, `${path}.requesterId`),
    ...(node.assignedWorkerId === undefined
      ? {}
      : {
          assignedWorkerId: identifierAt(
            node.assignedWorkerId,
            `${path}.assignedWorkerId`,
          ),
        }),
    createdAt: timestampAt(node.createdAt, `${path}.createdAt`),
    depth: integerAt(
      node.depth,
      `${path}.depth`,
      0,
      TASK_LINEAGE_HARD_MAX_DEPTH,
    ),
  };
}

export function parseTaskLineageNodeV1(input: unknown): TaskLineageNodeV1 {
  return parseTaskLineageNodeAt(input, "$");
}

function parseTaskLineageChildAt(
  input: unknown,
  path: string,
): TaskLineageChildV1 {
  const child = objectAt(input, path);
  exactKeys(child, new Set(["kind", "node", "edges", "rejoin"]), path);
  if (child.kind !== TASK_LINEAGE_CHILD_KIND) {
    fail("invalid_enum", `${path}.kind`);
  }
  return {
    kind: TASK_LINEAGE_CHILD_KIND,
    node: parseTaskLineageNodeAt(child.node, `${path}.node`),
    edges: uniqueEnumArrayAt(
      child.edges,
      TASK_LINEAGE_EDGE_TYPE_SET,
      `${path}.edges`,
      TASK_LINEAGE_EDGE_TYPES.length,
    ),
    rejoin: booleanAt(child.rejoin, `${path}.rejoin`),
  };
}

export function parseTaskLineageChildV1(input: unknown): TaskLineageChildV1 {
  return parseTaskLineageChildAt(input, "$");
}

function parseTaskLineageChildrenAnchorAt(
  input: unknown,
  path: string,
): TaskLineageChildrenAnchorV1 {
  const anchor = objectAt(input, path);
  exactKeys(
    anchor,
    new Set(["kind", "taskId", "parentRoundId"]),
    path,
  );
  if (anchor.kind !== TASK_LINEAGE_CHILDREN_ANCHOR_KIND) {
    fail("invalid_enum", `${path}.kind`);
  }
  const taskId = optionalIdentifierAt(anchor.taskId, `${path}.taskId`);
  const parentRoundId = optionalIdentifierAt(
    anchor.parentRoundId,
    `${path}.parentRoundId`,
  );
  if (taskId && parentRoundId) fail("ambiguous_anchor", path);
  if (!taskId && !parentRoundId) fail("unknown_anchor", path);
  return taskId
    ? { kind: TASK_LINEAGE_CHILDREN_ANCHOR_KIND, taskId }
    : {
        kind: TASK_LINEAGE_CHILDREN_ANCHOR_KIND,
        parentRoundId: parentRoundId!,
      };
}

function parseTaskLineagePageAt(
  input: unknown,
  path: string,
): TaskLineagePageV1 {
  const page = objectAt(input, path);
  exactKeys(
    page,
    new Set(["kind", "limit", "returned", "nextCursor"]),
    path,
  );
  if (page.kind !== TASK_LINEAGE_PAGE_KIND) {
    fail("invalid_enum", `${path}.kind`);
  }
  const nextCursor =
    page.nextCursor === null
      ? null
      : stringAt(page.nextCursor, `${path}.nextCursor`, {
          max: TASK_LINEAGE_MAX_CURSOR_LENGTH,
        });
  if (nextCursor !== null) parseTaskLineageCursorV1(nextCursor);
  return {
    kind: TASK_LINEAGE_PAGE_KIND,
    limit: integerAt(page.limit, `${path}.limit`, 1, TASK_LINEAGE_MAX_LIMIT),
    returned: integerAt(
      page.returned,
      `${path}.returned`,
      0,
      TASK_LINEAGE_MAX_LIMIT,
    ),
    nextCursor,
  };
}

export function parseTaskLineagePaginationV1(
  input: unknown,
): TaskLineagePaginationV1 {
  const pagination = objectAt(input, "$");
  exactKeys(pagination, new Set(["kind", "limit", "cursor"]), "$");
  if (pagination.kind !== TASK_LINEAGE_PAGINATION_KIND) {
    fail("invalid_enum", "$.kind");
  }
  const cursor =
    pagination.cursor === undefined
      ? undefined
      : stringAt(pagination.cursor, "$.cursor", {
          max: TASK_LINEAGE_MAX_CURSOR_LENGTH,
        });
  if (cursor !== undefined) parseTaskLineageCursorV1(cursor);
  return {
    kind: TASK_LINEAGE_PAGINATION_KIND,
    limit: integerAt(
      pagination.limit,
      "$.limit",
      1,
      TASK_LINEAGE_MAX_LIMIT,
    ),
    ...(cursor ? { cursor } : {}),
  };
}

export function parseTaskLineagePageV1(input: unknown): TaskLineagePageV1 {
  return parseTaskLineagePageAt(input, "$");
}

function parseTaskLineageFiltersAt(
  input: unknown,
  path: string,
): TaskLineageFiltersV1 {
  const filters = objectAt(input, path);
  exactKeys(
    filters,
    new Set(["kind", "parentRoundId", "intent", "status", "since", "until"]),
    path,
  );
  if (filters.kind !== TASK_LINEAGE_FILTERS_KIND) {
    fail("invalid_enum", `${path}.kind`);
  }
  const since =
    filters.since === undefined
      ? undefined
      : timestampAt(filters.since, `${path}.since`, true);
  const until =
    filters.until === undefined
      ? undefined
      : timestampAt(filters.until, `${path}.until`, true);
  if (
    since !== undefined
    && until !== undefined
    && Date.parse(since) > Date.parse(until)
  ) {
    fail("invalid_timestamp", `${path}.until`);
  }
  return {
    kind: TASK_LINEAGE_FILTERS_KIND,
    ...(filters.parentRoundId === undefined
      ? {}
      : {
          parentRoundId: identifierAt(
            filters.parentRoundId,
            `${path}.parentRoundId`,
          ),
        }),
    ...(filters.intent === undefined
      ? {}
      : {
          intent: enumAt(
            filters.intent,
            TASK_LINEAGE_INTENT_SET,
            `${path}.intent`,
          ),
        }),
    ...(filters.status === undefined
      ? {}
      : {
          status: uniqueEnumArrayAt(
            filters.status,
            TASK_LINEAGE_STATUS_SET,
            `${path}.status`,
            TASK_LINEAGE_STATUSES.length,
          ).sort(),
        }),
    ...(since ? { since } : {}),
    ...(until ? { until } : {}),
  };
}

export function parseTaskLineageFiltersV1(
  input: unknown,
): TaskLineageFiltersV1 {
  return parseTaskLineageFiltersAt(input, "$");
}

function parseTaskLineageRoundCompletenessHintAt(
  input: unknown,
  path: string,
): TaskLineageRoundCompletenessHintV1 {
  const hint = objectAt(input, path);
  exactKeys(
    hint,
    new Set([
      "kind",
      "parentRoundId",
      "stampedTotal",
      "observedChildren",
      "complete",
    ]),
    path,
  );
  if (hint.kind !== TASK_LINEAGE_ROUND_HINT_KIND) {
    fail("invalid_enum", `${path}.kind`);
  }
  return {
    kind: TASK_LINEAGE_ROUND_HINT_KIND,
    parentRoundId: identifierAt(
      hint.parentRoundId,
      `${path}.parentRoundId`,
    ),
    stampedTotal: integerAt(
      hint.stampedTotal,
      `${path}.stampedTotal`,
      1,
    ),
    observedChildren: integerAt(
      hint.observedChildren,
      `${path}.observedChildren`,
      0,
    ),
    complete: booleanAt(hint.complete, `${path}.complete`),
  };
}

export function parseTaskLineageRoundCompletenessHintV1(
  input: unknown,
): TaskLineageRoundCompletenessHintV1 {
  return parseTaskLineageRoundCompletenessHintAt(input, "$");
}

function parseTaskLineageAnomalyAt(
  input: unknown,
  path: string,
): TaskLineageAnomalyV1 {
  const anomaly = objectAt(input, path);
  exactKeys(anomaly, new Set(["kind", "code", "count"]), path);
  if (anomaly.kind !== TASK_LINEAGE_ANOMALY_KIND) {
    fail("invalid_enum", `${path}.kind`);
  }
  return {
    kind: TASK_LINEAGE_ANOMALY_KIND,
    code: enumAt(
      anomaly.code,
      TASK_LINEAGE_ANOMALY_CODE_SET,
      `${path}.code`,
    ),
    count: integerAt(anomaly.count, `${path}.count`, 1),
  };
}

export function parseTaskLineageAnomalyV1(
  input: unknown,
): TaskLineageAnomalyV1 {
  return parseTaskLineageAnomalyAt(input, "$");
}

function parseTaskLineageDiagnosticsAt(
  input: unknown,
  path: string,
): TaskLineageDiagnosticsV1 {
  const diagnostics = objectAt(input, path);
  exactKeys(
    diagnostics,
    new Set([
      "kind",
      "source",
      "scannedVisibleTasks",
      "returnedNodes",
      "anomalies",
    ]),
    path,
  );
  if (
    diagnostics.kind !== TASK_LINEAGE_DIAGNOSTICS_KIND
    || diagnostics.source !== "task_record_read_projection"
  ) {
    fail("invalid_enum", `${path}.kind`);
  }
  const anomalies = arrayAt(
    diagnostics.anomalies,
    `${path}.anomalies`,
    { max: TASK_LINEAGE_MAX_DIAGNOSTIC_CODES },
  ).map((value, index) =>
    parseTaskLineageAnomalyAt(value, `${path}.anomalies[${index}]`),
  );
  const codes = anomalies.map((anomaly) => anomaly.code);
  if (new Set(codes).size !== codes.length) {
    fail("duplicate_value", `${path}.anomalies`);
  }
  return {
    kind: TASK_LINEAGE_DIAGNOSTICS_KIND,
    source: "task_record_read_projection",
    scannedVisibleTasks: integerAt(
      diagnostics.scannedVisibleTasks,
      `${path}.scannedVisibleTasks`,
      0,
    ),
    returnedNodes: integerAt(
      diagnostics.returnedNodes,
      `${path}.returnedNodes`,
      0,
      TASK_LINEAGE_MAX_LIMIT + 1,
    ),
    anomalies,
  };
}

export function parseTaskLineageDiagnosticsV1(
  input: unknown,
): TaskLineageDiagnosticsV1 {
  return parseTaskLineageDiagnosticsAt(input, "$");
}

export function parseTaskLineageChildrenV1(
  input: unknown,
): TaskLineageChildrenV1 {
  const result = objectAt(input, "$");
  exactKeys(
    result,
    new Set(["kind", "anchor", "children", "page", "round", "diagnostics"]),
    "$",
  );
  if (result.kind !== TASK_LINEAGE_CHILDREN_KIND) {
    fail("invalid_enum", "$.kind");
  }
  return {
    kind: TASK_LINEAGE_CHILDREN_KIND,
    anchor: parseTaskLineageChildrenAnchorAt(result.anchor, "$.anchor"),
    children: arrayAt(result.children, "$.children", {
      max: TASK_LINEAGE_MAX_LIMIT,
    }).map((value, index) =>
      parseTaskLineageChildAt(value, `$.children[${index}]`),
    ),
    page: parseTaskLineagePageAt(result.page, "$.page"),
    ...(result.round === undefined
      ? {}
      : {
          round: parseTaskLineageRoundCompletenessHintAt(
            result.round,
            "$.round",
          ),
        }),
    diagnostics: parseTaskLineageDiagnosticsAt(
      result.diagnostics,
      "$.diagnostics",
    ),
  };
}

export function parseTaskLineageLineageV1(
  input: unknown,
): TaskLineageLineageV1 {
  const result = objectAt(input, "$");
  exactKeys(
    result,
    new Set([
      "kind",
      "lineage",
      "truncated",
      "rootReached",
      "diagnostics",
    ]),
    "$",
  );
  if (result.kind !== TASK_LINEAGE_LINEAGE_KIND) {
    fail("invalid_enum", "$.kind");
  }
  return {
    kind: TASK_LINEAGE_LINEAGE_KIND,
    lineage: arrayAt(result.lineage, "$.lineage", {
      min: 1,
      max: TASK_LINEAGE_HARD_MAX_DEPTH + 1,
    }).map((value, index) =>
      parseTaskLineageNodeAt(value, `$.lineage[${index}]`),
    ),
    truncated: booleanAt(result.truncated, "$.truncated"),
    rootReached: booleanAt(result.rootReached, "$.rootReached"),
    diagnostics: parseTaskLineageDiagnosticsAt(
      result.diagnostics,
      "$.diagnostics",
    ),
  };
}

export function parseTaskLineageLeavesV1(
  input: unknown,
): TaskLineageLeavesV1 {
  const result = objectAt(input, "$");
  exactKeys(
    result,
    new Set(["kind", "filters", "leaves", "page", "diagnostics"]),
    "$",
  );
  if (result.kind !== TASK_LINEAGE_LEAVES_KIND) {
    fail("invalid_enum", "$.kind");
  }
  return {
    kind: TASK_LINEAGE_LEAVES_KIND,
    filters: parseTaskLineageFiltersAt(result.filters, "$.filters"),
    leaves: arrayAt(result.leaves, "$.leaves", {
      max: TASK_LINEAGE_MAX_LIMIT,
    }).map((value, index) =>
      parseTaskLineageNodeAt(value, `$.leaves[${index}]`),
    ),
    page: parseTaskLineagePageAt(result.page, "$.page"),
    diagnostics: parseTaskLineageDiagnosticsAt(
      result.diagnostics,
      "$.diagnostics",
    ),
  };
}

function storedIdentifier(value: unknown): string | undefined {
  return typeof value === "string" && IDENTIFIER_PATTERN.test(value)
    ? value
    : undefined;
}

function storedTimestamp(
  value: unknown,
): { value: string; epochMs: number } | undefined {
  if (
    typeof value !== "string"
    || value.length > 40
    || !RFC3339_PATTERN.test(value)
  ) {
    return undefined;
  }
  const epochMs = Date.parse(value);
  return Number.isFinite(epochMs) ? { value, epochMs } : undefined;
}

function increment(
  counts: Map<TaskLineageAnomalyCodeV1, number>,
  code: TaskLineageAnomalyCodeV1,
  amount = 1,
): void {
  if (amount <= 0) return;
  counts.set(code, (counts.get(code) ?? 0) + amount);
}

function indexedTaskFromRecord(
  task: TaskRecord,
  anomalies: Map<TaskLineageAnomalyCodeV1, number>,
): IndexedTask | undefined {
  const taskId = storedIdentifier(task.id);
  const createdAt = storedTimestamp(task.createdAt);
  const requesterId = storedIdentifier(task.requester?.id);
  if (
    !taskId
    || !createdAt
    || !requesterId
    || !TASK_LINEAGE_INTENT_SET.has(task.intent)
    || !TASK_LINEAGE_STATUS_SET.has(task.status)
  ) {
    increment(anomalies, "task_lineage.invalid_record");
    return undefined;
  }

  const parentRecorded = task.parentTaskId !== undefined;
  const parentTaskId = storedIdentifier(task.parentTaskId);
  const parentRoundId = storedIdentifier(task.parentRoundId);
  const parentRoundTotal =
    Number.isSafeInteger(task.parentRoundTotal)
    && (task.parentRoundTotal ?? 0) > 0
      ? task.parentRoundTotal
      : undefined;

  const references = Array.isArray(task.referenceTaskIds)
    ? task.referenceTaskIds
    : [];
  const referenceTaskIds: string[] = [];
  const seenReferences = new Set<string>();
  let invalidReferenceCount = 0;
  for (const reference of references) {
    const id = storedIdentifier(reference);
    if (!id) {
      invalidReferenceCount += 1;
      continue;
    }
    if (seenReferences.has(id)) {
      increment(anomalies, "task_lineage.duplicate_edge");
      continue;
    }
    seenReferences.add(id);
    referenceTaskIds.push(id);
  }

  return {
    task,
    taskId,
    createdAt: createdAt.value,
    createdAtMs: createdAt.epochMs,
    parentRecorded,
    ...(parentTaskId ? { parentTaskId } : {}),
    ...(parentRoundId ? { parentRoundId } : {}),
    ...(parentRoundTotal ? { parentRoundTotal } : {}),
    referenceTaskIds,
    invalidReferenceCount,
  };
}

function compareIndexedTask(left: IndexedTask, right: IndexedTask): number {
  if (left.createdAtMs !== right.createdAtMs) {
    return left.createdAtMs - right.createdAtMs;
  }
  return left.taskId < right.taskId
    ? -1
    : left.taskId > right.taskId
      ? 1
      : 0;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function queryHash(value: Record<string, unknown>): string {
  return sha256(JSON.stringify(value));
}

function encodeCursor(
  query: string,
  task: IndexedTask,
): string {
  const value: TaskLineageCursorV1 = {
    kind: TASK_LINEAGE_CURSOR_KIND,
    queryHash: query,
    createdAt: task.createdAt,
    taskIdHash: sha256(task.taskId),
  };
  return `tl1.${Buffer.from(JSON.stringify(value), "utf8").toString("base64url")}`;
}

function paginate<T>(
  values: T[],
  pagination: TaskLineagePaginationV1,
  query: string,
  taskFor: (value: T) => IndexedTask,
): PageSlice<T> {
  let start = 0;
  if (pagination.cursor) {
    const cursor = parseTaskLineageCursorV1(pagination.cursor);
    if (cursor.queryHash !== query) {
      fail("cursor_mismatch", "$.cursor");
    }
    const cursorIndex = values.findIndex((value) => {
      const task = taskFor(value);
      return (
        task.createdAt === cursor.createdAt
        && sha256(task.taskId) === cursor.taskIdHash
      );
    });
    if (cursorIndex < 0) {
      fail("cursor_position_unavailable", "$.cursor");
    }
    start = cursorIndex + 1;
  }
  const end = Math.min(values.length, start + pagination.limit);
  const items = values.slice(start, end);
  const last = items.at(-1);
  return {
    items,
    page: {
      kind: TASK_LINEAGE_PAGE_KIND,
      limit: pagination.limit,
      returned: items.length,
      nextCursor:
        end < values.length && last
          ? encodeCursor(query, taskFor(last))
          : null,
    },
  };
}

function notFound(): never {
  // Hidden and absent anchors intentionally share one bounded error.
  throw new BrokerError("not_found", "task not found");
}

/**
 * Build one ephemeral projection from the caller's already-authorized task
 * snapshot. Inaccessible tasks must be removed before calling this function.
 */
export function buildTaskLineageReadProjection(
  tasks: readonly TaskRecord[],
): TaskLineageReadProjectionV1 {
  const anomalies = new Map<TaskLineageAnomalyCodeV1, number>();
  const byId = new Map<string, IndexedTask>();

  for (const task of tasks) {
    const indexed = indexedTaskFromRecord(task, anomalies);
    if (!indexed) continue;
    if (byId.has(indexed.taskId)) {
      increment(anomalies, "task_lineage.duplicate_task_record");
      continue;
    }
    byId.set(indexed.taskId, indexed);
  }

  const childEdgesByTask = new Map<
    string,
    Map<string, Set<TaskLineageEdgeTypeV1>>
  >();
  const roundChildren = new Map<string, IndexedTask[]>();
  const tasksWithVisibleChildren = new Set<string>();

  const addChildEdge = (
    anchorTaskId: string,
    child: IndexedTask,
    edge: TaskLineageEdgeTypeV1,
  ): void => {
    let children = childEdgesByTask.get(anchorTaskId);
    if (!children) {
      children = new Map();
      childEdgesByTask.set(anchorTaskId, children);
    }
    let edges = children.get(child.taskId);
    if (!edges) {
      edges = new Set();
      children.set(child.taskId, edges);
    }
    edges.add(edge);
    tasksWithVisibleChildren.add(anchorTaskId);
  };

  for (const task of byId.values()) {
    if (task.parentRecorded) {
      if (task.parentTaskId && byId.has(task.parentTaskId)) {
        addChildEdge(task.parentTaskId, task, "canonical_parent");
      } else {
        increment(anomalies, "task_lineage.parent_missing");
      }
    }

    increment(
      anomalies,
      "task_lineage.reference_unavailable",
      task.invalidReferenceCount,
    );
    for (const referenceTaskId of task.referenceTaskIds) {
      if (!byId.has(referenceTaskId)) {
        increment(anomalies, "task_lineage.reference_unavailable");
        continue;
      }
      addChildEdge(referenceTaskId, task, "reference");
      if (referenceTaskId === task.parentTaskId) {
        increment(anomalies, "task_lineage.duplicate_edge");
      }
    }

    if (task.parentRoundId) {
      const children = roundChildren.get(task.parentRoundId) ?? [];
      children.push(task);
      roundChildren.set(task.parentRoundId, children);
    }

    const visibleReferenceCount = task.referenceTaskIds.reduce(
      (count, id) => count + (byId.has(id) ? 1 : 0),
      0,
    );
    if (visibleReferenceCount > TASK_LINEAGE_MAX_REFERENCE_IDS_PER_NODE) {
      increment(anomalies, "task_lineage.reference_output_truncated");
    }
  }

  // Resolve every visible canonical-parent component once. A task is marked
  // cycle-reachable when its own ancestry eventually enters a cycle, including
  // cycles beyond the response maxDepth. Query-time lineage can then fail in
  // O(1) without an unbounded traversal or a per-item store read.
  const canonicalCycleReachable = new Set<string>();
  const canonicalCycleResolution = new Map<string, boolean>();
  for (const start of byId.values()) {
    if (canonicalCycleResolution.has(start.taskId)) continue;
    const path: IndexedTask[] = [];
    const positions = new Map<string, number>();
    let current: IndexedTask | undefined = start;
    let reachesCycle = false;
    while (current) {
      const resolved = canonicalCycleResolution.get(current.taskId);
      if (resolved !== undefined) {
        reachesCycle = resolved;
        break;
      }
      if (positions.has(current.taskId)) {
        reachesCycle = true;
        break;
      }
      positions.set(current.taskId, path.length);
      path.push(current);
      current =
        current.parentTaskId && byId.has(current.parentTaskId)
          ? byId.get(current.parentTaskId)
          : undefined;
    }
    for (const task of path) {
      canonicalCycleResolution.set(task.taskId, reachesCycle);
      if (reachesCycle) canonicalCycleReachable.add(task.taskId);
    }
  }

  const nodeFor = (task: IndexedTask, depth: number): TaskLineageNodeV1 => {
    const visibleParent =
      task.parentTaskId && byId.has(task.parentTaskId)
        ? task.parentTaskId
        : undefined;
    const visibleReferences = task.referenceTaskIds
      .filter((id) => byId.has(id))
      .slice(0, TASK_LINEAGE_MAX_REFERENCE_IDS_PER_NODE);
    return {
      kind: TASK_LINEAGE_NODE_KIND,
      taskId: task.taskId,
      parentTaskId: visibleParent ?? null,
      parentMissing: task.parentRecorded && !visibleParent,
      ...(task.parentRoundId ? { parentRoundId: task.parentRoundId } : {}),
      referenceTaskIds: visibleReferences,
      intent: task.task.intent,
      status: task.task.status,
      requesterId: task.task.requester.id,
      ...(storedIdentifier(task.task.assignedWorkerId)
        ? { assignedWorkerId: task.task.assignedWorkerId }
        : {}),
      createdAt: task.createdAt,
      depth,
    };
  };

  const isRejoin = (task: IndexedTask): boolean =>
    Boolean(
      task.parentTaskId
      && byId.has(task.parentTaskId)
      && task.referenceTaskIds.some(
        (reference) =>
          reference !== task.parentTaskId && byId.has(reference),
      ),
    );

  const diagnosticsFor = (
    returnedNodes: number,
    extra: ReadonlyMap<TaskLineageAnomalyCodeV1, number> = new Map(),
  ): TaskLineageDiagnosticsV1 => {
    const merged = new Map(anomalies);
    for (const [code, count] of extra) increment(merged, code, count);
    const safeAnomalies = [...merged.entries()]
      .filter(([, count]) => count > 0)
      .sort(([left], [right]) =>
        left < right ? -1 : left > right ? 1 : 0,
      )
      .slice(0, TASK_LINEAGE_MAX_DIAGNOSTIC_CODES)
      .map(([code, count]): TaskLineageAnomalyV1 => ({
        kind: TASK_LINEAGE_ANOMALY_KIND,
        code,
        count: Math.min(Number.MAX_SAFE_INTEGER, count),
      }));
    return {
      kind: TASK_LINEAGE_DIAGNOSTICS_KIND,
      source: "task_record_read_projection",
      scannedVisibleTasks: byId.size,
      returnedNodes,
      anomalies: safeAnomalies,
    };
  };

  const roundHintFor = (
    children: IndexedTask[],
  ): {
    hint?: TaskLineageRoundCompletenessHintV1;
    anomalies: Map<TaskLineageAnomalyCodeV1, number>;
  } => {
    const roundAnomalies = new Map<TaskLineageAnomalyCodeV1, number>();
    if (children.length === 0) return { anomalies: roundAnomalies };
    const roundIds = new Set(
      children
        .map((child) => child.parentRoundId)
        .filter((value): value is string => Boolean(value)),
    );
    if (roundIds.size !== 1 || children.some((child) => !child.parentRoundId)) {
      return { anomalies: roundAnomalies };
    }
    const totals = new Set(
      children
        .map((child) => child.parentRoundTotal)
        .filter((value): value is number => value !== undefined),
    );
    if (totals.size > 1) {
      increment(roundAnomalies, "task_lineage.round_total_conflict");
      return { anomalies: roundAnomalies };
    }
    if (
      totals.size !== 1
      || children.some((child) => child.parentRoundTotal === undefined)
    ) {
      increment(roundAnomalies, "task_lineage.round_total_unavailable");
      return { anomalies: roundAnomalies };
    }
    const parentRoundId = [...roundIds][0]!;
    const stampedTotal = [...totals][0]!;
    return {
      hint: {
        kind: TASK_LINEAGE_ROUND_HINT_KIND,
        parentRoundId,
        stampedTotal,
        observedChildren: children.length,
        complete: children.length === stampedTotal,
      },
      anomalies: roundAnomalies,
    };
  };

  return {
    children(
      request: TaskLineageChildrenRequestV1,
    ): TaskLineageChildrenV1 {
      const normalizedRequest = parseTaskLineageChildrenRequestV1({
        ...("taskId" in request.anchor
          ? { taskId: request.anchor.taskId }
          : { parentRoundId: request.anchor.parentRoundId }),
        limit: request.pagination.limit,
        ...(request.pagination.cursor
          ? { cursor: request.pagination.cursor }
          : {}),
      });

      let candidates: Array<{
        task: IndexedTask;
        edges: TaskLineageEdgeTypeV1[];
      }>;
      if ("taskId" in normalizedRequest.anchor) {
        const anchor = byId.get(normalizedRequest.anchor.taskId);
        if (!anchor) notFound();
        const direct = childEdgesByTask.get(anchor.taskId) ?? new Map();
        candidates = [...direct.entries()].map(([taskId, edges]) => ({
          task: byId.get(taskId)!,
          edges: TASK_LINEAGE_EDGE_TYPES.filter((edge) => edges.has(edge)),
        }));
      } else {
        const stamped = roundChildren.get(
          normalizedRequest.anchor.parentRoundId,
        );
        if (!stamped) notFound();
        candidates = stamped.map((task) => ({
          task,
          edges: ["round_stamp"],
        }));
      }
      candidates.sort((left, right) =>
        compareIndexedTask(left.task, right.task),
      );

      const query = queryHash({
        method: "tasks/children",
        anchor: normalizedRequest.anchor,
        limit: normalizedRequest.pagination.limit,
      });
      const paged = paginate(
        candidates,
        normalizedRequest.pagination,
        query,
        (value) => value.task,
      );
      const round = roundHintFor(candidates.map((candidate) => candidate.task));
      return parseTaskLineageChildrenV1({
        kind: TASK_LINEAGE_CHILDREN_KIND,
        anchor: normalizedRequest.anchor,
        children: paged.items.map(
          ({ task, edges }): TaskLineageChildV1 => ({
            kind: TASK_LINEAGE_CHILD_KIND,
            node: nodeFor(task, 1),
            edges,
            rejoin: isRejoin(task),
          }),
        ),
        page: paged.page,
        ...(round.hint ? { round: round.hint } : {}),
        diagnostics: diagnosticsFor(paged.items.length, round.anomalies),
      });
    },

    lineage(
      request: TaskLineageLineageRequestV1,
    ): TaskLineageLineageV1 {
      const normalizedRequest = parseTaskLineageLineageRequestV1({
        taskId: request.taskId,
        maxDepth: request.maxDepth,
      });
      const anchor = byId.get(normalizedRequest.taskId);
      if (!anchor) notFound();
      if (canonicalCycleReachable.has(anchor.taskId)) {
        throw new TaskLineageCycleError();
      }

      const lineage: TaskLineageNodeV1[] = [];
      let current: IndexedTask | undefined = anchor;
      let depth = 0;
      let truncated = false;
      let rootReached = false;
      while (current) {
        lineage.push(nodeFor(current, depth));
        if (!current.parentRecorded) {
          rootReached = true;
          break;
        }
        if (!current.parentTaskId || !byId.has(current.parentTaskId)) {
          break;
        }
        if (depth >= normalizedRequest.maxDepth) {
          truncated = true;
          break;
        }
        current = byId.get(current.parentTaskId);
        depth += 1;
      }

      return parseTaskLineageLineageV1({
        kind: TASK_LINEAGE_LINEAGE_KIND,
        lineage,
        truncated,
        rootReached,
        diagnostics: diagnosticsFor(lineage.length),
      });
    },

    leaves(
      request: TaskLineageLeavesRequestV1,
    ): TaskLineageLeavesV1 {
      const normalizedRequest = parseTaskLineageLeavesRequestV1({
        ...(request.filters.parentRoundId
          ? { parentRoundId: request.filters.parentRoundId }
          : {}),
        ...(request.filters.intent
          ? { intent: request.filters.intent }
          : {}),
        ...(request.filters.status
          ? { status: request.filters.status }
          : {}),
        ...(request.filters.since ? { since: request.filters.since } : {}),
        ...(request.filters.until ? { until: request.filters.until } : {}),
        limit: request.pagination.limit,
        ...(request.pagination.cursor
          ? { cursor: request.pagination.cursor }
          : {}),
      });
      const statusSet = normalizedRequest.filters.status
        ? new Set(normalizedRequest.filters.status)
        : undefined;
      const sinceMs = normalizedRequest.filters.since
        ? Date.parse(normalizedRequest.filters.since)
        : undefined;
      const untilMs = normalizedRequest.filters.until
        ? Date.parse(normalizedRequest.filters.until)
        : undefined;

      const candidates = [...byId.values()]
        .filter((task) => !tasksWithVisibleChildren.has(task.taskId))
        .filter(
          (task) =>
            !normalizedRequest.filters.parentRoundId
            || task.parentRoundId ===
              normalizedRequest.filters.parentRoundId,
        )
        .filter(
          (task) =>
            !normalizedRequest.filters.intent
            || task.task.intent === normalizedRequest.filters.intent,
        )
        .filter((task) => !statusSet || statusSet.has(task.task.status))
        .filter(
          (task) => sinceMs === undefined || task.createdAtMs >= sinceMs,
        )
        .filter(
          (task) => untilMs === undefined || task.createdAtMs <= untilMs,
        )
        .sort(compareIndexedTask);

      const query = queryHash({
        method: "tasks/leaves",
        filters: normalizedRequest.filters,
        limit: normalizedRequest.pagination.limit,
      });
      const paged = paginate(
        candidates,
        normalizedRequest.pagination,
        query,
        (task) => task,
      );
      return parseTaskLineageLeavesV1({
        kind: TASK_LINEAGE_LEAVES_KIND,
        filters: normalizedRequest.filters,
        leaves: paged.items.map((task) => nodeFor(task, 0)),
        page: paged.page,
        diagnostics: diagnosticsFor(paged.items.length),
      });
    },
  };
}
