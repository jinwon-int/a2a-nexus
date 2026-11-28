/**
 * Broker access for the MCP Tasks server (a2a-nexus #2591, design §3/§4.2).
 *
 * The server reaches the broker ONLY through JSON-RPC `POST /a2a/jsonrpc`
 * (`SendMessage`, `GetTask`, `CancelTask`) with a fixed, non-operator
 * requester identity. It never calls REST `GET /tasks/:id`, which has no
 * task-party check (design §2, open question Q2). Every call is a fresh broker
 * round trip: the broker's own task-party check is the authorization.
 */
import { randomUUID } from "node:crypto";

export const BROKER_JSONRPC_PATH = "/a2a/jsonrpc";
export const BROKER_A2A_VERSION = "1.0";
export const BROKER_CALL_TIMEOUT_MS = 15_000;

/** A2A JSON-RPC codes the broker raises that mean "this caller may not see this task (or it does not exist)". */
export const BROKER_TASK_INVISIBLE_CODES: ReadonlySet<number> = new Set([-32001, -32011]);
/** CancelTask by a non-party is a policy denial; for this server it must read like an unknown task. */
export const BROKER_CANCEL_DENIED_CODE = -32012;
/** A2A TaskNotCancelableError: the task is already terminal. */
export const BROKER_TASK_NOT_CANCELABLE_CODE = -32002;

export interface BrokerIdentity {
  id: string;
  /** Same vocabulary as the broker's A2APartyKind. */
  kind: "session" | "node" | "user" | "service";
  role: string;
}

/** Proto-JSON A2A Task as projected by the broker (`projectSpecTask`). Only the fields the server reads. */
export interface SpecTask {
  id: string;
  contextId?: string;
  status: { state: string; timestamp?: string; message?: { parts?: Array<Record<string, unknown>> } };
  artifacts?: Array<{ artifactId?: string; parts?: Array<Record<string, unknown>> }>;
  metadata?: Record<string, unknown>;
}

export interface DispatchRequest {
  text: string;
  targetNodeId: string;
}

/** A broker call failed at the protocol level (transport, non-2xx, malformed body, or a JSON-RPC error). */
export class BrokerRpcError extends Error {
  readonly rpcCode: number | undefined;
  constructor(message: string, rpcCode?: number) {
    super(message);
    this.name = "BrokerRpcError";
    this.rpcCode = rpcCode;
  }
}

export interface BrokerRpcClient {
  /** JSON-RPC SendMessage on a new context; the broker assigns the task id. */
  dispatchAnalysis(request: DispatchRequest): Promise<SpecTask>;
  /** JSON-RPC GetTask; `undefined` when the broker says not found or not visible to this identity. */
  getTask(taskId: string): Promise<SpecTask | undefined>;
  /** JSON-RPC CancelTask; `"invisible"` / `"terminal"` mirror the broker's refusal. */
  cancelTask(taskId: string): Promise<"ok" | "invisible" | "terminal">;
}

/** One JSON-RPC exchange: `(method, params) => result`, throwing {@link BrokerRpcError} on any failure. */
export type JsonRpcCall = (method: string, params: Record<string, unknown>) => Promise<unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asSpecTask(value: unknown): SpecTask {
  if (!isRecord(value) || typeof value.id !== "string" || !isRecord(value.status) || typeof value.status.state !== "string") {
    throw new BrokerRpcError("broker returned a malformed task");
  }
  return value as unknown as SpecTask;
}

/**
 * Broker client over any {@link JsonRpcCall}. The HTTP transport below and
 * the in-process test broker both plug in here, so the method/param shapes
 * are exercised by the same code in tests and in a later live adapter.
 */
export class JsonRpcBrokerClient implements BrokerRpcClient {
  constructor(private readonly call: JsonRpcCall, private readonly newMessageId: () => string = randomUUID) {}

  async dispatchAnalysis(request: DispatchRequest): Promise<SpecTask> {
    const result = await this.call("SendMessage", {
      message: { messageId: this.newMessageId(), role: "ROLE_USER", parts: [{ text: request.text }] },
      // Source-only analysis only (design §5): the intent is fixed here, never taken from the tool input.
      metadata: { targetNodeId: request.targetNodeId, intent: "analyze" },
    });
    if (!isRecord(result) || !("task" in result)) throw new BrokerRpcError("broker did not create a task");
    return asSpecTask(result.task);
  }

  async getTask(taskId: string): Promise<SpecTask | undefined> {
    try {
      return asSpecTask(await this.call("GetTask", { id: taskId }));
    } catch (error) {
      if (error instanceof BrokerRpcError && error.rpcCode !== undefined && BROKER_TASK_INVISIBLE_CODES.has(error.rpcCode)) return undefined;
      throw error;
    }
  }

  async cancelTask(taskId: string): Promise<"ok" | "invisible" | "terminal"> {
    try {
      await this.call("CancelTask", { id: taskId, reason: "mcp tasks/cancel" });
      return "ok";
    } catch (error) {
      if (error instanceof BrokerRpcError && error.rpcCode !== undefined) {
        if (BROKER_TASK_INVISIBLE_CODES.has(error.rpcCode) || error.rpcCode === BROKER_CANCEL_DENIED_CODE) return "invisible";
        if (error.rpcCode === BROKER_TASK_NOT_CANCELABLE_CODE) return "terminal";
      }
      throw error;
    }
  }
}

export interface HttpJsonRpcOptions {
  /** Broker base URL on the operator node's existing private path, e.g. a loopback tunnel. */
  baseUrl: string;
  /** Shared edge secret. Sent only as the `x-a2a-edge-secret` header; never logged or echoed. */
  edgeSecret: string;
  identity: BrokerIdentity;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** The single endpoint the server may call. Anything but `http(s)` with no credentials, query, or fragment is refused. */
export function brokerJsonRpcEndpoint(baseUrl: string): URL {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new BrokerRpcError("broker base URL is not a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new BrokerRpcError("broker base URL must be http or https");
  if (url.username || url.password || url.search || url.hash) throw new BrokerRpcError("broker base URL must not carry credentials, query, or fragment");
  return new URL(BROKER_JSONRPC_PATH, url);
}

/** JSON-RPC over HTTP POST to {@link BROKER_JSONRPC_PATH}. No other route is reachable through this transport. */
export function httpJsonRpcCall(options: HttpJsonRpcOptions): JsonRpcCall {
  const endpoint = brokerJsonRpcEndpoint(options.baseUrl);
  if (!options.edgeSecret) throw new BrokerRpcError("edge secret is empty");
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? BROKER_CALL_TIMEOUT_MS;
  let nextId = 1;
  return async (method, params) => {
    const id = nextId++;
    let response: Response;
    try {
      response = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "a2a-version": BROKER_A2A_VERSION,
          "x-a2a-edge-secret": options.edgeSecret,
          "x-a2a-requester-id": options.identity.id,
          "x-a2a-requester-kind": options.identity.kind,
          "x-a2a-requester-role": options.identity.role,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      // The transport error text could carry the URL; report a fixed message only.
      throw new BrokerRpcError(`broker ${method} transport failure`);
    }
    if (!response.ok) throw new BrokerRpcError(`broker ${method} HTTP ${response.status}`);
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new BrokerRpcError(`broker ${method} returned non-JSON`);
    }
    if (!isRecord(body) || body.id !== id) throw new BrokerRpcError(`broker ${method} returned a mismatched response`);
    if (isRecord(body.error)) {
      const code = typeof body.error.code === "number" ? body.error.code : undefined;
      throw new BrokerRpcError(`broker ${method} error ${code ?? "unknown"}`, code);
    }
    if (!("result" in body)) throw new BrokerRpcError(`broker ${method} returned no result`);
    return body.result;
  };
}
