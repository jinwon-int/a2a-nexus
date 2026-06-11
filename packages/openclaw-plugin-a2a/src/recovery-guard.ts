/**
 * Termux / mobile-safe recovery loop hardening.
 *
 * Adds guardrails for retry storms, duplicate wakeups, long-running recovery
 * actions, and network reconnects on low-resource nodes.
 *
 * Closes jinwon-int/plugin-a2a#77.
 */

import os from "node:os";

// ── Types ─────────────────────────────────────────────────────

export type RecoveryActionKind =
  | "cancel"
  | "requeue"
  | "replay_event"
  | "dry_run"
  | "status_check";

export type RecoveryNodeProfile = {
  /** True when running on Android/Termux or another mobile-constrained host. */
  isMobile: boolean;
  /** True when the node has limited memory or CPU (detected or configured). */
  isLowResource: boolean;
  /** Optional human-readable node identifier for status surfaces. */
  nodeId?: string;
};

export type RecoveryRetryPolicy = {
  /** Maximum total attempts for a single recovery action. */
  maxAttempts: number;
  /** Base delay in ms between retries (exponential backoff). */
  baseDelayMs: number;
  /** Maximum backoff delay in ms. */
  maxDelayMs: number;
  /** Jitter factor (0–1) to spread retry storms. */
  jitterFactor: number;
};

export type RecoveryActionId = string;

export type RecoveryActionRecord = {
  id: RecoveryActionId;
  kind: RecoveryActionKind;
  taskId: string;
  attemptCount: number;
  lastAttemptAtMs: number;
  status: "pending" | "running" | "completed" | "failed" | "abandoned";
  nextRetryAtMs?: number;
  error?: string;
};

export type RecoveryGuardOptions = {
  /** Clock for tests. */
  nowMs?: () => number;
  /** Retry policy. Mobile defaults are more conservative. */
  retryPolicy?: Partial<RecoveryRetryPolicy>;
  /** Node profile. Auto-detected if omitted. */
  nodeProfile?: Partial<RecoveryNodeProfile>;
  /** Maximum concurrent recovery actions. */
  maxConcurrent?: number;
  /** Maximum time a single recovery action can run before timeout (ms). */
  actionTimeoutMs?: number;
  /** Maximum time a recovery action record is kept after completion (ms). */
  recordRetentionMs?: number;
};

export type RecoveryGuardStatus = {
  nodeProfile: RecoveryNodeProfile;
  retryPolicy: RecoveryRetryPolicy;
  activeCount: number;
  pendingCount: number;
  totalAttempted: number;
  totalDeduplicated: number;
  totalRateLimited: number;
  totalTimedOut: number;
  maxConcurrent: number;
};

// ── Defaults ──────────────────────────────────────────────────

const MOBILE_RETRY_POLICY: RecoveryRetryPolicy = {
  maxAttempts: 2,
  baseDelayMs: 2000,
  maxDelayMs: 15000,
  jitterFactor: 0.5,
};

const DEFAULT_RETRY_POLICY: RecoveryRetryPolicy = {
  maxAttempts: 5,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
  jitterFactor: 0.3,
};

const DEFAULT_MAX_CONCURRENT = 2;
const DEFAULT_ACTION_TIMEOUT_MS = 60_000;
const DEFAULT_RECORD_RETENTION_MS = 300_000; // 5 min

// ── Detection ─────────────────────────────────────────────────

function detectMobileProfile(): boolean {
  // Only Android (Termux) is a mobile profile. arch === "arm64" alone must
  // not count: Apple Silicon dev machines and Graviton servers are arm64 and
  // were silently getting the conservative mobile retry policy.
  const platform = typeof process !== "undefined" ? process.platform : "";
  return platform === "android";
}

function detectLowResource(): boolean {
  // Termux on Android typically has limited memory
  if (detectMobileProfile()) return true;
  try {
    // This is an ESM module: require() is undefined at runtime, so the
    // previous require("os") always threw and low-memory detection never
    // fired off-mobile.
    const memInfo = os.totalmem?.();
    if (memInfo && memInfo < 2 * 1024 * 1024 * 1024) return true; // < 2 GB
  } catch {}
  return false;
}

// ── Guard ─────────────────────────────────────────────────────

export type RecoveryGuard = {
  /** Current status snapshot for broker command center display. */
  status: () => RecoveryGuardStatus;

  /**
   * Evaluate whether a recovery action should proceed.
   * Returns { allowed: true, dedup: false } if the action is new and can run.
   * Returns { allowed: true, dedup: true } if it was already registered (idempotent pass).
   * Returns { allowed: false, reason } if blocked by concurrency, rate, or timeout.
   */
  evaluate: (params: {
    actionId: RecoveryActionId;
    kind: RecoveryActionKind;
    taskId: string;
  }) => RecoveryEvaluateResult;

  /** Mark a recovery action as started. */
  start: (actionId: RecoveryActionId) => void;

  /** Mark a recovery action as completed (success). */
  complete: (actionId: RecoveryActionId) => void;

  /** Mark a recovery action as failed and optionally schedule retry. */
  fail: (actionId: RecoveryActionId, error: string) => void;

  /** Calculate the next retry delay for an action (ms). Returns 0 if no retry. */
  nextRetryDelayMs: (actionId: RecoveryActionId) => number;

  /** Check if an action is eligible for retry. */
  canRetry: (actionId: RecoveryActionId) => boolean;

  /** Purge completed/abandoned records older than retention period. */
  purge: () => number;

  /** Reset all state (for tests). */
  reset: () => void;
};

export type RecoveryEvaluateResult =
  | { allowed: true; dedup: boolean }
  | { allowed: false; reason: string };

export function createRecoveryGuard(options: RecoveryGuardOptions = {}): RecoveryGuard {
  const nowMs = options.nowMs ?? Date.now;
  const nodeProfile: RecoveryNodeProfile = {
    isMobile: options.nodeProfile?.isMobile ?? detectMobileProfile(),
    isLowResource: options.nodeProfile?.isLowResource ?? (options.nodeProfile?.isLowResource ?? detectLowResource()),
    nodeId: options.nodeProfile?.nodeId,
  };
  const retryPolicy: RecoveryRetryPolicy = {
    ...DEFAULT_RETRY_POLICY,
    ...(nodeProfile.isMobile || nodeProfile.isLowResource ? MOBILE_RETRY_POLICY : {}),
    ...options.retryPolicy,
  };
  const maxConcurrent = options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
  const actionTimeoutMs = options.actionTimeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS;
  const recordRetentionMs = options.recordRetentionMs ?? DEFAULT_RECORD_RETENTION_MS;

  const records = new Map<RecoveryActionId, RecoveryActionRecord>();
  let totalAttempted = 0;
  let totalDeduplicated = 0;
  let totalRateLimited = 0;
  let totalTimedOut = 0;

  function jitteredDelay(baseMs: number): number {
    const jitter = baseMs * retryPolicy.jitterFactor * Math.random();
    return Math.min(baseMs + jitter, retryPolicy.maxDelayMs);
  }

  function activeCount(): number {
    let count = 0;
    for (const r of records.values()) {
      if (r.status === "running") count++;
    }
    return count;
  }

  function pendingCount(): number {
    let count = 0;
    for (const r of records.values()) {
      if (r.status === "pending") count++;
    }
    return count;
  }

  function purgeExpired(): number {
    const cutoff = nowMs() - recordRetentionMs;
    let purged = 0;
    for (const [id, r] of records) {
      if (
        (r.status === "completed" || r.status === "abandoned") &&
        r.lastAttemptAtMs < cutoff
      ) {
        records.delete(id);
        purged++;
      }
    }
    return purged;
  }

  return {
    status() {
      // Check and abandon timed-out running actions
      for (const r of records.values()) {
        if (r.status === "running" && nowMs() - r.lastAttemptAtMs > actionTimeoutMs) {
          r.status = "abandoned";
          r.error = `Action timed out after ${actionTimeoutMs}ms`;
          totalTimedOut++;
        }
      }
      purgeExpired();
      return {
        nodeProfile,
        retryPolicy,
        activeCount: activeCount(),
        pendingCount: pendingCount(),
        totalAttempted,
        totalDeduplicated,
        totalRateLimited,
        totalTimedOut,
        maxConcurrent,
      };
    },

    evaluate({ actionId, kind, taskId }) {
      purgeExpired();

      // Check and abandon timed-out running actions
      for (const r of records.values()) {
        if (r.status === "running" && nowMs() - r.lastAttemptAtMs > actionTimeoutMs) {
          r.status = "abandoned";
          r.error = `Action timed out after ${actionTimeoutMs}ms`;
          totalTimedOut++;
        }
      }

      const existing = records.get(actionId);
      if (existing) {
        // Already running — dedup
        if (existing.status === "running") {
          totalDeduplicated++;
          return { allowed: true, dedup: true };
        }
        // Pending — dedup
        if (existing.status === "pending") {
          totalDeduplicated++;
          return { allowed: true, dedup: true };
        }
        // Completed or failed — check retry
        if (existing.status === "completed") {
          totalDeduplicated++;
          return { allowed: true, dedup: true };
        }
        // Failed or abandoned with retries exhausted — permanently blocked.
        // Previously neither status was checked against maxAttempts on this
        // path, so an exhausted (or timed-out/abandoned) action fell through
        // to re-registration and became immediately eligible again,
        // defeating the retry-storm guard.
        if (
          (existing.status === "failed" || existing.status === "abandoned") &&
          existing.attemptCount >= retryPolicy.maxAttempts
        ) {
          totalRateLimited++;
          return {
            allowed: false,
            reason: `Retries exhausted (${existing.attemptCount}/${retryPolicy.maxAttempts})`,
          };
        }
        // Failed or abandoned with retries remaining — enforce backoff.
        if (existing.status === "failed" || existing.status === "abandoned") {
          const delay = nextRetryDelayMsForRecord(existing, retryPolicy, nowMs());
          if (delay > 0) {
            totalRateLimited++;
            return { allowed: false, reason: `Retry backoff: ${Math.round(delay)}ms remaining` };
          }
          // Retry is ready — fall through to new registration
        }
      }

      // Concurrency check
      if (activeCount() >= maxConcurrent) {
        totalRateLimited++;
        return {
          allowed: false,
          reason: `Max concurrent recovery actions reached (${maxConcurrent}). ${activeCount()} active.`,
        };
      }

      // Register new action
      records.set(actionId, {
        id: actionId,
        kind,
        taskId,
        attemptCount: existing ? existing.attemptCount + 1 : 1,
        lastAttemptAtMs: nowMs(),
        status: "pending",
      });
      totalAttempted++;

      return { allowed: true, dedup: false };
    },

    start(actionId) {
      const r = records.get(actionId);
      if (r && r.status === "pending") {
        r.status = "running";
        r.lastAttemptAtMs = nowMs();
      }
    },

    complete(actionId) {
      const r = records.get(actionId);
      if (r) {
        r.status = "completed";
        r.lastAttemptAtMs = nowMs();
      }
    },

    fail(actionId, error) {
      const r = records.get(actionId);
      if (r) {
        r.status = "failed";
        r.error = error;
        r.lastAttemptAtMs = nowMs();
        if (r.attemptCount < retryPolicy.maxAttempts) {
          const delay = jitteredDelay(
            retryPolicy.baseDelayMs * Math.pow(2, r.attemptCount),
          );
          r.nextRetryAtMs = nowMs() + delay;
        } else {
          r.status = "abandoned";
        }
      }
    },

    nextRetryDelayMs(actionId) {
      const r = records.get(actionId);
      if (!r || r.status !== "failed") return 0;
      return nextRetryDelayMsForRecord(r, retryPolicy, nowMs());
    },

    canRetry(actionId) {
      const r = records.get(actionId);
      if (!r || r.status !== "failed") return false;
      if (r.attemptCount >= retryPolicy.maxAttempts) return false;
      return nextRetryDelayMsForRecord(r, retryPolicy, nowMs()) <= 0;
    },

    purge: purgeExpired,

    reset() {
      records.clear();
      totalAttempted = 0;
      totalDeduplicated = 0;
      totalRateLimited = 0;
      totalTimedOut = 0;
    },
  };
}

function nextRetryDelayMsForRecord(
  r: RecoveryActionRecord,
  policy: RecoveryRetryPolicy,
  nowMs: number,
): number {
  if (r.status !== "failed" || r.attemptCount >= policy.maxAttempts) return 0;
  if (r.nextRetryAtMs == null) return 0;
  return Math.max(0, r.nextRetryAtMs - nowMs);
}
