/**
 * Merge-ready projection for NCLEX content PRs (#1724).
 *
 * Pure read model over stored receipts plus operator-supplied GitHub facts
 * (gate status, author-distinct approval, merge conflict). Mirrors the
 * offline preset semantics exactly: quorum 2 (normal) / 3 (high-risk), only
 * fresh exact-head signed PASS receipts count, stale receipts are reported
 * separately, blocking findings veto.
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
  staleReceiptCount: number;
  blockingFindings: number;
  reasons: string[];
}

const QUORUM = { normal: 2, "high-risk": 3 } as const;

export function projectMergeReady(records: NclexReceiptRecord[], input: MergeReadyInput): MergeReadyProjection {
  const quorum = QUORUM[input.risk];
  const head = input.currentHeadSha.toLowerCase();
  const fresh = records.filter((record) => record.receipt.headSha === head);
  const stale = records.filter((record) => record.receipt.headSha !== head);
  const freshPasses = fresh.filter((record) => record.receipt.verdict === "PASS");
  const blockingFindings = fresh.reduce(
    (count, record) => count + record.receipt.findings.filter((finding) => finding.blocking).length,
    0,
  );

  const reasons: string[] = [];
  if (input.gateGreen !== true) reasons.push("github_gate_not_green");
  if (freshPasses.length < quorum) reasons.push(`insufficient_fresh_signed_pass:${freshPasses.length}/${quorum}`);
  if (stale.length > 0) reasons.push(`stale_receipts_excluded:${stale.length}`);
  if (blockingFindings > 0) reasons.push(`blocking_findings:${blockingFindings}`);
  if (input.authorDistinctApproval !== true) reasons.push("author_distinct_approval_missing");
  if (input.mergeConflict === true) reasons.push("merge_conflict_present");

  return {
    ready: reasons.length === 0,
    quorum,
    freshPassCount: freshPasses.length,
    staleReceiptCount: stale.length,
    blockingFindings,
    reasons,
  };
}
