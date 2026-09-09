import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryA2ABroker } from "../core/broker.js";
import { emptySnapshot } from "../core/store.js";
import {
  buildTaskLineageReadProjection,
  parseTaskLineageChildrenRequestV1,
  parseTaskLineageLeavesRequestV1,
  parseTaskLineageLineageRequestV1,
} from "../core/task-lineage-read.js";
import type { TaskRuntimeRepository } from "../core/task-repository.js";
import type { TaskRecord } from "../core/types.js";
import { createBrokerAgentCard } from "./agent-card.js";
import {
  executeA2AJsonRpc,
  type ExecuteJsonRpcOptions,
  type JsonRpcFailure,
  type JsonRpcSuccess,
} from "./json-rpc.js";

const T0 = "2026-07-28T00:00:00.000Z";
const agentCard = createBrokerAgentCard({
  serviceName: "task-lineage-test-broker",
  publicBaseUrl: "https://broker.test/",
});

function task(
  id: string,
  workerId: string,
  overrides: Partial<TaskRecord> = {},
): TaskRecord {
  return {
    id,
    intent: "analyze",
    status: "queued",
    requester: { id: "requester-a", kind: "service", role: "researcher" },
    target: { id: workerId, kind: "node", role: "analyst" },
    targetNodeId: workerId,
    assignedWorkerId: workerId,
    payload: { secretPayload: `payload-${id}` },
    message: `message-${id}`,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

function brokerWithTasks(tasks: TaskRecord[]): InMemoryA2ABroker {
  return new InMemoryA2ABroker(undefined, {
    ...emptySnapshot(),
    tasks,
  });
}

function options(
  broker: InMemoryA2ABroker,
  requesterIdentity: ExecuteJsonRpcOptions["requesterIdentity"] = {
    id: "worker-a",
    kind: "node",
    role: "analyst",
  },
): ExecuteJsonRpcOptions {
  return {
    broker,
    agentCard,
    requesterIdentity,
    enforceRequesterIdentity: true,
  };
}

function rpc(
  broker: InMemoryA2ABroker,
  method: string,
  params: unknown,
  requesterIdentity?: ExecuteJsonRpcOptions["requesterIdentity"],
): JsonRpcSuccess | JsonRpcFailure {
  return executeA2AJsonRpc(
    { jsonrpc: "2.0", id: "task-lineage-test", method, params },
    options(broker, requesterIdentity),
  );
}

function resultOf<T>(
  response: JsonRpcSuccess | JsonRpcFailure,
): T {
  assert.ok("result" in response, JSON.stringify(response));
  return response.result as T;
}

test("task-lineage JSON-RPC methods share the existing authenticated task-read boundary", () => {
  const broker = brokerWithTasks([task("visible", "worker-a")]);
  for (const [method, params] of [
    ["tasks/children", { taskId: "visible" }],
    ["tasks/lineage", { taskId: "visible" }],
    ["tasks/leaves", {}],
  ] as const) {
    const response = rpc(broker, method, params, null);
    assert.ok("error" in response);
    if (!("error" in response)) continue;
    assert.equal(response.error.code, -32011);
    assert.equal(
      (
        (response.error.data as Array<Record<string, unknown>>)[0]
          ?.metadata as Record<string, unknown>
      ).brokerCode,
      "unauthorized",
    );
  }
});

test("task-lineage JSON-RPC hides inaccessible parent/reference identifiers and does not re-root", () => {
  const broker = brokerWithTasks([
    task("hidden-parent", "worker-b"),
    task("hidden-reference", "worker-b"),
    task("visible-child", "worker-a", {
      parentTaskId: "hidden-parent",
      referenceTaskIds: ["hidden-reference"],
    }),
  ]);
  const response = rpc(
    broker,
    "tasks/lineage",
    { taskId: "visible-child" },
  );
  const result = resultOf<{
    lineage: Array<{
      taskId: string;
      parentTaskId: string | null;
      parentMissing: boolean;
      referenceTaskIds: string[];
    }>;
    rootReached: boolean;
  }>(response);
  assert.deepEqual(result.lineage, [
    {
      kind: "TaskLineageNodeV1",
      taskId: "visible-child",
      parentTaskId: null,
      parentMissing: true,
      referenceTaskIds: [],
      intent: "analyze",
      status: "queued",
      requesterId: "requester-a",
      assignedWorkerId: "worker-a",
      createdAt: T0,
      depth: 0,
    },
  ]);
  assert.equal(result.rootReached, false);
  assert.doesNotMatch(
    JSON.stringify(response),
    /hidden-parent|hidden-reference|payload-|message-/,
  );

  const absentBroker = brokerWithTasks([
    task("visible-child", "worker-a", {
      parentTaskId: "hidden-parent",
      referenceTaskIds: ["hidden-reference"],
    }),
  ]);
  const absentResponse = rpc(
    absentBroker,
    "tasks/lineage",
    { taskId: "visible-child" },
  );
  assert.deepEqual(
    response,
    absentResponse,
    "inaccessible and absent parent/reference records must project identically",
  );
});

test("task-lineage JSON-RPC makes hidden and missing task anchors indistinguishable", () => {
  const broker = brokerWithTasks([
    task("hidden-anchor", "worker-b"),
    task("visible", "worker-a"),
  ]);
  for (const method of ["tasks/children", "tasks/lineage"]) {
    const hidden = rpc(broker, method, { taskId: "hidden-anchor" });
    const missing = rpc(broker, method, { taskId: "missing-anchor" });
    assert.ok("error" in hidden && "error" in missing);
    if (!("error" in hidden) || !("error" in missing)) continue;
    assert.equal(hidden.error.code, -32001);
    assert.equal(hidden.error.message, missing.error.message);
    assert.deepEqual(hidden.error.data, missing.error.data);
    assert.doesNotMatch(JSON.stringify(hidden), /hidden-anchor/);
  }
});

test("task-lineage JSON-RPC excludes hidden children and makes hidden and missing round anchors indistinguishable", () => {
  const broker = brokerWithTasks([
    task("visible-root", "worker-a"),
    task("hidden-child", "worker-b", {
      parentTaskId: "visible-root",
      parentRoundId: "hidden-round",
      parentRoundTotal: 1,
    }),
  ]);
  const leaves = resultOf<{
    leaves: Array<{ taskId: string }>;
    diagnostics: { scannedVisibleTasks: number };
  }>(rpc(broker, "tasks/leaves", {}));
  assert.deepEqual(leaves.leaves.map((node) => node.taskId), ["visible-root"]);
  assert.equal(leaves.diagnostics.scannedVisibleTasks, 1);

  const hidden = rpc(
    broker,
    "tasks/children",
    { parentRoundId: "hidden-round" },
  );
  const missing = rpc(
    broker,
    "tasks/children",
    { parentRoundId: "missing-round" },
  );
  assert.ok("error" in hidden && "error" in missing);
  if (!("error" in hidden) || !("error" in missing)) return;
  assert.equal(hidden.error.code, -32001);
  assert.equal(hidden.error.code, missing.error.code);
  assert.equal(hidden.error.message, missing.error.message);
  assert.deepEqual(hidden.error.data, missing.error.data);

  const serialized = JSON.stringify(hidden).toLowerCase();
  assert.doesNotMatch(serialized, /hidden-child|hidden-round/);
  for (const disclosure of ["count", "cursor", "anomal", "round"]) {
    assert.equal(
      serialized.includes(disclosure),
      false,
      `${disclosure} must not enter the bounded anchor failure`,
    );
  }
});

test("task-lineage JSON-RPC reports only visible direct children and deduplicates typed edges", () => {
  const broker = brokerWithTasks([
    task("anchor", "worker-a"),
    task("visible-terminal-child", "worker-a", {
      parentTaskId: "anchor",
      referenceTaskIds: ["anchor"],
      status: "succeeded",
    }),
    task("hidden-child", "worker-b", {
      parentTaskId: "anchor",
    }),
  ]);
  const result = resultOf<{
    children: Array<{
      node: { taskId: string; status: string };
      edges: string[];
    }>;
  }>(rpc(broker, "tasks/children", { taskId: "anchor" }));
  assert.deepEqual(result.children, [
    {
      kind: "TaskLineageChildV1",
      node: {
        kind: "TaskLineageNodeV1",
        taskId: "visible-terminal-child",
        parentTaskId: "anchor",
        parentMissing: false,
        referenceTaskIds: ["anchor"],
        intent: "analyze",
        status: "succeeded",
        requesterId: "requester-a",
        assignedWorkerId: "worker-a",
        createdAt: T0,
        depth: 1,
      },
      edges: ["canonical_parent", "reference"],
      rejoin: false,
    },
  ]);
});

test("task-lineage JSON-RPC uses one repository list snapshot and no per-item get scan", () => {
  let listCalls = 0;
  let getCalls = 0;
  const repository: TaskRuntimeRepository = {
    getTask() {
      getCalls += 1;
      return null;
    },
    listTasks() {
      listCalls += 1;
      return [
        task("repo-root", "worker-a"),
        task("repo-child", "worker-a", {
          parentTaskId: "repo-root",
        }),
      ];
    },
    upsertTask() {
      assert.fail("read projection must never write");
    },
  };
  const broker = new InMemoryA2ABroker(
    undefined,
    undefined,
    { taskRepository: repository },
  );
  const result = rpc(broker, "tasks/children", { taskId: "repo-root" });
  assert.ok("result" in result);
  assert.equal(listCalls, 1);
  assert.equal(getCalls, 0);
});

test("task-lineage JSON-RPC serves broad-visibility readers from the incremental index", () => {
  let listCalls = 0;
  const records = [
    task("index-root", "worker-a"),
    task("index-child", "worker-a", {
      parentTaskId: "index-root",
      parentRoundId: "index-round",
      parentRoundTotal: 1,
    }),
    task("index-other", "worker-b", { parentTaskId: "index-root" }),
  ];
  const repository: TaskRuntimeRepository = {
    getTask: () => null,
    listTasks() {
      listCalls += 1;
      return [...records];
    },
    upsertTask: () => assert.fail("read projection must never write"),
  };
  const broker = new InMemoryA2ABroker(
    undefined,
    undefined,
    { taskRepository: repository },
  );
  const hub = { id: "hub-node", kind: "service" as const, role: "hub" as const };
  const first = rpc(broker, "tasks/children", { taskId: "index-root" }, hub);
  const second = rpc(broker, "tasks/children", { taskId: "index-root" }, hub);
  const lineage = rpc(broker, "tasks/lineage", { taskId: "index-child" }, hub);
  const leaves = rpc(broker, "tasks/leaves", { parentRoundId: "index-round" }, hub);
  assert.equal(listCalls, 1, "the index must sync the repository once, not per request");
  assert.deepEqual(second, first, "repeated reads must be identical");

  // Hub visibility spans the whole universe, so the index path must return
  // exactly what a batch projection over all records returns.
  const batch = buildTaskLineageReadProjection(records);
  assert.deepEqual(
    resultOf(first),
    batch.children(parseTaskLineageChildrenRequestV1({ taskId: "index-root" })),
  );
  assert.deepEqual(
    resultOf(lineage),
    batch.lineage(parseTaskLineageLineageRequestV1({ taskId: "index-child" })),
  );
  assert.deepEqual(
    resultOf(leaves),
    batch.leaves(parseTaskLineageLeavesRequestV1({ parentRoundId: "index-round" })),
  );
});

test("task-lineage JSON-RPC keeps per-requester scoping while broad readers use the index", () => {
  const broker = brokerWithTasks([
    task("scope-root", "worker-a"),
    task("scope-hidden-child", "worker-b", { parentTaskId: "scope-root" }),
  ]);
  const hub = { id: "hub-node", kind: "service" as const, role: "hub" as const };
  type leavesResult = {
    leaves: Array<{ taskId: string }>;
    diagnostics: { scannedVisibleTasks: number };
  };
  const hubLeaves = resultOf<leavesResult>(rpc(broker, "tasks/leaves", {}, hub));
  assert.deepEqual(hubLeaves.leaves.map((node) => node.taskId), ["scope-hidden-child"]);
  assert.equal(hubLeaves.diagnostics.scannedVisibleTasks, 2);

  const analystLeaves = resultOf<leavesResult>(rpc(broker, "tasks/leaves", {}));
  assert.deepEqual(analystLeaves.leaves.map((node) => node.taskId), ["scope-root"]);
  assert.equal(analystLeaves.diagnostics.scannedVisibleTasks, 1);

  // Operator mode (no requester enforcement) is broad too and must agree
  // with the hub's index-served view.
  const operatorResponse = executeA2AJsonRpc(
    { jsonrpc: "2.0", id: "task-lineage-test", method: "tasks/leaves", params: {} },
    {
      broker,
      agentCard,
      requesterIdentity: null,
      enforceRequesterIdentity: false,
    },
  );
  const operatorLeaves = resultOf<leavesResult>(operatorResponse);
  assert.deepEqual(operatorLeaves, hubLeaves);
});

test("task-lineage JSON-RPC maps canonical cycles to identifier-free structured errors", () => {
  const broker = brokerWithTasks([
    task("cycle-a", "worker-a", { parentTaskId: "cycle-b" }),
    task("cycle-b", "worker-a", { parentTaskId: "cycle-a" }),
  ]);
  const response = rpc(
    broker,
    "tasks/lineage",
    { taskId: "cycle-a" },
  );
  assert.ok("error" in response);
  if (!("error" in response)) return;
  assert.equal(response.error.code, -32015);
  assert.equal(response.error.message, "task lineage cycle detected");
  const data = response.error.data as Array<Record<string, unknown>>;
  assert.equal(data[0]?.domain, "a2a-broker.local");
  assert.equal(data[0]?.reason, "TASK_LINEAGE_CYCLE");
  assert.equal(
    (data[0]?.metadata as Record<string, unknown>).brokerCode,
    "task_lineage_cycle",
  );
  assert.doesNotMatch(JSON.stringify(response), /cycle-a|cycle-b/);
});

test("task-lineage JSON-RPC strict parsers return canonical invalid-params errors", () => {
  const broker = brokerWithTasks([task("visible", "worker-a")]);
  for (const [method, params] of [
    ["tasks/children", { taskId: "visible", parentRoundId: "round" }],
    ["tasks/lineage", { taskId: "visible", maxDepth: 129 }],
    ["tasks/leaves", { status: ["completed"] }],
    ["tasks/leaves", { since: "invalid" }],
    ["tasks/leaves", { limit: 1_001 }],
    ["tasks/leaves", { cursor: "invalid" }],
    ["tasks/leaves", { unknown: true }],
  ] as const) {
    const response = rpc(broker, method, params);
    assert.ok("error" in response, `${method} ${JSON.stringify(params)}`);
    if (!("error" in response)) continue;
    assert.equal(response.error.code, -32602);
    assert.equal(
      (
        (response.error.data as Array<Record<string, unknown>>)[0]
          ?.metadata as Record<string, unknown>
      ).brokerCode,
      "bad_request",
    );
  }
});
