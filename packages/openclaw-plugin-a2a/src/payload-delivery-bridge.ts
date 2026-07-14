/**
 * Payload delivery and result marker bridge (Round 21, plugin-a2a#100).
 *
 * Bridges broker remote execution requests to OpenClaw durable session
 * payload delivery and maps execution result markers back into
 * broker-compatible events.
 *
 * Built on Round 20 durable-session-wake-adapter.
 *
 * Key properties:
 * - Idempotent payload delivery (dedup by wakeId + payload fingerprint).
 * - Result marker projection with redaction defaults.
 * - Timeout/failure marker handling with stale session fallback.
 * - Additive broker metadata tolerance.
 * - Zero OpenClaw internals imported.
 */

import { createHash } from "node:crypto";

// ── Types ──────────────────────────────────────────────────────

export type PayloadDeliveryState =
  | "pending"
  | "delivered"
  | "acknowledged"
  | "completed"
  | "failed"
  | "timeout"
  | "stale_session";

export type ResultMarkerType =
  | "success"
  | "failure"
  | "timeout"
  | "partial"
  | "stale";

export interface PayloadDeliveryRequest {
  /** Wake entry this payload is associated with. */
  wakeId: string;
  /** Task ID from broker. */
  taskId: string;
  /** Payload content (will be redacted in projection). */
  payload: string;
  /** Target session key. */
  targetSessionKey: string;
  /** Target node ID. */
  targetNodeId?: string;
  /** Correlation ID. */
  correlationId?: string;
  /** Delivery deadline (ISO-8601). */
  deadline?: string;
  /** Extra broker metadata (tolerated, not processed). */
  [extra: string]: unknown;
}

export interface PayloadDeliveryEntry {
  /** Stable delivery ID. */
  deliveryId: string;
  /** Associated wake ID. */
  wakeId: string;
  /** Task ID. */
  taskId: string;
  /** Target session key. */
  targetSessionKey: string;
  /** Target node ID. */
  targetNodeId?: string;
  /** Correlation ID. */
  correlationId?: string;
  /** Current delivery state. */
  state: PayloadDeliveryState;
  /** Delivery attempt count. */
  attemptCount: number;
  /** ISO-8601 created timestamp. */
  createdAt: string;
  /** ISO-8601 last updated timestamp. */
  updatedAt: string;
  /** Deadline for delivery. */
  deadline?: string;
  /** Warnings. */
  warnings: string[];
}

export interface ResultMarker {
  /** Marker type. */
  type: ResultMarkerType;
  /** Associated delivery ID. */
  deliveryId: string;
  /** Wake ID. */
  wakeId: string;
  /** Task ID. */
  taskId: string;
  /** ISO-8601 timestamp. */
  timestamp: string;
  /** Redacted result summary. */
  summary?: string;
  /** Raw marker text (for audit, not projected externally). */
  rawMarkerText?: string;
  /** Parse status. */
  parseStatus: "clean" | "partial";
}

export interface PayloadDeliveryAuditEvent {
  /** Stable event ID. */
  eventId: string;
  /** Delivery ID. */
  deliveryId: string;
  /** Task ID. */
  taskId: string;
  /** State transition. */
  fromState: PayloadDeliveryState;
  /** New state. */
  toState: PayloadDeliveryState;
  /** ISO-8601 timestamp. */
  timestamp: string;
  /** Redacted summary. */
  summary?: string;
  /** Target reference (redacted). */
  targetRef?: string;
}

export interface DeliveryTransition {
  entry: PayloadDeliveryEntry;
  audit: PayloadDeliveryAuditEvent;
}

// ── Constants ──────────────────────────────────────────────────

const MAX_DELIVERIES = 256;
const MAX_AUDIT_HISTORY = 1000;

// ── Stable ID derivation ───────────────────────────────────────

function deriveDeliveryId(wakeId: string, taskId: string, payloadFingerprint: string): string {
  const raw = `delivery:${wakeId}:${taskId}:${payloadFingerprint}`;
  return createHash("sha256").update(raw).digest("hex").slice(0, 24);
}

function deriveAuditId(deliveryId: string, toState: PayloadDeliveryState, ts: string): string {
  return createHash("sha256").update(`audit:${deliveryId}:${toState}:${ts}`).digest("hex").slice(0, 20);
}

function fingerprintPayload(payload: string): string {
  return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

function redactTargetRef(sessionKey: string, nodeId?: string): string {
  // Use non-secret hash digest — never expose raw or partial sessionKey values
  // R29 fix: previously showed first 6 + last 4 chars; now uses a one-way digest
  // See plugin-a2a#337 (R28 HOLD: raw sessionKey in error messages)
  const digest = createHash("sha256").update(sessionKey).digest("hex").slice(0, 16);
  return nodeId ? `${nodeId}/${digest}` : digest;
}

const REDACTED = "[redacted]";
const SECRET_PATTERN = /\b(api[_ -]?key|token|secret|password|authorization|bearer)\b\s*[:=]\s*[^\s,;]+/gi;
const SESSION_PATTERN = /\bsession\s*(key|id|text|content)?\s*[:：]\s*\S+/gi;

function redactSummary(value: string): string {
  let r = value.replace(SECRET_PATTERN, `$1: ${REDACTED}`);
  r = r.replace(SESSION_PATTERN, `session: ${REDACTED}`);
  return r.trim();
}

// ── Payload Delivery Adapter ───────────────────────────────────

export interface PayloadDeliveryAdapterOptions {
  now?: () => Date;
  maxDeliveries?: number;
  defaultTimeoutMs?: number;
}

export class PayloadDeliveryAdapter {
  private entries = new Map<string, PayloadDeliveryEntry>();
  private resultMarkers = new Map<string, ResultMarker>();
  private auditLog: PayloadDeliveryAuditEvent[] = [];
  private readonly now: () => Date;
  private readonly maxDeliveries: number;

  constructor(options: PayloadDeliveryAdapterOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.maxDeliveries = options.maxDeliveries ?? MAX_DELIVERIES;
  }

  /**
   * Deliver a payload to a session. Idempotent by wakeId + payload fingerprint.
   */
  deliver(request: PayloadDeliveryRequest): DeliveryTransition {
    const { wakeId, taskId, payload, targetSessionKey, targetNodeId, correlationId, deadline } = request;

    if (!wakeId?.trim() || !taskId?.trim() || !targetSessionKey?.trim()) {
      return this.createFailedDelivery(
        wakeId ?? "unknown", taskId ?? "unknown", targetSessionKey ?? "unknown",
        targetNodeId, correlationId, "invalid_request: wakeId, taskId, targetSessionKey required",
      );
    }

    const payloadFp = fingerprintPayload(payload ?? "");
    const deliveryId = deriveDeliveryId(wakeId, taskId, payloadFp);
    const key = `${wakeId}:${payloadFp}`;

    // Deduplicate
    const existing = this.entries.get(key);
    if (existing && (existing.state === "pending" || existing.state === "delivered")) {
      return {
        entry: { ...existing },
        audit: this.createAudit(existing, existing.state, existing.state, "duplicate delivery suppressed"),
      };
    }

    // Capacity
    if (this.entries.size >= this.maxDeliveries && !existing) {
      this.evict();
    }

    const entry: PayloadDeliveryEntry = {
      deliveryId,
      wakeId,
      taskId,
      targetSessionKey,
      targetNodeId,
      correlationId,
      state: "delivered",
      attemptCount: 1,
      createdAt: this.now().toISOString(),
      updatedAt: this.now().toISOString(),
      deadline,
      warnings: [],
    };

    this.entries.set(key, entry);
    return {
      entry: { ...entry },
      audit: this.createAudit(entry, "pending", "delivered", "payload delivered to session"),
    };
  }

  /**
   * Record execution result from a marker.
   */
  recordResult(marker: {
    deliveryId: string;
    type: ResultMarkerType;
    summary?: string;
    rawMarkerText?: string;
  }): DeliveryTransition | null {
    // Find entry by deliveryId
    let entry: PayloadDeliveryEntry | undefined;
    for (const e of this.entries.values()) {
      if (e.deliveryId === marker.deliveryId) {
        entry = e;
        break;
      }
    }
    if (!entry) return null;

    const fromState = entry.state;
    const ts = this.now().toISOString();

    // Map result type to delivery state
    const stateMap: Record<ResultMarkerType, PayloadDeliveryState> = {
      success: "completed",
      failure: "failed",
      timeout: "timeout",
      partial: "completed", // partial results are still "completed" with warnings
      stale: "stale_session",
    };

    const newState = stateMap[marker.type];
    entry.state = newState;
    entry.updatedAt = ts;

    if (marker.type === "partial") {
      entry.warnings.push("partial result received");
    }

    // Store result marker
    const resultMarker: ResultMarker = {
      type: marker.type,
      deliveryId: marker.deliveryId,
      wakeId: entry.wakeId,
      taskId: entry.taskId,
      timestamp: ts,
      summary: marker.summary ? redactSummary(marker.summary) : undefined,
      rawMarkerText: marker.rawMarkerText,
      parseStatus: "clean",
    };
    this.resultMarkers.set(marker.deliveryId, resultMarker);

    return {
      entry: { ...entry },
      audit: this.createAudit(entry, fromState, newState, `result: ${marker.type}`),
    };
  }

  /**
   * Check for timed-out deliveries and transition them.
   */
  checkTimeouts(): DeliveryTransition[] {
    const nowMs = this.now().getTime();
    const transitions: DeliveryTransition[] = [];

    for (const entry of this.entries.values()) {
      if (entry.state !== "delivered" && entry.state !== "pending") continue;
      if (!entry.deadline) continue;

      const deadlineMs = new Date(entry.deadline).getTime();
      if (nowMs > deadlineMs) {
        const fromState = entry.state;
        entry.state = "timeout";
        entry.updatedAt = this.now().toISOString();
        entry.warnings.push("delivery timed out");

        transitions.push({
          entry: { ...entry },
          audit: this.createAudit(entry, fromState, "timeout", "delivery deadline exceeded"),
        });
      }
    }

    return transitions;
  }

  /**
   * Handle stale session: transition delivered entries to stale_session fallback.
   */
  markStaleSession(sessionKey: string): DeliveryTransition[] {
    const transitions: DeliveryTransition[] = [];
    for (const entry of this.entries.values()) {
      if (entry.targetSessionKey !== sessionKey) continue;
      if (entry.state !== "delivered" && entry.state !== "pending") continue;

      const fromState = entry.state;
      entry.state = "stale_session";
      entry.updatedAt = this.now().toISOString();
      entry.warnings.push("session marked stale");

      transitions.push({
        entry: { ...entry },
        audit: this.createAudit(entry, fromState, "stale_session", "session stale fallback"),
      });
    }
    return transitions;
  }

  /**
   * Get redacted result marker projection for broker consumption.
   */
  getResultProjection(deliveryId?: string): ResultMarker[] {
    const markers = deliveryId
      ? [this.resultMarkers.get(deliveryId)].filter(Boolean)
      : [...this.resultMarkers.values()];

    return markers
      .filter((m): m is ResultMarker => m !== undefined)
      .map(({ rawMarkerText: _, ...rest }) => rest as ResultMarker);
  }

  /**
   * Get redacted audit projection.
   */
  getAuditProjection(deliveryId?: string): PayloadDeliveryAuditEvent[] {
    const events = deliveryId
      ? this.auditLog.filter((e) => e.deliveryId === deliveryId)
      : [...this.auditLog];
    return events;
  }

  /**
   * Get delivery entry.
   */
  getEntry(deliveryId: string): PayloadDeliveryEntry | undefined {
    for (const e of this.entries.values()) {
      if (e.deliveryId === deliveryId) return { ...e };
    }
    return undefined;
  }

  // ── Internal ──────────────────────────────────────────────

  private createFailedDelivery(
    wakeId: string, taskId: string, targetSessionKey: string,
    targetNodeId: string | undefined, correlationId: string | undefined,
    reason: string,
  ): DeliveryTransition {
    const entry: PayloadDeliveryEntry = {
      deliveryId: `failed:${taskId}`,
      wakeId,
      taskId,
      targetSessionKey,
      targetNodeId,
      correlationId,
      state: "failed",
      attemptCount: 0,
      createdAt: this.now().toISOString(),
      updatedAt: this.now().toISOString(),
      warnings: [reason],
    };
    return {
      entry,
      audit: this.createAudit(entry, "pending", "failed", reason),
    };
  }

  private createAudit(
    entry: PayloadDeliveryEntry,
    fromState: PayloadDeliveryState,
    toState: PayloadDeliveryState,
    summary: string,
  ): PayloadDeliveryAuditEvent {
    const ts = this.now().toISOString();
    const event: PayloadDeliveryAuditEvent = {
      eventId: deriveAuditId(entry.deliveryId, toState, ts),
      deliveryId: entry.deliveryId,
      taskId: entry.taskId,
      fromState,
      toState,
      timestamp: ts,
      summary: redactSummary(summary),
      targetRef: redactTargetRef(entry.targetSessionKey, entry.targetNodeId),
    };

    this.auditLog.push(event);
    if (this.auditLog.length > MAX_AUDIT_HISTORY) {
      this.auditLog = this.auditLog.slice(-MAX_AUDIT_HISTORY);
    }

    return event;
  }

  private evict(): void {
    for (const [key, entry] of this.entries) {
      if (entry.state === "completed" || entry.state === "failed" || entry.state === "timeout") {
        this.entries.delete(key);
        return;
      }
    }
    // Evict oldest if no terminal entries
    let oldestKey: string | undefined;
    let oldestTime = Infinity;
    for (const [key, entry] of this.entries) {
      const t = new Date(entry.createdAt).getTime();
      if (t < oldestTime) { oldestTime = t; oldestKey = key; }
    }
    if (oldestKey) this.entries.delete(oldestKey);
  }
}

export function createPayloadDeliveryAdapter(options?: PayloadDeliveryAdapterOptions): PayloadDeliveryAdapter {
  return new PayloadDeliveryAdapter(options);
}
