/**
 * Spend ledger, record only (#2499 slice 2, docs/specs/goal-budget).
 *
 * - Every terminal transition writes one `broker_spend_events` row keyed by
 *   task_id: complete, fail (also one that schedules a retry: the retry is a
 *   new task with its own row), stale-sweep dead-letter, cancel (direct,
 *   cascaded over non-terminal descendants, checkpoint expiry). Replays and
 *   repeated terminal writes never add or change a row. An invariant test
 *   checks every terminal task row has exactly one spend row and no
 *   non-terminal task has one, on both in-process wirings and on the real
 *   worker-thread persistence.
 * - Usage comes from `executionTelemetry` on `result.output`,
 *   `error.details.bridgeFailure` (also nested under `nestedError`), or the
 *   preserved negative-verdict result, first valid carrier wins; it is
 *   validated and bounded, and when no carrier parses the row is unmetered
 *   with one content-free log line.
 * - `period_key` is `YYYY-MM` of the terminal time in the configured zone
 *   (default Asia/Seoul): 00:00 KST on the 1st = 15:00 UTC on the last day.
 * - The spend row commits in the same store transaction as the terminal task
 *   row (hints-only and repository-on-write wiring alike).
 * - Stores without SQLite get no spend rows (spend is SQLite-only).
 * - Period totals are BigInt-exact beyond 2^53 tokens.
 * - Slice-1 follow-ups: createGoal rollback (goal and `goal.created` audit)
 *   on a failed save, and snapshot goals imported into broker_goals on a
 *   SQLite-backed broker (non-fatal on failure).
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { BrokerError, InMemoryA2ABroker, type InMemoryA2ABrokerOptions } from "./broker.js";
import { buildTaskSpendEvent } from "./completion/broker-task-terminal.js";
import {
  budgetPeriodKey,
  DEFAULT_BUDGET_PERIOD_TIME_ZONE,
  resolveBudgetPeriodTimeZone,
} from "./store-schemas.js";
import {
  emptySnapshot,
  JsonFileBrokerStateStore,
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
  type BrokerSnapshot,
  type BrokerStateStore,
} from "./store/store.js";
import { createWorkerThreadPersistence } from "./store/sqlite-worker-thread-persistence.js";
import type { CreateTaskRequest, SpendEventRecord, TaskRecord } from "./types.js";

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

function claudeTelemetry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: TELEMETRY_SCHEMA,
    source: "claude_cli_envelope",
    elapsedMs: 1200,
    modelRequests: 3,
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

type Wiring = "hints" | "repositories";

interface Harness {
  broker: InMemoryA2ABroker;
  store: SqliteBrokerStateStore;
  dbFile: string;
  rows(): SpendRow[];
  row(taskId: string): SpendRow | undefined;
  reopen(): void;
  close(): void;
}

/**
 * `hints`: no repositories, so every row reaches SQLite through the save
 * hints (the worker-thread topology's shape). `repositories`: the full
 * repository set, as server.ts wires the in-process SQLite store.
 */
type HarnessOptions = Pick<InMemoryA2ABrokerOptions, "budgetPeriodTimeZone" | "checkpointTimeoutMs" | "maxRequeueAttempts">;

function harness(wiring: Wiring = "hints", options: HarnessOptions = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), "a2a-spend-ledger-"));
  const dbFile = join(dir, "state.sqlite");
  const open = () => {
    // hot-tables: a restart reloads task rows written through hints or repositories.
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
      maxRequeueAttempts: 1,
      ...repositories,
      ...options,
    });
    return { store, broker };
  };
  let current = open();
  registerWorkers(current.broker, "worker-a", "worker-b");
  const readRows = (): SpendRow[] => {
    const db = new DatabaseSync(dbFile);
    try {
      return db.prepare("SELECT * FROM broker_spend_events ORDER BY task_id").all() as unknown as SpendRow[];
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
    rows: readRows,
    row: (taskId) => readRows().find((row) => row.task_id === taskId),
    reopen() {
      current.store.close();
      current = open();
    },
    close() {
      current.store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
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

for (const wiring of ["hints", "repositories"] as const) {
  test(`[${wiring}] a succeeded task records one spend row from result.output telemetry`, () => {
    const h = harness(wiring);
    try {
      h.broker.createGoal({ id: "goal-spend", title: "Spend goal", requester: OPERATOR });
      runToRunning(h.broker, taskRequest("task-ok", { goalId: "goal-spend" }));
      const done = h.broker.completeTask("task-ok", "worker-a", {
        summary: "done",
        output: { executionTelemetry: claudeTelemetry() },
      });
      const row = h.row("task-ok");
      assert.ok(row, "the terminal transition wrote a spend row");
      assert.equal(row.recorded_at, done.completedAt);
      assert.equal(row.period_key, budgetPeriodKey(done.completedAt!, "Asia/Seoul"));
      assert.equal(row.agent_id, "worker-a", "agent = the worker that completed it (claimedBy)");
      assert.equal(row.lane, "analyze", "lane = task intent");
      assert.equal(row.goal_id, "goal-spend");
      assert.equal(row.cost_usd, 0.4321);
      assert.equal(row.cost_known, 1);
      assert.equal(row.input_tokens, 120 + 3_000, "uncached input + cache creation; cache reads not counted");
      assert.equal(row.output_tokens, 450);
      assert.equal(h.rows().length, 1);
    } finally {
      h.close();
    }
  });

  test(`[${wiring}] the spend row commits in the same transaction as the terminal task row`, () => {
    const h = harness(wiring);
    try {
      runToRunning(h.broker, taskRequest("task-atomic"));
      const before = h.store.commits;
      h.broker.completeTask("task-atomic", "worker-a", { summary: "ok", output: { executionTelemetry: claudeTelemetry() } });
      assert.equal(h.store.commits - before, 1, "terminal write + spend row = one commit");

      // Make the ledger insert fail: the whole terminal transaction must roll
      // back, so the store never holds a terminal task without its spend row.
      runToRunning(h.broker, taskRequest("task-rollback"));
      const db = new DatabaseSync(h.dbFile);
      try {
        db.exec(`CREATE TRIGGER spend_fail BEFORE INSERT ON broker_spend_events
                 WHEN NEW.task_id = 'task-rollback' BEGIN SELECT RAISE(ABORT, 'spend insert failed'); END`);
      } finally {
        db.close();
      }
      assert.throws(() => h.broker.completeTask("task-rollback", "worker-a", { summary: "ok" }), /spend insert failed/);
      const check = new DatabaseSync(h.dbFile);
      try {
        const task = check.prepare("SELECT status FROM broker_tasks WHERE id = 'task-rollback'").get() as { status: string };
        assert.equal(task.status, "running", "the terminal task row rolled back with the failed spend insert");
        assert.equal(
          check.prepare("SELECT COUNT(*) AS n FROM broker_spend_events WHERE task_id = 'task-rollback'").get()?.n,
          0,
        );
      } finally {
        check.close();
      }
    } finally {
      h.close();
    }
  });
}

test("replays never double count: repeated terminal writes, a restart, and a replayed ledger insert keep one row", () => {
  const h = harness();
  try {
    runToRunning(h.broker, taskRequest("task-replay"));
    h.broker.completeTask("task-replay", "worker-a", { summary: "first", output: { executionTelemetry: claudeTelemetry() } });
    const first = h.row("task-replay");
    // Idempotent completion replay and a late fail on the terminal task.
    h.broker.completeTask("task-replay", "worker-a", {
      summary: "replay",
      output: { executionTelemetry: claudeTelemetry({ costUsd: 99, outputTokens: 9_999 }) },
    });
    h.broker.failTask("task-replay", "worker-a", { code: "late", message: "late fail" });
    assert.deepEqual(h.row("task-replay"), first);

    // A spend-only save really runs the insert: a fresh task id gets a row
    // on the hot path and on the full-save path alike...
    const fresh = (taskId: string): SpendEventRecord => ({
      ...buildTaskSpendEvent(h.broker.getTask("task-replay")!, { timeZone: "UTC" }).event,
      taskId,
      costUsd: 1.5,
      inputTokens: 7,
    });
    h.store.saveHotEntities({ spendEvents: [fresh("task-spend-only-hot")] });
    h.store.save(h.broker.exportSnapshot(), { spendEvents: [fresh("task-spend-only-full")] });
    assert.equal(h.rows().length, 3);
    assert.equal(h.row("task-spend-only-hot")?.cost_usd, 1.5);
    assert.equal(h.row("task-spend-only-full")?.input_tokens, 7);
    // ...so a replayed save carrying an existing task's row with other values
    // (e.g. a re-delivered worker-thread write) reaches ON CONFLICT and is
    // ignored: the row count is unchanged and the values are the first write's.
    h.store.saveHotEntities({
      spendEvents: [{ ...buildTaskSpendEvent(h.broker.getTask("task-replay")!, { timeZone: "UTC" }).event, costUsd: 50, inputTokens: 1 }],
    });
    h.store.saveHotEntities({ spendEvents: [{ ...fresh("task-spend-only-hot"), costUsd: 99 }] });
    assert.equal(h.rows().length, 3);
    assert.deepEqual(h.row("task-replay"), first);
    assert.equal(h.row("task-replay")?.cost_usd, 0.4321);
    assert.equal(h.row("task-spend-only-hot")?.cost_usd, 1.5);

    // Restart: the terminal task loads as terminal; nothing re-records it.
    h.reopen();
    h.broker.completeTask("task-replay", "worker-a", { summary: "after restart" });
    assert.equal(h.rows().length, 3);
    assert.deepEqual(h.row("task-replay"), first);
  } finally {
    h.close();
  }
});

test("failed results are recorded from bridgeFailure telemetry (top-level and nested under nestedError)", () => {
  const h = harness();
  try {
    runToRunning(h.broker, taskRequest("task-bridge-fail"));
    h.broker.failTask("task-bridge-fail", "worker-a", {
      code: "openclaw_analysis_failed",
      message: "bridge failed",
      details: { bridgeFailure: { code: "no_final_json", executionTelemetry: claudeTelemetry({ costUsd: 0.25 }) } },
    });
    runToRunning(h.broker, taskRequest("task-nested-fail"));
    h.broker.failTask("task-nested-fail", "worker-a", {
      code: "handler_exit_nonzero",
      message: "handler failed",
      details: {
        stage: "handler",
        nestedError: {
          code: "openclaw_analysis_failed",
          message: "bridge failed",
          details: {
            bridgeFailure: {
              code: "provider_error",
              executionTelemetry: { schemaVersion: TELEMETRY_SCHEMA, source: "danso_cli_usage", inputTokens: 700, outputTokens: 30 },
            },
          },
        },
      },
    });
    const top = h.row("task-bridge-fail");
    assert.equal(top?.cost_known, 1);
    assert.equal(top?.cost_usd, 0.25);
    assert.equal(top?.agent_id, "worker-a");
    const nested = h.row("task-nested-fail");
    assert.equal(nested?.cost_known, 0, "danso reports tokens but no cost");
    assert.equal(nested?.cost_usd, 0);
    assert.equal(nested?.input_tokens, 700);
    assert.equal(nested?.output_tokens, 30);
  } finally {
    h.close();
  }
});

test("a partial result is recorded like any succeeded result; a failed review keeps its preserved telemetry", () => {
  const h = harness();
  try {
    runToRunning(h.broker, taskRequest("task-partial"));
    h.broker.completeTask("task-partial", "worker-a", {
      summary: "partial",
      output: { completion: { marked: true, status: "partial" }, executionTelemetry: claudeTelemetry({ costUsd: 0.1 }) },
    });
    assert.equal(h.row("task-partial")?.cost_usd, 0.1);

    // buildTaskSpendEvent reads negativeVerdictEvidence when nothing else carries telemetry.
    const preserved = buildTaskSpendEvent(
      {
        ...h.broker.getTask("task-partial")!,
        status: "failed",
        result: undefined,
        error: { code: "review_verdict_failed", message: "fail" },
        negativeVerdictEvidence: {
          reviewerNodeId: "worker-a",
          verdict: "fail",
          result: { summary: "fail", output: { executionTelemetry: claudeTelemetry({ costUsd: 0.07 }) } },
          recordedAt: "2026-11-06T00:00:00.000Z",
        },
      } as TaskRecord,
      { timeZone: "UTC" },
    );
    assert.equal(preserved.event.costKnown, true);
    assert.equal(preserved.event.costUsd, 0.07);
  } finally {
    h.close();
  }
});

test("canceled tasks and dead-lettered tasks are recorded; cancel attributes to the claimant, else the assignee", () => {
  const h = harness();
  try {
    // Canceled while running: cancellation clears claimedBy; the row keeps the pre-cancel claimant.
    runToRunning(h.broker, taskRequest("task-cancel-running", { assignedWorkerId: "worker-b", target: { id: "worker-b", kind: "node", role: "analyst" } }), "worker-b");
    h.broker.cancelTask("task-cancel-running", { actor: OPERATOR, reason: "stop" });
    // Canceled while queued: never claimed, so the agent is whatever the broker assigned.
    h.broker.createTask(taskRequest("task-cancel-queued", { assignedWorkerId: undefined }));
    h.broker.cancelTask("task-cancel-queued", { actor: OPERATOR });
    const queuedAssignee = h.broker.getTask("task-cancel-queued")?.assignedWorkerId ?? null;
    // Dead-letter: maxRequeueAttempts=1, so the second stale sweep fails it.
    runToRunning(h.broker, taskRequest("task-dead"));
    const now = Date.now();
    h.broker.requeueStaleTasks(0, { nowMs: now + 60_000 });
    h.broker.claimTask("task-dead", "worker-a");
    h.broker.requeueStaleTasks(0, { nowMs: now + 120_000 });
    assert.equal(h.broker.getTask("task-dead")?.status, "failed");

    const running = h.row("task-cancel-running");
    assert.equal(running?.agent_id, "worker-b");
    assert.equal(running?.cost_known, 0);
    assert.equal(running?.input_tokens, 0);
    assert.equal(running?.output_tokens, 0);
    assert.equal(h.row("task-cancel-queued")?.agent_id, queuedAssignee);
    // No claimant and no assignee: no agent (pure projection). The pre-cancel
    // claimant wins over the assignee; claimedBy (complete/fail) wins over both.
    const canceled = { ...h.broker.getTask("task-cancel-queued")!, claimedBy: undefined, assignedWorkerId: undefined };
    assert.equal(buildTaskSpendEvent(canceled, { timeZone: "UTC" }).event.agentId, null);
    assert.equal(buildTaskSpendEvent({ ...canceled, assignedWorkerId: "worker-b" }, { timeZone: "UTC", claimant: "worker-a" }).event.agentId, "worker-a");
    assert.equal(buildTaskSpendEvent({ ...canceled, claimedBy: "worker-c" }, { timeZone: "UTC", claimant: "worker-a" }).event.agentId, "worker-c");
    assert.equal(h.row("task-dead")?.agent_id, "worker-a", "dead-letter keeps claimedBy");
    assert.equal(h.rows().length, 3);
  } finally {
    h.close();
  }
});

test("runtimes without cost or tokens: tokens-only rows are cost-unknown, no telemetry is unmetered", () => {
  const h = harness();
  try {
    runToRunning(h.broker, taskRequest("task-codex"));
    h.broker.completeTask("task-codex", "worker-a", { summary: "codex", output: { actualRuntimeModel: "gpt" } });
    runToRunning(h.broker, taskRequest("task-piri-no-marker"));
    h.broker.completeTask("task-piri-no-marker", "worker-a", {
      summary: "piri",
      output: { executionTelemetry: { schemaVersion: TELEMETRY_SCHEMA, source: "piri_progress_file", elapsedMs: 5, modelRequests: 2 } },
    });
    runToRunning(h.broker, taskRequest("task-zero-cost"));
    h.broker.completeTask("task-zero-cost", "worker-a", {
      summary: "free",
      output: { executionTelemetry: claudeTelemetry({ costUsd: 0, inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0 }) },
    });
    for (const id of ["task-codex", "task-piri-no-marker"]) {
      const row = h.row(id);
      assert.equal(row?.cost_known, 0, id);
      assert.equal(row?.cost_usd, 0, id);
      assert.equal(row?.input_tokens, 0, id);
      assert.equal(row?.output_tokens, 0, id);
    }
    assert.equal(h.row("task-zero-cost")?.cost_known, 1, "a reported 0 USD is a known cost");

    const totals = h.broker.readSpendTotals({ periodKey: h.row("task-codex")!.period_key });
    assert.equal(totals?.total.taskCount, 3);
    assert.equal(totals?.total.unmeteredTaskCount, 2);
    assert.equal(totals?.total.costUnknownTaskCount, 2);
  } finally {
    h.close();
  }
});

test("malformed telemetry never throws: the row is unmetered and one content-free warning is logged per task", () => {
  const h = harness();
  try {
    const cases: Array<[string, unknown, string]> = [
      ["task-neg", claudeTelemetry({ costUsd: -1 }), "costUsd_invalid"],
      ["task-str", claudeTelemetry({ inputTokens: "123" }), "inputTokens_invalid"],
      ["task-cap-usd", claudeTelemetry({ costUsd: 1e6 + 1 }), "costUsd_exceeds_cap"],
      ["task-cap-tokens", claudeTelemetry({ outputTokens: 1e12 + 1 }), "outputTokens_exceeds_cap"],
      ["task-cap-sum", claudeTelemetry({ inputTokens: 1e12, cacheCreationInputTokens: 1 }), "inputTokens_exceeds_cap"],
      ["task-schema", { ...claudeTelemetry(), schemaVersion: "v0" }, "schema_version"],
      ["task-array", [1, 2], "not_object"],
    ];
    const { events } = captureWarnings(() => {
      for (const [id, telemetry] of cases) {
        runToRunning(h.broker, taskRequest(id));
        h.broker.completeTask(id, "worker-a", { summary: id, output: { executionTelemetry: telemetry } });
      }
    });
    const malformed = events.filter((event) => event.event === "broker.spend.telemetry_malformed");
    assert.equal(malformed.length, cases.length, "exactly one line per malformed task");
    for (const [id, , reason] of cases) {
      const row = h.row(id);
      assert.equal(row?.cost_known, 0, id);
      assert.equal(row?.cost_usd, 0, id);
      assert.equal(row?.input_tokens, 0, id);
      assert.equal(row?.output_tokens, 0, id);
      const line = malformed.find((event) => event.taskId === id);
      assert.equal(line?.reason, reason, id);
      assert.deepEqual(Object.keys(line ?? {}).sort(), ["event", "reason", "status", "taskId"], "no telemetry values echoed");
    }
  } finally {
    h.close();
  }
});

test("KST month boundary: 00:00 KST on the 1st is 15:00 UTC on the last day", () => {
  assert.equal(budgetPeriodKey("2026-11-30T14:59:59.999Z", "Asia/Seoul"), "2026-11");
  assert.equal(budgetPeriodKey("2026-11-30T15:00:00.000Z", "Asia/Seoul"), "2026-12");
  assert.equal(budgetPeriodKey("2026-12-31T15:00:00.000Z", "Asia/Seoul"), "2027-01");
  assert.equal(budgetPeriodKey("2026-11-30T15:00:00.000Z", "UTC"), "2026-11");

  const task = {
    id: "t",
    intent: "analyze",
    status: "succeeded",
    claimedBy: "worker-a",
    updatedAt: "2026-11-30T15:00:00.000Z",
    completedAt: "2026-11-30T15:00:00.000Z",
  } as TaskRecord;
  assert.equal(buildTaskSpendEvent(task, { timeZone: "Asia/Seoul" }).event.periodKey, "2026-12");
  assert.equal(buildTaskSpendEvent(task, { timeZone: "UTC" }).event.periodKey, "2026-11");
  assert.equal(
    buildTaskSpendEvent({ ...task, completedAt: "2026-11-30T14:59:59.999Z" }, { timeZone: "Asia/Seoul" }).event.periodKey,
    "2026-11",
  );
});

test("KST month boundary through the broker: the terminal time picks the period, in the configured zone", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-30T14:59:59.000Z") });
  const kst = harness();
  const utc = harness("hints", { budgetPeriodTimeZone: "UTC" });
  try {
    for (const h of [kst, utc]) {
      runToRunning(h.broker, taskRequest("task-before"));
      h.broker.completeTask("task-before", "worker-a", { summary: "before" });
    }
    t.mock.timers.setTime(Date.parse("2026-11-30T15:00:00.000Z"));
    for (const h of [kst, utc]) {
      runToRunning(h.broker, taskRequest("task-after"));
      h.broker.completeTask("task-after", "worker-a", { summary: "after" });
    }
    assert.equal(kst.row("task-before")?.period_key, "2026-11");
    assert.equal(kst.row("task-after")?.period_key, "2026-12");
    assert.equal(utc.row("task-before")?.period_key, "2026-11");
    assert.equal(utc.row("task-after")?.period_key, "2026-11");
    assert.equal(kst.broker.budgetPeriodKey(), "2026-12", "the default period follows the zone");
    assert.equal(utc.broker.budgetPeriodKey(), "2026-11");
  } finally {
    kst.close();
    utc.close();
  }
});

test("the budget period time zone defaults to Asia/Seoul, canonicalizes, and fails closed on an invalid zone", () => {
  assert.equal(DEFAULT_BUDGET_PERIOD_TIME_ZONE, "Asia/Seoul");
  assert.equal(resolveBudgetPeriodTimeZone(undefined), "Asia/Seoul");
  assert.equal(resolveBudgetPeriodTimeZone("   "), "Asia/Seoul");
  assert.equal(resolveBudgetPeriodTimeZone("UTC"), "UTC");
  assert.equal(resolveBudgetPeriodTimeZone(" asia/seoul "), "Asia/Seoul");
  assert.throws(() => resolveBudgetPeriodTimeZone("Mars/Olympus"), /invalid A2A_BUDGET_PERIOD_TIME_ZONE='Mars\/Olympus'/);
  assert.throws(() => new InMemoryA2ABroker(undefined, undefined, { budgetPeriodTimeZone: "Not/AZone" }), /A2A_BUDGET_PERIOD_TIME_ZONE/);
  assert.equal(new InMemoryA2ABroker().getBudgetPeriodTimeZone(), "Asia/Seoul");
});

test("spend totals group by agent, lane and goal for a period, from indexed queries only", () => {
  const h = harness();
  try {
    h.broker.createGoal({ id: "goal-a", title: "A", requester: OPERATOR });
    runToRunning(h.broker, taskRequest("t1", { goalId: "goal-a" }));
    h.broker.completeTask("t1", "worker-a", { summary: "1", output: { executionTelemetry: claudeTelemetry({ costUsd: 0.1, inputTokens: 10, cacheCreationInputTokens: 0, outputTokens: 1 }) } });
    runToRunning(h.broker, taskRequest("t2", { goalId: "goal-a", intent: "chat" }));
    h.broker.completeTask("t2", "worker-a", { summary: "2", output: { executionTelemetry: claudeTelemetry({ costUsd: 0.2, inputTokens: 20, cacheCreationInputTokens: 0, outputTokens: 2 }) } });
    runToRunning(h.broker, taskRequest("t3", { assignedWorkerId: "worker-b", target: { id: "worker-b", kind: "node", role: "analyst" } }), "worker-b");
    h.broker.completeTask("t3", "worker-b", { summary: "3" });
    const period = h.row("t1")!.period_key;

    const all = h.broker.readSpendTotals({ periodKey: period })!;
    assert.deepEqual(all.total, {
      usdKnownTotal: 0.3,
      inputTokensTotal: 30n,
      outputTokensTotal: 3n,
      taskCount: 3,
      costUnknownTaskCount: 1,
      unmeteredTaskCount: 1,
    });
    const key = (s: { scopeType: string; scopeId: string; taskCount: number }) => `${s.scopeType}:${s.scopeId}:${s.taskCount}`;
    assert.deepEqual(all.scopes.map(key), [
      "agent:worker-a:2",
      "agent:worker-b:1",
      "lane:analyze:2",
      "lane:chat:1",
      "goal:goal-a:2",
    ], "a goal-less task counts toward the total but belongs to no goal scope");
    assert.equal(all.truncated, false);

    const one = h.broker.readSpendTotals({ periodKey: period, scopeType: "goal", scopeId: "goal-a" })!;
    assert.equal(one.scopes.length, 1);
    assert.equal(one.scopes[0]?.usdKnownTotal, 0.3);
    assert.equal(h.broker.readSpendTotals({ periodKey: "1999-01" })!.total.taskCount, 0);

    // Each totals query uses a (period_key, scope) index, never a table or payload scan.
    const db = new DatabaseSync(h.dbFile);
    try {
      for (const column of ["agent_id", "lane", "goal_id"]) {
        const plan = db
          .prepare(`EXPLAIN QUERY PLAN SELECT ${column}, COUNT(*) FROM broker_spend_events WHERE period_key = ? AND ${column} IS NOT NULL GROUP BY ${column}`)
          .all(period)
          .map((row) => String((row as { detail: string }).detail))
          .join(" | ");
        assert.match(plan, /USING (COVERING )?INDEX broker_spend_events_period_/, `${column}: ${plan}`);
      }
    } finally {
      db.close();
    }
  } finally {
    h.close();
  }
});

test("stores without SQLite keep no spend: no rows staged, totals unavailable, snapshot unchanged", () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-spend-json-"));
  const stateFile = join(dir, "state.json");
  try {
    const store = new JsonFileBrokerStateStore(stateFile);
    const broker = new InMemoryA2ABroker(store, store.load());
    registerWorkers(broker, "worker-a");
    runToRunning(broker, taskRequest("task-json"));
    broker.completeTask("task-json", "worker-a", { summary: "ok", output: { executionTelemetry: claudeTelemetry() } });
    assert.equal(broker.hasSpendLedger(), false);
    assert.equal(broker.readSpendTotals({ periodKey: broker.budgetPeriodKey() }), undefined);
    const onDisk = JSON.parse(readFileSync(stateFile, "utf8")) as Record<string, unknown>;
    assert.equal("spendEvents" in onDisk, false);
    assert.equal("spend" in onDisk, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const goalCreatedAudits = (broker: InMemoryA2ABroker, goalId: string) =>
  broker.listAuditEvents().filter((event) => event.action === "goal.created" && event.targetId === goalId);

test("createGoal on a store without a goal table rolls the goal and its goal.created audit back when the save throws", () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-goal-rollback-"));
  const stateFile = join(dir, "state.json");
  try {
    const inner = new JsonFileBrokerStateStore(stateFile);
    let failSaves = false;
    const store: BrokerStateStore = {
      load: () => inner.load(),
      save: (snapshot, hints) => {
        if (failSaves) throw new Error("disk full");
        inner.save(snapshot, hints);
      },
    };
    const broker = new InMemoryA2ABroker(store, store.load());
    registerWorkers(broker, "worker-a");

    failSaves = true;
    assert.throws(() => broker.createGoal({ id: "goal-flaky", title: "Flaky", requester: OPERATOR }), /disk full/);
    assert.equal(broker.getGoal("goal-flaky"), undefined, "the failed goal is not left in memory");
    assert.deepEqual(broker.listGoals(), []);
    assert.deepEqual(goalCreatedAudits(broker, "goal-flaky"), [], "no goal.created audit for a goal the caller saw fail");
    assert.throws(
      () => broker.createTask(taskRequest("task-flaky", { goalId: "goal-flaky" })),
      (error: unknown) => error instanceof BrokerError && error.code === "not_found",
    );

    // The next unrelated full save does not persist it.
    failSaves = false;
    broker.createTask(taskRequest("task-after"));
    const onDisk = JSON.parse(readFileSync(stateFile, "utf8")) as { goals?: unknown; auditEvents: Array<{ action: string }> };
    assert.equal("goals" in onDisk, false);
    assert.equal(onDisk.auditEvents.some((event) => event.action === "goal.created"), false);

    // A retry with the same id succeeds (no misleading 409) and persists.
    const retried = broker.createGoal({ id: "goal-flaky", title: "Flaky", requester: OPERATOR });
    assert.equal(retried.status, "pursuing");
    const persisted = JSON.parse(readFileSync(stateFile, "utf8")) as { goals?: Array<{ id: string }>; auditEvents: Array<{ action: string }> };
    assert.deepEqual(persisted.goals?.map((goal) => goal.id), ["goal-flaky"]);
    assert.equal(persisted.auditEvents.filter((event) => event.action === "goal.created").length, 1);
    assert.equal(goalCreatedAudits(broker, "goal-flaky").length, 1);

    // A duplicate (409) never removes the existing goal's audit event.
    assert.throws(
      () => broker.createGoal({ id: "goal-flaky", title: "Again", requester: OPERATOR }),
      (error: unknown) => error instanceof BrokerError && error.code === "invalid_transition",
    );
    assert.equal(goalCreatedAudits(broker, "goal-flaky").length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const wiring of ["hints", "repositories"] as const) {
  test(`[${wiring}] createGoal on SQLite leaves neither a goal row nor a goal.created audit when the save throws`, () => {
    const h = harness(wiring);
    try {
      const db = new DatabaseSync(h.dbFile);
      try {
        db.exec(`CREATE TRIGGER goal_audit_fail BEFORE INSERT ON broker_audit_events
                 WHEN NEW.target_id = 'goal-flaky' BEGIN SELECT RAISE(ABORT, 'audit insert failed'); END`);
      } finally {
        db.close();
      }
      assert.throws(() => h.broker.createGoal({ id: "goal-flaky", title: "Flaky", requester: OPERATOR }), /audit insert failed/);
      assert.equal(h.broker.getGoal("goal-flaky"), undefined, "the goal row rolled back with the batch");
      assert.deepEqual(goalCreatedAudits(h.broker, "goal-flaky"), [], "the in-memory audit event is undone too");
      assert.equal("goals" in h.broker.exportSnapshot(), false);

      const fix = new DatabaseSync(h.dbFile);
      try {
        fix.exec("DROP TRIGGER goal_audit_fail");
      } finally {
        fix.close();
      }
      h.broker.createGoal({ id: "goal-flaky", title: "Flaky", requester: OPERATOR });
      assert.equal(goalCreatedAudits(h.broker, "goal-flaky").length, 1);
      const check = new DatabaseSync(h.dbFile);
      try {
        const n = (check.prepare("SELECT COUNT(*) AS n FROM broker_audit_events WHERE action = 'goal.created' AND target_id = 'goal-flaky'").get() as { n: number }).n;
        assert.equal(n, 1);
      } finally {
        check.close();
      }
    } finally {
      h.close();
    }
  });
}

test("a snapshot carrying goals loaded into a SQLite-backed broker imports them into broker_goals (create-only) and logs the count", () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-goal-import-"));
  const dbFile = join(dir, "state.sqlite");
  try {
    const source = new InMemoryA2ABroker();
    const fromJson = source.createGoal({ id: "goal-from-json", title: "From JSON", requester: OPERATOR });
    const existing = source.createGoal({ id: "goal-existing", title: "Snapshot copy", requester: OPERATOR });
    const invalid = { ...fromJson, id: "bad id" };

    const store = new SqliteBrokerStateStore(dbFile);
    try {
      new InMemoryA2ABroker(store, store.load()).createGoal({ id: "goal-existing", title: "Table copy", requester: OPERATOR });
      const snapshot: BrokerSnapshot = { ...emptySnapshot(), goals: [fromJson, existing, invalid] as BrokerSnapshot["goals"] };
      const { result: broker, events } = captureWarnings(() => new InMemoryA2ABroker(store, snapshot));

      assert.equal(broker.getGoal("goal-from-json")?.title, "From JSON");
      assert.equal(broker.getGoal("goal-existing")?.title, "Table copy", "an existing row is never overwritten");
      const imported = events.find((event) => event.event === "broker.snapshot.goals_imported");
      assert.deepEqual(imported, {
        event: "broker.snapshot.goals_imported",
        source: "loadSnapshot",
        snapshotGoals: 3,
        imported: 1,
        alreadyPresent: 1,
        quarantined: 1,
      });
      assert.equal(events.filter((event) => event.event === "broker.snapshot.record_quarantined").length, 1);
      // The SQLite broker never re-emits goals into its own snapshot.
      assert.equal("goals" in broker.exportSnapshot(), false);
      // Loading the same snapshot again (every restart until a full save
      // rewrites the canonical snapshot) imports nothing twice and logs
      // nothing new once the only remaining news would be "already present".
      const valid: BrokerSnapshot = { ...snapshot, goals: [fromJson, existing] as BrokerSnapshot["goals"] };
      const again = captureWarnings(() => new InMemoryA2ABroker(store, valid));
      assert.equal(again.events.some((event) => event.event === "broker.snapshot.goals_imported"), false);
      assert.equal(again.result.getGoal("goal-existing")?.title, "Table copy");
      assert.equal(again.result.listGoals().length, 2);
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a failing snapshot goal import does not abort startup and carries the goals forward for a retry", () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-goal-import-fail-"));
  const dbFile = join(dir, "state.sqlite");
  try {
    const goal = new InMemoryA2ABroker().createGoal({ id: "goal-carried", title: "Carried", requester: OPERATOR });
    const snapshot: BrokerSnapshot = { ...emptySnapshot(), goals: [goal] as BrokerSnapshot["goals"] };
    const store = new SqliteBrokerStateStore(dbFile);
    try {
      const db = new DatabaseSync(dbFile);
      try {
        db.exec(`CREATE TRIGGER goal_import_fail BEFORE INSERT ON broker_goals
                 BEGIN SELECT RAISE(ABORT, 'goal insert failed'); END`);
      } finally {
        db.close();
      }
      const { result: broker, events } = captureWarnings(() => new InMemoryA2ABroker(store, snapshot));
      const failed = events.find((event) => event.event === "broker.snapshot.goals_import_failed");
      assert.deepEqual(failed, {
        event: "broker.snapshot.goals_import_failed",
        source: "loadSnapshot",
        snapshotGoals: 1,
        carriedForward: 1,
        error: "goal insert failed",
      });
      assert.equal(broker.getGoal("goal-carried"), undefined, "nothing was imported");
      assert.deepEqual(
        (broker.exportSnapshot().goals as Array<{ id: string }> | undefined)?.map((entry) => entry.id),
        ["goal-carried"],
        "the next full save keeps the goals for the next start",
      );

      const fix = new DatabaseSync(dbFile);
      try {
        fix.exec("DROP TRIGGER goal_import_fail");
      } finally {
        fix.close();
      }
      const retried = captureWarnings(() => new InMemoryA2ABroker(store, broker.exportSnapshot()));
      assert.equal(retried.result.getGoal("goal-carried")?.title, "Carried");
      assert.equal(retried.events.find((event) => event.event === "broker.snapshot.goals_imported")?.imported, 1);
      assert.equal("goals" in retried.result.exportSnapshot(), false);
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a JSON state file with goals imported into a SQLite store (hot-tables load) reaches broker_goals", () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-goal-json-import-"));
  const stateFile = join(dir, "state.json");
  const dbFile = join(dir, "state.sqlite");
  try {
    const goal = new InMemoryA2ABroker().createGoal({ id: "goal-legacy", title: "Legacy", requester: OPERATOR });
    const task = {
      id: "legacy-task",
      intent: "chat",
      requester: { id: "hub-a", kind: "node", role: "hub" },
      target: { id: "worker-a", kind: "node", role: "analyst" },
      targetNodeId: "worker-a",
      status: "queued",
      payload: {},
      artifactIds: [],
      createdAt: "2026-11-01T00:00:00.000Z",
      updatedAt: "2026-11-01T00:00:00.000Z",
      taskOrigin: "api",
    };
    writeFileSync(stateFile, JSON.stringify({ ...emptySnapshot(), tasks: [task], goals: [goal] }));
    const store = new SqliteBrokerStateStore(dbFile, { loadSource: "hot-tables", importJsonFile: stateFile });
    try {
      const { result: broker, events } = captureWarnings(() => new InMemoryA2ABroker(store, store.load()));
      assert.equal(broker.getGoal("goal-legacy")?.title, "Legacy");
      assert.equal(events.find((event) => event.event === "broker.snapshot.goals_imported")?.imported, 1);
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- Per-path coverage and the ledger invariant (#2499 slice 2 review) -------

const RETRY_POLICY = { retryPolicy: { maxRetries: 1, retryOn: ["environment"], backoffMs: 0 } };
const RETRYABLE_ERROR = {
  code: "handler_exit_nonzero",
  message: "handler failed",
  details: { stage: "handler", nestedError: { code: "openclaw_analysis_failed" } },
};

/** Store-level ledger check: every task row joined to its spend rows. */
function ledgerByTask(dbFile: string): Map<string, { status: string; rows: number }> {
  const db = new DatabaseSync(dbFile);
  try {
    const rows = db.prepare(
      `SELECT t.id AS id, t.status AS status, COUNT(s.task_id) AS n
         FROM broker_tasks t LEFT JOIN broker_spend_events s ON s.task_id = t.id
        GROUP BY t.id`,
    ).all() as Array<{ id: string; status: string; n: number }>;
    const orphans = db.prepare(
      "SELECT COUNT(*) AS n FROM broker_spend_events s WHERE NOT EXISTS (SELECT 1 FROM broker_tasks t WHERE t.id = s.task_id)",
    ).get() as { n: number };
    assert.equal(orphans.n, 0, "no spend row without its task row");
    return new Map(rows.map((row) => [row.id, { status: row.status, rows: Number(row.n) }]));
  } finally {
    db.close();
  }
}

function assertLedgerInvariant(dbFile: string, broker: InMemoryA2ABroker, taskIds: readonly string[]): void {
  const ledger = ledgerByTask(dbFile);
  for (const id of taskIds) {
    const task = broker.getTask(id);
    assert.ok(task, id);
    const stored = ledger.get(id);
    assert.ok(stored, `${id} has a task row`);
    assert.equal(stored.status, task.status, `${id}: stored status matches the broker`);
    const terminal = task.status === "succeeded" || task.status === "failed" || task.status === "canceled";
    assert.equal(stored.rows, terminal ? 1 : 0, `${id} (${task.status}) has ${terminal ? "exactly one" : "no"} spend row`);
  }
  for (const [id, stored] of ledger) {
    const terminal = stored.status === "succeeded" || stored.status === "failed" || stored.status === "canceled";
    assert.equal(stored.rows, terminal ? 1 : 0, `${id} (${stored.status})`);
  }
}

/**
 * Drives every terminal path once on `broker` (workers worker-a/worker-b
 * registered, checkpointTimeoutMs 60s, maxRequeueAttempts 1) and returns the
 * task ids it touched plus the retry task id.
 */
function runMixedScenario(broker: InMemoryA2ABroker) {
  const ids: string[] = [];
  const run = (request: CreateTaskRequest, workerId = "worker-a") => {
    ids.push(request.id!);
    return runToRunning(broker, request, workerId);
  };
  // Complete.
  run(taskRequest("mix-ok"));
  broker.completeTask("mix-ok", "worker-a", { summary: "ok", output: { executionTelemetry: claudeTelemetry({ costUsd: 0.1 }) } });
  // (a) A fail that schedules a retry; the retry then completes.
  run(taskRequest("mix-retry", { payload: RETRY_POLICY }));
  const failed = broker.failTask("mix-retry", "worker-a", {
    ...RETRYABLE_ERROR,
    details: { ...RETRYABLE_ERROR.details, bridgeFailure: { code: "x", executionTelemetry: claudeTelemetry({ costUsd: 0.2 }) } },
  });
  assert.ok(failed.retriedBy, "a retry was scheduled");
  const retryId = failed.retriedBy!;
  ids.push(retryId);
  broker.claimTask(retryId, "worker-a");
  broker.startTask(retryId, "worker-a");
  broker.completeTask(retryId, "worker-a", { summary: "retry ok", output: { executionTelemetry: claudeTelemetry({ costUsd: 0.3 }) } });
  // (b) A cascaded cancel: parent running; children queued / running /
  // already succeeded; a grandchild queued under the queued child.
  run(taskRequest("mix-parent"));
  ids.push("mix-child-queued");
  broker.createTask(taskRequest("mix-child-queued", { parentTaskId: "mix-parent" }));
  run(taskRequest("mix-child-running", {
    parentTaskId: "mix-parent",
    assignedWorkerId: "worker-b",
    target: { id: "worker-b", kind: "node", role: "analyst" },
  }), "worker-b");
  run(taskRequest("mix-child-done", { parentTaskId: "mix-parent" }));
  broker.completeTask("mix-child-done", "worker-a", { summary: "done early" });
  ids.push("mix-grandchild");
  broker.createTask(taskRequest("mix-grandchild", { parentTaskId: "mix-child-queued" }));
  broker.cancelTask("mix-parent", { actor: OPERATOR, reason: "stop the tree" });
  // (c) Checkpoint expiry, and (d) a stale-sweep dead-letter, in one sweep pair.
  run(taskRequest("mix-checkpoint"));
  broker.checkpointTask("mix-checkpoint", "worker-a", { state: "awaiting_operator", reason: "waiting" });
  run(taskRequest("mix-dead"));
  const now = Date.now();
  broker.requeueStaleTasks(0, { nowMs: now + 30_000 });
  broker.claimTask("mix-dead", "worker-a");
  broker.requeueStaleTasks(0, { nowMs: now + 61_000 });
  // Non-terminal tasks that must have no row.
  ids.push("mix-queued");
  broker.createTask(taskRequest("mix-queued"));
  run(taskRequest("mix-running"));
  return { ids, retryId };
}

function assertMixedScenario(broker: InMemoryA2ABroker, row: (id: string) => SpendRow | undefined, retryId: string): void {
  assert.equal(broker.getTask("mix-retry")?.status, "failed");
  assert.equal(row("mix-retry")?.cost_usd, 0.2, "(a) the failed attempt's own row, from its bridgeFailure");
  assert.equal(row(retryId)?.cost_usd, 0.3, "(a) the retry is a new task with its own row");
  for (const id of ["mix-parent", "mix-child-queued", "mix-child-running", "mix-grandchild"]) {
    assert.equal(broker.getTask(id)?.status, "canceled", id);
    assert.ok(row(id), `(b) ${id} canceled by the cascade has a row`);
  }
  assert.equal(row("mix-child-running")?.agent_id, "worker-b", "(b) the running child keeps its claimant");
  assert.equal(row("mix-child-done")?.cost_known, 0, "(b) the already-terminal child keeps its own earlier row");
  assert.equal(broker.getTask("mix-checkpoint")?.status, "canceled", "(c) checkpoint expiry cancels");
  assert.equal(row("mix-checkpoint")?.agent_id, "worker-a", "(c) attributed to the worker that held the claim");
  assert.equal(broker.getTask("mix-dead")?.status, "failed", "(d) dead-lettered");
  assert.equal(broker.getTask("mix-dead")?.error?.code, "exceeded_requeue_limit");
  assert.equal(row("mix-dead")?.agent_id, "worker-a");
  assert.equal(row("mix-queued"), undefined);
  assert.equal(row("mix-running"), undefined);
}

for (const wiring of ["hints", "repositories"] as const) {
  test(`[${wiring}] every terminal path writes exactly one row, and the ledger matches the task table`, () => {
    const h = harness(wiring, { checkpointTimeoutMs: 60_000 });
    try {
      const { ids, retryId } = runMixedScenario(h.broker);
      assertMixedScenario(h.broker, h.row, retryId);
      assertLedgerInvariant(h.dbFile, h.broker, ids);
      // Ten terminal tasks: ok, the failed attempt and its retry, the cascade
      // (parent + 3 non-terminal descendants), the child that finished before
      // the cascade, the checkpoint expiry and the dead-letter.
      const terminal = ids.filter((id) => ["succeeded", "failed", "canceled"].includes(h.broker.getTask(id)!.status));
      assert.deepEqual(h.rows().map((row) => row.task_id).sort(), [...terminal].sort());
      assert.equal(terminal.length, 10);
      // Restarting changes nothing.
      h.reopen();
      assertLedgerInvariant(h.dbFile, h.broker, ids);
    } finally {
      h.close();
    }
  });
}

test("a cascaded cancel over N non-terminal descendants adds exactly N+1 rows, each in its own committed batch", () => {
  const h = harness("hints");
  try {
    runToRunning(h.broker, taskRequest("tree-root"));
    for (const id of ["tree-a", "tree-b", "tree-c"]) {
      h.broker.createTask(taskRequest(id, { parentTaskId: "tree-root" }));
    }
    h.broker.createTask(taskRequest("tree-a-1", { parentTaskId: "tree-a" }));
    const before = h.rows().length;
    h.broker.cancelTask("tree-root", { actor: OPERATOR, reason: "stop" });
    assert.equal(h.rows().length - before, 5, "root + 4 descendants");
    for (const id of ["tree-root", "tree-a", "tree-b", "tree-c", "tree-a-1"]) {
      assert.equal(h.row(id)?.cost_known, 0, `${id}: a cancel carries no telemetry`);
    }
    // Canceling again is a no-op.
    h.broker.cancelTask("tree-root", { actor: OPERATOR });
    assert.equal(h.rows().length - before, 5);
  } finally {
    h.close();
  }
});

test("a canceled running task is attributed to its claimant even when the assignee differs (legacy row)", () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-spend-legacy-cancel-"));
  const dbFile = join(dir, "state.sqlite");
  try {
    const store = new SqliteBrokerStateStore(dbFile, { loadSource: "hot-tables" });
    try {
      const legacy = {
        id: "legacy-running",
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
      // A row written before claims required the assignee: the loader fills
      // the assignee from the target, so it differs from the claimant.
      const broker = new InMemoryA2ABroker(store, { ...emptySnapshot(), tasks: [legacy] });
      assert.equal(broker.getTask("legacy-running")?.assignedWorkerId, "worker-a", "precondition: assignee is the target");
      assert.equal(broker.getTask("legacy-running")?.claimedBy, "worker-x", "precondition: another worker holds the claim");
      broker.cancelTask("legacy-running", { actor: OPERATOR, reason: "stop" });
      assert.equal(broker.getTask("legacy-running")?.claimedBy, undefined, "cancel cleared claimedBy");
      const db = new DatabaseSync(dbFile);
      try {
        const row = db.prepare("SELECT agent_id FROM broker_spend_events WHERE task_id = 'legacy-running'").get() as { agent_id: string | null };
        assert.equal(row.agent_id, "worker-x", "the worker that ran it, not the assignee");
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

test("telemetry carriers: precedence by status, and a malformed top carrier falls back to the next valid one", () => {
  const base = {
    id: "t",
    intent: "analyze",
    status: "failed",
    claimedBy: "worker-a",
    updatedAt: "2026-11-06T00:00:00.000Z",
    completedAt: "2026-11-06T00:00:00.000Z",
  } as TaskRecord;
  const bridge = (telemetry: unknown) => ({ code: "x", message: "x", details: { bridgeFailure: { code: "x", executionTelemetry: telemetry } } });
  const nestedBridge = (telemetry: unknown) => ({
    code: "handler_exit_nonzero",
    message: "x",
    details: { nestedError: { details: { bridgeFailure: { executionTelemetry: telemetry } } } },
  });
  const output = (telemetry: unknown) => ({ summary: "s", output: { executionTelemetry: telemetry } });

  // Failed: bridgeFailure wins over result.output when both are valid.
  const both = buildTaskSpendEvent(
    { ...base, error: bridge(claudeTelemetry({ costUsd: 0.25 })), result: output(claudeTelemetry({ costUsd: 0.75 })) },
    { timeZone: "UTC" },
  );
  assert.equal(both.event.costUsd, 0.25);
  assert.equal(both.malformed, undefined);
  // Succeeded: result.output wins.
  assert.equal(
    buildTaskSpendEvent(
      { ...base, status: "succeeded", error: bridge(claudeTelemetry({ costUsd: 0.25 })), result: output(claudeTelemetry({ costUsd: 0.75 })) },
      { timeZone: "UTC" },
    ).event.costUsd,
    0.75,
  );
  // Malformed bridgeFailure, valid result.output: falls back, metered, no malformed flag.
  const fallback = buildTaskSpendEvent(
    { ...base, error: bridge(claudeTelemetry({ costUsd: -1 })), result: output(claudeTelemetry({ costUsd: 0.75 })) },
    { timeZone: "UTC" },
  );
  assert.equal(fallback.event.costKnown, true);
  assert.equal(fallback.event.costUsd, 0.75);
  assert.equal(fallback.malformed, undefined);
  // Malformed bridgeFailure, valid nested bridgeFailure: the nested one.
  const nested = buildTaskSpendEvent(
    {
      ...base,
      error: {
        code: "handler_exit_nonzero",
        message: "x",
        details: {
          bridgeFailure: { executionTelemetry: { schemaVersion: "v0" } },
          nestedError: { details: { bridgeFailure: { executionTelemetry: claudeTelemetry({ costUsd: 0.5 }) } } },
        },
      },
    },
    { timeZone: "UTC" },
  );
  assert.equal(nested.event.costUsd, 0.5);
  assert.equal(nested.malformed, undefined);
  // Every present carrier malformed: unmetered, reason of the top carrier.
  const none = buildTaskSpendEvent(
    { ...base, error: nestedBridge("garbage"), result: output(claudeTelemetry({ outputTokens: "1" })) },
    { timeZone: "UTC" },
  );
  assert.equal(none.event.costKnown, false);
  assert.equal(none.event.inputTokens, 0);
  assert.equal(none.malformed, "not_object");
});

test("telemetry fallback through the broker: a failed task with a malformed bridgeFailure and a valid nested one is metered, with no warning", () => {
  const h = harness();
  try {
    runToRunning(h.broker, taskRequest("task-fallback"));
    const { events } = captureWarnings(() =>
      h.broker.failTask("task-fallback", "worker-a", {
        code: "handler_exit_nonzero",
        message: "handler failed",
        details: {
          bridgeFailure: { code: "x", executionTelemetry: claudeTelemetry({ costUsd: 2e6 }) },
          nestedError: { code: "y", message: "y", details: { bridgeFailure: { code: "y", executionTelemetry: claudeTelemetry({ costUsd: 0.6 }) } } },
        },
      }));
    assert.equal(h.row("task-fallback")?.cost_usd, 0.6);
    assert.equal(h.row("task-fallback")?.cost_known, 1);
    assert.equal(events.filter((event) => event.event === "broker.spend.telemetry_malformed").length, 0);
  } finally {
    h.close();
  }
});

test("period totals stay exact past 2^53 tokens; rows with no agent count in the period total only", () => {
  const h = harness();
  try {
    const period = "2026-11";
    const row = (taskId: string, agentId: string | null): SpendEventRecord => ({
      taskId,
      recordedAt: "2026-11-06T00:00:00.000Z",
      periodKey: period,
      agentId,
      lane: "analyze",
      goalId: null,
      costUsd: 1e6,
      inputTokens: 1e12,
      outputTokens: 1e12,
      costKnown: true,
    });
    // 10,000 rows at the per-row cap: 1e16 tokens > Number.MAX_SAFE_INTEGER (~9.007e15).
    const rows = Array.from({ length: 10_000 }, (_, index) => row(`big-${String(index).padStart(5, "0")}`, index === 0 ? null : "worker-big"));
    h.store.saveHotEntities({ spendEvents: rows });
    const totals = h.broker.readSpendTotals({ periodKey: period })!;
    assert.equal(totals.total.inputTokensTotal, 10_000n * 10n ** 12n);
    assert.equal(totals.total.outputTokensTotal, 10_000n * 10n ** 12n);
    assert.equal(totals.total.taskCount, 10_000);
    assert.equal(totals.total.usdKnownTotal, 1e10);
    const agent = totals.scopes.filter((scope) => scope.scopeType === "agent");
    assert.deepEqual(agent.map((scope) => [scope.scopeId, scope.taskCount]), [["worker-big", 9_999]], "the NULL-agent row is in no agent scope");
    assert.equal(agent[0]?.inputTokensTotal, 9_999n * 10n ** 12n);
    const lane = h.broker.readSpendTotals({ periodKey: period, scopeType: "lane", scopeId: "analyze" })!;
    assert.equal(lane.scopes[0]?.inputTokensTotal, 10_000n * 10n ** 12n);
  } finally {
    h.close();
  }
});

test("real worker-thread SQLite persistence: every terminal path writes one row, readable through the proxy store", async () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-spend-worker-thread-"));
  const dbFile = join(dir, "state.sqlite");
  // Writes are fire-and-forget here (the HTTP routes await each ACK), so the
  // queue must hold the whole scenario.
  const handle = createWorkerThreadPersistence({ dbFile, loadSource: "hot-tables", queueCapacity: 1_024 });
  const drain = () => handle.stateStore.awaitDurablePersistenceAck();
  try {
    // The server's worker-thread wiring: the proxy store, no repositories.
    const broker = new InMemoryA2ABroker(handle.stateStore, handle.stateStore.load(), {
      maxRequeueAttempts: 1,
      checkpointTimeoutMs: 60_000,
    });
    assert.equal(broker.hasSpendLedger(), true, "the proxy store exposes readSpendTotals (inherited, main-thread read)");
    registerWorkers(broker, "worker-a", "worker-b");
    const { ids, retryId } = runMixedScenario(broker);
    await drain();
    const readRow = (taskId: string): SpendRow | undefined => {
      const db = new DatabaseSync(dbFile);
      try {
        return db.prepare("SELECT * FROM broker_spend_events WHERE task_id = ?").get(taskId) as SpendRow | undefined;
      } finally {
        db.close();
      }
    };
    assertMixedScenario(broker, readRow, retryId);
    assertLedgerInvariant(dbFile, broker, ids);
    const totals = broker.readSpendTotals({ periodKey: readRow("mix-ok")!.period_key })!;
    assert.equal(totals.total.taskCount, 10);
    assert.equal(totals.total.usdKnownTotal, 0.6, "0.1 + 0.2 + 0.3");
    // A replayed completion and a late fail add nothing after the queue drains.
    broker.completeTask("mix-ok", "worker-a", { summary: "replay", output: { executionTelemetry: claudeTelemetry({ costUsd: 9 }) } });
    await drain();
    assert.equal(readRow("mix-ok")?.cost_usd, 0.1);
    assert.equal(broker.readSpendTotals({ periodKey: readRow("mix-ok")!.period_key })!.total.taskCount, 10);
  } finally {
    await handle.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
