/**
 * Goal routes (#2499 slice 1): POST /goals, GET /goals, GET /goals/:id.
 *
 * GET /budgets/status (#2499 slice 2) and the budget routes (#2499 slice 3b:
 * POST /budgets, PATCH /budgets/:id, GET /budgets, status additions) are
 * covered at the end of the file.
 *
 * Handler-level tests pin auth classes and validation; server-level tests
 * pin route-table registration, HTTP status mapping, and the goal-linked
 * POST /tasks refusals on the SQLite backend (in-process and worker-thread),
 * goal survival across a JSON-file-backend restart, and the idempotent
 * replay behaviour when only goalId differs.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Readable } from "node:stream";
import test from "node:test";

import { BrokerError, InMemoryA2ABroker } from "../core/broker.js";
import { SqliteBrokerStateStore, type BrokerStateStore } from "../core/store/store.js";
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

function makeRouter(broker = new InMemoryA2ABroker()) {
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
  // Goal id pattern and text limits: 400, never trimmed.
  for (const id of [" goal-1", "goal-1 ", "goal 1", "a".repeat(129)]) {
    await assert.rejects(() => route("POST", "/goals", { body: { id, title: "t" } }), rejectsWith("bad_request", /goal id must match/));
  }
  await assert.rejects(
    () => route("POST", "/goals", { body: { title: "x".repeat(201) } }),
    rejectsWith("bad_request", /title must be at most 200 characters/),
  );
  await assert.rejects(
    () => route("POST", "/goals", { body: { title: "t", objective: "o".repeat(2001) } }),
    rejectsWith("bad_request", /objective must be at most 2000 characters/),
  );
  await assert.rejects(() => route("GET", "/goals/bad%20id"), rejectsWith("bad_request", /goal id must match/));
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

test("server: padded or malformed goal ids are 400 on POST /goals, GET /goals/:id and POST /tasks", async () => {
  const server = await startTestServer();
  try {
    await registerTestWorker(server.baseUrl, "worker-a", "analyst");
    const created = await fetch(`${server.baseUrl}/goals`, {
      method: "POST",
      headers: jsonHeaders(HUB),
      body: JSON.stringify({ id: "goal-shape", title: "shape" }),
    });
    assert.equal(created.status, 201);
    const paddedGoal = await fetch(`${server.baseUrl}/goals`, {
      method: "POST",
      headers: jsonHeaders(HUB),
      body: JSON.stringify({ id: "goal-shape ", title: "padded" }),
    });
    assert.equal(paddedGoal.status, 400);
    assert.equal((await paddedGoal.json()).error.code, "bad_request");
    const paddedRead = await fetch(`${server.baseUrl}/goals/%20goal-shape`, { headers: HUB });
    assert.equal(paddedRead.status, 400);
    const paddedTask = await fetch(`${server.baseUrl}/tasks`, {
      method: "POST",
      headers: jsonHeaders(HUB),
      body: JSON.stringify({
        id: "task-padded",
        intent: "chat",
        requester: { id: "test-hub", kind: "node", role: "hub" },
        target: { id: "worker-a", kind: "node", role: "analyst" },
        taskOrigin: "api",
        goalId: " goal-shape",
      }),
    });
    assert.equal(paddedTask.status, 400);
    const body = await paddedTask.json();
    assert.equal(body.error.code, "bad_request");
    assert.match(body.error.message, /goalId/);
  } finally {
    await server.close();
  }
});

test("server (JSON-file backend): goals survive a broker restart on the same state file and accept linked tasks", async () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-broker-goal-routes-json-"));
  const stateFile = join(dir, "state.json");
  const options = { stateStore: undefined, persistenceBackend: "json-file" as const, stateFile };
  try {
    const first = await startTestServer(options);
    try {
      await registerTestWorker(first.baseUrl, "worker-a", "analyst");
      const created = await fetch(`${first.baseUrl}/goals`, {
        method: "POST",
        headers: jsonHeaders(HUB),
        body: JSON.stringify({ id: "goal-json", title: "JSON goal", objective: "Survive a restart" }),
      });
      assert.equal(created.status, 201);
    } finally {
      await first.close();
    }
    const onDisk = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.deepEqual(onDisk.goals.map((goal: { id: string }) => goal.id), ["goal-json"]);

    const second = await startTestServer(options);
    try {
      const detail = await fetch(`${second.baseUrl}/goals/goal-json`, { headers: HUB });
      assert.equal(detail.status, 200);
      const detailBody = await detail.json();
      assert.equal(detailBody.goal.objective, "Survive a restart");
      assert.equal(detailBody.goal.status, "pursuing");

      const linked = await fetch(`${second.baseUrl}/tasks`, {
        method: "POST",
        headers: jsonHeaders(HUB),
        body: JSON.stringify({
          id: "task-json-1",
          intent: "chat",
          requester: { id: "test-hub", kind: "node", role: "hub" },
          target: { id: "worker-a", kind: "node", role: "analyst" },
          taskOrigin: "api",
          goalId: "goal-json",
        }),
      });
      assert.equal(linked.status, 201);
      assert.equal((await linked.json()).goalId, "goal-json");
      const after = await (await fetch(`${second.baseUrl}/goals/goal-json`, { headers: HUB })).json();
      assert.deepEqual(after.linkedTasks, { total: 1, byStatus: { queued: 1 } });
    } finally {
      await second.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("server (V1 idempotency authority): a create replay differing only in goalId is a 409 idempotency_conflict", async () => {
  const server = await startTestServer({ brokerId: "brokeralpha", sharedStateIdempotencyV1: true });
  try {
    await registerTestWorker(server.baseUrl, "worker-a", "analyst");
    for (const id of ["goal-one", "goal-two"]) {
      const created = await fetch(`${server.baseUrl}/goals`, {
        method: "POST",
        headers: jsonHeaders(HUB),
        body: JSON.stringify({ id, title: id }),
      });
      assert.equal(created.status, 201);
    }
    const create = (goalId: string) =>
      fetch(`${server.baseUrl}/tasks`, {
        method: "POST",
        headers: jsonHeaders(HUB),
        body: JSON.stringify({
          id: "task-idem-goal",
          intent: "chat",
          requester: { id: "test-hub", kind: "node", role: "hub" },
          target: { id: "worker-a", kind: "node", role: "analyst" },
          message: "same everything",
          taskOrigin: "api",
          goalId,
        }),
      });
    assert.equal((await create("goal-one")).status, 201);
    const sameReplay = await create("goal-one");
    assert.equal(sameReplay.status, 200);
    assert.equal((await sameReplay.json()).task.goalId, "goal-one");
    const relink = await create("goal-two");
    assert.equal(relink.status, 409);
    assert.equal((await relink.json()).error.code, "idempotency_conflict");
    const stored = await (await fetch(`${server.baseUrl}/tasks/task-idem-goal`, { headers: HUB })).json();
    assert.equal(stored.goalId, "goal-one");
  } finally {
    await server.close();
  }
});

// --- GET /budgets/status (#2499 slice 2) -------------------------------------

const TELEMETRY = {
  schemaVersion: "a2a.analysis-execution-telemetry.v1",
  source: "claude_cli_envelope",
  inputTokens: 100,
  outputTokens: 40,
  cacheReadInputTokens: 5_000,
  cacheCreationInputTokens: 20,
  costUsd: 0.5,
};

test("handler: budget status validates its query and reports available:false without a spend ledger", async () => {
  const { route } = makeRouter();
  const ok = await route("GET", "/budgets/status");
  assert.equal(ok.handled, true);
  assert.equal(ok.status, 200);
  assert.equal(ok.json.kind, "budget-status");
  assert.equal(ok.json.available, false, "no SQLite store: the spend ledger is SQLite-only");
  assert.match(ok.json.period, /^\d{4}-\d{2}$/);
  assert.equal(ok.json.timeZone, "Asia/Seoul");
  assert.deepEqual(ok.json.scopes, []);
  assert.equal(ok.json.period_total, null);
  assert.equal(ok.json.scope_total, null);
  assert.equal("total" in ok.json, false);
  assert.equal("ledger" in ok.json, false, "no ledger, no ledger coverage");

  await assert.rejects(() => route("GET", "/budgets/status?scope_type=team"), rejectsWith("bad_request", /scope_type must be one of agent, lane, goal/));
  await assert.rejects(() => route("GET", "/budgets/status?scope_id=worker-a"), rejectsWith("bad_request", /scope_id requires scope_type/));
  for (const period of ["2026-13", "2026-1", "202611", "2026-11-01", "26-11"]) {
    await assert.rejects(() => route("GET", `/budgets/status?period=${period}`), rejectsWith("bad_request", /period must be YYYY-MM/));
  }
  await assert.rejects(() => route("GET", "/budgets/status?scope_type=goal&scope_id=bad%20id"), rejectsWith("bad_request", /scope_id must match/));
  await assert.rejects(() => route("GET", `/budgets/status?scope_type=agent&scope_id=${"a".repeat(257)}`), rejectsWith("bad_request", /scope_id must match/));
  await assert.rejects(() => route("GET", "/budgets/status?scope_type=lane&scope_id="), rejectsWith("bad_request", /scope_id must match/));

  // Auth: the GET /goals read posture.
  const analyst = { id: "an-1", kind: "node" as const, role: "analyst" as const };
  assert.equal((await route("GET", "/budgets/status", { identity: analyst })).status, 200);
  await assert.rejects(() => route("GET", "/budgets/status", { identity: null }), rejectsWith("unauthorized"));
  const publisher = { id: "pub-1", kind: "node" as const, role: "publisher" as const };
  await assert.rejects(() => route("GET", "/budgets/status", { identity: publisher }), rejectsWith("unauthorized", /budget\.status/));
  assert.equal((await route("GET", "/budgets/status", { identity: null, enforce: false })).status, 200);

  // Unmatched shapes fall through (#2499 slice 3b: GET /budgets is the list route now).
  assert.equal((await route("POST", "/budgets/status")).handled, false);
  assert.equal((await route("GET", "/budgets/status/x")).handled, false);
  assert.equal((await route("DELETE", "/budgets/x")).handled, false);
  assert.equal((await route("PATCH", "/budgets")).handled, false);
});

test("handler: token totals above Number.MAX_SAFE_INTEGER are exact decimal strings; safe totals stay numbers", async () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-budget-status-bigint-"));
  const store = new SqliteBrokerStateStore(join(dir, "state.sqlite"));
  try {
    const broker = new InMemoryA2ABroker(store, store.load(), { budgetPeriodTimeZone: "UTC" });
    const row = (taskId: string, agentId: string, tokens: number) => ({
      taskId,
      recordedAt: "2026-11-06T00:00:00.000Z",
      periodKey: "2026-11",
      agentId,
      lane: "analyze",
      goalId: null,
      costUsd: 0,
      inputTokens: tokens,
      outputTokens: 1,
      costKnown: false,
    });
    // 9,008 rows at the 1e12 cap pass 2^53 - 1 (9,007,199,254,740,991).
    store.saveHotEntities({
      spendEvents: [
        ...Array.from({ length: 9_008 }, (_, index) => row(`big-${index}`, "worker-big", 1e12)),
        row("small-1", "worker-small", 5),
      ],
    });
    const { route } = makeRouter(broker);
    const all = await route("GET", "/budgets/status?period=2026-11");
    assert.equal(all.json.period_total.input_tokens_total, "9008000000000005");
    assert.equal(all.json.period_total.output_tokens_total, 9_009, "a safe total stays a number");
    const big = await route("GET", "/budgets/status?period=2026-11&scope_type=agent&scope_id=worker-big");
    assert.equal(big.json.scope_total.input_tokens_total, "9008000000000000");
    const small = await route("GET", "/budgets/status?period=2026-11&scope_type=agent&scope_id=worker-small");
    assert.equal(small.json.scope_total.input_tokens_total, 5);
    assert.equal(small.json.period_total.input_tokens_total, "9008000000000005");
    // #2499 slice 3a: rows written straight to the ledger have no task rows,
    // so nothing is missing; the coverage metadata came from construction.
    assert.deepEqual(all.json.ledger, {
      firstPeriod: broker.budgetPeriodKey(),
      timeZone: "UTC",
      missingSpendRows: 0,
      periodComplete: "2026-11" > broker.budgetPeriodKey(),
    });
    // periodComplete: only a period strictly after the first one.
    assert.equal((await route("GET", `/budgets/status?period=${broker.budgetPeriodKey()}`)).json.ledger.periodComplete, false);
    assert.equal((await route("GET", "/budgets/status?period=2999-01")).json.ledger.periodComplete, true);
    assert.equal((await route("GET", "/budgets/status?period=1999-01")).json.ledger.periodComplete, false);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("handler: ledger.missingSpendRows counts terminal task rows without a spend row; null when the count is unavailable or throws", async () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-budget-status-missing-"));
  const store = new SqliteBrokerStateStore(join(dir, "state.sqlite"));
  try {
    const broker = new InMemoryA2ABroker(store, store.load(), { budgetPeriodTimeZone: "UTC" });
    // Two terminal task rows the ledger has no row for (written past the broker), one queued.
    const row = (id: string, status: string) => ({
      id,
      intent: "analyze",
      requester: { id: "hub-a", kind: "node", role: "hub" },
      target: { id: "worker-a", kind: "node", role: "analyst" },
      targetNodeId: "worker-a",
      status,
      payload: {},
      artifactIds: [],
      createdAt: "2026-11-01T00:00:00.000Z",
      updatedAt: "2026-11-01T00:00:00.000Z",
      taskOrigin: "api",
    }) as unknown as Parameters<SqliteBrokerStateStore["upsertHotTasks"]>[0][number];
    store.upsertHotTasks([row("m-1", "succeeded"), row("m-2", "canceled"), row("m-3", "queued")]);
    const { route } = makeRouter(broker);
    const counted = await route("GET", "/budgets/status");
    assert.equal(counted.status, 200);
    assert.equal(counted.json.ledger.missingSpendRows, 2);

    store.countTerminalTasksMissingSpend = () => {
      throw new Error("disk I/O error");
    };
    const failed = await route("GET", "/budgets/status");
    assert.equal(failed.status, 200, "a failed count does not fail the status read");
    assert.equal(failed.json.ledger.missingSpendRows, null);
    assert.equal(failed.json.available, true);
    assert.equal(failed.json.ledger.timeZone, "UTC", "the other ledger fields stay");
    assert.ok(failed.json.period_total);

    Object.assign(store, { countTerminalTasksMissingSpend: undefined });
    assert.equal((await route("GET", "/budgets/status")).json.ledger.missingSpendRows, null, "a store that cannot count");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

const WORKER_A = { "x-a2a-requester-id": "worker-a", "x-a2a-requester-role": "analyst" };

async function exerciseBudgetServer(baseUrl: string): Promise<void> {
  await registerTestWorker(baseUrl, "worker-a", "analyst");
  assert.equal(
    (await fetch(`${baseUrl}/goals`, { method: "POST", headers: jsonHeaders(HUB), body: JSON.stringify({ id: "goal-spend", title: "Spend" }) })).status,
    201,
  );
  const run = async (id: string, intent: string, goalId: string | undefined, terminal: "complete" | "fail") => {
    const created = await fetch(`${baseUrl}/tasks`, {
      method: "POST",
      headers: jsonHeaders(HUB),
      body: JSON.stringify({
        id,
        intent,
        requester: { id: "test-hub", kind: "node", role: "hub" },
        target: { id: "worker-a", kind: "node", role: "analyst" },
        assignedWorkerId: "worker-a",
        message: id,
        taskOrigin: "api",
        ...(goalId ? { goalId } : {}),
      }),
    });
    assert.equal(created.status, 201, await created.clone().text());
    const claimed = await fetch(`${baseUrl}/tasks/${id}/claim`, { method: "POST", headers: jsonHeaders(WORKER_A), body: JSON.stringify({ workerId: "worker-a" }) });
    assert.equal(claimed.status, 200, await claimed.clone().text());
    const body = terminal === "complete"
      ? { workerId: "worker-a", result: { summary: "done", output: { executionTelemetry: TELEMETRY } } }
      : { workerId: "worker-a", error: { code: "openclaw_analysis_failed", message: "bridge", details: { bridgeFailure: { code: "x", executionTelemetry: { ...TELEMETRY, costUsd: 0.25 } } } } };
    const finished = await fetch(`${baseUrl}/tasks/${id}/${terminal}`, { method: "POST", headers: jsonHeaders(WORKER_A), body: JSON.stringify(body) });
    assert.equal(finished.status, 200, await finished.clone().text());
  };
  await run("spend-1", "analyze", "goal-spend", "complete");
  await run("spend-2", "chat", undefined, "fail");

  const anonymous = await fetch(`${baseUrl}/budgets/status`);
  assert.equal(anonymous.status, 401);

  const status = await fetch(`${baseUrl}/budgets/status`, { headers: HUB });
  assert.equal(status.status, 200);
  assert.equal(status.headers.get("cache-control"), "no-store");
  const all = await status.json();
  assert.equal(all.available, true);
  assert.equal(all.timeZone, "Asia/Seoul");
  assert.match(all.period, /^\d{4}-\d{2}$/);
  assert.equal("total" in all, false, "renamed: period_total is unambiguous");
  assert.equal(all.scope_total, null, "no named scope");
  assert.deepEqual(all.period_total, {
    usd_known_total: 0.75,
    input_tokens_total: 240,
    output_tokens_total: 80,
    task_count: 2,
    cost_unknown_task_count: 0,
    unmetered_task_count: 0,
  });
  assert.deepEqual(
    all.scopes.map((scope: { scope_type: string; scope_id: string; task_count: number; limits: unknown }) =>
      `${scope.scope_type}:${scope.scope_id}:${scope.task_count}:${String(scope.limits)}`),
    ["agent:worker-a:2:null", "lane:analyze:1:null", "lane:chat:1:null", "goal:goal-spend:1:null"],
  );
  assert.equal(all.truncated, false);
  // #2499 slice 3a: ledger coverage (additive). The ledger started recording
  // this period, so it is not complete (later periods: the handler test).
  assert.deepEqual(all.ledger, { firstPeriod: all.period, timeZone: "Asia/Seoul", missingSpendRows: 0, periodComplete: false });

  const goal = await (await fetch(`${baseUrl}/budgets/status?scope_type=goal&scope_id=goal-spend&period=${all.period}`, { headers: HUB })).json();
  assert.equal(goal.scopeType, "goal");
  // A named scope: scope_total is that scope; period_total stays the whole period.
  assert.deepEqual(goal.scope_total, {
    usd_known_total: 0.5,
    input_tokens_total: 120,
    output_tokens_total: 40,
    task_count: 1,
    cost_unknown_task_count: 0,
    unmetered_task_count: 0,
  });
  assert.deepEqual(goal.period_total, all.period_total);
  assert.deepEqual(goal.scopes, [{
    scope_type: "goal",
    scope_id: "goal-spend",
    usd_known_total: 0.5,
    input_tokens_total: 120,
    output_tokens_total: 40,
    task_count: 1,
    cost_unknown_task_count: 0,
    unmetered_task_count: 0,
    limits: null,
  }]);

  const idle = await (await fetch(`${baseUrl}/budgets/status?scope_type=agent&scope_id=worker-idle`, { headers: HUB })).json();
  assert.equal(idle.scopes.length, 1, "a named scope with no spend reports zero totals");
  assert.equal(idle.scopes[0].task_count, 0);
  assert.equal(idle.scopes[0].scope_id, "worker-idle");
  assert.equal(idle.scope_total.task_count, 0, "a named scope with no spend has a zero scope_total");
  assert.equal(idle.period_total.task_count, 2);

  // scope_type alone lists that type's scopes; no single scope_total.
  const lanes = await (await fetch(`${baseUrl}/budgets/status?scope_type=lane`, { headers: HUB })).json();
  assert.equal(lanes.scope_total, null);
  assert.deepEqual(lanes.scopes.map((scope: { scope_id: string }) => scope.scope_id), ["analyze", "chat"]);

  const otherMonth = await (await fetch(`${baseUrl}/budgets/status?period=1999-01`, { headers: HUB })).json();
  assert.equal(otherMonth.period_total.task_count, 0);
  assert.deepEqual(otherMonth.scopes, []);
  assert.equal(otherMonth.ledger.periodComplete, false, "a period before the ledger started is not complete");

  const bad = await fetch(`${baseUrl}/budgets/status?scope_type=team`, { headers: HUB });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error.code, "bad_request");
  assert.equal((await fetch(`${baseUrl}/budgets/status?period=2026-13`, { headers: HUB })).status, 400);
}

test("server (SQLite backend): terminal transitions feed GET /budgets/status", async () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-broker-budget-status-"));
  const server = await startTestServer({
    stateStore: undefined,
    persistenceBackend: "sqlite",
    stateFile: join(dir, "state.json"),
    sqliteFile: join(dir, "state.sqlite"),
  });
  try {
    await exerciseBudgetServer(server.baseUrl);
  } finally {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("server (SQLite worker-thread persistence): spend rows ride the queued terminal write", async () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-broker-budget-status-wt-"));
  await withEnv({ BROKER_PERSISTENCE_QUEUE_WORKER_THREAD: "1" }, async () => {
    const server = await startTestServer({
      stateStore: undefined,
      persistenceBackend: "sqlite",
      stateFile: join(dir, "state.json"),
      sqliteFile: join(dir, "state.sqlite"),
    });
    try {
      await exerciseBudgetServer(server.baseUrl);
      assert.equal(server.runtime.broker.hasSpendLedger(), true, "the worker-thread proxy store keeps the ledger capability");
      // Each terminal route awaited its queued write: exactly one row per task.
      const db = new DatabaseSync(join(dir, "state.sqlite"));
      try {
        const rows = db.prepare("SELECT task_id FROM broker_spend_events ORDER BY task_id").all() as Array<{ task_id: string }>;
        assert.deepEqual(rows.map((row) => row.task_id), ["spend-1", "spend-2"]);
      } finally {
        db.close();
      }
    } finally {
      await server.close();
    }
  });
  rmSync(dir, { recursive: true, force: true });
});

test("server (injected snapshot store): GET /budgets/status reports available:false", async () => {
  const server = await startTestServer();
  try {
    const res = await fetch(`${server.baseUrl}/budgets/status?scope_type=lane`, { headers: HUB });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.available, false);
    assert.equal(body.scopeType, "lane");
    assert.deepEqual(body.scopes, []);
    assert.equal(body.period_total, null);
    assert.equal(body.scope_total, null);
  } finally {
    await server.close();
  }
});

test("server: the budget period zone comes from A2A_BUDGET_PERIOD_TIME_ZONE and an invalid zone fails startup", async () => {
  await withEnv({ A2A_BUDGET_PERIOD_TIME_ZONE: "UTC" }, async () => {
    const server = await startTestServer();
    try {
      const body = await (await fetch(`${server.baseUrl}/budgets/status`, { headers: HUB })).json();
      assert.equal(body.timeZone, "UTC");
    } finally {
      await server.close();
    }
  });
  await withEnv({ A2A_BUDGET_PERIOD_TIME_ZONE: "Mars/Olympus" }, async () => {
    await assert.rejects(() => startTestServer(), /invalid A2A_BUDGET_PERIOD_TIME_ZONE='Mars\/Olympus'/);
  });
});

// --- Budgets (#2499 slice 3b) ------------------------------------------------------

function sqliteRouter(options: { budgetEnforcementMode?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "a2a-budget-routes-"));
  const store = new SqliteBrokerStateStore(join(dir, "state.sqlite"));
  const broker = new InMemoryA2ABroker(store, store.load(), { budgetPeriodTimeZone: "UTC", ...options });
  const { route } = makeRouter(broker);
  return {
    broker,
    store,
    route,
    close() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("handler: budget create / update / list — auth, validation, 404, 409, audit", async () => {
  const r = sqliteRouter();
  try {
    const analyst = { id: "an-1", kind: "node" as const, role: "analyst" as const };
    const publisher = { id: "pub-1", kind: "node" as const, role: "publisher" as const };
    const create = (body: unknown, identity?: RequesterIdentity | null) => r.route("POST", "/budgets", { body, ...(identity !== undefined ? { identity } : {}) });

    const created = await create({ id: "b-lane", scopeType: "lane", scopeId: "analyze", period: "month", limitUsd: 20, warnPct: 90 });
    assert.equal(created.status, 201);
    assert.deepEqual({ ...created.json.budget, createdAt: "t" }, {
      id: "b-lane",
      scopeType: "lane",
      scopeId: "analyze",
      period: "month",
      limitUsd: 20,
      limitTokens: null,
      warnPct: 90,
      enforce: "refuse",
      createdBy: "op-1",
      createdAt: "t",
    });
    assert.equal("updatedAt" in created.json.budget, false, "no updated_at column: createdAt only");

    // Auth: writes are hub/operator; reads the GET /goals set.
    await assert.rejects(() => create({ scopeType: "lane", scopeId: "chat", period: "month", limitUsd: 1 }, analyst), rejectsWith("unauthorized", /budget\.create/));
    await assert.rejects(() => r.route("PATCH", "/budgets/b-lane", { body: { warnPct: 5 }, identity: analyst }), rejectsWith("unauthorized", /budget\.update/));
    await assert.rejects(() => create({}, null), rejectsWith("unauthorized"));
    assert.equal((await r.route("GET", "/budgets", { identity: analyst })).status, 200);
    await assert.rejects(() => r.route("GET", "/budgets", { identity: publisher }), rejectsWith("unauthorized", /budget\.list/));

    // Validation: 400, never trimmed.
    const base = { scopeType: "agent", scopeId: "worker-a", period: "month" };
    const invalid: Array<[unknown, RegExp]> = [
      [[], /JSON object body/],
      [{ ...base, limitUsd: 1, extra: true }, /unsupported fields: extra/],
      [{ ...base }, /limitUsd, limitTokens, or both/],
      [{ ...base, limitUsd: 0 }, /limitUsd/],
      [{ ...base, limitUsd: 1e10 }, /limitUsd/],
      [{ ...base, limitTokens: 2.5 }, /limitTokens/],
      [{ ...base, limitTokens: 1, warnPct: 0 }, /warnPct/],
      [{ ...base, limitTokens: 1, enforce: "stop" }, /enforce/],
      [{ ...base, limitTokens: 1, period: "day" }, /period/],
      [{ ...base, limitTokens: 1, scopeType: "team" }, /scopeType/],
      [{ ...base, limitTokens: 1, scopeId: "a".repeat(257) }, /scopeId must match/],
      [{ ...base, limitTokens: 1, scopeType: "goal", scopeId: "goal-1 " }, /scopeId must match/],
      [{ ...base, limitTokens: 1, scopeType: 123 }, /scopeType/],
      [{ ...base, limitTokens: 1, scopeId: ["worker-a"] }, /scopeId must match/],
      [{ ...base, limitTokens: 1, id: 123 }, /budget id must match/],
      [{ ...base, limitTokens: 1, id: " b-1" }, /budget id must match/],
    ];
    for (const [body, pattern] of invalid) {
      await assert.rejects(() => create(body), rejectsWith("bad_request", pattern), JSON.stringify(body));
    }
    await assert.rejects(
      () => create({ scopeType: "goal", scopeId: "goal-missing", period: "month", limitUsd: 1 }),
      rejectsWith("not_found", /goal not found/),
    );
    await assert.rejects(() => create({ id: "b-lane", ...base, limitUsd: 1 }), rejectsWith("invalid_transition", /already exists/));
    await assert.rejects(() => create({ scopeType: "lane", scopeId: "analyze", period: "month", limitTokens: 5 }), rejectsWith("invalid_transition", /budget for lane 'analyze'/));

    // PATCH: clear one limit, refuse clearing both, unknown fields, unknown id.
    const patched = await r.route("PATCH", "/budgets/b-lane", { body: { limitTokens: 1_000, limitUsd: null } });
    assert.equal(patched.status, 200);
    assert.equal(patched.json.budget.limitUsd, null);
    assert.equal(patched.json.budget.limitTokens, 1_000);
    await assert.rejects(() => r.route("PATCH", "/budgets/b-lane", { body: { limitTokens: null } }), rejectsWith("bad_request", /at least one/));
    await assert.rejects(() => r.route("PATCH", "/budgets/b-lane", { body: { scopeId: "chat" } }), rejectsWith("bad_request", /unsupported fields: scopeId/));
    await assert.rejects(() => r.route("PATCH", "/budgets/b-missing", { body: { warnPct: 5 } }), rejectsWith("not_found", /budget not found/));
    await assert.rejects(() => r.route("PATCH", "/budgets/bad%20id", { body: { warnPct: 5 } }), rejectsWith("bad_request", /budget id must match/));

    // List: filters and bounds.
    await create({ id: "b-agent", ...base, limitUsd: 2 });
    const all = await r.route("GET", "/budgets");
    assert.equal(all.json.kind, "budgets");
    assert.equal(all.json.available, true);
    assert.deepEqual(all.json.budgets.map((budget: { id: string }) => budget.id), ["b-agent", "b-lane"]);
    assert.deepEqual((await r.route("GET", "/budgets?scope_type=lane")).json.budgets.map((budget: { id: string }) => budget.id), ["b-lane"]);
    assert.equal((await r.route("GET", "/budgets?scope_type=agent&scope_id=worker-a")).json.count, 1);
    assert.equal((await r.route("GET", "/budgets?limit=1")).json.count, 1);
    assert.equal((await r.route("GET", "/budgets?limit=1000")).json.count, 2);
    // m9: strict integers only, route-side maximum 1000.
    for (const limit of ["0", "%205", "0x5", "1e3", "5.0", "1001", "-1", "", "05", "abc"]) {
      await assert.rejects(() => r.route("GET", `/budgets?limit=${limit}`), rejectsWith("bad_request", /limit must be an integer from 1 to 1000/), limit);
    }
    await assert.rejects(() => r.route("GET", "/budgets?scope_id=worker-a"), rejectsWith("bad_request", /scope_id requires scope_type/));
    await assert.rejects(() => r.route("GET", "/budgets?scope_type=team"), rejectsWith("bad_request", /scope_type/));

    // Audit events: created by the authenticated caller, update notes the changed fields.
    const audits = r.broker.listAuditEvents().filter((event) => event.targetType === "budget");
    assert.deepEqual(
      audits.map((event) => `${event.action}:${event.targetId}:${event.actorId}:${event.note}`).sort(),
      ["budget.created:b-agent:op-1:agent:worker-a", "budget.created:b-lane:op-1:lane:analyze", "budget.updated:b-lane:op-1:limitUsd,limitTokens"].sort(),
    );
  } finally {
    r.close();
  }
});

test("handler: budgets without the SQLite store — writes are 409 unsupported_operation, GET /budgets is available:false", async () => {
  const { route } = makeRouter();
  await assert.rejects(
    () => route("POST", "/budgets", { body: { scopeType: "lane", scopeId: "chat", period: "month", limitUsd: 1 } }),
    rejectsWith("unsupported_operation"),
  );
  await assert.rejects(() => route("PATCH", "/budgets/b-1", { body: { warnPct: 5 } }), rejectsWith("unsupported_operation"));
  const list = await route("GET", "/budgets");
  assert.equal(list.status, 200);
  assert.deepEqual({ ...list.json, reason: "r" }, { kind: "budgets", available: false, reason: "r", count: 0, budgets: [] });
  const status = await route("GET", "/budgets/status");
  assert.deepEqual(status.json.enforcement, { configuredMode: "off", effectiveMode: "off", reason: "mode_off" });
  assert.deepEqual(status.json.budgets, []);
  assert.deepEqual(status.json.checkFailed, { count: 0, lastAt: null });
  assert.equal(status.json.topRows, null);
});

test("handler: budget status — enforcement, budgets, limits, topRows, checkFailed; a failed ledger read still answers 200", async () => {
  const r = sqliteRouter({ budgetEnforcementMode: "on" });
  try {
    const period = r.broker.budgetPeriodKey();
    r.store.saveHotEntities({
      spendEvents: [
        { taskId: "s-1", recordedAt: "2026-11-06T00:00:00.000Z", periodKey: period, agentId: "worker-a", lane: "analyze", goalId: null, costUsd: 4, inputTokens: 10, outputTokens: 5, costKnown: true },
        { taskId: "s-2", recordedAt: "2026-11-06T00:00:00.000Z", periodKey: period, agentId: "worker-b", lane: "analyze", goalId: null, costUsd: 0, inputTokens: 700, outputTokens: 300, costKnown: false },
        { taskId: "s-3", recordedAt: "2026-11-06T00:00:00.000Z", periodKey: period, agentId: "worker-a", lane: "chat", goalId: null, costUsd: 1, inputTokens: 1, outputTokens: 1, costKnown: true },
      ],
    });
    await r.route("POST", "/budgets", { body: { id: "b-analyze", scopeType: "lane", scopeId: "analyze", period: "month", limitUsd: 5, limitTokens: 2_000, warnPct: 50 } });
    await r.route("POST", "/budgets", { body: { id: "b-a", scopeType: "agent", scopeId: "worker-a", period: "month", limitUsd: 100 } });

    const all = await r.route("GET", "/budgets/status");
    assert.equal(all.status, 200);
    assert.deepEqual(all.json.enforcement, { configuredMode: "on", effectiveMode: "shadow", reason: "period_incomplete" }, "decision 9");
    assert.deepEqual(all.json.checkFailed, { count: 0, lastAt: null });
    assert.equal(all.json.topRows, null, "topRows needs a named scope");
    assert.equal(all.json.budgetsTruncated, false);
    assert.deepEqual(all.json.budgets, [
      { id: "b-a", scopeType: "agent", scopeId: "worker-a", limitUsd: 100, limitTokens: null, warnPct: 80, enforce: "refuse", usdSpent: 5, tokensSpent: 17, usdExhausted: false, tokensExhausted: false, warn: false },
      { id: "b-analyze", scopeType: "lane", scopeId: "analyze", limitUsd: 5, limitTokens: 2_000, warnPct: 50, enforce: "refuse", usdSpent: 4, tokensSpent: 1_015, usdExhausted: false, tokensExhausted: false, warn: true },
    ]);
    // `limits` (slice 2: always null) now carries the scope's month budget.
    const limitsOf = (scopeType: string, scopeId: string) =>
      all.json.scopes.find((scope: { scope_type: string; scope_id: string }) => scope.scope_type === scopeType && scope.scope_id === scopeId)?.limits;
    assert.deepEqual(limitsOf("lane", "analyze"), { budgetId: "b-analyze", limitUsd: 5, limitTokens: 2_000, warnPct: 50, enforce: "refuse" });
    assert.equal(limitsOf("lane", "chat"), null);
    assert.equal(limitsOf("agent", "worker-a")?.budgetId, "b-a");

    const lane = await r.route("GET", "/budgets/status?scope_type=lane&scope_id=analyze&top=1");
    assert.deepEqual(lane.json.budgets.map((budget: { id: string }) => budget.id), ["b-analyze"], "budgets follow the scope filter");
    assert.equal(lane.json.topRows.limit, 1);
    assert.deepEqual(lane.json.topRows.byCost.map((row: { taskId: string }) => row.taskId), ["s-1"]);
    assert.deepEqual(lane.json.topRows.byTokens, [
      { taskId: "s-2", agentId: "worker-b", lane: "analyze", goalId: null, costUsd: 0, costKnown: false, tokens: 1_000, recordedAt: "2026-11-06T00:00:00.000Z" },
    ], "m8: tokens is a JSON number while safe");
    assert.equal((await r.route("GET", "/budgets/status?scope_type=lane&scope_id=analyze")).json.topRows.limit, 5, "default N");
    await assert.rejects(() => r.route("GET", "/budgets/status?top=3"), rejectsWith("bad_request", /top requires scope_type and scope_id/));
    for (const top of ["21", "0", "%205", "0x5", "1e1", "5.0", "-1", "05"]) {
      await assert.rejects(
        () => r.route("GET", `/budgets/status?scope_type=lane&scope_id=analyze&top=${top}`),
        rejectsWith("bad_request", /top must be an integer from 1 to 20/),
        top,
      );
    }
    assert.equal((await r.route("GET", "/budgets/status?scope_type=lane&scope_id=analyze&top=20")).json.topRows.limit, 20);

    // A failed claim-time read is counted; a failed status read still answers with it.
    const original = r.store.readSpendScopeUsage;
    r.store.readSpendScopeUsage = () => {
      throw new Error("disk I/O error");
    };
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      assert.equal(r.broker.evaluateClaimBudget({ lane: "analyze", workerId: "worker-a" }).checkFailed, true);
      const failed = await r.route("GET", "/budgets/status");
      assert.equal(failed.status, 200);
      assert.equal(failed.json.available, true, "m6: the ledger exists; available:false keeps meaning no SQLite ledger");
      assert.equal(failed.json.readError, "ledger_read_failed");
      assert.equal(failed.json.period_total, null);
      assert.equal(failed.json.ledger, null);
      assert.deepEqual(failed.json.budgets, []);
      assert.equal(failed.json.checkFailed.count, 1, "served from memory");
      assert.match(failed.json.checkFailed.lastAt, /^\d{4}-\d{2}-\d{2}T/);
      assert.equal(failed.json.enforcement.configuredMode, "on");
    } finally {
      console.warn = originalWarn;
      r.store.readSpendScopeUsage = original;
    }
    const recovered = (await r.route("GET", "/budgets/status")).json;
    assert.equal(recovered.available, true);
    assert.equal("readError" in recovered, false);
  } finally {
    r.close();
  }
});

test("handler: status limits come from every budget, not the first 200 evaluated (m5); topRows tokens past 2^53 is a string (m8)", async () => {
  const r = sqliteRouter();
  try {
    const period = r.broker.budgetPeriodKey();
    // 201 agent budgets: the `budgets` array stops at 200; `limits` still finds the last one.
    for (let index = 0; index <= 200; index += 1) {
      r.broker.createBudget({ id: `b-${String(index).padStart(3, "0")}`, scopeType: "agent", scopeId: `worker-${String(index).padStart(3, "0")}`, period: "month", limitUsd: 1, createdBy: "o" });
    }
    r.store.saveHotEntities({
      spendEvents: [{ taskId: "s-last", recordedAt: "2026-11-06T00:00:00.000Z", periodKey: period, agentId: "worker-200", lane: "analyze", goalId: null, costUsd: 0, inputTokens: 1, outputTokens: 1, costKnown: false }],
    });
    const status = (await r.route("GET", "/budgets/status?scope_type=agent")).json;
    assert.equal(status.budgets.length, 200);
    assert.equal(status.budgetsTruncated, true);
    assert.equal(status.scopes.find((scope: { scope_id: string }) => scope.scope_id === "worker-200")?.limits?.budgetId, "b-200");

    // topRows tokens: the store reads BigInt; the route projects it like the totals.
    const original = r.store.listTopSpendRows.bind(r.store);
    r.store.listTopSpendRows = (query) => original(query).map((row) => ({ ...row, tokens: 2n ** 60n }));
    const top = (await r.route("GET", "/budgets/status?scope_type=agent&scope_id=worker-200")).json;
    assert.equal(top.topRows.byTokens[0].tokens, (2n ** 60n).toString());
  } finally {
    r.close();
  }
});

test("M2: PATCH /budgets/:id invalid values, bodies and callers over HTTP", async () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-broker-budget-patch-"));
  const server = await startTestServer({
    rateLimitMaxRequests: 1_000,
    stateStore: undefined,
    persistenceBackend: "sqlite",
    stateFile: join(dir, "state.json"),
    sqliteFile: join(dir, "state.sqlite"),
  });
  try {
    const baseUrl = server.baseUrl;
    const created = await fetch(`${baseUrl}/budgets`, {
      method: "POST",
      headers: jsonHeaders(HUB),
      body: JSON.stringify({ id: "b-patch", scopeType: "lane", scopeId: "analyze", period: "month", limitUsd: 5, limitTokens: 10 }),
    });
    assert.equal(created.status, 201);
    const patch = (body: string, headers: Record<string, string> = jsonHeaders(HUB)) =>
      fetch(`${baseUrl}/budgets/b-patch`, { method: "PATCH", headers, body });
    const invalid: unknown[] = [
      { warnPct: 0 }, { warnPct: 101 }, { warnPct: 50.5 }, { warnPct: "50" },
      { enforce: "stop" },
      { limitUsd: 0 }, { limitUsd: -1 }, { limitUsd: 1e10 }, { limitUsd: "5" },
      { limitTokens: 2.5 }, { limitTokens: 0 }, { limitTokens: Number.MAX_SAFE_INTEGER + 1 }, { limitTokens: "5" },
      { limitUsd: null, limitTokens: null },
      {}, // no change: 400, not a 200 no-op
      [], "x", 5, null,
      { scopeType: "agent" },
    ];
    for (const body of invalid) {
      const res = await patch(JSON.stringify(body));
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.equal((await res.json()).error.code, "bad_request");
    }
    // NaN cannot travel in JSON (JSON.stringify turns it into null, a clear); the broker-level table covers it.
    const malformed = await patch("{\"warnPct\": ");
    assert.equal(malformed.status, 400, "malformed JSON");
    // Unauthenticated and read-role callers: 401 (the broker maps every role refusal to unauthorized).
    assert.equal((await patch(JSON.stringify({ warnPct: 5 }), jsonHeaders({}))).status, 401);
    assert.equal((await patch(JSON.stringify({ warnPct: 5 }), jsonHeaders({ "x-a2a-requester-id": "an-1", "x-a2a-requester-role": "analyst" }))).status, 401);
    const unchanged = await (await fetch(`${baseUrl}/budgets?scope_type=lane&scope_id=analyze`, { headers: HUB })).json();
    assert.deepEqual(unchanged.budgets.map((budget: { limitUsd: number; limitTokens: number; warnPct: number }) => [budget.limitUsd, budget.limitTokens, budget.warnPct]), [[5, 10, 80]]);
    const ok = await patch(JSON.stringify({ warnPct: 50 }));
    assert.equal(ok.status, 200);
  } finally {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("server: an injected broker whose enforcement mode differs from A2A_BUDGET_ENFORCEMENT_MODE fails startup (m4)", async () => {
  await withEnv({ A2A_BUDGET_ENFORCEMENT_MODE: "shadow" }, async () => {
    await assert.rejects(() => startTestServer({ broker: new InMemoryA2ABroker() }), /differs from the injected broker's budget enforcement mode 'off'/);
  });
  const server = await startTestServer({ broker: new InMemoryA2ABroker() });
  await server.close();
});

async function exerciseBudgetRoutesServer(baseUrl: string): Promise<void> {
  const post = (body: unknown, headers: Record<string, string> = HUB) =>
    fetch(`${baseUrl}/budgets`, { method: "POST", headers: jsonHeaders(headers), body: JSON.stringify(body) });
  const created = await post({ id: "b-http", scopeType: "lane", scopeId: "analyze", period: "month", limitUsd: 10 });
  assert.equal(created.status, 201, await created.clone().text());
  assert.equal((await created.json()).budget.createdBy, "test-hub");
  assert.equal((await post({ id: "b-http", scopeType: "lane", scopeId: "chat", period: "month", limitUsd: 1 })).status, 409);
  assert.equal((await post({ scopeType: "lane", scopeId: "analyze", period: "month", limitUsd: 1 })).status, 409);
  assert.equal((await post({ scopeType: "lane", scopeId: "chat", period: "month" })).status, 400);
  assert.equal((await post({ scopeType: "goal", scopeId: "goal-none", period: "month", limitUsd: 1 })).status, 404);
  assert.equal((await post({ scopeType: "lane", scopeId: "chat", period: "month", limitUsd: 1 }, { "x-a2a-requester-id": "an-1", "x-a2a-requester-role": "analyst" })).status, 401);
  const patch = (id: string, body: unknown) =>
    fetch(`${baseUrl}/budgets/${id}`, { method: "PATCH", headers: jsonHeaders(HUB), body: JSON.stringify(body) });
  const patched = await patch("b-http", { limitTokens: 50, limitUsd: null });
  assert.equal(patched.status, 200, await patched.clone().text());
  assert.equal((await patched.json()).budget.limitTokens, 50);
  assert.equal((await patch("b-http", { limitTokens: null })).status, 400);
  assert.equal((await patch("b-none", { warnPct: 5 })).status, 404);
  const list = await fetch(`${baseUrl}/budgets`, { headers: HUB });
  assert.equal(list.status, 200);
  assert.equal(list.headers.get("cache-control"), "no-store");
  const body = await list.json();
  assert.deepEqual(body.budgets.map((budget: { id: string; limitUsd: unknown }) => [budget.id, budget.limitUsd]), [["b-http", null]]);
  assert.equal((await fetch(`${baseUrl}/budgets`)).status, 401);
  const status = await (await fetch(`${baseUrl}/budgets/status?scope_type=lane&scope_id=analyze`, { headers: HUB })).json();
  assert.deepEqual(status.budgets.map((budget: { id: string }) => budget.id), ["b-http"]);
  assert.deepEqual(status.enforcement, { configuredMode: "off", effectiveMode: "off", reason: "mode_off" });
}

test("server (SQLite backend): budget routes are registered with HTTP status mapping", async () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-broker-budget-routes-"));
  const server = await startTestServer({
    stateStore: undefined,
    persistenceBackend: "sqlite",
    stateFile: join(dir, "state.json"),
    sqliteFile: join(dir, "state.sqlite"),
  });
  try {
    await exerciseBudgetRoutesServer(server.baseUrl);
  } finally {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("server (SQLite worker-thread persistence): budget routes and their audit rows", async () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-broker-budget-routes-wt-"));
  await withEnv({ BROKER_PERSISTENCE_QUEUE_WORKER_THREAD: "1" }, async () => {
    const server = await startTestServer({
      stateStore: undefined,
      persistenceBackend: "sqlite",
      stateFile: join(dir, "state.json"),
      sqliteFile: join(dir, "state.sqlite"),
    });
    try {
      await exerciseBudgetRoutesServer(server.baseUrl);
      const db = new DatabaseSync(join(dir, "state.sqlite"));
      try {
        const rows = db.prepare("SELECT action FROM broker_audit_events WHERE target_type = 'budget' ORDER BY action").all() as Array<{ action: string }>;
        assert.deepEqual(rows.map((row) => row.action), ["budget.created", "budget.updated"], "each write route awaited its queued audit row");
      } finally {
        db.close();
      }
    } finally {
      await server.close();
    }
  });
  rmSync(dir, { recursive: true, force: true });
});

test("server: A2A_BUDGET_ENFORCEMENT_MODE — invalid fails startup; non-off without the spend ledger fails startup; shadow on SQLite starts", async () => {
  await withEnv({ A2A_BUDGET_ENFORCEMENT_MODE: "enforce" }, async () => {
    await assert.rejects(() => startTestServer(), /invalid A2A_BUDGET_ENFORCEMENT_MODE='enforce'/);
  });
  await withEnv({ A2A_BUDGET_ENFORCEMENT_MODE: "on" }, async () => {
    await assert.rejects(() => startTestServer(), /A2A_BUDGET_ENFORCEMENT_MODE='on' requires the spend ledger/);
  });
  const dir = mkdtempSync(join(tmpdir(), "a2a-broker-budget-mode-"));
  try {
    await withEnv({ A2A_BUDGET_ENFORCEMENT_MODE: "shadow" }, async () => {
      const server = await startTestServer({
        stateStore: undefined,
        persistenceBackend: "sqlite",
        stateFile: join(dir, "state.json"),
        sqliteFile: join(dir, "state.sqlite"),
      });
      try {
        const body = await (await fetch(`${server.baseUrl}/budgets/status`, { headers: HUB })).json();
        assert.deepEqual(body.enforcement, { configuredMode: "shadow", effectiveMode: "shadow", reason: "mode_shadow" });
      } finally {
        await server.close();
      }
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
