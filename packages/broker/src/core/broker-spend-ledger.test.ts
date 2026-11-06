/**
 * Spend ledger, record only (#2499 slice 2, docs/specs/goal-budget).
 *
 * - Every terminal transition (succeeded, failed, canceled, dead-letter)
 *   writes one `broker_spend_events` row keyed by task_id; replays and
 *   repeated terminal writes never add or change a row.
 * - Usage comes from `executionTelemetry` on `result.output`,
 *   `error.details.bridgeFailure` (also nested under `nestedError`), or the
 *   preserved negative-verdict result; it is validated and bounded, and
 *   malformed telemetry is recorded unmetered with one content-free log line.
 * - `period_key` is `YYYY-MM` of the terminal time in the configured zone
 *   (default Asia/Seoul): 00:00 KST on the 1st = 15:00 UTC on the last day.
 * - The spend row commits in the same store transaction as the terminal task
 *   row (hints-only and repository-on-write wiring alike).
 * - Stores without SQLite get no spend rows (spend is SQLite-only).
 * - Slice-1 follow-ups: createGoal rollback on a failed JSON-file save, and
 *   snapshot goals imported into broker_goals on a SQLite-backed broker.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { BrokerError, InMemoryA2ABroker } from "./broker.js";
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
import type { CreateTaskRequest, TaskRecord } from "./types.js";

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
function harness(wiring: Wiring = "hints", options: { budgetPeriodTimeZone?: string } = {}): Harness {
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

    // A replayed save carrying the same task's spend row with other values
    // (e.g. a re-delivered worker-thread write) is ignored by the store.
    h.store.saveHotEntities({
      spendEvents: [{ ...buildTaskSpendEvent(h.broker.getTask("task-replay")!, { timeZone: "UTC" }).event, costUsd: 50, inputTokens: 1 }],
    });
    assert.deepEqual(h.row("task-replay"), first);

    // Restart: the terminal task loads as terminal; nothing re-records it.
    h.reopen();
    h.broker.completeTask("task-replay", "worker-a", { summary: "after restart" });
    assert.deepEqual(h.rows(), [first]);
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

test("canceled tasks and dead-lettered tasks are recorded; cancel attributes to the assignee", () => {
  const h = harness();
  try {
    // Canceled while running: cancellation clears claimedBy, so the agent is the assignee.
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
    // No claimant and no assignee: no agent (pure projection).
    const unattributed = buildTaskSpendEvent(
      { ...h.broker.getTask("task-cancel-queued")!, claimedBy: undefined, assignedWorkerId: undefined },
      { timeZone: "UTC" },
    );
    assert.equal(unattributed.event.agentId, null);
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
      inputTokensTotal: 30,
      outputTokensTotal: 3,
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

test("createGoal on a store without a goal table rolls the goal back when the save throws", () => {
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
    assert.throws(
      () => broker.createTask(taskRequest("task-flaky", { goalId: "goal-flaky" })),
      (error: unknown) => error instanceof BrokerError && error.code === "not_found",
    );

    // The next unrelated full save does not persist it.
    failSaves = false;
    broker.createTask(taskRequest("task-after"));
    const onDisk = JSON.parse(readFileSync(stateFile, "utf8")) as Record<string, unknown>;
    assert.equal("goals" in onDisk, false);

    // A retry with the same id succeeds (no misleading 409) and persists.
    const retried = broker.createGoal({ id: "goal-flaky", title: "Flaky", requester: OPERATOR });
    assert.equal(retried.status, "pursuing");
    const persisted = JSON.parse(readFileSync(stateFile, "utf8")) as { goals?: Array<{ id: string }> };
    assert.deepEqual(persisted.goals?.map((goal) => goal.id), ["goal-flaky"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

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
      // Loading the same snapshot again imports nothing twice.
      const again = captureWarnings(() => new InMemoryA2ABroker(store, snapshot)).events
        .find((event) => event.event === "broker.snapshot.goals_imported");
      assert.equal(again?.imported, 0);
      assert.equal(again?.alreadyPresent, 2);
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
