// Table-native runtime repository adapters extracted from store.ts (#1289 R4
// L-store-3). Nine thin Sqlite*RuntimeRepository classes the server wires into
// InMemoryA2ABroker — read/list/upsert delegation over SqliteBrokerStateStore;
// the audit repository additionally applies the hot/heartbeat prune caps.
// Pure move: store.ts re-exports every symbol here, so existing
// `from "./store.js"` imports are preserved. The only back-reference to
// store.js is type-only (erased at runtime — the L-store-1/2 no-cycle shape).
import { isHeartbeatAuditEvent, getHeartbeatAuditEventId } from "./broker-retention-selectors.js";
import { normalizeRuntimeTaskListLimit } from "./store-hot-select-projections.js";
import { taskMatchesRuntimeFilters, workerMatchesRuntimeFilters } from "./store-runtime-filters.js";
import type { ArtifactRuntimeRepository } from "./artifact-repository.js";
import type { AuditRuntimeRepository } from "./audit-repository.js";
import type { ExchangeMessageRuntimeRepository, ExchangeRuntimeRepository } from "./exchange-repository.js";
import type { ProposalRuntimeRepository } from "./proposal-repository.js";
import type { TaskRuntimeRepository } from "./task-repository.js";
import type { TombstoneRuntimeRepository } from "./tombstone-repository.js";
import type { ValidationRuntimeRepository } from "./validation-repository.js";
import type { WorkerRuntimeRepository } from "./worker-repository.js";
import type { SqliteAuditRuntimeRepositoryOptions } from "./store-contracts.js";
import type { SqliteBrokerStateStore } from "./store.js";
import type {
  A2AExchangeMessageRecord,
  A2AExchangeState,
  ArtifactRecord,
  AuditEvent,
  AuditListFilters,
  ChangeProposal,
  ProposalListFilters,
  TaskListFilters,
  TaskRecord,
  TaskTombstone,
  TombstoneListFilters,
  ValidationResult,
  WorkerListFilters,
  WorkerRecord,
} from "./types.js";

export const DEFAULT_HOT_RUNTIME_MAX_HEARTBEAT_AUDIT_EVENTS = 500;

export class SqliteTaskRuntimeRepository implements TaskRuntimeRepository {
  constructor(private readonly store: SqliteBrokerStateStore) {}

  getTask(id: string): TaskRecord | null {
    return this.store.readHotTasks({ id })[0] ?? null;
  }

  listTasks(filters: TaskListFilters = {}): TaskRecord[] {
    const sqliteCanApplyLimit = !filters.exchangeId && !filters.proposalId && !filters.claimedBy;
    return this.store
      .readHotTasks({
        status: filters.status,
        targetNodeId: filters.targetNodeId,
        intent: filters.intent,
        assignedWorkerId: filters.assignedWorkerId,
        taskOrigin: filters.taskOrigin,
        limit: sqliteCanApplyLimit ? filters.limit : undefined,
      })
      .filter((task) => taskMatchesRuntimeFilters(task, filters))
      .slice(0, normalizeRuntimeTaskListLimit(filters.limit));
  }

  upsertTask(task: TaskRecord): void {
    this.store.upsertHotTasks([task]);
  }
}

export class SqliteExchangeRuntimeRepository implements ExchangeRuntimeRepository {
  constructor(private readonly store: SqliteBrokerStateStore) {}

  getExchange(id: string): A2AExchangeState | null {
    return this.store.readHotExchanges({ id })[0] ?? null;
  }

  listExchanges(): A2AExchangeState[] {
    return this.store.readHotExchanges();
  }

  upsertExchange(exchange: A2AExchangeState): void {
    this.store.upsertHotExchanges([exchange]);
  }
}

export class SqliteExchangeMessageRuntimeRepository implements ExchangeMessageRuntimeRepository {
  constructor(private readonly store: SqliteBrokerStateStore) {}

  getExchangeMessage(id: string): A2AExchangeMessageRecord | null {
    return this.store.readHotExchangeMessages({ id })[0] ?? null;
  }

  listExchangeMessages(exchangeId: string): A2AExchangeMessageRecord[] {
    return this.store.readHotExchangeMessages({ exchangeId });
  }

  upsertExchangeMessage(message: A2AExchangeMessageRecord): void {
    this.store.upsertHotExchangeMessages([message]);
  }
}

export class SqliteProposalRuntimeRepository implements ProposalRuntimeRepository {
  constructor(private readonly store: SqliteBrokerStateStore) {}

  getProposal(id: string): ChangeProposal | null {
    return this.store.readHotProposals({ id })[0] ?? null;
  }

  listProposals(filters: ProposalListFilters = {}): ChangeProposal[] {
    return this.store.readHotProposals(filters);
  }

  upsertProposal(proposal: ChangeProposal): void {
    this.store.upsertHotProposals([proposal]);
  }
}

export class SqliteArtifactRuntimeRepository implements ArtifactRuntimeRepository {
  constructor(private readonly store: SqliteBrokerStateStore) {}

  getArtifact(id: string): ArtifactRecord | null {
    return this.store.readHotArtifacts({ id })[0] ?? null;
  }

  listArtifactsForProposal(proposalId: string): ArtifactRecord[] {
    return this.store.readHotArtifacts({ proposalId });
  }

  upsertArtifact(artifact: ArtifactRecord): void {
    this.store.upsertHotArtifacts([artifact]);
  }
}

export class SqliteValidationRuntimeRepository implements ValidationRuntimeRepository {
  constructor(private readonly store: SqliteBrokerStateStore) {}

  getValidation(id: string): ValidationResult | null {
    return this.store.readHotValidations({ id })[0] ?? null;
  }

  listValidationsForProposal(proposalId: string): ValidationResult[] {
    return this.store.readHotValidations({ proposalId });
  }

  upsertValidation(validation: ValidationResult): void {
    this.store.upsertHotValidations([validation]);
  }
}

export class SqliteWorkerRuntimeRepository implements WorkerRuntimeRepository {
  constructor(private readonly store: SqliteBrokerStateStore) {}

  getWorker(nodeId: string): WorkerRecord | null {
    return this.store.readHotWorkers({ nodeId })[0] ?? null;
  }

  listWorkers(filters: WorkerListFilters = {}): WorkerRecord[] {
    return this.store
      .readHotWorkers({ role: filters.role })
      .filter((worker) => workerMatchesRuntimeFilters(worker, filters));
  }

  upsertWorker(worker: WorkerRecord): void {
    this.store.upsertHotWorkers([worker]);
  }
}

export class SqliteAuditRuntimeRepository implements AuditRuntimeRepository {
  private readonly maxHotAuditEvents: number;
  private readonly maxHotHeartbeatAuditEvents: number;

  constructor(
    private readonly store: SqliteBrokerStateStore,
    options: SqliteAuditRuntimeRepositoryOptions = {},
  ) {
    this.maxHotAuditEvents = Math.max(0, Math.floor(options.maxHotAuditEvents ?? 5_000));
    this.maxHotHeartbeatAuditEvents = Math.max(
      0,
      Math.floor(options.maxHotHeartbeatAuditEvents ?? Math.min(this.maxHotAuditEvents, DEFAULT_HOT_RUNTIME_MAX_HEARTBEAT_AUDIT_EVENTS)),
    );
  }

  listAuditEvents(filters: AuditListFilters = {}): AuditEvent[] {
    return this.store.readHotAuditEvents(filters);
  }

  appendAuditEvent(event: AuditEvent): void {
    const hotEvent = { ...event, id: getHeartbeatAuditEventId(event) ?? event.id };
    this.store.upsertHotAuditEvents([hotEvent]);
    if (isHeartbeatAuditEvent(hotEvent)) {
      this.store.pruneHotHeartbeatAuditEventsToMax(this.maxHotHeartbeatAuditEvents);
    }
    this.store.pruneHotAuditEventsToMax(this.maxHotAuditEvents);
  }
}

export class SqliteTombstoneRuntimeRepository implements TombstoneRuntimeRepository {
  constructor(private readonly store: SqliteBrokerStateStore) {}

  getTombstone(taskId: string): TaskTombstone | null {
    return this.store.readHotTombstones({ taskId })[0] ?? null;
  }

  listTombstones(filters: TombstoneListFilters = {}): TaskTombstone[] {
    return this.store.readHotTombstones(filters);
  }

  upsertTombstone(tombstone: TaskTombstone): void {
    this.store.upsertHotTombstones([tombstone]);
  }
}
