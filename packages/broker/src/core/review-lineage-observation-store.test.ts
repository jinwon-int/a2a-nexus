import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { Worker } from "node:worker_threads";

import { intentHash } from "../review-lifecycle/canonical-json.js";
import {
  parseReviewLineageObservation,
  type ProjectedReviewLineageObservation,
} from "../review-lifecycle/observation.js";
import type {
  IntentContractV1,
  ReviewLineageBudgetV1,
} from "../review-lifecycle/types.js";
import {
  REVIEW_LINEAGE_OBSERVATION_LEDGER_TABLE,
  SqliteReviewLineageObservationStore,
} from "./review-lineage-observation-store.js";

const BASE_SHA = "0".repeat(40);
const HEAD_SHA = "1".repeat(40);
const DIFF_HASH = `sha256:${"a".repeat(64)}`;
const T0 = "2026-07-23T13:10:00Z";

function contract(lineageId = "pr-1518-phase9"): IntentContractV1 {
  const partial = {
    kind: "IntentContractV1" as const,
    lineageId,
    goal: "Prove restart-safe observation application.",
    nonGoals: ["Do not attach a live producer."],
    invariants: ["Lineage and dedupe ledger commit atomically."],
    acceptanceCriteria: [
      { id: "AC-1", text: "Replay never calls the engine twice." },
    ],
    declaredPaths: {
      allowed: ["packages/broker/src/**"],
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

function binding(lineageId = "pr-1518-phase9") {
  return {
    intentHash: contract(lineageId).intentHash,
    headSha: HEAD_SHA,
    diffHash: DIFF_HASH,
  };
}

function createCommand(
  lineageId = "pr-1518-phase9",
  sourceEventId = "phase9:create:1",
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
  lineageId = "pr-1518-phase9",
  sourceEventId = "phase9:cancel:1",
): ProjectedReviewLineageObservation {
  return parseReviewLineageObservation({
    kind: "a2a.review-lineage-observation.v1",
    producerId: "dispatcher-seoseo",
    sourceEventId,
    lineageId,
    observedAt: "2026-07-23T13:11:00Z",
    binding: binding(lineageId),
    observation: {
      kind: "operator_cancel",
    },
  });
}

function tempDatabase(): { dir: string; dbFile: string } {
  const dir = mkdtempSync(join(tmpdir(), "a2a-review-observation-"));
  return { dir, dbFile: join(dir, "state.sqlite") };
}

test("observation store replays an applied create after process restart", () => {
  const { dir, dbFile } = tempDatabase();
  try {
    const command = createCommand();
    const first = new SqliteReviewLineageObservationStore(dbFile);
    assert.deepEqual(first.apply(command), {
      status: "applied",
      lineageId: command.lineageId,
      outcome: "applied",
      state: "reviewing_initial",
      recordVersion: 1,
      effects: [],
    });
    first.close();

    const restored = new SqliteReviewLineageObservationStore(dbFile);
    assert.deepEqual(restored.apply(command), {
      status: "replayed",
      lineageId: command.lineageId,
      originalOutcome: "applied",
      state: "reviewing_initial",
      recordVersion: 1,
      effects: [],
    });
    assert.equal(restored.countLedgerEntries(), 1);
    restored.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("observation store rejects same-key/different-payload without mutation", () => {
  const { dir, dbFile } = tempDatabase();
  try {
    const store = new SqliteReviewLineageObservationStore(dbFile);
    const command = createCommand();
    assert.equal(store.apply(command).status, "applied");

    const conflicting = structuredClone(command);
    conflicting.payloadFingerprint = `sha256:${"f".repeat(64)}`;
    assert.deepEqual(store.apply(conflicting), {
      status: "idempotency_conflict",
      lineageId: command.lineageId,
    });
    assert.equal(store.countLedgerEntries(), 1);
    assert.equal(store.getLineage(command.lineageId)?.state, "reviewing_initial");
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("missing lineage is a stable recorded outcome even after later creation", () => {
  const { dir, dbFile } = tempDatabase();
  try {
    const store = new SqliteReviewLineageObservationStore(dbFile);
    const missing = cancelCommand("late-lineage", "phase9:cancel:missing");
    assert.deepEqual(store.apply(missing), {
      status: "missing_lineage",
      lineageId: "late-lineage",
      outcome: "missing_lineage",
    });

    assert.equal(
      store.apply(createCommand("late-lineage", "phase9:create:late")).status,
      "applied",
    );
    assert.deepEqual(store.apply(missing), {
      status: "replayed",
      lineageId: "late-lineage",
      originalOutcome: "missing_lineage",
    });
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("intent/head/diff mismatches fail exact-subject CAS and replay stably", () => {
  for (const field of ["intentHash", "headSha", "diffHash"] as const) {
    const { dir, dbFile } = tempDatabase();
    try {
      const lineageId = `subject-${field}`;
      const store = new SqliteReviewLineageObservationStore(dbFile);
      assert.equal(store.apply(createCommand(lineageId, `create:${field}`)).status, "applied");

      const mismatch = cancelCommand(lineageId, `cancel:${field}`);
      mismatch.expectedSubject[field] =
        field === "headSha"
          ? "9".repeat(40)
          : `sha256:${"9".repeat(64)}`;
      assert.deepEqual(store.apply(mismatch), {
        status: "subject_conflict",
        lineageId,
        outcome: "subject_conflict",
      });
      assert.deepEqual(store.apply(mismatch), {
        status: "replayed",
        lineageId,
        originalOutcome: "subject_conflict",
      });
      assert.equal(store.getLineage(lineageId)?.state, "reviewing_initial");
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("lineage write and ledger insert roll back together on commit-path failure", () => {
  const { dir, dbFile } = tempDatabase();
  try {
    const store = new SqliteReviewLineageObservationStore(dbFile);
    assert.equal(store.apply(createCommand()).status, "applied");
    const cancel = cancelCommand();

    const faultDb = new DatabaseSync(dbFile);
    faultDb.exec(`
      CREATE TRIGGER reject_test_observation
      BEFORE INSERT ON ${REVIEW_LINEAGE_OBSERVATION_LEDGER_TABLE}
      WHEN NEW.idempotency_key = '${cancel.idempotencyKey}'
      BEGIN
        SELECT RAISE(ABORT, 'forced_test_failure');
      END
    `);
    assert.throws(() => store.apply(cancel), /forced_test_failure/);
    assert.equal(store.getLineage(cancel.lineageId)?.state, "reviewing_initial");
    assert.equal(store.countLedgerEntries(), 1);
    faultDb.exec("DROP TRIGGER reject_test_observation");
    faultDb.close();

    store.close();
    const restored = new SqliteReviewLineageObservationStore(dbFile);
    assert.deepEqual(restored.apply(cancel), {
      status: "applied",
      lineageId: cancel.lineageId,
      outcome: "applied",
      state: "canceled",
      recordVersion: 2,
      effects: ["operator_canceled"],
    });
    assert.equal(restored.getLineage(cancel.lineageId)?.state, "canceled");
    restored.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("two independent connections apply a concurrent command exactly once", async () => {
  const { dir, dbFile } = tempDatabase();
  try {
    const command = createCommand("concurrent-lineage", "phase9:create:concurrent");
    const moduleUrl = new URL(
      "./review-lineage-observation-store.js",
      import.meta.url,
    ).href;
    const workerSource = `
      const { parentPort, workerData } = require("node:worker_threads");
      (async () => {
        const { SqliteReviewLineageObservationStore } = await import(workerData.moduleUrl);
        parentPort.postMessage("ready");
        await new Promise((resolve) => parentPort.once("message", resolve));
        const store = new SqliteReviewLineageObservationStore(workerData.dbFile);
        try {
          parentPort.postMessage(store.apply(workerData.command));
        } finally {
          store.close();
        }
      })().catch((error) => { throw error; });
    `;
    const workers = [0, 1].map(() => new Worker(workerSource, {
      eval: true,
      workerData: { moduleUrl, dbFile, command },
    }));
    await Promise.all(workers.map((worker) =>
      new Promise<void>((resolve, reject) => {
        worker.once("message", (message) => {
          if (message === "ready") resolve();
          else reject(new Error("worker did not become ready"));
        });
        worker.once("error", reject);
      })
    ));
    for (const worker of workers) worker.postMessage("start");
    const results = await Promise.all(workers.map((worker) =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        worker.once("message", resolve);
        worker.once("error", reject);
      })
    ));
    assert.deepEqual(
      results.map((result) => result.status).sort(),
      ["applied", "replayed"],
    );

    const store = new SqliteReviewLineageObservationStore(dbFile);
    assert.equal(store.countLedgerEntries(), 1);
    assert.equal(store.getLineage(command.lineageId)?.state, "reviewing_initial");
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("engine rejection is redacted, durable, and replayed without reevaluation", () => {
  const { dir, dbFile } = tempDatabase();
  try {
    const store = new SqliteReviewLineageObservationStore(dbFile);
    const invalid = createCommand("invalid-transition", "phase9:create:invalid");
    if (invalid.command.kind !== "create_lineage") {
      throw new Error("fixture must project a create command");
    }
    invalid.command.input.contract.intentHash = `sha256:${"e".repeat(64)}`;

    assert.deepEqual(store.apply(invalid), {
      status: "transition_rejected",
      lineageId: invalid.lineageId,
      outcome: "transition_rejected",
    });
    assert.deepEqual(store.apply(invalid), {
      status: "replayed",
      lineageId: invalid.lineageId,
      originalOutcome: "transition_rejected",
    });
    assert.equal(store.getLineage(invalid.lineageId), undefined);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ledger stores only derived identifiers and redacted outcome metadata", () => {
  const { dir, dbFile } = tempDatabase();
  try {
    const store = new SqliteReviewLineageObservationStore(dbFile);
    const command = createCommand();
    store.apply(command);
    const rejectedReview = parseReviewLineageObservation({
      kind: "a2a.review-lineage-observation.v1",
      producerId: "dispatcher-seoseo",
      sourceEventId: "phase9:review:redaction",
      lineageId: command.lineageId,
      observedAt: "2026-07-23T13:12:00Z",
      binding: binding(),
      observation: {
        kind: "review_report",
        receipt: {
          kind: "ReviewReceiptV1",
          reviewerNodeId: "reviewer-public-fixture",
          verdict: "pass",
          note: "private-note-must-not-enter-ledger",
          headSha: HEAD_SHA,
          diffHash: DIFF_HASH,
          intentHash: contract().intentHash,
          findingLedgerRef: `ledger-${command.lineageId}`,
          authorWorkerId: "author-public-fixture",
        },
        resolvedFindingIds: [],
        reopenedFindingIds: [],
        newFindings: [],
      },
    });
    if (
      rejectedReview.command.kind !== "record_event"
      || rejectedReview.command.event.type !== "review_report"
    ) {
      throw new Error("fixture must project a review event");
    }
    rejectedReview.command.event.receipt.reviewerNodeId =
      "reviewer-private-value";
    rejectedReview.command.event.receipt.intentHash =
      `sha256:${"e".repeat(64)}`;
    assert.deepEqual(store.apply(rejectedReview), {
      status: "applied",
      lineageId: command.lineageId,
      outcome: "applied",
      state: "reviewing_initial",
      recordVersion: 2,
      effects: ["receipt_rejected:intent_hash_mismatch"],
    });
    store.close();

    const db = new DatabaseSync(dbFile);
    const rows = db.prepare(
      `SELECT * FROM ${REVIEW_LINEAGE_OBSERVATION_LEDGER_TABLE}`,
    ).all();
    const serialized = JSON.stringify(rows);
    assert.doesNotMatch(serialized, /Prove restart-safe observation application/);
    assert.doesNotMatch(serialized, /Do not attach a live producer/);
    assert.doesNotMatch(serialized, /dispatcher-seoseo/);
    assert.doesNotMatch(serialized, /phase9:create:1/);
    assert.doesNotMatch(serialized, /reviewer-private-value/);
    assert.doesNotMatch(serialized, /private-note-must-not-enter-ledger/);
    assert.match(serialized, /payload_fingerprint/);
    assert.match(serialized, /expected_subject_fingerprint/);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
