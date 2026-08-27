import { BrokerError } from "../core/broker.js";
import type { TaskRecord } from "../core/types.js";
import { a2aStatusTimestamp } from "./task-projection.js";

/**
 * Spec-path ListTasks filter vocabulary + bounded pagination
 * (#1912 D2+D3, slices 1–2 of #1997).
 *
 * The v1.0.1 proto defines exactly eight request fields for ListTasks
 * (`tenant`, `context_id`, `status`, `page_size`, `page_token`,
 * `history_length`, `status_timestamp_after`, `include_artifacts`). This parser
 * accepts precisely that surface — in both ProtoJSON casings — and fails closed
 * on anything else:
 *
 *  - unknown keys reject instead of dropping silently (the audit's core
 *    complaint about the old behavior, also fixed for `tenant` in #1924);
 *  - `pageSize` defaults to 50 when unspecified and clamps to the documented
 *    maximum of 100: the server may return fewer than requested, never more
 *    than the maximum. Values below the minimum of 1 (0, negatives,
 *    non-integers, non-numbers) reject;
 *  - `pageToken` is an opaque, checksummed cursor bound to the exact filter
 *    scope it was issued under. Forged, tampered, stale, or scope-mismatched
 *    tokens reject with -32602. An empty token is the proto default "first
 *    page" and stays acceptable;
 *  - `statusTimestampAfter` filters inclusively (>=) on the projected status
 *    timestamp; a value that is not a parseable timestamp rejects;
 *  - `historyLength` caps per-task history messages. The broker's projection
 *    carries no per-task history at all, so every valid value is honored
 *    trivially and we accept it outright;
 *  - `includeArtifacts` is accepted for both values, but artifact elision for
 *    `false` is still the documented D4 gap — responses keep artifacts until
 *    D4 lands (recorded in protocol-compatibility.md);
 *  - `status` must be the normative `TASK_STATE_*` spelling. Matching happens
 *    against the **projected** state (see mapTaskState in task-projection.ts),
 *    so a running task paused on an operator checkpoint correctly satisfies
 *    TASK_STATE_INPUT_REQUIRED rather than TASK_STATE_WORKING.
 *
 * The headerless legacy envelope keeps its own historical parser
 * (`parseListTaskFilters` in json-rpc.ts); this module never runs for it.
 */

/**
 * The projected-state spellings used by `projectBrokerTask().status.state`.
 * Kept as a local union: it mirrors the projection types without importing
 * them, and the test suite pins every row of the mapping table.
 */
type ProjectedSpecState =
  | "submitted"
  | "working"
  | "completed"
  | "failed"
  | "canceled"
  | "input-required"
  | "auth-required"
  | "rejected";

const SPEC_STATUS_TO_PROJECTED: Readonly<Record<string, ProjectedSpecState>> = {
  TASK_STATE_SUBMITTED: "submitted",
  TASK_STATE_WORKING: "working",
  TASK_STATE_COMPLETED: "completed",
  TASK_STATE_FAILED: "failed",
  TASK_STATE_CANCELED: "canceled",
  TASK_STATE_INPUT_REQUIRED: "input-required",
  TASK_STATE_AUTH_REQUIRED: "auth-required",
  TASK_STATE_REJECTED: "rejected",
};

/**
 * Canonical field -> every wire spelling that may carry it. ProtoJSON parsers
 * accept both lowerCamelCase and the proto field name; listing both keeps a
 * snake_case client's `page_size` from silently reading as an unset pageSize.
 */
const FIELD_SOURCES: Readonly<Record<string, readonly string[]>> = {
  tenant: ["tenant"],
  contextId: ["contextId", "context_id"],
  status: ["status"],
  pageSize: ["pageSize", "page_size"],
  pageToken: ["pageToken", "page_token"],
  historyLength: ["historyLength", "history_length"],
  statusTimestampAfter: ["statusTimestampAfter", "status_timestamp_after"],
  includeArtifacts: ["includeArtifacts", "include_artifacts"],
};

/** Keys the spec path understands at all; everything else rejects by name. */
const VALID_SPEC_KEYS: ReadonlySet<string> = new Set(
  Object.values(FIELD_SOURCES).flat(),
);

export const SPEC_PAGE_SIZE_DEFAULT = 50;
export const SPEC_PAGE_SIZE_MAX = 100;

export interface DecodedListCursor {
  /** id of the last task on the previously returned page. */
  lastId: string;
  /** projected status timestamp of that task (the D11 ordering key). */
  lastStatusTimestamp: string;
  /** fingerprint of the filter scope the cursor was issued under. */
  scopeKey: string;
}

export interface SpecTaskListFilters {
  /** Conversation constraint (proto `context_id`) mapped onto the internal field. */
  exchangeId?: string;
  /**
   * Requested status in **projected** spelling. Absent means no constraint,
   * including an explicitly sent `TASK_STATE_UNSPECIFIED` (proto enum zero).
   */
  specStatus?: ProjectedSpecState;
  /** Bounded page size (1..100, default 50) — the spec path is always paged. */
  pageSize?: number;
  /** Validated continuation cursor, when a non-empty pageToken was supplied. */
  cursor?: DecodedListCursor;
  /** Inclusive lower bound (epoch ms) on the projected status timestamp. */
  statusTimestampAfterMs?: number;
  /** Fingerprint of the filter scope this query (and its cursors) belongs to. */
  scopeKey?: string;
}

interface FieldRead {
  present: boolean;
  /** Casing actually used on the wire, for precise error text. */
  spelling?: string;
  value?: unknown;
}

function readField(record: Record<string, unknown>, canonicalKey: string): FieldRead {
  for (const spelling of FIELD_SOURCES[canonicalKey]) {
    const value = record[spelling];
    if (value !== undefined && value !== null && value !== "") {
      return { present: true, spelling, value };
    }
  }
  return { present: false };
}

function badRequest(message: string): never {
  throw new BrokerError("bad_request", message);
}

/** Small non-cryptographic fingerprint for cursor integrity and scope binding. */
function fnv1a32(input: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

/** Fingerprint of the filter context a cursor belongs to. */
function scopeKeyFor(parts: {
  contextId?: string;
  specStatus?: string;
  statusTimestampAfterMs?: number;
}): string {
  return fnv1a32(
    JSON.stringify([
      parts.contextId ?? null,
      parts.specStatus ?? null,
      parts.statusTimestampAfterMs ?? null,
    ]),
  );
}

export function encodeListCursor(cursor: DecodedListCursor): string {
  const payload = JSON.stringify({
    v: 1,
    i: cursor.lastId,
    t: cursor.lastStatusTimestamp,
    f: cursor.scopeKey,
  });
  return `${Buffer.from(payload, "utf8").toString("base64url")}.${fnv1a32(payload)}`;
}

function decodeListCursor(token: string, expectedScopeKey: string): DecodedListCursor {
  const reject = (): never =>
    badRequest(
      "ListTasks pageToken is not a valid cursor for this query: request a fresh first page (tokens are opaque, checksummed, scope-bound, and expire when their task leaves the result)",
    );
  const dot = token.lastIndexOf(".");
  if (dot <= 0 || dot === token.length - 1) reject();
  const encoded = token.slice(0, dot);
  const checksum = token.slice(dot + 1);
  const payload = (() => {
    try {
      return Buffer.from(encoded, "base64url").toString("utf8");
    } catch {
      return reject();
    }
  })();
  // Integrity: the checksum must match the payload exactly, so a tampered or
  // hand-crafted token fails closed before any field is interpreted.
  if (fnv1a32(payload) !== checksum) reject();
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    reject();
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    (parsed as Record<string, unknown>).v !== 1 ||
    typeof (parsed as Record<string, unknown>).i !== "string" ||
    typeof (parsed as Record<string, unknown>).t !== "string" ||
    typeof (parsed as Record<string, unknown>).f !== "string"
  ) {
    reject();
  }
  const decoded = parsed as { v: number; i: string; t: string; f: string };
  if (decoded.f !== expectedScopeKey) {
    badRequest(
      "ListTasks pageToken belongs to a different query scope: cursors cannot be reused across differing filters",
    );
  }
  return { lastId: decoded.i, lastStatusTimestamp: decoded.t, scopeKey: decoded.f };
}

export function parseSpecListTaskFilters(params: unknown): SpecTaskListFilters {
  if (params === undefined || params === null || params === "") {
    return { pageSize: SPEC_PAGE_SIZE_DEFAULT };
  }
  if (typeof params !== "object" || Array.isArray(params)) {
    badRequest("params must be an object");
  }
  const record = params as Record<string, unknown>;

  // Reject anything outside the pinned v1.0.1 vocabulary before interpreting
  // any value, so a misspelled internal-only key cannot be half-honored.
  for (const key of Object.keys(record)) {
    if (!VALID_SPEC_KEYS.has(key)) {
      badRequest(
        `unknown ListTasks parameter '${key}': the A2A v1.0 spec-path accepts only ` +
          "tenant, contextId, status, pageSize, pageToken, historyLength, statusTimestampAfter, includeArtifacts " +
          "(internal-vocabulary filters like targetNodeId/claimedBy live only behind the headerless legacy envelope)",
      );
    }
  }

  // --- status -----------------------------------------------------------------
  let specStatus: ProjectedSpecState | undefined;
  let rawStatusValue: string | undefined;
  const status = readField(record, "status");
  if (status.present) {
    if (typeof status.value !== "string") {
      badRequest("status must be a TASK_STATE_* string");
    }
    if (status.value === "TASK_STATE_UNSPECIFIED") {
      // Enum zero: no constraint, same as omitting the field.
      specStatus = undefined;
    } else {
      const projected = SPEC_STATUS_TO_PROJECTED[status.value];
      if (!projected) {
        badRequest(
          `unsupported status '${status.value}': the spec path requires the normative ` +
            "TASK_STATE_* vocabulary (e.g. TASK_STATE_WORKING), not internal broker states",
        );
      }
      specStatus = projected;
      rawStatusValue = status.value;
    }
  }

  // --- conversation -----------------------------------------------------------
  let exchangeId: string | undefined;
  const contextId = readField(record, "contextId");
  if (contextId.present) {
    if (typeof contextId.value !== "string") {
      badRequest("contextId must be a string");
    }
    exchangeId = contextId.value;
  }

  // --- bounded pagination (D3) ------------------------------------------------
  let pageSize = SPEC_PAGE_SIZE_DEFAULT;
  const pageSizeField = readField(record, "pageSize");
  if (pageSizeField.present) {
    if (
      typeof pageSizeField.value !== "number" ||
      !Number.isInteger(pageSizeField.value) ||
      pageSizeField.value < 1
    ) {
      badRequest(
        `ListTasks ${pageSizeField.spelling} must be an integer >= 1 (the proto minimum); values above ${SPEC_PAGE_SIZE_MAX} clamp`,
      );
    }
    pageSize = Math.min(pageSizeField.value, SPEC_PAGE_SIZE_MAX);
  }

  // The scope key must be computed before decoding a token so a cursor can be
  // bound to exactly the filters it was issued with.
  let statusTimestampAfterMs: number | undefined;
  const statusAfter = readField(record, "statusTimestampAfter");
  if (statusAfter.present) {
    if (typeof statusAfter.value !== "string") {
      badRequest(
        `ListTasks ${statusAfter.spelling} must be an RFC 3339 timestamp string (e.g. "2026-08-21T10:00:00Z")`,
      );
    }
    const parsedMs = Date.parse(statusAfter.value);
    if (Number.isNaN(parsedMs)) {
      badRequest(
        `ListTasks ${statusAfter.spelling} is not a parseable timestamp: '${statusAfter.value}'`,
      );
    }
    statusTimestampAfterMs = parsedMs;
  }

  const scopeKey = scopeKeyFor({
    contextId: exchangeId,
    specStatus: rawStatusValue,
    statusTimestampAfterMs,
  });

  let cursor: DecodedListCursor | undefined;
  const pageToken = readField(record, "pageToken");
  if (pageToken.present) {
    if (typeof pageToken.value !== "string") {
      badRequest(`ListTasks ${pageToken.spelling} must be a string`);
    }
    cursor = decodeListCursor(pageToken.value, scopeKey);
  }

  // --- per-task history cap ---------------------------------------------------
  const historyLength = readField(record, "historyLength");
  if (historyLength.present) {
    if (
      typeof historyLength.value !== "number" ||
      !Number.isInteger(historyLength.value) ||
      historyLength.value < 0
    ) {
      badRequest(`ListTasks ${historyLength.spelling} must be a non-negative integer`);
    }
    // Valid values are honored trivially: projections carry zero per-task
    // history messages, which already satisfies any cap.
  }

  // --- artifacts --------------------------------------------------------------
  const includeArtifacts = readField(record, "includeArtifacts");
  if (includeArtifacts.present) {
    if (typeof includeArtifacts.value !== "boolean") {
      badRequest(`ListTasks ${includeArtifacts.spelling} must be a boolean`);
    }
    // Both values accepted; elision for false remains the documented D4 gap.
  }

  return {
    ...(exchangeId ? { exchangeId } : {}),
    ...(specStatus ? { specStatus } : {}),
    pageSize,
    scopeKey,
    ...(cursor ? { cursor } : {}),
    ...(statusTimestampAfterMs !== undefined ? { statusTimestampAfterMs } : {}),
  };
}

/**
 * Slice the sorted, fully-matched task list into the requested page and build
 * the continuation token. Returns the page plus the next token ("" on the last
 * page). `cursor` seek fails closed when its anchor task is no longer in the
 * result — the client re-queries from the first page.
 */
export function pageSpecTasks(
  sorted: TaskRecord[],
  filters: SpecTaskListFilters,
): { page: TaskRecord[]; nextPageToken: string } {
  const pageSize = filters.pageSize ?? SPEC_PAGE_SIZE_DEFAULT;
  let start = 0;
  if (filters.cursor) {
    const cursor = filters.cursor;
    const anchor = sorted.findIndex(
      (task) =>
        task.id === cursor.lastId &&
        a2aStatusTimestamp(task) === cursor.lastStatusTimestamp,
    );
    if (anchor === -1) {
      badRequest(
        "ListTasks pageToken no longer matches any task in this query's result (stale cursor): re-query from the first page",
      );
    }
    start = anchor + 1;
  }
  const page = sorted.slice(start, start + pageSize);
  const hasMore = start + page.length < sorted.length;
  const last = page[page.length - 1];
  const nextPageToken =
    hasMore && last
      ? encodeListCursor({
          lastId: last.id,
          lastStatusTimestamp: a2aStatusTimestamp(last),
          scopeKey: filters.scopeKey ?? "",
        })
      : "";
  return { page, nextPageToken };
}
