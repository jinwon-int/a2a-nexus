import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryA2ABroker } from "../core/broker.js";
import { emptySnapshot } from "../core/store.js";
import type { TaskRecord } from "../core/types.js";
import { createBrokerAgentCard } from "./agent-card.js";
import { executeA2AJsonRpc, type ExecuteJsonRpcOptions } from "./json-rpc.js";

/**
 * A2A v1.0 ListTasks bounded pagination (#1912 D3, slice 2 of #1997).
 *
 * The spec-path response must honor the proto contract: pageSize defaults to
 * 50, is bounded to [1, 100] (larger requests clamp — the server "may return
 * fewer" than requested, never more than the maximum), pages continue via an
 * opaque nextPageToken, totalSize counts every matching task before paging,
 * and statusTimestampAfter filters on the projected status timestamp with an
 * inclusive (>=) boundary. Cursors are opaque, checksummed, scoped to their
 * exact filter context, and fail closed when forged, tampered, stale, or
 * replayed against a different query.
 */

const agentCard = createBrokerAgentCard({
  serviceName: "list-tasks-spec-pagination-test-broker",
  publicBaseUrl: "https://broker.test/",
});

let seq = 0;
function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  seq += 1;
  const id = overrides.id ?? `t${String(seq).padStart(3, "0")}`;
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

interface PageResult {
  ids: string[];
  nextPageToken: string;
  pageSize: number;
  totalSize: number;
}

function listPage(
  broker: InMemoryA2ABroker,
  params: Record<string, unknown>,
  shapeOverride?: Partial<ExecuteJsonRpcOptions>,
): PageResult {
  const response = executeA2AJsonRpc(
    { jsonrpc: "2.0", id: 1, method: "ListTasks", params },
    options(broker, shapeOverride),
  );
  if ("error" in response) {
    throw new Error(
      `ListTasks failed unexpectedly: ${response.error.code} ${response.error.message}`,
    );
  }
  const result = response.result as {
    tasks?: Array<{ id?: string }>;
    nextPageToken?: string;
    pageSize?: number;
    totalSize?: number;
  };
  return {
    ids: (result.tasks ?? []).map((entry) => entry.id as string),
    nextPageToken: result.nextPageToken ?? "",
    pageSize: result.pageSize ?? -1,
    totalSize: result.totalSize ?? -1,
  };
}

function expectInvalidParams(
  broker: InMemoryA2ABroker,
  params: Record<string, unknown>,
  messagePart: RegExp,
): void {
  const response = executeA2AJsonRpc(
    { jsonrpc: "2.0", id: 1, method: "ListTasks", params },
    options(broker),
  );
  assert.ok("error" in response, `expected failure for ${JSON.stringify(params)}`);
  assert.equal(response.error.code, -32602, `expected Invalid params for ${JSON.stringify(params)}`);
  assert.match(response.error.message, messagePart);
}

function manyTasks(count: number, status: TaskRecord["status"] = "queued"): TaskRecord[] {
  return Array.from({ length: count }, (_, index) =>
    task({
      status,
      updatedAt: new Date(Date.UTC(2026, 7, 21, 10, 0, index)).toISOString(),
    }),
  );
}

test("default pageSize is 50 when unspecified", () => {
  const broker = brokerWithTasks(manyTasks(55));

  const page = listPage(broker, {});
  assert.equal(page.ids.length, 50);
  assert.equal(page.pageSize, 50);
  assert.equal(page.totalSize, 55);
  assert.notEqual(page.nextPageToken, "");
});

test("pageSize caps at 100; larger requests clamp instead of erroring", () => {
  const broker = brokerWithTasks(manyTasks(120));

  const page = listPage(broker, { pageSize: 100 });
  assert.equal(page.ids.length, 100);
  assert.equal(page.pageSize, 100);
  assert.equal(page.totalSize, 120);

  const clamped = listPage(broker, { pageSize: 150 });
  assert.equal(clamped.ids.length, 100);
  assert.equal(clamped.pageSize, 100);
});

test("pageSize below the minimum of 1 is a client error", () => {
  const broker = brokerWithTasks([task()]);

  expectInvalidParams(broker, { pageSize: 0 }, /pageSize/);
  expectInvalidParams(broker, { pageSize: -1 }, /pageSize/);
  expectInvalidParams(broker, { pageSize: 2.5 }, /pageSize/);
  expectInvalidParams(broker, { pageSize: "5" }, /pageSize/);
});

test("pagination walks every task exactly once across pages", () => {
  const broker = brokerWithTasks(manyTasks(120));

  const collected: string[] = [];
  let token: string | undefined = undefined;
  let pages = 0;
  while (pages < 5) {
    const page = listPage(broker, {
      ...(token !== undefined ? { pageToken: token } : {}),
      pageSize: 100,
    });
    collected.push(...page.ids);
    pages += 1;
    if (page.nextPageToken === "") break;
    token = page.nextPageToken;
  }

  assert.equal(pages, 2);
  assert.equal(collected.length, 120);
  assert.equal(new Set(collected).size, 120, "no duplicates across pages");
});

test("the last page carries an empty nextPageToken and the used pageSize", () => {
  const broker = brokerWithTasks(manyTasks(10));

  const page = listPage(broker, { pageSize: 100 });
  assert.equal(page.nextPageToken, "");
  assert.equal(page.pageSize, 10);
  assert.equal(page.totalSize, 10);
});

test("a page token is idempotent: replaying it returns the same page", () => {
  const broker = brokerWithTasks(manyTasks(30));

  const first = listPage(broker, { pageSize: 10 });
  assert.notEqual(first.nextPageToken, "");
  const replay = listPage(broker, { pageSize: 10, pageToken: first.nextPageToken });
  assert.deepEqual(replay.ids, listPage(broker, { pageSize: 10, pageToken: first.nextPageToken }).ids);
  assert.notEqual(replay.nextPageToken, "");
});

test("forged or tampered page tokens fail closed", () => {
  const broker = brokerWithTasks(manyTasks(30));

  expectInvalidParams(broker, { pageToken: "garbage" }, /pageToken/);
  expectInvalidParams(broker, { pageToken: "eyJ2IjoxfQ.not-a-checksum" }, /pageToken/);
  expectInvalidParams(broker, { pageToken: "###" }, /pageToken/);
});

test("a cursor is bound to its query scope: replaying under a different filter rejects", () => {
  const broker = brokerWithTasks([
    ...manyTasks(30, "succeeded"),
    ...manyTasks(30, "failed"),
  ]);

  const scoped = listPage(broker, { status: "TASK_STATE_COMPLETED", pageSize: 10 });
  assert.notEqual(scoped.nextPageToken, "");
  expectInvalidParams(
    broker,
    { status: "TASK_STATE_FAILED", pageToken: scoped.nextPageToken },
    /scope|different/,
  );
  // and the same token under its own scope still works
  const same = listPage(broker, { status: "TASK_STATE_COMPLETED", pageSize: 10, pageToken: scoped.nextPageToken });
  assert.equal(same.ids.length, 10);
});

test("statusTimestampAfter filters inclusively on the projected status timestamp", () => {
  const broker = brokerWithTasks([
    task({ id: "early", updatedAt: "2026-08-21T09:00:00.000Z", completedAt: "2026-08-21T09:30:00.000Z", status: "succeeded" }),
    task({ id: "boundary", updatedAt: "2026-08-21T10:00:00.000Z", completedAt: "2026-08-21T10:00:00.000Z", status: "succeeded" }),
    task({ id: "later", updatedAt: "2026-08-21T11:00:00.000Z", status: "succeeded" }),
  ]);

  const ids = listPage(broker, { statusTimestampAfter: "2026-08-21T10:00:00Z" }).ids;
  assert.deepEqual(ids.sort(), ["boundary", "later"]);
  expectInvalidParams(broker, { statusTimestampAfter: "not-a-timestamp" }, /statusTimestampAfter/);
});

test("status filter and pagination compose with totalSize over matches", () => {
  const broker = brokerWithTasks([
    ...manyTasks(12, "succeeded"),
    ...manyTasks(8, "failed"),
  ]);

  const page = listPage(broker, {
    status: "TASK_STATE_FAILED",
    pageSize: 3,
  });
  assert.equal(page.ids.length, 3);
  assert.equal(page.pageSize, 3);
  assert.equal(page.totalSize, 8, "totalSize counts all matching tasks, not just the page");
  assert.notEqual(page.nextPageToken, "");
});

test("the legacy envelope is unaffected by bounded pagination", () => {
  const broker = brokerWithTasks(manyTasks(120));

  const response = executeA2AJsonRpc(
    { jsonrpc: "2.0", id: 1, method: "ListTasks", params: {} },
    options(broker, { responseShape: "legacy" }),
  );
  assert.ok(!("error" in response));
  const tasks = (response.result as { tasks?: unknown[] }).tasks ?? [];
  assert.equal(tasks.length, 120, "legacy still returns the full unbounded set");
});
