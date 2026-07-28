import assert from "node:assert/strict";
import test from "node:test";

import { projectReviewLineageProducerFact } from "./producer-contract.js";
import {
  authorizeReviewerReviewLineageReport,
} from "./review-report-source.js";

const LINEAGE_ID = "phase16-review-lineage";
const REVIEWER_ID = "reviewer-yukson";
const BINDING = {
  intentHash: `sha256:${"a".repeat(64)}`,
  headSha: "b".repeat(40),
  diffHash: `sha256:${"c".repeat(64)}`,
};

function request(note = "Bounded private review reason.") {
  return {
    reportRef: "review-report:phase16:1",
    observedAt: "2026-07-28T10:00:00Z",
    binding: BINDING,
    receipt: {
      kind: "ReviewReceiptV1" as const,
      reviewerNodeId: REVIEWER_ID,
      verdict: "pass" as const,
      note,
      headSha: BINDING.headSha,
      diffHash: BINDING.diffHash,
      intentHash: BINDING.intentHash,
      findingLedgerRef: `ledger-${LINEAGE_ID}`,
      authorWorkerId: "author-bangtong",
      submittedAt: "2026-07-28T09:59:30Z",
    },
    resolvedFindingIds: [],
    reopenedFindingIds: [],
    newFindings: [],
  };
}

test("review report source derives reviewer authority and identities outside request data", () => {
  const authorized = authorizeReviewerReviewLineageReport(
    LINEAGE_ID,
    request(),
    REVIEWER_ID,
  );
  assert.equal(authorized.fact.observation.kind, "review_report");
  assert.match(
    authorized.source.producerId,
    /^review-lineage-source:v1:[0-9a-f]{64}$/,
  );
  assert.match(
    authorized.source.sourceEventId,
    /^review-lineage-event:v1:[0-9a-f]{64}$/,
  );
  assert.equal(authorized.source.sourceKind, "review_report_submitted");
  assert.equal(authorized.source.authorityKind, "reviewer");
  assert.match(authorized.source.sourceEventRefHash, /^sha256:[0-9a-f]{64}$/);
  const projected = projectReviewLineageProducerFact(authorized.fact);
  assert.equal(projected.command.kind, "record_event");
  if (projected.command.kind !== "record_event") {
    throw new Error("review report must project a record_event command");
  }
  assert.equal(projected.command.event.type, "review_report");
});

test("authenticated reviewer must match the complete receipt identity", () => {
  assert.throws(
    () => authorizeReviewerReviewLineageReport(
      LINEAGE_ID,
      request(),
      "different-signed-reviewer",
    ),
    /issuer_mismatch at \$trustedContext\.issuerId/,
  );
});

test("review report request cannot inject authority, identity, source kind, or generic evidence", () => {
  for (const field of [
    "authorityKind",
    "issuerId",
    "producerId",
    "sourceEventId",
    "sourceKind",
    "task",
    "result",
    "log",
    "prompt",
    "providerPayload",
    "credential",
    "privateReviewProse",
  ]) {
    assert.throws(
      () => authorizeReviewerReviewLineageReport(
        LINEAGE_ID,
        { ...request(), [field]: "caller-controlled" },
        REVIEWER_ID,
      ),
      new RegExp(`unexpected_field at \\$request\\.${field}`),
    );
  }
});

test("same report re-derives identity while changed receipt evidence changes fingerprint", () => {
  const first = authorizeReviewerReviewLineageReport(
    LINEAGE_ID,
    request(),
    REVIEWER_ID,
  );
  const replay = authorizeReviewerReviewLineageReport(
    LINEAGE_ID,
    structuredClone(request()),
    REVIEWER_ID,
  );
  const changed = authorizeReviewerReviewLineageReport(
    LINEAGE_ID,
    request("Changed private reason under the immutable report."),
    REVIEWER_ID,
  );
  assert.equal(replay.fact.producerId, first.fact.producerId);
  assert.equal(replay.fact.sourceEventId, first.fact.sourceEventId);
  assert.equal(changed.fact.sourceEventId, first.fact.sourceEventId);
  assert.notEqual(
    projectReviewLineageProducerFact(changed.fact).payloadFingerprint,
    projectReviewLineageProducerFact(first.fact).payloadFingerprint,
  );
});

test("review report delegates nested exact-field and receipt validation to Phase 8", () => {
  assert.throws(
    () => authorizeReviewerReviewLineageReport(
      LINEAGE_ID,
      { ...request(), reportRef: "" },
      REVIEWER_ID,
    ),
    /invalid_string at \$\.sourceEventRef/,
  );
  assert.throws(
    () => authorizeReviewerReviewLineageReport(
      LINEAGE_ID,
      {
        ...request(),
        receipt: {
          ...request().receipt,
          rawProviderResponse: "must fail closed",
        },
      },
      REVIEWER_ID,
    ),
    /unexpected_field at \$\.observation\.receipt\.rawProviderResponse/,
  );
  assert.throws(
    () => authorizeReviewerReviewLineageReport(
      LINEAGE_ID,
      {
        ...request(),
        receipt: {
          ...request().receipt,
          reviewerNodeId: "author-bangtong",
        },
      },
      "author-bangtong",
    ),
    /review_not_independent at \$\.observation\.receipt\.authorWorkerId/,
  );
});
