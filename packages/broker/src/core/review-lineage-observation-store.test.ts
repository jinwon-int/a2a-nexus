import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { Worker } from "node:worker_threads";

import { intentHash } from "../review-lifecycle/canonical-json.js";
import {
  deriveObservationIdempotencyKey,
  parseReviewLineageObservation,
  type ProjectedReviewLineageObservation,
} from "../review-lifecycle/observation.js";
import {
  authorizeOperatorReviewLineageCreate,
} from "../review-lifecycle/lineage-create-source.js";
import {
  authorizeOperatorReviewLineageCancel,
} from "../review-lifecycle/operator-cancel-source.js";
import {
  projectReviewLineageProducerFact,
} from "../review-lifecycle/producer-contract.js";
import type {
  IntentContractV1,
  ReviewLineageBudgetV1,
} from "../review-lifecycle/types.js";
import {
  REVIEW_LINEAGE_AUTHORIZED_SOURCE_EVENT_TABLE,
  REVIEW_LINEAGE_OBSERVATION_LEDGER_TABLE,
  SqliteReviewLineageObservationStore,
  type AuthorizedReviewLineageSourceAdmissionV1,
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

function authorizedCancelAdmission(
  lineageId = "pr-1518-phase9",
  decisionRef = "operator-decision:phase14:cancel:1",
  detail = "Explicit bounded review-lineage cancellation.",
): AuthorizedReviewLineageSourceAdmissionV1 {
  const authorized = authorizeOperatorReviewLineageCancel(
    lineageId,
    {
      decisionRef,
      observedAt: "2026-07-23T13:11:00Z",
      binding: binding(lineageId),
      detail,
    },
    "operator-seoseo",
  );
  const command = projectReviewLineageProducerFact(authorized.fact);
  return {
    source: {
      ...authorized.source,
      payloadFingerprint: command.payloadFingerprint,
    },
    command,
  };
}

function authorizedCreateAdmission(
  lineageId = "pr-1518-phase9",
  dispatchRef = "lineage-dispatch:phase15:create:1",
  overrideBudget?: ReviewLineageBudgetV1,
): AuthorizedReviewLineageSourceAdmissionV1 {
  const authorized = authorizeOperatorReviewLineageCreate(
    {
      dispatchRef,
      observedAt: T0,
      binding: binding(lineageId),
      contract: contract(lineageId),
      budget: overrideBudget ?? budget(),
    },
    "operator-seoseo",
  );
  const command = projectReviewLineageProducerFact(authorized.fact);
  return {
    source: {
      ...authorized.source,
      payloadFingerprint: command.payloadFingerprint,
    },
    command,
  };
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

test("authenticated lineage create commits source, lineage, and ledger and replays after restart", () => {
  const { dir, dbFile } = tempDatabase();
  try {
    const admission = authorizedCreateAdmission();
    const first = new SqliteReviewLineageObservationStore(dbFile);
    assert.deepEqual(first.applyAuthorizedSource(admission), {
      status: "applied",
      lineageId: admission.command.lineageId,
      outcome: "applied",
      state: "reviewing_initial",
      recordVersion: 1,
      effects: [],
    });
    assert.equal(first.countLedgerEntries(), 1);
    assert.equal(first.countAuthorizedSourceEvents(), 1);
    first.close();

    const restored = new SqliteReviewLineageObservationStore(dbFile);
    assert.deepEqual(restored.applyAuthorizedSource(admission), {
      status: "replayed",
      lineageId: admission.command.lineageId,
      originalOutcome: "applied",
      state: "reviewing_initial",
      recordVersion: 1,
      effects: [],
    });
    assert.equal(restored.countLedgerEntries(), 1);
    assert.equal(restored.countAuthorizedSourceEvents(), 1);
    restored.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("same lineage dispatch with changed evidence conflicts without overwrite", () => {
  const { dir, dbFile } = tempDatabase();
  try {
    const first = authorizedCreateAdmission();
    const changedBudget = budget();
    changedBudget.maxReviewerRuns = 3;
    const changed = authorizedCreateAdmission(
      first.command.lineageId,
      "lineage-dispatch:phase15:create:1",
      changedBudget,
    );
    assert.equal(first.source.sourceEventId, changed.source.sourceEventId);
    assert.notEqual(
      first.command.payloadFingerprint,
      changed.command.payloadFingerprint,
    );
    const store = new SqliteReviewLineageObservationStore(dbFile);
    assert.equal(store.applyAuthorizedSource(first).status, "applied");
    assert.deepEqual(store.applyAuthorizedSource(changed), {
      status: "idempotency_conflict",
      lineageId: first.command.lineageId,
    });
    assert.equal(store.countLedgerEntries(), 1);
    assert.equal(store.countAuthorizedSourceEvents(), 1);
    assert.equal(
      store.getLineage(first.command.lineageId)?.budget.maxReviewerRuns,
      2,
    );
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("different authenticated source for an existing lineage records and replays subject conflict", () => {
  const { dir, dbFile } = tempDatabase();
  try {
    const lineageId = "phase15-existing-lineage";
    const first = authorizedCreateAdmission(
      lineageId,
      "lineage-dispatch:phase15:first",
    );
    const second = authorizedCreateAdmission(
      lineageId,
      "lineage-dispatch:phase15:second",
    );
    const store = new SqliteReviewLineageObservationStore(dbFile);
    assert.equal(store.applyAuthorizedSource(first).status, "applied");
    assert.deepEqual(store.applyAuthorizedSource(second), {
      status: "subject_conflict",
      lineageId,
      outcome: "subject_conflict",
    });
    assert.deepEqual(store.applyAuthorizedSource(second), {
      status: "replayed",
      lineageId,
      originalOutcome: "subject_conflict",
    });
    assert.equal(store.countLedgerEntries(), 2);
    assert.equal(store.countAuthorizedSourceEvents(), 2);
    assert.equal(store.getLineage(lineageId)?.state, "reviewing_initial");
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("authorized lineage create rolls back lineage and ledger when source insert fails", () => {
  const { dir, dbFile } = tempDatabase();
  try {
    const admission = authorizedCreateAdmission();
    const store = new SqliteReviewLineageObservationStore(dbFile);
    const faultDb = new DatabaseSync(dbFile);
    faultDb.exec(`
      CREATE TRIGGER reject_phase15_authorized_source
      BEFORE INSERT ON ${REVIEW_LINEAGE_AUTHORIZED_SOURCE_EVENT_TABLE}
      WHEN NEW.source_event_id = '${admission.source.sourceEventId}'
      BEGIN
        SELECT RAISE(ABORT, 'forced_phase15_source_failure');
      END
    `);
    assert.throws(
      () => store.applyAuthorizedSource(admission),
      /forced_phase15_source_failure/,
    );
    assert.equal(store.getLineage(admission.command.lineageId), undefined);
    assert.equal(store.countLedgerEntries(), 0);
    assert.equal(store.countAuthorizedSourceEvents(), 0);
    faultDb.exec("DROP TRIGGER reject_phase15_authorized_source");
    faultDb.close();
    assert.equal(store.applyAuthorizedSource(admission).status, "applied");
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("authorized lineage create rolls back lineage and source when ledger insert fails", () => {
  const { dir, dbFile } = tempDatabase();
  try {
    const admission = authorizedCreateAdmission();
    const store = new SqliteReviewLineageObservationStore(dbFile);
    const faultDb = new DatabaseSync(dbFile);
    faultDb.exec(`
      CREATE TRIGGER reject_phase15_observation_ledger
      BEFORE INSERT ON ${REVIEW_LINEAGE_OBSERVATION_LEDGER_TABLE}
      WHEN NEW.idempotency_key = '${admission.command.idempotencyKey}'
      BEGIN
        SELECT RAISE(ABORT, 'forced_phase15_ledger_failure');
      END
    `);
    assert.throws(
      () => store.applyAuthorizedSource(admission),
      /forced_phase15_ledger_failure/,
    );
    assert.equal(store.getLineage(admission.command.lineageId), undefined);
    assert.equal(store.countLedgerEntries(), 0);
    assert.equal(store.countAuthorizedSourceEvents(), 0);
    faultDb.exec("DROP TRIGGER reject_phase15_observation_ledger");
    faultDb.close();
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("authorized source admission rejects cross-kind source and command pairs", () => {
  const { dir, dbFile } = tempDatabase();
  try {
    const store = new SqliteReviewLineageObservationStore(dbFile);
    const create = authorizedCreateAdmission();
    const cancel = authorizedCancelAdmission();
    const createWithCancelSource = {
      source: {
        ...cancel.source,
        payloadFingerprint: create.command.payloadFingerprint,
      },
      command: {
        ...create.command,
        idempotencyKey: deriveObservationIdempotencyKey(
          cancel.source.producerId,
          cancel.source.sourceEventId,
        ),
      },
    } as AuthorizedReviewLineageSourceAdmissionV1;
    const cancelWithCreateSource = {
      source: {
        ...create.source,
        payloadFingerprint: cancel.command.payloadFingerprint,
      },
      command: {
        ...cancel.command,
        idempotencyKey: deriveObservationIdempotencyKey(
          create.source.producerId,
          create.source.sourceEventId,
        ),
      },
    } as AuthorizedReviewLineageSourceAdmissionV1;
    assert.throws(
      () => store.applyAuthorizedSource(createWithCancelSource),
      /invalid_authorized_source/,
    );
    assert.throws(
      () => store.applyAuthorizedSource(cancelWithCreateSource),
      /invalid_authorized_source/,
    );
    assert.equal(store.countLedgerEntries(), 0);
    assert.equal(store.countAuthorizedSourceEvents(), 0);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("authenticated operator cancel commits source, lineage, and ledger and replays after restart", () => {
  const { dir, dbFile } = tempDatabase();
  try {
    const admission = authorizedCancelAdmission();
    const first = new SqliteReviewLineageObservationStore(dbFile);
    assert.equal(first.apply(createCommand()).status, "applied");
    assert.deepEqual(first.applyAuthorizedSource(admission), {
      status: "applied",
      lineageId: admission.command.lineageId,
      outcome: "applied",
      state: "canceled",
      recordVersion: 2,
      effects: ["operator_canceled"],
    });
    assert.equal(first.countLedgerEntries(), 2);
    assert.equal(first.countAuthorizedSourceEvents(), 1);
    first.close();

    const restored = new SqliteReviewLineageObservationStore(dbFile);
    assert.deepEqual(restored.applyAuthorizedSource(admission), {
      status: "replayed",
      lineageId: admission.command.lineageId,
      originalOutcome: "applied",
      state: "canceled",
      recordVersion: 2,
      effects: ["operator_canceled"],
    });
    assert.equal(restored.countLedgerEntries(), 2);
    assert.equal(restored.countAuthorizedSourceEvents(), 1);
    restored.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("same operator decision with changed payload conflicts without overwrite", () => {
  const { dir, dbFile } = tempDatabase();
  try {
    const store = new SqliteReviewLineageObservationStore(dbFile);
    assert.equal(store.apply(createCommand()).status, "applied");
    const first = authorizedCancelAdmission();
    const changed = authorizedCancelAdmission(
      first.command.lineageId,
      "operator-decision:phase14:cancel:1",
      "Changed meaning under one immutable decision.",
    );
    assert.equal(
      first.source.sourceEventId,
      changed.source.sourceEventId,
    );
    assert.notEqual(
      first.command.payloadFingerprint,
      changed.command.payloadFingerprint,
    );
    assert.equal(store.applyAuthorizedSource(first).status, "applied");
    assert.deepEqual(store.applyAuthorizedSource(changed), {
      status: "idempotency_conflict",
      lineageId: first.command.lineageId,
    });
    assert.equal(store.getLineage(first.command.lineageId)?.state, "canceled");
    assert.equal(store.countLedgerEntries(), 2);
    assert.equal(store.countAuthorizedSourceEvents(), 1);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("source insert failure rolls back lineage and observation ledger together", () => {
  const { dir, dbFile } = tempDatabase();
  try {
    const store = new SqliteReviewLineageObservationStore(dbFile);
    assert.equal(store.apply(createCommand()).status, "applied");
    const admission = authorizedCancelAdmission();
    const faultDb = new DatabaseSync(dbFile);
    faultDb.exec(`
      CREATE TRIGGER reject_test_authorized_source
      BEFORE INSERT ON ${REVIEW_LINEAGE_AUTHORIZED_SOURCE_EVENT_TABLE}
      WHEN NEW.source_event_id = '${admission.source.sourceEventId}'
      BEGIN
        SELECT RAISE(ABORT, 'forced_source_failure');
      END
    `);
    assert.throws(
      () => store.applyAuthorizedSource(admission),
      /forced_source_failure/,
    );
    assert.equal(
      store.getLineage(admission.command.lineageId)?.state,
      "reviewing_initial",
    );
    assert.equal(store.countLedgerEntries(), 1);
    assert.equal(store.countAuthorizedSourceEvents(), 0);
    faultDb.exec("DROP TRIGGER reject_test_authorized_source");
    faultDb.close();

    assert.equal(store.applyAuthorizedSource(admission).status, "applied");
    assert.equal(
      store.getLineage(admission.command.lineageId)?.state,
      "canceled",
    );
    assert.equal(store.countLedgerEntries(), 2);
    assert.equal(store.countAuthorizedSourceEvents(), 1);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("authorized source table stores hashes and outcomes without raw operator detail", () => {
  const { dir, dbFile } = tempDatabase();
  try {
    const privateDetail = "private-cancel-detail-must-not-persist";
    const decisionRef = "operator-decision:private-ref-must-not-persist";
    const store = new SqliteReviewLineageObservationStore(dbFile);
    assert.equal(store.apply(createCommand()).status, "applied");
    assert.equal(
      store.applyAuthorizedSource(
        authorizedCancelAdmission(
          "pr-1518-phase9",
          decisionRef,
          privateDetail,
        ),
      ).status,
      "applied",
    );
    const reader = new DatabaseSync(dbFile);
    const row = reader.prepare(
      `SELECT * FROM ${REVIEW_LINEAGE_AUTHORIZED_SOURCE_EVENT_TABLE}`,
    ).get();
    const serialized = JSON.stringify(row);
    assert.doesNotMatch(serialized, new RegExp(privateDetail));
    assert.doesNotMatch(serialized, new RegExp(decisionRef));
    assert.doesNotMatch(serialized, /operator-seoseo/);
    reader.close();
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("authorized source table omits raw lineage dispatch, contract, and operator identity", () => {
  const { dir, dbFile } = tempDatabase();
  try {
    const dispatchRef = "lineage-dispatch:private-ref-must-not-persist";
    const admission = authorizedCreateAdmission(
      "phase15-private-lineage",
      dispatchRef,
    );
    const store = new SqliteReviewLineageObservationStore(dbFile);
    assert.equal(store.applyAuthorizedSource(admission).status, "applied");
    const reader = new DatabaseSync(dbFile);
    const row = reader.prepare(
      `SELECT * FROM ${REVIEW_LINEAGE_AUTHORIZED_SOURCE_EVENT_TABLE}
       WHERE source_kind = 'lineage_contract_frozen'`,
    ).get();
    const serialized = JSON.stringify(row);
    assert.doesNotMatch(serialized, new RegExp(dispatchRef));
    assert.doesNotMatch(serialized, /Prove restart-safe observation application/);
    assert.doesNotMatch(serialized, /operator-seoseo/);
    assert.doesNotMatch(serialized, /phase15-private-lineage/);
    reader.close();
    store.close();
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
