import assert from "node:assert/strict";
import test from "node:test";

import { intentHash } from "./canonical-json.js";
import {
  authorizeOperatorReviewLineageCreate,
} from "./lineage-create-source.js";
import { projectReviewLineageProducerFact } from "./producer-contract.js";
import type {
  IntentContractV1,
  ReviewLineageBudgetV1,
} from "./types.js";

const BASE_SHA = "a".repeat(40);
const HEAD_SHA = "b".repeat(40);
const DIFF_HASH = `sha256:${"c".repeat(64)}`;
const OBSERVED_AT = "2026-07-23T17:20:00Z";

function contract(lineageId = "phase15-lineage"): IntentContractV1 {
  const partial = {
    kind: "IntentContractV1" as const,
    lineageId,
    goal: "Freeze one bounded review lineage.",
    nonGoals: ["Do not attach review completion."],
    invariants: ["Only an authenticated operator starts a lineage."],
    acceptanceCriteria: [
      { id: "AC-1", text: "Source, lineage, and ledger commit atomically." },
    ],
    declaredPaths: {
      allowed: ["packages/broker/src/**"],
      forbidden: ["packages/broker/src/worker.ts"],
    },
    baseSha: BASE_SHA,
    headSha: HEAD_SHA,
    createdAt: OBSERVED_AT,
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

function request(lineageId = "phase15-lineage") {
  const frozen = contract(lineageId);
  return {
    dispatchRef: `lineage-dispatch:${lineageId}:1`,
    observedAt: OBSERVED_AT,
    binding: {
      intentHash: frozen.intentHash,
      headSha: frozen.headSha,
      diffHash: DIFF_HASH,
    },
    contract: frozen,
    budget: budget(),
  };
}

test("lineage create source derives dispatcher authority and identities outside request data", () => {
  const authorized = authorizeOperatorReviewLineageCreate(
    request(),
    "operator-seoseo",
  );
  assert.equal(authorized.fact.observation.kind, "lineage_create");
  assert.equal(authorized.fact.lineageId, "phase15-lineage");
  assert.match(
    authorized.source.producerId,
    /^review-lineage-source:v1:[0-9a-f]{64}$/,
  );
  assert.match(
    authorized.source.sourceEventId,
    /^review-lineage-event:v1:[0-9a-f]{64}$/,
  );
  assert.equal(authorized.source.sourceKind, "lineage_contract_frozen");
  assert.equal(authorized.source.authorityKind, "lineage_dispatcher");
  assert.match(authorized.source.sourceEventRefHash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(
    projectReviewLineageProducerFact(authorized.fact).command.kind,
    "create_lineage",
  );
});

test("same dispatch re-derives identity while changed evidence changes fingerprint", () => {
  const first = authorizeOperatorReviewLineageCreate(
    request(),
    "operator-seoseo",
  );
  const replay = authorizeOperatorReviewLineageCreate(
    structuredClone(request()),
    "operator-seoseo",
  );
  const changedRequest = request();
  changedRequest.budget.maxReviewerRuns = 3;
  const changed = authorizeOperatorReviewLineageCreate(
    changedRequest,
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

test("lineage create request cannot inject authority, identity, or source kind", () => {
  for (const field of [
    "authorityKind",
    "issuerId",
    "producerId",
    "sourceEventId",
    "sourceKind",
  ]) {
    assert.throws(
      () => authorizeOperatorReviewLineageCreate(
        { ...request(), [field]: "caller-controlled" },
        "operator-seoseo",
      ),
      new RegExp(`unexpected_field at \\$request\\.${field}`),
    );
  }
});

test("lineage create delegates nested contract and binding validation to the canonical parser", () => {
  assert.throws(
    () => authorizeOperatorReviewLineageCreate(
      { ...request(), dispatchRef: "" },
      "operator-seoseo",
    ),
    /invalid_string at \$\.sourceEventRef/,
  );
  assert.throws(
    () => authorizeOperatorReviewLineageCreate(
      {
        ...request(),
        binding: { ...request().binding, headSha: "not-a-sha" },
      },
      "operator-seoseo",
    ),
    /invalid_sha at \$\.binding\.headSha/,
  );
  assert.throws(
    () => authorizeOperatorReviewLineageCreate(
      {
        ...request(),
        contract: { ...contract(), lineageId: "different-lineage" },
      },
      "operator-seoseo",
    ),
    /intent_hash_mismatch at \$\.observation\.contract\.intentHash/,
  );
});
