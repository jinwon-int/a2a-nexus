/**
 * MCP Tasks server core — no-live (a2a-nexus #2591 design §7 step 2).
 *
 * Transport-agnostic JSON-RPC handler for the `io.modelcontextprotocol/tasks`
 * extension (revision 2026-07-28). It exposes one tool that dispatches a
 * source-only analysis request through broker JSON-RPC `SendMessage` and
 * always returns a task, plus `tasks/get`, `tasks/update`, and `tasks/cancel`
 * for tasks it created. Mapping comes from the facade contract v1
 * (`../a2a/mcp-tasks-facade.ts`) and is never re-derived here.
 *
 * Boundaries (design §3–§5), pinned by tests:
 * - The broker is reached only through a {@link BrokerRpcClient}; this module
 *   never imports broker core, the state store, or the HTTP server.
 * - The requester identity is fixed at construction and must not be `hub` or
 *   `operator`: construction throws, so the server refuses to start.
 * - Every task request is authorized twice: the created-task set, then one
 *   fresh broker call whose task-party check is the real authorization.
 * - No MCP path changes an approval or an operator checkpoint (`tasks/update`
 *   is acknowledged and ignored for operator decisions, G3). Only a
 *   clarification (`ambiguous_scope`) answer is delivered, as a context
 *   message the broker itself authorizes (#2606, #2595).
 */
import { evaluateMcpTaskInputResponse, isValidMcpTaskId, mcpInputRequestsForTask, projectMcpTask, type McpTask } from "../a2a/mcp-tasks-facade.js";
import { BrokerRpcError, type BrokerIdentity, type BrokerRpcClient, type SpecTask } from "./broker-client.js";
import type { CreatedTaskStore } from "./created-task-store.js";
import { SpecTaskShapeError, callToolResultForSpec, facadeTaskFromSpec } from "./spec-task.js";

export const MCP_TASKS_EXTENSION_ID = "io.modelcontextprotocol/tasks";
export const MCP_CLIENT_CAPABILITIES_META_KEY = "io.modelcontextprotocol/clientCapabilities";
export const MCP_PROTOCOL_VERSION = "2026-07-28";
export const MCP_TASKS_SERVER_NAME = "a2a-mcp-tasks-server";
export const DISPATCH_TOOL_NAME = "a2a_dispatch_analysis";
export const DISPATCH_PROMPT_MAX_LENGTH = 8_000;

export const JSONRPC_PARSE_ERROR = -32700;
export const JSONRPC_INVALID_REQUEST = -32600;
export const JSONRPC_METHOD_NOT_FOUND = -32601;
export const JSONRPC_INVALID_PARAMS = -32602;
export const JSONRPC_INTERNAL_ERROR = -32603;
/** MCP: Missing Required Client Capability. */
export const MCP_MISSING_CLIENT_CAPABILITY = -32021;

const PRIVILEGED_ROLES = new Set(["hub", "operator"]);
const IDENTITY_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const NODE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export type JsonRpcId = string | number | null;
export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: unknown;
}
export type JsonRpcResponse =
  | { jsonrpc: "2.0"; id: JsonRpcId; result: unknown }
  | { jsonrpc: "2.0"; id: JsonRpcId; error: { code: number; message: string } };

/** Closed-vocabulary log event. Never carries task text, input payloads, ids of other tasks, or credentials. */
export interface McpTasksLogEvent {
  method: string;
  reason: string;
}

export class McpTasksServerConfigError extends Error {
  constructor(reason: string) {
    super(`MCP Tasks server refuses to start: ${reason}`);
    this.name = "McpTasksServerConfigError";
  }
}

export interface McpTasksServerOptions {
  broker: BrokerRpcClient;
  /** The fixed requester identity the broker client sends. Checked here so the server refuses a privileged one. */
  identity: BrokerIdentity;
  store: CreatedTaskStore;
  /** Worker node ids the dispatch tool may target (the operator's existing lane allowlist). */
  allowedTargetNodeIds: readonly string[];
  log?: (event: McpTasksLogEvent) => void;
  serverVersion?: string;
}

/** Design §4.2: a hub or operator identity would let the player sit in the judge's seat. */
export function assertServerIdentity(identity: BrokerIdentity): void {
  if (!identity || typeof identity.id !== "string" || !IDENTITY_ID_PATTERN.test(identity.id)) {
    throw new McpTasksServerConfigError("requester id is missing or malformed");
  }
  const role = typeof identity.role === "string" ? identity.role.trim().toLowerCase() : "";
  if (!role) throw new McpTasksServerConfigError("requester role is missing");
  if (PRIVILEGED_ROLES.has(role)) throw new McpTasksServerConfigError("requester role must not be hub or operator");
}

class RpcError extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True when the request's `_meta` declares the tasks extension (object keyed by id, or a list of ids). */
export function declaresTasksExtension(params: unknown): boolean {
  if (!isRecord(params) || !isRecord(params._meta)) return false;
  const caps = params._meta[MCP_CLIENT_CAPABILITIES_META_KEY];
  if (!isRecord(caps)) return false;
  const extensions = caps.extensions;
  if (Array.isArray(extensions)) return extensions.includes(MCP_TASKS_EXTENSION_ID);
  return isRecord(extensions) && Object.prototype.hasOwnProperty.call(extensions, MCP_TASKS_EXTENSION_ID);
}

/** Wire fields only: facade annotations (`waitKind`, `toolOutcome`) never leave the server. */
function wireTask(task: McpTask): Record<string, unknown> {
  const { taskId, status, statusMessage, createdAt, lastUpdatedAt, ttlMs, pollIntervalMs } = task;
  return { taskId, status, statusMessage, createdAt, lastUpdatedAt, ttlMs, pollIntervalMs };
}

export class McpTasksServer {
  private readonly broker: BrokerRpcClient;
  private readonly store: CreatedTaskStore;
  private readonly allowedTargets: ReadonlySet<string>;
  private readonly log: (event: McpTasksLogEvent) => void;
  private readonly serverVersion: string;

  constructor(options: McpTasksServerOptions) {
    assertServerIdentity(options.identity);
    const targets = options.allowedTargetNodeIds ?? [];
    if (targets.length === 0 || !targets.every((id) => NODE_ID_PATTERN.test(id))) {
      throw new McpTasksServerConfigError("allowed target node list is empty or malformed");
    }
    this.broker = options.broker;
    this.store = options.store;
    this.allowedTargets = new Set(targets);
    this.log = options.log ?? (() => {});
    this.serverVersion = options.serverVersion ?? "0.1.0";
  }

  /** Handles one JSON-RPC message. Returns `undefined` for a notification (no `id`). */
  async handle(message: unknown): Promise<JsonRpcResponse | undefined> {
    if (!isRecord(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
      return { jsonrpc: "2.0", id: null, error: { code: JSONRPC_INVALID_REQUEST, message: "invalid request" } };
    }
    const isNotification = !("id" in message);
    const id = (isNotification ? null : message.id) as JsonRpcId;
    try {
      const result = await this.dispatch(message.method, message.params);
      return isNotification ? undefined : { jsonrpc: "2.0", id, result };
    } catch (error) {
      if (isNotification) return undefined;
      if (error instanceof RpcError) return { jsonrpc: "2.0", id, error: { code: error.code, message: error.message } };
      // Unexpected failures report a fixed message; the original text may carry broker detail.
      this.log({ method: message.method, reason: "internal_error" });
      return { jsonrpc: "2.0", id, error: { code: JSONRPC_INTERNAL_ERROR, message: "internal error" } };
    }
  }

  private capabilities(): Record<string, unknown> {
    return { tools: {}, extensions: { [MCP_TASKS_EXTENSION_ID]: {} } };
  }

  private async dispatch(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case "initialize":
        return {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: this.capabilities(),
          serverInfo: { name: MCP_TASKS_SERVER_NAME, version: this.serverVersion },
        };
      case "server/discover":
        return { capabilities: this.capabilities(), serverInfo: { name: MCP_TASKS_SERVER_NAME, version: this.serverVersion } };
      case "notifications/initialized":
      case "ping":
        return {};
      case "tools/list":
        return { tools: [this.dispatchToolDefinition()] };
      case "tools/call":
        return this.toolsCall(params);
      case "tasks/get":
        return this.tasksGet(params);
      case "tasks/update":
        return this.tasksUpdate(params);
      case "tasks/cancel":
        return this.tasksCancel(params);
      default:
        // Methods from the earlier core revision (tasks/result, tasks/list) are deliberately absent.
        throw new RpcError(JSONRPC_METHOD_NOT_FOUND, "method not found");
    }
  }

  private dispatchToolDefinition(): Record<string, unknown> {
    return {
      name: DISPATCH_TOOL_NAME,
      description: "Dispatch a source-only analysis request to an A2A worker. Always returns a task; poll it with tasks/get.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["prompt", "targetNodeId"],
        properties: {
          prompt: { type: "string", minLength: 1, maxLength: DISPATCH_PROMPT_MAX_LENGTH },
          targetNodeId: { type: "string", enum: [...this.allowedTargets] },
        },
      },
    };
  }

  private requireCapability(method: string, params: unknown): void {
    if (!declaresTasksExtension(params)) {
      this.log({ method, reason: "missing_client_capability" });
      throw new RpcError(MCP_MISSING_CLIENT_CAPABILITY, `client must declare ${MCP_TASKS_EXTENSION_ID}`);
    }
  }

  /** G4 + design §4.3 item 2: only ids this server created reach the broker; everything else is "not found". */
  private requireOwnTaskId(method: string, params: unknown): string {
    const taskId = isRecord(params) ? params.taskId : undefined;
    if (!isValidMcpTaskId(taskId) || !this.store.has(taskId)) {
      this.log({ method, reason: "unknown_task" });
      throw new RpcError(JSONRPC_INVALID_PARAMS, "unknown taskId");
    }
    return taskId;
  }

  /** One fresh broker read per request; a task the broker hides is the same "not found". */
  private async readTask(method: string, taskId: string): Promise<SpecTask> {
    let spec: SpecTask | undefined;
    try {
      spec = await this.broker.getTask(taskId);
    } catch (error) {
      this.log({ method, reason: error instanceof BrokerRpcError ? "broker_protocol_error" : "broker_error" });
      throw new RpcError(JSONRPC_INTERNAL_ERROR, "broker call failed");
    }
    if (!spec || spec.id !== taskId) {
      this.log({ method, reason: "broker_task_invisible" });
      throw new RpcError(JSONRPC_INVALID_PARAMS, "unknown taskId");
    }
    return spec;
  }

  private project(method: string, spec: SpecTask): McpTask {
    try {
      return projectMcpTask(facadeTaskFromSpec(spec));
    } catch (error) {
      this.log({ method, reason: error instanceof SpecTaskShapeError ? "broker_projection_unknown" : "projection_refused" });
      throw new RpcError(JSONRPC_INTERNAL_ERROR, "broker task could not be projected");
    }
  }

  private async toolsCall(params: unknown): Promise<unknown> {
    this.requireCapability("tools/call", params);
    if (!isRecord(params) || params.name !== DISPATCH_TOOL_NAME) throw new RpcError(JSONRPC_INVALID_PARAMS, "unknown tool");
    const args = params.arguments;
    if (!isRecord(args) || Object.keys(args).some((key) => key !== "prompt" && key !== "targetNodeId")) {
      throw new RpcError(JSONRPC_INVALID_PARAMS, "tool arguments must be exactly prompt and targetNodeId");
    }
    const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
    if (!prompt || prompt.length > DISPATCH_PROMPT_MAX_LENGTH) throw new RpcError(JSONRPC_INVALID_PARAMS, "prompt is empty or too long");
    if (typeof args.targetNodeId !== "string" || !this.allowedTargets.has(args.targetNodeId)) {
      this.log({ method: "tools/call", reason: "target_not_allowed" });
      throw new RpcError(JSONRPC_INVALID_PARAMS, "targetNodeId is not an allowed analysis lane");
    }

    let spec: SpecTask;
    try {
      spec = await this.broker.dispatchAnalysis({ text: prompt, targetNodeId: args.targetNodeId });
    } catch (error) {
      // G1: the server's own broker call failed at the protocol level. No task exists, so it is a JSON-RPC error.
      this.log({ method: "tools/call", reason: error instanceof BrokerRpcError ? "broker_protocol_error" : "broker_error" });
      throw new RpcError(JSONRPC_INTERNAL_ERROR, "broker did not accept the dispatch");
    }
    const task = this.project("tools/call", spec);
    // Recorded only after the id passed the facade's G4 check inside projectMcpTask.
    this.store.add(task.taskId);
    return { resultType: "task", ...wireTask(task) };
  }

  private async tasksGet(params: unknown): Promise<unknown> {
    this.requireCapability("tasks/get", params);
    const taskId = this.requireOwnTaskId("tasks/get", params);
    const spec = await this.readTask("tasks/get", taskId);
    const task = this.project("tasks/get", spec);
    const wire = wireTask(task);
    if (task.status === "completed") {
      const result = callToolResultForSpec(spec);
      if (result) wire.result = result;
    }
    // Only a clarification wait carries inputRequests (one key per checkpoint, G2); operator waits never do (G3).
    if (task.status === "input_required") {
      const inputRequests = mcpInputRequestsForTask(facadeTaskFromSpec(spec));
      if (inputRequests) wire.inputRequests = inputRequests;
    }
    return wire;
  }

  private async tasksUpdate(params: unknown): Promise<unknown> {
    this.requireCapability("tasks/update", params);
    const taskId = this.requireOwnTaskId("tasks/update", params);
    const spec = await this.readTask("tasks/update", taskId);
    const inputResponses = isRecord(params) ? params.inputResponses : undefined;
    const verdict = evaluateMcpTaskInputResponse(facadeTaskFromSpec(spec), inputResponses);
    if (!verdict.accepted) {
      // G3: acknowledged with an empty result and ignored; only the reason code is logged, never the payload.
      this.log({ method: "tasks/update", reason: verdict.reason });
      return {};
    }
    // #2606: deliver the answer to the outstanding clarification checkpoint on the task's own context.
    if (typeof spec.contextId !== "string" || !spec.contextId) {
      this.log({ method: "tasks/update", reason: "missing_context" });
      throw new RpcError(JSONRPC_INTERNAL_ERROR, "task has no context to deliver to");
    }
    try {
      await this.broker.answerClarification({ taskId, contextId: spec.contextId, text: verdict.text });
    } catch (error) {
      this.log({ method: "tasks/update", reason: error instanceof BrokerRpcError ? "broker_protocol_error" : "broker_error" });
      throw new RpcError(JSONRPC_INTERNAL_ERROR, "broker did not accept the clarification");
    }
    this.log({ method: "tasks/update", reason: "clarification_delivered" });
    return {};
  }

  private async tasksCancel(params: unknown): Promise<unknown> {
    this.requireCapability("tasks/cancel", params);
    const taskId = this.requireOwnTaskId("tasks/cancel", params);
    let outcome: "ok" | "invisible" | "terminal";
    try {
      outcome = await this.broker.cancelTask(taskId);
    } catch (error) {
      this.log({ method: "tasks/cancel", reason: error instanceof BrokerRpcError ? "broker_protocol_error" : "broker_error" });
      throw new RpcError(JSONRPC_INTERNAL_ERROR, "broker call failed");
    }
    if (outcome === "invisible") {
      this.log({ method: "tasks/cancel", reason: "broker_task_invisible" });
      throw new RpcError(JSONRPC_INVALID_PARAMS, "unknown taskId");
    }
    // Cooperative: the status becomes `cancelled` on a later tasks/get once the broker state changed.
    this.log({ method: "tasks/cancel", reason: outcome === "terminal" ? "already_terminal" : "cancel_forwarded" });
    return {};
  }
}
