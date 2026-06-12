import { BrokerError, type InMemoryA2ABroker } from "../core/broker.js";
import { assertRequesterCanSubscribeToTask, type RequesterIdentity } from "../core/request-security.js";
import type { A2AExchangeVia, TaskListFilters, TaskRecord } from "../core/types.js";
import type { AgentCard } from "./agent-card.js";
import { PEER_STATUS_VERBOSE_SCOPE, PeerStatusService, type PeerStatusRequest } from "./peer-status.js";
import { projectBrokerTask, projectBrokerTaskForList } from "./task-projection.js";

export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
}

export interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: unknown;
}

export interface JsonRpcFailure {
  jsonrpc: "2.0";
  id: JsonRpcId;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export interface ExecuteJsonRpcOptions {
  broker: InMemoryA2ABroker;
  agentCard: AgentCard;
  /**
   * Public base URL for the broker. Used to advertise the SSE subscription URL in
   * `SubscribeToTask` responses.
   */
  publicBaseUrl?: string;
  requesterIdentity: RequesterIdentity | null;
  enforceRequesterIdentity: boolean;
  /**
   * Optional peer status service instance. If provided, enables the PeerStatus RPC method.
   */
  peerStatusService?: PeerStatusService;
  /**
   * When set, a new-context SendMessage with no metadata.targetNodeId is
   * routed to this embedded default-agent worker (A2A single-agent mode).
   * An explicit targetNodeId always overrides it.
   */
  defaultAgentNodeId?: string;
  /**
   * Response wire shape. "spec" (clients that explicitly negotiated an
   * A2A-Version header) returns A2A 1.0 result objects; "legacy" (default;
   * header-less clients such as the plugin) keeps the historical envelopes.
   */
  responseShape?: "spec" | "legacy";
}

function specTaskStateName(state: ReturnType<typeof projectBrokerTask>["status"]["state"]): string {
  switch (state) {
    case "submitted": return "TASK_STATE_SUBMITTED";
    case "working": return "TASK_STATE_WORKING";
    case "completed": return "TASK_STATE_COMPLETED";
    case "failed": return "TASK_STATE_FAILED";
    case "canceled": return "TASK_STATE_CANCELED";
    case "input-required": return "TASK_STATE_INPUT_REQUIRED";
    case "rejected": return "TASK_STATE_REJECTED";
    case "auth-required": return "TASK_STATE_AUTH_REQUIRED";
    default: return "TASK_STATE_UNSPECIFIED";
  }
}

/** A2A 1.0 proto-JSON Task: id + top-level contextId, TASK_STATE_* status, no kind. */
export function projectSpecTask(task: TaskRecord): Record<string, unknown> {
  const projected = projectBrokerTask(task);
  return {
    id: projected.id,
    contextId: task.exchangeId,
    status: {
      state: specTaskStateName(projected.status.state),
      timestamp: projected.status.timestamp,
      ...(projected.status.message
        ? {
            message: {
              messageId: `${task.id}:status`,
              taskId: task.id,
              contextId: task.exchangeId,
              role: "ROLE_AGENT",
              parts: projected.status.message.parts,
            },
          }
        : {}),
    },
    artifacts: projected.artifacts ?? [],
    metadata: projected.metadata,
  };
}

/**
 * A2A 1.0 StreamResponse payloads for SendStreamingMessage. The proto's
 * StreamResponse is a oneof of { task | message | statusUpdate |
 * artifactUpdate }; the opening event carries the Task snapshot and
 * subsequent events carry TaskStatusUpdateEvent ({ taskId, contextId,
 * status, final }).
 */
export function specStreamTaskSnapshot(task: TaskRecord): Record<string, unknown> {
  return { task: projectSpecTask(task) };
}

export function specStreamStatusUpdate(task: TaskRecord, final: boolean): Record<string, unknown> {
  const projected = projectSpecTask(task);
  return {
    statusUpdate: {
      taskId: task.id,
      contextId: task.exchangeId,
      status: projected.status,
      final,
    },
  };
}

/** A2A 1.0 SendMessageResponse: a oneof wrapper of { task } or { message }. */
export function specSendResult(
  send: { contextId: string; messageId: string; task?: ReturnType<typeof projectBrokerTask> },
  broker: InMemoryA2ABroker,
): Record<string, unknown> {
  if (send.task) {
    const record = broker.getTask(send.task.id);
    if (record) {
      return { task: projectSpecTask(record) };
    }
  }
  return {
    message: { messageId: send.messageId, contextId: send.contextId, role: "ROLE_AGENT", parts: [] },
  };
}

export function executeA2AJsonRpc(
  request: unknown,
  options: ExecuteJsonRpcOptions,
): JsonRpcSuccess | JsonRpcFailure {
  const parsed = parseJsonRpcRequest(request);
  if ("error" in parsed) {
    return parsed;
  }

  const id = parsed.id ?? null;
  const { method, params } = parsed;

  try {
    switch (method) {
      case "SendMessage": {
        const result = executeSendMessage(params, options);
        if (options.responseShape === "spec") {
          return success(id, specSendResult(result, options.broker));
        }
        return success(id, result);
      }

      case "SendStreamingMessage": {
        // The HTTP layer intercepts a single SendStreamingMessage request and
        // answers with an SSE stream. Reaching this dispatcher means the call
        // arrived where streaming is impossible (inside a batch, or via a
        // non-streaming transport embedding) — fail closed instead of
        // pretending a unary response is a stream.
        return failure(
          id,
          -32600,
          "SendStreamingMessage requires a streaming response and cannot be used inside a batch request",
        );
      }

      case "GetTask": {
        const taskId = requireString(params, "taskId");
        if (options.enforceRequesterIdentity) {
          requireRequesterIdentityForTaskRead(options, "GetTask");
        }
        const task = options.broker.getTask(taskId);
        if (!task) {
          throw new BrokerError("not_found", "task not found");
        }
        if (options.enforceRequesterIdentity) {
          assertRequesterCanSubscribeToTask(options.requesterIdentity, task);
        }
        if (options.responseShape === "spec") {
          return success(id, projectSpecTask(task));
        }
        return success(id, { task: projectBrokerTask(task) });
      }

      case "ListTasks": {
        const filters = parseListTaskFilters(params);
        if (options.enforceRequesterIdentity) {
          requireTaskListRequester(options);
        }
        const visible = options.broker
          .listTasks(filters)
          .filter((task) => canReadTaskSnapshot(options, task));
        if (options.responseShape === "spec") {
          return success(id, { tasks: visible.map(projectSpecTask) });
        }
        return success(id, { tasks: visible.map(projectBrokerTaskForList) });
      }

      case "CancelTask": {
        const taskId = requireString(params, "taskId");
        const actor = deriveActor(params, options.requesterIdentity, options.enforceRequesterIdentity);
        const reason = optionalStringField(params, "reason");
        const task = options.broker.cancelTask(taskId, { actor, reason });
        if (options.responseShape === "spec") {
          return success(id, projectSpecTask(task));
        }
        return success(id, { task: projectBrokerTask(task) });
      }

      case "SubscribeToTask": {
        // Returns the current task snapshot plus the SSE URL clients should connect to for
        // live updates. Actual streaming happens over HTTP SSE at `/a2a/tasks/:id/events`
        // because JSON-RPC over a single POST cannot carry a multi-event stream.
        const taskId = requireString(params, "taskId");
        if (options.enforceRequesterIdentity) {
          requireRequesterIdentityForTaskRead(options, "SubscribeToTask");
        }
        const task = options.broker.getTask(taskId);
        if (!task) {
          throw new BrokerError("not_found", "task not found");
        }
        if (options.enforceRequesterIdentity) {
          assertRequesterCanSubscribeToTask(options.requesterIdentity, task);
        }
        const subscribeUrl = buildSubscribeUrl(options.publicBaseUrl, taskId);
        return success(id, {
          task: projectBrokerTask(task),
          subscription: {
            transport: "sse",
            url: subscribeUrl,
            eventTypes: ["task-snapshot", "task-status-update"],
          },
        });
      }

      case "GetExtendedAgentCard": {
        return success(id, options.agentCard);
      }

      case "a2a.peer.status":
      // Deprecated compatibility alias retained for existing callers. New
      // clients and docs must use the canonical broker extension name above.
      case "PeerStatus": {
        if (!options.peerStatusService) {
          return failure(id, -32601, `method not found: ${method}`);
        }

        // Auth check
        if (!options.requesterIdentity?.id) {
          return failure(id, -32001, `${method} requires caller identity`, {
            brokerCode: "unauthenticated",
          });
        }

        if (!isRecord(params)) {
          throw new BrokerError("bad_request", "params must be an object");
        }

        const peerRequest: PeerStatusRequest = {
          target: optionalString(params.target) ?? "",
          maxCacheAgeMs: typeof params.maxCacheAgeMs === "number" ? params.maxCacheAgeMs : undefined,
          verbose: typeof params.verbose === "boolean" ? params.verbose : undefined,
        };

        if (!peerRequest.target) {
          throw new BrokerError("bad_request", "target is required");
        }

        if (
          peerRequest.verbose &&
          !options.requesterIdentity.scopes?.includes(PEER_STATUS_VERBOSE_SCOPE)
        ) {
          return failure(id, -32003, `missing required scope: ${PEER_STATUS_VERBOSE_SCOPE}`, {
            brokerCode: "scope_denied",
            requiredScope: PEER_STATUS_VERBOSE_SCOPE,
          });
        }

        // Check that target worker exists
        const targetWorker = options.broker.getWorker(peerRequest.target);
        if (!targetWorker) {
          return failure(id, -32004, `target unknown: ${peerRequest.target}`, {
            brokerCode: "target_unknown",
          });
        }

        const result = options.peerStatusService.query(peerRequest, {
          callerId: options.requesterIdentity.id,
          scopes: options.requesterIdentity.scopes,
        });

        if ("errorCode" in result) {
          const errorData: Record<string, unknown> = { brokerCode: result.errorCode };
          if (result.retryAfterMs !== undefined) {
            errorData.retryAfterMs = result.retryAfterMs;
          }
          if (result.requiredScope !== undefined) {
            errorData.requiredScope = result.requiredScope;
          }
          const rpcCode = result.errorCode === "rate_limited" ? -32029
            : result.errorCode === "unauthenticated" ? -32001
            : result.errorCode === "scope_denied" ? -32003
            : -32602;
          return failure(id, rpcCode, result.message, errorData);
        }

        return success(id, result);
      }

      default:
        return failure(id, -32601, `method not found: ${method}`);
    }
  } catch (error) {
    if (error instanceof BrokerError) {
      return failure(id, brokerErrorCode(error.code, error.message), error.message, brokerErrorData(error.code, error.message));
    }
    if (error instanceof Error) {
      // An unexpected (non-BrokerError) exception is a server-side fault, not a
      // client params error: -32603 internal error, never -32602.
      return failure(id, -32603, error.message);
    }
    return failure(id, -32603, "internal error");
  }
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;

/**
 * Execute a raw JSON-RPC request body, handling the full transport envelope:
 *
 *  - malformed JSON returns a single -32700 parse error;
 *  - a batch array is processed per element, with an empty array rejected as
 *    -32600 (a single object, per the spec);
 *  - notifications (requests with no `id` member) receive no response.
 *
 * Returns a single response, an array of responses for a batch, or `null` when
 * the input was entirely notifications and the transport must send no body.
 */
export function executeA2AJsonRpcBody(
  rawBody: string,
  options: ExecuteJsonRpcOptions,
): JsonRpcResponse | JsonRpcResponse[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return failure(null, -32700, "parse error");
  }

  if (Array.isArray(parsed)) {
    if (parsed.length === 0) {
      return failure(null, -32600, "invalid JSON-RPC request: empty batch");
    }
    const responses: JsonRpcResponse[] = [];
    for (const entry of parsed) {
      const outcome = executeOneJsonRpc(entry, options);
      if (outcome) responses.push(outcome);
    }
    return responses.length > 0 ? responses : null;
  }

  return executeOneJsonRpc(parsed, options);
}

function executeOneJsonRpc(
  request: unknown,
  options: ExecuteJsonRpcOptions,
): JsonRpcResponse | null {
  // A request object with no `id` member is a notification and gets no
  // response (note: `id: null` is a normal request, not a notification).
  const isNotification = isRecord(request) && !("id" in request);
  const response = executeA2AJsonRpc(request, options);
  return isNotification ? null : response;
}

function parseJsonRpcRequest(request: unknown): JsonRpcRequest | JsonRpcFailure {
  if (!isRecord(request)) {
    return failure(null, -32600, "invalid JSON-RPC request");
  }

  if (request.jsonrpc !== "2.0") {
    return failure(readId(request.id), -32600, "jsonrpc must be '2.0'");
  }

  if (typeof request.method !== "string" || !request.method.trim()) {
    return failure(readId(request.id), -32600, "method is required");
  }

  return {
    jsonrpc: "2.0",
    id: readId(request.id),
    method: request.method,
    params: request.params,
  };
}

function parseListTaskFilters(params: unknown): TaskListFilters {
  if (params === undefined) {
    return {};
  }
  if (!isRecord(params)) {
    throw new BrokerError("bad_request", "params must be an object");
  }

  return {
    exchangeId: optionalString(params.exchangeId) ?? optionalString(params.contextId),
    status: optionalEnum(params.status, ["blocked", "queued", "claimed", "running", "succeeded", "failed", "canceled"]),
    targetNodeId: optionalString(params.targetNodeId),
    proposalId: optionalString(params.proposalId),
    intent: optionalEnum(params.intent, [
      "chat",
      "analyze",
      "verify",
      "backfill",
      "propose_patch",
      "propose_params",
      "validate_change",
      "apply_local_change",
      "promote_to_live",
      "rollback_live",
    ]),
    claimedBy: optionalString(params.claimedBy),
    assignedWorkerId: optionalString(params.assignedWorkerId),
  };
}

function canReadTaskSnapshot(options: ExecuteJsonRpcOptions, task: TaskRecord): boolean {
  if (!options.enforceRequesterIdentity) {
    return true;
  }
  requireTaskListRequester(options);
  try {
    assertRequesterCanSubscribeToTask(options.requesterIdentity, task);
    return true;
  } catch (error) {
    if (error instanceof BrokerError && error.code === "unauthorized") {
      return false;
    }
    throw error;
  }
}

function requireTaskListRequester(options: ExecuteJsonRpcOptions): void {
  requireRequesterIdentityForTaskRead(options, "ListTasks");
}

function requireRequesterIdentityForTaskRead(options: ExecuteJsonRpcOptions, method: string): void {
  if (!options.requesterIdentity?.id) {
    throw new BrokerError("unauthorized", `x-a2a-requester-id is required for ${method}`);
  }
}

export function executeSendMessage(
  params: unknown,
  options: ExecuteJsonRpcOptions,
): {
  contextId: string;
  task?: ReturnType<typeof projectBrokerTask>;
  messageId: string;
} {
  if (!isRecord(params)) {
    throw new BrokerError("bad_request", "params must be an object");
  }

  // In default-agent mode an anonymous A2A client (no broker requester
  // identity, no params.actor) is accepted as a synthetic service requester
  // so a bare message/send works like any standalone agent. Production
  // (no default agent) keeps requiring an actor.
  const effectiveIdentity: RequesterIdentity | null =
    options.requesterIdentity ??
    (options.defaultAgentNodeId && !options.enforceRequesterIdentity
      ? { id: "a2a-anonymous-client", kind: "service", role: "hub" }
      : null);
  const actor = deriveActor(params, effectiveIdentity, options.enforceRequesterIdentity);
  const text = extractMessageText(params.message);
  const metadata = isRecord(params.metadata) ? params.metadata : {};
  const exchangeId = optionalString(metadata.exchangeId) ?? optionalString(metadata.contextId);
  const intent = optionalEnum(metadata.intent, [
    "chat",
    "analyze",
    "verify",
    "backfill",
    "propose_patch",
    "propose_params",
    "validate_change",
    "apply_local_change",
    "promote_to_live",
    "rollback_live",
  ]) ?? "chat";
  const via = parseVia(metadata);
  assertConsistentAssignmentMetadata(metadata);

  if (exchangeId) {
    const existingExchange = options.broker.getExchange(exchangeId);
    if (!existingExchange) {
      throw new BrokerError("not_found", "exchange not found");
    }
    assertConsistentExistingContextAssignmentMetadata(metadata, existingExchange.target.id);
    const message = options.broker.addExchangeMessage(exchangeId, {
      actor,
      message: text,
      parentMessageId: optionalString(metadata.parentMessageId),
      targetNodeId: optionalString(metadata.targetNodeId),
      assignedWorkerId: optionalString(metadata.assignedWorkerId),
      via,
    });
    const exchange = options.broker.getExchange(exchangeId);
    const activeTask = exchange?.activeTaskId ? options.broker.getTask(exchange.activeTaskId) : null;
    return {
      contextId: exchangeId,
      messageId: message.id,
      task: activeTask ? projectBrokerTask(activeTask) : undefined,
    };
  }

  const targetNodeId = optionalString(metadata.targetNodeId) ?? options.defaultAgentNodeId;
  if (!targetNodeId) {
    throw new BrokerError("bad_request", "metadata.targetNodeId is required when starting a new context");
  }

  const targetWorker = options.broker.getWorker(targetNodeId);
  if (!targetWorker) {
    throw new BrokerError("not_found", "target worker not found");
  }

  const assignedWorkerId = optionalString(metadata.assignedWorkerId) ?? targetWorker.nodeId;
  if (assignedWorkerId !== targetWorker.nodeId) {
    throw new BrokerError("bad_request", "metadata.assignedWorkerId must match targetNodeId when starting a new context");
  }
  const assignedWorker = options.broker.getWorker(assignedWorkerId);
  if (!assignedWorker) {
    throw new BrokerError("not_found", "assigned worker not found");
  }

  const exchange = options.broker.startExchange({
    requester: actor,
    target: {
      id: targetWorker.nodeId,
      kind: "node",
      role: targetWorker.role,
    },
    message: text,
    intent,
    via,
  });
  const task = options.broker.createTask({
    exchangeId: exchange.id,
    intent,
    requester: actor,
    target: {
      id: targetWorker.nodeId,
      kind: "node",
      role: targetWorker.role,
    },
    assignedWorkerId: assignedWorker.nodeId,
    message: text,
    via,
  });

  return {
    contextId: exchange.id,
    messageId: exchange.rootMessageId,
    task: projectBrokerTask(task),
  };
}

function assertConsistentAssignmentMetadata(metadata: Record<string, unknown>): void {
  const targetNodeId = optionalString(metadata.targetNodeId);
  const assignedWorkerId = optionalString(metadata.assignedWorkerId);
  if (targetNodeId && assignedWorkerId && assignedWorkerId !== targetNodeId) {
    throw new BrokerError("bad_request", "metadata.assignedWorkerId must match targetNodeId when provided");
  }
}

function assertConsistentExistingContextAssignmentMetadata(
  metadata: Record<string, unknown>,
  exchangeTargetNodeId: string,
): void {
  const targetNodeId = optionalString(metadata.targetNodeId);
  if (targetNodeId && targetNodeId !== exchangeTargetNodeId) {
    throw new BrokerError("bad_request", "metadata.targetNodeId must match the exchange targetNodeId on existing contexts");
  }
  const assignedWorkerId = optionalString(metadata.assignedWorkerId);
  if (assignedWorkerId && assignedWorkerId !== exchangeTargetNodeId) {
    throw new BrokerError("bad_request", "metadata.assignedWorkerId must match the exchange targetNodeId on existing contexts");
  }
}

function deriveActor(
  params: unknown,
  requesterIdentity: RequesterIdentity | null,
  enforceRequesterIdentity: boolean,
): { id: string; kind?: RequesterIdentity["kind"]; role?: RequesterIdentity["role"] } {
  if (isRecord(params) && isRecord(params.actor) && typeof params.actor.id === "string") {
    const actor = {
      id: params.actor.id,
      kind: optionalEnum(params.actor.kind, ["session", "node", "user", "service"]),
      role: optionalEnum(params.actor.role, ["hub", "live-trader", "researcher", "analyst", "operator"]),
    };
    if (enforceRequesterIdentity) {
      if (!requesterIdentity?.id) {
        throw new BrokerError("unauthorized", "x-a2a-requester-id is required for CancelTask");
      }
      if (requesterIdentity.id !== actor.id) {
        throw new BrokerError("unauthorized", `CancelTask requester id must match ${actor.id}`);
      }
      if (actor.role && requesterIdentity.role && requesterIdentity.role !== actor.role) {
        throw new BrokerError("unauthorized", `CancelTask requester role must match ${actor.role}`);
      }
    }
    return actor;
  }

  if (!requesterIdentity?.id) {
    throw new BrokerError("bad_request", "actor.id is required");
  }

  return requesterIdentity;
}

function extractMessageText(message: unknown): string {
  if (typeof message === "string" && message.trim()) {
    return message.trim();
  }
  if (!isRecord(message)) {
    throw new BrokerError("bad_request", "message is required");
  }

  const directText = optionalString(message.text);
  if (directText) {
    return directText;
  }

  if (Array.isArray(message.parts)) {
    const text = message.parts
      .filter(isRecord)
      .map((part) => optionalString(part.text))
      .filter((value): value is string => Boolean(value))
      .join("\n\n")
      .trim();
    if (text) {
      return text;
    }
  }

  throw new BrokerError("bad_request", "message text is required");
}

function parseVia(metadata: Record<string, unknown>): A2AExchangeVia | undefined {
  const transport = optionalString(metadata.transport);
  const channel = optionalString(metadata.channel);
  const nodeId = optionalString(metadata.nodeId);
  const sessionId = optionalString(metadata.sessionId);
  const traceId = optionalString(metadata.traceId) ?? optionalString(metadata.messageId);

  if (!transport && !channel && !nodeId && !sessionId && !traceId) {
    return undefined;
  }

  return {
    transport,
    channel,
    nodeId,
    sessionId,
    traceId,
  };
}

function requireString(value: unknown, field: string): string {
  if (!isRecord(value) || typeof value[field] !== "string" || !value[field].trim()) {
    throw new BrokerError("bad_request", `${field} is required`);
  }
  return value[field].trim();
}

function optionalStringField(value: unknown, field: string): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return optionalString(value[field]);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalEnum<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim() as T;
  return allowed.includes(normalized) ? normalized : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readId(id: unknown): JsonRpcId {
  return typeof id === "string" || typeof id === "number" || id === null ? id : null;
}

function success(id: JsonRpcId, result: unknown): JsonRpcSuccess {
  return {
    jsonrpc: "2.0",
    id,
    result,
  };
}

function failure(id: JsonRpcId, code: number, message: string, data?: unknown): JsonRpcFailure {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
      data,
    },
  };
}

function buildSubscribeUrl(publicBaseUrl: string | undefined, taskId: string): string | undefined {
  if (!publicBaseUrl) {
    return undefined;
  }
  const trimmed = publicBaseUrl.endsWith("/") ? publicBaseUrl.slice(0, -1) : publicBaseUrl;
  return `${trimmed}/a2a/tasks/${encodeURIComponent(taskId)}/events`;
}

/**
 * Map an arbitrary thrown value to a JSON-RPC error object. BrokerError
 * validation codes keep their -326xx mapping; anything else is -32603.
 * Used by the HTTP layer for the SendStreamingMessage pre-stream phase.
 */
export function jsonRpcErrorFromUnknown(error: unknown): { code: number; message: string; data?: unknown } {
  if (error instanceof BrokerError) {
    return { code: brokerErrorCode(error.code, error.message), message: error.message, data: brokerErrorData(error.code, error.message) };
  }
  return { code: -32603, message: error instanceof Error ? error.message : String(error) };
}

// A2A 1.0 reserved JSON-RPC error family (a2a-protocol.org). Only the codes
// the broker can actually produce are bound here; the rest of the -3200x
// space (push/content-type/agent-response/extended-card/extension) is for
// conditions this broker does not raise.
const A2A_ERROR_DOMAIN = "a2a-protocol.org";
const A2A_ERROR_INFO_TYPE = "type.googleapis.com/google.rpc.ErrorInfo";

interface BrokerErrorMapping {
  code: number;
  /** A2A google.rpc.ErrorInfo domain + reason when the condition is an A2A-bound error. */
  a2a?: { reason: string };
}

function isA2ATaskNotFound(code: BrokerError["code"], message: string | undefined): boolean {
  return code === "not_found" && /^task not found\b/i.test(message ?? "");
}

function brokerErrorMapping(code: BrokerError["code"], message?: string): BrokerErrorMapping {
  switch (code) {
    case "not_found":
      if (isA2ATaskNotFound(code, message)) {
        // Task/resource lookups that miss are A2A TaskNotFoundError. Do not map
        // unrelated broker resources (workers/exchanges) to TASK_NOT_FOUND.
        return { code: -32001, a2a: { reason: "TASK_NOT_FOUND" } };
      }
      return { code: -32014 };
    case "invalid_transition":
      // A lifecycle transition the task can no longer make (e.g. cancel on a
      // terminal task) is A2A TaskNotCancelableError for JSON-RPC task ops.
      return { code: -32002, a2a: { reason: "TASK_NOT_CANCELABLE" } };
    case "bad_request":
      return { code: -32602 }; // standard JSON-RPC Invalid params
    case "unauthorized":
      return { code: -32011 }; // broker extension (A2A range, unbound)
    case "policy_denied":
      return { code: -32012 };
    case "rate_limited":
      return { code: -32013 };
    default:
      // Never throw from inside the catch handler that calls this — an
      // unmapped broker code becomes a generic internal error.
      return { code: -32603 };
  }
}

function brokerErrorCode(code: BrokerError["code"], message?: string): number {
  return brokerErrorMapping(code, message).code;
}

/**
 * Build the JSON-RPC `error.data` array for a BrokerError. A2A 1.0 requires a
 * google.rpc.ErrorInfo entry in the data array; for A2A-bound conditions the
 * domain is a2a-protocol.org with the spec reason, and for broker-specific
 * conditions a broker domain is used (the broker code is always preserved in
 * metadata for existing consumers).
 */
function brokerErrorData(code: BrokerError["code"], message?: string): unknown[] {
  const mapping = brokerErrorMapping(code, message);
  const reason = mapping.a2a?.reason ?? code.toUpperCase();
  const domain = mapping.a2a ? A2A_ERROR_DOMAIN : "a2a-broker.local";
  return [
    {
      "@type": A2A_ERROR_INFO_TYPE,
      domain,
      reason,
      metadata: { brokerCode: code },
    },
  ];
}
