import type {
  ArtifactRecord,
  AuditEvent,
  A2AExchangeMessageRecord,
  A2AExchangeState,
  ChangeProposal,
  GoalRecord,
  TaskRecord,
  TaskTombstone,
  ValidationResult,
  WorkerRecord,
} from "./types.js";
import type { CrossBrokerTerminalBriefProjection } from "./cross-broker-terminal-brief.js";
import type { PersistedWavePlan } from "./wave-plan-store.js";
import type { ReviewLineageRecord } from "../review-lifecycle/types.js";
import type { ProjectedReviewLineageObservation } from "../review-lifecycle/observation.js";
import type {
  AuthorizedReviewLineageSourceAdmissionV1,
  ReviewLineageObservationApplicationResult,
} from "./review-lineage-observation-store.js";
import type { TerminalTaskOutboxEvent } from "./terminal-event-outbox.js";
import type { TaskPushNotificationConfig } from "../a2a/push-notification-config.js";
import type {
  BrokerHotEntityDiagnostics,
  BrokerHotEntityHintCoverage,
  BrokerHotEntityMirrorStatus,
  BrokerHotHintCounts,
} from "./hot-diagnostics.js";

export const CURRENT_BROKER_STATE_VERSION = 8;
export const DEFAULT_BROKER_STATE_MAX_BYTES = 50 * 1024 * 1024;

export interface BrokerSnapshot {
  version: number;
  exchanges: A2AExchangeState[];
  exchangeMessages: A2AExchangeMessageRecord[];
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
   * Optional durable-write acknowledgement hook for queued/asynchronous stores.
   * Mutating HTTP routes call this after broker mutation and before returning
   * success, preserving the existing "persistState returned" ACK boundary.
   */
  awaitDurablePersistenceAck?(): Promise<void>;
  getPersistenceInfo?(): BrokerPersistenceInfo;
  /** Atomically record first use of a live-approval scope key. Returns false on replay. */
  consumeLiveApprovalKey?(key: string, consumedAt: string): boolean;
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
