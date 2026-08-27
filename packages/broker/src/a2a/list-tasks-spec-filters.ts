import { BrokerError } from "../core/broker.js";

/**
 * Spec-path ListTasks filter vocabulary (#1912 D2, slice 1 of #1997).
 *
 * The v1.0.1 proto defines exactly eight request fields for ListTasks
 * (`tenant`, `context_id`, `status`, `page_size`, `page_token`,
 * `history_length`, `status_timestamp_after`, `include_artifacts`). This parser
 * accepts precisely that surface — in both ProtoJSON casings — and fails closed
 * on anything else:
 *
 *  - unknown keys reject instead of dropping silently (the audit's core
 *    complaint about the old behavior, also fixed for `tenant` in #1924);
 *  - `pageSize`, non-empty `pageToken`, and `statusTimestampAfter` are part of
 *    the bounded-pagination contract (D3) and land with its cursor slice, not
 *    before (#1997 slice 2). An empty token is the proto default "first page"
 *    and stays acceptable;
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

export interface SpecTaskListFilters {
  /** Conversation constraint (proto `context_id`) mapped onto the internal field. */
  exchangeId?: string;
  /**
   * Requested status in **projected** spelling. Absent means no constraint,
   * including an explicitly sent `TASK_STATE_UNSPECIFIED` (proto enum zero).
   */
  specStatus?: ProjectedSpecState;
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

export function parseSpecListTaskFilters(params: unknown): SpecTaskListFilters {
  if (params === undefined || params === null || params === "") {
    return {};
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

  // --- bounded pagination contract (D3) arrives with #1997 slice 2 -------------
  const pageSize = readField(record, "pageSize");
  if (pageSize.present) {
    badRequest(
      `ListTasks ${pageSize.spelling} is not yet honored: bounded pagination lands with #1997 slice 2 (#1912 D3)`,
    );
  }

  const pageToken = readField(record, "pageToken");
  if (pageToken.present) {
    // "" never reaches here (empty string reads as unset); anything real needs cursors.
    badRequest(
      `non-empty ListTasks ${pageToken.spelling} is not yet honored: resync cursors land with #1997 slice 2 (#1912 D3)`,
    );
  }

  const statusAfter = readField(record, "statusTimestampAfter");
  if (statusAfter.present) {
    badRequest(
      `ListTasks ${statusAfter.spelling} is not yet honored: timestamp filtering lands with #1997 slice 2 (#1912 D2/D3 follow-up)`,
    );
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
  };
}
