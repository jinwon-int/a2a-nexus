import assert from "node:assert/strict";
import test from "node:test";

import { intentHash } from "./canonical-json.js";
import { createLineage } from "./lifecycle.js";
import { projectReviewLineageScorecardSample } from "./scorecard.js";
import {
  REVIEW_LINEAGE_PRIVACY_CLASSES,
  REVIEW_LINEAGE_RETENTION_APPROVAL_KIND,
  buildReviewLineageRetentionPlan,
  type ReviewLineageRetentionSourceV1,
} from "./privacy-retention.js";
import type {
  IntentContractV1,
  ReviewLineageRecord,
  ReviewLineageState,
  TerminalStopReason,
} from "./types.js";

const STARTED_AT = "2026-07-01T00:00:00Z";
const OLD_AT = "2026-07-10T00:00:00Z";
const CUTOFF_AT = "2026-07-20T00:00:00Z";
const RECENT_AT = "2026-07-21T00:00:00Z";
const APPROVED_AT = "2026-07-22T00:00:00Z";
const AS_OF = "2026-07-23T00:00:00Z";
const DIFF_HASH = `sha256:${"c".repeat(64)}`;

function contract(lineageId: string): IntentContractV1 {
  const partial = {
    kind: "IntentContractV1" as const,
    lineageId,
    goal: `private goal for ${lineageId}`,
    nonGoals: ["private non-goal"],
    invariants: ["private invariant"],
    acceptanceCriteria: [{ id: "AC-1", text: "Export redacted metrics only." }],
    declaredPaths: {
      allowed: ["packages/broker/src/review-lifecycle/**"],
    },
    baseSha: "1".repeat(40),
    headSha: "2".repeat(40),
    createdAt: STARTED_AT,
  };
  return {
    ...partial,
    intentHash: intentHash(partial as unknown as Record<string, unknown>),
  };
}

function record(
  lineageId: string,
  state: ReviewLineageState,
  updatedAt: string,
  terminalReason: TerminalStopReason | null,
): ReviewLineageRecord {
  const created = createLineage({
    contract: contract(lineageId),
    mode: "record",
    at: STARTED_AT,
    diffHash: DIFF_HASH,
  });
  return {
    ...created,
    state,
    updatedAt,
    terminalReason,
  };
}

function source(
  lineageId: string,
  state: ReviewLineageState,
  updatedAt: string,
  terminalReason: TerminalStopReason | null,
  recordVersion: number,
): ReviewLineageRetentionSourceV1 {
  return {
    record: record(lineageId, state, updatedAt, terminalReason),
    recordVersion,
    ledgerEntryCount: recordVersion + 1,
  };
}

function options(sources: ReviewLineageRetentionSourceV1[]) {
  return {
    approval: {
      kind: REVIEW_LINEAGE_RETENTION_APPROVAL_KIND,
      approvalRef: "operator-approval:phase11-retention-cutoff",
      approvedAt: APPROVED_AT,
      cutoffAt: CUTOFF_AT,
    },
    sourceRoundId: "a2a-nexus-1518-phase11-retention-r1",
    asOf: AS_OF,
    sources,
  };
}

function allSources(): ReviewLineageRetentionSourceV1[] {
  return [
    source("private-passed", "passed", OLD_AT, null, 2),
    source(
      "private-blocked",
      "blocked_needs_operator",
      OLD_AT,
      "budget_wall_clock",
      3,
    ),
    source(
      "private-conflict",
      "intent_conflict",
      OLD_AT,
      "intent_drift",
      4,
    ),
    source("private-canceled", "canceled", OLD_AT, "operator_cancel", 5),
    source("private-active", "reviewing_initial", OLD_AT, null, 1),
    source("private-at-cutoff", "passed", CUTOFF_AT, null, 2),
    source("private-recent", "passed", RECENT_AT, null, 2),
  ];
}

test("privacy classes separate canonical, ledger, and approved redacted export", () => {
  assert.equal(
    REVIEW_LINEAGE_PRIVACY_CLASSES.canonicalLineage.classification,
    "restricted_sensitive",
  );
  assert.equal(
    REVIEW_LINEAGE_PRIVACY_CLASSES.canonicalLineage.approvedExport,
    false,
  );
  assert.equal(
    REVIEW_LINEAGE_PRIVACY_CLASSES.idempotencyLedger.approvedExport,
    false,
  );
  assert.equal(
    REVIEW_LINEAGE_PRIVACY_CLASSES.scorecardProjection.approvedExport,
    true,
  );
});

test("retention plan includes only pre-cutoff terminal aggregate units", () => {
  const plan = buildReviewLineageRetentionPlan(options(allSources()));

  assert.equal(plan.aggregates.length, 4);
  assert.equal(plan.excludedActiveCount, 1);
  assert.equal(plan.excludedAtOrAfterCutoffCount, 2);
  assert.deepEqual(
    plan.aggregates.map((aggregate) => aggregate.lineageId),
    [
      "private-blocked",
      "private-canceled",
      "private-conflict",
      "private-passed",
    ],
  );
  for (const aggregate of plan.aggregates) {
    const matchingSource = allSources().find(
      (entry) => entry.record.lineageId === aggregate.lineageId,
    );
    assert.ok(matchingSource);
    assert.equal(aggregate.kind, "canonical_lineage_plus_ledger");
    assert.ok(aggregate.expectedRecordVersion > 0);
    assert.ok(aggregate.expectedLedgerEntryCount > 0);
    assert.equal(
      aggregate.exportLineageRef,
      projectReviewLineageScorecardSample(matchingSource.record, {
        sourceRoundId: plan.sourceRoundId,
        asOf: plan.asOf,
      }).lineageRef,
    );
    assert.deepEqual(
      Object.keys(aggregate).sort(),
      [
        "expectedLedgerEntryCount",
        "expectedRecordVersion",
        "expectedState",
        "expectedUpdatedAt",
        "exportLineageRef",
        "kind",
        "lineageId",
      ],
    );
  }
  assert.equal(plan.exportProof.scorecardInput.samples.length, 4);
  assert.match(
    plan.exportProof.payloadFingerprint,
    /^sha256:[0-9a-f]{64}$/,
  );
});

test("export proof is deterministic and excludes canonical and ledger material", () => {
  const first = buildReviewLineageRetentionPlan(options(allSources()));
  const second = buildReviewLineageRetentionPlan(
    options([...allSources()].reverse()),
  );
  assert.deepEqual(second.exportProof, first.exportProof);
  assert.deepEqual(second.aggregates, first.aggregates);

  const exported = JSON.stringify(first.exportProof);
  assert.doesNotMatch(
    exported,
    /private-(?:passed|blocked|conflict|canceled)|private goal|private non-goal/,
  );
  assert.doesNotMatch(
    exported,
    /"(?:currentHeadSha|currentDiffHash|intentHash|lineageId|ledger|reviewerNodeId|note|paths|idempotencyKey)"\s*:/,
  );
  assert.match(exported, /a2a\.review-lineage-scorecard-redacted\.v1/);
});

test("retention planning fails closed without a valid approved cutoff", () => {
  const valid = options(allSources());
  assert.throws(
    () => buildReviewLineageRetentionPlan({
      ...valid,
      approval: {
        ...valid.approval,
        kind: "a2a.review-lineage-retention-approval.v2",
      } as unknown as typeof valid.approval,
    }),
    /approval\.kind invalid_kind/,
  );
  assert.throws(
    () => buildReviewLineageRetentionPlan({
      ...valid,
      approval: {
        ...valid.approval,
        cutoffAt: "2026-07-23T00:00:01Z",
      },
    }),
    /cutoffAt after_approval/,
  );
  assert.throws(
    () => buildReviewLineageRetentionPlan({
      ...valid,
      approval: {
        ...valid.approval,
        approvedAt: "2026-07-24T00:00:00Z",
      },
    }),
    /approvedAt after_as_of/,
  );
  assert.throws(
    () => buildReviewLineageRetentionPlan({
      ...valid,
      approval: {
        ...valid.approval,
        execute: true,
      } as typeof valid.approval,
    }),
    /approval\.execute unexpected_field/,
  );
});

test("invalid storage metadata and unknown lineage state cannot enter a plan", () => {
  const invalidVersion = allSources();
  invalidVersion[0] = { ...invalidVersion[0], recordVersion: 0 };
  assert.throws(
    () => buildReviewLineageRetentionPlan(options(invalidVersion)),
    /recordVersion invalid_integer/,
  );

  const invalidLedger = allSources();
  invalidLedger[0] = { ...invalidLedger[0], ledgerEntryCount: -1 };
  assert.throws(
    () => buildReviewLineageRetentionPlan(options(invalidLedger)),
    /ledgerEntryCount invalid_integer/,
  );

  const unknownState = allSources();
  unknownState[0] = {
    ...unknownState[0],
    record: {
      ...unknownState[0].record,
      state: "future_state" as ReviewLineageState,
    },
  };
  assert.throws(
    () => buildReviewLineageRetentionPlan(options(unknownState)),
    /record\.state/,
  );
});
