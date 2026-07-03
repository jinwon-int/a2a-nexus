// Broker error type and class extracted from broker.ts so that modules can
// throw and type broker errors without importing the full broker module (which
// would create runtime import cycles). broker.ts re-exports both to preserve the
// existing public surface.

export type BrokerErrorCode =
  | "bad_request"
  | "not_found"
  | "policy_denied"
  | "invalid_transition"
  | "spec_underspecified"
  | "github_completion_evidence_missing"
  | "github_completion_receipt_invalid"
  | "queue_saturated"
  | "queue_drain_timeout"
  | "queue_closed"
  | "worker_crashed"
  | "worker_unavailable"
  | "unauthorized"
  | "rate_limited";

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
