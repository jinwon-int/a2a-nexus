/**
 * Typed HTTP client for the A2A Nexus broker API.
 *
 * This started life as `packages/openclaw-plugin-a2a/standalone-broker-client.ts`
 * and was the only harness-independent thing in that package: it imports `zod`
 * and nothing else, and speaks the broker's own HTTP surface. It moved here when
 * the OpenClaw plugin package was retired, so the broker's typed client lives
 * with the broker instead of inside one harness adapter.
 *
 * It is consumed by test/conformance/check-three-component-e2e.mjs as the
 * requester in the broker + client + worker end-to-end path.
 */
import { z } from "zod";

const DEFAULT_USER_AGENT = "a2a-nexus-broker-client/0.1";

const UnknownRecordSchema = z.record(z.string(), z.unknown());
const A2ABrokerPartyKindSchema = z.enum(["session", "node", "user", "service"]);
const A2ABrokerPartyRoleSchema = z.enum([
  "hub",
  "live-trader",
  "researcher",
  "analyst",
  "operator",
]);
const A2ABrokerTaskIntentSchema = z.enum([
  "chat",
  "analyze",
  "backfill",
  "propose_patch",
  "propose_params",
  "validate_change",
  "apply_local_change",
  "promote_to_live",
  "rollback_live",
]);
const A2ABrokerTaskStatusSchema = z.enum([
  "blocked",
  "queued",
  "claimed",
  "running",
  "succeeded",
  "failed",
  "canceled",
]);
const A2ABrokerTaskOriginSchema = z.enum(["github", "api", "sessions_send", "operator", "unknown"]);
const A2ABrokerTaskLaneReasonCodeSchema = z.enum([
  "all_fast_conditions_met",
  "requester_lane_facts_present",
  "intent_not_analyze",
  "mode_missing",
  "mode_not_read_only_analysis",
  "write_or_implementation_marker_present",
  "worker_assignment_conflict",
  "round_marker_present",
  "fanout_marker_present",
  "multi_worker_marker_present",
  "delegated_workflow_marker_present",
  "worker_mode_missing",
  "worker_not_persistent",
  "policy_decision_missing",
  "policy_decision_unknown",
  "policy_requires_approval",
  "policy_denied",
  "approval_marker_present",
  "sensitive_marker_present",
  "live_marker_present",
  "external_send_marker_present",
  "credential_access_marker_present",
]);
const A2ABrokerTaskLaneAssignmentSchema = z
  .object({
    version: z.literal("fast-lane.v1"),
    mode: z.literal("shadow"),
    decision: z.enum(["fast", "full"]),
    reasonCodes: z.array(A2ABrokerTaskLaneReasonCodeSchema).min(1),
  })
  .strict();

const A2ABrokerPartyRefSchema = z
  .object({
    id: z.string().min(1),
    kind: A2ABrokerPartyKindSchema.optional(),
    role: A2ABrokerPartyRoleSchema.optional(),
    displayName: z.string().min(1).optional(),
  })
  .strict();

const A2ABrokerViaSchema = z
  .object({
    transport: z.string().min(1).optional(),
    channel: z.string().min(1).optional(),
    nodeId: z.string().min(1).optional(),
    sessionId: z.string().min(1).optional(),
    traceId: z.string().min(1).optional(),
  })
  .strict();

const A2ABrokerWorkspaceRefSchema = z
  .object({
    nodeId: z.string().min(1),
    workspaceId: z.string().min(1),
    pathHint: z.string().min(1).optional(),
    branch: z.string().min(1).optional(),
    strategyId: z.string().min(1).optional(),
  })
  .strict();

const A2ABrokerTaskPolicyContextSchema = z
  .object({
    requiresApproval: z.boolean().optional(),
    liveImpact: z.boolean().optional(),
    targetEnvironment: z.enum(["research", "staging", "live"]).optional(),
  })
  .strict();

const A2ABrokerTaskValidationPayloadSchema = z
  .object({
    nodeId: z.string().min(1).optional(),
    kind: z.enum(["backfill", "paper", "replay", "smoke"]),
    verdict: z.enum(["pass", "fail", "warn"]),
    metrics: UnknownRecordSchema.optional(),
    artifactIds: z.array(z.string().min(1)).optional(),
    note: z.string().min(1).optional(),
  })
  .strict();

const A2ABrokerTaskApplyPayloadSchema = z
  .object({
    workspace: A2ABrokerWorkspaceRefSchema.optional(),
    artifactIds: z.array(z.string().min(1)).optional(),
    note: z.string().min(1).optional(),
  })
  .strict();

const A2ABrokerTaskResultSchema = z
  .object({
    summary: z.string().min(1).optional(),
    note: z.string().min(1).optional(),
    artifactIds: z.array(z.string().min(1)).optional(),
    output: UnknownRecordSchema.optional(),
    validation: A2ABrokerTaskValidationPayloadSchema.optional(),
    apply: A2ABrokerTaskApplyPayloadSchema.optional(),
  })
  .strict();

const A2ABrokerTaskErrorSchema = z
  .object({
    code: z.string().min(1).optional(),
    message: z.string().min(1),
    details: UnknownRecordSchema.optional(),
  })
  .strict();

const A2ABrokerTaskCancelRequestSchema = z
  .object({
    actor: A2ABrokerPartyRefSchema,
    reason: z.string().min(1).optional(),
  })
  .strict();

const A2ABrokerTaskCancellationInfoSchema = z
  .object({
    requestedAt: z.string().min(1),
    requestedBy: z.string().min(1),
    reason: z.string().min(1).optional(),
    sourceTaskId: z.string().min(1).optional(),
  })
  .strict();

const A2ABrokerTaskApprovalInfoSchema = z
  .object({
    approvalId: z.string().min(1),
    approvedAt: z.string().min(1),
    approvedBy: z.string().min(1),
    actorRole: A2ABrokerPartyRoleSchema.optional(),
    requesterRole: A2ABrokerPartyRoleSchema.optional(),
    reason: z.string().min(1).optional(),
  })
  .strict();

const A2ABrokerTaskApprovalOutcomeSchema = z
  .object({
    status: z.enum(["approved", "rejected", "expired", "canceled"]),
    approvalId: z.string().min(1),
    decidedAt: z.string().min(1),
    decidedBy: z.string().min(1),
    actorRole: A2ABrokerPartyRoleSchema.optional(),
    requesterRole: A2ABrokerPartyRoleSchema.optional(),
    reason: z.string().min(1).optional(),
  })
  .strict();

const A2ABrokerTaskApprovalRequestSchema = z
  .object({
    actor: A2ABrokerPartyRefSchema,
    reason: z.string().min(1).optional(),
    approvalId: z.string().min(1).optional(),
  })
  .strict();

const A2ABrokerTaskApprovalTerminalRequestSchema = A2ABrokerTaskApprovalRequestSchema.extend({
  status: z.enum(["rejected", "expired", "canceled"]).optional(),
}).strict();

const A2ABrokerTaskWorkerRequestSchema = z
  .object({
    workerId: z.string().min(1),
  })
  .strict();

const A2ABrokerTaskCompleteRequestSchema = A2ABrokerTaskWorkerRequestSchema.extend({
  result: A2ABrokerTaskResultSchema.optional(),
}).strict();

const A2ABrokerTaskFailRequestSchema = A2ABrokerTaskWorkerRequestSchema.extend({
  error: A2ABrokerTaskErrorSchema.optional(),
  // #1815 item 5: the result the worker was holding when a review verdict
  // failed — preserved by the broker as negativeVerdictEvidence.
  negativeVerdictEvidence: A2ABrokerTaskResultSchema.optional(),
}).strict();

const A2ABrokerTaskCreateRequestSchema = z
  .object({
    id: z.string().min(1).optional(),
    exchangeId: z.string().min(1).optional(),
    intent: A2ABrokerTaskIntentSchema,
    requester: A2ABrokerPartyRefSchema,
    target: A2ABrokerPartyRefSchema,
    workspace: A2ABrokerWorkspaceRefSchema.optional(),
    message: z.string().min(1).optional(),
    proposalId: z.string().min(1).optional(),
    artifactIds: z.array(z.string().min(1)).optional(),
    assignedWorkerId: z.string().min(1).optional(),
    via: A2ABrokerViaSchema.optional(),
    policyContext: A2ABrokerTaskPolicyContextSchema.optional(),
    payload: UnknownRecordSchema.optional(),
    taskOrigin: A2ABrokerTaskOriginSchema.optional(),
    brokerOfRecord: z.string().min(1).optional(),
    teamId: z.string().min(1).optional(),
  })
  .strict();

const A2ABrokerTaskRecordSchema = A2ABrokerTaskCreateRequestSchema.extend({
  id: z.string().min(1),
  status: A2ABrokerTaskStatusSchema,
  targetNodeId: z.string().min(1),
  payload: UnknownRecordSchema,
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  attemptId: z.string().min(1).optional(),
  claimedAt: z.string().min(1).optional(),
  completedAt: z.string().min(1).optional(),
  claimedBy: z.string().min(1).optional(),
  result: A2ABrokerTaskResultSchema.optional(),
  error: A2ABrokerTaskErrorSchema.optional(),
  cancellation: A2ABrokerTaskCancellationInfoSchema.optional(),
  approval: A2ABrokerTaskApprovalInfoSchema.optional(),
  approvalOutcome: A2ABrokerTaskApprovalOutcomeSchema.optional(),
  laneAssignment: A2ABrokerTaskLaneAssignmentSchema.optional(),
});

const A2ABrokerHealthSchema = z
  .object({
    ok: z.boolean(),
    service: z.string().min(1),
    publicBaseUrl: z.string().min(1),
  })
  .passthrough();

/**
 * Broker-advertised A2A protocol profile extracted from the health endpoint.
 *
 * This models the protocol-level capabilities the broker advertises:
 * protocolVersion, streaming/push support, input/output modes, and
 * unsupported REST/gRPC/push transport hints.
 *
 * Terminal Brief / outbox ACK boundaries are separate from A2A push
 * notification conformance. Provider accepted/message-id evidence is
 * send-acceptance telemetry only and not operator-visible ACK.
 */
export const A2ABrokerProtocolProfileSchema = z
  .object({
    protocolVersion: z.string().min(1).optional(),
    capabilities: z
      .object({
        streaming: z.boolean().optional(),
        pushNotifications: z.boolean().optional(),
      })
      .passthrough()
      .optional(),
    inputModes: z.array(z.string().min(1)).optional(),
    outputModes: z.array(z.string().min(1)).optional(),
    transportHints: z
      .object({
        rest: z.union([z.literal("supported"), z.literal("unsupported"), z.literal("deferred")]).optional(),
        grpc: z.union([z.literal("supported"), z.literal("unsupported"), z.literal("deferred")]).optional(),
        push: z.union([z.literal("supported"), z.literal("unsupported"), z.literal("deferred")]).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export type A2ABrokerProtocolProfile = z.infer<typeof A2ABrokerProtocolProfileSchema>;

const A2ABrokerTaskSseEventNameSchema = z.enum(["task-snapshot", "task-status-update"]);
const A2ABrokerOperatorSseEventNameSchema = z.enum([
  "operator-snapshot",
  "operator-summary-update",
  "operator-alert-opened",
  "operator-alert-resolved",
]);

const A2A_BROKER_LEGACY_TASK_STATES = [
  "submitted",
  "working",
  "input-required",
  "auth-required",
  "completed",
  "failed",
  "canceled",
  "rejected",
] as const;

/**
 * Wire encoding the broker emits depends on A2A-Version negotiation: spec
 * (negotiated) surfaces carry v1.0 ProtoJSON SCREAMING_SNAKE states, legacy
 * (header-less) surfaces carry the historical lowercase states. The client
 * accepts both and normalizes to the legacy lowercase form so downstream
 * consumers see exactly one vocabulary during the encoding migration
 * (#1912 D1). The enum is exhaustive on purpose — an unknown wire state
 * fails parsing loudly instead of degrading to a silent mismatch.
 */
const A2A_BROKER_SPEC_TO_LEGACY_TASK_STATE: Record<string, (typeof A2A_BROKER_LEGACY_TASK_STATES)[number]> = {
  TASK_STATE_SUBMITTED: "submitted",
  TASK_STATE_WORKING: "working",
  TASK_STATE_INPUT_REQUIRED: "input-required",
  TASK_STATE_AUTH_REQUIRED: "auth-required",
  TASK_STATE_COMPLETED: "completed",
  TASK_STATE_FAILED: "failed",
  TASK_STATE_CANCELED: "canceled",
  TASK_STATE_REJECTED: "rejected",
};

const A2ABrokerTaskProjectionStateSchema = z
  .enum([
    ...A2A_BROKER_LEGACY_TASK_STATES,
    "TASK_STATE_SUBMITTED",
    "TASK_STATE_WORKING",
    "TASK_STATE_INPUT_REQUIRED",
    "TASK_STATE_AUTH_REQUIRED",
    "TASK_STATE_COMPLETED",
    "TASK_STATE_FAILED",
    "TASK_STATE_CANCELED",
    "TASK_STATE_REJECTED",
  ])
  .transform(
    (state): (typeof A2A_BROKER_LEGACY_TASK_STATES)[number] =>
      A2A_BROKER_SPEC_TO_LEGACY_TASK_STATE[state] ?? (state as (typeof A2A_BROKER_LEGACY_TASK_STATES)[number]),
  );

const A2ABrokerTaskProjectionSchema = z
  .object({
    id: z.string().min(1),
    kind: z.literal("task"),
    status: z
      .object({
        state: A2ABrokerTaskProjectionStateSchema,
        timestamp: z.string().min(1),
        message: z
          .object({
            role: z.literal("agent"),
            parts: z.array(z.object({ text: z.string() })),
          })
          .optional(),
      })
      .strict(),
    metadata: z.record(z.string(), z.unknown()),
    artifacts: z.array(z.object({ id: z.string().min(1) })),
  })
  .strict();

const A2ABrokerTaskSseSnapshotReasonSchema = z.literal("snapshot");
const A2ABrokerTaskSseStatusUpdateReasonSchema = z.enum([
  "created",
  "approved",
  "claimed",
  "started",
  "succeeded",
  "failed",
  "canceled",
  "reassigned",
  "requeued",
  "dead_lettered",
]);

const A2ABrokerTaskSseSnapshotSchema = z
  .object({
    task: A2ABrokerTaskProjectionSchema,
    reason: A2ABrokerTaskSseSnapshotReasonSchema,
    final: z.boolean(),
  })
  .strict();

const A2ABrokerTaskSseStatusUpdateSchema = z
  .object({
    task: A2ABrokerTaskProjectionSchema,
    reason: A2ABrokerTaskSseStatusUpdateReasonSchema,
    final: z.boolean(),
  })
  .strict();

const A2ABrokerOperatorSsePayloadSchema = UnknownRecordSchema;

const OpenClawA2ABrokerTaskBridgeRequestSchema = z
  .object({
    taskId: z.string().min(1).optional(),
    waitRunId: z.string().min(1).optional(),
    correlationId: z.string().min(1).optional(),
    parentRunId: z.string().min(1).optional(),
    requesterNodeId: z.string().min(1).optional(),
    requesterSessionKey: z.string().min(1).optional(),
    requesterDisplayKey: z.string().min(1).optional(),
    requesterChannel: z.string().min(1).optional(),
    targetNodeId: z.string().min(1).optional(),
    targetSessionKey: z.string().min(1),
    targetDisplayKey: z.string().min(1),
    targetChannel: z.string().min(1).optional(),
    originalMessage: z.string().min(1),
    taskInput: UnknownRecordSchema.optional(),
    expectedOutput: z
      .object({
        format: z.enum(["text", "json"]),
        schemaName: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    roundOneReply: z.string().min(1).optional(),
    announceTimeoutMs: z.number().int().nonnegative(),
    maxPingPongTurns: z.number().int().nonnegative(),
    cancelTarget: z
      .object({
        kind: z.literal("session_run"),
        sessionKey: z.string().min(1),
        runId: z.string().min(1).optional(),
      })
      .optional(),
  })
  .strict();

export type A2ABrokerPartyKind = z.infer<typeof A2ABrokerPartyKindSchema>;
export type A2ABrokerPartyRole = z.infer<typeof A2ABrokerPartyRoleSchema>;
export type A2ABrokerTaskIntent = z.infer<typeof A2ABrokerTaskIntentSchema>;
export type A2ABrokerTaskStatus = z.infer<typeof A2ABrokerTaskStatusSchema>;
export type A2ABrokerPartyRef = z.infer<typeof A2ABrokerPartyRefSchema>;
export type A2ABrokerTaskCancelRequest = z.infer<typeof A2ABrokerTaskCancelRequestSchema>;
export type A2ABrokerTaskApprovalRequest = z.infer<typeof A2ABrokerTaskApprovalRequestSchema>;
export type A2ABrokerTaskApprovalTerminalRequest = z.infer<
  typeof A2ABrokerTaskApprovalTerminalRequestSchema
>;
export type A2ABrokerTaskCreateRequest = z.infer<typeof A2ABrokerTaskCreateRequestSchema>;
export type A2ABrokerTaskLaneAssignment = z.infer<typeof A2ABrokerTaskLaneAssignmentSchema>;
export type A2ABrokerTaskRecord = z.infer<typeof A2ABrokerTaskRecordSchema>;
export type A2ABrokerHealth = z.infer<typeof A2ABrokerHealthSchema>;
export type A2ABrokerTaskSseEventName = z.infer<typeof A2ABrokerTaskSseEventNameSchema>;
export type A2ABrokerOperatorSseEventName = z.infer<typeof A2ABrokerOperatorSseEventNameSchema>;
export type A2ABrokerTaskProjection = z.infer<typeof A2ABrokerTaskProjectionSchema>;
export type A2ABrokerTaskSseSnapshot = z.infer<typeof A2ABrokerTaskSseSnapshotSchema>;
export type A2ABrokerTaskSseStatusUpdate = z.infer<typeof A2ABrokerTaskSseStatusUpdateSchema>;
export type A2ABrokerTaskSseEvent =
  | { name: "task-snapshot"; id?: string; data: A2ABrokerTaskSseSnapshot }
  | { name: "task-status-update"; id?: string; data: A2ABrokerTaskSseStatusUpdate };
export type A2ABrokerOperatorSsePayload = z.infer<typeof A2ABrokerOperatorSsePayloadSchema>;
export type A2ABrokerOperatorSseEvent =
  | { name: "operator-snapshot"; id?: string; data: A2ABrokerOperatorSsePayload }
  | { name: "operator-summary-update"; id?: string; data: A2ABrokerOperatorSsePayload }
  | { name: "operator-alert-opened"; id?: string; data: A2ABrokerOperatorSsePayload }
  | { name: "operator-alert-resolved"; id?: string; data: A2ABrokerOperatorSsePayload };
export type OpenClawA2ABrokerTaskBridgeRequest = z.infer<
  typeof OpenClawA2ABrokerTaskBridgeRequestSchema
>;

const A2ATerminalOutboxPayloadSchema = z.object({
  taskId: z.string().min(1),
  status: z.string().min(1),
  worker: z.string().min(1).optional(),
  repo: z.string().min(1).optional(),
  issue: z.number().optional(),
  prUrl: z.string().min(1).optional(),
  doneUrl: z.string().min(1).optional(),
  blockUrl: z.string().min(1).optional(),
  testSummary: z.string().min(1).optional(),
  createdAt: z.string().min(1).optional(),
  updatedAt: z.string().min(1).optional(),
  completedAt: z.string().min(1).optional(),
}).passthrough();

const A2ATerminalOutboxEventSchema = z.object({
  id: z.string().min(1),
  kind: z.literal("task.terminal"),
  taskEventId: z.number(),
  payload: A2ATerminalOutboxPayloadSchema,
  createdAt: z.string().min(1),
  ack: UnknownRecordSchema.optional(),
  deliveredAt: z.string().min(1).optional(),
  attempts: z.number().int().nonnegative(),
}).passthrough();

const A2ATerminalOutboxListResponseSchema = z.object({
  kind: z.literal("task.terminal.outbox"),
  count: z.number().int().nonnegative(),
  cursor: z.string().nullable(),
  reconciledUnacked: z.number().int().nonnegative().optional(),
  events: z.array(A2ATerminalOutboxEventSchema),
}).passthrough();

const A2ATerminalOutboxAckResponseSchema = z.object({
  event: A2ATerminalOutboxEventSchema,
}).passthrough();

export type A2ATerminalOutboxEvent = z.infer<typeof A2ATerminalOutboxEventSchema>;
export type A2ATerminalOutboxListResponse = z.infer<typeof A2ATerminalOutboxListResponseSchema>;
export type A2ATerminalOutboxAckEvidence = "operator_visible" | "operator_confirmed" | "provider_delivery_receipt";
export type A2ATerminalOutboxReceiptStatus =
  | "accepted"
  | "started"
  | "produced"
  | "provider_sent"
  | "provider_accepted"
  | "timed_out"
  | "stale"
  | "failed";

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type A2ABrokerClientOptions = {
  baseUrl: string;
  edgeSecret?: string;
  requester?: A2ABrokerPartyRef;
  fetchImpl?: FetchLike;
  userAgent?: string;
  /**
   * A2A-Version negotiation for version-aware surfaces (per-task SSE stream).
   * Defaults to "1.0" — the client advertises the version it understands and
   * accepts both the v1.0 ProtoJSON (TASK_STATE_*) and legacy (lowercase)
   * state encodings on the wire, normalizing to the legacy lowercase form
   * for downstream consumers (#1912 D1). Set to null to opt out and receive
   * the historical legacy envelopes.
   */
  a2aVersion?: string | null;
};

export class A2ABrokerClientError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "A2ABrokerClientError";
  }
}

export class A2ABrokerMalformedResponseError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly bodyText: string,
  ) {
    super(message);
    this.name = "A2ABrokerMalformedResponseError";
  }
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeUnknownRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const normalized = value
    .map((item) => (typeof item === "string" && item.trim() ? item.trim() : undefined))
    .filter((item): item is string => Boolean(item));
  return normalized.length > 0 ? normalized : undefined;
}

function readCaseContext(taskInput: Record<string, unknown> | undefined): {
  exchangeId?: string;
  proposalId?: string;
  artifactIds?: string[];
  evidenceRefs?: string[];
  policyContext?: {
    requiresApproval?: boolean;
    liveImpact?: boolean;
    targetEnvironment?: "research" | "staging" | "live";
  };
} {
  if (!taskInput) {
    return {};
  }
  const nestedCaseContext = normalizeUnknownRecord(taskInput.caseContext);
  const nestedMetadata = normalizeUnknownRecord(taskInput.metadata);
  const source = nestedCaseContext ?? nestedMetadata ?? taskInput;
  const exchangeId =
    normalizeOptionalString(source.exchangeId as string | undefined) ??
    normalizeOptionalString(source.contextId as string | undefined);
  const proposalId = normalizeOptionalString(source.proposalId as string | undefined);
  const artifactIds = normalizeStringArray(source.artifactIds);
  const evidenceRefs = normalizeStringArray(source.evidenceRefs);
  const policyContextSource =
    normalizeUnknownRecord(source.policyContext) ?? normalizeUnknownRecord(taskInput.policyContext);
  const targetEnvironment = normalizeOptionalString(
    policyContextSource?.targetEnvironment as string | undefined,
  ) as "research" | "staging" | "live" | undefined;
  const requiresApproval =
    typeof policyContextSource?.requiresApproval === "boolean"
      ? policyContextSource.requiresApproval
      : typeof source.requiresApproval === "boolean"
        ? source.requiresApproval
        : undefined;
  const liveImpact =
    typeof policyContextSource?.liveImpact === "boolean"
      ? policyContextSource.liveImpact
      : typeof source.liveImpact === "boolean"
        ? source.liveImpact
        : undefined;
  const policyContext =
    requiresApproval !== undefined || liveImpact !== undefined || targetEnvironment !== undefined
      ? {
          ...(requiresApproval !== undefined ? { requiresApproval } : {}),
          ...(liveImpact !== undefined ? { liveImpact } : {}),
          ...(targetEnvironment !== undefined ? { targetEnvironment } : {}),
        }
      : undefined;

  return {
    ...(exchangeId ? { exchangeId } : {}),
    ...(proposalId ? { proposalId } : {}),
    ...(artifactIds ? { artifactIds } : {}),
    ...(evidenceRefs ? { evidenceRefs } : {}),
    ...(policyContext ? { policyContext } : {}),
  };
}

function normalizeRequiredTaskId(taskId: string): string {
  const normalizedTaskId = taskId.trim();
  if (!normalizedTaskId) {
    throw new Error("taskId is required");
  }
  return normalizedTaskId;
}

function buildEndpointUrl(baseUrl: string, path: string): string {
  return new URL(path.replace(/^\//, ""), `${baseUrl}/`).toString();
}

async function readBrokerText(response: Response): Promise<string | undefined> {
  const text = await response.text();
  if (!text) {
    return undefined;
  }
  return text;
}

async function readBrokerJson(response: Response): Promise<unknown> {
  const text = await readBrokerText(response);
  if (!text) {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new A2ABrokerMalformedResponseError(
      `Broker returned malformed JSON (${response.status})`,
      response.status,
      text,
    );
  }
}

function buildClientError(response: Response, body: unknown): A2ABrokerClientError {
  if (body && typeof body === "object" && "error" in body) {
    const bodyRecord = body as Record<string, unknown>;
    const error = bodyRecord.error;
    if (error && typeof error === "object") {
      const errorRecord = error as Record<string, unknown>;
      const code =
        typeof errorRecord.code === "string" && errorRecord.code.trim()
          ? errorRecord.code.trim()
          : undefined;
      const message =
        typeof errorRecord.message === "string" && errorRecord.message.trim()
          ? errorRecord.message.trim()
          : `Broker request failed with ${response.status}`;
      return new A2ABrokerClientError(message, response.status, code, body);
    }
  }
  if (typeof body === "string" && body.trim()) {
    return new A2ABrokerClientError(body.trim(), response.status, undefined, body);
  }
  return new A2ABrokerClientError(
    `Broker request failed with ${response.status}`,
    response.status,
    undefined,
    body,
  );
}

async function parseBrokerJson<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
  const body = await readBrokerJson(response);
  if (!response.ok) {
    throw buildClientError(response, body);
  }
  return schema.parse(body);
}

function buildRequestHeaders(params: {
  requester?: A2ABrokerPartyRef;
  edgeSecret?: string;
  userAgent: string;
  contentType?: string;
  a2aVersion?: string;
}): Headers {
  const headers = new Headers({
    accept: "application/json",
    "user-agent": params.userAgent,
  });
  if (params.a2aVersion) {
    headers.set("a2a-version", params.a2aVersion);
  }
  if (params.contentType) {
    headers.set("content-type", params.contentType);
  }
  if (params.edgeSecret) {
    headers.set("x-a2a-edge-secret", params.edgeSecret);
  }
  if (params.requester) {
    headers.set("x-a2a-requester-id", params.requester.id);
    if (params.requester.kind) {
      headers.set("x-a2a-requester-kind", params.requester.kind);
    }
    if (params.requester.role) {
      headers.set("x-a2a-requester-role", params.requester.role);
    }
  }
  return headers;
}

export function normalizeA2ABrokerBaseUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("A2A broker baseUrl is required");
  }
  const url = new URL(trimmed);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("A2A broker baseUrl must use http or https");
  }
  const pathname = url.pathname.replace(/\/+$/, "");
  url.pathname = pathname || "/";
  const href = url.toString();
  return href.endsWith("/") ? href.slice(0, -1) : href;
}

export function buildBrokerCreateTaskRequestFromOpenClaw(
  input: OpenClawA2ABrokerTaskBridgeRequest,
): A2ABrokerTaskCreateRequest {
  const request = OpenClawA2ABrokerTaskBridgeRequestSchema.parse(input);
  const requesterNodeId = normalizeOptionalString(request.requesterNodeId);
  const requesterSessionKey = normalizeOptionalString(request.requesterSessionKey);
  const requesterDisplayKey = normalizeOptionalString(request.requesterDisplayKey);
  const requesterChannel = normalizeOptionalString(request.requesterChannel);
  const targetNodeId = normalizeOptionalString(request.targetNodeId);
  const targetChannel = normalizeOptionalString(request.targetChannel);
  const correlationId = normalizeOptionalString(request.correlationId);
  const parentRunId = normalizeOptionalString(request.parentRunId);
  const taskInput = normalizeUnknownRecord(request.taskInput);
  const expectedOutput = request.expectedOutput
    ? {
        format: request.expectedOutput.format,
        ...(normalizeOptionalString(request.expectedOutput.schemaName)
          ? { schemaName: normalizeOptionalString(request.expectedOutput.schemaName) }
          : {}),
      }
    : undefined;
  const caseContext = readCaseContext(taskInput);
  // `requesterId` and `via.transport` are sent to the broker and land in stored
  // task evidence. Both defaulted to "openclaw" because this file used to ship
  // inside the OpenClaw plugin. It is now the broker's own generic client, so
  // the label was simply wrong — a task submitted by this client did not come
  // from OpenClaw. Safe to correct: both fields are free-form
  // `z.string().min(1).optional()` in the client schema and in
  // core/store-schemas.ts, with no enum and no branch on the value anywhere in
  // the broker. Existing records keep whatever they were written with.
  const requesterId = requesterNodeId ?? requesterSessionKey ?? "a2a-nexus-client";
  const targetId = targetNodeId ?? request.targetSessionKey;
  const taskId =
    normalizeOptionalString(request.taskId) ?? normalizeOptionalString(request.waitRunId);

  return {
    ...(taskId ? { id: taskId } : {}),
    ...(caseContext.exchangeId ? { exchangeId: caseContext.exchangeId } : {}),
    intent: "chat",
    requester: {
      id: requesterId,
      kind: requesterNodeId ? "node" : requesterSessionKey ? "session" : "service",
      role: "hub",
    },
    target: {
      id: targetId,
      kind: targetNodeId ? "node" : "session",
    },
    ...(caseContext.proposalId ? { proposalId: caseContext.proposalId } : {}),
    ...(caseContext.artifactIds ? { artifactIds: caseContext.artifactIds } : {}),
    ...(targetNodeId ? { assignedWorkerId: targetNodeId } : {}),
    ...(caseContext.policyContext ? { policyContext: caseContext.policyContext } : {}),
    message: request.originalMessage,
    via: {
      transport: "a2a-nexus-client",
      ...(requesterChannel ? { channel: requesterChannel } : {}),
      ...(requesterSessionKey ? { sessionId: requesterSessionKey } : {}),
      ...((correlationId ?? request.waitRunId)
        ? { traceId: correlationId ?? request.waitRunId }
        : {}),
    },
    payload: {
      ...(taskId ? { taskId } : {}),
      targetSessionKey: request.targetSessionKey,
      targetDisplayKey: request.targetDisplayKey,
      ...(targetChannel ? { targetChannel } : {}),
      announceTimeoutMs: request.announceTimeoutMs,
      maxPingPongTurns: request.maxPingPongTurns,
      ...(requesterSessionKey ? { requesterSessionKey } : {}),
      ...(requesterDisplayKey ? { requesterDisplayKey } : {}),
      ...(requesterChannel ? { requesterChannel } : {}),
      ...(taskInput ? { taskInput } : {}),
      ...(expectedOutput ? { expectedOutput } : {}),
      ...(caseContext.evidenceRefs ? { evidenceRefs: caseContext.evidenceRefs } : {}),
      ...(request.roundOneReply ? { roundOneReply: request.roundOneReply } : {}),
      ...(request.waitRunId ? { waitRunId: request.waitRunId } : {}),
      ...(correlationId ? { correlationId } : {}),
      ...(parentRunId ? { parentRunId } : {}),
      ...(request.cancelTarget ? { cancelTarget: request.cancelTarget } : {}),
    },
  };
}

type SseFrame = {
  id?: string;
  event?: string;
  data: string;
};

export type A2ABrokerSseChunk = string | Uint8Array;

export type A2ABrokerStreamTaskEventsOptions = {
  signal?: AbortSignal;
};

export type A2ABrokerStreamOperatorEventsOptions = {
  signal?: AbortSignal;
  lastEventId?: string;
};

/**
 * Parses an async iterable of SSE chunks (text or bytes) into framed events.
 * Strict to the broker's SSE format: id/event/data fields and frame boundaries.
 */
export async function* parseA2ABrokerTaskSseFrames(
  source: AsyncIterable<A2ABrokerSseChunk> | Iterable<A2ABrokerSseChunk>,
): AsyncIterable<SseFrame> {
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  const stripFrameBoundaryNewlines = (value: string): string => {
    let start = 0;
    let end = value.length;
    while (start < end) {
      const code = value.charCodeAt(start);
      if (code !== 10 && code !== 13) break;
      start += 1;
    }
    while (end > start) {
      const code = value.charCodeAt(end - 1);
      if (code !== 10 && code !== 13) break;
      end -= 1;
    }
    return start === 0 && end === value.length ? value : value.slice(start, end);
  };
  const flush = (raw: string): SseFrame | undefined => {
    const trimmed = stripFrameBoundaryNewlines(raw);
    if (!trimmed) {
      return undefined;
    }
    const frame: SseFrame = { data: "" };
    const dataParts: string[] = [];
    for (const line of trimmed.split(/\r?\n/)) {
      if (!line || line.startsWith(":")) {
        continue;
      }
      const colonIdx = line.indexOf(":");
      const field = colonIdx === -1 ? line : line.slice(0, colonIdx);
      const rawValue = colonIdx === -1 ? "" : line.slice(colonIdx + 1);
      const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;
      switch (field) {
        case "id":
          frame.id = value;
          break;
        case "event":
          frame.event = value;
          break;
        case "data":
          dataParts.push(value);
          break;
        default:
          break;
      }
    }
    if (dataParts.length === 0) {
      return undefined;
    }
    frame.data = dataParts.join("\n");
    return frame;
  };

  for await (const chunk of source as AsyncIterable<A2ABrokerSseChunk>) {
    buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    let boundary = buffer.search(/\r?\n\r?\n/);
    while (boundary !== -1) {
      const raw = buffer.slice(0, boundary);
      const matched = buffer.slice(boundary).match(/^\r?\n\r?\n/);
      const advance = boundary + (matched ? matched[0].length : 2);
      buffer = buffer.slice(advance);
      const frame = flush(raw);
      if (frame) {
        yield frame;
      }
      boundary = buffer.search(/\r?\n\r?\n/);
    }
  }

  buffer += decoder.decode();
  const tail = flush(buffer);
  if (tail) {
    yield tail;
  }
}

function decodeBrokerTaskSseFrame(frame: SseFrame): A2ABrokerTaskSseEvent | undefined {
  if (!frame.event) {
    return undefined;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(frame.data) as unknown;
  } catch {
    throw new A2ABrokerMalformedResponseError(
      `Broker SSE frame contained malformed JSON for event ${frame.event}`,
      200,
      frame.data,
    );
  }
  switch (frame.event) {
    case "task-snapshot":
      return {
        name: "task-snapshot",
        ...(frame.id ? { id: frame.id } : {}),
        data: A2ABrokerTaskSseSnapshotSchema.parse(payload),
      };
    case "task-status-update":
      return {
        name: "task-status-update",
        ...(frame.id ? { id: frame.id } : {}),
        data: A2ABrokerTaskSseStatusUpdateSchema.parse(payload),
      };
    default:
      return undefined;
  }
}

function decodeBrokerOperatorSseFrame(frame: SseFrame): A2ABrokerOperatorSseEvent | undefined {
  if (!frame.event) {
    return undefined;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(frame.data) as unknown;
  } catch {
    throw new A2ABrokerMalformedResponseError(
      `Broker SSE frame contained malformed JSON for event ${frame.event}`,
      200,
      frame.data,
    );
  }
  switch (frame.event) {
    case "operator-snapshot":
    case "operator-summary-update":
    case "operator-alert-opened":
    case "operator-alert-resolved":
      return {
        name: frame.event,
        ...(frame.id ? { id: frame.id } : {}),
        data: A2ABrokerOperatorSsePayloadSchema.parse(payload),
      };
    default:
      return undefined;
  }
}

function isWebReadableStream(
  body: ReadableStream<Uint8Array> | NodeJS.ReadableStream,
): body is ReadableStream<Uint8Array> {
  return "getReader" in body && typeof body.getReader === "function";
}

function isAsyncIterableNodeStream(
  body: NodeJS.ReadableStream,
): body is NodeJS.ReadableStream & AsyncIterable<A2ABrokerSseChunk> {
  return Symbol.asyncIterator in body && typeof body[Symbol.asyncIterator] === "function";
}

function destroyNodeReadableStream(body: NodeJS.ReadableStream) {
  if ("destroy" in body && typeof body.destroy === "function") {
    body.destroy();
  }
}

async function* readBodyAsChunks(
  body: ReadableStream<Uint8Array> | NodeJS.ReadableStream,
  signal?: AbortSignal,
): AsyncIterable<A2ABrokerSseChunk> {
  if (isWebReadableStream(body)) {
    const reader = body.getReader();
    const onAbort = () => {
      reader.cancel().catch(() => {});
    };
    if (signal) {
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
      }
    }
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }
        if (value) {
          yield value;
        }
      }
    } finally {
      signal?.removeEventListener("abort", onAbort);
      try {
        reader.releaseLock();
      } catch {}
    }
    return;
  }

  if (!isAsyncIterableNodeStream(body)) {
    throw new Error("Broker SSE response body is not async iterable");
  }

  const nodeStream = body;
  const onAbort = () => {
    destroyNodeReadableStream(nodeStream);
  };
  if (signal) {
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  }
  try {
    for await (const chunk of nodeStream) {
      yield chunk;
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

export function createA2ABrokerClient(options: A2ABrokerClientOptions) {
  const baseUrl = normalizeA2ABrokerBaseUrl(options.baseUrl);
  const fetchImpl = options.fetchImpl ?? fetch;
  const edgeSecret = normalizeOptionalString(options.edgeSecret);
  const userAgent = normalizeOptionalString(options.userAgent) ?? DEFAULT_USER_AGENT;
  const a2aVersion = options.a2aVersion === null
    ? undefined
    : normalizeOptionalString(options.a2aVersion ?? undefined) ?? "1.0";

  return {
    async health(): Promise<A2ABrokerHealth> {
      const response = await fetchImpl(buildEndpointUrl(baseUrl, "health"), {
        method: "GET",
        headers: buildRequestHeaders({
          userAgent,
        }),
      });
      return await parseBrokerJson(response, A2ABrokerHealthSchema);
    },

    async createTask(
      request: A2ABrokerTaskCreateRequest,
      overrides?: { requester?: A2ABrokerPartyRef },
    ): Promise<A2ABrokerTaskRecord> {
      const parsedRequest = A2ABrokerTaskCreateRequestSchema.parse(request);
      const requester = overrides?.requester ?? parsedRequest.requester ?? options.requester;
      const response = await fetchImpl(buildEndpointUrl(baseUrl, "tasks"), {
        method: "POST",
        headers: buildRequestHeaders({
          requester,
          edgeSecret,
          userAgent,
          contentType: "application/json",
        }),
        body: JSON.stringify(parsedRequest),
      });
      return await parseBrokerJson(response, A2ABrokerTaskRecordSchema);
    },

    async getTask(taskId: string): Promise<A2ABrokerTaskRecord> {
      const normalizedTaskId = normalizeRequiredTaskId(taskId);
      const response = await fetchImpl(
        buildEndpointUrl(baseUrl, `tasks/${encodeURIComponent(normalizedTaskId)}`),
        {
          method: "GET",
          headers: buildRequestHeaders({
            requester: options.requester,
            edgeSecret,
            userAgent,
          }),
        },
      );
      return await parseBrokerJson(response, A2ABrokerTaskRecordSchema);
    },

    async claimTask(taskId: string, request?: { workerId?: string }): Promise<A2ABrokerTaskRecord> {
      const normalizedTaskId = normalizeRequiredTaskId(taskId);
      const workerId = normalizeOptionalString(request?.workerId) ?? options.requester?.id;
      if (!workerId) {
        throw new Error("workerId or configured requester.id is required to claim a broker task");
      }
      const parsedRequest = A2ABrokerTaskWorkerRequestSchema.parse({ workerId });
      const response = await fetchImpl(
        buildEndpointUrl(baseUrl, `tasks/${encodeURIComponent(normalizedTaskId)}/claim`),
        {
          method: "POST",
          headers: buildRequestHeaders({
            requester: options.requester,
            edgeSecret,
            userAgent,
            contentType: "application/json",
          }),
          body: JSON.stringify(parsedRequest),
        },
      );
      return await parseBrokerJson(response, A2ABrokerTaskRecordSchema);
    },

    async startTask(taskId: string, request?: { workerId?: string }): Promise<A2ABrokerTaskRecord> {
      const normalizedTaskId = normalizeRequiredTaskId(taskId);
      const workerId = normalizeOptionalString(request?.workerId) ?? options.requester?.id;
      if (!workerId) {
        throw new Error("workerId or configured requester.id is required to start a broker task");
      }
      const parsedRequest = A2ABrokerTaskWorkerRequestSchema.parse({ workerId });
      const response = await fetchImpl(
        buildEndpointUrl(baseUrl, `tasks/${encodeURIComponent(normalizedTaskId)}/start`),
        {
          method: "POST",
          headers: buildRequestHeaders({
            requester: options.requester,
            edgeSecret,
            userAgent,
            contentType: "application/json",
          }),
          body: JSON.stringify(parsedRequest),
        },
      );
      return await parseBrokerJson(response, A2ABrokerTaskRecordSchema);
    },

    async completeTask(
      taskId: string,
      request?: { workerId?: string; result?: unknown },
    ): Promise<A2ABrokerTaskRecord> {
      const normalizedTaskId = normalizeRequiredTaskId(taskId);
      const workerId = normalizeOptionalString(request?.workerId) ?? options.requester?.id;
      if (!workerId) {
        throw new Error(
          "workerId or configured requester.id is required to complete a broker task",
        );
      }
      const parsedRequest = A2ABrokerTaskCompleteRequestSchema.parse({
        workerId,
        ...(request?.result ? { result: request.result } : {}),
      });
      const response = await fetchImpl(
        buildEndpointUrl(baseUrl, `tasks/${encodeURIComponent(normalizedTaskId)}/complete`),
        {
          method: "POST",
          headers: buildRequestHeaders({
            requester: options.requester,
            edgeSecret,
            userAgent,
            contentType: "application/json",
          }),
          body: JSON.stringify(parsedRequest),
        },
      );
      return await parseBrokerJson(response, A2ABrokerTaskRecordSchema);
    },

    async failTask(
      taskId: string,
      request?: { workerId?: string; error?: unknown },
    ): Promise<A2ABrokerTaskRecord> {
      const normalizedTaskId = normalizeRequiredTaskId(taskId);
      const workerId = normalizeOptionalString(request?.workerId) ?? options.requester?.id;
      if (!workerId) {
        throw new Error("workerId or configured requester.id is required to fail a broker task");
      }
      const parsedRequest = A2ABrokerTaskFailRequestSchema.parse({
        workerId,
        ...(request?.error ? { error: request.error } : {}),
      });
      const response = await fetchImpl(
        buildEndpointUrl(baseUrl, `tasks/${encodeURIComponent(normalizedTaskId)}/fail`),
        {
          method: "POST",
          headers: buildRequestHeaders({
            requester: options.requester,
            edgeSecret,
            userAgent,
            contentType: "application/json",
          }),
          body: JSON.stringify(parsedRequest),
        },
      );
      return await parseBrokerJson(response, A2ABrokerTaskRecordSchema);
    },

    async *streamTaskEvents(
      taskId: string,
      streamOptions?: A2ABrokerStreamTaskEventsOptions,
    ): AsyncGenerator<A2ABrokerTaskSseEvent, void, void> {
      const normalizedTaskId = normalizeRequiredTaskId(taskId);
      const headers = buildRequestHeaders({
        requester: options.requester,
        edgeSecret,
        userAgent,
        a2aVersion,
      });
      headers.set("accept", "text/event-stream");
      const init: RequestInit = {
        method: "GET",
        headers,
      };
      if (streamOptions?.signal) {
        init.signal = streamOptions.signal;
      }
      const response = await fetchImpl(
        buildEndpointUrl(baseUrl, `a2a/tasks/${encodeURIComponent(normalizedTaskId)}/events`),
        init,
      );
      if (!response.ok) {
        const body = await readBrokerJson(response).catch(() => undefined);
        throw buildClientError(response, body);
      }
      if (!response.body) {
        throw new A2ABrokerClientError(
          "Broker SSE response missing body",
          response.status,
          "broker_sse_missing_body",
        );
      }
      const chunks = readBodyAsChunks(response.body, streamOptions?.signal);
      for await (const frame of parseA2ABrokerTaskSseFrames(chunks)) {
        const event = decodeBrokerTaskSseFrame(frame);
        if (!event) {
          continue;
        }
        yield event;
        if (event.data.final) {
          return;
        }
      }
    },

    async *streamOperatorEvents(
      streamOptions?: A2ABrokerStreamOperatorEventsOptions,
    ): AsyncGenerator<A2ABrokerOperatorSseEvent, void, void> {
      const headers = buildRequestHeaders({
        requester: options.requester,
        edgeSecret,
        userAgent,
      });
      headers.set("accept", "text/event-stream");
      const lastEventId = normalizeOptionalString(streamOptions?.lastEventId);
      if (lastEventId) {
        headers.set("last-event-id", lastEventId);
      }
      const init: RequestInit = {
        method: "GET",
        headers,
      };
      if (streamOptions?.signal) {
        init.signal = streamOptions.signal;
      }
      const response = await fetchImpl(buildEndpointUrl(baseUrl, "a2a/operator/events"), init);
      if (!response.ok) {
        const body = await readBrokerJson(response).catch(() => undefined);
        throw buildClientError(response, body);
      }
      if (!response.body) {
        throw new A2ABrokerClientError(
          "Broker SSE response missing body",
          response.status,
          "broker_sse_missing_body",
        );
      }
      const chunks = readBodyAsChunks(response.body, streamOptions?.signal);
      for await (const frame of parseA2ABrokerTaskSseFrames(chunks)) {
        const event = decodeBrokerOperatorSseFrame(frame);
        if (!event) {
          continue;
        }
        yield event;
      }
    },

    async approveTask(
      taskId: string,
      request?: Partial<A2ABrokerTaskApprovalRequest>,
      overrides?: { requester?: A2ABrokerPartyRef },
    ): Promise<A2ABrokerTaskRecord> {
      const normalizedTaskId = normalizeRequiredTaskId(taskId);
      const requester = overrides?.requester ?? request?.actor ?? options.requester;
      const actor = request?.actor ?? requester;
      if (!actor) {
        throw new Error("actor or configured requester is required to approve broker task");
      }
      const parsedRequest = A2ABrokerTaskApprovalRequestSchema.parse({
        actor,
        ...(normalizeOptionalString(request?.reason)
          ? { reason: normalizeOptionalString(request?.reason) }
          : {}),
        ...(normalizeOptionalString(request?.approvalId)
          ? { approvalId: normalizeOptionalString(request?.approvalId) }
          : {}),
      });
      const response = await fetchImpl(
        buildEndpointUrl(baseUrl, `tasks/${encodeURIComponent(normalizedTaskId)}/approve`),
        {
          method: "POST",
          headers: buildRequestHeaders({
            requester,
            edgeSecret,
            userAgent,
            contentType: "application/json",
          }),
          body: JSON.stringify(parsedRequest),
        },
      );
      if (!response.ok) {
        const body = await readBrokerJson(response).catch(() => undefined);
        throw buildClientError(response, body);
      }
      return await parseBrokerJson(response, A2ABrokerTaskRecordSchema);
    },

    async rejectTaskApproval(
      taskId: string,
      request?: Partial<A2ABrokerTaskApprovalTerminalRequest>,
      overrides?: { requester?: A2ABrokerPartyRef },
    ): Promise<A2ABrokerTaskRecord> {
      const normalizedTaskId = normalizeRequiredTaskId(taskId);
      const requester = overrides?.requester ?? request?.actor ?? options.requester;
      const actor = request?.actor ?? requester;
      if (!actor) {
        throw new Error("actor or configured requester is required to reject broker task approval");
      }
      const parsedRequest = A2ABrokerTaskApprovalTerminalRequestSchema.parse({
        actor,
        ...(normalizeOptionalString(request?.reason)
          ? { reason: normalizeOptionalString(request?.reason) }
          : {}),
        ...(normalizeOptionalString(request?.approvalId)
          ? { approvalId: normalizeOptionalString(request?.approvalId) }
          : {}),
        ...(request?.status ? { status: request.status } : {}),
      });
      const response = await fetchImpl(
        buildEndpointUrl(baseUrl, `tasks/${encodeURIComponent(normalizedTaskId)}/reject-approval`),
        {
          method: "POST",
          headers: buildRequestHeaders({
            requester,
            edgeSecret,
            userAgent,
            contentType: "application/json",
          }),
          body: JSON.stringify(parsedRequest),
        },
      );
      if (!response.ok) {
        const body = await readBrokerJson(response).catch(() => undefined);
        throw buildClientError(response, body);
      }
      return await parseBrokerJson(response, A2ABrokerTaskRecordSchema);
    },

    async cancelTask(
      taskId: string,
      request?: Partial<A2ABrokerTaskCancelRequest>,
      overrides?: { requester?: A2ABrokerPartyRef },
    ): Promise<A2ABrokerTaskRecord> {
      const normalizedTaskId = normalizeRequiredTaskId(taskId);
      const requester = overrides?.requester ?? request?.actor ?? options.requester;
      const actor = request?.actor ?? requester;
      if (!actor) {
        throw new Error("actor or configured requester is required to cancel a broker task");
      }
      const parsedRequest = A2ABrokerTaskCancelRequestSchema.parse({
        actor,
        ...(normalizeOptionalString(request?.reason)
          ? { reason: normalizeOptionalString(request?.reason) }
          : {}),
      });
      const response = await fetchImpl(
        buildEndpointUrl(baseUrl, `tasks/${encodeURIComponent(normalizedTaskId)}/cancel`),
        {
          method: "POST",
          headers: buildRequestHeaders({
            requester,
            edgeSecret,
            userAgent,
            contentType: "application/json",
          }),
          body: JSON.stringify(parsedRequest),
        },
      );
      return await parseBrokerJson(response, A2ABrokerTaskRecordSchema);
    },

    async getTaskDiagnostics(taskId: string): Promise<unknown> {
      const normalizedTaskId = normalizeRequiredTaskId(taskId);
      const response = await fetchImpl(
        buildEndpointUrl(baseUrl, `tasks/${encodeURIComponent(normalizedTaskId)}/diagnostics`),
        {
          method: "GET",
          headers: buildRequestHeaders({
            requester: options.requester,
            edgeSecret,
            userAgent,
          }),
        },
      );
      return await readBrokerJson(response);
    },

    async listDiagnostics(): Promise<unknown> {
      const response = await fetchImpl(
        buildEndpointUrl(baseUrl, "tasks/diagnostics"),
        {
          method: "GET",
          headers: buildRequestHeaders({
            requester: options.requester,
            edgeSecret,
            userAgent,
          }),
        },
      );
      return await readBrokerJson(response);
    },

    async getAlerts(): Promise<unknown> {
      const response = await fetchImpl(
        buildEndpointUrl(baseUrl, "alerts"),
        {
          method: "GET",
          headers: buildRequestHeaders({
            requester: options.requester,
            edgeSecret,
            userAgent,
          }),
        },
      );
      return await readBrokerJson(response);
    },

    async listTerminalOutbox(params: {
      afterId?: string;
      limit?: number;
      reconcileUnacked?: boolean;
    } = {}): Promise<A2ATerminalOutboxListResponse> {
      const url = new URL(buildEndpointUrl(baseUrl, "a2a/tasks/terminal-outbox"));
      const afterId = normalizeOptionalString(params.afterId);
      if (afterId) url.searchParams.set("after_id", afterId);
      if (typeof params.limit === "number" && Number.isInteger(params.limit) && params.limit >= 0) {
        url.searchParams.set("limit", String(params.limit));
      }
      if (params.reconcileUnacked === true) {
        url.searchParams.set("reconcile_unacked", "true");
      }
      const response = await fetchImpl(url, {
        method: "GET",
        headers: buildRequestHeaders({
          requester: options.requester,
          edgeSecret,
          userAgent,
        }),
      });
      return await parseBrokerJson(response, A2ATerminalOutboxListResponseSchema);
    },

    async ackTerminalOutbox(params: {
      id: string;
      receipt: {
        evidence: A2ATerminalOutboxAckEvidence;
        acknowledgedAt?: string;
        receiptId?: string;
        note?: string;
      };
    }): Promise<A2ATerminalOutboxEvent> {
      const id = normalizeRequiredTaskId(params.id);
      const response = await fetchImpl(buildEndpointUrl(baseUrl, "a2a/tasks/terminal-outbox/ack"), {
        method: "POST",
        headers: buildRequestHeaders({
          requester: options.requester,
          edgeSecret,
          userAgent,
          contentType: "application/json",
        }),
        body: JSON.stringify({ id, receipt: params.receipt }),
      });
      const body = await parseBrokerJson(response, A2ATerminalOutboxAckResponseSchema);
      return body.event;
    },

    async recordTerminalOutboxReceipt(params: {
      id: string;
      receipt: {
        status: A2ATerminalOutboxReceiptStatus;
        updatedAt?: string;
        note?: string;
      };
    }): Promise<A2ATerminalOutboxEvent> {
      const id = normalizeRequiredTaskId(params.id);
      const response = await fetchImpl(buildEndpointUrl(baseUrl, "a2a/tasks/terminal-outbox/receipt"), {
        method: "POST",
        headers: buildRequestHeaders({
          requester: options.requester,
          edgeSecret,
          userAgent,
          contentType: "application/json",
        }),
        body: JSON.stringify({ id, receipt: params.receipt }),
      });
      const body = await parseBrokerJson(response, A2ATerminalOutboxAckResponseSchema);
      return body.event;
    },

    async relayTerminalProjection(projection: Record<string, unknown>): Promise<unknown> {
      const response = await fetchImpl(buildEndpointUrl(baseUrl, "a2a/cross-broker/terminal-briefs"), {
        method: "POST",
        headers: buildRequestHeaders({
          requester: options.requester,
          edgeSecret,
          userAgent,
          contentType: "application/json",
        }),
        body: JSON.stringify(projection),
      });
      const body = await readBrokerJson(response).catch(() => undefined);
      if (!response.ok) {
        throw buildClientError(response, body);
      }
      return body;
    },

    /**
     * Query peer status via broker JSON-RPC PeerStatus method.
     * Calls POST /a2a/jsonrpc with method "PeerStatus".
     */
    async peerStatus(params: { target: string; maxCacheAgeMs?: number }): Promise<unknown> {
      const body = {
        jsonrpc: "2.0",
        id: 1,
        method: "PeerStatus",
        params: {
          target: params.target,
          ...(params.maxCacheAgeMs !== undefined ? { maxCacheAgeMs: params.maxCacheAgeMs } : {}),
        },
      };
      const response = await fetchImpl(
        buildEndpointUrl(baseUrl, "a2a/jsonrpc"),
        {
          method: "POST",
          headers: buildRequestHeaders({
            requester: options.requester,
            edgeSecret,
            userAgent,
            contentType: "application/json",
          }),
          body: JSON.stringify(body),
        },
      );
      const json = await readBrokerJson(response);
      if (!json || typeof json !== "object" || Array.isArray(json)) {
        throw new A2ABrokerClientError(`unexpected peer status response: ${JSON.stringify(json)}`, response.status);
      }
      const result = (json as Record<string, unknown>).result;
      const error = (json as Record<string, unknown>).error;
      if (error && typeof error === "object") {
        const errorData = (error as Record<string, unknown>).data as Record<string, unknown> | undefined;
        const errorCode = errorData?.brokerCode ?? (error as Record<string, unknown>).message ?? "peer_status_error";
        throw new A2ABrokerClientError(String(errorCode), response.status);
      }
      return result;
    },
  };
}
