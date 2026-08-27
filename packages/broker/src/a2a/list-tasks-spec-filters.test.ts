import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryA2ABroker } from "../core/broker.js";
import { emptySnapshot } from "../core/store.js";
import type { TaskRecord } from "../core/types.js";
import { createBrokerAgentCard } from "./agent-card.js";
import { executeA2AJsonRpc, type ExecuteJsonRpcOptions } from "./json-rpc.js";

/**
 * A2A v1.0 ListTasks spec-vocabulary filters (#1912 D2, slice 1 of #1997).
 *
 * The spec-path parser accepts only the pinned v1.0.1 proto vocabulary:
 * `TASK_STATE_*` for `status`, `contextId`, and the pagination/artifact fields.
 * Unknown keys and known-but-unsupported parameters fail closed (-32602)
 * instead of being silently dropped — the silent-drop behavior is exactly the
 * mismatch the #1912 audit called out (see also the tenant guard added in
 * #1924). The headerless legacy envelope keeps its historical parser and is
 * untouched by this slice.
 */

const agentCard = createBrokerAgentCard({
  serviceName: "list-tasks-spec-filters-test-broker",
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
    responseShape: "spec",
    ...overrides,
  };
}

/**
 * The fixture covers every projected-state boundary the status filter must
 * respect (task-projection mapTaskState):
 *
 * | task          | internal status | checkpoint             | approvalOutcome | projected state   |
 * | ------------- | --------------- | ---------------------- | --------------- | ----------------- |
 * | queued        | queued          | —                      | —               | SUBMITTED         |
 * | running       | running         | —                      | —               | WORKING           |
 * | interrupted   | running         | awaiting_operator      | —               | INPUT_REQUIRED    |
 * | blocked       | blocked         | —                      | —               | AUTH_REQUIRED     |
 * | completed     | succeeded       | —                      | —               | COMPLETED         |
 * | failed        | failed          | —                      | —               | FAILED            |
 * | canceled      | canceled        | —                      | approved        | CANCELED          |
 * | rejected      | canceled        | —                      | rejected        | REJECTED          |
 */
const STATE_MATRIX: TaskRecord[] = [
  task("queued"),
  task("running", { status: "running", updatedAt: "2026-08-21T10:01:00.000Z" }),
  task("interrupted", {
    status: "running",
    updatedAt: "2026-08-21T10:02:00.000Z",
    checkpoint: {
      state: "awaiting_operator",
      checkpointId: "ckpt-interrupted",
      reason: "needs operator input",
      recordedAt: "2026-08-21T10:02:00.000Z",
      recordedBy: "worker-a",
    },
  }),
  task("blocked", { status: "blocked", updatedAt: "2026-08-21T10:03:00.000Z" }),
  task("completed", {
    status: "succeeded",
    updatedAt: "2026-08-21T10:04:00.000Z",
    completedAt: "2026-08-21T10:04:30.000Z",
  }),
  task("failed", { status: "failed", updatedAt: "2026-08-21T10:05:00.000Z" }),
  task("canceled", {
    status: "canceled",
    updatedAt: "2026-08-21T10:06:00.000Z",
    approvalOutcome: { status: "approved", approvalId: "ap-canceled", decidedAt: "2026-08-21T10:06:00.000Z", decidedBy: "operator-a" },
  }),
  task("rejected", {
    status: "canceled",
    updatedAt: "2026-08-21T10:07:00.000Z",
    approvalOutcome: { status: "rejected", approvalId: "ap-rejected", decidedAt: "2026-08-21T10:07:00.000Z", decidedBy: "operator-a" },
  }),
];

function listIds(
  broker: InMemoryA2ABroker,
  params: Record<string, unknown>,
  shapeOverride?: Partial<ExecuteJsonRpcOptions>,
): string[] {
  const response = executeA2AJsonRpc(
    { jsonrpc: "2.0", id: 1, method: "ListTasks", params },
    options(broker, shapeOverride),
  );
  if ("error" in response) {
    throw new Error(
      `ListTasks failed unexpectedly: ${response.error.code} ${response.error.message}`,
    );
  }
  const tasks = (response.result as { tasks?: Array<{ id?: string }> }).tasks ?? [];
  return tasks.map((entry) => entry.id as string);
}

function expectInvalidParams(
  broker: InMemoryA2ABroker,
  params: Record<string, unknown>,
  messagePart: string | RegExp,
): void {
  const response = executeA2AJsonRpc(
    { jsonrpc: "2.0", id: 1, method: "ListTasks", params },
    options(broker),
  );
  assert.ok("error" in response, `expected failure for ${JSON.stringify(params)}`);
  assert.equal(response.error.code, -32602, `expected Invalid params for ${JSON.stringify(params)}`);
  assert.match(response.error.message, new RegExp(messagePart));
}

test("spec status filter maps TASK_STATE_* onto projected states", () => {
  const broker = brokerWithTasks(STATE_MATRIX);

  assert.deepEqual(listIds(broker, { status: "TASK_STATE_SUBMITTED" }), ["queued"]);
  assert.deepEqual(listIds(broker, { status: "TASK_STATE_WORKING" }), ["running"]);
  // an operator-interrupt checkpoint outranks plain working in the projection
  assert.deepEqual(listIds(broker, { status: "TASK_STATE_INPUT_REQUIRED" }), ["interrupted"]);
  assert.deepEqual(listIds(broker, { status: "TASK_STATE_AUTH_REQUIRED" }), ["blocked"]);
  assert.deepEqual(listIds(broker, { status: "TASK_STATE_COMPLETED" }), ["completed"]);
  assert.deepEqual(listIds(broker, { status: "TASK_STATE_FAILED" }), ["failed"]);
  assert.deepEqual(listIds(broker, { status: "TASK_STATE_CANCELED" }), ["canceled"]);
  assert.deepEqual(listIds(broker, { status: "TASK_STATE_REJECTED" }), ["rejected"]);
});

test("spec status filter requires the normative SCREAMING_SNAKE vocabulary", () => {
  const broker = brokerWithTasks(STATE_MATRIX);

  expectInvalidParams(broker, { status: "working" }, "TASK_STATE_");
  expectInvalidParams(broker, { status: "queued" }, "TASK_STATE_");
  expectInvalidParams(broker, { status: "NOT_A_REAL_STATE" }, "TASK_STATE_");
});

// Proto3 enum zero is both the default and explicitly-sent `UNSPECIFIED`; a
// filter holding it carries no constraint, matching a client that omits the
// field entirely.
test("TASK_STATE_UNSPECIFIED means no status constraint, not a match on nothing", () => {
  const broker = brokerWithTasks(STATE_MATRIX);

  const ids = listIds(broker, { status: "TASK_STATE_UNSPECIFIED" });
  assert.equal(ids.length, STATE_MATRIX.length);
});

test("contextId filters by conversation; snake_case alias accepted (ProtoJSON)", () => {
  const broker = brokerWithTasks([
    task("a", { exchangeId: "ctx-1" }),
    task("b", { exchangeId: "ctx-2" }),
  ]);

  assert.deepEqual(listIds(broker, { contextId: "ctx-1" }), ["a"]);
  assert.deepEqual(listIds(broker, { context_id: "ctx-2" }), ["b"]);
});

test("internal-vocabulary filter keys are not part of the spec surface", () => {
  const broker = brokerWithTasks([task("a"), task("b")]);

  expectInvalidParams(broker, { claimedBy: "worker-a" }, "claimedBy");
  expectInvalidParams(broker, { targetNodeId: "worker-a" }, "targetNodeId");
  expectInvalidParams(broker, { anythingElse: 1 }, "anythingElse");
});

test("pagination params are honored as of #1997 slice 2 (fail-closed only on invalid values)", () => {
  const broker = brokerWithTasks(Array.from({ length: 30 }, (_, index) => task(`bulk-${index}`)));

  // large pageSize clamps to the documented maximum instead of erroring
  assert.equal(listIds(broker, { pageSize: 150 }).length, 30);
  // empty pageToken is the proto default "first page"
  assert.doesNotThrow(() => listIds(broker, { pageToken: "" }));
  // a real timestamp is accepted and filters inclusively
  assert.doesNotThrow(() => listIds(broker, { statusTimestampAfter: "2026-08-20T00:00:00Z" }));
  // invalid values still fail closed
  expectInvalidParams(broker, { pageSize: 0 }, /pageSize/);
  expectInvalidParams(broker, { pageToken: "garbage" }, /pageToken/);
  expectInvalidParams(broker, { statusTimestampAfter: "nope" }, /statusTimestampAfter/);
});

test("historyLength is honored trivially because the projection has no per-task history", () => {
  const broker = brokerWithTasks([task("a"), task("b")]);

  assert.equal(listIds(broker, { historyLength: 5 }).length, 2);
  expectInvalidParams(broker, { historyLength: -1 }, "historyLength");
  expectInvalidParams(broker, { history_length: "many" }, "history_length");
});

test("includeArtifacts elides the artifacts key by default and on explicit false (#1912 D4)", () => {
  const broker = brokerWithTasks([task("a"), task("b")]);

  const listTasks = (params: Record<string, unknown>): Array<Record<string, unknown>> => {
    const response = executeA2AJsonRpc(
      { jsonrpc: "2.0", id: 1, method: "ListTasks", params },
      options(broker),
    );
    if ("error" in response) {
      throw new Error(`ListTasks failed unexpectedly: ${response.error.code} ${response.error.message}`);
    }
    return (response.result as { tasks?: Array<Record<string, unknown>> }).tasks ?? [];
  };

  for (const params of [{}, { includeArtifacts: false }, { include_artifacts: false }]) {
    const tasks = listTasks(params);
    assert.equal(tasks.length, 2);
    for (const entry of tasks) {
      assert.equal(
        Object.hasOwn(entry, "artifacts"),
        false,
        `artifacts must be elided entirely for ${JSON.stringify(params)} — never [] or null`,
      );
    }
  }

  expectInvalidParams(broker, { includeArtifacts: "yes" }, "includeArtifacts");
  expectInvalidParams(broker, { include_artifacts: 1 }, "include_artifacts");
});

test("includeArtifacts=true always carries the artifacts key", () => {
  const broker = brokerWithTasks([task("a")]);

  const response = executeA2AJsonRpc(
    { jsonrpc: "2.0", id: 1, method: "ListTasks", params: { includeArtifacts: true } },
    options(broker),
  );
  assert.ok(!("error" in response));
  const first = ((response.result as { tasks?: Array<Record<string, unknown>> }).tasks ?? [])[0];
  assert.equal(Object.hasOwn(first ?? {}, "artifacts"), true, "true guarantees the key");
  assert.ok(Array.isArray(first?.artifacts), "artifacts stay an array when included");
});

test("the artifacts flag is shape-only: paging can flip it without changing membership", () => {
  const broker = brokerWithTasks([task("a"), task("b")]);

  const firstPage = executeA2AJsonRpc(
    { jsonrpc: "2.0", id: 1, method: "ListTasks", params: { pageSize: 1 } },
    options(broker),
  );
  assert.ok(!("error" in firstPage));
  const firstResult = firstPage.result as {
    tasks: Array<Record<string, unknown>>;
    nextPageToken: string;
    totalSize: number;
  };
  assert.equal(Object.hasOwn(firstResult.tasks[0], "artifacts"), false);

  const secondPage = executeA2AJsonRpc(
    {
      jsonrpc: "2.0",
      id: 2,
      method: "ListTasks",
      params: { pageSize: 1, pageToken: firstResult.nextPageToken, includeArtifacts: true },
    },
    options(broker),
  );
  assert.ok(!("error" in secondPage), "flipping the flag must not invalidate the cursor scope");
  const secondResult = secondPage.result as {
    tasks: Array<{ id?: string } & Record<string, unknown>>;
    totalSize: number;
  };
  assert.equal(secondResult.tasks.length, 1);
  assert.equal(Object.hasOwn(secondResult.tasks[0], "artifacts"), true);
  assert.equal(secondResult.totalSize, firstResult.totalSize, "membership metrics stay consistent");
});

test("spec GetTask keeps artifacts — it has no includeArtifacts proto field", () => {
  const broker = brokerWithTasks([task("a")]);

  const response = executeA2AJsonRpc(
    { jsonrpc: "2.0", id: 1, method: "GetTask", params: { id: "a" } },
    options(broker),
  );
  assert.ok(!("error" in response));
  // The spec shape returns the proto-JSON Task directly as the result (the
  // legacy envelope wraps it in { task }).
  const taskResult = response.result as Record<string, unknown>;
  assert.equal(Object.hasOwn(taskResult, "artifacts"), true, "GetTask is out of D4 scope");
});

test("the tenant guard still fires before spec filtering", () => {
  const broker = brokerWithTasks([task("a")]);

  expectInvalidParams(broker, { tenant: "undeclared-tenant", status: "TASK_STATE_FAILED" }, "tenant");
});

test("legacy envelope parser is unchanged by this slice", () => {
  const broker = brokerWithTasks(STATE_MATRIX);

  // internal vocabulary still works through the headerless legacy path
  assert.deepEqual(listIds(broker, { status: "queued" }, { responseShape: "legacy" }), ["queued"]);
  // and unknown keys are still tolerated there (historical behavior)
  assert.equal(listIds(broker, { anythingElse: 1 }, { responseShape: "legacy" }).length, STATE_MATRIX.length);
});
