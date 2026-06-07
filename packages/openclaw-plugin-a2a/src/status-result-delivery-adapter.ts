/**
 * Status/result delivery adapter (Round 22, plugin-a2a#103).
 *
 * Bridges OpenClaw session execution status and result events back to the
 * A2A broker, closing the delivery lifecycle loop.
 *
 * Built on Round 21 PayloadDeliveryAdapter.
 *
 * Key properties:
 * - Normalize status/result envelopes from OpenClaw handoff surface.
 * - Preserve stable delivery IDs and idempotent retry behavior.
 * - Redact private content by default.
 * - Surface clear failure codes when delivery cannot complete.
 * - Additive broker metadata tolerance.
 * - Zero OpenClaw internals imported.
 */

import { createHash } from "node:crypto";

import type {
  PayloadDeliveryEntry,
  PayloadDeliveryState,
  ResultMarkerType,
} from "./payload-delivery-bridge.js";

// ── Types ──────────────────────────────────────────────────────

/** Broker-compatible delivery status codes. */
export type BrokerDeliveryStatus =
  | "accepted"
  | "in_progress"
  | "completed"
  | "failed"
  | "timeout"
  | "cancelled"
  | "stale";

/** Failure codes with machine-readable semantics. */
export type DeliveryFailureCode =
  | "target_unreachable"
  | "session_expired"
  | "session_not_found"
  | "payload_too_large"
  | "invalid_envelope"
  | "broker_rejected"
  | "internal_error"
  | "deadline_exceeded"
  | "node_unreachable";

/**
 * Failure category separating retryable infrastructure failures from
 * non-retryable source/application failures.
 *
 * - `infra`: temporary infrastructure issue (network, node, timeout, internal
 *   error) — retrying the delivery may succeed.
 * - `source`: permanent source/application issue (invalid payload, rejected by
 *   broker, session gone) — retrying will not help; the task/app needs fixing.
 * - `unknown`: cannot determine the category.
 */
export type DeliveryFailureCategory = "infra" | "source" | "unknown";

/** Normalized status envelope from OpenClaw handoff surface. */
export interface SessionStatusEnvelope {
  /** Delivery ID (from PayloadDeliveryAdapter). */
  deliveryId: string;
  /** Task ID from broker. */
  taskId: string;
  /** Wake ID. */
  wakeId: string;
  /** Session status raw value from OpenClaw. */
  rawStatus: string;
  /** ISO-8601 timestamp. */
  timestamp: string;
  /** Node that produced this status. */
  sourceNodeId?: string;
  /** Session key reference. */
  sessionKey?: string;
  /** Extra metadata (tolerated). */
  [extra: string]: unknown;
}

/** Normalized result envelope from OpenClaw handoff surface. */
export interface SessionResultEnvelope {
  /** Delivery ID. */
  deliveryId: string;
  /** Task ID. */
  taskId: string;
  /** Wake ID. */
  wakeId: string;
  /** Result marker type. */
  resultType: ResultMarkerType;
  /** ISO-8601 timestamp. */
  timestamp: string;
  /** Result summary (will be redacted in projection). */
  summary?: string;
  /** Raw result text (audit only, not projected). */
  rawResultText?: string;
  /** Source node. */
  sourceNodeId?: string;
  /** Extra metadata (tolerated). */
  [extra: string]: unknown;
}

/** Broker-compatible delivery event. */
export interface BrokerDeliveryEvent {
  /** Stable event ID (idempotent key). */
  eventId: string;
  /** Delivery ID. */
  deliveryId: string;
  /** Task ID. */
  taskId: string;
  /** Wake ID. */
  wakeId: string;
  /** Broker status. */
  status: BrokerDeliveryStatus;
  /** Failure code (only when status is failed/timeout/stale). */
  failureCode?: DeliveryFailureCode;
  /**
   * Failure category distinguishing retryable infra failures from
   * permanent source failures. Only present when failureCode is set.
   */
  failureCategory?: DeliveryFailureCategory;
  /** Human-readable status message. */
  message: string;
  /** ISO-8601 timestamp. */
  timestamp: string;
  /** Source node reference (redacted). */
  sourceNodeRef?: string;
  /** Correlation ID (if provided by broker). */
  correlationId?: string;
  /** Delivery attempt number. */
  attemptNumber: number;
  /** Whether this is a duplicate/suppressed delivery. */
  isDuplicate: boolean;
}

/** Delivery audit entry for internal tracking. */
export interface StatusDeliveryAuditEntry {
  auditId: string;
  deliveryId: string;
  eventType: "status_update" | "result_delivery" | "failure" | "retry";
  fromStatus: BrokerDeliveryStatus | null;
  toStatus: BrokerDeliveryStatus;
  failureCode?: DeliveryFailureCode;
  /**
   * Failure category distinguishing retryable infra failures from
   * permanent source failures. Only present when failureCode is set.
   */
  failureCategory?: DeliveryFailureCategory;
  timestamp: string;
  summary: string;
}

/** Adapter options. */
export interface StatusResultDeliveryAdapterOptions {
  /** Clock override for testing. */
  now?: () => Date;
  /** Maximum tracked deliveries. */
  maxTracked?: number;
  /** Maximum audit entries. */
  maxAudit?: number;
}

// ── Constants ──────────────────────────────────────────────────

const MAX_TRACKED = 512;
const MAX_AUDIT = 2000;
const REDACTED = "[redacted]";
const SECRET_PATTERN = /\b(api[_ -]?key|token|secret|password|authorization|bearer)\b\s*[:=]\s*[^\s,;]+/gi;
const SESSION_PATTERN = /\bsession\s*(key|id|text|content)?\s*[:：]\s*\S+/gi;
const CODE_BLOCK_PATTERN = /```[\s\S]*?```/g;

// ── Delivery state → broker status mapping ─────────────────────

const DELIVERY_STATE_TO_BROKER: Record<PayloadDeliveryState, BrokerDeliveryStatus> = {
  pending: "accepted",
  delivered: "in_progress",
  acknowledged: "in_progress",
  completed: "completed",
  failed: "failed",
  timeout: "timeout",
  stale_session: "stale",
};

// ── Raw status normalization map ───────────────────────────────

const RAW_STATUS_MAP: Record<string, BrokerDeliveryStatus> = {
  running: "in_progress",
  active: "in_progress",
  pending: "accepted",
  waiting: "accepted",
  completed: "completed",
  success: "completed",
  done: "completed",
  failed: "failed",
  error: "failed",
  timeout: "timeout",
  timed_out: "timeout",
  expired: "stale",
  stale: "stale",
  cancelled: "cancelled",
  canceled: "cancelled",
  aborted: "cancelled",
};

// ── Helper functions ───────────────────────────────────────────

function deriveEventId(deliveryId: string, status: BrokerDeliveryStatus, ts: string): string {
  return createHash("sha256")
    .update(`srd:${deliveryId}:${status}:${ts}`)
    .digest("hex")
    .slice(0, 24);
}

function deriveAuditId(deliveryId: string, eventType: string, ts: string): string {
  return createHash("sha256")
    .update(`audit:${deliveryId}:${eventType}:${ts}`)
    .digest("hex")
    .slice(0, 20);
}

function redactContent(value: string): string {
  let r = value.replace(CODE_BLOCK_PATTERN, REDACTED);
  r = r.replace(SECRET_PATTERN, `$1: ${REDACTED}`);
  r = r.replace(SESSION_PATTERN, `session: ${REDACTED}`);
  return r.trim();
}

function redactNodeRef(nodeId?: string): string | undefined {
  if (!nodeId) return undefined;
  return nodeId.length > 12 ? `${nodeId.slice(0, 6)}…${nodeId.slice(-4)}` : nodeId;
}

function normalizeRawStatus(raw: string): BrokerDeliveryStatus {
  const key = raw.toLowerCase().trim().replace(/[\s_-]+/g, "_");
  return RAW_STATUS_MAP[key] ?? "in_progress"; // default to in_progress for unknown
}

function inferFailureCode(
  status: BrokerDeliveryStatus,
  rawStatus?: string,
  rawResultText?: string,
): DeliveryFailureCode | undefined {
  if (status === "failed") {
    const combined = `${rawStatus ?? ""} ${rawResultText ?? ""}`.toLowerCase();
    if (combined.includes("unreachable") || combined.includes("connection")) return "target_unreachable";
    if (combined.includes("expired") || combined.includes("stale")) return "session_expired";
    if (combined.includes("not found") || combined.includes("no session")) return "session_not_found";
    if (combined.includes("too large") || combined.includes("payload")) return "payload_too_large";
    if (combined.includes("rejected")) return "broker_rejected";
    return "internal_error";
  }
  if (status === "timeout") return "deadline_exceeded";
  if (status === "stale") return "session_expired";
  return undefined;
}

/**
 * Classify a failure code as retryable infrastructure failure (`infra`),
 * permanent source/application failure (`source`), or `unknown`.
 *
 * Infrastructure failures are transient (network, node down, timeout,
 * internal transient error) and retrying the delivery may succeed.
 * Source failures are permanent (invalid payload, rejected by broker,
 * session gone) and retrying will not help.
 */
function inferFailureCategory(
  code: DeliveryFailureCode | undefined,
): DeliveryFailureCategory | undefined {
  if (!code) return undefined;

  // Retryable infrastructure failures — transient conditions that may
  // resolve on retry (network, node, timeout, internal server error).
  const INFRA_CODES: ReadonlySet<DeliveryFailureCode> = new Set([
    "target_unreachable",
    "node_unreachable",
    "deadline_exceeded",
    "internal_error",
  ]);

  // Permanent source/application failures — retrying will not resolve
  // the underlying issue (invalid payload, rejected, session gone).
  const SOURCE_CODES: ReadonlySet<DeliveryFailureCode> = new Set([
    "session_expired",
    "session_not_found",
    "payload_too_large",
    "invalid_envelope",
    "broker_rejected",
  ]);

  if (INFRA_CODES.has(code)) return "infra";
  if (SOURCE_CODES.has(code)) return "source";
  return "unknown";
}

// ── Tracked delivery state ─────────────────────────────────────

interface TrackedDelivery {
  deliveryId: string;
  taskId: string;
  wakeId: string;
  currentStatus: BrokerDeliveryStatus;
  attemptCount: number;
  lastEventId: string;
  correlationId?: string;
  sourceNodeId?: string;
  updatedAt: string;
}

// ── Status Result Delivery Adapter ─────────────────────────────

export class StatusResultDeliveryAdapter {
  private tracked = new Map<string, TrackedDelivery>();
  private deliveryIndex = new Map<string, string>(); // deliveryId → tracking key
  private auditLog: StatusDeliveryAuditEntry[] = [];
  private readonly now: () => Date;
  private readonly maxTracked: number;
  private readonly maxAudit: number;

  constructor(options: StatusResultDeliveryAdapterOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.maxTracked = options.maxTracked ?? MAX_TRACKED;
    this.maxAudit = options.maxAudit ?? MAX_AUDIT;
  }

  // ── Status ingestion ───────────────────────────────────────

  /**
   * Ingest a session status envelope and produce a broker-compatible event.
   * Idempotent: same deliveryId + status + timestamp → suppressed duplicate.
   */
  ingestStatus(envelope: SessionStatusEnvelope): BrokerDeliveryEvent {
    const { deliveryId, taskId, wakeId, rawStatus, timestamp, sourceNodeId, sessionKey } = envelope;

    const brokerStatus = normalizeRawStatus(rawStatus);
    const ts = timestamp || this.now().toISOString();
    const eventId = deriveEventId(deliveryId, brokerStatus, ts);

    const key = `${deliveryId}`;
    const existing = this.tracked.get(key);

    // Duplicate suppression: same event ID means already delivered
    if (existing && existing.lastEventId === eventId) {
      return this.buildEvent(existing, brokerStatus, ts, true);
    }

    // Update tracking
    const tracked: TrackedDelivery = {
      deliveryId,
      taskId,
      wakeId,
      currentStatus: brokerStatus,
      attemptCount: (existing?.attemptCount ?? 0) + 1,
      lastEventId: eventId,
      correlationId: (envelope as Record<string, unknown>).correlationId as string | undefined ?? existing?.correlationId,
      sourceNodeId: sourceNodeId ?? existing?.sourceNodeId,
      updatedAt: ts,
    };

    this.ensureCapacity();
    this.tracked.set(key, tracked);
    this.deliveryIndex.set(deliveryId, key);

    // Audit
    this.appendAudit({
      deliveryId,
      eventType: "status_update",
      fromStatus: existing?.currentStatus ?? null,
      toStatus: brokerStatus,
      timestamp: ts,
      summary: `status: ${rawStatus} → ${brokerStatus}`,
    });

    return this.buildEvent(tracked, brokerStatus, ts, false);
  }

  // ── Result ingestion ───────────────────────────────────────

  /**
   * Ingest a session result envelope and produce a terminal broker event.
   * Closes the delivery lifecycle.
   */
  ingestResult(envelope: SessionResultEnvelope): BrokerDeliveryEvent {
    const { deliveryId, taskId, wakeId, resultType, timestamp, summary, rawResultText, sourceNodeId } = envelope;

    const stateMap: Record<ResultMarkerType, BrokerDeliveryStatus> = {
      success: "completed",
      failure: "failed",
      timeout: "timeout",
      partial: "completed",
      stale: "stale",
    };

    const brokerStatus = stateMap[resultType];
    const ts = timestamp || this.now().toISOString();
    const eventId = deriveEventId(deliveryId, brokerStatus, ts);

    const key = `${deliveryId}`;
    const existing = this.tracked.get(key);

    // Duplicate suppression
    if (existing && existing.lastEventId === eventId) {
      return this.buildEvent(existing, brokerStatus, ts, true);
    }

    const failureCode = inferFailureCode(brokerStatus, undefined, rawResultText);

    const tracked: TrackedDelivery = {
      deliveryId,
      taskId,
      wakeId,
      currentStatus: brokerStatus,
      attemptCount: (existing?.attemptCount ?? 0) + 1,
      lastEventId: eventId,
      correlationId: (envelope as Record<string, unknown>).correlationId as string | undefined ?? existing?.correlationId,
      sourceNodeId: sourceNodeId ?? existing?.sourceNodeId,
      updatedAt: ts,
    };

    this.ensureCapacity();
    this.tracked.set(key, tracked);
    this.deliveryIndex.set(deliveryId, key);

    // Audit
    this.appendAudit({
      deliveryId,
      eventType: resultType === "success" || resultType === "partial" ? "result_delivery" : "failure",
      fromStatus: existing?.currentStatus ?? null,
      toStatus: brokerStatus,
      failureCode,
      failureCategory: inferFailureCategory(failureCode),
      timestamp: ts,
      summary: summary ? redactContent(summary) : `result: ${resultType}`,
    });

    const event = this.buildEvent(tracked, brokerStatus, ts, false);
    event.failureCode = failureCode;
    event.failureCategory = inferFailureCategory(failureCode);
    return event;
  }

  // ── Delivery entry bridge ──────────────────────────────────

  /**
   * Bridge a PayloadDeliveryEntry into a broker status event.
   * Useful for bridging Round 21 delivery states into broker-compatible format.
   */
  bridgeDeliveryEntry(entry: PayloadDeliveryEntry): BrokerDeliveryEvent {
    const brokerStatus = DELIVERY_STATE_TO_BROKER[entry.state] ?? "in_progress";
    const ts = entry.updatedAt;
    const eventId = deriveEventId(entry.deliveryId, brokerStatus, ts);

    const key = `${entry.deliveryId}`;
    const existing = this.tracked.get(key);

    if (existing && existing.lastEventId === eventId) {
      return this.buildEvent(existing, brokerStatus, ts, true);
    }

    const tracked: TrackedDelivery = {
      deliveryId: entry.deliveryId,
      taskId: entry.taskId,
      wakeId: entry.wakeId,
      currentStatus: brokerStatus,
      attemptCount: (existing?.attemptCount ?? 0) + 1,
      lastEventId: eventId,
      correlationId: entry.correlationId ?? existing?.correlationId,
      sourceNodeId: entry.targetNodeId ?? existing?.sourceNodeId,
      updatedAt: ts,
    };

    this.ensureCapacity();
    this.tracked.set(key, tracked);
    this.deliveryIndex.set(entry.deliveryId, key);

    const failureCode = inferFailureCode(brokerStatus);

    this.appendAudit({
      deliveryId: entry.deliveryId,
      eventType: "status_update",
      fromStatus: existing?.currentStatus ?? null,
      toStatus: brokerStatus,
      failureCode,
      failureCategory: inferFailureCategory(failureCode),
      timestamp: ts,
      summary: `bridged delivery state: ${entry.state} → ${brokerStatus}`,
    });

    const event = this.buildEvent(tracked, brokerStatus, ts, false);
    event.failureCode = failureCode;
    event.failureCategory = inferFailureCategory(failureCode);
    return event;
  }

  // ── Query methods ──────────────────────────────────────────

  /** Get current tracked status for a delivery. */
  getStatus(deliveryId: string): BrokerDeliveryEvent | null {
    const tracked = this.tracked.get(deliveryId);
    if (!tracked) return null;
    return this.buildEvent(tracked, tracked.currentStatus, tracked.updatedAt, false);
  }

  /** Get audit log, optionally filtered by deliveryId. */
  getAuditLog(deliveryId?: string): StatusDeliveryAuditEntry[] {
    if (deliveryId) {
      return this.auditLog.filter((a) => a.deliveryId === deliveryId);
    }
    return [...this.auditLog];
  }

  /** Get all tracked delivery IDs. */
  getTrackedDeliveryIds(): string[] {
    return [...this.tracked.keys()];
  }

  // ── Internal ───────────────────────────────────────────────

  private buildEvent(
    tracked: TrackedDelivery,
    status: BrokerDeliveryStatus,
    ts: string,
    isDuplicate: boolean,
  ): BrokerDeliveryEvent {
    const failureCode = inferFailureCode(status);
    return {
      eventId: tracked.lastEventId,
      deliveryId: tracked.deliveryId,
      taskId: tracked.taskId,
      wakeId: tracked.wakeId,
      status,
      failureCode,
      failureCategory: inferFailureCategory(failureCode),
      message: this.statusMessage(status, isDuplicate),
      timestamp: ts,
      sourceNodeRef: redactNodeRef(tracked.sourceNodeId),
      correlationId: tracked.correlationId,
      attemptNumber: tracked.attemptCount,
      isDuplicate,
    };
  }

  private statusMessage(status: BrokerDeliveryStatus, isDuplicate: boolean): string {
    const prefix = isDuplicate ? "[duplicate] " : "";
    const messages: Record<BrokerDeliveryStatus, string> = {
      accepted: "delivery accepted",
      in_progress: "delivery in progress",
      completed: "delivery completed successfully",
      failed: "delivery failed",
      timeout: "delivery timed out",
      cancelled: "delivery cancelled",
      stale: "session stale, delivery cannot complete",
    };
    return `${prefix}${messages[status]}`;
  }

  private ensureCapacity(): void {
    if (this.tracked.size >= this.maxTracked) {
      // Evict oldest 10%
      const toEvict = Math.ceil(this.maxTracked * 0.1);
      let count = 0;
      for (const [key, entry] of this.tracked) {
        if (count >= toEvict) break;
        // Don't evict in-progress entries
        if (entry.currentStatus === "in_progress" || entry.currentStatus === "accepted") continue;
        this.tracked.delete(key);
        this.deliveryIndex.delete(entry.deliveryId);
        count++;
      }
      // If still over capacity, force evict
      if (this.tracked.size >= this.maxTracked) {
        for (const [key, entry] of this.tracked) {
          if (count >= toEvict) break;
          this.tracked.delete(key);
          this.deliveryIndex.delete(entry.deliveryId);
          count++;
        }
      }
    }

    if (this.auditLog.length >= this.maxAudit) {
      this.auditLog = this.auditLog.slice(Math.ceil(this.maxAudit * 0.1));
    }
  }

  private appendAudit(entry: Omit<StatusDeliveryAuditEntry, "auditId">): void {
    const audit: StatusDeliveryAuditEntry = {
      ...entry,
      auditId: deriveAuditId(entry.deliveryId, entry.eventType, entry.timestamp),
    };
    this.auditLog.push(audit);
  }
}

// ── Factory ────────────────────────────────────────────────────

export function createStatusResultDeliveryAdapter(
  options?: StatusResultDeliveryAdapterOptions,
): StatusResultDeliveryAdapter {
  return new StatusResultDeliveryAdapter(options);
}
