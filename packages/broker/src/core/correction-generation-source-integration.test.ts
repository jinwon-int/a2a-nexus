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
  authorizeOperatorReviewLineageCorrectionGeneration,
} from "../review-lifecycle/correction-generation-source.js";
import {
  authorizeOperatorReviewLineageCreate,
} from "../review-lifecycle/lineage-create-source.js";
import {
  authorizeOperatorReviewLineageCancel,
} from "../review-lifecycle/operator-cancel-source.js";
import {
  projectReviewLineageProducerFact,
} from "../review-lifecycle/producer-contract.js";
import {
  authorizeReviewerReviewLineageReport,
} from "../review-lifecycle/review-report-source.js";
import {
  REVIEW_LINEAGE_SOURCE_CARRIER_KIND,
  authorizeReviewLineageSourceCarrier,
  createReviewLineageTrustedSourceContext,
} from "../review-lifecycle/source-carrier.js";
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
const NEXT_SHA = "2".repeat(40);
const DIFF_HASH = `sha256:${"a".repeat(64)}`;
const NEXT_DIFF_HASH = `sha256:${"b".repeat(64)}`;
const T0 = "2026-07-28T11:10:00Z";
const T1 = "2026-07-28T11:11:00Z";
const T2 = "2026-07-28T11:12:00Z";
const OPERATOR_ID = "operator-alpha";
const REVIEWER_ID = "reviewer-beta";
const ALLOWED_PATH =
  "packages/broker/src/review-lifecycle/correction-generation-source.ts";

function contract(lineageId = "phase17-atomic"): IntentContractV1 {
  const partial = {
    kind: "IntentContractV1" as const,
    lineageId,
    goal: "Record an already committed correction generation.",
    nonGoals: ["Do not apply or auto-push a fixer patch."],
    invariants: ["Frozen intent and allowed paths remain authoritative."],
    acceptanceCriteria: [
      { id: "AC-1", text: "Correction admission is atomic and bounded." },
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
    maxWallClockSeconds: 21_600,
    maxCorrectionGenerations: 1,
    maxReviewerRuns: 2,
    maxReviewerReplacements: 1,
    repeatedFindingThreshold: 2,
    onExhaustion: "blocked_needs_operator",
  };
}

function binding(lineageId = "phase17-atomic") {
  return {
    intentHash: contract(lineageId).intentHash,
    headSha: HEAD_SHA,
    diffHash: DIFF_HASH,
  };
}

function admission(
  authorized: ReturnType<
    | typeof authorizeOperatorReviewLineageCreate
    | typeof authorizeOperatorReviewLineageCancel
    | typeof authorizeOperatorReviewLineageCorrectionGeneration
    | typeof authorizeReviewerReviewLineageReport
  >,
): AuthorizedReviewLineageSourceAdmissionV1 {
  const command = projectReviewLineageProducerFact(authorized.fact);
  return {
    source: {
      ...authorized.source,
      payloadFingerprint: command.payloadFingerprint,
    },
    command,
  };
}

function createAdmission(
  lineageId = "phase17-atomic",
): AuthorizedReviewLineageSourceAdmissionV1 {
  return admission(authorizeOperatorReviewLineageCreate(
    {
      dispatchRef: `lineage-dispatch:${lineageId}:1`,
      observedAt: T0,
      binding: binding(lineageId),
      contract: contract(lineageId),
      budget: budget(),
    },
    OPERATOR_ID,
  ));
}

function blockingFinding() {
  const signable = {
    criterionRef: "AC-1",
    category: "correctness" as const,
    evidenceRefs: ["packages/broker/src/core/broker.ts:700"],
  };
  return {
    findingId: "F-1",
    ...signable,
    severity: "major" as const,
    blocking: true,
    introducedAtHead: HEAD_SHA,
    firstSeenAtHead: HEAD_SHA,
    resolvedAtHead: null,
    disposition: "open" as const,
    signature: findingSignature(signable),
  };
}

function failedReportAdmission(
  lineageId = "phase17-atomic",
): AuthorizedReviewLineageSourceAdmissionV1 {
  const subject = binding(lineageId);
  return admission(authorizeReviewerReviewLineageReport(
    lineageId,
    {
      reportRef: `review-report:${lineageId}:initial`,
      observedAt: T1,
      binding: subject,
      receipt: {
        kind: "ReviewReceiptV1",
        reviewerNodeId: REVIEWER_ID,
        verdict: "fail",
        note: "One bounded correction is required.",
        headSha: subject.headSha,
        diffHash: subject.diffHash,
        intentHash: subject.intentHash,
        findingLedgerRef: `ledger-${lineageId}`,
        authorWorkerId: "author-alpha",
        submittedAt: T1,
      },
      resolvedFindingIds: [],
      reopenedFindingIds: [],
      newFindings: [blockingFinding()],
    },
    REVIEWER_ID,
  ));
}

function passingReportAdmission(
  lineageId: string,
): AuthorizedReviewLineageSourceAdmissionV1 {
  const subject = binding(lineageId);
  return admission(authorizeReviewerReviewLineageReport(
    lineageId,
    {
      reportRef: `review-report:${lineageId}:pass`,
      observedAt: T1,
      binding: subject,
      receipt: {
        kind: "ReviewReceiptV1",
        reviewerNodeId: REVIEWER_ID,
        verdict: "pass",
        note: "Compatibility pass.",
        headSha: subject.headSha,
        diffHash: subject.diffHash,
        intentHash: subject.intentHash,
        findingLedgerRef: `ledger-${lineageId}`,
        authorWorkerId: "author-alpha",
        submittedAt: T1,
      },
      resolvedFindingIds: [],
      reopenedFindingIds: [],
      newFindings: [],
    },
    REVIEWER_ID,
  ));
}

function correctionAdmission(options: {
  lineageId?: string;
  generationRef?: string;
  pathsChanged?: string[];
  bindingOverride?: ReturnType<typeof binding>;
} = {}): AuthorizedReviewLineageSourceAdmissionV1 {
  const lineageId = options.lineageId ?? "phase17-atomic";
  const subject = options.bindingOverride ?? binding(lineageId);
  return admission(authorizeOperatorReviewLineageCorrectionGeneration(
    lineageId,
    {
      generationRef:
        options.generationRef ?? `correction-generation:${lineageId}:1`,
      observedAt: T2,
      binding: subject,
      headSha: NEXT_SHA,
      diffHash: NEXT_DIFF_HASH,
      intentHash: subject.intentHash,
      pathsChanged: options.pathsChanged ?? [ALLOWED_PATH],
    },
    OPERATOR_ID,
  ));
}

function cancelAdmission(
  lineageId: string,
): AuthorizedReviewLineageSourceAdmissionV1 {
  return admission(authorizeOperatorReviewLineageCancel(
    lineageId,
    {
      decisionRef: `operator-decision:${lineageId}:1`,
      observedAt: T1,
      binding: binding(lineageId),
      detail: "Explicit compatibility cancellation.",
    },
    OPERATOR_ID,
  ));
}

function detachedReplacementAdmission():
  AuthorizedReviewLineageSourceAdmissionV1 {
  const observedAt = T2;
  const fact = authorizeReviewLineageSourceCarrier(
    {
      kind: REVIEW_LINEAGE_SOURCE_CARRIER_KIND,
      sourceKind: "reviewer_replacement_decided",
      sourceEventRef: "detached:reviewer-replacement:1",
      lineageId: "phase17-atomic",
      observedAt,
      binding: binding(),
      observation: {
        kind: "reviewer_replacement",
        reason: "infrastructure_failure",
      },
    },
    createReviewLineageTrustedSourceContext({
      authorityKind: "reviewer_allocator",
      issuerId: "owner-reviewer-replacement",
      sourceNamespace: "test:detached-reviewer-replacement:v1",
    }),
  );
  const command = projectReviewLineageProducerFact(fact);
  return {
    source: {
      sourceEventId: fact.sourceEventId,
      producerId: fact.producerId,
      sourceKind: "reviewer_replacement_decided",
      authorityKind: "reviewer_allocator",
      sourceEventRefHash: `sha256:${"d".repeat(64)}`,
      observedAt,
      payloadFingerprint: command.payloadFingerprint,
    },
    command,
  } as unknown as AuthorizedReviewLineageSourceAdmissionV1;
}

function tempDatabase(): { dir: string; dbFile: string } {
  const dir = mkdtempSync(join(tmpdir(), "a2a-correction-source-"));
  return { dir, dbFile: join(dir, "state.sqlite") };
}

function preparePending(
  store: SqliteReviewLineageObservationStore,
  lineageId = "phase17-atomic",
): void {
  assert.equal(
    store.applyAuthorizedSource(createAdmission(lineageId)).status,
    "applied",
  );
  assert.equal(
    store.applyAuthorizedSource(failedReportAdmission(lineageId)).status,
    "applied",
  );
  assert.equal(store.getLineage(lineageId)?.state, "correction_pending");
}

test("direct SQLite path atomically commits correction source, lineage, and ledger", () => {
  const { dir, dbFile } = tempDatabase();
  try {
    const store = new SqliteReviewLineageObservationStore(dbFile);
    preparePending(store);
    assert.deepEqual(store.applyAuthorizedSource(correctionAdmission()), {
      status: "applied",
      lineageId: "phase17-atomic",
      outcome: "applied",
      state: "reviewing_resolution",
      recordVersion: 3,
      effects: ["generation_accepted"],
    });
    const record = store.getLineage("phase17-atomic");
    assert.equal(record?.counters.correctionGenerations, 1);
    assert.equal(record?.currentHeadSha, NEXT_SHA);
    assert.equal(record?.currentDiffHash, NEXT_DIFF_HASH);
    assert.equal(store.countLedgerEntries(), 3);
    assert.equal(store.countAuthorizedSourceEvents(), 3);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("correction source is rejected outside correction_pending and exact subject mismatch fails closed", () => {
  const { dir, dbFile } = tempDatabase();
  try {
    const store = new SqliteReviewLineageObservationStore(dbFile);
    assert.equal(store.applyAuthorizedSource(createAdmission()).status, "applied");
    const outOfState = correctionAdmission({
      generationRef: "correction-generation:out-of-state:1",
    });
    assert.deepEqual(store.applyAuthorizedSource(outOfState), {
      status: "transition_rejected",
      lineageId: "phase17-atomic",
      outcome: "transition_rejected",
    });
    assert.equal(store.getLineage("phase17-atomic")?.state, "reviewing_initial");

    assert.equal(
      store.applyAuthorizedSource(failedReportAdmission()).status,
      "applied",
    );
    const stale = correctionAdmission({
      generationRef: "correction-generation:stale-subject:1",
      bindingOverride: {
        ...binding(),
        headSha: "9".repeat(40),
      },
    });
    assert.deepEqual(store.applyAuthorizedSource(stale), {
      status: "subject_conflict",
      lineageId: "phase17-atomic",
      outcome: "subject_conflict",
    });
    const record = store.getLineage("phase17-atomic");
    assert.equal(record?.state, "correction_pending");
    assert.equal(record?.counters.correctionGenerations, 0);
    assert.equal(record?.currentHeadSha, HEAD_SHA);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("forbidden and out-of-scope paths preserve the pending head and fail closed", () => {
  const { dir, dbFile } = tempDatabase();
  try {
    const store = new SqliteReviewLineageObservationStore(dbFile);
    preparePending(store);
    const forbidden = correctionAdmission({
      generationRef: "correction-generation:forbidden:1",
      pathsChanged: ["packages/broker/src/worker.ts"],
    });
    assert.deepEqual(store.applyAuthorizedSource(forbidden), {
      status: "applied",
      lineageId: "phase17-atomic",
      outcome: "applied",
      state: "correction_pending",
      recordVersion: 3,
      effects: ["forbidden_path_rejected"],
    });
    const outside = correctionAdmission({
      generationRef: "correction-generation:outside:1",
      pathsChanged: ["docs/operators.md"],
    });
    assert.deepEqual(store.applyAuthorizedSource(outside), {
      status: "applied",
      lineageId: "phase17-atomic",
      outcome: "applied",
      state: "correction_pending",
      recordVersion: 4,
      effects: ["scope_drift_rejected"],
    });
    const record = store.getLineage("phase17-atomic");
    assert.equal(record?.counters.scopeDriftRejections, 2);
    assert.equal(record?.counters.correctionGenerations, 0);
    assert.equal(record?.currentHeadSha, HEAD_SHA);
    assert.equal(record?.currentDiffHash, DIFF_HASH);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("correction source replays after restart and changed payload conflicts", () => {
  const { dir, dbFile } = tempDatabase();
  try {
    const firstCorrection = correctionAdmission();
    const first = new SqliteReviewLineageObservationStore(dbFile);
    preparePending(first);
    assert.equal(first.applyAuthorizedSource(firstCorrection).status, "applied");
    first.close();

    const restored = new SqliteReviewLineageObservationStore(dbFile);
    assert.deepEqual(restored.applyAuthorizedSource(firstCorrection), {
      status: "replayed",
      lineageId: "phase17-atomic",
      originalOutcome: "applied",
      state: "reviewing_resolution",
      recordVersion: 3,
      effects: ["generation_accepted"],
    });
    const changed = correctionAdmission({
      pathsChanged: ["packages/broker/src/core/store.ts"],
    });
    assert.equal(
      changed.source.sourceEventId,
      firstCorrection.source.sourceEventId,
    );
    assert.deepEqual(restored.applyAuthorizedSource(changed), {
      status: "idempotency_conflict",
      lineageId: "phase17-atomic",
    });
    assert.equal(
      restored.getLineage("phase17-atomic")?.counters.correctionGenerations,
      1,
    );
    assert.equal(restored.countLedgerEntries(), 3);
    assert.equal(restored.countAuthorizedSourceEvents(), 3);
    restored.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("correction source and ledger insert failures roll back the lineage transition", () => {
  for (const target of ["source", "ledger"] as const) {
    const { dir, dbFile } = tempDatabase();
    try {
      const store = new SqliteReviewLineageObservationStore(dbFile);
      preparePending(store);
      const correction = correctionAdmission();
      const faultDb = new DatabaseSync(dbFile);
      if (target === "source") {
        faultDb.exec(`
          CREATE TRIGGER reject_phase17_source
          BEFORE INSERT ON ${REVIEW_LINEAGE_AUTHORIZED_SOURCE_EVENT_TABLE}
          WHEN NEW.source_event_id = '${correction.source.sourceEventId}'
          BEGIN
            SELECT RAISE(ABORT, 'forced_phase17_source_failure');
          END
        `);
      } else {
        faultDb.exec(`
          CREATE TRIGGER reject_phase17_ledger
          BEFORE INSERT ON ${REVIEW_LINEAGE_OBSERVATION_LEDGER_TABLE}
          WHEN NEW.idempotency_key = '${correction.command.idempotencyKey}'
          BEGIN
            SELECT RAISE(ABORT, 'forced_phase17_ledger_failure');
          END
        `);
      }
      assert.throws(
        () => store.applyAuthorizedSource(correction),
        new RegExp(`forced_phase17_${target}_failure`),
      );
      const record = store.getLineage("phase17-atomic");
      assert.equal(record?.state, "correction_pending");
      assert.equal(record?.counters.correctionGenerations, 0);
      assert.equal(record?.currentHeadSha, HEAD_SHA);
      assert.equal(store.countLedgerEntries(), 2);
      assert.equal(store.countAuthorizedSourceEvents(), 2);
      faultDb.close();
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("closed source admission attaches correction, keeps replacement detached, and preserves existing sources", () => {
  const { dir, dbFile } = tempDatabase();
  try {
    const store = new SqliteReviewLineageObservationStore(dbFile);
    preparePending(store);
    const correction = correctionAdmission();
    for (const source of [
      { ...correction.source, authorityKind: "reviewer" },
      { ...correction.source, sourceKind: "review_report_submitted" },
    ]) {
      assert.throws(
        () => store.applyAuthorizedSource({
          ...correction,
          source,
        } as unknown as AuthorizedReviewLineageSourceAdmissionV1),
        /invalid_authorized_source/,
      );
    }
    assert.equal(
      store.applyAuthorizedSource(correction).status,
      "applied",
    );
    assert.throws(
      () => store.applyAuthorizedSource(detachedReplacementAdmission()),
      /invalid_authorized_source/,
    );

    const passLineage = "phase17-review-compat";
    assert.equal(
      store.applyAuthorizedSource(createAdmission(passLineage)).status,
      "applied",
    );
    assert.equal(
      store.applyAuthorizedSource(passingReportAdmission(passLineage)).status,
      "applied",
    );
    assert.equal(store.getLineage(passLineage)?.state, "passed");

    const cancelLineage = "phase17-cancel-compat";
    assert.equal(
      store.applyAuthorizedSource(createAdmission(cancelLineage)).status,
      "applied",
    );
    assert.equal(
      store.applyAuthorizedSource(cancelAdmission(cancelLineage)).status,
      "applied",
    );
    assert.equal(store.getLineage(cancelLineage)?.state, "canceled");
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("minimized source metadata excludes generation reference, operator, and paths", () => {
  const { dir, dbFile } = tempDatabase();
  try {
    const generationRef = "correction-generation:private-ref:1";
    const privatePath =
      "packages/broker/src/core/private-correction-detail.ts";
    const store = new SqliteReviewLineageObservationStore(dbFile);
    preparePending(store);
    assert.equal(
      store.applyAuthorizedSource(correctionAdmission({
        generationRef,
        pathsChanged: [privatePath],
      })).status,
      "applied",
    );
    const reader = new DatabaseSync(dbFile);
    const row = reader.prepare(
      `SELECT * FROM ${REVIEW_LINEAGE_AUTHORIZED_SOURCE_EVENT_TABLE}
       WHERE source_kind = 'correction_generation_committed'`,
    ).get();
    const serialized = JSON.stringify(row);
    assert.doesNotMatch(serialized, new RegExp(generationRef));
    assert.doesNotMatch(serialized, new RegExp(OPERATOR_ID));
    assert.doesNotMatch(serialized, new RegExp(privatePath));
    assert.doesNotMatch(serialized, /credential|provider|prompt|patch/i);
    reader.close();
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
