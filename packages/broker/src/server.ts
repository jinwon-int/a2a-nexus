import { readFileSync } from "node:fs";
import { readPersistenceQueueDiagnostics } from "./persistence-queue-diagnostics.js";
import { summarizeTerminalOutboxForSchedz } from "./terminal-outbox-schedz.js";
import { createDefaultStateStore, resolvePublicBaseUrl, firstNonEmpty } from "./server-config.js";
// Re-exported to preserve the public surface (tests import firstNonEmpty from here).
export { firstNonEmpty };
import {
  resolveA2AHttpSignatureWorkerAuthMode,
  validateBrokerStartupSecurity,
} from "./startup-security.js";
import {
  optionalString,
  assertCreateTaskRequestParties,
  parseTerminalOutboxAckReceipt,
  parseTerminalOutboxReceiptUpdate,
  assertRequesterCanSubscribeToWorkerAssignments,
} from "./request-parsers.js";
import {
  listAuditEventsForReadPath,
  assertCreateTaskPayloadWithinLimit,
  listTasksForReadPath,
  listTaskItemsForReadPath,
  getTaskForReadPath,
  getTaskDiagnosticsForReadPath,
  listTaskDiagnosticsForReadPath,
  mapBrokerDiagnosticsToSnapshot,
} from "./task-read-paths.js";
import {
  numberQueryParam,
  boundedLimitQueryParam,
  booleanQueryParam,
  cleanupPlanOptionsFromUrl,
  cleanupPlanOptionsFromBody,
  stringListQueryParam,
  nonNegativeNumberBodyField,
  stringListBodyField,
} from "./http/request-params.js";
import { createServer, type IncomingMessage, type RequestListener, type Server, type ServerResponse } from "node:http";
import { loadavg, cpus } from "node:os";
import { readRuntimeMemoryUsage, readEventLoopDelayMs, readGcDiagnostics, readCpuDiagnostics } from "./diagnostics/system-metrics.js";
import { RequestTimingWindow, type RequestTimingSnapshot } from "./diagnostics/request-timing-window.js";
import { computeReusedSocketGate } from "./diagnostics/reused-socket-gate.js";
import { resolveBrokerBuildInfo } from "./broker-build-info.js";
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
import { loadCrossBrokerTrustAnchors, verifyCrossBrokerSenderProof, CrossBrokerNonceCache } from "./a2a/cross-broker-sender-proof.js";
import { startDefaultAgent, DEFAULT_AGENT_NODE_ID, type DefaultAgentHandle } from "./a2a/default-agent.js";
import { executeA2AJsonRpcBody, executeSendMessage, jsonRpcErrorFromUnknown, specSendResult } from "./a2a/json-rpc.js";
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
  assertGitHubWebhookSignature,
  assertA2AWorkerScopeAllowed,
  assertRequesterCanSubscribeToTask,
  assertRequesterHasRole,
  assertRequesterCanTouchProposalArtifacts,
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
  recordWorkerRegisterPhase,
  workerRegisterPhaseTimingSnapshot,
  workerRegisterPhasePerWorkerSnapshot,
  recordWorkerHeartbeatPhase,
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
  ApplyProposalRequest,
  AttachArtifactRequest,
  CreateProposalRequest,
  CreateTaskRequest,
  ProposalActorRequest,
  ProposalKind,
  ProposalStatus,
  RegisterWorkerRequest,
  SubmitValidationRequest,
  TaskApprovalRequest,
  TaskApprovalTerminalRequest,
  TaskCancelRequest,
  TaskClaimRequest,
  TaskCompleteRequest,
  TaskDiagnosticReport,
  TaskEvidenceRequest,
  TaskFailRequest,
  TaskKind,
  TaskListFilters,
  TaskOrigin,
  TaskReassignRequest,
  TaskRecord,
  TaskStatus,
  TaskTombstone,
  TaskWakeDecisionRequest,
  TaskWakePlanRequest,
  WorkerHeartbeatRequest,
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
import { buildOperatorTaskReport } from "./core/operator-task-report.js";
import { buildReleaseEvidenceExport } from "./core/release-evidence.js";
import {
  buildTerminalBriefSidecarDryRunGate,
  extractTerminalBriefSidecarDryRunGateFinalizerStatus,
  extractTerminalBriefSidecarDryRunGateRehearsal,
  extractTerminalBriefSidecarDryRunOperatingEvidence,
} from "./core/terminal-brief-sidecar-dry-run-gate.js";
import {
  buildTerminalBriefSidecarActivationApproval,
  extractTerminalBriefSidecarActivationApprovalGate,
  extractTerminalBriefSidecarActivationApprovalOptions,
} from "./core/terminal-brief-sidecar-activation-approval.js";
import {
  buildTerminalBriefSidecarActivationReceiptIngestor,
  extractTerminalBriefSidecarActivationApprovalPacket,
  extractTerminalBriefSidecarActivationReceiptEvidence,
} from "./core/terminal-brief-sidecar-activation-receipt-ingestor.js";
import {
  buildTerminalBriefSidecarStartExecutorGate,
  extractTerminalBriefSidecarStartExecutorGateOptions,
  extractTerminalBriefSidecarStartExecutorGateReceipt,
} from "./core/terminal-brief-sidecar-start-executor-gate.js";
import {
  buildTerminalBriefSidecarExecutorInvocationRehearsal,
  extractTerminalBriefSidecarExecutorInvocationRehearsalGate,
  extractTerminalBriefSidecarExecutorInvocationRehearsalOptions,
} from "./core/terminal-brief-sidecar-executor-invocation-rehearsal.js";
import {
  buildTerminalBriefSidecarRuntimePreflightApproval,
  extractTerminalBriefSidecarRuntimePreflightApprovalOptions,
  extractTerminalBriefSidecarRuntimePreflightApprovalRehearsal,
} from "./core/terminal-brief-sidecar-runtime-preflight-approval.js";
import {
  buildTerminalBriefSidecarAdapterHandoffApproval,
  extractTerminalBriefSidecarAdapterHandoffApprovalOptions,
  extractTerminalBriefSidecarAdapterHandoffApprovalPacket,
} from "./core/terminal-brief-sidecar-adapter-handoff-approval.js";
import {
  buildTerminalBriefSidecarOperatorReviewTable,
  extractTerminalBriefSidecarOperatorReviewTableHandoff,
  extractTerminalBriefSidecarOperatorReviewTableOptions,
} from "./core/terminal-brief-sidecar-operator-review-table.js";
import {
  buildTerminalBriefSidecarReviewDecisionIngestor,
  extractTerminalBriefSidecarReviewDecisionEvidence,
  extractTerminalBriefSidecarReviewDecisionIngestorOptions,
  extractTerminalBriefSidecarReviewDecisionIngestorTable,
} from "./core/terminal-brief-sidecar-review-decision-ingestor.js";
import {
  buildTerminalBriefSidecarApprovalGrantProposal,
  extractTerminalBriefSidecarApprovalGrantProposalOptions,
  extractTerminalBriefSidecarApprovalGrantProposalReviewDecision,
} from "./core/terminal-brief-sidecar-approval-grant-proposal.js";
import {
  buildTerminalBriefSidecarApprovalGrantEvidenceIngestor,
  extractTerminalBriefSidecarApprovalGrantEvidence,
  extractTerminalBriefSidecarApprovalGrantEvidenceIngestorOptions,
  extractTerminalBriefSidecarApprovalGrantEvidenceIngestorProposal,
} from "./core/terminal-brief-sidecar-approval-grant-evidence-ingestor.js";
import {
  buildTerminalBriefSidecarExecutionGateFinalReview,
  extractTerminalBriefSidecarExecutionGateFinalReviewGrantEvidence,
  extractTerminalBriefSidecarExecutionGateFinalReviewOptions,
} from "./core/terminal-brief-sidecar-execution-gate-final-review.js";
import {
  buildTerminalBriefSidecarExecutorDispatchRequestDraft,
  extractTerminalBriefSidecarExecutorDispatchRequestDraftFinalReview,
  extractTerminalBriefSidecarExecutorDispatchRequestDraftOptions,
} from "./core/terminal-brief-sidecar-executor-dispatch-request-draft.js";
import {
  buildTerminalBriefSidecarDispatcherPreflightSeal,
  extractTerminalBriefSidecarDispatcherPreflightSealDraft,
  extractTerminalBriefSidecarDispatcherPreflightSealOptions,
  extractTerminalBriefSidecarDispatcherRuntimeEvidence,
} from "./core/terminal-brief-sidecar-dispatcher-preflight-seal.js";
import {
  buildTerminalBriefSidecarDispatcherApprovalHandoff,
  extractTerminalBriefSidecarDispatcherApprovalHandoffOptions,
  extractTerminalBriefSidecarDispatcherApprovalHandoffSeal,
} from "./core/terminal-brief-sidecar-dispatcher-approval-handoff.js";
import {
  buildTerminalBriefSidecarDefaultOnCandidateFinalGate,
  extractTerminalBriefSidecarDefaultOnCandidateFinalGateObservation,
  extractTerminalBriefSidecarDefaultOnCandidateFinalGateOptions,
} from "./core/terminal-brief-sidecar-default-on-candidate-final-gate.js";
import {
  buildTerminalBriefSidecarDefaultOnApprovalRequest,
  extractTerminalBriefSidecarDefaultOnApprovalRequestFinalGate,
  extractTerminalBriefSidecarDefaultOnApprovalRequestOptions,
} from "./core/terminal-brief-sidecar-default-on-approval-request.js";
import {
  buildTerminalBriefSidecarDefaultOnApprovalEvidenceIngestor,
  extractTerminalBriefSidecarDefaultOnApprovalEvidence,
  extractTerminalBriefSidecarDefaultOnApprovalEvidenceIngestorOptions,
  extractTerminalBriefSidecarDefaultOnApprovalRequestPacket,
} from "./core/terminal-brief-sidecar-default-on-approval-evidence-ingestor.js";
import {
  buildTerminalBriefSidecarDefaultOnEnablementGate,
  extractTerminalBriefSidecarDefaultOnEnablementGateApprovalEvidence,
  extractTerminalBriefSidecarDefaultOnEnablementGateOptions,
} from "./core/terminal-brief-sidecar-default-on-enablement-gate.js";
import {
  buildTerminalBriefSidecarDefaultOnRuntimeMutationPlan,
  extractTerminalBriefSidecarDefaultOnRuntimeMutationPlanEnablementGate,
  extractTerminalBriefSidecarDefaultOnRuntimeMutationPlanOptions,
} from "./core/terminal-brief-sidecar-default-on-runtime-mutation-plan.js";
import {
  buildTerminalBriefSidecarDefaultOnExecutionRollbackEnvelope,
  extractTerminalBriefSidecarDefaultOnExecutionRollbackEnvelopeOptions,
  extractTerminalBriefSidecarDefaultOnExecutionRollbackEnvelopePlan,
} from "./core/terminal-brief-sidecar-default-on-execution-rollback-envelope.js";
import {
  buildTerminalBriefSidecarDefaultOnExecutionApprovalRequest,
  extractTerminalBriefSidecarDefaultOnExecutionApprovalRequestEnvelope,
  extractTerminalBriefSidecarDefaultOnExecutionApprovalRequestOptions,
} from "./core/terminal-brief-sidecar-default-on-execution-approval-request.js";
import {
  buildTerminalBriefSidecarDefaultOnExecutionApprovalEvidenceIngestor,
  extractTerminalBriefSidecarDefaultOnExecutionApprovalEvidence,
  extractTerminalBriefSidecarDefaultOnExecutionApprovalEvidenceIngestorOptions,
  extractTerminalBriefSidecarDefaultOnExecutionApprovalRequestPacket,
} from "./core/terminal-brief-sidecar-default-on-execution-approval-evidence-ingestor.js";
import {
  buildTerminalBriefSidecarDefaultOnRuntimeExecutionFinalGate,
  extractTerminalBriefSidecarDefaultOnRuntimeExecutionFinalGateEvidence,
  extractTerminalBriefSidecarDefaultOnRuntimeExecutionFinalGateOptions,
} from "./core/terminal-brief-sidecar-default-on-runtime-execution-final-gate.js";
import {
  buildTerminalBriefSidecarDefaultOnRuntimeExecutionRequestDraft,
  extractTerminalBriefSidecarDefaultOnRuntimeExecutionRequestDraftFinalGate,
  extractTerminalBriefSidecarDefaultOnRuntimeExecutionRequestDraftOptions,
} from "./core/terminal-brief-sidecar-default-on-runtime-execution-request-draft.js";
import {
  buildTerminalBriefSidecarDefaultOnRuntimeExecutionApprovalEvidenceIngestor,
  extractTerminalBriefSidecarDefaultOnRuntimeExecutionApprovalEvidence,
  extractTerminalBriefSidecarDefaultOnRuntimeExecutionApprovalEvidenceIngestorOptions,
  extractTerminalBriefSidecarDefaultOnRuntimeExecutionRequestDraftPacket,
} from "./core/terminal-brief-sidecar-default-on-runtime-execution-approval-evidence-ingestor.js";
import {
  buildTerminalBriefSidecarDefaultOnRuntimeExecutorGate,
  extractTerminalBriefSidecarDefaultOnRuntimeExecutorGateEvidence,
  extractTerminalBriefSidecarDefaultOnRuntimeExecutorGateOptions,
} from "./core/terminal-brief-sidecar-default-on-runtime-executor-gate.js";
import {
  buildTerminalBriefSidecarDefaultOnFinalLiveExecution,
  extractTerminalBriefSidecarDefaultOnFinalLiveExecutionGate,
  extractTerminalBriefSidecarDefaultOnFinalLiveExecutionOptions,
} from "./core/terminal-brief-sidecar-default-on-final-live-execution.js";
import {
  buildTerminalBriefSidecarDefaultOnExecutionWindowRequestDraft,
  extractTerminalBriefSidecarDefaultOnExecutionWindowRequestDraftFinalLiveExecution,
  extractTerminalBriefSidecarDefaultOnExecutionWindowRequestDraftOptions,
} from "./core/terminal-brief-sidecar-default-on-execution-window-request-draft.js";
import {
  buildTerminalBriefSidecarDefaultOnExecutionWindowApprovalEvidenceIngestor,
  extractTerminalBriefSidecarDefaultOnExecutionWindowApprovalEvidence,
  extractTerminalBriefSidecarDefaultOnExecutionWindowApprovalEvidenceIngestorOptions,
  extractTerminalBriefSidecarDefaultOnExecutionWindowApprovalEvidenceRequestDraft,
} from "./core/terminal-brief-sidecar-default-on-execution-window-approval-evidence-ingestor.js";
import {
  buildTerminalBriefSidecarDefaultOnFinalRuntimeMutationExecutorGate,
  extractTerminalBriefSidecarDefaultOnFinalRuntimeMutationExecutorGateEvidence,
  extractTerminalBriefSidecarDefaultOnFinalRuntimeMutationExecutorGateOptions,
} from "./core/terminal-brief-sidecar-default-on-final-runtime-mutation-executor-gate.js";
import {
  buildTerminalBriefSidecarDefaultOnLiveExecutor,
  extractTerminalBriefSidecarDefaultOnLiveExecutorGate,
  extractTerminalBriefSidecarDefaultOnLiveExecutorOptions,
} from "./core/terminal-brief-sidecar-default-on-live-executor.js";
import {
  buildTerminalBriefSidecarDryRunStartCanaryPlan,
  extractTerminalBriefSidecarDryRunStartCanaryPlanOptions,
  extractTerminalBriefSidecarDryRunStartCanaryPlanRehearsal,
} from "./core/terminal-brief-sidecar-dry-run-start-canary-plan.js";
import {
  buildTerminalBriefSidecarPreflightEvidenceCollector,
  extractTerminalBriefSidecarPreflightEvidence,
  extractTerminalBriefSidecarPreflightEvidenceCollectorCanaryPlan,
  extractTerminalBriefSidecarPreflightEvidenceCollectorOptions,
} from "./core/terminal-brief-sidecar-preflight-evidence-collector.js";
import {
  buildTerminalBriefSidecarPreflightChainReview,
  extractTerminalBriefSidecarPreflightChainReviewCollector,
  extractTerminalBriefSidecarPreflightChainReviewOptions,
} from "./core/terminal-brief-sidecar-preflight-chain-review.js";
import {
  buildTerminalBriefSidecarDryRunStartApprovalRequest,
  extractTerminalBriefSidecarDryRunStartApprovalRequestChainReview,
  extractTerminalBriefSidecarDryRunStartApprovalRequestOptions,
} from "./core/terminal-brief-sidecar-dry-run-start-approval-request.js";
import {
  buildTerminalBriefSidecarDryRunStartApprovalReceiptIngestor,
  extractTerminalBriefSidecarDryRunStartApprovalReceiptEvidence,
  extractTerminalBriefSidecarDryRunStartApprovalReceiptIngestorOptions,
  extractTerminalBriefSidecarDryRunStartApprovalRequestPacket,
} from "./core/terminal-brief-sidecar-dry-run-start-approval-receipt-ingestor.js";
import {
  buildBrokerCleanupPlan,
  executeBrokerCleanupPlan,
  validateCleanupExecution,
  type BrokerCleanupPlanOptions,
} from "./core/broker-cleanup.js";
import {
  isTerminalTaskOutboxAckInputEvidence,
  isTerminalTaskReceiptStatus,
  type TerminalTaskEventOutbox,
  type TerminalTaskOutboxEvent,
  type TerminalTaskOutboxAckInput,
  type TerminalTaskOutboxReceiptUpdateInput,
} from "./core/terminal-event-outbox.js";
import {
  queryTerminalBriefInbox,
  summarizeTerminalBriefInbox,
} from "./core/terminal-brief-query-api.js";
import { GitHubIngestionService } from "./github/ingestion.js";
import { BoundedPoller } from "./github/bounded-poller.js";
import { parseGitHubWebhook, validateWebhookHeaders } from "./github/webhook-parser.js";
import { A2A_VERSION_HEADER, SUPPORTED_A2A_VERSIONS, negotiateA2AVersion } from "./a2a/version-negotiation.js";
import { readJson, readRawBody } from "./http/body.js";
import { sendJson, truncateMessage } from "./http/response.js";
import { awaitDurablePersistenceAck, sendError } from "./http/error-mapping.js";
import {
  handleTaskEventStream,
  handleTerminalTaskEventStream,
  handleWorkerAssignmentEventStream,
} from "./http/task-event-streams.js";
import {
  handleStreamingMessageResponse,
  parseSingleStreamingMessageRequest,
} from "./http/streaming-message.js";
import { handleOperatorEventStream } from "./http/operator-events.js";
import { handleRoundStatusRequest } from "./http/rounds.js";
import { handleProposalByIdRequest, handleProposalsListRequest } from "./http/proposals-read.js";
import { handleExchangeRoutesIfMatched } from "./http/exchanges-read.js";
import { handleComplexityOrchestrationRoutesIfMatched } from "./http/complexity-orchestration-routes.js";
import { handleTerminalBriefCloseoutRoutesIfMatched } from "./http/terminal-brief-routes.js";
import {
  handleWorkersReadRouteIfMatched,
  toWorkerView,
} from "./http/workers-read.js";
import {
  ENDPOINT_GROUPS,
  REQUEST_ROUTE_GROUPS,
  classifyEndpointGroup,
  classifyRequestRoute,
  type EndpointGroup,
  type RequestRouteGroup,
} from "./http/route-classification.js";
import { readCgroupCpuSnapshot, readCgroupPsiSnapshot } from "./diagnostics/cgroup-metrics.js";
import {
  DEFAULT_TASK_LIST_LIMIT,
  auditFiltersFromUrl,
  taskFiltersFromUrl,
  taskIdsFromUrl,
} from "./http/read-path-filters.js";
import { buildAlertScan, buildDashboardResponse, type OperatorSummary } from "./http/dashboard-response.js";
import {
  assertA2AContentDigestMatches,
  hasA2AHttpSignatureHeaders,
  headerValue,
  requestHeadersForA2AHttpSignature,
} from "./http/worker-route-auth.js";

export interface BrokerBuildInfo {
  component: string;
  revision: string;
  source: string;
  builtAt?: string;
  runtime?: string;
  image?: {
    tag?: string;
    digest?: string;
  };
}

export type BrokerPersistenceQueueMode = "inline" | "worker_thread";
export type BrokerPersistenceQueueState = "disabled" | "healthy" | "saturated" | "draining" | "aborted" | "unavailable";

export interface BrokerPersistenceQueueDiagnostics {
  kind: "broker.persistence.queue";
  enabled: boolean;
  mode: BrokerPersistenceQueueMode;
  state: BrokerPersistenceQueueState;
  capacity: number | null;
  queued: number;
  active: number;
  inFlight: number;
  available: number | null;
  closing: boolean;
  aborted: boolean;
  lastErrorCode?: BrokerError["code"] | string;
  lastErrorAt?: string;
  lastErrorMessage?: string;
}

export type BrokerPersistenceQueueDiagnosticsProvider = () => BrokerPersistenceQueueDiagnostics | undefined;

export interface OperatorSnapshotEvent {
  summary: OperatorSummary;
  alerts: AlertScanResult;
}

interface OperatorSummaryUpdateEvent {
  summary: OperatorSummary;
  alerts: AlertScanResult;
}

interface OperatorAlertEvent {
  alert: Alert;
}

type OperatorEventName =
  | "operator-snapshot"
  | "operator-summary-update"
  | "operator-alert-opened"
  | "operator-alert-resolved";

type OperatorEventPayload =
  | OperatorSnapshotEvent
  | OperatorSummaryUpdateEvent
  | OperatorAlertEvent;

export interface BufferedOperatorEvent {
  seq: number;
  event: OperatorEventName;
  data: OperatorEventPayload;
}

export interface OperatorReplayWindow {
  oldestBufferedSeq: number | null;
  currentSeq: number;
}

const DEFAULT_DASHBOARD_RECENT_HISTORY_LIMIT = 10;
const DEFAULT_DASHBOARD_OLDEST_PENDING_LIMIT = 5;
const DEFAULT_DASHBOARD_PENDING_ACTION_LIMIT = 5;
const DEFAULT_ALERT_STALE_AFTER_MS = 120_000;
const DEFAULT_ALERT_LONG_RUNNING_AFTER_MS = 3_600_000;
const DEFAULT_OPERATOR_EVENT_BUFFER_LIMIT = 200;
const DEFAULT_MAX_TASK_PAYLOAD_BYTES = 1 * 1024 * 1024;


/**
 * Small rolling window of request durations for a single endpoint.
 * Records the last N completion times and exposes p50/p95/p99/p999.
 */

// Per-endpoint request windows for attribution.
const _livezTiming = new RequestTimingWindow();
const _healthTiming = new RequestTimingWindow();

// ---------------------------------------------------------------------------
// Request accept/scheduling attribution (issue #1032)
// O(1) counters and rolling windows. Never touches DB, hot-table, or cache.
// ---------------------------------------------------------------------------

/** Total number of accepted HTTP requests since process start. */
let _totalAcceptedRequests = 0;

/** Currently in-flight requests (active handler executions). */
let _activeRequests = 0;

/**
 * Global scheduling window: records handler-completion duration for EVERY
 * request, not just /livez.  Exposes p50/p95/p99 across all endpoints.
 */
const _schedulingTimingWindow = new RequestTimingWindow(200);

/** Per-endpoint timing windows and active request gauges. */
const _perEndpointTiming = new Map<EndpointGroup, RequestTimingWindow>();
const _perEndpointActive = new Map<EndpointGroup, number>();

/** Per-endpoint handler body timing windows (handler start to res.end(), excludes response flush). */
const _perEndpointHandlerBody = new Map<EndpointGroup, RequestTimingWindow>();

interface RequestRouteMetrics {
  timing: RequestTimingWindow;
  active: number;
  firstRequestLatency: RequestTimingWindow;
  requestsOnNewConnection: number;
  requestsOnReusedConnection: number;
}

const _perRouteMetrics = new Map<RequestRouteGroup, RequestRouteMetrics>();

/** Per-route handler body timing windows (handler start to res.end(), excludes response flush). */
const _perRouteHandlerBody = new Map<RequestRouteGroup, RequestTimingWindow>();

function routeHandlerBodyWindow(group: RequestRouteGroup): RequestTimingWindow {
  let window = _perRouteHandlerBody.get(group);
  if (!window) {
    window = new RequestTimingWindow(200);
    _perRouteHandlerBody.set(group, window);
  }
  return window;
}

function routeHandlerBodySnapshot(): Record<RequestRouteGroup, RequestTimingSnapshot> {
  const snapshot = {} as Record<RequestRouteGroup, RequestTimingSnapshot>;
  for (const group of REQUEST_ROUTE_GROUPS) {
    snapshot[group] = _perRouteHandlerBody.get(group)?.snapshot() ?? null;
  }
  return snapshot;
}

function endpointTimingWindow(group: EndpointGroup): RequestTimingWindow {
  let window = _perEndpointTiming.get(group);
  if (!window) {
    window = new RequestTimingWindow(200);
    _perEndpointTiming.set(group, window);
  }
  return window;
}

function endpointTimingSnapshot(): Record<EndpointGroup, RequestTimingSnapshot> {
  const snapshot = {} as Record<EndpointGroup, RequestTimingSnapshot>;
  for (const group of ENDPOINT_GROUPS) {
    snapshot[group] = _perEndpointTiming.get(group)?.snapshot() ?? null;
  }
  return snapshot;
}

function endpointActiveSnapshot(): Record<EndpointGroup, number> {
  const snapshot = {} as Record<EndpointGroup, number>;
  for (const group of ENDPOINT_GROUPS) {
    snapshot[group] = _perEndpointActive.get(group) ?? 0;
  }
  return snapshot;
}

function endpointHandlerBodyWindow(group: EndpointGroup): RequestTimingWindow {
  let window = _perEndpointHandlerBody.get(group);
  if (!window) {
    window = new RequestTimingWindow(200);
    _perEndpointHandlerBody.set(group, window);
  }
  return window;
}

function endpointHandlerBodySnapshot(): Record<EndpointGroup, RequestTimingSnapshot> {
  const snapshot = {} as Record<EndpointGroup, RequestTimingSnapshot>;
  for (const group of ENDPOINT_GROUPS) {
    snapshot[group] = _perEndpointHandlerBody.get(group)?.snapshot() ?? null;
  }
  return snapshot;
}

function routeMetrics(group: RequestRouteGroup): RequestRouteMetrics {
  let metrics = _perRouteMetrics.get(group);
  if (!metrics) {
    metrics = {
      timing: new RequestTimingWindow(200),
      active: 0,
      firstRequestLatency: new RequestTimingWindow(200),
      requestsOnNewConnection: 0,
      requestsOnReusedConnection: 0,
    };
    _perRouteMetrics.set(group, metrics);
  }
  return metrics;
}

function requestRouteSnapshot(): Record<RequestRouteGroup, {
  active: number;
  timing: RequestTimingSnapshot;
  firstRequestLatencyMs: RequestTimingSnapshot;
  onNewConnection: number;
  onReusedConnection: number;
}> {
  const snapshot = {} as Record<RequestRouteGroup, {
    active: number;
    timing: RequestTimingSnapshot;
    firstRequestLatencyMs: RequestTimingSnapshot;
    onNewConnection: number;
    onReusedConnection: number;
  }>;
  for (const group of REQUEST_ROUTE_GROUPS) {
    const metrics = _perRouteMetrics.get(group);
    snapshot[group] = {
      active: metrics?.active ?? 0,
      timing: metrics?.timing.snapshot() ?? null,
      firstRequestLatencyMs: metrics?.firstRequestLatency.snapshot() ?? null,
      onNewConnection: metrics?.requestsOnNewConnection ?? 0,
      onReusedConnection: metrics?.requestsOnReusedConnection ?? 0,
    };
  }
  return snapshot;
}

/** Lazily-cached host-level scheduling snapshot (refreshed at most once per second). */
interface HostLoadSnapshot {
  loadavg1: number;
  loadavg5: number;
  loadavg15: number;
  cpuCount: number;
  loadPerCpu: number;
  snapshotAtMs: number;
}

let _cachedHostLoad: HostLoadSnapshot | null = null;
let _cachedHostLoadAt = 0;

function readHostLoadSnapshot(): HostLoadSnapshot {
  const now = Date.now();
  if (_cachedHostLoad && now - _cachedHostLoadAt < 1000) {
    return _cachedHostLoad;
  }
  const avg = loadavg();
  const cpuInfo = cpus();
  const cpuCount = cpuInfo.length;
  _cachedHostLoad = {
    loadavg1: avg[0],
    loadavg5: avg[1],
    loadavg15: avg[2],
    cpuCount,
    loadPerCpu: cpuCount > 0 ? Math.round((avg[0] / cpuCount) * 1000) / 1000 : 0,
    snapshotAtMs: now,
  };
  _cachedHostLoadAt = now;
  return _cachedHostLoad;
}

/**
 * Hook called at the top of the request handler to track accept timing.
 * Listens on `res.on("finish")` to decrement the active count and record
 * the handler duration in the global scheduling window.
 */
function initSchedulingHook(
  req: IncomingMessage,
  res: ServerResponse<IncomingMessage>,
  endpointGroup: EndpointGroup,
  routeGroup: RequestRouteGroup,
): void {
  const handlerStartPerfMs = performance.now();
  const handlerStartUnixMs = Date.now();
  _totalAcceptedRequests++;
  _activeRequests++;
  _perEndpointActive.set(endpointGroup, (_perEndpointActive.get(endpointGroup) ?? 0) + 1);
  const route = routeMetrics(routeGroup);
  route.active++;

  // Connection reuse classification: first request on socket vs keep-alive reused.
  const sock = req.socket as any;
  const requestsServedBefore = Number.isFinite(sock?.__a2aRequestsServed)
    ? Number(sock.__a2aRequestsServed)
    : (sock?.__a2aHasServedRequest ? 1 : 0);
  const socketConnectedAtPerfMs = typeof sock?.__a2aConnectedAt === "number"
    ? sock.__a2aConnectedAt
    : null;
  const socketConnectedUnixMs = typeof sock?.__a2aConnectedAtUnixMs === "number"
    ? sock.__a2aConnectedAtUnixMs
    : null;
  const lastResponseFinishedAtPerfMs = typeof sock?.__a2aLastResponseFinishedAt === "number"
    ? sock.__a2aLastResponseFinishedAt
    : null;
  const httpRequestEventAtPerfMs = typeof (req as any).__a2aHttpRequestEventAt === "number"
    ? (req as any).__a2aHttpRequestEventAt
    : null;
  const httpRequestEventUnixMs = typeof (req as any).__a2aHttpRequestEventAtUnixMs === "number"
    ? (req as any).__a2aHttpRequestEventAtUnixMs
    : null;
  const clientProbeStartUnixMs = parseProbeStartHeader(req, handlerStartUnixMs);
  const socketAgeBeforeHandlerMs = socketConnectedAtPerfMs !== null
    ? Math.round((handlerStartPerfMs - socketConnectedAtPerfMs) * 1000) / 1000
    : null;
  const socketIdleBeforeRequestMs = requestsServedBefore > 0 && lastResponseFinishedAtPerfMs !== null
    ? Math.round((handlerStartPerfMs - lastResponseFinishedAtPerfMs) * 1000) / 1000
    : null;
  const socketAcceptedToHttpRequestEventMs = socketConnectedAtPerfMs !== null && httpRequestEventAtPerfMs !== null
    ? Math.round((httpRequestEventAtPerfMs - socketConnectedAtPerfMs) * 1000) / 1000
    : null;
  const httpRequestEventToHandlerStartMs = httpRequestEventAtPerfMs !== null
    ? Math.round((handlerStartPerfMs - httpRequestEventAtPerfMs) * 1000) / 1000
    : null;
  const socketIdleBeforeHttpRequestEventMs = requestsServedBefore > 0
    && lastResponseFinishedAtPerfMs !== null
    && httpRequestEventAtPerfMs !== null
    ? Math.round((httpRequestEventAtPerfMs - lastResponseFinishedAtPerfMs) * 1000) / 1000
    : null;
  const clientProbeStartToHandlerStartMs = clientProbeStartUnixMs !== null
    ? handlerStartUnixMs - clientProbeStartUnixMs
    : null;
  const clientProbeStartToSocketConnectedMs = clientProbeStartUnixMs !== null && socketConnectedUnixMs !== null
    ? socketConnectedUnixMs - clientProbeStartUnixMs
    : null;
  const clientProbeStartToHttpRequestEventMs = clientProbeStartUnixMs !== null && httpRequestEventUnixMs !== null
    ? httpRequestEventUnixMs - clientProbeStartUnixMs
    : null;
  const firstDataAtPerfMs = typeof sock?.__a2aFirstDataAt === "number"
    ? sock.__a2aFirstDataAt
    : null;
  const socketConnectedToFirstDataMs = socketConnectedAtPerfMs !== null && firstDataAtPerfMs !== null
    ? Math.round((firstDataAtPerfMs - socketConnectedAtPerfMs) * 1000) / 1000
    : null;
  const firstDataToHttpRequestEventMs = firstDataAtPerfMs !== null && httpRequestEventAtPerfMs !== null
    ? Math.round((httpRequestEventAtPerfMs - firstDataAtPerfMs) * 1000) / 1000
    : null;
  const reuseFirstDataAtPerfMs = typeof sock?.__a2aReuseFirstDataAt === "number"
    ? sock.__a2aReuseFirstDataAt
    : null;
  const reuseIdleBeforeDataMs = requestsServedBefore > 0
    && lastResponseFinishedAtPerfMs !== null
    && reuseFirstDataAtPerfMs !== null
    ? Math.round((reuseFirstDataAtPerfMs - lastResponseFinishedAtPerfMs) * 1000) / 1000
    : null;
  const reuseDataToHttpRequestEventMs = requestsServedBefore > 0
    && reuseFirstDataAtPerfMs !== null
    && httpRequestEventAtPerfMs !== null
    ? Math.round((httpRequestEventAtPerfMs - reuseFirstDataAtPerfMs) * 1000) / 1000
    : null;
  const lifecycle: RequestLifecycleTiming = {
    handlerStartUnixMs,
    socketConnectedUnixMs,
    socketAgeBeforeHandlerMs,
    socketIdleBeforeRequestMs,
    httpRequestEventUnixMs,
    socketAcceptedToHttpRequestEventMs,
    httpRequestEventToHandlerStartMs,
    socketIdleBeforeHttpRequestEventMs,
    socketRequestIndex: requestsServedBefore + 1,
    socketHadServedRequest: requestsServedBefore > 0,
    clientProbeStartUnixMs,
    clientProbeStartToHandlerStartMs,
    clientProbeStartToSocketConnectedMs,
    clientProbeStartToHttpRequestEventMs,
    socketConnectedToFirstDataMs,
    firstDataToHttpRequestEventMs,
    reuseIdleBeforeDataMs,
    reuseDataToHttpRequestEventMs,
  };
  (req as any).__a2aRequestLifecycle = lifecycle;
  if (socketAgeBeforeHandlerMs !== null && socketAgeBeforeHandlerMs >= 0) {
    _socketAgeBeforeHandlerWindow.record(socketAgeBeforeHandlerMs);
  }
  if (socketIdleBeforeRequestMs !== null && socketIdleBeforeRequestMs >= 0) {
    _socketIdleBeforeRequestWindow.record(socketIdleBeforeRequestMs);
  }
  if (socketAcceptedToHttpRequestEventMs !== null && socketAcceptedToHttpRequestEventMs >= 0) {
    _socketAcceptedToHttpRequestEventWindow.record(socketAcceptedToHttpRequestEventMs);
  }
  if (httpRequestEventToHandlerStartMs !== null && httpRequestEventToHandlerStartMs >= 0) {
    _httpRequestEventToHandlerStartWindow.record(httpRequestEventToHandlerStartMs);
  }
  if (socketIdleBeforeHttpRequestEventMs !== null && socketIdleBeforeHttpRequestEventMs >= 0) {
    _socketIdleBeforeHttpRequestEventWindow.record(socketIdleBeforeHttpRequestEventMs);
  }
  if (clientProbeStartToHandlerStartMs !== null && clientProbeStartToHandlerStartMs >= 0) {
    _clientProbeStartToHandlerStartWindow.record(clientProbeStartToHandlerStartMs);
  }
  if (clientProbeStartToSocketConnectedMs !== null && clientProbeStartToSocketConnectedMs >= 0) {
    _clientProbeStartToSocketConnectedWindow.record(clientProbeStartToSocketConnectedMs);
  }
  if (clientProbeStartToHttpRequestEventMs !== null && clientProbeStartToHttpRequestEventMs >= 0) {
    _clientProbeStartToHttpRequestEventWindow.record(clientProbeStartToHttpRequestEventMs);
  }
  if (socketConnectedToFirstDataMs !== null && socketConnectedToFirstDataMs >= 0) {
    _socketConnectedToFirstDataWindow.record(socketConnectedToFirstDataMs);
  }
  if (firstDataToHttpRequestEventMs !== null && firstDataToHttpRequestEventMs >= 0) {
    _firstDataToHttpRequestEventWindow.record(firstDataToHttpRequestEventMs);
  }
  if (sock?.__a2aConnectedAt !== undefined) {
    if (!sock.__a2aHasServedRequest) {
      // Fresh connection: record per-reuse breakdown windows
      if (socketAgeBeforeHandlerMs !== null && socketAgeBeforeHandlerMs >= 0) {
        _freshSocketAgeBeforeHandlerWindow.record(socketAgeBeforeHandlerMs);
      }
      if (socketAcceptedToHttpRequestEventMs !== null && socketAcceptedToHttpRequestEventMs >= 0) {
        _freshSocketAcceptedToHttpRequestEventWindow.record(socketAcceptedToHttpRequestEventMs);
      }
      if (socketConnectedToFirstDataMs !== null && socketConnectedToFirstDataMs >= 0) {
        _freshSocketConnectedToFirstDataWindow.record(socketConnectedToFirstDataMs);
      }
      if (firstDataToHttpRequestEventMs !== null && firstDataToHttpRequestEventMs >= 0) {
        _freshSocketFirstDataToHttpRequestEventWindow.record(firstDataToHttpRequestEventMs);
      }
      if (httpRequestEventToHandlerStartMs !== null && httpRequestEventToHandlerStartMs >= 0) {
        _freshSocketHttpRequestEventToHandlerStartWindow.record(httpRequestEventToHandlerStartMs);
      }
    } else {
      // Reused socket: record per-reuse breakdown windows
      if (socketAgeBeforeHandlerMs !== null && socketAgeBeforeHandlerMs >= 0) {
        _reusedSocketAgeBeforeHandlerWindow.record(socketAgeBeforeHandlerMs);
      }
      if (socketIdleBeforeHttpRequestEventMs !== null && socketIdleBeforeHttpRequestEventMs >= 0) {
        _reusedSocketIdleBeforeHttpRequestEventWindow.record(socketIdleBeforeHttpRequestEventMs);
      }
      if (httpRequestEventToHandlerStartMs !== null && httpRequestEventToHandlerStartMs >= 0) {
        _reusedSocketHttpRequestEventToHandlerStartWindow.record(httpRequestEventToHandlerStartMs);
      }
      // Per-reused-request first-data-byte breakdown: separates wire idle
      // from event-loop blocked after data arrives (#1032 antithesis-runtime).
      if (reuseIdleBeforeDataMs !== null && reuseIdleBeforeDataMs >= 0) {
        _reusedSocketIdleBeforeDataWindow.record(reuseIdleBeforeDataMs);
      }
      if (reuseDataToHttpRequestEventMs !== null && reuseDataToHttpRequestEventMs >= 0) {
        _reusedSocketFirstDataToHttpRequestEventWindow.record(reuseDataToHttpRequestEventMs);
      }
    }
    if (!sock.__a2aHasServedRequest) {
      sock.__a2aHasServedRequest = true;
      _requestsOnNewConnection++;
      const firstReqLat = socketAgeBeforeHandlerMs ?? Math.round((handlerStartPerfMs - sock.__a2aConnectedAt) * 1000) / 1000;
      _firstRequestLatencyWindow.record(firstReqLat);
      route.requestsOnNewConnection++;
      route.firstRequestLatency.record(firstReqLat);
    } else {
      _requestsOnReusedConnection++;
      route.requestsOnReusedConnection++;
    }
  }
  sock.__a2aRequestsServed = requestsServedBefore + 1;

  // Probe burst detection: track /livez probes per /24 peer prefix.
  if (req.url === "/livez") {
    const peer = req.socket?.remoteAddress ?? "unknown";
    const prefix = peer.includes(".") ? peer.split(".").slice(0, 3).join(".") : peer;
    const now = Date.now();
    let entry = _probeCounter.get(prefix);
    if (!entry || now - entry.windowStartMs > PROBE_WINDOW_MS) {
      entry = { count: 0, windowStartMs: now };
      _probeCounter.set(prefix, entry);
    }
    entry.count++;
    // /livez is public and unauthenticated, so a distinct peer /24 per request
    // would grow this map without bound. Prune only when it gets large so the
    // hot path stays cheap.
    if (_probeCounter.size > PROBE_COUNTER_MAX_ENTRIES) {
      pruneProbeCounter(now);
    }
  }

  let flushCalledAt = 0;
  let completed = false;

  // Wrap res.end() to capture when the handler calls flush so we can measure
  // the gap between handler-side flush and OS-level finish.
  const originalEnd = res.end.bind(res);
  res.end = function endWrap(...args: any[]) {
    flushCalledAt = performance.now();
    return originalEnd(...args);
  } as typeof res.end;

  const completeHandler = () => {
    if (completed) return;
    completed = true;
    _activeRequests = Math.max(0, _activeRequests - 1);
    const now = performance.now();
    const elapsedMs = Math.round((now - handlerStartPerfMs) * 1000) / 1000;
    _schedulingTimingWindow.record(elapsedMs);
    endpointTimingWindow(endpointGroup).record(elapsedMs);
    route.timing.record(elapsedMs);
    _perEndpointActive.set(endpointGroup, Math.max(0, (_perEndpointActive.get(endpointGroup) ?? 0) - 1));
    route.active = Math.max(0, route.active - 1);

    // Record handler body execution time (start → res.end()) and flush-finish gap.
    if (flushCalledAt > 0) {
      const handlerBodyMs = Math.round((flushCalledAt - handlerStartPerfMs) * 1000) / 1000;
      _handlerBodyWindow.record(handlerBodyMs);
      endpointHandlerBodyWindow(endpointGroup).record(handlerBodyMs);
      routeHandlerBodyWindow(routeGroup).record(handlerBodyMs);
      const gapMs = Math.round((now - flushCalledAt) * 1000) / 1000;
      _flushFinishGapWindow.record(gapMs);
    }
    sock.__a2aLastResponseFinishedAt = now;
    sock.__a2aLastResponseFinishedUnixMs = Date.now();

    // Re-arm one-shot data listener for next keep-alive request (#1032
    // antithesis-runtime).  Records when the next request's first data byte
    // arrives, enabling separation of wire idle (client didn't send yet)
    // from event-loop blocked (data received but not processed).
    //
    // prependOnceListener ensures this fires BEFORE the HTTP parser's
    // internal data handler (registered first), so __a2aReuseFirstDataAt
    // is stamped before the HTTP parser emits the 'request' event even
    // when the full request fits in a single TCP segment.
    if (!sock.destroyed && sock.writable) {
      sock.__a2aReuseFirstDataAt = null;
      sock.prependOnceListener("data", () => {
        sock.__a2aReuseFirstDataAt = performance.now();
      });
    }

    res.off("finish", completeHandler);
    res.off("close", completeHandler);
  };
  res.on("finish", completeHandler);
  res.on("close", completeHandler);
}

// ---------------------------------------------------------------------------
// Cgroup (container-level) CPU throttling and PSI diagnostics (#1054)
// Graceful fallback: returns null when cgroupv2 files are unavailable
// (non-Linux, non-container, or restricted permissions).
// These are O(1) reads — single-file /sys/fs/cgroup reads — and are
// exposed only on /schedz, never on the /livez hot path.
// ---------------------------------------------------------------------------


// Connection tracking diagnostics (issue #1032)
// O(1), bounded in-memory, off /livez hot path (exposed on /schedz).
// ---------------------------------------------------------------------------

/** Total TCP connections accepted since process start (server "connection" events). */
let _totalConnections = 0;

/** Currently open TCP connections. */
let _activeConnections = 0;

/** Peak concurrent TCP connections since process start. */
let _peakConnections = 0;

/** Timing window for per-connection duration (socket open to close). */
const _connectionDurationWindow = new RequestTimingWindow(200);

/** Timing window for first-request latency on new TCP connections. */
const _firstRequestLatencyWindow = new RequestTimingWindow(200);

/** Timing window for socket age when a request handler starts. */
const _socketAgeBeforeHandlerWindow = new RequestTimingWindow(200);

/** Timing window for keep-alive socket idle time before a reused request starts. */
const _socketIdleBeforeRequestWindow = new RequestTimingWindow(200);

/** Timing window for socket acceptance to Node HTTP request event. */
const _socketAcceptedToHttpRequestEventWindow = new RequestTimingWindow(200);

/** Timing window for Node HTTP request event to main handler start. */
const _httpRequestEventToHandlerStartWindow = new RequestTimingWindow(200);

/** Timing window for keep-alive socket idle before Node HTTP request event. */
const _socketIdleBeforeHttpRequestEventWindow = new RequestTimingWindow(200);

/** Timing window for client probe start header to server handler start. */
const _clientProbeStartToHandlerStartWindow = new RequestTimingWindow(200);

/** Timing window for client probe start header to TCP socket connection event. */
const _clientProbeStartToSocketConnectedWindow = new RequestTimingWindow(200);

/** Timing window for flush-finish gap: handler res.end() to res "finish" event. */
const _flushFinishGapWindow = new RequestTimingWindow(200);

/** Timing window for handler body execution: handler start to res.end() call, excluding response flushing. */
const _handlerBodyWindow = new RequestTimingWindow(200);

/** Timing window for client probe start to Node HTTP request event (client pool artifact detection). */
const _clientProbeStartToHttpRequestEventWindow = new RequestTimingWindow(200);

/** Timing window for TCP accept/scheduling delay before first data byte on socket (connected → first data). */
const _socketConnectedToFirstDataWindow = new RequestTimingWindow(200);

/** Timing window for HTTP parser/read delay from first data byte to 'request' event. */
const _firstDataToHttpRequestEventWindow = new RequestTimingWindow(200);

/** Timing windows broken down by connection reuse for socket idle classification. */
const _freshSocketAgeBeforeHandlerWindow = new RequestTimingWindow(200);
const _freshSocketAcceptedToHttpRequestEventWindow = new RequestTimingWindow(200);
const _freshSocketConnectedToFirstDataWindow = new RequestTimingWindow(200);
const _freshSocketFirstDataToHttpRequestEventWindow = new RequestTimingWindow(200);
/** Timing window for fresh-socket HTTP request event → handler start (event-loop descheduling). */
const _freshSocketHttpRequestEventToHandlerStartWindow = new RequestTimingWindow(200);
const _reusedSocketIdleBeforeHttpRequestEventWindow = new RequestTimingWindow(200);
const _reusedSocketAgeBeforeHandlerWindow = new RequestTimingWindow(200);
const _reusedSocketHttpRequestEventToHandlerStartWindow = new RequestTimingWindow(200);
/**
 * Per-reused-request idle before first data byte arrives on socket.
 * This separates "wire idle" (client hadn't sent next request yet) from
 * "data-received-but-not-processed" (event-loop blocked after data arrived).
 * Re-armed after each response finishes on a keep-alive socket.
 */
const _reusedSocketIdleBeforeDataWindow = new RequestTimingWindow(200);
/**
 * Per-reused-request first data byte → HTTP request event gap.
 * When this is large, data arrived on a keep-alive socket but Node's event
 * loop was blocked (GC, cgroup CPU throttle, other callbacks) before the
 * HTTP parser could fire the request event.  High values here while
 * idleBeforeData is low point to event-loop descheduling, not wire idle.
 */
const _reusedSocketFirstDataToHttpRequestEventWindow = new RequestTimingWindow(200);

/** Counters for request-vs-connection reuse classification. */
let _requestsOnNewConnection = 0;
let _requestsOnReusedConnection = 0;

/** Per-peer rolling probe counter (keyed by peer IP /24 prefix). Only active for /livez probes. */
const _probeCounter: Map<string, { count: number; windowStartMs: number }> = new Map();
const PROBE_WINDOW_MS = 10_000;
const PROBE_BURST_THRESHOLD = 5;
const PROBE_START_HEADER_MAX_LAG_MS = 5 * 60_000;
const PROBE_START_HEADER_MAX_FUTURE_MS = 1_000;

interface RequestLifecycleTiming {
  handlerStartUnixMs: number;
  socketConnectedUnixMs: number | null;
  socketAgeBeforeHandlerMs: number | null;
  socketIdleBeforeRequestMs: number | null;
  httpRequestEventUnixMs: number | null;
  socketAcceptedToHttpRequestEventMs: number | null;
  httpRequestEventToHandlerStartMs: number | null;
  socketIdleBeforeHttpRequestEventMs: number | null;
  socketRequestIndex: number;
  socketHadServedRequest: boolean;
  clientProbeStartUnixMs: number | null;
  clientProbeStartToHandlerStartMs: number | null;
  clientProbeStartToSocketConnectedMs: number | null;
  /** Client probe start to Node HTTP request event (ms). Distinguishes client pool artifact from server-side idle. */
  clientProbeStartToHttpRequestEventMs: number | null;
  /** Socket connected (TCP accept) to first data byte on socket (ms). Pure accept/scheduling wait, excluding HTTP parser. */
  socketConnectedToFirstDataMs: number | null;
  /** First data byte on socket to HTTP 'request' event (ms). Pure HTTP parser/read delay. */
  firstDataToHttpRequestEventMs: number | null;
  /** Last response finish to next request first data byte on reused socket (ms). Wire idle only, excludes event-loop dispatch. */
  reuseIdleBeforeDataMs: number | null;
  /** Next request first data byte to HTTP request event on reused socket (ms). Data arrived but event-loop blocked before HTTP parser. */
  reuseDataToHttpRequestEventMs: number | null;
}

/** Tags a socket with metadata on accept. Called once per TCP connection. */
function trackServerConnection(socket: import("node:net").Socket): void {
  _totalConnections++;
  _activeConnections++;
  if (_activeConnections > _peakConnections) {
    _peakConnections = _activeConnections;
  }
  (socket as any).__a2aConnectedAt = performance.now();
  (socket as any).__a2aConnectedAtUnixMs = Date.now();
  (socket as any).__a2aHasServedRequest = false;
  (socket as any).__a2aRequestsServed = 0;
  // Record the first data byte arrival on the socket to separate pure
  // accept/scheduling wait (connected → first data) from HTTP parser/read
  // delay (first data → 'request' event).  once() self-removes after first
  // fire; the listener does NOT consume data — all 'data' listeners on the
  // same socket receive the same chunk in flowing mode.
  (socket as any).__a2aFirstDataAt = null;
  socket.once("data", () => {
    (socket as any).__a2aFirstDataAt = performance.now();
  });
  socket.on("close", () => {
    _activeConnections = Math.max(0, _activeConnections - 1);
    const dur = Math.round((performance.now() - (socket as any).__a2aConnectedAt) * 1000) / 1000;
    _connectionDurationWindow.record(dur);
  });
}

/** Stamp the Node HTTP "request" event before the main handler runs. */
function markHttpRequestEvent(req: IncomingMessage): void {
  (req as any).__a2aHttpRequestEventAt = performance.now();
  (req as any).__a2aHttpRequestEventAtUnixMs = Date.now();
}

function parseProbeStartHeader(req: IncomingMessage, handlerStartUnixMs: number): number | null {
  const raw = req.headers["x-a2a-probe-start-unix-ms"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  if (parsed < handlerStartUnixMs - PROBE_START_HEADER_MAX_LAG_MS) return null;
  if (parsed > handlerStartUnixMs + PROBE_START_HEADER_MAX_FUTURE_MS) return null;
  return parsed;
}

function readRequestLifecycleTiming(req: IncomingMessage): RequestLifecycleTiming | null {
  return ((req as any).__a2aRequestLifecycle ?? null) as RequestLifecycleTiming | null;
}

/** Returns a snapshot of probe burst peers for diagnostic display. Lightweight scan of active entries. */
// Bound on distinct peer /24 prefixes tracked for /livez probe-burst detection.
const PROBE_COUNTER_MAX_ENTRIES = 4096;

function pruneProbeCounter(now: number): void {
  // Drop entries whose window has expired (the readers already ignore these).
  for (const [prefix, entry] of _probeCounter) {
    if (now - entry.windowStartMs > PROBE_WINDOW_MS) {
      _probeCounter.delete(prefix);
    }
  }
  // If still over the cap (many active prefixes), evict the oldest by window
  // start so the map cannot grow without bound.
  if (_probeCounter.size > PROBE_COUNTER_MAX_ENTRIES) {
    const oldestFirst = [..._probeCounter.entries()].sort(
      (a, b) => a[1].windowStartMs - b[1].windowStartMs,
    );
    const toRemove = _probeCounter.size - PROBE_COUNTER_MAX_ENTRIES;
    for (let i = 0; i < toRemove; i++) {
      _probeCounter.delete(oldestFirst[i]![0]);
    }
  }
}

function readProbeBursts(): Array<{ peerPrefix: string; count: number; ageMs: number }> {
  const now = Date.now();
  const bursts: Array<{ peerPrefix: string; count: number; ageMs: number }> = [];
  for (const [prefix, entry] of _probeCounter) {
    if (now - entry.windowStartMs > PROBE_WINDOW_MS) continue;
    if (entry.count >= PROBE_BURST_THRESHOLD) {
      bursts.push({ peerPrefix: prefix, count: entry.count, ageMs: now - entry.windowStartMs });
    }
  }
  return bursts;
}


function readHttpServerDiagnostics(server: Server | null): {
  keepAliveTimeoutMs: number | null;
  headersTimeoutMs: number | null;
  requestTimeoutMs: number | null;
  timeoutMs: number | null;
  maxRequestsPerSocket: number | null;
  maxConnections: number | null;
  connectionsCheckingIntervalMs: number | null;
  socketReusePolicy: string;
} {
  // Derive an explicit socket-reuse policy label from the server configuration.
  // This makes the keep-alive/reuse intent visible in diagnostics so operators
  // can interpret rare reused-socket-idle latency in /livez probes (#1253).
  const kat = typeof server?.keepAliveTimeout === "number" ? server.keepAliveTimeout : null;
  const mps = typeof server?.maxRequestsPerSocket === "number" ? server.maxRequestsPerSocket : null;
  let socketReusePolicy: string;
  if (kat === 0 || mps === 1) {
    socketReusePolicy = "per-request (no keep-alive reuse)";
  } else if (kat !== null && kat >= 60000) {
    socketReusePolicy = "keep-alive (reuse enabled, long timeout)";
  } else if (kat !== null && kat > 0) {
    socketReusePolicy = "keep-alive (reuse enabled)";
  } else {
    socketReusePolicy = "unknown";
  }
  return {
    keepAliveTimeoutMs: typeof server?.keepAliveTimeout === "number" ? server.keepAliveTimeout : null,
    headersTimeoutMs: typeof server?.headersTimeout === "number" ? server.headersTimeout : null,
    requestTimeoutMs: typeof server?.requestTimeout === "number" ? server.requestTimeout : null,
    timeoutMs: typeof server?.timeout === "number" ? server.timeout : null,
    maxRequestsPerSocket: typeof server?.maxRequestsPerSocket === "number" ? server.maxRequestsPerSocket : null,
    maxConnections: typeof server?.maxConnections === "number" ? server.maxConnections : null,
    connectionsCheckingIntervalMs: typeof (server as any)?.connectionsCheckingInterval === "number"
      ? (server as any).connectionsCheckingInterval
      : null,
    socketReusePolicy,
  };
}


export type A2AHttpSignatureWorkerAuthMode = "off" | "optional" | "strict";
export type A2AHttpSignatureWorkerKeySource = "empty" | "inline" | "file";

interface A2AHttpSignatureVerifiedWorker {
  keyid: string;
  requesterId: string;
  scopes?: readonly string[];
}

export interface BrokerServerOptions extends BrokerRuntimeHotLimitOptions {
  host?: string;
  port?: number;
  serviceName?: string;
  publicBaseUrl?: string;
  stateFile?: string;
  sqliteFile?: string;
  persistenceBackend?: "json-file" | "sqlite";
  sqliteLoadSource?: SqliteBrokerLoadSource;
  workerOfflineAfterSec?: number;
  /**
   * Minimum interval between unchanged durable worker heartbeat writes. In-memory
   * read paths stay fresh on every heartbeat; SQLite persistence is bounded to
   * keep heartbeat churn off the hot request path. Env:
   * `BROKER_WORKER_HEARTBEAT_PERSIST_INTERVAL_MS`.
   */
  workerHeartbeatPersistIntervalMs?: number;
  rateLimitWindowSec?: number;
  rateLimitMaxRequests?: number;
  workerRateLimitWindowSec?: number;
  workerRateLimitMaxRequests?: number;
  enforceRequesterIdentity?: boolean;
  edgeSecret?: string;
  /** Explicit dev-only opt-in for unauthenticated local broker startup. Env: `A2A_ALLOW_INSECURE_DEV=1`. */
  allowInsecureDev?: boolean;
  /**
   * Worker-plane A2A HTTP Signature rollout mode.
   * - off: no route-level signature checks (default/backwards compatible)
   * - optional: verify signed worker requests when signature headers are present
   * - strict: require valid signatures for worker lifecycle/poll/mutation routes
   * Env: `A2A_HTTP_SIGNATURE_WORKER_AUTH`.
   */
  a2aHttpSignatureWorkerAuth?: A2AHttpSignatureWorkerAuthMode;
  /** In-memory key registry for worker HTTP Signature verification. */
  a2aHttpSignatureKeyRegistry?: A2AHttpSignatureKeyRegistry;
  /** JSON file containing public worker HTTP Signature keys. Env: `A2A_HTTP_SIGNATURE_KEY_REGISTRY_FILE`. */
  a2aHttpSignatureKeyRegistryFile?: string;
  /**
   * Shared secret for GitHub webhook deliveries. When set, POST /github/webhook
   * requires a valid X-Hub-Signature-256 header (HMAC-SHA256 of the raw body).
   */
  githubWebhookSecret?: string;
  agentCard?: AgentCard;
  /**
   * Enable A2A 1.0 task push-notification config CRUD and advertise
   * capabilities.pushNotifications on the agent card. Falls back to
   * A2A_PUSH_NOTIFICATIONS_ENABLED. Off by default.
   */
  pushNotificationsEnabled?: boolean;
  /** PEM private key file (Ed25519 or EC P-256) for A2A 1.0 signed agent cards. Falls back to AGENT_CARD_SIGNING_KEY_FILE. */
  agentCardSigningKeyFile?: string;
  /** Optional JWS kid header for the agent-card signature. Falls back to AGENT_CARD_SIGNING_KID. */
  agentCardSigningKid?: string;
  /**
   * JSON trust-anchor file ({ "<brokerId>": "<SPKI public key PEM>" }) for
   * the cross-broker terminal-brief receiver. When set, every inbound
   * projection must carry a request-bound `senderProof` (a JWS over
   * { brokerId, bodyHash, issuedAt, nonce } signed by the pinned key) —
   * NOT merely a signed agent card, which is public and replayable.
   * Enabling this fail-closes peers that do not emit senderProof yet, so
   * roll out sender-side support before pinning a peer's key. Falls back
   * to CROSS_BROKER_SENDER_PROOF_KEYS_FILE. Unset keeps today's behavior.
   */
  crossBrokerSenderProofKeysFile?: string;
  /**
   * Enable the embedded default A2A agent: register a built-in worker and
   * drive its tasks in-process so a worker-less SendMessage produces a task
   * (single-agent / conformance mode). Falls back to A2A_DEFAULT_AGENT_MODE.
   * Off by default; production multi-worker routing is unchanged.
   */
  defaultAgentMode?: boolean;
  stateStore?: BrokerStateStore;
  broker?: InMemoryA2ABroker;
  /**
   * Optional O(1) worker-thread persistence queue counters for /health, /schedz,
   * and operator dashboard surfaces. The provider must not perform DB or network IO.
   */
  persistenceQueueDiagnostics?: BrokerPersistenceQueueDiagnosticsProvider;
  /** Max worker-thread durable write ACK wait in ms before returning retryable 503. */
  persistenceQueueAckTimeoutMs?: number;
  /**
   * Max bytes allowed for CreateTaskRequest.payload. Keeps large sourceBundle
   * blobs from entering hot task rows/read paths; externalize larger bundles.
   * Env: `BROKER_MAX_TASK_PAYLOAD_BYTES` (or legacy `A2A_MAX_TASK_PAYLOAD_BYTES`).
   */
  maxTaskPayloadBytes?: number;
  retentionPolicy?: Partial<BrokerRetentionPolicy>;
  maxSnapshotBytes?: number;
  trustedProxy?: boolean;
  staleReaperEnabled?: boolean;
  staleReaperIntervalSec?: number;
  staleReaperOlderThanSec?: number;
  /**
   * Max times the stale-task reaper (or manual requeue) may recycle a single task back to
   * `queued` before dead-lettering it to `failed`. `0` disables the cap. Env:
   * `BROKER_MAX_REQUEUE_ATTEMPTS`.
   */
  maxRequeueAttempts?: number;
  /** Optional broker identity exposed on health/worker registration and stamped onto new tasks as broker-of-record. Env: `A2A_BROKER_ID` or `BROKER_ID`. */
  brokerId?: string;
  /** Team/tenant identity stamped onto new tasks for lifecycle ownership checks. Env: `A2A_TEAM_ID`. */
  teamId?: string;
  /**
   * SSE heartbeat interval for `/a2a/tasks/:id/events`. Comments (`: heartbeat ...`) keep
   * intermediaries from timing out idle subscriptions. `0` disables heartbeats. Env:
   * `TASK_SUBSCRIBE_HEARTBEAT_SEC`.
   */
  taskSubscribeHeartbeatSec?: number;
  /**
   * Enables the read-only `a2a.peer.status` JSON-RPC method. Default-off until
   * canary proof validates the Round 7 wake-layer rollout. Env: `A2A_PEER_STATUS_ENABLED`.
   */
  peerStatusEnabled?: boolean;
  /**
   * Optional deployment/build revision to expose on health and operator status surfaces.
   * Env priority: `A2A_BROKER_REVISION`, `BROKER_RELEASE_REVISION`, `RELEASE_REVISION`.
   */
  buildRevision?: string;
  /** Backward-compatible alias for older draft callers. Prefer `buildRevision`. */
  releaseRevision?: string;
  /** Optional broker version override. Defaults to package metadata. Env: `A2A_BROKER_VERSION`. */
  version?: string;
  /** Optional generated build-info JSON path. Defaults to bundled `dist/build-info.json` when present. */
  buildInfoFile?: string;
  /**
   * HTTP server `keepAliveTimeout` in ms. Controls how long idle TCP connections are
   * kept open by the server. Must be shorter than `headersTimeoutMs`.
   * Default: 62000ms (62s), chosen to exceed the default 30s worker heartbeat interval
   * so heartbeat connections survive between beats.
   * The Node.js default is 5000ms, which forces every heartbeat to open a new connection.
   * Env: `A2A_SERVER_KEEPALIVE_TIMEOUT_MS`.
   */
  keepAliveTimeoutMs?: number;
  /**
   * HTTP server `headersTimeout` in ms. Controls how long the server waits to receive
   * the complete request headers. Must exceed `keepAliveTimeoutMs` (Node.js requirement,
   * otherwise the server throws on listen). Defaults to `keepAliveTimeoutMs + 10000`.
   * Env: `A2A_SERVER_HEADERS_TIMEOUT_MS`.
   */
  headersTimeoutMs?: number;
}

export interface BrokerStaleReaperStatus {
  enabled: boolean;
  intervalSec: number;
  olderThanSec: number;
  maxRequeueAttempts: number;
  lastRunAt?: string;
  lastRequeued?: number;
  lastDeadLettered?: number;
  totalDeadLettered: number;
  lastError?: string;
  runCount: number;
}

export interface BrokerServerRuntime {
  server: Server;
  handler: RequestListener<typeof IncomingMessage, typeof ServerResponse>;
  broker: InMemoryA2ABroker;
  /** Run the stale-task reaper sweep once. Returns the number of requeued tasks. */
  runStaleReaperSweep: () => number;
  /** Stop the periodic stale-task reaper timer (if started). Safe to call multiple times. */
  stopStaleReaper: () => void;
  /** Current reaper configuration and last-run observations for ops visibility. */
  getStaleReaperStatus: () => BrokerStaleReaperStatus;
  /** GitHub /a2a assign ingestion service — exposed for diagnostics and direct calls. */
  githubIngestion: GitHubIngestionService;
  /** Bounded poller for periodic GitHub event fetch — exposed for diagnostics. */
  boundedPoller?: BoundedPoller;
  /** Stop the bounded poller (if started). Safe to call multiple times. */
  stopPoller: () => void;
  /** Drain and terminate the worker-thread persistence queue, if enabled. */
  closeWorkerPersistence: () => Promise<void>;
  config: {
    host: string;
    port: number;
    serviceName: string;
    publicBaseUrl: string;
    stateFile: string;
    sqliteFile?: string;
    persistenceBackend: "json-file" | "sqlite";
    sqliteLoadSource?: SqliteBrokerLoadSource;
    workerOfflineAfterSec: number;
    workerHeartbeatPersistIntervalMs: number;
    rateLimitWindowSec: number;
    rateLimitMaxRequests: number;
    workerRateLimitWindowSec: number;
    workerRateLimitMaxRequests: number;
    enforceRequesterIdentity: boolean;
    edgeSecret?: string;
    a2aHttpSignatureWorkerAuth: A2AHttpSignatureWorkerAuthMode;
    a2aHttpSignatureWorkerKeyCount: number;
    a2aHttpSignatureWorkerKeySource: A2AHttpSignatureWorkerKeySource;
    githubWebhookSecret?: string;
    retentionPolicy: BrokerRetentionPolicy;
    maxSnapshotBytes: number;
    maxHotRuntimeNonTerminalTasks: number;
    maxHotRuntimeTerminalTasks: number;
    maxHotRuntimeAuditEvents: number;
    maxHotRuntimeHeartbeatAuditEvents: number;
    maxHotRuntimeTerminalOutboxEvents: number;
    trustedProxy: boolean;
    staleReaperEnabled: boolean;
    staleReaperIntervalSec: number;
    staleReaperOlderThanSec: number;
    maxRequeueAttempts: number;
    taskSubscribeHeartbeatSec: number;
    peerStatusEnabled: boolean;
    brokerId: string;
    version: string;
    build: BrokerBuildInfo;
  };
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
  const retentionPolicy = resolveBrokerRetentionPolicy(options.retentionPolicy);
  const hotRuntimeLimits = resolveHotRuntimeLimits(options);
  const maxSnapshotBytes = Math.max(
    1,
    options.maxSnapshotBytes ?? Number(process.env.STATE_FILE_MAX_BYTES ?? DEFAULT_BROKER_STATE_MAX_BYTES),
  );
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
  const crossBrokerTrustAnchors = loadCrossBrokerTrustAnchors(
    options.crossBrokerSenderProofKeysFile ?? process.env.CROSS_BROKER_SENDER_PROOF_KEYS_FILE,
  );
  const crossBrokerNonceCache = crossBrokerTrustAnchors ? new CrossBrokerNonceCache() : undefined;
  const agentCard = signingKeyFile
    ? signAgentCard(unsignedAgentCard as unknown as Record<string, unknown>, {
        privateKeyPem: readFileSync(signingKeyFile, "utf8"),
        kid: options.agentCardSigningKid ?? process.env.AGENT_CARD_SIGNING_KID,
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
  let staleReaperLastRunAt: string | undefined;
  let staleReaperLastRequeued: number | undefined;
  let staleReaperLastDeadLettered: number | undefined;
  let staleReaperTotalDeadLettered = 0;
  let staleReaperLastError: string | undefined;
  let staleReaperRunCount = 0;
  let suppressOperatorStateBroadcast = false;

  const runStaleReaperSweep = (): number => {
    suppressOperatorStateBroadcast = true;
    try {
      const { requeued, deadLettered } = broker.requeueStaleTasksDetailed(
        staleReaperOlderThanSec * 1000,
        { workerOfflineAfterMs: workerOfflineAfterSec * 1000 },
      );
      staleReaperLastRunAt = new Date().toISOString();
      staleReaperLastRequeued = requeued.length;
      staleReaperLastDeadLettered = deadLettered.length;
      staleReaperTotalDeadLettered += deadLettered.length;
      staleReaperLastError = undefined;
      staleReaperRunCount += 1;
      if (deadLettered.length > 0) {
        // Operators want to see this without trawling audit logs. Keep it a single, greppable
        // line with task ids so it maps back to `task.failed` audit events.
        console.warn(
          `[a2a-broker] stale reaper dead-lettered ${deadLettered.length} task(s) after ${broker.getMaxRequeueAttempts()} requeue attempts: ${deadLettered
            .map((task) => task.id)
            .join(", ")}`,
        );
      }
      if (requeued.length > 0 || deadLettered.length > 0) {
        publishOperatorEvents();
      }
      return requeued.length;
    } catch (error) {
      staleReaperLastRunAt = new Date().toISOString();
      staleReaperLastRequeued = 0;
      staleReaperLastDeadLettered = 0;
      staleReaperLastError = error instanceof Error ? error.message : String(error);
      staleReaperRunCount += 1;
      // Keep the loop alive: transient persistence errors shouldn't kill the timer.
      console.error(`[a2a-broker] stale reaper sweep failed: ${staleReaperLastError}`);
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

  const getStaleReaperStatus = (): BrokerStaleReaperStatus => ({
    enabled: staleReaperEnabled,
    intervalSec: staleReaperIntervalSec,
    olderThanSec: staleReaperOlderThanSec,
    maxRequeueAttempts,
    lastRunAt: staleReaperLastRunAt,
    lastRequeued: staleReaperLastRequeued,
    lastDeadLettered: staleReaperLastDeadLettered,
    totalDeadLettered: staleReaperTotalDeadLettered,
    lastError: staleReaperLastError,
    runCount: staleReaperRunCount,
  });

  const operatorListeners = new Set<(event: BufferedOperatorEvent) => void>();
  const operatorEventBuffer: BufferedOperatorEvent[] = [];
  let operatorEventSeq = 0;

  // Compute hot-table growth for operator alerts once per snapshot.
  const currentHotTableGrowth = (): HotTableGrowthProjection | undefined =>
    stateStore instanceof SqliteBrokerStateStore
      ? projectHotTableGrowth({
          current: stateStore.readHotTableLoadMetrics(),
          runtimeLoadLimits: stateStore.readHotTableRuntimeLoadLimits(),
        })
      : undefined;

  let operatorAlertsById = new Map(
    buildAlertScan({
      broker,
      workerHeartbeatMissedAfterMs: workerOfflineAfterSec * 1000,
      hotTableGrowth: currentHotTableGrowth(),
    }).alerts.map((alert) => [alert.id, alert] as const),
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
    operatorEventBuffer.filter((event) => event.seq > afterSeq);

  const currentOperatorReplayWindow = (): OperatorReplayWindow => ({
    oldestBufferedSeq: operatorEventBuffer[0]?.seq ?? null,
    currentSeq: operatorEventSeq,
  });

  const subscribeToOperatorEvents = (
    listener: (event: BufferedOperatorEvent) => void,
  ): (() => void) => {
    operatorListeners.add(listener);
    return () => {
      operatorListeners.delete(listener);
    };
  };

  const emitOperatorEvent = (event: OperatorEventName, data: OperatorEventPayload): void => {
    const buffered: BufferedOperatorEvent = {
      seq: operatorEventSeq + 1,
      event,
      data: structuredClone(data),
    };
    operatorEventSeq = buffered.seq;
    operatorEventBuffer.push(buffered);
    if (operatorEventBuffer.length > DEFAULT_OPERATOR_EVENT_BUFFER_LIMIT) {
      operatorEventBuffer.splice(0, operatorEventBuffer.length - DEFAULT_OPERATOR_EVENT_BUFFER_LIMIT);
    }

    for (const listener of [...operatorListeners]) {
      try {
        listener(buffered);
      } catch (error) {
        console.error(
          `[a2a-broker] operator subscriber threw: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  };

  const publishOperatorEvents = (): void => {
    if (operatorListeners.size === 0) {
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
    const nextAlertsById = new Map(alerts.alerts.map((alert) => [alert.id, alert] as const));
    const openedAlerts = alerts.alerts
      .filter((alert) => !operatorAlertsById.has(alert.id))
      .sort((left, right) => left.id.localeCompare(right.id));
    const resolvedAlerts = [...operatorAlertsById.values()]
      .filter((alert) => !nextAlertsById.has(alert.id))
      .sort((left, right) => left.id.localeCompare(right.id));

    for (const alert of openedAlerts) {
      emitOperatorEvent("operator-alert-opened", { alert });
    }
    for (const alert of resolvedAlerts) {
      emitOperatorEvent("operator-alert-resolved", { alert });
    }

    operatorAlertsById = nextAlertsById;
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
    }, a2aHttpSignatureKeyRegistry);

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

      if (req.method === "POST" && (path === "/a2a/jsonrpc" || path === "/a2a/jsonrpc/")) {
        // A2A 1.0 version negotiation: serve the requested version's
        // semantics or fail closed on a version we cannot honor. The
        // response always advertises the version actually served.
        const negotiated = negotiateA2AVersion(req.headers[A2A_VERSION_HEADER]);
        if (!negotiated.ok) {
          return sendJson(
            res,
            400,
            { jsonrpc: "2.0", id: null, error: { code: -32600, message: negotiated.message } },
            { "a2a-version": SUPPORTED_A2A_VERSIONS.join(", ") },
          );
        }
        res.setHeader("a2a-version", negotiated.version);
        // Explicit version negotiation opts the client into A2A 1.0 result
        // shapes; header-less legacy clients keep the historical envelopes.
        const responseShape = negotiated.requested !== null ? "spec" as const : "legacy" as const;
        // Read the raw body so malformed JSON yields a JSON-RPC -32700 rather
        // than the broker's HTTP error envelope, and so batch arrays /
        // notifications are handled by the JSON-RPC transport layer.
        const rawBody = (await readRawBody(req)).toString("utf8");

        // A2A 1.0 SendStreamingMessage: a single (non-batch) request streams
        // JSON-RPC result envelopes over SSE instead of a unary response.
        // Batch-embedded SendStreamingMessage falls through to the JSON-RPC
        // layer, which rejects it with -32600.
        const streamingRequest = parseSingleStreamingMessageRequest(rawBody);
        if (streamingRequest) {
          let created;
          try {
            created = executeSendMessage(streamingRequest.params, {
              broker,
              agentCard,
              publicBaseUrl,
              requesterIdentity,
              enforceRequesterIdentity,
              peerStatusService,
              pushNotificationConfigStore,
              persistPushNotificationConfigs,
              defaultAgentNodeId,
            });
          } catch (error) {
            const rpcError = jsonRpcErrorFromUnknown(error);
            return sendJson(res, 200, {
              jsonrpc: "2.0",
              id: streamingRequest.id,
              error: rpcError,
            });
          }
          const createdTask = created.task ? broker.getTask(created.task.id) : null;
          if (!createdTask) {
            // Context-only sends (no active task) have nothing to stream.
            const contextResult = responseShape === "spec" ? specSendResult(created, broker) : created;
            return sendJson(res, 200, { jsonrpc: "2.0", id: streamingRequest.id, result: contextResult });
          }
          handleStreamingMessageResponse(req, res, {
            broker,
            rpcId: streamingRequest.id,
            sendResult: created,
            task: createdTask,
            heartbeatMs: taskSubscribeHeartbeatSec * 1000,
            responseShape,
          });
          return;
        }

        const response = executeA2AJsonRpcBody(rawBody, {
          broker,
          agentCard,
          publicBaseUrl,
          requesterIdentity,
          enforceRequesterIdentity,
          peerStatusService,
          pushNotificationConfigStore,
          persistPushNotificationConfigs,
          responseShape,
          defaultAgentNodeId,
        });
        if (response === null) {
          // Entirely notifications — JSON-RPC requires no response body.
          res.writeHead(204);
          res.end();
          return;
        }
        return sendJson(res, 200, response);
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

      if (
        req.method === "GET" &&
        segments[0] === "a2a" &&
        segments[1] === "workers" &&
        segments[2] &&
        segments[3] === "assignment-events" &&
        segments.length === 4
      ) {
        const workerId = segments[2];
        const verifiedWorker = await assertWorkerHttpSignatureRoute(req, url);
        assertVerifiedWorkerMatches(verifiedWorker, workerId, "workers.assignment-events");
        if (enforceRequesterIdentity) {
          assertRequesterCanSubscribeToWorkerAssignments(requesterIdentity, workerId);
        }
        if (!broker.getWorker(workerId)) {
          throw new BrokerError("not_found", "worker not found");
        }

        handleWorkerAssignmentEventStream(req, res, {
          broker,
          workerId,
          heartbeatMs: taskSubscribeHeartbeatSec * 1000,
        });
        return;
      }

      if (
        req.method === "GET" &&
        segments[0] === "a2a" &&
        segments[1] === "tasks" &&
        segments[2] &&
        segments[3] === "events" &&
        segments.length === 4
      ) {
        const taskId = segments[2];
        const task = broker.getTask(taskId);
        if (!task) {
          throw new BrokerError("not_found", "task not found");
        }
        if (enforceRequesterIdentity) {
          assertRequesterCanSubscribeToTask(requesterIdentity, task);
        }

        handleTaskEventStream(req, res, {
          broker,
          task,
          heartbeatMs: taskSubscribeHeartbeatSec * 1000,
        });
        return;
      }

      if (
        req.method === "POST" &&
        path === "/a2a/cross-broker/terminal-briefs"
      ) {
        if (enforceRequesterIdentity) {
          assertRequesterHasRole(requesterIdentity, ["hub", "operator"], "cross-broker-terminal-brief.ingest");
        }

        const body = await readJson(req);
        if (crossBrokerTrustAnchors && crossBrokerNonceCache) {
          const verdict = verifyCrossBrokerSenderProof(crossBrokerTrustAnchors, body, {
            nonceCache: crossBrokerNonceCache,
          });
          if (!verdict.ok) {
            throw new BrokerError("policy_denied", `cross-broker trust: ${verdict.reason}`);
          }
        }
        const result = broker.ingestCrossBrokerTerminalBriefProjection(body as Parameters<typeof broker.ingestCrossBrokerTerminalBriefProjection>[0]);
        if (!result.accepted) {
          const status = result.ack.code === "missing_parent" ? 404 : result.ack.code === "stale_replay" ? 409 : 400;
          return sendJson(res, status, result);
        }
        await awaitDurablePersistenceAck(stateStore);
        return sendJson(res, result.replayed ? 200 : 202, result);
      }

      if (
        req.method === "GET" &&
        path === "/a2a/cross-broker/terminal-briefs"
      ) {
        if (enforceRequesterIdentity) {
          assertRequesterHasRole(requesterIdentity, ["hub", "operator"], "cross-broker-terminal-brief.query");
        }

        const parentRoundId = url.searchParams.get("parent_round_id") ?? undefined;
        const originBrokerId = url.searchParams.get("origin_broker_id") ?? undefined;
        const records = broker.listCrossBrokerTerminalBriefProjections({ parentRoundId, originBrokerId });
        return sendJson(res, 200, {
          kind: "a2a.cross-broker.terminal-briefs",
          count: records.length,
          records,
        });
      }

      if (
        req.method === "GET" &&
        path === "/a2a/tasks/terminal-outbox"
      ) {
        if (enforceRequesterIdentity) {
          assertRequesterHasRole(requesterIdentity, ["hub", "operator"], "task-terminal-outbox.subscribe");
        }

        const afterId = url.searchParams.get("after_id") ?? undefined;
        const limit = numberQueryParam(url, "limit");
        const reconcileUnacked = booleanQueryParam(url, "reconcile_unacked") ?? false;
        if (reconcileUnacked) {
          const subscription = broker.getTerminalTaskEventOutbox().subscribeWithCursor({ afterId, limit });
          return sendJson(res, 200, {
            kind: "task.terminal.outbox",
            count: subscription.events.length,
            cursor: subscription.cursor,
            reconciledUnacked: subscription.reconciledUnacked,
            events: subscription.events,
          });
        }
        const events = broker.getTerminalTaskEventOutbox().subscribe({ afterId, limit });
        return sendJson(res, 200, {
          kind: "task.terminal.outbox",
          count: events.length,
          cursor: events.at(-1)?.id ?? afterId ?? null,
          events,
        });
      }

      if (req.method === "GET" && path === "/terminal-brief/inbox") {
        if (enforceRequesterIdentity) {
          assertRequesterHasRole(requesterIdentity, ["hub", "operator"], "terminal_brief.inbox.read");
        }

        const outbox = broker.getTerminalTaskEventOutbox();
        const includeAll = booleanQueryParam(url, "all") ?? false;
        const filter = {
          parentRoundId: optionalString(url.searchParams.get("parent_round_id") ?? url.searchParams.get("parentRoundId")),
          originBrokerId: optionalString(url.searchParams.get("origin_broker_id") ?? url.searchParams.get("originBrokerId")),
          brokerOfRecordId: optionalString(url.searchParams.get("broker_of_record_id") ?? url.searchParams.get("brokerOfRecordId")),
          worker: optionalString(url.searchParams.get("worker")),
          taskStatus: optionalString(url.searchParams.get("task_status") ?? url.searchParams.get("taskStatus")),
          ticketRef: optionalString(url.searchParams.get("ticket_ref") ?? url.searchParams.get("ticketRef")),
          ...(includeAll ? {} : { unacked: true }),
        };
        const inbox = queryTerminalBriefInbox(
          outbox,
          filter,
          { afterId: optionalString(url.searchParams.get("after_id") ?? url.searchParams.get("afterId")) },
          numberQueryParam(url, "limit"),
        );
        return sendJson(res, 200, {
          kind: "a2a-broker.terminal-brief.inbox",
          summary: inbox.summary,
          query: inbox.query,
        }, {
          "cache-control": "no-store",
        });
      }

      if (
        req.method === "POST" &&
        path === "/a2a/tasks/terminal-outbox/receipt"
      ) {
        if (enforceRequesterIdentity) {
          assertRequesterHasRole(requesterIdentity, ["hub", "operator"], "task-terminal-outbox.receipt");
        }

        const body = await readJson<{ id?: unknown; receipt?: unknown }>(req);
        const id = body?.id;
        if (typeof id !== "string" || id.length === 0) {
          throw new BrokerError("bad_request", "terminal outbox receipt update requires a non-empty id");
        }
        const receipt = parseTerminalOutboxReceiptUpdate(body?.receipt);
        const event = broker.recordTerminalTaskOutboxReceiptStatus(id, receipt);
        if (!event) {
          throw new BrokerError("not_found", "terminal outbox event not found");
        }
        await awaitDurablePersistenceAck(stateStore);
        return sendJson(res, 200, { event });
      }

      if (
        req.method === "POST" &&
        path === "/a2a/tasks/terminal-outbox/ack"
      ) {
        if (enforceRequesterIdentity) {
          assertRequesterHasRole(requesterIdentity, ["hub", "operator"], "task-terminal-outbox.ack");
        }

        const body = await readJson<{ id?: unknown; receipt?: unknown }>(req);
        const id = body?.id;
        if (typeof id !== "string" || id.length === 0) {
          throw new BrokerError("bad_request", "terminal outbox ack requires a non-empty id");
        }
        const receipt = parseTerminalOutboxAckReceipt(body?.receipt);
        const event = broker.acknowledgeTerminalTaskOutboxEvent(id, receipt);
        if (!event) {
          throw new BrokerError("not_found", "terminal outbox event not found");
        }
        await awaitDurablePersistenceAck(stateStore);
        return sendJson(res, 200, { event });
      }

      if (
        req.method === "GET" &&
        path === "/a2a/tasks/terminal-events"
      ) {
        if (enforceRequesterIdentity) {
          assertRequesterHasRole(requesterIdentity, ["hub", "operator"], "task-terminal.subscribe");
        }

        handleTerminalTaskEventStream(req, res, {
          broker,
          heartbeatMs: taskSubscribeHeartbeatSec * 1000,
        });
        return;
      }

      if (
        req.method === "GET" &&
        path === "/a2a/operator/events"
      ) {
        if (enforceRequesterIdentity) {
          assertRequesterHasRole(requesterIdentity, ["hub", "operator"], "operator.subscribe");
        }

        handleOperatorEventStream(req, res, {
          currentSnapshot: currentOperatorSnapshot,
          replayEvents: replayOperatorEvents,
          subscribe: subscribeToOperatorEvents,
          replayWindow: currentOperatorReplayWindow,
          heartbeatMs: taskSubscribeHeartbeatSec * 1000,
        });
        return;
      }

      if (req.method === "GET" && path === "/dashboard") {
        const recentLimit = numberQueryParam(url, "recent_history_limit") ?? 10;
        const oldestPendingLimit = numberQueryParam(url, "oldest_pending_limit") ?? 5;
        const pendingActionLimit = numberQueryParam(url, "pending_action_limit") ?? 5;
        return sendJson(res, 200, buildDashboardResponse({
          broker,
          workerOfflineAfterSec,
          getStaleReaperStatus,
          rateLimiter,
          workerRateLimiter,
          version: buildInfo.version,
          build: buildInfo.build,
          recentHistoryLimit: recentLimit,
          oldestPendingLimit,
          pendingActionLimit,
          hotEntityDiagnostics: stateStore instanceof SqliteBrokerStateStore
            ? stateStore.readHotEntityDiagnostics()
            : undefined,
          persistenceQueue: readPersistenceQueueDiagnostics(persistenceQueueDiagnosticsProvider),
        }));
      }

      if (req.method === "GET" && path === "/control-tower") {
        if (enforceRequesterIdentity) {
          assertRequesterHasRole(requesterIdentity, ["hub", "operator"], "control_tower.read");
        }
        const recentLimit = numberQueryParam(url, "recent_history_limit") ?? 10;
        const oldestPendingLimit = numberQueryParam(url, "oldest_pending_limit") ?? 5;
        const pendingActionLimit = numberQueryParam(url, "pending_action_limit") ?? 5;
        const dashboard = buildDashboardResponse({
          broker,
          workerOfflineAfterSec,
          getStaleReaperStatus,
          rateLimiter,
          workerRateLimiter,
          version: buildInfo.version,
          build: buildInfo.build,
          recentHistoryLimit: recentLimit,
          oldestPendingLimit,
          pendingActionLimit,
          hotEntityDiagnostics: stateStore instanceof SqliteBrokerStateStore
            ? stateStore.readHotEntityDiagnostics()
            : undefined,
          persistenceQueue: readPersistenceQueueDiagnostics(persistenceQueueDiagnosticsProvider),
        });
        return sendJson(res, 200, {
          kind: "a2a-broker.control-tower.snapshot",
          generatedAt: dashboard.generatedAt,
          brokerId,
          version: buildInfo.version,
          build: buildInfo.build,
          queue: dashboard.operatorSnapshot.taskStatusSummary,
          recovery: dashboard.operatorSnapshot.recoverySummary,
          attention: dashboard.attention,
          workerCapacity: broker.getWorkerCapacitySummary({
            workerOfflineAfterMs: workerOfflineAfterSec * 1000,
            taskStaleAfterMs: numberQueryParam(url, "stale_after_ms") ?? workerOfflineAfterSec * 1000,
          }),
          terminalBrief: summarizeTerminalBriefInbox(broker.getTerminalTaskEventOutbox()),
          safety: {
            readOnly: true,
            performsMutation: false,
            forbiddenActions: ["manual_ack", "replay", "prune", "provider_send", "restart", "deploy", "db_mutation"],
          },
        }, {
          "cache-control": "no-store",
        });
      }

      if (req.method === "GET" && path === "/release/evidence") {
        if (enforceRequesterIdentity) {
          assertRequesterHasRole(requesterIdentity, ["hub", "operator"], "release.evidence.read");
        }
        const filters = taskFiltersFromUrl(url);
        const wantedTaskIds = new Set(taskIdsFromUrl(url));
        const tasks = listTasksForReadPath(stateStore, broker, filters)
          .filter((task) => wantedTaskIds.size === 0 || wantedTaskIds.has(task.id));
        const report = buildReleaseEvidenceExport(tasks, {
          repo: optionalString(url.searchParams.get("repo")),
          issue: optionalString(url.searchParams.get("issue")),
          parentIssue: optionalString(url.searchParams.get("parentIssue") ?? url.searchParams.get("parent_issue")),
          runId: optionalString(url.searchParams.get("runId") ?? url.searchParams.get("run_id")),
          ...(stateStore instanceof SqliteBrokerStateStore
            ? {
                terminalOutboxDiagnostics: mapBrokerDiagnosticsToSnapshot(
                  stateStore.readHotTerminalOutboxDiagnostics(),
                ),
              }
            : {}),
        });
        return sendJson(res, 200, report, {
          "cache-control": "no-store",
        });
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

      if (req.method === "POST" && path === "/terminal-brief/sidecar/dry-run-gate") {
        if (enforceRequesterIdentity) {
          assertRequesterHasRole(requesterIdentity, ["hub", "operator"], "terminal_brief.sidecar_dry_run_gate.read");
        }
        const body = await readJson<Record<string, unknown>>(req);
        let sidecarRehearsal;
        try {
          sidecarRehearsal = extractTerminalBriefSidecarDryRunGateRehearsal(body);
        } catch (error) {
          const message = error instanceof Error ? error.message : "invalid sidecar dry-run gate input";
          throw new BrokerError("bad_request", message);
        }
        const report = buildTerminalBriefSidecarDryRunGate(
          sidecarRehearsal,
          extractTerminalBriefSidecarDryRunGateFinalizerStatus(body),
          extractTerminalBriefSidecarDryRunOperatingEvidence(body),
        );
        return sendJson(res, 200, report, {
          "cache-control": "no-store",
        });
      }

      if (req.method === "POST" && path === "/terminal-brief/sidecar/activation-approval") {
        if (enforceRequesterIdentity) {
          assertRequesterHasRole(requesterIdentity, ["hub", "operator"], "terminal_brief.sidecar_activation_approval.read");
        }
        const body = await readJson<Record<string, unknown>>(req);
        let dryRunGate;
        try {
          dryRunGate = extractTerminalBriefSidecarActivationApprovalGate(body);
        } catch (error) {
          const message = error instanceof Error ? error.message : "invalid sidecar activation approval input";
          throw new BrokerError("bad_request", message);
        }
        const report = buildTerminalBriefSidecarActivationApproval(
          dryRunGate,
          extractTerminalBriefSidecarActivationApprovalOptions(body),
        );
        return sendJson(res, 200, report, {
          "cache-control": "no-store",
        });
      }

      if (req.method === "POST" && path === "/terminal-brief/sidecar/activation-receipt") {
        if (enforceRequesterIdentity) {
          assertRequesterHasRole(requesterIdentity, ["hub", "operator"], "terminal_brief.sidecar_activation_receipt.read");
        }
        const body = await readJson<Record<string, unknown>>(req);
        let activationApproval;
        try {
          activationApproval = extractTerminalBriefSidecarActivationApprovalPacket(body);
        } catch (error) {
          const message = error instanceof Error ? error.message : "invalid sidecar activation receipt input";
          throw new BrokerError("bad_request", message);
        }
        const report = buildTerminalBriefSidecarActivationReceiptIngestor(
          activationApproval,
          extractTerminalBriefSidecarActivationReceiptEvidence(body),
        );
        return sendJson(res, 200, report, {
          "cache-control": "no-store",
        });
      }

      if (req.method === "POST" && path === "/terminal-brief/sidecar/start-executor-gate") {
        if (enforceRequesterIdentity) {
          assertRequesterHasRole(requesterIdentity, ["hub", "operator"], "terminal_brief.sidecar_start_executor_gate.read");
        }
        const body = await readJson<Record<string, unknown>>(req);
        let activationReceipt;
        try {
          activationReceipt = extractTerminalBriefSidecarStartExecutorGateReceipt(body);
        } catch (error) {
          const message = error instanceof Error ? error.message : "invalid sidecar start executor gate input";
          throw new BrokerError("bad_request", message);
        }
        const report = buildTerminalBriefSidecarStartExecutorGate(
          activationReceipt,
          extractTerminalBriefSidecarStartExecutorGateOptions(body),
        );
        return sendJson(res, 200, report, {
          "cache-control": "no-store",
        });
      }

      if (req.method === "POST" && path === "/terminal-brief/sidecar/executor-invocation-rehearsal") {
        if (enforceRequesterIdentity) {
          assertRequesterHasRole(requesterIdentity, ["hub", "operator"], "terminal_brief.sidecar_executor_invocation_rehearsal.read");
        }
        const body = await readJson<Record<string, unknown>>(req);
        let startExecutorGate;
        try {
          startExecutorGate = extractTerminalBriefSidecarExecutorInvocationRehearsalGate(body);
        } catch (error) {
          const message = error instanceof Error ? error.message : "invalid sidecar executor invocation rehearsal input";
          throw new BrokerError("bad_request", message);
        }
        const report = buildTerminalBriefSidecarExecutorInvocationRehearsal(
          startExecutorGate,
          extractTerminalBriefSidecarExecutorInvocationRehearsalOptions(body),
        );
        return sendJson(res, 200, report, {
          "cache-control": "no-store",
        });
      }

      if (req.method === "POST" && path === "/terminal-brief/sidecar/runtime-preflight-approval") {
        if (enforceRequesterIdentity) {
          assertRequesterHasRole(requesterIdentity, ["hub", "operator"], "terminal_brief.sidecar_runtime_preflight_approval.read");
        }
        const body = await readJson<Record<string, unknown>>(req);
        let executorInvocationRehearsal;
        try {
          executorInvocationRehearsal = extractTerminalBriefSidecarRuntimePreflightApprovalRehearsal(body);
        } catch (error) {
          const message = error instanceof Error ? error.message : "invalid sidecar runtime preflight approval input";
          throw new BrokerError("bad_request", message);
        }
        const report = buildTerminalBriefSidecarRuntimePreflightApproval(
          executorInvocationRehearsal,
          extractTerminalBriefSidecarRuntimePreflightApprovalOptions(body),
        );
        return sendJson(res, 200, report, {
          "cache-control": "no-store",
        });
      }

      if (req.method === "POST" && path === "/terminal-brief/sidecar/adapter-handoff-approval") {
        if (enforceRequesterIdentity) {
          assertRequesterHasRole(requesterIdentity, ["hub", "operator"], "terminal_brief.sidecar_adapter_handoff_approval.read");
        }
        const body = await readJson<Record<string, unknown>>(req);
        let runtimePreflightApproval;
        try {
          runtimePreflightApproval = extractTerminalBriefSidecarAdapterHandoffApprovalPacket(body);
        } catch (error) {
          const message = error instanceof Error ? error.message : "invalid sidecar adapter handoff approval input";
          throw new BrokerError("bad_request", message);
        }
        const report = buildTerminalBriefSidecarAdapterHandoffApproval(
          runtimePreflightApproval,
          extractTerminalBriefSidecarAdapterHandoffApprovalOptions(body),
        );
        return sendJson(res, 200, report, {
          "cache-control": "no-store",
        });
      }

      if (req.method === "POST" && path === "/terminal-brief/sidecar/operator-review-table") {
        if (enforceRequesterIdentity) {
          assertRequesterHasRole(requesterIdentity, ["hub", "operator"], "terminal_brief.sidecar_operator_review_table.read");
        }
        const body = await readJson<Record<string, unknown>>(req);
        let adapterHandoff;
        try {
          adapterHandoff = extractTerminalBriefSidecarOperatorReviewTableHandoff(body);
        } catch (error) {
          const message = error instanceof Error ? error.message : "invalid sidecar operator review table input";
          throw new BrokerError("bad_request", message);
        }
        const report = buildTerminalBriefSidecarOperatorReviewTable(
          adapterHandoff,
          extractTerminalBriefSidecarOperatorReviewTableOptions(body),
        );
        return sendJson(res, 200, report, {
          "cache-control": "no-store",
        });
      }

      if (req.method === "POST" && path === "/terminal-brief/sidecar/review-decision") {
        if (enforceRequesterIdentity) {
          assertRequesterHasRole(requesterIdentity, ["hub", "operator"], "terminal_brief.sidecar_review_decision.read");
        }
        const body = await readJson<Record<string, unknown>>(req);
        let reviewTable;
        try {
          reviewTable = extractTerminalBriefSidecarReviewDecisionIngestorTable(body);
        } catch (error) {
          const message = error instanceof Error ? error.message : "invalid sidecar review decision input";
          throw new BrokerError("bad_request", message);
        }
        const report = buildTerminalBriefSidecarReviewDecisionIngestor(
          reviewTable,
          extractTerminalBriefSidecarReviewDecisionEvidence(body),
          extractTerminalBriefSidecarReviewDecisionIngestorOptions(body),
        );
        return sendJson(res, 200, report, {
          "cache-control": "no-store",
        });
      }

      if (req.method === "POST" && path === "/terminal-brief/sidecar/approval-grant-proposal") {
        if (enforceRequesterIdentity) {
          assertRequesterHasRole(requesterIdentity, ["hub", "operator"], "terminal_brief.sidecar_approval_grant_proposal.read");
        }
        const body = await readJson<Record<string, unknown>>(req);
        let reviewDecision;
        try {
          reviewDecision = extractTerminalBriefSidecarApprovalGrantProposalReviewDecision(body);
        } catch (error) {
          const message = error instanceof Error ? error.message : "invalid sidecar approval grant proposal input";
          throw new BrokerError("bad_request", message);
        }
        const report = buildTerminalBriefSidecarApprovalGrantProposal(
          reviewDecision,
          extractTerminalBriefSidecarApprovalGrantProposalOptions(body),
        );
        return sendJson(res, 200, report, {
          "cache-control": "no-store",
        });
      }

      if (req.method === "POST" && path === "/terminal-brief/sidecar/approval-grant-evidence") {
        if (enforceRequesterIdentity) {
          assertRequesterHasRole(requesterIdentity, ["hub", "operator"], "terminal_brief.sidecar_approval_grant_evidence.read");
        }
        const body = await readJson<Record<string, unknown>>(req);
        let proposal;
        try {
          proposal = extractTerminalBriefSidecarApprovalGrantEvidenceIngestorProposal(body);
        } catch (error) {
          const message = error instanceof Error ? error.message : "invalid sidecar approval grant evidence input";
          throw new BrokerError("bad_request", message);
        }
        const report = buildTerminalBriefSidecarApprovalGrantEvidenceIngestor(
          proposal,
          extractTerminalBriefSidecarApprovalGrantEvidence(body),
          extractTerminalBriefSidecarApprovalGrantEvidenceIngestorOptions(body),
        );
        return sendJson(res, 200, report, {
          "cache-control": "no-store",
        });
      }

      if (req.method === "POST" && path === "/terminal-brief/sidecar/execution-gate-final-review") {
        if (enforceRequesterIdentity) {
          assertRequesterHasRole(requesterIdentity, ["hub", "operator"], "terminal_brief.sidecar_execution_gate_final_review.read");
        }
        const body = await readJson<Record<string, unknown>>(req);
        let grantEvidence;
        try {
          grantEvidence = extractTerminalBriefSidecarExecutionGateFinalReviewGrantEvidence(body);
        } catch (error) {
          const message = error instanceof Error ? error.message : "invalid sidecar execution gate final review input";
          throw new BrokerError("bad_request", message);
        }
        const report = buildTerminalBriefSidecarExecutionGateFinalReview(
          grantEvidence,
          extractTerminalBriefSidecarExecutionGateFinalReviewOptions(body),
        );
        return sendJson(res, 200, report, {
          "cache-control": "no-store",
        });
      }

      if (req.method === "POST" && path === "/terminal-brief/sidecar/executor-dispatch-request-draft") {
        if (enforceRequesterIdentity) {
          assertRequesterHasRole(requesterIdentity, ["hub", "operator"], "terminal_brief.sidecar_executor_dispatch_request_draft.read");
        }
        const body = await readJson<Record<string, unknown>>(req);
        let finalReview;
        try {
          finalReview = extractTerminalBriefSidecarExecutorDispatchRequestDraftFinalReview(body);
        } catch (error) {
          const message = error instanceof Error ? error.message : "invalid sidecar executor dispatch request draft input";
          throw new BrokerError("bad_request", message);
        }
        const report = buildTerminalBriefSidecarExecutorDispatchRequestDraft(
          finalReview,
          extractTerminalBriefSidecarExecutorDispatchRequestDraftOptions(body),
        );
        return sendJson(res, 200, report, {
          "cache-control": "no-store",
        });
      }

      if (req.method === "POST" && path === "/terminal-brief/sidecar/dispatcher-preflight-seal") {
        if (enforceRequesterIdentity) {
          assertRequesterHasRole(requesterIdentity, ["hub", "operator"], "terminal_brief.sidecar_dispatcher_preflight_seal.read");
        }
        const body = await readJson<Record<string, unknown>>(req);
        let dispatchDraft;
        try {
          dispatchDraft = extractTerminalBriefSidecarDispatcherPreflightSealDraft(body);
        } catch (error) {
          const message = error instanceof Error ? error.message : "invalid sidecar dispatcher preflight seal input";
          throw new BrokerError("bad_request", message);
        }
        const report = buildTerminalBriefSidecarDispatcherPreflightSeal(
          dispatchDraft,
          extractTerminalBriefSidecarDispatcherRuntimeEvidence(body),
          extractTerminalBriefSidecarDispatcherPreflightSealOptions(body),
        );
        return sendJson(res, 200, report, {
          "cache-control": "no-store",
        });
      }

      if (req.method === "POST" && path === "/terminal-brief/sidecar/dispatcher-approval-handoff") {
        if (enforceRequesterIdentity) {
          assertRequesterHasRole(requesterIdentity, ["hub", "operator"], "terminal_brief.sidecar_dispatcher_approval_handoff.read");
        }
        const body = await readJson<Record<string, unknown>>(req);
        let preflightSeal;
        try {
          preflightSeal = extractTerminalBriefSidecarDispatcherApprovalHandoffSeal(body);
        } catch (error) {
          const message = error instanceof Error ? error.message : "invalid sidecar dispatcher approval handoff input";
          throw new BrokerError("bad_request", message);
        }
        const report = buildTerminalBriefSidecarDispatcherApprovalHandoff(
          preflightSeal,
          extractTerminalBriefSidecarDispatcherApprovalHandoffOptions(body),
        );
        return sendJson(res, 200, report, {
          "cache-control": "no-store",
        });
      }

      if (req.method === "POST" && path === "/terminal-brief/sidecar/dry-run-start-canary-plan") {
        if (enforceRequesterIdentity) {
          assertRequesterHasRole(requesterIdentity, ["hub", "operator"], "terminal_brief.sidecar_dry_run_start_canary_plan.read");
        }
        const body = await readJson<Record<string, unknown>>(req);
        let executorInvocationRehearsal;
        try {
          executorInvocationRehearsal = extractTerminalBriefSidecarDryRunStartCanaryPlanRehearsal(body);
        } catch (error) {
          const message = error instanceof Error ? error.message : "invalid sidecar dry-run start canary plan input";
          throw new BrokerError("bad_request", message);
        }
        const report = buildTerminalBriefSidecarDryRunStartCanaryPlan(
          executorInvocationRehearsal,
          extractTerminalBriefSidecarDryRunStartCanaryPlanOptions(body),
        );
        return sendJson(res, 200, report, {
          "cache-control": "no-store",
        });
      }

      if (req.method === "POST" && path === "/terminal-brief/sidecar/default-on-candidate-final-gate") {
        if (enforceRequesterIdentity) {
          assertRequesterHasRole(requesterIdentity, ["hub", "operator"], "terminal_brief.sidecar_default_on_candidate_final_gate.read");
        }
        const body = await readJson<Record<string, unknown>>(req);
        let observation;
        try {
          observation = extractTerminalBriefSidecarDefaultOnCandidateFinalGateObservation(body);
        } catch (error) {
          const message = error instanceof Error ? error.message : "invalid sidecar default-on candidate final gate input";
          throw new BrokerError("bad_request", message);
        }
        const report = buildTerminalBriefSidecarDefaultOnCandidateFinalGate(
          observation,
          extractTerminalBriefSidecarDefaultOnCandidateFinalGateOptions(body),
        );
        return sendJson(res, 200, report, {
          "cache-control": "no-store",
        });
      }

      if (req.method === "POST" && path === "/terminal-brief/sidecar/default-on-approval-request") {
        if (enforceRequesterIdentity) {
          assertRequesterHasRole(requesterIdentity, ["hub", "operator"], "terminal_brief.sidecar_default_on_approval_request.read");
        }
        const body = await readJson<Record<string, unknown>>(req);
        let finalGate;
        try {
          finalGate = extractTerminalBriefSidecarDefaultOnApprovalRequestFinalGate(body);
        } catch (error) {
          const message = error instanceof Error ? error.message : "invalid sidecar default-on approval request input";
          throw new BrokerError("bad_request", message);
        }
        const report = buildTerminalBriefSidecarDefaultOnApprovalRequest(
          finalGate,
          extractTerminalBriefSidecarDefaultOnApprovalRequestOptions(body),
        );
        return sendJson(res, 200, report, {
          "cache-control": "no-store",
        });
      }

      if (req.method === "POST" && path === "/terminal-brief/sidecar/default-on-approval-evidence") {
        if (enforceRequesterIdentity) {
          assertRequesterHasRole(requesterIdentity, ["hub", "operator"], "terminal_brief.sidecar_default_on_approval_evidence.read");
        }
        const body = await readJson<Record<string, unknown>>(req);
        let approvalRequest;
        try {
          approvalRequest = extractTerminalBriefSidecarDefaultOnApprovalRequestPacket(body);
        } catch (error) {
          const message = error instanceof Error ? error.message : "invalid sidecar default-on approval evidence input";
          throw new BrokerError("bad_request", message);
        }
        const report = buildTerminalBriefSidecarDefaultOnApprovalEvidenceIngestor(
          approvalRequest,
          extractTerminalBriefSidecarDefaultOnApprovalEvidence(body),
          extractTerminalBriefSidecarDefaultOnApprovalEvidenceIngestorOptions(body),
        );
        return sendJson(res, 200, report, {
          "cache-control": "no-store",
        });
      }

      if (req.method === "POST" && path === "/terminal-brief/sidecar/default-on-enablement-gate") {
        if (enforceRequesterIdentity) {
          assertRequesterHasRole(requesterIdentity, ["hub", "operator"], "terminal_brief.sidecar_default_on_enablement_gate.read");
        }
        const body = await readJson<Record<string, unknown>>(req);
        let approvalEvidence;
        try {
          approvalEvidence = extractTerminalBriefSidecarDefaultOnEnablementGateApprovalEvidence(body);
        } catch (error) {
          const message = error instanceof Error ? error.message : "invalid sidecar default-on enablement gate input";
          throw new BrokerError("bad_request", message);
        }
        const report = buildTerminalBriefSidecarDefaultOnEnablementGate(
          approvalEvidence,
          extractTerminalBriefSidecarDefaultOnEnablementGateOptions(body),
        );
        return sendJson(res, 200, report, {
          "cache-control": "no-store",
        });
      }

      if (req.method === "POST" && path === "/terminal-brief/sidecar/default-on-runtime-mutation-plan") {
        if (enforceRequesterIdentity) {
          assertRequesterHasRole(requesterIdentity, ["hub", "operator"], "terminal_brief.sidecar_default_on_runtime_mutation_plan.read");
        }
        const body = await readJson<Record<string, unknown>>(req);
        let enablementGate;
        try {
          enablementGate = extractTerminalBriefSidecarDefaultOnRuntimeMutationPlanEnablementGate(body);
        } catch (error) {
          const message = error instanceof Error ? error.message : "invalid sidecar default-on runtime mutation plan input";
          throw new BrokerError("bad_request", message);
        }
        const report = buildTerminalBriefSidecarDefaultOnRuntimeMutationPlan(
          enablementGate,
          extractTerminalBriefSidecarDefaultOnRuntimeMutationPlanOptions(body),
        );
        return sendJson(res, 200, report, {
          "cache-control": "no-store",
        });
      }

      if (req.method === "POST" && path === "/terminal-brief/sidecar/default-on-execution-rollback-envelope") {
        if (enforceRequesterIdentity) {
          assertRequesterHasRole(requesterIdentity, ["hub", "operator"], "terminal_brief.sidecar_default_on_execution_rollback_envelope.read");
        }
        const body = await readJson<Record<string, unknown>>(req);
        let plan;
        try {
          plan = extractTerminalBriefSidecarDefaultOnExecutionRollbackEnvelopePlan(body);
        } catch (error) {
          const message = error instanceof Error ? error.message : "invalid sidecar default-on execution rollback envelope input";
          throw new BrokerError("bad_request", message);
        }
        const report = buildTerminalBriefSidecarDefaultOnExecutionRollbackEnvelope(
          plan,
          extractTerminalBriefSidecarDefaultOnExecutionRollbackEnvelopeOptions(body),
        );
        return sendJson(res, 200, report, {
          "cache-control": "no-store",
        });
      }

      if (req.method === "POST" && path === "/terminal-brief/sidecar/default-on-execution-approval-request") {
        if (enforceRequesterIdentity) {
          assertRequesterHasRole(requesterIdentity, ["hub", "operator"], "terminal_brief.sidecar_default_on_execution_approval_request.read");
        }
        const body = await readJson<Record<string, unknown>>(req);
        let envelope;
        try {
          envelope = extractTerminalBriefSidecarDefaultOnExecutionApprovalRequestEnvelope(body);
        } catch (error) {
          const message = error instanceof Error ? error.message : "invalid sidecar default-on execution approval request input";
          throw new BrokerError("bad_request", message);
        }
        const report = buildTerminalBriefSidecarDefaultOnExecutionApprovalRequest(
          envelope,
          extractTerminalBriefSidecarDefaultOnExecutionApprovalRequestOptions(body),
        );
        return sendJson(res, 200, report, {
          "cache-control": "no-store",
        });
      }

      if (req.method === "POST" && path === "/terminal-brief/sidecar/default-on-execution-approval-evidence") {
        if (enforceRequesterIdentity) {
          assertRequesterHasRole(requesterIdentity, ["hub", "operator"], "terminal_brief.sidecar_default_on_execution_approval_evidence.read");
        }
        const body = await readJson<Record<string, unknown>>(req);
        let approvalRequest;
        try {
          approvalRequest = extractTerminalBriefSidecarDefaultOnExecutionApprovalRequestPacket(body);
        } catch (error) {
          const message = error instanceof Error ? error.message : "invalid sidecar default-on execution approval evidence input";
          throw new BrokerError("bad_request", message);
        }
        const report = buildTerminalBriefSidecarDefaultOnExecutionApprovalEvidenceIngestor(
          approvalRequest,
          extractTerminalBriefSidecarDefaultOnExecutionApprovalEvidence(body),
          extractTerminalBriefSidecarDefaultOnExecutionApprovalEvidenceIngestorOptions(body),
        );
        return sendJson(res, 200, report, {
          "cache-control": "no-store",
        });
      }

      if (req.method === "POST" && path === "/terminal-brief/sidecar/default-on-runtime-execution-final-gate") {
        if (enforceRequesterIdentity) {
          assertRequesterHasRole(requesterIdentity, ["hub", "operator"], "terminal_brief.sidecar_default_on_runtime_execution_final_gate.read");
        }
        const body = await readJson<Record<string, unknown>>(req);
        let evidence;
        try {
          evidence = extractTerminalBriefSidecarDefaultOnRuntimeExecutionFinalGateEvidence(body);
        } catch (error) {
          const message = error instanceof Error ? error.message : "invalid sidecar default-on runtime execution final gate input";
          throw new BrokerError("bad_request", message);
        }
        const report = buildTerminalBriefSidecarDefaultOnRuntimeExecutionFinalGate(
          evidence,
          extractTerminalBriefSidecarDefaultOnRuntimeExecutionFinalGateOptions(body),
        );
        return sendJson(res, 200, report, {
          "cache-control": "no-store",
        });
      }

      if (req.method === "POST" && path === "/terminal-brief/sidecar/default-on-runtime-execution-request-draft") {
        if (enforceRequesterIdentity) {
          assertRequesterHasRole(requesterIdentity, ["hub", "operator"], "terminal_brief.sidecar_default_on_runtime_execution_request_draft.read");
        }
        const body = await readJson<Record<string, unknown>>(req);
        let finalGate;
        try {
          finalGate = extractTerminalBriefSidecarDefaultOnRuntimeExecutionRequestDraftFinalGate(body);
        } catch (error) {
          const message = error instanceof Error ? error.message : "invalid sidecar default-on runtime execution request draft input";
          throw new BrokerError("bad_request", message);
        }
        const report = buildTerminalBriefSidecarDefaultOnRuntimeExecutionRequestDraft(
          finalGate,
          extractTerminalBriefSidecarDefaultOnRuntimeExecutionRequestDraftOptions(body),
        );
        return sendJson(res, 200, report, {
          "cache-control": "no-store",
        });
      }

      if (req.method === "POST" && path === "/terminal-brief/sidecar/default-on-runtime-execution-approval-evidence") {
        if (enforceRequesterIdentity) {
          assertRequesterHasRole(requesterIdentity, ["hub", "operator"], "terminal_brief.sidecar_default_on_runtime_execution_approval_evidence.read");
        }
        const body = await readJson<Record<string, unknown>>(req);
        let requestDraft;
        try {
          requestDraft = extractTerminalBriefSidecarDefaultOnRuntimeExecutionRequestDraftPacket(body);
        } catch (error) {
          const message = error instanceof Error ? error.message : "invalid sidecar default-on runtime execution approval evidence input";
          throw new BrokerError("bad_request", message);
        }
        const report = buildTerminalBriefSidecarDefaultOnRuntimeExecutionApprovalEvidenceIngestor(
          requestDraft,
          extractTerminalBriefSidecarDefaultOnRuntimeExecutionApprovalEvidence(body),
          extractTerminalBriefSidecarDefaultOnRuntimeExecutionApprovalEvidenceIngestorOptions(body),
        );
        return sendJson(res, 200, report, {
          "cache-control": "no-store",
        });
      }

      if (req.method === "POST" && path === "/terminal-brief/sidecar/default-on-runtime-executor-gate") {
        if (enforceRequesterIdentity) {
          assertRequesterHasRole(requesterIdentity, ["hub", "operator"], "terminal_brief.sidecar_default_on_runtime_executor_gate.read");
        }
        const body = await readJson<Record<string, unknown>>(req);
        let evidence;
        try {
          evidence = extractTerminalBriefSidecarDefaultOnRuntimeExecutorGateEvidence(body);
        } catch (error) {
          const message = error instanceof Error ? error.message : "invalid sidecar default-on runtime executor gate input";
          throw new BrokerError("bad_request", message);
        }
        const report = buildTerminalBriefSidecarDefaultOnRuntimeExecutorGate(
          evidence,
          extractTerminalBriefSidecarDefaultOnRuntimeExecutorGateOptions(body),
        );
        return sendJson(res, 200, report, {
          "cache-control": "no-store",
        });
      }

      if (req.method === "POST" && path === "/terminal-brief/sidecar/default-on-final-live-execution") {
        if (enforceRequesterIdentity) {
          assertRequesterHasRole(requesterIdentity, ["hub", "operator"], "terminal_brief.sidecar_default_on_final_live_execution.read");
        }
        const body = await readJson<Record<string, unknown>>(req);
        let gate;
        try {
          gate = extractTerminalBriefSidecarDefaultOnFinalLiveExecutionGate(body);
        } catch (error) {
          const message = error instanceof Error ? error.message : "invalid sidecar default-on final live execution input";
          throw new BrokerError("bad_request", message);
        }
        const report = buildTerminalBriefSidecarDefaultOnFinalLiveExecution(
          gate,
          extractTerminalBriefSidecarDefaultOnFinalLiveExecutionOptions(body),
        );
        return sendJson(res, 200, report, {
          "cache-control": "no-store",
        });
      }

      if (req.method === "POST" && path === "/terminal-brief/sidecar/default-on-execution-window-request-draft") {
        if (enforceRequesterIdentity) {
          assertRequesterHasRole(requesterIdentity, ["hub", "operator"], "terminal_brief.sidecar_default_on_execution_window_request_draft.read");
        }
        const body = await readJson<Record<string, unknown>>(req);
        let finalLiveExecution;
        try {
          finalLiveExecution = extractTerminalBriefSidecarDefaultOnExecutionWindowRequestDraftFinalLiveExecution(body);
        } catch (error) {
          const message = error instanceof Error ? error.message : "invalid sidecar default-on execution window request draft input";
          throw new BrokerError("bad_request", message);
        }
        const report = buildTerminalBriefSidecarDefaultOnExecutionWindowRequestDraft(
          finalLiveExecution,
          extractTerminalBriefSidecarDefaultOnExecutionWindowRequestDraftOptions(body),
        );
        return sendJson(res, 200, report, {
          "cache-control": "no-store",
        });
      }

      if (req.method === "POST" && path === "/terminal-brief/sidecar/default-on-execution-window-approval-evidence") {
        if (enforceRequesterIdentity) {
          assertRequesterHasRole(requesterIdentity, ["hub", "operator"], "terminal_brief.sidecar_default_on_execution_window_approval_evidence.read");
        }
        const body = await readJson<Record<string, unknown>>(req);
        let requestDraft;
        try {
          requestDraft = extractTerminalBriefSidecarDefaultOnExecutionWindowApprovalEvidenceRequestDraft(body);
        } catch (error) {
          const message = error instanceof Error ? error.message : "invalid sidecar default-on execution window approval evidence input";
          throw new BrokerError("bad_request", message);
        }
        const report = buildTerminalBriefSidecarDefaultOnExecutionWindowApprovalEvidenceIngestor(
          requestDraft,
          extractTerminalBriefSidecarDefaultOnExecutionWindowApprovalEvidence(body),
          extractTerminalBriefSidecarDefaultOnExecutionWindowApprovalEvidenceIngestorOptions(body),
        );
        return sendJson(res, 200, report, {
          "cache-control": "no-store",
        });
      }

      if (req.method === "POST" && path === "/terminal-brief/sidecar/default-on-final-runtime-mutation-executor-gate") {
        if (enforceRequesterIdentity) {
          assertRequesterHasRole(requesterIdentity, ["hub", "operator"], "terminal_brief.sidecar_default_on_final_runtime_mutation_executor_gate.read");
        }
        const body = await readJson<Record<string, unknown>>(req);
        let evidence;
        try {
          evidence = extractTerminalBriefSidecarDefaultOnFinalRuntimeMutationExecutorGateEvidence(body);
        } catch (error) {
          const message = error instanceof Error ? error.message : "invalid sidecar default-on final runtime mutation executor gate input";
          throw new BrokerError("bad_request", message);
        }
        const report = buildTerminalBriefSidecarDefaultOnFinalRuntimeMutationExecutorGate(
          evidence,
          extractTerminalBriefSidecarDefaultOnFinalRuntimeMutationExecutorGateOptions(body),
        );
        return sendJson(res, 200, report, {
          "cache-control": "no-store",
        });
      }

      if (req.method === "POST" && path === "/terminal-brief/sidecar/default-on-live-executor") {
        if (enforceRequesterIdentity) {
          assertRequesterHasRole(requesterIdentity, ["hub", "operator"], "terminal_brief.sidecar_default_on_live_executor.read");
        }
        const body = await readJson<Record<string, unknown>>(req);
        let gate;
        try {
          gate = extractTerminalBriefSidecarDefaultOnLiveExecutorGate(body);
        } catch (error) {
          const message = error instanceof Error ? error.message : "invalid sidecar default-on live executor input";
          throw new BrokerError("bad_request", message);
        }
        const report = buildTerminalBriefSidecarDefaultOnLiveExecutor(
          gate,
          extractTerminalBriefSidecarDefaultOnLiveExecutorOptions(body),
        );
        return sendJson(res, 200, report, {
          "cache-control": "no-store",
        });
      }

      if (req.method === "POST" && path === "/terminal-brief/sidecar/preflight-evidence-collector") {
        if (enforceRequesterIdentity) {
          assertRequesterHasRole(requesterIdentity, ["hub", "operator"], "terminal_brief.sidecar_preflight_evidence_collector.read");
        }
        const body = await readJson<Record<string, unknown>>(req);
        let dryRunStartCanaryPlan;
        try {
          dryRunStartCanaryPlan = extractTerminalBriefSidecarPreflightEvidenceCollectorCanaryPlan(body);
        } catch (error) {
          const message = error instanceof Error ? error.message : "invalid sidecar preflight evidence collector input";
          throw new BrokerError("bad_request", message);
        }
        const report = buildTerminalBriefSidecarPreflightEvidenceCollector(
          dryRunStartCanaryPlan,
          extractTerminalBriefSidecarPreflightEvidence(body),
          extractTerminalBriefSidecarPreflightEvidenceCollectorOptions(body),
        );
        return sendJson(res, 200, report, {
          "cache-control": "no-store",
        });
      }

      if (req.method === "POST" && path === "/terminal-brief/sidecar/preflight-chain-review") {
        if (enforceRequesterIdentity) {
          assertRequesterHasRole(requesterIdentity, ["hub", "operator"], "terminal_brief.sidecar_preflight_chain_review.read");
        }
        const body = await readJson<Record<string, unknown>>(req);
        let preflightCollector;
        try {
          preflightCollector = extractTerminalBriefSidecarPreflightChainReviewCollector(body);
        } catch (error) {
          const message = error instanceof Error ? error.message : "invalid sidecar preflight chain review input";
          throw new BrokerError("bad_request", message);
        }
        const report = buildTerminalBriefSidecarPreflightChainReview(
          preflightCollector,
          extractTerminalBriefSidecarPreflightChainReviewOptions(body),
        );
        return sendJson(res, 200, report, {
          "cache-control": "no-store",
        });
      }

      if (req.method === "POST" && path === "/terminal-brief/sidecar/dry-run-start-approval-request") {
        if (enforceRequesterIdentity) {
          assertRequesterHasRole(requesterIdentity, ["hub", "operator"], "terminal_brief.sidecar_dry_run_start_approval_request.read");
        }
        const body = await readJson<Record<string, unknown>>(req);
        let chainReview;
        try {
          chainReview = extractTerminalBriefSidecarDryRunStartApprovalRequestChainReview(body);
        } catch (error) {
          const message = error instanceof Error ? error.message : "invalid sidecar dry-run start approval request input";
          throw new BrokerError("bad_request", message);
        }
        const report = buildTerminalBriefSidecarDryRunStartApprovalRequest(
          chainReview,
          extractTerminalBriefSidecarDryRunStartApprovalRequestOptions(body),
        );
        return sendJson(res, 200, report, {
          "cache-control": "no-store",
        });
      }

      if (req.method === "POST" && path === "/terminal-brief/sidecar/dry-run-start-approval-receipt") {
        if (enforceRequesterIdentity) {
          assertRequesterHasRole(requesterIdentity, ["hub", "operator"], "terminal_brief.sidecar_dry_run_start_approval_receipt.read");
        }
        const body = await readJson<Record<string, unknown>>(req);
        let approvalRequest;
        try {
          approvalRequest = extractTerminalBriefSidecarDryRunStartApprovalRequestPacket(body);
        } catch (error) {
          const message = error instanceof Error ? error.message : "invalid sidecar dry-run start approval receipt input";
          throw new BrokerError("bad_request", message);
        }
        const report = buildTerminalBriefSidecarDryRunStartApprovalReceiptIngestor(
          approvalRequest,
          extractTerminalBriefSidecarDryRunStartApprovalReceiptEvidence(body),
          extractTerminalBriefSidecarDryRunStartApprovalReceiptIngestorOptions(body),
        );
        return sendJson(res, 200, report, {
          "cache-control": "no-store",
        });
      }

      if (req.method === "GET" && path === "/operator/cleanup/plan") {
        if (enforceRequesterIdentity) {
          assertRequesterHasRole(requesterIdentity, ["hub", "operator"], "operator.cleanup.plan");
        }
        if (!(stateStore instanceof SqliteBrokerStateStore)) {
          throw new BrokerError("bad_request", "broker cleanup planning requires sqlite persistence");
        }
        const plan = buildBrokerCleanupPlan(stateStore, cleanupPlanOptionsFromUrl(url));
        return sendJson(res, 200, plan, { "cache-control": "no-store" });
      }

      if (req.method === "POST" && path === "/operator/cleanup/execute") {
        if (enforceRequesterIdentity) {
          assertRequesterHasRole(requesterIdentity, ["hub", "operator"], "operator.cleanup.execute");
        }
        if (!(stateStore instanceof SqliteBrokerStateStore)) {
          throw new BrokerError("bad_request", "broker cleanup execution requires sqlite persistence");
        }
        const body = await readJson<Record<string, unknown>>(req);
        const plan = buildBrokerCleanupPlan(stateStore, cleanupPlanOptionsFromBody(body));
        const executionOptions = {
          approvalToken: optionalString(body?.approvalToken),
          confirmation: optionalString(body?.confirmation),
          backupProof: optionalString(body?.backupProof),
          allowWorkerPrune: body?.allowWorkerPrune === true,
          actorId: requesterIdentity?.id,
        };
        const blockers = validateCleanupExecution(plan, executionOptions);
        if (blockers.length > 0) {
          return sendJson(res, 409, {
            ok: false,
            error: "cleanup_execution_blocked",
            blockers,
            plan,
          }, { "cache-control": "no-store" });
        }
        const result = executeBrokerCleanupPlan(stateStore, plan, executionOptions);
        return sendJson(res, 200, { ok: true, plan, result }, { "cache-control": "no-store" });
      }

      // GET /alerts — monitoring-friendly alert projection
      if (req.method === "GET" && path === "/alerts") {
        const hotTableGrowth: HotTableGrowthProjection | undefined =
          stateStore instanceof SqliteBrokerStateStore
            ? projectHotTableGrowth({
                current: stateStore.readHotTableLoadMetrics(),
                runtimeLoadLimits: stateStore.readHotTableRuntimeLoadLimits(),
              })
            : undefined;
        const result = buildAlertScan({
          broker,
          staleAfterMs: numberQueryParam(url, "stale_after_ms") ?? DEFAULT_ALERT_STALE_AFTER_MS,
          longRunningAfterMs: numberQueryParam(url, "long_running_after_ms") ?? DEFAULT_ALERT_LONG_RUNNING_AFTER_MS,
          staleWarningMs: numberQueryParam(url, "stale_warning_ms") ?? undefined,
          staleCriticalMs: numberQueryParam(url, "stale_critical_ms") ?? undefined,
          longRunningWarningMs: numberQueryParam(url, "long_running_warning_ms") ?? undefined,
          longRunningCriticalMs: numberQueryParam(url, "long_running_critical_ms") ?? undefined,
          workerHeartbeatMissedAfterMs:
            numberQueryParam(url, "worker_heartbeat_missed_after_ms") ?? workerOfflineAfterSec * 1000,
          hotTableGrowth,
        });
        return sendJson(res, 200, result);
      }

      // GET /cleanup/candidates — read-only cleanup candidate discovery (issue #520)
      if (req.method === "GET" && path === "/cleanup/candidates") {
        if (enforceRequesterIdentity) {
          assertRequesterHasRole(requesterIdentity, ["hub", "operator"], "cleanup.candidates.read");
        }
        const plan = broker.discoverCleanupCandidates({
          staleWorkerAfterMs: numberQueryParam(url, "stale_worker_after_ms") ?? undefined,
          staleTaskAfterMs: numberQueryParam(url, "stale_task_after_ms") ?? undefined,
          terminalOutboxBacklogAfterMs: numberQueryParam(url, "terminal_outbox_backlog_after_ms") ?? undefined,
          historicalTerminalAfterMs: numberQueryParam(url, "historical_terminal_after_ms") ?? undefined,
        });
        return sendJson(res, 200, plan, {
          "cache-control": "no-store",
        });
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

      if (req.method === "POST" && path === "/workers/register") {
        const verifiedWorker = await assertWorkerHttpSignatureRoute(req, url);
        const readJsonStartedAt = performance.now();
        const body = await readJson<RegisterWorkerRequest>(req);
        recordWorkerRegisterPhase("readJson", readJsonStartedAt);
        if (!body) {
          throw new BrokerError("bad_request", "request body is required");
        }
        const workerId = typeof body.nodeId === "string" ? body.nodeId : undefined;
        assertVerifiedWorkerMatches(verifiedWorker, workerId, "worker.register");
        if (enforceRequesterIdentity) {
          const authAssertStartedAt = performance.now();
          assertRequesterMatchesParty(
            requesterIdentity,
            { id: body.nodeId, role: body.role },
            "worker.register",
          );
          recordWorkerRegisterPhase("authAssert", authAssertStartedAt, workerId);
        }
        const brokerRegisterStartedAt = performance.now();
        const worker = broker.registerWorker(body);
        recordWorkerRegisterPhase("brokerRegister", brokerRegisterStartedAt, workerId);
        // Registration is always online — use toWorkerView for consistent fields
        const toWorkerViewStartedAt = performance.now();
        const workerView = toWorkerView(worker, workerOfflineAfterSec * 1000);
        recordWorkerRegisterPhase("toWorkerView", toWorkerViewStartedAt, workerId);
        await awaitDurablePersistenceAck(stateStore);
        return sendJson(res, 201, { ...workerView, brokerId });
      }

      if (req.method === "POST" && segments[0] === "workers" && segments[1] && segments[2] === "heartbeat") {
        const verifiedWorker = await assertWorkerHttpSignatureRoute(req, url);
        const workerId = segments[1];
        assertVerifiedWorkerMatches(verifiedWorker, workerId, "worker.heartbeat");
        const readJsonStartedAt = performance.now();
        const body = await readJson<WorkerHeartbeatRequest>(req);
        recordWorkerHeartbeatPhase("readJson", readJsonStartedAt, workerId);
        if (enforceRequesterIdentity) {
          const authLookupStartedAt = performance.now();
          const existingWorker = broker.getWorkerCachedFirst(workerId);
          recordWorkerHeartbeatPhase("authLookup", authLookupStartedAt, workerId);
          const authAssertStartedAt = performance.now();
          assertRequesterMatchesParty(
            requesterIdentity,
            { id: workerId, role: existingWorker?.role },
            "worker.heartbeat",
          );
          recordWorkerHeartbeatPhase("authAssert", authAssertStartedAt, workerId);
        }
        const heartbeatStartedAt = performance.now();
        const worker = broker.heartbeatWorker(workerId, body ?? undefined);
        recordWorkerHeartbeatPhase("brokerHeartbeat", heartbeatStartedAt, workerId);
        // Heartbeat always implies worker-plane online — use toWorkerView for consistent fields
        const toWorkerViewStartedAt = performance.now();
        const workerView = toWorkerView(worker, workerOfflineAfterSec * 1000);
        recordWorkerHeartbeatPhase("toWorkerView", toWorkerViewStartedAt, workerId);
        await awaitDurablePersistenceAck(stateStore);
        return sendJson(res, 200, workerView);
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

      if (req.method === "GET" && path === "/proposals") {
        return handleProposalsListRequest({ res, url, stateStore, broker });
      }

      if (req.method === "POST" && path === "/proposals") {
        const body = await readJson<CreateProposalRequest>(req);
        if (!body) {
          throw new BrokerError("bad_request", "request body is required");
        }
        if (enforceRequesterIdentity) {
          assertRequesterMatchesParty(
            requesterIdentity,
            { id: body.source.id, role: body.source.role },
            "proposal.create",
          );
        }
        const proposal = broker.createProposal(body);
        await awaitDurablePersistenceAck(stateStore);
        return sendJson(res, 201, proposal);
      }

      if (req.method === "GET" && segments[0] === "proposals" && segments[1] && segments.length === 2) {
        return handleProposalByIdRequest({ res, url, stateStore, broker, proposalId: segments[1] });
      }

      if (
        req.method === "GET" &&
        segments[0] === "rounds" &&
        segments[1] &&
        segments[2] === "status" &&
        segments.length === 3
      ) {
        return handleRoundStatusRequest({
          res,
          rawParentRoundId: segments[1],
          getRoundStatus: (parentRoundId) => broker.getRoundStatus(parentRoundId),
        });
      }

      if (req.method === "POST" && segments[0] === "proposals" && segments[1] && segments[2] === "artifacts") {
        const body = await readJson<AttachArtifactRequest>(req);
        if (!body) {
          throw new BrokerError("bad_request", "request body is required");
        }
        if (enforceRequesterIdentity) {
          const proposal = broker.getProposal(segments[1]);
          if (!proposal) {
            throw new BrokerError("not_found", "proposal not found");
          }
          assertRequesterCanTouchProposalArtifacts(requesterIdentity, proposal);
        }
        const artifact = broker.attachArtifact(segments[1], body);
        await awaitDurablePersistenceAck(stateStore);
        return sendJson(res, 201, artifact);
      }

      if (req.method === "POST" && segments[0] === "proposals" && segments[1] && segments[2] === "validate") {
        const body = await readJson<SubmitValidationRequest>(req);
        if (!body) {
          throw new BrokerError("bad_request", "request body is required");
        }
        if (enforceRequesterIdentity) {
          assertRequesterMatchesParty(requesterIdentity, { id: body.nodeId }, "proposal.validate");
        }
        const validation = broker.submitValidationResult(segments[1], body);
        await awaitDurablePersistenceAck(stateStore);
        return sendJson(res, 201, validation);
      }

      if (req.method === "POST" && segments[0] === "proposals" && segments[1] && segments[2] === "approve") {
        const body = await readJson<ProposalActorRequest>(req);
        if (!body?.actor?.id) {
          throw new BrokerError("bad_request", "actor.id is required");
        }
        if (enforceRequesterIdentity) {
          assertRequesterMatchesParty(
            requesterIdentity,
            { id: body.actor.id, role: body.actor.role },
            "proposal.approve",
          );
        }
        const proposal = broker.approveProposal(segments[1], body);
        await awaitDurablePersistenceAck(stateStore);
        return sendJson(res, 200, {
          ok: true,
          proposalId: proposal.id,
          status: proposal.status,
          updatedAt: proposal.updatedAt,
        });
      }

      if (req.method === "POST" && segments[0] === "proposals" && segments[1] && segments[2] === "reject") {
        const body = await readJson<ProposalActorRequest>(req);
        if (!body?.actor?.id) {
          throw new BrokerError("bad_request", "actor.id is required");
        }
        if (enforceRequesterIdentity) {
          assertRequesterMatchesParty(
            requesterIdentity,
            { id: body.actor.id, role: body.actor.role },
            "proposal.reject",
          );
        }
        const proposal = broker.rejectProposal(segments[1], body);
        await awaitDurablePersistenceAck(stateStore);
        return sendJson(res, 200, {
          ok: true,
          proposalId: proposal.id,
          status: proposal.status,
          updatedAt: proposal.updatedAt,
        });
      }

      if (req.method === "POST" && segments[0] === "proposals" && segments[1] && segments[2] === "apply") {
        const body = await readJson<ApplyProposalRequest>(req);
        if (!body?.actor?.id || !body.workspace?.nodeId || !body.workspace?.workspaceId) {
          throw new BrokerError("bad_request", "actor.id, workspace.nodeId, and workspace.workspaceId are required");
        }
        if (enforceRequesterIdentity) {
          assertRequesterMatchesParty(
            requesterIdentity,
            { id: body.actor.id, role: body.actor.role },
            "proposal.apply",
          );
        }
        const proposal = broker.applyProposalLocally(segments[1], body);
        await awaitDurablePersistenceAck(stateStore);
        return sendJson(res, 200, {
          ok: true,
          proposalId: proposal.id,
          status: proposal.status,
          updatedAt: proposal.updatedAt,
        });
      }

      if (req.method === "GET" && path === "/tasks") {
        if (url.searchParams.has("worker") || url.searchParams.has("assignedWorkerId")) {
          const workerParam = optionalString(url.searchParams.get("worker"));
          const assignedWorkerParam = optionalString(url.searchParams.get("assignedWorkerId"));
          if (workerParam && assignedWorkerParam && workerParam !== assignedWorkerParam) {
            throw new BrokerError("bad_request", "worker and assignedWorkerId query parameters must match when both are provided");
          }
          const expectedWorkerId = assignedWorkerParam ?? workerParam;
          if (!expectedWorkerId) {
            throw new BrokerError("bad_request", "worker or assignedWorkerId query parameter is required");
          }
          const verifiedWorker = await assertWorkerHttpSignatureRoute(req, url);
          assertVerifiedWorkerMatches(verifiedWorker, expectedWorkerId, "tasks.list");
        }
        const filters = taskFiltersFromUrl(url, { defaultLimit: DEFAULT_TASK_LIST_LIMIT });
        const includeFullTaskRecords = url.searchParams.get("detail") === "full" || url.searchParams.get("include") === "full";
        if (includeFullTaskRecords) {
          const tasks = listTasksForReadPath(stateStore, broker, filters);
          return sendJson(res, 200, {
            count: tasks.length,
            limit: filters.limit,
            items: tasks,
          });
        }
        const items = listTaskItemsForReadPath(stateStore, broker, filters);
        return sendJson(res, 200, {
          count: items.length,
          limit: filters.limit,
          items,
        });
      }

      if (req.method === "POST" && path === "/tasks") {
        const body = await readJson<CreateTaskRequest>(req);
        if (!body) {
          throw new BrokerError("bad_request", "request body is required");
        }
        assertCreateTaskRequestParties(body);
        if (enforceRequesterIdentity) {
          assertRequesterMatchesParty(
            requesterIdentity,
            { id: body.requester.id, role: body.requester.role },
            "task.create",
          );
        }
        assertCreateTaskPayloadWithinLimit(body, maxTaskPayloadBytes);
        const task = broker.createTask(body);
        // Durable-ack disambiguation (a2a-nexus#636/#638): at this point the
        // task EXISTS in the broker — a persistence-queue ack timeout must
        // not be reported as a creation failure with no task id, or the
        // operator cannot tell rejected from accepted-but-slow. 202 carries
        // the created task plus the ack error so dispatch tooling can
        // classify it as accepted-unconfirmed and verify via GET /tasks/:id.
        try {
          await awaitDurablePersistenceAck(stateStore);
        } catch (error) {
          if (
            error instanceof BrokerError &&
            (error.code === "queue_drain_timeout" || error.code === "queue_saturated")
          ) {
            return sendJson(res, 202, {
              task,
              durable: false,
              ackError: { code: error.code, message: error.message },
              hint: `task ${task.id} was created; confirm with GET /tasks/${task.id} — it persists on the next successful flush`,
            });
          }
          throw error;
        }
        return sendJson(res, 201, task);
      }

      if (req.method === "POST" && path === "/tasks/requeue_stale") {
        if (enforceRequesterIdentity) {
          assertRequesterHasRole(requesterIdentity, ["hub", "operator"], "task.requeue_stale");
        }
        const olderThanSec = numberQueryParam(url, "older_than_seconds") ?? 300;
        const { requeued, deadLettered } = broker.requeueStaleTasksDetailed(olderThanSec * 1000, {
          workerOfflineAfterMs: workerOfflineAfterSec * 1000,
        });
        await awaitDurablePersistenceAck(stateStore);
        return sendJson(res, 200, {
          ok: true,
          olderThanSeconds: olderThanSec,
          workerOfflineAfterSeconds: workerOfflineAfterSec,
          maxRequeueAttempts: broker.getMaxRequeueAttempts(),
          policy: "requeue_only",
          requeued: requeued.length,
          deadLettered: deadLettered.length,
          items: requeued.map((task) => ({
            id: task.id,
            status: task.status,
            targetNodeId: task.targetNodeId,
            assignedWorkerId: task.assignedWorkerId,
            proposalId: task.proposalId,
            requeueCount: task.requeueCount,
            updatedAt: task.updatedAt,
          })),
          deadLetteredItems: deadLettered.map((task) => ({
            id: task.id,
            status: task.status,
            targetNodeId: task.targetNodeId,
            assignedWorkerId: task.assignedWorkerId,
            proposalId: task.proposalId,
            requeueCount: task.requeueCount,
            error: task.error,
            updatedAt: task.updatedAt,
          })),
        });
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
      if (req.method === "GET" && path === "/operator/task-report") {
        if (enforceRequesterIdentity) {
          assertRequesterHasRole(requesterIdentity, ["hub", "operator"], "operator.task-report");
        }
        const taskIds = taskIdsFromUrl(url);
        const parentIssue = optionalString(url.searchParams.get("parent_issue"));
        const staleAfterMs = numberQueryParam(url, "stale_after_ms") ?? 15 * 60 * 1000;
        const updatedAfter = optionalString(url.searchParams.get("updated_after"));
        const tasks = taskIds.length
          ? taskIds.map((id) => getTaskForReadPath(stateStore, broker, id)).filter((task): task is TaskRecord => Boolean(task))
          : listTasksForReadPath(stateStore, broker, {});
        const terminalOutbox = broker.getTerminalTaskEventOutbox().subscribe();
        return sendJson(res, 200, buildOperatorTaskReport(tasks, { taskIds, parentIssue, staleAfterMs, updatedAfter, terminalOutbox }));
      }

      if (req.method === "GET" && path === "/tasks/diagnostics") {
        const staleAfterMs = numberQueryParam(url, "stale_after_ms") ?? 120_000;
        const longRunningAfterMs = numberQueryParam(url, "long_running_after_ms") ?? 3_600_000;
        const reports = listTaskDiagnosticsForReadPath(stateStore, broker, { staleAfterMs, longRunningAfterMs });
        return sendJson(res, 200, { items: reports, generatedAt: new Date().toISOString() });
      }

      if (
        req.method === "POST" &&
        segments[0] === "tasks" &&
        segments[1] &&
        segments[2] === "wake" &&
        segments[3] === "plan" &&
        segments.length === 4
      ) {
        const body = await readJson<TaskWakePlanRequest>(req);
        if (!body?.targetSessionKey) {
          throw new BrokerError("bad_request", "targetSessionKey is required");
        }
        if (enforceRequesterIdentity) {
          assertRequesterHasRole(requesterIdentity, ["hub", "operator"], "task.wake.plan");
        }
        const result = broker.planAcceptedTaskWake(segments[1], body);
        await awaitDurablePersistenceAck(stateStore);
        return sendJson(res, result.replayed ? 200 : 201, result);
      }

      if (
        req.method === "POST" &&
        segments[0] === "tasks" &&
        segments[1] &&
        segments[2] === "wake" &&
        segments[3] === "decision" &&
        segments.length === 4
      ) {
        const body = await readJson<TaskWakeDecisionRequest>(req);
        if (!body?.status) {
          throw new BrokerError("bad_request", "status is required");
        }
        if (enforceRequesterIdentity) {
          assertRequesterHasRole(requesterIdentity, ["hub", "operator"], "task.wake.decision");
        }
        const task = broker.recordTaskWakeDecision(segments[1], body);
        await awaitDurablePersistenceAck(stateStore);
        return sendJson(res, 200, task);
      }

      if (req.method === "GET" && segments[0] === "tasks" && segments[1] && segments.length === 2) {
        const task = getTaskForReadPath(stateStore, broker, segments[1], {
          includeStaleReadPath: url.searchParams
            .getAll("include")
            .flatMap((value) => value.split(","))
            .map((value) => value.trim())
            .includes("stale_read_path"),
        });
        if (!task) {
          throw new BrokerError("not_found", "task not found");
        }
        return sendJson(res, 200, task);
      }

      // GET /tasks/:id/diagnostics — monitoring-friendly diagnostic report
      if (
        req.method === "GET" &&
        segments[0] === "tasks" &&
        segments[1] &&
        segments[2] === "diagnostics" &&
        segments.length === 3
      ) {
        const report = getTaskDiagnosticsForReadPath(stateStore, broker, segments[1], {
          staleAfterMs: numberQueryParam(url, "stale_after_ms") ?? undefined,
          longRunningAfterMs: numberQueryParam(url, "long_running_after_ms") ?? undefined,
        });
        return sendJson(res, 200, report);
      }

      if (
        req.method === "POST" && segments[0] === "tasks" && segments[1] && segments[2] === "claim") {
        const verifiedWorker = await assertWorkerHttpSignatureRoute(req, url);
        const body = await readJson<TaskClaimRequest>(req);
        if (!body?.workerId) {
          throw new BrokerError("bad_request", "workerId is required");
        }
        assertVerifiedWorkerMatches(verifiedWorker, body.workerId, "task.claim");
        if (enforceRequesterIdentity) {
          assertRequesterMatchesParty(requesterIdentity, { id: body.workerId }, "task.claim");
        }
        const task = broker.claimTask(segments[1], body.workerId);
        await awaitDurablePersistenceAck(stateStore);
        return sendJson(res, 200, task);
      }

      if (req.method === "POST" && segments[0] === "tasks" && segments[1] && segments[2] === "start") {
        const verifiedWorker = await assertWorkerHttpSignatureRoute(req, url);
        const body = await readJson<TaskClaimRequest>(req);
        if (!body?.workerId) {
          throw new BrokerError("bad_request", "workerId is required");
        }
        assertVerifiedWorkerMatches(verifiedWorker, body.workerId, "task.start");
        if (enforceRequesterIdentity) {
          assertRequesterMatchesParty(requesterIdentity, { id: body.workerId }, "task.start");
        }
        const task = broker.startTask(segments[1], body.workerId);
        await awaitDurablePersistenceAck(stateStore);
        return sendJson(res, 200, task);
      }

      if (req.method === "POST" && segments[0] === "tasks" && segments[1] && segments[2] === "heartbeat") {
        const verifiedWorker = await assertWorkerHttpSignatureRoute(req, url);
        const body = await readJson<TaskClaimRequest>(req);
        if (!body?.workerId) {
          throw new BrokerError("bad_request", "workerId is required");
        }
        assertVerifiedWorkerMatches(verifiedWorker, body.workerId, "task.heartbeat");
        if (enforceRequesterIdentity) {
          assertRequesterMatchesParty(requesterIdentity, { id: body.workerId }, "task.heartbeat");
        }
        const task = broker.heartbeatTask(segments[1], body.workerId);
        await awaitDurablePersistenceAck(stateStore);
        return sendJson(res, 200, task);
      }

      if (req.method === "POST" && segments[0] === "tasks" && segments[1] && segments[2] === "checkpoint") {
        const verifiedWorker = await assertWorkerHttpSignatureRoute(req, url);
        const body = await readJson<{ workerId?: string; state?: string; checkpointId?: string; reason?: string; decisionType?: string; artifactRefs?: string[] }>(req);
        if (!body?.workerId) {
          throw new BrokerError("bad_request", "workerId is required");
        }
        assertVerifiedWorkerMatches(verifiedWorker, body.workerId, "task.checkpoint");
        if (enforceRequesterIdentity) {
          assertRequesterMatchesParty(requesterIdentity, { id: body.workerId }, "task.checkpoint");
        }
        const task = broker.checkpointTask(segments[1], body.workerId, {
          state: body.state as "paused" | "awaiting_operator",
          checkpointId: body.checkpointId,
          reason: body.reason,
          decisionType: body.decisionType,
          artifactRefs: body.artifactRefs,
        });
        await awaitDurablePersistenceAck(stateStore);
        return sendJson(res, 200, task);
      }

      if (req.method === "POST" && segments[0] === "tasks" && segments[1] && segments[2] === "resume") {
        const body = await readJson<{ actorId?: string; checkpointId?: string }>(req);
        const actorId = body?.actorId ?? requesterIdentity?.id;
        if (!actorId) {
          throw new BrokerError("bad_request", "actorId is required");
        }
        const resumeTarget = broker.getTask(segments[1]);
        if (!resumeTarget) {
          throw new BrokerError("not_found", "task not found");
        }
        if (enforceRequesterIdentity) {
          assertRequesterMatchesParty(requesterIdentity, { id: actorId }, "task.resume");
          // Clearing an operator checkpoint is a task mutation: the caller
          // must be a party to the task (requester / target / assigned worker)
          // or a hub/operator. Without this, anyone who knows a task id could
          // clear another task's awaiting_operator checkpoint.
          assertRequesterCanSubscribeToTask(requesterIdentity, resumeTarget);
        }
        const task = broker.resumeTask(segments[1], actorId, { checkpointId: body?.checkpointId });
        await awaitDurablePersistenceAck(stateStore);
        return sendJson(res, 200, task);
      }

      if (req.method === "POST" && segments[0] === "tasks" && segments[1] && segments[2] === "complete") {
        const verifiedWorker = await assertWorkerHttpSignatureRoute(req, url);
        const body = await readJson<TaskCompleteRequest>(req);
        if (!body?.workerId) {
          throw new BrokerError("bad_request", "workerId is required");
        }
        assertVerifiedWorkerMatches(verifiedWorker, body.workerId, "task.complete");
        if (enforceRequesterIdentity) {
          assertRequesterMatchesParty(requesterIdentity, { id: body.workerId }, "task.complete");
        }
        const task = broker.completeTask(segments[1], body.workerId, body.result);
        await awaitDurablePersistenceAck(stateStore);
        return sendJson(res, 200, task);
      }

      if (req.method === "POST" && segments[0] === "tasks" && segments[1] && segments[2] === "evidence") {
        const verifiedWorker = await assertWorkerHttpSignatureRoute(req, url);
        const body = await readJson<TaskEvidenceRequest>(req);
        if (!body?.workerId) {
          throw new BrokerError("bad_request", "workerId is required");
        }
        assertVerifiedWorkerMatches(verifiedWorker, body.workerId, "task.evidence");
        if (enforceRequesterIdentity) {
          assertRequesterMatchesParty(requesterIdentity, { id: body.workerId }, "task.evidence");
        }
        const outcome = body.outcome ?? "done";
        if (outcome === "done" || outcome === "pr") {
          const task = broker.completeTask(segments[1], body.workerId, body.result);
          await awaitDurablePersistenceAck(stateStore);
          return sendJson(res, 200, task);
        }
        if (outcome === "blocked" || outcome === "failed") {
          const task = broker.failTask(segments[1], body.workerId, body.error ?? {
            code: outcome,
            message: body.result?.summary ?? body.result?.note ?? `worker posted ${outcome} evidence`,
          });
          await awaitDurablePersistenceAck(stateStore);
          return sendJson(res, 200, task);
        }
        throw new BrokerError("bad_request", "outcome must be done, pr, blocked, or failed");
      }

      if (req.method === "POST" && segments[0] === "tasks" && segments[1] && segments[2] === "fail") {
        const verifiedWorker = await assertWorkerHttpSignatureRoute(req, url);
        const body = await readJson<TaskFailRequest>(req);
        if (!body?.workerId) {
          throw new BrokerError("bad_request", "workerId is required");
        }
        assertVerifiedWorkerMatches(verifiedWorker, body.workerId, "task.fail");
        if (enforceRequesterIdentity) {
          assertRequesterMatchesParty(requesterIdentity, { id: body.workerId }, "task.fail");
        }
        const task = broker.failTask(segments[1], body.workerId, body.error);
        await awaitDurablePersistenceAck(stateStore);
        return sendJson(res, 200, task);
      }

      if (req.method === "POST" && segments[0] === "tasks" && segments[1] && segments[2] === "approve") {
        const body = await readJson<TaskApprovalRequest>(req);
        if (!body?.actor?.id) {
          throw new BrokerError("bad_request", "actor.id is required");
        }
        if (enforceRequesterIdentity) {
          assertRequesterMatchesParty(
            requesterIdentity,
            { id: body.actor.id, role: body.actor.role },
            "task.approve",
          );
          assertRequesterHasRole(requesterIdentity, ["hub", "operator"], "task.approve");
        }
        const task = broker.approveTask(segments[1], body);
        await awaitDurablePersistenceAck(stateStore);
        return sendJson(res, 200, task);
      }

      if (req.method === "POST" && segments[0] === "tasks" && segments[1] && segments[2] === "reject-approval") {
        const body = await readJson<TaskApprovalTerminalRequest>(req);
        if (!body?.actor?.id) {
          throw new BrokerError("bad_request", "actor.id is required");
        }
        if (enforceRequesterIdentity) {
          assertRequesterMatchesParty(
            requesterIdentity,
            { id: body.actor.id, role: body.actor.role },
            "task.reject-approval",
          );
          assertRequesterHasRole(requesterIdentity, ["hub", "operator"], "task.reject-approval");
        }
        const task = broker.rejectTaskApproval(segments[1], body);
        await awaitDurablePersistenceAck(stateStore);
        return sendJson(res, 200, task);
      }

      if (req.method === "POST" && segments[0] === "tasks" && segments[1] && segments[2] === "cancel") {
        const body = await readJson<TaskCancelRequest>(req);
        if (!body?.actor?.id) {
          throw new BrokerError("bad_request", "actor.id is required");
        }
        if (enforceRequesterIdentity) {
          assertRequesterMatchesParty(
            requesterIdentity,
            { id: body.actor.id, role: body.actor.role },
            "task.cancel",
          );
        }
        const task = broker.cancelTask(segments[1], body);
        await awaitDurablePersistenceAck(stateStore);
        return sendJson(res, 200, task);
      }

      if (req.method === "POST" && segments[0] === "tasks" && segments[1] && segments[2] === "reassign") {
        const body = await readJson<TaskReassignRequest>(req);
        if (!body?.actor?.id) {
          throw new BrokerError("bad_request", "actor.id is required");
        }
        if (enforceRequesterIdentity) {
          assertRequesterMatchesParty(
            requesterIdentity,
            { id: body.actor.id, role: body.actor.role },
            "task.reassign",
          );
          assertRequesterHasRole(requesterIdentity, ["hub", "operator"], "task.reassign");
        }
        const task = broker.reassignTask(segments[1], body);
        await awaitDurablePersistenceAck(stateStore);
        return sendJson(res, 200, task);
      }

      if (req.method === "GET" && path === "/audit") {
        const filters = auditFiltersFromUrl(url);
        return sendJson(res, 200, { items: listAuditEventsForReadPath(stateStore, broker, filters) });
      }

      // -----------------------------------------------------------------------
      // GitHub /a2a assign ingestion endpoint
      // -----------------------------------------------------------------------
      if (req.method === "POST" && path === "/github/webhook") {
        const validationError = validateWebhookHeaders(
          req.headers["x-github-event"] as string | undefined,
          req.headers["x-github-delivery"] as string | undefined,
        );
        if (validationError) {
          throw new BrokerError("bad_request", validationError);
        }

        const rawBody = await readRawBody(req);
        assertGitHubWebhookSignature(
          rawBody,
          req.headers["x-hub-signature-256"] as string | undefined,
          githubWebhookSecret,
        );
        let body: Record<string, unknown> | null = null;
        if (rawBody.length > 0) {
          try {
            body = JSON.parse(rawBody.toString("utf8")) as Record<string, unknown>;
          } catch {
            throw new BrokerError("bad_request", "invalid JSON body");
          }
        }
        const parsed = parseGitHubWebhook(
          req.headers["x-github-event"] as string,
          req.headers["x-github-delivery"] as string,
          body,
        );
        if (!parsed) {
          throw new BrokerError("bad_request", "unsupported or malformed webhook payload");
        }

        const result = githubIngestion.ingest(parsed.event, parsed.ctx);
        return sendJson(res, result.deduped ? 200 : 201, result);
      }

      // GitHub webhook ingestion diagnostics
      if (req.method === "GET" && path === "/github/webhook/health") {
        const replayStats = githubIngestion.getReplayStats();
        return sendJson(res, 200, {
          ok: true,
          service: "github-ingestion",
          replayStats,
        });
      }

      // GitHub bounded poller diagnostics
      if (req.method === "GET" && path === "/github/poller/health") {
        const poller = boundedPoller;
        if (!poller) {
          return sendJson(res, 200, {
            ok: true,
            service: "github-bounded-poller",
            status: "not_started",
          });
        }
        return sendJson(res, 200, {
          ok: true,
          service: "github-bounded-poller",
          status: "started",
          stats: poller.getStats(),
        });
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
      maxRequeueAttempts,
      taskSubscribeHeartbeatSec,
      peerStatusEnabled,
      brokerId,
      version: buildInfo.version,
      build: buildInfo.build,
    },
  };
}

/**
 * Default keepAliveTimeout for the HTTP server (62s). Chosen to exceed the default
 * 30s worker heartbeat interval so that heartbeat TCP connections survive between
 * heartbeats and can be reused. Node.js defaults to 5000ms, which forces every
 * heartbeat to create a new TCP connection.
 */
const DEFAULT_KEEPALIVE_TIMEOUT_MS = 62000;

/**
 * Margin applied to headersTimeout above keepAliveTimeout. Node.js requires
 * headersTimeout > keepAliveTimeout or server.listen() throws an error.
 */
const HEADERS_TIMEOUT_MARGIN_MS = 10000;

export function startBrokerServer(options: BrokerServerOptions = {}): BrokerServerRuntime {
  const runtime = createBrokerServer(options);
  runtime.server.listen(runtime.config.port, runtime.config.host, () => {
    console.log(`${runtime.config.serviceName} listening on ${runtime.config.publicBaseUrl}`);
    if (runtime.config.staleReaperEnabled) {
      const cap =
        runtime.config.maxRequeueAttempts === 0
          ? "unlimited"
          : `${runtime.config.maxRequeueAttempts}`;
      console.log(
        `[a2a-broker] stale reaper enabled: interval=${runtime.config.staleReaperIntervalSec}s olderThan=${runtime.config.staleReaperOlderThanSec}s maxRequeueAttempts=${cap}`,
      );
    }
  });

  const gracefulShutdown = (signal: NodeJS.Signals) => {
    console.log(`[a2a-broker] received ${signal}, stopping stale reaper and closing server`);
    runtime.stopStaleReaper();
    runtime.stopPoller();
    runtime.server.close(() => {
      runtime.closeWorkerPersistence()
        .catch((error) => {
          console.error("[a2a-broker] worker-thread persistence shutdown failed:", error);
          process.exitCode = 1;
        })
        .finally(() => process.exit());
    });
    // server.close() only fires its callback once every connection ends, but
    // SSE streams are kept alive by heartbeats and never end on their own.
    // Close idle connections immediately and force-close any still-open ones
    // after a grace period so shutdown cannot hang until SIGKILL.
    runtime.server.closeIdleConnections?.();
    setTimeout(() => {
      runtime.server.closeAllConnections?.();
    }, SHUTDOWN_FORCE_CLOSE_MS).unref?.();
  };
  process.once("SIGINT", gracefulShutdown);
  process.once("SIGTERM", gracefulShutdown);

  return runtime;
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
// Grace period after server.close() before force-closing lingering (e.g. SSE)
// connections so a graceful shutdown cannot hang indefinitely.
const SHUTDOWN_FORCE_CLOSE_MS = 5_000;

// HTTP/SSE plumbing, error mapping, and streaming response helpers extracted to
// ./http/* (issue #645 phase 2). They take all state via explicit parameters and
// are imported at the top of this file.
