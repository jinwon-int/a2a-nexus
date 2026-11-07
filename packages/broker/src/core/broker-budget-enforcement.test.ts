/**
 * Budget refusal hooks (#2499 slice 3b-2, docs/specs/goal-budget): red first.
 *
 * - Claim refusal ("Enforcement points", Decisions 2, 4, 9, 13, 15, 16): in
 *   effective mode `on` a claim whose agent, lane or goal scope is exhausted
 *   is refused with `policy_denied` (HTTP 403), `details.reason`
 *   `budget_exhausted` and `details.scopes` naming the refusing scope(s); the
 *   task stays `queued` and unclaimed. A USD-exhausted scope refuses only a
 *   worker with a `cost_known` row in the period; `pause` budgets, `shadow`,
 *   `on` while the period is incomplete, and `off` never refuse (`off` reads
 *   no budget at all); in-flight tasks are untouched; a failed budget read
 *   fails open and is counted in `checkFailed`.
 * - Queued-listing filter ("Claim retry loop"): the worker poll
 *   `GET /tasks?assignedWorkerId=W&status=queued` and the SSE
 *   `worker-assignment-snapshot` for W omit the tasks a claim by W would be
 *   refused for; other query shapes are unfiltered; poll and SSE agree.
 *   `GET /budgets/status` exposes `listing` (contract defined here):
 *     - `omittedTotal`: tasks omitted from worker listings since startup
 *       (each listing adds the number of tasks it omitted; in memory);
 *     - `lastOmittedAt`: ISO time of the last omission, or null;
 *     - `wouldOmitTotal`: the same count in `shadow` (nothing is omitted).
 *
 * Run in both in-process wirings (save hints, runtime repositories), like
 * broker-budget.test.ts. Server tests inject the SQLite-backed broker and
 * store, so the poll route takes the SQLite hot read path.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { readSseEventsUntil, startTestServer } from "../server-test-helpers.js";
import { BrokerError, InMemoryA2ABroker } from "./broker.js";
import {
  SqliteArtifactRuntimeRepository,
  SqliteAuditRuntimeRepository,
  SqliteBrokerStateStore,
  SqliteExchangeMessageRuntimeRepository,
  SqliteExchangeRuntimeRepository,
  SqliteProposalRuntimeRepository,
  SqliteTaskRuntimeRepository,
  SqliteTombstoneRuntimeRepository,
  SqliteValidationRuntimeRepository,
  SqliteWorkerRuntimeRepository,
} from "./store/store.js";
import type { CreateBudgetRequest, CreateTaskRequest, SpendEventRecord } from "./types.js";

const OPERATOR = { id: "operator-1", kind: "user" as const, role: "operator" as const };
const TELEMETRY_SCHEMA = "a2a.analysis-execution-telemetry.v1";
const WIRINGS = ["hints", "repositories"] as const;
type Wiring = (typeof WIRINGS)[number];
type Mode = "off" | "shadow" | "on";

// --- Harness ------------------------------------------------------------------------

interface Harness {
  broker: InMemoryA2ABroker;
  store: SqliteBrokerStateStore;
  sql(statement: string, ...params: Array<string | number | null>): void;
  query<T>(statement: string, ...params: Array<string | number | null>): T[];
  close(): void;
}

function harness(wiring: Wiring, mode: Mode): Harness {
  const dir = mkdtempSync(join(tmpdir(), "a2a-budget-enforce-"));
  const dbFile = join(dir, "state.sqlite");
  const store = new SqliteBrokerStateStore(dbFile, { loadSource: "hot-tables" });
  const repositories = wiring === "repositories"
    ? {
        taskRepository: new SqliteTaskRuntimeRepository(store),
        auditRepository: new SqliteAuditRuntimeRepository(store),
        tombstoneRepository: new SqliteTombstoneRuntimeRepository(store),
        workerRepository: new SqliteWorkerRuntimeRepository(store),
        exchangeRepository: new SqliteExchangeRuntimeRepository(store),
        exchangeMessageRepository: new SqliteExchangeMessageRuntimeRepository(store),
        proposalRepository: new SqliteProposalRuntimeRepository(store),
        artifactRepository: new SqliteArtifactRuntimeRepository(store),
        validationRepository: new SqliteValidationRuntimeRepository(store),
      }
    : {};
  const broker = new InMemoryA2ABroker(store, store.load(), {
    budgetPeriodTimeZone: "UTC",
    budgetEnforcementMode: mode,
    ...repositories,
  });
  for (const nodeId of ["worker-a", "worker-b", "worker-c"]) {
    broker.registerWorker({
      nodeId,
      role: "analyst",
      capabilities: {
        canAnalyze: true,
        canBackfill: false,
        canPatchWorkspace: false,
        canPromoteLive: false,
        workspaceIds: ["default"],
        environments: ["research"],
      },
    });
  }
  const withDb = <T>(fn: (db: DatabaseSync) => T): T => {
    const db = new DatabaseSync(dbFile);
    try {
      return fn(db);
    } finally {
      db.close();
    }
  };
  return {
    broker,
    store,
    sql: (statement, ...params) => withDb((db) => {
      db.prepare(statement).run(...params);
    }),
    query: <T>(statement: string, ...params: Array<string | number | null>) =>
      withDb((db) => db.prepare(statement).all(...params).map((row) => ({ ...row })) as T[]),
    close() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** The ledger started long before the current period: `periodComplete` is true (decision 9). */
function completePeriod(h: Harness): void {
  h.sql("UPDATE broker_metadata SET value = '2000-01' WHERE key = 'spend_ledger_first_period'");
}

function taskRequest(id: string, workerId: string, overrides: Partial<CreateTaskRequest> = {}): CreateTaskRequest {
  return {
    id,
    intent: "analyze",
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: workerId, kind: "node", role: "analyst" },
    assignedWorkerId: workerId,
    message: `task ${id}`,
    payload: {},
    ...overrides,
  };
}

function spendRow(h: Harness, taskId: string, overrides: Partial<SpendEventRecord> = {}): SpendEventRecord {
  return {
    taskId,
    recordedAt: new Date().toISOString(),
    periodKey: h.broker.budgetPeriodKey(),
    agentId: "worker-b",
    lane: "analyze",
    goalId: null,
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    costKnown: false,
    ...overrides,
  };
}

function seedSpend(h: Harness, ...rows: SpendEventRecord[]): void {
  h.store.saveHotEntities({ spendEvents: rows });
}

function budget(h: Harness, request: Omit<CreateBudgetRequest, "period" | "createdBy">): void {
  h.broker.createBudget({ period: "month", createdBy: "operator-1", ...request } as CreateBudgetRequest);
}

function quiet<T>(fn: () => T): T {
  const original = console.warn;
  console.warn = () => {};
  try {
    return fn();
  } finally {
    console.warn = original;
  }
}

/**
 * Harness sanity: the scope really is exhausted for this worker and the
 * effective mode is the one the test expects. A failure here is a harness
 * bug, not the missing feature.
 */
function assertPrecondition(
  h: Harness,
  input: { workerId: string; lane?: string; goalId?: string },
  expected: { wouldRefuse: boolean; effectiveMode: Mode },
): void {
  const decision = h.broker.evaluateClaimBudget(input);
  assert.equal(decision.checkFailed, false, "precondition: the budget read works");
  assert.equal(decision.enforcement.effectiveMode, expected.effectiveMode, "precondition: effective mode");
  assert.equal(decision.wouldRefuse, expected.wouldRefuse, "precondition: evaluator decision");
}

interface ExpectedScope {
  budgetId: string;
  scopeType: "agent" | "lane" | "goal";
  scopeId: string;
  reason: "tokens_exhausted" | "usd_exhausted";
}

/** The claim must throw policy_denied / budget_exhausted naming the refusing scope. */
function assertClaimRefused(h: Harness, taskId: string, workerId: string, scope: ExpectedScope): void {
  let error: unknown;
  try {
    quiet(() => h.broker.claimTask(taskId, workerId));
  } catch (caught) {
    error = caught;
  }
  assert.ok(error !== undefined, `expected policy_denied (budget_exhausted) for ${workerId} on ${taskId}; the claim succeeded`);
  assert.ok(error instanceof BrokerError, `expected a BrokerError, got ${String(error)}`);
  assert.equal(error.code, "policy_denied");
  assert.equal(error.details?.reason, "budget_exhausted");
  const scopes = error.details?.scopes;
  assert.ok(Array.isArray(scopes), "details.scopes lists the refusing scopes");
  const match = (scopes as Array<Record<string, unknown>>).find((entry) => entry.budgetId === scope.budgetId);
  assert.ok(match, `details.scopes names budget ${scope.budgetId}`);
  assert.deepEqual(
    { scopeType: match.scopeType, scopeId: match.scopeId, reason: match.reason },
    { scopeType: scope.scopeType, scopeId: scope.scopeId, reason: scope.reason },
  );
  assertStillQueued(h, taskId);
}

function assertStillQueued(h: Harness, taskId: string): void {
  const task = h.broker.getTask(taskId);
  assert.equal(task?.status, "queued", "the refused task stays queued");
  assert.equal(task?.claimedBy, undefined, "and unclaimed");
  assert.equal(task?.attemptId, undefined);
  assert.deepEqual(
    h.broker.listAuditEvents({ action: "task.claimed" }).filter((event) => event.targetId === taskId),
    [],
    "no task.claimed audit event",
  );
}

// --- Claim refusal ------------------------------------------------------------------

for (const wiring of WIRINGS) {
  test(`[${wiring}] 1: on, period complete, token-exhausted lane budget: the claim is refused (policy_denied, budget_exhausted); the task stays queued`, () => {
    const h = harness(wiring, "on");
    try {
      completePeriod(h);
      budget(h, { id: "b-lane", scopeType: "lane", scopeId: "analyze", limitTokens: 100 });
      seedSpend(h, spendRow(h, "r-1", { agentId: "worker-b", inputTokens: 60, outputTokens: 40 }));
      h.broker.createTask(taskRequest("t-1", "worker-a"));
      assertPrecondition(h, { workerId: "worker-a", lane: "analyze" }, { wouldRefuse: true, effectiveMode: "on" });
      assertClaimRefused(h, "t-1", "worker-a", { budgetId: "b-lane", scopeType: "lane", scopeId: "analyze", reason: "tokens_exhausted" });
      // The refusal is the authority on every retry, and the stored row stays queued.
      assertClaimRefused(h, "t-1", "worker-a", { budgetId: "b-lane", scopeType: "lane", scopeId: "analyze", reason: "tokens_exhausted" });
      assert.equal(h.query<{ status: string }>("SELECT status FROM broker_tasks WHERE id = 't-1'")[0]?.status, "queued");
    } finally {
      h.close();
    }
  });

  test(`[${wiring}] 1 (HTTP): POST /tasks/:id/claim on an exhausted scope is 403 policy_denied with reason budget_exhausted`, async () => {
    const h = harness(wiring, "on");
    try {
      completePeriod(h);
      budget(h, { id: "b-lane", scopeType: "lane", scopeId: "analyze", limitTokens: 100 });
      seedSpend(h, spendRow(h, "r-1", { agentId: "worker-b", inputTokens: 100 }));
      h.broker.createTask(taskRequest("t-1", "worker-a"));
      assertPrecondition(h, { workerId: "worker-a", lane: "analyze" }, { wouldRefuse: true, effectiveMode: "on" });
      await withServer(h, "on", async (baseUrl) => {
        const res = await fetch(`${baseUrl}/tasks/t-1/claim`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ workerId: "worker-a" }),
        });
        const body = await res.json() as { status?: string; error?: { code: string; details?: Record<string, unknown> } };
        assert.equal(res.status, 403, `expected 403 budget refusal, got ${res.status} (task status ${body.status ?? "n/a"})`);
        assert.equal(body.error?.code, "policy_denied");
        assert.equal(body.error?.details?.reason, "budget_exhausted");
        assert.ok(Array.isArray(body.error?.details?.scopes));
      });
      assertStillQueued(h, "t-1");
    } finally {
      h.close();
    }
  });

  test(`[${wiring}] 2: a USD-exhausted lane refuses only a worker with a cost_known row this period (Decisions 4, 15)`, () => {
    const h = harness(wiring, "on");
    try {
      completePeriod(h);
      budget(h, { id: "b-usd", scopeType: "lane", scopeId: "analyze", limitUsd: 1 });
      seedSpend(
        h,
        spendRow(h, "r-a", { agentId: "worker-a", costKnown: true, costUsd: 2, inputTokens: 10 }),
        spendRow(h, "r-b", { agentId: "worker-b", costKnown: false, inputTokens: 500, outputTokens: 50 }),
      );
      h.broker.createTask(taskRequest("t-a", "worker-a"));
      h.broker.createTask(taskRequest("t-b", "worker-b"));
      h.broker.createTask(taskRequest("t-c", "worker-c"));
      assertPrecondition(h, { workerId: "worker-a", lane: "analyze" }, { wouldRefuse: true, effectiveMode: "on" });
      assertClaimRefused(h, "t-a", "worker-a", { budgetId: "b-usd", scopeType: "lane", scopeId: "analyze", reason: "usd_exhausted" });
      // Only cost-unknown rows (worker-b) or no rows at all (worker-c): never refused by a USD limit.
      assert.equal(h.broker.claimTask("t-b", "worker-b").status, "claimed");
      assert.equal(h.broker.claimTask("t-c", "worker-c").status, "claimed");
    } finally {
      h.close();
    }
  });

  test(`[${wiring}] 3a: an exhausted agent-scope budget (scopeId = worker id) refuses that worker only`, () => {
    const h = harness(wiring, "on");
    try {
      completePeriod(h);
      budget(h, { id: "b-agent", scopeType: "agent", scopeId: "worker-a", limitTokens: 100 });
      seedSpend(h, spendRow(h, "r-a", { agentId: "worker-a", lane: "chat", inputTokens: 80, outputTokens: 30 }));
      h.broker.createTask(taskRequest("t-a", "worker-a"));
      h.broker.createTask(taskRequest("t-b", "worker-b"));
      assertPrecondition(h, { workerId: "worker-a", lane: "analyze" }, { wouldRefuse: true, effectiveMode: "on" });
      assertClaimRefused(h, "t-a", "worker-a", { budgetId: "b-agent", scopeType: "agent", scopeId: "worker-a", reason: "tokens_exhausted" });
      assert.equal(h.broker.claimTask("t-b", "worker-b").status, "claimed", "another worker in the same lane is not refused");
    } finally {
      h.close();
    }
  });

  test(`[${wiring}] 3b: an exhausted goal-scope budget refuses tasks linked to the goal only`, () => {
    const h = harness(wiring, "on");
    try {
      completePeriod(h);
      h.broker.createGoal({ id: "goal-1", title: "Goal one", requester: OPERATOR });
      budget(h, { id: "b-goal", scopeType: "goal", scopeId: "goal-1", limitTokens: 100 });
      seedSpend(h, spendRow(h, "r-g", { agentId: "worker-b", goalId: "goal-1", inputTokens: 150 }));
      h.broker.createTask(taskRequest("t-goal", "worker-a", { goalId: "goal-1" }));
      h.broker.createTask(taskRequest("t-plain", "worker-a"));
      assertPrecondition(h, { workerId: "worker-a", lane: "analyze", goalId: "goal-1" }, { wouldRefuse: true, effectiveMode: "on" });
      assertClaimRefused(h, "t-goal", "worker-a", { budgetId: "b-goal", scopeType: "goal", scopeId: "goal-1", reason: "tokens_exhausted" });
      assert.equal(h.broker.claimTask("t-plain", "worker-a").status, "claimed", "a task without the goal is not refused");
    } finally {
      h.close();
    }
  });

  test(`[${wiring}] 4: an exhausted pause budget does not refuse at claim`, () => {
    const h = harness(wiring, "on");
    try {
      completePeriod(h);
      budget(h, { id: "b-pause", scopeType: "lane", scopeId: "analyze", limitTokens: 100, enforce: "pause" });
      // Created while within the limit (`pause` acts at create time), exhausted afterwards.
      h.broker.createTask(taskRequest("t-1", "worker-a"));
      seedSpend(h, spendRow(h, "r-1", { inputTokens: 500 }));
      assert.equal(h.broker.evaluateBudget(h.broker.getBudget("b-pause")!).tokensExhausted, true, "precondition: exhausted");
      assertPrecondition(h, { workerId: "worker-a", lane: "analyze" }, { wouldRefuse: false, effectiveMode: "on" });
      assert.equal(quiet(() => h.broker.claimTask("t-1", "worker-a")).status, "claimed");
    } finally {
      h.close();
    }
  });

  test(`[${wiring}] 5: shadow, and on while the period is incomplete, never refuse a claim`, () => {
    for (const [mode, complete, effectiveMode] of [["shadow", true, "shadow"], ["on", false, "shadow"]] as const) {
      const h = harness(wiring, mode);
      try {
        if (complete) completePeriod(h);
        budget(h, { id: "b-lane", scopeType: "lane", scopeId: "analyze", limitTokens: 100 });
        seedSpend(h, spendRow(h, "r-1", { inputTokens: 500 }));
        h.broker.createTask(taskRequest("t-1", "worker-a"));
        assertPrecondition(h, { workerId: "worker-a", lane: "analyze" }, { wouldRefuse: true, effectiveMode });
        assert.equal(quiet(() => h.broker.claimTask("t-1", "worker-a")).status, "claimed", `${mode} (period complete: ${complete})`);
      } finally {
        h.close();
      }
    }
  });

  test(`[${wiring}] 6: off reads no budget at all on claim`, () => {
    const h = harness(wiring, "off");
    try {
      completePeriod(h);
      budget(h, { id: "b-lane", scopeType: "lane", scopeId: "analyze", limitTokens: 100 });
      seedSpend(h, spendRow(h, "r-1", { inputTokens: 500 }));
      h.broker.createTask(taskRequest("t-1", "worker-a"));
      const calls: string[] = [];
      const store = h.store;
      const usage = store.readSpendScopeUsage.bind(store);
      const cost = store.hasCostReportingSpend.bind(store);
      const metadata = store.readSpendLedgerMetadata.bind(store);
      store.readSpendScopeUsage = (query) => {
        calls.push("readSpendScopeUsage");
        return usage(query);
      };
      store.hasCostReportingSpend = (query) => {
        calls.push("hasCostReportingSpend");
        return cost(query);
      };
      store.readSpendLedgerMetadata = () => {
        calls.push("readSpendLedgerMetadata");
        return metadata();
      };
      assert.equal(h.broker.claimTask("t-1", "worker-a").status, "claimed");
      assert.deepEqual(calls, [], "mode off: the claim reads no budget or ledger metadata");
    } finally {
      h.close();
    }
  });

  test(`[${wiring}] 7: in-flight tasks are untouched when their scope becomes exhausted; their spend row is written`, () => {
    const h = harness(wiring, "on");
    try {
      completePeriod(h);
      budget(h, { id: "b-lane", scopeType: "lane", scopeId: "analyze", limitTokens: 100 });
      h.broker.createTask(taskRequest("t-run", "worker-a"));
      h.broker.createTask(taskRequest("t-claimed", "worker-a"));
      h.broker.claimTask("t-run", "worker-a");
      h.broker.startTask("t-run", "worker-a");
      h.broker.claimTask("t-claimed", "worker-a");
      // The scope becomes exhausted while both are in flight.
      seedSpend(h, spendRow(h, "r-1", { inputTokens: 500 }));
      assertPrecondition(h, { workerId: "worker-a", lane: "analyze" }, { wouldRefuse: true, effectiveMode: "on" });
      const output = { executionTelemetry: { schemaVersion: TELEMETRY_SCHEMA, inputTokens: 7, outputTokens: 3, costUsd: 0.01 } };
      assert.equal(quiet(() => h.broker.completeTask("t-run", "worker-a", { summary: "ok", output })).status, "succeeded");
      h.broker.startTask("t-claimed", "worker-a");
      assert.equal(quiet(() => h.broker.completeTask("t-claimed", "worker-a", { summary: "ok", output })).status, "succeeded");
      const rows = h.query<{ task_id: string; input_tokens: number; output_tokens: number }>(
        "SELECT task_id, input_tokens, output_tokens FROM broker_spend_events WHERE task_id IN ('t-run', 't-claimed') ORDER BY task_id",
      );
      assert.deepEqual(rows, [
        { task_id: "t-claimed", input_tokens: 7, output_tokens: 3 },
        { task_id: "t-run", input_tokens: 7, output_tokens: 3 },
      ]);
    } finally {
      h.close();
    }
  });

  test(`[${wiring}] 8: a budget read that throws at claim fails open and counts in checkFailed`, () => {
    const h = harness(wiring, "on");
    try {
      completePeriod(h);
      budget(h, { id: "b-lane", scopeType: "lane", scopeId: "analyze", limitTokens: 100 });
      h.broker.createTask(taskRequest("t-1", "worker-a"));
      h.store.readSpendScopeUsage = () => {
        throw new Error("disk I/O error");
      };
      const before = h.broker.getBudgetCheckFailures().count;
      assert.equal(quiet(() => h.broker.claimTask("t-1", "worker-a")).status, "claimed", "fail-open: the claim proceeds");
      assert.equal(h.broker.getBudgetCheckFailures().count, before + 1, "the claim-time read failure is counted (checkFailed)");
    } finally {
      h.close();
    }
  });
}

// --- Queued-listing filter ------------------------------------------------------------

async function withServer(h: Harness, mode: Mode, run: (baseUrl: string) => Promise<void>): Promise<void> {
  const server = await startTestServer({
    broker: h.broker,
    stateStore: h.store,
    enforceRequesterIdentity: false,
    budgetEnforcementMode: mode,
    budgetPeriodTimeZone: "UTC",
    rateLimitMaxRequests: 1_000,
  });
  try {
    await run(server.baseUrl);
  } finally {
    await server.close();
  }
}

async function listIds(baseUrl: string, query: string): Promise<string[]> {
  const res = await fetch(`${baseUrl}/tasks?${query}`);
  assert.equal(res.status, 200, query);
  const body = await res.json() as { items: Array<{ id: string }> };
  return body.items.map((item) => item.id).sort();
}

async function snapshotIds(baseUrl: string, workerId: string): Promise<string[]> {
  const res = await fetch(`${baseUrl}/a2a/workers/${workerId}/assignment-events`, {
    headers: { "x-a2a-requester-id": workerId, "x-a2a-requester-role": "analyst" },
  });
  assert.equal(res.status, 200);
  const events = await readSseEventsUntil(res, (seen) => seen.some((event) => event.event === "worker-assignment-snapshot"));
  const snapshot = events.find((event) => event.event === "worker-assignment-snapshot")!;
  const data = JSON.parse(snapshot.data) as { count: number; tasks: Array<{ taskId: string }> };
  assert.equal(data.count, data.tasks.length);
  return data.tasks.map((task) => task.taskId).sort();
}

interface ListingStatus {
  omittedTotal?: number;
  lastOmittedAt?: string | null;
  wouldOmitTotal?: number;
}

async function listingStatus(baseUrl: string): Promise<ListingStatus | undefined> {
  const res = await fetch(`${baseUrl}/budgets/status`);
  assert.equal(res.status, 200);
  return ((await res.json()) as { listing?: ListingStatus }).listing;
}

const POLL = (workerId: string) => `assignedWorkerId=${workerId}&status=queued`;

for (const wiring of WIRINGS) {
  test(`[${wiring}] 9: on: the worker poll omits tasks the worker's claim would be refused for; other shapes and workers are unfiltered; status counts omissions`, async () => {
    const h = harness(wiring, "on");
    try {
      completePeriod(h);
      budget(h, { id: "b-agent", scopeType: "agent", scopeId: "worker-a", limitTokens: 100 });
      seedSpend(h, spendRow(h, "r-a", { agentId: "worker-a", lane: "chat", inputTokens: 200 }));
      h.broker.createTask(taskRequest("t-a", "worker-a"));
      h.broker.createTask(taskRequest("t-b", "worker-b"));
      assertPrecondition(h, { workerId: "worker-a", lane: "analyze" }, { wouldRefuse: true, effectiveMode: "on" });
      assertPrecondition(h, { workerId: "worker-b", lane: "analyze" }, { wouldRefuse: false, effectiveMode: "on" });
      await withServer(h, "on", async (baseUrl) => {
        const initial = await listingStatus(baseUrl);
        assert.deepEqual(await listIds(baseUrl, POLL("worker-a")), [], "the refused task is omitted from worker-a's poll");
        assert.deepEqual(await listIds(baseUrl, `${POLL("worker-a")}&detail=full`), [], "also with detail=full");
        assert.deepEqual(await listIds(baseUrl, POLL("worker-b")), ["t-b"], "worker-b's listing is unfiltered");
        // Other query shapes are not worker polls: unfiltered.
        assert.deepEqual(await listIds(baseUrl, "status=queued"), ["t-a", "t-b"]);
        assert.deepEqual(await listIds(baseUrl, "assignedWorkerId=worker-a"), ["t-a"]);
        assert.deepEqual(initial, { omittedTotal: 0, lastOmittedAt: null, wouldOmitTotal: 0 }, "listing counters start at zero");
        const listing = await listingStatus(baseUrl);
        assert.equal(listing?.omittedTotal, 2, "each worker listing adds the tasks it omitted");
        assert.equal(typeof listing?.lastOmittedAt, "string");
        assert.ok(!Number.isNaN(Date.parse(listing!.lastOmittedAt!)), "lastOmittedAt is an ISO time");
      });
    } finally {
      h.close();
    }
  });

  for (const mode of ["on", "shadow"] as const) {
    test(`[${wiring}] 10 (${mode}): the SSE worker-assignment-snapshot and the poll route list the same tasks`, async () => {
      const h = harness(wiring, mode);
      try {
        completePeriod(h);
        h.broker.createGoal({ id: "goal-1", title: "Goal one", requester: OPERATOR });
        budget(h, { id: "b-goal", scopeType: "goal", scopeId: "goal-1", limitTokens: 100 });
        seedSpend(h, spendRow(h, "r-g", { agentId: "worker-b", goalId: "goal-1", inputTokens: 150 }));
        h.broker.createTask(taskRequest("t-goal", "worker-a", { goalId: "goal-1" }));
        h.broker.createTask(taskRequest("t-plain", "worker-a"));
        assertPrecondition(h, { workerId: "worker-a", lane: "analyze", goalId: "goal-1" }, { wouldRefuse: true, effectiveMode: mode });
        await withServer(h, mode, async (baseUrl) => {
          const polled = await listIds(baseUrl, POLL("worker-a"));
          const streamed = await snapshotIds(baseUrl, "worker-a");
          assert.deepEqual(polled, mode === "on" ? ["t-plain"] : ["t-goal", "t-plain"], "poll");
          assert.deepEqual(streamed, polled, "poll and SSE agree");
        });
      } finally {
        h.close();
      }
    });
  }

  test(`[${wiring}] 11: shadow omits nothing; listing.wouldOmitTotal counts what on would omit`, async () => {
    const h = harness(wiring, "shadow");
    try {
      completePeriod(h);
      budget(h, { id: "b-lane", scopeType: "lane", scopeId: "analyze", limitTokens: 100 });
      seedSpend(h, spendRow(h, "r-1", { inputTokens: 500 }));
      h.broker.createTask(taskRequest("t-a", "worker-a"));
      assertPrecondition(h, { workerId: "worker-a", lane: "analyze" }, { wouldRefuse: true, effectiveMode: "shadow" });
      await withServer(h, "shadow", async (baseUrl) => {
        assert.deepEqual(await listIds(baseUrl, POLL("worker-a")), ["t-a"], "shadow never omits");
        const listing = await listingStatus(baseUrl);
        assert.equal(listing?.omittedTotal, 0);
        assert.equal(listing?.lastOmittedAt, null);
        assert.equal(listing?.wouldOmitTotal, 1, "the would-omit decision is counted");
      });
    } finally {
      h.close();
    }
  });

  test(`[${wiring}] 12: a USD-exhausted lane omits tasks only for a cost-reporting worker`, async () => {
    const h = harness(wiring, "on");
    try {
      completePeriod(h);
      budget(h, { id: "b-usd", scopeType: "lane", scopeId: "analyze", limitUsd: 1 });
      seedSpend(
        h,
        spendRow(h, "r-a", { agentId: "worker-a", costKnown: true, costUsd: 2 }),
        spendRow(h, "r-b", { agentId: "worker-b", costKnown: false, inputTokens: 500 }),
      );
      h.broker.createTask(taskRequest("t-a", "worker-a"));
      h.broker.createTask(taskRequest("t-b", "worker-b"));
      h.broker.createTask(taskRequest("t-c", "worker-c"));
      assertPrecondition(h, { workerId: "worker-a", lane: "analyze" }, { wouldRefuse: true, effectiveMode: "on" });
      await withServer(h, "on", async (baseUrl) => {
        assert.deepEqual(await listIds(baseUrl, POLL("worker-a")), [], "the cost-reporting worker's task is omitted");
        assert.deepEqual(await listIds(baseUrl, POLL("worker-b")), ["t-b"], "cost-unknown rows only: kept");
        assert.deepEqual(await listIds(baseUrl, POLL("worker-c")), ["t-c"], "no rows: kept");
        assert.deepEqual(await snapshotIds(baseUrl, "worker-a"), [], "SSE follows the same rule");
        assert.deepEqual(await snapshotIds(baseUrl, "worker-b"), ["t-b"]);
      });
    } finally {
      h.close();
    }
  });
}
