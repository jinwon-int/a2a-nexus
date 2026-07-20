/**
 * Bounded PR review lifecycle — record-mode types (#1518 Phase 3a).
 *
 * Mirrors the JSON schemas in docs/specs/bounded-pr-review-lifecycle/schemas/
 * (Phase 1, #1583). This module is a pure engine: it records lineage state,
 * budget counters, and finding ledgers, and NEVER blocks the broker
 * completion path. Enforce mode (Phase 4+) consumes the same transitions.
 */

export const REVIEW_LINEAGE_KIND = "a2a.review-lineage.v1" as const;

export type ReviewLineageState =
  | "reviewing_initial"
  | "correction_pending"
  | "reviewing_resolution"
  | "passed"
  | "blocked_needs_operator"
  | "intent_conflict"
  | "canceled";

export const TERMINAL_LINEAGE_STATES: ReadonlySet<ReviewLineageState> = new Set([
  "passed",
  "blocked_needs_operator",
  "intent_conflict",
  "canceled",
]);

export type TerminalStopReason =
  | "budget_wall_clock"
  | "budget_correction_generations"
  | "budget_reviewer_runs"
  | "repeated_findings"
  | "intent_drift"
  | "scope_drift"
  | "operator_cancel";

export interface AcceptanceCriterion {
  id: string;
  text: string;
}

export interface DeclaredPaths {
  allowed: string[];
  forbidden?: string[];
}

export interface IntentContractV1 {
  kind: "IntentContractV1";
  lineageId: string;
  goal: string;
  nonGoals: string[];
  invariants: string[];
  acceptanceCriteria: AcceptanceCriterion[];
  declaredPaths: DeclaredPaths;
  baseSha: string;
  headSha: string;
  createdAt: string;
  intentHash: string;
}

export interface ReviewLineageBudgetV1 {
  kind: "ReviewLineageBudgetV1";
  maxWallClockSeconds: number;
  maxCorrectionGenerations: number;
  maxReviewerRuns: number;
  maxReviewerReplacements: number;
  repeatedFindingThreshold: number;
  onExhaustion: "blocked_needs_operator";
}

export const DEFAULT_LINEAGE_BUDGET: ReviewLineageBudgetV1 = {
  kind: "ReviewLineageBudgetV1",
  maxWallClockSeconds: 21600,
  maxCorrectionGenerations: 1,
  maxReviewerRuns: 2,
  maxReviewerReplacements: 1,
  repeatedFindingThreshold: 2,
  onExhaustion: "blocked_needs_operator",
};

export type FindingSeverity = "critical" | "major" | "minor";
export type FindingCategory =
  | "correctness"
  | "security"
  | "regression"
  | "spec_ambiguity"
  | "scope_drift"
  | "style"
  | "preference"
  | "design"
  | "other";
export type FindingDisposition = "open" | "resolved" | "reopened" | "overruled_by_finalizer";

/** Categories that can never block (spec.md blocking rule / clarify Q3). */
export const NON_BLOCKING_CATEGORIES: ReadonlySet<FindingCategory> = new Set(["style", "preference", "design"]);

export interface FindingV1 {
  findingId: string;
  criterionRef: string;
  evidenceRefs: string[];
  severity: FindingSeverity;
  category: FindingCategory;
  blocking: boolean;
  introducedAtHead: string;
  firstSeenAtHead: string;
  resolvedAtHead: string | null;
  disposition: FindingDisposition;
  signature: string;
}

export interface FindingLedgerV1 {
  kind: "FindingLedgerV1";
  ledgerId: string;
  lineageId: string;
  findings: FindingV1[];
}

export interface ReviewReceiptV1 {
  kind: "ReviewReceiptV1";
  reviewerNodeId: string;
  verdict: "pass" | "fail";
  note: string;
  headSha: string;
  diffHash: string;
  intentHash: string;
  findingLedgerRef: string;
  authorWorkerId?: string;
  submittedAt?: string;
}

/** Justification required for a NEW blocking finding in a resolution review (spec: no moving goalposts). */
export interface NewFindingJustification {
  kind: "introduced_regression" | "critical_security" | "unavailable_evidence";
  detail: string;
}

export interface ReviewLineageCounters {
  correctionGenerations: number;
  reviewerRuns: number;
  reviewerReplacements: number;
  findingsNew: number;
  findingsReopened: number;
  findingsResolved: number;
  repeatedSignatureHits: number;
  goalpostRejections: number;
  scopeDriftRejections: number;
}

export type ReviewLineageMode = "off" | "record" | "enforce";

export interface ReviewLineageRecord {
  kind: typeof REVIEW_LINEAGE_KIND;
  lineageId: string;
  mode: ReviewLineageMode;
  state: ReviewLineageState;
  contract: IntentContractV1;
  budget: ReviewLineageBudgetV1;
  ledger: FindingLedgerV1;
  counters: ReviewLineageCounters;
  /** Head of the latest accepted correction generation; equals contract.headSha initially. */
  currentHeadSha: string;
  /** Canonical diffHash of the current head; null until supplied (creation option / first accepted correction). */
  currentDiffHash: string | null;
  startedAt: string;
  updatedAt: string;
  terminalReason: TerminalStopReason | null;
  /** Signatures of currently-unresolved findings with consecutive unresolved counts. */
  unresolvedSignatures: Record<string, number>;
}

/** Engine input events. All timestamps ISO-8601; engine is pure. */
export type ReviewLineageEvent =
  | {
      type: "review_report";
      at: string;
      receipt: ReviewReceiptV1;
      /** Existing finding ids marked resolved at receipt.headSha. */
      resolvedFindingIds?: string[];
      /** Existing finding ids reopened with evidence. */
      reopenedFindingIds?: string[];
      /** New findings raised by this review run. */
      newFindings?: Array<FindingV1 & { justification?: NewFindingJustification }>;
    }
  | {
      type: "correction_generation";
      at: string;
      headSha: string;
      diffHash: string;
      intentHash: string;
      /** Repository paths touched by this correction candidate. */
      pathsChanged: string[];
    }
  | {
      type: "reviewer_replacement";
      at: string;
      reason: "infrastructure_failure" | "other";
      detail?: string;
    }
  | { type: "operator_cancel"; at: string; detail?: string };

export interface LineageMetrics {
  elapsedSeconds: number;
  correctionGenerations: number;
  reviewerRuns: number;
  reviewerReplacements: number;
  findingsNew: number;
  findingsReopened: number;
  findingsResolved: number;
  repeatedSignatureHits: number;
  goalpostRejections: number;
  scopeDriftRejections: number;
  openBlockingFindings: number;
  terminalReason: TerminalStopReason | null;
}
