import assert from "node:assert/strict";
import test from "node:test";

import { intentHash } from "./canonical-json.js";
import {
  projectReviewLineageProducerFact,
} from "./producer-contract.js";
import {
  REVIEW_LINEAGE_SOURCE_AUTHORITY_MATRIX,
  REVIEW_LINEAGE_SOURCE_CARRIER_KIND,
  authorizeReviewLineageSourceCarrier,
  createReviewLineageTrustedSourceContext,
  type ReviewLineageSourceAuthorityKind,
  type ReviewLineageSourceCarrierV1,
  type ReviewLineageTrustedSourceContextV1,
} from "./source-carrier.js";
import type {
  IntentContractV1,
  ReviewLineageBudgetV1,
} from "./types.js";

const T0 = "2026-07-23T16:05:00Z";
const BASE_SHA = "1".repeat(40);
const HEAD_SHA = "2".repeat(40);
const NEXT_SHA = "3".repeat(40);
const DIFF_HASH = `sha256:${"a".repeat(64)}`;
const NEXT_DIFF_HASH = `sha256:${"b".repeat(64)}`;

function contract(lineageId = "phase13-lineage"): IntentContractV1 {
  const partial = {
    kind: "IntentContractV1" as const,
    lineageId,
    goal: "Authorize explicit review-lineage source carriers.",
    nonGoals: ["Do not infer from generic task or cancellation state."],
    invariants: [
      "Untrusted carriers cannot choose authority or idempotency identity.",
    ],
    acceptanceCriteria: [
      { id: "AC-1", text: "All source kinds are authority-bound." },
      { id: "AC-2", text: "Derived source identity is deterministic." },
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

interface SourceFixture {
  carrier: ReviewLineageSourceCarrierV1;
  authorityKind: ReviewLineageSourceAuthorityKind;
  issuerId: string;
  expectedCommand: "create_lineage" | "record_event";
  expectedEvent: string | null;
}

function carrierBase(
  sourceKind: ReviewLineageSourceCarrierV1["sourceKind"],
  sourceEventRef: string,
  observation: ReviewLineageSourceCarrierV1["observation"],
): ReviewLineageSourceCarrierV1 {
  const frozen = contract();
  return {
    kind: REVIEW_LINEAGE_SOURCE_CARRIER_KIND,
    sourceKind,
    sourceEventRef,
    lineageId: frozen.lineageId,
    observedAt: T0,
    binding: {
      intentHash: frozen.intentHash,
      headSha: HEAD_SHA,
      diffHash: DIFF_HASH,
    },
    observation,
  } as ReviewLineageSourceCarrierV1;
}

function fixtures(): SourceFixture[] {
  const frozen = contract();
  return [
    {
      carrier: carrierBase(
        "lineage_contract_frozen",
        "dispatch:phase13:lineage:1",
        {
          kind: "lineage_create",
          mode: "record",
          contract: frozen,
          budget: budget(),
        },
      ),
      authorityKind: "lineage_dispatcher",
      issuerId: "dispatcher-a",
      expectedCommand: "create_lineage",
      expectedEvent: null,
    },
    {
      carrier: carrierBase(
        "review_report_submitted",
        "review-task:phase13:attempt:1",
        {
          kind: "review_report",
          receipt: {
            kind: "ReviewReceiptV1",
            reviewerNodeId: "reviewer-a",
            verdict: "pass",
            note: "Complete exact-subject review evidence.",
            headSha: HEAD_SHA,
            diffHash: DIFF_HASH,
            intentHash: frozen.intentHash,
            findingLedgerRef: `ledger-${frozen.lineageId}`,
            authorWorkerId: "author-a",
            submittedAt: T0,
          },
          resolvedFindingIds: [],
          reopenedFindingIds: [],
          newFindings: [],
        },
      ),
      authorityKind: "reviewer",
      issuerId: "reviewer-a",
      expectedCommand: "record_event",
      expectedEvent: "review_report",
    },
    {
      carrier: carrierBase(
        "correction_generation_committed",
        "correction:phase13:generation:1",
        {
          kind: "correction_generation",
          headSha: NEXT_SHA,
          diffHash: NEXT_DIFF_HASH,
          intentHash: frozen.intentHash,
          pathsChanged: [
            "packages/broker/src/review-lifecycle/source-carrier.ts",
          ],
        },
      ),
      authorityKind: "correction_controller",
      issuerId: "correction-controller-a",
      expectedCommand: "record_event",
      expectedEvent: "correction_generation",
    },
    {
      carrier: carrierBase(
        "reviewer_replacement_decided",
        "replacement:phase13:decision:1",
        {
          kind: "reviewer_replacement",
          reason: "infrastructure_failure",
          detail: "Verified worker infrastructure failure.",
        },
      ),
      authorityKind: "reviewer_allocator",
      issuerId: "allocator-a",
      expectedCommand: "record_event",
      expectedEvent: "reviewer_replacement",
    },
    {
      carrier: carrierBase(
        "lineage_cancel_decided",
        "operator:phase13:cancel:1",
        {
          kind: "operator_cancel",
          detail: "Explicit lineage cancellation decision.",
        },
      ),
      authorityKind: "operator",
      issuerId: "operator-a",
      expectedCommand: "record_event",
      expectedEvent: "operator_cancel",
    },
  ];
}

function trustedContext(
  authorityKind: ReviewLineageSourceAuthorityKind,
  issuerId: string,
  sourceNamespace = "phase13-contract-tests",
): ReviewLineageTrustedSourceContextV1 {
  return createReviewLineageTrustedSourceContext({
    authorityKind,
    issuerId,
    sourceNamespace,
  });
}

test("source authority matrix exhaustively assigns all five observation kinds", () => {
  assert.deepEqual(
    Object.keys(REVIEW_LINEAGE_SOURCE_AUTHORITY_MATRIX).sort(),
    [
      "correction_generation",
      "lineage_create",
      "operator_cancel",
      "review_report",
      "reviewer_replacement",
    ],
  );
  for (const [observationKind, entry] of Object.entries(
    REVIEW_LINEAGE_SOURCE_AUTHORITY_MATRIX,
  )) {
    assert.equal(entry.observationKind, observationKind);
    assert.match(entry.sourceKind, /^[a-z][a-z_]+$/);
    assert.match(entry.authorityKind, /^[a-z][a-z_]+$/);
  }
});

test("all five carriers derive identities and remain lossless through the sole fact projector", () => {
  for (const fixture of fixtures()) {
    assert.equal(
      Object.hasOwn(fixture.carrier, "producerId"),
      false,
    );
    assert.equal(
      Object.hasOwn(fixture.carrier, "sourceEventId"),
      false,
    );
    assert.equal(
      Object.hasOwn(fixture.carrier, "authorityKind"),
      false,
    );

    const fact = authorizeReviewLineageSourceCarrier(
      fixture.carrier,
      trustedContext(fixture.authorityKind, fixture.issuerId),
    );
    assert.match(
      fact.producerId,
      /^review-lineage-source:v1:[0-9a-f]{64}$/,
    );
    assert.match(
      fact.sourceEventId,
      /^review-lineage-event:v1:[0-9a-f]{64}$/,
    );
    assert.deepEqual(fact.observation, fixture.carrier.observation);
    assert.deepEqual(fact.binding, fixture.carrier.binding);

    const projected = projectReviewLineageProducerFact(fact);
    assert.equal(projected.command.kind, fixture.expectedCommand);
    if (projected.command.kind === "record_event") {
      assert.equal(projected.command.event.type, fixture.expectedEvent);
    } else {
      assert.equal(fixture.expectedEvent, null);
    }
  }
});

test("trusted context plus immutable event reference deterministically derive replay identity", () => {
  const fixture = fixtures()[4];
  const context = trustedContext(
    fixture.authorityKind,
    fixture.issuerId,
  );
  const first = authorizeReviewLineageSourceCarrier(
    fixture.carrier,
    context,
  );
  const replay = authorizeReviewLineageSourceCarrier(
    structuredClone(fixture.carrier),
    context,
  );
  const recreatedContextReplay = authorizeReviewLineageSourceCarrier(
    fixture.carrier,
    trustedContext(fixture.authorityKind, fixture.issuerId),
  );
  assert.equal(replay.producerId, first.producerId);
  assert.equal(replay.sourceEventId, first.sourceEventId);
  assert.equal(recreatedContextReplay.producerId, first.producerId);
  assert.equal(recreatedContextReplay.sourceEventId, first.sourceEventId);

  const changed = structuredClone(fixture.carrier);
  if (changed.observation.kind !== "operator_cancel") {
    throw new Error("test fixture must be operator_cancel");
  }
  changed.observation.detail = "Changed payload under one source event.";
  const changedFact = authorizeReviewLineageSourceCarrier(changed, context);
  const firstCommand = projectReviewLineageProducerFact(first);
  const changedCommand = projectReviewLineageProducerFact(changedFact);
  assert.equal(changedCommand.idempotencyKey, firstCommand.idempotencyKey);
  assert.notEqual(
    changedCommand.payloadFingerprint,
    firstCommand.payloadFingerprint,
  );

  const otherIssuer = authorizeReviewLineageSourceCarrier(
    fixture.carrier,
    trustedContext(fixture.authorityKind, "operator-b"),
  );
  const otherNamespace = authorizeReviewLineageSourceCarrier(
    fixture.carrier,
    trustedContext(
      fixture.authorityKind,
      fixture.issuerId,
      "phase13-other-namespace",
    ),
  );
  const otherRefCarrier = {
    ...structuredClone(fixture.carrier),
    sourceEventRef: "operator:phase13:cancel:2",
  };
  const otherRef = authorizeReviewLineageSourceCarrier(
    otherRefCarrier,
    context,
  );
  assert.notEqual(otherIssuer.producerId, first.producerId);
  assert.notEqual(otherNamespace.producerId, first.producerId);
  assert.notEqual(otherRef.sourceEventId, first.sourceEventId);
});

test("carrier cannot self-assert identity or authority and generic task data is rejected", () => {
  const fixture = fixtures()[0];
  const context = trustedContext(
    fixture.authorityKind,
    fixture.issuerId,
  );
  for (const field of ["producerId", "sourceEventId", "authorityKind"]) {
    assert.throws(
      () => authorizeReviewLineageSourceCarrier(
        {
          ...structuredClone(fixture.carrier),
          [field]: "caller-controlled",
        },
        context,
      ),
      new RegExp(`unexpected_field at \\$\\.${field}`),
    );
  }

  assert.throws(
    () => authorizeReviewLineageSourceCarrier(
      {
        kind: REVIEW_LINEAGE_SOURCE_CARRIER_KIND,
        taskId: "generic-task",
        status: "succeeded",
        result: { summary: "infer a lineage fact" },
      },
      context,
    ),
    /unexpected_field at \$\.taskId/,
  );
  assert.throws(
    () => authorizeReviewLineageSourceCarrier(
      {
        ...structuredClone(fixtures()[4].carrier),
        cancellation: {
          kind: "operator_cancel",
          reason: "generic recursive cancellation",
        },
      },
      trustedContext("operator", "operator-a"),
    ),
    /unexpected_field at \$\.cancellation/,
  );
});

test("source kind, authority, reviewer identity, and canonical observation validation fail closed", () => {
  const review = fixtures()[1];
  assert.throws(
    () => authorizeReviewLineageSourceCarrier(
      {
        ...structuredClone(review.carrier),
        sourceKind: "lineage_cancel_decided",
      },
      trustedContext("reviewer", "reviewer-a"),
    ),
    /source_kind_mismatch at \$\.sourceKind/,
  );
  assert.throws(
    () => authorizeReviewLineageSourceCarrier(
      review.carrier,
      trustedContext("operator", "reviewer-a"),
    ),
    /authority_mismatch at \$trustedContext\.authorityKind/,
  );
  assert.throws(
    () => authorizeReviewLineageSourceCarrier(
      review.carrier,
      trustedContext("reviewer", "different-reviewer"),
    ),
    /issuer_mismatch at \$trustedContext\.issuerId/,
  );

  const missingBinding = structuredClone(review.carrier) as
    & Record<string, unknown>
    & { binding?: unknown };
  delete missingBinding.binding;
  assert.throws(
    () => authorizeReviewLineageSourceCarrier(
      missingBinding,
      trustedContext("reviewer", "reviewer-a"),
    ),
    /invalid_object at \$\.binding/,
  );
});

test("only factory-issued immutable trusted contexts are accepted", () => {
  const fixture = fixtures()[4];
  const issued = trustedContext("operator", "operator-a");
  assert.equal(Object.isFrozen(issued), true);
  assert.throws(
    () => authorizeReviewLineageSourceCarrier(
      fixture.carrier,
      {
        kind: "a2a.review-lineage-trusted-source-context.v1",
        authorityKind: "operator",
        issuerId: "operator-a",
        sourceNamespace: "phase13-contract-tests",
      } as unknown as ReviewLineageTrustedSourceContextV1,
    ),
    /untrusted_context at \$trustedContext/,
  );
  assert.throws(
    () => authorizeReviewLineageSourceCarrier(
      fixture.carrier,
      structuredClone(issued) as ReviewLineageTrustedSourceContextV1,
    ),
    /untrusted_context at \$trustedContext/,
  );

  assert.throws(
    () => createReviewLineageTrustedSourceContext({
      authorityKind: "operator",
      issuerId: "operator with spaces",
      sourceNamespace: "phase13-contract-tests",
    }),
    /invalid_string at \$trustedContext\.issuerId/,
  );
  assert.throws(
    () => createReviewLineageTrustedSourceContext({
      authorityKind: "operator",
      issuerId: "operator-a",
      sourceNamespace: "phase13-contract-tests",
      extra: "not allowed",
    } as never),
    /unexpected_field at \$trustedContext\.extra/,
  );
});
