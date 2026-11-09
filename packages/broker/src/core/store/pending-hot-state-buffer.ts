// Pending hot-entity staging buffer, extracted from the InMemoryA2ABroker
// god-class (collaborator pattern from #1075-#1079). Between full snapshot
// persists, every record write stages a clone here so the next incremental
// ("hot") save can flush just the dirty rows. The broker held ten parallel Maps
// plus four near-identical methods (has-pending / drain-all / drain-retained /
// clear) that repeated the same plumbing across all ten categories.
//
// This collaborator owns those ten staging maps and the drain logic. Each
// category drains into one optional field of BrokerStateSaveHints; the map key
// equals the record id used both for staging and for the retained-id filter, so
// retention can be applied by key without re-deriving ids per category.
//
// #2523: a drained batch whose durable write fails is put back (`restore`), and
// `DurableWriteHealth` holds the fail-closed state that write failure opens:
// the two decide together what the next save must carry and whether the broker
// may accept a mutation at all.
import type {
  ArtifactRecord,
  AuditEvent,
  A2AExchangeMessageRecord,
  A2AExchangeState,
  BudgetRecord,
  ChangeProposal,
  GoalRecord,
  SpendEventRecord,
  SpendLateMeteringRecord,
  TaskRecord,
  TaskTombstone,
  ValidationResult,
  WorkerRecord,
} from "../types.js";
import type { TerminalTaskOutboxEvent } from "../completion/terminal-event-outbox.js";
import type { BrokerSnapshot, BrokerStateSaveHints } from "./store.js";

// The drain order matches the historical BrokerStateSaveHints construction order.
const HINT_KEYS = [
  "hotExchanges",
  "hotExchangeMessages",
  "hotProposals",
  "hotArtifacts",
  "hotValidations",
  "hotTasks",
  "hotTombstones",
  "hotAuditEvents",
  "hotWorkers",
  "hotTerminalOutboxEvents",
  "spendEvents",
  "spendMeterings",
  "budgets",
  "goals",
] as const;

export type PendingHintKey = (typeof HINT_KEYS)[number];
type HintKey = PendingHintKey;

/** The ten hot-table categories (the rest are ledger/budget/goal rows with no hot table). */
const HOT_TABLE_HINT_KEYS: ReadonlySet<HintKey> = new Set(HINT_KEYS.slice(0, 10));

/**
 * #2523: `hints` without the hot-table categories (undefined when nothing is
 * left). A save given these takes the store's full-write path, which rewrites
 * every hot table from the snapshot; the spend, metering, budget and goal rows
 * have no snapshot copy, so they must still ride the hints.
 */
export function withoutHotTableHints(hints: BrokerStateSaveHints | undefined): BrokerStateSaveHints | undefined {
  if (!hints) return undefined;
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(hints)) {
    if (!HOT_TABLE_HINT_KEYS.has(key as HintKey)) kept[key] = value;
  }
  return Object.keys(kept).length > 0 ? (kept as BrokerStateSaveHints) : undefined;
}

// The staging-map key of a drained record, per category (restore re-keys by it).
const HINT_RECORD_ID: Record<HintKey, (record: unknown) => string> = {
  hotExchanges: (r) => (r as { id: string }).id,
  hotExchangeMessages: (r) => (r as { id: string }).id,
  hotProposals: (r) => (r as { id: string }).id,
  hotArtifacts: (r) => (r as { id: string }).id,
  hotValidations: (r) => (r as { id: string }).id,
  hotTasks: (r) => (r as { id: string }).id,
  hotTombstones: (r) => (r as { taskId: string }).taskId,
  hotAuditEvents: (r) => (r as { id: string }).id,
  hotWorkers: (r) => (r as { nodeId: string }).nodeId,
  hotTerminalOutboxEvents: (r) => (r as { id: string }).id,
  spendEvents: (r) => (r as { taskId: string }).taskId,
  spendMeterings: (r) => (r as { taskId: string }).taskId,
  budgets: (r) => (r as { id: string }).id,
  goals: (r) => (r as { id: string }).id,
};

// First write wins for these (see stageSpendEvent): a restored row is the
// earlier write, so it replaces anything staged for the same task since.
const FIRST_WRITE_WINS: ReadonlySet<HintKey> = new Set(["spendEvents", "spendMeterings"]);

// For each category, the ids still retained after retention is applied to a full
// snapshot. The staging map key equals these ids, so a key ∈ set test filters the
// staged clones the same way the broker did inline. `null` marks a category that
// retention never prunes (the spend ledger, #2499 slice 2, and its late
// meterings, slice 3a: neither is mirrored in the snapshot, so every staged
// entry is kept).
const RETAINED_IDS: Record<HintKey, ((snapshot: BrokerSnapshot) => Iterable<string>) | null> = {
  hotExchanges: (s) => s.exchanges.map((exchange) => exchange.id),
  hotExchangeMessages: (s) => s.exchangeMessages.map((message) => message.id),
  hotProposals: (s) => s.proposals.map((proposal) => proposal.id),
  hotArtifacts: (s) => s.artifacts.map((artifact) => artifact.id),
  hotValidations: (s) => s.validations.map((validation) => validation.id),
  hotTasks: (s) => s.tasks.map((task) => task.id),
  hotTombstones: (s) => (s.tombstones ?? []).map((tombstone) => tombstone.taskId),
  hotAuditEvents: (s) => s.auditEvents.map((event) => event.id),
  hotWorkers: (s) => s.workers.map((worker) => worker.nodeId),
  hotTerminalOutboxEvents: (s) => (s.terminalOutbox ?? []).map((event) => event.id),
  spendEvents: null,
  spendMeterings: null,
  // #2499 slice 3b: budget rows live in broker_budgets only, never pruned.
  budgets: null,
  // #2499 slice 3b-2: goal status updates live in broker_goals only.
  goals: null,
};

export class PendingHotStateBuffer {
  private readonly maps: Record<HintKey, Map<string, unknown>> = {
    hotExchanges: new Map(),
    hotExchangeMessages: new Map(),
    hotProposals: new Map(),
    hotArtifacts: new Map(),
    hotValidations: new Map(),
    hotTasks: new Map(),
    hotTombstones: new Map(),
    hotAuditEvents: new Map(),
    hotWorkers: new Map(),
    hotTerminalOutboxEvents: new Map(),
    spendEvents: new Map(),
    spendMeterings: new Map(),
    budgets: new Map(),
    goals: new Map(),
  };

  stageExchange(record: A2AExchangeState): void {
    this.maps.hotExchanges.set(record.id, structuredClone(record));
  }

  stageExchangeMessage(record: A2AExchangeMessageRecord): void {
    this.maps.hotExchangeMessages.set(record.id, structuredClone(record));
  }

  stageProposal(record: ChangeProposal): void {
    this.maps.hotProposals.set(record.id, structuredClone(record));
  }

  stageArtifact(record: ArtifactRecord): void {
    this.maps.hotArtifacts.set(record.id, structuredClone(record));
  }

  stageValidation(record: ValidationResult): void {
    this.maps.hotValidations.set(record.id, structuredClone(record));
  }

  stageTask(record: TaskRecord): void {
    this.maps.hotTasks.set(record.id, structuredClone(record));
  }

  stageTombstone(taskId: string, record: TaskTombstone): void {
    this.maps.hotTombstones.set(taskId, structuredClone(record));
  }

  stageAuditEvent(record: AuditEvent): void {
    this.maps.hotAuditEvents.set(record.id, structuredClone(record));
  }

  stageWorker(record: WorkerRecord): void {
    this.maps.hotWorkers.set(record.nodeId, structuredClone(record));
  }

  stageTerminalOutboxEvent(record: TerminalTaskOutboxEvent): void {
    this.maps.hotTerminalOutboxEvents.set(record.id, structuredClone(record));
  }

  /**
   * Stage one spend-ledger row (#2499 slice 2). First write wins, like the
   * store's `ON CONFLICT(task_id) DO NOTHING`: a second terminal-time staging
   * for the same task before the next flush never replaces the first.
   */
  stageSpendEvent(record: SpendEventRecord): void {
    if (this.maps.spendEvents.has(record.taskId)) return;
    this.maps.spendEvents.set(record.taskId, { ...record });
  }

  /**
   * Stage one late metering (#2499 slice 3a, G1). First write wins, like
   * stageSpendEvent; the store update is itself guarded to apply once.
   */
  stageSpendMetering(record: SpendLateMeteringRecord): void {
    if (this.maps.spendMeterings.has(record.taskId)) return;
    this.maps.spendMeterings.set(record.taskId, { ...record });
  }

  /**
   * Stage one budget row (#2499 slice 3b). Last write wins (the store
   * upserts by id), so a create then an update before the next flush stores
   * the updated row.
   */
  stageBudget(record: BudgetRecord): void {
    this.maps.budgets.set(record.id, { ...record });
  }

  /** The staged budget row for `id`, if any (#2499 slice 3b-2). */
  stagedBudget(id: string): BudgetRecord | undefined {
    const staged = this.maps.budgets.get(id) as BudgetRecord | undefined;
    return staged ? { ...staged } : undefined;
  }

  /**
   * Undo a staged budget row (a failed mutation's rollback, #2499 slice 3b).
   * #2499 slice 3b-2: `previous` (the row staged before the failed write)
   * is restored instead of dropped.
   */
  unstageBudget(id: string, previous?: BudgetRecord): void {
    if (previous) this.maps.budgets.set(id, { ...previous });
    else this.maps.budgets.delete(id);
  }

  /**
   * Stage one goal row update (#2499 slice 3b-2: a goal budget transition).
   * Last write wins; the store updates the existing `broker_goals` row.
   */
  stageGoal(record: GoalRecord): void {
    this.maps.goals.set(record.id, structuredClone(record));
  }

  /** The staged goal update for `id`, if any. */
  stagedGoal(id: string): GoalRecord | undefined {
    const staged = this.maps.goals.get(id) as GoalRecord | undefined;
    return staged ? structuredClone(staged) : undefined;
  }

  /** Undo a staged goal update (rollback); `previous` is restored when given. */
  unstageGoal(id: string, previous?: GoalRecord): void {
    if (previous) this.maps.goals.set(id, structuredClone(previous));
    else this.maps.goals.delete(id);
  }

  /** Whether any category has staged records awaiting a hot save. */
  hasPending(): boolean {
    return HINT_KEYS.some((key) => this.maps[key].size > 0);
  }

  /** Drop all staged records without draining them. */
  clear(): void {
    for (const key of HINT_KEYS) {
      this.maps[key].clear();
    }
  }

  /** Drain every staged record into save hints and clear, or undefined if empty. */
  consumeAll(): BrokerStateSaveHints | undefined {
    if (!this.hasPending()) {
      return undefined;
    }
    const hints = this.buildHints(() => true);
    this.clear();
    return hints;
  }

  /**
   * Drain only staged records still retained in `snapshot` (others were pruned by
   * retention and must not be re-persisted), then clear. Undefined if empty.
   */
  consumeRetained(snapshot: BrokerSnapshot): BrokerStateSaveHints | undefined {
    if (!this.hasPending()) {
      return undefined;
    }
    const retained = {} as Record<HintKey, Set<string> | null>;
    for (const key of HINT_KEYS) {
      const ids = RETAINED_IDS[key];
      retained[key] = ids ? new Set(ids(snapshot)) : null;
    }
    const hints = this.buildHints((key, id) => retained[key]?.has(id) ?? true);
    this.clear();
    return hints;
  }

  /**
   * #2523: put back the hints a failed durable write consumed, so no row is
   * lost with the write. A row staged again since (a newer version of the
   * same record) is kept; for the first-write-wins ledger categories the
   * restored row is the earlier write and replaces it. `except` skips
   * categories whose owner already resyncs memory from the store on a failed
   * queued write (budgets, goals): re-staging them would write a row memory
   * no longer holds. Re-writing a row that did commit is harmless: every lane
   * is an upsert, the spend insert is ON CONFLICT DO NOTHING and the late
   * metering update applies once.
   */
  restore(hints: BrokerStateSaveHints, options: { except?: readonly HintKey[] } = {}): void {
    const drained = hints as Partial<Record<HintKey, unknown[]>>;
    for (const key of HINT_KEYS) {
      if (options.except?.includes(key)) continue;
      const map = this.maps[key];
      for (const record of drained[key] ?? []) {
        const id = HINT_RECORD_ID[key](record);
        if (FIRST_WRITE_WINS.has(key) || !map.has(id)) map.set(id, record);
      }
    }
  }

  private buildHints(keep: (key: HintKey, id: string) => boolean): BrokerStateSaveHints {
    const hints: Record<string, unknown[]> = {};
    for (const key of HINT_KEYS) {
      const values: unknown[] = [];
      for (const [id, record] of this.maps[key]) {
        if (keep(key, id)) {
          values.push(record);
        }
      }
      if (values.length > 0) {
        hints[key] = values;
      }
    }
    return hints as BrokerStateSaveHints;
  }
}

/** #2523: where a durable write failed: synchronously in this process, or in a queued (worker-thread) write. */
export type DurableWriteTopology = "in_process" | "queued";

/** #2523: the fail-closed persistence state, as served by `/health` (`persistenceWrites`). */
export interface DurableWriteHealthSnapshot {
  state: "ok" | "degraded";
  /** When the current degraded period began (null while ok). */
  degradedSince: string | null;
  /**
   * The last failed durable write: when, where, the error class (`name`, plus
   * `/code` when the error has one, e.g. `Error/ERR_SQLITE_ERROR`) and the
   * message (bounded).
   */
  lastFailure: { at: string; topology: DurableWriteTopology; errorClass: string; message: string } | null;
  /** Failed durable writes since process start (every failure, also while degraded). */
  failuresTotal: number;
  /** Degraded periods ended by a successful recovery save since process start. */
  recoveriesTotal: number;
  lastRecoveredAt: string | null;
  recoveryProbe: {
    inFlight: boolean;
    lastAt: string | null;
    /** Recovery saves that failed in a row in this degraded period (reset when it clears). */
    consecutiveFailures: number;
    /** Wait before the next recovery save: the base interval, doubled per consecutive failure, capped. */
    intervalMs: number;
    baseIntervalMs: number;
    maxIntervalMs: number;
    /** Earliest time the next recovery save may run (null while ok or before the first probe). */
    nextAt: string | null;
  };
}

const FAILURE_MESSAGE_MAX_CHARS = 300;
/** #2523: cap of the recovery-save backoff (the base interval wins when it is larger). */
export const DEFAULT_RECOVERY_PROBE_MAX_INTERVAL_MS = 60_000;

/** `name`, plus `/code` when the error carries a string code (`Error/ERR_SQLITE_ERROR`). */
export function durableWriteErrorClass(error: unknown): string {
  if (!(error instanceof Error)) return typeof error;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && code.length > 0 ? `${error.name}/${code.slice(0, 60)}` : error.name;
}

/**
 * #2523: fail-closed persistence state. A failed durable write opens it; the
 * broker then refuses mutations (503 `state_unavailable`) until a recovery
 * save — a full save of memory issued after the failure — succeeds, or the
 * process restarts (a restart reloads memory from disk).
 *
 * Every failure bumps `epoch`. A recovery probe takes the epoch when it
 * starts and clears the state only if no failure arrived meanwhile, so a
 * queued write that fails after the probe was queued keeps the broker
 * degraded. The first probe after the state opens may run at once (a one-off
 * fault self-heals on the next mutation). After a failed probe the next one
 * waits `baseIntervalMs`, doubled per consecutive failure up to
 * `maxIntervalMs` (a full save is expensive and, in process, synchronous on
 * the event loop); never two queued probes at a time.
 */
export class DurableWriteHealth {
  private degradedSince: string | undefined;
  private epoch = 0;
  private lastFailure: DurableWriteHealthSnapshot["lastFailure"] = null;
  private failuresTotal = 0;
  private recoveriesTotal = 0;
  private lastRecoveredAt: string | null = null;
  private lastProbeAtMs: number | undefined;
  private probeInFlight = false;
  private consecutiveProbeFailures = 0;
  private readonly maxIntervalMs: number;

  constructor(
    private readonly baseIntervalMs: number,
    maxIntervalMs = DEFAULT_RECOVERY_PROBE_MAX_INTERVAL_MS,
  ) {
    this.maxIntervalMs = Math.max(baseIntervalMs, maxIntervalMs);
  }

  get degraded(): boolean {
    return this.degradedSince !== undefined;
  }

  /** Record one failed durable write; true when it opened the degraded state. */
  markFailed(error: unknown, topology: DurableWriteTopology, nowMs = Date.now()): boolean {
    const at = new Date(nowMs).toISOString();
    const message = error instanceof Error ? error.message : String(error);
    this.epoch += 1;
    this.failuresTotal += 1;
    this.lastFailure = {
      at,
      topology,
      errorClass: durableWriteErrorClass(error),
      message: message.slice(0, FAILURE_MESSAGE_MAX_CHARS),
    };
    if (this.degradedSince !== undefined) return false;
    this.degradedSince = at;
    this.lastProbeAtMs = undefined;
    this.consecutiveProbeFailures = 0;
    return true;
  }

  /** The wait after the last probe: base, doubled per consecutive failure, capped. */
  private currentIntervalMs(): number {
    if (this.consecutiveProbeFailures <= 1) return this.baseIntervalMs;
    const factor = 2 ** Math.min(this.consecutiveProbeFailures - 1, 30);
    return Math.min(this.maxIntervalMs, this.baseIntervalMs * factor);
  }

  /**
   * Claim a recovery probe: the epoch token to pass to `probeSettled`, or
   * undefined when not degraded, a queued probe is still in flight, or the
   * backoff since the last probe has not elapsed.
   */
  beginProbe(options: { queued: boolean }, nowMs = Date.now()): number | undefined {
    if (!this.degraded || this.probeInFlight) return undefined;
    if (this.lastProbeAtMs !== undefined && nowMs - this.lastProbeAtMs < this.currentIntervalMs()) return undefined;
    this.lastProbeAtMs = nowMs;
    this.probeInFlight = options.queued;
    return this.epoch;
  }

  /**
   * Settle a probe; true when its success cleared the degraded state. A
   * failed probe counts toward the backoff; a successful one superseded by a
   * newer failure (stale epoch) neither counts nor clears.
   */
  probeSettled(token: number, ok: boolean, nowMs = Date.now()): boolean {
    this.probeInFlight = false;
    if (!this.degraded) return false;
    if (!ok) {
      this.consecutiveProbeFailures += 1;
      return false;
    }
    if (token !== this.epoch) return false;
    this.degradedSince = undefined;
    this.consecutiveProbeFailures = 0;
    this.recoveriesTotal += 1;
    this.lastRecoveredAt = new Date(nowMs).toISOString();
    return true;
  }

  snapshot(): DurableWriteHealthSnapshot {
    const nextAtMs = this.degraded && this.lastProbeAtMs !== undefined
      ? this.lastProbeAtMs + this.currentIntervalMs()
      : undefined;
    return {
      state: this.degraded ? "degraded" : "ok",
      degradedSince: this.degradedSince ?? null,
      lastFailure: this.lastFailure ? { ...this.lastFailure } : null,
      failuresTotal: this.failuresTotal,
      recoveriesTotal: this.recoveriesTotal,
      lastRecoveredAt: this.lastRecoveredAt,
      recoveryProbe: {
        inFlight: this.probeInFlight,
        lastAt: this.lastProbeAtMs === undefined ? null : new Date(this.lastProbeAtMs).toISOString(),
        consecutiveFailures: this.consecutiveProbeFailures,
        intervalMs: this.currentIntervalMs(),
        baseIntervalMs: this.baseIntervalMs,
        maxIntervalMs: this.maxIntervalMs,
        nextAt: nextAtMs === undefined ? null : new Date(nextAtMs).toISOString(),
      },
    };
  }
}
