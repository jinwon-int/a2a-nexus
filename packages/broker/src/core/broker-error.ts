// Broker error type and class extracted from broker.ts so that modules can
// throw and type broker errors without importing the full broker module (which
// would create runtime import cycles). broker.ts re-exports both to preserve the
// existing public surface.

/**
 * Every broker error code, as a runtime value.
 *
 * `BrokerErrorCode` is derived from this array rather than declared as a
 * standalone union so that surface-mapping tests can iterate the real code set
 * instead of a hand-copied list that silently drifts. Adding a code here is
 * enough to make those tests cover it.
 */
export const BROKER_ERROR_CODES = [
  "bad_request",
  "not_found",
  "content_type_not_supported",
  "unsupported_operation",
  "policy_denied",
  "invalid_transition",
  "idempotency_conflict",
  "spec_underspecified",
  "source_projection_empty",
  "retry_policy_malformed",
  "acceptance_malformed",
  "provenance_invalid",
  "github_completion_evidence_missing",
  "github_completion_receipt_invalid",
  "review_evidence_missing",
  "review_not_independent",
  "review_verdict_failed",
  "review_author_conflict",
  "finalizer_verdict_invalid",
  "queue_saturated",
  "queue_drain_timeout",
  "queue_closed",
  "worker_crashed",
  "worker_unavailable",
  "task_lineage_cycle",
  "unauthorized",
  "rate_limited",
] as const;

export type BrokerErrorCode = (typeof BROKER_ERROR_CODES)[number];

/**
 * Error code stamped on a task that is dead-lettered after exhausting its
 * automatic requeue attempts. Lives here (a leaf) so diagnostics modules can
 * reference it without importing the full broker module; broker.ts re-exports it
 * to preserve the existing public surface.
 */
export const REQUEUE_EXHAUSTED_ERROR_CODE = "exceeded_requeue_limit";

export class BrokerError extends Error {
  constructor(
    readonly code: BrokerErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "BrokerError";
  }
}
