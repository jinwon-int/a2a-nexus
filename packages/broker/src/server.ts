import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type RequestListener, type Server, type ServerResponse } from "node:http";
import { loadavg, cpus } from "node:os";
import { readRuntimeMemoryUsage, readEventLoopDelayMs, readGcDiagnostics, readCpuDiagnostics } from "./diagnostics/system-metrics.js";
import { RequestTimingWindow, type RequestTimingSnapshot } from "./diagnostics/request-timing-window.js";
import {
  sanitizeBrokerId,
  sanitizeBuildSource,
  sanitizeBuildToken,
  sanitizeImageDigest,
  sanitizeIsoTimestamp,
} from "./build-metadata-sanitize.js";

import { createBrokerAgentCard, type AgentCard } from "./a2a/agent-card.js";
import { PushNotificationConfigStore } from "./a2a/push-notification-config.js";
import { signAgentCard } from "./a2a/agent-card-signing.js";
import { loadCrossBrokerTrustAnchors, verifyCrossBrokerSenderProof, CrossBrokerNonceCache } from "./a2a/cross-broker-sender-proof.js";
import { startDefaultAgent, DEFAULT_AGENT_NODE_ID, type DefaultAgentHandle } from "./a2a/default-agent.js";
import { executeA2AJsonRpcBody, executeSendMessage, jsonRpcErrorFromUnknown, specSendResult } from "./a2a/json-rpc.js";
import { PeerStatusService } from "./a2a/peer-status.js";
import {
  BrokerError,
  DEFAULT_BROKER_RETENTION_POLICY,
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
  CURRENT_BROKER_STATE_VERSION,
  DEFAULT_BROKER_STATE_MAX_BYTES,
  DEFAULT_HOT_RUNTIME_MAX_AUDIT_EVENTS,
  DEFAULT_HOT_RUNTIME_MAX_HEARTBEAT_AUDIT_EVENTS,
  DEFAULT_HOT_RUNTIME_MAX_NON_TERMINAL_TASKS,
  DEFAULT_HOT_RUNTIME_MAX_TERMINAL_OUTBOX_EVENTS,
  DEFAULT_HOT_RUNTIME_MAX_TERMINAL_TASKS,
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
  type BrokerHotAuditDiagnostics,
  type BrokerHotEntityDiagnostics,
  type BrokerPersistenceInfo,
  type BrokerStateStore,
  type SqliteBrokerLoadSource,
  type BrokerHotTableLoadMetrics,
  type BrokerHotTableRuntimeLoadLimits,
  type SqliteTaskListItemProjection,
} from "./core/store.js";
import {
  projectHotTableGrowth,
  type HotTableGrowthProjection,
} from "./core/hot-table-growth.js";
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
  A2AExchangeIntent,
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
import { projectAlerts, type Alert, type AlertScanResult } from "./core/alert-projection.js";
import { buildOperatorTaskReport } from "./core/operator-task-report.js";
import { buildReleaseEvidenceExport } from "./core/release-evidence.js";
import {
  buildTerminalBriefCloseoutGate,
  extractTerminalBriefFinalizerWorkflowPacket,
} from "./core/terminal-brief-closeout-gate.js";
import {
  buildTerminalBriefApprovalRequest,
  extractTerminalBriefCloseoutGatePacket,
} from "./core/terminal-brief-approval-request.js";
import {
  buildTerminalBriefApprovalExecutor,
  extractTerminalBriefApprovalRequestPacket,
} from "./core/terminal-brief-approval-executor.js";
import {
  buildTerminalBriefApprovalDispatchAdapter,
  extractTerminalBriefApprovalExecutorPacket,
} from "./core/terminal-brief-approval-dispatch-adapter.js";
import {
  buildTerminalBriefApprovalReceiptIngestor,
  extractTerminalBriefApprovalDispatchAdapterPacket,
  extractTerminalBriefApprovalReceiptEvidence,
} from "./core/terminal-brief-approval-receipt-ingestor.js";
import {
  buildTerminalBriefFinalizerApprovalStatus,
  extractTerminalBriefFinalizerApprovalReceiptStatus,
  extractTerminalBriefFinalizerApprovalStatusDispatch,
} from "./core/terminal-brief-finalizer-approval-status.js";
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
  buildA2AWorkerSubagentOrchestrationPolicy,
  extractA2AWorkerSubagentPolicyInput,
} from "./core/worker-subagent-orchestration-policy.js";
import {
  classifyTaskComplexity,
  type TaskComplexityInput as ComplexityOrchestrationTaskComplexityInput,
} from "./core/task-complexity-classifier.js";
import {
  buildComplexityOrchestrationRecommendation,
  type ComplexityOrchestrationRecommendationPacket,
} from "./core/complexity-orchestration-recommendation.js";
import {
  buildFinalizerApprovalEnvelopeDraft,
  type FinalizerApprovalEnvelopeDraftPacket,
} from "./core/complexity-finalizer-approval-envelope-draft.js";
import {
  buildComplexityExecutionPlanDraft,
  extractEnvelopeFromExecutionPlan,
} from "./core/complexity-execution-plan-draft.js";
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
import {
  handleExchangeByIdRequest,
  handleExchangeMessagesRequest,
  handleExchangesListRequest,
} from "./http/exchanges-read.js";
import {
  handleWorkerByIdRequest,
  handleWorkerCapacityRequest,
  handleWorkersListRequest,
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


interface DashboardAttentionItem {
  code: string;
  severity: "info" | "warn" | "critical";
  count: number;
  summary: string;
}

interface DashboardAttentionSummary {
  highestSeverity: "none" | DashboardAttentionItem["severity"];
  items: DashboardAttentionItem[];
}

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

interface OperatorTaskStatusSummary {
  total: number;
  active: number;
  terminal: number;
  byStatus: Record<TaskStatus, number>;
}

interface OperatorAttentionItem {
  code: "stale_worker" | "stale_task" | "long_running" | "dead_lettered" | "requeued";
  severity: "info" | "warn" | "critical";
  taskId: string;
  status: TaskStatus;
  intent: TaskKind;
  targetNodeId: string;
  assignedWorkerId?: string;
  claimedBy?: string;
  requeueCount: number;
  statusAgeSec: number;
  whyStuck: string;
  whoClaimed: string | null;
  whatNext: string;
  lastHeartbeatAt?: string;
  completedAt?: string;
  errorCode?: string;
  errorMessage?: string;
}

interface OperatorDashboardSnapshot {
  generatedAt: string;
  workers: BrokerDashboard["workers"];
  taskStatusSummary: OperatorTaskStatusSummary;
  recoverySummary: {
    stale: {
      staleWorkerAssignments: number;
      staleWorkersWithActiveTasks: BrokerDashboard["observability"]["workerHealth"]["staleWorkersWithActiveTasks"];
      oldestClaimed?: BrokerDashboard["observability"]["queuePressure"]["oldestClaimed"];
      oldestRunning?: BrokerDashboard["observability"]["queuePressure"]["oldestRunning"];
    };
    retry: {
      totalRequeued: number;
      maxRequeueAttempts: number;
      recentRequeues: BrokerDashboard["observability"]["recovery"]["recentRequeues"];
    };
    deadLetter: {
      totalDeadLettered: number;
      recentDeadLetters: BrokerDashboard["observability"]["recovery"]["recentDeadLetters"];
    };
  };
  attentionItems: OperatorAttentionItem[];
}

type OperatorSummary = BrokerDashboard & {
  version: string;
  build: BrokerBuildInfo;
  staleReaper: BrokerStaleReaperStatus;
  requestPressure: {
    general: RateLimitPressureSnapshot;
    worker: RateLimitPressureSnapshot;
  };
  attention: DashboardAttentionSummary;
  operatorSnapshot: OperatorDashboardSnapshot;
  hotEntityDiagnostics?: BrokerHotEntityDiagnostics;
  persistenceQueue: BrokerPersistenceQueueDiagnostics;
};

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
const DEFAULT_HEALTH_DIAGNOSTICS_TTL_MS = 5_000;
type CachedHealthDiagnostics = {
  persistence: BrokerPersistenceInfo;
  auditDiagnostics: BrokerHotAuditDiagnostics | undefined;
  hotTableGrowth: HotTableGrowthProjection | undefined;
};

function disabledPersistenceQueueDiagnostics(): BrokerPersistenceQueueDiagnostics {
  return {
    kind: "broker.persistence.queue",
    enabled: false,
    mode: "inline",
    state: "disabled",
    capacity: null,
    queued: 0,
    active: 0,
    inFlight: 0,
    available: null,
    closing: false,
    aborted: false,
  };
}

function unavailablePersistenceQueueDiagnostics(error: unknown): BrokerPersistenceQueueDiagnostics {
  return {
    kind: "broker.persistence.queue",
    enabled: true,
    mode: "worker_thread",
    state: "unavailable",
    capacity: null,
    queued: 0,
    active: 0,
    inFlight: 0,
    available: null,
    closing: false,
    aborted: false,
    lastErrorCode: "worker_unavailable",
    lastErrorAt: new Date().toISOString(),
    lastErrorMessage: truncateMessage(error instanceof Error ? error.message : String(error), 200),
  };
}

function readPersistenceQueueDiagnostics(
  provider: BrokerPersistenceQueueDiagnosticsProvider | undefined,
): BrokerPersistenceQueueDiagnostics {
  if (!provider) {
    return disabledPersistenceQueueDiagnostics();
  }
  try {
    return normalizePersistenceQueueDiagnostics(provider() ?? disabledPersistenceQueueDiagnostics());
  } catch (error) {
    return unavailablePersistenceQueueDiagnostics(error);
  }
}

function normalizePersistenceQueueDiagnostics(
  diagnostics: BrokerPersistenceQueueDiagnostics,
): BrokerPersistenceQueueDiagnostics {
  const capacity = diagnostics.capacity === null ? null : Math.max(0, Math.floor(diagnostics.capacity));
  const queued = Math.max(0, Math.floor(diagnostics.queued));
  const active = Math.max(0, Math.floor(diagnostics.active));
  const inFlight = Math.max(queued + active, Math.floor(diagnostics.inFlight));
  const available = capacity === null ? null : Math.max(0, Math.floor(diagnostics.available ?? capacity - inFlight));
  const state = diagnostics.aborted
    ? "aborted"
    : diagnostics.closing
      ? "draining"
      : diagnostics.state;
  return {
    ...diagnostics,
    kind: "broker.persistence.queue",
    capacity,
    queued,
    active,
    inFlight,
    available,
    state,
  };
}


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

type TerminalOutboxCounterEntry = { key: string; count: number };

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

function incrementCounter(counter: Record<string, number>, key: string | undefined | null): void {
  const normalized = key && key.length > 0 ? key : "unknown";
  counter[normalized] = (counter[normalized] ?? 0) + 1;
}

function topCounterEntries(counter: Record<string, number>, limit = 5): TerminalOutboxCounterEntry[] {
  return Object.entries(counter)
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
    .slice(0, limit);
}

function oldestAgeMs(events: TerminalTaskOutboxEvent[], nowMs: number): number | null {
  let oldest: number | null = null;
  for (const event of events) {
    const timestamp = Date.parse(event.createdAt);
    if (!Number.isFinite(timestamp)) continue;
    oldest = oldest === null ? timestamp : Math.min(oldest, timestamp);
  }
  return oldest === null ? null : Math.max(0, Math.round(nowMs - oldest));
}

function summarizeTerminalOutboxForSchedz(outbox: TerminalTaskEventOutbox) {
  const limit = 200;
  const retained = outbox.snapshot();
  const events = retained.slice(-limit);
  const nowMs = Date.now();
  const byWorker: Record<string, number> = {};
  const byStatus: Record<string, number> = {};
  const byReceiptStatus: Record<string, number> = {};
  const byBrokerOfRecord: Record<string, number> = {};
  const pendingAckByWorker: Record<string, number> = {};
  const pendingAckByStatus: Record<string, number> = {};
  const pendingAckByReceiptStatus: Record<string, number> = {};
  const pendingAckByBrokerOfRecord: Record<string, number> = {};
  const pendingAckEvents: TerminalTaskOutboxEvent[] = [];
  let oldestPendingAckEvent: TerminalTaskOutboxEvent | null = null;
  let oldestPendingAckAt: number | null = null;

  for (const event of events) {
    const worker = event.payload.worker ?? event.payload.crossBrokerHandoff?.childWorkerId ?? undefined;
    incrementCounter(byWorker, worker);
    incrementCounter(byStatus, event.payload.status);
    incrementCounter(byReceiptStatus, event.receipt?.status);
    incrementCounter(byBrokerOfRecord, event.payload.brokerOfRecordId);
    if (!event.ack) {
      pendingAckEvents.push(event);
      incrementCounter(pendingAckByWorker, worker);
      incrementCounter(pendingAckByStatus, event.payload.status);
      incrementCounter(pendingAckByReceiptStatus, event.receipt?.status);
      incrementCounter(pendingAckByBrokerOfRecord, event.payload.brokerOfRecordId);
      const createdAt = Date.parse(event.createdAt);
      if (Number.isFinite(createdAt) && (oldestPendingAckAt === null || createdAt < oldestPendingAckAt)) {
        oldestPendingAckAt = createdAt;
        oldestPendingAckEvent = event;
      }
    }
  }
  const oldestPendingAckWorker = oldestPendingAckEvent
    ? oldestPendingAckEvent.payload.worker ?? oldestPendingAckEvent.payload.crossBrokerHandoff?.childWorkerId ?? "unknown"
    : null;

  return {
    retainedCount: retained.length,
    sampledCount: events.length,
    sampleLimit: limit,
    pendingAckCount: pendingAckEvents.length,
    oldestPendingAckAgeMs: oldestAgeMs(pendingAckEvents, nowMs),
    topWorkers: topCounterEntries(byWorker),
    topStatuses: topCounterEntries(byStatus),
    topReceiptStatuses: topCounterEntries(byReceiptStatus),
    topBrokersOfRecord: topCounterEntries(byBrokerOfRecord),
    topPendingAckWorkers: topCounterEntries(pendingAckByWorker),
    topPendingAckStatuses: topCounterEntries(pendingAckByStatus),
    topPendingAckReceiptStatuses: topCounterEntries(pendingAckByReceiptStatus),
    topPendingAckBrokersOfRecord: topCounterEntries(pendingAckByBrokerOfRecord),
    oldestPendingAckWorker,
    oldestPendingAckStatus: oldestPendingAckEvent?.payload.status ?? null,
    oldestPendingAckReceiptStatus: oldestPendingAckEvent?.receipt?.status ?? null,
    oldestPendingAckBrokerOfRecord: oldestPendingAckEvent?.payload.brokerOfRecordId ?? null,
  };
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

const WORKER_HEARTBEAT_PHASES = [
  "readJson",
  "authLookup",
  "authAssert",
  "brokerHeartbeat",
  "toWorkerView",
] as const;

type WorkerHeartbeatPhase = (typeof WORKER_HEARTBEAT_PHASES)[number];

const WORKER_REGISTER_PHASES = [
  "readJson",
  "authAssert",
  "brokerRegister",
  "toWorkerView",
] as const;

type WorkerRegisterPhase = (typeof WORKER_REGISTER_PHASES)[number];

const _workerRegisterPhaseTiming = new Map<WorkerRegisterPhase, RequestTimingWindow>();

function workerRegisterPhaseTimingWindow(phase: WorkerRegisterPhase): RequestTimingWindow {
  let window = _workerRegisterPhaseTiming.get(phase);
  if (!window) {
    window = new RequestTimingWindow(200);
    _workerRegisterPhaseTiming.set(phase, window);
  }
  return window;
}

function recordWorkerRegisterPhase(phase: WorkerRegisterPhase, startedAt: number, workerId?: string): void {
  const elapsed = Math.round((performance.now() - startedAt) * 1000) / 1000;
  workerRegisterPhaseTimingWindow(phase).record(elapsed);
  if (workerId) {
    perWorkerRegisterPhaseTimingWindow(workerId, phase).record(elapsed);
    _perWorkerRegisterLastSeen.set(workerId, Date.now());
  }
}

function workerRegisterPhaseTimingSnapshot(): Record<WorkerRegisterPhase, RequestTimingSnapshot> {
  const snapshot = {} as Record<WorkerRegisterPhase, RequestTimingSnapshot>;
  for (const phase of WORKER_REGISTER_PHASES) {
    snapshot[phase] = _workerRegisterPhaseTiming.get(phase)?.snapshot() ?? null;
  }
  return snapshot;
}

// Per-worker register phase timing (#1032 / Team2 jingun attribution).
const MAX_PER_WORKER_REGISTER_WORKERS = 500;
const PER_WORKER_REGISTER_STALE_AFTER_MS = 30 * 60 * 1000;
const _perWorkerRegisterPhaseTiming = new Map<string, Map<WorkerRegisterPhase, RequestTimingWindow>>();
const _perWorkerRegisterLastSeen = new Map<string, number>();

function perWorkerRegisterPhaseTimingWindow(workerId: string, phase: WorkerRegisterPhase): RequestTimingWindow {
  let perWorker = _perWorkerRegisterPhaseTiming.get(workerId);
  if (!perWorker) {
    if (_perWorkerRegisterPhaseTiming.size >= MAX_PER_WORKER_REGISTER_WORKERS) {
      const oldest = _perWorkerRegisterPhaseTiming.keys().next().value;
      if (oldest !== undefined) {
        _perWorkerRegisterPhaseTiming.delete(oldest);
        _perWorkerRegisterLastSeen.delete(oldest);
      }
    }
    perWorker = new Map();
    _perWorkerRegisterPhaseTiming.set(workerId, perWorker);
  }
  let window = perWorker.get(phase);
  if (!window) {
    window = new RequestTimingWindow(200);
    perWorker.set(phase, window);
  }
  return window;
}

function workerRegisterPhasePerWorkerSnapshot(): Record<string, Record<string, RequestTimingSnapshot | null>> | null {
  if (_perWorkerRegisterPhaseTiming.size === 0) return null;
  const snapshot: Record<string, Record<string, RequestTimingSnapshot | null>> = {};
  const now = Date.now();
  for (const [workerId, phaseMap] of _perWorkerRegisterPhaseTiming) {
    const lastSeen = _perWorkerRegisterLastSeen.get(workerId);
    if (lastSeen !== undefined && now - lastSeen > PER_WORKER_REGISTER_STALE_AFTER_MS) {
      _perWorkerRegisterPhaseTiming.delete(workerId);
      _perWorkerRegisterLastSeen.delete(workerId);
      continue;
    }
    const phaseSnap: Record<string, RequestTimingSnapshot | null> = {};
    for (const phase of WORKER_REGISTER_PHASES) {
      phaseSnap[phase] = phaseMap.get(phase)?.snapshot() ?? null;
    }
    snapshot[workerId] = phaseSnap;
  }
  return Object.keys(snapshot).length > 0 ? snapshot : null;
}

const _workerHeartbeatPhaseTiming = new Map<WorkerHeartbeatPhase, RequestTimingWindow>();

function workerHeartbeatPhaseTimingWindow(phase: WorkerHeartbeatPhase): RequestTimingWindow {
  let window = _workerHeartbeatPhaseTiming.get(phase);
  if (!window) {
    window = new RequestTimingWindow(200);
    _workerHeartbeatPhaseTiming.set(phase, window);
  }
  return window;
}

function recordWorkerHeartbeatPhase(phase: WorkerHeartbeatPhase, startedAt: number, workerId?: string): void {
  const elapsed = Math.round((performance.now() - startedAt) * 1000) / 1000;
  workerHeartbeatPhaseTimingWindow(phase).record(elapsed);
  if (workerId) {
    perWorkerHeartbeatPhaseTimingWindow(workerId, phase).record(elapsed);
    _perWorkerHeartbeatLastSeen.set(workerId, Date.now());
  }
}

function workerHeartbeatPhaseTimingSnapshot(): Record<WorkerHeartbeatPhase, RequestTimingSnapshot> {
  const snapshot = {} as Record<WorkerHeartbeatPhase, RequestTimingSnapshot>;
  for (const phase of WORKER_HEARTBEAT_PHASES) {
    snapshot[phase] = _workerHeartbeatPhaseTiming.get(phase)?.snapshot() ?? null;
  }
  return snapshot;
}

// Per-worker heartbeat phase timing (#1032 / Team1 sogyo attribution)
// Distinguishes individual worker timing from the aggregate above.
const MAX_PER_WORKER_HEARTBEAT_WORKERS = 500;
const PER_WORKER_HEARTBEAT_STALE_AFTER_MS = 30 * 60 * 1000;
const _perWorkerHeartbeatPhaseTiming = new Map<string, Map<WorkerHeartbeatPhase, RequestTimingWindow>>();
const _perWorkerHeartbeatLastSeen = new Map<string, number>();

function perWorkerHeartbeatPhaseTimingWindow(workerId: string, phase: WorkerHeartbeatPhase): RequestTimingWindow {
  let perWorker = _perWorkerHeartbeatPhaseTiming.get(workerId);
  if (!perWorker) {
    if (_perWorkerHeartbeatPhaseTiming.size >= MAX_PER_WORKER_HEARTBEAT_WORKERS) {
      const oldest = _perWorkerHeartbeatPhaseTiming.keys().next().value;
      if (oldest !== undefined) {
        _perWorkerHeartbeatPhaseTiming.delete(oldest);
        _perWorkerHeartbeatLastSeen.delete(oldest);
      }
    }
    perWorker = new Map();
    _perWorkerHeartbeatPhaseTiming.set(workerId, perWorker);
  }
  let window = perWorker.get(phase);
  if (!window) {
    window = new RequestTimingWindow(200);
    perWorker.set(phase, window);
  }
  return window;
}

function workerHeartbeatPhasePerWorkerSnapshot(): Record<string, Record<string, RequestTimingSnapshot | null>> | null {
  if (_perWorkerHeartbeatPhaseTiming.size === 0) return null;
  const snapshot: Record<string, Record<string, RequestTimingSnapshot | null>> = {};
  const now = Date.now();
  for (const [workerId, phaseMap] of _perWorkerHeartbeatPhaseTiming) {
    const lastSeen = _perWorkerHeartbeatLastSeen.get(workerId);
    if (lastSeen !== undefined && now - lastSeen > PER_WORKER_HEARTBEAT_STALE_AFTER_MS) {
      _perWorkerHeartbeatPhaseTiming.delete(workerId);
      _perWorkerHeartbeatLastSeen.delete(workerId);
      continue;
    }
    const phaseSnap: Record<string, RequestTimingSnapshot | null> = {};
    for (const phase of WORKER_HEARTBEAT_PHASES) {
      phaseSnap[phase] = phaseMap.get(phase)?.snapshot() ?? null;
    }
    snapshot[workerId] = phaseSnap;
  }
  return Object.keys(snapshot).length > 0 ? snapshot : null;
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

/**
 * Operator gate classifier for reused-socket idle vs. client pool vs. Node delivery.
 *
 * Uses aggregate timing windows from /schedz to distinguish:
 *   1. Reused-socket idle on wire (high reusedSocketIdleBeforeHttpRequestEventMs)
 *   2. Client pool artifact (high clientProbeStartToHttpRequestEventMs while server idle is low)
 *   3. Node request-event delivery delay (high httpRequestEventToHandlerStartMs)
 *   4. Server handler time (high schedulingTiming relates to handler side)
 *
 * Since #1102, "accepted-socket-waiting-before-handler" is split into:
 *   - "accepted-socket-waiting-before-request-event": dominant delay is
 *     TCP accept / TLS handshake / read before the HTTP parser fires.
 *   - "accepted-socket-waiting-before-handler": dominant delay is
 *     Node request-event → handler start (event-loop descheduling).
 *
 * Since #1121, the reused-socket branch is similarly split:
 *   - "reused-socket-idle-before-request-event": dominant delay is
 *     keep-alive idle on wire before the HTTP request event fires.
 *   - "reused-socket-waiting-before-handler": dominant delay is
 *     Node request-event → handler start on a reused socket.
 *
 * Returns a verdict object with bucket, confidence, and evidence fields.
 */
function computeReusedSocketGate(inputs: {
  freshSocketAge: ReturnType<RequestTimingWindow["snapshot"]>;
  freshSocketAcceptToReq: ReturnType<RequestTimingWindow["snapshot"]>;
  freshHttpReqEventToHandler: ReturnType<RequestTimingWindow["snapshot"]>;
  freshSocketConnectedToFirstData: ReturnType<RequestTimingWindow["snapshot"]>;
  freshSocketFirstDataToReq: ReturnType<RequestTimingWindow["snapshot"]>;
  reusedSocketIdle: ReturnType<RequestTimingWindow["snapshot"]>;
  aggHttpReqEventToHandler: ReturnType<RequestTimingWindow["snapshot"]>;
  aggClientProbeToHttpReqEvent: ReturnType<RequestTimingWindow["snapshot"]>;
  aggSocketIdleBeforeHttpReqEvent: ReturnType<RequestTimingWindow["snapshot"]>;
  aggSocketAgeBeforeHandler: ReturnType<RequestTimingWindow["snapshot"]>;
  reusedSocketAge: ReturnType<RequestTimingWindow["snapshot"]>;
  reusedSocketHttpReqEventToHandler: ReturnType<RequestTimingWindow["snapshot"]>;
  reusedSocketIdleBeforeData: ReturnType<RequestTimingWindow["snapshot"]>;
  reusedSocketDataToReqEvent: ReturnType<RequestTimingWindow["snapshot"]>;
}): {
  bucket: string;
  confidence: "low" | "medium" | "high";
  reasons: string[];
  evidence: Record<string, number | null>;
} {
  const {
    freshSocketAcceptToReq,
    freshHttpReqEventToHandler,
    freshSocketConnectedToFirstData,
    freshSocketFirstDataToReq,
    reusedSocketIdle,
    aggHttpReqEventToHandler,
    aggClientProbeToHttpReqEvent,
    aggSocketIdleBeforeHttpReqEvent,
    aggSocketAgeBeforeHandler,
    freshSocketAge,
    reusedSocketAge,
    reusedSocketHttpReqEventToHandler,
    reusedSocketIdleBeforeData,
    reusedSocketDataToReqEvent,
  } = inputs;

  const reusedIdleP99 = reusedSocketIdle?.p99Ms ?? null;
  const reusedIdleP95 = reusedSocketIdle?.p95Ms ?? null;
  const eventToHandlerP99 = aggHttpReqEventToHandler?.p99Ms ?? null;
  const eventToHandlerP95 = aggHttpReqEventToHandler?.p95Ms ?? null;
  const freshReqToHandlerP99 = freshHttpReqEventToHandler?.p99Ms ?? null;
  const freshConnectedToDataP99 = freshSocketConnectedToFirstData?.p99Ms ?? null;
  const freshDataToReqP99 = freshSocketFirstDataToReq?.p99Ms ?? null;
  const clientProbeToReqP99 = aggClientProbeToHttpReqEvent?.p99Ms ?? null;
  const clientProbeToReqP95 = aggClientProbeToHttpReqEvent?.p95Ms ?? null;
  const globalIdleP99 = aggSocketIdleBeforeHttpReqEvent?.p99Ms ?? null;
  const freshAgeP99 = freshSocketAge?.p99Ms ?? null;
  const reusedAgeP99 = reusedSocketAge?.p99Ms ?? null;
  const reusedReqToHandlerP99 = reusedSocketHttpReqEventToHandler?.p99Ms ?? null;
  const freshAcceptToReqP99 = freshSocketAcceptToReq?.p99Ms ?? null;
  const reusedIdleBeforeDataP99 = reusedSocketIdleBeforeData?.p99Ms ?? null;
  const reusedDataToReqEventP99 = reusedSocketDataToReqEvent?.p99Ms ?? null;

  const reasons: string[] = [];
  let bucket = "no-significant-stall";
  let confidence: "low" | "medium" | "high" = "low";

  // Evidence: reused socket idle on wire
  if (reusedIdleP99 !== null && reusedIdleP99 > 1000) {
    reasons.push(`sogyo: reused-socket idle on wire p99=${reusedIdleP99.toFixed(1)}ms`);
  }

  // Evidence: Node request-event delivery delay
  if (eventToHandlerP99 !== null && eventToHandlerP99 > 100) {
    reasons.push(`sogyo: Node request-event delivery delay p99=${eventToHandlerP99.toFixed(1)}ms`);
  }

  // Evidence: client pool artifact (client sees delay but server idle is low)
  if (clientProbeToReqP99 !== null && globalIdleP99 !== null) {
    if (clientProbeToReqP99 > 1000 && globalIdleP99 < 500) {
      reasons.push(`sogyo: client pool artifact — client→request=${clientProbeToReqP99.toFixed(1)}ms but server idle=${globalIdleP99.toFixed(1)}ms`);
    }
  }

  // Evidence: fresh connection age
  if (freshAgeP99 !== null && freshAgeP99 > 1000) {
    reasons.push(`sogyo: fresh socket scheduling delay p99=${freshAgeP99.toFixed(1)}ms`);
  }

  // Evidence: accept→request-event breakdown for fresh sockets
  if (freshAcceptToReqP99 !== null && freshAcceptToReqP99 > 500) {
    reasons.push(`sogyo: fresh socket accept→request-event p99=${freshAcceptToReqP99.toFixed(1)}ms`);
  }

  // Evidence: fresh-socket request-event → handler-start delay (event-loop descheduling)
  if (freshReqToHandlerP99 !== null && freshReqToHandlerP99 > 100) {
    reasons.push(`sogyo: fresh socket req→handler delay p99=${freshReqToHandlerP99.toFixed(1)}ms`);
  }

  // Classify the dominant bucket
  if (reusedIdleP99 !== null && reusedIdleP99 > 1000) {
    // Split reused-socket stall into idle-before-request-event vs
    // waiting-before-handler (#1121).  Mirror the fresh socket split
    // but using the dedicated reused-socket event→handler window.
    // If idle-before-request-event dominates (>60% of total handler
    // wait or idle alone exceeds 2s), classify as idle on wire.
    // Otherwise the delay is in the req→handler dispatch phase.
    if (reusedReqToHandlerP99 !== null && reusedIdleP99 < reusedReqToHandlerP99 * 1.5 && reusedIdleP99 < 2000) {
      bucket = "reused-socket-waiting-before-handler";
      confidence = reusedReqToHandlerP99 > 500 ? "high" : "medium";
    } else if (reusedIdleBeforeDataP99 !== null && reusedDataToReqEventP99 !== null) {
      // Further split: distinguish wire idle from event-loop blocked
      // after data arrives (#1032 antithesis-runtime).
      // If idle-before-data dominates, the client wasn't sending —
      // the stall is client-pool or keep-alive race, not server-side.
      // If data-to-req-event dominates, data arrived but Node was
      // blocked (GC, cgroup throttle, event-loop pressure).
      if (reusedDataToReqEventP99 > reusedIdleBeforeDataP99 * 0.5 && reusedDataToReqEventP99 > 500) {
        bucket = "reused-socket-data-received-blocked";
        reasons.push(`jingun: reused-socket data→req-event p99=${reusedDataToReqEventP99.toFixed(1)}ms exceeds idle-before-data p99=${reusedIdleBeforeDataP99.toFixed(1)}ms — event-loop blocked after data arrived, not wire idle`);
        confidence = reusedDataToReqEventP99 > 2000 ? "high" : (reusedDataToReqEventP99 > 1000 ? "medium" : "low");
      } else {
        bucket = "reused-socket-idle-before-request-event";
        confidence = reusedIdleP99 > 3000 ? "high" : (reusedIdleP99 > 1500 ? "medium" : "low");
      }
    } else {
      bucket = "reused-socket-idle-before-request-event";
      confidence = reusedIdleP99 > 3000 ? "high" : (reusedIdleP99 > 1500 ? "medium" : "low");
    }
  } else if (eventToHandlerP99 !== null && eventToHandlerP99 > 100) {
    bucket = "node-request-event-delivery";
    confidence = eventToHandlerP99 > 500 ? "high" : "medium";
  } else if (clientProbeToReqP99 !== null && clientProbeToReqP99 > 1000 && (globalIdleP99 === null || globalIdleP99 < 500)) {
    bucket = "client-pool-artifact";
    confidence = "medium";
  } else if (freshAgeP99 !== null && freshAgeP99 > 1000) {
    // Split accepted-socket-waiting into accept→req vs. req→handler (#1102, #1125).
    // Use the fresh-socket accept→request-event window and the fresh-specific
    // httpRequestEventToHandlerStartMs window to distinguish TCP/accept wait
    // from event-loop descheduling.
    const freshAcceptToReqPortion = freshAcceptToReqP99 ?? 0;
    // Further decompose accept→req into accept→data (socket accepted but
    // no data arrived) vs. data→req (data arrived but event-loop blocked
    // before parser fired).  Uses fresh-connection breakdown windows that
    // separate "waiting for data on the wire" from "event-loop delay after
    // data arrived" (#1154 Team1 thesis — Gwakga fresh >3s attribution).
    const freshConnectedToData = freshConnectedToDataP99 ?? 0;
    const freshDataToReq = freshDataToReqP99 ?? 0;
    // If the accept→req portion dominates (>60% of total fresh age or
    // accept→req alone exceeds the threshold), classify as TCP accept/read wait.
    if (freshAcceptToReqPortion > freshAgeP99 * 0.6 || freshAcceptToReqPortion > 1000) {
      // Further decompose: distinguish data-not-arrived from event-loop-blocked
      // after data arrived.  This is the key #1154 decomposition for fresh >3s.
      if (freshDataToReq > 500 && freshDataToReq > freshConnectedToData * 0.5) {
        // Data arrived but event-loop was blocked before HTTP parser ran.
        bucket = "accepted-socket-data-received-blocked";
        reasons.push(`jingun: fresh socket data→req-event p99=${freshDataToReq.toFixed(1)}ms exceeds connected→data p99=${freshConnectedToData.toFixed(1)}ms — Node event-loop blocked after data arrived`);
        confidence = freshDataToReq > 2000 ? "high" : (freshDataToReq > 1000 ? "medium" : "low");
      } else if (freshConnectedToData > 500 && freshConnectedToData > freshDataToReq * 0.5) {
        // Socket accepted but first data byte delayed — network latency,
        // Gwakga didn't send yet, or host scheduling before read callback.
        bucket = "accepted-socket-waiting-for-data";
        reasons.push(`jingun: fresh socket connected→data p99=${freshConnectedToData.toFixed(1)}ms exceeds data→req-event p99=${freshDataToReq.toFixed(1)}ms — socket accepted but data not yet arrived`);
        confidence = freshConnectedToData > 2000 ? "high" : (freshConnectedToData > 1000 ? "medium" : "low");
      } else {
        // Unclear split; fall back to existing classification.
        bucket = "accepted-socket-waiting-before-request-event";
        confidence = freshAgeP99 > 3000 ? "high" : "medium";
      }
    } else {
      // Default: the delay is in the req→handler dispatch phase
      bucket = "accepted-socket-waiting-before-handler";
      confidence = freshAgeP99 > 3000 ? "high" : "medium";
    }
  }

  if (reasons.length === 0) {
    reasons.push("sogyo: no stall evidence in aggregate timing windows");
  }

  return {
    bucket,
    confidence,
    reasons,
    evidence: {
      reusedSocketIdleP99Ms: reusedIdleP99,
      eventToHandlerP99Ms: eventToHandlerP99,
      freshHttpReqEventToHandlerP99Ms: freshReqToHandlerP99,
      clientProbeToReqP99Ms: clientProbeToReqP99,
      globalSocketIdleP99Ms: globalIdleP99,
      freshSocketAgeP99Ms: freshAgeP99,
      reusedSocketAgeP99Ms: reusedAgeP99,
      freshSocketAcceptToReqP99Ms: freshAcceptToReqP99,
      freshSocketConnectedToFirstDataP99Ms: freshConnectedToDataP99,
      freshSocketFirstDataToReqP99Ms: freshDataToReqP99,
      reusedSocketReqToHandlerP99Ms: reusedReqToHandlerP99,
      reusedSocketIdleBeforeDataP99Ms: reusedIdleBeforeDataP99,
      reusedSocketDataToReqEventP99Ms: reusedDataToReqEventP99,
    },
  };
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

class HealthDiagnosticsCache {
  private cached: CachedHealthDiagnostics | null = null;
  private cachedAt = 0;
  private readonly ttlMs: number;
  /** Prior snapshot of hot-table load metrics, used to compute growth rate across cache refreshes. */
  private priorMetrics: BrokerHotTableLoadMetrics | undefined;
  /** Timestamp of the prior snapshot. */
  private priorGeneratedAt: string | undefined;

  constructor(ttlMs: number = DEFAULT_HEALTH_DIAGNOSTICS_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  get(
    stateStore: BrokerStateStore,
    extra?: {
      processMemory?: {
        rssBytes: number;
        heapTotalBytes: number;
        heapUsedBytes: number;
        heapLimitBytes: number;
      };
      snapshotMetrics?: {
        lastSnapshotBytes?: number | null;
        lastPersistDurationMs?: number | null;
        lastSnapshotAt?: string | null;
      };
    },
  ): { persistence: BrokerPersistenceInfo; auditDiagnostics: BrokerHotAuditDiagnostics | undefined; hotTableGrowth: HotTableGrowthProjection | undefined; fromCache: boolean } {
    const now = Date.now();
    if (this.cached !== null && now - this.cachedAt < this.ttlMs) {
      return { ...this.cached, fromCache: true };
    }
    const persistence = stateStore.getPersistenceInfo?.() ?? {
      kind: "custom",
      stateVersion: CURRENT_BROKER_STATE_VERSION,
    };
    const auditDiagnostics = stateStore instanceof SqliteBrokerStateStore
      ? stateStore.readHotAuditDiagnostics()
      : undefined;

    // Compute hot-table growth projection from current load metrics.
    let hotTableGrowth: HotTableGrowthProjection | undefined;
    if (persistence.hotTableLoadMetrics) {
      hotTableGrowth = projectHotTableGrowth({
        current: persistence.hotTableLoadMetrics,
        prior: this.priorMetrics,
        priorGeneratedAt: this.priorGeneratedAt,
        runtimeLoadLimits: persistence.hotTableRuntimeLoadLimits,
        maxWarnings: 10,
        ...(extra?.processMemory ? { processMemory: extra.processMemory } : {}),
        ...(extra?.snapshotMetrics ? { snapshotMetrics: extra.snapshotMetrics } : {}),
      });
    }

    // Rotate prior snapshot for the next cache refresh.
    if (persistence.hotTableLoadMetrics) {
      this.priorMetrics = persistence.hotTableLoadMetrics;
      this.priorGeneratedAt = hotTableGrowth?.generatedAt;
    }

    this.cached = { persistence, auditDiagnostics, hotTableGrowth };
    this.cachedAt = now;
    return { persistence, auditDiagnostics, hotTableGrowth, fromCache: false };
  }
}

export type A2AHttpSignatureWorkerAuthMode = "off" | "optional" | "strict";
export type A2AHttpSignatureWorkerKeySource = "empty" | "inline" | "file";

interface A2AHttpSignatureVerifiedWorker {
  keyid: string;
  requesterId: string;
  scopes?: readonly string[];
}

const A2A_HTTP_SIGNATURE_REPLAY_CACHE_MAX_ENTRIES = 10_000;

class A2AHttpSignatureReplayCache {
  private readonly entries = new Map<string, number>();

  remember(keyid: string, nonce: string, expiresEpochSeconds: number, nowEpochSeconds = Math.floor(Date.now() / 1000)): boolean {
    this.prune(nowEpochSeconds);
    const cacheKey = `${keyid}\0${nonce}`;
    const existingExpires = this.entries.get(cacheKey);
    if (existingExpires !== undefined && existingExpires > nowEpochSeconds) {
      return false;
    }
    this.entries.set(cacheKey, expiresEpochSeconds);
    while (this.entries.size > A2A_HTTP_SIGNATURE_REPLAY_CACHE_MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    return true;
  }

  private prune(nowEpochSeconds: number): void {
    for (const [key, expires] of this.entries) {
      if (expires <= nowEpochSeconds) {
        this.entries.delete(key);
      }
    }
  }
}

function resolveA2AHttpSignatureWorkerAuthMode(value: string | undefined): A2AHttpSignatureWorkerAuthMode {
  const normalized = (value ?? "off").trim().toLowerCase();
  if (normalized === "off" || normalized === "optional" || normalized === "strict") {
    return normalized;
  }
  throw new Error("A2A_HTTP_SIGNATURE_WORKER_AUTH must be one of: off, optional, strict");
}

export interface BrokerServerOptions {
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
  retentionPolicy?: Partial<BrokerRetentionPolicy>;
  maxSnapshotBytes?: number;
  /** Max non-terminal task rows to hydrate from SQLite hot tables. Env: `BROKER_HOT_RUNTIME_MAX_NON_TERMINAL_TASKS`. */
  maxHotRuntimeNonTerminalTasks?: number;
  /** Max terminal task rows to hydrate from SQLite hot tables; active tasks always hydrate. Env: `BROKER_HOT_RUNTIME_MAX_TERMINAL_TASKS`. */
  maxHotRuntimeTerminalTasks?: number;
  /** Max audit rows to hydrate from SQLite hot tables. Env: BROKER_HOT_RUNTIME_MAX_AUDIT_EVENTS. */
  maxHotRuntimeAuditEvents?: number;
  /** Max heartbeat audit rows retained in SQLite hot tables. Env: BROKER_HOT_RUNTIME_MAX_HEARTBEAT_AUDIT_EVENTS. */
  maxHotRuntimeHeartbeatAuditEvents?: number;
  /** Max terminal outbox rows to hydrate from SQLite hot tables. Env: `BROKER_HOT_RUNTIME_MAX_TERMINAL_OUTBOX_EVENTS`. */
  maxHotRuntimeTerminalOutboxEvents?: number;
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
  const workerOfflineAfterSec = options.workerOfflineAfterSec ?? Number(process.env.WORKER_OFFLINE_AFTER_SEC ?? 90);
  const workerHeartbeatPersistIntervalMs = Math.max(
    0,
    resolveIntegerOption(
      options.workerHeartbeatPersistIntervalMs,
      process.env.BROKER_WORKER_HEARTBEAT_PERSIST_INTERVAL_MS,
      DEFAULT_WORKER_HEARTBEAT_PERSIST_INTERVAL_MS,
    ),
  );
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
      publishOperatorEvents();
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

  const unsubscribeBrokerState = broker.subscribeToState(() => {
    if (suppressOperatorStateBroadcast) {
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
      if (path !== "/health" && !isPublicLivenessRoute && !isPublicDiscoveryRoute) {
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

      if (req.method === "POST" && path === "/workers/subagent-orchestration/plan") {
        if (enforceRequesterIdentity) {
          assertRequesterHasRole(requesterIdentity, ["hub", "operator", "analyst", "researcher", "live-trader"], "worker_subagent_orchestration.plan");
        }
        const body = await readJson<Record<string, unknown>>(req);
        let input;
        try {
          input = extractA2AWorkerSubagentPolicyInput(body);
        } catch (error) {
          const message = error instanceof Error ? error.message : "invalid worker subagent orchestration policy input";
          throw new BrokerError("bad_request", message);
        }
        const packet = buildA2AWorkerSubagentOrchestrationPolicy(input);
        return sendJson(res, 200, packet, {
          "cache-control": "no-store",
        });
      }

      if (req.method === "POST" && path === "/complexity-orchestration/recommendation") {
        if (enforceRequesterIdentity) {
          assertRequesterHasRole(requesterIdentity, ["hub", "operator", "analyst", "researcher", "live-trader"], "complexity_orchestration.recommendation");
        }
        const body = await readJson<Record<string, unknown>>(req);
        let input: ComplexityOrchestrationTaskComplexityInput;
        try {
          const rawIntent = body?.intent;
          if (typeof rawIntent !== "string" || rawIntent.length === 0) {
            throw new TypeError("missing or invalid 'intent' field");
          }
          const intent = rawIntent as A2AExchangeIntent;
          input = {
            intent,
            targetEnvironment: body?.targetEnvironment as ComplexityOrchestrationTaskComplexityInput["targetEnvironment"],
            policyContext: body?.policyContext as ComplexityOrchestrationTaskComplexityInput["policyContext"],
            referenceCount: typeof body?.referenceCount === "number" ? body?.referenceCount : undefined,
            artifactCount: typeof body?.artifactCount === "number" ? body?.artifactCount : undefined,
            turnCount: typeof body?.turnCount === "number" ? body?.turnCount : undefined,
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : "invalid complexity orchestration recommendation input";
          throw new BrokerError("bad_request", message);
        }
        const classification = classifyTaskComplexity(input);
        const packet = buildComplexityOrchestrationRecommendation(classification);
        return sendJson(res, 200, packet, {
          "cache-control": "no-store",
        });
      }

      if (req.method === "POST" && path === "/complexity-execution-plan/draft") {
        if (enforceRequesterIdentity) {
          assertRequesterHasRole(requesterIdentity, ["hub", "operator", "analyst", "researcher", "live-trader"], "complexity_execution_plan.draft");
        }
        const body = await readJson<Record<string, unknown>>(req);
        let envelope: FinalizerApprovalEnvelopeDraftPacket;
        try {
          if (body?.kind === "a2a-broker.complexity-orchestration-recommendation-packet") {
            envelope = buildFinalizerApprovalEnvelopeDraft(body as unknown as ComplexityOrchestrationRecommendationPacket);
          } else {
            envelope = extractEnvelopeFromExecutionPlan(body);
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : "invalid complexity execution plan draft input";
          throw new BrokerError("bad_request", message);
        }
        const packet = buildComplexityExecutionPlanDraft(envelope);
        return sendJson(res, 200, packet, {
          "cache-control": "no-store",
        });
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

      if (req.method === "POST" && path === "/terminal-brief/closeout/gate") {
        if (enforceRequesterIdentity) {
          assertRequesterHasRole(requesterIdentity, ["hub", "operator"], "terminal_brief.closeout_gate.read");
        }
        const body = await readJson<Record<string, unknown>>(req);
        let workflow;
        try {
          workflow = extractTerminalBriefFinalizerWorkflowPacket(body);
        } catch (error) {
          const message = error instanceof Error ? error.message : "invalid closeout gate input";
          throw new BrokerError("bad_request", message);
        }
        const report = buildTerminalBriefCloseoutGate(workflow, {
          issueUrl: optionalString(url.searchParams.get("issueUrl") ?? url.searchParams.get("issue_url")),
          prUrl: optionalString(url.searchParams.get("prUrl") ?? url.searchParams.get("pr_url")),
        });
        return sendJson(res, 200, report, {
          "cache-control": "no-store",
        });
      }

      if (req.method === "POST" && path === "/terminal-brief/closeout/approval-request") {
        if (enforceRequesterIdentity) {
          assertRequesterHasRole(requesterIdentity, ["hub", "operator"], "terminal_brief.approval_request.read");
        }
        const body = await readJson<Record<string, unknown>>(req);
        let gate;
        try {
          gate = extractTerminalBriefCloseoutGatePacket(body);
        } catch (error) {
          const message = error instanceof Error ? error.message : "invalid approval request input";
          throw new BrokerError("bad_request", message);
        }
        const report = buildTerminalBriefApprovalRequest(gate);
        return sendJson(res, 200, report, {
          "cache-control": "no-store",
        });
      }

      if (req.method === "POST" && path === "/terminal-brief/closeout/approval-executor") {
        if (enforceRequesterIdentity) {
          assertRequesterHasRole(requesterIdentity, ["hub", "operator"], "terminal_brief.approval_executor.read");
        }
        const body = await readJson<Record<string, unknown>>(req);
        let approvalRequest;
        try {
          approvalRequest = extractTerminalBriefApprovalRequestPacket(body);
        } catch (error) {
          const message = error instanceof Error ? error.message : "invalid approval executor input";
          throw new BrokerError("bad_request", message);
        }
        const executorOptions = body ?? {};
        const report = buildTerminalBriefApprovalExecutor(approvalRequest, {
          selectedAction: optionalString(executorOptions.selectedAction ?? executorOptions.selected_action),
          selectedTarget: optionalString(executorOptions.selectedTarget ?? executorOptions.selected_target),
          attemptExecute: executorOptions.attemptExecute === true || executorOptions.attempt_execute === true,
        });
        return sendJson(res, 200, report, {
          "cache-control": "no-store",
        });
      }

      if (req.method === "POST" && path === "/terminal-brief/closeout/approval-dispatch") {
        if (enforceRequesterIdentity) {
          assertRequesterHasRole(requesterIdentity, ["hub", "operator"], "terminal_brief.approval_dispatch.read");
        }
        const body = await readJson<Record<string, unknown>>(req);
        let approvalExecutor;
        try {
          approvalExecutor = extractTerminalBriefApprovalExecutorPacket(body);
        } catch (error) {
          const message = error instanceof Error ? error.message : "invalid approval dispatch input";
          throw new BrokerError("bad_request", message);
        }
        const dispatchOptions = body ?? {};
        const report = buildTerminalBriefApprovalDispatchAdapter(approvalExecutor, {
          adapter: optionalString(dispatchOptions.adapter ?? dispatchOptions.adapter_type ?? dispatchOptions.adapterType),
          target: optionalString(dispatchOptions.target),
          channel: optionalString(dispatchOptions.channel),
          requestedBy: optionalString(dispatchOptions.requestedBy ?? dispatchOptions.requested_by),
          receiptId: optionalString(dispatchOptions.receiptId ?? dispatchOptions.receipt_id),
        });
        return sendJson(res, 200, report, {
          "cache-control": "no-store",
        });
      }

      if (req.method === "POST" && path === "/terminal-brief/closeout/approval-receipt") {
        if (enforceRequesterIdentity) {
          assertRequesterHasRole(requesterIdentity, ["hub", "operator"], "terminal_brief.approval_receipt.read");
        }
        const body = await readJson<Record<string, unknown>>(req);
        let approvalDispatch;
        try {
          approvalDispatch = extractTerminalBriefApprovalDispatchAdapterPacket(body);
        } catch (error) {
          const message = error instanceof Error ? error.message : "invalid approval receipt input";
          throw new BrokerError("bad_request", message);
        }
        const receiptOptions = body ?? {};
        const maxAgeMsRaw = receiptOptions.maxAgeMs ?? receiptOptions.max_age_ms;
        const maxAgeMs = typeof maxAgeMsRaw === "number" && Number.isFinite(maxAgeMsRaw) ? maxAgeMsRaw : undefined;
        const report = buildTerminalBriefApprovalReceiptIngestor(
          approvalDispatch,
          extractTerminalBriefApprovalReceiptEvidence(body),
          { maxAgeMs },
        );
        return sendJson(res, 200, report, {
          "cache-control": "no-store",
        });
      }

      if (req.method === "POST" && path === "/terminal-brief/closeout/finalizer-approval-status") {
        if (enforceRequesterIdentity) {
          assertRequesterHasRole(requesterIdentity, ["hub", "operator"], "terminal_brief.finalizer_approval_status.read");
        }
        const body = await readJson<Record<string, unknown>>(req);
        let approvalDispatch;
        try {
          approvalDispatch = extractTerminalBriefFinalizerApprovalStatusDispatch(body);
        } catch (error) {
          const message = error instanceof Error ? error.message : "invalid finalizer approval status input";
          throw new BrokerError("bad_request", message);
        }
        const report = buildTerminalBriefFinalizerApprovalStatus(
          approvalDispatch,
          extractTerminalBriefFinalizerApprovalReceiptStatus(body),
        );
        return sendJson(res, 200, report, {
          "cache-control": "no-store",
        });
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

      if (req.method === "GET" && path === "/workers") {
        return handleWorkersListRequest({
          res,
          url,
          stateStore,
          broker,
          workerOfflineAfterMs: workerOfflineAfterSec * 1000,
        });
      }

      if (req.method === "GET" && path === "/workers/capacity") {
        return handleWorkerCapacityRequest({
          res,
          url,
          stateStore,
          broker,
          workerOfflineAfterMs: workerOfflineAfterSec * 1000,
        });
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

      if (req.method === "GET" && segments[0] === "workers" && segments[1] && segments.length === 2) {
        return handleWorkerByIdRequest({
          res,
          url,
          stateStore,
          broker,
          workerOfflineAfterMs: workerOfflineAfterSec * 1000,
          workerId: segments[1],
        });
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

      if (req.method === "GET" && path === "/exchanges") {
        return handleExchangesListRequest({ res, stateStore, broker });
      }

      if (req.method === "POST" && path === "/exchanges") {
        const body = await readJson<A2AExchangeRequest>(req);
        if (!body?.requester?.id || !body?.target?.id || !body?.message) {
          throw new BrokerError("bad_request", "requester.id, target.id, and message are required");
        }
        if (enforceRequesterIdentity) {
          assertRequesterMatchesParty(
            requesterIdentity,
            { id: body.requester.id, role: body.requester.role },
            "exchange.create",
          );
        }
        const exchange = broker.startExchange(body);
        await awaitDurablePersistenceAck(stateStore);
        return sendJson(res, 201, exchange);
      }

      if (req.method === "GET" && segments[0] === "exchanges" && segments[1] && segments[2] === "messages") {
        return handleExchangeMessagesRequest({
          res,
          stateStore,
          broker,
          exchangeId: segments[1],
          parentMessageId: optionalString(url.searchParams.get("parentMessageId")),
          includeDescendants: booleanQueryParam(url, "includeDescendants") ?? false,
        });
      }

      if (req.method === "POST" && segments[0] === "exchanges" && segments[1] && segments[2] === "messages") {
        const body = await readJson<A2AExchangeMessageRequest>(req);
        if (!body?.actor?.id || !body?.message) {
          throw new BrokerError("bad_request", "actor.id and message are required");
        }
        if (enforceRequesterIdentity) {
          assertRequesterMatchesParty(
            requesterIdentity,
            { id: body.actor.id, role: body.actor.role },
            "exchange.message.create",
          );
        }
        const message = broker.addExchangeMessage(segments[1], body);
        await awaitDurablePersistenceAck(stateStore);
        return sendJson(res, 201, message);
      }

      if (req.method === "GET" && segments[0] === "exchanges" && segments[1] && segments.length === 2) {
        return handleExchangeByIdRequest({ res, stateStore, broker, exchangeId: segments[1] });
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

export interface BrokerHotRuntimeLimits {
  maxNonTerminalTasks: number;
  maxTerminalTasks: number;
  maxAuditEvents: number;
  maxHeartbeatAuditEvents: number;
  maxTerminalOutboxEvents: number;
}

/**
 * Default keepAliveTimeout for the HTTP server (62s). Chosen to exceed the default
 * 30s worker heartbeat interval so that heartbeat TCP connections survive between
 * heartbeats and can be reused. Node.js defaults to 5000ms, which forces every
 * heartbeat to create a new TCP connection.
 */
function hasA2AHttpSignatureHeaders(req: IncomingMessage): boolean {
  return Boolean(headerValue(req, "signature-input") || headerValue(req, "signature"));
}

function requestHeadersForA2AHttpSignature(req: IncomingMessage): Record<string, string | undefined> {
  const headers: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    headers[name.toLowerCase()] = Array.isArray(value) ? value[0] : value;
  }
  return headers;
}

function assertA2AContentDigestMatches(req: IncomingMessage, rawBody: Buffer): void {
  const provided = headerValue(req, "content-digest");
  if (!provided) {
    throw new BrokerError("unauthorized", "a2a_signature_digest_required: content-digest is required");
  }
  const expected = `sha-256=:${createHash("sha256").update(rawBody).digest("base64")}:`;
  if (provided !== expected) {
    throw new BrokerError("unauthorized", "a2a_signature_digest_mismatch: content-digest does not match request body");
  }
}

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name.toLowerCase()];
  if (Array.isArray(value)) {
    return value[0]?.trim() || undefined;
  }
  if (typeof value === "string") {
    return value.trim() || undefined;
  }
  return undefined;
}

const DEFAULT_KEEPALIVE_TIMEOUT_MS = 62000;

/**
 * Margin applied to headersTimeout above keepAliveTimeout. Node.js requires
 * headersTimeout > keepAliveTimeout or server.listen() throws an error.
 */
const HEADERS_TIMEOUT_MARGIN_MS = 10000;

const DEFAULT_BROKER_HOT_RUNTIME_LIMITS: BrokerHotRuntimeLimits = {
  maxNonTerminalTasks: DEFAULT_HOT_RUNTIME_MAX_NON_TERMINAL_TASKS,
  maxTerminalTasks: DEFAULT_HOT_RUNTIME_MAX_TERMINAL_TASKS,
  maxAuditEvents: DEFAULT_HOT_RUNTIME_MAX_AUDIT_EVENTS,
  maxHeartbeatAuditEvents: DEFAULT_HOT_RUNTIME_MAX_HEARTBEAT_AUDIT_EVENTS,
  maxTerminalOutboxEvents: DEFAULT_HOT_RUNTIME_MAX_TERMINAL_OUTBOX_EVENTS,
};

function resolveHotRuntimeLimits(
  options: BrokerServerOptions,
): BrokerHotRuntimeLimits {
  return {
    maxNonTerminalTasks: Math.max(
      0,
      resolveIntegerOption(
        options.maxHotRuntimeNonTerminalTasks,
        process.env.BROKER_HOT_RUNTIME_MAX_NON_TERMINAL_TASKS,
        DEFAULT_BROKER_HOT_RUNTIME_LIMITS.maxNonTerminalTasks,
      ),
    ),
    maxTerminalTasks: Math.max(
      0,
      resolveIntegerOption(
        options.maxHotRuntimeTerminalTasks,
        process.env.BROKER_HOT_RUNTIME_MAX_TERMINAL_TASKS,
        DEFAULT_BROKER_HOT_RUNTIME_LIMITS.maxTerminalTasks,
      ),
    ),
    maxAuditEvents: Math.max(
      0,
      resolveIntegerOption(
        options.maxHotRuntimeAuditEvents,
        process.env.BROKER_HOT_RUNTIME_MAX_AUDIT_EVENTS,
        DEFAULT_BROKER_HOT_RUNTIME_LIMITS.maxAuditEvents,
      ),
    ),
    maxHeartbeatAuditEvents: Math.max(
      0,
      resolveIntegerOption(
        options.maxHotRuntimeHeartbeatAuditEvents,
        process.env.BROKER_HOT_RUNTIME_MAX_HEARTBEAT_AUDIT_EVENTS,
        Math.min(
          DEFAULT_BROKER_HOT_RUNTIME_LIMITS.maxAuditEvents,
          DEFAULT_BROKER_HOT_RUNTIME_LIMITS.maxHeartbeatAuditEvents,
        ),
      ),
    ),
    maxTerminalOutboxEvents: Math.max(
      0,
      resolveIntegerOption(
        options.maxHotRuntimeTerminalOutboxEvents,
        process.env.BROKER_HOT_RUNTIME_MAX_TERMINAL_OUTBOX_EVENTS,
        DEFAULT_BROKER_HOT_RUNTIME_LIMITS.maxTerminalOutboxEvents,
      ),
    ),
  };
}

function resolveBrokerRetentionPolicy(
  overrides?: Partial<BrokerRetentionPolicy>,
): BrokerRetentionPolicy {
  const maxAuditEvents = resolvePolicyNumber(
    overrides?.maxAuditEvents,
    process.env.BROKER_MAX_AUDIT_EVENTS,
    DEFAULT_BROKER_RETENTION_POLICY.maxAuditEvents,
  );
  return {
    terminalRetentionMs: resolvePolicyNumber(
      overrides?.terminalRetentionMs,
      process.env.BROKER_TERMINAL_RETENTION_MS,
      DEFAULT_BROKER_RETENTION_POLICY.terminalRetentionMs,
    ),
    maxTerminalExchanges: resolvePolicyNumber(
      overrides?.maxTerminalExchanges,
      process.env.BROKER_MAX_TERMINAL_EXCHANGES,
      DEFAULT_BROKER_RETENTION_POLICY.maxTerminalExchanges,
    ),
    maxTerminalTasks: resolvePolicyNumber(
      overrides?.maxTerminalTasks,
      process.env.BROKER_MAX_TERMINAL_TASKS,
      DEFAULT_BROKER_RETENTION_POLICY.maxTerminalTasks,
    ),
    maxTerminalProposals: resolvePolicyNumber(
      overrides?.maxTerminalProposals,
      process.env.BROKER_MAX_TERMINAL_PROPOSALS,
      DEFAULT_BROKER_RETENTION_POLICY.maxTerminalProposals,
    ),
    inactiveWorkerRetentionMs: resolvePolicyNumber(
      overrides?.inactiveWorkerRetentionMs,
      process.env.BROKER_INACTIVE_WORKER_RETENTION_MS,
      DEFAULT_BROKER_RETENTION_POLICY.inactiveWorkerRetentionMs,
    ),
    maxInactiveWorkers: resolvePolicyNumber(
      overrides?.maxInactiveWorkers,
      process.env.BROKER_MAX_INACTIVE_WORKERS,
      DEFAULT_BROKER_RETENTION_POLICY.maxInactiveWorkers,
    ),
    auditRetentionMs: resolvePolicyNumber(
      overrides?.auditRetentionMs,
      process.env.BROKER_AUDIT_RETENTION_MS,
      DEFAULT_BROKER_RETENTION_POLICY.auditRetentionMs,
    ),
    maxAuditEvents,
    maxHeartbeatAuditEvents: resolvePolicyNumber(
      overrides?.maxHeartbeatAuditEvents,
      process.env.BROKER_MAX_HEARTBEAT_AUDIT_EVENTS,
      Math.min(maxAuditEvents, DEFAULT_BROKER_RETENTION_POLICY.maxHeartbeatAuditEvents),
    ),
    heartbeatAuditSampleIntervalMs: resolvePolicyNumber(
      overrides?.heartbeatAuditSampleIntervalMs,
      process.env.BROKER_HEARTBEAT_AUDIT_SAMPLE_INTERVAL_MS,
      DEFAULT_BROKER_RETENTION_POLICY.heartbeatAuditSampleIntervalMs,
    ),
  };
}

function resolveStringOption(
  explicit: string | undefined,
  fromEnv: string | undefined,
  fallback?: string,
): string | undefined {
  if (typeof explicit === "string" && explicit.trim()) {
    return explicit.trim();
  }
  if (typeof fromEnv === "string" && fromEnv.trim()) {
    return fromEnv.trim();
  }
  if (typeof fallback === "string" && fallback.trim()) {
    return fallback.trim();
  }
  return undefined;
}

function resolveIntegerOption(
  explicit: number | undefined,
  fromEnv: string | undefined,
  fallback: number,
): number {
  if (typeof explicit === "number" && Number.isFinite(explicit)) {
    return Math.trunc(explicit);
  }
  if (fromEnv !== undefined) {
    const parsed = Number(fromEnv);
    if (Number.isFinite(parsed)) {
      return Math.trunc(parsed);
    }
  }
  return fallback;
}

function resolveBooleanEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "1" || normalized === "true" || normalized === "yes") {
    return true;
  }
  if (normalized === "0" || normalized === "false" || normalized === "no") {
    return false;
  }
  return fallback;
}

function resolveBrokerId(explicit: string | undefined, serviceName: string): string {
  return sanitizeBuildToken(explicit ?? process.env.A2A_BROKER_ID ?? process.env.BROKER_ID ?? serviceName, {
    fallback: serviceName,
    unsafeFallback: "redacted",
  }) ?? serviceName;
}

function resolveBrokerBuildInfo(options: BrokerServerOptions, serviceName: string): { version: string; build: BrokerBuildInfo } {
  const generated = readGeneratedBuildInfo(options.buildInfoFile);
  const version = sanitizeBuildToken(options.version ?? process.env.A2A_BROKER_VERSION ?? generated.version ?? readPackageVersion(), {
    fallback: "0.0.0",
    unsafeFallback: "0.0.0",
  }) ?? "0.0.0";
  const revision = sanitizeBuildToken(
    options.buildRevision ??
      options.releaseRevision ??
      process.env.A2A_BROKER_REVISION ??
      process.env.BROKER_RELEASE_REVISION ??
      process.env.RELEASE_REVISION ??
      generated.revision,
    { fallback: "unknown", unsafeFallback: "redacted" },
  ) ?? "unknown";
  const source = sanitizeBuildSource(process.env.A2A_BROKER_SOURCE ?? generated.source ?? "github.com/jinwon-int/a2a-nexus");
  const builtAt = sanitizeIsoTimestamp(process.env.A2A_BROKER_BUILT_AT ?? generated.builtAt);
  const runtime = sanitizeBuildToken(process.env.A2A_BROKER_RUNTIME ?? generated.runtime, {
    fallback: undefined,
    unsafeFallback: undefined,
  });
  const imageTag = sanitizeBuildToken(process.env.A2A_BROKER_IMAGE_TAG ?? generated.image?.tag, {
    fallback: undefined,
    unsafeFallback: undefined,
  });
  const imageDigest = sanitizeImageDigest(process.env.A2A_BROKER_IMAGE_DIGEST ?? generated.image?.digest);

  const image = imageTag || imageDigest ? { ...(imageTag ? { tag: imageTag } : {}), ...(imageDigest ? { digest: imageDigest } : {}) } : undefined;

  return {
    version,
    build: {
      component: serviceName,
      revision,
      source,
      ...(builtAt ? { builtAt } : {}),
      ...(runtime ? { runtime } : {}),
      ...(image ? { image } : {}),
    },
  };
}

function readGeneratedBuildInfo(path?: string): Partial<BrokerBuildInfo & { version: string }> {
  const candidates = path ? [path] : [new URL("./build-info.json", import.meta.url)];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(readFileSync(candidate, "utf8")) as Partial<BrokerBuildInfo & { version: string }>;
      if (parsed && typeof parsed === "object") {
        return parsed;
      }
    } catch {
      // Generated build-info is optional in local/dev runs.
    }
  }
  return {};
}

function readPackageVersion(): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: string };
    return parsed.version;
  } catch {
    return undefined;
  }
}

function normalizePersistenceBackend(value: string | undefined): "json-file" | "sqlite" {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "sqlite") {
    return "sqlite";
  }
  return "json-file";
}

function normalizeSqliteLoadSource(value: string | undefined): SqliteBrokerLoadSource {
  const normalized = value?.trim().toLowerCase().replace(/_/g, "-");
  if (normalized === "hot-tables" || normalized === "hot-table" || normalized === "hot-runtime") {
    return "hot-tables";
  }
  return "snapshot";
}

function createDefaultStateStore(params: {
  backend: "json-file" | "sqlite";
  stateFile: string;
  sqliteFile?: string;
  sqliteLoadSource: SqliteBrokerLoadSource;
  maxSnapshotBytes: number;
  hotRuntimeLimits?: BrokerHotRuntimeLimits;
}): BrokerStateStore {
  if (params.backend === "sqlite") {
    return new SqliteBrokerStateStore(params.sqliteFile ?? `${params.stateFile}.sqlite`, {
      importJsonFile: params.stateFile,
      loadSource: params.sqliteLoadSource,
      maxBytes: params.maxSnapshotBytes,
      maxHotRuntimeNonTerminalTasks: params.hotRuntimeLimits?.maxNonTerminalTasks,
      maxHotRuntimeTerminalTasks: params.hotRuntimeLimits?.maxTerminalTasks,
      maxHotRuntimeAuditEvents: params.hotRuntimeLimits?.maxAuditEvents,
      maxHotRuntimeHeartbeatAuditEvents: params.hotRuntimeLimits?.maxHeartbeatAuditEvents,
      maxHotRuntimeTerminalOutboxEvents: params.hotRuntimeLimits?.maxTerminalOutboxEvents,
    });
  }
  return new JsonFileBrokerStateStore(params.stateFile, { maxBytes: params.maxSnapshotBytes });
}

function resolvePolicyNumber(
  explicit: number | undefined,
  fromEnv: string | undefined,
  fallback: number,
): number {
  if (typeof explicit === "number" && Number.isFinite(explicit)) {
    return Math.max(0, Math.trunc(explicit));
  }
  const parsed = Number(fromEnv);
  if (Number.isFinite(parsed)) {
    return Math.max(0, Math.trunc(parsed));
  }
  return fallback;
}

function resolvePublicBaseUrl(value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new Error(
      "PUBLIC_BASE_URL is required. Set a real public base URL instead of relying on the masked placeholder.",
    );
  }

  const normalized = trimmed.toLowerCase();
  if (normalized.includes("<masked-host>")) {
    throw new Error(
      "PUBLIC_BASE_URL must not use the placeholder http://<masked-host>:8787. Set the real public base URL before starting the broker.",
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`PUBLIC_BASE_URL must be a valid absolute URL: ${trimmed}`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`PUBLIC_BASE_URL must use http or https: ${trimmed}`);
  }

  return parsed.toString();
}

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
export function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

// Grace period after server.close() before force-closing lingering (e.g. SSE)
// connections so a graceful shutdown cannot hang indefinitely.
const SHUTDOWN_FORCE_CLOSE_MS = 5_000;

function listAuditEventsForReadPath(
  stateStore: BrokerStateStore,
  broker: InMemoryA2ABroker,
  filters: AuditListFilters,
) {
  if (stateStore instanceof SqliteBrokerStateStore) {
    return stateStore.readHotAuditEvents(filters);
  }
  return broker.listAuditEvents(filters);
}

interface TaskListItem {
  id: string;
  intent: TaskKind;
  status: TaskStatus;
  targetNodeId: string;
  requester: TaskRecord["requester"];
  target: TaskRecord["target"];
  exchangeId?: string;
  parentTaskId?: string;
  proposalId?: string;
  assignedWorkerId?: string;
  claimedBy?: string;
  taskOrigin?: TaskOrigin;
  artifactIds?: string[];
  resultSummary?: string;
  error?: Pick<NonNullable<TaskRecord["error"]>, "code" | "message">;
  requeueCount?: number;
  createdAt: string;
  updatedAt: string;
  claimedAt?: string;
  completedAt?: string;
}

function projectTaskListItem(task: TaskRecord): TaskListItem {
  const artifactIds = task.result?.artifactIds ?? task.artifactIds;
  return {
    id: task.id,
    intent: task.intent,
    status: task.status,
    targetNodeId: task.targetNodeId,
    requester: task.requester,
    target: task.target,
    exchangeId: task.exchangeId,
    parentTaskId: task.parentTaskId,
    proposalId: task.proposalId,
    assignedWorkerId: task.assignedWorkerId,
    claimedBy: task.claimedBy,
    taskOrigin: task.taskOrigin,
    artifactIds,
    resultSummary: task.result?.summary ?? task.result?.note,
    error: task.error ? { code: task.error.code, message: task.error.message } : undefined,
    requeueCount: task.requeueCount,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    claimedAt: task.claimedAt,
    completedAt: task.completedAt,
  };
}

const ACTIVE_READ_PATH_STATUSES = new Set<TaskStatus>(["queued"]);

function shouldFilterSqliteActiveReadPath(filters: TaskListFilters): boolean {
  return filters.includeStaleReadPath !== true && (!filters.status || ACTIVE_READ_PATH_STATUSES.has(filters.status));
}

function taskIsLiveInMutationMap(broker: InMemoryA2ABroker, task: { id: string; status: TaskStatus }): boolean {
  if (!ACTIVE_READ_PATH_STATUSES.has(task.status)) return true;
  return Boolean(broker.getTask(task.id));
}

function listTasksForReadPath(
  stateStore: BrokerStateStore,
  broker: InMemoryA2ABroker,
  filters: TaskListFilters,
): TaskRecord[] {
  if (stateStore instanceof SqliteBrokerStateStore && canUseSqliteTaskHotRead(filters)) {
    const sqliteFilters = {
      status: filters.status,
      targetNodeId: filters.targetNodeId,
      intent: filters.intent,
      assignedWorkerId: filters.assignedWorkerId,
      taskOrigin: filters.taskOrigin,
      limit: shouldFilterSqliteActiveReadPath(filters) ? undefined : filters.limit,
    };
    const tasks = stateStore.readHotTasks(sqliteFilters);
    const filtered = shouldFilterSqliteActiveReadPath(filters)
      ? tasks.filter((task) => taskIsLiveInMutationMap(broker, task))
      : tasks;
    return filtered.slice(0, filters.limit);
  }
  return broker.listTasks(filters);
}

function listTaskItemsForReadPath(
  stateStore: BrokerStateStore,
  broker: InMemoryA2ABroker,
  filters: TaskListFilters,
): TaskListItem[] {
  if (stateStore instanceof SqliteBrokerStateStore && canUseSqliteTaskHotRead(filters)) {
    const sqliteFilters = {
      status: filters.status,
      targetNodeId: filters.targetNodeId,
      intent: filters.intent,
      assignedWorkerId: filters.assignedWorkerId,
      taskOrigin: filters.taskOrigin,
      limit: shouldFilterSqliteActiveReadPath(filters) ? undefined : filters.limit,
    };
    const items = stateStore.readHotTaskListItems(sqliteFilters);
    const filtered = shouldFilterSqliteActiveReadPath(filters)
      ? items.filter((task) => taskIsLiveInMutationMap(broker, task))
      : items;
    return filtered.slice(0, filters.limit).map(projectSqliteTaskListItem);
  }
  return broker.listTasks(filters).map(projectTaskListItem);
}

function projectSqliteTaskListItem(task: SqliteTaskListItemProjection): TaskListItem {
  return {
    id: task.id,
    intent: task.intent,
    status: task.status,
    targetNodeId: task.targetNodeId,
    requester: task.requester,
    target: task.target,
    exchangeId: task.exchangeId,
    parentTaskId: task.parentTaskId,
    proposalId: task.proposalId,
    assignedWorkerId: task.assignedWorkerId,
    claimedBy: task.claimedBy,
    taskOrigin: task.taskOrigin,
    artifactIds: task.artifactIds,
    resultSummary: task.resultSummary,
    error: task.error,
    requeueCount: task.requeueCount,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    claimedAt: task.claimedAt,
    completedAt: task.completedAt,
  };
}

function getTaskForReadPath(
  stateStore: BrokerStateStore,
  broker: InMemoryA2ABroker,
  taskId: string,
  options: { includeStaleReadPath?: boolean } = {},
): TaskRecord | null {
  if (stateStore instanceof SqliteBrokerStateStore) {
    const task = stateStore.readHotTasks({ id: taskId })[0] ?? null;
    if (task && options.includeStaleReadPath !== true && !taskIsLiveInMutationMap(broker, task)) {
      return null;
    }
    return task;
  }
  return broker.getTask(taskId);
}

function getTaskDiagnosticsForReadPath(
  stateStore: BrokerStateStore,
  broker: InMemoryA2ABroker,
  taskId: string,
  options: TaskDiagnosticsOptions,
): TaskDiagnosticReport {
  if (stateStore instanceof SqliteBrokerStateStore) {
    const task = stateStore.readHotTasks({ id: taskId })[0];
    if (!task) {
      throw new BrokerError("not_found", "task not found");
    }
    const assignedWorker = task.assignedWorkerId
      ? stateStore.readHotWorkers({ nodeId: task.assignedWorkerId })[0] ?? null
      : null;
    const lastRequeueEvent = latestAuditEvent(stateStore.readHotAuditEvents({
      targetId: taskId,
      action: "task.requeued",
    }));
    return broker.getTaskDiagnosticsForRecord(task, options, {
      tombstone: stateStore.readHotTombstones({ taskId })[0] ?? null,
      assignedWorker,
      lastRequeueEvent,
    });
  }
  return broker.getTaskDiagnostics(taskId, options);
}

function listTaskDiagnosticsForReadPath(
  stateStore: BrokerStateStore,
  broker: InMemoryA2ABroker,
  options: TaskDiagnosticsOptions,
): TaskDiagnosticReport[] {
  if (stateStore instanceof SqliteBrokerStateStore) {
    const tombstonesByTaskId = new Map<string, TaskTombstone>(
      stateStore.readHotTombstones().map((tombstone) => [tombstone.taskId, tombstone]),
    );
    const workersByNodeId = new Map<string, WorkerRecord>(
      stateStore.readHotWorkers().map((worker) => [worker.nodeId, worker]),
    );
    const latestRequeueEventByTaskId = new Map<string, AuditEvent>();
    for (const event of stateStore.readHotAuditEvents({ action: "task.requeued" })) {
      const existing = latestRequeueEventByTaskId.get(event.targetId);
      if (!existing || event.createdAt > existing.createdAt) {
        latestRequeueEventByTaskId.set(event.targetId, event);
      }
    }
    return stateStore.readHotTasks().map((task) => broker.getTaskDiagnosticsForRecord(task, options, {
      tombstone: tombstonesByTaskId.get(task.id) ?? null,
      assignedWorker: task.assignedWorkerId ? workersByNodeId.get(task.assignedWorkerId) ?? null : null,
      lastRequeueEvent: latestRequeueEventByTaskId.get(task.id) ?? null,
    }));
  }
  return broker.listTasks().map((task) => broker.getTaskDiagnostics(task.id, options));
}

function latestAuditEvent(events: AuditEvent[]): AuditEvent | null {
  let latest: AuditEvent | null = null;
  for (const event of events) {
    if (!latest || event.createdAt > latest.createdAt) {
      latest = event;
    }
  }
  return latest;
}

function canUseSqliteTaskHotRead(filters: TaskListFilters): boolean {
  return !(
    filters.exchangeId ||
    filters.proposalId ||
    filters.claimedBy
  );
}

function mapBrokerDiagnosticsToSnapshot(
  diagnostics: import("./core/store.js").BrokerHotTerminalOutboxDiagnostics,
): NonNullable<import("./core/release-evidence.js").ReleaseEvidenceExportOptions["terminalOutboxDiagnostics"]> {
  return {
    total: diagnostics.total,
    acked: diagnostics.acked,
    unacked: diagnostics.unacked,
    unackedRatio: diagnostics.unackedRatio,
    oldestUnackedAgeMs: diagnostics.oldestUnackedAgeMs,
    oldestUnackedCreatedAt: diagnostics.oldestUnackedCreatedAt,
    ackEligibleUnacked: diagnostics.ackEligibleUnacked,
    warnings: diagnostics.warnings,
  };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function assertCreateTaskRequestParties(body: CreateTaskRequest): void {
  assertRequestParty(body.requester, "requester");
  assertRequestParty(body.target, "target");
}

function assertRequestParty(value: unknown, field: "requester" | "target"): void {
  if (!value || typeof value !== "object") {
    throw new BrokerError("bad_request", `${field}.id is required`);
  }
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || record.id.trim().length === 0) {
    throw new BrokerError("bad_request", `${field}.id is required`);
  }
}

function optionalEnum<T extends string>(value: string | null, allowed: readonly T[]): T | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.trim() as T;
  return allowed.includes(normalized) ? normalized : undefined;
}

function parseTerminalOutboxAckReceipt(value: unknown): TerminalTaskOutboxAckInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BrokerError(
      "bad_request",
      "terminal outbox ack requires receipt evidence; Gateway/provider send success alone is not accepted",
    );
  }
  const receipt = value as Record<string, unknown>;
  if (!isTerminalTaskOutboxAckInputEvidence(receipt.evidence)) {
    throw new BrokerError(
      "bad_request",
      "terminal outbox ack evidence must be current_session_visible, operator_visible, or operator_confirmed",
    );
  }
  return {
    evidence: receipt.evidence,
    acknowledgedAt: typeof receipt.acknowledgedAt === "string" ? receipt.acknowledgedAt : undefined,
    receiptId: typeof receipt.receiptId === "string" ? receipt.receiptId : undefined,
    note: typeof receipt.note === "string" ? receipt.note : undefined,
  };
}

function parseTerminalOutboxReceiptUpdate(value: unknown): TerminalTaskOutboxReceiptUpdateInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BrokerError("bad_request", "terminal outbox receipt update requires a receipt object");
  }
  const receipt = value as Record<string, unknown>;
  if (!isTerminalTaskReceiptStatus(receipt.status)) {
    throw new BrokerError(
      "bad_request",
      "terminal outbox receipt status must be accepted, started, produced, provider_sent, provider_accepted, current_session_visible, operator_visible, timed_out, stale, or failed",
    );
  }
  return {
    status: receipt.status,
    updatedAt: typeof receipt.updatedAt === "string" ? receipt.updatedAt : undefined,
    note: typeof receipt.note === "string" ? receipt.note : undefined,
  };
}

function numberQueryParam(url: URL, name: string): number | undefined {
  const value = url.searchParams.get(name);
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new BrokerError("bad_request", `${name} must be a non-negative number`);
  }
  return parsed;
}

function boundedLimitQueryParam(
  url: URL,
  name: string,
  max: number,
  defaultValue?: number,
): number | undefined {
  const parsed = numberQueryParam(url, name);
  if (parsed === undefined) {
    return defaultValue;
  }
  if (!Number.isInteger(parsed)) {
    throw new BrokerError("bad_request", `${name} must be an integer`);
  }
  return Math.min(parsed, max);
}

function booleanQueryParam(url: URL, name: string): boolean | undefined {
  const value = url.searchParams.get(name);
  if (!value) {
    return undefined;
  }
  if (value === "1" || value.toLowerCase() === "true") {
    return true;
  }
  if (value === "0" || value.toLowerCase() === "false") {
    return false;
  }
  throw new BrokerError("bad_request", `${name} must be a boolean`);
}

function cleanupPlanOptionsFromUrl(url: URL): BrokerCleanupPlanOptions {
  return {
    nowMs: numberQueryParam(url, "now_ms"),
    taskRetentionMs: numberQueryParam(url, "task_retention_ms"),
    maxTerminalTasks: numberQueryParam(url, "max_terminal_tasks"),
    auditRetentionMs: numberQueryParam(url, "audit_retention_ms"),
    maxAuditEvents: numberQueryParam(url, "max_audit_events"),
    workerRetentionMs: numberQueryParam(url, "worker_retention_ms"),
    maxInactiveWorkers: numberQueryParam(url, "max_inactive_workers"),
    terminalOutboxRetentionMs: numberQueryParam(url, "terminal_outbox_retention_ms"),
    maxAcknowledgedTerminalOutboxEvents: numberQueryParam(url, "max_acknowledged_terminal_outbox_events"),
    protectedTaskIds: stringListQueryParam(url, "protected_task_id"),
    protectedWorkerIds: stringListQueryParam(url, "protected_worker_id"),
  };
}

function cleanupPlanOptionsFromBody(body: Record<string, unknown> | null | undefined): BrokerCleanupPlanOptions {
  return {
    nowMs: nonNegativeNumberBodyField(body, "nowMs"),
    taskRetentionMs: nonNegativeNumberBodyField(body, "taskRetentionMs"),
    maxTerminalTasks: nonNegativeNumberBodyField(body, "maxTerminalTasks"),
    auditRetentionMs: nonNegativeNumberBodyField(body, "auditRetentionMs"),
    maxAuditEvents: nonNegativeNumberBodyField(body, "maxAuditEvents"),
    workerRetentionMs: nonNegativeNumberBodyField(body, "workerRetentionMs"),
    maxInactiveWorkers: nonNegativeNumberBodyField(body, "maxInactiveWorkers"),
    terminalOutboxRetentionMs: nonNegativeNumberBodyField(body, "terminalOutboxRetentionMs"),
    maxAcknowledgedTerminalOutboxEvents: nonNegativeNumberBodyField(body, "maxAcknowledgedTerminalOutboxEvents"),
    protectedTaskIds: stringListBodyField(body, "protectedTaskIds"),
    protectedWorkerIds: stringListBodyField(body, "protectedWorkerIds"),
  };
}

function stringListQueryParam(url: URL, name: string): string[] | undefined {
  const values = url.searchParams.getAll(name).flatMap((value) => value.split(","));
  const normalized = values.map((value) => value.trim()).filter(Boolean);
  return normalized.length > 0 ? [...new Set(normalized)] : undefined;
}

function nonNegativeNumberBodyField(body: Record<string, unknown> | null | undefined, name: string): number | undefined {
  const value = body?.[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new BrokerError("bad_request", `${name} must be a non-negative number`);
  }
  return value;
}

function stringListBodyField(body: Record<string, unknown> | null | undefined, name: string): string[] | undefined {
  const value = body?.[name];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new BrokerError("bad_request", `${name} must be an array of strings`);
  }
  const normalized = value.map((item) => item.trim()).filter(Boolean);
  return normalized.length > 0 ? [...new Set(normalized)] : undefined;
}

function buildDashboardAttention(input: {
  dashboard: BrokerDashboard;
  staleReaper: BrokerStaleReaperStatus;
  persistenceQueue: BrokerPersistenceQueueDiagnostics;
  requestPressure: {
    general: RateLimitPressureSnapshot;
    worker: RateLimitPressureSnapshot;
  };
}): DashboardAttentionSummary {
  const items: DashboardAttentionItem[] = [];

  const staleAssignments = input.dashboard.observability.queuePressure.staleWorkerAssignments;
  if (staleAssignments > 0) {
    items.push({
      code: "stale-worker-assignments",
      severity: "critical",
      count: staleAssignments,
      summary: `${staleAssignments} claimed/running task(s) are assigned to stale workers`,
    });
  }

  const staleWorkers = input.dashboard.observability.workerHealth.staleWorkersWithActiveTasks.length;
  if (staleWorkers > 0) {
    items.push({
      code: "stale-workers-with-active-tasks",
      severity: "critical",
      count: staleWorkers,
      summary: `${staleWorkers} stale worker(s) still have active tasks`,
    });
  }

  const claimedAgeThresholdSec = Math.max(1, input.staleReaper.olderThanSec || 0);
  const oldestClaimed = input.dashboard.observability.queuePressure.oldestClaimed;
  if (oldestClaimed && oldestClaimed.statusAgeSec >= claimedAgeThresholdSec) {
    items.push({
      code: "aged-claimed-task",
      severity: oldestClaimed.statusAgeSec >= claimedAgeThresholdSec * 2 ? "critical" : "warn",
      count: 1,
      summary: `claimed task ${oldestClaimed.id} has been waiting ${oldestClaimed.statusAgeSec}s since claim`,
    });
  }

  const runningAgeThresholdSec = claimedAgeThresholdSec;
  const oldestRunning = input.dashboard.observability.queuePressure.oldestRunning;
  if (oldestRunning && oldestRunning.statusAgeSec >= runningAgeThresholdSec) {
    items.push({
      code: "aged-running-task",
      severity: oldestRunning.statusAgeSec >= runningAgeThresholdSec * 2 ? "critical" : "warn",
      count: 1,
      summary: `running task ${oldestRunning.id} has been active ${oldestRunning.statusAgeSec}s since start`,
    });
  }

  const recentDeadLetters = Math.max(
    input.dashboard.observability.recovery.recentDeadLetters.length,
    input.staleReaper.lastDeadLettered ?? 0,
  );
  if (recentDeadLetters > 0) {
    items.push({
      code: "dead-lettered-tasks",
      severity: "warn",
      count: recentDeadLetters,
      summary: `${recentDeadLetters} task(s) were dead-lettered and need operator review`,
    });
  }

  const recentRequeues = input.staleReaper.lastRequeued ?? 0;
  if (recentRequeues > 0) {
    items.push({
      code: "stale-reaper-requeues",
      severity: "info",
      count: recentRequeues,
      summary: `stale reaper requeued ${recentRequeues} task(s) on the last sweep`,
    });
  }

  if (input.persistenceQueue.state === "saturated") {
    items.push({
      code: "persistence-queue-saturated",
      severity: "warn",
      count: input.persistenceQueue.inFlight,
      summary: `persistence queue saturated: ${input.persistenceQueue.inFlight} in-flight write(s)`,
    });
  } else if (input.persistenceQueue.state === "aborted" || input.persistenceQueue.state === "unavailable") {
    items.push({
      code: "persistence-queue-unavailable",
      severity: "critical",
      count: input.persistenceQueue.inFlight,
      summary: `persistence queue ${input.persistenceQueue.state}`,
    });
  } else if (input.persistenceQueue.state === "draining" || input.persistenceQueue.closing) {
    items.push({
      code: "persistence-queue-draining",
      severity: "info",
      count: input.persistenceQueue.inFlight,
      summary: `persistence queue draining: ${input.persistenceQueue.inFlight} in-flight write(s)`,
    });
  }

  const saturatedGeneralKeys = input.requestPressure.general.busiest.filter((entry) => entry.remaining === 0).length;
  const saturatedWorkerKeys = input.requestPressure.worker.busiest.filter((entry) => entry.remaining === 0).length;
  const saturatedKeys = saturatedGeneralKeys + saturatedWorkerKeys;
  if (saturatedKeys > 0) {
    items.push({
      code: "rate-limit-saturation",
      severity: "warn",
      count: saturatedKeys,
      summary: `${saturatedKeys} rate-limit key(s) are currently saturated`,
    });
  }

  return {
    highestSeverity: highestDashboardAttentionSeverity(items),
    items,
  };
}

function highestDashboardAttentionSeverity(items: DashboardAttentionItem[]): DashboardAttentionSummary["highestSeverity"] {
  let highest: DashboardAttentionSummary["highestSeverity"] = "none";
  for (const item of items) {
    if (item.severity === "critical") {
      return "critical";
    }
    if (item.severity === "warn") {
      highest = highest === "none" || highest === "info" ? "warn" : highest;
      continue;
    }
    if (item.severity === "info" && highest === "none") {
      highest = "info";
    }
  }
  return highest;
}


function buildOperatorDashboardSnapshot(input: {
  broker: InMemoryA2ABroker;
  dashboard: BrokerDashboard;
  staleReaper: BrokerStaleReaperStatus;
  staleAfterMs?: number;
  longRunningAfterMs?: number;
}): OperatorDashboardSnapshot {
  const tasks = input.broker.listTasks();
  const byStatus = { ...input.dashboard.queue.byStatus } as Record<TaskStatus, number>;
  const terminalStatuses = new Set<TaskStatus>(["succeeded", "failed", "canceled"]);
  const activeStatuses = new Set<TaskStatus>(["blocked", "queued", "claimed", "running"]);
  const attentionItems: OperatorAttentionItem[] = [];

  for (const task of tasks) {
    const report = input.broker.getTaskDiagnostics(task.id, {
      staleAfterMs: input.staleAfterMs ?? Math.max(1, input.staleReaper.olderThanSec) * 1000,
      longRunningAfterMs: input.longRunningAfterMs,
    });
    const statusAgeSec = Math.floor(report.currentStatusDurationMs / 1000);
    const whoClaimed = task.claimedBy ?? task.assignedWorkerId ?? null;
    const base = {
      taskId: task.id,
      status: task.status,
      intent: task.intent,
      targetNodeId: task.targetNodeId,
      assignedWorkerId: task.assignedWorkerId,
      claimedBy: task.claimedBy,
      requeueCount: task.requeueCount ?? 0,
      statusAgeSec,
      whoClaimed,
      lastHeartbeatAt: task.lastHeartbeatAt,
    };

    if (task.status === "failed" && task.error?.code === "exceeded_requeue_limit") {
      attentionItems.push({
        ...base,
        code: "dead_lettered",
        severity: "critical",
        whyStuck: `task exceeded the stale requeue limit (${task.requeueCount ?? 0}/${input.staleReaper.maxRequeueAttempts})`,
        whatNext: "inspect the failed attempt evidence, fix or replace the worker, then create/reassign follow-up work",
        completedAt: task.completedAt,
        errorCode: task.error.code,
        errorMessage: task.error.message,
      });
      continue;
    }

    if (report.brokerHints.staleWorker && (task.status === "claimed" || task.status === "running")) {
      attentionItems.push({
        ...base,
        code: "stale_worker",
        severity: "critical",
        whyStuck: `${whoClaimed ?? task.targetNodeId} claimed/owns the task but its worker heartbeat is stale`,
        whatNext: "check the worker process; if it is not recovering, requeue stale tasks or reassign to a healthy worker",
      });
      continue;
    }

    if (report.diagnosticStatus === "stale") {
      attentionItems.push({
        ...base,
        code: "stale_task",
        severity: "warn",
        whyStuck: report.interruption?.summary ?? `task has had no fresh heartbeat for ${statusAgeSec}s`,
        whatNext: "ask the claimant for progress; if no evidence arrives, run stale requeue or reassign",
      });
      continue;
    }

    if (report.diagnosticStatus === "long_running") {
      attentionItems.push({
        ...base,
        code: "long_running",
        severity: "warn",
        whyStuck: `running longer than the configured operator threshold (${statusAgeSec}s)`,
        whatNext: "request progress evidence or split/cancel the task if it cannot finish promptly",
      });
      continue;
    }

    if ((task.requeueCount ?? 0) > 0 && (task.status === "queued" || task.status === "claimed" || task.status === "running")) {
      attentionItems.push({
        ...base,
        code: "requeued",
        severity: "info",
        whyStuck: `task has already been requeued ${task.requeueCount} time(s) after stale execution attempts`,
        whatNext: "prefer a healthy worker and watch for another stale attempt before the dead-letter cap",
      });
    }
  }

  attentionItems.sort((left, right) => {
    const severityRank = { critical: 0, warn: 1, info: 2 } as const;
    const severityCmp = severityRank[left.severity] - severityRank[right.severity];
    if (severityCmp !== 0) {
      return severityCmp;
    }
    const ageCmp = right.statusAgeSec - left.statusAgeSec;
    if (ageCmp !== 0) {
      return ageCmp;
    }
    return left.taskId.localeCompare(right.taskId);
  });

  return {
    generatedAt: input.dashboard.generatedAt,
    workers: input.dashboard.workers,
    taskStatusSummary: {
      total: tasks.length,
      active: tasks.filter((task) => activeStatuses.has(task.status)).length,
      terminal: tasks.filter((task) => terminalStatuses.has(task.status)).length,
      byStatus,
    },
    recoverySummary: {
      stale: {
        staleWorkerAssignments: input.dashboard.observability.queuePressure.staleWorkerAssignments,
        staleWorkersWithActiveTasks: input.dashboard.observability.workerHealth.staleWorkersWithActiveTasks,
        oldestClaimed: input.dashboard.observability.queuePressure.oldestClaimed,
        oldestRunning: input.dashboard.observability.queuePressure.oldestRunning,
      },
      retry: {
        totalRequeued: input.dashboard.observability.recovery.totalRequeued,
        maxRequeueAttempts: input.staleReaper.maxRequeueAttempts,
        recentRequeues: input.dashboard.observability.recovery.recentRequeues,
      },
      deadLetter: {
        totalDeadLettered: input.dashboard.observability.recovery.totalDeadLettered,
        recentDeadLetters: input.dashboard.observability.recovery.recentDeadLetters,
      },
    },
    attentionItems,
  };
}

function buildDashboardResponse(input: {
  broker: InMemoryA2ABroker;
  workerOfflineAfterSec: number;
  getStaleReaperStatus: () => BrokerStaleReaperStatus;
  rateLimiter: InMemoryRateLimiter;
  workerRateLimiter: InMemoryRateLimiter;
  version: string;
  build: BrokerBuildInfo;
  recentHistoryLimit?: number;
  oldestPendingLimit?: number;
  pendingActionLimit?: number;
  hotEntityDiagnostics?: BrokerHotEntityDiagnostics;
  persistenceQueue: BrokerPersistenceQueueDiagnostics;
}): OperatorSummary {
  const dashboard = input.broker.getDashboard({
    offlineAfterMs: input.workerOfflineAfterSec * 1000,
    recentHistoryLimit: input.recentHistoryLimit ?? DEFAULT_DASHBOARD_RECENT_HISTORY_LIMIT,
    oldestPendingLimit: input.oldestPendingLimit ?? DEFAULT_DASHBOARD_OLDEST_PENDING_LIMIT,
    pendingActionLimit: input.pendingActionLimit ?? DEFAULT_DASHBOARD_PENDING_ACTION_LIMIT,
  });
  const staleReaper = input.getStaleReaperStatus();
  const requestPressure = {
    general: input.rateLimiter.snapshot(),
    worker: input.workerRateLimiter.snapshot(),
  };
  return {
    ...dashboard,
    version: input.version,
    build: input.build,
    staleReaper,
    requestPressure,
    attention: buildDashboardAttention({
      dashboard,
      staleReaper,
      persistenceQueue: input.persistenceQueue,
      requestPressure,
    }),
    operatorSnapshot: buildOperatorDashboardSnapshot({
      broker: input.broker,
      dashboard,
      staleReaper,
    }),
    hotEntityDiagnostics: input.hotEntityDiagnostics,
    persistenceQueue: input.persistenceQueue,
  };
}

function buildAlertScan(input: {
  broker: InMemoryA2ABroker;
  staleAfterMs?: number;
  longRunningAfterMs?: number;
  staleWarningMs?: number;
  staleCriticalMs?: number;
  longRunningWarningMs?: number;
  longRunningCriticalMs?: number;
  workerHeartbeatMissedAfterMs: number;
  nowMs?: number;
  /** Optional hot-table growth projection for storage-growth alerts. */
  hotTableGrowth?: HotTableGrowthProjection | null;
}): AlertScanResult {
  const staleAfterMs = input.staleAfterMs ?? DEFAULT_ALERT_STALE_AFTER_MS;
  const longRunningAfterMs = input.longRunningAfterMs ?? DEFAULT_ALERT_LONG_RUNNING_AFTER_MS;
  const allTasks = input.broker.listTasks();
  const reports = allTasks.map((task) =>
    input.broker.getTaskDiagnostics(task.id, { staleAfterMs, longRunningAfterMs }),
  );

  return projectAlerts(reports, {
    staleWarningMs: input.staleWarningMs,
    staleCriticalMs: input.staleCriticalMs,
    longRunningWarningMs: input.longRunningWarningMs,
    longRunningCriticalMs: input.longRunningCriticalMs,
    workers: input.broker.listWorkers(),
    workerHeartbeatMissedAfterMs: input.workerHeartbeatMissedAfterMs,
    nowMs: input.nowMs,
    hotTableGrowth: input.hotTableGrowth,
  });
}

function assertRequesterCanSubscribeToWorkerAssignments(
  identity: RequesterIdentity | null,
  workerId: string,
): void {
  if (!identity?.id) {
    throw new BrokerError("unauthorized", "x-a2a-requester-id is required for this route");
  }
  if (identity.role === "hub" || identity.role === "operator" || identity.id === workerId) {
    return;
  }
  throw new BrokerError(
    "unauthorized",
    "worker assignment subscribe requires the assigned worker requester or a hub/operator role",
  );
}

// HTTP/SSE plumbing, error mapping, and streaming response helpers extracted to
// ./http/* (issue #645 phase 2). They take all state via explicit parameters and
// are imported at the top of this file.
