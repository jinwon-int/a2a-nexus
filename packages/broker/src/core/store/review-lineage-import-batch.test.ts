/**
 * #2512 regression: the legacy review-lineage import must never open a nested
 * transaction.
 *
 * On the in-process SQLite topology (BROKER_PERSISTENCE_BACKEND=sqlite, no
 * worker-thread persistence) every broker mutation runs inside
 * `commitMutation` -> `store.runBatch`, and once the 5-minute full-save
 * cadence elapses `persistState` calls `store.save()` from inside that open
 * transaction. `save()` used to run `importLegacySnapshot`, which issued its
 * own `BEGIN IMMEDIATE` unconditionally, so the mutation failed with
 * `cannot start a transaction within a transaction` and the batch (task row,
 * audit, tombstone, spend row) rolled back while memory had already moved on.
 *
 * Covered here:
 * - a full save inside commitMutation (shifted clock) on both load sources and
 *   both in-process wirings: the completion succeeds and the terminal task row,
 *   its spend row and the canonical snapshot are on disk after a reopen;
 * - `store.runBatch(() => store.save(snapshot))` directly;
 * - a never-imported legacy snapshot is imported exactly once, both at load
 *   (outside any batch) and on a save that runs inside a batch, and later saves
 *   neither re-import nor throw; a rolled-back batch leaves no import marker;
 * - over HTTP on a default in-process SQLite server, POST /tasks/:id/complete
 *   after the clock shift returns 200 and the disk row is terminal;
 * - worker-thread persistence (unaffected by the bug, import deferred to the
 *   worker thread) still imports a legacy snapshot exactly once.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";

import { intentHash } from "a2a-review-lifecycle";
import type { IntentContractV1, ReviewLineageBudgetV1, ReviewLineageRecord } from "a2a-review-lifecycle";

import { jsonHeaders, startTestServer } from "../../server-test-helpers.js";
import { InMemoryA2ABroker } from "../broker.js";
import type { CreateTaskRequest } from "../types.js";
import {
  REVIEW_LINEAGE_OBSERVATION_LINEAGE_TABLE,
  REVIEW_LINEAGE_OBSERVATION_META_TABLE,
} from "./review-lineage-observation-store.js";
import { ReviewLineageStore } from "./review-lineage-store.js";
import { createWorkerThreadPersistence } from "./sqlite-worker-thread-persistence.js";
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
  type SqliteBrokerLoadSource,
} from "./store.js";

// Past the broker's HOT_PERSIST_FULL_RETENTION_INTERVAL_MS (5 minutes), so the
// next mutation's persistState performs a full save inside commitMutation.
const PAST_FULL_SAVE_INTERVAL_MS = 6 * 60_000;
const LOAD_SOURCES: readonly SqliteBrokerLoadSource[] = ["snapshot", "hot-tables"];
const WIRINGS = ["hints", "repositories"] as const;
type Wiring = (typeof WIRINGS)[number];

const TELEMETRY = {
  schemaVersion: "a2a.analysis-execution-telemetry.v1",
  source: "claude_cli_envelope",
  elapsedMs: 1200,
  modelRequests: 1,
  inputTokens: 10,
  outputTokens: 20,
  costUsd: 0.01,
};

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function taskRequest(id: string): CreateTaskRequest {
  return {
    id,
    intent: "analyze",
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    assignedWorkerId: "worker-a",
    message: `task ${id}`,
    payload: {},
  };
}

/** Repositories wiring mirrors server.ts for an in-process SQLite store; hints wiring has none. */
function repositoriesFor(store: SqliteBrokerStateStore, wiring: Wiring) {
  if (wiring === "hints") return {};
  return {
    taskRepository: new SqliteTaskRuntimeRepository(store),
    auditRepository: new SqliteAuditRuntimeRepository(store),
    tombstoneRepository: new SqliteTombstoneRuntimeRepository(store),
    workerRepository: new SqliteWorkerRuntimeRepository(store),
    exchangeRepository: new SqliteExchangeRuntimeRepository(store),
    exchangeMessageRepository: new SqliteExchangeMessageRuntimeRepository(store),
    proposalRepository: new SqliteProposalRuntimeRepository(store),
    artifactRepository: new SqliteArtifactRuntimeRepository(store),
    validationRepository: new SqliteValidationRuntimeRepository(store),
  };
}

function openBroker(store: SqliteBrokerStateStore, wiring: Wiring): InMemoryA2ABroker {
  return new InMemoryA2ABroker(store, store.load(), repositoriesFor(store, wiring));
}

/** Record the persistence mode of every persistState call (proves the full-save path ran). */
function recordPersistModes(broker: InMemoryA2ABroker): string[] {
  const modes: string[] = [];
  broker.subscribeToProfiling((sample) => {
    if (sample.operation === "persistState" && sample.persistenceMode) modes.push(sample.persistenceMode);
  });
  return modes;
}

function registerWorker(broker: InMemoryA2ABroker, nodeId = "worker-a"): void {
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

function query<T>(dbFile: string, sql: string, ...params: string[]): T[] {
  const db = new DatabaseSync(dbFile);
  try {
    return db.prepare(sql).all(...params).map((row) => ({ ...row })) as T[];
  } finally {
    db.close();
  }
}

function importMarkerCount(dbFile: string): number {
  return query<{ count: number }>(
    dbFile,
    `SELECT COUNT(*) AS count FROM ${REVIEW_LINEAGE_OBSERVATION_META_TABLE} WHERE key = 'legacy_snapshot_import_v1'`,
  )[0]!.count;
}

function lineageRowIds(dbFile: string): string[] {
  return query<{ lineage_id: string }>(
    dbFile,
    `SELECT lineage_id FROM ${REVIEW_LINEAGE_OBSERVATION_LINEAGE_TABLE} ORDER BY lineage_id`,
  ).map((row) => row.lineage_id);
}

function legacyLineage(lineageId: string, state: "created" | "canceled" = "canceled"): ReviewLineageRecord {
  const partial = {
    kind: "IntentContractV1" as const,
    lineageId,
    goal: "Legacy lineage carried by a canonical snapshot.",
    nonGoals: ["None."],
    invariants: ["Imported once."],
    acceptanceCriteria: [{ id: "AC-1", text: "Imported once." }],
    declaredPaths: { allowed: ["packages/broker/src/core/**"], forbidden: [] },
    baseSha: "2".repeat(40),
    headSha: "3".repeat(40),
    createdAt: "2026-07-23T14:20:00Z",
  };
  const contract: IntentContractV1 = {
    ...partial,
    intentHash: intentHash(partial as unknown as Record<string, unknown>),
  };
  const budget: ReviewLineageBudgetV1 = {
    kind: "ReviewLineageBudgetV1",
    maxWallClockSeconds: 21600,
    maxCorrectionGenerations: 1,
    maxReviewerRuns: 2,
    maxReviewerReplacements: 1,
    repeatedFindingThreshold: 2,
    onExhaustion: "blocked_needs_operator",
  };
  const lineages = new ReviewLineageStore();
  const created = lineages.create({ contract, budget, diffHash: `sha256:${"b".repeat(64)}`, at: "2026-07-23T14:20:00Z" });
  if (state === "created") return created;
  return lineages.apply(lineageId, { type: "operator_cancel", at: "2026-07-23T14:22:00Z", detail: "legacy closeout" }).record;
}

/** Count `importLegacySnapshot` calls on the store's canonical lineage store (test-only spy). */
function countLegacyImports(store: SqliteBrokerStateStore): { readonly count: number } {
  const target = (store as unknown as {
    reviewLineageObservations: { importLegacySnapshot: (...args: unknown[]) => unknown };
  }).reviewLineageObservations;
  const original = target.importLegacySnapshot.bind(target);
  const state = { count: 0 };
  target.importLegacySnapshot = (...args: unknown[]) => {
    state.count += 1;
    return original(...args);
  };
  return state;
}

/** Freeze Date at the real current time so the test can step past the full-save interval. */
function freezeClock(t: TestContext): { advance(ms: number): void } {
  let now = Date.now();
  t.mock.timers.enable({ apis: ["Date"], now });
  return {
    advance(ms: number) {
      now += ms;
      t.mock.timers.setTime(now);
    },
  };
}

/**
 * Seed a canonical snapshot that carries `reviewLineages` without writing the
 * import marker: the shape of a store written before the dedicated lineage
 * tables existed (#1629).
 */
function seedLegacySnapshot(dbFile: string, records: ReviewLineageRecord[]): void {
  const seed = new SqliteBrokerStateStore(dbFile, { deferReviewLineageImport: true });
  try {
    seed.save({ ...emptySnapshot(), reviewLineages: records });
  } finally {
    seed.close();
  }
  assert.equal(importMarkerCount(dbFile), 0, "seed: the legacy snapshot is not imported yet");
}

// --- A full save inside commitMutation --------------------------------------------

for (const loadSource of LOAD_SOURCES) {
  for (const wiring of WIRINGS) {
    test(`[${loadSource}/${wiring}] a full save inside commitMutation commits the terminal transition and its spend row (#2512)`, (t) => {
      const clock = freezeClock(t);
      const dir = tempDir("a2a-2512-full-save-");
      const dbFile = join(dir, "state.sqlite");
      try {
        const store = new SqliteBrokerStateStore(dbFile, { loadSource });
        try {
          const broker = openBroker(store, wiring);
          registerWorker(broker);
          broker.createTask(taskRequest("task-2512"));
          broker.claimTask("task-2512", "worker-a");
          broker.startTask("task-2512", "worker-a");
          const commitsBefore = store.commits;
          const modes = recordPersistModes(broker);

          clock.advance(PAST_FULL_SAVE_INTERVAL_MS);
          const done = broker.completeTask("task-2512", "worker-a", {
            summary: "done",
            output: { executionTelemetry: TELEMETRY },
          });
          assert.equal(done.status, "succeeded");
          assert.deepEqual(modes, ["full"], "the completion persisted through the full save");
          assert.equal(store.commits - commitsBefore, 1, "the full save joined the mutation's single commit");
        } finally {
          store.close();
        }

        // A restart reads the hot tables (the source both load sources keep
        // current through hints/repositories); the terminal row must be there or
        // the stale reaper requeues the task and the work runs twice.
        const reopened = new SqliteBrokerStateStore(dbFile, { loadSource: "hot-tables" });
        try {
          assert.equal(reopened.readHotTasks({ id: "task-2512" })[0]?.status, "succeeded", "terminal hot row on disk");
          assert.equal(
            reopened.load().tasks.find((task) => task.id === "task-2512")?.status,
            "succeeded",
            "a restart loads the terminal task, so nothing requeues it",
          );
        } finally {
          reopened.close();
        }
        assert.deepEqual(
          query<{ task_id: string }>(dbFile, "SELECT task_id FROM broker_spend_events"),
          [{ task_id: "task-2512" }],
          "the spend row committed with the terminal row",
        );
        assert.equal(importMarkerCount(dbFile), 1, "the legacy import ran exactly once");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
}

// --- Direct store control cases ---------------------------------------------------

test("store.runBatch(() => store.save(snapshot)) succeeds before and after the import marker exists (#2512)", () => {
  const dir = tempDir("a2a-2512-run-batch-");
  const dbFile = join(dir, "state.sqlite");
  try {
    const store = new SqliteBrokerStateStore(dbFile);
    try {
      // Fresh store: no marker yet, so this save performs the one-time import
      // inside the open batch.
      store.runBatch(() => store.save(emptySnapshot()));
      assert.equal(importMarkerCount(dbFile), 1);
      // Marker present: the steady-state save path.
      store.runBatch(() => store.save(emptySnapshot()));
      store.save(emptySnapshot());
      assert.equal(importMarkerCount(dbFile), 1);
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a legacy import inside a batch rolls back with the batch: no marker, no rows (#2512)", () => {
  const dir = tempDir("a2a-2512-rollback-");
  const dbFile = join(dir, "state.sqlite");
  try {
    const store = new SqliteBrokerStateStore(dbFile);
    try {
      assert.throws(
        () => store.runBatch(() => {
          store.save({ ...emptySnapshot(), reviewLineages: [legacyLineage("legacy-rollback")] });
          throw new Error("forced_outer_failure");
        }),
        /forced_outer_failure/,
      );
      assert.equal(importMarkerCount(dbFile), 0, "the marker rolled back with the outer batch");
      assert.deepEqual(lineageRowIds(dbFile), []);

      // The next save still imports, exactly once.
      store.runBatch(() => store.save({ ...emptySnapshot(), reviewLineages: [legacyLineage("legacy-rollback")] }));
      assert.equal(importMarkerCount(dbFile), 1);
      assert.deepEqual(lineageRowIds(dbFile), ["legacy-rollback"]);
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- Legacy snapshot import: exactly once -----------------------------------------

for (const loadSource of LOAD_SOURCES) {
  test(`[${loadSource}] a never-imported legacy snapshot is imported once at load, and full saves in a batch never re-import (#2512)`, (t) => {
    const clock = freezeClock(t);
    const dir = tempDir("a2a-2512-legacy-load-");
    const dbFile = join(dir, "state.sqlite");
    try {
      seedLegacySnapshot(dbFile, [legacyLineage("legacy-load")]);

      const store = new SqliteBrokerStateStore(dbFile, { loadSource });
      try {
        const imports = countLegacyImports(store);
        const broker = openBroker(store, "repositories");
        assert.equal(imports.count, 1, "load performed the one-time import, outside any batch");
        assert.equal(importMarkerCount(dbFile), 1);
        assert.deepEqual(lineageRowIds(dbFile), ["legacy-load"]);
        assert.equal(broker.getReviewLineage("legacy-load")?.state, "canceled");

        registerWorker(broker);
        broker.createTask(taskRequest("task-legacy"));
        broker.claimTask("task-legacy", "worker-a");
        const modes = recordPersistModes(broker);
        clock.advance(PAST_FULL_SAVE_INTERVAL_MS);
        assert.equal(broker.completeTask("task-legacy", "worker-a", { summary: "done" }).status, "succeeded");
        clock.advance(PAST_FULL_SAVE_INTERVAL_MS);
        broker.createTask(taskRequest("task-legacy-next"));
        assert.deepEqual(modes, ["full", "full"], "both mutations persisted through the full save");
        assert.equal(imports.count, 1, "the steady-state save path never calls the import");
      } finally {
        store.close();
      }
      assert.equal(importMarkerCount(dbFile), 1);
      assert.deepEqual(lineageRowIds(dbFile), ["legacy-load"]);
      const reopened = new SqliteBrokerStateStore(dbFile, { loadSource });
      try {
        assert.equal(reopened.readHotTasks({ id: "task-legacy" })[0]?.status, "succeeded");
        assert.equal(reopened.listCanonicalReviewLineages()[0]?.state, "canceled");
      } finally {
        reopened.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("a legacy snapshot first seen by a save inside a batch is imported once; a later stale save neither re-imports nor throws (#2512)", () => {
  const dir = tempDir("a2a-2512-legacy-save-");
  const dbFile = join(dir, "state.sqlite");
  try {
    const store = new SqliteBrokerStateStore(dbFile);
    try {
      store.runBatch(() => store.save({ ...emptySnapshot(), reviewLineages: [legacyLineage("legacy-save")] }));
      assert.equal(importMarkerCount(dbFile), 1);
      assert.deepEqual(lineageRowIds(dbFile), ["legacy-save"]);

      const imports = countLegacyImports(store);
      const stale = legacyLineage("legacy-save", "created");
      store.runBatch(() => store.save({ ...emptySnapshot(), reviewLineages: [stale, legacyLineage("legacy-late")] }));
      store.save({ ...emptySnapshot(), reviewLineages: [stale] });
      assert.equal(imports.count, 0, "once the marker exists save does not import");
      assert.equal(importMarkerCount(dbFile), 1);
      assert.deepEqual(lineageRowIds(dbFile), ["legacy-save"], "a stale snapshot cannot add or overwrite rows");
      assert.equal(store.load().reviewLineages?.[0]?.state, "canceled");
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- Over HTTP on a default in-process SQLite server -----------------------------

for (const loadSource of LOAD_SOURCES) {
  test(`[${loadSource}] POST /tasks/:id/complete after the full-save interval returns 200 and the disk row is terminal (#2512)`, async (t) => {
    const clock = freezeClock(t);
    const dir = tempDir("a2a-2512-http-");
    const sqliteFile = join(dir, "state.sqlite");
    const server = await startTestServer({
      // `stateStore: undefined`: not an injected store, so server.ts builds the
      // default in-process SQLite store with the repositories wiring.
      stateStore: undefined,
      persistenceBackend: "sqlite",
      stateFile: join(dir, "state.json"),
      sqliteFile,
      sqliteLoadSource: loadSource,
      // Keep the serving fence inside this test's temp dir.
      sharedStateFile: join(dir, "serving-fence.sqlite"),
      enforceRequesterIdentity: false,
    });
    try {
      const broker = server.runtime.broker;
      registerWorker(broker);
      broker.createTask(taskRequest("task-http-2512"));
      broker.claimTask("task-http-2512", "worker-a");
      broker.startTask("task-http-2512", "worker-a");

      clock.advance(PAST_FULL_SAVE_INTERVAL_MS);
      const res = await fetch(`${server.baseUrl}/tasks/task-http-2512/complete`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ workerId: "worker-a", result: { summary: "done" } }),
      });
      assert.equal(res.status, 200, await res.text());
    } finally {
      await server.close();
    }
    try {
      assert.deepEqual(
        query<{ status: string }>(sqliteFile, "SELECT status FROM broker_tasks WHERE id = 'task-http-2512'"),
        [{ status: "succeeded" }],
        "disk status is terminal",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

// --- Worker-thread persistence: unchanged, still exactly one import ---------------

test("worker-thread persistence still imports a legacy snapshot exactly once, on the worker thread (#2512)", async () => {
  const dir = tempDir("a2a-2512-worker-thread-");
  const dbFile = join(dir, "state.sqlite");
  try {
    seedLegacySnapshot(dbFile, [legacyLineage("legacy-worker")]);
    const handle = createWorkerThreadPersistence({ dbFile, queueCapacity: 4 });
    try {
      const loaded = handle.stateStore.load();
      assert.equal(importMarkerCount(dbFile), 0, "the main-thread proxy defers the import (deferReviewLineageImport)");
      assert.deepEqual(loaded.reviewLineages?.map((record) => record.lineageId), ["legacy-worker"]);

      handle.stateStore.save(loaded);
      await handle.stateStore.awaitDurablePersistenceAck();
      assert.equal(importMarkerCount(dbFile), 1, "the worker thread imported on its first save");
      assert.deepEqual(lineageRowIds(dbFile), ["legacy-worker"]);

      handle.stateStore.save({ ...loaded, reviewLineages: [legacyLineage("legacy-worker", "created"), legacyLineage("legacy-late")] });
      await handle.stateStore.awaitDurablePersistenceAck();
      assert.equal(importMarkerCount(dbFile), 1);
      assert.deepEqual(lineageRowIds(dbFile), ["legacy-worker"], "no second import");
      assert.equal(handle.stateStore.listCanonicalReviewLineages()[0]?.state, "canceled");
    } finally {
      await handle.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
