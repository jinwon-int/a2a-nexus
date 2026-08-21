import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryA2ABroker } from "../core/broker.js";
import { emptySnapshot } from "../core/store.js";
import type { TaskRecord } from "../core/types.js";
import { createBrokerAgentCard } from "./agent-card.js";
import { executeA2AJsonRpc, type ExecuteJsonRpcOptions } from "./json-rpc.js";

/**
 * A2A v1.0 ListTasks ordering (#1912 D11).
 *
 * The spec requires ListTasks results to be ordered by **status timestamp,
 * descending**. The projected status timestamp is `completedAt ?? updatedAt`
 * (see task-projection.ts), which diverges from `createdAt` for any task that
 * has been claimed, run, completed, or canceled — i.e. almost every terminal
 * task. These fixtures pin the divergence so a createdAt-ordered read cannot
 * pass.
 */

const agentCard = createBrokerAgentCard({
  serviceName: "list-tasks-ordering-test-broker",
  publicBaseUrl: "https://broker.test/",
});

function task(id: string, overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id,
    intent: "analyze",
    status: "queued",
    requester: { id: "requester-a", kind: "service", role: "researcher" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    targetNodeId: "worker-a",
    assignedWorkerId: "worker-a",
    payload: {},
    message: `message-${id}`,
    createdAt: "2026-08-21T10:00:00.000Z",
    updatedAt: "2026-08-21T10:00:00.000Z",
    ...overrides,
  };
}

/**
 * createdAt order and status-timestamp order disagree on purpose:
 *
 * | task | createdAt | status timestamp      |
 * | ---- | --------- | --------------------- |
 * | old-completed | 10:00 | 10:30 (completedAt) |
 * | mid-queued    | 10:15 | 10:15 (updatedAt)   |
 * | new-running   | 10:20 | 10:25 (updatedAt)   |
 *
 * createdAt desc  => new-running, mid-queued, old-completed
 * statusTs desc   => old-completed, new-running, mid-queued
 */
const DIVERGENT_TASKS: TaskRecord[] = [
  task("old-completed", {
    status: "succeeded",
    createdAt: "2026-08-21T10:00:00.000Z",
    updatedAt: "2026-08-21T10:30:00.000Z",
    completedAt: "2026-08-21T10:30:00.000Z",
  }),
  task("mid-queued", {
    status: "queued",
    createdAt: "2026-08-21T10:15:00.000Z",
    updatedAt: "2026-08-21T10:15:00.000Z",
  }),
  task("new-running", {
    status: "running",
    createdAt: "2026-08-21T10:20:00.000Z",
    updatedAt: "2026-08-21T10:25:00.000Z",
  }),
];

function brokerWithTasks(tasks: TaskRecord[]): InMemoryA2ABroker {
  return new InMemoryA2ABroker(undefined, { ...emptySnapshot(), tasks });
}

function options(
  broker: InMemoryA2ABroker,
  overrides?: Partial<ExecuteJsonRpcOptions>,
): ExecuteJsonRpcOptions {
  return {
    broker,
    agentCard,
    publicBaseUrl: "https://broker.test",
    requesterIdentity: { id: "worker-a", kind: "node", role: "analyst" },
    enforceRequesterIdentity: false,
    ...overrides,
  };
}

function listTasks(
  broker: InMemoryA2ABroker,
  responseShape: "spec" | "legacy",
): Array<Record<string, unknown>> {
  const result = executeA2AJsonRpc(
    { jsonrpc: "2.0", id: 1, method: "ListTasks", params: {} },
    options(broker, { responseShape }),
  );
  assert.ok("result" in result, "ListTasks should succeed");
  if (!("result" in result)) return [];
  const tasks = (result.result as { tasks?: Array<Record<string, unknown>> }).tasks;
  assert.ok(Array.isArray(tasks), "ListTasks should return a tasks array");
  return tasks ?? [];
}

function statusTimestamp(task: Record<string, unknown>): string {
  const status = task.status as { timestamp?: unknown } | undefined;
  assert.equal(typeof status?.timestamp, "string", "each task must carry a status timestamp");
  return status?.timestamp as string;
}

test("ListTasks (spec shape) orders tasks by status timestamp descending, not createdAt", () => {
  const broker = brokerWithTasks(DIVERGENT_TASKS);

  const tasks = listTasks(broker, "spec");

  assert.deepEqual(
    tasks.map((entry) => entry.id),
    ["old-completed", "new-running", "mid-queued"],
    "spec ListTasks must order by status timestamp (completedAt ?? updatedAt) descending",
  );
});

test("ListTasks (spec shape) returns non-increasing status timestamps", () => {
  const broker = brokerWithTasks(DIVERGENT_TASKS);

  const timestamps = listTasks(broker, "spec").map(statusTimestamp);

  for (let index = 1; index < timestamps.length; index += 1) {
    assert.ok(
      timestamps[index - 1] >= timestamps[index],
      `status timestamps must not increase: ${timestamps[index - 1]} before ${timestamps[index]}`,
    );
  }
});

test("ListTasks (spec shape) breaks status-timestamp ties by task id for a stable order", () => {
  const sameInstant = "2026-08-21T11:00:00.000Z";
  const broker = brokerWithTasks([
    task("tie-c", { createdAt: "2026-08-21T10:03:00.000Z", updatedAt: sameInstant }),
    task("tie-a", { createdAt: "2026-08-21T10:01:00.000Z", updatedAt: sameInstant }),
    task("tie-b", { createdAt: "2026-08-21T10:02:00.000Z", updatedAt: sameInstant }),
  ]);

  const tasks = listTasks(broker, "spec");

  assert.deepEqual(
    tasks.map((entry) => entry.id),
    ["tie-a", "tie-b", "tie-c"],
    "equal status timestamps must fall back to ascending task id, not insertion order",
  );
});

test("ListTasks (legacy shape) keeps the broker-native createdAt ordering", () => {
  const broker = brokerWithTasks(DIVERGENT_TASKS);

  const tasks = listTasks(broker, "legacy");

  assert.deepEqual(
    tasks.map((entry) => entry.id),
    ["new-running", "mid-queued", "old-completed"],
    "the headerless legacy envelope keeps createdAt-descending ordering (documented deviation)",
  );
});
