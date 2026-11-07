/**
 * Budgets and the budget evaluator (#2499 slice 3b-1, docs/specs/goal-budget).
 *
 * - Store: insert / update / get / list / lookup by scope; one budget per
 *   (scope_type, scope_id, period) by pre-check and by the unique index
 *   (which a v14 store created before slice 3b gains on its next start); the
 *   at-least-one-limit CHECK; both in-process wirings and the real
 *   worker-thread persistence queue; audit events and their rollback.
 * - Enforcement mode: default off, invalid value, non-off without a spend
 *   ledger, `on` as `shadow` while the period is incomplete (decision 9).
 * - Evaluator: Decision 4 (unknown-cost runtimes are never refused by a USD
 *   limit), tokens = input + output refuse any worker, warn threshold,
 *   `pause` budgets never refuse at claim, fail-open check failures with a
 *   counter and a rate-limited log line (decision 13).
 * - Slice 3a review carry-overs: recordedAt fallthrough (6a), periodic
 *   reconcile page skip and rate-limited reconcile_failed (6b), diagnostics
 *   after the page write and the reconciled late malformed (6c), passEnded
 *   and the pass accumulator across a throw (6d), near-cap lines (6e).
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { mock } from "node:test";

import { BrokerError, InMemoryA2ABroker, type InMemoryA2ABrokerOptions } from "./broker.js";
import { buildTaskSpendEvent } from "./completion/broker-task-terminal.js";
import {
  decideClaimBudgetScope,
  evaluateBudgetUsage,
  resolveEffectiveBudgetEnforcement,
} from "./dispatch/broker-task-admission.js";
import { selectRetainedAuditEventIds } from "./broker-retention-selectors.js";
import { resolveBudgetEnforcementMode } from "./store-schemas.js";
import { planAuditRetentionFromRecords } from "./store/store-hot-retention-planning.js";
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
import { createWorkerThreadPersistence } from "./store/sqlite-worker-thread-persistence.js";
import type { BudgetRecord, CreateTaskRequest, SpendEventRecord, TaskRecord } from "./types.js";

const OPERATOR = { id: "operator-1", kind: "user" as const, role: "operator" as const };
const TELEMETRY_SCHEMA = "a2a.analysis-execution-telemetry.v1";

function telemetry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { schemaVersion: TELEMETRY_SCHEMA, inputTokens: 10, outputTokens: 5, costUsd: 0.1, ...overrides };
}

function taskRequest(id: string, overrides: Partial<CreateTaskRequest> = {}): CreateTaskRequest {
  return {
    id,
    intent: "analyze",
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    assignedWorkerId: "worker-a",
    message: `task ${id}`,
    payload: {},
    ...overrides,
  };
}

function registerWorkers(broker: InMemoryA2ABroker, ...ids: string[]): void {
  for (const nodeId of ids) {
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
}

function runToRunning(broker: InMemoryA2ABroker, request: CreateTaskRequest, workerId = "worker-a"): void {
  broker.createTask(request);
  broker.claimTask(request.id!, workerId);
  broker.startTask(request.id!, workerId);
}

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

type Wiring = "hints" | "repositories";

interface Harness {
  broker: InMemoryA2ABroker;
  store: SqliteBrokerStateStore;
  dbFile: string;
  sql(statement: string, ...params: Array<string | number | null>): void;
  query<T>(statement: string, ...params: Array<string | number | null>): T[];
  reopen(options?: HarnessOptions): Array<Record<string, unknown>>;
  close(): void;
}

type HarnessOptions = Pick<InMemoryA2ABrokerOptions, "budgetEnforcementMode" | "budgetPeriodTimeZone" | "retention">;

function harness(wiring: Wiring = "hints", options: HarnessOptions = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), "a2a-budget-"));
  const dbFile = join(dir, "state.sqlite");
  const open = (opts: typeof options) => {
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
    const broker = new InMemoryA2ABroker(store, store.load(), { budgetPeriodTimeZone: "UTC", ...repositories, ...opts });
    return { store, broker };
  };
  let current = open(options);
  registerWorkers(current.broker, "worker-a", "worker-b");
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
    reopen(opts = options) {
      current.store.close();
      return captureWarnings(() => {
        current = open(opts);
      }).events;
    },
    close() {
      current.store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function spendRow(taskId: string, overrides: Partial<SpendEventRecord> = {}): SpendEventRecord {
  return {
    taskId,
    recordedAt: "2026-11-06T00:00:00.000Z",
    periodKey: "2026-11",
    agentId: "worker-a",
    lane: "analyze",
    goalId: null,
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    costKnown: false,
    ...overrides,
  };
}

function rejectsWith(code: BrokerError["code"], pattern?: RegExp) {
  return (error: unknown) => error instanceof BrokerError && error.code === code && (!pattern || pattern.test(error.message));
}

// --- Store ----------------------------------------------------------------------

for (const wiring of ["hints", "repositories"] as const) {
  test(`[${wiring}] budgets: create, get, list, update; audit events; one budget per scope and period`, () => {
    const h = harness(wiring);
    try {
      const created = h.broker.createBudget({
        id: "b-lane",
        scopeType: "lane",
        scopeId: "analyze",
        period: "month",
        limitUsd: 25,
        createdBy: "operator-1",
      });
      assert.deepEqual({ ...created, createdAt: "x" }, {
        id: "b-lane",
        scopeType: "lane",
        scopeId: "analyze",
        period: "month",
        limitUsd: 25,
        limitTokens: null,
        warnPct: 80,
        enforce: "refuse",
        createdBy: "operator-1",
        createdAt: "x",
      });
      const generated = h.broker.createBudget({ scopeType: "agent", scopeId: "worker-a", period: "month", limitTokens: 1_000, createdBy: "operator-1" });
      assert.match(generated.id, /^[0-9a-f-]{36}$/, "an id is generated when absent");
      assert.deepEqual(h.broker.getBudget("b-lane"), created);
      assert.deepEqual(h.broker.findBudgetForScope("lane", "analyze"), created);
      assert.deepEqual(h.store.readBudget("b-lane"), created, "row and memory agree");
      assert.deepEqual(h.broker.listBudgets()?.map((budget) => budget.id), [generated.id, "b-lane"], "ordered by scope type, scope id");
      assert.deepEqual(h.broker.listBudgets({ scopeType: "lane" })?.map((budget) => budget.id), ["b-lane"]);
      assert.deepEqual(h.broker.listBudgets({ scopeType: "agent", scopeId: "worker-b" }), []);
      assert.equal(h.broker.listBudgets({ limit: 1 })?.length, 1);

      // Duplicate id and duplicate scope: 409 (invalid_transition) naming the conflict.
      assert.throws(
        () => h.broker.createBudget({ id: "b-lane", scopeType: "lane", scopeId: "chat", period: "month", limitUsd: 1, createdBy: "operator-1" }),
        rejectsWith("invalid_transition", /budget 'b-lane' already exists/),
      );
      assert.throws(
        () => h.broker.createBudget({ id: "b-lane-2", scopeType: "lane", scopeId: "analyze", period: "month", limitUsd: 1, createdBy: "operator-1" }),
        (error: unknown) => error instanceof BrokerError && error.code === "invalid_transition" && error.details?.budgetId === "b-lane",
      );

      const updated = h.broker.updateBudget("b-lane", { limitTokens: 500, warnPct: 50, enforce: "pause", actorId: "operator-2" });
      assert.equal(updated.limitTokens, 500);
      assert.equal(updated.limitUsd, 25, "an omitted field is unchanged");
      const cleared = h.broker.updateBudget("b-lane", { limitUsd: null, actorId: "operator-2" });
      assert.equal(cleared.limitUsd, null);
      assert.deepEqual(h.broker.getBudget("b-lane"), cleared, "the update is persisted");
      assert.throws(
        () => h.broker.updateBudget("b-lane", { limitTokens: null, actorId: "operator-2" }),
        rejectsWith("bad_request", /at least one/),
      );
      assert.throws(() => h.broker.updateBudget("b-missing", { warnPct: 10, actorId: "o" }), rejectsWith("not_found"));
      assert.throws(() => h.broker.updateBudget("b-lane", { actorId: "o" }), rejectsWith("bad_request", /changes nothing/));
      assert.equal(h.broker.getBudget("b-lane")?.createdBy, "operator-1", "the creator never changes");

      const audits = h.broker.listAuditEvents().filter((event) => event.targetType === "budget");
      assert.deepEqual(
        audits.map((event) => `${event.action}:${event.targetId}:${event.actorId}:${event.note}`).sort(),
        [
          `budget.created:${generated.id}:operator-1:agent:worker-a`,
          "budget.created:b-lane:operator-1:lane:analyze",
          "budget.updated:b-lane:operator-2:limitTokens,warnPct,enforce",
          "budget.updated:b-lane:operator-2:limitUsd",
        ].sort(),
      );
      // A restart reads the same rows and the persisted audit trail.
      h.reopen();
      assert.deepEqual(h.broker.getBudget("b-lane"), cleared);
      assert.equal(h.query<{ n: number }>("SELECT COUNT(*) AS n FROM broker_audit_events WHERE target_type = 'budget'")[0]?.n, 4);
    } finally {
      h.close();
    }
  });

  test(`[${wiring}] a failed save rolls back the budget row and its in-memory audit event`, () => {
    const h = harness(wiring);
    try {
      h.sql(`CREATE TRIGGER audit_fail BEFORE INSERT ON broker_audit_events
             WHEN NEW.action = 'budget.created' BEGIN SELECT RAISE(ABORT, 'audit write failed'); END`);
      assert.throws(
        () => h.broker.createBudget({ id: "b-flaky", scopeType: "lane", scopeId: "chat", period: "month", limitUsd: 1, createdBy: "o" }),
        /audit write failed/,
      );
      assert.equal(h.broker.getBudget("b-flaky"), undefined, "the row rolled back with the batch");
      assert.deepEqual(h.broker.listAuditEvents({ action: "budget.created" }), []);
      assert.equal(h.store.readBudget("b-flaky"), undefined);
      h.sql("DROP TRIGGER audit_fail");

      // The other way round: the budget row fails, so its audit row does not commit either.
      h.sql(`CREATE TRIGGER budget_fail BEFORE INSERT ON broker_budgets
             BEGIN SELECT RAISE(ABORT, 'budget write failed'); END`);
      assert.throws(
        () => h.broker.createBudget({ id: "b-flaky", scopeType: "lane", scopeId: "chat", period: "month", limitUsd: 1, createdBy: "o" }),
        /budget write failed/,
      );
      assert.equal(h.broker.getBudget("b-flaky"), undefined, "the map entry is rolled back");
      assert.deepEqual(h.broker.listAuditEvents({ action: "budget.created" }), []);
      assert.equal(h.query("SELECT id FROM broker_audit_events WHERE target_type = 'budget'").length, 0, "no audit row without its budget row");
      h.sql("DROP TRIGGER budget_fail");

      h.broker.createBudget({ id: "b-flaky", scopeType: "lane", scopeId: "chat", period: "month", limitUsd: 1, createdBy: "o" });
      assert.equal(h.broker.listAuditEvents({ action: "budget.created" }).length, 1, "a retry is not a false 409");

      // A failed update restores the previous record in memory and leaves the row unchanged.
      h.sql(`CREATE TRIGGER budget_update_fail BEFORE UPDATE ON broker_budgets
             BEGIN SELECT RAISE(ABORT, 'budget update failed'); END`);
      assert.throws(() => h.broker.updateBudget("b-flaky", { limitUsd: 9, actorId: "o" }), /budget update failed/);
      assert.equal(h.broker.getBudget("b-flaky")?.limitUsd, 1);
      assert.equal(h.store.readBudget("b-flaky")?.limitUsd, 1);
      assert.deepEqual(h.broker.listAuditEvents({ action: "budget.updated" }), []);
      assert.equal(h.query("SELECT id FROM broker_audit_events WHERE action = 'budget.updated'").length, 0);
      h.sql("DROP TRIGGER budget_update_fail");

      // One commit per budget write, row and audit together.
      const before = h.store.commits;
      h.broker.updateBudget("b-flaky", { limitUsd: 2, actorId: "o" });
      assert.equal(h.store.commits - before, 1, "row + audit + persist = one commit");
    } finally {
      h.close();
    }
  });
}

test("store: validation (400), the at-least-one-limit CHECK, and the unique scope index", () => {
  const h = harness();
  try {
    const base = { scopeType: "lane" as const, scopeId: "analyze", period: "month" as const, createdBy: "o" };
    const bad: Array<[Record<string, unknown>, RegExp]> = [
      [{ ...base }, /limitUsd, limitTokens, or both/],
      [{ ...base, limitUsd: null, limitTokens: null }, /limitUsd, limitTokens, or both/],
      [{ ...base, limitUsd: 0 }, /limitUsd/],
      [{ ...base, limitUsd: -1 }, /limitUsd/],
      [{ ...base, limitUsd: 1e9 + 1 }, /limitUsd/],
      [{ ...base, limitUsd: Number.POSITIVE_INFINITY }, /limitUsd/],
      [{ ...base, limitUsd: "5" }, /limitUsd/],
      [{ ...base, limitTokens: 1.5 }, /limitTokens/],
      [{ ...base, limitTokens: Number.MAX_SAFE_INTEGER + 1 }, /limitTokens/],
      [{ ...base, limitTokens: 0 }, /limitTokens/],
      [{ ...base, limitUsd: 1, warnPct: 0 }, /warnPct/],
      [{ ...base, limitUsd: 1, warnPct: 101 }, /warnPct/],
      [{ ...base, limitUsd: 1, warnPct: 50.5 }, /warnPct/],
      [{ ...base, limitUsd: 1, enforce: "block" }, /enforce/],
      [{ ...base, limitUsd: 1, period: "week" }, /period/],
      [{ ...base, limitUsd: 1, scopeType: "team" }, /scopeType/],
      [{ ...base, limitUsd: 1, scopeId: "a".repeat(257) }, /scopeId must match/],
      [{ ...base, limitUsd: 1, scopeId: "" }, /scopeId must match/],
      [{ ...base, limitUsd: 1, scopeId: "lane\u0001x" }, /scopeId must match/],
      [{ ...base, limitUsd: 1, scopeType: "goal", scopeId: "goal 1" }, /scopeId must match/],
      [{ ...base, limitUsd: 1, scopeType: "goal", scopeId: "a".repeat(129) }, /scopeId must match/],
      [{ ...base, limitUsd: 1, id: "b 1" }, /budget id must match/],
      [{ ...base, limitUsd: 1, id: "b-1 " }, /budget id must match/],
      // m10: every identifier and enum field must be a string.
      [{ ...base, limitUsd: 1, id: 123 }, /budget id must match/],
      [{ ...base, limitUsd: 1, id: ["x"] }, /budget id must match/],
      [{ ...base, limitUsd: 1, scopeId: 123 }, /scopeId must match/],
      [{ ...base, limitUsd: 1, scopeId: ["analyze"] }, /scopeId must match/],
      [{ ...base, limitUsd: 1, scopeType: 123 }, /scopeType/],
      [{ ...base, limitUsd: 1, scopeType: ["lane"] }, /scopeType/],
      [{ ...base, limitUsd: 1, period: 123 }, /period/],
      [{ ...base, limitUsd: 1, period: ["month"] }, /period/],
      [{ ...base, limitUsd: 1, enforce: 123 }, /enforce/],
      [{ ...base, limitUsd: 1, enforce: ["refuse"] }, /enforce/],
    ];
    for (const [request, pattern] of bad) {
      assert.throws(
        () => h.broker.createBudget(request as unknown as Parameters<InMemoryA2ABroker["createBudget"]>[0]),
        rejectsWith("bad_request", pattern),
        JSON.stringify(request),
      );
    }
    assert.equal(h.broker.createBudget({ ...base, limitTokens: Number.MAX_SAFE_INTEGER }).limitTokens, Number.MAX_SAFE_INTEGER);
    // m7: agent and lane scope ids use the ledger's pattern (up to 256, any non-control character).
    assert.equal(h.broker.createBudget({ ...base, scopeId: "l".repeat(129), limitUsd: 1 }).scopeId.length, 129);
    assert.equal(h.broker.createBudget({ ...base, scopeType: "agent", scopeId: "worker/a@host", limitUsd: 1 }).scopeId, "worker/a@host");
    assert.equal(h.broker.createBudget({ ...base, scopeType: "agent", scopeId: " padded ", limitUsd: 1 }).scopeId, " padded ", "never trimmed");
    assert.throws(
      () => h.broker.createBudget({ ...base, scopeType: "goal", scopeId: "goal-missing", limitUsd: 1 }),
      rejectsWith("not_found", /goal not found/),
    );
    h.broker.createGoal({ id: "goal-1", title: "G", requester: OPERATOR });
    assert.equal(h.broker.createBudget({ ...base, scopeType: "goal", scopeId: "goal-1", limitUsd: 1 }).scopeId, "goal-1");

    // The table CHECK and the unique index back the broker checks.
    const row = (id: string, usd: number | null, tokens: number | null) =>
      `INSERT INTO broker_budgets (id, scope_type, scope_id, period, limit_usd, limit_tokens, created_by, created_at)
       VALUES ('${id}', 'agent', 'worker-z', 'month', ${usd ?? "NULL"}, ${tokens ?? "NULL"}, 'o', '2026-11-01T00:00:00.000Z')`;
    assert.throws(() => h.sql(row("raw-none", null, null)), /CHECK constraint failed/);
    h.sql(row("raw-1", 1, null));
    assert.throws(() => h.sql(row("raw-2", 2, null)), /UNIQUE constraint failed/);
    const indexes = h.query<{ name: string; unique: number }>("PRAGMA index_list('broker_budgets')");
    assert.ok(indexes.some((index) => index.name === "broker_budgets_scope_unique_idx" && Number(index.unique) === 1));
  } finally {
    h.close();
  }
});

test("store: a v14 store created before slice 3b (no unique index) gains it on the next start", () => {
  const h = harness();
  try {
    h.sql("DROP INDEX broker_budgets_scope_unique_idx");
    assert.equal(h.query("SELECT name FROM sqlite_master WHERE name = 'broker_budgets_scope_unique_idx'").length, 0);
    h.reopen();
    assert.equal(h.query("SELECT name FROM sqlite_master WHERE name = 'broker_budgets_scope_unique_idx'").length, 1);
    assert.equal(h.query<{ value: string }>("SELECT value FROM broker_metadata WHERE key = 'schema_version'")[0]?.value, "14", "no version bump");
  } finally {
    h.close();
  }
});

test("stores without SQLite: budget writes are unsupported_operation (409), reads report no budgets", () => {
  const broker = new InMemoryA2ABroker();
  assert.equal(broker.hasBudgets(), false);
  assert.throws(
    () => broker.createBudget({ scopeType: "lane", scopeId: "chat", period: "month", limitUsd: 1, createdBy: "o" }),
    rejectsWith("unsupported_operation", /SQLite/),
  );
  assert.throws(() => broker.updateBudget("b-1", { warnPct: 10, actorId: "o" }), rejectsWith("unsupported_operation"));
  assert.equal(broker.listBudgets(), undefined);
  assert.equal(broker.getBudget("b-1"), undefined);
  const claim = captureWarnings(() => broker.evaluateClaimBudget({ lane: "chat", workerId: "worker-a" }));
  assert.deepEqual(
    (({ checkFailed, refuse, scopes }) => ({ checkFailed, refuse, scopes }))(claim.result),
    { checkFailed: false, refuse: false, scopes: [] },
    "no budget table: nothing to check, not a check failure",
  );
  assert.deepEqual(broker.getBudgetCheckFailures(), { count: 0, lastAt: null });
});

test("real worker-thread persistence: row and audit ride one queued write; the map is the duplicate check; a failed write leaves neither", async () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-budget-worker-thread-"));
  const dbFile = join(dir, "state.sqlite");
  const read = <T>(sql: string): T[] => {
    const db = new DatabaseSync(dbFile);
    try {
      return db.prepare(sql).all().map((row) => ({ ...row })) as T[];
    } finally {
      db.close();
    }
  };
  const exec = (sql: string) => {
    const db = new DatabaseSync(dbFile);
    try {
      db.exec(sql);
    } finally {
      db.close();
    }
  };
  let handle = createWorkerThreadPersistence({ dbFile, loadSource: "hot-tables", queueCapacity: 256 });
  try {
    let proxy = handle.stateStore;
    let broker = new InMemoryA2ABroker(proxy, proxy.load(), { budgetPeriodTimeZone: "UTC" });
    assert.equal(broker.hasBudgets(), true, "the proxy store keeps the budget capability");
    broker.createBudget({ id: "wt-1", scopeType: "lane", scopeId: "analyze", period: "month", limitUsd: 3, createdBy: "o" });
    // Quick succession, before the queue flushes: the in-memory map refuses the duplicate scope.
    assert.throws(
      () => broker.createBudget({ id: "wt-2", scopeType: "lane", scopeId: "analyze", period: "month", limitUsd: 3, createdBy: "o" }),
      rejectsWith("invalid_transition", /budget for lane 'analyze'/),
    );
    assert.throws(
      () => broker.createBudget({ id: "wt-1", scopeType: "lane", scopeId: "chat", period: "month", limitUsd: 3, createdBy: "o" }),
      rejectsWith("invalid_transition", /'wt-1' already exists/),
    );
    broker.updateBudget("wt-1", { limitTokens: 9, actorId: "o" });
    await proxy.awaitDurablePersistenceAck();
    assert.deepEqual(read("SELECT id, limit_usd, limit_tokens FROM broker_budgets"), [{ id: "wt-1", limit_usd: 3, limit_tokens: 9 }]);
    assert.deepEqual(
      read<{ action: string }>("SELECT action FROM broker_audit_events WHERE target_type = 'budget' ORDER BY action").map((row) => row.action),
      ["budget.created", "budget.updated"],
    );
    // Evaluator reads run on the main connection.
    proxy.saveHotEntities({ spendEvents: [spendRow("wt-row", { periodKey: broker.budgetPeriodKey(), costKnown: true, costUsd: 4 })] });
    await proxy.awaitDurablePersistenceAck();
    assert.equal(broker.evaluateBudget(broker.getBudget("wt-1")!).usdExhausted, true);

    // A failing queued write (the worker-side transaction aborts on the budget
    // row): neither the row nor its audit row commits; the ack reports it and
    // the in-memory entry is re-read from the store (dropped).
    exec(`CREATE TRIGGER budget_fail BEFORE INSERT ON broker_budgets
          WHEN NEW.id = 'wt-bad' BEGIN SELECT RAISE(ABORT, 'budget write failed'); END`);
    const originalError = console.error;
    console.error = () => {};
    try {
      broker.createBudget({ id: "wt-bad", scopeType: "lane", scopeId: "chat", period: "month", limitUsd: 1, createdBy: "o" });
      await assert.rejects(() => proxy.awaitDurablePersistenceAck(), /budget write failed/);
    } finally {
      console.error = originalError;
    }
    assert.deepEqual(read("SELECT id FROM broker_budgets WHERE id = 'wt-bad'"), []);
    assert.deepEqual(read("SELECT id FROM broker_audit_events WHERE target_id = 'wt-bad'"), [], "no audit without its row");
    assert.ok(broker.getBudget("wt-bad"), "before the resync the queued failure is not visible in memory");
    broker.reloadBudgetFromStore("wt-bad");
    assert.equal(broker.getBudget("wt-bad"), undefined);
    assert.equal(broker.findBudgetForScope("lane", "chat"), undefined, "the scope is free again");
    exec("DROP TRIGGER budget_fail");

    // Restart: the map is reloaded from the table.
    await handle.close();
    handle = createWorkerThreadPersistence({ dbFile, loadSource: "hot-tables", queueCapacity: 256 });
    proxy = handle.stateStore;
    const restarted = captureWarnings(() => new InMemoryA2ABroker(proxy, proxy.load(), { budgetPeriodTimeZone: "UTC" }));
    broker = restarted.result;
    assert.deepEqual(named(restarted.events, "broker.budget.loaded"), [{ event: "broker.budget.loaded", count: 1 }]);
    assert.equal(broker.getBudget("wt-1")?.limitTokens, 9);
    assert.throws(
      () => broker.createBudget({ id: "wt-3", scopeType: "lane", scopeId: "analyze", period: "month", limitUsd: 3, createdBy: "o" }),
      rejectsWith("invalid_transition"),
    );
  } finally {
    await handle.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("budgets: restart reloads the map; the unique index stays a backstop for a row the map does not know", () => {
  const h = harness();
  try {
    h.broker.createBudget({ id: "b-1", scopeType: "lane", scopeId: "analyze", period: "month", limitUsd: 1, createdBy: "o" });
    const startup = h.reopen();
    assert.deepEqual(named(startup, "broker.budget.loaded"), [{ event: "broker.budget.loaded", count: 1 }]);
    assert.deepEqual(h.broker.listBudgets()?.map((budget) => budget.id), ["b-1"]);
    // A row written behind the broker's back: the map misses it, the index refuses the duplicate.
    h.sql(`INSERT INTO broker_budgets (id, scope_type, scope_id, period, limit_usd, created_by, created_at)
           VALUES ('b-raw', 'lane', 'chat', 'month', 1, 'o', '2026-11-01T00:00:00.000Z')`);
    assert.throws(
      () => h.broker.createBudget({ id: "b-2", scopeType: "lane", scopeId: "chat", period: "month", limitUsd: 1, createdBy: "o" }),
      /UNIQUE constraint failed/,
    );
    assert.equal(h.broker.getBudget("b-2"), undefined, "rolled back");
    assert.deepEqual(h.broker.listAuditEvents({ action: "budget.created" }).map((event) => event.targetId), ["b-1"]);
  } finally {
    h.close();
  }
});

test("m3: budget audit events are exempt from every audit retention path", () => {
  const h = harness();
  try {
    h.broker.createBudget({ id: "b-keep", scopeType: "lane", scopeId: "analyze", period: "month", limitUsd: 1, createdBy: "o" });
    h.broker.updateBudget("b-keep", { warnPct: 50, actorId: "o" });
    h.broker.createGoal({ id: "goal-prunable", title: "G", requester: OPERATOR });
    const events = h.broker.listAuditEvents();
    const budgetIds = events.filter((event) => event.targetType === "budget").map((event) => event.id).sort();
    assert.equal(budgetIds.length, 2);
    const future = Date.now() + 365 * 24 * 3600_000;

    // In-memory selector and the SQLite planner.
    const retained = selectRetainedAuditEventIds({
      auditEvents: events,
      nowMs: future,
      auditRetentionMs: 1,
      maxAuditEvents: 0,
      maxHeartbeatAuditEvents: 0,
      retainedProposalIds: new Set(),
      retainedTaskIds: new Set(),
      retainedExchangeIds: new Set(),
      retainedMessageIds: new Set(),
      retainedArtifactIds: new Set(),
      retainedValidationIds: new Set(),
      retainedWorkerIds: new Set(),
    });
    assert.deepEqual([...retained].sort(), budgetIds, "only the budget history survives the selector");
    const plan = planAuditRetentionFromRecords(events, { retentionMs: 1, maxRecords: 0, nowMs: future });
    assert.deepEqual(plan.retainedIds, budgetIds);

    // The cap prune (audit repository) and the full-save mirror prune.
    h.store.pruneHotAuditEventsToMax(0);
    assert.deepEqual(h.query<{ id: string }>("SELECT id FROM broker_audit_events ORDER BY id").map((row) => row.id), budgetIds);
    h.broker.createGoal({ id: "goal-2", title: "G2", requester: OPERATOR });
    h.store.save({ ...h.broker.exportSnapshot(), auditEvents: [] });
    assert.deepEqual(
      h.query<{ id: string }>("SELECT id FROM broker_audit_events ORDER BY id").map((row) => row.id),
      budgetIds,
      "a full save whose snapshot no longer holds them keeps the budget audit rows",
    );
    // The in-memory retention pass at startup keeps them too.
    mock.timers.enable({ apis: ["Date"], now: future });
    try {
      h.reopen({ retention: { auditRetentionMs: 1, maxAuditEvents: 0 } });
      assert.deepEqual(h.broker.listAuditEvents().filter((event) => event.targetType === "budget").map((event) => event.id).sort(), budgetIds);
    } finally {
      mock.timers.reset();
    }
  } finally {
    h.close();
  }
});

// --- Enforcement mode -------------------------------------------------------------

test("mode: default off; invalid value and non-off without a spend ledger refuse construction", () => {
  assert.equal(resolveBudgetEnforcementMode(undefined), "off");
  assert.equal(resolveBudgetEnforcementMode(" "), "off");
  assert.equal(resolveBudgetEnforcementMode("Shadow"), "shadow");
  assert.throws(() => resolveBudgetEnforcementMode("enforce"), /invalid A2A_BUDGET_ENFORCEMENT_MODE='enforce' \(expected off \| shadow \| on\)/);
  assert.equal(new InMemoryA2ABroker().getBudgetEnforcementMode(), "off");
  assert.throws(() => new InMemoryA2ABroker(undefined, undefined, { budgetEnforcementMode: "maybe" }), /invalid A2A_BUDGET_ENFORCEMENT_MODE/);
  for (const mode of ["shadow", "on"]) {
    assert.throws(
      () => new InMemoryA2ABroker(undefined, undefined, { budgetEnforcementMode: mode }),
      new RegExp(`A2A_BUDGET_ENFORCEMENT_MODE='${mode}' requires the spend ledger`),
    );
  }
  assert.equal(new InMemoryA2ABroker(undefined, undefined, { budgetEnforcementMode: "off" }).getBudgetEnforcementMode(), "off");
});

test("mode: on runs as shadow while the period is incomplete (decision 9), on once it is complete", () => {
  assert.deepEqual(resolveEffectiveBudgetEnforcement("off", true), { configuredMode: "off", effectiveMode: "off", reason: "mode_off" });
  assert.deepEqual(resolveEffectiveBudgetEnforcement("shadow", true), { configuredMode: "shadow", effectiveMode: "shadow", reason: "mode_shadow" });
  const h = harness("hints", { budgetEnforcementMode: "on" });
  try {
    const current = h.broker.budgetPeriodKey();
    // The ledger started this period: incomplete.
    assert.deepEqual(h.broker.getBudgetEnforcement(), { configuredMode: "on", effectiveMode: "shadow", reason: "period_incomplete" });
    assert.deepEqual(h.broker.getBudgetEnforcement("2999-01"), { configuredMode: "on", effectiveMode: "on", reason: "mode_on" });
    h.sql("UPDATE broker_metadata SET value = '2000-01' WHERE key = 'spend_ledger_first_period'");
    assert.deepEqual(h.broker.getBudgetEnforcement(current), { configuredMode: "on", effectiveMode: "on", reason: "mode_on" });
    // Unknown coverage counts as incomplete: it can only weaken on to shadow.
    h.sql("DELETE FROM broker_metadata WHERE key = 'spend_ledger_first_period'");
    assert.equal(h.broker.getBudgetEnforcement(current).effectiveMode, "shadow");
  } finally {
    h.close();
  }
});

// --- Evaluator ----------------------------------------------------------------------

function budget(overrides: Partial<BudgetRecord> = {}): BudgetRecord {
  return {
    id: "b",
    scopeType: "lane",
    scopeId: "analyze",
    period: "month",
    limitUsd: null,
    limitTokens: null,
    warnPct: 80,
    enforce: "refuse",
    createdBy: "o",
    createdAt: "2026-11-01T00:00:00.000Z",
    ...overrides,
  };
}

test("evaluator (pure): exhaustion, warn threshold, and the per-scope claim decision", () => {
  const usd = budget({ limitUsd: 10 });
  assert.equal(evaluateBudgetUsage(usd, { usdSpent: 7.99, tokensSpent: 10n ** 15n }, "p").warn, false, "tokens never count toward a USD limit");
  assert.equal(evaluateBudgetUsage(usd, { usdSpent: 8, tokensSpent: 0n }, "p").warn, true, "80% of the USD limit");
  assert.equal(evaluateBudgetUsage(usd, { usdSpent: 9.99, tokensSpent: 0n }, "p").usdExhausted, false);
  assert.equal(evaluateBudgetUsage(usd, { usdSpent: 10, tokensSpent: 0n }, "p").usdExhausted, true);
  const tokens = budget({ limitTokens: 100, warnPct: 50 });
  assert.deepEqual(
    (({ usdExhausted, tokensExhausted, warn }) => ({ usdExhausted, tokensExhausted, warn }))(evaluateBudgetUsage(tokens, { usdSpent: 1e6, tokensSpent: 49n }, "p")),
    { usdExhausted: false, tokensExhausted: false, warn: false },
  );
  assert.equal(evaluateBudgetUsage(tokens, { usdSpent: 0, tokensSpent: 50n }, "p").warn, true);
  assert.equal(evaluateBudgetUsage(tokens, { usdSpent: 0, tokensSpent: 100n }, "p").tokensExhausted, true);
  // Exact past 2^53.
  const huge = budget({ limitTokens: Number.MAX_SAFE_INTEGER });
  assert.equal(evaluateBudgetUsage(huge, { usdSpent: 0, tokensSpent: BigInt(Number.MAX_SAFE_INTEGER) - 1n }, "p").tokensExhausted, false);
  assert.equal(evaluateBudgetUsage(huge, { usdSpent: 0, tokensSpent: BigInt(Number.MAX_SAFE_INTEGER) + 1n }, "p").tokensExhausted, true);

  let probes = 0;
  const reports = (answer: boolean) => () => {
    probes += 1;
    return answer;
  };
  const exhaustedUsd = evaluateBudgetUsage(usd, { usdSpent: 11, tokensSpent: 0n }, "p");
  assert.equal(decideClaimBudgetScope(exhaustedUsd, reports(true)).reason, "usd_exhausted");
  assert.equal(decideClaimBudgetScope(exhaustedUsd, reports(true)).refuse, true);
  assert.deepEqual(
    (({ refuse, reason }) => ({ refuse, reason }))(decideClaimBudgetScope(exhaustedUsd, reports(false))),
    { refuse: false, reason: "usd_exhausted_cost_unknown_worker" },
    "Decision 4: an unknown-cost worker is never refused by a USD limit",
  );
  probes = 0;
  const exhaustedTokens = evaluateBudgetUsage(tokens, { usdSpent: 0, tokensSpent: 100n }, "p");
  assert.deepEqual((({ refuse, reason }) => ({ refuse, reason }))(decideClaimBudgetScope(exhaustedTokens, reports(false))), { refuse: true, reason: "tokens_exhausted" });
  assert.equal(probes, 0, "the cost probe runs only when it matters");
  assert.equal(decideClaimBudgetScope(evaluateBudgetUsage(tokens, { usdSpent: 0, tokensSpent: 1n }, "p"), reports(true)).reason, "within_limit");
  const paused = evaluateBudgetUsage(budget({ limitTokens: 1, enforce: "pause" }), { usdSpent: 0, tokensSpent: 5n }, "p");
  assert.deepEqual((({ refuse, reason }) => ({ refuse, reason }))(decideClaimBudgetScope(paused, reports(true))), { refuse: false, reason: "enforce_pause" });
});

test("evaluator (broker): USD counts only cost_known rows; tokens are input + output; claim decisions per worker and mode", () => {
  const h = harness("hints", { budgetEnforcementMode: "on" });
  try {
    const period = h.broker.budgetPeriodKey();
    h.sql("UPDATE broker_metadata SET value = '2000-01' WHERE key = 'spend_ledger_first_period'");
    h.store.saveHotEntities({
      spendEvents: [
        // worker-a reports cost; worker-b runs an unknown-cost runtime with tokens.
        spendRow("r-a1", { periodKey: period, agentId: "worker-a", costKnown: true, costUsd: 6, inputTokens: 30, outputTokens: 10 }),
        spendRow("r-b1", { periodKey: period, agentId: "worker-b", costKnown: false, costUsd: 0, inputTokens: 40, outputTokens: 20 }),
        spendRow("r-b2", { periodKey: period, agentId: "worker-b", costKnown: false, lane: "chat", inputTokens: 500, outputTokens: 0 }),
        spendRow("r-old", { periodKey: "2000-01", agentId: "worker-a", costKnown: true, costUsd: 1_000 }),
      ],
    });
    // A USD-only budget on worker-b's agent scope: its unknown-cost rows never exhaust it.
    const usdOnlyB = h.broker.createBudget({ id: "usd-b", scopeType: "agent", scopeId: "worker-b", period: "month", limitUsd: 0.01, createdBy: "o" });
    const usdOnlyEval = h.broker.evaluateBudget(usdOnlyB);
    assert.equal(usdOnlyEval.usdSpent, 0);
    assert.equal(usdOnlyEval.usdExhausted, false, "Decision 4: unknown-cost rows do not count toward USD");
    assert.equal(usdOnlyEval.tokensSpent, 60n + 500n);

    const lane = h.broker.createBudget({ id: "lane-analyze", scopeType: "lane", scopeId: "analyze", period: "month", limitUsd: 5, createdBy: "o" });
    const laneEval = h.broker.evaluateBudget(lane);
    assert.equal(laneEval.usdSpent, 6, "only this period, only cost_known rows");
    assert.equal(laneEval.tokensSpent, 40n + 60n, "input + output tokens of every row of the scope");
    assert.equal(laneEval.usdExhausted, true);

    const refusedA = h.broker.evaluateClaimBudget({ lane: "analyze", workerId: "worker-a" });
    assert.equal(refusedA.checkFailed, false);
    assert.deepEqual(refusedA.enforcement, { configuredMode: "on", effectiveMode: "on", reason: "mode_on" });
    assert.deepEqual(refusedA.scopes.map((scope) => [scope.budgetId, scope.refuse, scope.reason]), [["lane-analyze", true, "usd_exhausted"]]);
    assert.equal(refusedA.refuse, true);
    const allowedB = h.broker.evaluateClaimBudget({ lane: "analyze", workerId: "worker-b" });
    assert.deepEqual(
      allowedB.scopes.map((scope) => [scope.budgetId, scope.refuse, scope.reason]),
      [["usd-b", false, "within_limit"], ["lane-analyze", false, "usd_exhausted_cost_unknown_worker"]],
    );
    assert.equal(allowedB.refuse, false);

    // A token limit counts input + output and refuses any worker.
    h.broker.createBudget({ id: "lane-chat", scopeType: "lane", scopeId: "chat", period: "month", limitTokens: 500, createdBy: "o" });
    // m11: workerId is also the agent scope key (worker-b has its own USD-only budget, within limit).
    for (const [workerId, reasons] of [["worker-a", ["tokens_exhausted"]], ["worker-b", ["within_limit", "tokens_exhausted"]]] as const) {
      const decision = h.broker.evaluateClaimBudget({ lane: "chat", workerId });
      assert.deepEqual(decision.scopes.map((scope) => scope.reason), reasons, workerId);
      assert.equal(decision.refuse, true);
    }
    // Goal scope and absent scopes.
    assert.deepEqual(h.broker.evaluateClaimBudget({ lane: "verify", goalId: null, workerId: "worker-a" }).scopes, []);

    // shadow: the same decision is reported, never applied.
    const shadow = h.reopen({ budgetEnforcementMode: "shadow" });
    assert.deepEqual(named(shadow, "broker.budget.check_failed"), []);
    const shadowed = h.broker.evaluateClaimBudget({ lane: "chat", workerId: "worker-a" });
    assert.equal(shadowed.wouldRefuse, true);
    assert.equal(shadowed.refuse, false);
    assert.equal(shadowed.enforcement.effectiveMode, "shadow");
  } finally {
    h.close();
  }
});

test("evaluator: a read failure fails open with checkFailed, an in-memory counter and a rate-limited check_failed line", () => {
  const h = harness("hints", { budgetEnforcementMode: "on" });
  mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-07T00:00:00.000Z") });
  try {
    h.broker.createBudget({ id: "lane-analyze", scopeType: "lane", scopeId: "analyze", period: "month", limitUsd: 1, createdBy: "o" });
    assert.deepEqual(h.broker.getBudgetCheckFailures(), { count: 0, lastAt: null });
    h.store.readSpendScopeUsage = () => {
      throw new Error("disk I/O error");
    };
    const first = captureWarnings(() => h.broker.evaluateClaimBudget({ lane: "analyze", workerId: "worker-a" }));
    assert.deepEqual(
      (({ checkFailed, refuse, wouldRefuse, scopes }) => ({ checkFailed, refuse, wouldRefuse, scopes }))(first.result),
      { checkFailed: true, refuse: false, wouldRefuse: false, scopes: [] },
    );
    assert.deepEqual(named(first.events, "broker.budget.check_failed"), [
      { event: "broker.budget.check_failed", source: "claim", workerId: "worker-a", count: 1, error: "disk I/O error", suppressed: 0 },
    ]);
    assert.deepEqual(h.broker.getBudgetCheckFailures(), { count: 1, lastAt: "2026-11-07T00:00:00.000Z" });
    mock.timers.tick(30_000);
    const second = captureWarnings(() => h.broker.evaluateClaimBudget({ lane: "analyze", workerId: "worker-a" }));
    assert.equal(second.result.checkFailed, true);
    assert.deepEqual(named(second.events, "broker.budget.check_failed"), [], "at most one line per minute");
    assert.deepEqual(h.broker.getBudgetCheckFailures(), { count: 2, lastAt: "2026-11-07T00:00:30.000Z" });
    mock.timers.tick(30_000);
    const third = captureWarnings(() => h.broker.evaluateClaimBudget({ lane: "analyze", workerId: "worker-b" }));
    assert.deepEqual(named(third.events, "broker.budget.check_failed"), [
      { event: "broker.budget.check_failed", source: "claim", workerId: "worker-b", count: 3, error: "disk I/O error", suppressed: 1 },
    ]);
  } finally {
    mock.timers.reset();
    h.close();
  }
});

// --- 3a review carry-overs ---------------------------------------------------------

test("6a: recordedAt is the first parseable of cancellation.requestedAt (canceled), completedAt, updatedAt, then now()", () => {
  const base = {
    id: "t",
    intent: "analyze",
    status: "canceled",
    cancellation: { requestedAt: "not-a-date" },
    completedAt: "2026-03-31T10:00:00.000Z",
    updatedAt: "2026-04-02T00:00:00.000Z",
  } as unknown as TaskRecord;
  const now = () => "2026-05-05T00:00:00.000Z";
  const recordedAt = (task: Partial<TaskRecord>) =>
    buildTaskSpendEvent({ ...base, ...task } as TaskRecord, { timeZone: "UTC", now }).event.recordedAt;
  assert.equal(recordedAt({}), "2026-03-31T10:00:00.000Z", "an unparseable cancel time falls through to completedAt");
  assert.equal(recordedAt({ cancellation: { requestedAt: "2026-03-30T00:00:00.000Z" } as TaskRecord["cancellation"] }), "2026-03-30T00:00:00.000Z");
  assert.equal(recordedAt({ completedAt: "bogus" }), "2026-04-02T00:00:00.000Z", "then updatedAt");
  assert.equal(recordedAt({ completedAt: "bogus", updatedAt: "bogus" }), "2026-05-05T00:00:00.000Z", "then now()");
  assert.equal(
    recordedAt({ status: "succeeded", cancellation: { requestedAt: "2026-03-01T00:00:00.000Z" } as TaskRecord["cancellation"] }),
    "2026-03-31T10:00:00.000Z",
    "the cancel time is only considered for a canceled task",
  );
});

/** Complete a task, then drop its spend row so the reconciliation has to rebuild it. */
function completedWithoutRow(h: Harness, id: string, output?: Record<string, unknown>): void {
  runToRunning(h.broker, taskRequest(id));
  captureWarnings(() => h.broker.completeTask(id, "worker-a", { summary: "ok", ...(output ? { output } : {}) }));
  h.sql("DELETE FROM broker_spend_events WHERE task_id = ?", id);
}

test("6b/m1: after a page write fails, the next periodic run retries it row by row and skips only the failing row; lines are rate-limited", () => {
  const h = harness();
  mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-07T00:00:00.000Z") });
  try {
    completedWithoutRow(h, "b-bad", { executionTelemetry: telemetry({ outputTokens: -1 }) });
    completedWithoutRow(h, "c-ok", { executionTelemetry: telemetry({ outputTokens: -2 }) });
    completedWithoutRow(h, "d-ok");
    h.sql(`CREATE TRIGGER spend_fail BEFORE INSERT ON broker_spend_events
           WHEN NEW.task_id = 'b-bad' BEGIN SELECT RAISE(ABORT, 'spend insert failed'); END`);
    const sweep = () => captureWarnings(() => h.broker.reconcileSpendLedger({ maxPages: 1, pageSize: 3 }));
    // Sweep 1: the bulk page write fails; nothing is written or logged per row.
    const one = sweep();
    assert.equal(one.result, undefined);
    assert.deepEqual(named(one.events, "broker.spend.reconcile_failed"), [
      { event: "broker.spend.reconcile_failed", submitted: 0, unrepairable: 0, error: "spend insert failed", suppressed: 0 },
    ]);
    assert.deepEqual(named(one.events, "broker.spend.telemetry_malformed"), [], "6c: nothing logged for a page whose write failed");
    assert.equal(h.query("SELECT task_id FROM broker_spend_events").length, 0, "the page write is all or nothing");
    // Sweep 2: row by row; only b-bad is skipped, the other two are written and logged once.
    const two = sweep();
    assert.deepEqual(two.result, { submitted: 2, unrepairable: 0 });
    assert.deepEqual(named(two.events, "broker.spend.reconcile_row_skipped"), [
      { event: "broker.spend.reconcile_row_skipped", taskId: "b-bad", error: "spend insert failed", suppressed: 0 },
    ]);
    assert.deepEqual(named(two.events, "broker.spend.telemetry_malformed").map((event) => event.taskId), ["c-ok"]);
    assert.deepEqual(named(two.events, "broker.spend.reconciled"), [
      { event: "broker.spend.reconciled", submitted: 2, unrepairable: 0, passEnded: false, rowsSkipped: 1 },
    ]);
    assert.deepEqual(h.query<{ task_id: string }>("SELECT task_id FROM broker_spend_events ORDER BY task_id").map((row) => row.task_id), ["c-ok", "d-ok"]);
    // The cursor moved past the page: the next sweep ends the pass instead of re-reading it.
    assert.deepEqual(sweep().result, { submitted: 0, unrepairable: 0 });
    // Next pass: b-bad alone fails its (bulk) write again; within the minute the line is suppressed.
    const again = sweep();
    assert.equal(again.result, undefined);
    assert.deepEqual(named(again.events, "broker.spend.reconcile_failed"), [], "one reconcile_failed line per minute");
    mock.timers.tick(61_000);
    const rowAgain = sweep();
    assert.deepEqual(named(rowAgain.events, "broker.spend.reconcile_row_skipped"), [
      { event: "broker.spend.reconcile_row_skipped", taskId: "b-bad", error: "spend insert failed", suppressed: 0 },
    ]);
    const third = sweep();
    assert.equal(third.result, undefined);
    assert.deepEqual(named(third.events, "broker.spend.reconcile_failed"), [
      { event: "broker.spend.reconcile_failed", submitted: 0, unrepairable: 0, error: "spend insert failed", suppressed: 1 },
    ]);
    // Once the write goes through, the row and its diagnostics land once.
    h.sql("DROP TRIGGER spend_fail");
    const passes = [sweep(), sweep(), sweep()];
    assert.deepEqual(
      passes.flatMap((run) => named(run.events, "broker.spend.telemetry_malformed")).map((event) => event.taskId),
      ["b-bad"],
    );
    assert.equal(h.query("SELECT task_id FROM broker_spend_events WHERE task_id = 'b-bad'").length, 1);
  } finally {
    mock.timers.reset();
    h.close();
  }
});

test("6b/m1: a listing failure never arms the row-by-row retry and keeps the cursor", () => {
  const h = harness();
  try {
    completedWithoutRow(h, "b-1");
    const original = h.store.listTerminalTasksMissingSpend;
    h.store.listTerminalTasksMissingSpend = () => {
      throw new Error("database is locked");
    };
    for (let index = 0; index < 4; index += 1) {
      const run = captureWarnings(() => h.broker.reconcileSpendLedger({ maxPages: 1, pageSize: 1 }));
      assert.equal(run.result, undefined);
    }
    h.store.listTerminalTasksMissingSpend = original;
    completedWithoutRow(h, "b-2");
    // A bulk write (not row by row): one saveHotEntities call for the page.
    let calls = 0;
    const save = h.store.saveHotEntities;
    h.store.saveHotEntities = (hints) => {
      calls += 1;
      save.call(h.store, hints);
    };
    try {
      assert.deepEqual(captureWarnings(() => h.broker.reconcileSpendLedger({ maxPages: 1, pageSize: 2 })).result, { submitted: 2, unrepairable: 0 });
      assert.equal(calls, 1);
    } finally {
      h.store.saveHotEntities = save;
    }
  } finally {
    h.close();
  }
});

test("6d: passEnded marks the pass total; a throw on a later page keeps the earlier pages' unrepairable count", () => {
  const h = harness();
  try {
    const ghost = (id: string) => ({
      id,
      intent: "analyze",
      requester: { id: "hub-a", kind: "node", role: "hub" },
      target: { id: "worker-a", kind: "node", role: "analyst" },
      targetNodeId: "worker-a",
      status: "failed",
      payload: {},
      artifactIds: [],
      createdAt: "2026-03-01T00:00:00.000Z",
      updatedAt: "2026-03-01T00:00:00.000Z",
      taskOrigin: "api",
    }) as unknown as TaskRecord;
    h.store.upsertHotTasks([ghost("a-0"), ghost("a-1")]);
    completedWithoutRow(h, "b-bad");
    h.sql(`CREATE TRIGGER spend_fail BEFORE INSERT ON broker_spend_events
           WHEN NEW.task_id = 'b-bad' BEGIN SELECT RAISE(ABORT, 'spend insert failed'); END`);
    const failed = captureWarnings(() => h.broker.reconcileSpendLedger({ maxPages: 2, pageSize: 2 }));
    assert.equal(failed.result, undefined);
    assert.deepEqual(named(failed.events, "broker.spend.reconcile_failed").map((event) => event.unrepairable), [2], "the completed first page's count");
    h.sql("DROP TRIGGER spend_fail");
    const ended = captureWarnings(() => h.broker.reconcileSpendLedger({ maxPages: 2, pageSize: 2 }));
    assert.deepEqual(ended.result, { submitted: 1, unrepairable: 0 });
    assert.deepEqual(named(ended.events, "broker.spend.reconciled"), [
      { event: "broker.spend.reconciled", submitted: 1, unrepairable: 2, passEnded: true },
    ], "the pass total includes the page read before the throw");
  } finally {
    h.close();
  }
});

test("6c: a reconciled cancel logs its late malformed telemetry with late: true, reconciled: true", () => {
  const h = harness();
  try {
    runToRunning(h.broker, taskRequest("rc-late-bad"));
    h.broker.cancelTask("rc-late-bad", { actor: OPERATOR });
    captureWarnings(() =>
      h.broker.completeTask("rc-late-bad", "worker-a", { summary: "late", output: { executionTelemetry: { schemaVersion: "v0" } } }));
    h.sql("DELETE FROM broker_spend_events");
    const startup = h.reopen();
    assert.deepEqual(named(startup, "broker.spend.telemetry_malformed"), [
      { event: "broker.spend.telemetry_malformed", taskId: "rc-late-bad", status: "canceled", reason: "schema_version", reconciled: true, late: true },
    ]);
    assert.equal(h.query<{ cost_known: number }>("SELECT cost_known FROM broker_spend_events")[0]?.cost_known, 0);
  } finally {
    h.close();
  }
});

test("6e: rows at or above half a per-task cap log broker.spend.near_cap (field only) at terminal time and when reconciled", () => {
  const h = harness();
  try {
    runToRunning(h.broker, taskRequest("big"));
    const terminal = captureWarnings(() =>
      h.broker.completeTask("big", "worker-a", {
        summary: "ok",
        output: { executionTelemetry: telemetry({ costUsd: 500_000, outputTokens: 5e11, inputTokens: 1 }) },
      }));
    assert.deepEqual(named(terminal.events, "broker.spend.near_cap"), [
      { event: "broker.spend.near_cap", taskId: "big", field: "costUsd" },
      { event: "broker.spend.near_cap", taskId: "big", field: "outputTokens" },
    ]);
    runToRunning(h.broker, taskRequest("small"));
    const quiet = captureWarnings(() =>
      h.broker.completeTask("small", "worker-a", { summary: "ok", output: { executionTelemetry: telemetry({ costUsd: 499_999 }) } }));
    assert.deepEqual(named(quiet.events, "broker.spend.near_cap"), []);
    h.sql("DELETE FROM broker_spend_events WHERE task_id = 'big'");
    const startup = h.reopen();
    assert.deepEqual(named(startup, "broker.spend.near_cap"), [
      { event: "broker.spend.near_cap", taskId: "big", field: "costUsd", reconciled: true },
      { event: "broker.spend.near_cap", taskId: "big", field: "outputTokens", reconciled: true },
    ]);
    // No values in any line.
    assert.ok(startup.every((event) => !JSON.stringify(event).includes("500000")));
  } finally {
    h.close();
  }
});

test("outliers: listTopSpendRows orders a scope's rows by cost (cost_known only) and by tokens", () => {
  const h = harness();
  try {
    h.store.saveHotEntities({
      spendEvents: [
        spendRow("t-1", { costKnown: true, costUsd: 3, inputTokens: 1, outputTokens: 1 }),
        spendRow("t-2", { costKnown: true, costUsd: 9, inputTokens: 5, outputTokens: 0 }),
        spendRow("t-3", { costKnown: false, inputTokens: 900, outputTokens: 100 }),
        spendRow("t-4", { lane: "chat", costKnown: true, costUsd: 99 }),
      ],
    });
    const top = h.broker.listTopSpendRows({ periodKey: "2026-11", scopeType: "lane", scopeId: "analyze", limit: 2 });
    assert.deepEqual(top.byCost.map((row) => [row.taskId, row.costUsd]), [["t-2", 9], ["t-1", 3]]);
    assert.deepEqual(top.byTokens.map((row) => [row.taskId, row.tokens, row.costKnown]), [["t-3", 1000n, false], ["t-2", 5n, true]]);
    assert.deepEqual(Object.keys(top.byCost[0]!).sort(), ["agentId", "costKnown", "costUsd", "goalId", "lane", "recordedAt", "taskId", "tokens"]);
  } finally {
    h.close();
  }
});

test("m2: getBudgetEnforcement never throws; a failed metadata read counts in checkFailed and logs check_failed (source enforcement)", () => {
  const h = harness("hints", { budgetEnforcementMode: "on" });
  try {
    h.sql("UPDATE broker_metadata SET value = '2000-01' WHERE key = 'spend_ledger_first_period'");
    assert.equal(h.broker.getBudgetEnforcement().effectiveMode, "on");
    h.store.readSpendLedgerMetadata = () => {
      throw new Error("disk I/O error");
    };
    const run = captureWarnings(() => h.broker.getBudgetEnforcement());
    assert.deepEqual(run.result, { configuredMode: "on", effectiveMode: "shadow", reason: "period_incomplete" });
    assert.deepEqual(named(run.events, "broker.budget.check_failed"), [
      { event: "broker.budget.check_failed", source: "enforcement", count: 1, error: "disk I/O error", suppressed: 0 },
    ]);
    assert.equal(h.broker.getBudgetCheckFailures().count, 1);
  } finally {
    h.close();
  }
});

test("m12: scope types reaching SQL come from the closed map only", () => {
  const h = harness();
  try {
    for (const scopeType of ["__proto__", "toString", "team"]) {
      assert.throws(
        () => h.broker.listTopSpendRows({ periodKey: "2026-11", scopeType: scopeType as never, scopeId: "x", limit: 1 }),
        rejectsWith("bad_request", /scopeType must be one of/),
      );
      assert.throws(
        () => h.store.readSpendScopeUsage({ periodKey: "2026-11", scopeType: scopeType as never, scopeId: "x" }),
        rejectsWith("bad_request", /unknown budget scope type/),
      );
      assert.throws(
        () => h.store.listTopSpendRows({ periodKey: "2026-11", scopeType: scopeType as never, scopeId: "x", by: "cost", limit: 1 }),
        rejectsWith("bad_request", /unknown budget scope type/),
      );
    }
  } finally {
    h.close();
  }
});

test("M2: updateBudget rejects every invalid value (400) and leaves the budget unchanged", () => {
  const h = harness();
  try {
    const created = h.broker.createBudget({ id: "b-1", scopeType: "lane", scopeId: "analyze", period: "month", limitUsd: 5, limitTokens: 10, createdBy: "o" });
    const invalid: Array<[Record<string, unknown>, RegExp]> = [
      [{ warnPct: 0 }, /warnPct/],
      [{ warnPct: 101 }, /warnPct/],
      [{ warnPct: 50.5 }, /warnPct/],
      [{ warnPct: "50" }, /warnPct/],
      [{ warnPct: null }, /warnPct/],
      [{ enforce: "stop" }, /enforce/],
      [{ enforce: 1 }, /enforce/],
      [{ limitUsd: 0 }, /limitUsd/],
      [{ limitUsd: -1 }, /limitUsd/],
      [{ limitUsd: 1e10 }, /limitUsd/],
      [{ limitUsd: "5" }, /limitUsd/],
      [{ limitUsd: Number.NaN }, /limitUsd/],
      [{ limitTokens: 2.5 }, /limitTokens/],
      [{ limitTokens: 0 }, /limitTokens/],
      [{ limitTokens: Number.MAX_SAFE_INTEGER + 1 }, /limitTokens/],
      [{ limitTokens: "5" }, /limitTokens/],
      [{ limitUsd: null, limitTokens: null }, /at least one/],
      [{}, /changes nothing/],
    ];
    for (const [request, pattern] of invalid) {
      assert.throws(
        () => h.broker.updateBudget("b-1", { ...request, actorId: "o" } as Parameters<InMemoryA2ABroker["updateBudget"]>[1]),
        rejectsWith("bad_request", pattern),
        JSON.stringify(request),
      );
    }
    assert.throws(() => h.broker.updateBudget("b-1", [] as never), rejectsWith("bad_request", /requires an object/));
    assert.throws(() => h.broker.updateBudget("b-1", { warnPct: 5 } as never), rejectsWith("bad_request", /actorId/));
    assert.deepEqual(h.broker.getBudget("b-1"), created);
    assert.deepEqual(h.broker.listAuditEvents({ action: "budget.updated" }), []);
  } finally {
    h.close();
  }
});
