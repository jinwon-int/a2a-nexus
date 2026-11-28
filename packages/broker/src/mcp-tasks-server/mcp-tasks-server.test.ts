// MCP Tasks server, no-live conformance (a2a-nexus #2591 design §7 step 2).
// The fake broker is the real InMemoryA2ABroker behind the real JSON-RPC
// handler with requester identity enforced, so the task-party check is the
// broker's own, not a stub.

import { randomUUID } from "node:crypto";
import { chmodSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test, { after } from "node:test";
import assert from "node:assert/strict";

import { createBrokerAgentCard } from "../a2a/agent-card.js";
import { executeA2AJsonRpc } from "../a2a/json-rpc.js";
import { MCP_OPERATOR_WAIT_POLL_INTERVAL_MS, isValidMcpTaskId } from "../a2a/mcp-tasks-facade.js";
import { InMemoryA2ABroker } from "../core/broker.js";
import { registerWorker } from "../core/broker-test-helpers.js";
import {
  BROKER_JSONRPC_PATH,
  BrokerRpcError,
  CREATED_TASK_STORE_SCHEMA,
  CreatedTaskStoreError,
  DISPATCH_TOOL_NAME,
  FileCreatedTaskStore,
  InMemoryCreatedTaskStore,
  JSONRPC_INTERNAL_ERROR,
  JSONRPC_INVALID_PARAMS,
  JSONRPC_METHOD_NOT_FOUND,
  JSONRPC_PARSE_ERROR,
  JSONRPC_INVALID_REQUEST,
  JsonRpcBrokerClient,
  MCP_CLIENT_CAPABILITIES_META_KEY,
  MCP_MISSING_CLIENT_CAPABILITY,
  MCP_RESULT_TEXT_MAX_CHARS,
  MCP_TASKS_EXTENSION_ID,
  McpTasksServer,
  McpTasksServerConfigError,
  brokerJsonRpcEndpoint,
  handleStdioLine,
  httpJsonRpcCall,
  serveStdio,
  type BrokerIdentity,
  type CreatedTaskStore,
  type JsonRpcCall,
  type JsonRpcResponse,
  type McpTasksLogEvent,
} from "./index.js";

const agentCard = createBrokerAgentCard({ serviceName: "test-broker", publicBaseUrl: "https://broker.test/" });
const IDENTITY: BrokerIdentity = { id: "node-a", kind: "node", role: "analyst" };
const CAPS = { _meta: { [MCP_CLIENT_CAPABILITIES_META_KEY]: { extensions: { [MCP_TASKS_EXTENSION_ID]: {} } } } };
const FAKE_TOKEN = `ghp_${"A1b2C3d4".repeat(5)}`;

// Every temp directory is removed after the file's tests (#2386 mkdtemp cleanup guard).
const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mcp-tasks-store-"));
  tempDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

interface Harness {
  broker: InMemoryA2ABroker;
  server: McpTasksServer;
  store: CreatedTaskStore;
  calls: string[];
  logs: McpTasksLogEvent[];
  rpc(method: string, params?: unknown): Promise<JsonRpcResponse>;
  dispatch(prompt?: string): Promise<string>;
}

function brokerCall(broker: InMemoryA2ABroker, identity: BrokerIdentity, calls: string[]): JsonRpcCall {
  return async (method, params) => {
    calls.push(method);
    const response = executeA2AJsonRpc(
      { jsonrpc: "2.0", id: calls.length, method, params },
      // The server types role as a plain string; the broker narrows it. Same runtime value.
      { broker, agentCard, requesterIdentity: identity as never, enforceRequesterIdentity: true, responseShape: "spec" },
    );
    if ("error" in response) throw new BrokerRpcError(`broker ${method} error`, response.error.code);
    return response.result;
  };
}

function harness(options: { store?: CreatedTaskStore; call?: JsonRpcCall } = {}): Harness {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "worker-a");
  registerWorker(broker, "worker-b");
  const calls: string[] = [];
  const logs: McpTasksLogEvent[] = [];
  const store = options.store ?? new InMemoryCreatedTaskStore();
  const server = new McpTasksServer({
    broker: new JsonRpcBrokerClient(options.call ?? brokerCall(broker, IDENTITY, calls)),
    identity: IDENTITY,
    store,
    allowedTargetNodeIds: ["worker-a"],
    log: (event) => logs.push(event),
  });
  let id = 0;
  const rpc = async (method: string, params?: unknown) => (await server.handle({ jsonrpc: "2.0", id: ++id, method, params }))!;
  const dispatch = async (prompt = "summarise the build failure") => {
    const response = await rpc("tools/call", { ...CAPS, name: DISPATCH_TOOL_NAME, arguments: { prompt, targetNodeId: "worker-a" } });
    assert.ok("result" in response, JSON.stringify(response));
    return (response.result as { taskId: string }).taskId;
  };
  return { broker, server, store, calls, logs, rpc, dispatch };
}

function errorCode(response: JsonRpcResponse): number | undefined {
  return "error" in response ? response.error.code : undefined;
}

function result<T = Record<string, unknown>>(response: JsonRpcResponse): T {
  assert.ok("result" in response, JSON.stringify(response));
  return response.result as T;
}

// ---------------------------------------------------------------------------
// Start-up refusals (design §4.2)
// ---------------------------------------------------------------------------

test("refuses to start with a hub or operator identity, a missing role, or a malformed id", () => {
  const base = { broker: new JsonRpcBrokerClient(async () => ({})), store: new InMemoryCreatedTaskStore(), allowedTargetNodeIds: ["worker-a"] };
  for (const identity of [
    { id: "node-a", kind: "node", role: "operator" },
    { id: "node-a", kind: "node", role: "hub" },
    { id: "node-a", kind: "node", role: " Operator " },
    { id: "node-a", kind: "node", role: "" },
    { id: "", kind: "node", role: "analyst" },
    { id: "bad id", kind: "node", role: "analyst" },
  ] as BrokerIdentity[]) {
    assert.throws(() => new McpTasksServer({ ...base, identity }), McpTasksServerConfigError, JSON.stringify(identity));
  }
  assert.throws(() => new McpTasksServer({ ...base, identity: IDENTITY, allowedTargetNodeIds: [] }), McpTasksServerConfigError);
  assert.doesNotThrow(() => new McpTasksServer({ ...base, identity: IDENTITY }));
});

// ---------------------------------------------------------------------------
// Discovery and capability gate
// ---------------------------------------------------------------------------

test("initialize and server/discover advertise the tasks extension; obsolete methods are absent", async () => {
  const h = harness();
  for (const method of ["initialize", "server/discover"]) {
    const caps = result<{ capabilities: { extensions: Record<string, unknown> } }>(await h.rpc(method, {})).capabilities;
    assert.ok(MCP_TASKS_EXTENSION_ID in caps.extensions, method);
  }
  const tools = result<{ tools: Array<{ name: string }> }>(await h.rpc("tools/list", {})).tools;
  assert.deepEqual(tools.map((tool) => tool.name), [DISPATCH_TOOL_NAME]);
  for (const method of ["tasks/result", "tasks/list", "notifications/tasks/status"]) {
    assert.equal(errorCode(await h.rpc(method, CAPS)), JSONRPC_METHOD_NOT_FOUND, method);
  }
});

test("every task method requires the declared client capability (-32021)", async () => {
  const h = harness();
  const taskId = await h.dispatch();
  const before = h.calls.length;
  const bare = [
    ["tools/call", { name: DISPATCH_TOOL_NAME, arguments: { prompt: "x", targetNodeId: "worker-a" } }],
    ["tasks/get", { taskId }],
    ["tasks/update", { taskId, inputResponses: {} }],
    ["tasks/cancel", { taskId }],
  ] as const;
  for (const [method, params] of bare) {
    assert.equal(errorCode(await h.rpc(method, params)), MCP_MISSING_CLIENT_CAPABILITY, method);
    const wrong = { ...params, _meta: { [MCP_CLIENT_CAPABILITIES_META_KEY]: { extensions: { "io.example/other": {} } } } };
    assert.equal(errorCode(await h.rpc(method, wrong)), MCP_MISSING_CLIENT_CAPABILITY, `${method} other extension`);
  }
  assert.equal(h.calls.length, before, "a refused request never reaches the broker");
  // The list form of extensions is accepted too.
  const listForm = { taskId, _meta: { [MCP_CLIENT_CAPABILITIES_META_KEY]: { extensions: [MCP_TASKS_EXTENSION_ID] } } };
  assert.equal(result<{ taskId: string }>(await h.rpc("tasks/get", listForm)).taskId, taskId);
});

// ---------------------------------------------------------------------------
// Dispatch tool
// ---------------------------------------------------------------------------

test("tools/call always returns a CreateTaskResult for a broker-assigned UUID, as a source-only analysis", async () => {
  const h = harness();
  const created = result(await h.rpc("tools/call", { ...CAPS, name: DISPATCH_TOOL_NAME, arguments: { prompt: "  why did CI fail  ", targetNodeId: "worker-a" } }));
  assert.equal(created.resultType, "task");
  assert.equal(created.status, "working");
  assert.equal(created.ttlMs, null);
  assert.ok(isValidMcpTaskId(created.taskId), String(created.taskId));
  assert.ok(!("waitKind" in created) && !("toolOutcome" in created), "facade annotations stay inside the server");
  assert.ok(h.store.has(created.taskId as string));
  const record = h.broker.getTask(created.taskId as string)!;
  assert.equal(record.intent, "analyze");
  assert.equal(record.requester.id, IDENTITY.id);
  assert.equal(record.targetNodeId, "worker-a");
  assert.deepEqual(h.calls, ["SendMessage"]);
});

test("tools/call refuses unknown tools, extra arguments, empty prompts, and targets outside the allowlist", async () => {
  const h = harness();
  const cases: unknown[] = [
    { ...CAPS, name: "a2a_dispatch_patch", arguments: { prompt: "x", targetNodeId: "worker-a" } },
    { ...CAPS, name: DISPATCH_TOOL_NAME, arguments: { prompt: "x", targetNodeId: "worker-a", intent: "promote_to_live" } },
    { ...CAPS, name: DISPATCH_TOOL_NAME, arguments: { prompt: "   ", targetNodeId: "worker-a" } },
    { ...CAPS, name: DISPATCH_TOOL_NAME, arguments: { prompt: "x".repeat(8_001), targetNodeId: "worker-a" } },
    { ...CAPS, name: DISPATCH_TOOL_NAME, arguments: { prompt: "x", targetNodeId: "worker-b" } },
    { ...CAPS, name: DISPATCH_TOOL_NAME },
  ];
  for (const params of cases) {
    assert.equal(errorCode(await h.rpc("tools/call", params)), JSONRPC_INVALID_PARAMS, JSON.stringify(params).slice(0, 120));
  }
  assert.deepEqual(h.calls, [], "nothing was sent to the broker");
});

test("G1: a broker protocol failure on dispatch is a JSON-RPC error and records no task", async () => {
  const calls: string[] = [];
  const h = harness({ call: async (method) => { calls.push(method); throw new BrokerRpcError("broker SendMessage HTTP 502"); } });
  const response = await h.rpc("tools/call", { ...CAPS, name: DISPATCH_TOOL_NAME, arguments: { prompt: "x", targetNodeId: "worker-a" } });
  assert.equal(errorCode(response), JSONRPC_INTERNAL_ERROR);
  assert.doesNotMatch(JSON.stringify(response), /502/);
  assert.deepEqual(h.logs, [{ method: "tools/call", reason: "broker_protocol_error" }]);
});

// ---------------------------------------------------------------------------
// Per-request authorization (design §4.3)
// ---------------------------------------------------------------------------

test("an id this session did not create is -32602 before any broker call, even if the broker would allow it", async () => {
  const h = harness();
  // Same requester, created outside this server: the broker's party check alone would pass.
  const outside = h.broker.createTask({
    intent: "analyze",
    requester: { id: IDENTITY.id, kind: "node", role: "analyst" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    message: "made elsewhere",
  });
  for (const taskId of [outside.id, randomUUID(), "task-0001", 42, undefined]) {
    for (const method of ["tasks/get", "tasks/update", "tasks/cancel"]) {
      const response = await h.rpc(method, { ...CAPS, taskId, inputResponses: {} });
      assert.equal(errorCode(response), JSONRPC_INVALID_PARAMS, `${method} ${String(taskId)}`);
      assert.match((response as { error: { message: string } }).error.message, /^unknown taskId$/);
    }
  }
  assert.deepEqual(h.calls, []);
});

test("a task the broker hides from this identity reads exactly like an unknown id", async () => {
  const h = harness();
  const foreign = h.broker.createTask({
    intent: "analyze",
    requester: { id: "someone-else", kind: "node", role: "analyst" },
    target: { id: "worker-b", kind: "node", role: "analyst" },
    message: "not yours",
  });
  h.store.add(foreign.id); // as if the set were tampered with: the broker still refuses
  for (const method of ["tasks/get", "tasks/cancel"]) {
    const response = await h.rpc(method, { ...CAPS, taskId: foreign.id });
    assert.equal(errorCode(response), JSONRPC_INVALID_PARAMS, method);
    assert.match((response as { error: { message: string } }).error.message, /^unknown taskId$/);
  }
  assert.equal(h.broker.getTask(foreign.id)!.status, "queued", "the refused cancel changed nothing");
});

test("every tasks/get is a fresh broker call (no cached read)", async () => {
  const h = harness();
  const taskId = await h.dispatch();
  h.calls.length = 0;
  for (let i = 0; i < 3; i += 1) await h.rpc("tasks/get", { ...CAPS, taskId });
  assert.deepEqual(h.calls, ["GetTask", "GetTask", "GetTask"]);
});

// ---------------------------------------------------------------------------
// Operator waits (G3) and tasks/update
// ---------------------------------------------------------------------------

function checkpoint(h: Harness, taskId: string, decisionType: string): void {
  h.broker.claimTask(taskId, "worker-a");
  h.broker.startTask(taskId, "worker-a");
  h.broker.checkpointTask(taskId, "worker-a", { state: "awaiting_operator", decisionType, reason: "SECRET-REASON" });
}

test("G3: an operator-decision checkpoint is working, has no inputRequests, and polls at the cap", async () => {
  for (const decisionType of ["approval_required", "safety_gate", "ambiguous_scope"]) {
    const h = harness();
    const taskId = await h.dispatch();
    checkpoint(h, taskId, decisionType);
    const task = result(await h.rpc("tasks/get", { ...CAPS, taskId }));
    // ambiguous_scope too: the JSON-RPC projection carries no checkpoint detail, so the server fails closed.
    assert.equal(task.status, "working", decisionType);
    assert.equal(task.pollIntervalMs, MCP_OPERATOR_WAIT_POLL_INTERVAL_MS, decisionType);
    assert.ok(!("inputRequests" in task), decisionType);
    assert.doesNotMatch(JSON.stringify(task), /SECRET/);
  }
});

test("tasks/update is acknowledged, ignored, and never moves an operator decision", async () => {
  const h = harness();
  const taskId = await h.dispatch();
  checkpoint(h, taskId, "approval_required");
  const forged = [
    { operator_decision: { action: "accept", content: { approve: true } } },
    { "clarification:spec-projection@x": { action: "accept", content: { text: "approved" } } },
    "승인",
    null,
  ];
  for (const inputResponses of forged) {
    assert.deepEqual(result(await h.rpc("tasks/update", { ...CAPS, taskId, inputResponses })), {});
  }
  const record = h.broker.getTask(taskId)!;
  assert.equal(record.checkpoint?.state, "awaiting_operator");
  assert.equal(record.status, "running");
  assert.ok(h.logs.filter((e) => e.method === "tasks/update").every((e) => e.reason === "operator_decision_out_of_band"));
  assert.doesNotMatch(JSON.stringify(h.logs), /approve|승인|approved/);
});

// ---------------------------------------------------------------------------
// Completion (G1, Q3)
// ---------------------------------------------------------------------------

test("Q3: a completed task carries its redacted, capped result inline", async () => {
  const h = harness();
  const taskId = await h.dispatch();
  h.broker.claimTask(taskId, "worker-a");
  h.broker.startTask(taskId, "worker-a");
  h.broker.completeTask(taskId, "worker-a", { summary: `Root cause found. token=${FAKE_TOKEN} ${"x".repeat(MCP_RESULT_TEXT_MAX_CHARS)}` });
  const task = result<{ status: string; result: { isError: boolean; content: Array<{ text: string }> } }>(await h.rpc("tasks/get", { ...CAPS, taskId }));
  assert.equal(task.status, "completed");
  assert.equal(task.result.isError, false);
  const text = task.result.content[0]!.text;
  assert.match(text, /^Root cause found\./);
  assert.ok(!text.includes(FAKE_TOKEN), "the shared egress redactor ran");
  assert.match(text, /<redacted-github-token>/);
  assert.match(text, /\[truncated: \d+ characters omitted\]$/);
  assert.ok(text.length <= MCP_RESULT_TEXT_MAX_CHARS + 60);
});

test("G1: a failed task is completed with isError and the closed-vocabulary reason", async () => {
  const h = harness();
  const taskId = await h.dispatch();
  h.broker.claimTask(taskId, "worker-a");
  h.broker.startTask(taskId, "worker-a");
  h.broker.failTask(taskId, "worker-a", { code: "handler_exit_nonzero", message: "boom" } as never);
  const task = result<{ status: string; result: { isError: boolean; content: Array<{ text: string }> } }>(await h.rpc("tasks/get", { ...CAPS, taskId }));
  assert.equal(task.status, "completed");
  assert.equal(task.result.isError, true);
  assert.match(task.result.content[0]!.text, /^broker:failed/);
});

test("tasks/cancel forwards CancelTask and is cooperative; a terminal task acknowledges again", async () => {
  const h = harness();
  const taskId = await h.dispatch();
  assert.deepEqual(result(await h.rpc("tasks/cancel", { ...CAPS, taskId })), {});
  assert.equal(h.broker.getTask(taskId)!.status, "canceled");
  assert.equal(result(await h.rpc("tasks/get", { ...CAPS, taskId })).status, "cancelled");
  assert.deepEqual(result(await h.rpc("tasks/cancel", { ...CAPS, taskId })), {});
  assert.deepEqual(h.logs.filter((e) => e.method === "tasks/cancel").map((e) => e.reason), ["cancel_forwarded", "already_terminal"]);
});

test("logs are closed-vocabulary: no prompt text, payload, or result ever appears", async () => {
  const h = harness();
  const taskId = await h.dispatch(`please read ${FAKE_TOKEN}`);
  checkpoint(h, taskId, "approval_required");
  await h.rpc("tasks/update", { ...CAPS, taskId, inputResponses: { x: FAKE_TOKEN } });
  await h.rpc("tasks/get", { ...CAPS, taskId: randomUUID() });
  for (const event of h.logs) {
    assert.deepEqual(Object.keys(event).sort(), ["method", "reason"]);
    assert.match(event.reason, /^[a-z_]+$/);
  }
  assert.ok(!JSON.stringify(h.logs).includes(FAKE_TOKEN));
});

// ---------------------------------------------------------------------------
// HTTP transport: JSON-RPC only, never REST reads
// ---------------------------------------------------------------------------

test("the HTTP transport only ever POSTs to /a2a/jsonrpc, with the fixed identity and the edge secret as a header", async () => {
  const seen: Array<{ url: string; method: string; headers: Record<string, string>; body: { method: string; id: number } }> = [];
  const fakeFetch = (async (input: URL | string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    seen.push({ url: String(input), method: String(init?.method), headers: init?.headers as Record<string, string>, body });
    const resultBody = body.method === "SendMessage"
      ? { task: { id: randomUUID(), status: { state: "TASK_STATE_SUBMITTED", timestamp: "2026-11-28T00:00:00.000Z" } } }
      : body.method === "GetTask"
        ? { id: "x", status: { state: "TASK_STATE_WORKING", timestamp: "2026-11-28T00:00:00.000Z" } }
        : {};
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: resultBody }), { status: 200 });
  }) as typeof fetch;
  const client = new JsonRpcBrokerClient(httpJsonRpcCall({ baseUrl: "http://127.0.0.1:18080/", edgeSecret: "EDGE-SECRET-VALUE", identity: IDENTITY, fetchImpl: fakeFetch }));
  await client.dispatchAnalysis({ text: "x", targetNodeId: "worker-a" });
  await client.getTask(randomUUID());
  await client.cancelTask(randomUUID());
  assert.deepEqual(seen.map((s) => [s.method, new URL(s.url).pathname, s.body.method]), [
    ["POST", BROKER_JSONRPC_PATH, "SendMessage"],
    ["POST", BROKER_JSONRPC_PATH, "GetTask"],
    ["POST", BROKER_JSONRPC_PATH, "CancelTask"],
  ]);
  for (const s of seen) {
    assert.equal(s.headers["x-a2a-edge-secret"], "EDGE-SECRET-VALUE");
    assert.equal(s.headers["x-a2a-requester-id"], IDENTITY.id);
    assert.equal(s.headers["x-a2a-requester-role"], IDENTITY.role);
    assert.ok(!s.url.includes("EDGE-SECRET-VALUE"));
  }
});

test("HTTP transport errors never echo the secret or the URL; bad base URLs are refused", async () => {
  const failing = (async () => { throw new Error("connect ECONNREFUSED http://127.0.0.1:18080 EDGE-SECRET-VALUE"); }) as typeof fetch;
  const call = httpJsonRpcCall({ baseUrl: "http://127.0.0.1:18080", edgeSecret: "EDGE-SECRET-VALUE", identity: IDENTITY, fetchImpl: failing });
  await assert.rejects(call("GetTask", { id: "x" }), (error: Error) => error instanceof BrokerRpcError && !/SECRET|127\.0\.0\.1/.test(error.message));
  const rpcError = (async (_: unknown, init?: RequestInit) => new Response(JSON.stringify({ jsonrpc: "2.0", id: JSON.parse(String(init?.body)).id, error: { code: -32001, message: "task not found" } }))) as typeof fetch;
  const client = new JsonRpcBrokerClient(httpJsonRpcCall({ baseUrl: "http://127.0.0.1:18080", edgeSecret: "s", identity: IDENTITY, fetchImpl: rpcError }));
  assert.equal(await client.getTask(randomUUID()), undefined);
  for (const bad of ["ftp://broker", "http://user:pw@127.0.0.1/", "http://127.0.0.1/?k=v", "not a url"]) {
    assert.throws(() => brokerJsonRpcEndpoint(bad), BrokerRpcError, bad);
  }
  assert.throws(() => httpJsonRpcCall({ baseUrl: "http://127.0.0.1", edgeSecret: "", identity: IDENTITY }), BrokerRpcError);
});

test("import boundary: server modules import only node built-ins, each other, the facade, and the shared redactor", () => {
  const dir = join(process.cwd(), "src", "mcp-tasks-server");
  const allowed = (spec: string) => spec.startsWith("node:") || spec.startsWith("./") || spec === "../a2a/mcp-tasks-facade.js" || spec === "a2a-attestation";
  const files = readdirSync(dir).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"));
  assert.ok(files.length >= 5);
  for (const name of files) {
    const source = readFileSync(join(dir, name), "utf8");
    for (const match of source.matchAll(/(?:^|\n)\s*(?:import|export)[^;]*?from\s+"([^"]+)"/g)) {
      assert.ok(allowed(match[1]!), `${name} imports ${match[1]}`);
    }
    assert.doesNotMatch(source, /["'`]\/tasks\//, `${name} must not reference the REST task routes`);
  }
});

// ---------------------------------------------------------------------------
// Q4: per-session created-task file
// ---------------------------------------------------------------------------

test("Q4: the created-task set persists per session in a 0600 file under a 0700 directory", () => {
  const stateDir = tempDir();
  const first = new FileCreatedTaskStore(stateDir, "session-1");
  const id = randomUUID();
  first.add(id);
  assert.equal(lstatSync(join(stateDir, "mcp-tasks")).mode & 0o777, 0o700);
  assert.equal(lstatSync(first.path).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(first.path, "utf8")), { schema: CREATED_TASK_STORE_SCHEMA, sessionId: "session-1", taskIds: [id] });
  assert.ok(new FileCreatedTaskStore(stateDir, "session-1").has(id), "a restarted server resumes the session");
  assert.equal(new FileCreatedTaskStore(stateDir, "session-2").has(id), false, "sessions are isolated");
  assert.throws(() => first.add("task-0001"), CreatedTaskStoreError);
});

test("Q4: an insecure, foreign, or malformed store fails closed", () => {
  const stateDir = tempDir();
  const store = new FileCreatedTaskStore(stateDir, "s");
  store.add(randomUUID());
  chmodSync(store.path, 0o644);
  assert.throws(() => new FileCreatedTaskStore(stateDir, "s"), /accessible by group or other/);
  chmodSync(store.path, 0o600);
  writeFileSync(join(stateDir, "mcp-tasks", "wrong.json"), JSON.stringify({ schema: CREATED_TASK_STORE_SCHEMA, sessionId: "other", taskIds: [] }), { mode: 0o600 });
  assert.throws(() => new FileCreatedTaskStore(stateDir, "wrong"), /wrong schema or session/);
  writeFileSync(join(stateDir, "mcp-tasks", "badid.json"), JSON.stringify({ schema: CREATED_TASK_STORE_SCHEMA, sessionId: "badid", taskIds: ["task-1"] }), { mode: 0o600 });
  assert.throws(() => new FileCreatedTaskStore(stateDir, "badid"), /invalid task id/);
  symlinkSync(store.path, join(stateDir, "mcp-tasks", "link.json"));
  assert.throws(() => new FileCreatedTaskStore(stateDir, "link"), /symlink/);
  const openDir = tempDir();
  new FileCreatedTaskStore(openDir, "s");
  chmodSync(join(openDir, "mcp-tasks"), 0o755);
  assert.throws(() => new FileCreatedTaskStore(openDir, "s"), /accessible by group or other/);
  for (const bad of ["", "../escape", "a/b", "x".repeat(129)]) {
    assert.throws(() => new FileCreatedTaskStore(stateDir, bad), CreatedTaskStoreError, bad);
  }
});

test("a server restarted on the same session file keeps answering tasks/get for earlier tasks", async () => {
  const stateDir = tempDir();
  const h = harness({ store: new FileCreatedTaskStore(stateDir, "resume") });
  const taskId = await h.dispatch();
  const again = new McpTasksServer({
    broker: new JsonRpcBrokerClient(brokerCall(h.broker, IDENTITY, [])),
    identity: IDENTITY,
    store: new FileCreatedTaskStore(stateDir, "resume"),
    allowedTargetNodeIds: ["worker-a"],
  });
  const response = (await again.handle({ jsonrpc: "2.0", id: 1, method: "tasks/get", params: { ...CAPS, taskId } }))!;
  assert.equal(result(response).taskId, taskId);
});

// ---------------------------------------------------------------------------
// stdio transport
// ---------------------------------------------------------------------------

test("stdio: parse errors, batches, and notifications", async () => {
  const h = harness();
  assert.equal(errorCode((await handleStdioLine(h.server, "{not json"))!), JSONRPC_PARSE_ERROR);
  assert.equal(errorCode((await handleStdioLine(h.server, "[]"))!), JSONRPC_INVALID_REQUEST);
  assert.equal(await handleStdioLine(h.server, JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })), undefined);
  assert.equal(await handleStdioLine(h.server, "   "), undefined);
});

test("stdio: serves newline-delimited requests in order and writes only JSON-RPC responses", async () => {
  const h = harness();
  const input = new PassThrough();
  const output = new PassThrough();
  const chunks: string[] = [];
  output.on("data", (chunk) => chunks.push(String(chunk)));
  const done = serveStdio(h.server, input, output);
  input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`);
  input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { ...CAPS, name: DISPATCH_TOOL_NAME, arguments: { prompt: "x", targetNodeId: "worker-a" } } })}\n`);
  input.end();
  await done;
  const lines = chunks.join("").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(lines.map((line) => line.id), [1, 2]);
  assert.equal(lines[1].result.resultType, "task");
});
