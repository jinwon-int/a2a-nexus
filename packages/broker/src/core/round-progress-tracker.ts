// Single source of truth for parent-round progress (`n/N`) metadata.
//
// Before this module the numerator logic existed as two independent copies —
// one in `task-event-stream.ts` (SSE/compact terminal events) and one in
// `terminal-event-outbox.ts` (operator-facing Terminal Brief) — each with its
// own `Map<string, Set<string>>` counter. The copies drifted in two ways:
//
//   1. Guard semantics. The stream copy used `parentRoundTotal === undefined`
//      to decide whether to publish progress, so a payload carrying
//      `parentRoundTotal: 0` still rendered a numerator (`3/0`). The outbox
//      copy used a truthy check and omitted the field instead, which is the
//      documented contract: `terminal-event-outbox.ts` states that when the
//      total is unknown the field is omitted "so downstream notifiers fall
//      back instead of rendering misleading `n/?` progress", and
//      `core/task-events.test.ts` asserts exactly that fallback
//      (`parentRoundProgress === undefined` plus a
//      "진단: parentRoundTotal, parentRoundOrder 누락" title).
//      => the outbox semantics are the correct ones and are adopted here.
//
//   2. Counter state. The outbox rebuilds its counters from the persisted
//      snapshot on restore, while the stream always started empty, so after a
//      broker restart (or after an outbox `seen`-dedup rejection) the two
//      surfaces reported different numerators for the same round. They now
//      share one {@link RoundProgressTracker} instance, so SSE and the
//      Terminal Brief cannot disagree.
//
// The tracker is also bounded: the old raw Maps grew without limit for the
// lifetime of the process (one entry per run key, one string per child task
// id), which is a slow leak on long-lived brokers.

/** Default cap on the number of distinct run/round keys retained. */
export const DEFAULT_ROUND_PROGRESS_MAX_RUNS = 512;
/** Default per-run idle TTL before a run's counter is evicted (24h). */
export const DEFAULT_ROUND_PROGRESS_TTL_MS = 24 * 60 * 60 * 1000;
/** Default cap on child task ids retained per run key. */
export const DEFAULT_ROUND_PROGRESS_MAX_CHILDREN_PER_RUN = 512;

export interface RoundProgressTrackerOptions {
  /** Maximum distinct run keys retained; least-recently-touched runs evict first. */
  maxRuns?: number;
  /** Idle TTL per run key in milliseconds. Values <= 0 disable TTL eviction. */
  ttlMs?: number;
  /** Maximum unique child task ids retained per run key. */
  maxChildrenPerRun?: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

interface RunEntry {
  children: Set<string>;
  /** Number of children observed, including any dropped by the per-run cap. */
  observed: number;
  touchedAt: number;
}

function positiveInt(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

/**
 * Bounded per-run counter of unique terminal child task ids.
 *
 * Insertion order of the underlying Map is used as an LRU: `record()` re-inserts
 * the touched run key so the oldest untouched run is always the first entry.
 */
export class RoundProgressTracker {
  private readonly runs = new Map<string, RunEntry>();
  private readonly maxRuns: number;
  private readonly ttlMs: number;
  private readonly maxChildrenPerRun: number;
  private readonly now: () => number;
  /** Number of run keys evicted by cap/TTL since construction (diagnostics). */
  private evictedRuns = 0;

  constructor(options: RoundProgressTrackerOptions = {}) {
    this.maxRuns = positiveInt(options.maxRuns, DEFAULT_ROUND_PROGRESS_MAX_RUNS);
    this.ttlMs = options.ttlMs === undefined
      ? DEFAULT_ROUND_PROGRESS_TTL_MS
      : options.ttlMs;
    this.maxChildrenPerRun = positiveInt(
      options.maxChildrenPerRun,
      DEFAULT_ROUND_PROGRESS_MAX_CHILDREN_PER_RUN,
    );
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Record `taskId` as a terminal child of `runKey` and return the resulting
   * unique-child count for that run.
   */
  record(runKey: string, taskId: string): number {
    this.evictExpired();
    const entry = this.runs.get(runKey);
    if (entry) {
      // Re-insert to refresh LRU position.
      this.runs.delete(runKey);
      if (!entry.children.has(taskId)) {
        entry.observed += 1;
        if (entry.children.size < this.maxChildrenPerRun) entry.children.add(taskId);
      }
      entry.touchedAt = this.now();
      this.runs.set(runKey, entry);
      return entry.observed;
    }
    const created: RunEntry = {
      children: new Set([taskId]),
      observed: 1,
      touchedAt: this.now(),
    };
    this.runs.set(runKey, created);
    this.evictOverflow();
    return created.observed;
  }

  /** Current unique-child count for a run key (0 when unknown/evicted). */
  count(runKey: string): number {
    return this.runs.get(runKey)?.observed ?? 0;
  }

  /** Number of distinct run keys currently retained. */
  get size(): number {
    return this.runs.size;
  }

  /** Diagnostics counter: run keys dropped by the cap or TTL. */
  get evictions(): number {
    return this.evictedRuns;
  }

  /** Drop all counters. */
  clear(): void {
    this.runs.clear();
  }

  /**
   * Merge persisted (run, taskId) pairs into the tracker. Used on snapshot
   * restore so counters resume at the correct completed-lane count. Merging is
   * additive rather than destructive because the tracker is shared with the
   * live event stream — a restore must not erase lanes already observed
   * in-process.
   */
  mergeFrom(entries: Iterable<{ run?: string; taskId: string }>): void {
    for (const entry of entries) {
      if (!entry.run) continue;
      this.record(entry.run, entry.taskId);
    }
  }

  private evictExpired(): void {
    if (this.ttlMs <= 0) return;
    const cutoff = this.now() - this.ttlMs;
    for (const [key, entry] of this.runs) {
      // Map iteration is insertion-ordered and `record()` re-inserts on touch,
      // so the first non-expired entry ends the sweep.
      if (entry.touchedAt > cutoff) break;
      this.runs.delete(key);
      this.evictedRuns += 1;
    }
  }

  private evictOverflow(): void {
    while (this.runs.size > this.maxRuns) {
      const oldest = this.runs.keys().next();
      if (oldest.done) return;
      this.runs.delete(oldest.value);
      this.evictedRuns += 1;
    }
  }
}

/**
 * Minimal shape the progress metadata writer needs. Kept structural so both
 * `TerminalTaskEventPayload` (outbox) and the compact stream payload satisfy it
 * without a circular import.
 */
export interface RoundProgressPayload {
  taskId: string;
  run?: string;
  parentRoundTotal?: number;
  parentRoundOrder?: number;
  parentRoundProgress?: number;
  parentRoundTerminalProgress?: number;
  parentRoundProgressSource?: "broker_local_count" | "parent_round_order";
}

/**
 * Stamp parent-round progress (`n/N`) onto a terminal payload.
 *
 * The numerator counts unique canonical children of the run that reached a
 * terminal status — succeeded/failed/canceled/blocked all close a lane.
 * Parent-owned handoff rows (`parentRoundProgressSource === "parent_round_order"`)
 * keep the parent's lane order instead, so a child/handoff broker cannot rewrite
 * parent lane 2/2 down to its local completion 1/2.
 *
 * When the payload has no run key this is a no-op. When `parentRoundTotal` is
 * unknown (absent or 0) the counter still advances but no progress field is
 * written, so downstream notifiers fall back to a readable title instead of
 * rendering misleading `n/?` (or `n/0`) progress.
 */
export function applyRoundProgressMetadata(
  payload: RoundProgressPayload,
  tracker: RoundProgressTracker,
): void {
  const runKey = payload.run;
  if (!runKey) return;

  const terminalCount = tracker.record(runKey, payload.taskId);

  if (!payload.parentRoundTotal) return;

  const useParentRoundOrder = payload.parentRoundProgressSource === "parent_round_order"
    && payload.parentRoundOrder !== undefined;
  payload.parentRoundProgress = useParentRoundOrder ? payload.parentRoundOrder : terminalCount;
  payload.parentRoundTerminalProgress = useParentRoundOrder
    ? payload.parentRoundOrder
    : terminalCount;
  if (!payload.parentRoundProgressSource) {
    payload.parentRoundProgressSource = "broker_local_count";
  }
}
