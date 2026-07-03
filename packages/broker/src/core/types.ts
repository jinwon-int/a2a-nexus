export type A2APartyKind = "session" | "node" | "user" | "service";
export type A2APartyRole =
  | "hub"
  | "live-trader"
  | "researcher"
  | "analyst"
  | "operator";

export type A2AExchangeIntent =
  | "chat"
  | "analyze"
  | "verify"
  | "backfill"
  | "propose_patch"
  | "propose_params"
  | "validate_change"
  | "apply_local_change"
  | "promote_to_live"
  | "rollback_live";

export type A2AExchangeStatus = "queued" | "running" | "completed" | "failed";
export type A2AExchangeMessageKind = "root" | "thread";
export type A2AExchangeDecision =
  | "accepted"
  | "partially_accepted"
  | "needs_clarification"
  | "declined";
export type ProposalKind = "patch" | "params" | "hybrid";
export type ProposalStatus =
  | "draft"
  | "submitted"
  | "validated"
  | "approved"
  | "rejected"
  | "applied"
  | "rolled_back";
export type ValidationKind = "backfill" | "paper" | "replay" | "review" | "smoke";
export type ValidationVerdict = "pass" | "fail" | "warn";
export type TaskKind = A2AExchangeIntent;
export type TaskStatus =
  | "blocked"
  | "queued"
  | "claimed"
  | "running"
  | "succeeded"
  | "failed"
  | "canceled";

/**
 * Broker closeout outcome classification (issue #471).
 *
 * Refines a terminal task status into evidence-aware categories for
 * operator summaries, read-model projections, and round-closeout
 * reconciliation. This classification is independent of task status:
 * a `succeeded` task may map to `pr_success` or `no_change_done`
 * depending on whether code/doc changes were produced; a `failed`
 * task may map to `no_change_block` or `infra_failure` depending on
 * whether the failure originated in infrastructure or a genuine
 * no-change analysis.
 *
 * Provider message-id/send success is accepted-send evidence only,
 * never read/visibility/terminal ACK.
 */

/**
 * Requester-visible status visibility contract (issue #921).
 *
 * Every task carries a `requester` identity (x-a2a-requester-id header or
 * session-level identity). The requester can see the task's status,
 * result, error, and evidence URLs. Restriction rules:
 *
 * | Requester role | Task visibility |
 * |---|---|
 * | hub / operator | All tasks in the broker (role-based access) |
 * | requester.id === task.requester.id | That specific task |
 * | requester.id === task.targetNodeId | Tasks assigned to that node |
 * | requester.id === task.assignedWorkerId | Tasks claimed by that worker |
 * | other | `unauthorized` BrokerError |
 *
 * The `x-a2a-requester-role` header further gates privileged operations:
 * - `hub`: subscribe to any task, access all statuses
 * - `operator`: touch any proposal artifact, subscribe to any task
 * - `analyst`/`researcher`/`live-trader`: restricted to their own tasks
 *
 * Missing or mismatched identity produces a typed BrokerError with
 * code `"unauthorized"` or `"bad_request"` and a human-readable reason
 * string. Callers SHOULD propagate these errors to the HTTP response or
 * call edge; they must NOT silently degrade security.
 *
 * Permission failures (assertion methods) and rate-limit denials share
 * the same error contract with distinct codes so upstream middleware can
 * distinguish policy blocks from resource pressure.
 */

// ---------------------------------------------------------------------------
// Rate limiting (requester-visible throttle state)
// ---------------------------------------------------------------------------
export type BrokerExitCondition =
  | "pr_success"       // Code/doc changes were made; PR created/merged.
  | "no_change_done"   // Task completed without code/doc changes; evidence-only Done.
  | "no_change_block"  // Task blocked without changes possible; evidence-only Block.
  | "infra_failure";   // Infrastructure/system failure, distinct from logical block.

/**
 * Broker-side objective lifecycle above individual A2A tasks. Goals are
 * bounded supervisory records: they summarize operator intent, child task
 * attachment, budget pressure, and terminal outcome without creating loops or
 * bypassing task approval/safety gates.
 */
export type GoalStatus =
  | "pursuing"
  | "paused"
  | "achieved"
  | "blocked"
  | "unmet"
  | "budget_limited"
  | "cleared";

export type GoalTransitionReason =
  | "operator_requested"
  | "child_task_progress"
  | "child_task_terminal"
  | "dependency_blocked"
  | "budget_exhausted"
  | "objective_satisfied"
  | "objective_not_met"
  | "retention_cleared";

export interface GoalBudgetPolicy {
  /** Maximum child task attempts the broker may attach before stopping as budget-limited. */
  maxChildAttempts?: number;
  /** Optional wall-clock deadline for pursuing work; ISO timestamp. */
  deadlineAt?: string;
  /** Optional operator-visible resource ceiling, e.g. tokens, cost units, or minutes. */
  maxResourceUnits?: number;
}

export interface GoalTaskAttachment {
  taskId: string;
  /** Optional role in the objective, e.g. implementation, review, smoke, or docs. */
  role?: string;
  attachedAt: string;
  detachedAt?: string;
}

export interface GoalStatusEvent {
  id: string;
  goalId: string;
  from?: GoalStatus;
  to: GoalStatus;
  reason: GoalTransitionReason;
  createdAt: string;
  actor?: A2APartyRef;
  taskId?: string;
  note?: string;
}

export interface GoalRecord {
  id: string;
  title: string;
  objective: string;
  requester: A2APartyRef;
  status: GoalStatus;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  budget?: GoalBudgetPolicy;
  taskAttachments: GoalTaskAttachment[];
  history: GoalStatusEvent[];
  outcome?: {
    summary: string;
    /** True only for non-budget failures. Budget exhaustion uses status=budget_limited. */
    failed: boolean;
    artifactIds?: string[];
  };
}
export type AuditAction =
  | "proposal.created"
  | "artifact.attached"
  | "validation.submitted"
  | "proposal.approved"
  | "proposal.rejected"
  | "proposal.applied"
  | "exchange.message.added"
  | "task.created"
  | "task.approved"
  | "task.approval_rejected"
  | "task.claimed"
  | "task.started"
  | "task.heartbeat"
  | "task.checkpointed"
  | "task.resumed"
  | "task.reassigned"
  | "task.requeued"
  | "task.succeeded"
  | "task.failed"
  | "task.canceled"
  | "task.updated"
  | "task.tombstoned"
  | "task.wake.planned"
  | "task.wake.scheduled"
  | "task.wake.skipped"
  | "task.wake.failed"
  | "worker.registered"
  | "worker.heartbeat"
  | "worker.identity_churn_detected"
  | "broker.cleanup.applied";
export type A2AWorkerEnvironment = "research" | "staging" | "live";
export type WorkerStatus = "online" | "stale";
export type WorkerPlaneStatus = "online" | "unknown";
export type ManagementPlaneStatus = "online" | "disconnected" | "unknown";

/**
 * Enriched worker health state that surfaces mobile-mode details when the
 * worker is declared as `mobile`. Consumers should check `workerMode` first;
 * ``persistent`` workers always report `"health_ok"` or `"stale"`.
 *
 * | Value | Meaning |
 * |---|---|
 * | `"health_ok"` | Heartbeat within mobile stale window (>0 && <= 30s) |
 * | `"stale"` | Heartbeat beyond mobile stale window but still registered (>30s && <= 90s) |
 * | `"disconnected"` | Heartbeat well beyond extended threshold (>90s) or worker unregistered |
 * | `"unsupported_capability"` | Worker registered but declared capabilities cannot fulfil the lane's task type |
 */
export type WorkerMobileHealth = "health_ok" | "stale" | "disconnected" | "unsupported_capability";
export type WorkerRuntimeFlavor =
  | "gateway"
  | "termux-hermes"
  | "broker-poll-http-handler"
  | "openclaw-poll-handler"
  | "unknown";

export type WorkerProviderRouteKind = "subscription" | "oauth" | "api-key" | "unknown";
export type WorkerProviderAvailability = "configured" | "canary_passed" | "entitlement_failed" | "disabled";

/**
 * Secret-safe model/provider entitlement hint for broker-local assignment.
 *
 * These fields identify a provider route without carrying tokens, OAuth paths,
 * raw subscription ids, cookies, or provider payloads. Public discovery surfaces
 * must omit the array; only team/private broker-local cards may opt in.
 */
export interface WorkerProviderCapability {
  providerId: string;
  modelFamily?: string;
  modelId?: string;
  routeKind: WorkerProviderRouteKind;
  availability: WorkerProviderAvailability;
  lastVerifiedAt?: string;
  evidenceId?: string;
}

/**
 * Declared operating mode of a worker node.
 * - `persistent`: always-on VPS / server (default if absent).
 * - `mobile`: battery-powered or sleep-capable device (Android/Termux, laptop).
 *   Mobile workers use shorter stale thresholds because brief offline
 *   windows are expected (Doze, network suspend, lid close).
 */
export type WorkerMode = "persistent" | "mobile";
/**
 * Where a task entered the broker. `unknown` is the backward-compatible default
 * for tasks created before this field existed or by callers that don't tag the
 * source. Downstream consumers use this to distinguish GitHub-driven
 * collaboration from API/sessions_send invocations.
 */
export type TaskOrigin = "github" | "api" | "sessions_send" | "operator" | "unknown";

export interface A2APartyRef {
  id: string;
  kind?: A2APartyKind;
  role?: A2APartyRole;
}

export interface A2AExchangeVia {
  transport?: string;
  channel?: string;
  nodeId?: string;
  sessionId?: string;
  traceId?: string;
}

export interface WorkspaceRef {
  nodeId: string;
  workspaceId: string;
  pathHint?: string;
  branch?: string;
  strategyId?: string;
}

export interface A2AExchangeRequest {
  requester: A2APartyRef;
  target: A2APartyRef;
  message: string;
  maxTurns?: number;
  intent?: A2AExchangeIntent;
  via?: A2AExchangeVia;
}

export interface A2AExchangeMessageRecord {
  id: string;
  exchangeId: string;
  kind: A2AExchangeMessageKind;
  message: string;
  requester?: A2APartyRef;
  actor?: A2APartyRef;
  via?: A2AExchangeVia;
  decision?: A2AExchangeDecision;
  targetNodeId?: string;
  assignedWorkerId?: string;
  parentMessageId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface A2AExchangeMessageRequest {
  actor: A2APartyRef;
  message: string;
  via?: A2AExchangeVia;
  decision?: A2AExchangeDecision;
  targetNodeId?: string;
  assignedWorkerId?: string;
  parentMessageId?: string;
}

export interface A2AExchangeState {
  id: string;
  requester: A2APartyRef;
  target: A2APartyRef;
  targetNodeId: string;
  assignedWorkerId?: string;
  message: string;
  maxTurns: number;
  intent: A2AExchangeIntent;
  status: A2AExchangeStatus;
  currentDecision?: A2AExchangeDecision;
  rootMessageId: string;
  latestMessageId: string;
  messageCount: number;
  lastMessageAt: string;
  activeTaskId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface A2ATaskRequest {
  id: string;
  exchangeId?: string;
  parentTaskId?: string;
  /**
   * A2A-style lineage references for follow-up/refinement tasks in the same
   * context. These are identifiers only; artifacts/results stay behind their
   * normal broker access controls and projections.
   */
  referenceTaskIds?: string[];
  intent: A2AExchangeIntent;
  requester: A2APartyRef;
  target: A2APartyRef;
  workspace?: WorkspaceRef;
  message?: string;
  proposalId?: string;
  artifactIds?: string[];
  assignedWorkerId?: string;
  via?: A2AExchangeVia;
  policyContext?: {
    requiresApproval?: boolean;
    liveImpact?: boolean;
    targetEnvironment?: A2AWorkerEnvironment;
  };
  createdAt: string;
}

export interface CreateTaskRequest extends Omit<A2ATaskRequest, "id" | "createdAt"> {
  id?: string;
  createdAt?: string;
  payload?: Record<string, unknown>;
  /** Canonical parent round identifier for A2A discussion/round child tasks. */
  parentRoundId?: string;
  /** Total expected child tasks/workers in the parent round. */
  parentRoundTotal?: number;
  /** 1-based order of this child task within the parent round. */
  parentRoundOrder?: number;
  taskOrigin?: TaskOrigin;
  /**
   * Local broker instance that accepts and owns lifecycle mutation authority
   * for this task row. Cross-broker parent/finalizer/operator ownership must
   * stay in payload metadata such as brokerOfRecordId, parentBrokerId,
   * crossBrokerHandoff, notificationOwnership, and terminalBrief.
   */
  brokerOfRecord?: string;
  /** Team/tenant boundary that owns lifecycle mutation authority for this task. */
  teamId?: string;
}

export interface TaskValidationPayload {
  nodeId?: string;
  kind: ValidationKind;
  verdict: ValidationVerdict;
  metrics?: Record<string, number | string | boolean>;
  artifactIds?: string[];
  note?: string;
}

export interface TaskApplyPayload {
  workspace?: WorkspaceRef;
  artifactIds?: string[];
  note?: string;
}

export interface TaskResult {
  summary?: string;
  note?: string;
  artifactIds?: string[];
  output?: Record<string, unknown>;
  /** Legacy single validation payload. Preserved for backward compatibility. */
  validation?: TaskValidationPayload;
  /** Optional multi-validation payload for tasks that require more than one evidence kind. */
  validations?: TaskValidationPayload[];
  apply?: TaskApplyPayload;
}

export interface TaskError {
  code?: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface TaskCancellationInfo {
  requestedAt: string;
  requestedBy: string;
  kind?: "operator_cancel" | "superseded";
  reason?: string;
  sourceTaskId?: string;
  supersededByTaskId?: string;
  supersededByPrUrl?: string;
  roundId?: string;
}

export interface TaskApprovalInfo {
  approvalId: string;
  approvedAt: string;
  approvedBy: string;
  actorRole?: A2APartyRole;
  requesterRole?: A2APartyRole;
  reason?: string;
}

export type TaskCheckpointState = "paused" | "awaiting_operator";

/** Interrupt decision types frozen by contracts/a2a/checkpoint-interrupt.md §2.2. */
export type TaskInterruptDecisionType =
  | "safety_gate"
  | "ambiguous_scope"
  | "approval_required"
  | "conflict_detected";

export interface TaskCheckpointInfo {
  state: TaskCheckpointState;
  checkpointId: string;
  /** Redacted, operator-safe description of what input is needed. */
  reason?: string;
  /**
   * Contract §2.2 decision type for `awaiting_operator` interrupts. Defaults
   * to `approval_required` when the worker does not specify one.
   */
  decisionType?: TaskInterruptDecisionType;
  /** Repo-relative, public-safe artifact references at the checkpoint (contract §1.3). */
  artifactRefs?: string[];
  recordedAt: string;
  recordedBy: string;
}

export type TaskApprovalOutcomeStatus = "approved" | "rejected" | "expired" | "canceled";

export interface TaskApprovalOutcomeInfo {
  status: TaskApprovalOutcomeStatus;
  approvalId: string;
  decidedAt: string;
  decidedBy: string;
  actorRole?: A2APartyRole;
  requesterRole?: A2APartyRole;
  reason?: string;
}

export interface TaskApprovalRequest {
  actor: A2APartyRef;
  reason?: string;
  approvalId?: string;
}

export interface TaskApprovalTerminalRequest extends TaskApprovalRequest {
  status?: Exclude<TaskApprovalOutcomeStatus, "approved">;
}

export type TaskWakeStatus = "planned" | "scheduled" | "skipped" | "failed";

export interface TaskWakeState {
  status: TaskWakeStatus;
  wakeKey: string;
  idempotencyKey: string;
  targetSessionKey: string;
  targetNodeId?: string;
  waitRunId?: string;
  correlationId?: string;
  parentRunId?: string;
  coalesced?: boolean;
  runtimeRunId?: string;
  code?: string;
  message?: string;
  plannedAt: string;
  updatedAt: string;
  decidedAt?: string;
  replayCount?: number;
}

export interface TaskWakePlanRequest {
  targetSessionKey: string;
  targetNodeId?: string;
  waitRunId?: string;
  correlationId?: string;
  parentRunId?: string;
  wakeKey?: string;
  idempotencyKey?: string;
  message?: string;
}

export interface TaskWakeDecisionRequest {
  status: Exclude<TaskWakeStatus, "planned">;
  coalesced?: boolean;
  runtimeRunId?: string;
  code?: string;
  message?: string;
}

export interface TaskWakePlanResult {
  task: TaskRecord;
  wake: TaskWakeState;
  shouldDispatch: boolean;
  replayed: boolean;
}

export interface TaskRecord extends A2ATaskRequest {
  intent: TaskKind;
  status: TaskStatus;
  targetNodeId: string;
  payload: Record<string, unknown>;
  /** Canonical parent round identifier for A2A discussion/round child tasks. */
  parentRoundId?: string;
  /** Total expected child tasks/workers in the parent round. */
  parentRoundTotal?: number;
  /** 1-based order of this child task within the parent round. */
  parentRoundOrder?: number;
  updatedAt: string;
  claimedAt?: string;
  completedAt?: string;
  claimedBy?: string;
  result?: TaskResult;
  error?: TaskError;
  /**
   * Recent worker-visible failure history used by scheduler diagnostics to
   * detect identical unresolved errors before the normal retry budget is spent.
   * Values must be operator-safe/redacted; raw secrets must never be stored here.
   */
  errorHistory?: TaskError[];
  cancellation?: TaskCancellationInfo;
  /** Operator/hub approval that released an approval-gated task for worker claim. */
  approval?: TaskApprovalInfo;
  /**
   * Active checkpoint per contracts/a2a/checkpoint-interrupt.md. Transitory
   * and non-terminal: `awaiting_operator` projects as the A2A 1.0
   * `input-required` state until requester input (a SendMessage into the
   * same context) or an explicit resume clears it.
   */
  checkpoint?: TaskCheckpointInfo;
  /** Terminal approval decision, including negative outcomes that keep live-impact work stopped. */
  approvalOutcome?: TaskApprovalOutcomeInfo;
  /**
   * Count of times this task has been requeued from claimed/running back to queued by the
   * stale-task reaper or the manual requeue endpoint. Capped by the broker's
   * `maxRequeueAttempts` policy so a flapping worker cannot thrash the queue indefinitely.
   * Reset to 0 when an operator reassigns the task (fresh attempt budget).
   */
  requeueCount?: number;
  /**
   * Last time a worker explicitly heartbeat this task, confirming active progress.
   * Updated by `heartbeatTask()`. Enables per-task staleness detection independent
   * of the worker-level `lastSeenAt`.
   */
  lastHeartbeatAt?: string;
  /**
   * Broker-generated UUID assigned when a task transitions from queued to claimed.
   * Reset on requeue/reassign. Each attempt represents a discrete execution window.
   */
  attemptId?: string;
  /** Durable Wake-on-Task decision state for accepted-task replay/idempotency. */
  wake?: TaskWakeState;
  /**
   * Where this task originated. `"github"` is set by the GitHub ingestion
   * service when projecting `/a2a assign` commands; non-GitHub callers default
   * to `"unknown"` unless they pass an explicit value through the create
   * request. Optional/additive for backward compatibility.
   */
  taskOrigin?: TaskOrigin;
  /** Broker instance that owns claim/start/complete/fail authority. Optional for legacy tasks. */
  brokerOfRecord?: string;
  /** Team/tenant boundary that owns claim/start/complete/fail authority. Optional for legacy tasks. */
  teamId?: string;
  /**
   * Evidence submitted by the worker after the task was canceled.
   * Present only when a worker posts completion/fail evidence after
   * the broker already transitioned the task to canceled. Enables
   * diagnostics to distinguish plain canceled from canceled with
   * late worker outcome (issue #954).
   */
  lateEvidenceAfterCancel?: {
    /** Whether the worker posted "complete" or "fail" evidence. */
    kind: "complete" | "fail";
    /** Worker-submitted result, present when kind="complete". */
    result?: TaskResult;
    /** Worker-submitted error, present when kind="fail". */
    error?: TaskError;
    /** When the late evidence was received. */
    submittedAt: string;
    /** Which worker submitted the late evidence. */
    submittedBy: string;
  };
}

export interface TaskClaimRequest {
  workerId: string;
}

export interface TaskStartRequest extends TaskClaimRequest {}

export interface TaskCompleteRequest extends TaskClaimRequest {
  result?: TaskResult;
}

/**
 * Hermes/native worker terminal evidence outcome.
 *
 * Canonical outcomes for worker-submitted evidence (POST /tasks/:id/evidence):
 * - "done" / "pr": task succeeds (calls completeTask)
 * - "blocked" / "failed": task fails (calls failTask)
 *
 * Hermes workers submit redacted source-only evidence only — no credentials,
 * provider message-ids, terminal ACK payloads, or session text. Provider-accepted
 * / message-id send success is NOT terminal ACK/read/visibility evidence.
 *
 * @see TaskEvidenceRequest
 * @see docs/hermes-native-worker-contract.md
 */
export type TaskEvidenceOutcome = "done" | "pr" | "blocked" | "failed";

/**
 * Worker-submitted terminal evidence request.
 *
 * This is the canonical endpoint for Hermes/native workers to post completion
 * or failure evidence without inheriting Docker Runner or OpenClaw Gateway
 * assumptions.
 *
 * Evidence categories (must be kept separate):
 * 1. Provider-accepted / message-id evidence — send-surface accepted the
 *    payload. This is NOT terminal ACK evidence.
 * 2. Terminal ACK / read / visibility evidence — proof of recipient receipt.
 *    Generated by the broker terminal-brief lifecycle, NOT by workers.
 *
 * Hermes/native worker evidence is always source-only and redacted:
 * - `result.summary`: human-readable outcome note
 * - `result.output`: safe structured metadata (no secrets, tokens, or ids)
 * - `error`: structured error with code and message (no stack traces)
 *
 * @see docs/hermes-native-worker-contract.md
 */
export interface TaskEvidenceRequest extends TaskClaimRequest {
  /**
   * Worker-facing terminal evidence outcome. "done" and "pr" succeed the task;
   * "blocked" and "failed" fail it with redacted error evidence.
   */
  outcome?: TaskEvidenceOutcome;
  result?: TaskResult;
  error?: TaskError;
}

export interface TaskFailRequest extends TaskClaimRequest {
  error?: TaskError;
}

export interface TaskCancelRequest {
  actor: A2APartyRef;
  reason?: string;
  supersededByTaskId?: string;
  supersededByPrUrl?: string;
  roundId?: string;
}

export interface TaskReassignRequest {
  actor: A2APartyRef;
  targetNodeId?: string;
  assignedWorkerId?: string;
  note?: string;
}

export interface TaskListFilters {
  exchangeId?: string;
  status?: TaskStatus;
  targetNodeId?: string;
  proposalId?: string;
  intent?: TaskKind;
  claimedBy?: string;
  assignedWorkerId?: string;
  taskOrigin?: TaskOrigin;
  /** Include SQLite active rows that are absent from the live broker mutation map. Diagnostic only. */
  includeStaleReadPath?: boolean;
  /** Maximum number of newest matching tasks to return. */
  limit?: number;
}

export interface ChangeProposal {
  id: string;
  source: A2APartyRef;
  target: A2APartyRef;
  sourceNodeId: string;
  targetNodeId: string;
  kind: ProposalKind;
  summary: string;
  rationale?: string;
  workspace: WorkspaceRef;
  patchText?: string;
  parameterPayload?: Record<string, unknown>;
  artifactIds: string[];
  status: ProposalStatus;
  createdAt: string;
  updatedAt: string;
}

export interface ArtifactRecord {
  id: string;
  proposalId: string;
  kind: string;
  uri: string;
  contentType?: string;
  sizeBytes?: number;
  summary?: string;
  createdAt: string;
}

export interface ValidationResult {
  id: string;
  proposalId: string;
  nodeId: string;
  kind: ValidationKind;
  verdict: ValidationVerdict;
  metrics: Record<string, number | string | boolean>;
  artifactIds: string[];
  note?: string;
  createdAt: string;
}

export interface AuditEvent {
  id: string;
  actorId: string;
  action: AuditAction;
  targetType: "proposal" | "artifact" | "validation" | "worker" | "task" | "exchange" | "exchange-message" | "broker";
  targetId: string;
  proposalId?: string;
  note?: string;
  createdAt: string;
}

export interface WorkerCapabilities {
  canAnalyze: boolean;
  canBackfill: boolean;
  canPatchWorkspace: boolean;
  canPromoteLive: boolean;
  workspaceIds: string[];
  environments: A2AWorkerEnvironment[];
  providerCapabilities?: WorkerProviderCapability[];
  /**
   * Runtime flavor reported by native/external workers; absent keeps legacy
   * gateway semantics. Canonical Hermes value: "termux-hermes"; canonical
   * broker poll/HTTP handler value: "broker-poll-http-handler". Legacy
   * OpenClaw poll-only deployments may still report "openclaw-poll-handler"
   * during the compatibility window.
   * @see docs/hermes-native-worker-contract.md
   */
  runtimeFlavor?: WorkerRuntimeFlavor;
  /**
   * False for Hermes/Termux native workers that do not require a full OpenClaw
   * Gateway on-device. Absent implies legacy Gateway assumption.
   * @see docs/hermes-native-worker-contract.md
   */
  gatewayRequired?: boolean;
}

export interface WorkerRecord {
  nodeId: string;
  role: A2APartyRole;
  displayName?: string;
  brokerUrl?: string;
  capabilities: WorkerCapabilities;
  /** Declared operating mode. Defaults to "persistent" when absent. */
  workerMode?: WorkerMode;
  metadata?: Record<string, string>;
  /** Management-plane reachability. Defaults to "unknown" when never reported. */
  managementPlane?: ManagementPlaneStatus;
  createdAt: string;
  updatedAt: string;
  lastSeenAt: string;
}

export interface RegisterWorkerRequest {
  nodeId: string;
  role: A2APartyRole;
  displayName?: string;
  brokerUrl?: string;
  capabilities: WorkerCapabilities;
  workerMode?: WorkerMode;
  metadata?: Record<string, string>;
  /** Management-plane reachability. When absent defaults to "unknown". */
  managementPlane?: ManagementPlaneStatus;
}

export interface WorkerHeartbeatRequest {
  displayName?: string;
  brokerUrl?: string;
  capabilities?: WorkerCapabilities;
  workerMode?: WorkerMode;
  metadata?: Record<string, string>;
  /**
   * Management-plane reachability reported by the worker.
   * When absent the broker defaults to "unknown".
   */
  managementPlane?: ManagementPlaneStatus;
}

export interface WorkerListFilters {
  role?: A2APartyRole;
  environment?: A2AWorkerEnvironment;
  workspaceId?: string;
  providerId?: string;
  modelFamily?: string;
  modelId?: string;
  providerAvailability?: WorkerProviderAvailability;
}

export interface WorkerView extends WorkerRecord {
  status: WorkerStatus;
  /** Worker-plane (heartbeat/poll/task-execution) availability. */
  workerPlane: WorkerPlaneStatus;
  /** Management-plane (SSH/node-host/admin) reachability. */
  managementPlane: ManagementPlaneStatus;
  /**
   * True only when workerPlane is "online" and managementPlane is not
   * "disconnected". Operators may override this decision externally.
   */
  updateEligible: boolean;
}

export interface WorkerRegistrationResponse extends WorkerView {
  /** Durable broker identity that accepted the registration. */
  brokerId: string;
}

export interface CreateProposalRequest {
  source: A2APartyRef;
  target: A2APartyRef;
  kind: ProposalKind;
  summary: string;
  rationale?: string;
  workspace: WorkspaceRef;
  patchText?: string;
  parameterPayload?: Record<string, unknown>;
  artifactIds?: string[];
}

export interface AttachArtifactRequest {
  kind: string;
  uri: string;
  contentType?: string;
  sizeBytes?: number;
  summary?: string;
}

export interface SubmitValidationRequest {
  nodeId: string;
  kind: ValidationKind;
  verdict: ValidationVerdict;
  metrics?: Record<string, number | string | boolean>;
  artifactIds?: string[];
  note?: string;
}

export interface ProposalActorRequest {
  actor: A2APartyRef;
  note?: string;
}

export interface ApplyProposalRequest extends ProposalActorRequest {
  workspace: WorkspaceRef;
}

export interface ProposalDetails {
  proposal: ChangeProposal;
  artifacts: ArtifactRecord[];
  validations: ValidationResult[];
  audit: AuditEvent[];
}

export interface ProposalListFilters {
  status?: ProposalStatus;
  sourceNodeId?: string;
  targetNodeId?: string;
  kind?: ProposalKind;
}

export interface AuditListFilters {
  proposalId?: string;
  actorId?: string;
  action?: AuditAction;
  targetId?: string;
}

/** Diagnostic status for a delegated run, computed from lifecycle data. */
export type TaskDiagnosticStatus =
  | "active"      // claimed or running with recent heartbeat
  | "stale"       // claimed or running but no recent heartbeat / exceeded expected duration
  | "long_running" // running beyond a configurable threshold
  | "terminal";    // succeeded, failed, or canceled

/** Stable broker-owned classification for downstream reconciliation / interruption handling. */
export type TaskBrokerState = "healthy" | "reconcile_needed" | "interrupted" | "terminal";

/** Distinguishable interruption / reconciliation causes projected from durable broker state. */
export type TaskInterruptionKind =
  | "stale_lease"
  | "stale_worker"
  | "requeued"
  | "operator_canceled"
  | "superseded"
  | "late_completion_after_cancel"  // worker posted completion/fail after cancel
  | "timeout"
  | "worker_lost"
  | "dead_lettered"
  | "failed";

export interface TaskInterruptionDiagnostic {
  kind: TaskInterruptionKind;
  /** Where this signal came from so plugin/operator lanes do not need to infer it. */
  source: "task_state" | "worker_state" | "audit" | "tombstone";
  summary: string;
  detectedAt?: string;
  actorId?: string;
  reason?: string;
}

/** Reason a tombstone was written. */
export type TombstoneReason =
  | "failed"              // task completed with error
  | "canceled"            // operator/requester canceled
  | "canceled_with_late_completion"  // operator canceled, worker posted evidence later
  | "timeout"             // exceeded maximum allowed run time
  | "dead_lettered"       // requeue limit exhausted
  | "worker_lost";        // assigned worker went offline

/** Preserved terminal context for post-mortem inspection. */
export interface TaskTombstone {
  taskId: string;
  terminalStatus: TaskStatus;
  tombstoneReason: TombstoneReason;
  /** Wall-clock duration from creation to termination, in milliseconds. */
  durationMs: number;
  requeueCount: number;
  error?: TaskError;
  result?: TaskResult;
  tombstonedAt: string;
  /** Arbitrary context the broker attaches at tombstone time. */
  metadata?: Record<string, unknown>;
}

/** Stable diagnostic report for downstream consumers (adapter, UI). */
export interface TaskDiagnosticReport {
  taskId: string;
  diagnosticStatus: TaskDiagnosticStatus;
  /** Higher-level broker-owned state for downstream lanes. */
  brokerState: TaskBrokerState;
  /** Whether downstream consumers should reconcile this task from broker state. */
  reconcileNeeded: boolean;
  /** Distinguishable interruption/reconciliation signal when one exists. */
  interruption?: TaskInterruptionDiagnostic;
  /** Current task snapshot (read-only copy). */
  task: TaskRecord;
  /** How long the task has been in its current status, in milliseconds. */
  currentStatusDurationMs: number;
  /** Time since last task heartbeat, in milliseconds. Undefined if never heartbeaten. */
  stalenessMs?: number;
  /** Broker-owned hints that plugin/operator consumers may rely on directly. */
  brokerHints: {
    staleLease: boolean;
    staleWorker: boolean;
    cancellationRequested: boolean;
    requeued: boolean;
    lastRequeueAt?: string;
    lastRequeueReason?: string;
    workerLastSeenAt?: string;
    tombstoneReason?: TombstoneReason;
    supersededByTaskId?: string;
    supersededByPrUrl?: string;
    supersededRoundId?: string;
    /** Present when a worker posted outcome evidence after the task was already canceled. */
    lateEvidenceAfterCancel?: {
      kind: "complete" | "fail";
      submittedAt: string;
      submittedBy: string;
    };
  };
  /** For terminal tasks: the tombstone, if one was written. */
  tombstone?: TaskTombstone;
  /** Lifecycle summary: key timestamps. */
  lifecycle: {
    createdAt: string;
    claimedAt?: string;
    startedAt?: string;
    lastHeartbeatAt?: string;
    completedAt?: string;
    tombstonedAt?: string;
  };
}

/** Filters for querying tombstones. */
export interface TombstoneListFilters {
  taskId?: string;
  tombstoneReason?: TombstoneReason;
  terminalStatus?: TaskStatus;
  since?: string;
}

/** Dashboard: aggregated summary of broker state for operator visibility. */
export interface BrokerDashboard {
  /** When this summary was computed. */
  generatedAt: string;
  /** Task queue overview. */
  queue: TaskQueueSummary;
  /** Recent task execution history (last N completed/failed). */
  history: TaskHistorySummary;
  /** Proposal pipeline state. */
  proposals: ProposalPipelineSummary;
  /** Worker fleet status. */
  workers: WorkerFleetSummary;
  /** Operator-facing observability summary for queue pressure and recovery cases. */
  observability: BrokerObservabilitySummary;
}

export interface BrokerObservabilitySummary {
  queuePressure: {
    blocked: number;
    queued: number;
    claimed: number;
    running: number;
    staleWorkerAssignments: number;
    oldestClaimed?: Pick<TaskRecord, 'id' | 'intent' | 'targetNodeId' | 'assignedWorkerId' | 'createdAt'> & {
      statusSinceAt: string;
      statusAgeSec: number;
    };
    oldestRunning?: Pick<TaskRecord, 'id' | 'intent' | 'targetNodeId' | 'assignedWorkerId' | 'createdAt'> & {
      statusSinceAt: string;
      statusAgeSec: number;
    };
  };
  recovery: {
    totalRequeued: number;
    totalDeadLettered: number;
    recentRequeues: Array<{
      taskId: string;
      actorId: string;
      createdAt: string;
      note?: string;
    }>;
    recentDeadLetters: Array<Pick<TaskRecord, 'id' | 'intent' | 'targetNodeId' | 'assignedWorkerId' | 'completedAt' | 'error' | 'requeueCount'>>;
  };
  workerHealth: {
    staleWorkersWithActiveTasks: Array<{
      nodeId: string;
      activeTaskCount: number;
      lastSeenAt: string;
      lastSeenAgeSec: number;
    }>;
  };
}

export interface TaskQueueSummary {
  total: number;
  byStatus: Record<TaskStatus, number>;
  byIntent: Record<string, number>;
  /** Tasks waiting longest in their current blocked/queued/claimed state. */
  oldestPending: Array<Pick<TaskRecord, 'id' | 'intent' | 'status' | 'targetNodeId' | 'assignedWorkerId' | 'createdAt'> & {
    statusSinceAt: string;
    statusAgeSec: number;
  }>;
}

export interface TaskHistorySummary {
  /** Number of tasks completed in the last hour. */
  completedLastHour: number;
  /** Number of tasks failed in the last hour. */
  failedLastHour: number;
  /** Total completed (all time). */
  totalCompleted: number;
  /** Total failed (all time). */
  totalFailed: number;
  /** Most recent N task outcomes (succeeded/failed), newest first. */
  recent: Array<Pick<TaskRecord, 'id' | 'intent' | 'status' | 'targetNodeId' | 'completedAt' | 'result' | 'error'>>;
}

export interface ProposalPipelineSummary {
  total: number;
  byStatus: Record<ProposalStatus, number>;
  /** Proposals awaiting validation or approval action. */
  pendingAction: Array<Pick<ChangeProposal, 'id' | 'kind' | 'summary' | 'status' | 'sourceNodeId' | 'targetNodeId' | 'updatedAt'>>;
}

export interface WorkerFleetSummary {
  total: number;
  online: number;
  stale: number;
  /** Per-worker status snapshot. */
  byNode: Array<{
    nodeId: string;
    role: string;
    displayName: string | undefined;
    status: 'online' | 'stale';
    activeTaskCount: number;
    lastSeenAt: string;
    lastSeenAgeSec: number;
    /** Declared operating mode; absent defaults to "persistent". */
    workerMode?: WorkerMode;
    /**
     * Enriched health for mobile workers. Present when `workerMode === "mobile"`
     * and the broker has enough registry data to classify the state.
     * Persistent workers omit this field to keep payloads compact.
     */
    mobileHealth?: WorkerMobileHealth;
  }>;
}

export interface WorkerIdentityWarning {
  code: "worker_identity_churn";
  severity: "warning";
  message: string;
  windowMs: number;
  changesInWindow: number;
  lastDetectedAt: string;
  lastChangedFields: string[];
}

export interface WorkerCapacitySummaryItem {
  nodeId: string;
  role: string;
  displayName: string | undefined;
  status: WorkerStatus;
  lastSeenAt: string;
  lastSeenAgeSec: number;
  counts: {
    queued: number;
    claimed: number;
    running: number;
    stale: number;
    active: number;
  };
  latestTaskUpdatedAt?: string;
  /** Declared operating mode; absent defaults to "persistent". */
  workerMode?: WorkerMode;
  /** Runtime flavor declared in capabilities for dispatch/ops visibility. */
  runtimeFlavor?: WorkerRuntimeFlavor;
  /** False when this worker does not require Gateway/plugin internals to execute tasks. */
  gatewayRequired?: boolean;
  /**
   * Enriched health for mobile workers. Present when `workerMode === "mobile"`
   * and the broker has enough registry data to classify the state.
   * Persistent workers omit this field to keep payloads compact.
   */
  mobileHealth?: WorkerMobileHealth;
  /** Warning surfaced when a nodeId appears to be shared by conflicting runtimes. */
  identityWarning?: WorkerIdentityWarning;
}

export interface WorkerCapacitySummary {
  generatedAt: string;
  workerOfflineAfterMs: number;
  taskStaleAfterMs: number;
  totals: {
    workers: number;
    online: number;
    staleWorkers: number;
    queued: number;
    claimed: number;
    running: number;
    staleTasks: number;
    active: number;
  };
  items: WorkerCapacitySummaryItem[];
}

// ---------------------------------------------------------------------------
// Cleanup candidate types (issue #520)
// ---------------------------------------------------------------------------

/** Cleanup candidate class for brokered DB hygiene discovery. */
export type CleanupCandidateClass =
  | "stale_worker"
  | "malformed_task"
  | "queued_residue"
  | "terminal_outbox_backlog"
  | "historical_terminal_task"
  | "orphaned_claim";

/** Risk classification for cleanup candidates. */
export type CleanupRiskClass = "safe" | "caution" | "high_risk";

/** Operator actionability classification for cleanup candidates. */
export type CleanupCandidateActionability =
  | "advisory"
  | "blocked"
  | "executable"
  | "cursor_skipped"
  | "retention_not_due";

/**
 * Single cleanup candidate discovered from broker state.
 *
 * Each candidate has a stable id for idempotent tracking across dry-run
 * iterations. The `reason` field explains why this record qualifies as a
 * candidate, and `risk` reflects the safety classification.
 */
export interface CleanupCandidate {
  /** Stable id for idempotent tracking across dry-run iterations. */
  id: string;
  /** Candidate class. */
  class: CleanupCandidateClass;
  /** Human-readable reason for qualification. */
  reason: string;
  /** Risk classification. */
  risk: CleanupRiskClass;
  /** Whether the candidate is actionable, advisory, blocked, or retained by policy. */
  actionability: CleanupCandidateActionability;
  /** Human-readable explanation of the actionability classification. */
  actionabilityReason: string;
  /** Associated entity identifier (taskId, worker nodeId, etc.). */
  entityId: string;
  /** When the entity last changed state. */
  updatedAt: string;
  /** Age in milliseconds since last update. */
  ageMs: number;
  /** Additional metadata (task status, worker role, outbox ack status, etc.). */
  metadata?: Record<string, unknown>;
}

/**
 * Read-only cleanup dry-run plan.
 *
 * Aggregates discovered candidates with summary counts and explicit
 * risk notes. This plan never mutates broker state; execution requires
 * a separate operator approval gate.
 */
export interface CleanupDryRunPlan {
  /** Generation timestamp. */
  generatedAt: string;
  /** Summary counts by candidate class. */
  summary: Record<CleanupCandidateClass, number>;
  /** Summary counts by operator actionability class. */
  actionabilitySummary: Record<CleanupCandidateActionability, number>;
  /** Total candidates across all classes. */
  totalCandidates: number;
  /** Discovered candidates ordered by risk (high_risk first). */
  candidates: CleanupCandidate[];
  /** Risk notes for the operator (e.g. backup requirements). */
  riskNotes: string[];
}

// ---------------------------------------------------------------------------
// Delegated-run types (re-exported from ./delegated-runtime.ts)
// ---------------------------------------------------------------------------

export type {
  DelegatedRunState,
  DelegatedRun,
  DelegatedRunOptions,
  DelegatedRunHandle,
  BrokerTaskBridge,
} from "./delegated-runtime.js";
