import type { A2AOperatorNotificationAckDecision } from "./operator-event-bridge.js";
import type { A2AOperatorTerminalNotificationEnvelope } from "./operator-terminal-notifier.js";

export type A2ATerminalBriefDeliveryAdapterEnvelope = A2AOperatorTerminalNotificationEnvelope;

export type A2ATerminalBriefDeliveryAdapterConfirmationSource =
  | "current_session_visible"
  | "manual_operator_receipt";

/**
 * Terminal Brief delivery adapter receipt status.
 *
 * DISTINCTION:
 * - `"accepted"` = the adapter accepted the delivery request (internal-handoff only).
 * - `"provider_accepted"` = the external provider (Telegram/Gateway) accepted the send.
 *
 * Neither `"accepted"` nor `"provider_accepted"` alone is Terminal ACK evidence.
 * Only a `"current_session_visible"` or `"manual_operator_receipt"` confirmation
 * source makes a terminal event ACK-eligible.
 *
 * Non-ACK statuses: `accepted`, `started`, `produced`, `provider_sent`, `provider_accepted`.
 * Terminal-outbox-reader-facing statuses: `timed_out`, `stale`, `failed`.
 */
export type A2ATerminalBriefDeliveryAdapterReceiptStatus =
  | "accepted"
  | "started"
  | "produced"
  | "provider_sent"
  | "provider_accepted"
  | "timed_out"
  | "stale"
  | "failed";

export type A2ATerminalBriefDeliveryAdapterReceiptDecision = {
  /**
   * True only when the adapter has current-session-visible or manual operator
   * receipt evidence. Provider accepted/sent/delivered status is not enough.
   */
  ackTerminalEvent: boolean;
  /**
   * Non-ACK receipt state to write back to the broker. Use this for
   * harness-neutral sidecars that produced/spooled a Terminal Brief but do not
   * yet have operator-visible or manual receipt evidence.
   */
  terminalReceiptStatus?: A2ATerminalBriefDeliveryAdapterReceiptStatus;
  reason?: string;
  confirmationSource?: A2ATerminalBriefDeliveryAdapterConfirmationSource;
  receiptId?: string;
};

const DEFAULT_PENDING_RECEIPT_REASON =
  "waiting for current-session or manual operator receipt confirmation";

export function normalizeTerminalBriefDeliveryReceiptDecision(
  value: unknown,
): A2AOperatorNotificationAckDecision {
  if (!value || typeof value !== "object") {
    return {
      ackTerminalEvent: false,
      reason: "delivery adapter receipt decision must be an object",
    };
  }

  const record = value as Record<string, unknown>;
  const confirmationSource = normalizeTerminalBriefConfirmationSource(
    record.confirmationSource ??
      record.confirmation_source ??
      record.source ??
      record.receiptMode ??
      record.receipt_mode ??
      record.receiptProjection ??
      record.receipt_projection ??
      record.evidence,
  );
  const receiptId = normalizeOptionalString(record.receiptId ?? record.receipt_id);
  const reason = normalizeOptionalString(record.reason);
  const terminalReceiptStatus = normalizeTerminalBriefReceiptStatus(
    record.terminalReceiptStatus ??
      record.terminal_receipt_status ??
      record.receiptStatus ??
      record.receipt_status,
  );

  if (record.ackTerminalEvent === true && confirmationSource) {
    return {
      ackTerminalEvent: true,
      confirmationSource,
      ...(receiptId ? { receiptId } : {}),
      ...(reason ? { reason } : {}),
    };
  }

  return {
    ackTerminalEvent: false,
    ...(reason ? { reason } : { reason: DEFAULT_PENDING_RECEIPT_REASON }),
    ...(terminalReceiptStatus ? { terminalReceiptStatus } : {}),
    ...(receiptId ? { receiptId } : {}),
  };
}

export function normalizeTerminalBriefConfirmationSource(
  value: unknown,
): A2ATerminalBriefDeliveryAdapterConfirmationSource | undefined {
  const normalized = normalizeOptionalString(value)?.toLowerCase().replace(/[ -]/g, "_");
  if (!normalized) return undefined;
  if (
    normalized === "current_session_visible" ||
    normalized === "operator_visible" ||
    normalized === "user_visible"
  ) {
    return "current_session_visible";
  }
  if (
    normalized === "manual_operator_receipt" ||
    normalized === "operator_confirmed" ||
    normalized === "operator_visible_manual"
  ) {
    return "manual_operator_receipt";
  }
  return undefined;
}

export function normalizeTerminalBriefReceiptStatus(
  value: unknown,
): A2ATerminalBriefDeliveryAdapterReceiptStatus | undefined {
  const normalized = normalizeOptionalString(value)?.toLowerCase().replace(/[ -]/g, "_");
  if (
    normalized === "accepted" ||
    normalized === "started" ||
    normalized === "produced" ||
    normalized === "provider_sent" ||
    normalized === "provider_accepted" ||
    normalized === "timed_out" ||
    normalized === "stale" ||
    normalized === "failed"
  ) {
    return normalized;
  }
  if (normalized === "sent" || normalized === "provider_delivered_if_known") {
    return "provider_sent";
  }
  return undefined;
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
