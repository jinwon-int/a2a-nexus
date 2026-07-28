import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryA2ABroker } from "../core/broker.js";
import { emptySnapshot } from "../core/store.js";
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

test("task-lineage JSON-RPC excludes hidden children from leaves, counts, cursors, anomalies, and round hints", () => {
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

  const round = resultOf<{
    children: unknown[];
    round?: unknown;
    page: { nextCursor: string | null };
    diagnostics: { anomalies: unknown[] };
  }>(
    rpc(broker, "tasks/children", { parentRoundId: "hidden-round" }),
  );
  assert.deepEqual(round.children, []);
  assert.equal(round.round, undefined);
  assert.equal(round.page.nextCursor, null);
  assert.deepEqual(round.diagnostics.anomalies, []);
  assert.doesNotMatch(JSON.stringify(round), /hidden-child/);
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
