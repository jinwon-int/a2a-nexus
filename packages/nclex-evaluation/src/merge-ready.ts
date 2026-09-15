/**
 * Merge-ready projection for NCLEX content PRs (#1724).
 *
 * Pure read model over stored receipts plus operator-supplied GitHub facts
 * (gate status, author-distinct approval, merge conflict). Mirrors the
 * offline preset semantics exactly: quorum 2 (normal) / 3 (high-risk), only
 * fresh exact-head signed PASS receipts count, stale receipts are reported
 * separately, blocking findings veto.
 *
 * #1724 distinct-reviewer quorum: on top of the raw `freshPassCount`, an
 * additive `distinctReviewerCount` counts the distinct declared reviewer node
 * IDs among the qualifying receipts, and `insufficient_independent_reviewers`
 * fails closed when that count is below quorum. A vote is one declared node
 * ID: different receiptId/producedAt/lane/team on the same `reviewerNodeId`
 * never mint a second reviewer.
 */
import type { NclexReceiptRecord } from "./receipt-store.js";

export interface MergeReadyInput {
  currentHeadSha: string;
  risk: "normal" | "high-risk";
  gateGreen: boolean;
  authorDistinctApproval: boolean;
  mergeConflict: boolean;
}

export interface MergeReadyProjection {
  ready: boolean;
  quorum: number;
  freshPassCount: number;
  /** Distinct declared reviewer node IDs among qualifying fresh PASS receipts (#1724). */
  distinctReviewerCount: number;
  staleReceiptCount: number;
  blockingFindings: number;
  reasons: string[];
}

const QUORUM = { normal: 2, "high-risk": 3 } as const;

/**
 * Distinct declared reviewer node IDs (#1724). Only a nonblank string
 * `reviewerNodeId` counts, after `trim()`; comparison is case-sensitive with
 * no unsourced alias normalization. Missing or malformed identities are never
 * String-coerced into a vote, and receiptId, keyId, team or lane are never
 * used as a fallback. Runtime records were already identity-verified at
 * admission; the string guard keeps malformed snapshot-restored rows from
 * being counted rather than thrown on.
 */
function distinctReviewerNodeIdCount(records: NclexReceiptRecord[]): number {
  const ids = new Set<string>();
  for (const record of records) {
    const reviewerNodeId: unknown = record.receipt.reviewerNodeId;
    if (typeof reviewerNodeId === "string" && reviewerNodeId.trim() !== "") {
      ids.add(reviewerNodeId.trim());
    }
  }
  return ids.size;
}

export function projectMergeReady(records: NclexReceiptRecord[], input: MergeReadyInput): MergeReadyProjection {
  const quorum = QUORUM[input.risk];
  const head = input.currentHeadSha.toLowerCase();
  const fresh = records.filter((record) => record.receipt.headSha === head);
  const stale = records.filter((record) => record.receipt.headSha !== head);
  const freshPasses = fresh.filter((record) => record.receipt.verdict === "PASS");
  const distinctReviewerCount = distinctReviewerNodeIdCount(freshPasses);
  const blockingFindings = fresh.reduce(
    (count, record) => count + record.receipt.findings.filter((finding) => finding.blocking).length,
    0,
  );

  const reasons: string[] = [];
  if (input.gateGreen !== true) reasons.push("github_gate_not_green");
  if (freshPasses.length < quorum) reasons.push(`insufficient_fresh_signed_pass:${freshPasses.length}/${quorum}`);
  // #1724 additive distinct-reviewer quorum: `freshPassCount` above stays the
  // raw qualifying PASS record count; this separate reason fails closed when
  // the distinct declared reviewer node IDs among them are below quorum.
  if (distinctReviewerCount < quorum) {
    reasons.push(`insufficient_independent_reviewers:${distinctReviewerCount}/${quorum}`);
  }
  // Stale receipts (for a previous head) are excluded from the vote and reported
  // via staleReceiptCount — they are NOT a merge-ready veto. The spec lists only
  // gate-green, same-head signed PASS >= quorum, zero blocking findings,
  // author-distinct approval, and no conflict as conditions. Treating a stale
  // count as a blocking reason deadlocked any PR that earned a receipt and was
  // then pushed to, because receipts are never pruned (BUG-08).
  if (blockingFindings > 0) reasons.push(`blocking_findings:${blockingFindings}`);
  if (input.authorDistinctApproval !== true) reasons.push("author_distinct_approval_missing");
  if (input.mergeConflict === true) reasons.push("merge_conflict_present");

  return {
    ready: reasons.length === 0,
    quorum,
    freshPassCount: freshPasses.length,
    distinctReviewerCount,
    staleReceiptCount: stale.length,
    blockingFindings,
    reasons,
  };
}
