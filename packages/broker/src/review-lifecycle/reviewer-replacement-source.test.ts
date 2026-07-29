import assert from "node:assert/strict";
import test from "node:test";

import {
  authorizeOperatorReviewLineageReviewerReplacement,
} from "./reviewer-replacement-source.js";
import {
  projectReviewLineageProducerFact,
} from "./producer-contract.js";

const LINEAGE_ID = "phase18-lineage";
const OPERATOR_ID = "operator-alpha";
const BINDING = {
  intentHash: `sha256:${"a".repeat(64)}`,
  headSha: "b".repeat(40),
  diffHash: `sha256:${"c".repeat(64)}`,
};

function request() {
  return {
    decisionRef: "reviewer-replacement:phase18:1",
    observedAt: "2026-07-28T12:00:00Z",
    binding: BINDING,
  };
}

test("replacement source fixes infrastructure decision and derives allocator identities", () => {
  const authorized = authorizeOperatorReviewLineageReviewerReplacement(
    LINEAGE_ID,
    request(),
    OPERATOR_ID,
  );
  assert.deepEqual(authorized.fact.observation, {
    kind: "reviewer_replacement",
    reason: "infrastructure_failure",
  });
  assert.equal(authorized.fact.lineageId, LINEAGE_ID);
  assert.equal(
    authorized.source.sourceKind,
    "reviewer_replacement_decided",
  );
  assert.equal(authorized.source.authorityKind, "reviewer_allocator");
  assert.match(
    authorized.source.producerId,
    /^review-lineage-source:v1:[0-9a-f]{64}$/,
  );
  assert.match(
    authorized.source.sourceEventId,
    /^review-lineage-event:v1:[0-9a-f]{64}$/,
  );
  assert.match(authorized.source.sourceEventRefHash, /^sha256:[0-9a-f]{64}$/);

  const command = projectReviewLineageProducerFact(authorized.fact);
  assert.equal(command.command.kind, "record_event");
  assert.deepEqual(
    command.command.kind === "record_event"
      ? command.command.event
      : undefined,
    {
      type: "reviewer_replacement",
      at: request().observedAt,
      reason: "infrastructure_failure",
    },
  );
});

test("replacement request admits exactly decisionRef, observedAt, and binding", () => {
  for (const field of Object.keys(request())) {
    const missing = { ...request() } as Record<string, unknown>;
    delete missing[field];
    assert.throws(
      () => authorizeOperatorReviewLineageReviewerReplacement(
        LINEAGE_ID,
        missing,
        OPERATOR_ID,
      ),
      new RegExp(`invalid_string at \\$request\\.${field}`),
    );
  }
  for (const field of [
    "reason",
    "detail",
    "authorityKind",
    "issuerId",
    "operatorId",
    "producerId",
    "sourceEventId",
    "sourceKind",
    "sourceNamespace",
    "reviewerId",
    "replacementReviewerId",
    "taskId",
    "assignedWorkerId",
  ]) {
    assert.throws(
      () => authorizeOperatorReviewLineageReviewerReplacement(
        LINEAGE_ID,
        { ...request(), [field]: "caller-controlled" },
        OPERATOR_ID,
      ),
      new RegExp(`unexpected_field at \\$request\\.${field}`),
    );
  }
  assert.throws(
    () => authorizeOperatorReviewLineageReviewerReplacement(
      LINEAGE_ID,
      {
        ...request(),
        binding: { ...BINDING, reviewerId: "reviewer-beta" },
      },
      OPERATOR_ID,
    ),
    /unexpected_field at \$\.binding\.reviewerId/,
  );
});

test("replacement source delegates exact subject and timestamp parsing to Phase 8", () => {
  assert.throws(
    () => authorizeOperatorReviewLineageReviewerReplacement(
      LINEAGE_ID,
      { ...request(), decisionRef: "" },
      OPERATOR_ID,
    ),
    /invalid_string at \$\.sourceEventRef/,
  );
  assert.throws(
    () => authorizeOperatorReviewLineageReviewerReplacement(
      LINEAGE_ID,
      { ...request(), observedAt: "not-an-instant" },
      OPERATOR_ID,
    ),
    /invalid_timestamp at \$\.observedAt/,
  );
  for (const [field, code] of [
    ["intentHash", "invalid_hash"],
    ["headSha", "invalid_sha"],
    ["diffHash", "invalid_hash"],
  ] as const) {
    const invalid = structuredClone(request());
    delete (invalid.binding as Record<string, unknown>)[field];
    assert.throws(
      () => authorizeOperatorReviewLineageReviewerReplacement(
        LINEAGE_ID,
        invalid,
        OPERATOR_ID,
      ),
      new RegExp(`${code} at \\$\\.binding\\.${field}`),
    );
  }
});

test("same decision re-derives identity and changed payload keeps event identity", () => {
  const first = authorizeOperatorReviewLineageReviewerReplacement(
    LINEAGE_ID,
    request(),
    OPERATOR_ID,
  );
  const replay = authorizeOperatorReviewLineageReviewerReplacement(
    LINEAGE_ID,
    structuredClone(request()),
    OPERATOR_ID,
  );
  const changed = authorizeOperatorReviewLineageReviewerReplacement(
    LINEAGE_ID,
    {
      ...request(),
      observedAt: "2026-07-28T12:00:01Z",
    },
    OPERATOR_ID,
  );
  assert.equal(replay.fact.producerId, first.fact.producerId);
  assert.equal(replay.fact.sourceEventId, first.fact.sourceEventId);
  assert.equal(changed.fact.sourceEventId, first.fact.sourceEventId);
  assert.notEqual(
    projectReviewLineageProducerFact(changed.fact).payloadFingerprint,
    projectReviewLineageProducerFact(first.fact).payloadFingerprint,
  );
});
