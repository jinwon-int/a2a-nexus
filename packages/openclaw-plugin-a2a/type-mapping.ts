/**
 * Explicit contract mapping between OpenClaw A2A protocol status/error shapes
 * and standalone broker domain types.
 *
 * The plugin owns broker-specific status translation so core callers can depend
 * on the bundled public seam instead of a core-local helper.
 */

export type A2AExecutionStatus =
  | "accepted"
  | "running"
  | "waiting_reply"
  | "waiting_external"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed_out";

/**
 * A2A receipt vocabulary — separated from provider-send success.
 *
 * Provider "accepted" means the broker accepted the task; it does NOT
 * mean the operator has seen the result.  "operator_visible" is the
 * next stronger level and requires a platform ACK or delivery bridge
 * confirmation that cannot be inferred from broker status alone.
 *
 * - none:                  no receipt tracking started
 * - pending:               send queued, not yet attempted
 * - accepted:              broker accepted the send (provider level)
 * - provider_delivered_if_known: provider reports delivery success
 * - operator_visible:      operator/human-visible receipt confirmed
 * - timed_out:             delivery timed out before reaching operator
 * - stale:                 target session was stale/unreachable
 * - failed:                send failed, no delivery
 */
export type A2AReceiptStatus =
  | "none"
  | "pending"
  | "accepted"
  | "provider_delivered_if_known"
  | "operator_visible"
  | "timed_out"
  | "stale"
  | "failed";

/** Terminal receipt statuses — no further receipt transitions expected. */
export const TERMINAL_RECEIPT_STATUSES: ReadonlySet<A2AReceiptStatus> = new Set([
  "operator_visible",
  "timed_out",
  "stale",
  "failed",
]);

/** Legacy delivery status — subset used in task-update deliveryStatus field. */
export type A2ADeliveryStatus = "sent" | "skipped" | "failed";

export type A2ATaskError = {
  code: string;
  message?: string;
};

export type A2ATaskCancelTarget = {
  kind: "session_run";
  sessionKey: string;
  runId?: string;
};

/** Every broker task status literal. */
export type BrokerTaskStatus =
  | "blocked"
  | "queued"
  | "claimed"
  | "running"
  | "succeeded"
  | "failed"
  | "canceled";

/** Broker statuses that indicate the task is still in-flight.
 *
 * "blocked" is an active status: the task is alive but blocked on
 * external evidence (operator approval, upstream dependency, or a
 * worker Block marker).  When the broker status is "blocked", the
 * execution-status projection returns "accepted" because the A2A
 * vocabulary has no first-class "blocked" status.  Callers that need
 * to distinguish a blocked task from a queued one MUST inspect
 * `metadata.evidenceRefs` for a `blockUrl` or check
 * `metadata.taskInput.blockUrl`. */
export const ACTIVE_BROKER_STATUSES: ReadonlySet<BrokerTaskStatus> = new Set([
  "blocked",
  "queued",
  "claimed",
  "running",
]);

/** Broker statuses that are terminal, no further state transitions. */
export const TERMINAL_BROKER_STATUSES: ReadonlySet<BrokerTaskStatus> = new Set([
  "succeeded",
  "failed",
  "canceled",
]);

/** OpenClaw statuses that are terminal. */
export const TERMINAL_OPENCLAW_STATUSES: ReadonlySet<A2AExecutionStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
  "timed_out",
]);

/** Non-cancel terminal statuses. */
export const NON_CANCEL_TERMINAL_STATUSES: ReadonlySet<A2AExecutionStatus> = new Set([
  "completed",
  "failed",
  "timed_out",
]);

export function mapBrokerStatusToExecutionStatus(params: {
  brokerStatus: BrokerTaskStatus;
  brokerErrorCode?: string | undefined;
}): A2AExecutionStatus {
  switch (params.brokerStatus) {
    // "blocked" maps to "accepted" (not "waiting_external") because
    // the A2A vocabulary has no first-class blocked status and
    // changing the mapping would be a semantic break for existing
    // callers.  Evidence-only and no-change outcomes are always
    // terminal "completed" broker tasks; the distinction is carried
    // in `metadata.evidenceRefs` (blockUrl / doneUrl) and the
    // optional `outcome` field on the worker Done event payload.
    case "blocked":
    case "queued":
    case "claimed":
      return "accepted";
    case "running":
      return "running";
    case "succeeded":
      return "completed";
    case "failed":
      return isBrokerTimeoutCode(params.brokerErrorCode) ? "timed_out" : "failed";
    case "canceled":
      return "cancelled";
    default:
      return "failed";
  }
}

export function mapBrokerStatusToDeliveryStatus(
  brokerStatus: BrokerTaskStatus,
): "none" | "pending" | "sent" | "skipped" | "failed" {
  switch (brokerStatus) {
    case "blocked":
    case "queued":
    case "claimed":
    case "running":
      return "pending";
    case "succeeded":
    case "failed":
    case "canceled":
      return "skipped";
    default:
      return "pending";
  }
}

/**
 * Map broker status to receipt status — separates provider-level success
 * from operator/human-visible receipt.
 *
 * Provider "accepted" ≠ operator-visible.  The receipt status only
 * reaches "operator_visible" when an explicit delivery confirmation
 * (not broker status) is available.
 */
export function mapBrokerStatusToReceiptStatus(params: {
  brokerStatus: BrokerTaskStatus;
  deliveryConfirmation?: boolean;
  staleSession?: boolean;
  timedOut?: boolean;
}): A2AReceiptStatus {
  // Terminal delivery outcomes first
  if (params.timedOut) {
    return "timed_out";
  }
  if (params.staleSession) {
    return "stale";
  }

  // Provider-level receipt: broker accepted the task
  switch (params.brokerStatus) {
    case "blocked":
    case "queued":
      return "pending";
    case "claimed":
    case "running":
      return "accepted";
    case "succeeded":
      // Broker reports success but we distinguish delivery vs visibility
      return params.deliveryConfirmation ? "operator_visible" : "provider_delivered_if_known";
    case "failed":
    case "canceled":
      return "failed";
    default:
      return "pending";
  }
}

/**
 * Returns true when a receipt status is terminal (no further transitions).
 */
export function isTerminalReceiptStatus(status: A2AReceiptStatus): boolean {
  return TERMINAL_RECEIPT_STATUSES.has(status);
}

export function mapBrokerErrorToTaskError(params: {
  brokerErrorCode?: string | undefined;
  brokerErrorMessage?: string | undefined;
  brokerStatus?: BrokerTaskStatus;
}): A2ATaskError | undefined {
  const code =
    params.brokerErrorCode ?? (params.brokerStatus === "failed" ? "remote_task_failed" : undefined);
  if (!code) {
    return undefined;
  }
  return {
    code,
    ...(params.brokerErrorMessage ? { message: params.brokerErrorMessage } : {}),
  };
}

const BROKER_TIMEOUT_CODES = new Set(["timeout", "timed_out", "broker_timeout"]);

export function isBrokerTimeoutCode(code: string | undefined): boolean {
  if (!code) {
    return false;
  }
  return BROKER_TIMEOUT_CODES.has(code.trim().toLowerCase());
}

export function resolveTraceField(params: {
  explicit?: string | undefined;
  payload?: string | undefined;
  request?: string | undefined;
  fallback?: string | undefined;
}): string | undefined {
  return params.explicit ?? params.payload ?? params.request ?? params.fallback;
}

export function resolveCancelTarget(params: {
  explicit?: A2ATaskCancelTarget | undefined;
  payload?: A2ATaskCancelTarget | undefined;
  request?: A2ATaskCancelTarget | undefined;
  targetSessionKey?: string | undefined;
  runId?: string | undefined;
}): A2ATaskCancelTarget | undefined {
  const target = params.explicit ?? params.payload ?? params.request;
  if (target) {
    return target;
  }
  if (params.targetSessionKey) {
    return {
      kind: "session_run",
      sessionKey: params.targetSessionKey,
      ...(params.runId ? { runId: params.runId } : {}),
    };
  }
  return undefined;
}

export function toEpochMs(value: string | undefined): number {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : Date.now();
}

export function isBrokerTaskTerminal(status: BrokerTaskStatus): boolean {
  return TERMINAL_BROKER_STATUSES.has(status);
}

export function isTerminalExecutionStatus(status: string | undefined): boolean {
  return TERMINAL_OPENCLAW_STATUSES.has(status as A2AExecutionStatus);
}
