import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { z } from "zod";

import type {
  ArtifactRecord,
  AuditEvent,
  A2AExchangeMessageRecord,
  A2AExchangeState,
  ChangeProposal,
  TaskRecord,
  TaskTombstone,
  ValidationResult,
  WorkerRecord,
} from "./types.js";
import { isHeartbeatAuditEvent } from "./broker-retention-selectors.js";
import {
  buildHotEntityHintCoverage,
  planAuditRetentionFromRecords,
  planTaskRetentionFromRecords,
  planTerminalOutboxRetentionFromRecords,
  planWorkerRetentionFromRecords,
} from "./store-hot-retention-planning.js";
import {
  buildHotTableSelect,
  buildHotTaskListItemSelect,
  normalizeNonNegativeSqliteLimit,
  normalizeOptionalSqliteLimit,
  parseHotTaskListItemProjection,
} from "./store-hot-select-projections.js";
import { DEFAULT_HOT_RUNTIME_MAX_HEARTBEAT_AUDIT_EVENTS } from "./store-runtime-repositories.js";
import * as hotDiagnostics from "./store-hot-diagnostics-read.js";
import {
  coerceSqliteCount,
  parseHotEntityPayloadResult,
  SQLITE_HOT_ENTITY_HINT_TABLES,
  SQLITE_HOT_ENTITY_SNAPSHOT_KEYS,
  SQLITE_HOT_ENTITY_TABLES,
  type HotDiagnosticsReadContext,
  type SqliteHotEntityTable,
} from "./store-hot-diagnostics-read.js";
import {
  DEFAULT_TERMINAL_TASK_OUTBOX_RETENTION,
  type TerminalTaskOutboxEvent,
} from "./terminal-event-outbox.js";
import {
  CURRENT_BROKER_STATE_VERSION as CURRENT_BROKER_STATE_VERSION_VALUE,
  DEFAULT_BROKER_STATE_MAX_BYTES as DEFAULT_BROKER_STATE_MAX_BYTES_VALUE,
} from "./store-contracts.js";
import type {
  BrokerHotTableLoadMetrics,
  BrokerHotTableRuntimeLoadLimits,
  BrokerPersistenceInfo,
  BrokerSnapshot,
  BrokerStateSaveHints,
  BrokerStateStore,
  SqliteBrokerLoadSource,
  SqliteBrokerStateStoreOptions,
} from "./store-contracts.js";
export {
  CURRENT_BROKER_STATE_VERSION,
  DEFAULT_BROKER_STATE_MAX_BYTES,
} from "./store-contracts.js";
export type {
  BrokerHotTableLoadMetricEntry,
  BrokerHotTableLoadMetrics,
  BrokerHotTableRuntimeLoadMetric,
  BrokerHotTableRuntimeLoadLimits,
  BrokerPersistenceInfo,
  BrokerSnapshot,
  BrokerStateSaveHints,
  BrokerStateStore,
  JsonFileBrokerStateStoreOptions,
  SqliteAuditRuntimeRepositoryOptions,
  SqliteBrokerLoadSource,
  SqliteBrokerStateStoreOptions,
} from "./store-contracts.js";
import type {
  BrokerHotAuditDiagnostics,
  BrokerHotEntityDiagnostics,
  BrokerHotEntityHintCoverage,
  BrokerHotEntityMirrorStatus,
  BrokerHotHintCounts,
  BrokerHotTerminalOutboxDiagnostics,
} from "./hot-diagnostics.js";
import {
  exchangeStateSchema,
  exchangeMessageSchema,
  taskSchema,
  proposalSchema,
  artifactSchema,
  validationSchema,
  auditEventSchema,
  workerSchema,
  tombstoneSchema,
  terminalOutboxEventSchema,
} from "./store-schemas.js";
import type { ProjectedReviewLineageObservation } from "../review-lifecycle/observation.js";
import type { ReviewLineageRecord } from "../review-lifecycle/types.js";
import {
  SqliteReviewLineageObservationStore,
  type ReviewLineageObservationApplicationResult,
} from "./review-lineage-observation-store.js";
import {
  JsonFileBrokerStateStore,
  emptySnapshot,
  parseSnapshotPayload,
} from "./store-snapshot-io.js";
import { fitSnapshotToBudget, SnapshotOverflowError } from "./store-snapshot-fit.js";

export {
  JsonFileBrokerStateStore,
  emptySnapshot,
  serializeBrokerSnapshot,
  writeBrokerSnapshotFile,
} from "./store-snapshot-io.js";
export { buildHotEntityHintCoverage } from "./store-hot-retention-planning.js";


export type {
  BrokerHotAuditDiagnostics,
  BrokerHotEntityDiagnostics,
  BrokerHotEntityHintCoverage,
  BrokerHotEntityMirrorMismatch,
  BrokerHotEntityMirrorRetentionWindow,
  BrokerHotEntityMirrorStatus,
  BrokerHotHintCounts,
  BrokerHotTerminalOutboxDiagnostics,
  BrokerInvalidHotEntityRow,
} from "./hot-diagnostics.js";

export interface SqliteTaskHotTableFilters {
  id?: string;
  status?: TaskRecord["status"];
  targetNodeId?: string;
  intent?: TaskRecord["intent"];
  assignedWorkerId?: string;
  taskOrigin?: TaskRecord["taskOrigin"];
  /** Optional cap on result rows to prevent unbounded heap materialization on hot-table diagnostic/cleanup reads. */
  maxRows?: number;
  /** Runtime listing cap. Unlike maxRows, limit=0 intentionally returns no rows. */
  limit?: number;
}

export interface SqliteTaskListItemProjection {
  id: string;
  intent: TaskRecord["intent"];
  status: TaskRecord["status"];
  targetNodeId: string;
  requester: TaskRecord["requester"];
  target: TaskRecord["target"];
  exchangeId?: string;
  parentTaskId?: string;
  proposalId?: string;
  assignedWorkerId?: string;
  claimedBy?: string;
  taskOrigin?: TaskRecord["taskOrigin"];
  artifactIds?: string[];
  resultSummary?: string;
  error?: Pick<NonNullable<TaskRecord["error"]>, "code" | "message">;
  requeueCount?: number;
  createdAt: string;
  updatedAt: string;
  claimedAt?: string;
  completedAt?: string;
}

export interface SqliteExchangeHotTableFilters {
  id?: string;
}

export interface SqliteExchangeMessageHotTableFilters {
  id?: string;
  exchangeId?: string;
}

export interface SqliteProposalHotTableFilters {
  id?: string;
  status?: ChangeProposal["status"];
  sourceNodeId?: string;
  targetNodeId?: string;
  kind?: ChangeProposal["kind"];
}

export interface SqliteArtifactHotTableFilters {
  id?: string;
  proposalId?: string;
}

export interface SqliteValidationHotTableFilters {
  id?: string;
  proposalId?: string;
}

export interface SqliteAuditHotTableFilters {
  proposalId?: string;
  actorId?: string;
  action?: AuditEvent["action"];
  targetType?: AuditEvent["targetType"];
  targetId?: string;
  /** Optional cap on result rows to prevent unbounded heap materialization on hot-table diagnostic/cleanup reads. */
  maxRows?: number;
}

export interface SqliteWorkerHotTableFilters {
  nodeId?: string;
  role?: WorkerRecord["role"];
  /** Optional cap on result rows to prevent unbounded heap materialization on hot-table diagnostic/cleanup reads. */
  maxRows?: number;
}

export interface SqliteTombstoneHotTableFilters {
  taskId?: string;
  tombstoneReason?: TaskTombstone["tombstoneReason"];
  terminalStatus?: TaskTombstone["terminalStatus"];
  since?: string;
  /** Optional cap on result rows to prevent unbounded heap materialization on hot-table diagnostic/cleanup reads. */
  maxRows?: number;
}

export interface SqliteHotRetentionPlan {
  table: "broker_exchanges" | "broker_exchange_messages" | "broker_proposals" | "broker_artifacts" | "broker_validations" | "broker_tasks" | "broker_tombstones" | "broker_audit_events" | "broker_workers" | "broker_terminal_outbox";
  cutoffMs: number;
  retainedIds: string[];
  pruneIds: string[];
  /**
   * Count of records retained solely because the max-records cap (e.g.
   * maxTerminalRecords or maxInactiveWorkers) prevented them from entering
   * the prune set. These are past the retention window but under the cap
   * limit. A value > 0 signals that these items are retention_not_due
   * rather than genuinely active/executable cleanup candidates.
   */
  retainedByCapCount?: number;
}

export interface SqliteHotRetentionApplyResult {
  table: SqliteHotRetentionPlan["table"];
  retainedCount: number;
  requestedPruneCount: number;
  prunedCount: number;
  remainingCount: number;
}

export interface SqliteCanonicalSnapshotRetentionSyncResult {
  synced: boolean;
  reason?: string;
  before?: {
    tasks: number;
    auditEvents: number;
    workers: number;
    terminalOutbox: number;
  };
  after?: {
    tasks: number;
    auditEvents: number;
    workers: number;
    terminalOutbox: number;
  };
}

export interface SqliteTaskHotRetentionPlanOptions {
  nowMs?: number;
  retentionMs: number;
  maxTerminalRecords: number;
  protectedTaskIds?: string[];
}

export interface SqliteAuditHotRetentionProtection {
  proposalIds?: string[];
  taskIds?: string[];
  exchangeIds?: string[];
  exchangeMessageIds?: string[];
  artifactIds?: string[];
  validationIds?: string[];
  workerIds?: string[];
}

export interface SqliteAuditHotRetentionPlanOptions {
  nowMs?: number;
  retentionMs: number;
  maxRecords: number;
  protectedIds?: SqliteAuditHotRetentionProtection;
}

export interface SqliteWorkerHotRetentionPlanOptions {
  nowMs?: number;
  retentionMs: number;
  maxInactiveWorkers: number;
  protectedWorkerIds?: string[];
}

export interface SqliteTerminalOutboxHotRetentionPlanOptions {
  nowMs?: number;
  retentionMs: number;
  maxAcknowledgedRecords: number;
}

const SQLITE_SCHEMA_VERSION = 12;
export const DEFAULT_HOT_RUNTIME_MAX_NON_TERMINAL_TASKS = 500;
export const DEFAULT_HOT_RUNTIME_MAX_TERMINAL_TASKS = 2_000;
export const DEFAULT_HOT_RUNTIME_MAX_AUDIT_EVENTS = 5_000;
// Defined in store-runtime-repositories.ts (its only value consumer besides
// this file) so that module's back-reference to store.js stays type-only;
// re-exported here to preserve the existing import path.
export { DEFAULT_HOT_RUNTIME_MAX_HEARTBEAT_AUDIT_EVENTS } from "./store-runtime-repositories.js";
export const DEFAULT_HOT_RUNTIME_MAX_TERMINAL_OUTBOX_EVENTS = DEFAULT_TERMINAL_TASK_OUTBOX_RETENTION;

export class SqliteBrokerStateStore implements BrokerStateStore {
  private readonly maxBytes: number;
  private readonly importJsonFile?: string;
  private readonly loadSource: SqliteBrokerLoadSource;
  private readonly maxHotRuntimeNonTerminalTasks: number;
  private readonly maxHotRuntimeTerminalTasks: number;
  private readonly maxHotRuntimeAuditEvents: number;
  private readonly maxHotRuntimeHeartbeatAuditEvents: number;
  private readonly maxHotRuntimeTerminalOutboxEvents: number;
  private readonly deferReviewLineageImport: boolean;
  private readonly db: DatabaseSync;
  private readonly journalMode: string;
  private readonly reviewLineageObservations: SqliteReviewLineageObservationStore;

  constructor(
    private readonly dbFile: string,
    options: SqliteBrokerStateStoreOptions = {},
  ) {
    this.maxBytes = Math.max(1, options.maxBytes ?? DEFAULT_BROKER_STATE_MAX_BYTES_VALUE);
    this.importJsonFile = options.importJsonFile;
    this.loadSource = options.loadSource ?? "snapshot";
    this.deferReviewLineageImport =
      options.deferReviewLineageImport ?? false;
    this.maxHotRuntimeNonTerminalTasks = normalizeNonNegativeSqliteLimit(
      options.maxHotRuntimeNonTerminalTasks,
      DEFAULT_HOT_RUNTIME_MAX_NON_TERMINAL_TASKS,
    );
    this.maxHotRuntimeTerminalTasks = normalizeNonNegativeSqliteLimit(
      options.maxHotRuntimeTerminalTasks,
      DEFAULT_HOT_RUNTIME_MAX_TERMINAL_TASKS,
    );
    this.maxHotRuntimeAuditEvents = normalizeNonNegativeSqliteLimit(
      options.maxHotRuntimeAuditEvents,
      DEFAULT_HOT_RUNTIME_MAX_AUDIT_EVENTS,
    );
    this.maxHotRuntimeHeartbeatAuditEvents = normalizeNonNegativeSqliteLimit(
      options.maxHotRuntimeHeartbeatAuditEvents,
      Math.min(this.maxHotRuntimeAuditEvents, DEFAULT_HOT_RUNTIME_MAX_HEARTBEAT_AUDIT_EVENTS),
    );
    this.maxHotRuntimeTerminalOutboxEvents = normalizeNonNegativeSqliteLimit(
      options.maxHotRuntimeTerminalOutboxEvents,
      DEFAULT_HOT_RUNTIME_MAX_TERMINAL_OUTBOX_EVENTS,
    );
    if (dbFile !== ":memory:") {
      mkdirSync(dirname(dbFile), { recursive: true });
    }
    this.db = new DatabaseSync(dbFile);
    // Wait up to 5s for a lock instead of failing immediately with
    // SQLITE_BUSY ("database is locked"). WAL allows concurrent readers, but
    // a writer plus a fresh reader (e.g. the worker-thread persistence path,
    // or parallel test processes sharing a db file) can still momentarily
    // contend; busy_timeout makes that wait rather than error.
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.journalMode = this.initializeDatabase();
    this.reviewLineageObservations =
      new SqliteReviewLineageObservationStore(this.db);
    // Publish schema 12 only after the Phase 10 canonical lineage/ledger
    // tables have initialized successfully on the same connection.
    this.writeMetadata("schema_version", String(SQLITE_SCHEMA_VERSION));
  }

  load(): BrokerSnapshot {
    if (this.loadSource === "hot-tables") {
      return this.loadHotRuntimeSnapshot();
    }
    const snapshot = this.loadCanonicalSnapshot();
    return this.withCanonicalReviewLineages(
      snapshot,
      this.hasCanonicalSnapshot() ? snapshot.reviewLineages : undefined,
    );
  }

  save(snapshot: BrokerSnapshot, hints?: BrokerStateSaveHints): void {
    this.saveSnapshot(
      this.withCanonicalReviewLineages(snapshot, snapshot.reviewLineages),
      hints,
    );
  }

  saveHotEntities(hints: BrokerStateSaveHints): void {
    this.saveHotEntityHints(hints);
  }

  applyReviewLineageObservation(
    command: ProjectedReviewLineageObservation,
  ):
    | ReviewLineageObservationApplicationResult
    | Promise<ReviewLineageObservationApplicationResult> {
    const legacy = this.readCanonicalSnapshotSidecars().reviewLineages ?? [];
    this.reviewLineageObservations.importLegacySnapshot(legacy);
    return this.reviewLineageObservations.apply(command);
  }

  listCanonicalReviewLineages(): ReviewLineageRecord[] {
    return this.reviewLineageObservations.listLineages();
  }

  readHotRuntimeSnapshot(): BrokerSnapshot {
    const sidecars = this.readCanonicalSnapshotSidecars();
    const snapshot: BrokerSnapshot = {
      version: CURRENT_BROKER_STATE_VERSION_VALUE,
      exchanges: this.readHotExchanges(),
      exchangeMessages: this.readHotExchangeMessages(),
      proposals: this.readHotProposals(),
      artifacts: this.readHotArtifacts(),
      validations: this.readHotValidations(),
      auditEvents: this.readHotAuditEventsForRuntime(),
      workers: this.readHotWorkers(),
      tasks: this.readHotTasksForRuntime(),
      tombstones: this.readHotTombstones(),
      terminalOutbox: this.readHotTerminalOutbox({ limit: this.maxHotRuntimeTerminalOutboxEvents }),
      crossBrokerTerminalBriefs: sidecars.crossBrokerTerminalBriefs ?? [],
      wavePlans: sidecars.wavePlans ?? [],
      reviewLineages: [],
    };
    if (sidecars.pushNotificationConfigs !== undefined) {
      snapshot.pushNotificationConfigs = sidecars.pushNotificationConfigs;
    }
    return this.withCanonicalReviewLineages(snapshot, sidecars.reviewLineages);
  }

  readHotTasks(filters: SqliteTaskHotTableFilters = {}): TaskRecord[] {
    const { sql, params } = buildHotTableSelect(
      "broker_tasks",
      [
        ["id", filters.id],
        ["status", filters.status],
        ["target_node_id", filters.targetNodeId],
        ["intent", filters.intent],
        ["assigned_worker_id", filters.assignedWorkerId],
        ["task_origin", filters.taskOrigin],
      ],
      "updated_at DESC, id ASC",
      filters.limit ?? (filters.maxRows !== undefined && filters.maxRows > 0 ? normalizeOptionalSqliteLimit(filters.maxRows) : undefined),
    );
    return this.db
      .prepare(sql)
      .all(...params)
      .flatMap((row) => parseHotEntityPayloadSafe(row, taskSchema, "broker_tasks")) as TaskRecord[];
  }

  readHotTaskListItems(filters: SqliteTaskHotTableFilters = {}): SqliteTaskListItemProjection[] {
    const { sql, params } = buildHotTaskListItemSelect(filters);
    return this.db
      .prepare(sql)
      .all(...params)
      .flatMap((row) => parseHotTaskListItemProjection(row));
  }

  readHotExchanges(filters: SqliteExchangeHotTableFilters = {}): A2AExchangeState[] {
    const { sql, params } = buildHotTableSelect(
      "broker_exchanges",
      [["id", filters.id]],
      "created_at DESC, id ASC",
    );
    return this.db
      .prepare(sql)
      .all(...params)
      .map((row) => parseHotEntityPayload(row, exchangeStateSchema, "broker_exchanges")) as A2AExchangeState[];
  }

  readHotExchangeMessages(filters: SqliteExchangeMessageHotTableFilters = {}): A2AExchangeMessageRecord[] {
    const { sql, params } = buildHotTableSelect(
      "broker_exchange_messages",
      [
        ["id", filters.id],
        ["exchange_id", filters.exchangeId],
      ],
      "created_at ASC, CASE WHEN kind = 'root' THEN 0 ELSE 1 END ASC, id ASC",
    );
    return this.db
      .prepare(sql)
      .all(...params)
      .map((row) => parseHotEntityPayload(row, exchangeMessageSchema, "broker_exchange_messages")) as A2AExchangeMessageRecord[];
  }

  readHotProposals(filters: SqliteProposalHotTableFilters = {}): ChangeProposal[] {
    const { sql, params } = buildHotTableSelect(
      "broker_proposals",
      [
        ["id", filters.id],
        ["status", filters.status],
        ["source_node_id", filters.sourceNodeId],
        ["target_node_id", filters.targetNodeId],
        ["kind", filters.kind],
      ],
      "created_at DESC, id ASC",
    );
    return this.db
      .prepare(sql)
      .all(...params)
      .map((row) => parseHotEntityPayload(row, proposalSchema, "broker_proposals")) as ChangeProposal[];
  }

  readHotArtifacts(filters: SqliteArtifactHotTableFilters = {}): ArtifactRecord[] {
    const { sql, params } = buildHotTableSelect(
      "broker_artifacts",
      [
        ["id", filters.id],
        ["proposal_id", filters.proposalId],
      ],
      "created_at DESC, id ASC",
    );
    return this.db
      .prepare(sql)
      .all(...params)
      .map((row) => parseHotEntityPayload(row, artifactSchema, "broker_artifacts")) as ArtifactRecord[];
  }

  readHotValidations(filters: SqliteValidationHotTableFilters = {}): ValidationResult[] {
    const { sql, params } = buildHotTableSelect(
      "broker_validations",
      [
        ["id", filters.id],
        ["proposal_id", filters.proposalId],
      ],
      "created_at DESC, id ASC",
    );
    return this.db
      .prepare(sql)
      .all(...params)
      .map((row) => parseHotEntityPayload(row, validationSchema, "broker_validations")) as ValidationResult[];
  }

  readHotWorkers(filters: SqliteWorkerHotTableFilters = {}): WorkerRecord[] {
    const { sql, params } = buildHotTableSelect(
      "broker_workers",
      [
        ["node_id", filters.nodeId],
        ["role", filters.role],
      ],
      "last_seen_at DESC, node_id ASC",
      filters.maxRows,
    );
    return this.db
      .prepare(sql)
      .all(...params)
      .flatMap((row) => parseHotEntityPayloadSafe(row, workerSchema, "broker_workers")) as WorkerRecord[];
  }

  readHotTombstones(filters: SqliteTombstoneHotTableFilters = {}): TaskTombstone[] {
    const { sql, params } = buildHotTableSelect(
      "broker_tombstones",
      [
        ["task_id", filters.taskId],
        ["tombstone_reason", filters.tombstoneReason],
        ["terminal_status", filters.terminalStatus],
      ],
      "tombstoned_at DESC, task_id ASC",
      filters.maxRows,
    );
    const tombstones = this.db
      .prepare(sql)
      .all(...params)
      .map((row) => parseHotEntityPayload(row, tombstoneSchema, "broker_tombstones")) as TaskTombstone[];
    return filters.since
      ? tombstones.filter((tombstone) => tombstone.tombstonedAt >= filters.since!)
      : tombstones;
  }

  readHotTerminalOutbox(options: { limit?: number } = {}): TerminalTaskOutboxEvent[] {
    const limit = normalizeOptionalSqliteLimit(options.limit);
    const rows = limit === undefined
      ? this.db
        .prepare("SELECT payload FROM broker_terminal_outbox ORDER BY created_at ASC, id ASC")
        .all()
      : this.db
        .prepare(
          `SELECT payload FROM (
             SELECT payload, created_at, id
             FROM broker_terminal_outbox
             ORDER BY created_at DESC, id DESC
             LIMIT ?
           )
           ORDER BY created_at ASC, id ASC`,
        )
        .all(limit);
    return rows
      .map((row) => parseHotEntityPayload(row, terminalOutboxEventSchema, "broker_terminal_outbox")) as TerminalTaskOutboxEvent[];
  }

  readHotAuditEvents(filters: SqliteAuditHotTableFilters = {}): AuditEvent[] {
    const { sql, params } = buildHotTableSelect(
      "broker_audit_events",
      [
        ["action", filters.action],
        ["target_type", filters.targetType],
        ["target_id", filters.targetId],
      ],
      "created_at DESC, id ASC",
      filters.maxRows,
    );
    const events = this.db
      .prepare(sql)
      .all(...params)
      .map((row) => parseHotEntityPayload(row, auditEventSchema, "broker_audit_events")) as AuditEvent[];
    return events.filter((event) => {
      if (filters.proposalId && event.proposalId !== filters.proposalId) {
        return false;
      }
      if (filters.actorId && event.actorId !== filters.actorId) {
        return false;
      }
      return true;
    });
  }

  private readHotTasksForRuntime(): TaskRecord[] {
    return this.db
      .prepare(
        `SELECT payload FROM (
           SELECT payload, updated_at, id
           FROM broker_tasks
           WHERE status NOT IN ('succeeded', 'failed', 'canceled')
           ORDER BY updated_at DESC, id ASC
           LIMIT ?
         )
         UNION ALL
         SELECT payload FROM (
           SELECT payload
           FROM broker_tasks
           WHERE status IN ('succeeded', 'failed', 'canceled')
           ORDER BY updated_at DESC, id ASC
           LIMIT ?
         )`,
      )
      .all(this.maxHotRuntimeNonTerminalTasks, this.maxHotRuntimeTerminalTasks)
      .flatMap((row) => parseHotEntityPayloadSafe(row, taskSchema, "broker_tasks")) as TaskRecord[];
  }

  private readHotAuditEventsForRuntime(): AuditEvent[] {
    return this.db
      .prepare(
        `SELECT payload FROM (
           SELECT payload, created_at, id
           FROM broker_audit_events
           ORDER BY created_at DESC, id ASC
           LIMIT ?
         )
         ORDER BY created_at DESC, id ASC`,
      )
      .all(this.maxHotRuntimeAuditEvents)
      .map((row) => parseHotEntityPayload(row, auditEventSchema, "broker_audit_events")) as AuditEvent[];
  }

  close(): void {
    this.db.close();
  }

  getPersistenceInfo(): BrokerPersistenceInfo {
    const info: BrokerPersistenceInfo = {
      kind: "sqlite",
      dbFile: this.dbFile,
      stateVersion: CURRENT_BROKER_STATE_VERSION_VALUE,
      loadSource: this.loadSource,
      schemaVersion: SQLITE_SCHEMA_VERSION,
      journalMode: this.journalMode,
      hotEntityTables: [...SQLITE_HOT_ENTITY_TABLES],
      hotEntityHintTables: [...SQLITE_HOT_ENTITY_HINT_TABLES],
      hotEntityHintCoverage: this.readHotEntityHintCoverage(),
      hotEntityMirror: this.readHotEntityMirrorStatus(),
      hotEntityDiagnostics: this.readHotEntityDiagnostics(),
      hotTableLoadMetrics: this.readHotTableLoadMetrics(),
      hotTableRuntimeLoadLimits: this.readHotTableRuntimeLoadLimits(),
      importedFromJsonFile: this.readMetadata("imported_from_json_file"),
      lastImportAt: this.readMetadata("last_import_at"),
    };
    const persistDiag = this.readLastPersistDiagnostics();
    if (persistDiag.lastPersistAt !== undefined) info.lastPersistAt = persistDiag.lastPersistAt;
    info.lastPersistSkippedFullSnapshot = persistDiag.lastPersistSkippedFullSnapshot;
    if (persistDiag.lastHotHintCounts !== undefined) info.lastHotHintCounts = persistDiag.lastHotHintCounts;
    return info;
  }

  readHotEntityHintCoverage(): BrokerHotEntityHintCoverage {
    return buildHotEntityHintCoverage(SQLITE_HOT_ENTITY_TABLES, SQLITE_HOT_ENTITY_HINT_TABLES);
  }

  // Hot-entity diagnostics READ paths (#1289 L-store-4): moved to
  // store-hot-diagnostics-read.ts with a callback-injected context. These
  // delegators keep the public read surface unchanged.
  private hotDiagnosticsReadContext(): HotDiagnosticsReadContext {
    return {
      db: this.db,
      maxHotRuntimeNonTerminalTasks: this.maxHotRuntimeNonTerminalTasks,
      maxHotRuntimeTerminalTasks: this.maxHotRuntimeTerminalTasks,
      maxHotRuntimeAuditEvents: this.maxHotRuntimeAuditEvents,
      maxHotRuntimeTerminalOutboxEvents: this.maxHotRuntimeTerminalOutboxEvents,
      readSnapshotRow: () => this.readSnapshotRow(),
      readLastPersistDiagnostics: () => this.readLastPersistDiagnostics(),
      readTableIds: (tableName) => this.readTableIds(tableName),
      readTableCount: (tableName) => this.readTableCount(tableName),
    };
  }

  readHotEntityDiagnostics(): BrokerHotEntityDiagnostics {
    return hotDiagnostics.readHotEntityDiagnostics(this.hotDiagnosticsReadContext());
  }

  readHotEntityMirrorStatus(): BrokerHotEntityMirrorStatus {
    return hotDiagnostics.readHotEntityMirrorStatus(this.hotDiagnosticsReadContext());
  }

  readHotEntityTableCounts(): Record<string, number> {
    return hotDiagnostics.readHotEntityTableCounts(this.hotDiagnosticsReadContext());
  }

  readHotAuditDiagnostics(): BrokerHotAuditDiagnostics {
    return hotDiagnostics.readHotAuditDiagnostics(this.hotDiagnosticsReadContext());
  }

  readHotTerminalOutboxDiagnostics(): BrokerHotTerminalOutboxDiagnostics {
    return hotDiagnostics.readHotTerminalOutboxDiagnostics(this.hotDiagnosticsReadContext());
  }

  readHotTableLoadMetrics(): BrokerHotTableLoadMetrics {
    return hotDiagnostics.readHotTableLoadMetrics(this.hotDiagnosticsReadContext());
  }

  readHotTableRuntimeLoadLimits(): BrokerHotTableRuntimeLoadLimits {
    return {
      terminalTasks: this.maxHotRuntimeTerminalTasks,
      auditEvents: this.maxHotRuntimeAuditEvents,
      terminalOutboxEvents: this.maxHotRuntimeTerminalOutboxEvents,
    };
  }

  planHotTaskRetention(options: SqliteTaskHotRetentionPlanOptions): SqliteHotRetentionPlan {
    const records = this.db
      .prepare("SELECT payload FROM broker_tasks")
      .all()
      .map((row) => parseHotEntityPayload(row, taskSchema, "broker_tasks")) as TaskRecord[];
    return planTaskRetentionFromRecords(records, options);
  }

  planHotAuditRetention(options: SqliteAuditHotRetentionPlanOptions): SqliteHotRetentionPlan {
    const records = this.db
      .prepare("SELECT payload FROM broker_audit_events")
      .all()
      .map((row) => parseHotEntityPayload(row, auditEventSchema, "broker_audit_events")) as AuditEvent[];
    return planAuditRetentionFromRecords(records, options);
  }

  planHotWorkerRetention(options: SqliteWorkerHotRetentionPlanOptions): SqliteHotRetentionPlan {
    const records = this.db
      .prepare("SELECT payload FROM broker_workers")
      .all()
      .map((row) => parseHotEntityPayload(row, workerSchema, "broker_workers")) as WorkerRecord[];
    return planWorkerRetentionFromRecords(records, options);
  }

  planHotTerminalOutboxRetention(options: SqliteTerminalOutboxHotRetentionPlanOptions): SqliteHotRetentionPlan {
    const records = this.db
      .prepare("SELECT payload FROM broker_terminal_outbox")
      .all()
      .map((row) => parseHotEntityPayload(row, terminalOutboxEventSchema, "broker_terminal_outbox")) as TerminalTaskOutboxEvent[];
    return planTerminalOutboxRetentionFromRecords(records, options);
  }

  applyHotRetentionPlan(plan: SqliteHotRetentionPlan): SqliteHotRetentionApplyResult {
    let result: SqliteHotRetentionApplyResult | undefined;
    this.runImmediateTransaction(() => {
      result = this.applyHotRetentionPlanUnsafe(plan);
    });
    return result!;
  }

  applyHotRetentionPlans(plans: SqliteHotRetentionPlan[]): SqliteHotRetentionApplyResult[] {
    const results: SqliteHotRetentionApplyResult[] = [];
    this.runImmediateTransaction(() => {
      for (const plan of plans) {
        results.push(this.applyHotRetentionPlanUnsafe(plan));
      }
    });
    return results;
  }

  syncCanonicalSnapshotWithHotRetentionPlans(
    plans: SqliteHotRetentionPlan[],
    auditEvent: AuditEvent,
  ): SqliteCanonicalSnapshotRetentionSyncResult {
    const snapshot = this.readSnapshotRow();
    if (!snapshot) {
      return { synced: false, reason: "no_canonical_snapshot" };
    }
    const pruneIdsByTable = new Map(plans.map((plan) => [plan.table, new Set(plan.pruneIds)]));
    const taskPruneIds = pruneIdsByTable.get("broker_tasks") ?? new Set<string>();
    const auditPruneIds = pruneIdsByTable.get("broker_audit_events") ?? new Set<string>();
    const workerPruneIds = pruneIdsByTable.get("broker_workers") ?? new Set<string>();
    const terminalOutboxPruneIds = pruneIdsByTable.get("broker_terminal_outbox") ?? new Set<string>();
    const retainedTaskIds = new Set(snapshot.tasks.filter((task) => !taskPruneIds.has(task.id)).map((task) => task.id));
    const before = canonicalSnapshotCounts(snapshot);
    const nextSnapshot: BrokerSnapshot = {
      ...snapshot,
      tasks: snapshot.tasks.filter((task) => !taskPruneIds.has(task.id)),
      pushNotificationConfigs: snapshot.pushNotificationConfigs?.filter((config) => retainedTaskIds.has(config.taskId)),
      auditEvents: [
        ...snapshot.auditEvents.filter((event) => !auditPruneIds.has(event.id) && event.id !== auditEvent.id),
        auditEvent,
      ],
      workers: snapshot.workers.filter((worker) => !workerPruneIds.has(worker.nodeId)),
      terminalOutbox: (snapshot.terminalOutbox ?? []).filter((event) => !terminalOutboxPruneIds.has(event.id)),
    };
    const after = canonicalSnapshotCounts(nextSnapshot);
    this.runImmediateTransaction(() => {
      this.writeCanonicalSnapshotPayloadRow(nextSnapshot, new Date().toISOString());
    });
    return { synced: true, before, after };
  }

  upsertHotTasks(tasks: TaskRecord[]): void {
    this.runImmediateTransaction(() => {
      this.upsertHotTasksUnsafe(tasks);
    });
  }

  upsertHotExchanges(exchanges: A2AExchangeState[]): void {
    this.runImmediateTransaction(() => {
      this.upsertHotExchangesUnsafe(exchanges);
    });
  }

  upsertHotExchangeMessages(messages: A2AExchangeMessageRecord[]): void {
    this.runImmediateTransaction(() => {
      this.upsertHotExchangeMessagesUnsafe(messages);
    });
  }

  upsertHotProposals(proposals: ChangeProposal[]): void {
    this.runImmediateTransaction(() => {
      this.upsertHotProposalsUnsafe(proposals);
    });
  }

  upsertHotArtifacts(artifacts: ArtifactRecord[]): void {
    this.runImmediateTransaction(() => {
      this.upsertHotArtifactsUnsafe(artifacts);
    });
  }

  upsertHotValidations(validations: ValidationResult[]): void {
    this.runImmediateTransaction(() => {
      this.upsertHotValidationsUnsafe(validations);
    });
  }

  upsertHotAuditEvents(events: AuditEvent[]): void {
    this.runImmediateTransaction(() => {
      this.upsertHotAuditEventsUnsafe(events);
    });
  }

  pruneHotAuditEventsToMax(maxRecords: number): SqliteHotRetentionApplyResult {
    let result: SqliteHotRetentionApplyResult | undefined;
    this.runImmediateTransaction(() => {
      result = this.pruneHotAuditEventsToMaxUnsafe(maxRecords);
    });
    return result!;
  }

  pruneHotHeartbeatAuditEventsToMax(maxRecords: number): SqliteHotRetentionApplyResult {
    let result: SqliteHotRetentionApplyResult | undefined;
    this.runImmediateTransaction(() => {
      result = this.pruneHotHeartbeatAuditEventsToMaxUnsafe(maxRecords);
    });
    return result!;
  }

  upsertHotWorkers(workers: WorkerRecord[]): void {
    this.runImmediateTransaction(() => {
      this.upsertHotWorkersUnsafe(workers);
    });
  }

  upsertHotTombstones(tombstones: TaskTombstone[]): void {
    this.runImmediateTransaction(() => {
      this.upsertHotTombstonesUnsafe(tombstones);
    });
  }

  consumeLiveApprovalKey(key: string, consumedAt: string): boolean {
    const normalizedKey = String(key ?? "").trim();
    const normalizedConsumedAt = String(consumedAt ?? "").trim();
    if (!normalizedKey || normalizedKey.length > 512) {
      throw new Error("live approval consumption key must contain 1..512 characters");
    }
    const parsedConsumedAt = new Date(normalizedConsumedAt);
    if (!normalizedConsumedAt || !Number.isFinite(parsedConsumedAt.getTime()) || parsedConsumedAt.toISOString() !== normalizedConsumedAt) {
      throw new Error("live approval consumedAt must be a canonical ISO timestamp");
    }
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO broker_live_approval_consumptions
           (consumption_key, consumed_at)
         VALUES (?, ?)`,
      )
      .run(normalizedKey, normalizedConsumedAt);
    return Number(result.changes) === 1;
  }

  private initializeDatabase(): string {
    const journal = this.db.prepare("PRAGMA journal_mode = WAL").get() as
      | { journal_mode?: string }
      | undefined;
    this.db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS broker_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS broker_snapshots (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        version INTEGER NOT NULL,
        payload TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS broker_tasks (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        intent TEXT NOT NULL,
        target_node_id TEXT NOT NULL,
        assigned_worker_id TEXT,
        task_origin TEXT NOT NULL DEFAULT 'unknown',
        updated_at TEXT NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS broker_tasks_status_updated_idx
        ON broker_tasks(status, updated_at);
      CREATE INDEX IF NOT EXISTS broker_tasks_updated_id_idx
        ON broker_tasks(updated_at DESC, id ASC);
      CREATE INDEX IF NOT EXISTS broker_tasks_status_updated_id_idx
        ON broker_tasks(status, updated_at DESC, id ASC);
      CREATE INDEX IF NOT EXISTS broker_tasks_worker_status_idx
        ON broker_tasks(assigned_worker_id, status);
      CREATE INDEX IF NOT EXISTS broker_tasks_worker_status_updated_id_idx
        ON broker_tasks(assigned_worker_id, status, updated_at DESC, id ASC);
      CREATE INDEX IF NOT EXISTS broker_tasks_target_status_idx
        ON broker_tasks(target_node_id, status);
      CREATE INDEX IF NOT EXISTS broker_tasks_intent_status_idx
        ON broker_tasks(intent, status);
      CREATE TABLE IF NOT EXISTS broker_exchanges (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        intent TEXT NOT NULL,
        target_node_id TEXT NOT NULL,
        assigned_worker_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS broker_exchanges_created_idx
        ON broker_exchanges(created_at);
      CREATE TABLE IF NOT EXISTS broker_exchange_messages (
        id TEXT PRIMARY KEY,
        exchange_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        parent_message_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS broker_exchange_messages_exchange_created_idx
        ON broker_exchange_messages(exchange_id, created_at);
      CREATE INDEX IF NOT EXISTS broker_exchange_messages_parent_idx
        ON broker_exchange_messages(exchange_id, parent_message_id);
      CREATE TABLE IF NOT EXISTS broker_proposals (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        kind TEXT NOT NULL,
        source_node_id TEXT NOT NULL,
        target_node_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS broker_proposals_status_updated_idx
        ON broker_proposals(status, updated_at);
      CREATE INDEX IF NOT EXISTS broker_proposals_source_status_idx
        ON broker_proposals(source_node_id, status);
      CREATE INDEX IF NOT EXISTS broker_proposals_target_status_idx
        ON broker_proposals(target_node_id, status);
      CREATE INDEX IF NOT EXISTS broker_proposals_kind_status_idx
        ON broker_proposals(kind, status);
      CREATE TABLE IF NOT EXISTS broker_artifacts (
        id TEXT PRIMARY KEY,
        proposal_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        created_at TEXT NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS broker_artifacts_proposal_created_idx
        ON broker_artifacts(proposal_id, created_at);
      CREATE TABLE IF NOT EXISTS broker_validations (
        id TEXT PRIMARY KEY,
        proposal_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        verdict TEXT NOT NULL,
        created_at TEXT NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS broker_validations_proposal_created_idx
        ON broker_validations(proposal_id, created_at);
      CREATE INDEX IF NOT EXISTS broker_validations_verdict_idx
        ON broker_validations(verdict, created_at);
      CREATE TABLE IF NOT EXISTS broker_workers (
        node_id TEXT PRIMARY KEY,
        role TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS broker_workers_last_seen_idx
        ON broker_workers(last_seen_at);
      CREATE TABLE IF NOT EXISTS broker_tombstones (
        task_id TEXT PRIMARY KEY,
        terminal_status TEXT NOT NULL,
        tombstone_reason TEXT NOT NULL,
        tombstoned_at TEXT NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS broker_tombstones_reason_idx
        ON broker_tombstones(tombstone_reason, tombstoned_at);
      CREATE INDEX IF NOT EXISTS broker_tombstones_status_idx
        ON broker_tombstones(terminal_status, tombstoned_at);
      CREATE TABLE IF NOT EXISTS broker_audit_events (
        id TEXT PRIMARY KEY,
        action TEXT NOT NULL,
        target_type TEXT NOT NULL,
        target_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS broker_audit_events_target_idx
        ON broker_audit_events(target_type, target_id, created_at);
      CREATE INDEX IF NOT EXISTS broker_audit_events_action_idx
        ON broker_audit_events(action, created_at);
      CREATE TABLE IF NOT EXISTS broker_live_approval_consumptions (
        consumption_key TEXT PRIMARY KEY,
        consumed_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS broker_live_approval_consumptions_time_idx
        ON broker_live_approval_consumptions(consumed_at);
      CREATE TABLE IF NOT EXISTS broker_terminal_outbox (
        id TEXT PRIMARY KEY,
        task_event_id INTEGER NOT NULL,
        acknowledged_at TEXT,
        created_at TEXT NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS broker_terminal_outbox_unacked_idx
        ON broker_terminal_outbox(acknowledged_at, created_at);
    `);
    this.ensureColumn("broker_tasks", "task_origin", "TEXT NOT NULL DEFAULT 'unknown'");
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS broker_tasks_origin_status_idx
        ON broker_tasks(task_origin, status);
    `);
    this.writeMetadata("state_version", String(CURRENT_BROKER_STATE_VERSION_VALUE));
    return journal?.journal_mode ?? "unknown";
  }

  private saveImportedJsonSnapshot(snapshot: BrokerSnapshot, jsonFile: string): void {
    const importedAt = new Date().toISOString();
    this.runImmediateTransaction(() => {
      this.writeSnapshotRow(snapshot, importedAt);
      this.writeMetadata("imported_from_json_file", jsonFile);
      this.writeMetadata("last_import_at", importedAt);
    });
  }

  private loadCanonicalSnapshot(): BrokerSnapshot {
    const row = this.db
      .prepare("SELECT payload FROM broker_snapshots WHERE id = 1")
      .get() as { payload?: string } | undefined;
    if (typeof row?.payload === "string") {
      return parseSnapshotPayload(row.payload, `SQLite broker snapshot at ${this.dbFile}`, this.maxBytes);
    }

    if (this.importJsonFile && existsSync(this.importJsonFile)) {
      const imported = new JsonFileBrokerStateStore(this.importJsonFile, {
        maxBytes: this.maxBytes,
      }).load();
      this.saveImportedJsonSnapshot(imported, this.importJsonFile);
      return imported;
    }

    return emptySnapshot();
  }

  private withCanonicalReviewLineages(
    snapshot: BrokerSnapshot,
    legacyRecords: ReviewLineageRecord[] | undefined,
  ): BrokerSnapshot {
    // A snapshot is compatibility input only. Once the import marker exists,
    // dedicated SQLite rows always win and a later stale blob cannot overwrite
    // them. Avoid marking an absent pre-import snapshot as imported because a
    // configured JSON import may still be loaded by loadHotRuntimeSnapshot().
    if (!this.deferReviewLineageImport && legacyRecords !== undefined) {
      this.reviewLineageObservations.importLegacySnapshot(legacyRecords);
    }
    const canonical = this.reviewLineageObservations.listLineages();
    const canonicalAuthorityReady =
      canonical.length > 0
      || this.reviewLineageObservations.legacySnapshotImported();
    return {
      ...snapshot,
      reviewLineages: canonicalAuthorityReady
        ? canonical
        : legacyRecords ?? [],
    };
  }

  /**
   * Snapshot-only sidecar fields that have no hot table (push-notification
   * configs, wave plans, and cross-broker Terminal Brief projections) live in
   * the canonical blob and must be carried into the
   * hot-table runtime snapshot, or a hot-tables restart silently drops them
   * (#1357 G3-d canary: a running wave plan vanished across a redeploy; #1446:
   * same gap for projections).
   */
  private readCanonicalSnapshotSidecars(): Pick<
    BrokerSnapshot,
    "pushNotificationConfigs" | "wavePlans" | "reviewLineages" | "crossBrokerTerminalBriefs"
  > {
    const row = this.db
      .prepare("SELECT payload FROM broker_snapshots WHERE id = 1")
      .get() as { payload?: string } | undefined;
    if (typeof row?.payload !== "string") {
      return {};
    }
    try {
      const canonical = parseSnapshotPayload(row.payload, `SQLite broker snapshot at ${this.dbFile}`, this.maxBytes);
      return {
        pushNotificationConfigs: canonical.pushNotificationConfigs,
        wavePlans: canonical.wavePlans,
        reviewLineages: canonical.reviewLineages,
        crossBrokerTerminalBriefs: canonical.crossBrokerTerminalBriefs,
      };
    } catch {
      // Hot-table runtime loading must remain recoverable even when the legacy
      // canonical snapshot is stale/corrupt/oversized. Sidecar fields are
      // snapshot-only, so skip them rather than making hot-table recovery
      // depend on parsing the entire canonical payload.
      return {};
    }
  }

  private loadHotRuntimeSnapshot(): BrokerSnapshot {
    const hotSnapshot = this.readHotRuntimeSnapshot();
    if (
      hasSnapshotRuntimeRows(hotSnapshot) ||
      this.hasCanonicalSnapshot() ||
      !this.importJsonFile ||
      !existsSync(this.importJsonFile)
    ) {
      return hotSnapshot;
    }

    const imported = new JsonFileBrokerStateStore(this.importJsonFile, {
      maxBytes: this.maxBytes,
    }).load();
    this.saveImportedJsonSnapshot(imported, this.importJsonFile);
    return this.readHotRuntimeSnapshot();
  }

  private hasCanonicalSnapshot(): boolean {
    const row = this.db
      .prepare("SELECT 1 AS found FROM broker_snapshots WHERE id = 1")
      .get() as { found?: number } | undefined;
    return row?.found === 1;
  }

  private saveSnapshot(snapshot: BrokerSnapshot, hints?: BrokerStateSaveHints): void {
    const updatedAt = new Date().toISOString();
    this.runImmediateTransaction(() => {
      const hasHotHints = hintsHasAnyEntries(hints);
      // Sidecar state with no hot table only reaches disk through the canonical
      // blob, so its presence must veto the hint-covered blob-write skip below.
      const hasSnapshotOnlySidecarState =
        snapshot.pushNotificationConfigs !== undefined ||
        (snapshot.wavePlans?.length ?? 0) > 0 ||
        (snapshot.crossBrokerTerminalBriefs?.length ?? 0) > 0;
      const skipFullSnapshot = hasHotHints && !hasSnapshotOnlySidecarState;
      const fit = this.writeSnapshotRow(snapshot, updatedAt, hints, { skipFullSnapshot });
      this.writeMetadata("state_version", String(CURRENT_BROKER_STATE_VERSION_VALUE));
      this.writePersistDiagnostics(updatedAt, hints, { skipFullSnapshot }, fit);
    });
  }

  private saveHotEntityHints(hints: BrokerStateSaveHints): void {
    const updatedAt = new Date().toISOString();
    this.runImmediateTransaction(() => {
      this.writeHotEntityHintRows(hints);
      this.writeMetadata("state_version", String(CURRENT_BROKER_STATE_VERSION_VALUE));
      this.writePersistDiagnostics(updatedAt, hints, { skipFullSnapshot: true });
    });
  }

  private writeSnapshotRow(
    snapshot: BrokerSnapshot,
    updatedAt: string,
    hints?: BrokerStateSaveHints,
    options?: { skipFullSnapshot?: boolean },
  ): { shedTerminalTasks: number; overflowError: string | undefined } {
    let shedTerminalTasks = 0;
    let overflowError: string | undefined;
    if (!options?.skipFullSnapshot) {
      try {
        shedTerminalTasks = this.writeCanonicalSnapshotPayloadRow(snapshot, updatedAt);
      } catch (error) {
        // Only the canonical-size overflow degrades (#1578): the hot entity
        // tables must still be written — before this, one throw rolled back
        // the whole transaction and two production brokers silently stopped
        // persisting anything for days/weeks. Any other error still aborts.
        if (!(error instanceof SnapshotOverflowError)) {
          throw error;
        }
        overflowError = error.message;
      }
    }
    this.writeHotEntityTables(snapshot, hints);
    return { shedTerminalTasks, overflowError };
  }

  private writeCanonicalSnapshotPayloadRow(snapshot: BrokerSnapshot, updatedAt: string): number {
    const fit = fitSnapshotToBudget(snapshot, this.maxBytes);
    this.db
      .prepare(
        `INSERT INTO broker_snapshots (id, version, payload, updated_at)
         VALUES (1, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           version = excluded.version,
           payload = excluded.payload,
           updated_at = excluded.updated_at`,
      )
      .run(CURRENT_BROKER_STATE_VERSION_VALUE, fit.payload, updatedAt);
    return fit.shedTerminalTasks;
  }

  private writePersistDiagnostics(
    updatedAt: string,
    hints: BrokerStateSaveHints | undefined,
    options: { skipFullSnapshot: boolean },
    fit?: { shedTerminalTasks: number; overflowError: string | undefined },
  ): void {
    this.writeMetadata("last_persist_at", updatedAt);
    this.writeMetadata("last_persist_skipped_full_snapshot", options.skipFullSnapshot ? "true" : "false");
    if (hints && hintsHasAnyEntries(hints)) {
      const counts: BrokerHotHintCounts = countHotHintEntries(hints);
      this.writeMetadata("last_hot_hint_counts", JSON.stringify(counts));
    } else {
      this.deleteMetadata("last_hot_hint_counts");
    }
    // Fail-visible degradation markers (#1578): sticky until the next
    // successful canonical write so operators and mirror health can see that
    // the canonical row is intentionally behind the hot tables.
    const previousOverflow = this.readMetadata("last_persist_error");
    if (fit?.overflowError) {
      this.writeMetadata(
        "last_persist_error",
        JSON.stringify({ kind: "full_snapshot_overflow", message: fit.overflowError.slice(0, 200), at: updatedAt }),
      );
      if (!previousOverflow) {
        console.error(
          `broker persist: canonical snapshot overflow degraded (${fit.overflowError}); hot entity tables persisted, canonical row left stale`,
        );
      }
    } else if (fit !== undefined) {
      if (previousOverflow) {
        console.log("broker persist: canonical snapshot write recovered; clearing overflow marker");
      }
      this.deleteMetadata("last_persist_error");
    }
    const previousShed = this.readMetadata("last_full_snapshot_shed_terminal");
    if (fit !== undefined && fit.shedTerminalTasks > 0) {
      this.writeMetadata("last_full_snapshot_shed_terminal", String(fit.shedTerminalTasks));
      if (!previousShed) {
        console.error(
          `broker persist: canonical snapshot exceeded budget; shed ${fit.shedTerminalTasks} oldest terminal task(s) from the canonical mirror (hot tables authoritative)`,
        );
      }
    } else if (fit !== undefined) {
      this.deleteMetadata("last_full_snapshot_shed_terminal");
    }
  }

  readLastPersistDiagnostics(): { lastPersistAt: string | undefined; lastPersistSkippedFullSnapshot: boolean; lastHotHintCounts: BrokerHotHintCounts | undefined; lastPersistError: { kind: string; message: string; at: string } | undefined; lastFullSnapshotShedTerminal: number | undefined } {
    const lastPersistAt = this.readMetadata("last_persist_at") ?? undefined;
    const skippedRaw = this.readMetadata("last_persist_skipped_full_snapshot");
    const countsRaw = this.readMetadata("last_hot_hint_counts");
    let lastHotHintCounts: BrokerHotHintCounts | undefined;
    if (countsRaw) {
      try {
        const parsed = JSON.parse(countsRaw);
        if (typeof parsed === "object" && parsed !== null) {
          lastHotHintCounts = parsed as BrokerHotHintCounts;
        }
      } catch {
        // ignore parse failures
      }
    }
    let lastPersistError: { kind: string; message: string; at: string } | undefined;
    const errorRaw = this.readMetadata("last_persist_error");
    if (errorRaw) {
      try {
        const parsed = JSON.parse(errorRaw);
        if (
          typeof parsed === "object" &&
          parsed !== null &&
          typeof parsed.kind === "string" &&
          typeof parsed.message === "string" &&
          typeof parsed.at === "string"
        ) {
          lastPersistError = { kind: parsed.kind, message: parsed.message, at: parsed.at };
        }
      } catch {
        // ignore parse failures
      }
    }
    const shedRaw = this.readMetadata("last_full_snapshot_shed_terminal");
    const shedParsed = shedRaw === undefined ? Number.NaN : Number.parseInt(shedRaw, 10);
    return {
      lastPersistAt,
      lastPersistSkippedFullSnapshot: skippedRaw === "true",
      lastHotHintCounts: lastHotHintCounts,
      lastPersistError,
      lastFullSnapshotShedTerminal: Number.isNaN(shedParsed) ? undefined : shedParsed,
    };
  }

  private readSnapshotRow(): BrokerSnapshot | undefined {
    const row = this.db
      .prepare("SELECT payload FROM broker_snapshots WHERE id = 1")
      .get() as { payload?: string } | undefined;
    if (typeof row?.payload !== "string") {
      return undefined;
    }
    return parseSnapshotPayload(row.payload, `SQLite broker snapshot at ${this.dbFile}`, this.maxBytes);
  }

  private readTableCount(tableName: SqliteHotEntityTable): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get() as { count?: number | bigint } | undefined;
    if (typeof row?.count === "bigint") {
      return Number(row.count);
    }
    return typeof row?.count === "number" ? row.count : 0;
  }

  private readHotHeartbeatAuditCount(): number {
    return coerceSqliteCount(
      this.db.prepare("SELECT COUNT(*) AS count FROM broker_audit_events WHERE action IN ('worker.heartbeat', 'task.heartbeat')").get() as
        | { count?: number | bigint }
        | undefined,
    );
  }

  private writeHotEntityTables(snapshot: BrokerSnapshot, hints?: BrokerStateSaveHints): void {
    const hotExchangeHints = hints?.hotExchanges;
    const hotExchangeMessageHints = hints?.hotExchangeMessages;
    const hotProposalHints = hints?.hotProposals;
    const hotArtifactHints = hints?.hotArtifacts;
    const hotValidationHints = hints?.hotValidations;
    const hotTaskHints = hints?.hotTasks;
    const hotTombstoneHints = hints?.hotTombstones;
    const hotAuditHints = hints?.hotAuditEvents;
    const hotWorkerHints = hints?.hotWorkers;
    const hotTerminalOutboxHints = hints?.hotTerminalOutboxEvents;
    const incrementalHotWrite = hintsHasAnyEntries(hints);
    if (incrementalHotWrite) {
      if (hotExchangeHints !== undefined) {
        this.applyCanonicalHotRetentionPlan("broker_exchanges", snapshot.exchanges.map((exchange) => exchange.id));
        this.upsertHotExchangesUnsafe(hotExchangeHints);
      }
      if (hotExchangeMessageHints !== undefined) {
        this.applyCanonicalHotRetentionPlan("broker_exchange_messages", snapshot.exchangeMessages.map((message) => message.id));
        this.upsertHotExchangeMessagesUnsafe(hotExchangeMessageHints);
      }
      if (hotProposalHints !== undefined) {
        this.applyCanonicalHotRetentionPlan("broker_proposals", snapshot.proposals.map((proposal) => proposal.id));
        this.upsertHotProposalsUnsafe(hotProposalHints);
      }
      if (hotArtifactHints !== undefined) {
        this.applyCanonicalHotRetentionPlan("broker_artifacts", snapshot.artifacts.map((artifact) => artifact.id));
        this.upsertHotArtifactsUnsafe(hotArtifactHints);
      }
      if (hotValidationHints !== undefined) {
        this.applyCanonicalHotRetentionPlan("broker_validations", snapshot.validations.map((validation) => validation.id));
        this.upsertHotValidationsUnsafe(hotValidationHints);
      }
      if (hotTaskHints !== undefined) {
        this.applyCanonicalHotRetentionPlan("broker_tasks", snapshot.tasks.map((task) => task.id));
        this.upsertHotTasksUnsafe(hotTaskHints);
      }
      if (hotTombstoneHints !== undefined) {
        this.applyCanonicalHotRetentionPlan("broker_tombstones", (snapshot.tombstones ?? []).map((tombstone) => tombstone.taskId));
        this.upsertHotTombstonesUnsafe(hotTombstoneHints);
      }
      if (hotAuditHints !== undefined) {
        const onlyHeartbeatAuditHints =
          hotAuditHints.length > 0 &&
          hotAuditHints.every(isHeartbeatAuditEvent);
        if (!onlyHeartbeatAuditHints) {
          this.applyCanonicalHotRetentionPlan("broker_audit_events", snapshot.auditEvents.map((event) => event.id));
        }
        this.upsertHotAuditEventsUnsafe(hotAuditHints);
        if (onlyHeartbeatAuditHints) {
          this.pruneHotHeartbeatAuditEventsToMaxUnsafe(this.maxHotRuntimeHeartbeatAuditEvents);
          this.pruneHotAuditEventsToMaxUnsafe(this.maxHotRuntimeAuditEvents);
        }
      }
      if (hotWorkerHints !== undefined) {
        this.applyCanonicalHotRetentionPlan("broker_workers", snapshot.workers.map((worker) => worker.nodeId));
        this.upsertHotWorkersUnsafe(hotWorkerHints);
      }
      if (hotTerminalOutboxHints !== undefined) {
        this.applyCanonicalHotRetentionPlan("broker_terminal_outbox", (snapshot.terminalOutbox ?? []).map((event) => event.id));
        this.upsertHotTerminalOutboxUnsafe(hotTerminalOutboxHints);
      }
      return;
    }

    if (hotExchangeHints) {
      this.applyCanonicalHotRetentionPlan("broker_exchanges", snapshot.exchanges.map((exchange) => exchange.id));
    } else {
      this.db.exec("DELETE FROM broker_exchanges;");
    }
    if (hotExchangeMessageHints) {
      this.applyCanonicalHotRetentionPlan("broker_exchange_messages", snapshot.exchangeMessages.map((message) => message.id));
    } else {
      this.db.exec("DELETE FROM broker_exchange_messages;");
    }
    if (hotProposalHints) {
      this.applyCanonicalHotRetentionPlan("broker_proposals", snapshot.proposals.map((proposal) => proposal.id));
    } else {
      this.db.exec("DELETE FROM broker_proposals;");
    }
    if (hotArtifactHints) {
      this.applyCanonicalHotRetentionPlan("broker_artifacts", snapshot.artifacts.map((artifact) => artifact.id));
    } else {
      this.db.exec("DELETE FROM broker_artifacts;");
    }
    if (hotValidationHints) {
      this.applyCanonicalHotRetentionPlan("broker_validations", snapshot.validations.map((validation) => validation.id));
    } else {
      this.db.exec("DELETE FROM broker_validations;");
    }
    if (hotTaskHints) {
      this.applyCanonicalHotRetentionPlan("broker_tasks", snapshot.tasks.map((task) => task.id));
    } else {
      this.db.exec("DELETE FROM broker_tasks;");
    }
    if (hotTombstoneHints) {
      this.applyCanonicalHotRetentionPlan("broker_tombstones", (snapshot.tombstones ?? []).map((tombstone) => tombstone.taskId));
    } else {
      this.db.exec("DELETE FROM broker_tombstones;");
    }
    if (hotAuditHints) {
      this.applyCanonicalHotRetentionPlan("broker_audit_events", snapshot.auditEvents.map((event) => event.id));
    } else {
      this.db.exec("DELETE FROM broker_audit_events;");
    }
    if (hotWorkerHints) {
      this.applyCanonicalHotRetentionPlan("broker_workers", snapshot.workers.map((worker) => worker.nodeId));
    } else {
      this.db.exec("DELETE FROM broker_workers;");
    }
    this.applyCanonicalHotRetentionPlan("broker_terminal_outbox", (snapshot.terminalOutbox ?? []).map((event) => event.id));

    this.upsertHotExchangesUnsafe(hotExchangeHints ?? snapshot.exchanges);
    this.upsertHotExchangeMessagesUnsafe(hotExchangeMessageHints ?? snapshot.exchangeMessages);

    this.upsertHotProposalsUnsafe(hotProposalHints ?? snapshot.proposals);
    this.upsertHotArtifactsUnsafe(hotArtifactHints ?? snapshot.artifacts);
    this.upsertHotValidationsUnsafe(hotValidationHints ?? snapshot.validations);

    this.upsertHotTasksUnsafe(hotTaskHints ?? snapshot.tasks);

    this.upsertHotTombstonesUnsafe(hotTombstoneHints ?? snapshot.tombstones ?? []);

    this.upsertHotWorkersUnsafe(hotWorkerHints ?? snapshot.workers);

    this.upsertHotAuditEventsUnsafe(hotAuditHints ?? snapshot.auditEvents);

    this.upsertHotTerminalOutboxUnsafe(hotTerminalOutboxHints ?? snapshot.terminalOutbox ?? []);
  }

  private writeHotEntityHintRows(hints: BrokerStateSaveHints): void {
    if (hints.hotExchanges !== undefined) {
      this.upsertHotExchangesUnsafe(hints.hotExchanges);
    }
    if (hints.hotExchangeMessages !== undefined) {
      this.upsertHotExchangeMessagesUnsafe(hints.hotExchangeMessages);
    }
    if (hints.hotProposals !== undefined) {
      this.upsertHotProposalsUnsafe(hints.hotProposals);
    }
    if (hints.hotArtifacts !== undefined) {
      this.upsertHotArtifactsUnsafe(hints.hotArtifacts);
    }
    if (hints.hotValidations !== undefined) {
      this.upsertHotValidationsUnsafe(hints.hotValidations);
    }
    if (hints.hotTasks !== undefined) {
      this.upsertHotTasksUnsafe(hints.hotTasks);
    }
    if (hints.hotTombstones !== undefined) {
      this.upsertHotTombstonesUnsafe(hints.hotTombstones);
    }
    if (hints.hotAuditEvents !== undefined) {
      this.upsertHotAuditEventsUnsafe(hints.hotAuditEvents);
      // Runtime audit repositories already prune on append. Avoid repeating
      // count/delete scans on the hot-only persist path, which can sit on the
      // heartbeat response-critical section under worker churn.
    }
    if (hints.hotWorkers !== undefined) {
      this.upsertHotWorkersUnsafe(hints.hotWorkers);
    }
    if (hints.hotTerminalOutboxEvents !== undefined) {
      this.upsertHotTerminalOutboxUnsafe(hints.hotTerminalOutboxEvents);
    }
  }

  private applyCanonicalHotRetentionPlan(
    tableName: SqliteHotRetentionPlan["table"],
    retainedIds: string[],
  ): SqliteHotRetentionApplyResult {
    const retained = new Set(retainedIds);
    const existingIds = this.readTableIds(tableName);
    return this.applyHotRetentionPlanUnsafe({
      table: tableName,
      cutoffMs: 0,
      retainedIds,
      pruneIds: existingIds.filter((id) => !retained.has(id)),
    });
  }

  private applyHotRetentionPlanUnsafe(plan: SqliteHotRetentionPlan): SqliteHotRetentionApplyResult {
    const beforeIds = new Set(this.readTableIds(plan.table));
    const pruneIds = plan.pruneIds.filter((id) => beforeIds.has(id));
    if (pruneIds.length > 0) {
      const primaryKeyColumn = this.hotRetentionPrimaryKeyColumn(plan.table);
      const placeholders = pruneIds.map(() => "?").join(", ");
      this.db.prepare(`DELETE FROM ${plan.table} WHERE ${primaryKeyColumn} IN (${placeholders})`).run(...pruneIds);
    }
    return {
      table: plan.table,
      retainedCount: plan.retainedIds.length,
      requestedPruneCount: plan.pruneIds.length,
      prunedCount: pruneIds.length,
      remainingCount: this.readTableCount(plan.table),
    };
  }

  private readTableIds(tableName: SqliteHotRetentionPlan["table"]): string[] {
    const primaryKeyColumn = this.hotRetentionPrimaryKeyColumn(tableName);
    return (this.db.prepare(`SELECT ${primaryKeyColumn} AS id FROM ${tableName} ORDER BY ${primaryKeyColumn} ASC`).all() as Array<{ id?: string }>)
      .flatMap((row) => typeof row.id === "string" ? [row.id] : []);
  }

  private upsertHotTasksUnsafe(tasks: TaskRecord[]): void {
    const upsertTask = this.db.prepare(
      `INSERT INTO broker_tasks
        (id, status, intent, target_node_id, assigned_worker_id, task_origin, updated_at, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         status = excluded.status,
         intent = excluded.intent,
         target_node_id = excluded.target_node_id,
         assigned_worker_id = excluded.assigned_worker_id,
         task_origin = excluded.task_origin,
         updated_at = excluded.updated_at,
         payload = excluded.payload`,
    );
    for (const task of tasks) {
      upsertTask.run(
        task.id,
        task.status,
        task.intent,
        task.targetNodeId,
        task.assignedWorkerId ?? null,
        task.taskOrigin ?? "unknown",
        task.updatedAt,
        JSON.stringify(task),
      );
    }
  }

  private upsertHotExchangesUnsafe(exchanges: A2AExchangeState[]): void {
    const upsertExchange = this.db.prepare(
      `INSERT INTO broker_exchanges
        (id, status, intent, target_node_id, assigned_worker_id, created_at, updated_at, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         status = excluded.status,
         intent = excluded.intent,
         target_node_id = excluded.target_node_id,
         assigned_worker_id = excluded.assigned_worker_id,
         created_at = excluded.created_at,
         updated_at = excluded.updated_at,
         payload = excluded.payload`,
    );
    for (const exchange of exchanges) {
      upsertExchange.run(
        exchange.id,
        exchange.status,
        exchange.intent,
        exchange.targetNodeId,
        exchange.assignedWorkerId ?? null,
        exchange.createdAt,
        exchange.updatedAt,
        JSON.stringify(exchange),
      );
    }
  }

  private upsertHotExchangeMessagesUnsafe(messages: A2AExchangeMessageRecord[]): void {
    const upsertMessage = this.db.prepare(
      `INSERT INTO broker_exchange_messages
        (id, exchange_id, kind, parent_message_id, created_at, updated_at, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         exchange_id = excluded.exchange_id,
         kind = excluded.kind,
         parent_message_id = excluded.parent_message_id,
         created_at = excluded.created_at,
         updated_at = excluded.updated_at,
         payload = excluded.payload`,
    );
    for (const message of messages) {
      upsertMessage.run(
        message.id,
        message.exchangeId,
        message.kind,
        message.parentMessageId ?? null,
        message.createdAt,
        message.updatedAt,
        JSON.stringify(message),
      );
    }
  }

  private upsertHotProposalsUnsafe(proposals: ChangeProposal[]): void {
    const upsertProposal = this.db.prepare(
      `INSERT INTO broker_proposals
        (id, status, kind, source_node_id, target_node_id, created_at, updated_at, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         status = excluded.status,
         kind = excluded.kind,
         source_node_id = excluded.source_node_id,
         target_node_id = excluded.target_node_id,
         created_at = excluded.created_at,
         updated_at = excluded.updated_at,
         payload = excluded.payload`,
    );
    for (const proposal of proposals) {
      upsertProposal.run(
        proposal.id,
        proposal.status,
        proposal.kind,
        proposal.sourceNodeId,
        proposal.targetNodeId,
        proposal.createdAt,
        proposal.updatedAt,
        JSON.stringify(proposal),
      );
    }
  }

  private upsertHotArtifactsUnsafe(artifacts: ArtifactRecord[]): void {
    const upsertArtifact = this.db.prepare(
      `INSERT INTO broker_artifacts
        (id, proposal_id, kind, created_at, payload)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         proposal_id = excluded.proposal_id,
         kind = excluded.kind,
         created_at = excluded.created_at,
         payload = excluded.payload`,
    );
    for (const artifact of artifacts) {
      upsertArtifact.run(
        artifact.id,
        artifact.proposalId,
        artifact.kind,
        artifact.createdAt,
        JSON.stringify(artifact),
      );
    }
  }

  private upsertHotValidationsUnsafe(validations: ValidationResult[]): void {
    const upsertValidation = this.db.prepare(
      `INSERT INTO broker_validations
        (id, proposal_id, node_id, kind, verdict, created_at, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         proposal_id = excluded.proposal_id,
         node_id = excluded.node_id,
         kind = excluded.kind,
         verdict = excluded.verdict,
         created_at = excluded.created_at,
         payload = excluded.payload`,
    );
    for (const validation of validations) {
      upsertValidation.run(
        validation.id,
        validation.proposalId,
        validation.nodeId,
        validation.kind,
        validation.verdict,
        validation.createdAt,
        JSON.stringify(validation),
      );
    }
  }

  private upsertHotAuditEventsUnsafe(events: AuditEvent[]): void {
    const upsertAudit = this.db.prepare(
      `INSERT INTO broker_audit_events
        (id, action, target_type, target_id, created_at, payload)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         action = excluded.action,
         target_type = excluded.target_type,
         target_id = excluded.target_id,
         created_at = excluded.created_at,
         payload = excluded.payload`,
    );
    for (const audit of events) {
      upsertAudit.run(
        audit.id,
        audit.action,
        audit.targetType,
        audit.targetId,
        audit.createdAt,
        JSON.stringify(audit),
      );
    }
  }

  private pruneHotAuditEventsToMaxUnsafe(maxRecords: number): SqliteHotRetentionApplyResult {
    const max = Math.max(0, Math.floor(maxRecords));
    const before = this.readTableCount("broker_audit_events");
    if (before <= max) {
      return {
        table: "broker_audit_events",
        retainedCount: before,
        requestedPruneCount: 0,
        prunedCount: 0,
        remainingCount: before,
      };
    }
    const deleteResult = this.db.prepare(
      `DELETE FROM broker_audit_events
       WHERE id IN (
         SELECT id FROM broker_audit_events
         ORDER BY created_at DESC, id DESC
         LIMIT -1 OFFSET ?
       )`,
    ).run(max);
    const remaining = this.readTableCount("broker_audit_events");
    return {
      table: "broker_audit_events",
      retainedCount: max,
      requestedPruneCount: before - max,
      prunedCount: Number(deleteResult.changes ?? 0),
      remainingCount: remaining,
    };
  }

  private pruneHotHeartbeatAuditEventsToMaxUnsafe(maxRecords: number): SqliteHotRetentionApplyResult {
    const max = Math.max(0, Math.floor(maxRecords));
    const before = this.readHotHeartbeatAuditCount();
    if (before <= max) {
      return {
        table: "broker_audit_events",
        retainedCount: before,
        requestedPruneCount: 0,
        prunedCount: 0,
        remainingCount: before,
      };
    }
    const deleteResult = this.db.prepare(
      `DELETE FROM broker_audit_events
       WHERE id IN (
         SELECT id FROM broker_audit_events
         WHERE action IN ('worker.heartbeat', 'task.heartbeat')
         ORDER BY created_at DESC, id DESC
         LIMIT -1 OFFSET ?
       )`,
    ).run(max);
    const remaining = this.readHotHeartbeatAuditCount();
    return {
      table: "broker_audit_events",
      retainedCount: max,
      requestedPruneCount: before - max,
      prunedCount: Number(deleteResult.changes ?? 0),
      remainingCount: remaining,
    };
  }

  private upsertHotWorkersUnsafe(workers: WorkerRecord[]): void {
    const upsertWorker = this.db.prepare(
      `INSERT INTO broker_workers
        (node_id, role, last_seen_at, updated_at, payload)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(node_id) DO UPDATE SET
         role = excluded.role,
         last_seen_at = excluded.last_seen_at,
         updated_at = excluded.updated_at,
         payload = excluded.payload`,
    );
    for (const worker of workers) {
      upsertWorker.run(
        worker.nodeId,
        worker.role,
        worker.lastSeenAt,
        worker.updatedAt,
        JSON.stringify(worker),
      );
    }
  }

  private upsertHotTerminalOutboxUnsafe(events: TerminalTaskOutboxEvent[]): void {
    const upsertEvent = this.db.prepare(
      `INSERT INTO broker_terminal_outbox
        (id, task_event_id, acknowledged_at, created_at, payload)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         task_event_id = excluded.task_event_id,
         acknowledged_at = excluded.acknowledged_at,
         created_at = excluded.created_at,
         payload = excluded.payload`,
    );
    for (const event of events) {
      upsertEvent.run(
        event.id,
        event.taskEventId,
        event.ack?.acknowledgedAt ?? event.deliveredAt ?? null,
        event.createdAt,
        JSON.stringify(event),
      );
    }
  }

  private upsertHotTombstonesUnsafe(tombstones: TaskTombstone[]): void {
    const upsertTombstone = this.db.prepare(
      `INSERT INTO broker_tombstones
        (task_id, terminal_status, tombstone_reason, tombstoned_at, payload)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(task_id) DO UPDATE SET
         terminal_status = excluded.terminal_status,
         tombstone_reason = excluded.tombstone_reason,
         tombstoned_at = excluded.tombstoned_at,
         payload = excluded.payload`,
    );
    for (const tombstone of tombstones) {
      upsertTombstone.run(
        tombstone.taskId,
        tombstone.terminalStatus,
        tombstone.tombstoneReason,
        tombstone.tombstonedAt,
        JSON.stringify(tombstone),
      );
    }
  }

  private hotRetentionPrimaryKeyColumn(tableName: SqliteHotRetentionPlan["table"]): "id" | "node_id" | "task_id" {
    if (tableName === "broker_workers") {
      return "node_id";
    }
    if (tableName === "broker_tombstones") {
      return "task_id";
    }
    return "id";
  }

  private runImmediateTransaction(fn: () => void): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      fn();
      this.db.exec("COMMIT");
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Preserve the original error; rollback failure only confirms the write did not cleanly complete.
      }
      throw error;
    }
  }

  private writeMetadata(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO broker_metadata (key, value)
         VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value);
  }

  private readMetadata(key: string): string | undefined {
    const row = this.db
      .prepare("SELECT value FROM broker_metadata WHERE key = ?")
      .get(key) as { value?: string } | undefined;
    return typeof row?.value === "string" ? row.value : undefined;
  }

  private deleteMetadata(key: string): void {
    this.db.prepare("DELETE FROM broker_metadata WHERE key = ?").run(key);
  }

  private ensureColumn(tableName: string, columnName: string, columnDefinition: string): void {
    const rows = this.db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name?: string }>;
    if (rows.some((row) => row.name === columnName)) {
      return;
    }
    this.db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDefinition}`);
  }
}

// Table-native runtime repository adapters moved to
// store-runtime-repositories.ts (#1289 R4 L-store-3); re-exported here so
// existing `from "./store.js"` imports keep working.
export {
  SqliteTaskRuntimeRepository,
  SqliteExchangeRuntimeRepository,
  SqliteExchangeMessageRuntimeRepository,
  SqliteProposalRuntimeRepository,
  SqliteArtifactRuntimeRepository,
  SqliteValidationRuntimeRepository,
  SqliteWorkerRuntimeRepository,
  SqliteAuditRuntimeRepository,
  SqliteTombstoneRuntimeRepository,
} from "./store-runtime-repositories.js";

function canonicalSnapshotCounts(snapshot: BrokerSnapshot): NonNullable<SqliteCanonicalSnapshotRetentionSyncResult["before"]> {
  return {
    tasks: snapshot.tasks.length,
    auditEvents: snapshot.auditEvents.length,
    workers: snapshot.workers.length,
    terminalOutbox: snapshot.terminalOutbox?.length ?? 0,
  };
}

function hasSnapshotRuntimeRows(snapshot: BrokerSnapshot): boolean {
  return Object.values(SQLITE_HOT_ENTITY_SNAPSHOT_KEYS).some(
    (key) => (snapshot[key] ?? []).length > 0,
  );
}


function parseHotEntityPayload<T>(row: unknown, schema: z.ZodType<T>, tableName: string): T {
  const parsed = parseHotEntityPayloadResult(row, schema, tableName);
  if (!parsed.success) {
    throw new Error(
      `invalid hot entity payload in ${tableName}: ${parsed.error}`,
    );
  }
  return parsed.data;
}

function parseHotEntityPayloadSafe<T>(row: unknown, schema: z.ZodType<T>, tableName: string): T[] {
  const parsed = parseHotEntityPayloadResult(row, schema, tableName);
  if (!parsed.success) {
    return [];
  }
  return [parsed.data];
}

function hintsHasAnyEntries(hints: BrokerStateSaveHints | undefined): boolean {
  if (!hints) return false;
  return (
    (hints.hotExchanges?.length ?? 0) > 0 ||
    (hints.hotExchangeMessages?.length ?? 0) > 0 ||
    (hints.hotProposals?.length ?? 0) > 0 ||
    (hints.hotArtifacts?.length ?? 0) > 0 ||
    (hints.hotValidations?.length ?? 0) > 0 ||
    (hints.hotTasks?.length ?? 0) > 0 ||
    (hints.hotTombstones?.length ?? 0) > 0 ||
    (hints.hotAuditEvents?.length ?? 0) > 0 ||
    (hints.hotWorkers?.length ?? 0) > 0 ||
    (hints.hotTerminalOutboxEvents?.length ?? 0) > 0
  );
}

function countHotHintEntries(hints: BrokerStateSaveHints): BrokerHotHintCounts {
  return {
    hotExchanges: hints.hotExchanges?.length ?? 0,
    hotExchangeMessages: hints.hotExchangeMessages?.length ?? 0,
    hotProposals: hints.hotProposals?.length ?? 0,
    hotArtifacts: hints.hotArtifacts?.length ?? 0,
    hotValidations: hints.hotValidations?.length ?? 0,
    hotTasks: hints.hotTasks?.length ?? 0,
    hotTombstones: hints.hotTombstones?.length ?? 0,
    hotAuditEvents: hints.hotAuditEvents?.length ?? 0,
    hotWorkers: hints.hotWorkers?.length ?? 0,
    hotTerminalOutboxEvents: hints.hotTerminalOutboxEvents?.length ?? 0,
  };
}
