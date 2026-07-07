import { randomUUID } from "node:crypto";
import { TaskEventDispatcher } from "./task-event-dispatcher.js";
import { BrokerListenerRegistry } from "./broker-listener-registry.js";
import { WorkerIdentityChurnTracker } from "./worker-identity-churn-tracker.js";
import { SnapshotExtensionRegistry } from "./snapshot-extension-registry.js";
import { HeartbeatPersistThrottle } from "./heartbeat-persist-throttle.js";
import { PendingHotStateBuffer } from "./pending-hot-state-buffer.js";
import { computeRetainedRecordIds } from "./broker-retention-reachability.js";
import {
  countStateSaveHints,
} from "./broker-record-helpers.js";
import {
  findLatestTaskAuditEvent,
  buildTaskDiagnosticReport,
} from "./broker-task-diagnostics.js";
import { normalizeWorkerRecord } from "./broker-worker-identity.js";
import {
  applyWorkerHeartbeatRuntimeUpdate,
  buildRegisteredWorkerRecord,
  normalizeWorkerRegistrationCapabilities,
  workerHeartbeatRequestFromRegistration,
  workerRegistrationMateriallyChanges,
} from "./broker-worker-runtime.js";
import {
  normalizeTaskPayload,
  normalizeTaskResult,
  normalizeTaskError,
  normalizeTaskRecord,
  hoistParentRoundFields,
} from "./broker-task-record-normalizers.js";
import {
  normalizeBrokerRetentionPolicy,
  normalizeMaxRequeueAttempts,
} from "./broker-retention-policy.js";
// Re-exported to preserve the public surface; the retention/requeue defaults now
// live in broker-retention-policy.js alongside the normalizers that use them.
export {
  DEFAULT_BROKER_RETENTION_POLICY,
  DEFAULT_MAX_REQUEUE_ATTEMPTS,
  DEFAULT_HEARTBEAT_AUDIT_SAMPLE_INTERVAL_MS,
} from "./broker-retention-policy.js";
import {
  normalizeExchangeState,
  normalizeExchangeMessageRecord,
  createLegacyRootExchangeMessage,
} from "./broker-exchange-normalizers.js";
import {
  normalizeGitHubPatchTaskRequest,
  cleanOptionalTaskCancelField,
  normalizeOwnershipString,
} from "./broker-task-request-normalizers.js";
import {
  isTerminalTaskStatus,
  computeTaskDiagnosticStatus,
} from "./broker-status-predicates.js";
import {
  normalizeWakeString,
  normalizeApprovalId,
  normalizeApprovalReason,
  normalizeApprovalTerminalStatus,
  buildTaskWakeKey,
  defaultWakeDecisionMessage,
  wakeDecisionAuditAction,
  wakeDecisionUpdateReason,
  normalizeTaskWakeState,
} from "./broker-wake-normalizers.js";
import {
  getHeartbeatAuditEventId,
  pruneMapEntries,
} from "./broker-retention-selectors.js";
// Re-exported to preserve the existing public surface; the thresholds now live
// in broker-worker-status.js alongside the logic that classifies against them.
export { MOBILE_OFFLINE_AFTER_MS, MOBILE_DISCONNECTED_AFTER_MS } from "./broker-worker-status.js";
import {
  isoNow,
  uniqueIds,
  sortedCopy,
  sortNewestFirst,
} from "./broker-helpers.js";
import { buildBrokerDashboard } from "./broker-dashboard.js";
import {
  addBrokerExchangeMessage,
  listBrokerExchangeMessages,
  startBrokerExchange,
} from "./broker-exchange.js";
import { applyBrokerExchangeMessageDecision } from "./broker-exchange-task-decision.js";
import { getBrokerRoundStatus, listBrokerTasks, readBrokerTask } from "./broker-task-read.js";
import { planClassAwareTaskRetry } from "./task-retry-policy.js";
import { readBrokerProposal, listBrokerProposals } from "./broker-proposal-read.js";
import {
  listBrokerArtifactsForProposal,
  listBrokerAuditEvents,
  listBrokerValidationsForProposal,
  readBrokerArtifact,
} from "./broker-evidence-read.js";
import { buildCleanupDryRunPlan } from "./broker-cleanup-discovery.js";
import { buildWorkerCapacitySummary } from "./broker-worker-capacity.js";
import { buildCompactDiagnostics } from "./broker-compact-diagnostics.js";
import {
  listBrokerWorkerViews,
  listBrokerWorkers,
  readBrokerWorker,
  readBrokerWorkerCachedFirst,
  readBrokerWorkerView,
} from "./broker-worker-read.js";

import type { RoundStatusSummary } from "./round-status.js";

import {
  isPrivilegedTaskApprover,
  normalizeTaskPolicyContext,
} from "./policy.js";
import type { BrokerPolicyDocument } from "./broker-policy.js";
import * as taskAdmission from "./broker-task-admission.js";
import type { TaskAdmissionContext } from "./broker-task-admission.js";
import * as staleTaskRequeue from "./broker-stale-task-requeue.js";
import type { StaleTaskRequeueContext } from "./broker-stale-task-requeue.js";
import * as proposalWrite from "./broker-proposal-write.js";
import type { ProposalWriteContext } from "./broker-proposal-write.js";
import {
  CURRENT_BROKER_STATE_VERSION,
  type BrokerSnapshot,
  type BrokerStateSaveHints,
  type BrokerStateStore,
} from "./store.js";
import { validateGithubTaskCompletionEvidence } from "./github-task-completion.js";
import { validateReviewEvidence } from "../worker-review.js";
import {
  normalizeTaskReadinessMode,
  type TaskReadinessMode,
} from "../task-readiness.js";
import { TaskEventStream } from "./task-event-stream.js";
import {
  TerminalTaskEventOutbox,
  type TerminalTaskOutboxAckInput,
  type TerminalTaskOutboxEvent,
  type TerminalTaskOutboxReceiptUpdateInput,
} from "./terminal-event-outbox.js";
import { ConferenceRoomManager } from "./conference-room.js";
import {
  CrossBrokerTerminalBriefProjectionStore,
  type CrossBrokerTerminalBriefProjection,
  type CrossBrokerTerminalBriefProjectionFilters,
  type CrossBrokerTerminalBriefProjectionRequest,
  type CrossBrokerTerminalBriefProjectionResult,
} from "./cross-broker-terminal-brief.js";
import { normalizeA2ARoundTaskRequest } from "./a2a-round-policy.js";
import {
  assertWorkerRegistrationPayload,
} from "./broker-payload-validators.js";
import {
  assertTransition,
  assertTaskStatus,
  assertTaskCreationOwnership,
} from "./broker-transition-guards.js";
import { readExchange, readExchanges } from "./broker-exchange-read.js";
import {
  resolveTerminalBriefParentOriginRoute,
  normalizeTerminalBriefTeamScope,
  type TerminalBriefParentOriginRoute,
} from "./terminal-brief-routing.js";
import type { ArtifactRuntimeRepository } from "./artifact-repository.js";
import type { AuditRuntimeRepository } from "./audit-repository.js";
import type { ExchangeMessageRuntimeRepository, ExchangeRuntimeRepository } from "./exchange-repository.js";
import type { ProposalRuntimeRepository } from "./proposal-repository.js";
import type { TaskRuntimeRepository } from "./task-repository.js";
import type { TombstoneRuntimeRepository } from "./tombstone-repository.js";
import type { ValidationRuntimeRepository } from "./validation-repository.js";
import type { WorkerRuntimeRepository } from "./worker-repository.js";
import type {
  WorkerAssignmentRole,
  WorkerCapabilityCard,
  WorkerCapabilityCardQuery,
  WorkerCapabilityCardRepository,
} from "./worker-capability-card.js";
import { InMemoryWorkerCapabilityCardRepository } from "./worker-capability-card.js";
import {
  deleteBrokerCapabilityProfile,
  listBrokerCapabilityProfiles,
  readBrokerCapabilityProfile,
  registerDefaultBrokerCapabilityProfile,
  storeBrokerCapabilityProfile,
} from "./broker-capability-profiles.js";
import type {
  ApplyProposalRequest,
  ArtifactRecord,
  AttachArtifactRequest,
  AuditAction,
  AuditEvent,
  AuditListFilters,
  A2AExchangeIntent,
  A2APartyRef,
  A2AWorkerEnvironment,
  A2AExchangeMessageRecord,
  A2AExchangeMessageRequest,
  A2AExchangeRequest,
  A2AExchangeState,
  BrokerDashboard,
  ChangeProposal,
  CleanupDryRunPlan,
  CreateProposalRequest,
  CreateTaskRequest,
  ProposalActorRequest,
  ProposalDetails,
  ProposalListFilters,
  RegisterWorkerRequest,
  SubmitValidationRequest,
  TaskCancelRequest,
  TaskError,
  TaskApprovalRequest,
  TaskApprovalTerminalRequest,
  TaskApprovalOutcomeStatus,
  TaskListFilters,
  TaskCheckpointState,
  TaskInterruptDecisionType,
  TaskRecord,
  TaskReassignRequest,
  TaskResult,
  TaskStatus,
  TaskWakeDecisionRequest,
  TaskWakePlanRequest,
  TaskWakePlanResult,
  TaskWakeState,
  ValidationResult,
  WorkerCapacitySummary,
  WorkerCapabilities,
  WorkerHeartbeatRequest,
  WorkerIdentityWarning,
  TaskDiagnosticReport,
  TaskDiagnosticStatus,
  TaskTombstone,
  TombstoneListFilters,
  TombstoneReason,
  WorkerListFilters,
  WorkerRecord,
  WorkerView,
} from "./types.js";

import { BrokerError, REQUEUE_EXHAUSTED_ERROR_CODE, type BrokerErrorCode } from "./broker-error.js";
import {
  DEFAULT_WORKER_HEARTBEAT_PERSIST_INTERVAL_MS,
  DEFAULT_WORKER_OFFLINE_AFTER_MS,
  type BrokerCompactDiagnostics,
  type BrokerProfilingListener,
  type BrokerRetentionPolicy,
  type BrokerStateChange,
  type BrokerStateListener,
  type BufferedTaskEvent,
  type InMemoryA2ABrokerOptions,
  type TaskDiagnosticsOptions,
  type TaskUpdateListener,
} from "./broker-contracts.js";
// Re-exported to preserve the public surface; BrokerError/BrokerErrorCode and
// REQUEUE_EXHAUSTED_ERROR_CODE now live in broker-error.js so other modules can
// throw, type, and reference broker errors without importing the full broker
// module.
export { BrokerError, REQUEUE_EXHAUSTED_ERROR_CODE };
export type { BrokerErrorCode };

export {
  DEFAULT_WORKER_HEARTBEAT_PERSIST_INTERVAL_MS,
  DEFAULT_WORKER_OFFLINE_AFTER_MS,
};
export type {
  BrokerCompactDiagnostics,
  BrokerProfilingListener,
  BrokerProfilingOperation,
  BrokerProfilingSample,
  BrokerRetentionPolicy,
  BrokerStateChange,
  BrokerStateListener,
  BufferedTaskEvent,
  InMemoryA2ABrokerOptions,
  TaskDiagnosticsOptions,
  TaskUpdate,
  TaskUpdateListener,
  TaskUpdateReason,
} from "./broker-contracts.js";

const HOT_PERSIST_FULL_RETENTION_INTERVAL_MS = 5 * 60_000;

/** Frozen interrupt decision types (contracts/a2a/checkpoint-interrupt.md §2.2). */
const TASK_INTERRUPT_DECISION_TYPES: readonly TaskInterruptDecisionType[] = [
  "safety_gate",
  "ambiguous_scope",
  "approval_required",
  "conflict_detected",
];

const DEFAULT_CHECKPOINT_TIMEOUT_MS = 24 * 60 * 60 * 1000;


function uniqueTaskErrorHistory(history: TaskError[] | undefined, error: TaskError): TaskError[] {
  const values = [...(history ?? []), error];
  return values.slice(-5).map((item) => normalizeTaskError(item));
}

export class InMemoryA2ABroker {
  private readonly exchanges = new Map<string, A2AExchangeState>();
  private readonly exchangeMessages = new Map<string, A2AExchangeMessageRecord>();
  private readonly proposals = new Map<string, ChangeProposal>();
  private readonly artifacts = new Map<string, ArtifactRecord>();
  private readonly validations = new Map<string, ValidationResult>();
  private readonly auditEvents = new Map<string, AuditEvent>();
  private readonly workers = new Map<string, WorkerRecord>();
  private readonly tasks = new Map<string, TaskRecord>();
  private readonly tombstones = new Map<string, TaskTombstone>();
  private readonly taskEvents: TaskEventDispatcher;
  private readonly pendingHot = new PendingHotStateBuffer();
  private readonly workerHeartbeatPersist = new HeartbeatPersistThrottle();
  private readonly workerChurn = new WorkerIdentityChurnTracker();
  private readonly taskHeartbeatAuditPersist = new HeartbeatPersistThrottle();
  private readonly listeners: BrokerListenerRegistry;
  private readonly taskEventStream: TaskEventStream;
  private readonly terminalTaskEventOutbox: TerminalTaskEventOutbox;
  private readonly crossBrokerTerminalBriefs: CrossBrokerTerminalBriefProjectionStore;
  private readonly conferenceManager: ConferenceRoomManager;
  private readonly taskRepository?: TaskRuntimeRepository;
  private readonly auditRepository?: AuditRuntimeRepository;
  private readonly tombstoneRepository?: TombstoneRuntimeRepository;
  private readonly workerRepository?: WorkerRuntimeRepository;
  private readonly exchangeRepository?: ExchangeRuntimeRepository;
  private readonly exchangeMessageRepository?: ExchangeMessageRuntimeRepository;
  private readonly proposalRepository?: ProposalRuntimeRepository;
  private readonly artifactRepository?: ArtifactRuntimeRepository;
  private readonly validationRepository?: ValidationRuntimeRepository;
  private readonly capabilityCards: WorkerCapabilityCardRepository;
  private readonly snapshotExtensions: SnapshotExtensionRegistry;
  private readonly brokerId?: string;
  private readonly teamId?: string;
  private readonly taskReadinessMode: TaskReadinessMode;
  private readonly policyDocument?: BrokerPolicyDocument;
  private readonly workerHeartbeatPersistIntervalMs: number;
  private lastFullRetentionPersistAtMs = Date.now();

  constructor(
    private readonly stateStore?: BrokerStateStore,
    snapshot?: BrokerSnapshot,
    options: InMemoryA2ABrokerOptions = {},
  ) {
    this.taskRepository = options.taskRepository;
    this.auditRepository = options.auditRepository;
    this.tombstoneRepository = options.tombstoneRepository;
    this.workerRepository = options.workerRepository;
    this.exchangeRepository = options.exchangeRepository;
    this.exchangeMessageRepository = options.exchangeMessageRepository;
    this.proposalRepository = options.proposalRepository;
    this.artifactRepository = options.artifactRepository;
    this.validationRepository = options.validationRepository;
    this.capabilityCards = options.capabilityCardRepository ?? new InMemoryWorkerCapabilityCardRepository();
    this.listeners = new BrokerListenerRegistry(options.profilingListener);
    this.snapshotExtensions = new SnapshotExtensionRegistry(options.snapshotExtensions);
    this.brokerId = normalizeOwnershipString(options.brokerId);
    this.teamId = normalizeOwnershipString(options.teamId);
    this.taskReadinessMode = normalizeTaskReadinessMode(options.taskReadinessMode);
    this.policyDocument = options.policyDocument;
    this.workerHeartbeatPersistIntervalMs = Math.max(0, options.workerHeartbeatPersistIntervalMs ?? DEFAULT_WORKER_HEARTBEAT_PERSIST_INTERVAL_MS);
    this.retentionPolicy = normalizeBrokerRetentionPolicy(options.retention);
    this.maxRequeueAttempts = normalizeMaxRequeueAttempts(options.maxRequeueAttempts);
    this.checkpointTimeoutMs = Math.max(0, options.checkpointTimeoutMs ?? DEFAULT_CHECKPOINT_TIMEOUT_MS);
    this.taskEvents = new TaskEventDispatcher(options.maxBufferedEventsPerTask ?? 100);
    this.taskEventStream = new TaskEventStream({ maxEvents: options.maxTaskStatusEvents });
    this.terminalTaskEventOutbox = new TerminalTaskEventOutbox({ maxEvents: options.maxTerminalTaskOutboxEvents });
    this.crossBrokerTerminalBriefs = new CrossBrokerTerminalBriefProjectionStore([], {
      brokerId: this.brokerId,
      hasParentRound: (parentRoundId) => this.tasks.has(parentRoundId),
      parentBrokerOfRecord: (parentRoundId) => this.tasks.get(parentRoundId)?.brokerOfRecord,
      getParentRoundRouting: (parentRoundId) => {
        const task = this.tasks.get(parentRoundId);
        if (!task) return undefined;
        const payload = task.payload ?? {};
        const teamScope = normalizeTerminalBriefTeamScope(
          (payload["teamScope"] as string)
          ?? (payload["requestedTeamScope"] as string)
          ?? "",
        );
        const initiatingBrokerId = (payload["initiatingBrokerId"] as string)?.trim();
        if (!teamScope || !initiatingBrokerId) return undefined;
        const result = resolveTerminalBriefParentOriginRoute({ initiatingBrokerId, requestedTeamScope: teamScope });
        if (!result.ok) return undefined;
        return {
          initiatingBrokerId: result.route.initiatingBrokerId,
          parentBrokerId: result.route.parentBrokerId,
          operatorFacingTerminalBriefSender: result.route.operatorFacingTerminalBriefSender,
          handoffBrokerId: result.route.handoff?.handoffBrokerId,
          projectionDestinationBrokerId: result.route.handoff?.projectionDestinationBrokerId,
        };
      },
    });
    this.conferenceManager = new ConferenceRoomManager();
    if (snapshot) {
      this.loadSnapshot(snapshot);
    }
    this.applyRetentionPolicy();
  }

  /**
   * Cursor-based stream of task status transitions. Wraps the audit-event
   * pipeline so subscribers can replay missed events after reconnect without
   * polling. See `docs/task-event-stream.md`.
   */
  getTaskEventStream(): TaskEventStream {
    return this.taskEventStream;
  }

  /** Compact terminal task event outbox for durable webhook/SSE delivery. */
  getTerminalTaskEventOutbox(): TerminalTaskEventOutbox {
    return this.terminalTaskEventOutbox;
  }

  acknowledgeTerminalTaskOutboxEvent(id: string, receipt: TerminalTaskOutboxAckInput): TerminalTaskOutboxEvent | null {
    const event = this.terminalTaskEventOutbox.acknowledge(id, receipt);
    if (!event) return null;
    this.persistTerminalTaskOutboxEvent(event);
    return event;
  }

  recordTerminalTaskOutboxReceiptStatus(id: string, receipt: TerminalTaskOutboxReceiptUpdateInput): TerminalTaskOutboxEvent | null {
    const event = this.terminalTaskEventOutbox.recordReceiptStatus(id, receipt);
    if (!event) return null;
    this.persistTerminalTaskOutboxEvent(event);
    return event;
  }

  ingestCrossBrokerTerminalBriefProjection(request: CrossBrokerTerminalBriefProjectionRequest): CrossBrokerTerminalBriefProjectionResult {
    const result = this.crossBrokerTerminalBriefs.ingest(request);
    if (result.accepted) {
      if (!result.replayed) {
        this.terminalTaskEventOutbox.enqueueCrossBrokerProjection(result.record);
      }
      this.persistState();
    }
    return result;
  }

  listCrossBrokerTerminalBriefProjections(filters?: CrossBrokerTerminalBriefProjectionFilters): CrossBrokerTerminalBriefProjection[] {
    return this.crossBrokerTerminalBriefs.list(filters);
  }

  getCrossBrokerTerminalBriefProjection(parentRoundId: string, originBrokerId: string): CrossBrokerTerminalBriefProjection | undefined {
    return this.crossBrokerTerminalBriefs.get(parentRoundId, originBrokerId);
  }

  /**
   * Manager for agent teleconference rooms. Each room is anchored to a parent
   * task id and tracks participant status transitions using the same bounded
   * cursor/replay substrate as the task status stream. See `docs/conference-room.md`.
   */
  getConferenceManager(): ConferenceRoomManager {
    return this.conferenceManager;
  }

  private readonly retentionPolicy: BrokerRetentionPolicy;
  private readonly maxRequeueAttempts: number;
  private readonly checkpointTimeoutMs: number;

  /** Returns the configured max automatic requeues per task. `0` means disabled. */
  getMaxRequeueAttempts(): number {
    return this.maxRequeueAttempts;
  }

  /**
   * Subscribe to task-lifecycle updates. The listener fires once per state transition
   * (claim, start, complete, fail, cancel, reassign, requeue, dead-letter) with the current
   * `TaskRecord` snapshot. Returns an unsubscribe function. Listeners are not invoked with
   * the current state on subscribe; callers that need the initial state should read it via
   * `getTask(taskId)` before subscribing. Listener errors are caught and logged so a broken
   * subscriber cannot stall the broker.
   */
  /**
   * Register a listener invoked with the ids of tasks removed by the
   * retention policy, so task-scoped state held outside the broker (e.g.
   * push-notification configs and their delivery secrets) can be released
   * on the same lifecycle instead of outliving the task.
   */
  registerTaskPruneListener(listener: (prunedTaskIds: string[]) => void): () => void {
    return this.taskEvents.registerPruneListener(listener);
  }

  /**
   * Register optional non-core state to include in future full broker
   * snapshots. Server features that live outside the broker (for example,
   * push-notification config secrets) use this to preserve sidecar state even
   * when callers supply their own broker instance.
   */
  registerSnapshotExtension(provider: () => Partial<BrokerSnapshot>): () => void {
    return this.snapshotExtensions.register(provider);
  }

  subscribeToTask(taskId: string, listener: TaskUpdateListener): () => void {
    return this.taskEvents.subscribe(taskId, listener);
  }

  /** Subscribe to broker-wide state changes after a successful persisted mutation. */
  subscribeToState(listener: BrokerStateListener): () => void {
    return this.listeners.subscribeState(listener);
  }

  /** Subscribe to compact broker profiling samples. Listener errors are ignored. */
  subscribeToProfiling(listener: BrokerProfilingListener): () => void {
    return this.listeners.subscribeProfiling(listener);
  }

  getCompactDiagnostics(options?: {
    nowMs?: number;
    staleAfterMs?: number;
    longRunningAfterMs?: number;
    workerOfflineAfterMs?: number;
  }): BrokerCompactDiagnostics {
    return buildCompactDiagnostics(
      {
        tasks: this.listTasks(),
        workers: this.listWorkers(),
        audits: this.listAuditEvents(),
        bufferedEventStreams: this.taskEvents.bufferedStreamCount(),
        retentionPolicy: this.retentionPolicy,
        runtimeRepositories: {
          tasks: Boolean(this.taskRepository),
          audit: Boolean(this.auditRepository),
          tombstones: Boolean(this.tombstoneRepository),
          workers: Boolean(this.workerRepository),
          exchanges: Boolean(this.exchangeRepository),
          exchangeMessages: Boolean(this.exchangeMessageRepository),
          proposals: Boolean(this.proposalRepository),
          artifacts: Boolean(this.artifactRepository),
          validations: Boolean(this.validationRepository),
        },
      },
      options,
    );
  }

  /** Replay buffered events after the given sequence number. Returns events with seq > afterSeq. */
  replayTaskEvents(taskId: string, afterSeq: number): BufferedTaskEvent[] {
    return this.taskEvents.replay(taskId, afterSeq);
  }

  /** Build the SSE `id` field value: `{taskId}:{seq}`. */
  formatSseEventId(taskId: string, seq: number): string {
    return `${taskId}:${seq}`;
  }

  /** Parse an SSE `Last-Event-Id` value into taskId and seq. Returns null if malformed. */
  parseSseEventId(raw: string): { taskId: string; seq: number } | null {
    const colonIdx = raw.lastIndexOf(":");
    if (colonIdx < 1) {
      return null;
    }
    const taskId = raw.substring(0, colonIdx);
    const seq = Number(raw.substring(colonIdx + 1));
    if (!taskId || !Number.isFinite(seq) || seq < 0) {
      return null;
    }
    return { taskId, seq };
  }

  startExchange(request: A2AExchangeRequest): A2AExchangeState {
    return startBrokerExchange(request, {
      setExchangeMessageRecord: (message) => this.setExchangeMessageRecord(message),
      setExchangeRecord: (exchange) => this.setExchangeRecord(exchange),
      persistState: () => this.persistState(),
    });
  }

  getExchange(id: string): A2AExchangeState | null {
    return readExchange(this.exchanges, this.exchangeRepository, id);
  }

  listExchanges(): A2AExchangeState[] {
    return readExchanges(this.exchanges, this.exchangeRepository);
  }

  listExchangeMessages(
    exchangeId: string,
    filters?: {
      parentMessageId?: string;
      includeDescendants?: boolean;
    },
  ): A2AExchangeMessageRecord[] {
    return listBrokerExchangeMessages(exchangeId, filters, {
      exchangeMessages: this.exchangeMessages,
      exchangeMessageRepository: this.exchangeMessageRepository,
      requireExchange: (id) => this.requireExchange(id),
      requireExchangeMessage: (id, messageId) => this.requireExchangeMessage(id, messageId),
    });
  }

  addExchangeMessage(exchangeId: string, request: A2AExchangeMessageRequest): A2AExchangeMessageRecord {
    return addBrokerExchangeMessage(exchangeId, request, {
      requireExchange: (id) => this.requireExchange(id),
      requireWorker: (nodeId) => this.requireWorker(nodeId),
      requireExchangeMessage: (id, messageId) => this.requireExchangeMessage(id, messageId),
      setExchangeMessageRecord: (message) => this.setExchangeMessageRecord(message),
      setExchangeRecord: (exchange) => this.setExchangeRecord(exchange),
      applyExchangeMessageDecision: (exchange, message, hasExplicitAssignment) => this.applyExchangeMessageDecision(
        exchange,
        message,
        hasExplicitAssignment,
      ),
      appendAuditEvent: (input) => this.appendAuditEvent(input),
      persistState: () => this.persistState(),
    });
  }

  registerWorker(request: RegisterWorkerRequest): WorkerRecord {
    assertWorkerRegistrationPayload(request);

    const now = isoNow();
    const existing = this.getWorkerCachedFirst(request.nodeId);
    const capabilities = normalizeWorkerRegistrationCapabilities(request);
    const materialChange = workerRegistrationMateriallyChanges(existing, request, capabilities);

    const identityWarning = existing && materialChange
      ? this.workerChurn.recordFingerprintChange(existing, request, capabilities)
      : undefined;

    if (existing && !materialChange) {
      return this.heartbeatWorker(
        request.nodeId,
        workerHeartbeatRequestFromRegistration(request, capabilities),
      );
    }

    const worker = buildRegisteredWorkerRecord(request, capabilities, existing, now);

    this.setWorkerRecord(worker);
    this.appendAuditEvent({
      actorId: worker.nodeId,
      action: "worker.registered",
      targetType: "worker",
      targetId: worker.nodeId,
      note: worker.displayName ?? worker.role,
    });
    if (identityWarning) {
      this.appendAuditEvent({
        actorId: worker.nodeId,
        action: "worker.identity_churn_detected",
        targetType: "worker",
        targetId: worker.nodeId,
        note: identityWarning.message,
      });
    }
    this.persistState();
    return worker;
  }

  getWorkerIdentityWarnings(): Record<string, WorkerIdentityWarning> {
    return this.workerChurn.getWarnings();
  }

  heartbeatWorker(nodeId: string, request?: WorkerHeartbeatRequest): WorkerRecord {
    const worker = this.requireWorkerCachedFirst(nodeId);
    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();
    const { materialChange } = applyWorkerHeartbeatRuntimeUpdate(worker, request, now);

    const shouldPersistHeartbeat = this.workerHeartbeatPersist.shouldPersist(
      worker.nodeId,
      nowMs,
      this.workerHeartbeatPersistIntervalMs,
      materialChange,
    );

    if (!shouldPersistHeartbeat) {
      this.setWorkerRecordInMemory(worker);
      return worker;
    }

    this.setWorkerRecord(worker);
    this.appendAuditEvent({
      actorId: worker.nodeId,
      action: "worker.heartbeat",
      targetType: "worker",
      targetId: worker.nodeId,
      note: "heartbeat",
    });
    this.persistState({
      kind: "worker.heartbeat",
      workerId: worker.nodeId,
      materialChange,
    });
    this.workerHeartbeatPersist.markPersisted(worker.nodeId, nowMs);
    return worker;
  }

  getWorker(nodeId: string): WorkerRecord | null {
    return readBrokerWorker({ workers: this.workers, workerRepository: this.workerRepository }, nodeId);
  }

  getWorkerCachedFirst(nodeId: string): WorkerRecord | null {
    return readBrokerWorkerCachedFirst({ workers: this.workers, workerRepository: this.workerRepository }, nodeId);
  }

  listWorkers(filters?: WorkerListFilters): WorkerRecord[] {
    return listBrokerWorkers({ workers: this.workers, workerRepository: this.workerRepository }, filters);
  }

  listWorkerViews(offlineAfterMs: number, filters?: WorkerListFilters): WorkerView[] {
    return listBrokerWorkerViews(
      { workers: this.workers, workerRepository: this.workerRepository },
      offlineAfterMs,
      filters,
    );
  }

  getWorkerView(nodeId: string, offlineAfterMs: number): WorkerView | null {
    return readBrokerWorkerView(
      { workers: this.workers, workerRepository: this.workerRepository },
      nodeId,
      offlineAfterMs,
    );
  }

  // ---------------------------------------------------------------------------
  // Worker capability profile storage/listing and assignment consumption (R31)
  // ---------------------------------------------------------------------------

  /**
   * Persist a capability profile for assignment planning.
   * Overwrites any previous profile for the same worker.
   */
  storeCapabilityProfile(card: WorkerCapabilityCard): void {
    storeBrokerCapabilityProfile(this.capabilityCards, card);
  }

  /**
   * Retrieve a stored capability profile by worker id, or null when no profile
   * has been registered for that worker.
   */
  getCapabilityProfile(workerId: string): WorkerCapabilityCard | null {
    return readBrokerCapabilityProfile(this.capabilityCards, workerId);
  }

  /**
   * List all stored capability profiles. Filters by {@link WorkerCapabilityCardQuery}
   * when provided. Only valid cards pass the filter.
   */
  listCapabilityProfiles(query?: WorkerCapabilityCardQuery): WorkerCapabilityCard[] {
    return listBrokerCapabilityProfiles(this.capabilityCards, query);
  }

  /**
   * Remove a stored capability profile. No-op when the worker has no profile.
   */
  deleteCapabilityProfile(workerId: string): void {
    deleteBrokerCapabilityProfile(this.capabilityCards, workerId);
  }

  /**
   * Auto-register a default capability profile from a registered
   * {@link WorkerView}. Useful when a worker registers and no explicit
   * capability card has been provided, so assignment planning always has at
   * least a baseline profile to work with.
   */
  registerDefaultCapabilityProfile(
    worker: WorkerView,
    defaults?: {
      teamId?: "team1" | "team2";
      brokerOfRecord?: string;
      lane?: "team1" | "team2";
      assignmentRoles?: WorkerAssignmentRole[];
      supportedTaskTypes?: A2AExchangeIntent[];
    },
  ): WorkerCapabilityCard {
    return registerDefaultBrokerCapabilityProfile(this.capabilityCards, worker, defaults);
  }

  // Proposal write paths (#1289 L-broker-11): the six RBAC-gated lifecycle
  // writes moved to broker-proposal-write.ts with callback-injected state
  // effects. These public delegators keep the API and call sites unchanged.
  private proposalWriteContext(): ProposalWriteContext {
    return {
      requireProposal: (id) => this.requireProposal(id),
      setProposalRecord: (proposal) => this.setProposalRecord(proposal),
      setArtifactRecord: (artifact) => this.setArtifactRecord(artifact),
      setValidationRecord: (validation) => this.setValidationRecord(validation),
      appendAuditEvent: (input) => this.appendAuditEvent(input),
      persistState: () => this.persistState(),
    };
  }

  createProposal(request: CreateProposalRequest): ChangeProposal {
    return proposalWrite.createProposal(request, this.proposalWriteContext());
  }

  getProposal(id: string): ChangeProposal | null {
    return readBrokerProposal(this.proposals, this.proposalRepository, id);
  }

  listProposals(filters?: ProposalListFilters): ChangeProposal[] {
    return listBrokerProposals(this.proposals, this.proposalRepository, filters);
  }

  getProposalDetails(id: string): ProposalDetails | null {
    const proposal = this.getProposal(id);
    if (!proposal) {
      return null;
    }

    return {
      proposal,
      artifacts: this.listArtifactsForProposal(id),
      validations: this.listValidationsForProposal(id),
      audit: this.listAuditEvents({ proposalId: id }),
    };
  }

  attachArtifact(proposalId: string, request: AttachArtifactRequest): ArtifactRecord {
    return proposalWrite.attachArtifact(proposalId, request, this.proposalWriteContext());
  }

  submitValidationResult(
    proposalId: string,
    request: SubmitValidationRequest,
  ): ValidationResult {
    return proposalWrite.submitValidationResult(proposalId, request, this.proposalWriteContext());
  }

  approveProposal(proposalId: string, request: ProposalActorRequest): ChangeProposal {
    return proposalWrite.approveProposal(proposalId, request, this.proposalWriteContext());
  }

  rejectProposal(proposalId: string, request: ProposalActorRequest): ChangeProposal {
    return proposalWrite.rejectProposal(proposalId, request, this.proposalWriteContext());
  }

  applyProposalLocally(proposalId: string, request: ApplyProposalRequest): ChangeProposal {
    return proposalWrite.applyProposalLocally(proposalId, request, this.proposalWriteContext());
  }

  createTask(request: CreateTaskRequest): TaskRecord {
    const normalizedGitHubRequest = normalizeGitHubPatchTaskRequest(request);
    const brokerOfRecord = normalizeOwnershipString(normalizedGitHubRequest.brokerOfRecord) ?? this.brokerId;
    const roundNormalizedRequest = normalizeA2ARoundTaskRequest(normalizedGitHubRequest, brokerOfRecord);
    const normalizedRequest = {
      ...roundNormalizedRequest,
      payload: normalizeTaskPayload(roundNormalizedRequest.payload, {
        assignedWorkerId: roundNormalizedRequest.assignedWorkerId ?? roundNormalizedRequest.target.id,
        localBrokerId: brokerOfRecord,
      }),
    };
    this.assertTaskPayload(normalizedRequest);

    // Idempotent create: if a task with the requested id already exists, return it as-is.
    if (normalizedRequest.id) {
      const existing = this.getTask(normalizedRequest.id);
      if (existing) {
        return existing;
      }
    }

    this.assertTaskReadiness(normalizedRequest);

    if (normalizedRequest.exchangeId) {
      this.requireExchange(normalizedRequest.exchangeId);
    }
    this.requireWorker(normalizedRequest.target.id);
    if (normalizedRequest.assignedWorkerId) {
      this.requireWorker(normalizedRequest.assignedWorkerId);
    }
    this.assertA2ARoundWorkerAvailability(normalizedRequest);
    this.assertTaskProposalLink(normalizedRequest);

    // Declarative worker-class policy (#1355 G1). An enforce-mode deny throws
    // here (nothing is created); a warn-mode deny is audited after the record
    // exists; require_approval merges into the existing blocked -> operator
    // approve -> queued flow regardless of mode (blocking is recoverable).
    const policyDecision = this.evaluateCreateTaskPolicy(normalizedRequest);

    const now = isoNow();
    const basePolicyContext = normalizeTaskPolicyContext(normalizedRequest);
    const policyContext = policyDecision?.action === "require_approval"
      ? { ...(basePolicyContext ?? {}), requiresApproval: true }
      : basePolicyContext;
    const initialStatus: TaskStatus = policyContext?.requiresApproval === true ? "blocked" : "queued";
    const teamId = normalizeOwnershipString(normalizedRequest.teamId) ?? this.teamId;
    assertTaskCreationOwnership(brokerOfRecord, this.brokerId);
    const task: TaskRecord = {
      id: normalizedRequest.id ?? randomUUID(),
      exchangeId: normalizedRequest.exchangeId,
      parentTaskId: normalizedRequest.parentTaskId,
      ...(normalizedRequest.referenceTaskIds?.length
        ? { referenceTaskIds: uniqueIds(normalizedRequest.referenceTaskIds) }
        : {}),
      intent: normalizedRequest.intent,
      requester: normalizedRequest.requester,
      target: normalizedRequest.target,
      targetNodeId: normalizedRequest.target.id,
      assignedWorkerId: normalizedRequest.assignedWorkerId ?? normalizedRequest.target.id,
      workspace: normalizedRequest.workspace,
      message: normalizedRequest.message,
      ...hoistParentRoundFields(normalizedRequest, normalizedRequest.payload),
      proposalId: normalizedRequest.proposalId,
      artifactIds: uniqueIds(normalizedRequest.artifactIds ?? []),
      via: normalizedRequest.via,
      policyContext,
      payload: normalizedRequest.payload,
      status: initialStatus,
      createdAt: normalizedRequest.createdAt ?? now,
      updatedAt: now,
      taskOrigin: normalizedRequest.taskOrigin ?? "unknown",
      ...(brokerOfRecord ? { brokerOfRecord } : {}),
      ...(teamId ? { teamId } : {}),
    };

    this.setTaskRecord(task);
    if (task.exchangeId) {
      this.linkTaskToExchange(task);
    }
    this.appendAuditEvent({
      actorId: task.requester.id,
      action: "task.created",
      targetType: "task",
      targetId: task.id,
      proposalId: task.proposalId,
      note: task.status === "blocked" ? `approval required: ${task.message ?? task.intent}` : task.message ?? task.intent,
    });
    if (policyDecision?.action === "deny") {
      // warn mode (an enforce deny threw before creation): structural evidence
      // that this task WOULD be denied under enforce, without blocking it.
      this.appendAuditEvent({
        actorId: task.requester.id,
        action: "task.policy_warned",
        targetType: "task",
        targetId: task.id,
        note: `rule ${policyDecision.ruleId}: ${policyDecision.reason}`,
      });
    }
    this.persistState();
    this.taskEvents.emit(task, "created");
    return task;
  }

  planAcceptedTaskWake(taskId: string, request: TaskWakePlanRequest): TaskWakePlanResult {
    const task = this.requireTask(taskId);
    if (!request.targetSessionKey?.trim()) {
      throw new BrokerError("bad_request", "targetSessionKey is required");
    }
    if (isTerminalTaskStatus(task.status)) {
      throw new BrokerError("invalid_transition", `cannot plan wake for terminal task ${task.status}`);
    }

    const wakeKey = buildTaskWakeKey(task, request);
    const idempotencyKey = normalizeWakeString(request.idempotencyKey) ?? `a2a-wake:${wakeKey}`;
    const existing = task.wake;
    if (existing) {
      if (existing.wakeKey !== wakeKey) {
        throw new BrokerError("invalid_transition", "task wake already planned with a different wake key");
      }
      task.wake = {
        ...existing,
        replayCount: (existing.replayCount ?? 0) + 1,
        updatedAt: isoNow(),
      };
      this.setTaskRecord(task);
      this.persistState();
      return {
        task,
        wake: task.wake,
        shouldDispatch: existing.status === "planned",
        replayed: true,
      };
    }

    const now = isoNow();
    const wake: TaskWakeState = {
      status: "planned",
      wakeKey,
      idempotencyKey,
      targetSessionKey: request.targetSessionKey.trim(),
      ...(normalizeWakeString(request.targetNodeId) ? { targetNodeId: normalizeWakeString(request.targetNodeId) } : {}),
      ...(normalizeWakeString(request.waitRunId) ? { waitRunId: normalizeWakeString(request.waitRunId) } : {}),
      ...(normalizeWakeString(request.correlationId) ? { correlationId: normalizeWakeString(request.correlationId) } : {}),
      ...(normalizeWakeString(request.parentRunId) ? { parentRunId: normalizeWakeString(request.parentRunId) } : {}),
      ...(normalizeWakeString(request.message) ? { message: normalizeWakeString(request.message) } : {}),
      plannedAt: now,
      updatedAt: now,
      replayCount: 0,
    };

    task.wake = wake;
    task.updatedAt = now;
    this.setTaskRecord(task);
    this.appendAuditEvent({
      actorId: task.requester.id,
      action: "task.wake.planned",
      targetType: "task",
      targetId: task.id,
      proposalId: task.proposalId,
      note: wake.message ?? wake.wakeKey,
    });
    this.persistState();
    this.taskEvents.emit(task, "wake_planned");
    return { task, wake, shouldDispatch: true, replayed: false };
  }

  recordTaskWakeDecision(taskId: string, request: TaskWakeDecisionRequest): TaskRecord {
    const task = this.requireTask(taskId);
    if (!task.wake) {
      throw new BrokerError("invalid_transition", "task wake has not been planned");
    }
    const existing = task.wake;
    if (existing.status !== "planned") {
      if (existing.status === request.status) {
        return task;
      }
      throw new BrokerError("invalid_transition", `task wake already decided as ${existing.status}`);
    }

    const now = isoNow();
    const message = normalizeWakeString(request.message) ?? defaultWakeDecisionMessage(request.status);
    task.wake = {
      ...existing,
      status: request.status,
      ...(request.coalesced !== undefined ? { coalesced: request.coalesced } : {}),
      ...(normalizeWakeString(request.runtimeRunId) ? { runtimeRunId: normalizeWakeString(request.runtimeRunId) } : {}),
      ...(normalizeWakeString(request.code) ? { code: normalizeWakeString(request.code) } : {}),
      message,
      decidedAt: now,
      updatedAt: now,
    };
    task.updatedAt = now;
    this.setTaskRecord(task);
    const action = wakeDecisionAuditAction(request.status);
    this.appendAuditEvent({
      actorId: "broker",
      action,
      targetType: "task",
      targetId: task.id,
      proposalId: task.proposalId,
      note: `${request.status}: ${message}`,
    });
    this.persistState();
    this.taskEvents.emit(task, wakeDecisionUpdateReason(request.status));
    return task;
  }

  getTask(id: string): TaskRecord | null {
    return readBrokerTask(this.tasks, this.taskRepository, id);
  }

  listTasks(filters?: TaskListFilters): TaskRecord[] {
    return listBrokerTasks(this.tasks, this.taskRepository, filters);
  }

  /** Aggregate lane completion for an A2A/A2AD parent round (#629). */
  getRoundStatus(parentRoundId: string): RoundStatusSummary {
    return getBrokerRoundStatus(this.tasks, this.taskRepository, parentRoundId);
  }

  updateTaskPayload(
    taskId: string,
    payload: Record<string, unknown>,
    request: { actor: A2APartyRef; note?: string },
  ): TaskRecord {
    const task = this.requireTask(taskId);
    if (!request.actor?.id) {
      throw new BrokerError("bad_request", "actor.id is required");
    }
    const now = isoNow();
    task.payload = normalizeTaskPayload(payload);
    task.updatedAt = now;
    this.setTaskRecord(task);
    this.appendAuditEvent({
      actorId: request.actor.id,
      action: "task.updated",
      targetType: "task",
      targetId: task.id,
      proposalId: task.proposalId,
      note: request.note ?? "task payload updated",
    });
    this.persistState();
    this.taskEvents.emit(task, "updated");
    return task;
  }

  reassignTask(taskId: string, request: TaskReassignRequest): TaskRecord {
    const task = this.requireTask(taskId);
    if (!request.actor?.id) {
      throw new BrokerError("bad_request", "actor.id is required");
    }
    if (request.actor.role !== "hub" && request.actor.role !== "operator") {
      throw new BrokerError("policy_denied", "task reassignment requires a hub or operator actor");
    }
    if (isTerminalTaskStatus(task.status)) {
      throw new BrokerError("invalid_transition", `cannot reassign task while status is ${task.status}`);
    }

    const previousTargetNodeId = task.targetNodeId;
    const previousAssignedWorkerId = task.assignedWorkerId ?? task.targetNodeId;
    const nextTargetNodeId = request.targetNodeId ?? task.targetNodeId;
    const nextAssignedWorkerId = request.assignedWorkerId ?? request.targetNodeId ?? task.assignedWorkerId ?? nextTargetNodeId;
    const targetWorker = this.requireWorker(nextTargetNodeId);
    const assignedWorker = this.requireWorker(nextAssignedWorkerId);
    const now = isoNow();

    task.targetNodeId = nextTargetNodeId;
    task.target = {
      id: targetWorker.nodeId,
      kind: "node",
      role: targetWorker.role,
    };
    task.assignedWorkerId = assignedWorker.nodeId;
    task.status = task.policyContext?.requiresApproval === true && !task.approval ? "blocked" : "queued";
    task.claimedBy = undefined;
    task.claimedAt = undefined;
    task.completedAt = undefined;
    task.result = undefined;
    task.error = undefined;
    // Operator reassignment is a fresh attempt budget: clearing `requeueCount` so the new
    // target isn't penalized by the previous worker's flaps.
    task.requeueCount = 0;
    task.attemptId = undefined;
    task.updatedAt = now;
    this.setTaskRecord(task);
    this.syncExchangeStateFromTask(task, "queued");
    this.appendAuditEvent({
      actorId: request.actor.id,
      action: "task.reassigned",
      targetType: "task",
      targetId: task.id,
      proposalId: task.proposalId,
      note:
        request.note ??
        `reassigned targetNodeId ${previousTargetNodeId} -> ${task.targetNodeId}, assignedWorkerId ${previousAssignedWorkerId} -> ${task.assignedWorkerId}`,
    });
    this.persistState();
    this.taskEvents.emit(task, "reassigned");
    return task;
  }

  cancelTask(taskId: string, request: TaskCancelRequest): TaskRecord {
    const task = this.requireTask(taskId);
    if (!request.actor?.id) {
      throw new BrokerError("bad_request", "actor.id is required");
    }

    const actorId = request.actor.id;
    const actorRole = request.actor.role;
    const requesterMatch = actorId === task.requester.id;
    const workerMatch =
      actorId === task.claimedBy ||
      actorId === task.assignedWorkerId ||
      actorId === task.targetNodeId;

    if (
      actorRole !== "hub" &&
      actorRole !== "operator" &&
      !requesterMatch &&
      !workerMatch
    ) {
      throw new BrokerError(
        "policy_denied",
        "task cancellation requires a hub, operator, requester, or assigned worker actor",
      );
    }

    if (task.status === "succeeded" || task.status === "failed" || task.status === "canceled") {
      return task;
    }

    const supersededByTaskId = cleanOptionalTaskCancelField(request.supersededByTaskId);
    const supersededByPrUrl = cleanOptionalTaskCancelField(request.supersededByPrUrl);
    const roundId = cleanOptionalTaskCancelField(request.roundId);
    if (supersededByTaskId === task.id) {
      throw new BrokerError("bad_request", "supersededByTaskId must refer to a different task");
    }
    if (supersededByTaskId) {
      const winner = this.requireTask(supersededByTaskId);
      if (!isTerminalTaskStatus(winner.status)) {
        throw new BrokerError("invalid_transition", `cannot supersede task by non-terminal task ${supersededByTaskId}`);
      }
    }
    const superseded = Boolean(supersededByTaskId || supersededByPrUrl);
    const reason = request.reason ?? (superseded
      ? `superseded by ${supersededByPrUrl ?? supersededByTaskId}`
      : undefined);

    return this.cancelTaskTree(task, {
      actorId,
      reason,
      kind: superseded ? "superseded" : undefined,
      supersededByTaskId,
      supersededByPrUrl,
      roundId,
    });
  }

  approveTask(taskId: string, request: TaskApprovalRequest): TaskRecord {
    const task = this.requireTask(taskId);
    if (!request.actor?.id) {
      throw new BrokerError("bad_request", "actor.id is required");
    }
    if (!isPrivilegedTaskApprover(request.actor)) {
      throw new BrokerError("policy_denied", "task approval requires a hub or operator actor");
    }
    if (task.policyContext?.requiresApproval !== true) {
      throw new BrokerError("invalid_transition", "task does not require approval");
    }
    if (task.approval) {
      return task;
    }
    if (isTerminalTaskStatus(task.status)) {
      throw new BrokerError("invalid_transition", `cannot approve task while status is ${task.status}`);
    }
    if (task.status !== "blocked" && task.status !== "queued") {
      throw new BrokerError("invalid_transition", `cannot approve task while status is ${task.status}`);
    }

    const now = isoNow();
    task.approval = {
      approvalId: normalizeApprovalId(request.approvalId) ?? randomUUID(),
      approvedAt: now,
      approvedBy: request.actor.id,
      actorRole: request.actor.role,
      requesterRole: task.requester.role,
      reason: normalizeApprovalReason(request.reason),
    };
    task.approvalOutcome = {
      status: "approved",
      approvalId: task.approval.approvalId,
      decidedAt: now,
      decidedBy: request.actor.id,
      actorRole: request.actor.role,
      requesterRole: task.requester.role,
      reason: task.approval.reason,
    };
    task.status = "queued";
    task.updatedAt = now;
    this.setTaskRecord(task);
    this.syncExchangeStateFromTask(task, "queued");
    this.appendAuditEvent({
      actorId: request.actor.id,
      action: "task.approved",
      targetType: "task",
      targetId: task.id,
      proposalId: task.proposalId,
      note: task.approval.reason ?? `approvalId=${task.approval.approvalId}`,
    });
    this.persistState();
    this.taskEvents.emit(task, "approved");
    return task;
  }

  rejectTaskApproval(taskId: string, request: TaskApprovalTerminalRequest): TaskRecord {
    const task = this.requireTask(taskId);
    if (!request.actor?.id) {
      throw new BrokerError("bad_request", "actor.id is required");
    }
    if (!isPrivilegedTaskApprover(request.actor)) {
      throw new BrokerError("policy_denied", "task approval rejection requires a hub or operator actor");
    }
    if (task.policyContext?.requiresApproval !== true) {
      throw new BrokerError("invalid_transition", "task does not require approval");
    }
    if (task.approval || task.approvalOutcome?.status === "approved") {
      throw new BrokerError("invalid_transition", "task approval is already approved");
    }
    if (task.approvalOutcome) {
      return task;
    }
    if (isTerminalTaskStatus(task.status)) {
      throw new BrokerError("invalid_transition", `cannot reject approval while task status is ${task.status}`);
    }
    if (task.status !== "blocked" && task.status !== "queued") {
      throw new BrokerError("invalid_transition", `cannot reject approval while task status is ${task.status}`);
    }

    const now = isoNow();
    const status = normalizeApprovalTerminalStatus(request.status);
    const reason = normalizeApprovalReason(request.reason) ?? `approval ${status}`;
    task.approvalOutcome = {
      status,
      approvalId: normalizeApprovalId(request.approvalId) ?? randomUUID(),
      decidedAt: now,
      decidedBy: request.actor.id,
      actorRole: request.actor.role,
      requesterRole: task.requester.role,
      reason,
    };
    const canceled = this.cancelTaskTree(task, {
      actorId: request.actor.id,
      reason,
    });
    this.appendAuditEvent({
      actorId: request.actor.id,
      action: "task.approval_rejected",
      targetType: "task",
      targetId: task.id,
      proposalId: task.proposalId,
      note: `${status}: ${reason}`,
    });
    this.persistState();
    return canceled;
  }

  claimTask(taskId: string, workerId: string): TaskRecord {
    const task = this.requireTask(taskId);
    this.assertTaskWorker(task, workerId, "claim");
    if (task.policyContext?.requiresApproval === true && !task.approval) {
      throw new BrokerError("policy_denied", "task requires operator or hub approval before claim");
    }
    this.assertClaimTaskPolicy(task, workerId);
    assertTaskStatus(task.status, ["queued"], "claim");

    const now = isoNow();
    task.status = "claimed";
    task.attemptId = randomUUID();
    task.claimedBy = workerId;
    task.claimedAt = now;
    task.updatedAt = now;
    this.setTaskRecord(task);
    this.syncExchangeStateFromTask(task, "running");
    this.appendAuditEvent({
      actorId: workerId,
      action: "task.claimed",
      targetType: "task",
      targetId: task.id,
      proposalId: task.proposalId,
      note: task.intent,
    });
    this.persistState();
    this.taskEvents.emit(task, "claimed");
    return task;
  }

  startTask(taskId: string, workerId: string): TaskRecord {
    const task = this.requireTask(taskId);
    this.assertTaskWorker(task, workerId, "start");
    assertTaskStatus(task.status, ["claimed"], "start");

    task.status = "running";
    task.updatedAt = isoNow();
    this.setTaskRecord(task);
    this.syncExchangeStateFromTask(task, "running");
    this.appendAuditEvent({
      actorId: workerId,
      action: "task.started",
      targetType: "task",
      targetId: task.id,
      proposalId: task.proposalId,
      note: task.intent,
    });
    this.persistState();
    this.taskEvents.emit(task, "started");
    return task;
  }

  completeTask(taskId: string, workerId: string, result?: TaskResult): TaskRecord {
    const task = this.requireTask(taskId);
    this.assertTaskWorker(task, workerId, "complete");

    // If already canceled, record late completion evidence instead of silently dropping.
    if (task.status === "canceled") {
      return this.recordLateEvidenceAfterCancel(task, workerId, "complete", { result });
    }
    // Idempotent: if already succeeded/failed, return as-is without mutation
    if (task.status === "succeeded" || task.status === "failed") {
      return task;
    }
    if (task.status !== "claimed" && task.status !== "running") {
      throw new BrokerError("invalid_transition", "cannot complete task while status is " + task.status);
    }
    // Contract §1.3: a checkpointed task is a real lifecycle gate. The worker
    // must not land terminal mutations while paused/awaiting_operator —
    // resume (operator/requester input) or cancel first.
    if (task.checkpoint) {
      throw new BrokerError(
        "invalid_transition",
        `cannot complete task while a ${task.checkpoint.state} checkpoint is active; resume or cancel first`,
      );
    }

    const normalizedResult = normalizeTaskResult(result);
    const completionEvidenceError =
      validateReviewEvidence(task, normalizedResult, workerId) ?? validateGithubTaskCompletionEvidence(task, normalizedResult);
    if (completionEvidenceError) {
      const brokerErrorCode =
        completionEvidenceError.code === "review_evidence_missing" ||
        completionEvidenceError.code === "review_not_independent" ||
        completionEvidenceError.code === "review_verdict_failed" ||
        completionEvidenceError.code === "github_completion_receipt_invalid"
          ? completionEvidenceError.code
          : "github_completion_evidence_missing";
      throw new BrokerError(
        brokerErrorCode,
        completionEvidenceError.message,
        completionEvidenceError.details,
      );
    }
    this.applyTaskCompletion(task, workerId, normalizedResult);

    const now = isoNow();
    task.status = "succeeded";
    task.claimedBy = workerId;
    task.updatedAt = now;
    task.completedAt = now;
    task.result = normalizedResult;
    task.error = undefined;
    task.artifactIds = uniqueIds([
      ...(task.artifactIds ?? []),
      ...(normalizedResult.artifactIds ?? []),
      ...(normalizedResult.validation?.artifactIds ?? []),
      ...(normalizedResult.apply?.artifactIds ?? []),
    ]);
    this.setTaskRecord(task);
    this.syncExchangeStateFromTask(task, "completed");
    this.appendAuditEvent({
      actorId: workerId,
      action: "task.succeeded",
      targetType: "task",
      targetId: task.id,
      proposalId: task.proposalId,
      note: normalizedResult.note ?? normalizedResult.summary ?? task.intent,
    });
    this.persistState();
    this.taskEvents.emit(task, "succeeded");
    // Succeeded tasks don't get a tombstone — they completed normally.
    return task;
  }

  failTask(taskId: string, workerId: string, error?: TaskError): TaskRecord {
    const task = this.requireTask(taskId);
    this.assertTaskWorker(task, workerId, "fail");

    // If already canceled, record late failure evidence instead of silently dropping.
    if (task.status === "canceled") {
      return this.recordLateEvidenceAfterCancel(task, workerId, "fail", { error });
    }
    // Idempotent: if already succeeded/failed, return as-is without mutation
    if (task.status === "succeeded" || task.status === "failed") {
      return task;
    }
    if (task.status !== "claimed" && task.status !== "running") {
      throw new BrokerError("invalid_transition", "cannot fail task while status is " + task.status);
    }
    // Contract §1.3: terminal mutations are gated while a checkpoint is
    // active (see completeTask).
    if (task.checkpoint) {
      throw new BrokerError(
        "invalid_transition",
        `cannot fail task while a ${task.checkpoint.state} checkpoint is active; resume or cancel first`,
      );
    }

    const now = isoNow();
    const normalizedError = normalizeTaskError(error);
    task.status = "failed";
    task.claimedBy = workerId;
    task.updatedAt = now;
    task.completedAt = now;
    task.error = normalizedError;

    const retryPlan = planClassAwareTaskRetry(task, normalizedError, {
      maxRequeueAttempts: this.maxRequeueAttempts,
      nowMs: Date.parse(now),
      taskIdExists: (id) => this.tasks.has(id),
    });
    let retryTask: TaskRecord | undefined;
    if (retryPlan.shouldRetry && retryPlan.retryTaskId && retryPlan.nextAttempt !== undefined) {
      task.retriedBy = retryPlan.retryTaskId;
      const retryPayload = {
        ...task.payload,
        retryClass: retryPlan.retryClass,
        retryAttempt: retryPlan.nextAttempt,
        retryOfTaskId: task.retryOfTaskId ?? task.id,
        retriedFromTaskId: task.id,
        ...(retryPlan.retryNotBeforeAt ? { retryNotBeforeAt: retryPlan.retryNotBeforeAt } : {}),
      };
      retryTask = normalizeTaskRecord({
        ...task,
        id: retryPlan.retryTaskId,
        parentTaskId: task.parentTaskId ?? task.id,
        referenceTaskIds: uniqueIds([...(task.referenceTaskIds ?? []), task.id]),
        status: "queued",
        payload: retryPayload,
        retryOfTaskId: task.retryOfTaskId ?? task.id,
        attempt: retryPlan.nextAttempt,
        retriedBy: undefined,
        requeueCount: retryPlan.nextRequeueCount,
        claimedAt: undefined,
        claimedBy: undefined,
        completedAt: undefined,
        result: undefined,
        error: undefined,
        errorHistory: uniqueTaskErrorHistory(task.errorHistory, normalizedError),
        checkpoint: undefined,
        attemptId: undefined,
        createdAt: now,
        updatedAt: now,
      });
    }

    this.setTaskRecord(task);
    if (retryTask) {
      this.setTaskRecord(retryTask);
    }
    this.syncExchangeStateFromTask(task, "failed");
    this.appendAuditEvent({
      actorId: workerId,
      action: "task.failed",
      targetType: "task",
      targetId: task.id,
      proposalId: task.proposalId,
      note: normalizedError.message,
    });
    if (retryTask) {
      this.appendAuditEvent({
        actorId: "broker",
        action: "task.retry_scheduled",
        targetType: "task",
        targetId: task.id,
        proposalId: task.proposalId,
        note: `scheduled retry ${retryTask.id} attempt ${retryTask.attempt} class ${retryPlan.retryClass}`,
      });
    }
    // writeTombstone mutates state (tombstone + audit event) without persisting,
    // so it must run before persistState() — otherwise a crash between the two
    // loses the tombstone until the next unrelated persist.
    this.writeTombstone(task, "failed");
    this.persistState();
    this.taskEvents.emit(task, "failed");
    return task;
  }

  // Stale-task requeue engine (#1289 L-broker-10): the sweep moved to
  // broker-stale-task-requeue.ts with callback-injected state effects. These
  // delegators keep the public API and every call site unchanged.
  private staleTaskRequeueContext(): StaleTaskRequeueContext {
    return {
      tasks: this.tasks,
      workers: this.workers,
      maxRequeueAttempts: this.maxRequeueAttempts,
      checkpointTimeoutMs: this.checkpointTimeoutMs,
      setTaskRecord: (task) => this.setTaskRecord(task),
      syncExchangeStateFromTask: (task, nextStatus) => this.syncExchangeStateFromTask(task, nextStatus),
      appendAuditEvent: (input) => this.appendAuditEvent(input),
      writeTombstone: (task, reason) => this.writeTombstone(task, reason),
      persistState: () => this.persistState(),
      emitTaskEvent: (task, reason) => this.taskEvents.emit(task, reason),
      cancelTask: (taskId, request) => this.cancelTask(taskId, request),
    };
  }

  requeueStaleTasks(
    olderThanMs: number,
    options?: {
      nowMs?: number;
      workerOfflineAfterMs?: number;
    },
  ): TaskRecord[] {
    return staleTaskRequeue.requeueStaleTasks(olderThanMs, options, this.staleTaskRequeueContext());
  }

  /**
   * Same as {@link requeueStaleTasks} but also surfaces the tasks that were dead-lettered to
   * `failed` because they exceeded `maxRequeueAttempts`. Kept as a separate method so the
   * existing public `requeueStaleTasks` signature stays backwards-compatible for the manual
   * `POST /tasks/requeue_stale` response and the in-process stale reaper.
   */
  requeueStaleTasksDetailed(
    olderThanMs: number,
    options?: {
      nowMs?: number;
      workerOfflineAfterMs?: number;
    },
  ): { requeued: TaskRecord[]; deadLettered: TaskRecord[] } {
    return staleTaskRequeue.requeueStaleTasksDetailed(olderThanMs, options, this.staleTaskRequeueContext());
  }

  private listStaleWorkerIds(offlineAfterMs: number, nowMs: number): string[] {
    return staleTaskRequeue.listStaleWorkerIds(offlineAfterMs, nowMs, { workers: this.workers });
  }

  getArtifact(id: string): ArtifactRecord | null {
    return readBrokerArtifact(this.artifacts, this.artifactRepository, id);
  }

  listArtifactsForProposal(proposalId: string): ArtifactRecord[] {
    return listBrokerArtifactsForProposal(this.artifacts, this.artifactRepository, proposalId);
  }

  listValidationsForProposal(proposalId: string): ValidationResult[] {
    return listBrokerValidationsForProposal(this.validations, this.validationRepository, proposalId);
  }

  listAuditEvents(filters?: AuditListFilters): AuditEvent[] {
    return listBrokerAuditEvents(this.auditEvents, this.auditRepository, filters);
  }


  getWorkerCapacitySummary(options?: {
    nowMs?: number;
    workerOfflineAfterMs?: number;
    taskStaleAfterMs?: number;
  }): WorkerCapacitySummary {
    return buildWorkerCapacitySummary(
      {
        workers: this.listWorkers(),
        tasks: this.listTasks(),
        identityWarnings: this.workerChurn.getWarnings(),
      },
      options,
    );
  }

  getDashboard(options?: {
    nowMs?: number;
    offlineAfterMs?: number;
    recentHistoryLimit?: number;
    oldestPendingLimit?: number;
    pendingActionLimit?: number;
  }): BrokerDashboard {
    const nowMs = options?.nowMs ?? Date.now();
    const offlineAfterMs = options?.offlineAfterMs ?? 90_000;
    return buildBrokerDashboard(
      {
        tasks: [...this.tasks.values()],
        proposals: [...this.proposals.values()],
        workers: [...this.workers.values()],
        staleWorkerIds: new Set(this.listStaleWorkerIds(offlineAfterMs, nowMs)),
        requeuedAuditEvents: this.listAuditEvents({ action: "task.requeued" }),
      },
      { ...options, nowMs, offlineAfterMs },
    );
  }


  exportSnapshot(): BrokerSnapshot {
    return {
      version: CURRENT_BROKER_STATE_VERSION,
      exchanges: [...this.exchanges.values()],
      exchangeMessages: [...this.exchangeMessages.values()],
      proposals: [...this.proposals.values()],
      artifacts: [...this.artifacts.values()],
      validations: [...this.validations.values()],
      auditEvents: [...this.auditEvents.values()],
      workers: [...this.workers.values()],
      tasks: [...this.tasks.values()],
      tombstones: [...this.tombstones.values()],
      terminalOutbox: this.terminalTaskEventOutbox.snapshot(),
      crossBrokerTerminalBriefs: this.crossBrokerTerminalBriefs.snapshot(),
      ...this.snapshotExtensions.collectFields(),
    };
  }

  private applyRetentionPolicy(nowMs = Date.now()): void {
    const retained = computeRetainedRecordIds(
      {
        exchanges: this.exchanges,
        exchangeMessages: this.exchangeMessages,
        tasks: this.tasks,
        proposals: this.proposals,
        artifacts: this.artifacts,
        validations: this.validations,
        workers: this.workers,
        auditEvents: this.auditEvents,
      },
      this.retentionPolicy,
      nowMs,
    );

    const prunedTaskIds = [...this.tasks.keys()].filter((taskId) => !retained.taskIds.has(taskId));

    pruneMapEntries(this.exchanges, retained.exchangeIds);
    pruneMapEntries(this.exchangeMessages, retained.messageIds);
    pruneMapEntries(this.tasks, retained.taskIds);
    pruneMapEntries(this.proposals, retained.proposalIds);
    pruneMapEntries(this.artifacts, retained.artifactIds);
    pruneMapEntries(this.validations, retained.validationIds);
    pruneMapEntries(this.workers, retained.workerIds);
    pruneMapEntries(this.auditEvents, retained.auditEventIds);
    this.workerHeartbeatPersist.prune(retained.workerIds);
    this.taskHeartbeatAuditPersist.prune(retained.taskIds);
    this.taskEvents.prune(retained.taskIds, prunedTaskIds);
  }

  private loadSnapshot(snapshot: BrokerSnapshot): void {
    for (const exchange of snapshot.exchanges) {
      const normalizedExchange = normalizeExchangeState(exchange);
      this.exchanges.set(normalizedExchange.id, normalizedExchange);
    }

    for (const message of snapshot.exchangeMessages ?? []) {
      this.exchangeMessages.set(message.id, normalizeExchangeMessageRecord(message));
    }

    for (const exchange of this.exchanges.values()) {
      if (exchange.rootMessageId) {
        continue;
      }

      const syntheticRoot = createLegacyRootExchangeMessage(exchange);
      this.exchangeMessages.set(syntheticRoot.id, syntheticRoot);
      exchange.rootMessageId = syntheticRoot.id;
      exchange.messageCount = Math.max(exchange.messageCount ?? 0, 1);
      exchange.lastMessageAt = exchange.lastMessageAt ?? exchange.updatedAt;
      this.exchanges.set(exchange.id, exchange);
    }

    for (const proposal of snapshot.proposals) {
      this.proposals.set(proposal.id, proposal);
    }

    for (const artifact of snapshot.artifacts) {
      this.artifacts.set(artifact.id, artifact);
    }

    for (const validation of snapshot.validations) {
      this.validations.set(validation.id, validation);
    }

    for (const auditEvent of snapshot.auditEvents) {
      this.auditEvents.set(auditEvent.id, auditEvent);
    }

    for (const worker of snapshot.workers ?? []) {
      const normalizedWorker = normalizeWorkerRecord(worker);
      this.workers.set(normalizedWorker.nodeId, normalizedWorker);
      const lastSeenAtMs = Date.parse(normalizedWorker.lastSeenAt);
      if (Number.isFinite(lastSeenAtMs)) {
        this.workerHeartbeatPersist.markPersisted(normalizedWorker.nodeId, lastSeenAtMs);
      }
    }

    for (const task of snapshot.tasks ?? []) {
      this.tasks.set(task.id, normalizeTaskRecord(task));
    }

    for (const tombstone of snapshot.tombstones ?? []) {
      this.tombstones.set(tombstone.taskId, tombstone);
    }

    this.terminalTaskEventOutbox.restoreSnapshot(snapshot.terminalOutbox ?? []);
    this.crossBrokerTerminalBriefs.restore(snapshot.crossBrokerTerminalBriefs ?? []);

    this.applyRetentionPolicy();
  }

  private persistState(change: BrokerStateChange = { kind: "state.persisted" }): void {
    const startedAtMs = Date.now();
    const startedAt = new Date(startedAtMs).toISOString();
    const hotSave = this.stateStore?.saveHotEntities;
    if (
      hotSave &&
      this.pendingHot.hasPending() &&
      startedAtMs - this.lastFullRetentionPersistAtMs < HOT_PERSIST_FULL_RETENTION_INTERVAL_MS
    ) {
      const hints = this.pendingHot.consumeAll();
      if (hints) {
        hotSave.call(this.stateStore, hints);
        this.listeners.emitStateChange(change);
        this.listeners.emitProfilingSample({
          operation: "persistState",
          startedAt,
          durationMs: Date.now() - startedAtMs,
          persistenceMode: "hot",
          retentionApplied: false,
          snapshotExported: false,
          saveHints: countStateSaveHints(hints),
        });
        return;
      }
    }

    this.applyRetentionPolicy();
    this.lastFullRetentionPersistAtMs = startedAtMs;
    const snapshot = this.exportSnapshot();
    const hints = this.pendingHot.consumeRetained(snapshot);
    this.stateStore?.save(snapshot, hints);
    this.listeners.emitStateChange(change);
    this.listeners.emitProfilingSample({
      operation: "persistState",
      startedAt,
      durationMs: Date.now() - startedAtMs,
      persistenceMode: "full",
      retentionApplied: true,
      snapshotExported: true,
      saveHints: hints ? countStateSaveHints(hints) : undefined,
    });
  }

  private setTaskRecord(task: TaskRecord): void {
    this.taskRepository?.upsertTask(structuredClone(task));
    this.tasks.set(task.id, task);
    this.pendingHot.stageTask(task);
  }

  private setExchangeRecord(exchange: A2AExchangeState): void {
    const normalizedExchange = normalizeExchangeState(exchange);
    this.exchangeRepository?.upsertExchange(structuredClone(normalizedExchange));
    this.exchanges.set(normalizedExchange.id, normalizedExchange);
    this.pendingHot.stageExchange(normalizedExchange);
  }

  private setExchangeMessageRecord(message: A2AExchangeMessageRecord): void {
    const normalizedMessage = normalizeExchangeMessageRecord(message);
    this.exchangeMessageRepository?.upsertExchangeMessage(structuredClone(normalizedMessage));
    this.exchangeMessages.set(normalizedMessage.id, normalizedMessage);
    this.pendingHot.stageExchangeMessage(normalizedMessage);
  }

  private setProposalRecord(proposal: ChangeProposal): void {
    this.proposalRepository?.upsertProposal(structuredClone(proposal));
    this.proposals.set(proposal.id, proposal);
    this.pendingHot.stageProposal(proposal);
  }

  private setArtifactRecord(artifact: ArtifactRecord): void {
    this.artifactRepository?.upsertArtifact(structuredClone(artifact));
    this.artifacts.set(artifact.id, artifact);
    this.pendingHot.stageArtifact(artifact);
  }

  private setValidationRecord(validation: ValidationResult): void {
    this.validationRepository?.upsertValidation(structuredClone(validation));
    this.validations.set(validation.id, validation);
    this.pendingHot.stageValidation(validation);
  }

  private setWorkerRecord(worker: WorkerRecord): void {
    const normalizedWorker = normalizeWorkerRecord(worker);
    this.workerRepository?.upsertWorker(structuredClone(normalizedWorker));
    this.workers.set(normalizedWorker.nodeId, normalizedWorker);
    this.pendingHot.stageWorker(normalizedWorker);
  }

  private setWorkerRecordInMemory(worker: WorkerRecord): void {
    const normalizedWorker = normalizeWorkerRecord(worker);
    this.workers.set(normalizedWorker.nodeId, normalizedWorker);
  }

  private persistTerminalTaskOutboxEvent(event: TerminalTaskOutboxEvent): void {
    this.pendingHot.stageTerminalOutboxEvent(event);
    this.persistState();
  }

  private appendAuditEvent(input: {
    actorId: string;
    action: AuditAction;
    targetType: AuditEvent["targetType"];
    targetId: string;
    proposalId?: string;
    note?: string;
  }): AuditEvent {
    const eventId = getHeartbeatAuditEventId(input) ?? randomUUID();
    const event: AuditEvent = {
      id: eventId,
      actorId: input.actorId,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId,
      proposalId: input.proposalId,
      note: input.note,
      createdAt: isoNow(),
    };

    this.auditEvents.set(event.id, event);
    this.auditRepository?.appendAuditEvent(structuredClone(event));
    this.pendingHot.stageAuditEvent(event);
    if (event.targetType === "task") {
      const task = this.tasks.get(event.targetId);
      if (task) {
        const taskEvent = this.taskEventStream.push(event, task);
        if (taskEvent) {
          const terminalEvent = this.terminalTaskEventOutbox.enqueue(taskEvent, task);
          if (terminalEvent) {
            this.pendingHot.stageTerminalOutboxEvent(terminalEvent);
          }
        }
      }
    }
    return event;
  }

  private requireProposal(id: string): ChangeProposal {
    const proposal = this.getProposal(id);
    if (!proposal) {
      throw new BrokerError("not_found", "proposal not found");
    }
    return proposal;
  }

  private requireExchange(id: string): A2AExchangeState {
    const exchange = readExchange(this.exchanges, this.exchangeRepository, id);
    if (!exchange) {
      throw new BrokerError("not_found", "exchange not found");
    }
    return exchange;
  }

  private requireWorker(nodeId: string): WorkerRecord {
    const worker = this.getWorker(nodeId);
    if (!worker) {
      throw new BrokerError("not_found", "worker not found");
    }
    return worker;
  }

  private requireWorkerCachedFirst(nodeId: string): WorkerRecord {
    const worker = this.getWorkerCachedFirst(nodeId);
    if (!worker) {
      throw new BrokerError("not_found", "worker not found");
    }
    return worker;
  }

  private requireTask(id: string): TaskRecord {
    const task = this.getTask(id);
    if (!task) {
      throw new BrokerError("not_found", "task not found");
    }
    return task;
  }

  private requireExchangeMessage(exchangeId: string, messageId: string): A2AExchangeMessageRecord {
    const repositoryMessage = this.exchangeMessageRepository?.getExchangeMessage(messageId);
    if (repositoryMessage) {
      const message = normalizeExchangeMessageRecord(repositoryMessage);
      this.exchangeMessages.set(message.id, message);
      if (message.exchangeId === exchangeId) {
        return message;
      }
    }
    const message = this.exchangeMessages.get(messageId);
    if (!message || message.exchangeId !== exchangeId) {
      throw new BrokerError("not_found", "exchange message not found");
    }
    return message;
  }

  private applyExchangeMessageDecision(
    exchange: A2AExchangeState,
    message: A2AExchangeMessageRecord,
    hasExplicitAssignment: boolean,
  ): void {
    applyBrokerExchangeMessageDecision(exchange, message, hasExplicitAssignment, {
      workers: this.workers,
      tasks: this.tasks,
      requireWorker: (nodeId) => this.requireWorker(nodeId),
      reassignTask: (taskId, request) => this.reassignTask(taskId, request),
      createTask: (request) => this.createTask(request),
      cancelActiveExchangeTask: (exchangeToCancel, reason) => this.cancelActiveExchangeTask(exchangeToCancel, reason),
    });
  }

  private cancelActiveExchangeTask(exchange: A2AExchangeState, reason: string): void {
    if (!exchange.activeTaskId) {
      return;
    }
    const task = this.tasks.get(exchange.activeTaskId);
    if (!task) {
      return;
    }
    if (task.status === "succeeded" || task.status === "failed" || task.status === "canceled") {
      return;
    }
    this.cancelTaskRecord(task, {
      actorId: "broker",
      reason,
    });
  }

  private cancelTaskRecord(
    task: TaskRecord,
    params: {
      actorId: string;
      reason?: string;
      sourceTaskId?: string;
      kind?: "superseded";
      supersededByTaskId?: string;
      supersededByPrUrl?: string;
      roundId?: string;
    },
  ): TaskRecord {
    const canceledAt = isoNow();
    // Cancellation is one of the two contract-sanctioned exits from a
    // checkpoint (resume | cancel): clear the gate so terminal tasks never
    // carry stale checkpoint metadata.
    task.checkpoint = undefined;
    task.status = "canceled";
    task.claimedBy = undefined;
    task.claimedAt = undefined;
    task.completedAt = canceledAt;
    task.updatedAt = canceledAt;
    task.result = undefined;
    task.error = undefined;
    task.cancellation = {
      requestedAt: canceledAt,
      requestedBy: params.actorId,
      kind: params.kind ?? "operator_cancel",
      reason: params.reason,
      sourceTaskId: params.sourceTaskId,
      supersededByTaskId: params.supersededByTaskId,
      supersededByPrUrl: params.supersededByPrUrl,
      roundId: params.roundId,
    };
    this.setTaskRecord(task);
    this.syncExchangeStateFromTask(task, "queued");
    this.appendAuditEvent({
      actorId: params.actorId,
      action: "task.canceled",
      targetType: "task",
      targetId: task.id,
      proposalId: task.proposalId,
      note: params.reason,
    });
    // Tombstone before persist so a crash between the two cannot lose it
    // (writeTombstone mutates state but does not persist on its own).
    this.writeTombstone(task, "canceled", { actorId: params.actorId, reason: params.reason });
    this.persistState();
    this.taskEvents.emit(task, "canceled");
    return task;
  }

  private cancelTaskTree(
    task: TaskRecord,
    params: {
      actorId: string;
      reason?: string;
      sourceTaskId?: string;
      kind?: "superseded";
      supersededByTaskId?: string;
      supersededByPrUrl?: string;
      roundId?: string;
    },
    visited = new Set<string>(),
  ): TaskRecord {
    if (visited.has(task.id)) {
      return task;
    }
    visited.add(task.id);

    const canceledTask = this.cancelTaskRecord(task, params);
    for (const childTask of this.listChildTasks(task.id)) {
      if (isTerminalTaskStatus(childTask.status)) {
        continue;
      }
      this.cancelTaskTree(
        childTask,
        {
          actorId: params.actorId,
          reason: params.reason,
          sourceTaskId: task.id,
          kind: params.kind,
          supersededByTaskId: params.supersededByTaskId,
          supersededByPrUrl: params.supersededByPrUrl,
          roundId: params.roundId,
        },
        visited,
      );
    }

    return canceledTask;
  }

  private listChildTasks(parentTaskId: string): TaskRecord[] {
    return sortedCopy(
      [...this.tasks.values()].filter((task) => task.parentTaskId === parentTaskId),
      sortNewestFirst,
    );
  }

  // --- Task Heartbeat ---

  /** Record a task-level heartbeat from the assigned worker. */
  /**
   * Record a checkpoint (contracts/a2a/checkpoint-interrupt.md). The task
   * stays non-terminal; `awaiting_operator` marks a human-interrupt pause
   * that projects as the A2A `input-required` state until cleared.
   */
  checkpointTask(
    taskId: string,
    workerId: string,
    request: {
      state: TaskCheckpointState;
      checkpointId?: string;
      reason?: string;
      decisionType?: string;
      artifactRefs?: string[];
    },
  ): TaskRecord {
    const task = this.requireTask(taskId);
    this.assertTaskWorker(task, workerId, "checkpoint");
    assertTaskStatus(task.status, ["claimed", "running"], "checkpoint");
    if (request.state !== "paused" && request.state !== "awaiting_operator") {
      throw new BrokerError("bad_request", "checkpoint state must be paused or awaiting_operator");
    }

    // Checkpoint inputs become operator-visible and audit-visible state, so
    // they are bounded and shape-checked before being recorded (contract
    // §2.4: redacted, no raw internal state).
    const checkpointId = request.checkpointId?.trim() || randomUUID();
    if (checkpointId.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(checkpointId)) {
      throw new BrokerError("bad_request", "checkpointId must be <=128 chars of [A-Za-z0-9._:-]");
    }
    const reason = request.reason?.trim() || undefined;
    if (reason !== undefined && (reason.length > 500 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(reason))) {
      throw new BrokerError("bad_request", "checkpoint reason must be <=500 chars with no control characters");
    }
    let decisionType: TaskInterruptDecisionType | undefined;
    if (request.state === "awaiting_operator") {
      // Contract §2.2: human interrupts carry one of the four frozen
      // decision types; approval_required is the default interrupt shape.
      const requested = request.decisionType?.trim() || "approval_required";
      if (!TASK_INTERRUPT_DECISION_TYPES.includes(requested as TaskInterruptDecisionType)) {
        throw new BrokerError(
          "bad_request",
          `decisionType must be one of ${TASK_INTERRUPT_DECISION_TYPES.join(", ")}`,
        );
      }
      decisionType = requested as TaskInterruptDecisionType;
    } else if (request.decisionType?.trim()) {
      throw new BrokerError("bad_request", "decisionType only applies to awaiting_operator checkpoints");
    }
    let artifactRefs: string[] | undefined;
    if (request.artifactRefs !== undefined) {
      if (!Array.isArray(request.artifactRefs) || request.artifactRefs.length > 32) {
        throw new BrokerError("bad_request", "artifactRefs must be an array of at most 32 references");
      }
      artifactRefs = request.artifactRefs.map((ref) => {
        const trimmed = typeof ref === "string" ? ref.trim() : "";
        if (!trimmed || trimmed.length > 256 || /[\u0000-\u001f]/.test(trimmed)) {
          throw new BrokerError("bad_request", "each artifactRef must be a 1-256 char string with no control characters");
        }
        return trimmed;
      });
    }

    const now = isoNow();
    task.checkpoint = {
      state: request.state,
      checkpointId,
      reason,
      ...(decisionType ? { decisionType } : {}),
      ...(artifactRefs && artifactRefs.length > 0 ? { artifactRefs } : {}),
      recordedAt: now,
      recordedBy: workerId,
    };
    task.updatedAt = now;
    this.setTaskRecord(task);
    this.appendAuditEvent({
      actorId: workerId,
      action: "task.checkpointed",
      targetType: "task",
      targetId: task.id,
      proposalId: task.proposalId,
      note: `checkpoint ${task.checkpoint.state}${decisionType ? ` (${decisionType})` : ""}: ${task.checkpoint.reason ?? task.checkpoint.checkpointId}`,
    });
    this.persistState();
    this.taskEvents.emit(task, "checkpointed");
    return task;
  }

  /** Clear an active checkpoint (operator approval, requester input, or worker resume). */
  resumeTask(taskId: string, actorId: string, request: { checkpointId?: string } = {}): TaskRecord {
    const task = this.requireTask(taskId);
    if (!task.checkpoint) {
      return task; // idempotent: nothing to resume
    }
    if (isTerminalTaskStatus(task.status)) {
      throw new BrokerError("invalid_transition", `cannot resume task while status is ${task.status}`);
    }
    if (request.checkpointId && request.checkpointId !== task.checkpoint.checkpointId) {
      throw new BrokerError("bad_request", "checkpointId does not match the active checkpoint");
    }

    const cleared = task.checkpoint;
    task.checkpoint = undefined;
    task.updatedAt = isoNow();
    this.setTaskRecord(task);
    this.appendAuditEvent({
      actorId,
      action: "task.resumed",
      targetType: "task",
      targetId: task.id,
      proposalId: task.proposalId,
      note: `resumed from ${cleared.state} checkpoint ${cleared.checkpointId}`,
    });
    this.persistState();
    this.taskEvents.emit(task, "resumed");
    return task;
  }

  heartbeatTask(taskId: string, workerId: string): TaskRecord {
    const task = this.requireTask(taskId);
    this.assertTaskWorker(task, workerId, "heartbeat");
    assertTaskStatus(task.status, ["claimed", "running"], "heartbeat");

    const now = isoNow();
    const nowMs = Date.parse(now);
    task.lastHeartbeatAt = now;
    task.updatedAt = now;
    this.setTaskRecord(task);
    const shouldPersistHeartbeatAudit = this.taskHeartbeatAuditPersist.shouldPersist(
      task.id,
      nowMs,
      this.retentionPolicy.heartbeatAuditSampleIntervalMs,
    );
    if (shouldPersistHeartbeatAudit) {
      this.appendAuditEvent({
        actorId: workerId,
        action: "task.heartbeat",
        targetType: "task",
        targetId: task.id,
        proposalId: task.proposalId,
        note: "task heartbeat",
      });
      this.taskHeartbeatAuditPersist.markPersisted(task.id, nowMs);
    }
    this.persistState();
    this.taskEvents.emit(task, "started"); // re-emit so subscribers see the heartbeat
    return task;
  }

  // --- Diagnostics ---

  /** Compute the diagnostic status for a single task. */
  getTaskDiagnostics(
    taskId: string,
    options?: TaskDiagnosticsOptions,
  ): TaskDiagnosticReport {
    const task = this.requireTask(taskId);
    return this.getTaskDiagnosticsForRecord(task, options, {
      tombstone: this.getTombstone(taskId),
    });
  }

  /** Compute diagnostics for a task snapshot supplied by a read model/store. */
  getTaskDiagnosticsForRecord(
    task: TaskRecord,
    options?: TaskDiagnosticsOptions,
    overrides?: {
      tombstone?: TaskTombstone | null;
      assignedWorker?: WorkerRecord | null;
      lastRequeueEvent?: AuditEvent | null;
    },
  ): TaskDiagnosticReport {
    // Resolve the three broker-coupled inputs (from caller overrides or our own
    // lookups), then delegate the pure assembly to buildTaskDiagnosticReport.
    const tombstone = overrides && "tombstone" in overrides
      ? overrides.tombstone ?? undefined
      : this.getTombstone(task.id) ?? undefined;
    const assignedWorker = overrides && "assignedWorker" in overrides
      ? overrides.assignedWorker ?? undefined
      : task.assignedWorkerId
        ? this.workers.get(task.assignedWorkerId)
        : undefined;
    const lastRequeueEvent = overrides && "lastRequeueEvent" in overrides
      ? overrides.lastRequeueEvent ?? undefined
      : findLatestTaskAuditEvent(this.listAuditEvents({ targetId: task.id, action: "task.requeued" }), task.id, "task.requeued");

    return buildTaskDiagnosticReport(task, { tombstone, assignedWorker, lastRequeueEvent }, options);
  }

  /** List tasks that are stale (claimed/running with no recent heartbeat). */
  listStaleTasks(options?: {
    staleAfterMs?: number;
    nowMs?: number;
  }): TaskRecord[] {
    const staleAfterMs = options?.staleAfterMs ?? 120_000;
    const nowMs = options?.nowMs ?? Date.now();
    const threshold = nowMs - staleAfterMs;

    return [...this.tasks.values()].filter((task) => {
      if (task.status !== "claimed" && task.status !== "running") {
        return false;
      }
      const lastSignal = task.lastHeartbeatAt
        ? Date.parse(task.lastHeartbeatAt)
        : task.claimedAt
          ? Date.parse(task.claimedAt)
          : Date.parse(task.createdAt);
      return lastSignal < threshold;
    });
  }

  /** List tasks that have been running longer than a threshold. */
  listLongRunningTasks(options?: {
    longRunningAfterMs?: number;
    nowMs?: number;
  }): TaskRecord[] {
    const longRunningAfterMs = options?.longRunningAfterMs ?? 3_600_000;
    const nowMs = options?.nowMs ?? Date.now();
    const threshold = nowMs - longRunningAfterMs;

    return [...this.tasks.values()].filter((task) => {
      if (task.status !== "running") {
        return false;
      }
      const startTime = task.claimedAt
        ? Date.parse(task.claimedAt)
        : Date.parse(task.createdAt);
      return startTime < threshold;
    });
  }

  // --- Cleanup Candidate Discovery (issue #520) ---

  /**
   * Read-only discovery of cleanup candidates across worker, task, outbox,
   * and tombstone categories. Never mutates broker state; execution of any
   * cleanup action requires a separate operator approval gate.
   *
   * Candidate classes:
   * - `stale_worker`: workers with no recent heartbeat (online but last seen
   *   beyond the stale threshold).
   * - `malformed_task`: queued tasks missing required target/requester fields.
   * - `queued_residue`: well-formed queued tasks that have been stale without
   *   being claimed — valid payloads that remain unclaimed and may indicate
   *   capacity or routing issues.
   * - `orphaned_claim`: claimed or running tasks whose claiming worker is
   *   stale — common residue after a fleet update where old workers are
   *   replaced and their in-flight tasks lose their executor.
   * - `terminal_outbox_backlog`: unacknowledged terminal outbox events older
   *   than the backlog threshold.
   * - `historical_terminal_task`: terminal (succeeded/failed/canceled) tasks
   *   with tombstones older than the historical threshold.
   */
  discoverCleanupCandidates(options?: {
    staleWorkerAfterMs?: number;
    staleTaskAfterMs?: number;
    terminalOutboxBacklogAfterMs?: number;
    historicalTerminalAfterMs?: number;
    nowMs?: number;
  }): CleanupDryRunPlan {
    return buildCleanupDryRunPlan(
      {
        workers: this.workers,
        tasks: this.tasks,
        tombstones: this.tombstones,
        outboxEvents: this.terminalTaskEventOutbox.snapshot(),
      },
      options,
    );
  }

  // --- Tombstones ---

  /** Get a tombstone by task ID. */
  getTombstone(taskId: string): TaskTombstone | null {
    const repositoryTombstone = this.tombstoneRepository?.getTombstone(taskId);
    if (repositoryTombstone) {
      this.tombstones.set(repositoryTombstone.taskId, repositoryTombstone);
      return repositoryTombstone;
    }
    return this.tombstones.get(taskId) ?? null;
  }

  /** List tombstones with optional filters. */
  listTombstones(filters?: TombstoneListFilters): TaskTombstone[] {
    const tombstonesByTaskId = new Map(this.tombstones);
    if (this.tombstoneRepository) {
      const tombstones = this.tombstoneRepository.listTombstones(filters);
      for (const tombstone of tombstones) {
        this.tombstones.set(tombstone.taskId, tombstone);
        tombstonesByTaskId.set(tombstone.taskId, tombstone);
      }
    }
    const items = [...tombstonesByTaskId.values()].filter((ts) => {
      if (filters?.taskId && ts.taskId !== filters.taskId) return false;
      if (filters?.tombstoneReason && ts.tombstoneReason !== filters.tombstoneReason) return false;
      if (filters?.terminalStatus && ts.terminalStatus !== filters.terminalStatus) return false;
      if (filters?.since && ts.tombstonedAt < filters.since) return false;
      return true;
    });
    items.sort((a, b) => b.tombstonedAt.localeCompare(a.tombstonedAt));
    return items;
  }

  /** Write a tombstone for a terminal task. Called internally on terminal transitions. */
  private writeTombstone(
    task: TaskRecord,
    reason: TombstoneReason,
    context?: { actorId?: string; reason?: string },
  ): void {
    const now = isoNow();
    const createdAtMs = Date.parse(task.createdAt);
    const completedAtMs = task.completedAt ? Date.parse(task.completedAt) : Date.now();

    const tombstone: TaskTombstone = {
      taskId: task.id,
      terminalStatus: task.status as TaskStatus,
      tombstoneReason: reason,
      durationMs: completedAtMs - createdAtMs,
      requeueCount: task.requeueCount ?? 0,
      error: task.error ? structuredClone(task.error) : undefined,
      result: task.result ? structuredClone(task.result) : undefined,
      tombstonedAt: now,
      metadata: context ? { actorId: context.actorId, cancelReason: context.reason } : undefined,
    };
    if (task.cancellation?.kind === "superseded") {
      tombstone.metadata = {
        ...(tombstone.metadata ?? {}),
        cancellationKind: "superseded",
        supersededByTaskId: task.cancellation.supersededByTaskId,
        supersededByPrUrl: task.cancellation.supersededByPrUrl,
        roundId: task.cancellation.roundId,
      };
    }

    this.tombstones.set(task.id, tombstone);
    this.tombstoneRepository?.upsertTombstone(structuredClone(tombstone));
    this.pendingHot.stageTombstone(task.id, tombstone);
    this.appendAuditEvent({
      actorId: context?.actorId ?? "broker",
      action: "task.tombstoned",
      targetType: "task",
      targetId: task.id,
      proposalId: task.proposalId,
      note: `tombstoned: ${reason}`,
    });
  }

  private linkTaskToExchange(task: TaskRecord): void {
    if (!task.exchangeId) {
      return;
    }
    const exchange = this.getExchange(task.exchangeId);
    if (!exchange) {
      return;
    }
    exchange.activeTaskId = task.id;
    exchange.targetNodeId = task.targetNodeId;
    exchange.assignedWorkerId = task.assignedWorkerId ?? task.targetNodeId;
    exchange.target = task.target;
    exchange.updatedAt = isoNow();
    this.setExchangeRecord(exchange);
  }

  private syncExchangeStateFromTask(
    task: TaskRecord,
    nextStatus: A2AExchangeState["status"],
  ): void {
    if (!task.exchangeId) {
      return;
    }
    const exchange = this.getExchange(task.exchangeId);
    if (!exchange) {
      return;
    }
    exchange.activeTaskId = task.id;
    exchange.targetNodeId = task.targetNodeId;
    exchange.assignedWorkerId = task.assignedWorkerId ?? task.targetNodeId;
    exchange.target = task.target;
    exchange.status = nextStatus;
    exchange.updatedAt = isoNow();
    this.setExchangeRecord(exchange);
  }

  // Task admission gates (#1289 L-broker-9): the create/claim-time checks
  // moved to broker-task-admission.ts with callback-injected state effects.
  // These thin delegators keep every call site unchanged.
  private taskAdmissionContext(): TaskAdmissionContext {
    return {
      brokerId: this.brokerId,
      teamId: this.teamId,
      taskReadinessMode: this.taskReadinessMode,
      policyDocument: this.policyDocument,
      tasks: this.tasks,
      getWorker: (nodeId) => this.getWorker(nodeId),
      getWorkerView: (nodeId, offlineAfterMs) => this.getWorkerView(nodeId, offlineAfterMs),
      requireWorker: (nodeId) => this.requireWorker(nodeId),
      requireProposal: (id) => this.requireProposal(id),
      appendAuditEvent: (input) => this.appendAuditEvent(input),
      persistState: () => this.persistState(),
    };
  }

  private assertTaskPayload(request: CreateTaskRequest): void {
    taskAdmission.assertTaskPayload(request, this.taskAdmissionContext());
  }

  private assertTaskReadiness(request: CreateTaskRequest): void {
    taskAdmission.assertTaskReadiness(request, this.taskAdmissionContext());
  }

  private evaluateCreateTaskPolicy(request: CreateTaskRequest) {
    return taskAdmission.evaluateCreateTaskPolicy(request, this.taskAdmissionContext());
  }

  private assertClaimTaskPolicy(task: TaskRecord, workerId: string): void {
    taskAdmission.assertClaimTaskPolicy(task, workerId, this.taskAdmissionContext());
  }

  private assertA2ARoundWorkerAvailability(request: CreateTaskRequest): void {
    taskAdmission.assertA2ARoundWorkerAvailability(request, this.taskAdmissionContext());
  }

  private assertTaskProposalLink(request: CreateTaskRequest): void {
    taskAdmission.assertTaskProposalLink(request, this.taskAdmissionContext());
  }

  private assertTaskWorker(task: TaskRecord, workerId: string, action: string): void {
    taskAdmission.assertTaskWorker(task, workerId, action, this.taskAdmissionContext());
  }

  /**
   * Record evidence that a worker posted after the task was already canceled.
   * The task stays canceled; late evidence is preserved for diagnostics.
   */
  private recordLateEvidenceAfterCancel(
    task: TaskRecord,
    workerId: string,
    kind: "complete" | "fail",
    data: { result?: TaskResult; error?: TaskError },
  ): TaskRecord {
    // Idempotent: if late evidence already recorded, return without mutation
    if (task.lateEvidenceAfterCancel) {
      return task;
    }
    const now = isoNow();
    task.lateEvidenceAfterCancel = {
      kind,
      result: data.result ? structuredClone(data.result) : undefined,
      error: data.error ? structuredClone(data.error) : undefined,
      submittedAt: now,
      submittedBy: workerId,
    };
    task.updatedAt = now;
    this.setTaskRecord(task);
    this.appendAuditEvent({
      actorId: workerId,
      action: "task.updated",
      targetType: "task",
      targetId: task.id,
      proposalId: task.proposalId,
      note: `late ${kind} evidence after cancel (issue #954)`,
    });
    this.writeTombstone(task, "canceled_with_late_completion", {
      actorId: workerId,
      reason: `worker posted ${kind} evidence after cancel`,
    });
    this.persistState();
    return task;
  }

  private applyTaskCompletion(task: TaskRecord, workerId: string, result: TaskResult): void {
    if (!task.proposalId) {
      return;
    }

    if (task.intent === "validate_change") {
      if (!result.validation) {
        throw new BrokerError(
          "bad_request",
          "validate_change completion requires result.validation",
        );
      }
      this.submitValidationResult(task.proposalId, {
        nodeId: result.validation.nodeId ?? workerId,
        kind: result.validation.kind,
        verdict: result.validation.verdict,
        metrics: result.validation.metrics,
        artifactIds: uniqueIds([
          ...(result.artifactIds ?? []),
          ...(result.validation.artifactIds ?? []),
        ]),
        note: result.validation.note ?? result.note ?? result.summary,
      });
      return;
    }

    if (task.intent === "apply_local_change") {
      const workspace = result.apply?.workspace ?? task.workspace;
      if (!workspace) {
        throw new BrokerError(
          "bad_request",
          "apply_local_change completion requires a workspace",
        );
      }
      const proposal = this.applyProposalLocally(task.proposalId, {
        actor: {
          id: workerId,
          role: task.target.role,
          kind: task.target.kind,
        },
        workspace,
        note: result.apply?.note ?? result.note ?? result.summary,
      });
      const artifactIds = uniqueIds([
        ...(result.artifactIds ?? []),
        ...(result.apply?.artifactIds ?? []),
      ]);
      if (artifactIds.length > 0) {
        proposal.artifactIds = uniqueIds([...proposal.artifactIds, ...artifactIds]);
        proposal.updatedAt = isoNow();
        this.setProposalRecord(proposal);
      }
    }
  }
}


