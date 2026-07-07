import type { TaskReadinessMode } from "../task-readiness.js";
import type { ArtifactRuntimeRepository } from "./artifact-repository.js";
import type { AuditRuntimeRepository } from "./audit-repository.js";
import type { BrokerPolicyDocument } from "./broker-policy.js";
import type { InjectedKnowledgeSnapshot } from "./broker-knowledge-injection.js";
import type { FinalizerVerdictEnforcement } from "./finalizer-verdict-admission.js";
import type { ExchangeMessageRuntimeRepository, ExchangeRuntimeRepository } from "./exchange-repository.js";
import type { ProposalRuntimeRepository } from "./proposal-repository.js";
import type { TaskRuntimeRepository } from "./task-repository.js";
import type { TombstoneRuntimeRepository } from "./tombstone-repository.js";
import type { ValidationRuntimeRepository } from "./validation-repository.js";
import type { WorkerRuntimeRepository } from "./worker-repository.js";
import type { WorkerCapabilityCardRepository } from "./worker-capability-card.js";
import type { BrokerSnapshot } from "./store.js";
import type { TaskRecord, TaskStatus } from "./types.js";

// Type-only contract bundle for InMemoryA2ABroker. Keep runtime broker logic in
// broker.ts; this module only hosts exported contracts/constants whose existing
// public import path is preserved by broker.ts re-exports.
export interface BrokerRetentionPolicy {
  terminalRetentionMs: number;
  maxTerminalExchanges: number;
  maxTerminalTasks: number;
  maxTerminalProposals: number;
  inactiveWorkerRetentionMs: number;
  maxInactiveWorkers: number;
  auditRetentionMs: number;
  /**
   * Maximum meaningful, non-heartbeat audit events retained after the age
   * window. Heartbeat audit rows use maxHeartbeatAuditEvents instead so
   * liveness chatter cannot evict terminal/proposal/approval evidence.
   */
  maxAuditEvents: number;
  /** Maximum heartbeat audit rows retained after the age window. */
  maxHeartbeatAuditEvents: number;
  /** Minimum interval for recording identical task heartbeat audit evidence. */
  heartbeatAuditSampleIntervalMs: number;
}

export interface InMemoryA2ABrokerOptions {
  /** Optional table-native repository for high-churn task lifecycle state. */
  taskRepository?: TaskRuntimeRepository;
  /** Optional table-native repository for append-only audit diagnostics. */
  auditRepository?: AuditRuntimeRepository;
  /** Optional table-native repository for terminal task tombstones. */
  tombstoneRepository?: TombstoneRuntimeRepository;
  /** Optional table-native repository for high-churn worker runtime state. */
  workerRepository?: WorkerRuntimeRepository;
  /** Optional table-native repository for A2A exchange runtime state. */
  exchangeRepository?: ExchangeRuntimeRepository;
  /** Optional table-native repository for A2A exchange message runtime state. */
  exchangeMessageRepository?: ExchangeMessageRuntimeRepository;
  /** Optional table-native repository for change proposal runtime state. */
  proposalRepository?: ProposalRuntimeRepository;
  /** Optional table-native repository for proposal artifact metadata. */
  artifactRepository?: ArtifactRuntimeRepository;
  /** Optional table-native repository for proposal validation results. */
  validationRepository?: ValidationRuntimeRepository;
  /** Optional repository for worker capability profile storage and retrieval. */
  capabilityCardRepository?: WorkerCapabilityCardRepository;
  retention?: Partial<BrokerRetentionPolicy>;
  /**
   * Maximum number of times the stale-task reaper (or manual requeue) is allowed to recycle a
   * single task back to `queued`. Once the cap is reached the next stale-recovery pass marks
   * the task `failed` with a `exceeded_requeue_limit` error instead of requeuing it again, so
   * a flapping worker or poisoned payload cannot thrash the queue forever. `0` disables the
   * cap (unlimited requeues, legacy behavior).
   */
  maxRequeueAttempts?: number;
  /**
   * Checkpoint/interrupt timeout in milliseconds (contract §1.4/§2.3): a
   * paused or awaiting_operator checkpoint that is not resumed within this
   * window is canceled by the stale-task sweep. Default 24h; 0 disables
   * timeout cancellation.
   */
  checkpointTimeoutMs?: number;
  /**
   * Max buffered SSE events per task for replay after reconnect.
   * Events beyond this limit are discarded (oldest first).
   * Default: 100.
   */
  maxBufferedEventsPerTask?: number;
  /**
   * Max retained {@link TaskStatusEvent}s in the broker-wide
   * {@link TaskEventStream}. Older events are evicted FIFO when exceeded.
   * Default: 1000.
   */
  maxTaskStatusEvents?: number;
  /**
   * Max retained terminal outbox records for external operator notifiers.
   * Older records are evicted FIFO when exceeded. Default: 1000.
   */
  maxTerminalTaskOutboxEvents?: number;
  /**
   * Minimum interval for persisting unchanged worker heartbeats. Set `0` to persist every heartbeat.
   * In-memory worker liveness still updates on every heartbeat. Default: disabled.
   */
  workerHeartbeatPersistIntervalMs?: number;
  /**
   * Stable broker identity for ownership-guarded tasks. When a task carries
   * brokerOfRecord metadata, lifecycle mutation is accepted only by a broker
   * configured with the same id.
   */
  brokerId?: string;
  /**
   * Stable team/tenant identity for ownership-guarded tasks. When a task
   * carries teamId metadata, lifecycle mutation is accepted only by a broker
   * configured with the same team id.
   */
  teamId?: string;
  /**
   * Definition-of-Ready lint mode for patch/implementation task creation. Default warn keeps rollout non-breaking; enforce fails underspecified new tasks closed.
   */
  taskReadinessMode?: TaskReadinessMode;
  /**
   * Declarative worker-class policy document (#1355 G1), pre-validated by
   * validateBrokerPolicyDocument. Evaluated at task create-time and claim-time;
   * the document's own `mode` decides warn vs enforce. Absent = no policy
   * evaluation (legacy behavior, everything allowed).
   */
  policyDocument?: BrokerPolicyDocument;
  /**
   * Deterministic anonymous knowledge snapshot (#1373 K1), pre-validated by
   * validateInjectedKnowledgeSnapshot. When present, tasks created with
   * payload.injectKnowledge === true receive counts-only hints in
   * policyContext.injectedKnowledge. Absent = no injection (legacy behavior).
   */
  injectedKnowledge?: InjectedKnowledgeSnapshot;
  /**
   * Accept-path finalizer-verdict posture (#1383 V-c). "off" (default) leaves
   * completion byte-identical to legacy; "warn"/"enforce" apply only to tasks
   * that opt in via payload.requireFinalizerVerdict. The broker checks verdict
   * structure/decision/subject-binding/independence — signature authenticity
   * stays with the repo merge gate.
   */
  finalizerVerdictEnforcement?: FinalizerVerdictEnforcement;
  /** Optional lightweight profiling hook for broker internals. Listener errors are ignored. */
  profilingListener?: BrokerProfilingListener;
  /** Optional non-core state to include in full broker snapshots. */
  snapshotExtensions?: () => Partial<BrokerSnapshot>;
}

export interface TaskDiagnosticsOptions {
  /** Threshold in ms after which a running task without heartbeat is stale. */
  staleAfterMs?: number;
  /** Threshold in ms after which a running task is long-running. */
  longRunningAfterMs?: number;
  /** Threshold in ms after which an assigned worker is considered stale/offline. */
  workerOfflineAfterMs?: number;
  nowMs?: number;
}

/**
 * Worker heartbeats are high-churn liveness hints. Persist unchanged heartbeats
 * only when explicitly configured; in-memory liveness remains updated on every
 * request. Material heartbeat changes still persist immediately.
 */
export const DEFAULT_WORKER_HEARTBEAT_PERSIST_INTERVAL_MS = Number.POSITIVE_INFINITY;

/**
 * Default milliseconds after which a persistent worker is considered stale.
 * @see WorkerMode
 */
export const DEFAULT_WORKER_OFFLINE_AFTER_MS = 90_000;

export type TaskUpdateReason =
  | "created"
  | "approved"
  | "claimed"
  | "started"
  | "succeeded"
  | "failed"
  | "canceled"
  | "updated"
  | "checkpointed"
  | "resumed"
  | "reassigned"
  | "requeued"
  | "dead_lettered"
  | "wake_planned"
  | "wake_scheduled"
  | "wake_skipped"
  | "wake_failed";

export interface TaskUpdate {
  task: TaskRecord;
  reason: TaskUpdateReason;
  /** Terminal updates should be the last event a subscriber sees for this task. */
  final: boolean;
  /** Monotonically increasing sequence number per task for SSE `id:` field and replay. */
  seq: number;
}

/** Buffered SSE event for replay after reconnect. */
export interface BufferedTaskEvent {
  seq: number;
  event: string;
  data: TaskUpdate;
}

export type TaskUpdateListener = (update: TaskUpdate) => void;
export type BrokerStateChange =
  | { kind: "state.persisted" }
  | { kind: "worker.heartbeat"; workerId: string; materialChange: boolean };

export type BrokerStateListener = (change: BrokerStateChange) => void;

export type BrokerProfilingOperation = "persistState";

export interface BrokerProfilingSample {
  operation: BrokerProfilingOperation;
  startedAt: string;
  durationMs: number;
  persistenceMode?: "full" | "hot";
  retentionApplied?: boolean;
  snapshotExported?: boolean;
  saveHints?: {
    hotExchanges: number;
    hotExchangeMessages: number;
    hotProposals: number;
    hotArtifacts: number;
    hotValidations: number;
    hotTasks: number;
    hotTombstones: number;
    hotAuditEvents: number;
    hotWorkers: number;
    hotTerminalOutboxEvents: number;
  };
}

export type BrokerProfilingListener = (sample: BrokerProfilingSample) => void;

export interface BrokerCompactDiagnostics {
  generatedAt: string;
  tasks: {
    total: number;
    byStatus: Record<TaskStatus, number>;
    stale: number;
    longRunning: number;
    bufferedEventStreams: number;
  };
  workers: {
    total: number;
    stale: number;
  };
  audit: {
    total: number;
    requeued: number;
    deadLettered: number;
  };
  retention: BrokerRetentionPolicy;
  runtimeRepositories: {
    tasks: boolean;
    audit: boolean;
    tombstones: boolean;
    workers: boolean;
    exchanges: boolean;
    exchangeMessages: boolean;
    proposals: boolean;
    artifacts: boolean;
    validations: boolean;
  };
}
