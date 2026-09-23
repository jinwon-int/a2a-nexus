#!/usr/bin/env node
/**
 * Deterministic contract tests for the nclex_content_pr_v1 preset (#1724).
 * No network, no provider, no broker: routing, readiness, and projection are
 * pure functions pinned by golden cases plus fail-closed fixtures (self
 * review, head drift, manifest mismatch, malformed input) and the #1724
 * distinct-reviewer quorum (declared reviewerNodeId identity rules,
 * preserved raw freshPassCount, additive insufficient_independent_reviewers).
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  NCLEX_CONTENT_PR_PRESET_V1,
  NclexPresetError,
  classifyReceipts,
  evaluateMergeReadiness,
  formatEvaluationComment,
  refsManifestDigestSha256,
  routeEvaluation,
  validatePresetInput,
  verifyRefsManifest,
} from "./nclex-content-pr-preset.mjs";

const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);
const BASE = "c".repeat(40);
const MANIFEST = "d".repeat(64);

function input(overrides = {}) {
  return {
    repo: "jinwon-int/nclex",
    prNumber: 145,
    baseSha: BASE,
    headSha: HEAD_A,
    diffHash: "diffhash-1",
    intentHash: "intenthash-1",
    authorNodeId: "dungae",
    caseIds: ["RN-CASE-PA-003"],
    sourcePacketId: "packet-2026-08-06",
    refsManifestSha256: MANIFEST,
    risk: "normal",
    ...overrides,
  };
}

const REGISTRY = [
  { nodeId: "dungae", team: "T2", formalReviewEligible: true },
  { nodeId: "soonwook", team: "T2", formalReviewEligible: true },
  { nodeId: "seoseo", team: "T1", formalReviewEligible: true },
  { nodeId: "nosuk", team: "T1", formalReviewEligible: true },
  { nodeId: "yukson", team: "T1", formalReviewEligible: true },
  { nodeId: "daegyo", team: "T2", formalReviewEligible: false },
];

test("preset constants pin the two lanes and bounded budget defaults", () => {
  assert.equal(NCLEX_CONTENT_PR_PRESET_V1.presetId, "nclex_content_pr_v1");
  assert.deepEqual(
    NCLEX_CONTENT_PR_PRESET_V1.lanes.map((lane) => lane.kind),
    ["content_clinical", "evidence_adversarial"],
  );
  assert.deepEqual(NCLEX_CONTENT_PR_PRESET_V1.budget, { maxCorrectionGenerations: 1, maxReviewerRuns: 2 });
  assert.equal(NCLEX_CONTENT_PR_PRESET_V1.sideEffectPolicy, "finalizer-only");
});

test("input validation fails closed on missing fields and malformed hashes", () => {
  assert.throws(() => validatePresetInput(null), (e) => e instanceof NclexPresetError && e.code === "input_invalid");
  assert.throws(
    () => validatePresetInput(input({ refsManifestSha256: "short" })),
    (e) => e.code === "refs_manifest_invalid",
    "manifest mismatch class must fail closed",
  );
  assert.throws(() => validatePresetInput(input({ headSha: "zzz" })), (e) => e.code === "input_invalid");
  const noCases = input({ caseIds: [] });
  assert.throws(() => validatePresetInput(noCases), (e) => e.code === "input_invalid");
  const { authorNodeId, ...rest } = input();
  assert.throws(
    () => validatePresetInput(rest),
    (e) => e.code === "input_missing_fields" && e.details.missing.includes("authorNodeId"),
  );
});

test("routing: T2 author goes to T1 reviewers with broker of record team1 (#633 invariant)", () => {
  const routed = routeEvaluation({ input: input(), registry: REGISTRY });
  assert.equal(routed.reviewerTeam, "T1");
  assert.equal(routed.brokerOfRecord, "brokerAlpha");
  assert.equal(routed.quorum, 2);
  assert.equal(routed.lanes.length, 2);
  assert.ok(routed.lanes.every((lane) => ["seoseo", "nosuk", "yukson"].includes(lane.reviewerNodeId)));
  assert.ok(routed.lanes.every((lane) => lane.reviewerNodeId !== "dungae"), "author is recused by construction");
  assert.equal(new Set(routed.lanes.map((lane) => lane.reviewerNodeId)).size, 2, "reviewers are distinct");
  assert.deepEqual(
    routed.lanes.map((lane) => lane.kind),
    ["content_clinical", "evidence_adversarial"],
  );
});

test("routing: T1 author goes to T2 reviewers, ineligible members are skipped", () => {
  const routed = routeEvaluation({ input: input({ authorNodeId: "seoseo" }), registry: REGISTRY });
  assert.equal(routed.reviewerTeam, "T2");
  assert.equal(routed.brokerOfRecord, "brokerBeta");
  assert.deepEqual(
    routed.lanes.map((lane) => lane.reviewerNodeId),
    ["dungae", "soonwook"],
    "daegyo is not formal-review eligible and never appears",
  );
});

test("routing: co-authors are recused alongside the author", () => {
  const routed = routeEvaluation({
    input: input({ authorNodeId: "seoseo", coAuthorNodeIds: ["dungae"] }),
    registry: REGISTRY,
  });
  assert.ok(routed.lanes.every((lane) => !["seoseo", "dungae"].includes(lane.reviewerNodeId)));
  assert.ok(routed.lanes.some((lane) => lane.reviewerNodeId === "soonwook"));
});

test("routing: understaffed team expands cross-team before failing", () => {
  const routed = routeEvaluation({
    input: input({ authorNodeId: "seoseo", coAuthorNodeIds: ["dungae"] }),
    registry: REGISTRY,
  });
  assert.equal(routed.lanes.length, 2, "quorum filled across teams");
  assert.equal(routed.reviewerTeam, "cross-team");
  assert.ok(!routed.lanes.some((lane) => ["seoseo", "dungae"].includes(lane.reviewerNodeId)));
});

test("routing: high-risk requires three independent reviewers", () => {
  const routed = routeEvaluation({ input: input({ risk: "high-risk" }), registry: REGISTRY });
  assert.equal(routed.quorum, 3);
  assert.equal(routed.lanes.length, 3);
});

test("routing: high-risk wraps the two contract lane kinds cyclically by design (#1724)", () => {
  const routed = routeEvaluation({ input: input({ risk: "high-risk" }), registry: REGISTRY });
  // The preset contract fixes exactly two lane kinds, so the third high-risk
  // lane deliberately reuses `content_clinical` instead of inventing a kind.
  // Independence is reviewer-based (distinct reviewerNodeId + cross-team
  // expansion), never kind-based; laneIds stay unique regardless.
  assert.deepEqual(
    routed.lanes.map((lane) => lane.kind),
    ["content_clinical", "evidence_adversarial", "content_clinical"],
  );
  assert.equal(new Set(routed.lanes.map((lane) => lane.reviewerNodeId)).size, 3, "three distinct reviewers");
  assert.notEqual(routed.lanes[2].reviewerNodeId, routed.lanes[0].reviewerNodeId);
  assert.equal(new Set(routed.lanes.map((lane) => lane.laneId)).size, 3, "laneIds stay unique despite the repeated kind");
});

test("routing fails closed when no independent quorum exists (self-review impossible)", () => {
  const soloRegistry = [{ nodeId: "dungae", team: "T2", formalReviewEligible: true }];
  assert.throws(
    () => routeEvaluation({ input: input(), registry: soloRegistry }),
    (e) => e.code === "insufficient_reviewers",
    "a fleet that can only self-review must fail closed, never self-assign",
  );
});

test("receipt staleness: only exact-head receipts count as fresh", () => {
  const { fresh, stale } = classifyReceipts({
    receipts: [
      { receiptId: "r1", headSha: HEAD_A, verdict: "PASS", signed: true },
      { receiptId: "r2", headSha: HEAD_B, verdict: "PASS", signed: true },
    ],
    currentHeadSha: HEAD_A,
  });
  assert.deepEqual(fresh.map((r) => r.receiptId), ["r1"]);
  assert.deepEqual(stale.map((r) => r.receiptId), ["r2"], "head drift stales prior PASS evidence");
});

test("merge-ready requires gate, fresh quorum, zero blockers, distinct approval, no conflict", () => {
  // Positive fixtures carry real distinct reviewer node IDs (#1724): quorum is
  // judged on distinct declared IDs, so two same-reviewer receipts can never
  // make a PR ready.
  const receipts = [
    { receiptId: "r1", headSha: HEAD_A, verdict: "PASS", signed: true, reviewerNodeId: "seoseo" },
    { receiptId: "r2", headSha: HEAD_A, verdict: "PASS", signed: true, reviewerNodeId: "nosuk" },
  ];
  const ready = evaluateMergeReadiness({
    gateGreen: true,
    currentHeadSha: HEAD_A,
    receipts,
    blockingFindings: 0,
    authorDistinctApproval: true,
    mergeConflict: false,
  });
  assert.equal(ready.ready, true);
  assert.equal(ready.freshPassCount, 2);
  assert.equal(ready.distinctReviewerCount, 2);

  // Stale (previous-head) receipts are excluded from the vote and reported via
  // staleReceiptCount, but must NOT veto readiness when quorum is otherwise met
  // (BUG-08); a stale-count veto deadlocked re-reviewed PRs since receipts are
  // never pruned.
  const withStale = evaluateMergeReadiness({
    gateGreen: true,
    currentHeadSha: HEAD_A,
    receipts: [...receipts, { receiptId: "r-stale", headSha: HEAD_B, verdict: "PASS", signed: true, reviewerNodeId: "yukson" }],
    blockingFindings: 0,
    authorDistinctApproval: true,
    mergeConflict: false,
  });
  assert.equal(withStale.ready, true, "stale receipts must not veto a PR that meets quorum");
  assert.equal(withStale.staleReceiptCount, 1);
  assert.equal(withStale.distinctReviewerCount, 2, "stale receipts are not votes toward distinct quorum either");
  assert.ok(!withStale.reasons.includes("stale_receipts_excluded:1"), "stale receipts must not be a blocking reason");

  const cases = [
    [{ gateGreen: false }, "github_gate_not_green"],
    [{ receipts: receipts.slice(1) }, "insufficient_fresh_signed_pass:1/2"],
    [{ blockingFindings: 1 }, "blocking_findings:1"],
    [{ authorDistinctApproval: false }, "author_distinct_approval_missing"],
    [{ mergeConflict: true }, "merge_conflict_present"],
    [
      {
        receipts: [
          { receiptId: "r4", headSha: HEAD_A, verdict: "PASS", signed: false, reviewerNodeId: "yukson" },
          ...receipts.slice(1),
        ],
      },
      "insufficient_fresh_signed_pass:1/2",
    ],
  ];
  for (const [overrides, reason] of cases) {
    const verdict = evaluateMergeReadiness({
      gateGreen: true,
      currentHeadSha: HEAD_A,
      receipts,
      blockingFindings: 0,
      authorDistinctApproval: true,
      mergeConflict: false,
      ...overrides,
    });
    assert.equal(verdict.ready, false, `${reason} must block readiness`);
    assert.ok(verdict.reasons.includes(reason), `${reason} must be reported`);
  }

  const highRisk = evaluateMergeReadiness({
    gateGreen: true,
    currentHeadSha: HEAD_A,
    receipts,
    blockingFindings: 0,
    authorDistinctApproval: true,
    mergeConflict: false,
    risk: "high-risk",
  });
  assert.equal(highRisk.ready, false);
  assert.ok(highRisk.reasons.includes("insufficient_fresh_signed_pass:2/3"));
  assert.ok(highRisk.reasons.includes("insufficient_independent_reviewers:2/3"));
});

test("distinct-reviewer quorum: one reviewer with different receipt metadata has one vote (#1724)", () => {
  // Same declared node, different receiptId/producedAt/lane/team: fresh quorum
  // metadata must never mint a second reviewer vote.
  const projection = evaluateMergeReadiness({
    gateGreen: true,
    currentHeadSha: HEAD_A,
    authorDistinctApproval: true,
    receipts: [
      {
        receiptId: "r1",
        headSha: HEAD_A,
        verdict: "PASS",
        signed: true,
        reviewerNodeId: "seoseo",
        producedAt: "2026-08-06T09:00:00.000Z",
        lane: "content_clinical",
        team: "T1",
      },
      {
        receiptId: "r2",
        headSha: HEAD_A,
        verdict: "PASS",
        signed: true,
        reviewerNodeId: "seoseo",
        producedAt: "2026-08-06T09:05:00.000Z",
        lane: "evidence_adversarial",
        team: "cross-team",
      },
    ],
  });
  assert.equal(projection.ready, false);
  assert.equal(projection.freshPassCount, 2, "freshPassCount stays the raw qualifying PASS record count");
  assert.equal(projection.distinctReviewerCount, 1, "different receiptId/producedAt/lane/team never add a reviewer");
  assert.ok(projection.reasons.includes("insufficient_independent_reviewers:1/2"));
  assert.ok(
    !projection.reasons.some((reason) => reason.startsWith("insufficient_fresh_signed_pass")),
    "the raw count met its quorum; only the distinct count is short",
  );
});

test("distinct-reviewer quorum: trimmed duplicates collapse; comparison stays case-sensitive (#1724)", () => {
  const whitespaceDuplicate = evaluateMergeReadiness({
    gateGreen: true,
    currentHeadSha: HEAD_A,
    authorDistinctApproval: true,
    receipts: [
      { receiptId: "r1", headSha: HEAD_A, verdict: "PASS", signed: true, reviewerNodeId: "seoseo" },
      { receiptId: "r2", headSha: HEAD_A, verdict: "PASS", signed: true, reviewerNodeId: "  seoseo  " },
    ],
  });
  assert.equal(whitespaceDuplicate.distinctReviewerCount, 1, "whitespace variants are the same declared node");
  assert.equal(whitespaceDuplicate.ready, false);
  assert.ok(whitespaceDuplicate.reasons.includes("insufficient_independent_reviewers:1/2"));

  const caseDistinct = evaluateMergeReadiness({
    gateGreen: true,
    currentHeadSha: HEAD_A,
    authorDistinctApproval: true,
    receipts: [
      { receiptId: "r1", headSha: HEAD_A, verdict: "PASS", signed: true, reviewerNodeId: "seoseo" },
      { receiptId: "r2", headSha: HEAD_A, verdict: "PASS", signed: true, reviewerNodeId: "Seoseo" },
    ],
  });
  assert.equal(
    caseDistinct.distinctReviewerCount,
    2,
    "node IDs are case-sensitive; no unsourced alias normalization collapses them",
  );
  assert.equal(caseDistinct.ready, true);
});

test("distinct-reviewer quorum: missing or malformed identities never count and never fall back (#1724)", () => {
  const projection = evaluateMergeReadiness({
    gateGreen: true,
    currentHeadSha: HEAD_A,
    authorDistinctApproval: true,
    receipts: [
      { receiptId: "r1", headSha: HEAD_A, verdict: "PASS", signed: true },
      { receiptId: "r2", headSha: HEAD_A, verdict: "PASS", signed: true, reviewerNodeId: "" },
      { receiptId: "r3", headSha: HEAD_A, verdict: "PASS", signed: true, reviewerNodeId: "   " },
      { receiptId: "r4", headSha: HEAD_A, verdict: "PASS", signed: true, reviewerNodeId: 42 },
      { receiptId: "r5", headSha: HEAD_A, verdict: "PASS", signed: true, reviewerNodeId: null },
    ],
  });
  assert.equal(projection.freshPassCount, 5, "raw count is preserved; identity quality does not change it");
  assert.equal(
    projection.distinctReviewerCount,
    0,
    "missing/nonstring identities are not counted and not String-coerced; receiptId is no fallback",
  );
  assert.equal(projection.ready, false);
  assert.ok(projection.reasons.includes("insufficient_independent_reviewers:0/2"));
});

test("distinct-reviewer quorum: stale, unsigned and BLOCK receipts are not votes (#1724)", () => {
  const projection = evaluateMergeReadiness({
    gateGreen: true,
    currentHeadSha: HEAD_A,
    authorDistinctApproval: true,
    receipts: [
      { receiptId: "stale-1", headSha: HEAD_B, verdict: "PASS", signed: true, reviewerNodeId: "seoseo" },
      { receiptId: "unsigned-1", headSha: HEAD_A, verdict: "PASS", signed: false, reviewerNodeId: "nosuk" },
      { receiptId: "block-1", headSha: HEAD_A, verdict: "BLOCK", signed: true, reviewerNodeId: "yukson" },
    ],
  });
  assert.equal(projection.freshPassCount, 0);
  assert.equal(projection.distinctReviewerCount, 0);
  assert.equal(projection.staleReceiptCount, 1, "stale classification is preserved");
  assert.ok(projection.reasons.includes("insufficient_fresh_signed_pass:0/2"));
  assert.ok(projection.reasons.includes("insufficient_independent_reviewers:0/2"));
});

test("distinct-reviewer quorum: high-risk needs three distinct declared reviewers (#1724)", () => {
  const twoDistinct = [
    { receiptId: "r1", headSha: HEAD_A, verdict: "PASS", signed: true, reviewerNodeId: "seoseo" },
    { receiptId: "r2", headSha: HEAD_A, verdict: "PASS", signed: true, reviewerNodeId: "nosuk" },
  ];
  const short = evaluateMergeReadiness({
    gateGreen: true,
    currentHeadSha: HEAD_A,
    authorDistinctApproval: true,
    risk: "high-risk",
    receipts: twoDistinct,
  });
  assert.equal(short.ready, false);
  assert.equal(short.distinctReviewerCount, 2);
  assert.ok(short.reasons.includes("insufficient_independent_reviewers:2/3"));

  const met = evaluateMergeReadiness({
    gateGreen: true,
    currentHeadSha: HEAD_A,
    authorDistinctApproval: true,
    risk: "high-risk",
    receipts: [...twoDistinct, { receiptId: "r3", headSha: HEAD_A, verdict: "PASS", signed: true, reviewerNodeId: "yukson" }],
  });
  assert.equal(met.ready, true);
  assert.equal(met.freshPassCount, 3);
  assert.equal(met.distinctReviewerCount, 3);
  assert.ok(!met.reasons.some((reason) => reason.startsWith("insufficient_")));
});

test("distinct-reviewer quorum: a duplicate reviewer's blocking finding still vetoes (#1724)", () => {
  const projection = evaluateMergeReadiness({
    gateGreen: true,
    currentHeadSha: HEAD_A,
    authorDistinctApproval: true,
    receipts: [
      { receiptId: "r1", headSha: HEAD_A, verdict: "PASS", signed: true, reviewerNodeId: "seoseo" },
      { receiptId: "r2", headSha: HEAD_A, verdict: "PASS", signed: true, reviewerNodeId: "seoseo" },
    ],
    blockingFindings: 1,
  });
  assert.equal(projection.ready, false);
  assert.equal(projection.distinctReviewerCount, 1);
  assert.ok(projection.reasons.includes("blocking_findings:1"), "all fresh blocking findings still veto");
  assert.ok(projection.reasons.includes("insufficient_independent_reviewers:1/2"));
});

test("comment projection is the exact body-free contract line", () => {
  const line = formatEvaluationComment({
    nodeId: "seoseo",
    team: "T1",
    lane: "content_clinical",
    headSha: HEAD_A,
    verdict: "PASS",
    receiptId: "receipt-1",
  });
  assert.equal(
    line,
    `EVALUATION node=seoseo team=T1 lane=content_clinical head=${HEAD_A} verdict=PASS receipt=receipt-1`,
  );
  assert.throws(
    () => formatEvaluationComment({ nodeId: "seoseo", team: "T3", lane: "x", headSha: HEAD_A, verdict: "PASS", receiptId: "r" }),
    (e) => e.code === "comment_invalid",
  );
  assert.throws(
    () => formatEvaluationComment({ nodeId: "seoseo", team: "T1", lane: "x", headSha: HEAD_A, verdict: "MAYBE", receiptId: "r" }),
    (e) => e.code === "comment_invalid",
  );
});

// #1724 gap (b): the declared refsManifestSha256 is bound to the actual refs
// manifest value — RFC 8785 (JCS) canonical digest, lowercase 64-hex, the same
// sha256-over-canonical-JSON convention as signed receipt ids. The golden
// digest was computed independently (python hashlib over the hand-built JCS
// string) so a drift in the canonicalization convention is a visible break.
const REFS_MANIFEST = {
  schemaVersion: "nclex-refs-manifest.v1",
  entries: [
    { id: "pharm-01", url: "https://refs.example/pharm-01.pdf", license: "CC-BY-4.0", sha256: "a".repeat(64) },
    { id: "safe-02", url: "https://refs.example/safe-02.pdf", license: "CC-BY-4.0", sha256: "b".repeat(64) },
  ],
};
const REFS_MANIFEST_DIGEST = "77c653f124761888b63a3be5ebfd7511279a504f32b83b69d776bdb7a2cb350f";

test("refs manifest digest: golden digest pins JCS; key insertion order is free, array order is content", () => {
  assert.equal(refsManifestDigestSha256(REFS_MANIFEST), REFS_MANIFEST_DIGEST);

  // Key insertion order (top level and inside entries) cannot change the digest.
  const reordered = {
    entries: REFS_MANIFEST.entries.map(({ sha256, url, license, id }) => ({ url, license, id, sha256 })),
    schemaVersion: REFS_MANIFEST.schemaVersion,
  };
  assert.deepEqual(Object.keys(reordered), ["entries", "schemaVersion"], "the fixture really does reorder keys");
  assert.equal(refsManifestDigestSha256(reordered), REFS_MANIFEST_DIGEST, "key order must not change the digest");

  // Array order is content under JCS: reordered entries are a different manifest.
  const reversed = { ...REFS_MANIFEST, entries: [...REFS_MANIFEST.entries].reverse() };
  assert.notEqual(refsManifestDigestSha256(reversed), REFS_MANIFEST_DIGEST, "array reordering must change the digest");
});

test("verifyRefsManifest: matching declaration returns the validated input and the recomputed digest", () => {
  const verified = verifyRefsManifest({
    input: input({ refsManifestSha256: REFS_MANIFEST_DIGEST }),
    refsManifest: REFS_MANIFEST,
  });
  assert.equal(verified.refsManifestSha256, REFS_MANIFEST_DIGEST, "the actual digest is echoed");
  assert.equal(verified.input.headSha, HEAD_A, "the validated input is returned");
  assert.equal(verified.input.refsManifestSha256, REFS_MANIFEST_DIGEST);

  // The validated input chains straight into routing without re-validation.
  const routed = routeEvaluation({ input: verified.input, registry: REGISTRY });
  assert.equal(routed.reviewerTeam, "T1");
  assert.equal(routed.lanes.length, 2);
});

test("verifyRefsManifest: declared digest mismatch fails closed as refs_manifest_invalid", () => {
  const cases = [
    ["declaration does not describe the manifest", REFS_MANIFEST, MANIFEST],
    ["manifest is not the one declared", { ...REFS_MANIFEST, entries: [...REFS_MANIFEST.entries].reverse() }, REFS_MANIFEST_DIGEST],
  ];
  for (const [label, badManifest, declared] of cases) {
    try {
      verifyRefsManifest({ input: input({ refsManifestSha256: declared }), refsManifest: badManifest });
      assert.fail(label + ": must throw");
    } catch (error) {
      assert.ok(error instanceof NclexPresetError, label);
      assert.equal(error.code, "refs_manifest_invalid", label);
      assert.equal(error.details.declared, declared.toLowerCase());
      assert.ok(/^[0-9a-f]{64}$/.test(error.details.actual), "the actual digest is reported");
      assert.notEqual(error.details.actual, error.details.declared, label);
    }
  }
});

test("verifyRefsManifest: non-manifest values and non-canonicalizable content fail closed", () => {
  const cases = [
    ["a JSON string is a value, not a manifest", '{"entries":[]}'],
    ["a number is not a manifest", 42],
    ["null is not a manifest", null],
    ["a boolean is not a manifest", true],
    ["a BigInt member is not RFC 8785 canonicalizable", { schemaVersion: 1n }],
    ["a non-finite number is not RFC 8785 canonicalizable", { ratio: Number.NaN }],
  ];
  for (const [label, bad] of cases) {
    assert.throws(
      () => verifyRefsManifest({ input: input(), refsManifest: bad }),
      (e) => e instanceof NclexPresetError && e.code === "refs_manifest_invalid",
      label,
    );
  }
});

test("verifyRefsManifest: input re-validation runs first and never trusts a matching manifest", () => {
  assert.throws(
    () => verifyRefsManifest({ input: input({ headSha: "zzz" }), refsManifest: REFS_MANIFEST }),
    (e) => e.code === "input_invalid",
  );
  const { authorNodeId, ...rest } = input();
  assert.throws(
    () => verifyRefsManifest({ input: rest, refsManifest: REFS_MANIFEST }),
    (e) => e.code === "input_missing_fields",
  );
  assert.throws(
    () => verifyRefsManifest({ input: input({ refsManifestSha256: "short" }), refsManifest: REFS_MANIFEST }),
    (e) => e.code === "refs_manifest_invalid",
    "a perfect manifest never rehabilitates a malformed declaration",
  );
});
