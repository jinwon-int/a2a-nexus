import test from "node:test";
import assert from "node:assert/strict";

import { InMemoryA2ABroker } from "../core/broker.js";
import { createBrokerAgentCard } from "./agent-card.js";
import { executeA2AJsonRpc, type ExecuteJsonRpcOptions } from "./json-rpc.js";

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
  assert.equal(result.error.code, -32001);
  assert.equal((result.error.data as Record<string, unknown>)?.brokerCode, "unauthorized");
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
  assert.equal(result.error.code, -32001);
  assert.equal((result.error.data as Record<string, unknown>)?.brokerCode, "unauthorized");
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
  assert.equal(result.error.code, -32001);
  assert.equal((result.error.data as Record<string, unknown>)?.brokerCode, "unauthorized");
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
  assert.equal(result.error.code, -32001);
  assert.equal((result.error.data as Record<string, unknown>)?.brokerCode, "unauthorized");
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
  assert.equal(result.error.code, -32001);
  assert.equal((result.error.data as Record<string, unknown>)?.brokerCode, "unauthorized");
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
  assert.equal(result.error.code, -32001);
  assert.equal((result.error.data as Record<string, unknown>)?.brokerCode, "unauthorized");
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
  assert.equal(result.error.code, -32001);
  assert.equal((result.error.data as Record<string, unknown>)?.brokerCode, "unauthorized");
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
