import { readFileSync } from "node:fs";
import { createPublicKey } from "node:crypto";
import { readPersistenceQueueDiagnostics } from "./persistence-queue-diagnostics.js";
import { summarizeTerminalOutboxForSchedz } from "./terminal-outbox-schedz.js";
import { createDefaultStateStore, resolvePublicBaseUrl, firstNonEmpty } from "./server-config.js";
// Re-exported to preserve the public surface (tests import firstNonEmpty from here).
export { firstNonEmpty };
import type {
  A2AHttpSignatureVerifiedWorker,
  A2AHttpSignatureWorkerAuthMode,
  A2AHttpSignatureWorkerKeySource,
  BrokerBuildInfo,
  BrokerPersistenceQueueDiagnostics,
  BrokerPersistenceQueueDiagnosticsProvider,
  BrokerPersistenceQueueState,
  BrokerServerOptions,
  BrokerServerRuntime,
  BrokerStaleReaperStatus,
  BufferedOperatorEvent,
  OperatorEventName,
  OperatorEventPayload,
  OperatorReplayWindow,
  OperatorSnapshotEvent,
} from "./server-contracts.js";
export type {
  A2AHttpSignatureVerifiedWorker,
  A2AHttpSignatureWorkerAuthMode,
  A2AHttpSignatureWorkerKeySource,
  BrokerBuildInfo,
  BrokerPersistenceQueueDiagnostics,
  BrokerPersistenceQueueDiagnosticsProvider,
  BrokerPersistenceQueueMode,
  BrokerPersistenceQueueState,
  BrokerServerOptions,
  BrokerServerRuntime,
  BrokerStaleReaperStatus,
  BufferedOperatorEvent,
  OperatorEventName,
  OperatorEventPayload,
  OperatorReplayWindow,
  OperatorSnapshotEvent,
} from "./server-contracts.js";
import {
  resolveA2AHttpSignatureWorkerAuthMode,
  validateBrokerStartupSecurity,
} from "./startup-security.js";
import {
  boundedLimitQueryParam,
  stringListQueryParam,
  nonNegativeNumberBodyField,
  stringListBodyField,
} from "./http/request-params.js";
import { createServer, type IncomingMessage, type RequestListener, type Server, type ServerResponse } from "node:http";
import {
  DEFAULT_KEEPALIVE_TIMEOUT_MS,
  HEADERS_TIMEOUT_MARGIN_MS,
  startBrokerServerWithFactory,
} from "./server-lifecycle.js";
import { readHostLoadSnapshot } from "./host-load-snapshot.js";
import { readHttpServerDiagnostics } from "./http-server-diagnostics.js";
import { OperatorEventStream } from "./operator-event-stream.js";
import { StaleReaperStatusTracker } from "./stale-reaper-status-tracker.js";
import { OperatorAlertDiffer } from "./operator-alert-differ.js";
import {
  _livezTiming,
  _healthTiming,
  _totalAcceptedRequests,
  _activeRequests,
  _schedulingTimingWindow,
  routeHandlerBodySnapshot,
  endpointTimingSnapshot,
  endpointActiveSnapshot,
  endpointHandlerBodySnapshot,
  requestRouteSnapshot,
  initSchedulingHook,
  _totalConnections,
  _activeConnections,
  _peakConnections,
  _connectionDurationWindow,
  _firstRequestLatencyWindow,
  _socketAgeBeforeHandlerWindow,
  _socketIdleBeforeRequestWindow,
  _socketAcceptedToHttpRequestEventWindow,
  _httpRequestEventToHandlerStartWindow,
  _socketIdleBeforeHttpRequestEventWindow,
  _clientProbeStartToHandlerStartWindow,
  _clientProbeStartToSocketConnectedWindow,
  _flushFinishGapWindow,
  _handlerBodyWindow,
  _clientProbeStartToHttpRequestEventWindow,
  _socketConnectedToFirstDataWindow,
  _firstDataToHttpRequestEventWindow,
  _freshSocketAgeBeforeHandlerWindow,
  _freshSocketAcceptedToHttpRequestEventWindow,
  _freshSocketConnectedToFirstDataWindow,
  _freshSocketFirstDataToHttpRequestEventWindow,
  _freshSocketHttpRequestEventToHandlerStartWindow,
  _reusedSocketIdleBeforeHttpRequestEventWindow,
  _reusedSocketAgeBeforeHandlerWindow,
  _reusedSocketHttpRequestEventToHandlerStartWindow,
  _reusedSocketIdleBeforeDataWindow,
  _reusedSocketFirstDataToHttpRequestEventWindow,
  _requestsOnNewConnection,
  _requestsOnReusedConnection,
  trackServerConnection,
  markHttpRequestEvent,
  readRequestLifecycleTiming,
  readProbeBursts,
} from "./request-scheduling-metrics.js";
import { readRuntimeMemoryUsage, readEventLoopDelayMs, readGcDiagnostics, readCpuDiagnostics } from "./diagnostics/system-metrics.js";
import { computeReusedSocketGate } from "./diagnostics/reused-socket-gate.js";
import { resolveBrokerBuildInfo } from "./broker-build-info.js";
import { normalizeTaskReadinessMode, type TaskReadinessMode } from "./task-readiness.js";
import { loadBrokerPolicyFile } from "@openclaw/a2a-policy-referee";
import { loadInjectedKnowledgeFile } from "./core/broker-knowledge-injection.js";
import { resolveFinalizerVerdictEnforcement } from "./core/finalizer-verdict-admission.js";
import { loadFinalizerKeyringFile } from "./core/finalizer-verdict-signature.js";
import { normalizePersistenceBackend, normalizeSqliteLoadSource } from "./persistence-options.js";
import {
  resolveBrokerId,
  resolveBrokerRetentionPolicy,
  resolveHotRuntimeLimits,
  resolveIntegerOption,
  resolveStringOption,
  resolveBooleanEnv,
  type BrokerHotRuntimeLimits,
  type BrokerRuntimeHotLimitOptions,
} from "./broker-runtime-config.js";

import { createBrokerAgentCard, type AgentCard } from "./a2a/agent-card.js";
import { PushNotificationConfigStore } from "./a2a/push-notification-config.js";
import { signAgentCard } from "./a2a/agent-card-signing.js";
import { loadCrossBrokerTrustAnchors, CrossBrokerNonceCache } from "./a2a/cross-broker-sender-proof.js";
import { startDefaultAgent, DEFAULT_AGENT_NODE_ID, type DefaultAgentHandle } from "./a2a/default-agent.js";
import { PeerStatusService } from "./a2a/peer-status.js";
import {
  BrokerError,
  DEFAULT_MAX_REQUEUE_ATTEMPTS,
  DEFAULT_WORKER_HEARTBEAT_PERSIST_INTERVAL_MS,
  InMemoryA2ABroker,
  type BrokerRetentionPolicy,
  type TaskDiagnosticsOptions,
} from "./core/broker.js";
import {
  applyRateLimitHeaders,
  assertEdgeSecret,
  assertA2AWorkerScopeAllowed,
  assertRequesterHasRole,
  assertRequesterMatchesParty,
  classifyRateLimitBucket,
  extractRequesterIdentity,
  InMemoryRateLimiter,
  loadA2AHttpSignatureKeyRegistryFile,
  verifyA2AHttpSignature,
  rateLimitKey,
  type A2AHttpSignatureKeyRegistry,
  type A2AWorkerRouteScope,
  type RateLimitPressureSnapshot,
  type RequesterIdentity,
} from "./core/request-security.js";
import {
  DEFAULT_BROKER_STATE_MAX_BYTES,
  JsonFileBrokerStateStore,
  SqliteArtifactRuntimeRepository,
  SqliteAuditRuntimeRepository,
  SqliteBrokerStateStore,
  SqliteExchangeMessageRuntimeRepository,
  SqliteExchangeRuntimeRepository,
  SqliteProposalRuntimeRepository,
  SqliteTaskRuntimeRepository,
  SqliteTombstoneRuntimeRepository,
  SqliteValidationRuntimeRepository,
  SqliteWorkerRuntimeRepository,
  type BrokerHotEntityDiagnostics,
  type BrokerStateStore,
  type SqliteBrokerLoadSource,
  type BrokerHotTableRuntimeLoadLimits,
  type SqliteTaskListItemProjection,
} from "./core/store.js";
import {
  projectHotTableGrowth,
  type HotTableGrowthProjection,
} from "./core/hot-table-growth.js";
import { HealthDiagnosticsCache } from "./health-diagnostics-cache.js";
import { A2AHttpSignatureReplayCache } from "./a2a-http-signature-replay-cache.js";
import {
  workerRegisterPhaseTimingSnapshot,
  workerRegisterPhasePerWorkerSnapshot,
  workerHeartbeatPhaseTimingSnapshot,
  workerHeartbeatPhasePerWorkerSnapshot,
} from "./worker-phase-timing.js";
import {
  createWorkerThreadPersistence,
} from "./core/sqlite-worker-thread-persistence.js";
import type { WorkerThreadPersistenceHandle } from "./core/sqlite-worker-thread-persistence.js";
import type {
  A2AExchangeMessageRequest,
  A2AExchangeRequest,
  AuditAction,
  AuditEvent,
  AuditListFilters,
  BrokerDashboard,
  CreateTaskRequest,
  ProposalKind,
  ProposalStatus,
  TaskDiagnosticReport,
  TaskKind,
  TaskListFilters,
  TaskOrigin,
  TaskStatus,
  TaskTombstone,
  WorkerRecord,
  WorkerView,
  A2AWorkerEnvironment,
  A2APartyRole,
} from "./core/types.js";
import type { DecisionDialecticPatchV1, DecisionDialecticPhase } from "./decision-dialectic/types.js";
import {
  applyDecisionDialecticPatch,
  buildDecisionDialecticPhaseTaskRequest,
  DecisionDialecticExecutionError,
  extractDecisionDialecticTaskInput,
  nextDecisionDialecticPhase,
} from "./decision-dialectic/execution.js";
import {
  projectDecisionDialecticReadModel,
  DecisionDialecticReadModelError,
} from "./decision-dialectic/read-model.js";
import {
  projectTradingDialecticReadModel,
  TradingDialecticReadModelError,
} from "./trading-dialectic/read-model.js";
import type { Alert, AlertScanResult } from "./core/alert-projection.js";
import { TERMINAL_BRIEF_SIDECAR_ROUTES } from "./terminal-brief-sidecar-routes.js";
import {
  isTerminalTaskOutboxAckInputEvidence,
  isTerminalTaskReceiptStatus,
  type TerminalTaskEventOutbox,
  type TerminalTaskOutboxEvent,
  type TerminalTaskOutboxAckInput,
  type TerminalTaskOutboxReceiptUpdateInput,
} from "./core/terminal-event-outbox.js";
import { GitHubIngestionService } from "./github/ingestion.js";
import { BoundedPoller } from "./github/bounded-poller.js";
import { readJson, readRawBody } from "./http/body.js";
import { sendJson, truncateMessage } from "./http/response.js";
import { awaitDurablePersistenceAck, sendError } from "./http/error-mapping.js";
import { handleRoundStatusRouteIfMatched } from "./http/rounds.js";
import { handleAuditReadRouteIfMatched } from "./http/audit-read-route.js";
import { handleProposalsReadRouteIfMatched } from "./http/proposals-read.js";
import { handleExchangeRoutesIfMatched } from "./http/exchanges-read.js";
import { handleComplexityOrchestrationRoutesIfMatched } from "./http/complexity-orchestration-routes.js";
import { handleWavePlanRoutesIfMatched } from "./http/wave-plan-routes.js";
import { handleTerminalBriefCloseoutRoutesIfMatched } from "./http/terminal-brief-routes.js";
import {
  handleWorkersReadRouteIfMatched,
} from "./http/workers-read.js";
import { handleOperatorDiagnosticsReadRouteIfMatched } from "./http/operator-diagnostics-read.js";
import { handleOperatorCleanupRouteIfMatched } from "./http/operator-cleanup-routes.js";
import { handleOperatorDashboardRouteIfMatched } from "./http/operator-dashboard-routes.js";
import { handleOperatorReportingReadRouteIfMatched } from "./http/operator-reporting-read.js";
import { handleProposalsWriteRouteIfMatched } from "./http/proposals-write-routes.js";
import { handleTasksDecisionRouteIfMatched } from "./http/tasks-decision-routes.js";
import { handleTasksWorkerRouteIfMatched } from "./http/tasks-worker-routes.js";
import { handleWorkersWriteRouteIfMatched } from "./http/workers-write-routes.js";
import { handleTasksCollectionRouteIfMatched } from "./http/tasks-collection-routes.js";
import { handleTaskStatsRouteIfMatched } from "./http/task-stats-routes.js";
import { handleGitHubRouteIfMatched } from "./http/github-routes.js";
import { handleTasksReadRouteIfMatched } from "./http/tasks-read.js";
import { handleA2ATerminalOutboxRouteIfMatched } from "./http/a2a-terminal-outbox-routes.js";
import { handleA2AJsonRpcRouteIfMatched } from "./http/a2a-jsonrpc-route.js";
import { handleA2AStreamRouteIfMatched } from "./http/a2a-stream-routes.js";
import { handleA2ATaskStreamRouteIfMatched } from "./http/a2a-task-stream-routes.js";
import { handleTasksWakeRouteIfMatched } from "./http/tasks-wake-routes.js";
import {
  classifyEndpointGroup,
  classifyRequestRoute,
} from "./http/route-classification.js";
import { readCgroupCpuSnapshot, readCgroupPsiSnapshot } from "./diagnostics/cgroup-metrics.js";
import { buildAlertScan, buildDashboardResponse, type OperatorSummary } from "./http/dashboard-response.js";
import {
  assertA2AContentDigestMatches,
  hasA2AHttpSignatureHeaders,
  headerValue,
  requestHeadersForA2AHttpSignature,
} from "./http/worker-route-auth.js";

const DEFAULT_OPERATOR_EVENT_BUFFER_LIMIT = 200;
const DEFAULT_MAX_TASK_PAYLOAD_BYTES = 1 * 1024 * 1024;

/**
 * Resolve the result-provenance countersigning posture (#1389). Defaults to
 * "auto" when unset/empty; a non-empty but unrecognized value is a loud
 * configuration error rather than a silent fallback.
 */
function resolveResultProvenanceCountersignMode(raw: string | undefined): "enforce" | "auto" | "off" {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "") return "auto";
  if (value === "enforce" || value === "auto" || value === "off") return value;
  throw new Error(
    `invalid A2A_RESULT_PROVENANCE_COUNTERSIGN='${raw}' (expected enforce | auto | off)`,
  );
}

export function createBrokerServer(options: BrokerServerOptions = {}): BrokerServerRuntime {
  const host = options.host ?? process.env.HOST ?? "0.0.0.0";
  const port = options.port ?? Number(process.env.PORT ?? 8787);
  const serviceName = options.serviceName ?? process.env.SERVICE_NAME ?? "a2a-broker";
  const publicBaseUrl = resolvePublicBaseUrl(options.publicBaseUrl ?? process.env.PUBLIC_BASE_URL);
  const stateFile = options.stateFile ?? process.env.STATE_FILE ?? "/var/lib/a2a-broker/state.json";
  let persistenceQueueDiagnosticsProvider = options.persistenceQueueDiagnostics;
  const persistenceBackend =
    options.persistenceBackend ?? normalizePersistenceBackend(process.env.BROKER_PERSISTENCE_BACKEND);
  const sqliteFile = options.sqliteFile ?? process.env.SQLITE_STATE_FILE ?? process.env.BROKER_SQLITE_FILE;
  const sqliteLoadSource = options.sqliteLoadSource ?? normalizeSqliteLoadSource(process.env.BROKER_SQLITE_LOAD_SOURCE);
  const persistenceQueueAckTimeoutMs = Math.max(
    1,
    resolveIntegerOption(
      options.persistenceQueueAckTimeoutMs,
      process.env.BROKER_PERSISTENCE_QUEUE_ACK_TIMEOUT_MS,
      30_000,
    ),
  );
  const maxTaskPayloadBytes = Math.max(
    1,
    resolveIntegerOption(
      options.maxTaskPayloadBytes,
      process.env.BROKER_MAX_TASK_PAYLOAD_BYTES ?? process.env.A2A_MAX_TASK_PAYLOAD_BYTES,
      DEFAULT_MAX_TASK_PAYLOAD_BYTES,
    ),
  );
  const workerOfflineAfterSec = options.workerOfflineAfterSec ?? Number(process.env.WORKER_OFFLINE_AFTER_SEC ?? 90);
  const workerHeartbeatPersistIntervalMs = Math.max(
    0,
    resolveIntegerOption(
      options.workerHeartbeatPersistIntervalMs,
      process.env.BROKER_WORKER_HEARTBEAT_PERSIST_INTERVAL_MS,
      DEFAULT_WORKER_HEARTBEAT_PERSIST_INTERVAL_MS,
    ),
  );
  const workerHeartbeatPersistence = {
    intervalMs: Number.isFinite(workerHeartbeatPersistIntervalMs) ? workerHeartbeatPersistIntervalMs : null,
    disabled: !Number.isFinite(workerHeartbeatPersistIntervalMs),
    persistEveryHeartbeat: workerHeartbeatPersistIntervalMs === 0,
    warning: persistenceBackend === "sqlite" && workerHeartbeatPersistIntervalMs === 0
      ? "BROKER_WORKER_HEARTBEAT_PERSIST_INTERVAL_MS=0 persists every worker heartbeat/register change through durable SQLite; this can starve task lifecycle writes. Use a positive interval such as 60000 unless explicitly load-testing."
      : undefined,
  };
  const rateLimitWindowSec = options.rateLimitWindowSec ?? Number(process.env.RATE_LIMIT_WINDOW_SEC ?? 60);
  const rateLimitMaxRequests = options.rateLimitMaxRequests ?? Number(process.env.RATE_LIMIT_MAX_REQUESTS ?? 10);
  const workerRateLimitWindowSec =
    options.workerRateLimitWindowSec ?? Number(process.env.WORKER_RATE_LIMIT_WINDOW_SEC ?? rateLimitWindowSec);
  const workerRateLimitMaxRequests =
    options.workerRateLimitMaxRequests ?? Number(process.env.WORKER_RATE_LIMIT_MAX_REQUESTS ?? 60);
  const enforceRequesterIdentity =
    options.enforceRequesterIdentity ?? process.env.ENFORCE_REQUESTER_IDENTITY !== "0";
  const edgeSecret = options.edgeSecret ?? process.env.EDGE_SECRET ?? process.env.A2A_EDGE_SECRET;
  const liveApprovalSigningKey = options.liveApprovalSigningKey ?? process.env.A2A_LIVE_APPROVAL_SIGNING_KEY ?? "";
  const a2aHttpSignatureWorkerAuth = resolveA2AHttpSignatureWorkerAuthMode(
    options.a2aHttpSignatureWorkerAuth ?? process.env.A2A_HTTP_SIGNATURE_WORKER_AUTH,
  );
  const a2aHttpSignatureKeyRegistryFile = resolveStringOption(
    options.a2aHttpSignatureKeyRegistryFile,
    process.env.A2A_HTTP_SIGNATURE_KEY_REGISTRY_FILE,
  );
  if (options.a2aHttpSignatureKeyRegistry && a2aHttpSignatureKeyRegistryFile) {
    throw new Error("configure either a2aHttpSignatureKeyRegistry or A2A_HTTP_SIGNATURE_KEY_REGISTRY_FILE, not both");
  }
  const a2aHttpSignatureKeyRegistry = options.a2aHttpSignatureKeyRegistry
    ?? (a2aHttpSignatureKeyRegistryFile ? loadA2AHttpSignatureKeyRegistryFile(a2aHttpSignatureKeyRegistryFile) : {});
  const a2aHttpSignatureWorkerKeySource: A2AHttpSignatureWorkerKeySource = options.a2aHttpSignatureKeyRegistry
    ? "inline"
    : (a2aHttpSignatureKeyRegistryFile ? "file" : "empty");
  const a2aHttpSignatureReplayCache = new A2AHttpSignatureReplayCache();
  // Small forward clock-skew tolerance on the signature `created` timestamp
  // (#1402): absorbs sub-second worker/broker drift that otherwise flips
  // a2a_signature_time_invalid at second boundaries. Default 2s; expires stays
  // strict. A2A_SIGNATURE_CLOCK_SKEW_SEC overrides (0 restores strict behavior).
  const a2aSignatureClockSkewSeconds = Math.max(
    0,
    Math.floor(
      options.a2aSignatureClockSkewSeconds
        ?? Number(process.env.A2A_SIGNATURE_CLOCK_SKEW_SEC ?? 2),
    ) || 0,
  );
  const allowInsecureDev = options.allowInsecureDev ?? resolveBooleanEnv(process.env.A2A_ALLOW_INSECURE_DEV, false);
  validateBrokerStartupSecurity({
    host,
    edgeSecret,
    workerAuth: a2aHttpSignatureWorkerAuth,
    workerKeyCount: Object.keys(a2aHttpSignatureKeyRegistry).length,
    allowInsecureDev,
  });
  const githubWebhookSecret = firstNonEmpty(
    options.githubWebhookSecret,
    process.env.GITHUB_WEBHOOK_SECRET,
    process.env.A2A_GITHUB_WEBHOOK_SECRET,
  );
  const trustedProxy = options.trustedProxy ?? process.env.TRUSTED_PROXY === "1";
  const maxSnapshotBytes = Math.max(
    1,
    options.maxSnapshotBytes ?? Number(process.env.STATE_FILE_MAX_BYTES ?? DEFAULT_BROKER_STATE_MAX_BYTES),
  );
  // Default the terminal-task byte budget to half the snapshot cap so terminal
  // retention can never outgrow STATE_FILE_MAX_BYTES and wedge persistence,
  // whatever count caps or payload sizes are in play (#1579).
  const retentionPolicy = resolveBrokerRetentionPolicy(options.retentionPolicy, {
    maxTerminalTaskBytes: Math.floor(maxSnapshotBytes / 2),
  });
  const taskReadinessMode = normalizeTaskReadinessMode(
    options.taskReadinessMode ?? process.env.A2A_TASK_READINESS_MODE ?? process.env.BROKER_TASK_READINESS_MODE,
  );
  // Declarative worker-class policy (#1355 G1). A configured-but-invalid or
  // unreadable document fails startup loudly (loadBrokerPolicyFile throws);
  // unset keeps legacy behavior (no policy evaluation).
  const brokerPolicyFile = options.brokerPolicyFile ?? process.env.A2A_BROKER_POLICY_FILE;
  const brokerPolicyDocument = brokerPolicyFile ? loadBrokerPolicyFile(brokerPolicyFile) : undefined;
  // Anonymous knowledge injection snapshot (#1373 K1). Same stance as the
  // policy file: configured-but-invalid fails startup loudly; unset keeps
  // legacy behavior (no injection).
  const injectedKnowledgeFile = options.injectedKnowledgeFile ?? process.env.A2A_INJECTED_KNOWLEDGE_FILE;
  const injectedKnowledge = injectedKnowledgeFile ? loadInjectedKnowledgeFile(injectedKnowledgeFile) : undefined;
  // Accept-path finalizer-verdict posture (#1383 V-c). Invalid value fails
  // startup loudly (resolve throws); default off keeps completion unchanged.
  const finalizerVerdictEnforcement = resolveFinalizerVerdictEnforcement(
    options.finalizerVerdictEnforcement ?? process.env.A2A_FINALIZER_VERDICT_ENFORCEMENT,
  );
  // Optional registered finalizer keyring (#1383 V-c follow-up): when set, the
  // accept-path verifies static-key verdict signatures in-broker. Invalid file
  // fails startup loudly; unset defers signature checks to the merge gate.
  const finalizerKeyringFile = options.finalizerKeyringFile ?? process.env.A2A_FINALIZER_KEYRING_FILE;
  const finalizerKeyring = finalizerKeyringFile ? loadFinalizerKeyringFile(finalizerKeyringFile) : undefined;
  const hotRuntimeLimits = resolveHotRuntimeLimits(options);
  const maxHotRuntimeNonTerminalTasks = hotRuntimeLimits.maxNonTerminalTasks;
  const maxHotRuntimeTerminalTasks = hotRuntimeLimits.maxTerminalTasks;
  const maxHotRuntimeAuditEvents = hotRuntimeLimits.maxAuditEvents;
  const maxHotRuntimeHeartbeatAuditEvents = hotRuntimeLimits.maxHeartbeatAuditEvents;
  const maxHotRuntimeTerminalOutboxEvents = hotRuntimeLimits.maxTerminalOutboxEvents;
  const staleReaperEnabled =
    options.staleReaperEnabled ?? resolveBooleanEnv(process.env.STALE_REAPER_ENABLED, true);
  // Default sweep cadence (60s) is well below the default worker offline threshold (90s),
  // so a dead worker's in-flight task gets reaped within roughly offlineAfterSec + intervalSec.
  const staleReaperIntervalSec = Math.max(
    1,
    resolveIntegerOption(options.staleReaperIntervalSec, process.env.STALE_REAPER_INTERVAL_SEC, 60),
  );
  // Baseline stale threshold falls back to the worker offline window so local reaping never
  // fires earlier than "worker definitely missed a heartbeat cycle".
  const staleReaperOlderThanSec = Math.max(
    0,
    resolveIntegerOption(
      options.staleReaperOlderThanSec,
      process.env.STALE_REAPER_OLDER_THAN_SEC,
      Math.max(workerOfflineAfterSec, 1),
    ),
  );
  // Stale wave-plan sweep threshold (#1357 G3-c reaper wiring). Rides the same
  // reaper interval; a live wave idle past this window gets one wave.stalled
  // warning audit event (never an auto-abort). 0 disables the wave sweep.
  const waveStaleAfterSec = Math.max(
    0,
    resolveIntegerOption(options.waveStaleAfterSec, process.env.WAVE_STALE_AFTER_SEC, 21_600),
  );
  const maxRequeueAttempts = Math.max(
    0,
    resolveIntegerOption(
      options.maxRequeueAttempts,
      process.env.BROKER_MAX_REQUEUE_ATTEMPTS,
      DEFAULT_MAX_REQUEUE_ATTEMPTS,
    ),
  );
  const taskSubscribeHeartbeatSec = Math.max(
    0,
    resolveIntegerOption(options.taskSubscribeHeartbeatSec, process.env.TASK_SUBSCRIBE_HEARTBEAT_SEC, 15),
  );
  const peerStatusEnabled =
    options.peerStatusEnabled ?? resolveBooleanEnv(process.env.A2A_PEER_STATUS_ENABLED, false);
  const brokerId = resolveBrokerId(options.brokerId, serviceName);
  const teamId = resolveStringOption(options.teamId, process.env.A2A_TEAM_ID);
  const buildInfo = resolveBrokerBuildInfo(options, serviceName);

  let stateStore: BrokerStateStore =
    options.stateStore ??
    createDefaultStateStore({
      backend: persistenceBackend,
      stateFile,
      sqliteFile,
      sqliteLoadSource,
      maxSnapshotBytes,
      hotRuntimeLimits,
    });

  // Worker-thread persistence facade (opt-in).
  // Off by default; enable with BROKER_PERSISTENCE_QUEUE_WORKER_THREAD=1.
  // When enabled, the SqliteBrokerStateStore is replaced with a proxy that
  // delegates write operations (save, saveHotEntities) through a FIFO queue
  // to a dedicated worker thread. All read methods remain synchronous on the
  // main thread. The proxy extends SqliteBrokerStateStore, so instanceof
  // checks and repository constructors work unchanged.
  let workerPersistenceHandle: WorkerThreadPersistenceHandle | undefined;
  if (
    persistenceBackend === "sqlite" &&
    sqliteFile &&
    process.env.BROKER_PERSISTENCE_QUEUE_WORKER_THREAD === "1" &&
    !options.stateStore
  ) {
    workerPersistenceHandle = createWorkerThreadPersistence({
      dbFile: sqliteFile,
      ackTimeoutMs: persistenceQueueAckTimeoutMs,
      loadSource: sqliteLoadSource,
      maxBytes: maxSnapshotBytes,
      maxHotRuntimeNonTerminalTasks,
      maxHotRuntimeTerminalTasks,
      maxHotRuntimeAuditEvents,
      maxHotRuntimeHeartbeatAuditEvents,
      maxHotRuntimeTerminalOutboxEvents,
    });
    stateStore = workerPersistenceHandle.stateStore;
    persistenceQueueDiagnosticsProvider = workerPersistenceHandle.diagnostics;
  }

  const pushNotificationsEnabled =
    options.pushNotificationsEnabled ?? resolveBooleanEnv(process.env.A2A_PUSH_NOTIFICATIONS_ENABLED, false);
  const initialSnapshot = options.broker && !pushNotificationsEnabled ? undefined : stateStore.load();
  const pushNotificationConfigStore = pushNotificationsEnabled
    ? new PushNotificationConfigStore(initialSnapshot?.pushNotificationConfigs ?? [])
    : undefined;
  const pushNotificationSnapshotExtension = pushNotificationConfigStore
    ? () => ({ pushNotificationConfigs: pushNotificationConfigStore.snapshot() })
    : undefined;

  const sqliteRepositoryStore =
    workerPersistenceHandle || !(stateStore instanceof SqliteBrokerStateStore)
      ? undefined
      : stateStore;
  let workerPersistenceClosePromise: Promise<void> | undefined;
  const closeWorkerPersistence = (): Promise<void> => {
    if (!workerPersistenceHandle) {
      return Promise.resolve();
    }
    workerPersistenceClosePromise ??= workerPersistenceHandle.close();
    return workerPersistenceClosePromise;
  };
  let unsubscribePushNotificationPruneListener: (() => void) | undefined;
  let unsubscribePushNotificationSnapshotExtension: (() => void) | undefined;
  const broker =
    options.broker ??
    new InMemoryA2ABroker(stateStore, initialSnapshot, {
      taskRepository: sqliteRepositoryStore
        ? new SqliteTaskRuntimeRepository(sqliteRepositoryStore)
        : undefined,
      auditRepository: sqliteRepositoryStore
        ? new SqliteAuditRuntimeRepository(sqliteRepositoryStore, { maxHotAuditEvents: retentionPolicy.maxAuditEvents })
        : undefined,
      tombstoneRepository: sqliteRepositoryStore
        ? new SqliteTombstoneRuntimeRepository(sqliteRepositoryStore)
        : undefined,
      workerRepository: sqliteRepositoryStore
        ? new SqliteWorkerRuntimeRepository(sqliteRepositoryStore)
        : undefined,
      exchangeRepository: sqliteRepositoryStore
        ? new SqliteExchangeRuntimeRepository(sqliteRepositoryStore)
        : undefined,
      exchangeMessageRepository: sqliteRepositoryStore
        ? new SqliteExchangeMessageRuntimeRepository(sqliteRepositoryStore)
        : undefined,
      proposalRepository: sqliteRepositoryStore
        ? new SqliteProposalRuntimeRepository(sqliteRepositoryStore)
        : undefined,
      artifactRepository: sqliteRepositoryStore
        ? new SqliteArtifactRuntimeRepository(sqliteRepositoryStore)
        : undefined,
      validationRepository: sqliteRepositoryStore
        ? new SqliteValidationRuntimeRepository(sqliteRepositoryStore)
        : undefined,
      retention: retentionPolicy,
      maxRequeueAttempts,
      workerHeartbeatPersistIntervalMs,
      brokerId,
      teamId,
      taskReadinessMode,
      policyDocument: brokerPolicyDocument,
      injectedKnowledge,
      finalizerVerdictEnforcement,
      finalizerKeyring,
      snapshotExtensions: pushNotificationSnapshotExtension,
    });
  if (options.broker && pushNotificationSnapshotExtension) {
    unsubscribePushNotificationSnapshotExtension = broker.registerSnapshotExtension(pushNotificationSnapshotExtension);
  }
  const rateLimiter = new InMemoryRateLimiter(
    Math.max(1, rateLimitMaxRequests),
    Math.max(1, rateLimitWindowSec) * 1000,
  );
  const workerRateLimiter = new InMemoryRateLimiter(
    Math.max(1, workerRateLimitMaxRequests),
    Math.max(1, workerRateLimitWindowSec) * 1000,
  );
  let startupPrunedPushConfigTaskCount = 0;
  if (pushNotificationConfigStore) {
    // Release push configs (and their delivery secrets) on the same lifecycle
    // as the tasks they belong to: when retention prunes a task, its configs
    // must not outlive it in memory.
    unsubscribePushNotificationPruneListener = broker.registerTaskPruneListener((prunedTaskIds) => {
      for (const taskId of prunedTaskIds) {
        pushNotificationConfigStore.clearTask(taskId);
      }
    });
    startupPrunedPushConfigTaskCount = pushNotificationConfigStore.retainTasks(broker.listTasks().map((task) => task.id));
  }
  const persistPushNotificationConfigs = pushNotificationConfigStore
    ? () => stateStore.save({
        ...broker.exportSnapshot(),
        pushNotificationConfigs: pushNotificationConfigStore.snapshot(),
      })
    : undefined;
  if (startupPrunedPushConfigTaskCount > 0 && !options.broker) {
    persistPushNotificationConfigs?.();
  }
  const unsignedAgentCard =
    options.agentCard ??
    createBrokerAgentCard({
      serviceName,
      publicBaseUrl,
      supportsStreaming: true,
      supportsPushNotifications: pushNotificationsEnabled,
    });
  // A2A 1.0 signed agent cards: opt-in via AGENT_CARD_SIGNING_KEY_FILE
  // (PEM Ed25519 or EC P-256 private key). A missing key serves the card
  // unsigned exactly as before; a configured-but-unreadable key fails
  // startup loudly instead of silently serving an unsigned card.
  const signingKeyFile = options.agentCardSigningKeyFile ?? process.env.AGENT_CARD_SIGNING_KEY_FILE;
  const signingKeyPem = signingKeyFile ? readFileSync(signingKeyFile, "utf8") : undefined;
  const agentCardSigningKid = options.agentCardSigningKid ?? process.env.AGENT_CARD_SIGNING_KID;
  // Result-provenance countersigning posture (#1382 G2 / #1389 deploy gap). The
  // #1389 incident: a new build that unconditionally enforced countersigning
  // shipped before the signer key/env reached the container, so every provenance-
  // bearing worker submission failed with "countersigning key is not configured".
  // "enforce" turns that code-vs-env skew into a LOUD STARTUP failure (mirroring
  // the "configured-but-unreadable key fails startup" agent-card stance) instead
  // of a per-task failure discovered later by workers. "auto" (default) never
  // rejects a worker task for a missing broker key. "off" is a kill switch.
  const resultProvenanceCountersign = resolveResultProvenanceCountersignMode(
    options.resultProvenanceCountersign ?? process.env.A2A_RESULT_PROVENANCE_COUNTERSIGN,
  );
  if (resultProvenanceCountersign === "enforce" && !signingKeyPem) {
    throw new Error(
      "A2A_RESULT_PROVENANCE_COUNTERSIGN=enforce requires a broker signing key, but none is configured. " +
        "Set AGENT_CARD_SIGNING_KEY_FILE to a readable Ed25519/EC-P256 private key, or set " +
        "A2A_RESULT_PROVENANCE_COUNTERSIGN=off to disable result-provenance countersigning.",
    );
  }
  const crossBrokerTrustAnchors = loadCrossBrokerTrustAnchors(
    options.crossBrokerSenderProofKeysFile ?? process.env.CROSS_BROKER_SENDER_PROOF_KEYS_FILE,
  );
  const crossBrokerNonceCache = crossBrokerTrustAnchors ? new CrossBrokerNonceCache() : undefined;
  const agentCard = signingKeyPem
    ? signAgentCard(unsignedAgentCard as unknown as Record<string, unknown>, {
        privateKeyPem: signingKeyPem,
        kid: agentCardSigningKid,
      }) as unknown as typeof unsignedAgentCard
    : unsignedAgentCard;
  const peerStatusService = peerStatusEnabled
    ? new PeerStatusService(broker, { workerOfflineAfterMs: workerOfflineAfterSec * 1000 })
    : undefined;

  // Embedded default A2A agent (opt-in). Registering its worker and driving
  // tasks in-process lets the broker also answer worker-less SendMessage as a
  // standalone agent. Off by default; an explicit targetNodeId always wins.
  const defaultAgentEnabled = options.defaultAgentMode ?? resolveBooleanEnv(process.env.A2A_DEFAULT_AGENT_MODE, false);
  let defaultAgentHandle: DefaultAgentHandle | undefined;
  if (defaultAgentEnabled) {
    defaultAgentHandle = startDefaultAgent(broker);
  }
  const defaultAgentNodeId = defaultAgentHandle?.nodeId;

  const healthDiagnosticsCache = new HealthDiagnosticsCache();

  // In-broker periodic stale-task reaper. Without this, claimed/running tasks pointing at a
  // dead worker stay stuck until an operator manually hits POST /tasks/requeue_stale. The
  // broker snapshot already survives restart, but recovery still required a human. This loop
  // makes recovery self-healing after node, worker, or broker restarts.
  let staleReaperTimer: NodeJS.Timeout | null = null;
  const staleReaperStatus = new StaleReaperStatusTracker();
  let suppressOperatorStateBroadcast = false;

  const runStaleReaperSweep = (): number => {
    suppressOperatorStateBroadcast = true;
    try {
      const { requeued, deadLettered } = broker.requeueStaleTasksDetailed(
        staleReaperOlderThanSec * 1000,
        { workerOfflineAfterMs: workerOfflineAfterSec * 1000 },
      );
      staleReaperStatus.recordSweep(requeued.length, deadLettered.length);
      if (deadLettered.length > 0) {
        // Operators want to see this without trawling audit logs. Keep it a single, greppable
        // line with task ids so it maps back to `task.failed` audit events.
        console.warn(
          `[a2a-broker] stale reaper dead-lettered ${deadLettered.length} task(s) after ${broker.getMaxRequeueAttempts()} requeue attempts: ${deadLettered
            .map((task) => task.id)
            .join(", ")}`,
        );
      }
      // Stale wave-plan sweep rides the same interval: warn-only wave.stalled
      // audit events for live waves idle past the threshold (never auto-abort).
      const stalledWaves = waveStaleAfterSec > 0 ? broker.sweepStalledWavePlans(waveStaleAfterSec * 1000) : [];
      if (stalledWaves.length > 0) {
        console.warn(
          `[a2a-broker] wave reaper flagged ${stalledWaves.length} stalled wave plan(s): ${stalledWaves
            .map((wave) => `${wave.wavePlanId}@${wave.stageId}`)
            .join(", ")}`,
        );
      }
      if (requeued.length > 0 || deadLettered.length > 0 || stalledWaves.length > 0) {
        publishOperatorEvents();
      }
      return requeued.length;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      staleReaperStatus.recordError(message);
      // Keep the loop alive: transient persistence errors shouldn't kill the timer.
      console.error(`[a2a-broker] stale reaper sweep failed: ${message}`);
      publishOperatorEvents();
      return 0;
    } finally {
      suppressOperatorStateBroadcast = false;
    }
  };

  const stopStaleReaper = (): void => {
    if (staleReaperTimer !== null) {
      clearInterval(staleReaperTimer);
      staleReaperTimer = null;
    }
  };

  const getStaleReaperStatus = (): BrokerStaleReaperStatus =>
    staleReaperStatus.status({
      enabled: staleReaperEnabled,
      intervalSec: staleReaperIntervalSec,
      olderThanSec: staleReaperOlderThanSec,
      waveStaleAfterSec,
      maxRequeueAttempts,
    });

  const operatorEvents = new OperatorEventStream(DEFAULT_OPERATOR_EVENT_BUFFER_LIMIT);

  // Compute hot-table growth for operator alerts once per snapshot.
  const currentHotTableGrowth = (): HotTableGrowthProjection | undefined =>
    stateStore instanceof SqliteBrokerStateStore
      ? projectHotTableGrowth({
          current: stateStore.readHotTableLoadMetrics(),
          runtimeLoadLimits: stateStore.readHotTableRuntimeLoadLimits(),
        })
      : undefined;

  const operatorAlerts = new OperatorAlertDiffer(
    buildAlertScan({
      broker,
      workerHeartbeatMissedAfterMs: workerOfflineAfterSec * 1000,
      hotTableGrowth: currentHotTableGrowth(),
    }).alerts,
  );

  const currentOperatorSnapshot = (): OperatorSnapshotEvent => {
    return {
      summary: buildDashboardResponse({
        broker,
        workerOfflineAfterSec,
        getStaleReaperStatus,
        rateLimiter,
        workerRateLimiter,
        version: buildInfo.version,
        build: buildInfo.build,
        persistenceQueue: readPersistenceQueueDiagnostics(persistenceQueueDiagnosticsProvider),
      }),
      alerts: buildAlertScan({
        broker,
        workerHeartbeatMissedAfterMs: workerOfflineAfterSec * 1000,
        hotTableGrowth: currentHotTableGrowth(),
      }),
    };
  };

  const replayOperatorEvents = (afterSeq: number): BufferedOperatorEvent[] =>
    operatorEvents.replay(afterSeq);

  const currentOperatorReplayWindow = (): OperatorReplayWindow => operatorEvents.replayWindow();

  const subscribeToOperatorEvents = (
    listener: (event: BufferedOperatorEvent) => void,
  ): (() => void) => operatorEvents.subscribe(listener);

  const emitOperatorEvent = (event: OperatorEventName, data: OperatorEventPayload): void =>
    operatorEvents.emit(event, data);

  const publishOperatorEvents = (): void => {
    if (operatorEvents.listenerCount === 0) {
      // Do not run operator projections on every broker state change while
      // the SSE stream is idle. A new subscriber gets a fresh snapshot on
      // connect, and active subscribers still receive buffered updates.
      return;
    }

    const snapshot = currentOperatorSnapshot();
    emitOperatorEvent("operator-summary-update", {
      summary: snapshot.summary,
      alerts: snapshot.alerts,
    });

    publishOperatorAlertChanges(snapshot.alerts);
  };

  const publishOperatorAlertChanges = (alerts: AlertScanResult): void => {
    const { opened, resolved } = operatorAlerts.apply(alerts.alerts);
    for (const alert of opened) {
      emitOperatorEvent("operator-alert-opened", { alert });
    }
    for (const alert of resolved) {
      emitOperatorEvent("operator-alert-resolved", { alert });
    }
  };

  const unsubscribeBrokerState = broker.subscribeToState((change) => {
    if (suppressOperatorStateBroadcast) {
      return;
    }
    if (change.kind === "worker.heartbeat" && !change.materialChange) {
      return;
    }
    publishOperatorEvents();
  });

  if (staleReaperEnabled) {
    staleReaperTimer = setInterval(runStaleReaperSweep, staleReaperIntervalSec * 1000);
    // Reaper should never block process exit; tests and scripts expect clean shutdown.
    staleReaperTimer.unref?.();
  }

  // GitHub /a2a assign ingestion service — shared across the webhook endpoint and the bounded poller.
  const githubIngestion = new GitHubIngestionService({
    broker,
    defaultIntent: "analyze",
    requesterId: "github-ingestion",
  });

  // Bounded poller for periodic GitHub event fetch. Not started by default; the operator
  // may call `startPoller()` with a `fetchEvents` callback or start it externally.
  let boundedPoller: BoundedPoller | undefined;
  let pollerStarted = false;

  /**
   * Start the bounded poller with the given fetch function.
   * No-op if already started. Returns the poller instance.
   */
  function startPoller(fetchEvents: BoundedPoller["fetchEvents"]): BoundedPoller {
    if (pollerStarted && boundedPoller) return boundedPoller;
    boundedPoller = new BoundedPoller({
      ingestionService: githubIngestion,
      fetchEvents,
      label: "github-bounded-poller",
    });
    boundedPoller.start();
    pollerStarted = true;
    return boundedPoller;
  }

  /** Stop the bounded poller. Safe to call multiple times. */
  function stopPoller(): void {
    if (boundedPoller) {
      boundedPoller.stop();
      boundedPoller = undefined;
    }
    pollerStarted = false;
  }

  let httpServerForDiagnostics: Server | null = null;

  const assertWorkerHttpSignatureRoute = async (req: IncomingMessage, url: URL): Promise<A2AHttpSignatureVerifiedWorker | null> => {
    if (a2aHttpSignatureWorkerAuth === "off") {
      return null;
    }
    const hasSignatureHeaders = hasA2AHttpSignatureHeaders(req);
    if (!hasSignatureHeaders) {
      if (a2aHttpSignatureWorkerAuth === "strict") {
        throw new BrokerError("unauthorized", "a2a_signature_required: worker route requires A2A HTTP Signature");
      }
      return null;
    }

    const rawBody = await readRawBody(req);
    assertA2AContentDigestMatches(req, rawBody);
    const result = verifyA2AHttpSignature({
      method: req.method ?? "GET",
      authority: headerValue(req, "host") ?? url.host,
      path: url.pathname,
      query: url.search.length > 0 ? url.search.slice(1) : "",
      headers: requestHeadersForA2AHttpSignature(req),
      signatureInput: headerValue(req, "signature-input") ?? "",
      signature: headerValue(req, "signature"),
    }, a2aHttpSignatureKeyRegistry, { clockSkewSeconds: a2aSignatureClockSkewSeconds });

    if (!result.ok) {
      throw new BrokerError("unauthorized", `${result.code}: ${result.message}`);
    }
    if (result.brokerId !== brokerId) {
      throw new BrokerError("unauthorized", `a2a_signature_identity_mismatch: signed broker id ${result.brokerId} does not match ${brokerId}`);
    }
    if (!a2aHttpSignatureReplayCache.remember(result.keyid, result.nonce, result.expires)) {
      throw new BrokerError("unauthorized", "a2a_signature_replay: nonce has already been used for this key id");
    }
    const verifiedRecord = a2aHttpSignatureKeyRegistry[result.keyid];
    return {
      keyid: result.keyid,
      requesterId: result.requesterId,
      publicKeyPem: verifiedRecord
        ? createPublicKey({ key: verifiedRecord.publicKeyJwk, format: "jwk" }).export({ type: "spki", format: "pem" }).toString()
        : undefined,
      scopes: verifiedRecord?.scopes,
    };
  };

  const assertVerifiedWorkerMatches = (
    verified: A2AHttpSignatureVerifiedWorker | null,
    expectedWorkerId: string | undefined,
    operation: A2AWorkerRouteScope,
  ): void => {
    if (!verified) {
      return;
    }
    // Enforce the signing key's route scope first (fail closed), independent of
    // whether the route also carries an expected worker id to identity-match.
    assertA2AWorkerScopeAllowed(verified.scopes, operation);
    if (expectedWorkerId && verified.requesterId !== expectedWorkerId) {
      throw new BrokerError(
        "unauthorized",
        `a2a_signature_identity_mismatch: signed requester ${verified.requesterId} cannot authorize ${operation} for ${expectedWorkerId}`,
      );
    }
  };

  // Graceful drain (#1405): while draining, every response carries
  // `Connection: close` so keep-alive sockets end cleanly after their in-flight
  // response, and the two NEW-WORK routes (task poll + claim) are refused with
  // 503 broker_draining + Retry-After. Submission/lifecycle routes keep working
  // so in-flight worker results land before the process exits.
  let draining = false;
  const drainRetryAfterSec = 2;
  const isDrainRefusedRoute = (method: string | undefined, path: string, segments: string[]): boolean => {
    if (method === "GET" && path === "/tasks") return true;
    return method === "POST" && segments.length === 3 && segments[0] === "tasks" && segments[2] === "claim";
  };

  const handler: RequestListener<typeof IncomingMessage, typeof ServerResponse> = async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const path = url.pathname;
    const rawSegments = path.split("/").filter(Boolean);
    let requesterIdentity: RequesterIdentity | null = null;

    try {
      let segments: string[];
      try {
        segments = rawSegments.map((segment) => decodeURIComponent(segment));
      } catch {
        throw new BrokerError("bad_request", "invalid URL path encoding");
      }
      // Accept-side scheduling hook: tracks active count and handler duration.
      initSchedulingHook(req, res, classifyEndpointGroup(req.method, path, segments), classifyRequestRoute(req.method, path, segments));

      requesterIdentity = extractRequesterIdentity(req);
      const isPublicDiscoveryRoute = req.method === "GET" && path === "/.well-known/agent-card.json";
      const isPublicLivenessRoute = req.method === "GET" && path === "/livez";
      if (!isPublicLivenessRoute && !isPublicDiscoveryRoute) {
        assertEdgeSecret(req, edgeSecret);

        const bucket = classifyRateLimitBucket(req, url);
        const limiter = bucket === "worker" ? workerRateLimiter : rateLimiter;
        const decision = limiter.check(
          rateLimitKey(req, requesterIdentity, {
            trustedProxy,
          }),
        );
        applyRateLimitHeaders(res, decision, bucket);
        if (!decision.allowed) {
          res.setHeader("retry-after", String(decision.retryAfterSec));
          throw new BrokerError("rate_limited", "rate limit exceeded");
        }
      }

      if (draining) {
        res.setHeader("connection", "close");
        if (isDrainRefusedRoute(req.method, path, segments)) {
          res.setHeader("retry-after", String(drainRetryAfterSec));
          return sendJson(res, 503, {
            error: {
              code: "broker_draining",
              message: "broker is draining for shutdown; retry against the new instance",
            },
          });
        }
      }

      if (req.method === "GET" && path === "/livez") {
        const lifecycleTiming = readRequestLifecycleTiming(req);
        const handlerStartUnixMs = lifecycleTiming?.handlerStartUnixMs ?? Date.now();
        const t0 = performance.now();
        const eventLoopDelayMs = readEventLoopDelayMs();
        const gcDiag = readGcDiagnostics();
        const cpuDiag = readCpuDiagnostics();
        const t1 = performance.now();
        const diagDurationMs = Math.round((t1 - t0) * 1000) / 1000;
        const body: Record<string, unknown> = {
          ok: true,
          service: serviceName,
          brokerId,
          draining,
          uptimeSec: Math.round(process.uptime()),
          eventLoop: {
            delayMs: eventLoopDelayMs,
          },
          gc: gcDiag.count > 0 || gcDiag.totalMs > 0
            ? gcDiag
            : undefined,
          cpu: cpuDiag.percentSinceLastCheck >= 0
            ? {
                percentSinceLastCheck: cpuDiag.percentSinceLastCheck,
                deltaUserMicrosec: cpuDiag.deltaUserMicrosec,
                deltaSystemMicrosec: cpuDiag.deltaSystemMicrosec,
                deltaIntervalMs: cpuDiag.deltaIntervalMs,
              }
            : undefined,
          /**
           * O(1) in-memory gauge: number of handler executions currently in
           * flight.  Helps distinguish "event loop blocked by concurrent work"
           * from "process waiting for CPU scheduling."
           */
          activeRequests: _activeRequests,
          timing: null,
          diagMs: diagDurationMs,
        };
        const t2 = performance.now();
        const handlerElapsedMs = Math.round((t2 - t0) * 1000) / 1000;
        _livezTiming.record(handlerElapsedMs);
        // Per-request handler time lets external probes distinguish handler
        // work from accept/host-scheduler delay.
        body.requestDurationMs = handlerElapsedMs;
        body.probeTiming = {
          ...lifecycleTiming,
          handlerStartUnixMs,
          responsePreparedUnixMs: Date.now(),
          responsePreparationDurationMs: handlerElapsedMs,
        };
        body.timing = _livezTiming.snapshot();

        return sendJson(res, 200, body, {
          "cache-control": "no-store",
        });
      }

      if (req.method === "GET" && path === "/health") {
        const t0 = performance.now();
        const runtimeMemory = readRuntimeMemoryUsage();
        const { persistence, auditDiagnostics, hotTableGrowth, fromCache } = healthDiagnosticsCache.get(stateStore, {
          processMemory: {
            rssBytes: runtimeMemory.rssBytes,
            heapTotalBytes: runtimeMemory.heapTotalBytes,
            heapUsedBytes: runtimeMemory.heapUsedBytes,
            heapLimitBytes: runtimeMemory.heapLimitBytes,
          },
        });
        const t1 = performance.now();
        const persistenceDurationMs = Math.round((t1 - t0) * 100) / 100;

        const requestPressure = {
          general: rateLimiter.snapshot(),
          worker: workerRateLimiter.snapshot(),
        };
        const t2 = performance.now();
        const pressureDurationMs = Math.round((t2 - t1) * 100) / 100;

        // runtimeMemory already read above — avoid duplicate call.
        const heapUsedRatio =
          runtimeMemory.heapLimitBytes > 0
            ? runtimeMemory.heapUsedBytes / runtimeMemory.heapLimitBytes
            : 0;
        const eventLoopDelayMs = readEventLoopDelayMs();
        const persistenceQueue = readPersistenceQueueDiagnostics(persistenceQueueDiagnosticsProvider);

        const body: Record<string, unknown> = {
          ok: true,
          service: serviceName,
          brokerId,
          version: buildInfo.version,
          build: buildInfo.build,
          publicBaseUrl,
          uptimeSec: Math.round(process.uptime()),
          runtimeMemory: {
            ...runtimeMemory,
            heapUsedRatio: Math.round(heapUsedRatio * 1000) / 1000,
            eventLoopDelayMs: eventLoopDelayMs ?? null,
          },
          persistence,
          persistenceQueue,
          workerHeartbeatPersistence,
          ...(auditDiagnostics !== undefined ? { auditDiagnostics } : {}),
          ...(hotTableGrowth !== undefined ? { hotTableGrowth } : {}),
          workers: {
            offlineAfterSec: workerOfflineAfterSec,
          },
          staleReaper: getStaleReaperStatus(),
          requestSecurity: {
            enforceRequesterIdentity,
            edgeSecretRequired: Boolean(edgeSecret),
            a2aHttpSignatureWorkerAuth,
            a2aHttpSignatureWorkerKeyCount: Object.keys(a2aHttpSignatureKeyRegistry).length,
            a2aHttpSignatureWorkerKeySource,
            rateLimitWindowSec,
            rateLimitMaxRequests,
            workerRateLimitWindowSec,
            workerRateLimitMaxRequests,
            trustedProxy,
          },
          requestPressure,
          retentionPolicy,
          maxSnapshotBytes,
          ...(stateStore instanceof SqliteBrokerStateStore
            ? {
                terminalOutboxDiagnostics: stateStore.readHotTerminalOutboxDiagnostics(),
              }
            : {}),
        };

        if (heapUsedRatio > 0.85) {
          body.ok = false;
          body.error = `heap pressure critical: ${Math.round(heapUsedRatio * 100)}% used`;
        } else if (heapUsedRatio > 0.70) {
          body.warning = `heap pressure elevated: ${Math.round(heapUsedRatio * 100)}% used`;
        }
        const t3 = performance.now();
        const jsonDurationMs = Math.round((t3 - t2) * 100) / 100;
        const totalDurationMs = Math.round((t3 - t0) * 100) / 100;
        _healthTiming.record(totalDurationMs);

        if (hotTableGrowth && hotTableGrowth.overallSeverity === "critical") {
          body.ok = false;
          const crit = hotTableGrowth.warnings.filter((w) => w.startsWith("CRITICAL"));
          body.error = `hot-table growth critical: ${truncateMessage(crit.join("; "), 500) || "one or more tables near stability limits"}`;
        } else if (hotTableGrowth && hotTableGrowth.overallSeverity === "warning") {
          const existing = body.warning ? `${body.warning}; ` : "";
          const warns = hotTableGrowth.warnings.filter((w) => w.startsWith("WARNING"));
          body.warning = `${existing}hot-table growth warning: ${truncateMessage(warns.join("; "), 500) || "growth approaching stability limits"}`;
        }

        if (workerHeartbeatPersistence.warning) {
          const existing = body.warning ? `${body.warning}; ` : "";
          body.warning = `${existing}${workerHeartbeatPersistence.warning}`;
        }

        body.timing = {
          totalMs: totalDurationMs,
          persistenceMs: persistenceDurationMs,
          pressureMs: pressureDurationMs,
          jsonMs: jsonDurationMs,
          fromCache,
        };

        return sendJson(res, 200, body, {
          "cache-control": "no-store",
        });
      }

      if (req.method === "GET" && path === "/.well-known/agent-card.json") {
        return sendJson(res, 200, agentCard, {
          "cache-control": "public, max-age=300",
        });
      }

      if (await handleA2AJsonRpcRouteIfMatched({
        method: req.method,
        path,
        req,
        res,
        broker,
        agentCard,
        publicBaseUrl,
        requesterIdentity,
        enforceRequesterIdentity,
        peerStatusService,
        pushNotificationConfigStore,
        persistPushNotificationConfigs,
        defaultAgentNodeId,
        taskSubscribeHeartbeatSec,
      })) {
        return;
      }

      if (await handleComplexityOrchestrationRoutesIfMatched({
        method: req.method,
        path,
        req,
        res,
        enforceRequesterIdentity,
        requesterIdentity,
      })) {
        return;
      }

      if (await handleWavePlanRoutesIfMatched({
        method: req.method,
        path,
        req,
        res,
        broker,
        stateStore,
        enforceRequesterIdentity,
        requesterIdentity,
      })) {
        return;
      }

      if (await handleA2ATaskStreamRouteIfMatched({
        method: req.method,
        segments,
        req,
        res,
        url,
        broker,
        enforceRequesterIdentity,
        requesterIdentity,
        taskSubscribeHeartbeatSec,
        assertWorkerHttpSignatureRoute,
        assertVerifiedWorkerMatches,
      })) {
        return;
      }

      if (await handleA2ATerminalOutboxRouteIfMatched({
        method: req.method,
        path,
        req,
        res,
        url,
        broker,
        stateStore,
        enforceRequesterIdentity,
        requesterIdentity,
        crossBrokerTrustAnchors,
        crossBrokerNonceCache,
      })) {
        return;
      }

      if (handleA2AStreamRouteIfMatched({
        method: req.method,
        path,
        req,
        res,
        broker,
        enforceRequesterIdentity,
        requesterIdentity,
        taskSubscribeHeartbeatSec,
        currentOperatorSnapshot,
        replayOperatorEvents,
        subscribeToOperatorEvents,
        currentOperatorReplayWindow,
      })) {
        return;
      }

      if (handleOperatorDashboardRouteIfMatched({
        method: req.method,
        path,
        res,
        url,
        broker,
        stateStore,
        brokerId,
        workerOfflineAfterSec,
        getStaleReaperStatus,
        rateLimiter,
        workerRateLimiter,
        buildInfo,
        persistenceQueueDiagnosticsProvider,
        enforceRequesterIdentity,
        requesterIdentity,
      })) {
        return;
      }

      if (handleOperatorReportingReadRouteIfMatched({
        method: req.method,
        path,
        res,
        url,
        broker,
        stateStore,
        enforceRequesterIdentity,
        requesterIdentity,
      })) {
        return;
      }

      if (await handleTerminalBriefCloseoutRoutesIfMatched({
        method: req.method,
        path,
        req,
        res,
        url,
        enforceRequesterIdentity,
        requesterIdentity,
      })) {
        return;
      }

      if (req.method === "POST" && path.startsWith("/terminal-brief/sidecar/")) {
        const sidecarRoute = TERMINAL_BRIEF_SIDECAR_ROUTES.get(
          path.slice("/terminal-brief/sidecar/".length),
        );
        if (sidecarRoute) {
          if (enforceRequesterIdentity) {
            assertRequesterHasRole(requesterIdentity, ["hub", "operator"], sidecarRoute.scope);
          }
          const body = await readJson<Record<string, unknown>>(req);
          const report = sidecarRoute.project(body);
          return sendJson(res, 200, report, {
            "cache-control": "no-store",
          });
        }
      }

      if (await handleOperatorCleanupRouteIfMatched({
        method: req.method,
        path,
        req,
        res,
        url,
        stateStore,
        enforceRequesterIdentity,
        requesterIdentity,
      })) {
        return;
      }

      // GET /alerts — monitoring-friendly alert projection
      if (handleOperatorDiagnosticsReadRouteIfMatched({
        method: req.method,
        path,
        res,
        url,
        broker,
        stateStore,
        workerOfflineAfterMs: workerOfflineAfterSec * 1000,
        enforceRequesterIdentity,
        requesterIdentity,
      })) {
        return;
      }

      if (handleWorkersReadRouteIfMatched({
        method: req.method,
        path,
        segments,
        res,
        url,
        stateStore,
        broker,
        workerOfflineAfterMs: workerOfflineAfterSec * 1000,
      })) {
        return;
      }

      if (await handleWorkersWriteRouteIfMatched({
        method: req.method,
        path,
        segments,
        req,
        res,
        url,
        broker,
        stateStore,
        brokerId,
        workerOfflineAfterMs: workerOfflineAfterSec * 1000,
        enforceRequesterIdentity,
        requesterIdentity,
        assertWorkerHttpSignatureRoute,
        assertVerifiedWorkerMatches,
      })) {
        return;
      }

      if (await handleExchangeRoutesIfMatched({
        method: req.method,
        path,
        segments,
        req,
        res,
        url,
        stateStore,
        broker,
        enforceRequesterIdentity,
        requesterIdentity,
      })) {
        return;
      }

      if (handleProposalsReadRouteIfMatched({
        method: req.method,
        path,
        segments,
        res,
        url,
        stateStore,
        broker,
      })) {
        return;
      }

      if (await handleProposalsWriteRouteIfMatched({
        method: req.method,
        path,
        segments,
        req,
        res,
        broker,
        stateStore,
        enforceRequesterIdentity,
        requesterIdentity,
      })) {
        return;
      }

      if (handleRoundStatusRouteIfMatched({ method: req.method, segments, res, broker })) {
        return;
      }

      if (handleTaskStatsRouteIfMatched({ method: req.method, path, res, url, broker, stateStore })) {
        return;
      }


      if (await handleTasksCollectionRouteIfMatched({
        method: req.method,
        path,
        req,
        res,
        url,
        broker,
        stateStore,
        enforceRequesterIdentity,
        requesterIdentity,
        maxTaskPayloadBytes,
        workerOfflineAfterSec,
        liveApprovalSigningKey,
        brokerId,
        assertWorkerHttpSignatureRoute,
        assertVerifiedWorkerMatches,
      })) {
        return;
      }

      if (
        req.method === "GET" &&
        segments[0] === "tasks" &&
        segments[1] &&
        segments[2] === "decision-dialectic" &&
        segments.length === 3
      ) {
        const task = broker.getTask(segments[1]);
        if (!task) {
          throw new BrokerError("not_found", "task not found");
        }
        try {
          const readModel = projectDecisionDialecticReadModel(task);
          return sendJson(res, 200, readModel);
        } catch (error) {
          if (error instanceof DecisionDialecticReadModelError) {
            const code = error.code === "missing_contract" || error.code === "wrong_kind" ? "not_found" : "bad_request";
            throw new BrokerError(code, error.message);
          }
          throw error;
        }
      }

      if (
        req.method === "POST" &&
        segments[0] === "tasks" &&
        segments[1] &&
        segments[2] === "decision-dialectic" &&
        segments[3] === "advance" &&
        segments.length === 4
      ) {
        const body = (await readJson<{ id?: string; phase?: DecisionDialecticPhase }>(req)) ?? {};
        if (enforceRequesterIdentity) {
          assertRequesterHasRole(requesterIdentity, ["hub", "operator"], "decision-dialectic.advance");
        }
        const task = broker.getTask(segments[1]);
        if (!task) {
          throw new BrokerError("not_found", "task not found");
        }
        try {
          const { phase, request } = buildDecisionDialecticPhaseTaskRequest(task, {
            id: body.id,
            phase: body.phase,
            requesterId: requesterIdentity?.id,
          });
          const childTask = broker.createTask(request);
          await awaitDurablePersistenceAck(stateStore);
          return sendJson(res, 201, {
            phase,
            parentTaskId: task.id,
            childTask,
          });
        } catch (error) {
          if (error instanceof DecisionDialecticExecutionError) {
            const code =
              error.code === "missing_contract" || error.code === "wrong_kind"
                ? "not_found"
                : "bad_request";
            throw new BrokerError(code, error.message);
          }
          throw error;
        }
      }

      if (
        req.method === "POST" &&
        segments[0] === "tasks" &&
        segments[1] &&
        segments[2] === "decision-dialectic" &&
        segments[3] === "patch" &&
        segments.length === 4
      ) {
        const body = await readJson<DecisionDialecticPatchV1>(req);
        if (!body) {
          throw new BrokerError("bad_request", "request body is required");
        }
        if (enforceRequesterIdentity) {
          const requesterRole = requesterIdentity?.role;
          if (requesterRole === "hub" || requesterRole === "operator") {
            assertRequesterHasRole(requesterIdentity, ["hub", "operator"], "decision-dialectic.patch");
          } else {
            assertRequesterMatchesParty(requesterIdentity, { id: body.authorAgent }, "decision-dialectic.patch");
          }
        }
        const task = broker.getTask(segments[1]);
        if (!task) {
          throw new BrokerError("not_found", "task not found");
        }
        try {
          const input = extractDecisionDialecticTaskInput(task.payload);
          const updatedTask = applyDecisionDialecticPatch(input.contract.task, body);
          const nextPhase = nextDecisionDialecticPhase(updatedTask) ?? input.contract.phase;
          const updated = broker.updateTaskPayload(
            task.id,
            {
              ...task.payload,
              contract: {
                ...input.contract,
                phase: nextPhase,
                task: updatedTask,
              },
            },
            {
              actor: {
                id: requesterIdentity?.id ?? body.authorAgent,
                kind: "node",
                role: requesterIdentity?.role,
              },
              note: "decision.dialectic patch " + body.op,
            },
          );
          await awaitDurablePersistenceAck(stateStore);
          const readModel = projectDecisionDialecticReadModel(updated);
          return sendJson(res, 200, readModel);
        } catch (error) {
          if (error instanceof DecisionDialecticExecutionError) {
            const code =
              error.code === "missing_contract" || error.code === "wrong_kind"
                ? "not_found"
                : error.code === "invalid_contract"
                  ? "bad_request"
                  : "invalid_transition";
            throw new BrokerError(code, error.message);
          }
          throw error;
        }
      }

      if (
        req.method === "GET" &&
        segments[0] === "tasks" &&
        segments[1] &&
        segments[2] === "trading-dialectic" &&
        segments.length === 3
      ) {
        const task = broker.getTask(segments[1]);
        if (!task) {
          throw new BrokerError("not_found", "task not found");
        }
        try {
          const readModel = projectTradingDialecticReadModel(task);
          return sendJson(res, 200, readModel);
        } catch (error) {
          if (error instanceof TradingDialecticReadModelError) {
            const code = error.code === "missing_contract" || error.code === "wrong_kind" ? "not_found" : "bad_request";
            throw new BrokerError(code, error.message);
          }
          throw error;
        }
      }

      // GET /tasks/diagnostics — bulk diagnostic scan (MUST come before /tasks/:id)
      if (handleTasksReadRouteIfMatched({
        method: req.method,
        path,
        segments,
        res,
        url,
        broker,
        stateStore,
      })) {
        return;
      }

      if (await handleTasksWakeRouteIfMatched({
        method: req.method,
        segments,
        req,
        res,
        broker,
        stateStore,
        enforceRequesterIdentity,
        requesterIdentity,
      })) {
        return;
      }

      if (await handleTasksDecisionRouteIfMatched({
        method: req.method,
        segments,
        req,
        res,
        broker,
        stateStore,
        enforceRequesterIdentity,
        requesterIdentity,
      })) {
        return;
      }

      if (await handleTasksWorkerRouteIfMatched({
        method: req.method,
        segments,
        req,
        res,
        url,
        broker,
        stateStore,
        enforceRequesterIdentity,
        requesterIdentity,
        assertWorkerHttpSignatureRoute,
        assertVerifiedWorkerMatches,
        resultProvenanceBrokerSigner: signingKeyPem
          ? {
              privateKeyPem: signingKeyPem,
              brokerKeyId: agentCardSigningKid ?? brokerId,
            }
          : undefined,
        resultProvenanceCountersign,
      })) {
        return;
      }


      if (handleAuditReadRouteIfMatched({ method: req.method, path, res, url, broker, stateStore })) {
        return;
      }

      // -----------------------------------------------------------------------
      // GitHub /a2a assign ingestion endpoint
      // -----------------------------------------------------------------------
      if (await handleGitHubRouteIfMatched({
        method: req.method,
        path,
        req,
        res,
        githubIngestion,
        githubWebhookSecret,
        boundedPoller,
      })) {
        return;
      }

      // GET /schedz - host/process/container scheduling attribution (#1032)
      // Off /livez path, O(1), no DB, no cache. Includes cgroup CPU
      // throttling counters and PSI for container-level scheduling
      // attribution (helps distinguish handler work from descheduling).
      if (req.method === "GET" && path === "/schedz") {
        const hostLoad = readHostLoadSnapshot();
        const schedTiming = _schedulingTimingWindow.snapshot();
        const cgroupCpu = readCgroupCpuSnapshot();
        const psi = readCgroupPsiSnapshot();
        const connDuration = _connectionDurationWindow.snapshot();
        const firstReqLat = _firstRequestLatencyWindow.snapshot();
        const flushGap = _flushFinishGapWindow.snapshot();
        const handlerBodyTiming = _handlerBodyWindow.snapshot();
        const totalRequests = _requestsOnNewConnection + _requestsOnReusedConnection;

        // Reuse-breakdown snapshots
        const freshSocketAge = _freshSocketAgeBeforeHandlerWindow.snapshot();
        const freshSocketAcceptToReq = _freshSocketAcceptedToHttpRequestEventWindow.snapshot();
        const reusedSocketIdle = _reusedSocketIdleBeforeHttpRequestEventWindow.snapshot();
        const reusedSocketAge = _reusedSocketAgeBeforeHandlerWindow.snapshot();
        const reusedSocketHttpReqEventToHandler = _reusedSocketHttpRequestEventToHandlerStartWindow.snapshot();
        const reusedSocketIdleBeforeData = _reusedSocketIdleBeforeDataWindow.snapshot();
        const reusedSocketDataToReqEvent = _reusedSocketFirstDataToHttpRequestEventWindow.snapshot();

        // Combined perRequest snapshots
        const aggSocketAgeBeforeHandler = _socketAgeBeforeHandlerWindow.snapshot();
        const aggSocketIdleBeforeRequest = _socketIdleBeforeRequestWindow.snapshot();
        const aggSocketAcceptToReqEvent = _socketAcceptedToHttpRequestEventWindow.snapshot();
        const aggHttpReqEventToHandler = _httpRequestEventToHandlerStartWindow.snapshot();
        const aggSocketIdleBeforeHttpReqEvent = _socketIdleBeforeHttpRequestEventWindow.snapshot();
        const aggClientProbeToHandler = _clientProbeStartToHandlerStartWindow.snapshot();
        const aggClientProbeToSocket = _clientProbeStartToSocketConnectedWindow.snapshot();
        const aggClientProbeToHttpReqEvent = _clientProbeStartToHttpRequestEventWindow.snapshot();
        const aggSocketConnectedToFirstData = _socketConnectedToFirstDataWindow.snapshot();
        const aggFirstDataToHttpRequestEvent = _firstDataToHttpRequestEventWindow.snapshot();

        // Fresh-connection breakdown for connected→firstData and firstData→request
        const freshSocketConnectedToFirstData = _freshSocketConnectedToFirstDataWindow.snapshot();
        const freshSocketFirstDataToReq = _freshSocketFirstDataToHttpRequestEventWindow.snapshot();
        const freshSocketHttpReqEventToHandler = _freshSocketHttpRequestEventToHandlerStartWindow.snapshot();

        // Operator gate: pre-classify stall type from aggregate evidence
        const operatorGate = computeReusedSocketGate({
          freshSocketAge,
          freshSocketAcceptToReq,
          freshHttpReqEventToHandler: freshSocketHttpReqEventToHandler,
          freshSocketConnectedToFirstData: freshSocketConnectedToFirstData,
          freshSocketFirstDataToReq: freshSocketFirstDataToReq,
          reusedSocketIdle,
          aggHttpReqEventToHandler: aggHttpReqEventToHandler,
          aggClientProbeToHttpReqEvent: aggClientProbeToHttpReqEvent,
          aggSocketIdleBeforeHttpReqEvent: aggSocketIdleBeforeHttpReqEvent,
          aggSocketAgeBeforeHandler: aggSocketAgeBeforeHandler,
          reusedSocketAge,
          reusedSocketHttpReqEventToHandler,
          reusedSocketIdleBeforeData,
          reusedSocketDataToReqEvent,
        });

        return sendJson(res, 200, {
          ok: true,
          service: serviceName,
          brokerId,
          totalAccepted: _totalAcceptedRequests,
          activeRequests: _activeRequests,
          host: hostLoad,
          schedulingTiming: schedTiming,
          endpointTiming: endpointTimingSnapshot(),
          endpointActive: endpointActiveSnapshot(),
          endpointHandlerBodyTiming: endpointHandlerBodySnapshot(),
          requestRoutes: requestRouteSnapshot(),
          routeHandlerBodyTiming: routeHandlerBodySnapshot(),
          persistenceQueue: readPersistenceQueueDiagnostics(persistenceQueueDiagnosticsProvider),
          workerHeartbeatPersistence,
          terminalOutbox: summarizeTerminalOutboxForSchedz(broker.getTerminalTaskEventOutbox()),
          workerHeartbeatPhases: workerHeartbeatPhaseTimingSnapshot(),
          workerRegisterPhases: workerRegisterPhaseTimingSnapshot(),
          perWorkerHeartbeatPhases: workerHeartbeatPhasePerWorkerSnapshot(),
          perWorkerRegisterPhases: workerRegisterPhasePerWorkerSnapshot(),
          container: {
            cgroup: cgroupCpu.stats ? {
              cpu: cgroupCpu.stats,
              cpuLimit: cgroupCpu.limit,
              cpuDelta: cgroupCpu.delta,
            } : null,
            psi,
            runtime: buildInfo.build?.runtime ?? null,
          },
          connections: {
            totalConnections: _totalConnections,
            activeConnections: _activeConnections,
            peakConnections: _peakConnections,
            connectionDurationMs: connDuration,
            httpServer: readHttpServerDiagnostics(httpServerForDiagnostics),
          },
          perRequest: {
            onNewConnection: _requestsOnNewConnection,
            onReusedConnection: _requestsOnReusedConnection,
            totalSamples: totalRequests,
            firstRequestLatencyMs: firstReqLat,
            handlerMs: handlerBodyTiming,
            socketAgeBeforeHandlerMs: aggSocketAgeBeforeHandler,
            socketIdleBeforeRequestMs: aggSocketIdleBeforeRequest,
            socketAcceptedToHttpRequestEventMs: aggSocketAcceptToReqEvent,
            httpRequestEventToHandlerStartMs: aggHttpReqEventToHandler,
            socketIdleBeforeHttpRequestEventMs: aggSocketIdleBeforeHttpReqEvent,
            clientProbeStartToHandlerStartMs: aggClientProbeToHandler,
            clientProbeStartToSocketConnectedMs: aggClientProbeToSocket,
            clientProbeStartToHttpRequestEventMs: aggClientProbeToHttpReqEvent,
            socketConnectedToFirstDataMs: aggSocketConnectedToFirstData,
            firstDataToHttpRequestEventMs: aggFirstDataToHttpRequestEvent,
            byConnectionReuse: {
              fresh: {
                socketAgeBeforeHandlerMs: freshSocketAge,
                socketAcceptedToHttpRequestEventMs: freshSocketAcceptToReq,
                socketConnectedToFirstDataMs: freshSocketConnectedToFirstData,
                firstDataToHttpRequestEventMs: freshSocketFirstDataToReq,
                httpRequestEventToHandlerStartMs: freshSocketHttpReqEventToHandler,
              },
              reused: {
                socketAgeBeforeHandlerMs: reusedSocketAge,
                socketIdleBeforeHttpRequestEventMs: reusedSocketIdle,
                httpRequestEventToHandlerStartMs: reusedSocketHttpReqEventToHandler,
                idleBeforeDataMs: reusedSocketIdleBeforeData,
                dataToHttpRequestEventMs: reusedSocketDataToReqEvent,
              },
            },
          },
          operatorGate,
          flushing: {
            handlerToFinishGapMs: flushGap,
          },
          probeBursts: readProbeBursts(),
        }, {
          "cache-control": "no-store",
        });
      }

      throw new BrokerError("not_found", "not found");
    } catch (error) {
      if (!(error instanceof BrokerError)) {
        // Unexpected (non-BrokerError) exceptions are otherwise mapped to a fixed
        // internal_error 500 with no server-side trace, which made a fleet-wide
        // intermittent worker-heartbeat 500 undiagnosable from broker container
        // logs alone. Log the route and stack so future occurrences are visible
        // in `docker logs`; response body/status are unchanged.
        console.error(`[a2a-broker] unhandled error on ${req.method} ${path}:`, error);
      }
      return sendError(res, error);
    }
  };

  const server = createServer(handler);
  httpServerForDiagnostics = server;

  // Configure keepAliveTimeout to exceed the heartbeat interval so worker heartbeat
  // TCP connections survive between beats and can be reused. The Node.js default is
  // 5000ms, which forces every heartbeat (default 30s interval) to open a new
  // connection, contributing to TCP accept queue buildup and first-request latency
  // spikes documented in #1032.
  server.keepAliveTimeout = options.keepAliveTimeoutMs ??
    resolveIntegerOption(
      undefined,
      process.env.A2A_SERVER_KEEPALIVE_TIMEOUT_MS,
      DEFAULT_KEEPALIVE_TIMEOUT_MS,
    );
  // headersTimeout must exceed keepAliveTimeout per Node.js runtime enforcement.
  server.headersTimeout = options.headersTimeoutMs ??
    resolveIntegerOption(
      undefined,
      process.env.A2A_SERVER_HEADERS_TIMEOUT_MS,
      server.keepAliveTimeout + HEADERS_TIMEOUT_MARGIN_MS,
    );

  // Stamp the Node HTTP request event before the main handler listener runs.
  server.prependListener("request", markHttpRequestEvent);
  // Wire TCP connection tracking for scheduling attribution diagnostics.
  server.on("connection", (socket: import("node:net").Socket) => {
    trackServerConnection(socket);
  });
  // When the HTTP server closes, ensure the reaper timer is cleaned up. This matters for
  // tests and for any runtime that shuts down via server.close() rather than the SIGINT
  // path in startBrokerServer.
  server.on("close", () => {
    stopStaleReaper();
    stopPoller();
    defaultAgentHandle?.stop();
    unsubscribeBrokerState();
    unsubscribePushNotificationPruneListener?.();
    unsubscribePushNotificationSnapshotExtension?.();
    void closeWorkerPersistence().catch((error) => {
      console.error("[a2a-broker] worker-thread persistence shutdown failed:", error);
    });
  });

  return {
    server,
    handler,
    broker,
    beginDrain: () => {
      if (draining) return;
      draining = true;
      console.log("[a2a-broker] drain started: refusing new poll/claim work, closing idle connections");
      server.closeIdleConnections?.();
    },
    isDraining: () => draining,
    runStaleReaperSweep,
    stopStaleReaper,
    getStaleReaperStatus,
    githubIngestion,
    get boundedPoller(): BoundedPoller | undefined {
      return boundedPoller;
    },
    stopPoller,
    closeWorkerPersistence,
    config: {
      host,
      port,
      serviceName,
      publicBaseUrl,
      stateFile,
      ...(sqliteFile ? { sqliteFile } : {}),
      persistenceBackend,
      ...(persistenceBackend === "sqlite" ? { sqliteLoadSource } : {}),
      workerOfflineAfterSec,
      workerHeartbeatPersistIntervalMs,
      rateLimitWindowSec,
      rateLimitMaxRequests,
      workerRateLimitWindowSec,
      workerRateLimitMaxRequests,
      enforceRequesterIdentity,
      edgeSecret,
      a2aHttpSignatureWorkerAuth,
      a2aHttpSignatureWorkerKeyCount: Object.keys(a2aHttpSignatureKeyRegistry).length,
      a2aHttpSignatureWorkerKeySource,
      retentionPolicy,
      maxSnapshotBytes,
      maxHotRuntimeNonTerminalTasks,
      maxHotRuntimeTerminalTasks,
      maxHotRuntimeAuditEvents,
      maxHotRuntimeHeartbeatAuditEvents,
      maxHotRuntimeTerminalOutboxEvents,
      trustedProxy,
      staleReaperEnabled,
      staleReaperIntervalSec,
      staleReaperOlderThanSec,
      waveStaleAfterSec,
      maxRequeueAttempts,
      taskSubscribeHeartbeatSec,
      peerStatusEnabled,
      brokerId,
      version: buildInfo.version,
      build: buildInfo.build,
    },
  };
}

export function startBrokerServer(options: BrokerServerOptions = {}): BrokerServerRuntime {
  return startBrokerServerWithFactory(createBrokerServer, options);
}

if (import.meta.url === new URL(process.argv[1] ?? "", "file://").href) {
  startBrokerServer();
}

/**
 * Resolve the first non-empty (after trimming) value from a precedence list.
 *
 * Plain `a ?? b` treats an empty string as "set", so a blank primary env var
 * (GITHUB_WEBHOOK_SECRET=) would shadow a configured compatibility alias
 * (A2A_GITHUB_WEBHOOK_SECRET=secret) and silently disable signature
 * verification — a fail-open. Trimming and skipping blanks closes that gap.
 */

// HTTP/SSE plumbing, error mapping, and streaming response helpers extracted to
// ./http/* (issue #645 phase 2). They take all state via explicit parameters and
// are imported at the top of this file.
