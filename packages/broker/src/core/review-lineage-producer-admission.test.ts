import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { intentHash } from "../review-lifecycle/canonical-json.js";
import {
  REVIEW_LINEAGE_PRODUCER_FACT_KIND,
  type ReviewLineageProducerFactV1,
} from "../review-lifecycle/producer-contract.js";
import type {
  IntentContractV1,
  ReviewLineageBudgetV1,
} from "../review-lifecycle/types.js";
import { InMemoryA2ABroker } from "./broker.js";
import {
  admitReviewLineageProducerFact,
  type ReviewLineageProducerAdmissionContext,
} from "./review-lineage-producer-admission.js";
import {
  createWorkerTask,
  registerWorker,
} from "./broker-test-helpers.js";
import {
  emptySnapshot,
  SqliteBrokerStateStore,
  type BrokerStateStore,
} from "./store.js";
import {
  createWorkerThreadPersistence,
} from "./sqlite-worker-thread-persistence.js";

const BASE_SHA = "1".repeat(40);
const HEAD_SHA = "2".repeat(40);
const DIFF_HASH = `sha256:${"a".repeat(64)}`;
const T0 = "2026-07-23T15:30:00Z";

function contract(lineageId = "phase12-lineage"): IntentContractV1 {
  const partial = {
    kind: "IntentContractV1" as const,
    lineageId,
    goal: "Admit an explicit producer fact with durable ACK.",
    nonGoals: ["Do not infer from generic task lifecycle state."],
    invariants: ["The caller observes every asynchronous store failure."],
    acceptanceCriteria: [
      { id: "AC-1", text: "Off mode remains inert." },
      { id: "AC-2", text: "Record mode awaits one compound command." },
    ],
    declaredPaths: {
      allowed: ["packages/broker/src/core/**"],
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
    maxWallClockSeconds: 21_600,
    maxCorrectionGenerations: 1,
    maxReviewerRuns: 2,
    maxReviewerReplacements: 1,
    repeatedFindingThreshold: 2,
    onExhaustion: "blocked_needs_operator",
  };
}

function createFact(
  lineageId = "phase12-lineage",
  sourceEventId = "phase12:create:1",
): ReviewLineageProducerFactV1 {
  const frozen = contract(lineageId);
  return {
    kind: REVIEW_LINEAGE_PRODUCER_FACT_KIND,
    producerId: "phase12-test-producer",
    sourceEventId,
    lineageId,
    observedAt: T0,
    binding: {
      intentHash: frozen.intentHash,
      headSha: HEAD_SHA,
      diffHash: DIFF_HASH,
    },
    observation: {
      kind: "lineage_create",
      mode: "record",
      contract: frozen,
      budget: budget(),
    },
  };
}

test("off mode is inert before producer-fact validation or store access", async () => {
  let applications = 0;
  const context: ReviewLineageProducerAdmissionContext = {
    mode: "off",
    apply: async () => {
      applications += 1;
      throw new Error("must not be called");
    },
  };

  assert.equal(
    await admitReviewLineageProducerFact(
      { kind: "invalid fact that record mode would reject" },
      context,
    ),
    undefined,
  );
  assert.equal(applications, 0);
});

test("record mode validates once, dispatches one compound command, and awaits ACK", async () => {
  let applications = 0;
  let settle:
    | ((value: {
      status: "applied";
      lineageId: string;
      outcome: "applied";
      state: "reviewing_initial";
      recordVersion: number;
      effects: [];
    }) => void)
    | undefined;
  const durableAck = new Promise<{
    status: "applied";
    lineageId: string;
    outcome: "applied";
    state: "reviewing_initial";
    recordVersion: number;
    effects: [];
  }>((resolve) => {
    settle = resolve;
  });
  const context: ReviewLineageProducerAdmissionContext = {
    mode: "record",
    apply: async (command) => {
      applications += 1;
      assert.equal(command.command.kind, "create_lineage");
      assert.equal(command.lineageId, "phase12-lineage");
      assert.equal(command.observedAt, T0);
      return durableAck;
    },
  };

  let completed = false;
  const pending = admitReviewLineageProducerFact(createFact(), context)
    .then((result) => {
      completed = true;
      return result;
    });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(applications, 1);
  assert.equal(completed, false);

  settle?.({
    status: "applied",
    lineageId: "phase12-lineage",
    outcome: "applied",
    state: "reviewing_initial",
    recordVersion: 1,
    effects: [],
  });
  assert.equal((await pending)?.status, "applied");
  assert.equal(completed, true);
});

test("record mode rejects malformed facts before the store and propagates store errors", async () => {
  let applications = 0;
  const context: ReviewLineageProducerAdmissionContext = {
    mode: "record",
    apply: async () => {
      applications += 1;
      throw new Error("queue_saturated");
    },
  };

  await assert.rejects(
    admitReviewLineageProducerFact(
      { ...createFact(), sourceEventId: "" },
      context,
    ),
    /invalid_string at \$\.sourceEventId/,
  );
  assert.equal(applications, 0);
  await assert.rejects(
    admitReviewLineageProducerFact(createFact(), context),
    /queue_saturated/,
  );
  assert.equal(applications, 1);
});

test("broker admission uses canonical SQLite replay and refreshes projection after ACK", async () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-review-producer-admission-"));
  try {
    const store = new SqliteBrokerStateStore(join(dir, "state.sqlite"));
    const broker = new InMemoryA2ABroker(
      store,
      store.load(),
      { reviewLineageMode: "record" },
    );

    assert.equal(
      (await broker.admitReviewLineageProducerFact(createFact()))?.status,
      "applied",
    );
    assert.equal(
      broker.getReviewLineage("phase12-lineage", T0)?.state,
      "reviewing_initial",
    );
    assert.equal(
      (await broker.admitReviewLineageProducerFact(createFact()))?.status,
      "replayed",
    );
    const changed = structuredClone(createFact());
    if (changed.observation.kind !== "lineage_create") {
      throw new Error("test fixture must be lineage_create");
    }
    changed.observation.budget.maxWallClockSeconds += 1;
    assert.equal(
      (await broker.admitReviewLineageProducerFact(changed))?.status,
      "idempotency_conflict",
    );
    assert.equal(
      broker.getReviewLineage("phase12-lineage", T0)?.state,
      "reviewing_initial",
    );
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("worker-thread admission observes its ACK and propagates queue aborts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-review-producer-worker-"));
  const handle = createWorkerThreadPersistence({
    dbFile: join(dir, "state.sqlite"),
    queueCapacity: 2,
  });
  try {
    const broker = new InMemoryA2ABroker(
      handle.stateStore,
      handle.stateStore.load(),
      { reviewLineageMode: "record" },
    );
    assert.equal(
      (await broker.admitReviewLineageProducerFact(
        createFact("phase12-worker-lineage", "phase12:worker:create:1"),
      ))?.status,
      "applied",
    );
    assert.equal(
      broker.getReviewLineage("phase12-worker-lineage", T0)?.state,
      "reviewing_initial",
    );
    assert.equal(handle.queue.stats().inFlight, 0);

    handle.queue.abort(new Error("worker_crashed"));
    await assert.rejects(
      broker.admitReviewLineageProducerFact(
        createFact("phase12-aborted-lineage", "phase12:worker:create:2"),
      ),
      /worker_crashed/,
    );
  } finally {
    await handle.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("generic complete and cancel paths never synthesize producer facts", () => {
  let applications = 0;
  const stateStore: BrokerStateStore = {
    load: () => emptySnapshot(),
    save: () => undefined,
    applyReviewLineageObservation: async () => {
      applications += 1;
      throw new Error("unexpected automatic observation");
    },
    listCanonicalReviewLineages: () => [],
  };
  const broker = new InMemoryA2ABroker(
    stateStore,
    stateStore.load(),
    { reviewLineageMode: "record" },
  );
  registerWorker(broker, "phase12-worker");

  const completed = createWorkerTask(
    broker,
    "phase12-generic-complete",
    "phase12-worker",
  );
  broker.claimTask(completed.id, "phase12-worker");
  broker.startTask(completed.id, "phase12-worker");
  broker.completeTask(completed.id, "phase12-worker", { summary: "done" });

  const canceled = createWorkerTask(
    broker,
    "phase12-generic-cancel",
    "phase12-worker",
  );
  broker.cancelTask(canceled.id, {
    actor: { id: "phase12-operator", kind: "node", role: "operator" },
    reason: "generic task cancellation is not a lineage fact",
  });
  assert.equal(applications, 0);
});
