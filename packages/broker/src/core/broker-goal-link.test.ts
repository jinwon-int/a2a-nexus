/**
 * Goal persistence and the create-time task goal link (#2499 slice 1).
 *
 * - Goals reuse GoalRecord/GoalStatus and start `pursuing`.
 * - SQLite stores are the goal authority (`broker_goals`); stores without a
 *   goal table carry broker-held goals in their snapshot.
 * - A task `goalId` must name an existing `pursuing` goal: unknown is
 *   `not_found`, non-pursuing is `invalid_transition`; absent is unchanged.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { BrokerError, InMemoryA2ABroker } from "./broker.js";
import { emptySnapshot, SqliteBrokerStateStore, type BrokerSnapshot, type BrokerStateStore } from "./store/store.js";
import type { CreateTaskRequest, GoalRecord, RegisterWorkerRequest } from "./types.js";

const OPERATOR = { id: "operator-1", kind: "user" as const, role: "operator" as const };

function worker(): RegisterWorkerRequest {
  return {
    nodeId: "worker-a",
    role: "analyst",
    capabilities: {
      canAnalyze: true,
      canBackfill: false,
      canPatchWorkspace: false,
      canPromoteLive: false,
      workspaceIds: ["default"],
      environments: ["research"],
    },
  } as RegisterWorkerRequest;
}

function taskRequest(overrides: Partial<CreateTaskRequest> = {}): CreateTaskRequest {
  return {
    intent: "chat",
    requester: { id: "hub", kind: "node", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    message: "goal-linked task",
    payload: {},
    ...overrides,
  };
}

function expectBrokerError(fn: () => unknown, code: BrokerError["code"], pattern?: RegExp): BrokerError {
  let caught: unknown;
  assert.throws(fn, (error: unknown) => {
    caught = error;
    return error instanceof BrokerError && error.code === code && (!pattern || pattern.test(error.message));
  });
  return caught as BrokerError;
}

function withSqliteBroker(run: (broker: InMemoryA2ABroker, store: SqliteBrokerStateStore, dbFile: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "a2a-broker-goal-link-"));
  const dbFile = join(dir, "state.sqlite");
  const store = new SqliteBrokerStateStore(dbFile);
  try {
    const broker = new InMemoryA2ABroker(store, store.load());
    broker.registerWorker(worker());
    run(broker, store, dbFile);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function setGoalStatus(store: SqliteBrokerStateStore, goalId: string, status: GoalRecord["status"]): void {
  const current = store.readGoal(goalId);
  assert.ok(current);
  store.upsertGoal({ ...current, status, updatedAt: new Date().toISOString() });
}

test("createGoal builds a pursuing GoalRecord with a creation history event", () => {
  const broker = new InMemoryA2ABroker();
  const goal = broker.createGoal({
    id: "goal-1",
    title: "  Ship slice 1  ",
    requester: OPERATOR,
    budget: { maxChildAttempts: 3, maxResourceUnits: 10, deadlineAt: "2026-12-01T00:00:00.000Z" },
  });
  assert.equal(goal.id, "goal-1");
  assert.equal(goal.title, "Ship slice 1");
  assert.equal(goal.objective, "Ship slice 1", "objective defaults to the title");
  assert.equal(goal.status, "pursuing");
  assert.deepEqual(goal.requester, OPERATOR);
  assert.deepEqual(goal.budget, { maxChildAttempts: 3, maxResourceUnits: 10, deadlineAt: "2026-12-01T00:00:00.000Z" });
  assert.deepEqual(goal.taskAttachments, []);
  assert.equal(goal.history.length, 1);
  assert.equal(goal.history[0]?.to, "pursuing");
  assert.equal(goal.history[0]?.reason, "operator_requested");
  assert.equal(goal.history[0]?.goalId, "goal-1");
  assert.deepEqual(broker.getGoal("goal-1"), goal);

  const generated = broker.createGoal({ title: "No id", objective: "Explicit objective", requester: OPERATOR });
  assert.match(generated.id, /^[0-9a-f-]{36}$/);
  assert.equal(generated.objective, "Explicit objective");
});

test("createGoal refuses a missing title, a duplicate id, and an invalid budget", () => {
  const broker = new InMemoryA2ABroker();
  expectBrokerError(() => broker.createGoal({ title: "   ", requester: OPERATOR }), "bad_request", /title/);
  expectBrokerError(() => broker.createGoal({ title: "x", requester: { id: "" } }), "bad_request", /requester/);
  broker.createGoal({ id: "goal-dup", title: "first", requester: OPERATOR });
  expectBrokerError(() => broker.createGoal({ id: "goal-dup", title: "second", requester: OPERATOR }), "invalid_transition", /already exists/);
  expectBrokerError(
    () => broker.createGoal({ title: "bad budget", requester: OPERATOR, budget: { maxChildAttempts: -1 } }),
    "bad_request",
    /budget\.maxChildAttempts/,
  );
  expectBrokerError(
    () => broker.createGoal({ title: "bad deadline", requester: OPERATOR, budget: { deadlineAt: "next tuesday" } }),
    "bad_request",
    /deadlineAt/,
  );
});

test("SQLite store: goals persist in broker_goals and survive a broker restart; snapshot carries no goals", () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-broker-goal-restart-"));
  const dbFile = join(dir, "state.sqlite");
  try {
    const store = new SqliteBrokerStateStore(dbFile);
    const broker = new InMemoryA2ABroker(store, store.load());
    broker.createGoal({ id: "goal-a", title: "A", requester: OPERATOR });
    broker.createGoal({ id: "goal-b", title: "B", requester: OPERATOR });
    assert.equal(broker.exportSnapshot().goals, undefined, "SQLite goals are not duplicated into the snapshot");
    store.close();

    const reopened = new SqliteBrokerStateStore(dbFile);
    try {
      const restarted = new InMemoryA2ABroker(reopened, reopened.load());
      assert.equal(restarted.getGoal("goal-a")?.title, "A");
      assert.deepEqual(restarted.listGoals().map((goal) => goal.id).sort(), ["goal-a", "goal-b"]);
      assert.deepEqual(restarted.listGoals({ status: "paused" }), []);
    } finally {
      reopened.close();
    }
    const db = new DatabaseSync(dbFile);
    try {
      const rows = db.prepare("SELECT id, status FROM broker_goals ORDER BY id").all() as Array<{ id: string; status: string }>;
      assert.deepEqual(rows.map((row) => ({ ...row })), [
        { id: "goal-a", status: "pursuing" },
        { id: "goal-b", status: "pursuing" },
      ]);
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("store without a goal table: goals ride in the snapshot and survive a restart", () => {
  let saved: BrokerSnapshot = emptySnapshot();
  const store: BrokerStateStore = {
    load: () => structuredClone(saved),
    save: (snapshot) => {
      saved = structuredClone(snapshot);
    },
  };
  const broker = new InMemoryA2ABroker(store, store.load());
  assert.equal(broker.exportSnapshot().goals, undefined, "no goals: snapshot shape unchanged");
  broker.createGoal({ id: "goal-json", title: "JSON-backed", requester: OPERATOR });
  assert.deepEqual(saved.goals?.map((goal) => goal.id), ["goal-json"], "createGoal persisted a full snapshot");

  const restarted = new InMemoryA2ABroker(store, store.load());
  assert.equal(restarted.getGoal("goal-json")?.status, "pursuing");
  assert.deepEqual(restarted.listGoals().map((goal) => goal.id), ["goal-json"]);
});

test("task create with a pursuing goal persists goalId in the record JSON and the goal_id column", () => {
  withSqliteBroker((broker, store, dbFile) => {
    broker.createGoal({ id: "goal-live", title: "Live goal", requester: OPERATOR });
    const task = broker.createTask(taskRequest({ id: "task-goal-1", goalId: "goal-live" }));
    assert.equal(task.goalId, "goal-live");
    assert.equal(task.status, "queued");
    assert.equal(broker.getTask("task-goal-1")?.goalId, "goal-live");
    assert.deepEqual(broker.countGoalTasksByStatus("goal-live"), { queued: 1 });

    const db = new DatabaseSync(dbFile);
    try {
      const row = db.prepare("SELECT goal_id, payload FROM broker_tasks WHERE id = ?").get("task-goal-1") as {
        goal_id: string | null;
        payload: string;
      };
      assert.equal(row.goal_id, "goal-live");
      assert.equal(JSON.parse(row.payload).goalId, "goal-live");
    } finally {
      db.close();
    }
    assert.equal(store.readHotTasks({ id: "task-goal-1" })[0]?.goalId, "goal-live");
  });
});

test("task create without goalId is unchanged: no goalId field, NULL column", () => {
  withSqliteBroker((broker, _store, dbFile) => {
    const task = broker.createTask(taskRequest({ id: "task-plain" }));
    assert.equal("goalId" in task, false);
    const db = new DatabaseSync(dbFile);
    try {
      const row = db.prepare("SELECT goal_id FROM broker_tasks WHERE id = ?").get("task-plain") as { goal_id: string | null };
      assert.equal(row.goal_id, null);
    } finally {
      db.close();
    }
  });
});

test("an unknown goalId is refused with not_found and nothing is created", () => {
  withSqliteBroker((broker) => {
    const error = expectBrokerError(
      () => broker.createTask(taskRequest({ id: "task-orphan", goalId: "goal-missing" })),
      "not_found",
      /goal not found/,
    );
    assert.deepEqual(error.details, { goalId: "goal-missing" });
    assert.equal(broker.getTask("task-orphan"), null);
  });
});

test("a goal that is not pursuing is refused with invalid_transition for every other status", () => {
  withSqliteBroker((broker, store) => {
    broker.createGoal({ id: "goal-closed", title: "Closed goal", requester: OPERATOR });
    for (const status of ["paused", "achieved", "blocked", "unmet", "budget_limited", "cleared"] as const) {
      setGoalStatus(store, "goal-closed", status);
      const error = expectBrokerError(
        () => broker.createTask(taskRequest({ id: `task-${status}`, goalId: "goal-closed" })),
        "invalid_transition",
        new RegExp(`is ${status}; tasks may only attach to a pursuing goal`),
      );
      assert.deepEqual(error.details, { goalId: "goal-closed", goalStatus: status });
      assert.equal(broker.getTask(`task-${status}`), null);
    }
    // Back to pursuing: attach succeeds again.
    setGoalStatus(store, "goal-closed", "pursuing");
    assert.equal(broker.createTask(taskRequest({ id: "task-reopened", goalId: "goal-closed" })).goalId, "goal-closed");
  });
});

test("a malformed goalId is bad_request", () => {
  const broker = new InMemoryA2ABroker();
  broker.registerWorker(worker());
  expectBrokerError(() => broker.createTask(taskRequest({ goalId: "  " })), "bad_request", /goalId/);
  expectBrokerError(() => broker.createTask(taskRequest({ goalId: 42 as unknown as string })), "bad_request", /goalId/);
});

test("an idempotent create replay returns the stored task even after the goal stopped pursuing", () => {
  withSqliteBroker((broker, store) => {
    broker.createGoal({ id: "goal-replay", title: "Replay", requester: OPERATOR });
    const first = broker.createTask(taskRequest({ id: "task-replay", goalId: "goal-replay" }));
    setGoalStatus(store, "goal-replay", "paused");
    const replay = broker.createTask(taskRequest({ id: "task-replay", goalId: "goal-replay" }));
    assert.equal(replay.id, first.id);
    assert.equal(replay.goalId, "goal-replay");
  });
});

test("the in-memory broker (no store) enforces the same goal link", () => {
  const broker = new InMemoryA2ABroker();
  broker.registerWorker(worker());
  broker.createGoal({ id: "goal-mem", title: "Memory goal", requester: OPERATOR });
  assert.equal(broker.createTask(taskRequest({ id: "task-mem", goalId: "goal-mem" })).goalId, "goal-mem");
  assert.deepEqual(broker.countGoalTasksByStatus("goal-mem"), { queued: 1 });
  expectBrokerError(() => broker.createTask(taskRequest({ goalId: "goal-nope" })), "not_found");
});
