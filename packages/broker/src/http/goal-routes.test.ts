/**
 * Goal routes (#2499 slice 1): POST /goals, GET /goals, GET /goals/:id.
 *
 * GET /budgets/status (#2499 slice 2) is covered at the end of the file.
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

  // Unmatched shapes fall through.
  assert.equal((await route("POST", "/budgets/status")).handled, false);
  assert.equal((await route("GET", "/budgets")).handled, false);
  assert.equal((await route("GET", "/budgets/status/x")).handled, false);
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
