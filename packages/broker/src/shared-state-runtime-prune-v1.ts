/**
 * #2344: in-process periodic physical prune of the V1 serving file's
 * append-only tables (`shared_state_replay_nonce`, `shared_state_rate_cost`).
 *
 * The reserve/consume primitives deliberately leave expired rows on disk
 * (#2081 — physical cleanup timing must never be observable in a logical
 * answer), and the only caller of `pruneSharedStateSqliteV1` used to be the
 * offline operator tool, which requires a stopped broker. With the replay or
 * rate primitive on, the serving file therefore grew without bound (#1504
 * Phase 7-A: 267 of 288 nonce rows already expired ~20 minutes after start).
 *
 * This runs the same prune through the serving fence's own single-writer
 * connection (`SharedStateServingFenceV1.pruneExpiredRows`), so it never
 * contends with the request path the way a second connection would under
 * `timeout: 0`. Deleting rows stops growth; it does not shrink the file
 * (no auto_vacuum) — reclaiming space stays an offline `VACUUM`.
 *
 * Configuration (all validated at startup; invalid values fail loudly):
 * - `BROKER_SHARED_STATE_V1_PRUNE` (`on` | `off`, default `on`). Only takes
 *   effect while the replay or rate primitive is on; otherwise there is
 *   nothing to prune and no timer is started.
 * - `BROKER_SHARED_STATE_V1_PRUNE_INTERVAL_MS` (default 60000, 1000..3600000).
 * - `BROKER_SHARED_STATE_V1_RATE_RETENTION_MS` (default 86400000). Must be
 *   strictly greater than every rate window still being reserved against.
 *
 * The shadow file (`BROKER_SHADOW_STATE_V1`) is intentionally out of scope.
 */

import type { SharedStateFencePruneOutcomeV1 } from "./shared-state-serving-fence-v1.js";

export const SHARED_STATE_RUNTIME_PRUNE_V1 = Object.freeze({
  kind: "SharedStateRuntimePruneV1",
  modeEnvKey: "BROKER_SHARED_STATE_V1_PRUNE",
  intervalEnvKey: "BROKER_SHARED_STATE_V1_PRUNE_INTERVAL_MS",
  retentionEnvKey: "BROKER_SHARED_STATE_V1_RATE_RETENTION_MS",
  defaultIntervalMs: 60_000,
  minIntervalMs: 1_000,
  maxIntervalMs: 3_600_000,
  defaultRateCostRetentionMs: 86_400_000,
  /** Emit one aggregate log line at most once per this many runs. */
  summaryEveryRuns: 60,
  logPrefix: "[a2a-broker] shared-state V1 runtime prune",
} as const);

export interface SharedStateRuntimePruneConfigV1 {
  readonly enabled: boolean;
  readonly intervalMs: number;
  readonly rateCostRetentionMs: number;
}

export interface SharedStateRuntimePruneConfigInputV1 {
  readonly enabled?: boolean | undefined;
  readonly intervalMs?: number | undefined;
  readonly rateCostRetentionMs?: number | undefined;
}

function parseMode(raw: string | undefined): boolean {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "" || value === "on") return true;
  if (value === "off") return false;
  throw new Error(
    `invalid ${SHARED_STATE_RUNTIME_PRUNE_V1.modeEnvKey}='${raw}' (expected on | off)`,
  );
}

function parseIntegerMs(name: string, raw: string | undefined, fallback: number): number {
  const value = (raw ?? "").trim();
  if (value === "") return fallback;
  if (!/^[0-9]+$/.test(value)) {
    throw new Error(`invalid ${name}='${raw}' (expected a positive integer of milliseconds)`);
  }
  return Number(value);
}

/**
 * Resolves and validates the runtime prune configuration. Explicit options
 * win over the environment. `maxRateWindowMs` is the largest rate window the
 * broker reserves against (general and worker buckets); the rate-cost
 * retention must strictly exceed it so a prune can never drop a cost row that
 * a live window still counts.
 */
export function resolveSharedStateRuntimePruneConfigV1(
  input: SharedStateRuntimePruneConfigInputV1,
  env: Readonly<Record<string, string | undefined>>,
  maxRateWindowMs: number,
): SharedStateRuntimePruneConfigV1 {
  const C = SHARED_STATE_RUNTIME_PRUNE_V1;
  const enabled = input.enabled ?? parseMode(env[C.modeEnvKey]);
  const intervalMs = input.intervalMs
    ?? parseIntegerMs(C.intervalEnvKey, env[C.intervalEnvKey], C.defaultIntervalMs);
  const rateCostRetentionMs = input.rateCostRetentionMs
    ?? parseIntegerMs(C.retentionEnvKey, env[C.retentionEnvKey], C.defaultRateCostRetentionMs);

  if (!Number.isSafeInteger(intervalMs) || intervalMs < C.minIntervalMs || intervalMs > C.maxIntervalMs) {
    throw new Error(
      `invalid ${C.intervalEnvKey}=${intervalMs} (expected ${C.minIntervalMs}..${C.maxIntervalMs})`,
    );
  }
  if (!Number.isSafeInteger(rateCostRetentionMs) || rateCostRetentionMs <= maxRateWindowMs) {
    throw new Error(
      `invalid ${C.retentionEnvKey}=${rateCostRetentionMs} (must exceed the largest rate window, ${maxRateWindowMs}ms)`,
    );
  }
  return Object.freeze({ enabled, intervalMs, rateCostRetentionMs });
}

export interface SharedStateRuntimePruneStatsV1 {
  readonly runs: number;
  readonly pruned: number;
  readonly skipped: number;
  readonly failed: number;
  readonly rateCostDeleted: number;
  readonly nonceDeleted: number;
  readonly lastOutcome: SharedStateFencePruneOutcomeV1["outcome"] | null;
  readonly lastReasonCode: string | null;
  readonly lastRunAtMs: number | null;
}

export interface SharedStateRuntimePruneV1 {
  /** One prune pass now; never throws. */
  runOnce(nowMs?: number): SharedStateFencePruneOutcomeV1;
  start(): void;
  stop(): void;
  stats(): SharedStateRuntimePruneStatsV1;
}

export function createSharedStateRuntimePruneV1(input: {
  readonly config: SharedStateRuntimePruneConfigV1;
  /** Resolves the CURRENT fence prune entry point; `undefined` = no fence. */
  readonly prune: (
    rateCostRetentionMs: number,
    nowMs: number,
  ) => SharedStateFencePruneOutcomeV1 | undefined;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
}): SharedStateRuntimePruneV1 {
  const C = SHARED_STATE_RUNTIME_PRUNE_V1;
  const now = input.now ?? Date.now;
  const log = input.log ?? ((line: string) => console.log(line));
  let timer: ReturnType<typeof setInterval> | undefined;
  let runs = 0;
  let pruned = 0;
  let skipped = 0;
  let failed = 0;
  let rateCostDeleted = 0;
  let nonceDeleted = 0;
  let lastOutcome: SharedStateFencePruneOutcomeV1["outcome"] | null = null;
  let lastReasonCode: string | null = null;
  let lastRunAtMs: number | null = null;
  // Window counters for the aggregate summary line.
  let windowRuns = 0;
  let windowRateCost = 0;
  let windowNonce = 0;
  // Last logged non-pruned state, so a persistent skip/failure logs once on
  // entry (and once on recovery) instead of every tick.
  let loggedState: string | null = null;

  const runOnce = (nowMs: number = now()): SharedStateFencePruneOutcomeV1 => {
    let outcome: SharedStateFencePruneOutcomeV1;
    try {
      outcome = input.prune(input.config.rateCostRetentionMs, nowMs)
        ?? Object.freeze({ outcome: "skipped", reasonCode: "adapter_unavailable" });
    } catch {
      outcome = Object.freeze({ outcome: "failed", reasonCode: "store_failure" });
    }
    runs += 1;
    windowRuns += 1;
    lastRunAtMs = nowMs;
    lastOutcome = outcome.outcome;
    if (outcome.outcome === "pruned") {
      pruned += 1;
      rateCostDeleted += outcome.rateCostDeleted;
      nonceDeleted += outcome.nonceDeleted;
      windowRateCost += outcome.rateCostDeleted;
      windowNonce += outcome.nonceDeleted;
      lastReasonCode = null;
      if (loggedState !== null) {
        log(`${C.logPrefix}: recovered (was ${loggedState})`);
        loggedState = null;
      }
    } else {
      if (outcome.outcome === "skipped") skipped += 1;
      else failed += 1;
      lastReasonCode = outcome.reasonCode;
      const state = `${outcome.outcome}:${outcome.reasonCode}`;
      if (state !== loggedState) {
        log(`${C.logPrefix}: ${outcome.outcome} (${outcome.reasonCode})`);
        loggedState = state;
      }
    }
    if (windowRuns >= C.summaryEveryRuns) {
      if (windowRateCost > 0 || windowNonce > 0) {
        log(
          `${C.logPrefix}: ${windowRuns} runs deleted nonce=${windowNonce} rateCost=${windowRateCost}`,
        );
      }
      windowRuns = 0;
      windowRateCost = 0;
      windowNonce = 0;
    }
    return outcome;
  };

  return Object.freeze({
    runOnce,
    start(): void {
      if (timer !== undefined || !input.config.enabled) return;
      timer = setInterval(() => {
        runOnce();
      }, input.config.intervalMs);
      timer.unref?.();
    },
    stop(): void {
      if (timer === undefined) return;
      clearInterval(timer);
      timer = undefined;
    },
    stats(): SharedStateRuntimePruneStatsV1 {
      return Object.freeze({
        runs,
        pruned,
        skipped,
        failed,
        rateCostDeleted,
        nonceDeleted,
        lastOutcome,
        lastReasonCode,
        lastRunAtMs,
      });
    },
  });
}
