#!/usr/bin/env node
/**
 * Deterministic contract tests for the nclex_content_pr_v1 preset (#1724).
 * No network, no provider, no broker: routing, readiness, and projection are
 * pure functions pinned by golden cases plus fail-closed fixtures (self
 * review, head drift, manifest mismatch, malformed input).
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  NCLEX_CONTENT_PR_PRESET_V1,
  NclexPresetError,
  classifyReceipts,
  evaluateMergeReadiness,
  formatEvaluationComment,
  routeEvaluation,
  validatePresetInput,
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
  const receipts = [
    { receiptId: "r1", headSha: HEAD_A, verdict: "PASS", signed: true },
    { receiptId: "r2", headSha: HEAD_A, verdict: "PASS", signed: true },
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

  // Stale (previous-head) receipts are excluded from the vote and reported via
  // staleReceiptCount, but must NOT veto readiness when quorum is otherwise met
  // (BUG-08); a stale-count veto deadlocked re-reviewed PRs since receipts are
  // never pruned.
  const withStale = evaluateMergeReadiness({
    gateGreen: true,
    currentHeadSha: HEAD_A,
    receipts: [...receipts, { receiptId: "r-stale", headSha: HEAD_B, verdict: "PASS", signed: true }],
    blockingFindings: 0,
    authorDistinctApproval: true,
    mergeConflict: false,
  });
  assert.equal(withStale.ready, true, "stale receipts must not veto a PR that meets quorum");
  assert.equal(withStale.staleReceiptCount, 1);
  assert.ok(!withStale.reasons.includes("stale_receipts_excluded:1"), "stale receipts must not be a blocking reason");

  const cases = [
    [{ gateGreen: false }, "github_gate_not_green"],
    [{ receipts: receipts.slice(1) }, "insufficient_fresh_signed_pass:1/2"],
    [{ blockingFindings: 1 }, "blocking_findings:1"],
    [{ authorDistinctApproval: false }, "author_distinct_approval_missing"],
    [{ mergeConflict: true }, "merge_conflict_present"],
    [
      { receipts: [{ receiptId: "r4", headSha: HEAD_A, verdict: "PASS", signed: false }, ...receipts.slice(1)] },
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
