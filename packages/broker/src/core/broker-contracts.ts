import type { TaskAttemptStoreSurface } from "../task-attempt/producer.js";
import type { TaskReadinessMode } from "../task-readiness.js";
import type { ArtifactRuntimeRepository } from "./artifact-repository.js";
import type { AuditRuntimeRepository } from "./audit-repository.js";
import type { BrokerPolicyDocument } from "a2a-policy-referee";
import type { InjectedKnowledgeSnapshot } from "./broker-knowledge-injection.js";
import type { FinalizerVerdictEnforcement } from "./finalizer-verdict-admission.js";
import type { FinalizerKeyring } from "a2a-attestation";
import type { ExchangeMessageRuntimeRepository, ExchangeRuntimeRepository } from "./exchange-repository.js";
import type { ProposalRuntimeRepository } from "./proposal-repository.js";
import type { TaskRuntimeRepository } from "./task-repository.js";
import type { TombstoneRuntimeRepository } from "./tombstone-repository.js";
import type { ValidationRuntimeRepository } from "./validation-repository.js";
import type { WorkerRuntimeRepository } from "./worker-repository.js";
import type { WorkerCapabilityCardRepository } from "./worker-capability-card.js";
import type { BrokerSnapshot } from "./store.js";
import type { TaskRecord, TaskStatus } from "./types.js";
import type { ReviewLineageRolloutMode } from "./review-lineage-store.js";
import type { WavePlanDagV2RecordStore } from "../wave-plan-dag-v2/record-store.js";

// Type-only contract bundle for InMemoryA2ABroker. Keep runtime broker logic in
// broker.ts; this module only hosts exported contracts/constants whose existing
// public import path is preserved by broker.ts re-exports.
export interface BrokerRetentionPolicy {
  /**
   * Age cutoff after which terminal records become *candidates* for pruning.
   * This is not a TTL: candidates past the cutoff are still retained up to
   * the maxTerminal* count caps, so count-based eviction only starts once
   * more than a cap's worth of records are older than the window.
   */
  terminalRetentionMs: number;
  maxTerminalExchanges: number;
  maxTerminalTasks: number;
  /**
   * Cumulative serialized-byte budget for retained terminal task records, the
   * dominant contributor to snapshot size. Bounds terminal-task retention by
   * bytes so the persisted state file cannot outgrow the snapshot byte cap
   * (STATE_FILE_MAX_BYTES) on the count cap alone (#1579). Unlike
   * terminalRetentionMs, this applies to terminal tasks even inside the age
   * window; active and protected tasks are never evicted by it.
   * Env: BROKER_MAX_TERMINAL_TASK_BYTES; defaults to half the snapshot cap.
   */
  maxTerminalTaskBytes: number;
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
  /**
   * Optional durable TaskAttemptRecordV1 store (#1799 slice 1). Injecting a
   * store enables record mode: terminal task transitions additionally emit a
   * public-safe attempt record. Absent (the default) the surface is fully
   * off. Recording is advisory and fail-open — it never changes task
   * execution, claims, retries, or finalization.
   */
  taskAttemptRecordStore?: TaskAttemptStoreSurface;
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
  /**
   * Resource-aware worker onboarding enforcement (#1786).
   *
   * Only workers that opt in via registration metadata are evaluated at all, so
   * this setting has no effect on workers that do not ask for it.
   *
   * - "warn" (default): evaluate and record the decision as an audit event.
   * - "enforce": additionally reject registration when the decision is no-go.
   * - "off": skip evaluation entirely.
   */
  resourceAwareOnboardingMode?: "off" | "warn" | "enforce";
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
   * Bounded PR review lifecycle telemetry posture (#1518 Phase 3b).
   * "off" (default) makes record calls no-ops; "record" persists and projects
   * explicit lineage events without affecting task completion or finalizers.
   */
  reviewLineageMode?: ReviewLineageRolloutMode;
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
  /**
   * Registered finalizer keyring (#1383 V-c follow-up). When present, the
   * accept-path verifies static-key verdict signatures in-broker at completion
   * time; absent = signature authenticity deferred to the repo merge gate.
   */
  finalizerKeyring?: FinalizerKeyring;
  /** Optional lightweight profiling hook for broker internals. Listener errors are ignored. */
  profilingListener?: BrokerProfilingListener;
  /**
   * Rollout mode for the WavePlanDagV2 rehearsal-evidence store (#1800).
   * `off` (default) keeps the entire surface absent; `record` lets the broker
   * hold a store that explicit operator/hub calls may append to. There is no
   * acting mode — recording is never authority (spec §1).
   */
  wavePlanDagV2Mode?: "off" | "record";
  /**
   * When `wavePlanDagV2Mode` is not `off`, the store to use. Optional even in
   * record mode so diagnostics can distinguish mode-on/store-absent; absent
   * store surfaces nothing (mirrors taskAttemptRecordStore).
   */
  wavePlanDagV2RecordStore?: WavePlanDagV2RecordStore;
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
