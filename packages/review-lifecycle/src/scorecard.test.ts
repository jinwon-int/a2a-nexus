import test from "node:test";
import assert from "node:assert/strict";

import { intentHash } from "./canonical-json.js";
import { createLineage } from "./lifecycle.js";
import {
  buildReviewLineageScorecard,
  projectReviewLineageScorecardSample,
  validateReviewLineageScorecardInput,
  assertReviewLineageScorecardReplay,
  type IntentHashAssessmentV1,
  type ReviewLineageScorecardInputV1,
  type ReviewLineageScorecardSampleV1,
} from "./scorecard.js";
import {
  DEFAULT_LINEAGE_BUDGET,
  REVIEW_LINEAGE_KIND,
  type IntentContractV1,
  type LineageMetrics,
  type ReviewLineageBudgetV1,
  type ReviewLineageRecord,
  type ReviewLineageState,
  type TerminalStopReason,
} from "./types.js";

const T0 = "2026-07-23T00:00:00Z";
const T1 = "2026-07-23T01:00:00Z";
const T3 = "2026-07-23T08:00:00Z";
const SOURCE_ROUND = "a2a-nexus-1518-phase7-readback-r1";

function makeContract(lineageId: string): IntentContractV1 {
  const withoutHash = {
    kind: "IntentContractV1" as const,
    lineageId,
    goal: "sensitive goal that must not enter the scorecard",
    nonGoals: ["do not expose private prompts"],
    invariants: ["advisory only"],
    acceptanceCriteria: [{ id: "AC-1", text: "aggregate redacted metrics" }],
    declaredPaths: { allowed: ["packages/broker/src/review-lifecycle/**"] },
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    createdAt: T0,
  };
  return { ...withoutHash, intentHash: intentHash(withoutHash) };
}

function makeRecord(
  lineageId: string,
  patch: Partial<ReviewLineageRecord> = {},
): ReviewLineageRecord {
  const record = createLineage({
    contract: makeContract(lineageId),
    budget: patch.budget,
    mode: "record",
    at: T0,
    diffHash: "sha256:" + "c".repeat(64),
  });
  return {
    ...record,
    ...patch,
    counters: { ...record.counters, ...patch.counters },
  };
}

function metrics(patch: Partial<LineageMetrics> = {}): LineageMetrics {
  return {
    elapsedSeconds: 3600,
    correctionGenerations: 0,
    reviewerRuns: 1,
    reviewerReplacements: 0,
    findingsNew: 0,
    findingsReopened: 0,
    findingsResolved: 0,
    repeatedSignatureHits: 0,
    goalpostRejections: 0,
    scopeDriftRejections: 0,
    openBlockingFindings: 0,
    terminalReason: null,
    ...patch,
  };
}

function sample(
  index: number,
  options: {
    budget?: ReviewLineageBudgetV1;
    state?: ReviewLineageState;
    terminalReason?: TerminalStopReason | null;
    metrics?: Partial<LineageMetrics>;
    signalRefs?: string[];
  } = {},
): ReviewLineageScorecardSampleV1 {
  const terminalReason = options.terminalReason ?? null;
  const sampleMetrics = metrics({ terminalReason, ...options.metrics });
  const observedAt = new Date(
    Date.parse(T0) + sampleMetrics.elapsedSeconds * 1000,
  ).toISOString().replace(".000Z", "Z");
  return {
    kind: "a2a.review-lineage-scorecard-sample.v1",
    recordSchemaVersion: REVIEW_LINEAGE_KIND,
    lineageRef: `lr-${String(index).padStart(16, "0")}`,
    mode: "record",
    state: options.state ?? "passed",
    budget: options.budget ?? DEFAULT_LINEAGE_BUDGET,
    metrics: sampleMetrics,
    startedAt: T0,
    observedAt,
    terminalReason,
    unresolvedSignatureCount: 0,
    intentHashSignalRefs: options.signalRefs ?? [],
  };
}

function input(
  samples: ReviewLineageScorecardSampleV1[],
  intentHashAssessments: IntentHashAssessmentV1[] = [],
): ReviewLineageScorecardInputV1 {
  return {
    kind: "a2a.review-lineage-scorecard-input.v1",
    sourceRoundId: SOURCE_ROUND,
    recordSchemaVersion: REVIEW_LINEAGE_KIND,
    redactionProfileVersion: "a2a.review-lineage-scorecard-redacted.v1",
    asOf: T3,
    samples,
    intentHashAssessments,
  };
}

test("scorecard projection reuses lifecycle metrics and emits no frozen intent or raw subject", () => {
  const record = makeRecord("private-lineage-id", {
    state: "passed",
    updatedAt: T1,
    counters: {
      correctionGenerations: 1,
      reviewerRuns: 2,
      reviewerReplacements: 0,
      findingsNew: 1,
      findingsReopened: 0,
      findingsResolved: 1,
      repeatedSignatureHits: 0,
      goalpostRejections: 0,
      scopeDriftRejections: 0,
    },
  });
  const projected = projectReviewLineageScorecardSample(record, {
    sourceRoundId: SOURCE_ROUND,
    asOf: T3,
  });

  assert.equal(projected.metrics.elapsedSeconds, 3600);
  assert.equal(projected.metrics.correctionGenerations, 1);
  assert.match(projected.lineageRef, /^lr-[0-9a-f]{16}$/);
  assert.notEqual(
    projected.lineageRef,
    projectReviewLineageScorecardSample(record, {
      sourceRoundId: "another-round",
      asOf: T3,
    }).lineageRef,
  );
  const serialized = JSON.stringify(projected);
  assert.doesNotMatch(
    serialized,
    /private-lineage-id|sensitive goal|"intentHash":|"currentHeadSha":/,
  );
});

test("scorecard is deterministic across input order and separates budget cohorts", () => {
  const alternateBudget = {
    ...DEFAULT_LINEAGE_BUDGET,
    maxWallClockSeconds: 10_800,
  };
  const samples = [
    sample(2, { budget: alternateBudget }),
    sample(1),
  ];
  const first = buildReviewLineageScorecard(input(samples));
  const second = buildReviewLineageScorecard(input([...samples].reverse()));

  assert.deepEqual(second, first);
  assert.equal(first.cohorts.length, 2);
  assert.deepEqual(first.lineages.map((row) => row.lineageRef), [
    "lr-0000000000000001",
    "lr-0000000000000002",
  ]);
  assert.match(first.inputDigest, /^sha256:[0-9a-f]{64}$/);
});

test("input validation fails closed on duplicates, mixed versions, non-record mode, and private fields", () => {
  const valid = input([sample(1)]);
  assert.throws(
    () => validateReviewLineageScorecardInput({ ...valid, samples: [sample(1), sample(1)] }),
    /duplicate lineageRef/,
  );
  assert.throws(
    () => validateReviewLineageScorecardInput({
      ...valid,
      samples: [{ ...sample(1), recordSchemaVersion: "a2a.review-lineage.v2" }],
    }),
    /recordSchemaVersion/,
  );
  assert.throws(
    () => validateReviewLineageScorecardInput({
      ...valid,
      samples: [{ ...sample(1), mode: "enforce" }],
    }),
    /mode/,
  );
  assert.throws(
    () => validateReviewLineageScorecardInput({
      ...valid,
      samples: [{ ...sample(1), rawPrompt: "forbidden" }],
    }),
    /unexpected field/,
  );
  assert.throws(
    () => validateReviewLineageScorecardInput({
      ...valid,
      samples: [{ ...sample(1), observedAt: "2026-07-22T23:00:00Z" }],
    }),
    /observedAt/,
  );
  assert.throws(
    () => validateReviewLineageScorecardInput({
      ...valid,
      samples: [{
        ...sample(1),
        metrics: metrics({ elapsedSeconds: 60 }),
      }],
    }),
    /elapsedSeconds/,
  );
});

test("intentHash false-positive rate uses only explicit final adjudications", () => {
  const signalRef = "ih-0000000000000001";
  const conflict = sample(1, {
    state: "intent_conflict",
    terminalReason: "intent_drift",
    signalRefs: [signalRef],
  });
  const withoutAssessment = buildReviewLineageScorecard(input([conflict]));
  assert.deepEqual(withoutAssessment.intentHashBehavior, {
    signalCount: 1,
    adjudicatedCount: 0,
    truePositiveCount: 0,
    falsePositiveCount: 0,
    unadjudicatedCount: 1,
    falsePositiveRate: { numerator: 0, denominator: 0, rate: null },
  });

  const assessment: IntentHashAssessmentV1 = {
    kind: "a2a.intent-hash-assessment.v1",
    lineageRef: conflict.lineageRef,
    signalRef,
    finalDisposition: "false_positive",
    reasonCode: "metadata_only_head_change",
    evidenceRefs: ["github:pr:1625", "test:intent-hash-golden-vector"],
  };
  const adjudicated = buildReviewLineageScorecard(input([conflict], [assessment]));
  assert.deepEqual(adjudicated.intentHashBehavior.falsePositiveRate, {
    numerator: 1,
    denominator: 1,
    rate: 1,
  });
});

test("intentHash assessment validation rejects unknown, duplicate, and conflicting signal claims", () => {
  const signalRef = "ih-0000000000000001";
  const conflict = sample(1, {
    state: "intent_conflict",
    terminalReason: "intent_drift",
    signalRefs: [signalRef],
  });
  const assessment: IntentHashAssessmentV1 = {
    kind: "a2a.intent-hash-assessment.v1",
    lineageRef: conflict.lineageRef,
    signalRef,
    finalDisposition: "true_positive",
    reasonCode: "frozen_intent_changed",
    evidenceRefs: ["test:intent-drift-fixture"],
  };
  assert.throws(
    () => buildReviewLineageScorecard(input([conflict], [
      assessment,
      { ...assessment, finalDisposition: "false_positive" },
    ])),
    /duplicate intentHash assessment/,
  );
  assert.throws(
    () => buildReviewLineageScorecard(input([conflict], [
      { ...assessment, signalRef: "ih-9999999999999999" },
    ])),
    /unknown intentHash signal/,
  );
  assert.throws(
    () => buildReviewLineageScorecard(input([sample(2)], [
      { ...assessment, lineageRef: "lr-0000000000000002" },
    ])),
    /unknown intentHash signal/,
  );
  assert.throws(
    () => buildReviewLineageScorecard(input([conflict], [
      { ...assessment, evidenceRefs: ["secret:must-not-pass"] },
    ])),
    /namespace must be one of/,
  );
});

test("budget advice stays insufficient below 30 terminal samples", () => {
  const report = buildReviewLineageScorecard(
    input(Array.from({ length: 29 }, (_, index) => sample(index + 1))),
  );
  const advice = report.cohorts[0]?.advisoryBudgetRecommendations.maxWallClockSeconds;
  assert.equal(advice?.status, "insufficient_evidence");
  assert.equal(advice?.evidenceCount, 29);
  assert.equal(advice?.candidate, null);
  assert.equal(JSON.stringify(report).includes("\"apply\""), false);
});

test("budget advice investigates an increase only at 30 samples, 5 hits, and 10 percent", () => {
  const makeCohort = (hits: number): ReviewLineageScorecardSampleV1[] =>
    Array.from({ length: 30 }, (_, index) =>
      index < hits
        ? sample(index + 1, {
            state: "blocked_needs_operator",
            terminalReason: "budget_wall_clock",
            metrics: { elapsedSeconds: 21_600 },
          })
        : sample(index + 1, { metrics: { elapsedSeconds: 3_600 } }));

  const fourHits = buildReviewLineageScorecard(input(makeCohort(4)))
    .cohorts[0]?.advisoryBudgetRecommendations.maxWallClockSeconds;
  const fiveHits = buildReviewLineageScorecard(input(makeCohort(5)))
    .cohorts[0]?.advisoryBudgetRecommendations.maxWallClockSeconds;

  assert.equal(fourHits?.status, "hold");
  assert.equal(fiveHits?.status, "investigate_increase");
  assert.equal(fiveHits?.exhaustionHits, 5);
  assert.ok((fiveHits?.candidate ?? 0) > DEFAULT_LINEAGE_BUDGET.maxWallClockSeconds);
});

test("budget decrease requires 100 samples, zero exhaustion, and p95 at most half the limit", () => {
  const report = buildReviewLineageScorecard(input(
    Array.from({ length: 100 }, (_, index) =>
      sample(index + 1, { metrics: { elapsedSeconds: 3_600 } })),
  ));
  const advice = report.cohorts[0]?.advisoryBudgetRecommendations.maxWallClockSeconds;

  assert.equal(advice?.status, "investigate_decrease");
  assert.equal(advice?.exhaustionHits, 0);
  assert.equal(advice?.observedP95, 3_600);
  assert.equal(advice?.candidate, 4_320);
  assert.equal(
    report.cohorts[0]?.advisoryBudgetRecommendations.maxCorrectionGenerations
      .status,
    "hold",
  );
});

test("same source round cannot be replayed with a different canonical input digest", () => {
  const original = buildReviewLineageScorecard(input([sample(1)]));
  const same = buildReviewLineageScorecard(input([sample(1)]));
  const changed = buildReviewLineageScorecard(input([sample(1, {
    metrics: { reviewerRuns: 2 },
  })]));

  assert.doesNotThrow(() => assertReviewLineageScorecardReplay(original, same));
  assert.throws(
    () => assertReviewLineageScorecardReplay(original, changed),
    /sourceRoundId collision/,
  );
});
