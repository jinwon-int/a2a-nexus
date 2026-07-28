import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { intentHash } from "../review-lifecycle/canonical-json.js";
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
const DIFF_HASH = `sha256:${"a".repeat(64)}`;
const T0 = "2026-07-28T10:10:00Z";
const T1 = "2026-07-28T10:11:00Z";
const REVIEWER_ID = "reviewer-beta";

function contract(lineageId = "phase16-atomic"): IntentContractV1 {
  const partial = {
    kind: "IntentContractV1" as const,
    lineageId,
    goal: "Attach an authenticated review report source.",
    nonGoals: ["Do not infer a report from task completion."],
    invariants: ["Source, lineage, and ledger share one transaction."],
    acceptanceCriteria: [
      { id: "AC-1", text: "The verified key owner is the reviewer issuer." },
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

function binding(lineageId = "phase16-atomic") {
  return {
    intentHash: contract(lineageId).intentHash,
    headSha: HEAD_SHA,
    diffHash: DIFF_HASH,
  };
}

function createAdmission(
  lineageId = "phase16-atomic",
): AuthorizedReviewLineageSourceAdmissionV1 {
  const authorized = authorizeOperatorReviewLineageCreate(
    {
      dispatchRef: `lineage-dispatch:${lineageId}:1`,
      observedAt: T0,
      binding: binding(lineageId),
      contract: contract(lineageId),
      budget: budget(),
    },
    "operator-alpha",
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

function reportAdmission(
  lineageId = "phase16-atomic",
  reportRef = "review-report:phase16:1",
  note = "Private review prose stays out of source metadata.",
): AuthorizedReviewLineageSourceAdmissionV1 {
  const subject = binding(lineageId);
  const authorized = authorizeReviewerReviewLineageReport(
    lineageId,
    {
      reportRef,
      observedAt: T1,
      binding: subject,
      receipt: {
        kind: "ReviewReceiptV1",
        reviewerNodeId: REVIEWER_ID,
        verdict: "pass",
        note,
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

function cancelAdmission(
  lineageId: string,
): AuthorizedReviewLineageSourceAdmissionV1 {
  const authorized = authorizeOperatorReviewLineageCancel(
    lineageId,
    {
      decisionRef: `operator-decision:${lineageId}:1`,
      observedAt: T1,
      binding: binding(lineageId),
      detail: "Explicit compatibility cancellation.",
    },
    "operator-alpha",
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

function detachedReplacementAdmission():
  AuthorizedReviewLineageSourceAdmissionV1 {
  const sourceEventRef = "detached:reviewer_replacement:1";
  const observedAt = "2026-07-28T10:12:00Z";
  const descriptor = {
    sourceKind: "reviewer_replacement_decided" as const,
    authorityKind: "reviewer_allocator" as const,
    observation: {
      kind: "reviewer_replacement" as const,
      reason: "infrastructure_failure" as const,
    },
  };
  const fact = authorizeReviewLineageSourceCarrier(
    {
      kind: REVIEW_LINEAGE_SOURCE_CARRIER_KIND,
      sourceKind: descriptor.sourceKind,
      sourceEventRef,
      lineageId: "phase16-atomic",
      observedAt,
      binding: binding(),
      observation: descriptor.observation,
    },
    createReviewLineageTrustedSourceContext({
      authorityKind: descriptor.authorityKind,
      issuerId: "owner-reviewer-replacement",
      sourceNamespace: "test:detached-reviewer-replacement:v1",
    }),
  );
  const command = projectReviewLineageProducerFact(fact);
  return {
    source: {
      sourceEventId: fact.sourceEventId,
      producerId: fact.producerId,
      sourceKind: descriptor.sourceKind,
      authorityKind: descriptor.authorityKind,
      sourceEventRefHash: `sha256:${"d".repeat(64)}`,
      observedAt,
      payloadFingerprint: command.payloadFingerprint,
    },
    command,
  } as unknown as AuthorizedReviewLineageSourceAdmissionV1;
}

function tempDatabase(): { dir: string; dbFile: string } {
  const dir = mkdtempSync(join(tmpdir(), "a2a-review-report-source-"));
  return { dir, dbFile: join(dir, "state.sqlite") };
}

test("direct SQLite path atomically commits review source, lineage, and ledger", () => {
  const { dir, dbFile } = tempDatabase();
  try {
    const store = new SqliteReviewLineageObservationStore(dbFile);
    assert.equal(store.applyAuthorizedSource(createAdmission()).status, "applied");
    assert.deepEqual(store.applyAuthorizedSource(reportAdmission()), {
      status: "applied",
      lineageId: "phase16-atomic",
      outcome: "applied",
      state: "passed",
      recordVersion: 2,
      effects: ["lineage_passed"],
    });
    assert.equal(store.getLineage("phase16-atomic")?.counters.reviewerRuns, 1);
    assert.equal(store.countLedgerEntries(), 2);
    assert.equal(store.countAuthorizedSourceEvents(), 2);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("review source replays after restart and changed payload conflicts", () => {
  const { dir, dbFile } = tempDatabase();
  try {
    const firstReport = reportAdmission();
    const first = new SqliteReviewLineageObservationStore(dbFile);
    assert.equal(first.applyAuthorizedSource(createAdmission()).status, "applied");
    assert.equal(first.applyAuthorizedSource(firstReport).status, "applied");
    first.close();

    const restored = new SqliteReviewLineageObservationStore(dbFile);
    assert.deepEqual(restored.applyAuthorizedSource(firstReport), {
      status: "replayed",
      lineageId: "phase16-atomic",
      originalOutcome: "applied",
      state: "passed",
      recordVersion: 2,
      effects: ["lineage_passed"],
    });
    const changed = reportAdmission(
      "phase16-atomic",
      "review-report:phase16:1",
      "Changed meaning under the immutable report reference.",
    );
    assert.equal(changed.source.sourceEventId, firstReport.source.sourceEventId);
    assert.deepEqual(restored.applyAuthorizedSource(changed), {
      status: "idempotency_conflict",
      lineageId: "phase16-atomic",
    });
    assert.equal(restored.getLineage("phase16-atomic")?.counters.reviewerRuns, 1);
    assert.equal(restored.countLedgerEntries(), 2);
    assert.equal(restored.countAuthorizedSourceEvents(), 2);
    restored.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("review source and ledger insert failures roll back the lineage transition", () => {
  for (const target of ["source", "ledger"] as const) {
    const { dir, dbFile } = tempDatabase();
    try {
      const store = new SqliteReviewLineageObservationStore(dbFile);
      assert.equal(
        store.applyAuthorizedSource(createAdmission()).status,
        "applied",
      );
      const report = reportAdmission();
      const faultDb = new DatabaseSync(dbFile);
      if (target === "source") {
        faultDb.exec(`
          CREATE TRIGGER reject_phase16_source
          BEFORE INSERT ON ${REVIEW_LINEAGE_AUTHORIZED_SOURCE_EVENT_TABLE}
          WHEN NEW.source_event_id = '${report.source.sourceEventId}'
          BEGIN
            SELECT RAISE(ABORT, 'forced_phase16_source_failure');
          END
        `);
      } else {
        faultDb.exec(`
          CREATE TRIGGER reject_phase16_ledger
          BEFORE INSERT ON ${REVIEW_LINEAGE_OBSERVATION_LEDGER_TABLE}
          WHEN NEW.idempotency_key = '${report.command.idempotencyKey}'
          BEGIN
            SELECT RAISE(ABORT, 'forced_phase16_ledger_failure');
          END
        `);
      }
      assert.throws(
        () => store.applyAuthorizedSource(report),
        new RegExp(`forced_phase16_${target}_failure`),
      );
      assert.equal(store.getLineage("phase16-atomic")?.state, "reviewing_initial");
      assert.equal(store.getLineage("phase16-atomic")?.counters.reviewerRuns, 0);
      assert.equal(store.countLedgerEntries(), 1);
      assert.equal(store.countAuthorizedSourceEvents(), 1);
      faultDb.close();
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("closed source admission keeps replacement detached and preserves create/cancel", () => {
  const { dir, dbFile } = tempDatabase();
  try {
    const store = new SqliteReviewLineageObservationStore(dbFile);
    assert.equal(store.applyAuthorizedSource(createAdmission()).status, "applied");
    assert.throws(
      () => store.applyAuthorizedSource(detachedReplacementAdmission()),
      /invalid_authorized_source/,
    );

    const cancelLineage = "phase16-cancel-compat";
    assert.equal(
      store.applyAuthorizedSource(createAdmission(cancelLineage)).status,
      "applied",
    );
    assert.equal(
      store.applyAuthorizedSource(cancelAdmission(cancelLineage)).status,
      "applied",
    );
    assert.equal(store.getLineage(cancelLineage)?.state, "canceled");
    assert.equal(store.countLedgerEntries(), 3);
    assert.equal(store.countAuthorizedSourceEvents(), 3);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("minimized source metadata excludes report reference, reviewer, and prose", () => {
  const { dir, dbFile } = tempDatabase();
  try {
    const reportRef = "review-report:private-ref-must-not-persist";
    const note = "private-review-note-must-not-enter-source-metadata";
    const store = new SqliteReviewLineageObservationStore(dbFile);
    assert.equal(store.applyAuthorizedSource(createAdmission()).status, "applied");
    assert.equal(
      store.applyAuthorizedSource(
        reportAdmission("phase16-atomic", reportRef, note),
      ).status,
      "applied",
    );
    const reader = new DatabaseSync(dbFile);
    const row = reader.prepare(
      `SELECT * FROM ${REVIEW_LINEAGE_AUTHORIZED_SOURCE_EVENT_TABLE}
       WHERE source_kind = 'review_report_submitted'`,
    ).get();
    const serialized = JSON.stringify(row);
    assert.doesNotMatch(serialized, new RegExp(reportRef));
    assert.doesNotMatch(serialized, new RegExp(note));
    assert.doesNotMatch(serialized, new RegExp(REVIEWER_ID));
    assert.doesNotMatch(serialized, /credential|provider|prompt/i);
    reader.close();
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
