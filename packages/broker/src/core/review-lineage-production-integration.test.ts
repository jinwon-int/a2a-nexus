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

function operatorCancelRequest(lineageId = "pr-1518-phase10") {
  return {
    decisionRef: `operator-decision:${lineageId}:1`,
    observedAt: "2026-07-23T14:21:00Z",
    binding: binding(lineageId),
    detail: "Explicit authenticated operator cancellation.",
  };
}

function operatorCreateRequest(lineageId = "pr-1518-phase10") {
  return {
    dispatchRef: `lineage-dispatch:${lineageId}:1`,
    observedAt: T0,
    binding: binding(lineageId),
    contract: contract(lineageId),
    budget: budget(),
  };
}

function reviewerReportRequest(
  lineageId = "pr-1518-phase10",
  note = "Authenticated reviewer passed the exact subject.",
) {
  return {
    reportRef: `review-report:${lineageId}:1`,
    observedAt: "2026-07-23T14:21:00Z",
    binding: binding(lineageId),
    receipt: {
      kind: "ReviewReceiptV1" as const,
      reviewerNodeId: "reviewer-yukson",
      verdict: "pass" as const,
      note,
      headSha: HEAD_SHA,
      diffHash: DIFF_HASH,
      intentHash: contract(lineageId).intentHash,
      findingLedgerRef: `ledger-${lineageId}`,
      authorWorkerId: "author-bangtong",
    },
    resolvedFindingIds: [],
    reopenedFindingIds: [],
    newFindings: [],
  };
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

test("broker operator-cancel source awaits the composite store ACK before projection refresh", async () => {
  const { dir, dbFile } = tempDatabase("a2a-review-operator-source-");
  try {
    const store = new SqliteBrokerStateStore(dbFile);
    const broker = new InMemoryA2ABroker(
      store,
      store.load(),
      { reviewLineageMode: "record" },
    );
    assert.equal(
      (await broker.applyReviewLineageObservation(createCommand()))?.status,
      "applied",
    );
    assert.equal(
      (await broker.recordOperatorReviewLineageCancel(
        "pr-1518-phase10",
        operatorCancelRequest(),
        "operator-seoseo",
      ))?.status,
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
      (await restoredBroker.recordOperatorReviewLineageCancel(
        "pr-1518-phase10",
        operatorCancelRequest(),
        "operator-seoseo",
      ))?.status,
      "replayed",
    );
    restoredStore.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("broker operator-owned lineage create commits before projection and replays after restart", async () => {
  const { dir, dbFile } = tempDatabase("a2a-review-create-source-");
  try {
    const store = new SqliteBrokerStateStore(dbFile);
    const broker = new InMemoryA2ABroker(
      store,
      store.load(),
      { reviewLineageMode: "record" },
    );
    assert.equal(
      (await broker.recordOperatorReviewLineageCreate(
        operatorCreateRequest(),
        "operator-seoseo",
      ))?.status,
      "applied",
    );
    assert.equal(
      broker.getReviewLineage("pr-1518-phase10", T0)?.state,
      "reviewing_initial",
    );
    store.close();

    const restoredStore = new SqliteBrokerStateStore(dbFile);
    const restoredBroker = new InMemoryA2ABroker(
      restoredStore,
      restoredStore.load(),
      { reviewLineageMode: "record" },
    );
    assert.equal(
      (await restoredBroker.recordOperatorReviewLineageCreate(
        operatorCreateRequest(),
        "operator-seoseo",
      ))?.status,
      "replayed",
    );
    assert.equal(
      restoredBroker.getReviewLineage("pr-1518-phase10", T0)?.state,
      "reviewing_initial",
    );
    restoredStore.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("broker reviewer report commits before projection, replays after restart, and conflicts on changed payload", async () => {
  const { dir, dbFile } = tempDatabase("a2a-review-report-source-");
  try {
    const store = new SqliteBrokerStateStore(dbFile);
    const broker = new InMemoryA2ABroker(
      store,
      store.load(),
      { reviewLineageMode: "record" },
    );
    assert.equal(
      (await broker.recordOperatorReviewLineageCreate(
        operatorCreateRequest(),
        "operator-seoseo",
      ))?.status,
      "applied",
    );
    assert.equal(
      (await broker.recordReviewerReviewLineageReport(
        "pr-1518-phase10",
        reviewerReportRequest(),
        "reviewer-yukson",
      ))?.status,
      "applied",
    );
    assert.equal(
      broker.getReviewLineage("pr-1518-phase10", T0)?.state,
      "passed",
    );
    store.close();

    const restoredStore = new SqliteBrokerStateStore(dbFile);
    const restoredBroker = new InMemoryA2ABroker(
      restoredStore,
      restoredStore.load(),
      { reviewLineageMode: "record" },
    );
    assert.equal(
      (await restoredBroker.recordReviewerReviewLineageReport(
        "pr-1518-phase10",
        reviewerReportRequest(),
        "reviewer-yukson",
      ))?.status,
      "replayed",
    );
    assert.equal(
      (await restoredBroker.recordReviewerReviewLineageReport(
        "pr-1518-phase10",
        reviewerReportRequest(
          "pr-1518-phase10",
          "Changed evidence under the immutable report.",
        ),
        "reviewer-yukson",
      ))?.status,
      "idempotency_conflict",
    );
    assert.equal(
      restoredBroker.getReviewLineage("pr-1518-phase10", T0)?.state,
      "passed",
    );
    restoredStore.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reviewer report projection remains unchanged until the composite durable ACK", async () => {
  const store = new SqliteBrokerStateStore(":memory:");
  try {
    assert.equal(
      (await store.applyReviewLineageObservation(createCommand())).status,
      "applied",
    );
    let captured:
      | Parameters<NonNullable<
          typeof store.applyAuthorizedReviewLineageSource
        >>[0]
      | undefined;
    let settle: (() => void) | undefined;
    const delayed = new Promise<
      Awaited<ReturnType<
        NonNullable<typeof store.applyAuthorizedReviewLineageSource>
      >>
    >((resolve) => {
      settle = () => {
        if (!captured) throw new Error("missing captured admission");
        resolve(store.applyAuthorizedReviewLineageSource(captured));
      };
    });
    let projectionReads = 0;
    const delayedStore = {
      load: () => store.load(),
      save: () => undefined,
      applyAuthorizedReviewLineageSource: (admission: typeof captured) => {
        if (!admission) throw new Error("missing admission");
        captured = admission;
        return delayed;
      },
      listCanonicalReviewLineages: () => {
        projectionReads += 1;
        return store.listCanonicalReviewLineages();
      },
    };
    const broker = new InMemoryA2ABroker(
      delayedStore,
      delayedStore.load(),
      { reviewLineageMode: "record" },
    );
    const pending = broker.recordReviewerReviewLineageReport(
      "pr-1518-phase10",
      reviewerReportRequest(),
      "reviewer-yukson",
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(
      broker.getReviewLineage("pr-1518-phase10", T0)?.state,
      "reviewing_initial",
    );
    assert.equal(projectionReads, 0);
    settle?.();
    assert.equal((await pending)?.status, "applied");
    assert.equal(projectionReads, 1);
    assert.equal(
      broker.getReviewLineage("pr-1518-phase10", T0)?.state,
      "passed",
    );
  } finally {
    store.close();
  }
});

test("off mode returns before attached source validation or store access", async () => {
  let calls = 0;
  const snapshot = emptySnapshot();
  const stateStore = {
    load: () => snapshot,
    save: () => undefined,
    applyAuthorizedReviewLineageSource: () => {
      calls += 1;
      throw new Error("must not be called");
    },
    listCanonicalReviewLineages: () => [],
  };
  const broker = new InMemoryA2ABroker(
    stateStore,
    snapshot,
    { reviewLineageMode: "off" },
  );
  assert.equal(
    await broker.recordOperatorReviewLineageCreate(
      null,
      "invalid operator id",
    ),
    undefined,
  );
  assert.equal(
    await broker.recordOperatorReviewLineageCancel(
      "invalid lineage id",
      null,
      "invalid operator id",
    ),
    undefined,
  );
  assert.equal(
    await broker.recordReviewerReviewLineageReport(
      "invalid lineage id",
      null,
      "invalid reviewer id",
    ),
    undefined,
  );
  assert.equal(calls, 0);
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
      (await broker.recordOperatorReviewLineageCreate(
        operatorCreateRequest(),
        "operator-seoseo",
      ))?.status,
      "applied",
    );
    assert.equal(
      (await broker.recordOperatorReviewLineageCancel(
        "pr-1518-phase10",
        operatorCancelRequest(),
        "operator-seoseo",
      ))?.status,
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

test("worker-thread reviewer report uses one composite command and ACK before projection", async () => {
  const { dir, dbFile } = tempDatabase("a2a-review-worker-report-");
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
      (await broker.recordOperatorReviewLineageCreate(
        operatorCreateRequest(),
        "operator-seoseo",
      ))?.status,
      "applied",
    );

    let compositeCommands = 0;
    const originalRequest =
      handle.workerThread.request.bind(handle.workerThread);
    handle.workerThread.request = ((
      method: string,
      ...args: unknown[]
    ) => {
      if (method === "applyAuthorizedReviewLineageSource") {
        compositeCommands += 1;
      }
      return originalRequest(method, ...args);
    }) as typeof handle.workerThread.request;

    assert.equal(
      (await broker.recordReviewerReviewLineageReport(
        "pr-1518-phase10",
        reviewerReportRequest(),
        "reviewer-yukson",
      ))?.status,
      "applied",
    );
    assert.equal(compositeCommands, 1);
    assert.equal(
      broker.getReviewLineage("pr-1518-phase10", T0)?.state,
      "passed",
    );
    assert.equal(handle.queue.stats().inFlight, 0);

    const reader = new SqliteBrokerStateStore(dbFile);
    try {
      assert.equal(
        reader.load().reviewLineages?.[0]?.state,
        "passed",
      );
    } finally {
      reader.close();
    }
  } finally {
    await handle.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
