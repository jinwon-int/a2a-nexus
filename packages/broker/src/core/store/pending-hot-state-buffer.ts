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
import type {
  ArtifactRecord,
  AuditEvent,
  A2AExchangeMessageRecord,
  A2AExchangeState,
  ChangeProposal,
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
] as const;

type HintKey = (typeof HINT_KEYS)[number];

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
