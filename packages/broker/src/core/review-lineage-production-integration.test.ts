import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  findingSignature,
  intentHash,
} from "../review-lifecycle/canonical-json.js";
import {
  ObservationValidationError,
  parseReviewLineageObservation,
  type ProjectedReviewLineageObservation,
} from "../review-lifecycle/observation.js";
import type {
  IntentContractV1,
  ReviewLineageBudgetV1,
} from "../review-lifecycle/types.js";
import { InMemoryA2ABroker } from "./broker.js";
import {
  REVIEW_LINEAGE_AUTHORIZED_SOURCE_EVENT_TABLE,
  REVIEW_LINEAGE_OBSERVATION_LEDGER_TABLE,
  type ReviewLineageObservationApplicationResult,
} from "./review-lineage-observation-store.js";
import { ReviewLineageStore } from "./review-lineage-store.js";
import { emptySnapshot, SqliteBrokerStateStore } from "./store.js";
import { createWorkerThreadPersistence } from "./sqlite-worker-thread-persistence.js";

const BASE_SHA = "2".repeat(40);
const HEAD_SHA = "3".repeat(40);
const NEXT_SHA = "4".repeat(40);
const DIFF_HASH = `sha256:${"b".repeat(64)}`;
const NEXT_DIFF_HASH = `sha256:${"c".repeat(64)}`;
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

function reviewerReportRequest(lineageId = "pr-1518-phase10") {
  const subject = binding(lineageId);
  return {
    reportRef: `review-report:${lineageId}:1`,
    observedAt: "2026-07-23T14:21:00Z",
    binding: subject,
    receipt: {
      kind: "ReviewReceiptV1",
      reviewerNodeId: "reviewer-beta",
      verdict: "pass",
      note: "Authenticated bounded review report.",
      headSha: subject.headSha,
      diffHash: subject.diffHash,
      intentHash: subject.intentHash,
      findingLedgerRef: `ledger-${lineageId}`,
      authorWorkerId: "author-alpha",
      submittedAt: "2026-07-23T14:21:00Z",
    },
    resolvedFindingIds: [],
    reopenedFindingIds: [],
    newFindings: [],
  };
}

function failedReviewerReportRequest(lineageId = "pr-1518-phase10") {
  const subject = binding(lineageId);
  const signable = {
    criterionRef: "AC-1",
    category: "correctness" as const,
    evidenceRefs: ["packages/broker/src/core/broker.ts:700"],
  };
  return {
    reportRef: `review-report:${lineageId}:fail`,
    observedAt: "2026-07-23T14:21:00Z",
    binding: subject,
    receipt: {
      kind: "ReviewReceiptV1",
      reviewerNodeId: "reviewer-beta",
      verdict: "fail",
      note: "One bounded correction generation is required.",
      headSha: subject.headSha,
      diffHash: subject.diffHash,
      intentHash: subject.intentHash,
      findingLedgerRef: `ledger-${lineageId}`,
      authorWorkerId: "author-alpha",
      submittedAt: "2026-07-23T14:21:00Z",
    },
    resolvedFindingIds: [],
    reopenedFindingIds: [],
    newFindings: [{
      findingId: "F-1",
      ...signable,
      severity: "major" as const,
      blocking: true,
      introducedAtHead: subject.headSha,
      firstSeenAtHead: subject.headSha,
      resolvedAtHead: null,
      disposition: "open" as const,
      signature: findingSignature(signable),
    }],
  };
}

function correctionGenerationRequest(lineageId = "pr-1518-phase10") {
  const subject = binding(lineageId);
  return {
    generationRef: `correction-generation:${lineageId}:1`,
    observedAt: "2026-07-23T14:22:00Z",
    binding: subject,
    headSha: NEXT_SHA,
    diffHash: NEXT_DIFF_HASH,
    intentHash: subject.intentHash,
    pathsChanged: [
      "packages/broker/src/core/broker.ts",
    ],
  };
}

function reviewerReplacementRequest(lineageId = "pr-1518-phase10") {
  return {
    decisionRef: `reviewer-replacement:${lineageId}:1`,
    observedAt: "2026-07-23T14:21:30Z",
    binding: binding(lineageId),
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

test("broker review report awaits the composite ACK before projection refresh", async () => {
  const durableStore = new SqliteBrokerStateStore(":memory:");
  try {
    const setupBroker = new InMemoryA2ABroker(
      durableStore,
      durableStore.load(),
      { reviewLineageMode: "record" },
    );
    assert.equal(
      (await setupBroker.recordOperatorReviewLineageCreate(
        operatorCreateRequest(),
        "operator-seoseo",
      ))?.status,
      "applied",
    );

    let release: (() => Promise<void>) | undefined;
    const delayedStore = {
      load: () => durableStore.load(),
      save: () => undefined,
      applyAuthorizedReviewLineageSource: (admission: Parameters<
        SqliteBrokerStateStore["applyAuthorizedReviewLineageSource"]
      >[0]) => new Promise<ReviewLineageObservationApplicationResult>(
        (resolve, reject) => {
          release = async () => {
            try {
              resolve(
                await durableStore.applyAuthorizedReviewLineageSource(
                  admission,
                ),
              );
            } catch (error) {
              reject(error);
            }
          };
        },
      ),
      listCanonicalReviewLineages: () =>
        durableStore.listCanonicalReviewLineages(),
    };
    const broker = new InMemoryA2ABroker(
      delayedStore,
      delayedStore.load(),
      { reviewLineageMode: "record" },
    );
    const pending = broker.recordReviewerReviewLineageReport(
      "pr-1518-phase10",
      reviewerReportRequest(),
      "reviewer-beta",
    );
    assert.equal(
      broker.getReviewLineage("pr-1518-phase10", T0)?.state,
      "reviewing_initial",
    );
    assert.ok(release);
    await release();
    assert.equal((await pending)?.status, "applied");
    assert.equal(
      broker.getReviewLineage("pr-1518-phase10", T0)?.state,
      "passed",
    );
  } finally {
    durableStore.close();
  }
});

test("broker correction generation awaits the composite ACK before projection refresh", async () => {
  const durableStore = new SqliteBrokerStateStore(":memory:");
  try {
    const setupBroker = new InMemoryA2ABroker(
      durableStore,
      durableStore.load(),
      { reviewLineageMode: "record" },
    );
    assert.equal(
      (await setupBroker.recordOperatorReviewLineageCreate(
        operatorCreateRequest(),
        "operator-seoseo",
      ))?.status,
      "applied",
    );
    assert.equal(
      (await setupBroker.recordReviewerReviewLineageReport(
        "pr-1518-phase10",
        failedReviewerReportRequest(),
        "reviewer-beta",
      ))?.status,
      "applied",
    );

    let release: (() => Promise<void>) | undefined;
    const delayedStore = {
      load: () => durableStore.load(),
      save: () => undefined,
      applyAuthorizedReviewLineageSource: (admission: Parameters<
        SqliteBrokerStateStore["applyAuthorizedReviewLineageSource"]
      >[0]) => new Promise<ReviewLineageObservationApplicationResult>(
        (resolve, reject) => {
          release = async () => {
            try {
              resolve(
                await durableStore.applyAuthorizedReviewLineageSource(
                  admission,
                ),
              );
            } catch (error) {
              reject(error);
            }
          };
        },
      ),
      listCanonicalReviewLineages: () =>
        durableStore.listCanonicalReviewLineages(),
    };
    const broker = new InMemoryA2ABroker(
      delayedStore,
      delayedStore.load(),
      { reviewLineageMode: "record" },
    );
    const pending =
      broker.recordOperatorReviewLineageCorrectionGeneration(
        "pr-1518-phase10",
        correctionGenerationRequest(),
        "operator-seoseo",
      );
    assert.equal(
      broker.getReviewLineage("pr-1518-phase10", T0)?.state,
      "correction_pending",
    );
    assert.ok(release);
    await release();
    assert.equal((await pending)?.status, "applied");
    assert.equal(
      broker.getReviewLineage("pr-1518-phase10", T0)?.state,
      "reviewing_resolution",
    );
  } finally {
    durableStore.close();
  }
});

test("broker reviewer replacement awaits the composite ACK before projection refresh", async () => {
  const durableStore = new SqliteBrokerStateStore(":memory:");
  try {
    const setupBroker = new InMemoryA2ABroker(
      durableStore,
      durableStore.load(),
      { reviewLineageMode: "record" },
    );
    assert.equal(
      (await setupBroker.recordOperatorReviewLineageCreate(
        operatorCreateRequest(),
        "operator-seoseo",
      ))?.status,
      "applied",
    );

    let release: (() => Promise<void>) | undefined;
    const delayedStore = {
      load: () => durableStore.load(),
      save: () => undefined,
      applyAuthorizedReviewLineageSource: (admission: Parameters<
        SqliteBrokerStateStore["applyAuthorizedReviewLineageSource"]
      >[0]) => new Promise<ReviewLineageObservationApplicationResult>(
        (resolve, reject) => {
          release = async () => {
            try {
              resolve(
                await durableStore.applyAuthorizedReviewLineageSource(
                  admission,
                ),
              );
            } catch (error) {
              reject(error);
            }
          };
        },
      ),
      listCanonicalReviewLineages: () =>
        durableStore.listCanonicalReviewLineages(),
    };
    const broker = new InMemoryA2ABroker(
      delayedStore,
      delayedStore.load(),
      { reviewLineageMode: "record" },
    );
    const pending =
      broker.recordOperatorReviewLineageReviewerReplacement(
        "pr-1518-phase10",
        reviewerReplacementRequest(),
        "operator-seoseo",
      );
    assert.equal(
      broker.getReviewLineage("pr-1518-phase10", T0)
        ?.metrics.reviewerReplacements,
      0,
    );
    assert.ok(release);
    await release();
    assert.equal((await pending)?.status, "applied");
    assert.equal(
      broker.getReviewLineage("pr-1518-phase10", T0)
        ?.metrics.reviewerReplacements,
      1,
    );
  } finally {
    durableStore.close();
  }
});

test("off mode returns before all attached source validation or store access", async () => {
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
  assert.equal(
    await broker.recordOperatorReviewLineageCorrectionGeneration(
      "invalid lineage id",
      null,
      "invalid operator id",
    ),
    undefined,
  );
  assert.equal(
    await broker.recordOperatorReviewLineageReviewerReplacement(
      "invalid lineage id",
      null,
      "invalid operator id",
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

test("worker-thread proxy sends one composite review source command and ACKs before readback", async () => {
  const { dir, dbFile } = tempDatabase("a2a-review-report-worker-thread-");
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
      (await broker.recordReviewerReviewLineageReport(
        "pr-1518-phase10",
        reviewerReportRequest(),
        "reviewer-beta",
      ))?.status,
      "applied",
    );
    assert.equal(
      broker.getReviewLineage("pr-1518-phase10", T0)?.state,
      "passed",
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
      const stored = reader.load().reviewLineages?.[0];
      assert.equal(stored?.state, "passed");
      assert.equal(stored?.counters.reviewerRuns, 1);
    } finally {
      reader.close();
    }
  } finally {
    await handle.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("worker-thread proxy sends one composite correction source command and ACKs before readback", async () => {
  const { dir, dbFile } = tempDatabase(
    "a2a-review-correction-worker-thread-",
  );
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
      (await broker.recordReviewerReviewLineageReport(
        "pr-1518-phase10",
        failedReviewerReportRequest(),
        "reviewer-beta",
      ))?.status,
      "applied",
    );
    assert.equal(
      (await broker.recordOperatorReviewLineageCorrectionGeneration(
        "pr-1518-phase10",
        correctionGenerationRequest(),
        "operator-seoseo",
      ))?.status,
      "applied",
    );
    assert.equal(
      broker.getReviewLineage("pr-1518-phase10", T0)?.state,
      "reviewing_resolution",
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
      const stored = reader.load().reviewLineages?.[0];
      assert.equal(stored?.state, "reviewing_resolution");
      assert.equal(stored?.counters.correctionGenerations, 1);
      assert.equal(stored?.currentHeadSha, NEXT_SHA);
      assert.equal(stored?.currentDiffHash, NEXT_DIFF_HASH);
    } finally {
      reader.close();
    }
  } finally {
    await handle.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("worker-thread proxy sends one composite replacement source command and ACKs before readback", async () => {
  const { dir, dbFile } = tempDatabase(
    "a2a-review-replacement-worker-thread-",
  );
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
      (await broker.recordOperatorReviewLineageReviewerReplacement(
        "pr-1518-phase10",
        reviewerReplacementRequest(),
        "operator-seoseo",
      ))?.status,
      "applied",
    );
    assert.equal(
      broker.getReviewLineage("pr-1518-phase10", T0)
        ?.metrics.reviewerReplacements,
      1,
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
      const stored = reader.load().reviewLineages?.[0];
      assert.equal(stored?.state, "reviewing_initial");
      assert.equal(stored?.counters.reviewerReplacements, 1);
      assert.equal(stored?.counters.reviewerRuns, 0);
      assert.equal(stored?.counters.correctionGenerations, 0);
      assert.equal(stored?.currentHeadSha, HEAD_SHA);
      assert.equal(stored?.currentDiffHash, DIFF_HASH);
      assert.equal(stored?.startedAt, T0);
    } finally {
      reader.close();
    }
  } finally {
    await handle.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Whole-sequence durable-boundary regression coverage (#1518). The tests below
// drive complete non-converging and intent-drift sequences through the
// authenticated broker source methods against a file-backed SQLite store.
// They prove the durable production boundary composes correctly: terminal
// durability across reopen, exact-source replay inertness, per-lineage
// independence, and the actual frozen-intent admission contract. This is
// record-mode observation proof only; it never proves that live task
// completion, retries, or dispatches are blocked.
// ---------------------------------------------------------------------------

const TERMINAL_LINEAGE_A = "pr-1518-terminus-a";
const COMPLETING_LINEAGE_B = "pr-1518-terminus-b";
const INTENT_GATE_LINEAGE_C = "pr-1518-terminus-c";
const HEAD_A = "5".repeat(40);
const NEXT_HEAD_A = "6".repeat(40);
const HEAD_B = "7".repeat(40);
const NEXT_HEAD_B = "8".repeat(40);
const HEAD_C = "9".repeat(40);
const NEXT_HEAD_C = "a".repeat(40);
const DIFF_A = `sha256:${"d".repeat(64)}`;
const NEXT_DIFF_A = `sha256:${"e".repeat(64)}`;
const DIFF_B = `sha256:${"f".repeat(64)}`;
const NEXT_DIFF_B = `sha256:${"0".repeat(64)}`;
const DIFF_C = `sha256:${"1".repeat(64)}`;
const NEXT_DIFF_C = `sha256:${"2".repeat(64)}`;
const DRIFTED_INTENT_HASH = `sha256:${"3".repeat(64)}`;
const T_CREATE = "2026-07-23T15:00:00Z";
const T_REPORT = "2026-07-23T15:01:00Z";
const T_CORRECTION = "2026-07-23T15:02:00Z";
const T_RESOLUTION = "2026-07-23T15:03:00Z";
const T_AFTER = "2026-07-23T15:04:00Z";

interface TerminusScenario {
  lineageId: string;
  headSha: string;
  diffHash: string;
  nextHeadSha: string;
  nextDiffHash: string;
  intentHash: string;
}

function terminusContract(
  lineageId: string,
  headSha: string,
): IntentContractV1 {
  const partial = {
    kind: "IntentContractV1" as const,
    lineageId,
    goal: "Keep bounded review lineages durable across restarts.",
    nonGoals: ["Do not enable enforce mode or automatic producers."],
    invariants: ["Lineage and ledger share one commit."],
    acceptanceCriteria: [{
      id: "AC-1",
      text: "Non-converging resolution stops at the explicit budget.",
    }],
    declaredPaths: {
      allowed: ["packages/broker/src/core/**"],
      forbidden: ["packages/broker/src/worker.ts"],
    },
    baseSha: BASE_SHA,
    headSha,
    createdAt: T_CREATE,
  };
  return {
    ...partial,
    intentHash: intentHash(partial as unknown as Record<string, unknown>),
  };
}

function terminusScenario(
  lineageId: string,
  headSha: string,
  diffHash: string,
  nextHeadSha: string,
  nextDiffHash: string,
): TerminusScenario {
  return {
    lineageId,
    headSha,
    diffHash,
    nextHeadSha,
    nextDiffHash,
    intentHash: terminusContract(lineageId, headSha).intentHash,
  };
}

function terminusBinding(
  scenario: TerminusScenario,
  headSha = scenario.headSha,
  diffHash = scenario.diffHash,
): { intentHash: string; headSha: string; diffHash: string } {
  return {
    intentHash: scenario.intentHash,
    headSha,
    diffHash,
  };
}

function terminusCreateRequest(scenario: TerminusScenario) {
  return {
    dispatchRef: `lineage-dispatch:${scenario.lineageId}:1`,
    observedAt: T_CREATE,
    binding: terminusBinding(scenario),
    contract: terminusContract(scenario.lineageId, scenario.headSha),
    budget: budget(),
  };
}

function terminusBlockingFinding(findingId: string, headSha: string) {
  const signable = {
    criterionRef: "AC-1",
    category: "correctness" as const,
    evidenceRefs: ["packages/broker/src/core/broker.ts:700"],
  };
  return {
    findingId,
    ...signable,
    severity: "major" as const,
    blocking: true,
    introducedAtHead: headSha,
    firstSeenAtHead: headSha,
    resolvedAtHead: null,
    disposition: "open" as const,
    signature: findingSignature(signable),
  };
}

function terminusReportRequest(options: {
  lineageId: string;
  binding: { intentHash: string; headSha: string; diffHash: string };
  reportRef: string;
  observedAt: string;
  verdict: "pass" | "fail";
  note: string;
  resolvedFindingIds?: string[];
  newFindings?: ReturnType<typeof terminusBlockingFinding>[];
}) {
  return {
    reportRef: options.reportRef,
    observedAt: options.observedAt,
    binding: options.binding,
    receipt: {
      kind: "ReviewReceiptV1",
      reviewerNodeId: "reviewer-beta",
      verdict: options.verdict,
      note: options.note,
      headSha: options.binding.headSha,
      diffHash: options.binding.diffHash,
      intentHash: options.binding.intentHash,
      findingLedgerRef: `ledger-${options.lineageId}`,
      authorWorkerId: "author-alpha",
      submittedAt: options.observedAt,
    },
    resolvedFindingIds: options.resolvedFindingIds ?? [],
    reopenedFindingIds: [],
    newFindings: options.newFindings ?? [],
  };
}

function terminusCorrectionRequest(options: {
  lineageId: string;
  binding: { intentHash: string; headSha: string; diffHash: string };
  generationRef: string;
  observedAt: string;
  headSha: string;
  diffHash: string;
  intentHash: string;
  pathsChanged: string[];
}) {
  return {
    generationRef: options.generationRef,
    observedAt: options.observedAt,
    binding: options.binding,
    headSha: options.headSha,
    diffHash: options.diffHash,
    intentHash: options.intentHash,
    pathsChanged: options.pathsChanged,
  };
}

function countRows(dbFile: string, table: string): number {
  const reader = new DatabaseSync(dbFile);
  try {
    const row = reader.prepare(
      `SELECT COUNT(*) AS count FROM ${table}`,
    ).get() as { count?: number | bigint };
    return Number(row?.count ?? 0);
  } finally {
    reader.close();
  }
}

function terminusRecord(store: SqliteBrokerStateStore, lineageId: string) {
  const record = store.load().reviewLineages?.find((candidate) =>
    candidate.lineageId === lineageId
  );
  assert.ok(record, `lineage ${lineageId} must be persisted`);
  return record;
}

/**
 * Drive two independent lineages through authenticated source methods on one
 * file-backed store: lineage A follows a non-converging sequence to the
 * terminal `repeated_findings` reason while lineage B absorbs a scope-drift
 * rejection and still completes. Returns the exact requests needed for replay
 * assertions after reopen.
 */
async function applyTerminusSequence(store: SqliteBrokerStateStore) {
  const broker = new InMemoryA2ABroker(
    store,
    store.load(),
    { reviewLineageMode: "record" },
  );
  const scenarioA = terminusScenario(
    TERMINAL_LINEAGE_A,
    HEAD_A,
    DIFF_A,
    NEXT_HEAD_A,
    NEXT_DIFF_A,
  );
  const scenarioB = terminusScenario(
    COMPLETING_LINEAGE_B,
    HEAD_B,
    DIFF_B,
    NEXT_HEAD_B,
    NEXT_DIFF_B,
  );

  assert.equal(
    (await broker.recordOperatorReviewLineageCreate(
      terminusCreateRequest(scenarioA),
      "operator-seoseo",
    ))?.status,
    "applied",
  );
  assert.equal(
    (await broker.recordOperatorReviewLineageCreate(
      terminusCreateRequest(scenarioB),
      "operator-seoseo",
    ))?.status,
    "applied",
  );

  const initialReportA = terminusReportRequest({
    lineageId: scenarioA.lineageId,
    binding: terminusBinding(scenarioA),
    reportRef: `review-report:${scenarioA.lineageId}:1`,
    observedAt: T_REPORT,
    verdict: "fail",
    note: "Initial review rejects one blocking correctness finding.",
    newFindings: [terminusBlockingFinding("F-1", scenarioA.headSha)],
  });
  assert.deepEqual(
    await broker.recordReviewerReviewLineageReport(
      scenarioA.lineageId,
      initialReportA,
      "reviewer-beta",
    ),
    {
      status: "applied",
      lineageId: scenarioA.lineageId,
      outcome: "applied",
      state: "correction_pending",
      recordVersion: 2,
      effects: ["correction_pending"],
    },
  );

  const initialReportB = terminusReportRequest({
    lineageId: scenarioB.lineageId,
    binding: terminusBinding(scenarioB),
    reportRef: `review-report:${scenarioB.lineageId}:1`,
    observedAt: T_REPORT,
    verdict: "fail",
    note: "Initial review rejects one blocking correctness finding.",
    newFindings: [terminusBlockingFinding("F-2", scenarioB.headSha)],
  });
  assert.equal(
    (await broker.recordReviewerReviewLineageReport(
      scenarioB.lineageId,
      initialReportB,
      "reviewer-beta",
    ))?.status,
    "applied",
  );

  const acceptedCorrectionA = terminusCorrectionRequest({
    lineageId: scenarioA.lineageId,
    binding: terminusBinding(scenarioA),
    generationRef: `correction-generation:${scenarioA.lineageId}:1`,
    observedAt: T_CORRECTION,
    headSha: scenarioA.nextHeadSha,
    diffHash: scenarioA.nextDiffHash,
    intentHash: scenarioA.intentHash,
    pathsChanged: ["packages/broker/src/core/broker.ts"],
  });
  assert.deepEqual(
    await broker.recordOperatorReviewLineageCorrectionGeneration(
      scenarioA.lineageId,
      acceptedCorrectionA,
      "operator-seoseo",
    ),
    {
      status: "applied",
      lineageId: scenarioA.lineageId,
      outcome: "applied",
      state: "reviewing_resolution",
      recordVersion: 3,
      effects: ["generation_accepted"],
    },
  );

  // Scope drift leaves a visible rejection, never overwrites the accepted
  // subject, and does not terminate the lineage.
  const driftedCorrectionB = terminusCorrectionRequest({
    lineageId: scenarioB.lineageId,
    binding: terminusBinding(scenarioB),
    generationRef: `correction-generation:${scenarioB.lineageId}:drift`,
    observedAt: T_CORRECTION,
    headSha: scenarioB.nextHeadSha,
    diffHash: scenarioB.nextDiffHash,
    intentHash: scenarioB.intentHash,
    pathsChanged: ["docs/unrelated-change.md"],
  });
  assert.deepEqual(
    await broker.recordOperatorReviewLineageCorrectionGeneration(
      scenarioB.lineageId,
      driftedCorrectionB,
      "operator-seoseo",
    ),
    {
      status: "applied",
      lineageId: scenarioB.lineageId,
      outcome: "applied",
      state: "correction_pending",
      recordVersion: 3,
      effects: ["scope_drift_rejected"],
    },
  );
  assert.equal(
    broker.getReviewLineage(scenarioB.lineageId, T_CREATE)?.state,
    "correction_pending",
  );
  assert.equal(
    broker.getReviewLineage(scenarioB.lineageId, T_CREATE)?.metrics
      .scopeDriftRejections,
    1,
  );
  assert.equal(
    terminusRecord(store, scenarioB.lineageId).currentHeadSha,
    scenarioB.headSha,
  );

  // Non-converging resolution: the reviewer fails again without resolving
  // F-1, so the repeated-signature early stop terminates lineage A.
  const terminalResolutionReportA = terminusReportRequest({
    lineageId: scenarioA.lineageId,
    binding: terminusBinding(
      scenarioA,
      scenarioA.nextHeadSha,
      scenarioA.nextDiffHash,
    ),
    reportRef: `review-report:${scenarioA.lineageId}:2`,
    observedAt: T_RESOLUTION,
    verdict: "fail",
    note: "Resolution review fails without resolving the open finding.",
  });
  assert.deepEqual(
    await broker.recordReviewerReviewLineageReport(
      scenarioA.lineageId,
      terminalResolutionReportA,
      "reviewer-beta",
    ),
    {
      status: "applied",
      lineageId: scenarioA.lineageId,
      outcome: "applied",
      state: "blocked_needs_operator",
      recordVersion: 4,
      effects: ["repeated_signature_stop"],
    },
  );

  // Lineage A being terminal must not stop or alter lineage B.
  const properCorrectionB = terminusCorrectionRequest({
    lineageId: scenarioB.lineageId,
    binding: terminusBinding(scenarioB),
    generationRef: `correction-generation:${scenarioB.lineageId}:2`,
    observedAt: T_CORRECTION,
    headSha: scenarioB.nextHeadSha,
    diffHash: scenarioB.nextDiffHash,
    intentHash: scenarioB.intentHash,
    pathsChanged: ["packages/broker/src/core/broker.ts"],
  });
  assert.equal(
    (await broker.recordOperatorReviewLineageCorrectionGeneration(
      scenarioB.lineageId,
      properCorrectionB,
      "operator-seoseo",
    ))?.status,
    "applied",
  );
  const resolutionReportB = terminusReportRequest({
    lineageId: scenarioB.lineageId,
    binding: terminusBinding(
      scenarioB,
      scenarioB.nextHeadSha,
      scenarioB.nextDiffHash,
    ),
    reportRef: `review-report:${scenarioB.lineageId}:2`,
    observedAt: T_RESOLUTION,
    verdict: "pass",
    note: "Resolution review resolves the initial finding.",
    resolvedFindingIds: ["F-2"],
  });
  assert.equal(
    (await broker.recordReviewerReviewLineageReport(
      scenarioB.lineageId,
      resolutionReportB,
      "reviewer-beta",
    ))?.status,
    "applied",
  );

  return {
    broker,
    scenarioA,
    scenarioB,
    acceptedCorrectionA,
    terminalResolutionReportA,
  };
}

test(
  "non-converging lineage reaches the terminal repeated-findings reason while an independent drifted lineage completes through authenticated source methods",
  async () => {
    const { dir, dbFile } = tempDatabase("a2a-review-terminus-live-");
    try {
      const store = new SqliteBrokerStateStore(dbFile);
      try {
        const { broker, scenarioA, scenarioB } = await applyTerminusSequence(
          store,
        );

        const terminal = broker.getReviewLineage(scenarioA.lineageId, T_CREATE);
        assert.equal(terminal?.state, "blocked_needs_operator");
        assert.equal(terminal?.metrics.terminalReason, "repeated_findings");
        assert.equal(terminal?.metrics.reviewerRuns, 2);
        assert.equal(terminal?.metrics.correctionGenerations, 1);
        assert.equal(terminal?.metrics.repeatedSignatureHits, 1);

        const recordA = terminusRecord(store, scenarioA.lineageId);
        assert.equal(recordA.terminalReason, "repeated_findings");
        assert.equal(recordA.currentHeadSha, scenarioA.nextHeadSha);
        assert.equal(recordA.currentDiffHash, scenarioA.nextDiffHash);
        assert.deepEqual(recordA.budget, budget());
        assert.equal(recordA.counters.correctionGenerations, 1);
        assert.equal(recordA.counters.reviewerRuns, 2);
        assert.equal(recordA.counters.repeatedSignatureHits, 1);
        assert.equal(recordA.counters.scopeDriftRejections, 0);

        assert.equal(
          broker.getReviewLineage(scenarioB.lineageId, T_CREATE)?.state,
          "passed",
        );
        const recordB = terminusRecord(store, scenarioB.lineageId);
        assert.equal(recordB.terminalReason, null);
        assert.equal(recordB.currentHeadSha, scenarioB.nextHeadSha);
        assert.deepEqual(recordB.budget, budget());
        assert.equal(recordB.counters.correctionGenerations, 1);
        assert.equal(recordB.counters.reviewerRuns, 2);
        assert.equal(recordB.counters.scopeDriftRejections, 1);
        assert.equal(recordB.counters.findingsResolved, 1);
      } finally {
        store.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  "terminal non-converging lineage survives store reopen: exact source replays cannot increment counters or reset budget and later events cannot revive it",
  async () => {
    const { dir, dbFile } = tempDatabase("a2a-review-terminus-reopen-");
    try {
      const store = new SqliteBrokerStateStore(dbFile);
      const seeded = await applyTerminusSequence(store);
      store.close();

      const restoredStore = new SqliteBrokerStateStore(dbFile);
      try {
        const restoredBroker = new InMemoryA2ABroker(
          restoredStore,
          restoredStore.load(),
          { reviewLineageMode: "record" },
        );
        assert.equal(
          restoredBroker.getReviewLineage(seeded.scenarioA.lineageId, T_CREATE)
            ?.state,
          "blocked_needs_operator",
        );
        assert.equal(
          restoredBroker.getReviewLineage(seeded.scenarioA.lineageId, T_CREATE)
            ?.metrics.terminalReason,
          "repeated_findings",
        );
        assert.equal(
          restoredBroker.getReviewLineage(seeded.scenarioB.lineageId, T_CREATE)
            ?.state,
          "passed",
        );

        // Exact replay of the accepted correction round: one stable replayed
        // outcome, no second engine transition, no counter or budget change.
        assert.deepEqual(
          await restoredBroker.recordOperatorReviewLineageCorrectionGeneration(
            seeded.scenarioA.lineageId,
            seeded.acceptedCorrectionA,
            "operator-seoseo",
          ),
          {
            status: "replayed",
            lineageId: seeded.scenarioA.lineageId,
            originalOutcome: "applied",
            state: "reviewing_resolution",
            recordVersion: 3,
            effects: ["generation_accepted"],
          },
        );
        assert.deepEqual(
          await restoredBroker.recordReviewerReviewLineageReport(
            seeded.scenarioA.lineageId,
            seeded.terminalResolutionReportA,
            "reviewer-beta",
          ),
          {
            status: "replayed",
            lineageId: seeded.scenarioA.lineageId,
            originalOutcome: "applied",
            state: "blocked_needs_operator",
            recordVersion: 4,
            effects: ["repeated_signature_stop"],
          },
        );

        const recordA = terminusRecord(
          restoredStore,
          seeded.scenarioA.lineageId,
        );
        assert.equal(recordA.state, "blocked_needs_operator");
        assert.equal(recordA.terminalReason, "repeated_findings");
        assert.equal(recordA.currentHeadSha, seeded.scenarioA.nextHeadSha);
        assert.deepEqual(recordA.budget, budget());
        assert.equal(recordA.counters.correctionGenerations, 1);
        assert.equal(recordA.counters.reviewerRuns, 2);
        assert.equal(recordA.counters.repeatedSignatureHits, 1);

        // A differently-referenced later report cannot revive the terminal
        // lineage: the engine ignores it and the record stays terminal.
        const laterReportA = terminusReportRequest({
          lineageId: seeded.scenarioA.lineageId,
          binding: terminusBinding(
            seeded.scenarioA,
            seeded.scenarioA.nextHeadSha,
            seeded.scenarioA.nextDiffHash,
          ),
          reportRef: `review-report:${seeded.scenarioA.lineageId}:late`,
          observedAt: T_AFTER,
          verdict: "pass",
          note: "Later attempt to revive a terminal lineage.",
        });
        assert.deepEqual(
          await restoredBroker.recordReviewerReviewLineageReport(
            seeded.scenarioA.lineageId,
            laterReportA,
            "reviewer-beta",
          ),
          {
            status: "applied",
            lineageId: seeded.scenarioA.lineageId,
            outcome: "applied",
            state: "blocked_needs_operator",
            recordVersion: 5,
            effects: ["ignored_terminal:blocked_needs_operator"],
          },
        );

        // A fresh correction round is rejected at the durable state gate.
        const laterCorrectionA = terminusCorrectionRequest({
          lineageId: seeded.scenarioA.lineageId,
          binding: terminusBinding(
            seeded.scenarioA,
            seeded.scenarioA.nextHeadSha,
            seeded.scenarioA.nextDiffHash,
          ),
          generationRef:
            `correction-generation:${seeded.scenarioA.lineageId}:late`,
          observedAt: T_AFTER,
          headSha: seeded.scenarioA.headSha,
          diffHash: seeded.scenarioA.diffHash,
          intentHash: seeded.scenarioA.intentHash,
          pathsChanged: ["packages/broker/src/core/broker.ts"],
        });
        assert.deepEqual(
          await restoredBroker.recordOperatorReviewLineageCorrectionGeneration(
            seeded.scenarioA.lineageId,
            laterCorrectionA,
            "operator-seoseo",
          ),
          {
            status: "transition_rejected",
            lineageId: seeded.scenarioA.lineageId,
            outcome: "transition_rejected",
          },
        );

        const recordAfterRevivalAttempts = terminusRecord(
          restoredStore,
          seeded.scenarioA.lineageId,
        );
        assert.equal(
          recordAfterRevivalAttempts.state,
          "blocked_needs_operator",
        );
        assert.equal(
          recordAfterRevivalAttempts.terminalReason,
          "repeated_findings",
        );
        assert.equal(recordAfterRevivalAttempts.counters.reviewerRuns, 2);
        assert.equal(
          recordAfterRevivalAttempts.counters.correctionGenerations,
          1,
        );

        // The exhausted lineage left the independent lineage untouched.
        const recordB = terminusRecord(restoredStore, seeded.scenarioB.lineageId);
        assert.equal(recordB.state, "passed");
        assert.equal(recordB.terminalReason, null);
        assert.equal(recordB.counters.reviewerRuns, 2);
        assert.equal(recordB.counters.correctionGenerations, 1);
        assert.equal(recordB.counters.scopeDriftRejections, 1);
      } finally {
        restoredStore.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  "frozen-intent-changing correction is rejected at the durable admission boundary without overwriting the accepted subject",
  async () => {
    const { dir, dbFile } = tempDatabase("a2a-review-intent-gate-");
    try {
      const store = new SqliteBrokerStateStore(dbFile);
      try {
        const broker = new InMemoryA2ABroker(
          store,
          store.load(),
          { reviewLineageMode: "record" },
        );
        const scenarioC = terminusScenario(
          INTENT_GATE_LINEAGE_C,
          HEAD_C,
          DIFF_C,
          NEXT_HEAD_C,
          NEXT_DIFF_C,
        );
        assert.equal(
          (await broker.recordOperatorReviewLineageCreate(
            terminusCreateRequest(scenarioC),
            "operator-seoseo",
          ))?.status,
          "applied",
        );
        assert.equal(
          (await broker.recordReviewerReviewLineageReport(
            scenarioC.lineageId,
            terminusReportRequest({
              lineageId: scenarioC.lineageId,
              binding: terminusBinding(scenarioC),
              reportRef: `review-report:${scenarioC.lineageId}:1`,
              observedAt: T_REPORT,
              verdict: "fail",
              note: "Initial review rejects one blocking correctness finding.",
              newFindings: [terminusBlockingFinding("F-3", scenarioC.headSha)],
            }),
            "reviewer-beta",
          ))?.status,
          "applied",
        );
        assert.equal(
          broker.getReviewLineage(scenarioC.lineageId, T_CREATE)?.state,
          "correction_pending",
        );

        const sourceEventsBefore = countRows(
          dbFile,
          REVIEW_LINEAGE_AUTHORIZED_SOURCE_EVENT_TABLE,
        );
        const ledgerEntriesBefore = countRows(
          dbFile,
          REVIEW_LINEAGE_OBSERVATION_LEDGER_TABLE,
        );

        // (a) Internally consistent but drifted binding: the Phase 8 parser
        // admits it, and the durable exact-subject check rejects it as a
        // stable subject_conflict. The engine's intent_conflict branch is not
        // reachable through this boundary — assert the actual contract.
        const driftedConsistent = terminusCorrectionRequest({
          lineageId: scenarioC.lineageId,
          binding: {
            intentHash: DRIFTED_INTENT_HASH,
            headSha: scenarioC.headSha,
            diffHash: scenarioC.diffHash,
          },
          generationRef: `correction-generation:${scenarioC.lineageId}:drift1`,
          observedAt: T_CORRECTION,
          headSha: scenarioC.nextHeadSha,
          diffHash: scenarioC.nextDiffHash,
          intentHash: DRIFTED_INTENT_HASH,
          pathsChanged: ["packages/broker/src/core/broker.ts"],
        });
        assert.deepEqual(
          await broker.recordOperatorReviewLineageCorrectionGeneration(
            scenarioC.lineageId,
            driftedConsistent,
            "operator-seoseo",
          ),
          {
            status: "subject_conflict",
            lineageId: scenarioC.lineageId,
            outcome: "subject_conflict",
          },
        );

        // (b) Binding and observation intent disagree: rejected by the parser
        // contract before any store access, so no durable row appears.
        const driftedInconsistent = {
          ...driftedConsistent,
          binding: terminusBinding(scenarioC),
          generationRef: `correction-generation:${scenarioC.lineageId}:drift2`,
        };
        await assert.rejects(
          () =>
            broker.recordOperatorReviewLineageCorrectionGeneration(
              scenarioC.lineageId,
              driftedInconsistent,
              "operator-seoseo",
            ),
          (error: unknown) =>
            error instanceof ObservationValidationError &&
            error.code === "binding_mismatch",
        );

        assert.equal(
          countRows(dbFile, REVIEW_LINEAGE_AUTHORIZED_SOURCE_EVENT_TABLE),
          sourceEventsBefore + 1,
        );
        assert.equal(
          countRows(dbFile, REVIEW_LINEAGE_OBSERVATION_LEDGER_TABLE),
          ledgerEntriesBefore + 1,
        );

        // The accepted subject is untouched and the lineage is not terminal.
        const recordC = terminusRecord(store, scenarioC.lineageId);
        assert.equal(recordC.state, "correction_pending");
        assert.equal(recordC.terminalReason, null);
        assert.equal(recordC.counters.correctionGenerations, 0);
        assert.equal(recordC.counters.scopeDriftRejections, 0);
        assert.equal(recordC.currentHeadSha, scenarioC.headSha);
        assert.equal(recordC.currentDiffHash, scenarioC.diffHash);

        // Replaying the drifted source round stays inert as well.
        assert.deepEqual(
          await broker.recordOperatorReviewLineageCorrectionGeneration(
            scenarioC.lineageId,
            driftedConsistent,
            "operator-seoseo",
          ),
          {
            status: "replayed",
            lineageId: scenarioC.lineageId,
            originalOutcome: "subject_conflict",
          },
        );

        // The drift attempts consumed no budget: a correct generation with the
        // frozen intent is still admitted afterwards.
        const properCorrectionC = terminusCorrectionRequest({
          lineageId: scenarioC.lineageId,
          binding: terminusBinding(scenarioC),
          generationRef: `correction-generation:${scenarioC.lineageId}:2`,
          observedAt: T_CORRECTION,
          headSha: scenarioC.nextHeadSha,
          diffHash: scenarioC.nextDiffHash,
          intentHash: scenarioC.intentHash,
          pathsChanged: ["packages/broker/src/core/broker.ts"],
        });
        assert.equal(
          (await broker.recordOperatorReviewLineageCorrectionGeneration(
            scenarioC.lineageId,
            properCorrectionC,
            "operator-seoseo",
          ))?.status,
          "applied",
        );
        assert.equal(
          broker.getReviewLineage(scenarioC.lineageId, T_CREATE)?.state,
          "reviewing_resolution",
        );
        assert.equal(
          broker.getReviewLineage(scenarioC.lineageId, T_CREATE)?.metrics
            .correctionGenerations,
          1,
        );
        assert.equal(
          terminusRecord(store, scenarioC.lineageId).currentHeadSha,
          scenarioC.nextHeadSha,
        );
      } finally {
        store.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
