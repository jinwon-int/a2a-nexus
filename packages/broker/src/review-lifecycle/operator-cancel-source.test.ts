import assert from "node:assert/strict";
import test from "node:test";

import {
  authorizeOperatorReviewLineageCancel,
} from "./operator-cancel-source.js";
import { projectReviewLineageProducerFact } from "./producer-contract.js";

const BINDING = {
  intentHash: `sha256:${"a".repeat(64)}`,
  headSha: "b".repeat(40),
  diffHash: `sha256:${"c".repeat(64)}`,
};

function request(detail = "Explicit operator cancellation.") {
  return {
    decisionRef: "operator-decision:phase14:1",
    observedAt: "2026-07-23T16:40:00Z",
    binding: BINDING,
    detail,
  };
}

test("operator cancel source derives authority and identities outside request data", () => {
  const authorized = authorizeOperatorReviewLineageCancel(
    "phase14-lineage",
    request(),
    "operator-seoseo",
  );
  assert.equal(
    authorized.fact.observation.kind,
    "operator_cancel",
  );
  assert.match(
    authorized.source.producerId,
    /^review-lineage-source:v1:[0-9a-f]{64}$/,
  );
  assert.match(
    authorized.source.sourceEventId,
    /^review-lineage-event:v1:[0-9a-f]{64}$/,
  );
  assert.equal(authorized.source.sourceKind, "lineage_cancel_decided");
  assert.equal(authorized.source.authorityKind, "operator");
  assert.match(authorized.source.sourceEventRefHash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(
    projectReviewLineageProducerFact(authorized.fact).command.kind,
    "record_event",
  );
});

test("same operator decision re-derives identity while changed evidence changes fingerprint", () => {
  const first = authorizeOperatorReviewLineageCancel(
    "phase14-lineage",
    request(),
    "operator-seoseo",
  );
  const replay = authorizeOperatorReviewLineageCancel(
    "phase14-lineage",
    structuredClone(request()),
    "operator-seoseo",
  );
  const changed = authorizeOperatorReviewLineageCancel(
    "phase14-lineage",
    request("Changed evidence under the immutable decision."),
    "operator-seoseo",
  );
  assert.equal(replay.fact.producerId, first.fact.producerId);
  assert.equal(replay.fact.sourceEventId, first.fact.sourceEventId);
  assert.equal(changed.fact.sourceEventId, first.fact.sourceEventId);
  assert.notEqual(
    projectReviewLineageProducerFact(changed.fact).payloadFingerprint,
    projectReviewLineageProducerFact(first.fact).payloadFingerprint,
  );
});

test("request cannot inject authority, derived identity, or additional fields", () => {
  for (const field of [
    "authorityKind",
    "producerId",
    "sourceEventId",
    "sourceKind",
  ]) {
    assert.throws(
      () => authorizeOperatorReviewLineageCancel(
        "phase14-lineage",
        { ...request(), [field]: "caller-controlled" },
        "operator-seoseo",
      ),
      new RegExp(`unexpected_field at \\$request\\.${field}`),
    );
  }
});

test("canonical carrier and observation validation remains fail closed", () => {
  assert.throws(
    () => authorizeOperatorReviewLineageCancel(
      "phase14-lineage",
      { ...request(), decisionRef: "" },
      "operator-seoseo",
    ),
    /invalid_string at \$\.sourceEventRef/,
  );
  assert.throws(
    () => authorizeOperatorReviewLineageCancel(
      "phase14-lineage",
      {
        ...request(),
        binding: { ...BINDING, headSha: "not-a-sha" },
      },
      "operator-seoseo",
    ),
    /invalid_sha at \$\.binding\.headSha/,
  );
});
