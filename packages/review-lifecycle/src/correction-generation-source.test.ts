import assert from "node:assert/strict";
import test from "node:test";

import {
  authorizeOperatorReviewLineageCorrectionGeneration,
} from "./correction-generation-source.js";
import {
  projectReviewLineageProducerFact,
} from "./producer-contract.js";

const LINEAGE_ID = "phase17-lineage";
const OPERATOR_ID = "operator-alpha";
const BINDING = {
  intentHash: `sha256:${"a".repeat(64)}`,
  headSha: "b".repeat(40),
  diffHash: `sha256:${"c".repeat(64)}`,
};
const NEXT_HEAD_SHA = "d".repeat(40);
const NEXT_DIFF_HASH = `sha256:${"e".repeat(64)}`;

function request(pathsChanged = ["packages/broker/src/core/broker.ts"]) {
  return {
    generationRef: "correction-generation:phase17:1",
    observedAt: "2026-07-28T11:00:00Z",
    binding: BINDING,
    headSha: NEXT_HEAD_SHA,
    diffHash: NEXT_DIFF_HASH,
    intentHash: BINDING.intentHash,
    pathsChanged,
  };
}

test("correction source derives controller authority and identities outside request data", () => {
  const authorized = authorizeOperatorReviewLineageCorrectionGeneration(
    LINEAGE_ID,
    request(),
    OPERATOR_ID,
  );
  assert.equal(authorized.fact.observation.kind, "correction_generation");
  assert.equal(authorized.fact.lineageId, LINEAGE_ID);
  assert.match(
    authorized.source.producerId,
    /^review-lineage-source:v1:[0-9a-f]{64}$/,
  );
  assert.match(
    authorized.source.sourceEventId,
    /^review-lineage-event:v1:[0-9a-f]{64}$/,
  );
  assert.equal(
    authorized.source.sourceKind,
    "correction_generation_committed",
  );
  assert.equal(
    authorized.source.authorityKind,
    "correction_controller",
  );
  assert.match(authorized.source.sourceEventRefHash, /^sha256:[0-9a-f]{64}$/);

  const command = projectReviewLineageProducerFact(authorized.fact);
  assert.equal(command.command.kind, "record_event");
  assert.equal(
    command.command.kind === "record_event"
      ? command.command.event.type
      : undefined,
    "correction_generation",
  );
});

test("same generation re-derives identity while changed payload changes fingerprint", () => {
  const first = authorizeOperatorReviewLineageCorrectionGeneration(
    LINEAGE_ID,
    request(),
    OPERATOR_ID,
  );
  const replay = authorizeOperatorReviewLineageCorrectionGeneration(
    LINEAGE_ID,
    structuredClone(request()),
    OPERATOR_ID,
  );
  const changed = authorizeOperatorReviewLineageCorrectionGeneration(
    LINEAGE_ID,
    request(["packages/broker/src/core/store.ts"]),
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

test("correction request rejects missing, additional, and identity fields", () => {
  for (const field of Object.keys(request())) {
    const missing = {
      ...request(),
    } as Record<string, unknown>;
    delete missing[field];
    assert.throws(
      () => authorizeOperatorReviewLineageCorrectionGeneration(
        LINEAGE_ID,
        missing,
        OPERATOR_ID,
      ),
      new RegExp(`invalid_string at \\$request\\.${field}`),
    );
  }
  for (const field of [
    "authorityKind",
    "issuerId",
    "operatorId",
    "producerId",
    "sourceEventId",
    "sourceKind",
    "sourceNamespace",
  ]) {
    assert.throws(
      () => authorizeOperatorReviewLineageCorrectionGeneration(
        LINEAGE_ID,
        { ...request(), [field]: "caller-controlled" },
        OPERATOR_ID,
      ),
      new RegExp(`unexpected_field at \\$request\\.${field}`),
    );
  }
});

test("correction source delegates subject, intent, head, diff, and path validation to Phase 8", () => {
  assert.throws(
    () => authorizeOperatorReviewLineageCorrectionGeneration(
      LINEAGE_ID,
      { ...request(), generationRef: "" },
      OPERATOR_ID,
    ),
    /invalid_string at \$\.sourceEventRef/,
  );
  assert.throws(
    () => authorizeOperatorReviewLineageCorrectionGeneration(
      LINEAGE_ID,
      {
        ...request(),
        intentHash: `sha256:${"f".repeat(64)}`,
      },
      OPERATOR_ID,
    ),
    /binding_mismatch at \$\.observation\.intentHash/,
  );
  assert.throws(
    () => authorizeOperatorReviewLineageCorrectionGeneration(
      LINEAGE_ID,
      {
        ...request(),
        headSha: BINDING.headSha,
        diffHash: BINDING.diffHash,
      },
      OPERATOR_ID,
    ),
    /subject_not_changed at \$\.observation/,
  );
  assert.throws(
    () => authorizeOperatorReviewLineageCorrectionGeneration(
      LINEAGE_ID,
      request([
        "packages/broker/src/core/broker.ts",
        "packages/broker/src/core/broker.ts",
      ]),
      OPERATOR_ID,
    ),
    /duplicate_value at \$\.observation\.pathsChanged\[1\]/,
  );
  assert.throws(
    () => authorizeOperatorReviewLineageCorrectionGeneration(
      LINEAGE_ID,
      {
        ...request(),
        binding: { ...BINDING, authorityKind: "correction_controller" },
      },
      OPERATOR_ID,
    ),
    /unexpected_field at \$\.binding\.authorityKind/,
  );
});
