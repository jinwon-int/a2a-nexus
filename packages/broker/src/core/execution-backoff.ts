/**
 * Deterministic backoff computation for execution retry scheduling.
 *
 * Supports exponential, linear, and fixed strategies with configurable
 * base delay, max delay, and optional jitter. All computations are
 * deterministic given the same inputs (attempt number, config, and
 * optional seed), making them safe for replay and cross-worker
 * verification.
 *
 * Integration: used by ExecutionManager for retry delay planning and by
 * the scheduler/control-tower for operator-visible backoff schedules.
 *
 * Reference: a2a-plane#434 / a2a-broker#907 lane 3/4 (nosuk).
 */

import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Backoff strategy
// ---------------------------------------------------------------------------

export type BackoffStrategy = "exponential" | "linear" | "fixed";

/**
 * Backoff configuration for deterministic retry delay computation.
 *
 * All delays are computed as integers (ms). Jitter is additive noise
 * applied on top of the computed delay, bounded by jitterMs.
 */
export interface BackoffConfig {
  /** Backoff growth strategy. Default: "exponential". */
  strategy?: BackoffStrategy;
  /** Base delay in milliseconds. Default: 1_000 (1s). */
  baseMs?: number;
  /** Maximum delay cap in milliseconds. Default: 300_000 (5min). */
  maxMs?: number;
  /**
   * Maximum jitter in milliseconds. When > 0, jitter is computed as
   * a deterministic value in [0, jitterMs] based on attempt number
   * and optional seed. Default: 0 (no jitter).
   */
  jitterMs?: number;
  /**
   * Optional seed for deterministic jitter production. When provided,
   * the same seed + attempt always produces the same jitter value.
   * When omitted, the delay's own hash serves as seed.
   */
  seed?: string;
  /**
   * Multiplier for exponential strategy. Default: 2.
   * delay = baseMs * multiplier^(attempt-1) capped at maxMs.
   */
  multiplier?: number;
}

// ---------------------------------------------------------------------------
// Default thresholds
// ---------------------------------------------------------------------------

export const DEFAULT_BACKOFF_CONFIG: Required<BackoffConfig> = {
  strategy: "exponential",
  baseMs: 1_000,
  maxMs: 300_000, // 5 minutes
  jitterMs: 0,
  seed: "",
  multiplier: 2,
};

/**
 * Default backoff configs for each execution phase.
 * Queued retries use short backoff; claimed/running use longer windows.
 */
export const PHASE_BACKOFF_CONFIGS: Record<
  "queued" | "claimed" | "running",
  Required<BackoffConfig>
> = {
  queued: {
    strategy: "exponential",
    baseMs: 2_000,
    maxMs: 60_000, // 1 minute cap for queued retries
    jitterMs: 500,
    seed: "queue-phase",
    multiplier: 2,
  },
  claimed: {
    strategy: "exponential",
    baseMs: 5_000,
    maxMs: 120_000, // 2 minute cap for claimed retries
    jitterMs: 1_000,
    seed: "claim-phase",
    multiplier: 2,
  },
  running: {
    strategy: "exponential",
    baseMs: 10_000,
    maxMs: 300_000, // 5 minute cap for running retries
    jitterMs: 2_000,
    seed: "run-phase",
    multiplier: 2,
  },
};

// ---------------------------------------------------------------------------
// Pre-computed schedule
// ---------------------------------------------------------------------------

export interface BackoffEntry {
  /** 1-based attempt number. */
  attempt: number;
  /** Base delay before jitter. */
  baseDelayMs: number;
  /** Applied jitter (may be 0). */
  jitterMs: number;
  /** Total delay = baseDelayMs + jitterMs. */
  totalDelayMs: number;
  /** Cumulative delay across all entries up to this attempt. */
  cumulativeDelayMs: number;
}

export interface BackoffSchedule {
  /** Config used for computation. */
  config: Required<BackoffConfig>;
  /** Pre-computed entries for attempts 1..maxAttempts. */
  entries: BackoffEntry[];
  /** Total cumulative delay across all entries. */
  totalCumulativeMs: number;
}

// ---------------------------------------------------------------------------
// Pure functions
// ---------------------------------------------------------------------------

/** Normalize a partial BackoffConfig to its fully-resolved form. */
export function normalizeBackoffConfig(
  config?: BackoffConfig,
): Required<BackoffConfig> {
  const c = config ?? {};
  const strategy = c.strategy ?? DEFAULT_BACKOFF_CONFIG.strategy;
  const multiplier = c.multiplier ?? DEFAULT_BACKOFF_CONFIG.multiplier;
  const seed = c.seed ?? DEFAULT_BACKOFF_CONFIG.seed;
  return {
    strategy,
    baseMs: Math.max(1, c.baseMs ?? DEFAULT_BACKOFF_CONFIG.baseMs),
    maxMs: Math.max(1, c.maxMs ?? DEFAULT_BACKOFF_CONFIG.maxMs),
    jitterMs: Math.max(0, c.jitterMs ?? DEFAULT_BACKOFF_CONFIG.jitterMs),
    seed,
    multiplier: Math.max(1, multiplier),
  };
}

/**
 * Compute the deterministic base delay for a given attempt number
 * (1-based) without jitter.
 *
 * Exponential: baseMs * multiplier^(attempt-1), capped at maxMs.
 * Linear: baseMs + (attempt-1) * multiplier * baseMs, capped at maxMs.
 * Fixed: maxMs (or baseMs when maxMs < baseMs).
 */
export function computeBaseDelay(
  attempt: number,
  config?: BackoffConfig,
): number {
  const c = normalizeBackoffConfig(config);
  const n = Math.max(1, attempt);

  let delay: number;
  switch (c.strategy) {
    case "linear":
      delay = c.baseMs + (n - 1) * c.multiplier * c.baseMs;
      break;
    case "fixed":
      delay = c.baseMs;
      break;
    case "exponential":
    default:
      // baseMs * multiplier^(n-1) via multiplication loop to avoid float drift
      delay = c.baseMs;
      for (let i = 1; i < n; i++) {
        delay = delay * c.multiplier;
      }
      break;
  }

  return Math.min(delay, c.maxMs);
}

/**
 * Compute deterministic jitter for an attempt.
 *
 * Uses SHA-256 of (seed + ":" + attempt) to produce a value in [0, maxJitterMs].
 */
export function computeDeterministicJitter(
  attempt: number,
  seed: string,
  maxJitterMs: number,
): number {
  if (maxJitterMs <= 0) return 0;
  const n = Math.max(1, attempt);
  const hash = createHash("sha256")
    .update(`${seed}:${n}`)
    .digest("hex");
  // Use first 8 hex chars as a 32-bit integer, modulo (maxJitterMs + 1)
  const intVal = Number.parseInt(hash.slice(0, 8), 16);
  return intVal % (maxJitterMs + 1);
}

/**
 * Compute total backoff delay (base + jitter) for an attempt.
 *
 * Returns { baseDelayMs, jitterMs, totalDelayMs }.
 */
export function computeBackoffDelay(
  attempt: number,
  config?: BackoffConfig,
): { baseDelayMs: number; jitterMs: number; totalDelayMs: number } {
  const c = normalizeBackoffConfig(config);
  const n = Math.max(1, attempt);
  const baseDelayMs = computeBaseDelay(n, c);
  const jitterMs = computeDeterministicJitter(n, c.seed, c.jitterMs);
  return { baseDelayMs, jitterMs, totalDelayMs: baseDelayMs + jitterMs };
}

/**
 * Pre-compute a full backoff schedule for up to `maxAttempts` retries.
 */
export function buildBackoffSchedule(
  maxAttempts: number,
  config?: BackoffConfig,
): BackoffSchedule {
  const c = normalizeBackoffConfig(config);
  const count = Math.max(1, maxAttempts);
  const entries: BackoffEntry[] = [];
  let cumulative = 0;

  for (let i = 1; i <= count; i++) {
    const { baseDelayMs, jitterMs, totalDelayMs } = computeBackoffDelay(i, c);
    cumulative += totalDelayMs;
    entries.push({
      attempt: i,
      baseDelayMs,
      jitterMs,
      totalDelayMs,
      cumulativeDelayMs: cumulative,
    });
  }

  return {
    config: c,
    entries,
    totalCumulativeMs: cumulative,
  };
}

/**
 * Determine which entry in a backoff schedule applies for a given retry count.
 * Retry count 0 = first attempt (entry 1), retry count 1 = entry 2, etc.
 */
export function getBackoffEntry(
  retryCount: number,
  schedule: BackoffSchedule,
): BackoffEntry | undefined {
  const idx = Math.min(retryCount, schedule.entries.length - 1);
  return schedule.entries[idx];
}

/**
 * Serialize a backoff schedule to a compact summary for operator reports.
 */
export function serializeBackoffSchedule(
  schedule: BackoffSchedule,
): Record<string, unknown> {
  return {
    strategy: schedule.config.strategy,
    baseMs: schedule.config.baseMs,
    maxMs: schedule.config.maxMs,
    jitterMs: schedule.config.jitterMs,
    multiplier: schedule.config.multiplier,
    entries: schedule.entries.length,
    totalCumulativeMs: schedule.totalCumulativeMs,
    entryDelays: schedule.entries.map((e) => ({
      attempt: e.attempt,
      delayMs: e.totalDelayMs,
    })),
  };
}
