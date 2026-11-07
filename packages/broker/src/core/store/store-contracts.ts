import type {
  ArtifactRecord,
  AuditEvent,
  A2AExchangeMessageRecord,
  A2AExchangeState,
  BudgetListFilters,
  BudgetRecord,
  BudgetScopeType,
  ChangeProposal,
  GoalListFilters,
  GoalRecord,
  SpendEventRecord,
  SpendLateMeteringRecord,
  SpendTopRow,
  SpendTotalsQuery,
  SpendTotalsResult,
  TaskRecord,
  TaskTombstone,
  ValidationResult,
  WorkerRecord,
} from "../types.js";
import type { CrossBrokerTerminalBriefProjection } from "../completion/cross-broker-terminal-brief.js";
import type { PersistedWavePlan } from "../dispatch/wave-plan-store.js";
import type {
  ReviewLineageRecord,
  ProjectedReviewLineageObservation,
} from "a2a-review-lifecycle";
import type {
  AuthorizedReviewLineageSourceAdmissionV1,
  ReviewLineageObservationApplicationResult,
} from "./review-lineage-observation-store.js";
import type { TerminalTaskOutboxEvent } from "../completion/terminal-event-outbox.js";
import type { TaskPushNotificationConfig } from "../../a2a/push-notification-config.js";
import type {
  BrokerHotEntityDiagnostics,
  BrokerHotEntityHintCoverage,
  BrokerHotEntityMirrorStatus,
  BrokerHotHintCounts,
} from "../observability/hot-diagnostics.js";
import type { A2AConversationState } from "../transport/broker-conversation.js";


// Defined in store-schemas (kernel, #2453 Step 0); re-exported so existing
// importers keep their specifier.
export { CURRENT_BROKER_STATE_VERSION } from "../store-schemas.js";
export const DEFAULT_BROKER_STATE_MAX_BYTES = 50 * 1024 * 1024;

export interface BrokerSnapshot {
  version: number;
  exchanges: A2AExchangeState[];
  exchangeMessages: A2AExchangeMessageRecord[];
  /** Trusted Conversation Plane states (#1862); snapshot-extension field. */
  conversations?: A2AConversationState[];
  /** Receiving-broker mirrors of cross-broker conversations (#1864 relay). */
  conversationRelayMirrors?: A2AConversationState[];
  /** Outbound conversation relay log (#1864 relay). */
  conversationRelayOutbox?: import("../transport/broker-conversation-relay.js").ConversationRelayOutboxEntry[];
  proposals: ChangeProposal[];
  artifacts: ArtifactRecord[];
  validations: ValidationResult[];
  auditEvents: AuditEvent[];
  workers: WorkerRecord[];
  tasks: TaskRecord[];
  goals?: GoalRecord[];
  tombstones?: TaskTombstone[];
  terminalOutbox?: TerminalTaskOutboxEvent[];
  crossBrokerTerminalBriefs?: CrossBrokerTerminalBriefProjection[];
  wavePlans?: PersistedWavePlan[];
  reviewLineages?: ReviewLineageRecord[];
  pushNotificationConfigs?: TaskPushNotificationConfig[];
  /** Parent round registry (#2339 PR-1a); snapshot-only sidecar, no hot table. */
  parentRounds?: import("../dispatch/parent-round-registry.js").ParentRoundRegistryEntry[];
  /** NCLEX evaluation receipts (#1724); snapshot-extension field, passthrough schema. */
  nclexEvaluationReceipts?: Array<{
    receipt: import("a2a-nclex-evaluation").NclexSignedReceipt;
    recordedAt: string;
  }>;
}

export interface BrokerStateStore {
  load(): BrokerSnapshot;
  save(snapshot: BrokerSnapshot, hints?: BrokerStateSaveHints): void;
  /**
   * Apply one normalized record-mode observation through the store's canonical
   * lineage authority. SQLite implementations must commit the lineage and
   * idempotency outcome in one transaction.
   */
  applyReviewLineageObservation?(
    command: ProjectedReviewLineageObservation,
  ):
    | ReviewLineageObservationApplicationResult
    | Promise<ReviewLineageObservationApplicationResult>;
  /**
   * Commit one authenticated source event and its canonical lineage/ledger
   * outcome in the same durable transaction.
   */
  applyAuthorizedReviewLineageSource?(
    admission: AuthorizedReviewLineageSourceAdmissionV1,
  ):
    | ReviewLineageObservationApplicationResult
    | Promise<ReviewLineageObservationApplicationResult>;
  /** Read the canonical lineage projection after a durable observation ACK. */
  listCanonicalReviewLineages?(): ReviewLineageRecord[];
  /**
   * Persist dirty hot-table rows without requiring the caller to build a full
   * BrokerSnapshot first. Stores that cannot support granular writes should
   * leave this undefined so callers can fall back to save().
   */
  saveHotEntities?(hints: BrokerStateSaveHints): void;
  /**
   * Run a caller-defined unit of work so that every store write it performs
   * commits once, atomically. Stores with no transaction concept leave this
   * undefined and callers just invoke the function directly.
   *
   * The broker uses this to collapse one task mutation (record upsert + audit
   * append + retention prune + persist) from four commits into one; in WAL mode
   * each commit is an fsync, so the commit count is the dominant write cost.
   * Implementations must join an already-open transaction rather than nesting.
   */
  runBatch?<T>(fn: () => T): T;
  /**
   * Optional durable-write acknowledgement hook for queued/asynchronous stores.
   * Mutating HTTP routes call this after broker mutation and before returning
   * success, preserving the existing "persistState returned" ACK boundary.
   */
  awaitDurablePersistenceAck?(): Promise<void>;
  /**
   * #2499 slice 3b-2: the most recently queued write (worker-thread
   * topology), without taking it out of the set awaitDurablePersistenceAck
   * reports on; undefined when no write is queued or writes are synchronous
   * (in-process SQLite). Lets the broker settle in-memory state that waits on
   * one write (budget write generations, the goal overlay). #2499 slice 4:
   * cleared once that write settles; callers compare it with the value seen
   * before their own mutation, so an earlier call's write is never theirs.
   */
  latestQueuedWrite?(): Promise<unknown> | undefined;
  getPersistenceInfo?(): BrokerPersistenceInfo;
  /** Atomically record first use of a live-approval scope key. Returns false on replay. */
  consumeLiveApprovalKey?(key: string, consumedAt: string): boolean;
  /**
   * Goal persistence (#2499 slice 1). SQLite stores keep one `broker_goals`
   * row per goal and implement all four; a store that leaves them undefined
   * gets broker-held goals carried in its snapshot instead.
   *
   * `insertGoal` is create-only: an existing id is a `BrokerError`
   * `invalid_transition` (409), never an overwrite. #2499 slice 3b-2: goal
   * status updates (the budget limits) reach the row through the save hints
   * (`BrokerStateSaveHints.goals`), with their audit row.
   */
  insertGoal?(goal: GoalRecord): void;
  readGoal?(id: string): GoalRecord | undefined;
  listGoals?(filters?: GoalListFilters): GoalRecord[];
  /** Task counts per status for tasks linked to `goalId` (indexed `goal_id` column). */
  countGoalTasksByStatus?(goalId: string): Record<string, number>;
  /**
   * Spend ledger read (#2499 slice 2): period totals from
   * `broker_spend_events` over the `(period_key, <scope>)` indexes. A store
   * that leaves this undefined has no spend ledger: the broker stages no
   * spend rows for it and `GET /budgets/status` reports `available: false`.
   */
  readSpendTotals?(query: SpendTotalsQuery): SpendTotalsResult;
  /**
   * Spend ledger reconciliation (#2499 slice 3a, SQLite only, optional like
   * readSpendTotals): ids of terminal `broker_tasks` rows (status succeeded,
   * failed or canceled) with no `broker_spend_events` row, ascending, after
   * `afterId`, at most `limit`. One anti-join over the task status column and
   * the ledger primary key; never reads `broker_tasks.payload`.
   */
  listTerminalTasksMissingSpend?(options: { limit: number; afterId?: string }): string[];
  /** The COUNT variant of listTerminalTasksMissingSpend (live, unbounded by limit). */
  countTerminalTasksMissingSpend?(): number;
  /**
   * Ledger coverage metadata in `broker_metadata` (#2499 slice 3a):
   * `spend_ledger_first_period` is written once (when absent) and
   * `spend_ledger_time_zone` is set to `timeZone`. Returns the stored values
   * from before the call. One statement per key on this connection (like
   * `insertGoal`), so it is durable when this returns on either topology.
   */
  syncSpendLedgerMetadata?(input: { periodKey: string; timeZone: string }): {
    previousFirstPeriod?: string;
    previousTimeZone?: string;
  };
  readSpendLedgerMetadata?(): { firstPeriod?: string; timeZone?: string };
  /**
   * #2499 slice 3b-2: one spend row's metering columns by task id (primary
   * key point read), for the lost-late-metering pass; undefined when absent.
   */
  readSpendEventMetering?(taskId: string): {
    agentId: string | null;
    costKnown: boolean;
    inputTokens: number;
    outputTokens: number;
  } | undefined;
  /**
   * Budgets and their evaluator reads (#2499 slice 3b, SQLite only, optional
   * like readSpendTotals; a store missing any of them has no budgets and the
   * budget routes report it). Budget rows are written only through the save
   * hints (`BrokerStateSaveHints.budgets`), so a row commits with its audit
   * event; these are the reads: the broker loads every budget once at
   * startup (`listBudgets`) and keeps them in memory.
   */
  readBudget?(id: string): BudgetRecord | undefined;
  listBudgets?(filters?: BudgetListFilters): BudgetRecord[];
  /** One scope's period spend: USD over cost_known rows, input + output tokens. */
  readSpendScopeUsage?(query: { periodKey: string; scopeType: BudgetScopeType; scopeId: string }): {
    usdSpent: number;
    tokensSpent: bigint;
  };
  /** Whether the agent has a cost_known row in the period (Decision 4). */
  hasCostReportingSpend?(query: { periodKey: string; agentId: string }): boolean;
  /** The largest rows of one scope in a period, by cost (cost_known only) or tokens. */
  listTopSpendRows?(query: {
    periodKey: string;
    scopeType: BudgetScopeType;
    scopeId: string;
    by: "cost" | "tokens";
    limit: number;
  }): SpendTopRow[];
}

export interface BrokerStateSaveHints {
  hotExchanges?: A2AExchangeState[];
  hotExchangeMessages?: A2AExchangeMessageRecord[];
  hotProposals?: ChangeProposal[];
  hotArtifacts?: ArtifactRecord[];
  hotValidations?: ValidationResult[];
  hotTasks?: TaskRecord[];
  hotTombstones?: TaskTombstone[];
  hotAuditEvents?: AuditEvent[];
  hotWorkers?: WorkerRecord[];
  /** Dirty terminal-outbox rows whose ack/receipt state must be table-persisted immediately. */
  hotTerminalOutboxEvents?: TerminalTaskOutboxEvent[];
  /**
   * Spend-ledger rows staged at terminal transitions (#2499 slice 2). Not a
   * hot entity mirror: the snapshot carries no spend, retention never prunes
   * it, and stores insert each row once (`ON CONFLICT(task_id) DO NOTHING`)
   * in the same transaction as the rest of these hints, so the row commits
   * with the terminal task write it was staged beside. Stores without a
   * spend ledger ignore the field.
   */
  spendEvents?: SpendEventRecord[];
  /**
   * #2499 slice 3a (G1): one-time late meterings of canceled tasks' spend
   * rows, applied after `spendEvents` in the same transaction. Like
   * `spendEvents`, not a hot entity mirror and never pruned; each is a single
   * guarded UPDATE that only touches a row that is still unmetered and
   * attributed to the late poster, so a replay is a no-op.
   */
  spendMeterings?: SpendLateMeteringRecord[];
  /**
   * #2499 slice 3b: budget rows created or updated by this mutation, upserted
   * by id in the same transaction as the rest of these hints (so with their
   * `budget.created` / `budget.updated` audit rows). Not a hot entity mirror:
   * the snapshot carries no budgets and retention never prunes them. Stores
   * without a budget table ignore the field.
   */
  budgets?: BudgetRecord[];
  /**
   * #2499 slice 3b-2: goal records whose status changed (goal budget limits),
   * written over their existing `broker_goals` row in the same transaction as
   * the rest of these hints (so with their `goal.status_changed` audit row).
   * Never inserts: goals are created by insertGoal. Stores without a goal
   * table ignore the field.
   */
  goals?: GoalRecord[];
}

export interface BrokerPersistenceInfo {
  kind: string;
  stateVersion: number;
  loadSource?: string;
  schemaVersion?: number;
  stateFile?: string;
  dbFile?: string;
  journalMode?: string;
  hotEntityTables?: string[];
  hotEntityHintTables?: string[];
  hotEntityHintCoverage?: BrokerHotEntityHintCoverage;
  hotEntityMirror?: BrokerHotEntityMirrorStatus;
  hotEntityDiagnostics?: BrokerHotEntityDiagnostics;
  hotTableLoadMetrics?: BrokerHotTableLoadMetrics;
  hotTableRuntimeLoadLimits?: BrokerHotTableRuntimeLoadLimits;
  importedFromJsonFile?: string;
  lastImportAt?: string;
  /** ISO timestamp of the most recent persist. */
  lastPersistAt?: string;
  /** Whether the most recent persist skipped full snapshot serialization (incremental hot-table mode). */
  lastPersistSkippedFullSnapshot?: boolean;
  /** Dirty-table hint counts for the most recent persist. */
  lastHotHintCounts?: BrokerHotHintCounts;
}

export interface BrokerHotTableRuntimeLoadLimits {
  /** Terminal task rows retained in live memory; active tasks always hydrate. */
  terminalTasks: number;
  auditEvents: number;
  terminalOutboxEvents: number;
}

export interface BrokerHotTableRuntimeLoadMetric {
  /** Configured runtime hydration cap for this table/window. */
  limit: number;
  /** Rows expected to hydrate into the in-memory runtime snapshot. */
  loadedCount: number;
  /** Rows left queryable in SQLite but skipped from startup/runtime hydration. */
  skippedCount: number;
  /** Only set for broker_tasks: active rows are always hydrated outside the terminal cap. */
  activeCount?: number;
  /** Only set for broker_tasks: completed/failed/canceled rows subject to the terminal cap. */
  terminalCount?: number;
}

export interface BrokerHotTableLoadMetricEntry {
  count: number;
  maxPayloadBytes: number;
  /** Sum of serialized payload bytes for rows in this hot table, when available. */
  totalPayloadBytes?: number;
  runtimeLoad?: BrokerHotTableRuntimeLoadMetric;
  /** Only set for broker_terminal_outbox. */
  unackedCount?: number;
}

export interface BrokerHotTableLoadMetrics {
  tables: Record<string, BrokerHotTableLoadMetricEntry>;
}

export interface JsonFileBrokerStateStoreOptions {
  maxBytes?: number;
}

export type SqliteBrokerLoadSource = "snapshot" | "hot-tables";

export interface SqliteBrokerStateStoreOptions {
  maxBytes?: number;
  importJsonFile?: string;
  loadSource?: SqliteBrokerLoadSource;
  /**
   * #1504 §3: the one-shot startup clock observation (last_persist_at vs the
   * host clock) defaults to "enforce". Inspection/export paths pass "skip":
   * exporting a database must not depend on the host clock being healthy,
   * which is exactly when recovery export is most needed. The version guards
   * (schema_version / state_version) are NOT skippable — they protect against
   * misreading a database this binary cannot honestly interpret.
   */
  startupClockCheck?: "enforce" | "skip";
  /**
   * Internal worker-thread proxy mode: main-thread loads may project a legacy
   * sidecar but must leave its one-time canonical import to the worker owner.
   */
  deferReviewLineageImport?: boolean;
  /**
   * Maximum non-terminal (queued/claimed/running/blocked) task rows to hydrate into live
   * memory when using loadSource=hot-tables. Non-terminal tasks are always loaded up to this
   * limit (ordered by updated_at DESC, id ASC). Default: 500.
   */
  maxHotRuntimeNonTerminalTasks?: number;
  /**
   * Maximum terminal task rows to hydrate into live memory when using
   * loadSource=hot-tables. Active/non-terminal tasks are always loaded.
   */
  maxHotRuntimeTerminalTasks?: number;
  /** Maximum audit rows to hydrate into live memory when using loadSource=hot-tables. */
  maxHotRuntimeAuditEvents?: number;
  /** Maximum heartbeat audit rows retained in the SQLite hot audit table. */
  maxHotRuntimeHeartbeatAuditEvents?: number;
  /** Maximum terminal outbox rows to hydrate into live memory when using loadSource=hot-tables. */
  maxHotRuntimeTerminalOutboxEvents?: number;
}

export interface SqliteAuditRuntimeRepositoryOptions {
  maxHotAuditEvents?: number;
  maxHotHeartbeatAuditEvents?: number;
}
