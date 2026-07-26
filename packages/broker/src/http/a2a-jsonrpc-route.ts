// A2A JSON-RPC transport route (POST /a2a/jsonrpc), extracted from the server
// request closure into an explicit-context handler (continuing the #645
// dispatcher migration). This is the A2A 1.0 JSON-RPC endpoint: it negotiates
// the protocol version, special-cases single SendStreamingMessage requests onto
// an SSE response, and otherwise delegates the (possibly batched) body to the
// shared JSON-RPC executor. The execution options mirror ExecuteJsonRpcOptions,
// so the route context carries that same collaborator bundle.
import type { IncomingMessage, ServerResponse } from "node:http";

import { InMemoryA2ABroker } from "../core/broker.js";
import type { RequesterIdentity } from "../core/request-security.js";
import type { AgentCard } from "../a2a/agent-card.js";
import { PushNotificationConfigStore } from "../a2a/push-notification-config.js";
import { PeerStatusService } from "../a2a/peer-status.js";
import {
  a2aProtocolErrorData,
  executeA2AJsonRpcBody,
  executeSendMessage,
  jsonRpcErrorFromUnknown,
  specSendResult,
} from "../a2a/json-rpc.js";
import {
  A2A_VERSION_HEADER,
  SUPPORTED_A2A_VERSIONS,
  negotiateA2AVersion,
} from "../a2a/version-negotiation.js";
import { readRawBody } from "./body.js";
import { handleStreamingMessageResponse, parseSingleStreamingMessageRequest } from "./streaming-message.js";
import { sendJson } from "./response.js";

export interface A2AJsonRpcRouteContext {
  method: string | undefined;
  path: string;
  req: IncomingMessage;
  res: ServerResponse;
  broker: InMemoryA2ABroker;
  agentCard: AgentCard;
  publicBaseUrl: string;
  requesterIdentity: RequesterIdentity | null;
  enforceRequesterIdentity: boolean;
  peerStatusService?: PeerStatusService;
  pushNotificationConfigStore?: PushNotificationConfigStore;
  persistPushNotificationConfigs?: () => void;
  defaultAgentNodeId?: string;
  taskSubscribeHeartbeatSec: number;
}

/** POST /a2a/jsonrpc — A2A 1.0 JSON-RPC transport (unary, batch, and streaming). */
export async function handleA2AJsonRpcRequest(ctx: A2AJsonRpcRouteContext): Promise<void> {
  const { req, res, broker } = ctx;
  const executeOptions = {
    broker,
    agentCard: ctx.agentCard,
    publicBaseUrl: ctx.publicBaseUrl,
    requesterIdentity: ctx.requesterIdentity,
    enforceRequesterIdentity: ctx.enforceRequesterIdentity,
    peerStatusService: ctx.peerStatusService,
    pushNotificationConfigStore: ctx.pushNotificationConfigStore,
    persistPushNotificationConfigs: ctx.persistPushNotificationConfigs,
    defaultAgentNodeId: ctx.defaultAgentNodeId,
  };

  // A2A 1.0 version negotiation: serve the requested version's
  // semantics or fail closed on a version we cannot honor. The
  // response always advertises the version actually served.
  const negotiated = negotiateA2AVersion(req.headers[A2A_VERSION_HEADER]);
  if (!negotiated.ok) {
    sendJson(
      res,
      400,
      {
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32009,
          message: negotiated.message,
          data: a2aProtocolErrorData("VERSION_NOT_SUPPORTED"),
        },
      },
      { "a2a-version": SUPPORTED_A2A_VERSIONS.join(", ") },
    );
    return;
  }
  res.setHeader("a2a-version", negotiated.version);
  // Explicit version negotiation opts the client into A2A 1.0 result
  // shapes; header-less legacy clients keep the historical envelopes.
  const responseShape = negotiated.requested !== null ? "spec" as const : "legacy" as const;
  // A2A 1.0 ContentTypeNotSupportedError (-32005): the JSON-RPC endpoint
  // requires an application/json Content-Type. A wrong content type is a
  // content-type error, not a JSON parse error (-32700).
  const contentType = (req.headers["content-type"] ?? "").toLowerCase();
  if (!contentType.startsWith("application/json")) {
    sendJson(res, 200, {
      jsonrpc: "2.0",
      id: null,
      error: {
        code: -32005,
        message: `unsupported content type: ${contentType || "(none)"}`,
        data: a2aProtocolErrorData("CONTENT_TYPE_NOT_SUPPORTED"),
      },
    });
    return;
  }
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
      created = executeSendMessage(streamingRequest.params, executeOptions);
    } catch (error) {
      const rpcError = jsonRpcErrorFromUnknown(error);
      sendJson(res, 200, {
        jsonrpc: "2.0",
        id: streamingRequest.id,
        error: rpcError,
      });
      return;
    }
    const createdTask = created.task ? broker.getTask(created.task.id) : null;
    if (!createdTask) {
      // Context-only sends (no active task) have nothing to stream.
      const contextResult = responseShape === "spec" ? specSendResult(created, broker) : created;
      sendJson(res, 200, { jsonrpc: "2.0", id: streamingRequest.id, result: contextResult });
      return;
    }
    handleStreamingMessageResponse(req, res, {
      broker,
      rpcId: streamingRequest.id,
      sendResult: created,
      task: createdTask,
      heartbeatMs: ctx.taskSubscribeHeartbeatSec * 1000,
      responseShape,
    });
    return;
  }

  const response = executeA2AJsonRpcBody(rawBody, {
    ...executeOptions,
    responseShape,
  });
  if (response === null) {
    // Entirely notifications — JSON-RPC requires no response body.
    res.writeHead(204);
    res.end();
    return;
  }
  sendJson(res, 200, response);
}

/** Route dispatcher for the A2A JSON-RPC transport route. Returns true only when handled. */
export async function handleA2AJsonRpcRouteIfMatched(ctx: A2AJsonRpcRouteContext): Promise<boolean> {
  if (ctx.method === "POST" && (ctx.path === "/a2a/jsonrpc" || ctx.path === "/a2a/jsonrpc/")) {
    await handleA2AJsonRpcRequest(ctx);
    return true;
  }
  return false;
}
