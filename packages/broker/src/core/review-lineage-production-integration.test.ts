import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { intentHash } from "../review-lifecycle/canonical-json.js";
import {
  parseReviewLineageObservation,
  type ProjectedReviewLineageObservation,
} from "../review-lifecycle/observation.js";
import type {
  IntentContractV1,
  ReviewLineageBudgetV1,
} from "../review-lifecycle/types.js";
import { InMemoryA2ABroker } from "./broker.js";
import {
  REVIEW_LINEAGE_OBSERVATION_LEDGER_TABLE,
} from "./review-lineage-observation-store.js";
import { ReviewLineageStore } from "./review-lineage-store.js";
import { emptySnapshot, SqliteBrokerStateStore } from "./store.js";
import { createWorkerThreadPersistence } from "./sqlite-worker-thread-persistence.js";

const BASE_SHA = "2".repeat(40);
const HEAD_SHA = "3".repeat(40);
const DIFF_HASH = `sha256:${"b".repeat(64)}`;
const T0 = "2026-07-23T14:20:00Z";

function contract(lineageId = "pr-1518-phase10"): IntentContractV1 {
  const partial = {
    kind: "IntentContractV1" as const,
    lineageId,
    goal: "Make production lineage persistence atomic.",
    nonGoals: ["Do not attach an automatic producer."],
    invariants: ["Lineage and ledger share one commit."],
    acceptanceCriteria: [
      { id: "AC-1", text: "Worker-thread mode sends one compound command." },
    ],
    declaredPaths: {
      allowed: ["packages/broker/src/core/**"],
      forbidden: ["packages/broker/src/worker.ts"],
    },
    baseSha: BASE_SHA,
    headSha: HEAD_SHA,
    createdAt: T0,
  };
  return {
    ...partial,
    intentHash: intentHash(partial as unknown as Record<string, unknown>),
  };
}

function budget(): ReviewLineageBudgetV1 {
  return {
    kind: "ReviewLineageBudgetV1",
    maxWallClockSeconds: 21600,
    maxCorrectionGenerations: 1,
    maxReviewerRuns: 2,
    maxReviewerReplacements: 1,
    repeatedFindingThreshold: 2,
    onExhaustion: "blocked_needs_operator",
  };
}

function binding(lineageId = "pr-1518-phase10") {
  return {
    intentHash: contract(lineageId).intentHash,
    headSha: HEAD_SHA,
    diffHash: DIFF_HASH,
  };
}

function createCommand(
  lineageId = "pr-1518-phase10",
  sourceEventId = "phase10:create:1",
): ProjectedReviewLineageObservation {
  return parseReviewLineageObservation({
    kind: "a2a.review-lineage-observation.v1",
    producerId: "dispatcher-seoseo",
    sourceEventId,
    lineageId,
    observedAt: T0,
    binding: binding(lineageId),
    observation: {
      kind: "lineage_create",
      mode: "record",
      contract: contract(lineageId),
      budget: budget(),
    },
  });
}

function cancelCommand(
  lineageId = "pr-1518-phase10",
  sourceEventId = "phase10:cancel:1",
): ProjectedReviewLineageObservation {
  return parseReviewLineageObservation({
    kind: "a2a.review-lineage-observation.v1",
    producerId: "dispatcher-seoseo",
    sourceEventId,
    lineageId,
    observedAt: "2026-07-23T14:21:00Z",
    binding: binding(lineageId),
    observation: {
      kind: "operator_cancel",
    },
  });
}

function tempDatabase(prefix: string): {
  dir: string;
  dbFile: string;
} {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, dbFile: join(dir, "state.sqlite") };
}

test("production SQLite authority applies observations before refreshing broker projection", async () => {
  const { dir, dbFile } = tempDatabase("a2a-review-production-");
  try {
    const store = new SqliteBrokerStateStore(dbFile);
    const broker = new InMemoryA2ABroker(
      store,
      store.load(),
      { reviewLineageMode: "record" },
    );

    assert.throws(
      () => broker.createReviewLineage({ contract: contract(), at: T0 }),
      /review_lineage_atomic_observation_required/,
    );
    assert.equal(
      (await broker.applyReviewLineageObservation(createCommand()))?.status,
      "applied",
    );
    assert.equal(
      broker.getReviewLineage("pr-1518-phase10", T0)?.state,
      "reviewing_initial",
    );
    assert.equal(
      (await broker.applyReviewLineageObservation(cancelCommand()))?.status,
      "applied",
    );
    assert.equal(
      broker.getReviewLineage("pr-1518-phase10", T0)?.state,
      "canceled",
    );
    store.close();

    const restoredStore = new SqliteBrokerStateStore(dbFile);
    const restoredBroker = new InMemoryA2ABroker(
      restoredStore,
      restoredStore.load(),
      { reviewLineageMode: "record" },
    );
    assert.equal(
      restoredBroker.getReviewLineage("pr-1518-phase10", T0)?.state,
      "canceled",
    );
    assert.deepEqual(
      await restoredBroker.applyReviewLineageObservation(cancelCommand()),
      {
        status: "replayed",
        lineageId: "pr-1518-phase10",
        originalOutcome: "applied",
        state: "canceled",
        recordVersion: 2,
        effects: ["operator_canceled"],
      },
    );
    restoredStore.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("legacy snapshot imports once and cannot overwrite canonical SQLite rows", () => {
  const { dir, dbFile } = tempDatabase("a2a-review-legacy-import-");
  try {
    const lineageId = "legacy-phase10";
    const legacy = new ReviewLineageStore();
    legacy.create({
      contract: contract(lineageId),
      budget: budget(),
      diffHash: DIFF_HASH,
      at: T0,
    });
    const canonical = legacy.apply(lineageId, {
      type: "operator_cancel",
      at: "2026-07-23T14:22:00Z",
      detail: "legacy closeout",
    }).record;

    const store = new SqliteBrokerStateStore(dbFile);
    store.save({
      ...emptySnapshot(),
      reviewLineages: [canonical],
    });
    assert.equal(
      store.listCanonicalReviewLineages()[0]?.state,
      "canceled",
    );

    const stale = new ReviewLineageStore().create({
      contract: contract(lineageId),
      budget: budget(),
      diffHash: DIFF_HASH,
      at: T0,
    });
    store.save({
      ...emptySnapshot(),
      reviewLineages: [stale],
    });
    assert.equal(
      store.load().reviewLineages?.[0]?.state,
      "canceled",
    );
    store.close();

    const restored = new SqliteBrokerStateStore(dbFile);
    assert.equal(
      restored.load().reviewLineages?.[0]?.state,
      "canceled",
    );
    restored.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("production compound command rolls back lineage when ledger insert fails", async () => {
  const { dir, dbFile } = tempDatabase("a2a-review-production-rollback-");
  try {
    const store = new SqliteBrokerStateStore(dbFile);
    assert.equal(
      (await store.applyReviewLineageObservation(createCommand())).status,
      "applied",
    );
    const cancel = cancelCommand();
    const faultDb = new DatabaseSync(dbFile);
    faultDb.exec(`
      CREATE TRIGGER reject_phase10_observation
      BEFORE INSERT ON ${REVIEW_LINEAGE_OBSERVATION_LEDGER_TABLE}
      WHEN NEW.idempotency_key = '${cancel.idempotencyKey}'
      BEGIN
        SELECT RAISE(ABORT, 'forced_phase10_failure');
      END
    `);

    await assert.rejects(
      async () => {
        await store.applyReviewLineageObservation(cancel);
      },
      /forced_phase10_failure/,
    );
    assert.equal(
      store.listCanonicalReviewLineages()[0]?.state,
      "reviewing_initial",
    );
    faultDb.exec("DROP TRIGGER reject_phase10_observation");
    faultDb.close();
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("worker-thread proxy applies one compound observation and ACKs before readback", async () => {
  const { dir, dbFile } = tempDatabase("a2a-review-worker-thread-");
  const handle = createWorkerThreadPersistence({
    dbFile,
    queueCapacity: 4,
  });
  try {
    const broker = new InMemoryA2ABroker(
      handle.stateStore,
      handle.stateStore.load(),
      { reviewLineageMode: "record" },
    );
    assert.equal(
      (await broker.applyReviewLineageObservation(createCommand()))?.status,
      "applied",
    );
    assert.equal(
      (await broker.applyReviewLineageObservation(cancelCommand()))?.status,
      "applied",
    );
    assert.deepEqual(handle.queue.stats(), {
      capacity: 4,
      queued: 0,
      active: 0,
      inFlight: 0,
      available: 4,
      closing: false,
      aborted: false,
    });

    const reader = new SqliteBrokerStateStore(dbFile);
    try {
      assert.equal(
        reader.load().reviewLineages?.[0]?.state,
        "canceled",
      );
    } finally {
      reader.close();
    }
  } finally {
    await handle.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
