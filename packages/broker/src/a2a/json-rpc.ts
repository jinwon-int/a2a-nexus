import { BrokerError, type InMemoryA2ABroker } from "../core/broker.js";
import { PushNotificationConfigStore, PushConfigError, redactPushConfigSecrets } from "./push-notification-config.js";
import { assertRequesterCanSubscribeToTask, type RequesterIdentity } from "../core/request-security.js";
import type { A2AExchangeVia, TaskListFilters, TaskRecord } from "../core/types.js";
import type { AgentCard, AgentCapabilities } from "./agent-card.js";
import { PEER_STATUS_VERBOSE_SCOPE, PeerStatusService, type PeerStatusRequest } from "./peer-status.js";
import {
  a2aStatusTimestamp,
  compareByA2AStatusTimestampDesc,
  projectBrokerTask,
  projectBrokerTaskForList,
} from "./task-projection.js";
import { matchDefaultAgentConvention } from "./default-agent-conventions.js";
import {
  pageSpecTasks,
  parseSpecListTaskFilters,
} from "./list-tasks-spec-filters.js";
import {
  buildTaskLineageReadProjection,
  parseTaskLineageChildrenRequestV1,
  parseTaskLineageLeavesRequestV1,
  parseTaskLineageLineageRequestV1,
} from "../core/task-lineage-read.js";

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
   * Optional push-notification config store. When provided, the four A2A 1.0
   * TaskPushNotificationConfig methods are enabled.
   */
  pushNotificationConfigStore?: PushNotificationConfigStore;
  /** Persist a push-config mutation into the broker's durable snapshot path. */
  persistPushNotificationConfigs?: () => void;
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

export function specTaskStateName(state: ReturnType<typeof projectBrokerTask>["status"]["state"]): string {
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

/** Proto-JSON TaskStatus ({ state: TASK_STATE_*, timestamp, message? }). */
function specTaskStatus(task: TaskRecord): Record<string, unknown> {
  const projected = projectBrokerTask(task);
  return {
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
  };
}

/**
 * Proto-JSON Artifact: artifactId + parts (>=1) are REQUIRED. Broker tasks
 * carry artifact ids; the records resolve to a uri/contentType, projected as
 * a url Part. A dangling id (record pruned) degrades to a data Part carrying
 * the reference so the REQUIRED parts constraint still holds.
 */
function specTaskArtifacts(task: TaskRecord, broker: InMemoryA2ABroker): Array<Record<string, unknown>> {
  // Embedded-agent results carry fully-shaped A2A artifacts (default-agent
  // conformance mode); emit them verbatim. Ordinary worker results continue
  // through the artifactIds resolution path below.
  const embedded = task.result?.a2aArtifacts;
  if (embedded && embedded.length > 0) {
    return embedded.map((artifact) => ({
      artifactId: artifact.artifactId,
      ...(artifact.name ? { name: artifact.name } : {}),
      ...(artifact.description ? { description: artifact.description } : {}),
      parts: artifact.parts,
    }));
  }
  const ids = task.result?.artifactIds ?? task.artifactIds ?? [];
  return ids.map((id) => {
    const record = broker.getArtifact(id);
    if (!record) {
      return { artifactId: id, parts: [{ data: { brokerArtifactId: id } }] };
    }
    return {
      artifactId: record.id,
      ...(record.kind ? { name: record.kind } : {}),
      ...(record.summary ? { description: record.summary } : {}),
      parts: [
        {
          url: record.uri,
          ...(record.contentType ? { mediaType: record.contentType } : {}),
        },
      ],
    };
  });
}

/**
 * A2A 1.0 proto-JSON Task: id + top-level contextId, TASK_STATE_* status, no
 * kind.
 *
 * `options.includeArtifacts` mirrors the proto `ListTasksRequest
 * .include_artifacts` flag (#1912 D4): false — the proto default — elides the
 * `artifacts` key entirely from the task (never `[]`, never `null`); true
 * always carries the key. Omitted options mean the method has no such proto
 * field (GetTask), which keeps artifacts unconditionally.
 */
export function projectSpecTask(
  task: TaskRecord,
  broker: InMemoryA2ABroker,
  options?: { includeArtifacts?: boolean },
): Record<string, unknown> {
  const projected = projectBrokerTask(task);
  return {
    id: projected.id,
    contextId: task.exchangeId,
    status: specTaskStatus(task),
    ...(options?.includeArtifacts === false
      ? {}
      : { artifacts: specTaskArtifacts(task, broker) }),
    metadata: projected.metadata,
  };
}

/**
 * A2A 1.0 StreamResponse payloads for SendStreamingMessage. The proto's
 * StreamResponse is a oneof of { task | message | statusUpdate |
 * artifactUpdate }; the opening event carries the Task snapshot and
 * subsequent events carry TaskStatusUpdateEvent ({ taskId, contextId,
 * status, metadata }). The proto event has no `final` field — stream
 * termination is signaled by a terminal status.state plus the stream
 * closing; the broker's final flag rides in the open metadata Struct.
 */
export function specStreamTaskSnapshot(task: TaskRecord, broker: InMemoryA2ABroker): Record<string, unknown> {
  return { task: projectSpecTask(task, broker) };
}

export function specStreamStatusUpdate(task: TaskRecord, final: boolean): Record<string, unknown> {
  return {
    statusUpdate: {
      taskId: task.id,
      contextId: task.exchangeId,
      status: specTaskStatus(task),
      metadata: { final },
    },
  };
}

/** A2A 1.0 SendMessageResponse: a oneof wrapper of { task } or { message }. */
export function specSendResult(
  send: { contextId: string; messageId: string; task?: ReturnType<typeof projectBrokerTask>; message?: { role: "agent"; parts: Array<{ text: string }> } },
  broker: InMemoryA2ABroker,
): Record<string, unknown> {
  if (send.message) {
    return {
      message: {
        messageId: send.messageId,
        contextId: send.contextId,
        role: "ROLE_AGENT",
        parts: send.message.parts,
      },
    };
  }
  if (send.task) {
    const record = broker.getTask(send.task.id);
    if (record) {
      return { task: projectSpecTask(record, broker) };
    }
  }
  return {
    message: { messageId: send.messageId, contextId: send.contextId, role: "ROLE_AGENT", parts: [] },
  };
}

/**
 * Fail closed on a `tenant` this deployment never declared (#1912 D9).
 *
 * `tenant` is an opaque routing identifier carried on every A2A request
 * message. The contract is directional: a client MUST echo the value from the
 * `AgentInterface` it selected, **and only when that interface sets one**.
 *
 * The broker serves a single agent and declares no interface tenant, so a
 * request carrying one is making an assumption this deployment cannot honor.
 * Silently ignoring it — the previous behavior, since the params parsers drop
 * unknown keys — leaves that client believing it is routed to an isolated
 * tenant when it is not. Rejecting makes the mismatch visible at the first
 * request instead of letting it look like it worked.
 *
 * This is **not** an authorization check and must never be mistaken for one:
 * `tenant` is a client-supplied opaque string, so it can be set to anything by
 * anyone. Authorization is performed per request independently of this value.
 * The guard only enforces "did you address an interface that exists".
 *
 * The matching branch is already written so that declaring interface tenants
 * later routes correctly instead of needing this logic rebuilt.
 */
function assertDeclaredTenant(params: unknown, options: ExecuteJsonRpcOptions): void {
  if (!isRecord(params)) {
    return;
  }
  const requested = params.tenant;
  // Proto3 string default is "", and ProtoJSON may omit or send it; both mean
  // "no tenant addressed".
  if (requested === undefined || requested === null || requested === "") {
    return;
  }
  if (typeof requested !== "string") {
    throw new BrokerError("bad_request", "tenant must be a string");
  }
  const declared = new Set(
    (options.agentCard?.supportedInterfaces ?? [])
      .map((entry) => entry.tenant)
      .filter((value): value is string => typeof value === "string" && value.length > 0),
  );
  if (declared.size === 0) {
    throw new BrokerError(
      "bad_request",
      "this agent declares no interface tenant; requests must not carry one",
    );
  }
  if (!declared.has(requested)) {
    throw new BrokerError(
      "bad_request",
      "tenant does not match any declared AgentInterface tenant",
    );
  }
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
    assertDeclaredTenant(params, options);
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
        const taskId = requireTaskIdParam(params);
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
          return success(id, projectSpecTask(task, options.broker));
        }
        return success(id, { task: projectBrokerTask(task) });
      }

      case "ListTasks": {
        // The spec path (A2A-Version negotiated) gets the strict v1.0.1 filter
        // vocabulary (#1912 D2, #1997 slice 1); the headerless legacy envelope
        // keeps its historical internal-vocabulary parser untouched.
        const specFilters =
          options.responseShape === "spec" ? parseSpecListTaskFilters(params) : undefined;
        const filters: TaskListFilters = specFilters
          ? specFilters.exchangeId
            ? { exchangeId: specFilters.exchangeId }
            : {}
          : parseListTaskFilters(params);
        if (options.enforceRequesterIdentity) {
          requireTaskListRequester(options);
        }
        let visible = options.broker
          .listTasks(filters)
          .filter((task) => canReadTaskSnapshot(options, task));
        if (specFilters?.specStatus) {
          // Status matching happens at the projection boundary so projected
          // subtleties are respected: a running task paused on an operator
          // checkpoint satisfies TASK_STATE_INPUT_REQUIRED, a canceled task
          // with a rejected approval outcome only satisfies TASK_STATE_REJECTED.
          const wanted = specFilters.specStatus;
          visible = visible.filter((task) => projectBrokerTask(task).status.state === wanted);
        }
        if (options.responseShape === "spec") {
          // Proto ListTasksResponse: tasks + nextPageToken/pageSize/totalSize
          // are all REQUIRED. Spec ordering is status timestamp descending
          // (#1912 D11); ties break on ascending task id. The spec path is
          // always bounded (#1912 D3, #1997 slice 2): default 50, max 100,
          // continued via the opaque scope-bound cursor in nextPageToken.
          // Scoped to the spec shape — the headerless legacy envelope keeps
          // its established createdAt ordering and unbounded result set.
          let matched = visible;
          if (specFilters?.specStatus) {
            // Status matching happens at the projection boundary so projected
            // subtleties are respected: a running task paused on an operator
            // checkpoint satisfies TASK_STATE_INPUT_REQUIRED, a canceled task
            // with a rejected approval outcome only satisfies TASK_STATE_REJECTED.
            const wanted = specFilters.specStatus;
            matched = matched.filter((task) => projectBrokerTask(task).status.state === wanted);
          }
          if (specFilters?.statusTimestampAfterMs !== undefined) {
            // Inclusive lower bound on the projected status timestamp (spec:
            // "greater than or equal to this value").
            const afterMs = specFilters.statusTimestampAfterMs;
            matched = matched.filter(
              (task) => Date.parse(a2aStatusTimestamp(task)) >= afterMs,
            );
          }
          const totalSize = matched.length;
          const sorted = [...matched].sort(compareByA2AStatusTimestampDesc);
          const { page, nextPageToken } = pageSpecTasks(sorted, specFilters ?? {});
          return success(id, {
            // includeArtifacts defaults to false on the spec path (#1912 D4):
            // the artifacts key is elided unless the client opted in. GetTask
            // has no such proto field and keeps artifacts unconditionally.
            tasks: page.map((task) =>
              projectSpecTask(task, options.broker, {
                includeArtifacts: specFilters?.includeArtifacts === true,
              }),
            ),
            nextPageToken,
            pageSize: page.length,
            totalSize,
          });
        }
        return success(id, { tasks: visible.map(projectBrokerTaskForList) });
      }

      case "tasks/children": {
        const request = parseTaskLineageChildrenRequestV1(params);
        const projection = taskLineageProjectionForRead(
          options,
          "tasks/children",
        );
        return success(id, projection.children(request));
      }

      case "tasks/lineage": {
        const request = parseTaskLineageLineageRequestV1(params);
        const projection = taskLineageProjectionForRead(
          options,
          "tasks/lineage",
        );
        return success(id, projection.lineage(request));
      }

      case "tasks/leaves": {
        const request = parseTaskLineageLeavesRequestV1(params);
        const projection = taskLineageProjectionForRead(
          options,
          "tasks/leaves",
        );
        return success(id, projection.leaves(request));
      }

      case "CancelTask": {
        const taskId = requireTaskIdParam(params);
        // A2A task-identifier semantics: an unknown task id is
        // TaskNotFoundError regardless of actor identity, so the task lookup
        // must happen before actor derivation (which can legitimately demand
        // actor.id on identity-less calls).
        const cancelTarget = options.broker.getTask(taskId);
        if (!cancelTarget) {
          throw new BrokerError("not_found", "task not found");
        }
        // A2A CORE-CANCEL-002: CancelTask on a terminal task is
        // TaskNotCancelableError. The broker core keeps terminal cancels
        // idempotent for internal multi-worker flows (superseded sibling
        // lanes); the A2A adapter enforces the spec error at the boundary.
        if (cancelTarget.status === "succeeded" || cancelTarget.status === "failed" || cancelTarget.status === "canceled") {
          throw new BrokerError("invalid_transition", `task ${taskId} is terminal (${cancelTarget.status})`);
        }
        const actor = deriveActor(params, effectiveDefaultAgentIdentity(options), options.enforceRequesterIdentity);
        const reason = optionalStringField(params, "reason");
        const task = options.broker.cancelTask(taskId, { actor, reason });
        if (options.responseShape === "spec") {
          return success(id, projectSpecTask(task, options.broker));
        }
        return success(id, { task: projectBrokerTask(task) });
      }

      case "SubscribeToTask": {
        // Returns the current task snapshot plus the SSE URL clients should connect to for
        // live updates. Actual streaming happens over HTTP SSE at `/a2a/tasks/:id/events`
        // because JSON-RPC over a single POST cannot carry a multi-event stream.
        const taskId = requireTaskIdParam(params);
        const task = resolveSubscribeToTaskTarget(params, options);
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

      // A2A 1.0 push-notification config CRUD. Method names are the proto
      // rpc names (the official TCK's JSON-RPC binding sends these exact
      // strings); params accept both proto-JSON camelCase (taskId) and the
      // TCK's snake_case wire form (task_id). Disabled mode: the methods
      // answer PushNotificationNotSupportedError (-32003) per the A2A 1.0
      // error-code mapping — the capability is absent, not the method.
      case "CreateTaskPushNotificationConfig": {
        const store = options.pushNotificationConfigStore;
        if (!store) {
          // A2A 1.0 error-code mappings: an agent that does not support push
          // notifications answers PushNotificationNotSupportedError (-32003),
          // not method-not-found — the method exists, the capability does not.
          return failure(
            id,
            -32003,
            "push notifications are not supported",
            a2aProtocolErrorData("PUSH_NOTIFICATION_NOT_SUPPORTED"),
          );
        }
        const p = isRecord(params) ? params : {};
        const createTaskId = requirePushTaskId(params);
        requireAuthorizedTask(options, createTaskId);
        const cfg = store.create({
          taskId: createTaskId,
          id: optionalString(p.id),
          url: typeof p.url === "string" ? p.url : "",
          token: optionalString(p.token),
          authentication: Object.prototype.hasOwnProperty.call(p, "authentication")
            ? p.authentication
            : undefined,
        });
        options.persistPushNotificationConfigs?.();
        return success(id, redactPushConfigSecrets(cfg));
      }

      case "GetTaskPushNotificationConfig": {
        const store = options.pushNotificationConfigStore;
        if (!store) {
          // A2A 1.0 error-code mappings: an agent that does not support push
          // notifications answers PushNotificationNotSupportedError (-32003),
          // not method-not-found — the method exists, the capability does not.
          return failure(
            id,
            -32003,
            "push notifications are not supported",
            a2aProtocolErrorData("PUSH_NOTIFICATION_NOT_SUPPORTED"),
          );
        }
        const getTaskId = requirePushTaskId(params);
        requireAuthorizedTask(options, getTaskId);
        return success(id, redactPushConfigSecrets(store.get(getTaskId, requireString(params, "id"))));
      }

      case "ListTaskPushNotificationConfigs": {
        const store = options.pushNotificationConfigStore;
        if (!store) {
          // A2A 1.0 error-code mappings: an agent that does not support push
          // notifications answers PushNotificationNotSupportedError (-32003),
          // not method-not-found — the method exists, the capability does not.
          return failure(
            id,
            -32003,
            "push notifications are not supported",
            a2aProtocolErrorData("PUSH_NOTIFICATION_NOT_SUPPORTED"),
          );
        }
        const listTaskId = requirePushTaskId(params);
        requireAuthorizedTask(options, listTaskId);
        // Proto ListTaskPushNotificationConfigsResponse: configs + nextPageToken
        // (single-page semantics, so the token is always empty).
        return success(id, {
          configs: store.list(listTaskId).map(redactPushConfigSecrets),
          nextPageToken: "",
        });
      }

      case "DeleteTaskPushNotificationConfig": {
        const store = options.pushNotificationConfigStore;
        if (!store) {
          // A2A 1.0 error-code mappings: an agent that does not support push
          // notifications answers PushNotificationNotSupportedError (-32003),
          // not method-not-found — the method exists, the capability does not.
          return failure(
            id,
            -32003,
            "push notifications are not supported",
            a2aProtocolErrorData("PUSH_NOTIFICATION_NOT_SUPPORTED"),
          );
        }
        const delTaskId = requirePushTaskId(params);
        requireAuthorizedTask(options, delTaskId);
        store.delete(delTaskId, requireString(params, "id"));
        options.persistPushNotificationConfigs?.();
        return success(id, {});
      }

      case "GetExtendedAgentCard": {
        // A2A 1.0: without the extendedAgentCard capability the method must
        // fail — AuthenticatedExtendedCardNotConfiguredError (-32007) — not
        // silently serve the public card.
        const supportsExtendedCard =
          (options.agentCard.capabilities as AgentCapabilities & { extendedAgentCard?: boolean })
            .extendedAgentCard === true;
        if (!supportsExtendedCard) {
          return failure(
            id,
            -32007,
            "authenticated extended agent card is not configured",
            a2aProtocolErrorData("AUTHENTICATED_EXTENDED_CARD_NOT_CONFIGURED"),
          );
        }
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
    if (error instanceof PushConfigError) {
      return failure(id, brokerErrorCode(error.code), error.message, { brokerCode: error.code });
    }
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
  return executeA2AJsonRpcParsedBody(parsed, options);
}

/** Body-already-parsed variant so the transport route parses each body once. */
export function executeA2AJsonRpcParsedBody(
  parsed: unknown,
  options: ExecuteJsonRpcOptions,
): JsonRpcResponse | JsonRpcResponse[] | null {
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
  // A request object with no `id` member is a notification only after it is a
  // syntactically valid JSON-RPC request. Invalid no-id objects such as `{}`
  // must still produce -32600, including when embedded in a batch.
  const isNotification = isRecord(request) && !("id" in request);
  const parsed = parseJsonRpcRequest(request);
  if ("error" in parsed) {
    return parsed;
  }
  if (isNotification) {
    return null;
  }
  return executeA2AJsonRpc(request, options);
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

/**
 * Build exactly one ephemeral task-lineage index from the broker's canonical
 * list/repository read path. Authorization reduction happens before indexing,
 * so hidden tasks cannot affect graph edges, counts, cursors, anomalies, or
 * round hints.
 */
function taskLineageProjectionForRead(
  options: ExecuteJsonRpcOptions,
  method: "tasks/children" | "tasks/lineage" | "tasks/leaves",
) {
  if (options.enforceRequesterIdentity) {
    requireRequesterIdentityForTaskRead(options, method);
  }
  const visible = options.broker
    .listTasks()
    .filter((task) => canReadTaskSnapshot(options, task));
  return buildTaskLineageReadProjection(visible);
}

/**
 * In default-agent mode an anonymous A2A client (no broker requester
 * identity, no params.actor) is accepted as a synthetic service requester so
 * bare task operations work like any standalone agent. Production (no
 * default agent) keeps requiring an actor.
 */
function effectiveDefaultAgentIdentity(options: ExecuteJsonRpcOptions): RequesterIdentity | null {
  return (
    options.requesterIdentity ??
    (options.defaultAgentNodeId && !options.enforceRequesterIdentity
      ? { id: "a2a-anonymous-client", kind: "service", role: "hub" }
      : null)
  );
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
  message?: { role: "agent"; parts: Array<{ text: string }> };
} {
  if (!isRecord(params)) {
    throw new BrokerError("bad_request", "params must be an object");
  }

  // In default-agent mode an anonymous A2A client (no broker requester
  // identity, no params.actor) is accepted as a synthetic service requester
  // so a bare message/send works like any standalone agent. Production
  // (no default agent) keeps requiring an actor.
  const effectiveIdentity: RequesterIdentity | null = effectiveDefaultAgentIdentity(options);
  const actor = deriveActor(params, effectiveIdentity, options.enforceRequesterIdentity);

  // A2A message-level fields (messageId / taskId / contextId) live on the
  // message object itself, not in broker metadata.
  const a2aMessage = isRecord(params.message) ? params.message : undefined;
  const a2aMessageId = optionalString(a2aMessage?.messageId);
  const a2aTaskId = optionalString(a2aMessage?.taskId);
  const a2aContextId = optionalString(a2aMessage?.contextId);

  // The embedded default agent declares text-only input on its agent card.
  // A file part with a non-text media type is A2A ContentTypeNotSupportedError
  // (checked before text extraction so a file-only message reports the real
  // reason). Router mode leaves media support to the target worker.
  if (options.defaultAgentNodeId) {
    assertEmbeddedAgentSupportedParts(a2aMessage);
  }

  const text = extractMessageText(params.message);
  const metadata = isRecord(params.metadata) ? params.metadata : {};
  let exchangeId = optionalString(metadata.exchangeId) ?? optionalString(metadata.contextId) ?? a2aContextId;

  // A2A task identifier semantics: a message carrying taskId binds to that
  // task's context; an unknown taskId is TaskNotFoundError, and a message to
  // a terminal task is UnsupportedOperationError.
  if (a2aTaskId) {
    const referenced = options.broker.getTask(a2aTaskId);
    if (!referenced) {
      throw new BrokerError("not_found", `task not found: ${a2aTaskId}`);
    }
    if (referenced.status === "succeeded" || referenced.status === "failed" || referenced.status === "canceled") {
      throw new BrokerError("unsupported_operation", `task ${a2aTaskId} is terminal (${referenced.status})`);
    }
    if (exchangeId && exchangeId !== referenced.exchangeId) {
      throw new BrokerError("bad_request", "message.contextId does not match the context of message.taskId");
    }
    exchangeId = referenced.exchangeId;
  }
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
      // A2A §3.4.1: an agent that cannot accept a client-provided contextId
      // rejects the request with an error. The context id is a client
      // parameter, so the rejection is JSON-RPC Invalid params (-32602),
      // not a broker resource lookup miss (-32014).
      throw new BrokerError("bad_request", `unknown contextId: ${exchangeId}`);
    }
    assertConsistentExistingContextAssignmentMetadata(metadata, existingExchange.target.id);
    // Clearing an awaiting_operator checkpoint resumes the task, so a
    // context message that would trigger the auto-resume needs the same
    // task-party authorization as the explicit /tasks/:id/resume route
    // (hub/operator, requester, target node, or assigned worker). Checked
    // before the message is recorded so a non-party send fails closed.
    const checkpointedTask = existingExchange.activeTaskId
      ? options.broker.getTask(existingExchange.activeTaskId)
      : null;
    if (
      checkpointedTask?.checkpoint?.state === "awaiting_operator" &&
      options.enforceRequesterIdentity
    ) {
      assertRequesterCanSubscribeToTask(options.requesterIdentity, checkpointedTask);
    }
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
    // A2A multiturn resume: a message into a context whose active task is
    // waiting on requester input (awaiting_operator checkpoint /
    // input-required state) IS the requested input — clear the checkpoint so
    // the task returns to working.
    const resumedTask =
      activeTask?.checkpoint?.state === "awaiting_operator"
        ? options.broker.resumeTask(activeTask.id, actor.id)
        : activeTask;
    return {
      contextId: exchangeId,
      messageId: message.id,
      task: resumedTask ? projectBrokerTask(resumedTask) : undefined,
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

  // Embedded single-agent conformance conventions (default-agent mode only):
  // the official A2A TCK drives SUT behavior via messageId prefixes. A
  // direct-message convention is answered without creating a task; an
  // artifact convention is completed inline so the SendMessage response
  // carries the terminal task with its artifacts. Production routing never
  // interprets messageId prefixes.
  const convention =
    options.defaultAgentNodeId && targetWorker.nodeId === options.defaultAgentNodeId
      ? matchDefaultAgentConvention(a2aMessageId)
      : null;

  if (convention?.kind === "direct-message") {
    const reply = options.broker.addExchangeMessage(exchange.id, {
      actor: { id: targetWorker.nodeId, kind: "node", role: targetWorker.role },
      message: convention.text,
    });
    return {
      contextId: exchange.id,
      messageId: reply.id,
      message: { role: "agent", parts: [{ text: convention.text }] },
    };
  }

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

  if (convention?.kind === "complete-with-artifacts" || convention?.kind === "complete-with-message") {
    // The default agent's async drive loop may already have claimed/started
    // the task from the creation state event; only advance the states that
    // have not happened yet, then complete with the convention result.
    const inFlight = options.broker.getTask(task.id) ?? task;
    if (inFlight.status === "queued") {
      options.broker.claimTask(task.id, assignedWorker.nodeId);
    }
    if ((options.broker.getTask(task.id) ?? inFlight).status === "claimed") {
      options.broker.startTask(task.id, assignedWorker.nodeId);
    }
    options.broker.completeTask(task.id, assignedWorker.nodeId, convention.kind === "complete-with-artifacts"
      ? { summary: convention.summary, a2aArtifacts: convention.artifacts }
      : { summary: convention.summary });
  }

  if (convention?.kind === "input-required") {
    // Same inline advance, then pause on a human-interrupt checkpoint so the
    // response projects A2A input-required. The default agent's drive loop
    // never completes a checkpointed task; a follow-up context message
    // resumes it (existing resume path) and the agent then completes.
    const inFlight = options.broker.getTask(task.id) ?? task;
    if (inFlight.status === "queued") {
      options.broker.claimTask(task.id, assignedWorker.nodeId);
    }
    if ((options.broker.getTask(task.id) ?? inFlight).status === "claimed") {
      options.broker.startTask(task.id, assignedWorker.nodeId);
    }
    options.broker.checkpointTask(task.id, assignedWorker.nodeId, {
      state: "awaiting_operator",
      reason: convention.reason,
    });
  }

  // Re-read after the inline drive so the response reflects the terminal
  // task (convention path) rather than the creation-time snapshot.
  const current = options.broker.getTask(task.id) ?? task;
  return {
    contextId: exchange.id,
    messageId: exchange.rootMessageId,
    task: projectBrokerTask(current),
  };
}

/**
 * Embedded-agent input support is text-only (agent card defaultInputModes).
 * File parts (raw/url) with a non-text media type are rejected as A2A
 * ContentTypeNotSupportedError; text and data parts pass through.
 */
function assertEmbeddedAgentSupportedParts(message: Record<string, unknown> | undefined): void {
  if (!message || !Array.isArray(message.parts)) return;
  for (const part of message.parts) {
    if (!isRecord(part)) continue;
    if (part.raw !== undefined || part.url !== undefined) {
      const mediaType = optionalString(part.mediaType) ?? "";
      if (!mediaType.startsWith("text/")) {
        throw new BrokerError(
          "content_type_not_supported",
          `unsupported media type: ${mediaType || "unspecified"}`,
        );
      }
    }
  }
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
        throw new BrokerError("unauthorized", "x-a2a-requester-id is required to act as an actor");
      }
      if (requesterIdentity.id !== actor.id) {
        throw new BrokerError("unauthorized", `requester id must match actor id ${actor.id}`);
      }
      // A body-supplied actor.role must be backed by the authenticated requester
      // identity's role. Previously this ran only when BOTH roles were set, so a
      // request with no requester-role header could claim actor.role "operator"
      // in the body and gain operator authority in cancelTask (BUG-02). Also
      // fixes the misleading "CancelTask ..." wording on the SendMessage path,
      // which shares this helper (BUG-21).
      if (actor.role && requesterIdentity.role !== actor.role) {
        throw new BrokerError("unauthorized", `requester role must match actor role ${actor.role}`);
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

/**
 * Push-config methods accept the task id as proto-JSON `taskId` or the
 * official TCK's snake_case wire form `task_id` (its JSON-RPC client sends
 * proto field names verbatim).
 */
function requirePushTaskId(params: unknown): string {
  if (isRecord(params) && typeof params.taskId !== "string" && typeof params.task_id === "string") {
    return requireString(params, "task_id");
  }
  return requireString(params, "taskId");
}

/**
 * Task lookup methods (GetTask/CancelTask/SubscribeToTask) accept the task id
 * as proto-JSON `taskId`, the official TCK's snake_case wire form `task_id`,
 * the TCK JSON-RPC client's bare `id`, or the proto resource `name`
 * ("tasks/<id>", prefix stripped). Without a usable alias the canonical
 * `taskId` requirement throws, keeping the -32602 bad_request behaviour.
 */
function requireTaskIdParam(params: unknown): string {
  if (isRecord(params)) {
    if (typeof params.taskId === "string") {
      return requireString(params, "taskId");
    }
    if (typeof params.task_id === "string") {
      return requireString(params, "task_id");
    }
    if (typeof params.id === "string") {
      return requireString(params, "id");
    }
    if (typeof params.name === "string") {
      const name = requireString(params, "name");
      return name.startsWith("tasks/") ? name.slice("tasks/".length) : name;
    }
  }
  return requireString(params, "taskId");
}

/**
 * Resolve and authorize the SubscribeToTask target: the task must exist,
 * must be readable by the caller (under identity enforcement), and must be
 * non-terminal — A2A 1.0 STREAM-SUB-003 makes subscribing to a terminal
 * task an UnsupportedOperationError. Shared by the unary JSON-RPC method
 * and the HTTP-layer SSE upgrade.
 */
export function resolveSubscribeToTaskTarget(
  params: unknown,
  options: ExecuteJsonRpcOptions,
): TaskRecord {
  const taskId = requireTaskIdParam(params);
  if (options.enforceRequesterIdentity) {
    requireRequesterIdentityForTaskRead(options, "SubscribeToTask");
  }
  const task = options.broker.getTask(taskId);
  if (!task) {
    throw new BrokerError("not_found", "task not found");
  }
  if (task.status === "succeeded" || task.status === "failed" || task.status === "canceled") {
    throw new BrokerError("unsupported_operation", `task ${taskId} is terminal (${task.status})`);
  }
  if (options.enforceRequesterIdentity) {
    assertRequesterCanSubscribeToTask(options.requesterIdentity, task);
  }
  return task;
}

/**
 * Resolve and authorize the task a push-config operation targets. The task
 * must exist, and (under identity enforcement) the caller must be a party to
 * it (requester / target / assigned worker) or a hub/operator — push configs
 * carry delivery tokens/auth, so unauthorized read/list is a secret-leak
 * surface.
 */
function requireAuthorizedTask(options: ExecuteJsonRpcOptions, taskId: string): void {
  const task = options.broker.getTask(taskId);
  if (!task) {
    throw new BrokerError("not_found", "task not found");
  }
  if (options.enforceRequesterIdentity) {
    assertRequesterCanSubscribeToTask(options.requesterIdentity, task);
  }
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
// space (agent-response/extended-card/extension) is for conditions this
// broker does not raise.
const A2A_ERROR_DOMAIN = "a2a-protocol.org";
const A2A_ERROR_INFO_TYPE = "type.googleapis.com/google.rpc.ErrorInfo";

/** Build the standard A2A google.rpc.ErrorInfo payload for protocol errors. */
export function a2aProtocolErrorData(reason: string): unknown[] {
  return [
    {
      "@type": A2A_ERROR_INFO_TYPE,
      domain: A2A_ERROR_DOMAIN,
      reason,
      metadata: {},
    },
  ];
}

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
    case "content_type_not_supported":
      // A message part whose media type the agent does not support is A2A
      // ContentTypeNotSupportedError.
      return { code: -32005, a2a: { reason: "CONTENT_TYPE_NOT_SUPPORTED" } };
    case "unsupported_operation":
      // An operation the task's current state cannot accept (e.g. a message
      // to a terminal task) is A2A UnsupportedOperationError.
      return { code: -32004, a2a: { reason: "UNSUPPORTED_OPERATION" } };
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
    case "task_lineage_cycle":
      return { code: -32015 };
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
