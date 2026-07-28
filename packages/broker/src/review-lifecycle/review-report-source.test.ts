import assert from "node:assert/strict";
import test from "node:test";

import {
  authorizeReviewerReviewLineageReport,
} from "./review-report-source.js";
import {
  projectReviewLineageProducerFact,
} from "./producer-contract.js";

const LINEAGE_ID = "phase16-lineage";
const REVIEWER_ID = "reviewer-beta";
const BINDING = {
  intentHash: `sha256:${"a".repeat(64)}`,
  headSha: "b".repeat(40),
  diffHash: `sha256:${"c".repeat(64)}`,
};

function request(note = "Bounded public-safe review note.") {
  return {
    reportRef: "review-report:phase16:1",
    observedAt: "2026-07-28T10:00:00Z",
    binding: BINDING,
    receipt: {
      kind: "ReviewReceiptV1",
      reviewerNodeId: REVIEWER_ID,
      verdict: "pass",
      note,
      headSha: BINDING.headSha,
      diffHash: BINDING.diffHash,
      intentHash: BINDING.intentHash,
      findingLedgerRef: `ledger-${LINEAGE_ID}`,
      authorWorkerId: "author-alpha",
      submittedAt: "2026-07-28T09:59:00Z",
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
  assert.equal(authorized.fact.lineageId, LINEAGE_ID);
  assert.equal(
    authorized.fact.observation.kind === "review_report"
      ? authorized.fact.observation.receipt.reviewerNodeId
      : undefined,
    REVIEWER_ID,
  );
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
  const command = projectReviewLineageProducerFact(authorized.fact);
  assert.equal(command.command.kind, "record_event");
  assert.equal(
    command.command.kind === "record_event"
      ? command.command.event.type
      : undefined,
    "review_report",
  );
});

test("same signed report re-derives identity while changed evidence changes fingerprint", () => {
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
    request("Changed evidence under one immutable report reference."),
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

test("canonical Phase 8 receipt parser rejects signer and receipt reviewer mismatch", () => {
  assert.throws(
    () => authorizeReviewerReviewLineageReport(
      LINEAGE_ID,
      request(),
      "different-key-owner",
    ),
    /issuer_mismatch at \$receipt\.reviewerNodeId/,
  );
});

test("review report request rejects missing, additional, and issuer-like fields", () => {
  const { newFindings: _missing, ...missing } = request();
  assert.throws(
    () => authorizeReviewerReviewLineageReport(
      LINEAGE_ID,
      missing,
      REVIEWER_ID,
    ),
    /invalid_string at \$request\.newFindings/,
  );
  for (const field of [
    "authorityKind",
    "issuerId",
    "reviewerIssuerId",
    "producerId",
    "sourceEventId",
    "sourceKind",
    "sourceNamespace",
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

test("review report delegates receipt, subject, and finding validation to Phase 8", () => {
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
          authorWorkerId: REVIEWER_ID,
        },
      },
      REVIEWER_ID,
    ),
    /review_not_independent at \$receipt\.authorWorkerId/,
  );
  assert.throws(
    () => authorizeReviewerReviewLineageReport(
      LINEAGE_ID,
      {
        ...request(),
        binding: { ...BINDING, diffHash: `sha256:${"d".repeat(64)}` },
      },
      REVIEWER_ID,
    ),
    /binding_mismatch at \$\.observation\.receipt\.diffHash/,
  );
});
