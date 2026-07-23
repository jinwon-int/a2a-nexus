/**
 * Pure enforcement decision for the bounded PR review lifecycle (#1518 Phase 4).
 *
 * This module has no broker, task-completion, retry, persistence, or finalizer
 * dependency. Phase 4 consumes it only from conformance fixtures. Runtime
 * rollout continues to accept off/record only until later contract-first work
 * supplies lossless review events and an independently reviewed call site.
 */

import {
  TERMINAL_LINEAGE_STATES,
  type ReviewLineageMode,
  type ReviewLineageState,
  type TerminalStopReason,
} from "./types.js";

export const REVIEW_LINEAGE_ENFORCEMENT_DECISION_KIND =
  "a2a.review-lineage.enforcement-decision.v1" as const;

export interface ReviewLineageEnforcementInput {
  mode: ReviewLineageMode;
  state: ReviewLineageState;
  terminalReason: TerminalStopReason | null;
}

export type ReviewLineageEnforcementOutcome =
  | "not_enforced"
  | "review_pending"
  | "completion_allowed"
  | "blocked_needs_operator"
  | "intent_conflict"
  | "canceled"
  | "invalid_state";

export type ReviewLineageCompletionDisposition =
  | "unchanged"
  | "pending"
  | "allow"
  | "block";

export type ReviewLineageRetryDisposition =
  | "unchanged"
  | "not_applicable"
  | "forbidden";

export type ReviewLineageEnforcementReason =
  | TerminalStopReason
  | "mode_not_enforced"
  | "lineage_active"
  | "lineage_passed"
  | "invalid_state";

export interface ReviewLineageEnforcementDecision {
  kind: typeof REVIEW_LINEAGE_ENFORCEMENT_DECISION_KIND;
  mode: ReviewLineageMode;
  state: ReviewLineageState;
  terminalReason: TerminalStopReason | null;
  outcome: ReviewLineageEnforcementOutcome;
  completionDisposition: ReviewLineageCompletionDisposition;
  retryDisposition: ReviewLineageRetryDisposition;
  terminal: boolean;
  /** null means the current off/record behavior is intentionally unchanged. */
  requiresOperator: boolean | null;
  reason: ReviewLineageEnforcementReason;
}

function terminalReasonMatchesState(
  state: ReviewLineageState,
  terminalReason: TerminalStopReason | null,
): boolean {
  switch (state) {
    case "reviewing_initial":
    case "correction_pending":
    case "reviewing_resolution":
    case "passed":
      return terminalReason === null;
    case "blocked_needs_operator":
      return terminalReason !== null
        && terminalReason !== "intent_drift"
        && terminalReason !== "operator_cancel";
    case "intent_conflict":
      return terminalReason === "intent_drift";
    case "canceled":
      return terminalReason === "operator_cancel";
    default: {
      const neverState: never = state;
      return neverState;
    }
  }
}

export function evaluateReviewLineageEnforcement(
  input: ReviewLineageEnforcementInput,
): ReviewLineageEnforcementDecision {
  const base = {
    kind: REVIEW_LINEAGE_ENFORCEMENT_DECISION_KIND,
    mode: input.mode,
    state: input.state,
    terminalReason: input.terminalReason,
  } as const;

  if (input.mode !== "enforce") {
    return {
      ...base,
      outcome: "not_enforced",
      completionDisposition: "unchanged",
      retryDisposition: "unchanged",
      terminal: TERMINAL_LINEAGE_STATES.has(input.state),
      requiresOperator: null,
      reason: "mode_not_enforced",
    };
  }

  if (!terminalReasonMatchesState(input.state, input.terminalReason)) {
    return {
      ...base,
      outcome: "invalid_state",
      completionDisposition: "block",
      retryDisposition: "forbidden",
      terminal: true,
      requiresOperator: true,
      reason: "invalid_state",
    };
  }

  switch (input.state) {
    case "reviewing_initial":
    case "correction_pending":
    case "reviewing_resolution":
      return {
        ...base,
        outcome: "review_pending",
        completionDisposition: "pending",
        retryDisposition: "not_applicable",
        terminal: false,
        requiresOperator: false,
        reason: "lineage_active",
      };
    case "passed":
      return {
        ...base,
        outcome: "completion_allowed",
        completionDisposition: "allow",
        retryDisposition: "not_applicable",
        terminal: true,
        requiresOperator: false,
        reason: "lineage_passed",
      };
    case "blocked_needs_operator":
      return {
        ...base,
        outcome: "blocked_needs_operator",
        completionDisposition: "block",
        retryDisposition: "forbidden",
        terminal: true,
        requiresOperator: true,
        reason: input.terminalReason ?? "invalid_state",
      };
    case "intent_conflict":
      return {
        ...base,
        outcome: "intent_conflict",
        completionDisposition: "block",
        retryDisposition: "forbidden",
        terminal: true,
        requiresOperator: true,
        reason: "intent_drift",
      };
    case "canceled":
      return {
        ...base,
        outcome: "canceled",
        completionDisposition: "block",
        retryDisposition: "forbidden",
        terminal: true,
        requiresOperator: false,
        reason: "operator_cancel",
      };
    default: {
      const neverState: never = input.state;
      return neverState;
    }
  }
}
