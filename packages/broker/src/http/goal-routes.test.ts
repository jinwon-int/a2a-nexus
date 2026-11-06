/**
 * Goal routes (#2499 slice 1): POST /goals, GET /goals, GET /goals/:id.
 *
 * Handler-level tests pin auth classes and validation; server-level tests
 * pin route-table registration, HTTP status mapping, and the goal-linked
 * POST /tasks refusals on the SQLite backend (in-process and worker-thread).
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Readable } from "node:stream";
import test from "node:test";

import { BrokerError, InMemoryA2ABroker } from "../core/broker.js";
import type { BrokerStateStore } from "../core/store/store.js";
import type { RequesterIdentity } from "../core/transport/request-security.js";
import { jsonHeaders, registerTestWorker, startTestServer, withEnv } from "../server-test-helpers.js";
import { handleGoalRoutesIfMatched } from "./goal-routes.js";

class CapturingResponse extends EventEmitter {
  statusCode?: number;
  body = "";
  writeHead(statusCode: number): this {
    this.statusCode = statusCode;
    return this;
  }
  end(chunk?: string): this {
    if (chunk) this.body += chunk;
    return this;
  }
}

function makeRouter() {
  const broker = new InMemoryA2ABroker();
  async function route(method: string, path: string, options: { body?: unknown; identity?: RequesterIdentity | null; enforce?: boolean } = {}) {
    const res = new CapturingResponse();
    const url = new URL(path, "http://broker.test");
    const handled = await handleGoalRoutesIfMatched({
      method,
      segments: url.pathname.split("/").filter(Boolean),
      req: Readable.from([JSON.stringify(options.body ?? {})]) as IncomingMessage,
      res: res as unknown as ServerResponse,
      url,
      broker,
      stateStore: {} as BrokerStateStore,
      enforceRequesterIdentity: options.enforce ?? true,
      requesterIdentity: options.identity === undefined ? { id: "op-1", kind: "user", role: "operator" } : options.identity,
    });
    return { handled, status: res.statusCode, json: res.body ? JSON.parse(res.body) : undefined };
  }
  return { broker, route };
}

function rejectsWith(code: BrokerError["code"], pattern?: RegExp) {
  return (error: unknown) => error instanceof BrokerError && error.code === code && (!pattern || pattern.test(error.message));
}

test("handler: operator creates a goal; the requester is the authenticated caller", async () => {
  const { route } = makeRouter();
  const created = await route("POST", "/goals", {
    body: { id: "goal-1", title: "Ship slice 1", objective: "Schema and routes", budget: { maxChildAttempts: 2 } },
  });
  assert.equal(created.handled, true);
  assert.equal(created.status, 201);
  assert.equal(created.json.goal.id, "goal-1");
  assert.equal(created.json.goal.status, "pursuing");
  assert.deepEqual(created.json.goal.requester, { id: "op-1", kind: "user", role: "operator" });
  assert.deepEqual(created.json.goal.budget, { maxChildAttempts: 2 });
});

test("handler: write is hub/operator only; reads allow the observer roles", async () => {
  const { route } = makeRouter();
  await route("POST", "/goals", { body: { id: "goal-r", title: "readable" } });
  const analyst = { id: "an-1", kind: "node" as const, role: "analyst" as const };
  await assert.rejects(() => route("POST", "/goals", { body: { title: "x" }, identity: analyst }), rejectsWith("unauthorized", /goal\.create/));
  await assert.rejects(() => route("POST", "/goals", { body: { title: "x" }, identity: null }), rejectsWith("unauthorized"));
  assert.equal((await route("GET", "/goals", { identity: analyst })).status, 200);
  assert.equal((await route("GET", "/goals/goal-r", { identity: analyst })).status, 200);
  await assert.rejects(() => route("GET", "/goals", { identity: null }), rejectsWith("unauthorized"));
  const publisher = { id: "pub-1", kind: "node" as const, role: "publisher" as const };
  await assert.rejects(() => route("GET", "/goals/goal-r", { identity: publisher }), rejectsWith("unauthorized", /goal\.get/));
  // Identity enforcement off: no role check, like every other route.
  assert.equal((await route("GET", "/goals", { identity: null, enforce: false })).status, 200);
});

test("handler: request validation and unmatched shapes", async () => {
  const { route } = makeRouter();
  await assert.rejects(() => route("POST", "/goals", { body: {} }), rejectsWith("bad_request", /title is required/));
  await assert.rejects(() => route("POST", "/goals", { body: { title: 7 } }), rejectsWith("bad_request", /title must be a string/));
  await assert.rejects(() => route("POST", "/goals", { body: { title: "t", budget: [] } }), rejectsWith("bad_request", /budget must be an object/));
  await assert.rejects(
    () => route("POST", "/goals", { body: { title: "t", budget: { maxUsd: 5 } } }),
    rejectsWith("bad_request", /unsupported fields: maxUsd/),
  );
  await assert.rejects(() => route("GET", "/goals?status=active"), rejectsWith("bad_request", /status must be one of/));
  await assert.rejects(() => route("GET", "/goals?limit=0"), rejectsWith("bad_request", /limit/));
  await assert.rejects(() => route("GET", "/goals/missing"), rejectsWith("not_found", /goal not found/));
  assert.equal((await route("DELETE", "/goals/x")).handled, false);
  assert.equal((await route("POST", "/goals/x")).handled, false);
  assert.equal((await route("GET", "/goals/x/history")).handled, false);
  assert.equal((await route("GET", "/goalsx")).handled, false);
});

test("handler: list honours status and limit; detail carries linked-task counts", async () => {
  const { broker, route } = makeRouter();
  broker.registerWorker({
    nodeId: "worker-a",
    role: "analyst",
    capabilities: { canAnalyze: true, canBackfill: false, canPatchWorkspace: false, canPromoteLive: false, workspaceIds: ["t"], environments: ["research"] },
  });
  await route("POST", "/goals", { body: { id: "goal-a", title: "A" } });
  await route("POST", "/goals", { body: { id: "goal-b", title: "B" } });
  broker.createTask({
    id: "task-a1",
    intent: "chat",
    requester: { id: "hub", kind: "node", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    goalId: "goal-a",
  });
  const list = await route("GET", "/goals");
  assert.equal(list.json.kind, "goals");
  assert.equal(list.json.count, 2);
  assert.equal((await route("GET", "/goals?limit=1")).json.count, 1);
  assert.equal((await route("GET", "/goals?status=paused")).json.count, 0);
  assert.equal((await route("GET", "/goals?status=pursuing")).json.count, 2);
  const detail = await route("GET", "/goals/goal-a");
  assert.equal(detail.json.goal.id, "goal-a");
  assert.deepEqual(detail.json.linkedTasks, { total: 1, byStatus: { queued: 1 } });
  assert.deepEqual((await route("GET", "/goals/goal-b")).json.linkedTasks, { total: 0, byStatus: {} });
});

const HUB = { "x-a2a-requester-id": "test-hub", "x-a2a-requester-role": "hub" };

async function exerciseGoalServer(baseUrl: string): Promise<void> {
  await registerTestWorker(baseUrl, "worker-a", "analyst");

  // Auth: no identity is 401; a non-write role is 401 on POST.
  const anonymous = await fetch(`${baseUrl}/goals`);
  assert.equal(anonymous.status, 401);
  const analystWrite = await fetch(`${baseUrl}/goals`, {
    method: "POST",
    headers: jsonHeaders({ "x-a2a-requester-id": "an-1", "x-a2a-requester-role": "analyst" }),
    body: JSON.stringify({ title: "nope" }),
  });
  assert.equal(analystWrite.status, 401);

  const created = await fetch(`${baseUrl}/goals`, {
    method: "POST",
    headers: jsonHeaders(HUB),
    body: JSON.stringify({ id: "goal-http", title: "HTTP goal", budget: { maxResourceUnits: 5 } }),
  });
  assert.equal(created.status, 201);
  assert.equal((await created.json()).goal.status, "pursuing");

  const duplicate = await fetch(`${baseUrl}/goals`, {
    method: "POST",
    headers: jsonHeaders(HUB),
    body: JSON.stringify({ id: "goal-http", title: "again" }),
  });
  assert.equal(duplicate.status, 409);

  const list = await fetch(`${baseUrl}/goals`, { headers: HUB });
  assert.equal(list.status, 200);
  const listed = await list.json();
  assert.deepEqual(listed.goals.map((goal: { id: string }) => goal.id), ["goal-http"]);

  const missing = await fetch(`${baseUrl}/goals/goal-missing`, { headers: HUB });
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error.code, "not_found");

  // POST /tasks with a goal link.
  const createTask = (id: string, goalId: string) =>
    fetch(`${baseUrl}/tasks`, {
      method: "POST",
      headers: jsonHeaders(HUB),
      body: JSON.stringify({
        id,
        intent: "chat",
        requester: { id: "test-hub", kind: "node", role: "hub" },
        target: { id: "worker-a", kind: "node", role: "analyst" },
        message: "goal-linked",
        taskOrigin: "api",
        goalId,
      }),
    });
  const linked = await createTask("task-http-1", "goal-http");
  assert.equal(linked.status, 201);
  assert.equal((await linked.json()).goalId, "goal-http");

  const unknownGoal = await createTask("task-http-2", "goal-missing");
  assert.equal(unknownGoal.status, 404);
  const unknownBody = await unknownGoal.json();
  assert.equal(unknownBody.error.code, "not_found");
  assert.deepEqual(unknownBody.error.details, { goalId: "goal-missing" });

  const detail = await fetch(`${baseUrl}/goals/goal-http`, { headers: HUB });
  assert.equal(detail.status, 200);
  const detailBody = await detail.json();
  assert.equal(detailBody.goal.id, "goal-http");
  assert.deepEqual(detailBody.linkedTasks, { total: 1, byStatus: { queued: 1 } });

  const task = await fetch(`${baseUrl}/tasks/task-http-1`, { headers: HUB });
  assert.equal(task.status, 200);
  assert.equal((await task.json()).goalId, "goal-http");
}

test("server (SQLite backend): goal routes are registered, authenticated, and gate POST /tasks", async () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-broker-goal-routes-"));
  const server = await startTestServer({
    stateStore: undefined,
    persistenceBackend: "sqlite",
    stateFile: join(dir, "state.json"),
    sqliteFile: join(dir, "state.sqlite"),
  });
  try {
    await exerciseGoalServer(server.baseUrl);
    // A non-pursuing goal is a 409 conflict on POST /tasks. No pause route
    // exists in slice 1, so the row is changed directly in the store file.
    const db = new DatabaseSync(join(dir, "state.sqlite"));
    try {
      const row = db.prepare("SELECT payload FROM broker_goals WHERE id = 'goal-http'").get() as { payload: string };
      const paused = { ...JSON.parse(row.payload), status: "paused" };
      db.prepare("UPDATE broker_goals SET status = 'paused', payload = ? WHERE id = 'goal-http'").run(JSON.stringify(paused));
    } finally {
      db.close();
    }
    const refused = await fetch(`${server.baseUrl}/tasks`, {
      method: "POST",
      headers: jsonHeaders(HUB),
      body: JSON.stringify({
        id: "task-http-paused",
        intent: "chat",
        requester: { id: "test-hub", kind: "node", role: "hub" },
        target: { id: "worker-a", kind: "node", role: "analyst" },
        goalId: "goal-http",
      }),
    });
    assert.equal(refused.status, 409);
    const body = await refused.json();
    assert.equal(body.error.code, "invalid_transition");
    assert.deepEqual(body.error.details, { goalId: "goal-http", goalStatus: "paused" });
  } finally {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("server (SQLite worker-thread persistence): goal writes and goal-linked task creates agree", async () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-broker-goal-routes-wt-"));
  await withEnv({ BROKER_PERSISTENCE_QUEUE_WORKER_THREAD: "1" }, async () => {
    const server = await startTestServer({
      stateStore: undefined,
      persistenceBackend: "sqlite",
      stateFile: join(dir, "state.json"),
      sqliteFile: join(dir, "state.sqlite"),
    });
    try {
      await exerciseGoalServer(server.baseUrl);
    } finally {
      await server.close();
    }
  });
  rmSync(dir, { recursive: true, force: true });
});

test("server (injected snapshot store): goal routes work without a goal table", async () => {
  const server = await startTestServer();
  try {
    await exerciseGoalServer(server.baseUrl);
  } finally {
    await server.close();
  }
});
