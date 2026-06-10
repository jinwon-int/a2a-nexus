/**
 * Durable session wake adapter (Round 20, plugin-a2a#97).
 *
 * Bridges broker wake requests to durable OpenClaw session resume/launch
 * behavior while preserving node-id handoff and idempotency.
 *
 * Key properties:
 * - Preserves remote node-id through A2A delegation lifecycle.
 * - Maps broker wake audit events to plugin status markers.
 * - Duplicate wake/delivery suppression with degraded target fallback.
 * - Redacted status projection tolerant of additive broker metadata.
 * - Zero OpenClaw internals imported.
 *
 * Depends on:
 * - runtime-wake-adapter.ts (Round 10, base wake adapter types)
 * - wake-layer.ts (Round 12, wake envelope/guard types)
 */

import { createHash } from "node:crypto";

import type {
  A2AWakeRequest,
  A2AWakeDispatch,
  A2AWakeFailureRecord,
  A2AWakeFailureReason,
  A2ARuntimeWakeAdapter,
} from "./runtime-wake-adapter.js";

// ── Types ──────────────────────────────────────────────────────

export type DurableWakeState =
  | "pending"
  | "dispatched"
  | "acknowledged"
  | "resumed"
  | "completed"
  | "failed"
  | "fallback";

export type DurableWakeFallbackReason =
  | "target_unreachable"
  | "session_expired"
  | "node_id_resolution_failed"
  | "runtime_overloaded";

export interface DurableWakeEntry {
  /** Stable wake ID for idempotency. */
  wakeId: string;
  /** Task ID from broker. */
  taskId: string;
  /** Target session key. */
  targetSessionKey: string;
  /** Remote node ID (preserved for A2A delegation). */
  targetNodeId?: string;
  /** Correlation ID for broker audit trail. */
  correlationId?: string;
  /** Current durable state. */
  state: DurableWakeState;
  /** ISO-8601 timestamp when wake was created. */
  createdAt: string;
  /** ISO-8601 timestamp of last state transition. */
  updatedAt: string;
  /** Number of delivery attempts. */
  attemptCount: number;
  /** Fallback reason if state is 'fallback'. */
  fallbackReason?: DurableWakeFallbackReason;
  /** Coalesced task IDs. */
  coalescedTaskIds: string[];
  /** Non-fatal warnings. */
  warnings: string[];
}

export interface DurableWakeAuditEvent {
  /** Stable event ID for idempotency. */
  eventId: string;
  /** Wake entry this audit refers to. */
  wakeId: string;
  /** Task ID. */
  taskId: string;
  /** State transition that triggered this audit. */
  fromState: DurableWakeState;
  /** New state after transition. */
  toState: DurableWakeState;
  /** ISO-8601 timestamp. */
  timestamp: string;
  /** Redacted summary (no raw session/message text). */
  summary?: string;
  /** Target node reference (redacted). */
  targetRef?: string;
  /** Whether this was a fallback transition. */
  isFallback: boolean;
}

export interface DurableWakeTransition {
  entry: DurableWakeEntry;
  audit: DurableWakeAuditEvent;
}

// ── Constants ──────────────────────────────────────────────────

const MAX_RETRY_ATTEMPTS = 3;
const MAX_ENTRIES = 256;
const MAX_COALESCED_TASKS = 32;
const MAX_AUDIT_HISTORY = 1000;

// ── Stable ID derivation ───────────────────────────────────────

function deriveDurableWakeId(taskId: string, targetSessionKey: string, correlationId?: string): string {
  const raw = `durable-wake:${taskId}:${targetSessionKey}:${correlationId ?? "none"}`;
  return createHash("sha256").update(raw).digest("hex").slice(0, 24);
}

function deriveAuditEventId(wakeId: string, toState: DurableWakeState, timestamp: string): string {
  const raw = `audit:${wakeId}:${toState}:${timestamp}`;
  return createHash("sha256").update(raw).digest("hex").slice(0, 20);
}

function redactTargetRef(sessionKey: string, nodeId?: string): string {
  // Use non-secret hash digest — never expose raw or partial sessionKey values
  // R29 fix: previously showed first 6 + last 4 chars; now uses a one-way digest
  // See plugin-a2a#337 (R28 HOLD: raw sessionKey in error messages)
  const digest = createHash("sha256").update(sessionKey).digest("hex").slice(0, 16);
  return nodeId ? `${nodeId}/${digest}` : digest;
}

// ── Durable Session Wake Adapter ───────────────────────────────

export interface DurableSessionWakeAdapterOptions {
  now?: () => Date;
  maxRetryAttempts?: number;
  maxEntries?: number;
  /** Underlying runtime adapter for actual wake dispatch. */
  runtimeAdapter?: A2ARuntimeWakeAdapter;
}

export class DurableSessionWakeAdapter {
  private entries = new Map<string, DurableWakeEntry>();
  private auditLog: DurableWakeAuditEvent[] = [];
  private readonly now: () => Date;
  private readonly maxRetry: number;
  private readonly maxEntries: number;
  private readonly runtimeAdapter?: A2ARuntimeWakeAdapter;

  constructor(options: DurableSessionWakeAdapterOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.maxRetry = options.maxRetryAttempts ?? MAX_RETRY_ATTEMPTS;
    this.maxEntries = options.maxEntries ?? MAX_ENTRIES;
    this.runtimeAdapter = options.runtimeAdapter;
  }

  /**
   * Submit a durable wake request. Deduplicates by taskId + targetSessionKey.
   */
  wake(request: A2AWakeRequest): DurableWakeTransition & { dispatch?: A2AWakeDispatch } {
    const taskId = typeof request.taskId === "string" && request.taskId.trim() ? request.taskId.trim() : undefined;
    const targetSessionKey = typeof request.targetSessionKey === "string" && request.targetSessionKey.trim()
      ? request.targetSessionKey.trim()
      : undefined;

    if (!taskId || !targetSessionKey) {
      return this.createFailedEntry(
        taskId ?? "unknown",
        targetSessionKey ?? "unknown",
        request,
        "invalid_request: taskId and targetSessionKey required",
      );
    }

    const key = `${taskId}:${targetSessionKey}`;
    const existing = this.entries.get(key);

    // Deduplicate: coalesce if same key already pending/dispatched
    if (existing && (existing.state === "pending" || existing.state === "dispatched")) {
      existing.coalescedTaskIds = this.addCoalesced(existing.coalescedTaskIds, taskId);
      existing.updatedAt = this.now().toISOString();
      return {
        entry: { ...existing },
        audit: this.createAudit(existing, existing.state, existing.state, "coalesced duplicate wake"),
      };
    }

    // Capacity check
    if (this.entries.size >= this.maxEntries && !existing) {
      this.evictOldest();
    }

    // Create new entry
    const entry: DurableWakeEntry = {
      wakeId: deriveDurableWakeId(taskId, targetSessionKey, request.correlationId),
      taskId,
      targetSessionKey,
      targetNodeId: request.targetNodeId,
      correlationId: request.correlationId,
      state: "pending",
      createdAt: this.now().toISOString(),
      updatedAt: this.now().toISOString(),
      attemptCount: 0,
      coalescedTaskIds: [],
      warnings: [],
    };

    // Dispatch through runtime adapter if available
    let dispatch: A2AWakeDispatch | undefined;
    if (this.runtimeAdapter) {
      const rawDispatch = this.runtimeAdapter.wake(request);
      // Sync path only — async adapters should be wrapped for durability.
      if (!(rawDispatch instanceof Promise)) {
        dispatch = rawDispatch;
        if (dispatch?.visibleFailure) {
          entry.warnings.push(`runtime dispatch warning: ${dispatch.visibleFailure.message}`);
        }
        entry.state = "dispatched";
        entry.attemptCount = 1;
      }
    }

    this.entries.set(key, entry);
    const audit = this.createAudit(entry, "pending", entry.state, "wake created");

    return { entry: { ...entry }, audit, dispatch };
  }

  /**
   * Acknowledge a dispatched wake (remote node confirms receipt).
   */
  acknowledge(wakeId: string): DurableWakeTransition | null {
    const entry = this.findByWakeId(wakeId);
    if (!entry || entry.state !== "dispatched") return null;

    const fromState = entry.state;
    entry.state = "acknowledged";
    entry.updatedAt = this.now().toISOString();

    return {
      entry: { ...entry },
      audit: this.createAudit(entry, fromState, "acknowledged", "remote node acknowledged"),
    };
  }

  /**
   * Mark a wake as resumed (session active).
   */
  resume(wakeId: string): DurableWakeTransition | null {
    const entry = this.findByWakeId(wakeId);
    if (!entry || (entry.state !== "acknowledged" && entry.state !== "dispatched")) return null;

    const fromState = entry.state;
    entry.state = "resumed";
    entry.updatedAt = this.now().toISOString();

    return {
      entry: { ...entry },
      audit: this.createAudit(entry, fromState, "resumed", "session resumed"),
    };
  }

  /**
   * Complete a wake successfully.
   */
  complete(wakeId: string): DurableWakeTransition | null {
    const entry = this.findByWakeId(wakeId);
    if (!entry || entry.state !== "resumed") return null;

    const fromState = entry.state;
    entry.state = "completed";
    entry.updatedAt = this.now().toISOString();

    return {
      entry: { ...entry },
      audit: this.createAudit(entry, fromState, "completed", "task completed"),
    };
  }

  /**
   * Mark a wake as failed with optional fallback.
   */
  fail(wakeId: string, reason: string, fallback?: DurableWakeFallbackReason): DurableWakeTransition | null {
    const entry = this.findByWakeId(wakeId);
    if (!entry) return null;

    const fromState = entry.state;

    if (fallback && entry.attemptCount < this.maxRetry) {
      entry.state = "fallback";
      entry.fallbackReason = fallback;
      entry.attemptCount++;
      entry.updatedAt = this.now().toISOString();

      return {
        entry: { ...entry },
        audit: this.createAudit(entry, fromState, "fallback", `fallback: ${reason}`, true),
      };
    }

    entry.state = "failed";
    entry.updatedAt = this.now().toISOString();
    entry.warnings.push(`failure: ${reason}`);

    return {
      entry: { ...entry },
      audit: this.createAudit(entry, fromState, "failed", reason),
    };
  }

  /**
   * Get redacted audit projection for broker consumption.
   * Strips all raw session/message text.
   */
  getAuditProjection(wakeId?: string): DurableWakeAuditEvent[] {
    const events = wakeId
      ? this.auditLog.filter((e) => e.wakeId === wakeId)
      : [...this.auditLog];

    return events.map((e) => ({
      ...e,
      summary: e.summary ? this.redactSummary(e.summary) : undefined,
    }));
  }

  /**
   * Get all active (non-terminal) wake entries.
   */
  getActiveWakes(): DurableWakeEntry[] {
    return [...this.entries.values()]
      .filter((e) => e.state !== "completed" && e.state !== "failed")
      .map((e) => ({ ...e }));
  }

  /**
   * Get entry by wake ID.
   */
  getEntry(wakeId: string): DurableWakeEntry | undefined {
    const entry = this.findByWakeId(wakeId);
    return entry ? { ...entry } : undefined;
  }

  /**
   * Get node ID preservation status for a wake entry.
   */
  getNodeIdStatus(wakeId: string): { preserved: boolean; nodeId?: string } {
    const entry = this.findByWakeId(wakeId);
    if (!entry) return { preserved: false };
    return {
      preserved: typeof entry.targetNodeId === "string" && entry.targetNodeId.trim().length > 0,
      nodeId: entry.targetNodeId,
    };
  }

  // ── Internal helpers ───────────────────────────────────────

  private findByWakeId(wakeId: string): DurableWakeEntry | undefined {
    for (const entry of this.entries.values()) {
      if (entry.wakeId === wakeId) return entry;
    }
    return undefined;
  }

  private createFailedEntry(
    taskId: string,
    targetSessionKey: string,
    request: A2AWakeRequest,
    reason: string,
  ): DurableWakeTransition & { dispatch?: A2AWakeDispatch } {
    const entry: DurableWakeEntry = {
      wakeId: deriveDurableWakeId(taskId, targetSessionKey, request.correlationId),
      taskId,
      targetSessionKey,
      targetNodeId: request.targetNodeId,
      correlationId: request.correlationId,
      state: "failed",
      createdAt: this.now().toISOString(),
      updatedAt: this.now().toISOString(),
      attemptCount: 0,
      coalescedTaskIds: [],
      warnings: [reason],
    };

    return {
      entry,
      audit: this.createAudit(entry, "pending", "failed", reason),
    };
  }

  private createAudit(
    entry: DurableWakeEntry,
    fromState: DurableWakeState,
    toState: DurableWakeState,
    summary: string,
    isFallback = false,
  ): DurableWakeAuditEvent {
    const timestamp = this.now().toISOString();
    const audit: DurableWakeAuditEvent = {
      eventId: deriveAuditEventId(entry.wakeId, toState, timestamp),
      wakeId: entry.wakeId,
      taskId: entry.taskId,
      fromState,
      toState,
      timestamp,
      summary: this.redactSummary(summary),
      targetRef: redactTargetRef(entry.targetSessionKey, entry.targetNodeId),
      isFallback,
    };

    this.auditLog.push(audit);
    if (this.auditLog.length > MAX_AUDIT_HISTORY) {
      this.auditLog = this.auditLog.slice(-MAX_AUDIT_HISTORY);
    }

    return audit;
  }

  private redactSummary(value: string): string {
    // Strip credential-like patterns
    const SECRET_PATTERN = /\b(api[_ -]?key|token|secret|password|authorization|bearer)\b\s*[:=]\s*[^\s,;]+/gi;
    let result = value.replace(SECRET_PATTERN, "$1: [redacted]");
    // Strip raw session references
    result = result.replace(/\bsession\s*(key|id|text)?\s*[:：]\s*\S+/gi, "session: [redacted]");
    return result.trim();
  }

  private addCoalesced(existing: string[], taskId: string): string[] {
    if (existing.includes(taskId)) return existing;
    if (existing.length >= MAX_COALESCED_TASKS) return existing;
    return [...existing, taskId];
  }

  private evictOldest(): void {
    let oldestKey: string | undefined;
    let oldestTime = Infinity;
    for (const [key, entry] of this.entries) {
      if (entry.state === "completed" || entry.state === "failed") {
        // Prefer evicting terminal entries
        oldestKey = key;
        break;
      }
      if (entry.createdAt < String(oldestTime)) {
        oldestTime = Number(entry.createdAt);
        oldestKey = key;
      }
    }
    if (oldestKey) this.entries.delete(oldestKey);
  }
}

/**
 * Create a standalone durable session wake adapter.
 */
export function createDurableSessionWakeAdapter(
  options?: DurableSessionWakeAdapterOptions,
): DurableSessionWakeAdapter {
  return new DurableSessionWakeAdapter(options);
}
