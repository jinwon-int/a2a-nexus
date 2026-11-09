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
import { generateKeyPairSync } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { mock } from "node:test";

import { createBrokerAgentCard } from "../a2a/agent-card.js";
import { executeA2AJsonRpc } from "../a2a/json-rpc.js";
import { handleWorkerAssignmentEventStream } from "../http/task-event-streams.js";
import { readSseEventsUntil, startTestServer } from "../server-test-helpers.js";
import { signA2AWorkerRequest } from "../workers/worker-http-signature.js";
import { HOT_READ_HARD_MAX_LIMIT } from "./broker-list-filters.js";
import { BrokerError, InMemoryA2ABroker } from "./broker.js";
import { PendingHotStateBuffer } from "./store/pending-hot-state-buffer.js";
import { createWorkerThreadPersistence } from "./store/sqlite-worker-thread-persistence.js";
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
import type { BudgetRecord, CreateBudgetRequest, CreateTaskRequest, GoalRecord, SpendEventRecord } from "./types.js";

const OPERATOR = { id: "operator-1", kind: "user" as const, role: "operator" as const };
const TELEMETRY_SCHEMA = "a2a.analysis-execution-telemetry.v1";
const WIRINGS = ["hints", "repositories"] as const;
type Wiring = (typeof WIRINGS)[number];
type Mode = "off" | "shadow" | "on";

// --- Harness ------------------------------------------------------------------------

interface Harness {
  broker: InMemoryA2ABroker;
  store: SqliteBrokerStateStore;
  dbFile: string;
  sql(statement: string, ...params: Array<string | number | null>): void;
  query<T>(statement: string, ...params: Array<string | number | null>): T[];
  /** Restart on the same database with another enforcement mode. */
  reopen(mode: Mode): void;
  close(): void;
}

function harness(wiring: Wiring, mode: Mode): Harness {
  const dir = mkdtempSync(join(tmpdir(), "a2a-budget-enforce-"));
  const dbFile = join(dir, "state.sqlite");
  const open = (openMode: Mode) => {
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
    const broker = quiet(() => new InMemoryA2ABroker(store, store.load(), {
      budgetPeriodTimeZone: "UTC",
      budgetEnforcementMode: openMode,
      ...repositories,
    }));
    return { store, broker };
  };
  let current = open(mode);
  for (const nodeId of ["worker-a", "worker-b", "worker-c", "default-agent"]) {
    current.broker.registerWorker({
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
    get broker() {
      return current.broker;
    },
    get store() {
      return current.store;
    },
    dbFile,
    sql: (statement, ...params) => withDb((db) => {
      db.prepare(statement).run(...params);
    }),
    query: <T>(statement: string, ...params: Array<string | number | null>) =>
      withDb((db) => db.prepare(statement).all(...params).map((row) => ({ ...row })) as T[]),
    reopen(openMode) {
      current.store.close();
      current = open(openMode);
    },
    close() {
      current.store.close();
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
      assert.equal(h.broker.getBudgetCheckFailures().consecutive, 1, "and starts a run of consecutive failures");
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
  lastOmittedCount?: number;
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
        assert.deepEqual(initial, { omittedTotal: 0, lastOmittedAt: null, lastOmittedCount: 0, wouldOmitTotal: 0 }, "listing counters start at zero");
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

// --- Slice 3b-2 step B additions ----------------------------------------------------------

function captureWarnings<T>(fn: () => T): { result: T; events: Array<Record<string, unknown>> } {
  const lines: string[] = [];
  const original = console.warn;
  console.warn = (message?: unknown) => {
    lines.push(String(message));
  };
  try {
    const result = fn();
    const events = lines.flatMap((line) => {
      try {
        return [JSON.parse(line) as Record<string, unknown>];
      } catch {
        return [];
      }
    });
    return { result, events };
  } finally {
    console.warn = original;
  }
}

function named(events: Array<Record<string, unknown>>, name: string): Array<Record<string, unknown>> {
  return events.filter((event) => event.event === name);
}

function refusal(fn: () => unknown): BrokerError {
  let error: unknown;
  try {
    quiet(fn);
  } catch (caught) {
    error = caught;
  }
  assert.ok(error instanceof BrokerError, `expected a BrokerError, got ${String(error)}`);
  return error;
}

const TELEMETRY = { executionTelemetry: { schemaVersion: TELEMETRY_SCHEMA, inputTokens: 11, outputTokens: 4, costUsd: 0.02 } };

for (const wiring of WIRINGS) {
  test(`[${wiring}] claims: refusals and would-refuse decisions are counted and logged at most once per minute; status shows the counters`, async () => {
    const on = harness(wiring, "on");
    try {
      completePeriod(on);
      budget(on, { id: "b-lane", scopeType: "lane", scopeId: "analyze", limitTokens: 100 });
      seedSpend(on, spendRow(on, "r-1", { inputTokens: 500 }));
      on.broker.createTask(taskRequest("t-1", "worker-a"));
      on.broker.createTask(taskRequest("t-2", "worker-a"));
      const run = captureWarnings(() => {
        for (const id of ["t-1", "t-2"]) assert.throws(() => on.broker.claimTask(id, "worker-a"), /budget/);
      });
      assert.deepEqual(named(run.events, "broker.budget.claim_refused"), [
        { event: "broker.budget.claim_refused", taskId: "t-1", workerId: "worker-a", scopes: ["b-lane"], suppressed: 0 },
      ]);
      const claims = on.broker.getBudgetEnforcementCounters().claims;
      assert.equal(claims.refusedTotal, 2);
      assert.equal(claims.wouldRefuseTotal, 0);
      assert.match(claims.lastAt ?? "", /^\d{4}-\d{2}-\d{2}T/);
      await withServer(on, "on", async (baseUrl) => {
        const status = await (await fetch(`${baseUrl}/budgets/status`)).json() as Record<string, Record<string, unknown>>;
        assert.equal(status.claims?.refusedTotal, 2);
        assert.deepEqual(Object.keys(status.creates ?? {}).sort(), ["lastAt", "refusedTotal", "wouldRefuseTotal"]);
        assert.deepEqual(Object.keys(status.goals ?? {}).sort(), ["lastAt", "limitedTotal", "resumedTotal", "wouldLimitTotal"]);
        assert.deepEqual(Object.keys(status.listing ?? {}).sort(), ["lastOmittedAt", "lastOmittedCount", "omittedTotal", "wouldOmitTotal"]);
        assert.equal(status.checkFailed?.consecutive, 0);
      });
    } finally {
      on.close();
    }
    const shadow = harness(wiring, "shadow");
    try {
      completePeriod(shadow);
      budget(shadow, { id: "b-lane", scopeType: "lane", scopeId: "analyze", limitTokens: 100 });
      seedSpend(shadow, spendRow(shadow, "r-1", { inputTokens: 500 }));
      shadow.broker.createTask(taskRequest("t-1", "worker-a"));
      const run = captureWarnings(() => shadow.broker.claimTask("t-1", "worker-a"));
      assert.equal(run.result.status, "claimed");
      assert.deepEqual(named(run.events, "broker.budget.would_refuse"), [
        { event: "broker.budget.would_refuse", taskId: "t-1", workerId: "worker-a", scopes: ["b-lane"], suppressed: 0 },
      ]);
      assert.equal(shadow.broker.getBudgetEnforcementCounters().claims.wouldRefuseTotal, 1);
      assert.equal(shadow.broker.getBudgetEnforcementCounters().claims.refusedTotal, 0);
    } finally {
      shadow.close();
    }
  });

  test(`[${wiring}] checkFailed: a metadata-only failure is checkFailed (fail-open); consecutive counts failures until the next successful read`, async () => {
    const h = harness(wiring, "on");
    try {
      completePeriod(h);
      budget(h, { id: "b-lane", scopeType: "lane", scopeId: "analyze", limitTokens: 100 });
      seedSpend(h, spendRow(h, "r-1", { inputTokens: 500 }));
      h.broker.createTask(taskRequest("t-1", "worker-a"));
      h.broker.createTask(taskRequest("t-2", "worker-a"));
      const metadata = h.store.readSpendLedgerMetadata.bind(h.store);
      h.store.readSpendLedgerMetadata = () => {
        throw new Error("disk I/O error");
      };
      const decision = quiet(() => h.broker.evaluateClaimBudget({ workerId: "worker-a", lane: "analyze" }));
      assert.equal(decision.checkFailed, true, "the enforcement metadata read failed");
      assert.equal(decision.refuse, false);
      assert.equal(quiet(() => h.broker.claimTask("t-1", "worker-a")).status, "claimed", "fail-open");
      assert.deepEqual(
        (({ count, consecutive }) => ({ count, consecutive }))(h.broker.getBudgetCheckFailures()),
        { count: 2, consecutive: 2 },
      );
      h.store.readSpendLedgerMetadata = metadata;
      const usage = h.store.readSpendScopeUsage.bind(h.store);
      h.store.readSpendScopeUsage = () => {
        throw new Error("disk I/O error");
      };
      quiet(() => h.broker.evaluateClaimBudget({ workerId: "worker-a", lane: "analyze" }));
      assert.equal(h.broker.getBudgetCheckFailures().consecutive, 3);
      h.store.readSpendScopeUsage = usage;
      // The next successful evaluation ends the run (the count stays).
      assertClaimRefused(h, "t-2", "worker-a", { budgetId: "b-lane", scopeType: "lane", scopeId: "analyze", reason: "tokens_exhausted" });
      assert.deepEqual(
        (({ count, consecutive }) => ({ count, consecutive }))(h.broker.getBudgetCheckFailures()),
        { count: 3, consecutive: 0 },
      );
      await withServer(h, "on", async (baseUrl) => {
        const status = await (await fetch(`${baseUrl}/budgets/status`)).json() as { checkFailed: Record<string, unknown> };
        assert.equal(status.checkFailed.count, 3);
        assert.equal(status.checkFailed.consecutive, 0);
      });
    } finally {
      h.close();
    }
  });

  test(`[${wiring}] listing: one aggregate read per budget and one cost probe per listing; off reads nothing`, () => {
    const h = harness(wiring, "on");
    try {
      completePeriod(h);
      budget(h, { id: "b-lane", scopeType: "lane", scopeId: "analyze", limitUsd: 1 });
      budget(h, { id: "b-agent", scopeType: "agent", scopeId: "worker-a", limitTokens: 1_000_000 });
      seedSpend(h, spendRow(h, "r-b", { agentId: "worker-b", costKnown: true, costUsd: 5 }));
      for (let index = 0; index < 5; index += 1) h.broker.createTask(taskRequest(`t-${index}`, "worker-a"));
      const calls = { usage: 0, cost: 0 };
      const usage = h.store.readSpendScopeUsage.bind(h.store);
      const cost = h.store.hasCostReportingSpend.bind(h.store);
      h.store.readSpendScopeUsage = (query) => {
        calls.usage += 1;
        return usage(query);
      };
      h.store.hasCostReportingSpend = (query) => {
        calls.cost += 1;
        return cost(query);
      };
      const listed = h.broker.listTasks({ assignedWorkerId: "worker-a", status: "queued" });
      const kept = h.broker.filterQueuedListingForWorker("worker-a", listed);
      assert.equal(kept.length, 5, "worker-a reports no cost: a USD-exhausted lane keeps its tasks");
      assert.deepEqual(calls, { usage: 2, cost: 1 }, "memoized per listing");
    } finally {
      h.close();
    }
    const off = harness(wiring, "off");
    try {
      budget(off, { id: "b-lane", scopeType: "lane", scopeId: "analyze", limitTokens: 1 });
      off.broker.createTask(taskRequest("t-1", "worker-a"));
      let reads = 0;
      off.store.readSpendScopeUsage = () => {
        reads += 1;
        throw new Error("must not be read");
      };
      off.store.readSpendLedgerMetadata = () => {
        reads += 1;
        throw new Error("must not be read");
      };
      const listed = off.broker.listTasks({ assignedWorkerId: "worker-a", status: "queued" });
      assert.equal(off.broker.filterQueuedListingForWorker("worker-a", listed).length, 1);
      assert.equal(reads, 0);
    } finally {
      off.close();
    }
  });

  // --- pause at create -----------------------------------------------------------------

  test(`[${wiring}] pause: an exhausted pause budget refuses the create (budget_paused); refuse budgets never refuse at create; USD only for a cost-reporting worker`, () => {
    const h = harness(wiring, "on");
    try {
      completePeriod(h);
      budget(h, { id: "b-pause", scopeType: "lane", scopeId: "analyze", limitTokens: 100, enforce: "pause" });
      budget(h, { id: "b-refuse", scopeType: "lane", scopeId: "chat", limitTokens: 100 });
      budget(h, { id: "b-usd", scopeType: "lane", scopeId: "verify", limitUsd: 1, enforce: "pause" });
      budget(h, { id: "b-agent", scopeType: "agent", scopeId: "worker-c", limitTokens: 10, enforce: "pause" });
      seedSpend(
        h,
        spendRow(h, "r-1", { lane: "analyze", inputTokens: 500 }),
        spendRow(h, "r-2", { lane: "chat", inputTokens: 500 }),
        spendRow(h, "r-3", { lane: "verify", agentId: "worker-a", costKnown: true, costUsd: 2 }),
        spendRow(h, "r-4", { lane: "backfill", agentId: "worker-c", inputTokens: 50 }),
      );
      const paused = refusal(() => h.broker.createTask(taskRequest("t-paused", "worker-a")));
      assert.equal(paused.code, "policy_denied");
      assert.equal(paused.details?.reason, "budget_paused");
      assert.deepEqual(
        (paused.details?.scopes as Array<Record<string, unknown>>).map((scope) => [scope.budgetId, scope.scopeType, scope.scopeId, scope.reason]),
        [["b-pause", "lane", "analyze", "tokens_exhausted"]],
      );
      assert.equal(h.broker.getTask("t-paused"), null, "nothing is created");
      assert.deepEqual(h.broker.listAuditEvents({ action: "task.created" }).filter((event) => event.targetId === "t-paused"), []);
      assert.equal(h.broker.createTask(taskRequest("t-chat", "worker-a", { intent: "chat" })).status, "queued", "a refuse budget acts at claim only");
      const usd = refusal(() => h.broker.createTask(taskRequest("t-usd-a", "worker-a", { intent: "verify" })));
      assert.equal(usd.details?.reason, "budget_paused");
      assert.equal(h.broker.createTask(taskRequest("t-usd-b", "worker-b", { intent: "verify" })).status, "queued", "Decision 4: not a cost-reporting worker");
      const agent = refusal(() => h.broker.createTask(taskRequest("t-agent", "worker-c", { intent: "backfill" })));
      assert.equal((agent.details?.scopes as Array<Record<string, unknown>>)[0]?.scopeType, "agent");
      const creates = h.broker.getBudgetEnforcementCounters().creates;
      assert.equal(creates.refusedTotal, 3);
      assert.equal(creates.wouldRefuseTotal, 0);
    } finally {
      h.close();
    }
  });

  test(`[${wiring}] pause: shadow counts the would-refuse create and logs it; the task is created`, () => {
    const h = harness(wiring, "shadow");
    try {
      completePeriod(h);
      budget(h, { id: "b-pause", scopeType: "lane", scopeId: "analyze", limitTokens: 100, enforce: "pause" });
      seedSpend(h, spendRow(h, "r-1", { inputTokens: 500 }));
      const run = captureWarnings(() => h.broker.createTask(taskRequest("t-1", "worker-a")));
      assert.equal(run.result.status, "queued");
      assert.deepEqual(named(run.events, "broker.budget.create_would_refuse"), [
        { event: "broker.budget.create_would_refuse", workerId: "worker-a", lane: "analyze", scopes: ["b-pause"], suppressed: 0 },
      ]);
      assert.equal(h.broker.getBudgetEnforcementCounters().creates.wouldRefuseTotal, 1);
    } finally {
      h.close();
    }
  });

  test(`[${wiring}] pause: the retry task scheduled inside failTask is exempt (a terminal transition never fails on a budget)`, () => {
    const h = harness(wiring, "on");
    try {
      completePeriod(h);
      budget(h, { id: "b-pause", scopeType: "lane", scopeId: "analyze", limitTokens: 100, enforce: "pause" });
      h.broker.createTask(taskRequest("t-retry", "worker-a", {
        payload: { retryPolicy: { maxRetries: 1, retryOn: ["environment"], backoffMs: 0 } },
      }));
      h.broker.claimTask("t-retry", "worker-a");
      h.broker.startTask("t-retry", "worker-a");
      seedSpend(h, spendRow(h, "r-1", { inputTokens: 500 }));
      assert.equal(refusal(() => h.broker.createTask(taskRequest("t-new", "worker-a"))).details?.reason, "budget_paused", "precondition");
      const failed = quiet(() => h.broker.failTask("t-retry", "worker-a", {
        code: "handler_exit_nonzero",
        message: "handler failed",
        details: { stage: "handler", nestedError: { code: "openclaw_analysis_failed" } },
      }));
      assert.equal(failed.status, "failed");
      assert.ok(failed.retriedBy, "the retry is scheduled");
      assert.equal(h.broker.getTask(failed.retriedBy!)?.status, "queued");
    } finally {
      h.close();
    }
  });

  // --- goal budget_limited ---------------------------------------------------------------

  test(`[${wiring}] goals: an exhausted goal budget limits a pursuing goal (budget_exhausted); a create for it is refused; raising the limit resumes it`, () => {
    const h = harness(wiring, "on");
    try {
      completePeriod(h);
      h.broker.createGoal({ id: "goal-1", title: "Goal one", requester: OPERATOR });
      budget(h, { id: "b-goal", scopeType: "goal", scopeId: "goal-1", limitTokens: 100 });
      assert.deepEqual(quiet(() => h.broker.applyGoalBudgetLimits()), { limited: [], resumed: [] }, "within the limit");
      seedSpend(h, spendRow(h, "r-g", { goalId: "goal-1", inputTokens: 150 }));
      const run = captureWarnings(() => h.broker.applyGoalBudgetLimits());
      assert.deepEqual(run.result, { limited: ["goal-1"], resumed: [] });
      assert.deepEqual(named(run.events, "broker.budget.goal_limited"), [
        { event: "broker.budget.goal_limited", goalId: "goal-1", budgetId: "b-goal", note: "budget_exhausted" },
      ]);
      const goal = h.broker.getGoal("goal-1")!;
      assert.equal(goal.status, "budget_limited");
      assert.equal(goal.outcome, undefined, "outcome.failed is not set (a budget limit is not a failure)");
      assert.deepEqual(
        (({ from, to, reason }) => ({ from, to, reason }))(goal.history[goal.history.length - 1]!),
        { from: "pursuing", to: "budget_limited", reason: "budget_exhausted" },
      );
      assert.deepEqual(h.query<{ status: string }>("SELECT status FROM broker_goals WHERE id = 'goal-1'"), [{ status: "budget_limited" }], "the row is updated");
      assert.deepEqual(
        h.broker.listAuditEvents({ action: "goal.status_changed" }).map((event) => [event.actorId, event.targetId, event.note]),
        [["broker", "goal-1", "pursuing->budget_limited:budget_exhausted"]],
      );
      assert.equal(h.broker.listGoals({ status: "budget_limited" }).length, 1);
      assert.throws(
        () => h.broker.createTask(taskRequest("t-goal", "worker-a", { goalId: "goal-1" })),
        (error: unknown) => error instanceof BrokerError && error.code === "invalid_transition",
        "slice 1: tasks attach to pursuing goals only",
      );
      assert.deepEqual(quiet(() => h.broker.applyGoalBudgetLimits()), { limited: [], resumed: [] }, "idempotent");
      h.broker.updateBudget("b-goal", { limitTokens: 1_000, actorId: "operator-1" });
      assert.deepEqual(quiet(() => h.broker.applyGoalBudgetLimits()), { limited: [], resumed: ["goal-1"] });
      const resumed = h.broker.getGoal("goal-1")!;
      assert.equal(resumed.status, "pursuing");
      assert.deepEqual(
        (({ from, to, reason, note }) => ({ from, to, reason, note }))(resumed.history[resumed.history.length - 1]!),
        { from: "budget_limited", to: "pursuing", reason: "operator_requested", note: "budget_available" },
      );
      assert.equal(h.broker.createTask(taskRequest("t-goal", "worker-a", { goalId: "goal-1" })).status, "queued");
      const goals = h.broker.getBudgetEnforcementCounters().goals;
      assert.deepEqual([goals.limitedTotal, goals.resumedTotal], [1, 1]);
    } finally {
      h.close();
    }
  });

  test(`[${wiring}] goals: a budget-limited goal resumes when the period rolls`, () => {
    // The clock jump makes the next persist a full save inside the mutation's
    // transaction (the in-process default store; #2512 regression coverage).
    const h = harness(wiring, "on");
    try {
      completePeriod(h);
      h.broker.createGoal({ id: "goal-1", title: "Goal one", requester: OPERATOR });
      budget(h, { id: "b-goal", scopeType: "goal", scopeId: "goal-1", limitUsd: 1 });
      seedSpend(h, spendRow(h, "r-g", { goalId: "goal-1", costKnown: true, costUsd: 3 }));
      assert.deepEqual(quiet(() => h.broker.applyGoalBudgetLimits())?.limited, ["goal-1"], "USD counts for a goal (no Decision 4 here)");
      const [year, month] = h.broker.budgetPeriodKey().split("-").map(Number) as [number, number];
      mock.timers.enable({ apis: ["Date"], now: Date.UTC(year, month, 2) });
      try {
        assert.notEqual(h.broker.budgetPeriodKey(), `${year}-${String(month).padStart(2, "0")}`, "the period rolled");
        assert.deepEqual(quiet(() => h.broker.applyGoalBudgetLimits())?.resumed, ["goal-1"]);
        assert.equal(h.broker.getGoal("goal-1")?.status, "pursuing");
      } finally {
        mock.timers.reset();
      }
    } finally {
      h.close();
    }
  });

  test(`[${wiring}] goals: shadow only counts and logs; goals in other states, or limited for another reason, are untouched; off reads nothing`, () => {
    const shadow = harness(wiring, "shadow");
    try {
      completePeriod(shadow);
      shadow.broker.createGoal({ id: "goal-1", title: "Goal one", requester: OPERATOR });
      budget(shadow, { id: "b-goal", scopeType: "goal", scopeId: "goal-1", limitTokens: 100 });
      seedSpend(shadow, spendRow(shadow, "r-g", { goalId: "goal-1", inputTokens: 150 }));
      const run = captureWarnings(() => shadow.broker.applyGoalBudgetLimits());
      assert.deepEqual(run.result, { limited: [], resumed: [] });
      assert.deepEqual(named(run.events, "broker.budget.goal_would_limit"), [
        { event: "broker.budget.goal_would_limit", goalId: "goal-1", budgetId: "b-goal", suppressed: 0 },
      ]);
      assert.equal(shadow.broker.getGoal("goal-1")?.status, "pursuing");
      assert.equal(shadow.broker.getBudgetEnforcementCounters().goals.wouldLimitTotal, 1);
    } finally {
      shadow.close();
    }
    const h = harness(wiring, "on");
    try {
      completePeriod(h);
      const now = new Date().toISOString();
      const goalRow = (id: string, status: GoalRecord["status"], reason: GoalRecord["history"][number]["reason"]): GoalRecord => ({
        id,
        title: id,
        objective: id,
        requester: OPERATOR,
        status,
        createdAt: now,
        updatedAt: now,
        taskAttachments: [],
        history: [{ id: `${id}-h`, goalId: id, from: "pursuing", to: status, reason, createdAt: now }],
      });
      h.store.insertGoal(goalRow("goal-paused", "paused", "operator_requested"));
      h.store.insertGoal(goalRow("goal-other", "budget_limited", "dependency_blocked"));
      h.store.insertGoal(goalRow("goal-done", "achieved", "objective_satisfied"));
      budget(h, { id: "b-paused", scopeType: "goal", scopeId: "goal-paused", limitTokens: 100 });
      budget(h, { id: "b-other", scopeType: "goal", scopeId: "goal-other", limitTokens: 100 });
      budget(h, { id: "b-done", scopeType: "goal", scopeId: "goal-done", limitTokens: 100 });
      seedSpend(h, spendRow(h, "r-p", { goalId: "goal-paused", inputTokens: 500 }), spendRow(h, "r-d", { goalId: "goal-done", inputTokens: 500 }));
      assert.deepEqual(quiet(() => h.broker.applyGoalBudgetLimits()), { limited: [], resumed: [] });
      assert.deepEqual(
        ["goal-paused", "goal-other", "goal-done"].map((id) => h.broker.getGoal(id)?.status),
        ["paused", "budget_limited", "achieved"],
      );
      assert.deepEqual(h.broker.listAuditEvents({ action: "goal.status_changed" }), []);
    } finally {
      h.close();
    }
    const off = harness(wiring, "off");
    try {
      off.broker.createGoal({ id: "goal-1", title: "Goal one", requester: OPERATOR });
      budget(off, { id: "b-goal", scopeType: "goal", scopeId: "goal-1", limitTokens: 1 });
      off.store.readSpendScopeUsage = () => {
        throw new Error("must not be read");
      };
      assert.deepEqual(off.broker.applyGoalBudgetLimits(), { limited: [], resumed: [] });
      assert.equal(off.broker.getBudgetCheckFailures().count, 0, "no spend read in mode off");
    } finally {
      off.close();
    }
  });

  // --- lost late metering ---------------------------------------------------------------

  test(`[${wiring}] late metering lost with a failed save is restaged by the periodic pass; metered rows are untouched`, () => {
    const h = harness(wiring, "off");
    try {
      for (const id of ["t-lost", "t-ok"]) {
        h.broker.createTask(taskRequest(id, "worker-a"));
        h.broker.claimTask(id, "worker-a");
        h.broker.startTask(id, "worker-a");
        quiet(() => h.broker.cancelTask(id, { actor: OPERATOR }));
      }
      quiet(() => h.broker.completeTask("t-ok", "worker-a", { summary: "late", output: TELEMETRY }));
      h.sql(`CREATE TRIGGER meter_fail BEFORE UPDATE ON broker_spend_events
             WHEN OLD.task_id = 't-lost' BEGIN SELECT RAISE(ABORT, 'metering write failed'); END`);
      assert.throws(() => quiet(() => h.broker.completeTask("t-lost", "worker-a", { summary: "late", output: TELEMETRY })), /metering write failed/);
      h.sql("DROP TRIGGER meter_fail");
      assert.ok(h.broker.getTask("t-lost")?.lateEvidenceAfterCancel, "the late evidence stayed in memory");
      // A worker retry is idempotent: no second staging.
      quiet(() => h.broker.completeTask("t-lost", "worker-a", { summary: "late", output: TELEMETRY }));
      const rows = () => h.query<{ task_id: string; input_tokens: number; output_tokens: number; cost_known: number }>(
        "SELECT task_id, input_tokens, output_tokens, cost_known FROM broker_spend_events ORDER BY task_id",
      );
      assert.deepEqual(rows(), [
        { task_id: "t-lost", input_tokens: 0, output_tokens: 0, cost_known: 0 },
        { task_id: "t-ok", input_tokens: 11, output_tokens: 4, cost_known: 1 },
      ]);
      const run = captureWarnings(() => h.broker.restageLostLateMeterings());
      assert.deepEqual(run.result, { restaged: 1, checked: 2 });
      assert.deepEqual(named(run.events, "broker.spend.late_metering_restaged"), [
        { event: "broker.spend.late_metering_restaged", count: 1, suppressed: 0 },
      ]);
      assert.deepEqual(rows(), [
        { task_id: "t-lost", input_tokens: 11, output_tokens: 4, cost_known: 1 },
        { task_id: "t-ok", input_tokens: 11, output_tokens: 4, cost_known: 1 },
      ]);
      assert.deepEqual(quiet(() => h.broker.restageLostLateMeterings()), { restaged: 0, checked: 0 }, "each task is checked once (settled)");
      // A settled id whose task left the task map is evicted when the next pass starts.
      const settled = h.broker["lateMeteringSettled"] as Set<string>;
      assert.deepEqual([...settled].sort(), ["t-lost", "t-ok"]);
      (h.broker["tasks"] as Map<string, unknown>).delete("t-ok");
      quiet(() => h.broker.restageLostLateMeterings());
      assert.deepEqual([...settled], ["t-lost"]);
    } finally {
      h.close();
    }
  });
}

// --- other claim entry points ---------------------------------------------------------------

function sendConvention(h: Harness, messageId: string) {
  return quiet(() => executeA2AJsonRpc(
    {
      jsonrpc: "2.0",
      id: 1,
      method: "SendMessage",
      params: { message: { role: "ROLE_USER", parts: [{ text: "complete me" }], messageId } },
    },
    {
      broker: h.broker,
      agentCard: createBrokerAgentCard({ serviceName: "test-broker", publicBaseUrl: "https://broker.test/" }),
      publicBaseUrl: "https://broker.test",
      requesterIdentity: null,
      enforceRequesterIdentity: false,
      defaultAgentNodeId: "default-agent",
      responseShape: "spec",
    },
  ));
}

function rpcError(response: unknown): { code: number; message: string; data?: Array<{ metadata?: Record<string, string> }> } {
  assert.ok(response && typeof response === "object" && "error" in response, `expected an error, got ${JSON.stringify(response)}`);
  return (response as { error: { code: number; message: string; data?: Array<{ metadata?: Record<string, string> }> } }).error;
}

test("JSON-RPC convention send: a claim budget refusal is decided before anything is created; retries create nothing", () => {
  const h = harness("hints", "on");
  try {
    completePeriod(h);
    budget(h, { id: "b-agent", scopeType: "agent", scopeId: "default-agent", limitTokens: 10 });
    seedSpend(h, spendRow(h, "r-1", { agentId: "default-agent", inputTokens: 50 }));
    const before = { tasks: h.broker.listTasks().length, exchanges: h.broker.exportSnapshot().exchanges.length };
    for (const messageId of ["tck-complete-task-s1", "tck-complete-task-s1", "tck-complete-task-s2", "tck-input-required-s1"]) {
      const error = rpcError(sendConvention(h, messageId));
      assert.equal(error.code, -32012, "policy_denied");
      assert.match(error.message, /budget/);
      assert.equal(error.data?.[0]?.metadata?.budgetReason, "budget_exhausted");
      assert.equal(error.data?.[0]?.metadata?.brokerCode, "policy_denied");
    }
    assert.deepEqual(
      { tasks: h.broker.listTasks().length, exchanges: h.broker.exportSnapshot().exchanges.length },
      before,
      "no exchange and no task: nothing to retry into an orphan",
    );
    assert.equal(h.broker.getBudgetEnforcementCounters().claims.refusedTotal, 4, "each refused send counts as a claim refusal");
  } finally {
    h.close();
  }
});

test("JSON-RPC convention send: a pause budget for the task it would create refuses before anything is created", () => {
  const h = harness("hints", "on");
  try {
    completePeriod(h);
    budget(h, { id: "b-pause", scopeType: "lane", scopeId: "chat", limitTokens: 10, enforce: "pause" });
    seedSpend(h, spendRow(h, "r-1", { lane: "chat", inputTokens: 50 }));
    const before = h.broker.exportSnapshot().exchanges.length;
    const error = rpcError(sendConvention(h, "hello-plain-send"));
    assert.equal(error.code, -32012);
    assert.equal(error.data?.[0]?.metadata?.budgetReason, "budget_paused");
    assert.equal(h.broker.exportSnapshot().exchanges.length, before, "no orphan exchange");
    assert.equal(h.broker.listTasks().length, 0);
  } finally {
    h.close();
  }
});

test("JSON-RPC convention send: an inline claim still refused after the check (race) cancels the created task and names it in the error data", () => {
  const h = harness("hints", "on");
  try {
    completePeriod(h);
    budget(h, { id: "b-agent", scopeType: "agent", scopeId: "default-agent", limitTokens: 10 });
    seedSpend(h, spendRow(h, "r-1", { agentId: "default-agent", inputTokens: 50 }));
    // The budget runs out between the check and the inline claim.
    h.broker.assertClaimBudgetAllowed = () => undefined;
    const error = rpcError(sendConvention(h, "tck-complete-task-race"));
    assert.equal(error.code, -32012);
    const metadata = error.data?.[0]?.metadata ?? {};
    assert.equal(metadata.budgetReason, "budget_exhausted");
    assert.match(error.message, new RegExp(`claim of task ${metadata.taskId} \\(context ${metadata.contextId}\\) refused by a monthly budget; the task was canceled`));
    const task = h.broker.getTask(metadata.taskId!);
    assert.equal(task?.status, "canceled", "it cannot run later");
    assert.equal(task?.exchangeId, metadata.contextId);
    assert.equal(h.query<{ n: number }>("SELECT COUNT(*) AS n FROM broker_spend_events WHERE task_id = ?", metadata.taskId!)[0]?.n, 1, "the normal cancel path wrote its spend row");
  } finally {
    h.close();
  }
});

test("lease-gated HTTP claim: a budget refusal releases the granted lease, so a later claim is granted", async () => {
  const h = harness("repositories", "on");
  try {
    completePeriod(h);
    budget(h, { id: "b-lane", scopeType: "lane", scopeId: "analyze", limitTokens: 100 });
    seedSpend(h, spendRow(h, "r-1", { inputTokens: 500 }));
    h.broker.createTask(taskRequest("t-1", "worker-a"));
    const server = await startTestServer({
      broker: h.broker,
      stateStore: h.store,
      enforceRequesterIdentity: false,
      budgetEnforcementMode: "on",
      budgetPeriodTimeZone: "UTC",
      rateLimitMaxRequests: 1_000,
      sharedStateLeaseV1: true,
      staleReaperOlderThanSec: 60,
    });
    try {
      const claim = () => fetch(`${server.baseUrl}/tasks/t-1/claim`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workerId: "worker-a" }),
      });
      const refused = await quiet(claim);
      const refusedBody = await refused.json() as { error?: { details?: Record<string, unknown> } };
      assert.equal(refused.status, 403);
      assert.equal(refusedBody.error?.details?.reason, "budget_exhausted");
      assertStillQueued(h, "t-1");
      // Raise the limit: the claim is granted, so the refused claim's lease was released.
      h.broker.updateBudget("b-lane", { limitTokens: 10_000, actorId: "operator-1" });
      const granted = await claim();
      const body = await granted.json() as { status?: string; leaseV1?: unknown };
      assert.equal(granted.status, 200, JSON.stringify(body));
      assert.equal(body.status, "claimed");
      assert.ok(body.leaseV1, "a lease stamp from the authority");
    } finally {
      await server.close();
    }
  } finally {
    h.close();
  }
});

// --- 3b-1 round-2 minors ------------------------------------------------------------------

test("7a/m1/m2 (worker-thread): gen1 fails, gen2 lands: gen1's audit event goes, gen2's stays, memory follows the stored row", async () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-budget-gen-"));
  const dbFile = join(dir, "state.sqlite");
  const exec = (sql: string) => {
    const db = new DatabaseSync(dbFile);
    try {
      db.exec(sql);
    } finally {
      db.close();
    }
  };
  const handle = createWorkerThreadPersistence({ dbFile, loadSource: "hot-tables", queueCapacity: 256 });
  const originalError = console.error;
  try {
    const proxy = handle.stateStore;
    const broker = new InMemoryA2ABroker(proxy, proxy.load(), { budgetPeriodTimeZone: "UTC" });
    broker.createBudget({ id: "b-1", scopeType: "lane", scopeId: "analyze", period: "month", limitUsd: 1, createdBy: "o" });
    await proxy.awaitDurablePersistenceAck();
    assert.equal(broker.getBudgetWriteGeneration("b-1"), undefined, "a settled write is not kept");
    exec(`CREATE TRIGGER gen1_fail BEFORE UPDATE ON broker_budgets
          WHEN NEW.limit_usd = 7 BEGIN SELECT RAISE(ABORT, 'budget write failed'); END`);
    broker.updateBudget("b-1", { limitUsd: 7, actorId: "o" });
    const gen1 = broker.getBudgetWriteGeneration("b-1")!;
    broker.updateBudget("b-1", { limitUsd: 9, actorId: "o" });
    const gen2 = broker.getBudgetWriteGeneration("b-1")!;
    assert.ok(gen2 > gen1);
    // A resync for gen1 while gen2 is still queued keeps gen2's in-memory record.
    broker.reloadBudgetFromStore("b-1", gen1);
    assert.equal(broker.getBudget("b-1")?.limitUsd, 9, "a newer queued write holds memory");
    assert.equal(broker.listAuditEvents({ action: "budget.updated" }).length, 1, "gen1's audit event is removed even with gen2 pending");
    console.error = () => {};
    await assert.rejects(() => proxy.awaitDurablePersistenceAck(), /budget write failed/);
    console.error = originalError;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(broker.getBudgetWriteGeneration("b-1"), undefined, "gen2 settled when its write landed");
    broker.reloadBudgetFromStore("b-1", gen2);
    assert.equal(broker.getBudget("b-1")?.limitUsd, 9, "memory follows the stored row (gen2 landed)");
    assert.deepEqual(
      broker.listAuditEvents({ action: "budget.updated" }).map((event) => event.note),
      ["limitUsd"],
      "gen2's audit event stays",
    );
    const db = new DatabaseSync(dbFile);
    try {
      assert.deepEqual(db.prepare("SELECT limit_usd FROM broker_budgets WHERE id = 'b-1'").all().map((row) => ({ ...row })), [{ limit_usd: 9 }]);
    } finally {
      db.close();
    }
  } finally {
    console.error = originalError;
    await handle.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("7a: a rollback restores the earlier staged budget row (pending buffer)", () => {
  const buffer = new PendingHotStateBuffer();
  const row = (limitUsd: number): BudgetRecord => ({
    id: "b-1", scopeType: "lane", scopeId: "analyze", period: "month", limitUsd, limitTokens: null,
    warnPct: 80, enforce: "refuse", createdBy: "o", createdAt: "2026-11-01T00:00:00.000Z",
  });
  buffer.stageBudget(row(1));
  const previous = buffer.stagedBudget("b-1");
  buffer.stageBudget(row(2));
  buffer.unstageBudget("b-1", previous);
  assert.deepEqual(buffer.consumeAll()?.budgets?.map((budget) => budget.limitUsd), [1], "the earlier staged row is restored");
  buffer.stageBudget(row(3));
  buffer.unstageBudget("b-1");
  assert.equal(buffer.consumeAll(), undefined);
});

test("7b: budget reads return copies", () => {
  const h = harness("hints", "off");
  try {
    budget(h, { id: "b-1", scopeType: "lane", scopeId: "analyze", limitUsd: 1 });
    const created = h.broker.createBudget({ id: "b-2", scopeType: "lane", scopeId: "chat", period: "month", limitUsd: 2, createdBy: "o" });
    for (const copy of [created, h.broker.getBudget("b-2")!, h.broker.findBudgetForScope("lane", "chat")!, h.broker.listBudgets()![1]!]) {
      copy.limitUsd = 999;
    }
    const updated = h.broker.updateBudget("b-1", { limitUsd: 3, actorId: "o" });
    updated.limitUsd = 999;
    assert.equal(h.broker.getBudget("b-2")?.limitUsd, 2);
    assert.equal(h.broker.getBudget("b-1")?.limitUsd, 3);
  } finally {
    h.close();
  }
});

// --- Fix round (PR review): M1, m3, m5, m6, m7, m11, m12 ------------------------------------

/** A goal budget exhausted for goal-1; tasks linked to it are refused for any worker. */
function exhaustedGoal(h: Harness): void {
  completePeriod(h);
  h.broker.createGoal({ id: "goal-1", title: "Goal one", requester: OPERATOR });
  budget(h, { id: "b-goal", scopeType: "goal", scopeId: "goal-1", limitTokens: 100 });
  seedSpend(h, spendRow(h, "r-g", { goalId: "goal-1", inputTokens: 150 }));
}

for (const wiring of WIRINGS) {
  test(`[${wiring}] M1: refused tasks ahead of the page cut do not starve claimable ones (limit+3 refused, then 2 claimable)`, async () => {
    const h = harness(wiring, "on");
    try {
      exhaustedGoal(h);
      // Older claimable tasks first, then newer refused ones: the refused sort first (updated_at DESC, id ASC).
      for (const id of ["z-ok-1", "z-ok-2"]) h.broker.createTask(taskRequest(id, "worker-a"));
      for (let index = 0; index < 5; index += 1) h.broker.createTask(taskRequest(`a-refused-${index}`, "worker-a", { goalId: "goal-1" }));
      await withServer(h, "on", async (baseUrl) => {
        for (const detail of ["", "&detail=full"]) {
          const res = await fetch(`${baseUrl}/tasks?${POLL("worker-a")}&limit=2${detail}`);
          const body = await res.json() as { count: number; limit: number; items: Array<{ id: string }>; budgetOmitted: number; budgetScanCapped: boolean };
          assert.deepEqual(body.items.map((item) => item.id).sort(), ["z-ok-1", "z-ok-2"], `detail=${detail || "items"}`);
          assert.equal(body.count, 2);
          assert.equal(body.limit, 2, "limit stays the requested limit");
          assert.equal(body.budgetOmitted, 5);
          assert.equal(body.budgetScanCapped, false);
        }
        assert.deepEqual(await snapshotIds(baseUrl, "worker-a"), ["z-ok-1", "z-ok-2"], "SSE agrees");
        assert.equal((await listingStatus(baseUrl))?.lastOmittedCount, 5);
      });
    } finally {
      h.close();
    }
  });

  test(`[${wiring}] M1 (#2499 slice 4 5a): the refill stops after max(limit, min(10 x limit, 1000), 50) candidates and says so`, async () => {
    const h = harness(wiring, "on");
    try {
      exhaustedGoal(h);
      h.broker.createTask(taskRequest("z-ok", "worker-a"));
      for (let index = 0; index < 12; index += 1) h.broker.createTask(taskRequest(`a-refused-${String(index).padStart(2, "0")}`, "worker-a", { goalId: "goal-1" }));
      await withServer(h, "on", async (baseUrl) => {
        type Poll = { items: Array<{ id: string }>; budgetOmitted: number; budgetScanCapped: boolean };
        const small = await (await fetch(`${baseUrl}/tasks?${POLL("worker-a")}&limit=1`)).json() as Poll;
        assert.deepEqual(small.items.map((item) => item.id), ["z-ok"], "limit=1 scans the minimum fetch (50), not 10 candidates");
        assert.equal(small.budgetOmitted, 12);
        assert.equal(small.budgetScanCapped, false);
        quiet(() => {
          for (let index = 12; index < 55; index += 1) h.broker.createTask(taskRequest(`a-refused-${String(index).padStart(2, "0")}`, "worker-a", { goalId: "goal-1" }));
        });
        const capped = await (await fetch(`${baseUrl}/tasks?${POLL("worker-a")}&limit=1`)).json() as Poll;
        assert.deepEqual(capped.items, [], "the claimable task is past the 50-candidate bound");
        assert.equal(capped.budgetOmitted, 50);
        assert.equal(capped.budgetScanCapped, true);
        const wider = await (await fetch(`${baseUrl}/tasks?${POLL("worker-a")}&limit=6`)).json() as Poll;
        assert.deepEqual(wider.items.map((item) => item.id), ["z-ok"], "a bound of 60 reaches it");
      });
    } finally {
      h.close();
    }
  });

  test(`[${wiring}] M1: a held all-omitted long poll returns promptly once PATCH raises the limit`, async () => {
    const h = harness(wiring, "on");
    try {
      completePeriod(h);
      budget(h, { id: "b-lane", scopeType: "lane", scopeId: "analyze", limitTokens: 100 });
      seedSpend(h, spendRow(h, "r-1", { inputTokens: 500 }));
      h.broker.createTask(taskRequest("t-1", "worker-a"));
      await withServer(h, "on", async (baseUrl) => {
        const startedAt = Date.now();
        const poll = fetch(`${baseUrl}/tasks?${POLL("worker-a")}&waitMs=10000`, { headers: { "x-a2a-requester-id": "worker-a" } });
        await new Promise((resolve) => setTimeout(resolve, 200));
        const patched = await fetch(`${baseUrl}/budgets/b-lane`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ limitTokens: 10_000 }),
        });
        assert.equal(patched.status, 200);
        const body = await (await poll).json() as { items: Array<{ id: string }> };
        assert.deepEqual(body.items.map((item) => item.id), ["t-1"]);
        assert.ok(Date.now() - startedAt < 5_000, "woken by the budget write's state change, not the 10 s deadline");
      });
    } finally {
      h.close();
    }
  });

  test(`[${wiring}] #2520 a period roll releases a held all-omitted long poll (re-listed every drain-check slice), not at waitMs`, async () => {
    const h = harness(wiring, "on");
    try {
      completePeriod(h);
      budget(h, { id: "b-lane", scopeType: "lane", scopeId: "analyze", limitTokens: 100 });
      seedSpend(h, spendRow(h, "r-1", { inputTokens: 500 }));
      h.broker.createTask(taskRequest("t-1", "worker-a"));
      await withServer(h, "on", async (baseUrl) => {
        const startedAt = Date.now();
        const poll = fetch(`${baseUrl}/tasks?${POLL("worker-a")}&waitMs=10000`, { headers: { "x-a2a-requester-id": "worker-a" } });
        await new Promise((resolve) => setTimeout(resolve, 300));
        const next = nextPeriodKey(h.broker.budgetPeriodKey());
        const roll = mock.method(h.broker, "budgetPeriodKey", () => next);
        try {
          const body = await (await poll).json() as { items: Array<{ id: string }> };
          assert.deepEqual(body.items.map((item) => item.id), ["t-1"]);
          assert.ok(Date.now() - startedAt < 5_000, "released within a slice of the roll, not at the 10 s deadline");
        } finally {
          roll.mock.restore();
        }
      });
    } finally {
      h.close();
    }
  });

  test(`[${wiring}] #2520 the worker= alias (and status=pending) poll applies the same budget filter`, async () => {
    const h = harness(wiring, "on");
    try {
      exhaustedGoal(h);
      h.broker.createTask(taskRequest("t-goal", "worker-a", { goalId: "goal-1" }));
      h.broker.createTask(taskRequest("t-plain", "worker-a"));
      await withServer(h, "on", async (baseUrl) => {
        const expected = await listIds(baseUrl, POLL("worker-a"));
        assert.deepEqual(expected, ["t-plain"]);
        assert.deepEqual(await listIds(baseUrl, "worker=worker-a&status=queued"), expected, "worker= alias");
        assert.deepEqual(await listIds(baseUrl, "worker=worker-a&status=pending"), expected, "status=pending is queued");
        const body = await (await fetch(`${baseUrl}/tasks?worker=worker-a&status=queued`)).json() as { budgetOmitted?: number };
        assert.equal(body.budgetOmitted, 1);
      });
    } finally {
      h.close();
    }
  });

  test(`[${wiring}] #2520 an identity-enforced (signed) worker poll applies the budget filter`, async () => {
    const h = harness(wiring, "on");
    const keyPair = generateKeyPairSync("ed25519");
    const keyid = "worker:worker-a:budget";
    try {
      exhaustedGoal(h);
      h.broker.createTask(taskRequest("t-goal", "worker-a", { goalId: "goal-1" }));
      h.broker.createTask(taskRequest("t-plain", "worker-a"));
      const server = await startTestServer({
        broker: h.broker,
        stateStore: h.store,
        enforceRequesterIdentity: true,
        brokerId: "brokeralpha",
        a2aHttpSignatureWorkerAuth: "strict",
        a2aHttpSignatureKeyRegistry: {
          [keyid]: { keyid, workerId: "worker-a", publicKeyJwk: keyPair.publicKey.export({ format: "jwk" }) as Record<string, unknown> },
        },
        budgetEnforcementMode: "on",
        budgetPeriodTimeZone: "UTC",
        rateLimitMaxRequests: 1_000,
      });
      try {
        const url = new URL(`/tasks?${POLL("worker-a")}`, server.baseUrl);
        const headers = new Headers({
          accept: "application/json",
          "x-a2a-requester-id": "worker-a",
          "x-a2a-requester-kind": "node",
          "x-a2a-requester-role": "analyst",
        });
        const unsigned = await fetch(url, { headers });
        assert.equal(unsigned.status, 401, "precondition: the poll is identity-enforced");
        signA2AWorkerRequest({
          method: "GET",
          url,
          headers,
          body: "",
          config: { keyid, privateKeyJwk: keyPair.privateKey.export({ format: "jwk" }) as Record<string, unknown>, brokerId: "brokeralpha" },
        });
        const res = await fetch(url, { headers });
        assert.equal(res.status, 200);
        const body = await res.json() as { items: Array<{ id: string }>; budgetOmitted: number };
        assert.deepEqual(body.items.map((item) => item.id), ["t-plain"]);
        assert.equal(body.budgetOmitted, 1);
      } finally {
        await server.close();
      }
    } finally {
      h.close();
    }
  });

  test(`[${wiring}] m12: mode off — the worker poll and the SSE snapshot read no budget`, async () => {
    const h = harness(wiring, "off");
    try {
      budget(h, { id: "b-lane", scopeType: "lane", scopeId: "analyze", limitTokens: 1 });
      seedSpend(h, spendRow(h, "r-1", { inputTokens: 500 }));
      h.broker.createTask(taskRequest("t-1", "worker-a"));
      let reads = 0;
      const spy = <F extends (...args: never[]) => unknown>(fn: F): F => ((...args: never[]) => {
        reads += 1;
        return fn(...args);
      }) as F;
      h.store.readSpendScopeUsage = spy(h.store.readSpendScopeUsage.bind(h.store));
      h.store.hasCostReportingSpend = spy(h.store.hasCostReportingSpend.bind(h.store));
      h.store.readSpendLedgerMetadata = spy(h.store.readSpendLedgerMetadata.bind(h.store));
      await withServer(h, "off", async (baseUrl) => {
        const body = await (await fetch(`${baseUrl}/tasks?${POLL("worker-a")}`)).json() as Record<string, unknown>;
        assert.deepEqual((body.items as Array<{ id: string }>).map((item) => item.id), ["t-1"]);
        assert.equal("budgetOmitted" in body, false, "the response shape is unchanged in mode off");
        assert.deepEqual(await snapshotIds(baseUrl, "worker-a"), ["t-1"]);
      });
      assert.equal(reads, 0);
    } finally {
      h.close();
    }
  });

  test(`[${wiring}] m5: a failed scope read is counted once per listing and kept (fail-open)`, () => {
    const h = harness(wiring, "on");
    try {
      completePeriod(h);
      budget(h, { id: "b-lane", scopeType: "lane", scopeId: "analyze", limitTokens: 100 });
      for (let index = 0; index < 4; index += 1) h.broker.createTask(taskRequest(`t-${index}`, "worker-a"));
      let reads = 0;
      h.store.readSpendScopeUsage = () => {
        reads += 1;
        throw new Error("disk I/O error");
      };
      const listed = h.broker.listTasks({ assignedWorkerId: "worker-a", status: "queued" });
      assert.equal(quiet(() => h.broker.filterQueuedListingForWorker("worker-a", listed)).length, 4, "fail-open");
      assert.equal(reads, 1, "the failed read is not repeated within the listing");
      assert.deepEqual((({ count, consecutive }) => ({ count, consecutive }))(h.broker.getBudgetCheckFailures()), { count: 1, consecutive: 1 });
    } finally {
      h.close();
    }
  });

  test(`[${wiring}] m6: at create, the target is the agent scope only when it is a node`, () => {
    const h = harness(wiring, "on");
    try {
      completePeriod(h);
      budget(h, { id: "b-agent", scopeType: "agent", scopeId: "worker-c", limitTokens: 10, enforce: "pause" });
      seedSpend(h, spendRow(h, "r-1", { agentId: "worker-c", inputTokens: 50 }));
      const request = (id: string, kind: "node" | "service"): CreateTaskRequest => ({
        id,
        intent: "analyze",
        requester: { id: "hub-a", kind: "node", role: "hub" },
        target: { id: "worker-c", kind, role: "analyst" },
        message: `task ${id}`,
        payload: {},
      });
      assert.equal(refusal(() => h.broker.createTask(request("t-node", "node"))).details?.reason, "budget_paused");
      assert.equal(h.broker.createTask(request("t-service", "service")).status, "queued", "no agent scope for a non-node target");
    } finally {
      h.close();
    }
  });

  test(`[${wiring}] m7: when enforcement is no longer on, budget-limited goals are resumed without spend reads (on -> off, on -> shadow)`, () => {
    for (const next of ["off", "shadow"] as const) {
      const h = harness(wiring, "on");
      try {
        exhaustedGoal(h);
        assert.deepEqual(quiet(() => h.broker.applyGoalBudgetLimits())?.limited, ["goal-1"]);
        h.reopen(next);
        let reads = 0;
        h.store.readSpendScopeUsage = () => {
          reads += 1;
          return { usdSpent: 0, tokensSpent: 1_000n };
        };
        const run = quiet(() => h.broker.applyGoalBudgetLimits());
        assert.deepEqual(run?.resumed, ["goal-1"], next);
        const goal = h.broker.getGoal("goal-1")!;
        assert.equal(goal.status, "pursuing");
        assert.equal(goal.history[goal.history.length - 1]?.note, "budget_enforcement_not_on");
        assert.equal(h.broker.getBudgetEnforcementCounters().goals.resumedTotal, 1);
        if (next === "off") assert.equal(reads, 0, "mode off reads no spend");
        else assert.equal(h.broker.getBudgetEnforcementCounters().goals.wouldLimitTotal, 1, "shadow still reports what on would do");
      } finally {
        h.close();
      }
    }
  });

  test(`[${wiring}] m11: live and replayed worker-assignment events pass the same budget predicate as the snapshot`, () => {
    const h = harness(wiring, "on");
    try {
      exhaustedGoal(h);
      const open = (lastEventId?: string) => {
        const req = new EventEmitter() as unknown as IncomingMessage;
        (req as unknown as { headers: Record<string, string> }).headers = lastEventId ? { "last-event-id": lastEventId } : {};
        const chunks: string[] = [];
        const res = {
          writableEnded: false,
          writeHead() {},
          flushHeaders() {},
          write(chunk: string) {
            chunks.push(String(chunk));
            return true;
          },
          end() {
            (this as { writableEnded: boolean }).writableEnded = true;
          },
        } as unknown as ServerResponse<IncomingMessage>;
        handleWorkerAssignmentEventStream(req, res, { broker: h.broker, workerId: "worker-a", heartbeatMs: 0 });
        const assignments = () => chunks.join("").split("\n\n")
          .filter((block) => block.includes("event: worker-assignment\n"))
          .map((block) => (JSON.parse(block.split("\n").find((line) => line.startsWith("data: "))!.slice(6)) as { taskId: string }).taskId);
        return { req, assignments };
      };
      const live = open();
      quiet(() => {
        h.broker.createTask(taskRequest("t-refused", "worker-a", { goalId: "goal-1" }));
        h.broker.createTask(taskRequest("t-ok", "worker-a"));
      });
      assert.deepEqual(live.assignments(), ["t-ok"], "live events omit the refused task");
      live.req.emit("close");
      const replay = open("0");
      assert.deepEqual(replay.assignments(), ["t-ok"], "Last-Event-ID replay too");
      replay.req.emit("close");
      assert.ok(h.broker.getBudgetEnforcementCounters().listing.omittedTotal >= 2);
    } finally {
      h.close();
    }
  });

  test(`[${wiring}] m12: pause at create through the exchange-message path`, () => {
    const h = harness(wiring, "on");
    try {
      completePeriod(h);
      budget(h, { id: "b-pause", scopeType: "lane", scopeId: "analyze", limitTokens: 10, enforce: "pause" });
      seedSpend(h, spendRow(h, "r-1", { inputTokens: 50 }));
      const exchange = h.broker.startExchange({
        requester: { id: "hub-a", kind: "node", role: "hub" },
        target: { id: "worker-a", kind: "node", role: "analyst" },
        message: "start",
        intent: "analyze",
      });
      const error = refusal(() => h.broker.addExchangeMessage(exchange.id, {
        actor: { id: "worker-a", kind: "node", role: "analyst" },
        message: "accepted",
        decision: "accepted",
      }));
      assert.equal(error.details?.reason, "budget_paused");
      assert.deepEqual(h.broker.listTasks({ exchangeId: exchange.id }), [], "no task is created for the exchange");
    } finally {
      h.close();
    }
  });
}

test("m3 (worker-thread): the goal overlay is dropped once the goal write is durable; a failed goal write resyncs from the store; listGoals applies the overlay before its status filter", async () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-goal-overlay-"));
  const dbFile = join(dir, "state.sqlite");
  const exec = (sql: string) => {
    const db = new DatabaseSync(dbFile);
    try {
      db.exec(sql);
    } finally {
      db.close();
    }
  };
  const handle = createWorkerThreadPersistence({ dbFile, loadSource: "hot-tables", queueCapacity: 256 });
  const originalError = console.error;
  try {
    const proxy = handle.stateStore;
    const broker = new InMemoryA2ABroker(proxy, proxy.load(), { budgetPeriodTimeZone: "UTC", budgetEnforcementMode: "on" });
    const overlay = broker["goalUpdates"] as Map<string, unknown>;
    for (const id of ["goal-1", "goal-2"]) broker.createGoal({ id, title: id, requester: OPERATOR });
    for (const id of ["goal-1", "goal-2"]) {
      broker.createBudget({ id: `b-${id}`, scopeType: "goal", scopeId: id, period: "month", limitTokens: 10, createdBy: "o" });
    }
    proxy.saveHotEntities({
      spendEvents: ["goal-1", "goal-2"].map((goalId) => ({
        taskId: `r-${goalId}`, recordedAt: new Date().toISOString(), periodKey: broker.budgetPeriodKey(), agentId: "worker-a",
        lane: "analyze", goalId, costUsd: 0, inputTokens: 50, outputTokens: 0, costKnown: false,
      })),
    });
    await proxy.awaitDurablePersistenceAck();
    exec("UPDATE broker_metadata SET value = '2000-01' WHERE key = 'spend_ledger_first_period'");
    // goal-2's queued update fails.
    exec(`CREATE TRIGGER goal_fail BEFORE UPDATE ON broker_goals
          WHEN NEW.id = 'goal-2' BEGIN SELECT RAISE(ABORT, 'goal write failed'); END`);
    assert.deepEqual(quiet(() => broker.applyGoalBudgetLimits())?.limited.sort(), ["goal-1", "goal-2"]);
    // Before the queued writes settle the overlay serves both, ahead of the status filter.
    assert.deepEqual(broker.listGoals({ status: "budget_limited" }).map((goal) => goal.id).sort(), ["goal-1", "goal-2"]);
    assert.deepEqual(broker.listGoals({ status: "pursuing" }), []);
    console.error = () => {};
    await assert.rejects(() => proxy.awaitDurablePersistenceAck(), /goal write failed/);
    await new Promise((resolve) => setImmediate(resolve));
    console.error = originalError;
    assert.equal(overlay.size, 0, "settled writes leave the overlay (durable or resynced)");
    assert.equal(broker.getGoal("goal-1")?.status, "budget_limited", "the stored row");
    assert.equal(broker.getGoal("goal-2")?.status, "pursuing", "resynced from the store");
    assert.deepEqual(
      broker.listAuditEvents({ action: "goal.status_changed" }).map((event) => event.targetId),
      ["goal-1"],
      "the failed write's audit event is gone",
    );
  } finally {
    console.error = originalError;
    await handle.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("m12: lease-gated claim refused by a budget leaves no lease owner in the lease authority", async () => {
  const h = harness("repositories", "on");
  const dir = mkdtempSync(join(tmpdir(), "a2a-budget-lease-"));
  try {
    completePeriod(h);
    budget(h, { id: "b-lane", scopeType: "lane", scopeId: "analyze", limitTokens: 100 });
    seedSpend(h, spendRow(h, "r-1", { inputTokens: 500 }));
    h.broker.createTask(taskRequest("t-1", "worker-a"));
    const sharedStateFile = join(dir, "shared-state.sqlite");
    const server = await startTestServer({
      broker: h.broker,
      stateStore: h.store,
      enforceRequesterIdentity: false,
      budgetEnforcementMode: "on",
      budgetPeriodTimeZone: "UTC",
      rateLimitMaxRequests: 1_000,
      sharedStateLeaseV1: true,
      sharedStateFile,
      staleReaperOlderThanSec: 60,
    });
    try {
      const refused = await fetch(`${server.baseUrl}/tasks/t-1/claim`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workerId: "worker-a" }),
      });
      assert.equal(refused.status, 403);
      const db = new DatabaseSync(sharedStateFile, { readOnly: true });
      try {
        const leases = db.prepare("SELECT owner_key_digest, attempt_key_digest FROM shared_state_lease").all().map((row) => ({ ...row }));
        assert.ok(leases.length >= 1, "the authority granted a lease for the claim");
        assert.deepEqual(leases.map((lease) => lease.owner_key_digest), leases.map(() => null), "and the refusal released it (no owner)");
      } finally {
        db.close();
      }
      assertStillQueued(h, "t-1");
    } finally {
      await server.close();
    }
  } finally {
    h.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- #2499 slice 4: carried 3b-2 round-2 minors (5a-5j) ------------------------------------
// 5a is the M1 scan-bound test above.

/** A worker assignment stream on a fake response; snapshots and live assignments are read back. */
function openAssignmentStream(h: Harness, workerId: string, options: { heartbeatMs?: number } = {}) {
  const req = new EventEmitter() as unknown as IncomingMessage;
  (req as unknown as { headers: Record<string, string> }).headers = {};
  const chunks: string[] = [];
  const res = {
    writableEnded: false,
    writeHead() {},
    flushHeaders() {},
    write(chunk: string) {
      chunks.push(String(chunk));
      return true;
    },
    end() {
      (this as { writableEnded: boolean }).writableEnded = true;
    },
  } as unknown as ServerResponse<IncomingMessage>;
  handleWorkerAssignmentEventStream(req, res, { broker: h.broker, workerId, heartbeatMs: options.heartbeatMs ?? 0 });
  const blocks = (event: string) => chunks.join("").split("\n\n")
    .filter((block) => block.includes(`event: ${event}\n`))
    .map((block) => JSON.parse(block.split("\n").find((line) => line.startsWith("data: "))!.slice(6)) as Record<string, unknown>);
  return {
    snapshots: () => blocks("worker-assignment-snapshot").map((data) => (data.tasks as Array<{ taskId: string }>).map((task) => task.taskId).sort()),
    assignments: () => blocks("worker-assignment").map((data) => data.taskId as string),
    heartbeats: () => chunks.filter((chunk) => chunk.startsWith(":")).length,
    close: () => req.emit("close"),
  };
}

/** #2520: the stream checks the budget revision on a deferred (setImmediate) turn after a state change. */
function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function nextPeriodKey(current: string): string {
  const [year, month] = current.split("-").map(Number) as [number, number];
  return month === 12 ? `${year + 1}-01` : `${year}-${String(month + 1).padStart(2, "0")}`;
}

for (const wiring of WIRINGS) {
  test(`[${wiring}] 5b: an omitted assignment (snapshot or live) is re-announced by a fresh snapshot when the budget changes; #2520: every stream gets it`, async () => {
    const h = harness(wiring, "on");
    try {
      exhaustedGoal(h);
      quiet(() => h.broker.createTask(taskRequest("t-before", "worker-a", { goalId: "goal-1" })));
      const stream = openAssignmentStream(h, "worker-a");
      const other = openAssignmentStream(h, "worker-b");
      assert.deepEqual(stream.snapshots(), [[]], "the snapshot omits the refused task");
      quiet(() => h.broker.createTask(taskRequest("t-live", "worker-a", { goalId: "goal-1" })));
      assert.deepEqual(stream.assignments(), [], "the live event is omitted");
      quiet(() => h.broker.createTask(taskRequest("t-b", "worker-b")));
      await settle();
      assert.equal(stream.snapshots().length, 1, "a state change without a budget change sends nothing");
      h.broker.updateBudget("b-goal", { limitTokens: 10_000, actorId: "operator-1" });
      assert.equal(stream.snapshots().length, 1, "deferred past the write's commit");
      await settle();
      assert.deepEqual(stream.snapshots(), [[], ["t-before", "t-live"]], "re-announced once allowed");
      assert.deepEqual(other.snapshots(), [[], ["t-b"]], "#2520: a stream that omitted nothing gets the fresh snapshot too");
      quiet(() => h.broker.createTask(taskRequest("t-ok", "worker-a")));
      await settle();
      assert.equal(stream.snapshots().length, 2, "no budget change: no re-send");
      assert.deepEqual(stream.assignments(), ["t-ok"]);
      stream.close();
      other.close();
    } finally {
      h.close();
    }
  });

  test(`[${wiring}] 5b: the period roll re-announces omitted assignments on the next state change`, async () => {
    const h = harness(wiring, "on");
    try {
      exhaustedGoal(h);
      quiet(() => h.broker.createTask(taskRequest("t-1", "worker-a", { goalId: "goal-1" })));
      const stream = openAssignmentStream(h, "worker-a");
      assert.deepEqual(stream.snapshots(), [[]]);
      const next = nextPeriodKey(h.broker.budgetPeriodKey());
      const roll = mock.method(h.broker, "budgetPeriodKey", () => next);
      try {
        quiet(() => h.broker.createTask(taskRequest("t-other", "worker-b")));
        await settle();
        assert.deepEqual(stream.snapshots(), [[], ["t-1"]]);
      } finally {
        roll.mock.restore();
      }
      stream.close();
    } finally {
      h.close();
    }
  });

  test(`[${wiring}] #2520 heartbeat cadence: a period roll without any state change re-announces; close clears the interval`, () => {
    const h = harness(wiring, "on");
    mock.timers.enable({ apis: ["setInterval"] });
    try {
      exhaustedGoal(h);
      quiet(() => h.broker.createTask(taskRequest("t-1", "worker-a", { goalId: "goal-1" })));
      const stream = openAssignmentStream(h, "worker-a", { heartbeatMs: 1_000 });
      assert.deepEqual(stream.snapshots(), [[]]);
      mock.timers.tick(1_000);
      assert.equal(stream.snapshots().length, 1, "no budget change: the heartbeat check sends nothing");
      assert.equal(stream.heartbeats(), 1, "the heartbeat itself runs at the same cadence");
      const next = nextPeriodKey(h.broker.budgetPeriodKey());
      const roll = mock.method(h.broker, "budgetPeriodKey", () => next);
      try {
        mock.timers.tick(1_000);
        assert.deepEqual(stream.snapshots(), [[], ["t-1"]], "the period roll is noticed at the heartbeat cadence, with no state change");
        stream.close();
        mock.timers.tick(5_000);
        assert.equal(stream.snapshots().length, 2, "closed: the budget interval is cleared");
        assert.equal(stream.heartbeats(), 2, "and so is the heartbeat");
      } finally {
        roll.mock.restore();
      }
    } finally {
      mock.timers.reset();
      h.close();
    }
  });

  test(`[${wiring}] #2520 a stream that omitted nothing drops tasks of a scope that just ran out (alert sweep) and of a lowered limit`, async () => {
    const h = harness(wiring, "on");
    try {
      completePeriod(h);
      h.broker.createGoal({ id: "goal-1", title: "Goal one", requester: OPERATOR });
      budget(h, { id: "b-goal", scopeType: "goal", scopeId: "goal-1", limitTokens: 100 });
      quiet(() => h.broker.createTask(taskRequest("t-1", "worker-a", { goalId: "goal-1" })));
      const stream = openAssignmentStream(h, "worker-a");
      assert.deepEqual(stream.snapshots(), [["t-1"]], "nothing omitted yet");
      // Spend reaches the limit: no budget write, no state change. The alert
      // sweep notices it and the revision moves.
      seedSpend(h, spendRow(h, "r-g", { goalId: "goal-1", inputTokens: 150 }));
      quiet(() => h.broker.evaluateBudgetAlerts());
      quiet(() => h.broker.createTask(taskRequest("t-other", "worker-b")));
      await settle();
      assert.deepEqual(stream.snapshots(), [["t-1"], []], "the scope ran out: the fresh snapshot drops it");
      h.broker.updateBudget("b-goal", { limitTokens: 10_000, actorId: "operator-1" });
      await settle();
      h.broker.updateBudget("b-goal", { limitTokens: 50, actorId: "operator-1" });
      await settle();
      assert.deepEqual(stream.snapshots(), [["t-1"], [], ["t-1"], []], "a lowered limit drops it again");
      stream.close();
    } finally {
      h.close();
    }
  });

  test(`[${wiring}] #2520 the re-snapshot follows the committed budget: a raise that rolls back re-announces nothing new`, async () => {
    const h = harness(wiring, "on");
    try {
      exhaustedGoal(h);
      quiet(() => h.broker.createTask(taskRequest("t-1", "worker-a", { goalId: "goal-1" })));
      const stream = openAssignmentStream(h, "worker-a");
      assert.deepEqual(stream.snapshots(), [[]]);
      // The outermost commit fails after the mutation ran (and announced its
      // state change); nested joins (the store's own saves) pass through.
      const runBatch = h.store.runBatch.bind(h.store);
      let depth = 0;
      let announced = 0;
      const unsubscribe = h.broker.subscribeToState(() => {
        announced += 1;
      });
      const failing = mock.method(h.store, "runBatch", <T>(fn: () => T): T => {
        depth += 1;
        try {
          const result = runBatch(fn);
          if (depth === 1) throw new Error("commit failed");
          return result;
        } finally {
          depth -= 1;
        }
      });
      try {
        assert.throws(() => h.broker.updateBudget("b-goal", { limitTokens: 10_000, actorId: "operator-1" }), /commit failed/);
      } finally {
        failing.mock.restore();
        unsubscribe();
      }
      assert.equal(announced, 1, "precondition: the state change was announced inside the failed commit");
      assert.equal(h.broker.getBudget("b-goal")?.limitTokens, 100, "memory restored");
      assert.equal(stream.snapshots().length, 1, "nothing sent from inside the commit");
      await settle();
      assert.equal(stream.snapshots().length, 2, "the revision moved: a snapshot after the rollback");
      assert.deepEqual(stream.snapshots().at(-1), [], "the task the claim still refuses is not listed");
      assert.equal(stream.snapshots().some((ids) => ids.includes("t-1")), false);
      stream.close();
    } finally {
      h.close();
    }
  });

  test(`[${wiring}] #2520 mode off: the stream subscribes to no budget re-check and sends one snapshot`, async () => {
    const h = harness(wiring, "off");
    try {
      budget(h, { id: "b-lane", scopeType: "lane", scopeId: "analyze", limitTokens: 1 });
      quiet(() => h.broker.createTask(taskRequest("t-1", "worker-a")));
      const revision = mock.method(h.broker, "getBudgetRevision");
      const stream = openAssignmentStream(h, "worker-a");
      h.broker.updateBudget("b-lane", { limitTokens: 5, actorId: "operator-1" });
      await settle();
      assert.deepEqual(stream.snapshots(), [["t-1"]]);
      assert.equal(revision.mock.callCount(), 0, "the revision is never read in mode off");
      revision.mock.restore();
      stream.close();
    } finally {
      h.close();
    }
  });

  test(`[${wiring}] 5e: a restaged task is settled only after its save succeeded; a failing save is retried, then settled after 3 attempts`, () => {
    const h = harness(wiring, "off");
    try {
      for (const id of ["t-retry", "t-abandon"]) {
        h.broker.createTask(taskRequest(id, "worker-a"));
        h.broker.claimTask(id, "worker-a");
        h.broker.startTask(id, "worker-a");
        quiet(() => h.broker.cancelTask(id, { actor: OPERATOR }));
      }
      h.sql(`CREATE TRIGGER meter_fail BEFORE UPDATE ON broker_spend_events
             WHEN OLD.task_id IN ('t-retry', 't-abandon') BEGIN SELECT RAISE(ABORT, 'metering write failed'); END`);
      for (const id of ["t-retry", "t-abandon"]) {
        assert.throws(() => quiet(() => h.broker.completeTask(id, "worker-a", { summary: "late", output: TELEMETRY })), /metering write failed/);
        // #2523: the failed save now keeps its metering in the pending buffer
        // and degrades persistence. This test is about the restage pass that
        // repairs a metering lost before #2523, so simulate that loss: drop
        // the kept rows and let a recovery save (it writes no metering) clear
        // the state.
        (h.broker["pendingHot"] as PendingHotStateBuffer).clear();
        assert.equal(h.broker.retryDegradedPersistence(), "ok");
      }
      const settled = h.broker["lateMeteringSettled"] as Set<string>;
      const attempts = h.broker["lateMeteringAttempts"] as Map<string, number>;
      assert.equal(quiet(() => h.broker.restageLostLateMeterings()), undefined, "the save failed");
      assert.deepEqual([...settled], [], "nothing is settled by a failed save");
      assert.deepEqual([...attempts.entries()].sort(), [["t-abandon", 1], ["t-retry", 1]]);
      h.sql("DROP TRIGGER meter_fail");
      h.sql(`CREATE TRIGGER meter_fail BEFORE UPDATE ON broker_spend_events
             WHEN OLD.task_id = 't-abandon' BEGIN SELECT RAISE(ABORT, 'metering write failed'); END`);
      // After a failed save the pass writes row by row: t-retry lands, t-abandon fails again.
      assert.equal(quiet(() => h.broker.restageLostLateMeterings()), undefined, "one row still failed");
      assert.deepEqual([...settled], ["t-retry"], "the row whose save succeeded is settled");
      assert.deepEqual([...attempts.entries()], [["t-abandon", 2]]);
      const run = captureWarnings(() => h.broker.restageLostLateMeterings());
      assert.equal(run.result, undefined);
      assert.deepEqual(named(run.events, "broker.spend.late_metering_restage_abandoned"), [
        { event: "broker.spend.late_metering_restage_abandoned", taskId: "t-abandon", attempts: 3 },
      ]);
      assert.deepEqual([...settled].sort(), ["t-abandon", "t-retry"], "settled after 3 failed attempts");
      assert.equal(attempts.size, 0);
      assert.deepEqual(quiet(() => h.broker.restageLostLateMeterings()), { restaged: 0, checked: 0 });
      assert.deepEqual(
        h.query<{ task_id: string; cost_known: number }>("SELECT task_id, cost_known FROM broker_spend_events ORDER BY task_id"),
        [{ task_id: "t-abandon", cost_known: 0 }, { task_id: "t-retry", cost_known: 1 }],
      );
    } finally {
      h.close();
    }
  });

  test(`[${wiring}] 5e: a failed save leaves the task for the next pass, which repairs and settles it`, () => {
    const h = harness(wiring, "off");
    try {
      h.broker.createTask(taskRequest("t-lost", "worker-a"));
      h.broker.claimTask("t-lost", "worker-a");
      h.broker.startTask("t-lost", "worker-a");
      quiet(() => h.broker.cancelTask("t-lost", { actor: OPERATOR }));
      h.sql(`CREATE TRIGGER meter_fail BEFORE UPDATE ON broker_spend_events
             WHEN OLD.task_id = 't-lost' BEGIN SELECT RAISE(ABORT, 'metering write failed'); END`);
      assert.throws(() => quiet(() => h.broker.completeTask("t-lost", "worker-a", { summary: "late", output: TELEMETRY })), /metering write failed/);
      assert.equal(quiet(() => h.broker.restageLostLateMeterings()), undefined);
      h.sql("DROP TRIGGER meter_fail");
      assert.deepEqual(quiet(() => h.broker.restageLostLateMeterings()), { restaged: 1, checked: 1 });
      assert.ok((h.broker["lateMeteringSettled"] as Set<string>).has("t-lost"));
      assert.deepEqual(
        h.query<{ input_tokens: number; cost_known: number }>("SELECT input_tokens, cost_known FROM broker_spend_events WHERE task_id = 't-lost'"),
        [{ input_tokens: 11, cost_known: 1 }],
      );
    } finally {
      h.close();
    }
  });

  test(`[${wiring}] 5f: a queued write from an earlier call is never attributed to a later one; the landed check normalizes missing limits`, () => {
    const h = harness(wiring, "on");
    try {
      budget(h, { id: "b-1", scopeType: "lane", scopeId: "analyze", limitUsd: 1 });
      // A write queued earlier that never settles.
      const stale = new Promise<unknown>(() => {});
      (h.store as unknown as { latestQueuedWrite: () => Promise<unknown> }).latestQueuedWrite = () => stale;
      h.broker.updateBudget("b-1", { limitUsd: 2, actorId: "operator-1" });
      assert.equal(h.broker.getBudgetWriteGeneration("b-1"), undefined, "this call queued nothing: not kept as pending");
      delete (h.store as unknown as { latestQueuedWrite?: unknown }).latestQueuedWrite;
      // The landed check: a pending record with an absent limit matches the stored null.
      const audit = h.broker.listAuditEvents({ action: "budget.updated" })[0]!;
      const stored = h.broker.getBudget("b-1")!;
      const pending = h.broker["budgetPendingWrites"] as Map<string, Array<{ generation: number; auditEventId: string; record: BudgetRecord }>>;
      pending.set("b-1", [{ generation: 99, auditEventId: audit.id, record: { ...stored, limitTokens: undefined as unknown as null } }]);
      h.broker.reloadBudgetFromStore("b-1", 99);
      assert.equal(h.broker.listAuditEvents({ action: "budget.updated" }).length, 1, "the write landed: its audit event stays");
      assert.equal(h.broker.getBudgetWriteGeneration("b-1"), undefined);
    } finally {
      h.close();
    }
  });

  test(`[${wiring}] 5g: listGoals applies every filter to the overlay and reads past the limit by the overlay size`, () => {
    const h = harness(wiring, "on");
    try {
      for (const id of ["g-1", "g-2", "g-3"]) h.broker.createGoal({ id, title: id, requester: OPERATOR });
      const [first] = h.broker.listGoals({ status: "pursuing", limit: 1 });
      const overlay = h.broker["goalUpdates"] as Map<string, GoalRecord>;
      overlay.set(first!.id, { ...first!, status: "budget_limited" });
      const page = h.broker.listGoals({ status: "pursuing", limit: 2 });
      assert.equal(page.length, 2, "not short: the store was read past the limit");
      assert.equal(page.some((goal) => goal.id === first!.id), false);
      const all = h.broker.listGoals({});
      const cursor = { updatedAt: all[0]!.updatedAt, id: all[0]!.id };
      const after = h.broker.listGoals({ after: cursor });
      assert.deepEqual(after.map((goal) => goal.id), all.slice(1).map((goal) => goal.id), "the keyset cursor applies to overlay goals too");
      overlay.clear();
    } finally {
      h.close();
    }
  });

  test(`[${wiring}] 5g: the not-on resume pass walks budget_limited goals with a cursor, so goals limited for another reason cannot pin it`, () => {
    const h = harness(wiring, "off");
    try {
      const goalRow = (id: string, updatedAt: string, reason: GoalRecord["history"][number]["reason"]): GoalRecord => ({
        id,
        title: id,
        objective: id,
        requester: OPERATOR,
        status: "budget_limited",
        createdAt: updatedAt,
        updatedAt,
        taskAttachments: [],
        history: [{ id: `${id}-h`, goalId: id, from: "pursuing", to: "budget_limited", reason, createdAt: updatedAt }],
      });
      h.store.insertGoal(goalRow("other-1", "2026-11-06T00:00:02.000Z", "dependency_blocked"));
      h.store.insertGoal(goalRow("other-2", "2026-11-06T00:00:01.000Z", "dependency_blocked"));
      for (const id of ["bl-1", "bl-2", "bl-3"]) h.store.insertGoal(goalRow(id, "2026-11-01T00:00:00.000Z", "budget_exhausted"));
      budget(h, { id: "b-goal", scopeType: "goal", scopeId: "bl-1", limitTokens: 100 });
      const resumed: string[][] = [];
      for (let index = 0; index < 4; index += 1) resumed.push(quiet(() => h.broker.applyGoalBudgetLimits({ limit: 2 }))!.resumed);
      assert.deepEqual(resumed, [[], ["bl-1", "bl-2"], ["bl-3"], []]);
      assert.deepEqual(["other-1", "other-2"].map((id) => h.broker.getGoal(id)?.status), ["budget_limited", "budget_limited"]);
    } finally {
      h.close();
    }
  });

  test(`[${wiring}] 5h: shadow counts goals.wouldLimitTotal once per goal per period`, () => {
    const h = harness(wiring, "shadow");
    try {
      exhaustedGoal(h);
      for (let index = 0; index < 3; index += 1) quiet(() => h.broker.applyGoalBudgetLimits());
      assert.equal(h.broker.getBudgetEnforcementCounters().goals.wouldLimitTotal, 1);
      const current = h.broker.budgetPeriodKey();
      const [year, month] = current.split("-").map(Number) as [number, number];
      const next = month === 12 ? `${year + 1}-01` : `${year}-${String(month + 1).padStart(2, "0")}`;
      seedSpend(h, spendRow(h, "r-next", { goalId: "goal-1", inputTokens: 150, periodKey: next }));
      const rolled = mock.method(h.broker, "budgetPeriodKey", () => next);
      try {
        for (let index = 0; index < 2; index += 1) quiet(() => h.broker.applyGoalBudgetLimits());
      } finally {
        rolled.mock.restore();
      }
      assert.equal(h.broker.getBudgetEnforcementCounters().goals.wouldLimitTotal, 2, "counted again in the next period");
    } finally {
      h.close();
    }
  });

  for (const otherGoalBudget of [false, true]) {
    test(`[${wiring}] #2520 a goal whose goal budget left memory is resumed in on (${otherGoalBudget ? "other goal budgets remain" : "no goal budget left"}); then nothing more is read`, () => {
      const h = harness(wiring, "on");
      try {
        exhaustedGoal(h);
        if (otherGoalBudget) {
          h.broker.createGoal({ id: "goal-2", title: "Goal two", requester: OPERATOR });
          budget(h, { id: "b-goal-2", scopeType: "goal", scopeId: "goal-2", limitTokens: 1_000 });
        }
        assert.deepEqual(quiet(() => h.broker.applyGoalBudgetLimits())?.limited, ["goal-1"]);
        // The budget write did not land after all: the resync drops it from memory.
        h.sql("DELETE FROM broker_budgets WHERE id = 'b-goal'");
        h.broker.reloadBudgetFromStore("b-goal");
        assert.equal(h.broker.getBudget("b-goal"), undefined);
        assert.deepEqual(quiet(() => h.broker.applyGoalBudgetLimits())?.resumed, ["goal-1"]);
        const goal = h.broker.getGoal("goal-1")!;
        assert.equal(goal.status, "pursuing");
        assert.equal(goal.history.at(-1)?.note, "budget_available");
        const listGoals = mock.method(h.store, "listGoals");
        try {
          quiet(() => h.broker.applyGoalBudgetLimits());
          assert.equal(listGoals.mock.callCount(), 0, "the orphan pass walked every budget_limited goal: no goal list read");
        } finally {
          listGoals.mock.restore();
        }
      } finally {
        h.close();
      }
    });
  }

  for (const otherGoalBudget of [false, true]) {
    test(`[${wiring}] #2520 review: an orphan resume that fails once is retried by the next sweep (${otherGoalBudget ? "other goal budgets remain" : "no goal budget left"})`, () => {
      const h = harness(wiring, "on");
      try {
        exhaustedGoal(h);
        if (otherGoalBudget) {
          h.broker.createGoal({ id: "goal-2", title: "Goal two", requester: OPERATOR });
          budget(h, { id: "b-goal-2", scopeType: "goal", scopeId: "goal-2", limitTokens: 1_000 });
        }
        assert.deepEqual(quiet(() => h.broker.applyGoalBudgetLimits())?.limited, ["goal-1"]);
        h.sql("DELETE FROM broker_budgets WHERE id = 'b-goal'");
        h.broker.reloadBudgetFromStore("b-goal");
        const failing = mock.method(h.broker as unknown as { transitionGoalForBudget(): void }, "transitionGoalForBudget", () => {
          throw new Error("transient persist failure");
        });
        let first: { resumed: string[] } | undefined;
        try {
          first = quiet(() => h.broker.applyGoalBudgetLimits());
        } finally {
          failing.mock.restore();
        }
        assert.deepEqual(first?.resumed, [], "the resume failed");
        assert.equal(h.broker.getGoal("goal-1")?.status, "budget_limited");
        assert.deepEqual(quiet(() => h.broker.applyGoalBudgetLimits())?.resumed, ["goal-1"], "retried by the next sweep");
        assert.equal(h.broker.getGoal("goal-1")?.status, "pursuing");
        const listGoals = mock.method(h.store, "listGoals");
        try {
          quiet(() => h.broker.applyGoalBudgetLimits());
          assert.equal(listGoals.mock.callCount(), 0, "a walk without failures ends the check");
        } finally {
          listGoals.mock.restore();
        }
      } finally {
        h.close();
      }
    });
  }

  test(`[${wiring}] #2520 review: a listing that throws during a re-announce sends nothing and keeps the old revision, so the next check retries`, async () => {
    const h = harness(wiring, "on");
    try {
      exhaustedGoal(h);
      quiet(() => h.broker.createTask(taskRequest("t-1", "worker-a", { goalId: "goal-1" })));
      const stream = openAssignmentStream(h, "worker-a");
      assert.deepEqual(stream.snapshots(), [[]]);
      const filter = h.broker.filterQueuedListingForWorker.bind(h.broker);
      let throws = 1;
      const listing = mock.method(h.broker, "filterQueuedListingForWorker", ((workerId: string, items: Array<{ id: string }>) => {
        if (throws > 0) {
          throws -= 1;
          throw new Error("listing failed");
        }
        return filter(workerId, items);
      }) as typeof filter);
      try {
        h.broker.updateBudget("b-goal", { limitTokens: 10_000, actorId: "operator-1" });
        await settle();
        assert.equal(stream.snapshots().length, 1, "the listing threw: nothing sent");
        quiet(() => h.broker.createTask(taskRequest("t-other", "worker-b")));
        await settle();
        assert.deepEqual(stream.snapshots(), [[], ["t-1"]], "the next check retries (the revision was not recorded)");
      } finally {
        listing.mock.restore();
      }
      stream.close();
    } finally {
      h.close();
    }
  });

  test(`[${wiring}] #2520 review: a revision read that throws during the connect snapshot is retried once readable`, () => {
    const h = harness(wiring, "on");
    try {
      exhaustedGoal(h);
      quiet(() => h.broker.createTask(taskRequest("t-1", "worker-a", { goalId: "goal-1" })));
      const read = h.broker.getBudgetRevision.bind(h.broker);
      let throws = 1;
      const revision = mock.method(h.broker, "getBudgetRevision", () => {
        if (throws > 0) {
          throws -= 1;
          throw new Error("revision unreadable");
        }
        return read();
      });
      try {
        const stream = openAssignmentStream(h, "worker-a");
        assert.deepEqual(stream.snapshots(), [[], []], "unknown revision: the first readable check re-sends instead of never re-checking");
        stream.close();
      } finally {
        revision.mock.restore();
      }
    } finally {
      h.close();
    }
  });

  test(`[${wiring}] #2520 off after a restart resumes goals limited in on, also when their goal budget did not survive the restart`, () => {
    const h = harness(wiring, "on");
    try {
      exhaustedGoal(h);
      assert.deepEqual(quiet(() => h.broker.applyGoalBudgetLimits())?.limited, ["goal-1"]);
      h.sql("DELETE FROM broker_budgets WHERE id = 'b-goal'");
      h.reopen("off");
      assert.equal(h.broker.listBudgets()?.length, 0, "no goal budget after the restart");
      assert.deepEqual(quiet(() => h.broker.applyGoalBudgetLimits())?.resumed, ["goal-1"]);
      assert.equal(h.broker.getGoal("goal-1")?.history.at(-1)?.note, "budget_enforcement_not_on");
      const listGoals = mock.method(h.store, "listGoals");
      try {
        assert.deepEqual(h.broker.applyGoalBudgetLimits(), { limited: [], resumed: [] });
        assert.equal(listGoals.mock.callCount(), 0, "once per process start");
      } finally {
        listGoals.mock.restore();
      }
    } finally {
      h.close();
    }
  });

  test(`[${wiring}] #2520 listGoals: past the store's hard read bound the overlay over-fetch continues with keyset reads`, () => {
    const h = harness(wiring, "on");
    try {
      const total = HOT_READ_HARD_MAX_LIMIT + 2;
      const updatedAt = "2026-11-01T00:00:00.000Z";
      const row = (index: number): GoalRecord => ({
        id: `g-${String(index).padStart(6, "0")}`, title: "g", objective: "g", requester: OPERATOR, status: "pursuing",
        createdAt: updatedAt, updatedAt, taskAttachments: [], history: [],
      });
      const table = Array.from({ length: total }, (_, index) => row(index));
      const limits: number[] = [];
      const listGoals = mock.method(h.store, "listGoals", (filters: { status?: string; limit?: number; after?: { updatedAt: string; id: string } }) => {
        const limit = Math.min(filters.limit ?? 1_000, HOT_READ_HARD_MAX_LIMIT);
        limits.push(limit);
        return table
          .filter((goal) => (!filters.status || goal.status === filters.status) && (!filters.after || goal.id > filters.after.id))
          .slice(0, limit);
      });
      const overlay = h.broker["goalUpdates"] as Map<string, GoalRecord>;
      try {
        overlay.set(table[0]!.id, { ...table[0]!, status: "budget_limited" });
        const page = h.broker.listGoals({ status: "pursuing", limit: HOT_READ_HARD_MAX_LIMIT });
        assert.equal(page.length, HOT_READ_HARD_MAX_LIMIT, "not short: the clamp is read past");
        assert.equal(page.some((goal) => goal.id === table[0]!.id), false);
        assert.deepEqual(limits, [HOT_READ_HARD_MAX_LIMIT, 1]);
        limits.length = 0;
        assert.equal(h.broker.listGoals({ status: "pursuing", limit: 5 }).length, 5);
        assert.deepEqual(limits, [6], "below the bound: one read, as before");
      } finally {
        overlay.clear();
        listGoals.mock.restore();
      }
    } finally {
      h.close();
    }
  });

  test(`[${wiring}] 5i: without goal budgets the goal-limit sweep reads no enforcement metadata`, () => {
    const h = harness(wiring, "on");
    try {
      completePeriod(h);
      budget(h, { id: "b-lane", scopeType: "lane", scopeId: "analyze", limitTokens: 100 });
      const metadata = mock.method(h.store, "readSpendLedgerMetadata");
      try {
        assert.deepEqual(h.broker.applyGoalBudgetLimits(), { limited: [], resumed: [] });
        assert.equal(metadata.mock.callCount(), 0);
      } finally {
        metadata.mock.restore();
      }
    } finally {
      h.close();
    }
  });
}

test("5c: JSON-RPC race: a cancel that throws still returns the budget refusal (-32012) and logs the task id", () => {
  const h = harness("hints", "on");
  try {
    completePeriod(h);
    budget(h, { id: "b-agent", scopeType: "agent", scopeId: "default-agent", limitTokens: 10 });
    seedSpend(h, spendRow(h, "r-1", { agentId: "default-agent", inputTokens: 50 }));
    h.broker.assertClaimBudgetAllowed = () => undefined;
    h.broker.cancelTask = () => {
      throw new Error("cancel failed");
    };
    const run = captureWarnings(() => executeA2AJsonRpc(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "SendMessage",
        params: { message: { role: "ROLE_USER", parts: [{ text: "complete me" }], messageId: "tck-complete-task-cancel-fails" } },
      },
      {
        broker: h.broker,
        agentCard: createBrokerAgentCard({ serviceName: "test-broker", publicBaseUrl: "https://broker.test/" }),
        publicBaseUrl: "https://broker.test",
        requesterIdentity: null,
        enforceRequesterIdentity: false,
        defaultAgentNodeId: "default-agent",
        responseShape: "spec",
      },
    ));
    const error = rpcError(run.result);
    assert.equal(error.code, -32012, "the budget refusal, not the cancel error");
    const metadata = error.data?.[0]?.metadata ?? {};
    assert.equal(metadata.budgetReason, "budget_exhausted");
    assert.match(error.message, /canceling the task failed \(status queued\)/);
    assert.equal(h.broker.getTask(metadata.taskId!)?.status, "queued");
    assert.deepEqual(named(run.events, "broker.budget.convention_cancel_failed"), [
      { event: "broker.budget.convention_cancel_failed", taskId: metadata.taskId, taskStatus: "queued" },
    ]);
  } finally {
    h.close();
  }
});

test("5d: the JSON-RPC pre-check decides on the same request the create uses (one builder)", () => {
  const h = harness("hints", "on");
  try {
    const prechecked: CreateTaskRequest[] = [];
    const created: CreateTaskRequest[] = [];
    const precheck = h.broker.assertCreateBudgetAllowed.bind(h.broker);
    h.broker.assertCreateBudgetAllowed = (request) => {
      prechecked.push(structuredClone(request));
      precheck(request);
    };
    const create = h.broker.createTask.bind(h.broker);
    h.broker.createTask = (request) => {
      created.push(structuredClone(request));
      return create(request);
    };
    rpcResult(sendConvention(h, "plain-shape-1"));
    assert.equal(prechecked.length, 1);
    assert.equal(created.length, 1);
    const { exchangeId, ...rest } = created[0]!;
    assert.ok(exchangeId, "only the exchange id (created after the check) differs");
    assert.deepEqual(prechecked[0], rest);
  } finally {
    h.close();
  }
});

test("#2520 5c: a status read that throws after a failed cancel does not replace the refusal either", () => {
  const h = harness("hints", "on");
  try {
    completePeriod(h);
    budget(h, { id: "b-agent", scopeType: "agent", scopeId: "default-agent", limitTokens: 10 });
    seedSpend(h, spendRow(h, "r-1", { agentId: "default-agent", inputTokens: 50 }));
    h.broker.assertClaimBudgetAllowed = () => undefined;
    let failReads = false;
    h.broker.cancelTask = () => {
      failReads = true;
      throw new Error("cancel failed");
    };
    const getTask = h.broker.getTask.bind(h.broker);
    h.broker.getTask = (taskId: string) => {
      if (failReads) throw new Error("read failed");
      return getTask(taskId);
    };
    const run = captureWarnings(() => executeA2AJsonRpc(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "SendMessage",
        params: { message: { role: "ROLE_USER", parts: [{ text: "complete me" }], messageId: "tck-complete-task-read-fails" } },
      },
      {
        broker: h.broker,
        agentCard: createBrokerAgentCard({ serviceName: "test-broker", publicBaseUrl: "https://broker.test/" }),
        publicBaseUrl: "https://broker.test",
        requesterIdentity: null,
        enforceRequesterIdentity: false,
        defaultAgentNodeId: "default-agent",
        responseShape: "spec",
      },
    ));
    failReads = false;
    const error = rpcError(run.result);
    assert.equal(error.code, -32012, "the budget refusal, not the read error");
    assert.match(error.message, /canceling the task failed \(status unknown\)/);
    const metadata = error.data?.[0]?.metadata ?? {};
    assert.equal(metadata.budgetReason, "budget_exhausted");
    assert.deepEqual(named(run.events, "broker.budget.convention_cancel_failed"), [
      { event: "broker.budget.convention_cancel_failed", taskId: metadata.taskId, taskStatus: "unknown" },
    ]);
    assert.equal(h.broker.getTask(metadata.taskId!)?.status, "queued", "left queued (documented); named in the error data");
  } finally {
    h.close();
  }
});

test("#2520 5d: the claim pre-check takes the request the create uses, normalized as createTask does", () => {
  const h = harness("hints", "on");
  try {
    completePeriod(h);
    const prechecked: CreateTaskRequest[] = [];
    const created: CreateTaskRequest[] = [];
    const precheck = h.broker.assertClaimBudgetAllowed.bind(h.broker);
    h.broker.assertClaimBudgetAllowed = (request) => {
      prechecked.push(structuredClone(request));
      precheck(request);
    };
    const create = h.broker.createTask.bind(h.broker);
    h.broker.createTask = (request) => {
      created.push(structuredClone(request));
      return create(request);
    };
    rpcResult(sendConvention(h, "tck-complete-task-same-request"));
    assert.equal(prechecked.length, 1);
    const { exchangeId, ...rest } = created[0]!;
    assert.ok(exchangeId);
    assert.deepEqual(prechecked[0], rest, "the same request (only the exchange id differs)");
    // The goal scope comes from the normalized request: a normalization that
    // links a goal makes the pre-check read that goal's budget.
    h.broker.createGoal({ id: "goal-1", title: "Goal one", requester: OPERATOR });
    budget(h, { id: "b-goal", scopeType: "goal", scopeId: "goal-1", limitTokens: 10 });
    seedSpend(h, spendRow(h, "r-g", { goalId: "goal-1", inputTokens: 50 }));
    const normalize = (h.broker as unknown as { normalizeCreateTaskRequest(request: CreateTaskRequest): { request: CreateTaskRequest } })
      .normalizeCreateTaskRequest.bind(h.broker);
    const linked = mock.method(h.broker as unknown as { normalizeCreateTaskRequest: typeof normalize }, "normalizeCreateTaskRequest", (request: CreateTaskRequest) => {
      const result = normalize(request);
      return { ...result, request: { ...result.request, goalId: "goal-1" } };
    });
    try {
      const tasksBefore = h.broker.listTasks().length;
      const error = rpcError(sendConvention(h, "tck-complete-task-goal-linked"));
      assert.equal(error.code, -32012);
      assert.equal(error.data?.[0]?.metadata?.budgetReason, "budget_exhausted");
      assert.equal(h.broker.listTasks().length, tasksBefore, "refused by the pre-check: nothing created");
    } finally {
      linked.mock.restore();
    }
  } finally {
    h.close();
  }
});

test("#2520 JSON-RPC inline claim: claim errors other than a budget refusal pass through unchanged (no cancel)", () => {
  for (const thrown of [
    new BrokerError("invalid_transition", "task is not claimable"),
    new BrokerError("policy_denied", "worker class denied", { reason: "worker_class_denied" }),
  ]) {
    const h = harness("hints", "on");
    try {
      let canceled = 0;
      h.broker.cancelTask = () => {
        canceled += 1;
        throw new Error("must not cancel");
      };
      h.broker.claimTask = () => {
        throw thrown;
      };
      const error = rpcError(sendConvention(h, `tck-complete-task-${thrown.code}`));
      assert.equal(error.message, thrown.message, "the claim error's message, unchanged");
      const metadata = error.data?.[0]?.metadata ?? {};
      assert.equal(metadata.brokerCode, thrown.code);
      assert.equal(metadata.budgetReason, undefined);
      assert.equal(metadata.taskId, undefined, "not decorated with the task id");
      assert.equal(canceled, 0);
    } finally {
      h.close();
    }
  }
});

function rpcResult(response: unknown): unknown {
  assert.ok(response && typeof response === "object" && "result" in response, `expected a result, got ${JSON.stringify(response)}`);
  return (response as { result: unknown }).result;
}

test("5e (worker-thread): a restaged task is settled on its queued write's ack; a failed queued write leaves it for the next pass", async () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-restage-wt-"));
  const dbFile = join(dir, "state.sqlite");
  const exec = (sql: string) => {
    const db = new DatabaseSync(dbFile);
    try {
      db.exec(sql);
    } finally {
      db.close();
    }
  };
  const handle = createWorkerThreadPersistence({ dbFile, loadSource: "hot-tables", queueCapacity: 256 });
  const originalError = console.error;
  try {
    const proxy = handle.stateStore;
    const broker = quiet(() => new InMemoryA2ABroker(proxy, proxy.load(), { budgetPeriodTimeZone: "UTC" }));
    broker.registerWorker({
      nodeId: "worker-a",
      role: "analyst",
      capabilities: { canAnalyze: true, canBackfill: false, canPatchWorkspace: false, canPromoteLive: false, workspaceIds: ["default"], environments: ["research"] },
    });
    broker.createTask(taskRequest("t-lost", "worker-a"));
    broker.claimTask("t-lost", "worker-a");
    broker.startTask("t-lost", "worker-a");
    quiet(() => broker.cancelTask("t-lost", { actor: OPERATOR }));
    await proxy.awaitDurablePersistenceAck();
    exec(`CREATE TRIGGER meter_fail BEFORE UPDATE ON broker_spend_events
          WHEN OLD.task_id = 't-lost' BEGIN SELECT RAISE(ABORT, 'metering write failed'); END`);
    quiet(() => broker.completeTask("t-lost", "worker-a", { summary: "late", output: TELEMETRY }));
    console.error = () => {};
    await assert.rejects(() => proxy.awaitDurablePersistenceAck(), /metering write failed/);
    const settled = broker["lateMeteringSettled"] as Set<string>;
    const inFlight = broker["lateMeteringInFlight"] as Set<string>;
    const attempts = broker["lateMeteringAttempts"] as Map<string, number>;
    assert.deepEqual(quiet(() => broker.restageLostLateMeterings()), { restaged: 1, checked: 1 });
    assert.ok(inFlight.has("t-lost"), "waiting for the queued write");
    assert.equal(settled.has("t-lost"), false);
    assert.deepEqual(quiet(() => broker.restageLostLateMeterings()), { restaged: 0, checked: 0 }, "an in-flight task is not restaged twice");
    await assert.rejects(() => proxy.awaitDurablePersistenceAck(), /metering write failed/);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(inFlight.has("t-lost"), false);
    assert.equal(settled.has("t-lost"), false, "a failed queued write leaves it for the next pass");
    assert.equal(attempts.get("t-lost"), 1);
    exec("DROP TRIGGER meter_fail");
    assert.deepEqual(quiet(() => broker.restageLostLateMeterings()), { restaged: 1, checked: 1 });
    await proxy.awaitDurablePersistenceAck();
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(settled.has("t-lost"), "settled on the ack");
    assert.equal(proxy.latestQueuedWrite(), undefined, "5f: a settled write is no longer the latest queued write");
    const db = new DatabaseSync(dbFile);
    try {
      assert.deepEqual(db.prepare("SELECT input_tokens, cost_known FROM broker_spend_events WHERE task_id = 't-lost'").all().map((row) => ({ ...row })), [
        { input_tokens: 11, cost_known: 1 },
      ]);
    } finally {
      db.close();
    }
  } finally {
    console.error = originalError;
    await handle.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("5j (worker-thread): gen1 lands, gen2 fails: gen2's audit event goes, gen1's stays, memory follows the stored row (gen1)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-budget-gen2-"));
  const dbFile = join(dir, "state.sqlite");
  const exec = (sql: string) => {
    const db = new DatabaseSync(dbFile);
    try {
      db.exec(sql);
    } finally {
      db.close();
    }
  };
  const handle = createWorkerThreadPersistence({ dbFile, loadSource: "hot-tables", queueCapacity: 256 });
  const originalError = console.error;
  try {
    const proxy = handle.stateStore;
    const broker = quiet(() => new InMemoryA2ABroker(proxy, proxy.load(), { budgetPeriodTimeZone: "UTC" }));
    broker.createBudget({ id: "b-1", scopeType: "lane", scopeId: "analyze", period: "month", limitUsd: 1, createdBy: "o" });
    await proxy.awaitDurablePersistenceAck();
    assert.equal(proxy.latestQueuedWrite(), undefined, "5f: cleared once the write settled");
    exec(`CREATE TRIGGER gen2_fail BEFORE UPDATE ON broker_budgets
          WHEN NEW.limit_usd = 9 BEGIN SELECT RAISE(ABORT, 'budget write failed'); END`);
    broker.updateBudget("b-1", { limitUsd: 7, actorId: "o" });
    const gen1 = broker.getBudgetWriteGeneration("b-1")!;
    broker.updateBudget("b-1", { limitUsd: 9, actorId: "o" });
    const gen2 = broker.getBudgetWriteGeneration("b-1")!;
    assert.ok(gen2 > gen1);
    console.error = () => {};
    await assert.rejects(() => proxy.awaitDurablePersistenceAck(), /budget write failed/);
    console.error = originalError;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(broker.getBudgetWriteGeneration("b-1"), gen2, "gen1 settled on its ack; the failed gen2 stays for the route's resync");
    broker.reloadBudgetFromStore("b-1", gen2);
    assert.equal(broker.getBudgetWriteGeneration("b-1"), undefined);
    assert.equal(broker.getBudget("b-1")?.limitUsd, 7, "memory follows the stored row (gen1 landed)");
    assert.deepEqual(
      broker.listAuditEvents({ action: "budget.updated" }).map((event) => event.note),
      ["limitUsd"],
      "gen1's audit event stays, gen2's is gone",
    );
    assert.equal(proxy.latestQueuedWrite(), undefined);
  } finally {
    console.error = originalError;
    await handle.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- #2520: worker-thread insert races ------------------------------------------------------

test("#2520 (worker-thread): a budget insert that races another writer's row for the same scope fails its queued write; the resync drops it, and a goal it limited is resumed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-budget-race-"));
  const dbFile = join(dir, "state.sqlite");
  const exec = (sql: string) => {
    const db = new DatabaseSync(dbFile);
    try {
      db.exec(sql);
    } finally {
      db.close();
    }
  };
  const handle = createWorkerThreadPersistence({ dbFile, loadSource: "hot-tables", queueCapacity: 256 });
  const originalError = console.error;
  try {
    const proxy = handle.stateStore;
    const broker = quiet(() => new InMemoryA2ABroker(proxy, proxy.load(), { budgetPeriodTimeZone: "UTC", budgetEnforcementMode: "on" }));
    broker.createGoal({ id: "goal-1", title: "Goal one", requester: OPERATOR });
    await proxy.awaitDurablePersistenceAck();
    // Another writer inserted a budget for the same scope after this broker loaded its budgets.
    exec(`INSERT INTO broker_budgets (id, scope_type, scope_id, period, limit_usd, limit_tokens, warn_pct, enforce, created_by, created_at)
          VALUES ('b-other', 'goal', 'goal-1', 'month', NULL, 1000000, 80, 'refuse', 'other', '2026-11-01T00:00:00.000Z')`);
    broker.createBudget({ id: "b-goal", scopeType: "goal", scopeId: "goal-1", period: "month", limitTokens: 10, createdBy: "o" });
    const generation = broker.getBudgetWriteGeneration("b-goal");
    assert.ok(generation !== undefined, "queued");
    proxy.saveHotEntities({
      spendEvents: [{
        taskId: "r-g", recordedAt: new Date().toISOString(), periodKey: broker.budgetPeriodKey(), agentId: "worker-a",
        lane: "analyze", goalId: "goal-1", costUsd: 0, inputTokens: 50, outputTokens: 0, costKnown: false,
      }],
    });
    console.error = () => {};
    await assert.rejects(() => proxy.awaitDurablePersistenceAck(), /UNIQUE/);
    console.error = originalError;
    await new Promise((resolve) => setImmediate(resolve));
    exec("UPDATE broker_metadata SET value = '2000-01' WHERE key = 'spend_ledger_first_period'");
    // Until the route resyncs, the in-memory budget limits the goal.
    assert.deepEqual(quiet(() => broker.applyGoalBudgetLimits())?.limited, ["goal-1"]);
    await proxy.awaitDurablePersistenceAck();
    broker.reloadBudgetFromStore("b-goal", generation);
    assert.equal(broker.getBudget("b-goal"), undefined, "the write did not land: dropped from memory");
    assert.deepEqual(broker.listAuditEvents({ action: "budget.created" }), [], "and its audit event");
    assert.deepEqual(quiet(() => broker.applyGoalBudgetLimits())?.resumed, ["goal-1"], "the goal it limited is not left budget_limited");
    await proxy.awaitDurablePersistenceAck();
    assert.equal(broker.getGoal("goal-1")?.status, "pursuing");
  } finally {
    console.error = originalError;
    await handle.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#2520 (worker-thread): a goal insert that races a row written after the duplicate check is a 409 with no audit event and no change", async () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-goal-race-"));
  const dbFile = join(dir, "state.sqlite");
  const handle = createWorkerThreadPersistence({ dbFile, loadSource: "hot-tables", queueCapacity: 256 });
  try {
    const proxy = handle.stateStore;
    const broker = quiet(() => new InMemoryA2ABroker(proxy, proxy.load(), { budgetPeriodTimeZone: "UTC", budgetEnforcementMode: "on" }));
    broker.createGoal({ id: "g-race", title: "first", requester: OPERATOR });
    await proxy.awaitDurablePersistenceAck();
    // The duplicate check misses the row (it lands between the check and the insert).
    const readGoal = mock.method(proxy as unknown as { readGoal(id: string): GoalRecord | undefined }, "readGoal", () => undefined);
    let error: unknown;
    try {
      broker.createGoal({ id: "g-race", title: "second", requester: OPERATOR });
    } catch (caught) {
      error = caught;
    } finally {
      readGoal.mock.restore();
    }
    assert.ok(error instanceof BrokerError, `expected a BrokerError, got ${String(error)}`);
    assert.equal(error.code, "invalid_transition");
    await proxy.awaitDurablePersistenceAck();
    assert.equal(broker.getGoal("g-race")?.title, "first", "the stored row is unchanged");
    assert.equal(broker.listAuditEvents({ action: "goal.created" }).length, 1, "no audit event for the losing insert");
  } finally {
    await handle.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
