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
  authorizeOperatorReviewLineageReviewerReplacement,
} from "../review-lifecycle/reviewer-replacement-source.js";
import {
  REVIEW_LINEAGE_ATTACHED_SOURCE_TUPLES,
} from "../review-lifecycle/authorized-source.js";
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
const T0 = "2026-07-28T12:10:00Z";
const T1 = "2026-07-28T12:11:00Z";
const T2 = "2026-07-28T12:12:00Z";
const T3 = "2026-07-28T12:13:00Z";
const OPERATOR_ID = "operator-alpha";
const REVIEWER_ID = "reviewer-beta";

function contract(lineageId: string): IntentContractV1 {
  const partial = {
    kind: "IntentContractV1" as const,
    lineageId,
    goal: "Record a bounded infrastructure-failure reviewer replacement.",
    nonGoals: [
      "Do not select a replacement reviewer or mutate task assignment.",
    ],
    invariants: [
      "Shared lineage state and budgets remain authoritative.",
    ],
    acceptanceCriteria: [
      { id: "AC-1", text: "Replacement admission is atomic and bounded." },
    ],
    declaredPaths: { allowed: ["packages/broker/src/**"] },
    baseSha: BASE_SHA,
    headSha: HEAD_SHA,
    createdAt: T0,
  };
  return {
    ...partial,
    intentHash: intentHash(partial as unknown as Record<string, unknown>),
  };
}

function budget(maxReviewerReplacements = 1): ReviewLineageBudgetV1 {
  return {
    kind: "ReviewLineageBudgetV1",
    maxWallClockSeconds: 21_600,
    maxCorrectionGenerations: 1,
    maxReviewerRuns: 2,
    maxReviewerReplacements,
    repeatedFindingThreshold: 2,
    onExhaustion: "blocked_needs_operator",
  };
}

function binding(lineageId: string) {
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
    | typeof authorizeOperatorReviewLineageReviewerReplacement
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
  lineageId: string,
  maxReviewerReplacements = 1,
): AuthorizedReviewLineageSourceAdmissionV1 {
  return admission(authorizeOperatorReviewLineageCreate(
    {
      dispatchRef: `lineage-dispatch:${lineageId}:1`,
      observedAt: T0,
      binding: binding(lineageId),
      contract: contract(lineageId),
      budget: budget(maxReviewerReplacements),
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

function reviewAdmission(
  lineageId: string,
  verdict: "pass" | "fail",
): AuthorizedReviewLineageSourceAdmissionV1 {
  const subject = binding(lineageId);
  return admission(authorizeReviewerReviewLineageReport(
    lineageId,
    {
      reportRef: `review-report:${lineageId}:${verdict}`,
      observedAt: T1,
      binding: subject,
      receipt: {
        kind: "ReviewReceiptV1",
        reviewerNodeId: REVIEWER_ID,
        verdict,
        note: verdict === "pass"
          ? "Bounded compatibility pass."
          : "One bounded correction remains.",
        headSha: subject.headSha,
        diffHash: subject.diffHash,
        intentHash: subject.intentHash,
        findingLedgerRef: `ledger-${lineageId}`,
        authorWorkerId: "author-alpha",
        submittedAt: T1,
      },
      resolvedFindingIds: [],
      reopenedFindingIds: [],
      newFindings: verdict === "fail" ? [blockingFinding()] : [],
    },
    REVIEWER_ID,
  ));
}

function correctionAdmission(
  lineageId: string,
): AuthorizedReviewLineageSourceAdmissionV1 {
  const subject = binding(lineageId);
  return admission(authorizeOperatorReviewLineageCorrectionGeneration(
    lineageId,
    {
      generationRef: `correction-generation:${lineageId}:1`,
      observedAt: T2,
      binding: subject,
      headSha: NEXT_SHA,
      diffHash: NEXT_DIFF_HASH,
      intentHash: subject.intentHash,
      pathsChanged: [
        "packages/broker/src/review-lifecycle/reviewer-replacement-source.ts",
      ],
    },
    OPERATOR_ID,
  ));
}

function replacementAdmission(options: {
  lineageId: string;
  decisionRef?: string;
  observedAt?: string;
  bindingOverride?: ReturnType<typeof binding>;
}): AuthorizedReviewLineageSourceAdmissionV1 {
  return admission(authorizeOperatorReviewLineageReviewerReplacement(
    options.lineageId,
    {
      decisionRef:
        options.decisionRef
        ?? `reviewer-replacement:${options.lineageId}:1`,
      observedAt: options.observedAt ?? T2,
      binding:
        options.bindingOverride ?? binding(options.lineageId),
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
      observedAt: T2,
      binding: binding(lineageId),
      detail: "Explicit compatibility cancellation.",
    },
    OPERATOR_ID,
  ));
}

function tempDatabase(): { dir: string; dbFile: string } {
  const dir = mkdtempSync(join(tmpdir(), "a2a-replacement-source-"));
  return { dir, dbFile: join(dir, "state.sqlite") };
}

test("direct SQLite replacement increments only its counter and preserves shared lineage state", () => {
  const { dir, dbFile } = tempDatabase();
  try {
    const lineageId = "phase18-preservation";
    const store = new SqliteReviewLineageObservationStore(dbFile);
    assert.equal(
      store.applyAuthorizedSource(createAdmission(lineageId)).status,
      "applied",
    );
    assert.equal(
      store.applyAuthorizedSource(reviewAdmission(lineageId, "fail")).status,
      "applied",
    );
    const before = store.getLineage(lineageId);
    assert.ok(before);

    assert.deepEqual(
      store.applyAuthorizedSource(replacementAdmission({ lineageId })),
      {
        status: "applied",
        lineageId,
        outcome: "applied",
        state: "correction_pending",
        recordVersion: 3,
        effects: ["reviewer_replaced:infrastructure_failure"],
      },
    );
    const after = store.getLineage(lineageId);
    assert.ok(after);
    assert.equal(
      after.counters.reviewerReplacements,
      before.counters.reviewerReplacements + 1,
    );
    assert.deepEqual(
      {
        ...after.counters,
        reviewerReplacements: before.counters.reviewerReplacements,
      },
      before.counters,
    );
    assert.deepEqual(after.budget, before.budget);
    assert.equal(after.startedAt, before.startedAt);
    assert.equal(after.contract.intentHash, before.contract.intentHash);
    assert.equal(after.currentHeadSha, before.currentHeadSha);
    assert.equal(after.currentDiffHash, before.currentDiffHash);
    assert.deepEqual(after.ledger, before.ledger);
    assert.equal(after.state, before.state);
    assert.equal(store.countLedgerEntries(), 3);
    assert.equal(store.countAuthorizedSourceEvents(), 3);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("replacement exact-subject CAS and terminal rejection fail closed", () => {
  const { dir, dbFile } = tempDatabase();
  try {
    const staleId = "phase18-stale-subject";
    const store = new SqliteReviewLineageObservationStore(dbFile);
    assert.equal(
      store.applyAuthorizedSource(createAdmission(staleId)).status,
      "applied",
    );
    assert.deepEqual(
      store.applyAuthorizedSource(replacementAdmission({
        lineageId: staleId,
        decisionRef: "reviewer-replacement:stale:1",
        bindingOverride: {
          ...binding(staleId),
          headSha: "9".repeat(40),
        },
      })),
      {
        status: "subject_conflict",
        lineageId: staleId,
        outcome: "subject_conflict",
      },
    );
    assert.equal(
      store.getLineage(staleId)?.counters.reviewerReplacements,
      0,
    );

    const terminalId = "phase18-terminal";
    assert.equal(
      store.applyAuthorizedSource(createAdmission(terminalId)).status,
      "applied",
    );
    assert.equal(
      store.applyAuthorizedSource(reviewAdmission(terminalId, "pass")).status,
      "applied",
    );
    const before = store.getLineage(terminalId);
    assert.ok(before);
    assert.deepEqual(
      store.applyAuthorizedSource(replacementAdmission({
        lineageId: terminalId,
      })),
      {
        status: "transition_rejected",
        lineageId: terminalId,
        outcome: "transition_rejected",
      },
    );
    assert.deepEqual(store.getLineage(terminalId), before);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reviewer-replacement budget exhaustion is terminal, visible, and cannot restart", () => {
  const { dir, dbFile } = tempDatabase();
  try {
    const lineageId = "phase18-budget";
    const store = new SqliteReviewLineageObservationStore(dbFile);
    assert.equal(
      store.applyAuthorizedSource(createAdmission(lineageId, 1)).status,
      "applied",
    );
    assert.equal(
      store.applyAuthorizedSource(replacementAdmission({
        lineageId,
        decisionRef: "reviewer-replacement:budget:1",
        observedAt: T1,
      })).status,
      "applied",
    );
    assert.deepEqual(
      store.applyAuthorizedSource(replacementAdmission({
        lineageId,
        decisionRef: "reviewer-replacement:budget:2",
        observedAt: T2,
      })),
      {
        status: "applied",
        lineageId,
        outcome: "applied",
        state: "blocked_needs_operator",
        recordVersion: 3,
        effects: ["budget_exhausted:reviewer_replacements"],
      },
    );
    const exhausted = store.getLineage(lineageId);
    assert.equal(exhausted?.state, "blocked_needs_operator");
    assert.equal(exhausted?.terminalReason, "budget_reviewer_runs");
    assert.equal(exhausted?.counters.reviewerReplacements, 2);
    assert.equal(exhausted?.startedAt, T0);
    assert.deepEqual(
      store.applyAuthorizedSource(replacementAdmission({
        lineageId,
        decisionRef: "reviewer-replacement:budget:3",
        observedAt: T3,
      })),
      {
        status: "transition_rejected",
        lineageId,
        outcome: "transition_rejected",
      },
    );
    assert.deepEqual(store.getLineage(lineageId), exhausted);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("replacement replays after restart, conflicts on changed payload, and minimizes source metadata", () => {
  const { dir, dbFile } = tempDatabase();
  const lineageId = "phase18-restart";
  const decisionRef = "reviewer-replacement:private-decision:1";
  try {
    const replacement = replacementAdmission({ lineageId, decisionRef });
    const first = new SqliteReviewLineageObservationStore(dbFile);
    assert.equal(
      first.applyAuthorizedSource(createAdmission(lineageId)).status,
      "applied",
    );
    assert.equal(first.applyAuthorizedSource(replacement).status, "applied");
    first.close();

    const restored = new SqliteReviewLineageObservationStore(dbFile);
    assert.deepEqual(restored.applyAuthorizedSource(replacement), {
      status: "replayed",
      lineageId,
      originalOutcome: "applied",
      state: "reviewing_initial",
      recordVersion: 2,
      effects: ["reviewer_replaced:infrastructure_failure"],
    });
    const changed = replacementAdmission({
      lineageId,
      decisionRef,
      observedAt: T3,
    });
    assert.equal(
      changed.source.sourceEventId,
      replacement.source.sourceEventId,
    );
    assert.deepEqual(restored.applyAuthorizedSource(changed), {
      status: "idempotency_conflict",
      lineageId,
    });
    assert.equal(
      restored.getLineage(lineageId)?.counters.reviewerReplacements,
      1,
    );
    assert.equal(restored.countLedgerEntries(), 2);
    assert.equal(restored.countAuthorizedSourceEvents(), 2);

    const reader = new DatabaseSync(dbFile);
    const row = reader.prepare(
      `SELECT * FROM ${REVIEW_LINEAGE_AUTHORIZED_SOURCE_EVENT_TABLE}
       WHERE source_kind = 'reviewer_replacement_decided'`,
    ).get();
    const serialized = JSON.stringify(row);
    assert.doesNotMatch(serialized, new RegExp(decisionRef));
    assert.doesNotMatch(serialized, new RegExp(OPERATOR_ID));
    assert.doesNotMatch(serialized, /reviewer-beta|task|assignment/i);
    assert.doesNotMatch(serialized, /credential|provider|prompt|log|prose/i);
    reader.close();
    restored.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("replacement source and ledger insert failures roll back the lineage transition", () => {
  for (const target of ["source", "ledger"] as const) {
    const { dir, dbFile } = tempDatabase();
    try {
      const lineageId = `phase18-rollback-${target}`;
      const store = new SqliteReviewLineageObservationStore(dbFile);
      assert.equal(
        store.applyAuthorizedSource(createAdmission(lineageId)).status,
        "applied",
      );
      const replacement = replacementAdmission({ lineageId });
      const faultDb = new DatabaseSync(dbFile);
      const table = target === "source"
        ? REVIEW_LINEAGE_AUTHORIZED_SOURCE_EVENT_TABLE
        : REVIEW_LINEAGE_OBSERVATION_LEDGER_TABLE;
      const column = target === "source"
        ? "source_event_id"
        : "idempotency_key";
      const value = target === "source"
        ? replacement.source.sourceEventId
        : replacement.command.idempotencyKey;
      faultDb.exec(`
        CREATE TRIGGER reject_phase18_${target}
        BEFORE INSERT ON ${table}
        WHEN NEW.${column} = '${value}'
        BEGIN
          SELECT RAISE(ABORT, 'forced_phase18_${target}_failure');
        END
      `);
      assert.throws(
        () => store.applyAuthorizedSource(replacement),
        new RegExp(`forced_phase18_${target}_failure`),
      );
      const record = store.getLineage(lineageId);
      assert.equal(record?.state, "reviewing_initial");
      assert.equal(record?.counters.reviewerReplacements, 0);
      assert.equal(record?.currentHeadSha, HEAD_SHA);
      assert.equal(record?.currentDiffHash, DIFF_HASH);
      assert.equal(store.countLedgerEntries(), 1);
      assert.equal(store.countAuthorizedSourceEvents(), 1);
      faultDb.close();
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("closed attached set is exactly five tuples and preserves all four prior sources", () => {
  assert.deepEqual(REVIEW_LINEAGE_ATTACHED_SOURCE_TUPLES, [
    {
      sourceKind: "lineage_contract_frozen",
      authorityKind: "lineage_dispatcher",
      commandKind: "create_lineage",
      observationKind: "lineage_create",
    },
    {
      sourceKind: "review_report_submitted",
      authorityKind: "reviewer",
      commandKind: "record_event",
      observationKind: "review_report",
    },
    {
      sourceKind: "correction_generation_committed",
      authorityKind: "correction_controller",
      commandKind: "record_event",
      observationKind: "correction_generation",
    },
    {
      sourceKind: "reviewer_replacement_decided",
      authorityKind: "reviewer_allocator",
      commandKind: "record_event",
      observationKind: "reviewer_replacement",
    },
    {
      sourceKind: "lineage_cancel_decided",
      authorityKind: "operator",
      commandKind: "record_event",
      observationKind: "operator_cancel",
    },
  ]);

  const { dir, dbFile } = tempDatabase();
  try {
    const store = new SqliteReviewLineageObservationStore(dbFile);

    const replacementId = "phase18-five-replacement";
    assert.equal(
      store.applyAuthorizedSource(createAdmission(replacementId)).status,
      "applied",
    );
    const replacement = replacementAdmission({ lineageId: replacementId });
    for (const invalid of [
      {
        ...replacement,
        source: {
          ...replacement.source,
          authorityKind: "reviewer",
        },
      },
      {
        ...replacement,
        source: {
          ...replacement.source,
          sourceKind: "review_report_submitted",
        },
      },
      {
        ...replacement,
        command: {
          ...replacement.command,
          command: {
            kind: "record_event",
            lineageId: replacementId,
            event: {
              type: "reviewer_replacement",
              at: T2,
              reason: "other",
            },
          },
        },
      },
    ]) {
      assert.throws(
        () => store.applyAuthorizedSource(
          invalid as unknown as AuthorizedReviewLineageSourceAdmissionV1,
        ),
        /invalid_authorized_source/,
      );
    }
    assert.equal(store.applyAuthorizedSource(replacement).status, "applied");

    const reviewId = "phase18-five-review";
    assert.equal(
      store.applyAuthorizedSource(createAdmission(reviewId)).status,
      "applied",
    );
    assert.equal(
      store.applyAuthorizedSource(reviewAdmission(reviewId, "pass")).status,
      "applied",
    );
    assert.equal(store.getLineage(reviewId)?.state, "passed");

    const correctionId = "phase18-five-correction";
    assert.equal(
      store.applyAuthorizedSource(createAdmission(correctionId)).status,
      "applied",
    );
    assert.equal(
      store.applyAuthorizedSource(reviewAdmission(correctionId, "fail")).status,
      "applied",
    );
    assert.equal(
      store.applyAuthorizedSource(correctionAdmission(correctionId)).status,
      "applied",
    );
    assert.equal(
      store.getLineage(correctionId)?.state,
      "reviewing_resolution",
    );

    const cancelId = "phase18-five-cancel";
    assert.equal(
      store.applyAuthorizedSource(createAdmission(cancelId)).status,
      "applied",
    );
    assert.equal(
      store.applyAuthorizedSource(cancelAdmission(cancelId)).status,
      "applied",
    );
    assert.equal(store.getLineage(cancelId)?.state, "canceled");
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
