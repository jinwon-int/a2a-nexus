/**
 * Spend ledger, slice 3a preconditions (#2499 slice 3a, docs/specs/goal-budget).
 *
 * - G1: late complete/fail evidence a worker posts after its task was
 *   canceled meters the canceled task's unmetered row once, from the late
 *   poster only, with the terminal-time carrier precedence; the update rides
 *   the late-evidence save (one commit in process, one queued write on the
 *   worker-thread topology).
 * - G2/G3: one create-only reconciliation at startup inserts the missing row
 *   of every terminal task row the ledger has none for (a dropped staged row,
 *   or pre-slice-2 data), from the in-memory record; a restart repairs and
 *   logs nothing; non-terminal tasks never get rows.
 * - Ledger coverage metadata (`spend_ledger_first_period`, written once;
 *   `spend_ledger_time_zone`, with a warning on change) and the live
 *   `missingSpendRows` count.
 * - The `broker.spend.telemetry_fallback` line, the bigint-safe JSON
 *   projection, and retention: pruning terminal task rows keeps their spend
 *   rows, and reconcile never recreates anything for pruned tasks.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { InMemoryA2ABroker, type InMemoryA2ABrokerOptions } from "./broker.js";
import { isTerminalTaskStatus } from "./broker-status-predicates.js";
import { buildLateSpendMetering, buildTaskSpendEvent } from "./completion/broker-task-terminal.js";
import { budgetPeriodKey, jsonSafeSpendInteger, spendTotalsToJson } from "./store-schemas.js";
import {
  emptySnapshot,
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
  type BrokerStateSaveHints,
} from "./store/store.js";
import { createWorkerThreadPersistence } from "./store/sqlite-worker-thread-persistence.js";
import type { CreateTaskRequest, SpendEventRecord, SpendLateMeteringRecord, TaskRecord, TaskStatus } from "./types.js";

const OPERATOR = { id: "operator-1", kind: "user" as const, role: "operator" as const };
const TELEMETRY_SCHEMA = "a2a.analysis-execution-telemetry.v1";

interface SpendRow {
  task_id: string;
  recorded_at: string;
  period_key: string;
  agent_id: string | null;
  lane: string | null;
  goal_id: string | null;
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  cost_known: number;
}

function telemetry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: TELEMETRY_SCHEMA,
    source: "claude_cli_envelope",
    inputTokens: 120,
    outputTokens: 450,
    cacheReadInputTokens: 90_000,
    cacheCreationInputTokens: 3_000,
    costUsd: 0.4321,
    ...overrides,
  };
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

function runToRunning(broker: InMemoryA2ABroker, request: CreateTaskRequest, workerId = "worker-a"): TaskRecord {
  const task = broker.createTask(request);
  broker.claimTask(task.id, workerId);
  broker.startTask(task.id, workerId);
  return task;
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

function spendEvents(events: Array<Record<string, unknown>>, name: string): Array<Record<string, unknown>> {
  return events.filter((event) => event.event === name);
}

type Wiring = "hints" | "repositories";
type HarnessOptions = Pick<InMemoryA2ABrokerOptions, "budgetPeriodTimeZone" | "retention">;

interface Harness {
  broker: InMemoryA2ABroker;
  store: SqliteBrokerStateStore;
  dbFile: string;
  rows(): SpendRow[];
  row(taskId: string): SpendRow | undefined;
  /** Run SQL against the database on a second connection. */
  sql(statement: string, ...params: Array<string | number | null>): void;
  metadata(key: string): string | undefined;
  /** Restart: a new store and broker on the same file; returns the startup log lines. */
  reopen(options?: HarnessOptions): Array<Record<string, unknown>>;
  close(): void;
}

/** Same wirings as broker-spend-ledger.test.ts: `hints` (worker-thread shape) and `repositories` (server.ts in-process). */
function harness(wiring: Wiring = "hints", options: HarnessOptions = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), "a2a-spend-reconcile-"));
  const dbFile = join(dir, "state.sqlite");
  const open = (opts: HarnessOptions) => {
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
    const broker = new InMemoryA2ABroker(store, store.load(), { maxRequeueAttempts: 1, ...repositories, ...opts });
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
  const readRows = (): SpendRow[] =>
    withDb((db) => db.prepare("SELECT * FROM broker_spend_events ORDER BY task_id").all() as unknown as SpendRow[]);
  return {
    get broker() {
      return current.broker;
    },
    get store() {
      return current.store;
    },
    dbFile,
    rows: readRows,
    row: (taskId) => readRows().find((row) => row.task_id === taskId),
    sql: (statement, ...params) => withDb((db) => {
      db.prepare(statement).run(...params);
    }),
    metadata: (key) => withDb((db) =>
      (db.prepare("SELECT value FROM broker_metadata WHERE key = ?").get(key) as { value?: string } | undefined)?.value),
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

/** Store-level invariant: every terminal task row has exactly one spend row, no non-terminal one has any. */
function assertLedgerInvariant(dbFile: string): void {
  const db = new DatabaseSync(dbFile);
  try {
    const rows = db.prepare(
      `SELECT t.id AS id, t.status AS status, COUNT(s.task_id) AS n
         FROM broker_tasks t LEFT JOIN broker_spend_events s ON s.task_id = t.id
        GROUP BY t.id`,
    ).all() as Array<{ id: string; status: string; n: number }>;
    for (const row of rows) {
      const terminal = row.status === "succeeded" || row.status === "failed" || row.status === "canceled";
      assert.equal(Number(row.n), terminal ? 1 : 0, `${row.id} (${row.status})`);
    }
  } finally {
    db.close();
  }
}

// --- G1: late telemetry after cancel -----------------------------------------

for (const wiring of ["hints", "repositories"] as const) {
  test(`[${wiring}] G1: a late complete meters the canceled task's unmetered row once, in the late-evidence commit`, () => {
    const h = harness(wiring);
    try {
      runToRunning(h.broker, taskRequest("late-ok"));
      h.broker.cancelTask("late-ok", { actor: OPERATOR, reason: "stop" });
      const canceled = h.row("late-ok");
      assert.ok(canceled);
      assert.equal(canceled.cost_known, 0, "a cancel is recorded unmetered");
      assert.equal(canceled.agent_id, "worker-a", "attributed to the claimant at cancel time");

      const before = h.store.commits;
      const { events } = captureWarnings(() =>
        h.broker.completeTask("late-ok", "worker-a", { summary: "late", output: { executionTelemetry: telemetry() } }));
      assert.equal(h.store.commits - before, 1, "late evidence + tombstone + metering = one commit");
      const metered = h.row("late-ok");
      assert.ok(metered);
      assert.equal(metered.cost_usd, 0.4321);
      assert.equal(metered.cost_known, 1);
      assert.equal(metered.input_tokens, 120 + 3_000);
      assert.equal(metered.output_tokens, 450);
      assert.equal(metered.period_key, canceled.period_key, "spend stays in the cancel's period");
      assert.equal(metered.recorded_at, canceled.recorded_at);
      assert.equal(metered.agent_id, "worker-a");
      assert.deepEqual(spendEvents(events, "broker.spend.late_metering_staged"), [
        { event: "broker.spend.late_metering_staged", taskId: "late-ok", kind: "complete", costKnown: true },
      ]);
      assert.equal(h.broker.getTask("late-ok")?.status, "canceled", "the task stays canceled");

      // A second late post is a no-op (late evidence is recorded once) and logs nothing.
      const second = captureWarnings(() =>
        h.broker.failTask("late-ok", "worker-a", {
          code: "x",
          message: "x",
          details: { bridgeFailure: { executionTelemetry: telemetry({ costUsd: 9 }) } },
        }));
      assert.deepEqual(h.row("late-ok"), metered);
      assert.deepEqual(spendEvents(second.events, "broker.spend.late_metering_staged"), []);

      // A restart keeps the metered row and reconcile has nothing to do.
      const startup = h.reopen();
      assert.deepEqual(h.row("late-ok"), metered);
      assert.deepEqual(spendEvents(startup, "broker.spend.reconciled"), []);
    } finally {
      h.close();
    }
  });
}

test("G1: late telemetry that is present but malformed stages nothing and logs one late telemetry_malformed line; none at all logs nothing", () => {
  const h = harness();
  try {
    runToRunning(h.broker, taskRequest("late-none"));
    h.broker.cancelTask("late-none", { actor: OPERATOR });
    const canceled = h.row("late-none");
    const { events } = captureWarnings(() =>
      h.broker.completeTask("late-none", "worker-a", { summary: "late", output: { executionTelemetry: { schemaVersion: "v0", costUsd: 7 } } }));
    assert.deepEqual(h.row("late-none"), canceled);
    assert.deepEqual(events.filter((event) => String(event.event).startsWith("broker.spend.")), [
      { event: "broker.spend.telemetry_malformed", taskId: "late-none", status: "canceled", reason: "schema_version", late: true },
    ], "reason code only, never the values");

    runToRunning(h.broker, taskRequest("late-absent"));
    h.broker.cancelTask("late-absent", { actor: OPERATOR });
    const quiet = captureWarnings(() => h.broker.completeTask("late-absent", "worker-a", { summary: "late, no telemetry" }));
    assert.deepEqual(quiet.events.filter((event) => String(event.event).startsWith("broker.spend.")), []);
  } finally {
    h.close();
  }
});

test("G1 store guard: only an unmetered row attributed to the late poster is updated, once; a missing row is a no-op", () => {
  const h = harness();
  try {
    const row = (taskId: string, overrides: Partial<SpendEventRecord> = {}): SpendEventRecord => ({
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
    });
    h.store.saveHotEntities({
      spendEvents: [
        row("m-unmetered"),
        row("m-metered", { costUsd: 0.1, costKnown: true }),
        row("m-tokens", { inputTokens: 5 }),
        row("m-other", { agentId: "worker-x" }),
        row("m-null", { agentId: null }),
        row("m-full"),
      ],
    });
    const metering = (taskId: string, overrides: Partial<SpendLateMeteringRecord> = {}): SpendLateMeteringRecord => ({
      taskId,
      agentId: "worker-a",
      costUsd: 2,
      inputTokens: 10,
      outputTokens: 20,
      costKnown: true,
      ...overrides,
    });
    const before = h.rows();
    h.store.saveHotEntities({
      spendMeterings: ["m-unmetered", "m-metered", "m-tokens", "m-other", "m-null", "m-missing"].map((id) => metering(id)),
    });
    const after = new Map(h.rows().map((r) => [r.task_id, r]));
    assert.deepEqual(
      [after.get("m-unmetered")?.cost_usd, after.get("m-unmetered")?.input_tokens, after.get("m-unmetered")?.output_tokens, after.get("m-unmetered")?.cost_known],
      [2, 10, 20, 1],
    );
    for (const id of ["m-metered", "m-tokens", "m-other", "m-null"]) {
      assert.deepEqual(after.get(id), before.find((r) => r.task_id === id), `${id} is not overwritten`);
    }
    assert.equal(after.has("m-missing"), false, "an update never creates a row");
    assert.equal(after.size, before.length);

    // Once: a second metering of the now-metered row is a no-op.
    h.store.saveHotEntities({ spendMeterings: [metering("m-unmetered", { costUsd: 9, inputTokens: 1 })] });
    assert.equal(h.row("m-unmetered")?.cost_usd, 2);
    // The full-save path applies meterings too; a tokens-only metering keeps cost unknown.
    h.store.save(h.broker.exportSnapshot(), { spendMeterings: [metering("m-full", { costUsd: 0, costKnown: false })] });
    assert.deepEqual([h.row("m-full")?.cost_known, h.row("m-full")?.input_tokens], [0, 10]);
  } finally {
    h.close();
  }
});

test("G1: a late poster that is not the row's agent (legacy claimant != assignee) does not meter the row", () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-spend-late-other-"));
  const dbFile = join(dir, "state.sqlite");
  try {
    const store = new SqliteBrokerStateStore(dbFile, { loadSource: "hot-tables" });
    try {
      const legacy = {
        id: "legacy-late",
        intent: "analyze",
        requester: { id: "hub-a", kind: "node", role: "hub" },
        target: { id: "worker-a", kind: "node", role: "analyst" },
        targetNodeId: "worker-a",
        status: "running",
        claimedBy: "worker-x",
        claimedAt: "2026-11-01T00:00:00.000Z",
        payload: {},
        artifactIds: [],
        createdAt: "2026-11-01T00:00:00.000Z",
        updatedAt: "2026-11-01T00:00:00.000Z",
        taskOrigin: "api",
      } as unknown as TaskRecord;
      const broker = new InMemoryA2ABroker(store, { ...emptySnapshot(), tasks: [legacy] });
      registerWorkers(broker, "worker-a");
      broker.cancelTask("legacy-late", { actor: OPERATOR, reason: "stop" });
      const read = () => {
        const db = new DatabaseSync(dbFile);
        try {
          return db.prepare("SELECT * FROM broker_spend_events WHERE task_id = 'legacy-late'").get() as unknown as SpendRow;
        } finally {
          db.close();
        }
      };
      const canceled = read();
      assert.equal(canceled.agent_id, "worker-x", "precondition: the row belongs to the claimant");
      // The assignee may post late evidence (claimedBy was cleared), but it is not the row's agent.
      const { events } = captureWarnings(() =>
        broker.completeTask("legacy-late", "worker-a", { summary: "late", output: { executionTelemetry: telemetry() } }));
      assert.equal(broker.getTask("legacy-late")?.lateEvidenceAfterCancel?.submittedBy, "worker-a");
      // Staged (and logged as staged) by the broker, which cannot see the row;
      // the store guard then leaves the row unchanged.
      assert.deepEqual(spendEvents(events, "broker.spend.late_metering_staged"), [
        { event: "broker.spend.late_metering_staged", taskId: "legacy-late", kind: "complete", costKnown: true },
      ]);
      assert.deepEqual(read(), canceled, "not applied: agent_id IS the late poster fails");
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("G1: late fail reads the failure carriers first, late complete the result carriers first", () => {
  const bridge = (costUsd: unknown) => ({ code: "x", message: "x", details: { bridgeFailure: { executionTelemetry: telemetry({ costUsd }) } } });
  const late = (kind: "complete" | "fail", fields: Record<string, unknown>) => ({
    id: "t",
    intent: "analyze",
    status: "canceled",
    updatedAt: "2026-11-06T00:00:00.000Z",
    lateEvidenceAfterCancel: { kind, submittedAt: "2026-11-06T00:00:00.000Z", submittedBy: "worker-a", ...fields },
  }) as unknown as TaskRecord;
  const both = { error: bridge(0.25), result: { summary: "s", output: { executionTelemetry: telemetry({ costUsd: 0.75 }) } } };
  assert.equal(buildLateSpendMetering(late("fail", both)).metering?.costUsd, 0.25);
  assert.equal(buildLateSpendMetering(late("complete", both)).metering?.costUsd, 0.75);
  assert.equal(buildLateSpendMetering(late("fail", both)).metering?.agentId, "worker-a", "attributed to the late poster");
  // A malformed bridgeFailure falls back to the nested one, with the fallback reason.
  const nested = buildLateSpendMetering(late("fail", {
    error: {
      code: "handler_exit_nonzero",
      message: "x",
      details: {
        bridgeFailure: { executionTelemetry: telemetry({ costUsd: -1 }) },
        nestedError: { details: { bridgeFailure: { executionTelemetry: telemetry({ costUsd: 0.5 }) } } },
      },
    },
  }));
  assert.equal(nested.metering?.costUsd, 0.5);
  assert.equal(nested.fallback, "costUsd_invalid");
  // Nothing parses: nothing to meter, the reason code for the one log line; no late evidence: nothing at all.
  assert.deepEqual(buildLateSpendMetering(late("fail", { error: bridge("1") })), { malformed: "costUsd_invalid" });
  assert.deepEqual(buildLateSpendMetering({ id: "t", status: "canceled" } as TaskRecord), {});
});

test("G1 through the broker: a late fail with bridgeFailure telemetry meters the row", () => {
  const h = harness();
  try {
    runToRunning(h.broker, taskRequest("late-fail"));
    h.broker.cancelTask("late-fail", { actor: OPERATOR });
    const { events } = captureWarnings(() =>
      h.broker.failTask("late-fail", "worker-a", {
        code: "openclaw_analysis_failed",
        message: "bridge",
        details: { bridgeFailure: { code: "x", executionTelemetry: telemetry({ costUsd: 0.25, cacheCreationInputTokens: 0 }) } },
      }));
    assert.equal(h.row("late-fail")?.cost_usd, 0.25);
    assert.equal(h.row("late-fail")?.input_tokens, 120);
    assert.deepEqual(spendEvents(events, "broker.spend.late_metering_staged"), [
      { event: "broker.spend.late_metering_staged", taskId: "late-fail", kind: "fail", costKnown: true },
    ]);
  } finally {
    h.close();
  }
});

test("G1 on real worker-thread persistence: the metering travels in the late-evidence write with the task row", async () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-spend-late-worker-thread-"));
  const dbFile = join(dir, "state.sqlite");
  const handle = createWorkerThreadPersistence({ dbFile, loadSource: "hot-tables", queueCapacity: 256 });
  const drain = () => handle.stateStore.awaitDurablePersistenceAck();
  const writes: BrokerStateSaveHints[] = [];
  const proxy = handle.stateStore;
  const originalHot = proxy.saveHotEntities.bind(proxy);
  proxy.saveHotEntities = (hints) => {
    writes.push(hints);
    originalHot(hints);
  };
  const originalSave = proxy.save.bind(proxy);
  proxy.save = (snapshot, hints) => {
    if (hints) writes.push(hints);
    originalSave(snapshot, hints);
  };
  try {
    const broker = new InMemoryA2ABroker(proxy, proxy.load(), { maxRequeueAttempts: 1 });
    registerWorkers(broker, "worker-a");
    runToRunning(broker, taskRequest("wt-late"));
    broker.cancelTask("wt-late", { actor: OPERATOR });
    await drain();
    writes.length = 0;
    captureWarnings(() =>
      broker.completeTask("wt-late", "worker-a", { summary: "late", output: { executionTelemetry: telemetry({ costUsd: 0.2 }) } }));
    await drain();
    const carrying = writes.filter((hints) => hints.spendMeterings?.some((metering) => metering.taskId === "wt-late"));
    assert.equal(carrying.length, 1, "one queued write carries the metering");
    assert.ok(carrying[0]?.hotTasks?.some((task) => task.id === "wt-late" && task.lateEvidenceAfterCancel), "with the task row");
    const db = new DatabaseSync(dbFile);
    try {
      const row = db.prepare("SELECT cost_usd, cost_known FROM broker_spend_events WHERE task_id = 'wt-late'").get() as { cost_usd: number; cost_known: number };
      assert.deepEqual([row.cost_usd, row.cost_known], [0.2, 1]);
      const task = db.prepare("SELECT payload FROM broker_tasks WHERE id = 'wt-late'").get() as { payload: string };
      assert.equal((JSON.parse(task.payload) as TaskRecord).lateEvidenceAfterCancel?.kind, "complete");
    } finally {
      db.close();
    }
  } finally {
    await handle.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- G2 + G3: create-only reconciliation ---------------------------------------

for (const wiring of ["hints", "repositories"] as const) {
  test(`[${wiring}] G2/G3: terminal task rows without a spend row are repaired at startup exactly once`, () => {
    const h = harness(wiring);
    try {
      runToRunning(h.broker, taskRequest("r-ok"));
      h.broker.completeTask("r-ok", "worker-a", { summary: "ok", output: { executionTelemetry: telemetry({ costUsd: 0.3 }) } });
      runToRunning(h.broker, taskRequest("r-fail"));
      h.broker.failTask("r-fail", "worker-a", {
        code: "x",
        message: "x",
        details: { bridgeFailure: { executionTelemetry: telemetry({ costUsd: 0.2 }) } },
      });
      h.broker.createTask(taskRequest("r-cancel"));
      h.broker.cancelTask("r-cancel", { actor: OPERATOR });
      h.broker.createTask(taskRequest("r-queued"));
      runToRunning(h.broker, taskRequest("r-running"));
      const expected = new Map(h.rows().map((row) => [row.task_id, row]));
      assert.deepEqual([...expected.keys()], ["r-cancel", "r-fail", "r-ok"]);
      assert.equal(h.broker.readSpendLedgerCoverage()?.missingSpendRows, 0);

      // Simulate lost rows (a dropped staged row, or terminal tasks from before slice 2).
      h.sql("DELETE FROM broker_spend_events");
      assert.equal(h.broker.readSpendLedgerCoverage()?.missingSpendRows, 3, "missingSpendRows is live");

      const startup = h.reopen();
      assert.deepEqual(spendEvents(startup, "broker.spend.reconciled"), [
        { event: "broker.spend.reconciled", submitted: 3, unrepairable: 0, passEnded: true },
      ]);
      // Rebuilt from the task records with the terminal-time builder: same rows
      // (agent, lane, period from completedAt, usage). The cancel's claimant is
      // not on the record, so it falls back to the assignee (here the same worker).
      assert.deepEqual(new Map(h.rows().map((row) => [row.task_id, row])), expected);
      assert.equal(h.row("r-queued"), undefined, "non-terminal tasks never get rows");
      assert.equal(h.row("r-running"), undefined);
      assert.equal(h.broker.readSpendLedgerCoverage()?.missingSpendRows, 0);
      assertLedgerInvariant(h.dbFile);

      // Restart again: nothing to repair, nothing logged.
      const again = h.reopen();
      assert.deepEqual(spendEvents(again, "broker.spend.reconciled"), []);
      assert.equal(h.rows().length, 3);
      assertLedgerInvariant(h.dbFile);
    } finally {
      h.close();
    }
  });
}

test("G2: a failed save after the in-memory transition, then a later save of the task row, is repaired at startup", () => {
  const h = harness();
  try {
    runToRunning(h.broker, taskRequest("g2-lost"));
    h.sql(`CREATE TRIGGER spend_fail BEFORE INSERT ON broker_spend_events
           WHEN NEW.task_id = 'g2-lost' BEGIN SELECT RAISE(ABORT, 'spend insert failed'); END`);
    assert.throws(
      () => h.broker.completeTask("g2-lost", "worker-a", { summary: "ok", output: { executionTelemetry: telemetry({ costUsd: 0.7 }) } }),
      /spend insert failed/,
    );
    assert.equal(h.broker.getTask("g2-lost")?.status, "succeeded", "the in-memory transition stayed");
    h.sql("DROP TRIGGER spend_fail");
    // A later save persists the terminal task row; the staged spend row is gone.
    h.store.save(h.broker.exportSnapshot());
    assert.equal(h.row("g2-lost"), undefined);
    assert.equal(h.broker.readSpendLedgerCoverage()?.missingSpendRows, 1);

    const startup = h.reopen();
    assert.deepEqual(spendEvents(startup, "broker.spend.reconciled"), [
      { event: "broker.spend.reconciled", submitted: 1, unrepairable: 0, passEnded: true },
    ]);
    assert.equal(h.row("g2-lost")?.cost_usd, 0.7);
    assert.equal(h.broker.readSpendLedgerCoverage()?.missingSpendRows, 0);
  } finally {
    h.close();
  }
});

test("G3: a pre-slice-2 terminal task row gets its row with period_key from completedAt; an unhydrated one is unrepairable", () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-spend-backfill-"));
  const dbFile = join(dir, "state.sqlite");
  try {
    const legacy = (id: string, status: TaskRecord["status"], completedAt?: string) => ({
      id,
      intent: "analyze",
      requester: { id: "hub-a", kind: "node", role: "hub" },
      target: { id: "worker-a", kind: "node", role: "analyst" },
      targetNodeId: "worker-a",
      assignedWorkerId: "worker-a",
      status,
      ...(status === "succeeded" ? { claimedBy: "worker-a" } : {}),
      payload: {},
      artifactIds: [],
      createdAt: "2026-03-01T00:00:00.000Z",
      updatedAt: completedAt ?? "2026-03-01T00:00:00.000Z",
      ...(completedAt ? { completedAt } : {}),
      ...(status === "succeeded" ? { result: { summary: "old", output: { executionTelemetry: telemetry({ costUsd: 0.05 }) } } } : {}),
      taskOrigin: "api",
    }) as unknown as TaskRecord;
    const seed = new SqliteBrokerStateStore(dbFile, { loadSource: "hot-tables" });
    // 16:00 UTC on 31 March = 01:00 KST on 1 April.
    seed.upsertHotTasks([legacy("old-done", "succeeded", "2026-03-31T16:00:00.000Z"), legacy("old-queued", "queued")]);
    seed.close();

    const store = new SqliteBrokerStateStore(dbFile, { loadSource: "hot-tables" });
    try {
      const { events } = captureWarnings(() => new InMemoryA2ABroker(store, store.load()));
      assert.deepEqual(spendEvents(events, "broker.spend.reconciled"), [
        { event: "broker.spend.reconciled", submitted: 1, unrepairable: 0, passEnded: true },
      ]);
      const db = new DatabaseSync(dbFile);
      try {
        const rows = db.prepare("SELECT task_id, period_key, agent_id, cost_usd FROM broker_spend_events").all() as Array<Record<string, unknown>>;
        assert.deepEqual(rows.map((row) => ({ ...row })), [{ task_id: "old-done", period_key: "2026-04", agent_id: "worker-a", cost_usd: 0.05 }]);
      } finally {
        db.close();
      }
    } finally {
      store.close();
    }

    // A terminal task row the broker did not hydrate (here: an empty snapshot)
    // cannot be rebuilt: counted unrepairable, no row written.
    const third = new SqliteBrokerStateStore(dbFile, { loadSource: "hot-tables" });
    try {
      third.upsertHotTasks([legacy("old-unloaded", "failed", "2026-03-02T00:00:00.000Z")]);
      const { events } = captureWarnings(() => new InMemoryA2ABroker(third, emptySnapshot()));
      assert.deepEqual(spendEvents(events, "broker.spend.reconciled"), [
        { event: "broker.spend.reconciled", submitted: 0, unrepairable: 1, passEnded: true },
      ]);
      assert.equal(third.countTerminalTasksMissingSpend(), 1);
    } finally {
      third.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("G2: reconcile of a canceled task with late evidence applies the late usage when the poster is the row's agent", () => {
  const h = harness();
  try {
    runToRunning(h.broker, taskRequest("rc-late"));
    h.broker.cancelTask("rc-late", { actor: OPERATOR });
    captureWarnings(() =>
      h.broker.completeTask("rc-late", "worker-a", { summary: "late", output: { executionTelemetry: telemetry({ costUsd: 0.9 }) } }));
    const metered = h.row("rc-late");
    assert.equal(metered?.cost_usd, 0.9);
    h.sql("DELETE FROM broker_spend_events");
    h.reopen();
    assert.deepEqual(h.row("rc-late"), metered, "the reconciled row equals the late-metered one");
  } finally {
    h.close();
  }
});

test("reconcile pages past unrepairable ids, is non-fatal, and stops at maxPages", () => {
  const h = harness();
  try {
    // 205 ids sort before the repairable one: the second page must still reach it.
    const ghosts = Array.from({ length: 205 }, (_, index) => ({
      id: `a-ghost-${String(index).padStart(3, "0")}`,
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
    }) as unknown as TaskRecord);
    h.store.upsertHotTasks(ghosts);
    runToRunning(h.broker, taskRequest("z-real"));
    h.broker.completeTask("z-real", "worker-a", { summary: "ok" });
    h.sql("DELETE FROM broker_spend_events WHERE task_id = 'z-real'");
    // The ghosts are not in this broker's memory.
    const firstPage = captureWarnings(() => h.broker.reconcileSpendLedger({ maxPages: 1 }));
    assert.deepEqual(firstPage.result, { submitted: 0, unrepairable: 200 });
    const all = captureWarnings(() => h.broker.reconcileSpendLedger());
    assert.deepEqual(all.result, { submitted: 1, unrepairable: 205 });
    assert.ok(h.row("z-real"));
    assert.equal(h.rows().length, 1, "no row for an unrepairable id");

    // Non-fatal: a store failure logs one line and returns undefined.
    const failing = captureWarnings(() => {
      const original = h.store.listTerminalTasksMissingSpend;
      h.store.listTerminalTasksMissingSpend = () => {
        throw new Error("disk I/O error");
      };
      try {
        return h.broker.reconcileSpendLedger();
      } finally {
        h.store.listTerminalTasksMissingSpend = original;
      }
    });
    assert.equal(failing.result, undefined);
    assert.deepEqual(spendEvents(failing.events, "broker.spend.reconcile_failed"), [
      { event: "broker.spend.reconcile_failed", submitted: 0, unrepairable: 0, error: "disk I/O error", suppressed: 0 },
    ]);
  } finally {
    h.close();
  }
});

/** A terminal task row the broker never hydrated (written straight to broker_tasks). */
function ghostTask(id: string, status: TaskStatus = "failed"): TaskRecord {
  return {
    id,
    intent: "analyze",
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    targetNodeId: "worker-a",
    status,
    payload: {},
    artifactIds: [],
    createdAt: "2026-03-01T00:00:00.000Z",
    updatedAt: "2026-03-01T00:00:00.000Z",
    taskOrigin: "api",
  } as unknown as TaskRecord;
}

test("periodic reconcile: the cursor moves past a full page of unrepairable ids, a stable set logs once, a later-lost row is repaired without restart", () => {
  const h = harness();
  try {
    // Page size 3 (test-only override): five unrepairable ids sort first.
    h.store.upsertHotTasks(["a-0", "a-1", "a-2", "a-3", "a-4"].map((id) => ghostTask(id)));
    runToRunning(h.broker, taskRequest("z-real"));
    h.broker.completeTask("z-real", "worker-a", { summary: "ok", output: { executionTelemetry: telemetry({ costUsd: 0.4 }) } });
    const metered = h.row("z-real");
    h.sql("DELETE FROM broker_spend_events WHERE task_id = 'z-real'");
    const sweep = () => {
      const run = captureWarnings(() => h.broker.reconcileSpendLedger({ maxPages: 1, pageSize: 3 }));
      return { result: run.result, logged: spendEvents(run.events, "broker.spend.reconciled") };
    };

    // Sweep 1: a-0..a-2, all unrepairable, mid-pass: no line.
    assert.deepEqual(sweep(), { result: { submitted: 0, unrepairable: 3 }, logged: [] });
    // Sweep 2 continues after a-2 (it no longer re-reads the first page): a-3, a-4, z-real.
    assert.deepEqual(sweep(), {
      result: { submitted: 1, unrepairable: 2 },
      logged: [{ event: "broker.spend.reconciled", submitted: 1, unrepairable: 2, passEnded: false }],
    });
    assert.deepEqual(h.row("z-real"), metered, "repaired without a restart");
    // Sweep 3: an empty page ends the pass: the pass total (5) is new, so one line.
    assert.deepEqual(sweep(), {
      result: { submitted: 0, unrepairable: 0 },
      logged: [{ event: "broker.spend.reconciled", submitted: 0, unrepairable: 5, passEnded: true }],
    });
    // The next pass starts again from the first id; the same 5 log nothing.
    assert.deepEqual(sweep(), { result: { submitted: 0, unrepairable: 3 }, logged: [] });
    assert.deepEqual(sweep(), { result: { submitted: 0, unrepairable: 2 }, logged: [] }, "a short page ends the pass; total unchanged");

    // A row lost later (an id after the unrepairable ones) is found on the next pass.
    h.sql("DELETE FROM broker_spend_events WHERE task_id = 'z-real'");
    assert.equal(sweep().result?.submitted, 0, "a-0..a-2");
    assert.deepEqual(sweep(), {
      result: { submitted: 1, unrepairable: 2 },
      logged: [{ event: "broker.spend.reconciled", submitted: 1, unrepairable: 2, passEnded: false }],
    });
    assert.deepEqual(h.row("z-real"), metered);

    // A full run (the startup mode) walks from the first id and leaves the cursor reset.
    assert.deepEqual(sweep().result, { submitted: 0, unrepairable: 0 }, "ends the pass at the empty page");
    assert.deepEqual(sweep().result, { submitted: 0, unrepairable: 3 }, "mid-pass again: cursor after a-2");
    assert.deepEqual(captureWarnings(() => h.broker.reconcileSpendLedger({ pageSize: 3 })).result, { submitted: 0, unrepairable: 5 });
    assert.deepEqual(sweep().result, { submitted: 0, unrepairable: 3 }, "after a full run the sweep starts from a-0 again");
  } finally {
    h.close();
  }
});

test("the reconcile status IN-list is exactly the isTerminalTaskStatus set", () => {
  const h = harness();
  try {
    // Record<TaskStatus, true>: adding a status to TaskStatus fails this file's compile until listed.
    const every: Record<TaskStatus, true> = {
      blocked: true, queued: true, claimed: true, running: true, succeeded: true, failed: true, canceled: true,
    };
    const statuses = Object.keys(every) as TaskStatus[];
    h.store.upsertHotTasks(statuses.map((status) => ghostTask(`s-${status}`, status)));
    const listed = h.store.listTerminalTasksMissingSpend({ limit: 100 }).filter((id) => id.startsWith("s-")).map((id) => id.slice(2));
    assert.deepEqual(listed.sort(), statuses.filter((status) => isTerminalTaskStatus(status)).sort());
    assert.deepEqual(listed.sort(), ["canceled", "failed", "succeeded"]);
    assert.equal(h.store.countTerminalTasksMissingSpend(), listed.length);
  } finally {
    h.close();
  }
});

test("reconciled rows log telemetry_malformed / telemetry_fallback like terminal-time rows (reconciled: true)", () => {
  const h = harness();
  try {
    runToRunning(h.broker, taskRequest("rc-bad"));
    runToRunning(h.broker, taskRequest("rc-fb"));
    captureWarnings(() => {
      h.broker.completeTask("rc-bad", "worker-a", { summary: "s", output: { executionTelemetry: telemetry({ outputTokens: -1 }) } });
      h.broker.failTask("rc-fb", "worker-a", {
        code: "handler_exit_nonzero",
        message: "x",
        details: {
          bridgeFailure: { executionTelemetry: telemetry({ costUsd: 2e6 }) },
          nestedError: { details: { bridgeFailure: { executionTelemetry: telemetry({ costUsd: 0.3 }) } } },
        },
      });
    });
    h.sql("DELETE FROM broker_spend_events");
    const startup = h.reopen();
    assert.deepEqual(spendEvents(startup, "broker.spend.telemetry_malformed"), [
      { event: "broker.spend.telemetry_malformed", taskId: "rc-bad", status: "succeeded", reason: "outputTokens_invalid", reconciled: true },
    ]);
    assert.deepEqual(spendEvents(startup, "broker.spend.telemetry_fallback"), [
      { event: "broker.spend.telemetry_fallback", taskId: "rc-fb", status: "failed", reason: "costUsd_exceeds_cap", reconciled: true },
    ]);
    assert.equal(h.row("rc-fb")?.cost_usd, 0.3);
    assert.equal(h.row("rc-bad")?.cost_known, 0);
  } finally {
    h.close();
  }
});

test("a reconciled canceled task stays in the cancel's period when its late evidence arrived the next month", () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-spend-cancel-period-"));
  const dbFile = join(dir, "state.sqlite");
  try {
    // 10:00 UTC on 31 March = 19:00 KST on 31 March (2026-03); the late post is on 2 April.
    const canceledAt = "2026-03-31T10:00:00.000Z";
    const lateAt = "2026-04-02T00:00:00.000Z";
    const canceled = (id: string, withCompletedAt: boolean) => ({
      ...ghostTask(id, "canceled"),
      assignedWorkerId: "worker-a",
      ...(withCompletedAt ? { completedAt: canceledAt } : {}),
      updatedAt: lateAt,
      cancellation: { requestedAt: canceledAt, requestedBy: "operator-1", kind: "operator_cancel" },
      lateEvidenceAfterCancel: {
        kind: "complete",
        result: { summary: "late", output: { executionTelemetry: telemetry({ costUsd: 0.8 }) } },
        submittedAt: lateAt,
        submittedBy: "worker-a",
      },
    }) as unknown as TaskRecord;
    const seed = new SqliteBrokerStateStore(dbFile, { loadSource: "hot-tables" });
    seed.upsertHotTasks([canceled("c-stamped", true), canceled("c-legacy", false)]);
    seed.close();
    const store = new SqliteBrokerStateStore(dbFile, { loadSource: "hot-tables" });
    try {
      captureWarnings(() => new InMemoryA2ABroker(store, store.load()));
      const db = new DatabaseSync(dbFile);
      try {
        const rows = db.prepare("SELECT task_id, recorded_at, period_key, cost_usd FROM broker_spend_events ORDER BY task_id").all();
        assert.deepEqual(rows.map((row) => ({ ...row })), [
          { task_id: "c-legacy", recorded_at: canceledAt, period_key: "2026-03", cost_usd: 0.8 },
          { task_id: "c-stamped", recorded_at: canceledAt, period_key: "2026-03", cost_usd: 0.8 },
        ], "the cancel's period (not the late post's), with the late usage applied");
      } finally {
        db.close();
      }
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real worker-thread persistence: reconcile repairs a missing row, metadata is written and read back, coverage works", async () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-spend-reconcile-worker-thread-"));
  const dbFile = join(dir, "state.sqlite");
  const handle = createWorkerThreadPersistence({ dbFile, loadSource: "hot-tables", queueCapacity: 256 });
  const drain = () => handle.stateStore.awaitDurablePersistenceAck();
  try {
    const proxy = handle.stateStore;
    const broker = new InMemoryA2ABroker(proxy, proxy.load(), { budgetPeriodTimeZone: "UTC" });
    registerWorkers(broker, "worker-a");
    runToRunning(broker, taskRequest("wt-ok"));
    broker.completeTask("wt-ok", "worker-a", { summary: "ok", output: { executionTelemetry: telemetry({ costUsd: 0.5 }) } });
    await drain();
    const read = () => {
      const db = new DatabaseSync(dbFile);
      try {
        return db.prepare("SELECT cost_usd FROM broker_spend_events WHERE task_id = 'wt-ok'").get() as { cost_usd: number } | undefined;
      } finally {
        db.close();
      }
    };
    assert.equal(read()?.cost_usd, 0.5);
    // (b) Metadata written at construction (main connection) and read back through the proxy.
    assert.deepEqual(proxy.readSpendLedgerMetadata(), { firstPeriod: broker.budgetPeriodKey(), timeZone: "UTC" });

    const db = new DatabaseSync(dbFile);
    try {
      db.exec("DELETE FROM broker_spend_events WHERE task_id = 'wt-ok'");
    } finally {
      db.close();
    }
    // (c) Coverage through the proxy (main-thread read).
    assert.deepEqual(broker.readSpendLedgerCoverage(), { firstPeriod: broker.budgetPeriodKey(), timeZone: "UTC", missingSpendRows: 1 });
    // (a) Reconcile submits a queued write; the row is there after the queue flushes.
    const run = captureWarnings(() => broker.reconcileSpendLedger({ maxPages: 1 }));
    assert.deepEqual(run.result, { submitted: 1, unrepairable: 0 });
    await drain();
    assert.equal(read()?.cost_usd, 0.5);
    assert.equal(broker.readSpendLedgerCoverage()?.missingSpendRows, 0);
  } finally {
    await handle.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- Ledger coverage metadata ---------------------------------------------------

test("ledger metadata: the first period is written once; a zone change warns and updates", () => {
  const h = harness("hints", { budgetPeriodTimeZone: "UTC" });
  try {
    const current = h.broker.budgetPeriodKey();
    assert.equal(h.metadata("spend_ledger_first_period"), current);
    assert.equal(h.metadata("spend_ledger_time_zone"), "UTC");
    assert.deepEqual(h.broker.readSpendLedgerCoverage(), { firstPeriod: current, timeZone: "UTC", missingSpendRows: 0 });

    // The first period never moves on a later start.
    h.sql("UPDATE broker_metadata SET value = '2026-01' WHERE key = 'spend_ledger_first_period'");
    const sameZone = h.reopen();
    assert.equal(h.metadata("spend_ledger_first_period"), "2026-01");
    assert.deepEqual(spendEvents(sameZone, "broker.spend.time_zone_changed"), []);

    // A zone change: one warning, the stored zone follows, startup is not refused.
    const changed = h.reopen({ budgetPeriodTimeZone: "Asia/Seoul" });
    assert.deepEqual(spendEvents(changed, "broker.spend.time_zone_changed"), [
      { event: "broker.spend.time_zone_changed", previous: "UTC", current: "Asia/Seoul" },
    ]);
    assert.equal(h.metadata("spend_ledger_time_zone"), "Asia/Seoul");
    assert.equal(h.metadata("spend_ledger_first_period"), "2026-01");
    assert.equal(h.broker.readSpendLedgerCoverage()?.timeZone, "Asia/Seoul");
    // Same zone again: no warning.
    assert.deepEqual(spendEvents(h.reopen({ budgetPeriodTimeZone: "Asia/Seoul" }), "broker.spend.time_zone_changed"), []);
  } finally {
    h.close();
  }
});

test("ledger metadata: both keys commit in one transaction; a failed sync logs ledger_metadata_failed and reconcile still runs", () => {
  const h = harness();
  try {
    // One transaction: a failure on the second write rolls back the first.
    h.sql("DELETE FROM broker_metadata WHERE key IN ('spend_ledger_first_period', 'spend_ledger_time_zone')");
    h.sql(`CREATE TRIGGER zone_fail BEFORE INSERT ON broker_metadata
           WHEN NEW.key = 'spend_ledger_time_zone' BEGIN SELECT RAISE(ABORT, 'metadata write failed'); END`);
    const before = h.store.commits;
    assert.throws(() => h.store.syncSpendLedgerMetadata({ periodKey: "2026-11", timeZone: "UTC" }), /metadata write failed/);
    assert.equal(h.metadata("spend_ledger_first_period"), undefined, "rolled back with the failed zone write");
    h.sql("DROP TRIGGER zone_fail");
    h.store.syncSpendLedgerMetadata({ periodKey: "2026-11", timeZone: "UTC" });
    assert.equal(h.store.commits - before, 2, "one commit (and one rollback) per sync");
    assert.deepEqual([h.metadata("spend_ledger_first_period"), h.metadata("spend_ledger_time_zone")], ["2026-11", "UTC"]);

    // Startup with a failing sync: one line, then the reconciliation still repairs.
    runToRunning(h.broker, taskRequest("md-ok"));
    h.broker.completeTask("md-ok", "worker-a", { summary: "ok" });
    h.sql("DELETE FROM broker_spend_events");
    h.sql("DELETE FROM broker_metadata WHERE key IN ('spend_ledger_first_period', 'spend_ledger_time_zone')");
    const original = SqliteBrokerStateStore.prototype.syncSpendLedgerMetadata;
    SqliteBrokerStateStore.prototype.syncSpendLedgerMetadata = () => {
      throw new Error("database is locked");
    };
    let startup: Array<Record<string, unknown>>;
    try {
      startup = h.reopen();
    } finally {
      SqliteBrokerStateStore.prototype.syncSpendLedgerMetadata = original;
    }
    assert.deepEqual(spendEvents(startup, "broker.spend.ledger_metadata_failed"), [
      { event: "broker.spend.ledger_metadata_failed", error: "database is locked" },
    ]);
    assert.deepEqual(spendEvents(startup, "broker.spend.reconciled"), [{ event: "broker.spend.reconciled", submitted: 1, unrepairable: 0, passEnded: true }]);
    assert.ok(h.row("md-ok"));
    assert.deepEqual(h.broker.readSpendLedgerCoverage(), { firstPeriod: null, timeZone: null, missingSpendRows: 0 });
  } finally {
    h.close();
  }
});

test("ledger coverage: missingSpendRows is null when the store cannot count or the count throws", () => {
  const h = harness();
  try {
    const store = h.store;
    const original = store.countTerminalTasksMissingSpend;
    store.countTerminalTasksMissingSpend = () => {
      throw new Error("disk I/O error");
    };
    assert.equal(h.broker.readSpendLedgerCoverage()?.missingSpendRows, null);
    Object.assign(store, { countTerminalTasksMissingSpend: undefined });
    assert.equal(h.broker.readSpendLedgerCoverage()?.missingSpendRows, null);
    store.countTerminalTasksMissingSpend = original;
    assert.equal(h.broker.readSpendLedgerCoverage()?.missingSpendRows, 0);
  } finally {
    h.close();
  }
});

test("stores without SQLite have no ledger coverage and no reconcile", () => {
  const broker = new InMemoryA2ABroker();
  assert.equal(broker.readSpendLedgerCoverage(), undefined);
  assert.equal(broker.reconcileSpendLedger(), undefined);
});

// --- telemetry_fallback, bigint JSON, retention ------------------------------------

test("telemetry_fallback: a malformed top carrier with a later valid one logs one content-free line", () => {
  const built = buildTaskSpendEvent(
    {
      id: "t",
      intent: "analyze",
      status: "succeeded",
      updatedAt: "2026-11-06T00:00:00.000Z",
      result: { summary: "s", output: { executionTelemetry: telemetry({ outputTokens: "1" }) } },
      error: { code: "x", message: "x", details: { bridgeFailure: { executionTelemetry: telemetry({ costUsd: 0.6 }) } } },
    } as unknown as TaskRecord,
    { timeZone: "UTC" },
  );
  assert.equal(built.event.costUsd, 0.6);
  assert.equal(built.fallback, "outputTokens_invalid");
  assert.equal(built.malformed, undefined);
  assert.equal(buildTaskSpendEvent({ id: "t", status: "succeeded", updatedAt: "2026-11-06T00:00:00.000Z" } as TaskRecord, { timeZone: "UTC" }).fallback, undefined);

  const h = harness();
  try {
    runToRunning(h.broker, taskRequest("fb"));
    const { events } = captureWarnings(() =>
      h.broker.failTask("fb", "worker-a", {
        code: "handler_exit_nonzero",
        message: "handler failed",
        details: {
          bridgeFailure: { code: "x", executionTelemetry: telemetry({ costUsd: 2e6 }) },
          nestedError: { code: "y", message: "y", details: { bridgeFailure: { executionTelemetry: telemetry({ costUsd: 0.6 }) } } },
        },
      }));
    assert.equal(h.row("fb")?.cost_usd, 0.6);
    assert.deepEqual(spendEvents(events, "broker.spend.telemetry_fallback"), [
      { event: "broker.spend.telemetry_fallback", taskId: "fb", status: "failed", reason: "costUsd_exceeds_cap" },
    ]);
    assert.deepEqual(spendEvents(events, "broker.spend.telemetry_malformed"), []);
  } finally {
    h.close();
  }
});

test("spendTotalsToJson: JSON.stringify works past 2^53 and stays exact", () => {
  const above = 2n ** 53n + 1n;
  const totals = {
    usdKnownTotal: 1.5,
    inputTokensTotal: above,
    outputTokensTotal: BigInt(Number.MAX_SAFE_INTEGER),
    taskCount: 3,
    costUnknownTaskCount: 1,
    unmeteredTaskCount: 0,
  };
  assert.throws(() => JSON.stringify(totals), /BigInt/, "a raw SpendTotals cannot be serialized");
  const json = JSON.stringify(spendTotalsToJson(totals));
  const parsed = JSON.parse(json) as Record<string, unknown>;
  assert.equal(parsed.input_tokens_total, "9007199254740993", "exact decimal string above 2^53 - 1");
  assert.equal(BigInt(parsed.input_tokens_total as string), above);
  assert.equal(parsed.output_tokens_total, Number.MAX_SAFE_INTEGER, "a safe total stays a number");
  assert.deepEqual(parsed, {
    usd_known_total: 1.5,
    input_tokens_total: "9007199254740993",
    output_tokens_total: Number.MAX_SAFE_INTEGER,
    task_count: 3,
    cost_unknown_task_count: 1,
    unmetered_task_count: 0,
  });
  assert.equal(jsonSafeSpendInteger(0n), 0);
});

test("retention: pruning terminal task rows keeps their spend rows, and reconcile recreates nothing for them", () => {
  const h = harness("hints", { retention: { maxTerminalTasks: 1, terminalRetentionMs: 0 } });
  try {
    for (const id of ["ret-1", "ret-2", "ret-3"]) {
      runToRunning(h.broker, taskRequest(id));
      h.broker.completeTask(id, "worker-a", { summary: id, output: { executionTelemetry: telemetry({ costUsd: 0.1 }) } });
    }
    const spend = h.rows();
    assert.equal(spend.length, 3);
    // Restart: the load applies retention, so memory keeps one terminal task.
    // Then the full save of the retained snapshot (what persistState's
    // retention cadence writes) prunes broker_tasks to the retained set.
    const startup = h.reopen();
    assert.deepEqual(spendEvents(startup, "broker.spend.reconciled"), []);
    h.broker.createTask(taskRequest("ret-queued"));
    h.store.save(h.broker.exportSnapshot());
    const db = new DatabaseSync(h.dbFile);
    let terminalRows: number;
    try {
      terminalRows = Number((db.prepare("SELECT COUNT(*) AS n FROM broker_tasks WHERE status = 'succeeded'").get() as { n: number }).n);
    } finally {
      db.close();
    }
    assert.equal(terminalRows, 1, "the hot retention path pruned two terminal task rows");
    assert.deepEqual(h.rows(), spend, "their spend rows are intact (the ledger is never pruned)");
    assert.equal(h.broker.readSpendLedgerCoverage()?.missingSpendRows, 0);
    const again = h.reopen();
    assert.deepEqual(spendEvents(again, "broker.spend.reconciled"), []);
    assert.deepEqual(h.rows(), spend, "nothing recreated or duplicated");
    assert.deepEqual(captureWarnings(() => h.broker.reconcileSpendLedger()).result, { submitted: 0, unrepairable: 0 });
    // The period total still counts all three.
    assert.equal(h.broker.readSpendTotals({ periodKey: budgetPeriodKey(spend[0]!.recorded_at, "Asia/Seoul") })?.total.taskCount, 3);
  } finally {
    h.close();
  }
});
