import assert from "node:assert/strict";
import test from "node:test";

import { intentHash } from "./canonical-json.js";
import {
  REVIEW_LINEAGE_PRODUCER_COMPLETENESS_MATRIX,
  REVIEW_LINEAGE_PRODUCER_FACT_KIND,
  buildReviewLineageObservationEnvelopeFromFact,
  projectReviewLineageProducerFact,
  type ReviewLineageProducerFactV1,
} from "./producer-contract.js";
import type {
  IntentContractV1,
  ReviewLineageBudgetV1,
} from "./types.js";

const T0 = "2026-07-23T14:50:00Z";
const BASE_SHA = "1".repeat(40);
const HEAD_SHA = "2".repeat(40);
const NEXT_SHA = "3".repeat(40);
const DIFF_HASH = `sha256:${"a".repeat(64)}`;
const NEXT_DIFF_HASH = `sha256:${"b".repeat(64)}`;

function contract(lineageId = "phase11-lineage"): IntentContractV1 {
  const partial = {
    kind: "IntentContractV1" as const,
    lineageId,
    goal: "Prove complete structured producer facts.",
    nonGoals: ["Do not infer from result prose."],
    invariants: ["Every fact is exact-subject bound."],
    acceptanceCriteria: [
      { id: "AC-1", text: "All observation kinds are exhaustive." },
    ],
    declaredPaths: {
      allowed: ["packages/broker/src/review-lifecycle/**"],
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

function baseFact(
  observation: ReviewLineageProducerFactV1["observation"],
  sourceEventId: string,
): ReviewLineageProducerFactV1 {
  const frozen = contract();
  return {
    kind: REVIEW_LINEAGE_PRODUCER_FACT_KIND,
    producerId: "phase11-contract-test",
    sourceEventId,
    lineageId: frozen.lineageId,
    observedAt: T0,
    binding: {
      intentHash: frozen.intentHash,
      headSha: HEAD_SHA,
      diffHash: DIFF_HASH,
    },
    observation,
  };
}

function facts(): Array<{
  fact: ReviewLineageProducerFactV1;
  expectedCommand: "create_lineage" | "record_event";
  expectedEvent: string | null;
}> {
  const frozen = contract();
  return [
    {
      fact: baseFact({
        kind: "lineage_create",
        mode: "record",
        contract: frozen,
        budget: budget(),
      }, "phase11:create:1"),
      expectedCommand: "create_lineage",
      expectedEvent: null,
    },
    {
      fact: baseFact({
        kind: "review_report",
        receipt: {
          kind: "ReviewReceiptV1",
          reviewerNodeId: "independent-reviewer",
          verdict: "pass",
          note: "Structured review result.",
          headSha: HEAD_SHA,
          diffHash: DIFF_HASH,
          intentHash: frozen.intentHash,
          findingLedgerRef: `ledger-${frozen.lineageId}`,
          authorWorkerId: "author-worker",
          submittedAt: T0,
        },
        resolvedFindingIds: [],
        reopenedFindingIds: [],
        newFindings: [],
      }, "phase11:review:1"),
      expectedCommand: "record_event",
      expectedEvent: "review_report",
    },
    {
      fact: baseFact({
        kind: "correction_generation",
        headSha: NEXT_SHA,
        diffHash: NEXT_DIFF_HASH,
        intentHash: frozen.intentHash,
        pathsChanged: ["packages/broker/src/review-lifecycle/producer-contract.ts"],
      }, "phase11:correction:1"),
      expectedCommand: "record_event",
      expectedEvent: "correction_generation",
    },
    {
      fact: baseFact({
        kind: "reviewer_replacement",
        reason: "infrastructure_failure",
        detail: "Structured infrastructure classification.",
      }, "phase11:replacement:1"),
      expectedCommand: "record_event",
      expectedEvent: "reviewer_replacement",
    },
    {
      fact: baseFact({
        kind: "operator_cancel",
        detail: "Explicit operator cancellation.",
      }, "phase11:cancel:1"),
      expectedCommand: "record_event",
      expectedEvent: "operator_cancel",
    },
  ];
}

test("producer completeness matrix exhaustively names all five observation kinds", () => {
  assert.deepEqual(
    Object.keys(REVIEW_LINEAGE_PRODUCER_COMPLETENESS_MATRIX).sort(),
    [
      "correction_generation",
      "lineage_create",
      "operator_cancel",
      "review_report",
      "reviewer_replacement",
    ],
  );
  for (const [kind, entry] of Object.entries(
    REVIEW_LINEAGE_PRODUCER_COMPLETENESS_MATRIX,
  )) {
    assert.equal(entry.factKind, REVIEW_LINEAGE_PRODUCER_FACT_KIND);
    assert.equal(entry.observationKind, kind);
  }
});

test("every structured producer fact maps losslessly through the one canonical parser", () => {
  for (const { fact, expectedCommand, expectedEvent } of facts()) {
    const envelope = buildReviewLineageObservationEnvelopeFromFact(fact);
    assert.equal(envelope.kind, "a2a.review-lineage-observation.v1");
    assert.deepEqual(envelope.observation, fact.observation);
    assert.equal(envelope.sourceEventId, fact.sourceEventId);
    assert.deepEqual(envelope.binding, fact.binding);

    const first = projectReviewLineageProducerFact(fact);
    const replay = projectReviewLineageProducerFact(structuredClone(fact));
    assert.deepEqual(replay, first);
    assert.equal(first.command.kind, expectedCommand);
    if (first.command.kind === "record_event") {
      assert.equal(first.command.event.type, expectedEvent);
    } else {
      assert.equal(expectedEvent, null);
    }
  }
});

test("producer facts fail closed on prose-only, missing, multiple, and sensitive fields", () => {
  assert.throws(
    () => projectReviewLineageProducerFact({
      kind: REVIEW_LINEAGE_PRODUCER_FACT_KIND,
      summary: "infer a review event from this prose",
    }),
    /unexpected_field at \$\.summary/,
  );

  const missingBinding = structuredClone(facts()[0].fact) as
    & Record<string, unknown>
    & { binding?: unknown };
  delete missingBinding.binding;
  assert.throws(
    () => projectReviewLineageProducerFact(missingBinding),
    /invalid_object at \$\.binding/,
  );

  const multipleKinds = structuredClone(facts()[1].fact) as
    ReviewLineageProducerFactV1 & {
      observation: Record<string, unknown>;
    };
  multipleKinds.observation.pathsChanged = ["forbidden-in-review-report"];
  assert.throws(
    () => projectReviewLineageProducerFact(multipleKinds),
    /unexpected_field at \$\.observation\.pathsChanged/,
  );

  const sensitive = {
    ...structuredClone(facts()[4].fact),
    rawProviderOutput: "must never enter the producer contract",
  };
  assert.throws(
    () => projectReviewLineageProducerFact(sensitive),
    /unexpected_field at \$\.rawProviderOutput/,
  );

  const uncloneable = structuredClone(facts()[4].fact) as
    ReviewLineageProducerFactV1 & {
      observation: Record<string, unknown>;
    };
  uncloneable.observation.detail = () => "not JSON";
  assert.throws(
    () => projectReviewLineageProducerFact(uncloneable),
    /invalid_string at \$\.observation\.detail/,
  );
});

test("source event reuse preserves key identity but exposes a changed payload fingerprint", () => {
  const firstFact = facts()[4].fact;
  const changedFact = structuredClone(firstFact);
  if (changedFact.observation.kind !== "operator_cancel") {
    throw new Error("test fixture must be operator_cancel");
  }
  changedFact.observation.detail = "Different structured cancellation detail.";

  const first = projectReviewLineageProducerFact(firstFact);
  const changed = projectReviewLineageProducerFact(changedFact);
  assert.equal(changed.idempotencyKey, first.idempotencyKey);
  assert.notEqual(changed.payloadFingerprint, first.payloadFingerprint);
});
