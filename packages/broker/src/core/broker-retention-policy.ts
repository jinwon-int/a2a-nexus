// Retention/requeue policy defaults and normalizers extracted from broker.ts.
// Self-contained: every value dependency lives here, so only the
// BrokerRetentionPolicy type is imported back (type-only, erased at runtime, so
// no runtime import cycle through broker.js). broker.ts re-exports the constants
// to preserve the existing public surface.
import type { BrokerRetentionPolicy } from "./broker.js";

/**
 * Default cap on automatic requeues for a single task. Chosen to tolerate a short burst of
 * worker crashes or transient outages without masking a genuinely stuck task forever.
 */
export const DEFAULT_MAX_REQUEUE_ATTEMPTS = 5;

export const DEFAULT_HEARTBEAT_AUDIT_SAMPLE_INTERVAL_MS = 60_000;

/**
 * Terminal retention uses terminalRetentionMs as a candidacy cutoff, not a
 * strict TTL: all records at or newer than the cutoff remain, and each
 * maxTerminal* value retains at most that many older candidates newest-first.
 */
export const DEFAULT_BROKER_RETENTION_POLICY: BrokerRetentionPolicy = {
  terminalRetentionMs: 7 * 24 * 60 * 60 * 1000,
  maxTerminalExchanges: 1_000,
  maxTerminalTasks: 2_000,
  maxTerminalProposals: 1_000,
  inactiveWorkerRetentionMs: 14 * 24 * 60 * 60 * 1000,
  maxInactiveWorkers: 500,
  auditRetentionMs: 7 * 24 * 60 * 60 * 1000,
  maxAuditEvents: 5_000,
  maxHeartbeatAuditEvents: 500,
  heartbeatAuditSampleIntervalMs: DEFAULT_HEARTBEAT_AUDIT_SAMPLE_INTERVAL_MS,
};

export function normalizeNonNegativeInteger(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  const normalized = value ?? fallback;
  return Math.max(0, Math.trunc(normalized));
}

export function normalizeMaxRequeueAttempts(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return DEFAULT_MAX_REQUEUE_ATTEMPTS;
  }
  return Math.max(0, Math.trunc(value));
}

export function normalizeBrokerRetentionPolicy(
  overrides?: Partial<BrokerRetentionPolicy>,
): BrokerRetentionPolicy {
  const maxAuditEvents = normalizeNonNegativeInteger(
    overrides?.maxAuditEvents,
    DEFAULT_BROKER_RETENTION_POLICY.maxAuditEvents,
  );
  return {
    terminalRetentionMs: normalizeNonNegativeInteger(
      overrides?.terminalRetentionMs,
      DEFAULT_BROKER_RETENTION_POLICY.terminalRetentionMs,
    ),
    maxTerminalExchanges: normalizeNonNegativeInteger(
      overrides?.maxTerminalExchanges,
      DEFAULT_BROKER_RETENTION_POLICY.maxTerminalExchanges,
    ),
    maxTerminalTasks: normalizeNonNegativeInteger(
      overrides?.maxTerminalTasks,
      DEFAULT_BROKER_RETENTION_POLICY.maxTerminalTasks,
    ),
    maxTerminalProposals: normalizeNonNegativeInteger(
      overrides?.maxTerminalProposals,
      DEFAULT_BROKER_RETENTION_POLICY.maxTerminalProposals,
    ),
    inactiveWorkerRetentionMs: normalizeNonNegativeInteger(
      overrides?.inactiveWorkerRetentionMs,
      DEFAULT_BROKER_RETENTION_POLICY.inactiveWorkerRetentionMs,
    ),
    maxInactiveWorkers: normalizeNonNegativeInteger(
      overrides?.maxInactiveWorkers,
      DEFAULT_BROKER_RETENTION_POLICY.maxInactiveWorkers,
    ),
    auditRetentionMs: normalizeNonNegativeInteger(
      overrides?.auditRetentionMs,
      DEFAULT_BROKER_RETENTION_POLICY.auditRetentionMs,
    ),
    maxAuditEvents,
    maxHeartbeatAuditEvents: normalizeNonNegativeInteger(
      overrides?.maxHeartbeatAuditEvents,
      Math.min(maxAuditEvents, DEFAULT_BROKER_RETENTION_POLICY.maxHeartbeatAuditEvents),
    ),
    heartbeatAuditSampleIntervalMs: normalizeNonNegativeInteger(
      overrides?.heartbeatAuditSampleIntervalMs,
      DEFAULT_BROKER_RETENTION_POLICY.heartbeatAuditSampleIntervalMs,
    ),
  };
}
