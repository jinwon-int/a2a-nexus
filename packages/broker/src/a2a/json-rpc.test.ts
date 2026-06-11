import test from "node:test";
import assert from "node:assert/strict";

import { InMemoryA2ABroker } from "../core/broker.js";
import { createBrokerAgentCard } from "./agent-card.js";
import { executeA2AJsonRpc, executeA2AJsonRpcBody, type ExecuteJsonRpcOptions, type JsonRpcResponse } from "./json-rpc.js";

function createBroker(): InMemoryA2ABroker {
  return new InMemoryA2ABroker();
}

function registerWorker(broker: InMemoryA2ABroker, nodeId: string): void {
  broker.registerWorker({
    nodeId,
    role: "analyst",
    capabilities: {
      canAnalyze: true,
      canBackfill: false,
      canPatchWorkspace: false,
      canPromoteLive: false,
      workspaceIds: ["test"],
      environments: ["research"],
    },
  });
}

const agentCard = createBrokerAgentCard({
  serviceName: "test-broker",
  publicBaseUrl: "https://broker.test/",
});

function createJsonRpcOptions(
  broker: InMemoryA2ABroker,
  overrides?: Partial<ExecuteJsonRpcOptions>,
): ExecuteJsonRpcOptions {
  return {
    broker,
    agentCard,
    publicBaseUrl: "https://broker.test",
    requesterIdentity: { id: "caller-node", kind: "node", role: "hub" },
    enforceRequesterIdentity: true,
    ...overrides,
  };
}

function createTaskViaJsonRpc(broker: InMemoryA2ABroker): string {
  registerWorker(broker, "worker-a");
  const result = executeA2AJsonRpc(
    {
      jsonrpc: "2.0",
      id: 1,
      method: "SendMessage",
      params: {
        message: { parts: [{ text: "audit auth test" }] },
        metadata: { targetNodeId: "worker-a", intent: "analyze" },
      },
    },
    createJsonRpcOptions(broker),
  );
  assert.ok("result" in result, "setup SendMessage should succeed");
  const taskId = (result.result as { task?: { id?: unknown } }).task?.id;
  if (typeof taskId !== "string") {
    assert.fail("setup SendMessage should return a task id");
  }
  return taskId;
}

test("SubscribeToTask rejects unauthenticated JSON-RPC callers before returning task snapshots", () => {
  const broker = createBroker();
  const taskId = createTaskViaJsonRpc(broker);

  const result = executeA2AJsonRpc(
    {
      jsonrpc: "2.0",
      id: 2,
      method: "SubscribeToTask",
      params: { taskId },
    },
    createJsonRpcOptions(broker, {
      requesterIdentity: null,
      enforceRequesterIdentity: true,
    }),
  );

  assert.ok("error" in result, "SubscribeToTask should fail without requester identity");
  if (!("error" in result)) return;
  assert.equal(result.error.code, -32011);
  assert.equal(
    ((result.error.data as Array<Record<string, unknown>>)?.[0]?.metadata as Record<string, unknown>)?.brokerCode,
    "unauthorized",
  );
});

test("GetTask rejects unauthenticated JSON-RPC callers before returning task snapshots", () => {
  const broker = createBroker();
  const taskId = createTaskViaJsonRpc(broker);

  const result = executeA2AJsonRpc(
    {
      jsonrpc: "2.0",
      id: 3,
      method: "GetTask",
      params: { taskId },
    },
    createJsonRpcOptions(broker, {
      requesterIdentity: null,
      enforceRequesterIdentity: true,
    }),
  );

  assert.ok("error" in result, "GetTask should fail without requester identity");
  if (!("error" in result)) return;
  assert.equal(result.error.code, -32011);
  assert.equal(
    ((result.error.data as Array<Record<string, unknown>>)?.[0]?.metadata as Record<string, unknown>)?.brokerCode,
    "unauthorized",
  );
});

test("ListTasks filters JSON-RPC task snapshots to tasks visible to the requester", () => {
  const broker = createBroker();
  const visibleTaskId = createTaskViaJsonRpc(broker);
  registerWorker(broker, "worker-b");
  const hiddenResult = executeA2AJsonRpc(
    {
      jsonrpc: "2.0",
      id: 1,
      method: "SendMessage",
      params: {
        message: { parts: [{ text: "hidden from worker-a" }] },
        metadata: { targetNodeId: "worker-b", intent: "analyze" },
      },
    },
    createJsonRpcOptions(broker),
  );
  assert.ok("result" in hiddenResult, "setup second SendMessage should succeed");

  const result = executeA2AJsonRpc(
    {
      jsonrpc: "2.0",
      id: 4,
      method: "ListTasks",
      params: {},
    },
    createJsonRpcOptions(broker, {
      requesterIdentity: { id: "worker-a", kind: "node", role: "analyst" },
      enforceRequesterIdentity: true,
    }),
  );

  assert.ok("result" in result, "ListTasks should succeed for an authenticated requester");
  if (!("result" in result)) return;
  const tasks = (result.result as { tasks?: Array<{ id?: string }> }).tasks ?? [];
  assert.deepEqual(tasks.map((task) => task.id), [visibleTaskId]);
});

test("ListTasks rejects unauthenticated JSON-RPC callers", () => {
  const broker = createBroker();
  createTaskViaJsonRpc(broker);

  const result = executeA2AJsonRpc(
    {
      jsonrpc: "2.0",
      id: 5,
      method: "ListTasks",
      params: {},
    },
    createJsonRpcOptions(broker, {
      requesterIdentity: null,
      enforceRequesterIdentity: true,
    }),
  );

  assert.ok("error" in result, "ListTasks should fail without requester identity");
  if (!("error" in result)) return;
  assert.equal(result.error.code, -32011);
  assert.equal(
    ((result.error.data as Array<Record<string, unknown>>)?.[0]?.metadata as Record<string, unknown>)?.brokerCode,
    "unauthorized",
  );
});

test("ListTasks rejects unauthenticated JSON-RPC callers even when the broker has no tasks", () => {
  const broker = createBroker();

  const result = executeA2AJsonRpc(
    {
      jsonrpc: "2.0",
      id: 6,
      method: "ListTasks",
      params: {},
    },
    createJsonRpcOptions(broker, {
      requesterIdentity: null,
      enforceRequesterIdentity: true,
    }),
  );

  assert.ok("error" in result, "ListTasks should fail without requester identity before listing tasks");
  if (!("error" in result)) return;
  assert.equal(result.error.code, -32011);
  assert.equal(
    ((result.error.data as Array<Record<string, unknown>>)?.[0]?.metadata as Record<string, unknown>)?.brokerCode,
    "unauthorized",
  );
});

test("ListTasks rejects unauthenticated JSON-RPC callers before applying no-match filters", () => {
  const broker = createBroker();
  createTaskViaJsonRpc(broker);

  const result = executeA2AJsonRpc(
    {
      jsonrpc: "2.0",
      id: 7,
      method: "ListTasks",
      params: { targetNodeId: "no-such-worker" },
    },
    createJsonRpcOptions(broker, {
      requesterIdentity: null,
      enforceRequesterIdentity: true,
    }),
  );

  assert.ok("error" in result, "ListTasks should fail without requester identity before applying filters");
  if (!("error" in result)) return;
  assert.equal(result.error.code, -32011);
  assert.equal(
    ((result.error.data as Array<Record<string, unknown>>)?.[0]?.metadata as Record<string, unknown>)?.brokerCode,
    "unauthorized",
  );
});

test("GetTask rejects unauthenticated JSON-RPC callers before task existence checks", () => {
  const broker = createBroker();

  const result = executeA2AJsonRpc(
    {
      jsonrpc: "2.0",
      id: 8,
      method: "GetTask",
      params: { taskId: "no-such-task" },
    },
    createJsonRpcOptions(broker, {
      requesterIdentity: null,
      enforceRequesterIdentity: true,
    }),
  );

  assert.ok("error" in result, "GetTask should fail auth before task lookup");
  if (!("error" in result)) return;
  assert.equal(result.error.code, -32011);
  assert.equal(
    ((result.error.data as Array<Record<string, unknown>>)?.[0]?.metadata as Record<string, unknown>)?.brokerCode,
    "unauthorized",
  );
});

test("SubscribeToTask rejects unauthenticated JSON-RPC callers before task existence checks", () => {
  const broker = createBroker();

  const result = executeA2AJsonRpc(
    {
      jsonrpc: "2.0",
      id: 9,
      method: "SubscribeToTask",
      params: { taskId: "no-such-task" },
    },
    createJsonRpcOptions(broker, {
      requesterIdentity: null,
      enforceRequesterIdentity: true,
    }),
  );

  assert.ok("error" in result, "SubscribeToTask should fail auth before task lookup");
  if (!("error" in result)) return;
  assert.equal(result.error.code, -32011);
  assert.equal(
    ((result.error.data as Array<Record<string, unknown>>)?.[0]?.metadata as Record<string, unknown>)?.brokerCode,
    "unauthorized",
  );
});

test("SendMessage rejects mismatched targetNodeId and assignedWorkerId on existing contexts", () => {
  const broker = createBroker();
  const taskId = createTaskViaJsonRpc(broker);
  registerWorker(broker, "worker-b");
  const task = broker.getTask(taskId);
  assert.ok(task, "setup task should exist");

  const result = executeA2AJsonRpc(
    {
      jsonrpc: "2.0",
      id: 10,
      method: "SendMessage",
      params: {
        message: { parts: [{ text: "mismatched follow-up assignment" }] },
        metadata: {
          contextId: task.exchangeId,
          targetNodeId: "worker-a",
          assignedWorkerId: "worker-b",
        },
      },
    },
    createJsonRpcOptions(broker),
  );

  assert.ok("error" in result, "existing-context mismatched target/assigned worker should be rejected");
  if (!("error" in result)) return;
  assert.equal(result.error.code, -32602);
  assert.match(result.error.message, /assignedWorkerId must match targetNodeId/);
});

test("SendMessage rejects existing-context follow-ups that override only assignedWorkerId", () => {
  const broker = createBroker();
  const taskId = createTaskViaJsonRpc(broker);
  registerWorker(broker, "worker-b");
  const task = broker.getTask(taskId);
  assert.ok(task, "setup task should exist");

  const result = executeA2AJsonRpc(
    {
      jsonrpc: "2.0",
      id: 11,
      method: "SendMessage",
      params: {
        message: { parts: [{ text: "assigned-only override" }] },
        metadata: {
          contextId: task.exchangeId,
          assignedWorkerId: "worker-b",
        },
      },
    },
    createJsonRpcOptions(broker),
  );

  assert.ok("error" in result, "assigned-only override should be rejected on existing contexts");
  if (!("error" in result)) return;
  assert.equal(result.error.code, -32602);
  assert.match(result.error.message, /assignedWorkerId must match the exchange targetNodeId/);
});

test("SendMessage rejects existing-context follow-ups that override only targetNodeId", () => {
  const broker = createBroker();
  const taskId = createTaskViaJsonRpc(broker);
  registerWorker(broker, "worker-b");
  const task = broker.getTask(taskId);
  assert.ok(task, "setup task should exist");

  const result = executeA2AJsonRpc(
    {
      jsonrpc: "2.0",
      id: 12,
      method: "SendMessage",
      params: {
        message: { parts: [{ text: "target-only override" }] },
        metadata: {
          contextId: task.exchangeId,
          targetNodeId: "worker-b",
        },
      },
    },
    createJsonRpcOptions(broker),
  );

  assert.ok("error" in result, "target-only override should be rejected on existing contexts");
  if (!("error" in result)) return;
  assert.equal(result.error.code, -32602);
  assert.match(result.error.message, /targetNodeId must match the exchange targetNodeId/);
});

test("SendMessage rejects mismatched targetNodeId and assignedWorkerId by default", () => {
  const broker = createBroker();
  registerWorker(broker, "worker-a");
  registerWorker(broker, "worker-b");

  const result = executeA2AJsonRpc(
    {
      jsonrpc: "2.0",
      id: 1,
      method: "SendMessage",
      params: {
        message: { parts: [{ text: "mismatched worker assignment" }] },
        metadata: {
          targetNodeId: "worker-a",
          assignedWorkerId: "worker-b",
          intent: "analyze",
        },
      },
    },
    createJsonRpcOptions(broker),
  );

  assert.ok("error" in result, "mismatched target/assigned worker should be rejected");
  if (!("error" in result)) return;
  assert.equal(result.error.code, -32602);
  assert.match(result.error.message, /assignedWorkerId must match targetNodeId/);
});

// ───────────────────────────────────────────────────────────────────────────
// JSON-RPC transport conformance (a2a-nexus#573 item 10)
// ───────────────────────────────────────────────────────────────────────────

test("malformed JSON body returns a -32700 parse error", () => {
  const broker = createBroker();
  const result = executeA2AJsonRpcBody("{ not valid json", createJsonRpcOptions(broker));
  assert.ok(result && !Array.isArray(result) && "error" in result);
  assert.equal((result as JsonRpcResponse & { error: { code: number } }).error.code, -32700);
});

test("a batch array is processed per element and returns an array of responses", () => {
  const broker = createBroker();
  registerWorker(broker, "worker-a");
  const body = JSON.stringify([
    { jsonrpc: "2.0", id: 1, method: "ListTasks", params: {} },
    { jsonrpc: "2.0", id: 2, method: "GetExtendedAgentCard" },
    { jsonrpc: "2.0", id: 3, method: "NoSuchMethod" },
  ]);
  const result = executeA2AJsonRpcBody(body, createJsonRpcOptions(broker));
  assert.ok(Array.isArray(result), "a batch must return an array of responses");
  assert.equal(result.length, 3);
  assert.deepEqual(result.map((r) => r.id), [1, 2, 3]);
  assert.ok("result" in result[0]!);
  assert.ok("error" in result[2]! && (result[2] as { error: { code: number } }).error.code === -32601);
});

test("an empty batch array is rejected with -32600", () => {
  const broker = createBroker();
  const result = executeA2AJsonRpcBody("[]", createJsonRpcOptions(broker));
  assert.ok(result && !Array.isArray(result) && "error" in result);
  assert.equal((result as { error: { code: number } }).error.code, -32600);
});

test("a notification (no id member) gets no response", () => {
  const broker = createBroker();
  registerWorker(broker, "worker-a");
  // GetExtendedAgentCard with no `id` is a notification.
  const result = executeA2AJsonRpcBody(
    JSON.stringify({ jsonrpc: "2.0", method: "GetExtendedAgentCard" }),
    createJsonRpcOptions(broker),
  );
  assert.equal(result, null, "a notification must not produce a response");
});

test("a batch of only notifications returns null (no response body)", () => {
  const broker = createBroker();
  const body = JSON.stringify([
    { jsonrpc: "2.0", method: "GetExtendedAgentCard" },
    { jsonrpc: "2.0", method: "GetExtendedAgentCard" },
  ]);
  const result = executeA2AJsonRpcBody(body, createJsonRpcOptions(broker));
  assert.equal(result, null);
});

test("id: null is a normal request and still gets a response", () => {
  const broker = createBroker();
  registerWorker(broker, "worker-a");
  const result = executeA2AJsonRpcBody(
    JSON.stringify({ jsonrpc: "2.0", id: null, method: "GetExtendedAgentCard" }),
    createJsonRpcOptions(broker),
  );
  assert.ok(result && !Array.isArray(result) && "result" in result);
  assert.equal((result as JsonRpcResponse).id, null);
});

test("GetTask on a missing task returns A2A TaskNotFoundError (-32001) with ErrorInfo", () => {
  const broker = new InMemoryA2ABroker();
  const result = executeA2AJsonRpc(
    { jsonrpc: "2.0", id: "e1", method: "GetTask", params: { taskId: "nope" } },
    { broker },
  ) as JsonRpcFailure;

  assert.equal(result.error.code, -32001);
  const data = result.error.data as Array<Record<string, unknown>>;
  assert.ok(Array.isArray(data), "A2A error.data must be an array");
  assert.equal(data[0]["@type"], "type.googleapis.com/google.rpc.ErrorInfo");
  assert.equal(data[0].domain, "a2a-protocol.org");
  assert.equal(data[0].reason, "TASK_NOT_FOUND");
  assert.equal((data[0].metadata as Record<string, unknown>).brokerCode, "not_found");
});

test("broker-specific errors carry an ErrorInfo array in the broker domain", () => {
  const broker = new InMemoryA2ABroker();
  // bad_request (validation) stays standard -32602 with an array data payload.
  const result = executeA2AJsonRpc(
    { jsonrpc: "2.0", id: "e2", method: "GetTask", params: {} },
    { broker },
  ) as JsonRpcFailure;

  assert.equal(result.error.code, -32602);
  const data = result.error.data as Array<Record<string, unknown>>;
  assert.ok(Array.isArray(data));
  assert.equal((data[0].metadata as Record<string, unknown>).brokerCode, "bad_request");
});
