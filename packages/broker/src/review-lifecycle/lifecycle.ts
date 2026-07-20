/**
 * Bounded PR review lifecycle — record-mode engine (#1518 Phase 3a).
 *
 * Pure functions: no I/O, no broker mutation, no completion-path authority.
 * The engine records lineage state, budget counters, and the finding ledger;
 * Phase 4+ enforce mode consumes the same transitions to actually stop work.
 *
 * Invariants implemented (docs/specs/bounded-pr-review-lifecycle/spec.md):
 * - Frozen intent is the oracle: receipts/corrections bound to a different
 *   intentHash are rejected (receipt) or transition to intent_conflict
 *   (correction).
 * - One global budget per lineage: wall clock, correction generations,
 *   reviewer runs, reviewer replacements (infra failure only, never resets),
 *   repeated-finding early stop. Exhaustion is terminal
 *   (blocked_needs_operator), never running, never auto-retry.
 * - Resolution review is a resolution check: NEW blocking findings require an
 *   explicit introduced-regression / critical-security / unavailable-evidence
 *   justification, else they are rejected as goalpost moves.
 * - Style/preference/design findings are normalized to non-blocking.
 * - Corrections outside declared paths are rejected as scope drift and never
 *   counted; the original author head stays recoverable.
 */

import { intentHash } from "./canonical-json.js";
import {
  DEFAULT_LINEAGE_BUDGET,
  NON_BLOCKING_CATEGORIES,
  TERMINAL_LINEAGE_STATES,
  REVIEW_LINEAGE_KIND,
  type FindingV1,
  type IntentContractV1,
  type LineageMetrics,
  type NewFindingJustification,
  type ReviewLineageBudgetV1,
  type ReviewLineageEvent,
  type ReviewLineageRecord,
  type ReviewLineageState,
  type TerminalStopReason,
} from "./types.js";

export interface CreateLineageInput {
  contract: IntentContractV1;
  budget?: ReviewLineageBudgetV1;
  at: string;
  mode?: ReviewLineageRecord["mode"];
  /** Canonical diffHash of the original head, when the dispatcher already computed it. */
  diffHash?: string;
}

export interface AppliedEvent {
  record: ReviewLineageRecord;
  effects: string[];
}

function secondsBetween(from: string, to: string): number {
  return Math.max(0, Math.floor((Date.parse(to) - Date.parse(from)) / 1000));
}

/** Path matcher: exact match or trailing `dir/**` prefix (documented subset). */
export function pathMatchesPattern(pattern: string, path: string): boolean {
  if (pattern.endsWith("/**")) {
    const dir = pattern.slice(0, -3);
    return path === dir || path.startsWith(dir + "/");
  }
  return path === pattern;
}

/** Paths that can never be validated textually (traversal) are always rejected. */
function hasTraversalSegment(path: string): boolean {
  return path.split("/").includes("..");
}

export function classifyPaths(contract: IntentContractV1, paths: string[]): { forbidden: string[]; outside: string[] } {
  const forbiddenPatterns = contract.declaredPaths.forbidden ?? [];
  const forbidden = paths.filter((p) => !hasTraversalSegment(p) && forbiddenPatterns.some((pattern) => pathMatchesPattern(pattern, p)));
  const outside = paths.filter(
    (p) =>
      !forbidden.includes(p) &&
      (hasTraversalSegment(p) || !contract.declaredPaths.allowed.some((pattern) => pathMatchesPattern(pattern, p))),
  );
  return { forbidden, outside };
}

function openBlockingFindings(record: ReviewLineageRecord): FindingV1[] {
  return record.ledger.findings.filter(
    (finding) => finding.blocking && (finding.disposition === "open" || finding.disposition === "reopened"),
  );
}

function transition(record: ReviewLineageRecord, state: ReviewLineageState, at: string, terminalReason: TerminalStopReason | null): ReviewLineageRecord {
  return { ...record, state, terminalReason, updatedAt: at };
}

function withCounters(record: ReviewLineageRecord, patch: Partial<ReviewLineageRecord["counters"]>): ReviewLineageRecord {
  return { ...record, counters: { ...record.counters, ...patch } };
}

export function createLineage(input: CreateLineageInput): ReviewLineageRecord {
  const { contract } = input;
  const recomputed = intentHash(contract as unknown as Record<string, unknown>);
  if (recomputed !== contract.intentHash) {
    throw new Error(`intent contract hash mismatch: declared ${contract.intentHash} !== recomputed ${recomputed}`);
  }
  return {
    kind: REVIEW_LINEAGE_KIND,
    lineageId: contract.lineageId,
    mode: input.mode ?? "record",
    state: "reviewing_initial",
    contract,
    budget: input.budget ?? DEFAULT_LINEAGE_BUDGET,
    ledger: {
      kind: "FindingLedgerV1",
      ledgerId: `ledger-${contract.lineageId}`,
      lineageId: contract.lineageId,
      findings: [],
    },
    counters: {
      correctionGenerations: 0,
      reviewerRuns: 0,
      reviewerReplacements: 0,
      findingsNew: 0,
      findingsReopened: 0,
      findingsResolved: 0,
      repeatedSignatureHits: 0,
      goalpostRejections: 0,
      scopeDriftRejections: 0,
    },
    currentHeadSha: contract.headSha,
    currentDiffHash: input.diffHash ?? null,
    startedAt: input.at,
    updatedAt: input.at,
    terminalReason: null,
    unresolvedSignatures: {},
  };
}

function checkWallClock(record: ReviewLineageRecord, at: string): ReviewLineageRecord | null {
  if (TERMINAL_LINEAGE_STATES.has(record.state)) return null;
  if (secondsBetween(record.startedAt, at) > record.budget.maxWallClockSeconds) {
    return transition(record, "blocked_needs_operator", at, "budget_wall_clock");
  }
  return null;
}

function newBlockingFindingEligible(
  record: ReviewLineageRecord,
  finding: FindingV1,
  justification: NewFindingJustification | undefined,
): { eligible: boolean; via?: string } {
  if (record.state === "reviewing_initial") return { eligible: true, via: "initial_review" };
  if (!justification) return { eligible: false };
  switch (justification.kind) {
    case "introduced_regression":
      // The defect must have been introduced by the correction generation, not the original head.
      if (
        record.currentHeadSha !== record.contract.headSha &&
        finding.introducedAtHead === record.currentHeadSha &&
        justification.detail.trim() !== ""
      ) {
        return { eligible: true, via: "introduced_regression" };
      }
      return { eligible: false };
    case "critical_security":
      return finding.severity === "critical" && finding.category === "security" && justification.detail.trim() !== ""
        ? { eligible: true, via: "critical_security" }
        : { eligible: false };
    case "unavailable_evidence":
      return justification.detail.trim() !== "" ? { eligible: true, via: "unavailable_evidence" } : { eligible: false };
    default:
      return { eligible: false };
  }
}

function applyReviewReport(record: ReviewLineageRecord, event: Extract<ReviewLineageEvent, { type: "review_report" }>): AppliedEvent {
  const effects: string[] = [];
  let next = record;

  // Review reports are only meaningful inside an active review state (spec
  // transition table): correction_pending has no review-report edge.
  if (next.state !== "reviewing_initial" && next.state !== "reviewing_resolution") {
    return { record: next, effects: [`report_out_of_state:${next.state}`] };
  }

  const receipt = event.receipt;
  if (receipt.intentHash !== next.contract.intentHash) {
    return { record: next, effects: [`receipt_rejected:intent_hash_mismatch:${receipt.reviewerNodeId}`] };
  }
  if (receipt.findingLedgerRef !== next.ledger.ledgerId) {
    return { record: next, effects: [`receipt_rejected:ledger_ref_mismatch:${receipt.reviewerNodeId}`] };
  }
  // Exact-subject binding (spec): the receipt must cover the current head/diff.
  // A receipt for a stale or foreign tree fails closed with no state change.
  if (receipt.headSha !== next.currentHeadSha) {
    return { record: next, effects: [`receipt_rejected:head_sha_mismatch:${receipt.reviewerNodeId}`] };
  }
  if (next.currentDiffHash !== null && receipt.diffHash !== next.currentDiffHash) {
    return { record: next, effects: [`receipt_rejected:diff_hash_mismatch:${receipt.reviewerNodeId}`] };
  }

  next = withCounters(next, { reviewerRuns: next.counters.reviewerRuns + 1 });
  if (next.counters.reviewerRuns > next.budget.maxReviewerRuns) {
    return {
      record: transition(next, "blocked_needs_operator", event.at, "budget_reviewer_runs"),
      effects: [...effects, "budget_exhausted:reviewer_runs"],
    };
  }

  const resolvedIds = new Set(event.resolvedFindingIds ?? []);
  const reopenedIds = new Set(event.reopenedFindingIds ?? []);
  let findingsResolved = 0;
  let findingsReopened = 0;
  const unresolvedSignatures = { ...next.unresolvedSignatures };
  const findings = next.ledger.findings.map((finding) => {
    if (resolvedIds.has(finding.findingId) && (finding.disposition === "open" || finding.disposition === "reopened")) {
      findingsResolved += 1;
      delete unresolvedSignatures[finding.signature];
      return { ...finding, disposition: "resolved" as const, resolvedAtHead: receipt.headSha };
    }
    if (reopenedIds.has(finding.findingId) && finding.disposition === "resolved") {
      findingsReopened += 1;
      return { ...finding, disposition: "reopened" as const, resolvedAtHead: null };
    }
    return finding;
  });

  const addedFindings: FindingV1[] = [];
  let goalpostRejections = 0;
  let findingsNew = 0;
  const seenIds = new Set(findings.map((f) => f.findingId));
  for (const candidate of event.newFindings ?? []) {
    const { justification, ...finding } = candidate;
    let normalized = finding;
    if (finding.blocking && NON_BLOCKING_CATEGORIES.has(finding.category)) {
      normalized = { ...finding, blocking: false };
      effects.push(`nonblocking_category_normalized:${finding.findingId}`);
    }
    if (normalized.blocking) {
      const { eligible, via } = newBlockingFindingEligible(next, normalized, justification);
      if (!eligible) {
        goalpostRejections += 1;
        effects.push(`goalpost_rejected:${finding.findingId}`);
        continue;
      }
      if (via && via !== "initial_review") effects.push(`new_blocker_admitted:${finding.findingId}:${via}`);
    }
    if (seenIds.has(normalized.findingId)) {
      effects.push(`duplicate_finding_id_ignored:${normalized.findingId}`);
      continue;
    }
    seenIds.add(normalized.findingId);
    findingsNew += 1;
    addedFindings.push(normalized);
  }

  next = withCounters(next, {
    findingsResolved: next.counters.findingsResolved + findingsResolved,
    findingsReopened: next.counters.findingsReopened + findingsReopened,
    findingsNew: next.counters.findingsNew + findingsNew,
    goalpostRejections: next.counters.goalpostRejections + goalpostRejections,
  });
  next = { ...next, ledger: { ...next.ledger, findings: [...findings, ...addedFindings] }, unresolvedSignatures };

  // Repeated identical unresolved signature early stop. One increment per
  // signature per review run: two findings sharing a signature must not
  // double-count within a single run.
  let repeatedStop = false;
  const openSignatures = new Set(openBlockingFindings(next).map((finding) => finding.signature));
  for (const signature of openSignatures) {
    const count = (next.unresolvedSignatures[signature] ?? 0) + 1;
    next.unresolvedSignatures[signature] = count;
    if (count >= next.budget.repeatedFindingThreshold) {
      repeatedStop = true;
      const findingId = openBlockingFindings(next).find((finding) => finding.signature === signature)?.findingId ?? signature;
      effects.push(`repeated_signature_stop:${findingId}`);
    }
  }
  if (repeatedStop) {
    next = withCounters(next, { repeatedSignatureHits: next.counters.repeatedSignatureHits + 1 });
    return {
      record: transition(next, "blocked_needs_operator", event.at, "repeated_findings"),
      effects,
    };
  }

  const openBlocking = openBlockingFindings(next);
  if (openBlocking.length === 0 && receipt.verdict === "pass") {
    return { record: transition(next, "passed", event.at, null), effects: [...effects, "lineage_passed"] };
  }
  if (openBlocking.length === 0) {
    // No open blockers but the reviewer verdict is fail: require an explicit pass, stay in review.
    return { record: transition(next, record.state, event.at, null), effects: [...effects, "verdict_fail_without_open_findings"] };
  }
  if (next.counters.correctionGenerations >= next.budget.maxCorrectionGenerations) {
    return {
      record: transition(next, "blocked_needs_operator", event.at, "budget_correction_generations"),
      effects: [...effects, "budget_exhausted:correction_generations"],
    };
  }
  return { record: transition(next, "correction_pending", event.at, null), effects: [...effects, "correction_pending"] };
}

function applyCorrectionGeneration(record: ReviewLineageRecord, event: Extract<ReviewLineageEvent, { type: "correction_generation" }>): AppliedEvent {
  if (record.state !== "correction_pending") {
    return { record, effects: [`generation_out_of_state:${record.state}`] };
  }
  if (event.intentHash !== record.contract.intentHash) {
    return {
      record: transition(record, "intent_conflict", event.at, "intent_drift"),
      effects: ["intent_conflict:correction_changed_frozen_intent"],
    };
  }
  const { forbidden, outside } = classifyPaths(record.contract, event.pathsChanged);
  if (forbidden.length > 0) {
    return {
      record: withCounters(record, { scopeDriftRejections: record.counters.scopeDriftRejections + 1 }),
      effects: [`forbidden_path_rejected:${forbidden.join(",")}`],
    };
  }
  if (outside.length > 0) {
    return {
      record: withCounters(record, { scopeDriftRejections: record.counters.scopeDriftRejections + 1 }),
      effects: [`scope_drift_rejected:${outside.join(",")}`],
    };
  }
  const next = withCounters(record, { correctionGenerations: record.counters.correctionGenerations + 1 });
  return {
    record: transition({ ...next, currentHeadSha: event.headSha, currentDiffHash: event.diffHash }, "reviewing_resolution", event.at, null),
    effects: ["generation_accepted"],
  };
}

export function applyEvent(record: ReviewLineageRecord, event: ReviewLineageEvent): AppliedEvent {
  if (TERMINAL_LINEAGE_STATES.has(record.state)) {
    return { record, effects: [`ignored_terminal:${record.state}`] };
  }
  if (event.type === "operator_cancel") {
    return {
      record: transition(record, "canceled", event.at, "operator_cancel"),
      effects: ["operator_canceled"],
    };
  }
  const exhausted = checkWallClock(record, event.at);
  if (exhausted) {
    return { record: exhausted, effects: ["budget_exhausted:wall_clock"] };
  }
  switch (event.type) {
    case "review_report":
      return applyReviewReport(record, event);
    case "correction_generation":
      return applyCorrectionGeneration(record, event);
    case "reviewer_replacement": {
      if (event.reason !== "infrastructure_failure") {
        return { record, effects: [`replacement_rejected:${event.reason}`] };
      }
      const next = withCounters(record, { reviewerReplacements: record.counters.reviewerReplacements + 1 });
      if (next.counters.reviewerReplacements > next.budget.maxReviewerReplacements) {
        return {
          record: transition(next, "blocked_needs_operator", event.at, "budget_reviewer_runs"),
          effects: ["budget_exhausted:reviewer_replacements"],
        };
      }
      // A classified replacement never resets the lineage budget (spec).
      return { record: { ...next, updatedAt: event.at }, effects: ["reviewer_replaced:infrastructure_failure"] };
    }
    default: {
      const neverEvent: never = event;
      return { record, effects: [`unknown_event:${String((neverEvent as { type?: string }).type)}`] };
    }
  }
}

export function computeMetrics(record: ReviewLineageRecord, now: string): LineageMetrics {
  return {
    elapsedSeconds: secondsBetween(record.startedAt, now),
    correctionGenerations: record.counters.correctionGenerations,
    reviewerRuns: record.counters.reviewerRuns,
    reviewerReplacements: record.counters.reviewerReplacements,
    findingsNew: record.counters.findingsNew,
    findingsReopened: record.counters.findingsReopened,
    findingsResolved: record.counters.findingsResolved,
    repeatedSignatureHits: record.counters.repeatedSignatureHits,
    goalpostRejections: record.counters.goalpostRejections,
    scopeDriftRejections: record.counters.scopeDriftRejections,
    openBlockingFindings: openBlockingFindings(record).length,
    terminalReason: record.terminalReason,
  };
}

export { openBlockingFindings };
