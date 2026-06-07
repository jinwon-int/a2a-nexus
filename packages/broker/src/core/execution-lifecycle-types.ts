/**
 * Type definitions for broker remote execution lifecycle and result reconciliation.
 *
 * Models the wake-to-work lifecycle from session readiness through completion:
 *   wake_requested → session_ready → payload_delivered → running → result_reported/failed/timeout
 *
 * Built on top of Round 20 wake audit. Execution state is tracked per-run
 * with lease/timeout semantics. Result artifacts are redacted and structured
 * for closeout reconciliation.
 */

// ---------------------------------------------------------------------------
// Execution states
// ---------------------------------------------------------------------------

export type ExecutionStatus =
  | "wake_requested"
  | "session_ready"
  | "payload_delivered"
  | "running"
  | "result_reported"
  | "failed"
  | "timeout"
  | "cancelled";

export const EXECUTION_TRANSITIONS: Record<
  ExecutionStatus,
  ReadonlySet<ExecutionStatus>
> = {
  wake_requested: new Set(["session_ready", "failed", "timeout", "cancelled"]),
  session_ready: new Set(["payload_delivered", "failed", "timeout", "cancelled"]),
  payload_delivered: new Set(["running", "failed", "timeout", "cancelled"]),
  running: new Set(["result_reported", "failed", "timeout", "cancelled"]),
  result_reported: new Set(),
  failed: new Set(["wake_requested", "session_ready"]),
  timeout: new Set(["wake_requested", "session_ready", "cancelled"]),
  cancelled: new Set(),
};

// ---------------------------------------------------------------------------
// Failure / timeout codes
// ---------------------------------------------------------------------------

export type ExecutionFailureCode =
  | "peer_unreachable"
  | "session_expired"
  | "payload_too_large"
  | "delivery_failed"
  | "runtime_error"
  | "result_parse_error"
  | "auth_failed"
  | "rate_limited"
  | "lease_expired"
  | "execution_timeout"
  | "cancelled_by_operator"
  | "duplicate_payload_suppressed"
  | "other";

export const EXECUTION_FAILURE_CODES = [
  "peer_unreachable",
  "session_expired",
  "payload_too_large",
  "delivery_failed",
  "runtime_error",
  "result_parse_error",
  "auth_failed",
  "rate_limited",
  "lease_expired",
  "execution_timeout",
  "cancelled_by_operator",
  "duplicate_payload_suppressed",
  "other",
] as const satisfies readonly ExecutionFailureCode[];

// ---------------------------------------------------------------------------
// Retryability classification (issue #838)
// ---------------------------------------------------------------------------

/**
 * Whether an execution failure code is classified as retryable.
 *
 * Retryable = transient infrastructure failure that may resolve on a fresh
 * attempt with a new session/workspace. Non-retryable = permanent or semantic
 * failure that will recur unless the task input or environment changes.
 *
 * Classification rationale:
 * - `peer_unreachable`     — transient network; may resolve on retry
 * - `session_expired`       — transient session timing; fresh session may help
 * - `delivery_failed`       — transient delivery channel issue
 * - `runtime_error`         — generic runtime hiccup (e.g. LLM timeout); may be transient
 * - `rate_limited`          — rate limit window resets; retry allowed after backoff
 * - `lease_expired`         — timing/contention issue; fresh lease may succeed
 * - `execution_timeout`     — may succeed with more time, different model, or reduced load
 * - `payload_too_large`     — payload size won't change on retry; permanent
 * - `result_parse_error`    — input/format problem; not transient
 * - `auth_failed`           — credentials won't change on retry
 * - `cancelled_by_operator` — explicit operator intent; not a retry candidate
 * - `duplicate_payload_suppressed` — not a real failure; idempotent guard
 * - `other`                 — unknown; default to non-retryable for safety
 */
export const FAILURE_RETRYABILITY: Record<ExecutionFailureCode, boolean> = {
  peer_unreachable: true,
  session_expired: true,
  payload_too_large: false,
  delivery_failed: true,
  runtime_error: true,
  result_parse_error: false,
  auth_failed: false,
  rate_limited: true,
  lease_expired: true,
  execution_timeout: true,
  cancelled_by_operator: false,
  duplicate_payload_suppressed: false,
  other: false,
};

/**
 * Classify an execution failure code as retryable or not.
 * Resolves aliases before lookup. Unknown codes default to non-retryable.
 */
export function classifyExecutionFailure(code: string): boolean {
  const resolved = EXECUTION_FAILURE_ALIASES[code];
  const normalized = (resolved ?? code) as ExecutionFailureCode;
  const retryable = FAILURE_RETRYABILITY[normalized];
  return retryable === true;
}

/** Alias map: short failure labels → canonical ExecutionFailureCode. */
export const EXECUTION_FAILURE_ALIASES: Record<string, ExecutionFailureCode> = {
  unreachable: "peer_unreachable",
  peer_unreachable: "peer_unreachable",
  expired: "session_expired",
  session_expired: "session_expired",
  payload_large: "payload_too_large",
  payload_too_large: "payload_too_large",
  delivery: "delivery_failed",
  delivery_failed: "delivery_failed",
  runtime: "runtime_error",
  runtime_error: "runtime_error",
  parse: "result_parse_error",
  result_parse_error: "result_parse_error",
  auth: "auth_failed",
  auth_failed: "auth_failed",
  rate_limit: "rate_limited",
  rate_limited: "rate_limited",
  lease: "lease_expired",
  lease_expired: "lease_expired",
  timeout: "execution_timeout",
  execution_timeout: "execution_timeout",
  cancelled: "cancelled_by_operator",
  cancelled_by_operator: "cancelled_by_operator",
  duplicate: "duplicate_payload_suppressed",
  duplicate_payload_suppressed: "duplicate_payload_suppressed",
  other: "other",
};

const FAILURE_CODE_SET = new Set<string>(EXECUTION_FAILURE_CODES);

/** Resolve a raw failure label to a canonical ExecutionFailureCode. */
export function resolveExecutionFailureCode(raw: string): ExecutionFailureCode {
  const resolved = EXECUTION_FAILURE_ALIASES[raw];
  if (resolved && FAILURE_CODE_SET.has(resolved)) return resolved;
  if (FAILURE_CODE_SET.has(raw)) return raw as ExecutionFailureCode;
  return "other";
}

// ---------------------------------------------------------------------------
// Result artifact (redacted, structured)
// ---------------------------------------------------------------------------

export type ResultOutcome = "success" | "partial" | "rejected";

export interface ResultArtifact {
  /** Structured outcome. */
  outcome: ResultOutcome;
  /** Operator-safe summary of the result. No raw prompt or session text. */
  summary: string;
  /** Artifact IDs produced during execution. */
  artifactIds?: string[];
  /** Structured error code if outcome is rejected. */
  errorCode?: ExecutionFailureCode;
}

// ---------------------------------------------------------------------------
// Execution event (replay-safe)
// ---------------------------------------------------------------------------

export type ExecutionEventKind =
  | "exec_wake_requested"
  | "exec_session_ready"
  | "exec_payload_delivered"
  | "exec_running"
  | "exec_result_reported"
  | "exec_failed"
  | "exec_timeout"
  | "exec_cancelled";

export interface ExecutionEvent {
  /** Monotonically increasing event id for cursor-based replay. */
  id: number;
  /** ISO timestamp. */
  timestamp: string;
  /** Execution run id. */
  runId: string;
  /** Target session key. */
  sessionKey: string;
  /** Peer/node id. */
  peerNodeId: string;
  /** Parent task id. */
  parentTaskId?: string;
  /** Event kind. */
  kind: ExecutionEventKind;
  /** Structured metadata. */
  metadata: {
    failureCode?: ExecutionFailureCode;
    /** Lease deadline ISO timestamp (set on session_ready). */
    leaseDeadline?: string;
    /** Result outcome (set on result_reported). */
    outcome?: ResultOutcome;
    /** Duration ms from payload_delivered → result_reported/failed/timeout. */
    executionDurationMs?: number;
    /** Wake audit event id at time of wake request (for cross-ref). */
    wakeEventId?: number;
  };
}

// ---------------------------------------------------------------------------
// Execution run state (tracked outside replay buffer)
// ---------------------------------------------------------------------------

export interface ExecutionRunState {
  /** Unique run id. */
  runId: string;
  /** Target session key. */
  sessionKey: string;
  /** Peer/node id. */
  peerNodeId: string;
  /** Parent task id. */
  parentTaskId?: string;
  /** Current status. */
  status: ExecutionStatus;
  /** Structured failure code. */
  failureCode?: ExecutionFailureCode;
  /** Result artifact (set on result_reported). */
  result?: ResultArtifact;
  /** Lease deadline ISO timestamp. */
  leaseDeadline?: string;
  /** Wake audit event id at request time. */
  wakeEventId?: number;
  /** ISO timestamps. */
  createdAt: string;
  updatedAt: string;
  /** ISO timestamp when payload was delivered. */
  payloadDeliveredAt?: string;
  /** ISO timestamp when execution started. */
  startedAt?: string;
  /** ISO timestamp of terminal state. */
  completedAt?: string;
  /** Execution attempt count (for retry). */
  attempts: number;
  /** Whether a payload has been delivered for this run (idempotency). */
  payloadDelivered: boolean;
}

// ---------------------------------------------------------------------------
// Aggregate closeout summary
// ---------------------------------------------------------------------------

export type ExecutionCloseoutKind = "completed" | "failed" | "timed_out" | "waiting" | "cancelled";

export interface ExecutionCloseoutSummary {
  runId: string;
  sessionKey: string;
  peerNodeId: string;
  kind: ExecutionCloseoutKind;
  /** Number of attempts. */
  attempts: number;
  /** Result artifact if completed. */
  result?: ResultArtifact;
  /** Failure code if failed/timed_out. */
  failureCode?: ExecutionFailureCode;
  /** ISO timestamp of last state change. */
  updatedAt: string;
}
