/**
 * Merge-ready projection tests (#1724 distinct-reviewer quorum).
 *
 * Pure domain coverage for `projectMergeReady`: quorum counts distinct
 * declared reviewer node IDs among qualifying fresh signed PASS receipts
 * while `freshPassCount` stays the raw signed-PASS record count;
 * unsigned/malformed signature rows never vote (#1724 gap (a) structural
 * guard); missing/malformed identities never count (and are never
 * String-coerced); stale and BLOCK records never vote; and a duplicate
 * reviewer's blocking finding still vetoes. Receipts here are
 * admitted-record shaped — the projection is a read model, admission
 * (cryptographic signature verification) is covered by the route and
 * receipt-contract suites.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  NCLEX_RECEIPT_CANONICALIZATION,
  NCLEX_RECEIPT_SCHEMA,
  type NclexReceiptCore,
  type NclexSignedReceipt,
} from "./receipt-contract.js";
import type { NclexReceiptRecord } from "./receipt-store.js";
import { NclexEvaluationReceiptStore } from "./receipt-store.js";
import { projectMergeReady, type MergeReadyInput } from "./merge-ready.js";

const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);

let receiptSeq = 0;

function receipt(
  overrides: Partial<NclexReceiptCore> & { receiptId?: string } = {},
): NclexSignedReceipt {
  receiptSeq += 1;
  const core: NclexReceiptCore = {
    schema: NCLEX_RECEIPT_SCHEMA,
    canonicalization: NCLEX_RECEIPT_CANONICALIZATION,
    repo: "jinwon-int/nclex",
    prNumber: 145,
    baseSha: "c".repeat(40),
    headSha: HEAD_A,
    diffHash: "dh-1",
    intentHash: "ih-1",
    authorNodeId: "dungae",
    reviewerNodeId: "seoseo",
    team: "T1",
    lane: "content_clinical",
    verdict: "PASS",
    findings: [],
    producedAt: "2026-08-06T09:00:00.000Z",
    ...overrides,
  };
  // Signature material is presentational here: the projection consumes
  // admitted records and never re-verifies signatures (that is admission's
  // job, verified by the receipt-contract and broker route suites).
  return { ...core, receiptId: `r-${receiptSeq}`, signatures: [{ protected: "prot", signature: "sig" }] };
}

function record(receiptValue: NclexSignedReceipt, recordedAt = "2026-08-06T09:00:01.000Z"): NclexReceiptRecord {
  return { receipt: receiptValue, recordedAt };
}

function input(overrides: Partial<MergeReadyInput> = {}): MergeReadyInput {
  return {
    currentHeadSha: HEAD_A,
    risk: "normal",
    gateGreen: true,
    authorDistinctApproval: true,
    mergeConflict: false,
    ...overrides,
  };
}

/** A record whose declared identity deviates from the admitted shape. */
function recordWithIdentity(reviewerNodeId: unknown): NclexReceiptRecord {
  return record({ ...receipt(), reviewerNodeId } as unknown as NclexSignedReceipt);
}

function recordWithoutIdentity(): NclexReceiptRecord {
  const base: Record<string, unknown> = { ...receipt() };
  delete base.reviewerNodeId;
  return record(base as unknown as NclexSignedReceipt);
}

/**
 * A record whose signature material deviates from the admitted shape (#1724
 * gap (a)): the snapshot-restore seam only checks receiptId presence, so such
 * rows can reach the projection without ever having been admitted. Pass
 * `undefined` to strip the field entirely.
 */
function recordWithSignatureShape(receiptId: unknown, signatures: unknown): NclexReceiptRecord {
  const base: Record<string, unknown> = { ...receipt() };
  if (receiptId === undefined) delete base.receiptId;
  else base.receiptId = receiptId;
  if (signatures === undefined) delete base.signatures;
  else base.signatures = signatures;
  return record(base as unknown as NclexSignedReceipt);
}

test("two distinct declared reviewers are ready; additive distinctReviewerCount is reported (#1724)", () => {
  const records = [
    record(receipt({ reviewerNodeId: "seoseo" })),
    record(receipt({ reviewerNodeId: "nosuk", producedAt: "2026-08-06T09:05:00.000Z", team: "T2" })),
  ];
  const projection = projectMergeReady(records, input());
  assert.equal(projection.ready, true);
  assert.equal(projection.quorum, 2);
  assert.equal(projection.freshPassCount, 2);
  assert.equal(projection.distinctReviewerCount, 2);
  assert.deepEqual(projection.reasons, []);
  assert.equal(projection.staleReceiptCount, 0);
});

test("one reviewer with different receiptId/producedAt/lane/team has one vote (#1724)", () => {
  // Confirmed baseline regression: two fresh signed PASS receipts from the
  // same reviewerNodeId must not read ready=true — different receipt
  // metadata never mints a second reviewer.
  const records = [
    record(receipt({ receiptId: "dup-1", reviewerNodeId: "seoseo", producedAt: "2026-08-06T09:00:00.000Z", lane: "content_clinical", team: "T1" })),
    record(receipt({ receiptId: "dup-2", reviewerNodeId: "seoseo", producedAt: "2026-08-06T09:05:00.000Z", lane: "evidence_adversarial", team: "cross-team" })),
  ];
  const projection = projectMergeReady(records, input());
  assert.equal(projection.ready, false);
  assert.equal(projection.freshPassCount, 2, "freshPassCount stays the raw qualifying PASS record count");
  assert.equal(projection.distinctReviewerCount, 1);
  assert.ok(projection.reasons.includes("insufficient_independent_reviewers:1/2"));
  assert.ok(
    !projection.reasons.some((reason) => reason.startsWith("insufficient_fresh_signed_pass")),
    "raw count met its quorum; only the distinct count is short",
  );

  // The store/listByPr path (what the broker route feeds the projection with)
  // yields the same verdict, including after a snapshot restore round-trip.
  const store = new NclexEvaluationReceiptStore(records);
  const restored = new NclexEvaluationReceiptStore(store.listAll());
  const viaStore = projectMergeReady(restored.listByPr("jinwon-int/nclex", 145), input());
  assert.deepEqual(viaStore, projection);
});

test("high-risk: two distinct reviewers fail, three distinct reviewers pass (#1724)", () => {
  const two = [
    record(receipt({ reviewerNodeId: "seoseo" })),
    record(receipt({ reviewerNodeId: "nosuk", producedAt: "2026-08-06T09:05:00.000Z" })),
  ];
  const short = projectMergeReady(two, input({ risk: "high-risk" }));
  assert.equal(short.ready, false);
  assert.equal(short.quorum, 3);
  assert.equal(short.distinctReviewerCount, 2);
  assert.ok(short.reasons.includes("insufficient_independent_reviewers:2/3"));

  const met = projectMergeReady(
    [...two, record(receipt({ reviewerNodeId: "yukson", producedAt: "2026-08-06T09:10:00.000Z", team: "cross-team" }))],
    input({ risk: "high-risk" }),
  );
  assert.equal(met.ready, true);
  assert.equal(met.freshPassCount, 3);
  assert.equal(met.distinctReviewerCount, 3);
  assert.ok(!met.reasons.some((reason) => reason.startsWith("insufficient_")));
});

test("whitespace duplicates collapse; node ID comparison stays case-sensitive (#1724)", () => {
  const whitespaceDuplicate = projectMergeReady(
    [
      record(receipt({ reviewerNodeId: "seoseo" })),
      record(receipt({ receiptId: "padded", reviewerNodeId: "  seoseo  " })),
    ],
    input(),
  );
  assert.equal(whitespaceDuplicate.distinctReviewerCount, 1, "trimmed duplicates are the same declared node");
  assert.equal(whitespaceDuplicate.ready, false);
  assert.ok(whitespaceDuplicate.reasons.includes("insufficient_independent_reviewers:1/2"));

  const caseDistinct = projectMergeReady(
    [
      record(receipt({ reviewerNodeId: "seoseo" })),
      record(receipt({ receiptId: "cased", reviewerNodeId: "Seoseo" })),
    ],
    input(),
  );
  assert.equal(
    caseDistinct.distinctReviewerCount,
    2,
    "no unsourced alias normalization: different case is a different declared node ID",
  );
  assert.equal(caseDistinct.ready, true);
});

test("missing or malformed identities never count toward quorum (#1724)", () => {
  const records = [
    recordWithoutIdentity(),
    recordWithIdentity(""),
    recordWithIdentity("   "),
    recordWithIdentity(42),
    recordWithIdentity(null),
  ];
  const projection = projectMergeReady(records, input());
  assert.equal(projection.freshPassCount, 5, "raw count is preserved; identity quality does not change it");
  assert.equal(projection.distinctReviewerCount, 0, "missing/nonstring identities are not counted, not String-coerced");
  assert.equal(projection.ready, false);
  assert.ok(projection.reasons.includes("insufficient_independent_reviewers:0/2"));
});

test("stale and BLOCK records never vote; stale classification is preserved (#1724)", () => {
  const records = [
    record(receipt({ receiptId: "stale-1", headSha: HEAD_B, reviewerNodeId: "seoseo" })),
    record(receipt({ receiptId: "block-1", verdict: "BLOCK", reviewerNodeId: "nosuk" })),
  ];
  const projection = projectMergeReady(records, input());
  assert.equal(projection.freshPassCount, 0);
  assert.equal(projection.distinctReviewerCount, 0);
  assert.equal(projection.staleReceiptCount, 1);
  assert.ok(projection.reasons.includes("insufficient_fresh_signed_pass:0/2"));
  assert.ok(projection.reasons.includes("insufficient_independent_reviewers:0/2"));

  // A stale receipt from a third node does not add a distinct vote either.
  const withStale = projectMergeReady(
    [
      record(receipt({ reviewerNodeId: "seoseo" })),
      record(receipt({ reviewerNodeId: "nosuk", producedAt: "2026-08-06T09:05:00.000Z" })),
      record(receipt({ receiptId: "stale-2", headSha: HEAD_B, reviewerNodeId: "yukson" })),
    ],
    input(),
  );
  assert.equal(withStale.ready, true);
  assert.equal(withStale.distinctReviewerCount, 2);
  assert.equal(withStale.staleReceiptCount, 1);
});

test("a duplicate reviewer's blocking finding still vetoes (#1724)", () => {
  const records = [
    record(receipt({ reviewerNodeId: "seoseo" })),
    record(
      receipt({
        receiptId: "dup-blocking",
        reviewerNodeId: "seoseo",
        producedAt: "2026-08-06T09:05:00.000Z",
        verdict: "BLOCK",
        findings: [{ findingId: "F-1", blocking: true }],
      }),
    ),
  ];
  const projection = projectMergeReady(records, input());
  assert.equal(projection.ready, false);
  assert.equal(projection.freshPassCount, 1, "only the PASS receipt qualifies");
  assert.equal(projection.distinctReviewerCount, 1);
  assert.equal(projection.blockingFindings, 1, "all fresh blocking findings are counted, duplicate reviewer or not");
  assert.ok(projection.reasons.includes("blocking_findings:1"));
  assert.ok(projection.reasons.includes("insufficient_independent_reviewers:1/2"));
});

test("unsigned or malformed PASS receipts never vote; admitted signed rows still do (#1724 gap a)", () => {
  const malformed = [
    recordWithSignatureShape(undefined, undefined), // signatures stripped entirely
    recordWithSignatureShape("no-sigs", []), // empty signatures array
    recordWithSignatureShape("multi-sigs", [
      { protected: "prot", signature: "sig" },
      { protected: "prot2", signature: "sig2" },
    ]), // more than one signature entry
    recordWithSignatureShape("blank-sig", [{ protected: "prot", signature: "   " }]), // blank signature
    recordWithSignatureShape("blank-prot", [{ protected: "", signature: "sig" }]), // blank protected header
    recordWithSignatureShape("   ", [{ protected: "prot", signature: "sig" }]), // blank receiptId
  ];
  const projection = projectMergeReady(malformed, input());
  assert.equal(projection.freshPassCount, 0, "unsigned/malformed PASS rows are excluded from the vote");
  assert.equal(projection.distinctReviewerCount, 0);
  assert.equal(projection.ready, false);
  assert.ok(projection.reasons.includes("insufficient_fresh_signed_pass:0/2"));
  assert.ok(projection.reasons.includes("insufficient_independent_reviewers:0/2"));
  assert.equal(projection.blockingFindings, 0, "malformed rows add no blocking findings");

  // Mixing one admitted (signed) PASS with unsigned rows leaves both quorums short.
  const mixed = projectMergeReady(
    [record(receipt({ reviewerNodeId: "seoseo" })), recordWithSignatureShape("unsigned", undefined)],
    input(),
  );
  assert.equal(mixed.freshPassCount, 1);
  assert.equal(mixed.distinctReviewerCount, 1);
  assert.equal(mixed.ready, false);
  assert.ok(mixed.reasons.includes("insufficient_fresh_signed_pass:1/2"));
  assert.ok(mixed.reasons.includes("insufficient_independent_reviewers:1/2"));

  // Two admitted signed PASS receipts remain ready — the guard adds no new veto.
  const signedReady = projectMergeReady(
    [
      record(receipt({ reviewerNodeId: "seoseo" })),
      record(receipt({ reviewerNodeId: "nosuk", producedAt: "2026-08-06T09:05:00.000Z" })),
    ],
    input(),
  );
  assert.equal(signedReady.ready, true);
  assert.equal(signedReady.freshPassCount, 2);
  assert.deepEqual(signedReady.reasons, []);
});

test("unsigned PASS rows still report blocking findings but never vote (#1724 gap a)", () => {
  const base: Record<string, unknown> = {
    ...receipt({ reviewerNodeId: "seoseo", findings: [{ findingId: "F-9", blocking: true }] }),
  };
  delete base.signatures;
  const unsignedBlocking = record(base as unknown as NclexSignedReceipt);

  const projection = projectMergeReady([unsignedBlocking], input());
  assert.equal(projection.freshPassCount, 0, "an unsigned PASS row never votes");
  assert.equal(projection.blockingFindings, 1, "blocking findings still count across all fresh records");
  assert.equal(projection.ready, false);
  assert.ok(projection.reasons.includes("blocking_findings:1"));
  assert.ok(projection.reasons.includes("insufficient_fresh_signed_pass:0/2"));
});

test("snapshot restore round-trip keeps unsigned rows non-voting (#1724 gap a)", () => {
  const signed = record(receipt({ reviewerNodeId: "seoseo" }));
  const unsignedBase: Record<string, unknown> = {
    ...receipt({ reviewerNodeId: "nosuk", producedAt: "2026-08-06T09:05:00.000Z" }),
  };
  unsignedBase.signatures = []; // malformed restored row with a nonblank receiptId
  const store = new NclexEvaluationReceiptStore([signed, record(unsignedBase as unknown as NclexSignedReceipt)]);

  const projection = projectMergeReady(store.listByPr("jinwon-int/nclex", 145), input());
  assert.equal(projection.freshPassCount, 1, "only the admitted signed PASS row votes");
  assert.equal(projection.distinctReviewerCount, 1);
  assert.equal(projection.ready, false);
  assert.ok(projection.reasons.includes("insufficient_fresh_signed_pass:1/2"));

  const again = new NclexEvaluationReceiptStore(store.listAll());
  assert.deepEqual(projectMergeReady(again.listByPr("jinwon-int/nclex", 145), input()), projection);
});

