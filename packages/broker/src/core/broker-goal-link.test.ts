/**
 * Goal persistence and the create-time task goal link (#2499 slice 1).
 *
 * - Goals reuse GoalRecord/GoalStatus and start `pursuing`.
 * - SQLite stores are the goal authority (`broker_goals`, create-only); stores
 *   without a goal table (the JSON-file store) carry broker-held goals in
 *   their snapshot.
 * - createGoal validates the id pattern and text limits and appends a
 *   `goal.created` audit event.
 * - A task `goalId` must name an existing `pursuing` goal: unknown is
 *   `not_found`, non-pursuing is `invalid_transition`; absent is unchanged.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { BrokerError, InMemoryA2ABroker } from "./broker.js";
import { GOAL_ID_PATTERN, taskSchema } from "./store-schemas.js";
import { emptySnapshot, JsonFileBrokerStateStore, SqliteBrokerStateStore } from "./store/store.js";
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

/**
 * Slice 1 has no goal transition (the store is create-only), so tests move a
 * goal out of `pursuing` by editing its row directly, as an operator would.
 */
function setGoalStatus(dbFile: string, goalId: string, status: GoalRecord["status"]): void {
  const db = new DatabaseSync(dbFile);
  try {
    const row = db.prepare("SELECT payload FROM broker_goals WHERE id = ?").get(goalId) as { payload: string } | undefined;
    assert.ok(row, `goal ${goalId} must exist`);
    const updatedAt = new Date().toISOString();
    const next = { ...JSON.parse(row.payload), status, updatedAt };
    db.prepare("UPDATE broker_goals SET status = ?, updated_at = ?, payload = ? WHERE id = ?")
      .run(status, updatedAt, JSON.stringify(next), goalId);
  } finally {
    db.close();
  }
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
  assert.match(generated.id, GOAL_ID_PATTERN, "generated UUIDs satisfy the goal id pattern");
  assert.equal(generated.objective, "Explicit objective");
});

test("createGoal enforces the goal id pattern (never trims) and the title/objective limits", () => {
  const broker = new InMemoryA2ABroker();
  for (const id of [" goal-1", "goal-1 ", "goal 1", "", "goal/1", "a".repeat(129), 7 as unknown as string]) {
    expectBrokerError(() => broker.createGoal({ id, title: "t", requester: OPERATOR }), "bad_request", /goal id must match/);
  }
  assert.equal(broker.listGoals().length, 0, "no rejected id was created, trimmed or not");
  assert.equal(broker.createGoal({ id: "Goal_1.a:b-c", title: "t", requester: OPERATOR }).id, "Goal_1.a:b-c");
  assert.equal(broker.createGoal({ id: "a".repeat(128), title: "t", requester: OPERATOR }).id.length, 128);

  expectBrokerError(() => broker.createGoal({ title: "x".repeat(201), requester: OPERATOR }), "bad_request", /title must be at most 200 characters/);
  assert.equal(broker.createGoal({ title: `  ${"x".repeat(200)}  `, requester: OPERATOR }).title.length, 200, "limit applies after trimming");
  expectBrokerError(
    () => broker.createGoal({ title: "t", objective: "o".repeat(2001), requester: OPERATOR }),
    "bad_request",
    /objective must be at most 2000 characters/,
  );
  assert.equal(broker.createGoal({ title: "t", objective: "o".repeat(2000), requester: OPERATOR }).objective.length, 2000);
  expectBrokerError(
    () => broker.createGoal({ title: "t", objective: 5 as unknown as string, requester: OPERATOR }),
    "bad_request",
    /objective must be a string/,
  );
});

test("createGoal appends a goal.created audit event attributed to the requester", () => {
  const broker = new InMemoryA2ABroker();
  const goal = broker.createGoal({ id: "goal-audited", title: "Audited goal", requester: OPERATOR });
  const events = broker.listAuditEvents({ action: "goal.created" });
  assert.equal(events.length, 1);
  assert.equal(events[0]?.actorId, OPERATOR.id);
  assert.equal(events[0]?.targetType, "goal");
  assert.equal(events[0]?.targetId, goal.id);
  assert.equal(events[0]?.note, "Audited goal");
  // A refused create records nothing.
  expectBrokerError(() => broker.createGoal({ id: "goal-audited", title: "again", requester: OPERATOR }), "invalid_transition");
  assert.equal(broker.listAuditEvents({ action: "goal.created" }).length, 1);
});

test("SQLite: createGoal is create-only; a primary-key conflict at insert is 409 and rolls the audit event back", () => {
  withSqliteBroker((broker, store) => {
    broker.createGoal({ id: "goal-race", title: "first", requester: OPERATOR });
    assert.equal(broker.listAuditEvents({ action: "goal.created" }).length, 1);
    // Hide the row from the broker's pre-check so the create reaches the
    // INSERT, as a concurrent writer would.
    const readGoal = store.readGoal.bind(store);
    store.readGoal = () => undefined;
    try {
      expectBrokerError(
        () => broker.createGoal({ id: "goal-race", title: "second", requester: OPERATOR }),
        "invalid_transition",
        /goal 'goal-race' already exists/,
      );
    } finally {
      store.readGoal = readGoal;
    }
    assert.equal(store.readGoal("goal-race")?.title, "first", "the stored goal was not overwritten");
    assert.equal(broker.listAuditEvents({ action: "goal.created" }).length, 1, "no audit event for the refused create");
  });
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

test("JSON-file store (no goal table): goals ride in the snapshot file and survive a restart; goal-less snapshots are unchanged", () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-broker-goal-json-"));
  const stateFile = join(dir, "state.json");
  try {
    const store = new JsonFileBrokerStateStore(stateFile);
    const broker = new InMemoryA2ABroker(store, store.load());
    broker.registerWorker(worker());
    broker.createTask(taskRequest({ id: "task-before-goals" }));
    const before = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.equal("goals" in before, false, "no goals: the snapshot has no goals field");
    assert.equal("goalId" in before.tasks[0], false, "a task without a goal serializes without goalId");

    broker.createGoal({ id: "goal-json", title: "JSON-backed", requester: OPERATOR });
    const onDisk = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.deepEqual(onDisk.goals.map((goal: GoalRecord) => goal.id), ["goal-json"], "createGoal persisted a full snapshot");

    // Restart on the same file: the real loader (parseSnapshotPayload with the
    // passthrough brokerSnapshotSchema) keeps the field and loadSnapshot
    // validates it.
    const reopened = new JsonFileBrokerStateStore(stateFile);
    const restarted = new InMemoryA2ABroker(reopened, reopened.load());
    assert.equal(restarted.getGoal("goal-json")?.status, "pursuing");
    assert.deepEqual(restarted.listGoals().map((goal) => goal.id), ["goal-json"]);
    const linked = restarted.createTask(taskRequest({ id: "task-after-restart", goalId: "goal-json" }));
    assert.equal(linked.goalId, "goal-json");
    assert.deepEqual(restarted.countGoalTasksByStatus("goal-json"), { queued: 1 });
    expectBrokerError(
      () => restarted.createGoal({ id: "goal-json", title: "dup", requester: OPERATOR }),
      "invalid_transition",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("JSON-file store: an invalid goal entry is dropped on load and logged as record_quarantined; valid ones load", () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-broker-goal-json-bad-"));
  const stateFile = join(dir, "state.json");
  const warnings: string[] = [];
  const originalWarn = console.warn;
  try {
    const valid = new InMemoryA2ABroker().createGoal({ id: "goal-ok", title: "ok", requester: OPERATOR });
    const invalid = { ...valid, id: "goal bad", status: "active" };
    writeFileSync(stateFile, JSON.stringify({ ...emptySnapshot(), goals: [valid, invalid] }));
    console.warn = (message?: unknown) => {
      warnings.push(String(message));
    };
    const store = new JsonFileBrokerStateStore(stateFile);
    const broker = new InMemoryA2ABroker(store, store.load());
    console.warn = originalWarn;

    assert.deepEqual(broker.listGoals().map((goal) => goal.id), ["goal-ok"]);
    const quarantined = warnings
      .map((line) => {
        try {
          return JSON.parse(line) as Record<string, unknown>;
        } catch {
          return undefined;
        }
      })
      .filter((event) => event?.event === "broker.snapshot.record_quarantined");
    assert.equal(quarantined.length, 1);
    assert.equal(quarantined[0]?.collection, "goals");
    assert.equal(quarantined[0]?.index, 1);
    assert.equal(quarantined[0]?.recordId, "goal bad");
    assert.ok((quarantined[0]?.issues as string[]).some((issue) => issue.startsWith("id:")));
    assert.ok((quarantined[0]?.issues as string[]).some((issue) => issue.startsWith("status:")));
  } finally {
    console.warn = originalWarn;
    rmSync(dir, { recursive: true, force: true });
  }
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
  withSqliteBroker((broker, _store, dbFile) => {
    broker.createGoal({ id: "goal-closed", title: "Closed goal", requester: OPERATOR });
    for (const status of ["paused", "achieved", "blocked", "unmet", "budget_limited", "cleared"] as const) {
      setGoalStatus(dbFile, "goal-closed", status);
      const error = expectBrokerError(
        () => broker.createTask(taskRequest({ id: `task-${status}`, goalId: "goal-closed" })),
        "invalid_transition",
        new RegExp(`is ${status}; tasks may only attach to a pursuing goal`),
      );
      assert.deepEqual(error.details, { goalId: "goal-closed", goalStatus: status });
      assert.equal(broker.getTask(`task-${status}`), null);
    }
    // Back to pursuing: attach succeeds again.
    setGoalStatus(dbFile, "goal-closed", "pursuing");
    assert.equal(broker.createTask(taskRequest({ id: "task-reopened", goalId: "goal-closed" })).goalId, "goal-closed");
  });
});

test("a malformed goalId is bad_request (pattern, never trimmed), even when the goal exists or the call is a replay", () => {
  const broker = new InMemoryA2ABroker();
  broker.registerWorker(worker());
  broker.createGoal({ id: "goal-x", title: "x", requester: OPERATOR });
  for (const goalId of ["  ", " goal-x", "goal-x ", "goal x", "", "a".repeat(129), 42, null]) {
    expectBrokerError(
      () => broker.createTask(taskRequest({ goalId: goalId as unknown as string })),
      "bad_request",
      /goalId/,
    );
  }
  // The shape check runs before the idempotent-replay branch.
  broker.createTask(taskRequest({ id: "task-shape", goalId: "goal-x" }));
  expectBrokerError(() => broker.createTask(taskRequest({ id: "task-shape", goalId: " goal-x" })), "bad_request", /goalId/);
  assert.equal(broker.listTasks().length, 1);
});

test("the task schemas carry goalId as optional with the goal id pattern; a goal-less task parses without the key", () => {
  const base = {
    id: "t",
    intent: "chat",
    requester: { id: "hub" },
    target: { id: "w" },
    targetNodeId: "w",
    payload: {},
    status: "queued",
    createdAt: "2026-11-06T00:00:00.000Z",
    updatedAt: "2026-11-06T00:00:00.000Z",
    taskOrigin: "api",
  };
  const parsed = taskSchema.parse(base);
  assert.equal("goalId" in parsed, false, "no default: shape unchanged for tasks without a goal");
  assert.equal(taskSchema.parse({ ...base, goalId: "goal-1" }).goalId, "goal-1");
  assert.equal(taskSchema.safeParse({ ...base, goalId: " goal-1" }).success, false);
});

test("an idempotent create replay returns the stored task even after the goal stopped pursuing", () => {
  withSqliteBroker((broker, _store, dbFile) => {
    broker.createGoal({ id: "goal-replay", title: "Replay", requester: OPERATOR });
    const first = broker.createTask(taskRequest({ id: "task-replay", goalId: "goal-replay" }));
    setGoalStatus(dbFile, "goal-replay", "paused");
    const replay = broker.createTask(taskRequest({ id: "task-replay", goalId: "goal-replay" }));
    assert.equal(replay.id, first.id);
    assert.equal(replay.goalId, "goal-replay");
  });
});

test("legacy idempotent replay with only goalId differing returns the stored task unchanged (goalId ignored, like every other field)", () => {
  withSqliteBroker((broker) => {
    broker.createGoal({ id: "goal-a", title: "A", requester: OPERATOR });
    broker.createGoal({ id: "goal-b", title: "B", requester: OPERATOR });
    const first = broker.createTask(taskRequest({ id: "task-relink", goalId: "goal-a" }));
    for (const goalId of ["goal-b", "goal-missing", undefined]) {
      const replay = broker.createTask(taskRequest({ id: "task-relink", ...(goalId ? { goalId } : {}) }));
      assert.equal(replay.goalId, "goal-a", `replay with goalId=${String(goalId)} keeps the stored link`);
      assert.equal(replay.createdAt, first.createdAt);
    }
    assert.deepEqual(broker.countGoalTasksByStatus("goal-a"), { queued: 1 });
    assert.deepEqual(broker.countGoalTasksByStatus("goal-b"), {});
    assert.equal(broker.listAuditEvents({ action: "task.create_idempotent_hit" }).length, 3);
  });
});

test("a class-aware retry inherits the root task's goalId (same lineage, not a new admission)", () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-broker-goal-retry-"));
  const dbFile = join(dir, "state.sqlite");
  const store = new SqliteBrokerStateStore(dbFile);
  try {
    const broker = new InMemoryA2ABroker(store, store.load(), { maxRequeueAttempts: 3 });
    broker.registerWorker(worker());
    broker.createGoal({ id: "goal-retry", title: "Retry goal", requester: OPERATOR });
    const task = broker.createTask(
      taskRequest({
        id: "task-retry-root",
        goalId: "goal-retry",
        payload: { retryPolicy: { maxRetries: 1, retryOn: ["environment"], backoffMs: 0 } },
      }),
    );
    broker.claimTask(task.id, "worker-a");
    broker.startTask(task.id, "worker-a");
    const failed = broker.failTask(task.id, "worker-a", {
      code: "handler_exit_nonzero",
      message: "handler failed",
      details: { stage: "handler", nestedError: { code: "openclaw_analysis_failed" } },
    });
    assert.ok(failed.retriedBy, "a retry was scheduled");
    const retry = broker.getTask(failed.retriedBy!);
    assert.equal(retry?.goalId, "goal-retry");
    assert.equal(retry?.retryOfTaskId, task.id);
    assert.deepEqual(broker.countGoalTasksByStatus("goal-retry"), { failed: 1, queued: 1 });

    // A retry of a goal-less task stays goal-less.
    const plain = broker.createTask(
      taskRequest({ id: "task-retry-plain", payload: { retryPolicy: { maxRetries: 1, retryOn: ["environment"], backoffMs: 0 } } }),
    );
    broker.claimTask(plain.id, "worker-a");
    broker.startTask(plain.id, "worker-a");
    const plainFailed = broker.failTask(plain.id, "worker-a", {
      code: "handler_exit_nonzero",
      message: "handler failed",
      details: { stage: "handler", nestedError: { code: "openclaw_analysis_failed" } },
    });
    assert.equal("goalId" in (broker.getTask(plainFailed.retriedBy!) ?? {}), false);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the in-memory broker (no store) enforces the same goal link", () => {
  const broker = new InMemoryA2ABroker();
  broker.registerWorker(worker());
  broker.createGoal({ id: "goal-mem", title: "Memory goal", requester: OPERATOR });
  assert.equal(broker.createTask(taskRequest({ id: "task-mem", goalId: "goal-mem" })).goalId, "goal-mem");
  assert.deepEqual(broker.countGoalTasksByStatus("goal-mem"), { queued: 1 });
  expectBrokerError(() => broker.createTask(taskRequest({ goalId: "goal-nope" })), "not_found");
});
