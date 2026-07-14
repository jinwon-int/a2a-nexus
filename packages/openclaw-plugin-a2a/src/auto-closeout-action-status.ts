/**
 * Auto-closeout action request status projection — operator-facing approval/status
 * for auto-closeout action requests (#406).
 *
 * Issue:  jinwon-int/plugin-a2a#406
 * Parent: jinwon-int/a2a-broker#844
 * Run:    a2a-team1-auto-closeout-action-reconcile-20260520T180955Z
 * Round:  3/4
 * Worker: workerBeta
 *
 * Distinguishes seven closeout action states used by operator-facing UX:
 *   pre-action: draft_ready, comment_only_ready, comment_and_close_requires_approval, blocked
 *   post-action: executed, noop, failed
 *
 * Preserves accepted-send-is-not-ACK semantics: provider API acceptance of the
 * closeout action (e.g. GitHub comment POST accepted 201) is projection-only
 * evidence, never operator-visible acknowledgment of the closeout.
 *
 * Source-only contract:
 *  - Pure projection — no live provider sends, no terminal ACK, no Gateway restart.
 *  - No GitHub API calls, no issue/PR mutations, no deploy, no production DB.
 *  - All states are deterministic projections; the caller decides what to emit.
 *
 * Safety gates:
 *  - Always projects `isAck: false` for provider-accepted evidence.
 *  - Fail-closed: invalid inputs project `failed` with an explicit error code.
 *  - Approval gating is preserved: action requests that bypass operator approval
 *    project as `blocked` with `closeFailed: true`.
 */

import type {
  A2ACloseoutCandidateEvaluation,
} from "./operator-closeout-trigger.js";

// ── Auto-closeout action states ──────────────────────────────────

/**
 * Status of an auto-closeout action request.
 *
 * These seven states cover the full lifecycle of an auto-closeout action
 * from initial evaluation through execution:
 *
 * Pre-action (from candidate evaluation):
 * - `draft_ready`: N/N closeout draft prepared, not yet posted.
 * - `comment_only_ready`: N/N comment ready, close handled separately.
 * - `comment_and_close_requires_approval`: N/N ready, close needs operator approval.
 * - `blocked`: closeout blocked (lane failure or approval bypass).
 *
 * Post-action (action result):
 * - `executed`: closeout action completed successfully (comment posted, issue closed
 *   as appropriate). Provider API accepted the request — this is projection-only
 *   evidence, never operator-visible ACK.
 * - `noop`: action was attempted but nothing needed to be done (e.g. all lanes
 *   already resolved, issue already closed, comment already posted).
 * - `failed`: the closeout action could not complete due to an error.
 */
export type A2AAutoCloseoutActionStatus =
  // Pre-action (candidate evaluation states — reference only)
  | "draft_ready"
  | "comment_only_ready"
  | "comment_and_close_requires_approval"
  | "blocked"
  // Post-action (action result states)
  | "executed"
  | "noop"
  | "failed";

/**
 * Category grouping for the status — used for operator-facing UX filters.
 */
export type A2AAutoCloseoutStatusCategory = "pre_action" | "action_complete" | "action_failed" | "blocked";
export function categorizeActionStatus(status: A2AAutoCloseoutActionStatus): A2AAutoCloseoutStatusCategory {
  switch (status) {
    case "draft_ready":
    case "comment_only_ready":
    case "comment_and_close_requires_approval":
      return "pre_action";
    case "executed":
    case "noop":
      return "action_complete";
    case "failed":
      return "action_failed";
    case "blocked":
      return "blocked";
  }
}

// ── Action result types ─────────────────────────────────────────

/**
 * Closeout action that was requested.
 */
export type A2ACloseoutActionKind =
  /** Post an N/N summary comment (no issue close). */
  | "comment"
  /** Post an N/N summary comment and close the issue. */
  | "comment_and_close"
  /** No action was needed — skip. */
  | "noop";

/**
 * Closeout action result — what actually happened when the action was taken.
 */
export type A2ACloseoutActionResult =
  /** Action completed successfully. Provider API accepted the request. This is
   * projection-only evidence; not operator-visible ACK. */
  | { outcome: "executed"; action: A2ACloseoutActionKind; evidenceUrl?: string }
  /** No action needed; nothing was done. */
  | { outcome: "noop"; action: "noop"; reason: string }
  /** Action failed. */
  | { outcome: "failed"; action: A2ACloseoutActionKind; errorCode: A2ACloseoutFailureCode; errorMessage: string };

/**
 * Failure codes for auto-closeout action failure.
 */
export type A2ACloseoutFailureCode =
  /** GitHub API returned an error. */
  | "github_api_error"
  /** Invalid state transition — e.g. trying to close when already closed. */
  | "invalid_transition"
  /** The closeout request was malformed or missing required fields. */
  | "invalid_request"
  /** Operator approval was required but not obtained. */
  | "approval_required"
  /** Approval was gated but the gate check failed. */
  | "approval_gate_denied"
  /** The target issue was not found or is inaccessible. */
  | "target_not_found"
  /** Internal error in the projection/action layer. */
  | "internal_error";

// ── Operator-facing status projection ───────────────────────────

/**
 * Operator-facing auto-closeout action status projection.
 *
 * Combines the closeout candidate evaluation state with the action result
 * (if any) into a single operator-visible projection.
 */
export type A2AAutoCloseoutStatusProjection = {
  /** Schema identifier. */
  schema: "a2a.auto-closeout.status-projection.v1";
  /** Schema version. */
  version: 1;
  /** Parent round identifier. */
  parentRoundId: string;
  /** The unified auto-closeout status. */
  status: A2AAutoCloseoutActionStatus;
  /** Category for UX grouping. */
  category: A2AAutoCloseoutStatusCategory;
  /** The action that was requested (if any). */
  action?: A2ACloseoutActionKind;
  /** The action result (present only for post-action states). */
  result?: A2ACloseoutActionResult;
  /** Human-readable summary. */
  summary: string;
  /** When the projection was produced (epoch ms). */
  projectedAt: number;
  /** Run identifier for traceability. */
  runId: string;

  // ── Non-ACK semantics ──────────────────────────────────────

  /**
   * Provider API acceptance is never operator-visible ACK.
   *
   * When an auto-closeout action is "executed", the provider (e.g. GitHub)
   * accepted the API request. This field documents that the acceptance is
   * transport-level evidence only — not operator acknowledgment of the
   * closeout.
   */
  acceptedSendIsNotAck: true;
  /** Whether this projection represents actual closeout confirmation. */
  isCloseoutAck: false;
  /**
   * When true, operator approval was required and the action was approved.
   * When false, approval was either not required or not obtained.
   */
  approvalGated: boolean;
  /** Whether operator approval was obtained before the action was taken. */
  approvalObtained: boolean;

  // ── Candidate evaluation reference ─────────────────────────

  /** The underlying closeout candidate evaluation (if available). */
  candidateEvaluation?: A2ACloseoutCandidateEvaluation;
};

// ── Projection input ────────────────────────────────────────────

/**
 * Input for building an auto-closeout action status projection.
 */
export type A2AAutoCloseoutStatusProjectionInput = {
  /** Parent round identifier. */
  parentRoundId: string;
  /** The closeout candidate evaluation result (pre-action evaluation). */
  candidateEvaluation?: A2ACloseoutCandidateEvaluation;
  /** The closeout action that was requested. */
  action?: A2ACloseoutActionKind;
  /** The action result (present when action was attempted). */
  result?: A2ACloseoutActionResult;
  /** Whether operator approval was required. */
  approvalRequired?: boolean;
  /** Whether operator approval was obtained. */
  approvalObtained?: boolean;
  /** Run identifier. */
  runId?: string;
  /** Clock override for testing. */
  now?: () => number;
};

// ── Projection logic ────────────────────────────────────────────

/**
 * Project the operator-facing auto-closeout action status from an input.
 *
 * Pure projection — no side effects, no live sends, no terminal ACK.
 * All inputs are deterministic; the projection is stateless.
 *
 * Status resolution rules:
 *
 * 1. If `result` is present, use it to determine the post-action status:
 *    - outcome === "executed" → status is "executed"
 *    - outcome === "noop"    → status is "noop"
 *    - outcome === "failed"  → status is "failed"
 *
 * 2. If no `result`, derive from the candidate evaluation state:
 *    - blocked              → status is "blocked"
 *    - draft_ready          → status is "draft_ready"
 *    - comment_only_ready   → status is "comment_only_ready"
 *    - comment_and_close_requires_approval → "comment_and_close_requires_approval"
 *    - waiting              → status is "draft_ready" (waiting resolved to draft-ready at the action-projection layer)
 *
 * 3. Approval gating:
 *    - If action is "comment_and_close" and approvalRequired is true but
 *      approvalObtained is false, the status is "blocked" with failure
 *      code "approval_required".
 *    - If action is "comment", approval is not required for the comment
 *      action itself (close still requires approval via candidate state).
 *
 * 4. Non-ACK semantics: the `acceptedSendIsNotAck` field is always `true`.
 *    Projected action outcomes are transport-level evidence only.
 *
 * @param input — Auto-closeout action request context.
 * @returns Operator-facing status projection.
 */
export function projectAutoCloseoutActionStatus(
  input: A2AAutoCloseoutStatusProjectionInput,
): A2AAutoCloseoutStatusProjection {
  const now = input.now ?? Date.now;
  const runId = input.runId ?? `auto-closeout-status-${now()}`;
  const projectedAt = now();

  const {
    parentRoundId,
    candidateEvaluation,
    action,
    result,
    approvalRequired,
    approvalObtained,
  } = input;

  // ── Approval gate check ─────────────────────────────────
  //
  // If the action is comment_and_close and approval was required but
  // not obtained, treat as blocked (fail-closed).
  if (
    action === "comment_and_close" &&
    approvalRequired === true &&
    approvalObtained !== true
  ) {
    const status: A2AAutoCloseoutActionStatus = "blocked";
    return {
      schema: "a2a.auto-closeout.status-projection.v1",
      version: 1,
      parentRoundId,
      status,
      category: categorizeActionStatus(status),
      action,
      result: {
        outcome: "failed",
        action: "comment_and_close",
        errorCode: "approval_required",
        errorMessage: "Operator approval is required before closeout action can proceed",
      },
      summary: `CLOSEOUT BLOCKED (approval gate): ${parentRoundId} — close action requires operator approval which was not obtained`,
      projectedAt,
      runId,
      acceptedSendIsNotAck: true,
      isCloseoutAck: false,
      approvalGated: approvalRequired === true,
      approvalObtained: false,
      candidateEvaluation,
    };
  }

  // ── Result-based: post-action states ─────────────────────
  if (result) {
    switch (result.outcome) {
      case "executed": {
        const status: A2AAutoCloseoutActionStatus = "executed";
        const urlFragment = result.evidenceUrl ? ` — evidence: ${result.evidenceUrl}` : "";
        return {
          schema: "a2a.auto-closeout.status-projection.v1",
          version: 1,
          parentRoundId,
          status,
          category: categorizeActionStatus(status),
          action: result.action,
          result,
          summary: `CLOSEOUT EXECUTED: ${result.action} for ${parentRoundId}${urlFragment}`,
          projectedAt,
          runId,
          acceptedSendIsNotAck: true,
          isCloseoutAck: false,
          approvalGated: approvalRequired === true,
          approvalObtained: approvalObtained === true,
          candidateEvaluation,
        };
      }
      case "noop": {
        const status: A2AAutoCloseoutActionStatus = "noop";
        return {
          schema: "a2a.auto-closeout.status-projection.v1",
          version: 1,
          parentRoundId,
          status,
          category: categorizeActionStatus(status),
          action: "noop",
          result,
          summary: `CLOSEOUT NOOP: ${parentRoundId} — ${result.reason}`,
          projectedAt,
          runId,
          acceptedSendIsNotAck: true,
          isCloseoutAck: false,
          approvalGated: approvalRequired === true,
          approvalObtained: approvalObtained === true,
          candidateEvaluation,
        };
      }
      case "failed": {
        const status: A2AAutoCloseoutActionStatus = "failed";
        return {
          schema: "a2a.auto-closeout.status-projection.v1",
          version: 1,
          parentRoundId,
          status,
          category: categorizeActionStatus(status),
          action: result.action,
          result,
          summary: `CLOSEOUT FAILED: ${result.action} for ${parentRoundId} — ${result.errorCode}: ${result.errorMessage}`,
          projectedAt,
          runId,
          acceptedSendIsNotAck: true,
          isCloseoutAck: false,
          approvalGated: approvalRequired === true,
          approvalObtained: approvalObtained === true,
          candidateEvaluation,
        };
      }
    }
  }

  // ── Evaluation-based: pre-action states ───────────────────
  const candidateState = candidateEvaluation?.state;
  let status: A2AAutoCloseoutActionStatus;

  switch (candidateState) {
    case "blocked":
      status = "blocked";
      break;
    case "waiting":
      // At the action-projection layer, "waiting" is still actionable
      // but no action can be taken yet. Map to draft_ready.
      status = "draft_ready";
      break;
    case "draft_ready":
      status = "draft_ready";
      break;
    case "comment_only_ready":
      status = "comment_only_ready";
      break;
    case "comment_and_close_requires_approval":
      status = "comment_and_close_requires_approval";
      break;
    default:
      // No candidate evaluation → no action yet → draft_ready
      status = "draft_ready";
      break;
  }

  const candidateSummary = candidateEvaluation?.summary ?? `No evaluation available for ${parentRoundId}`;

  return {
    schema: "a2a.auto-closeout.status-projection.v1",
    version: 1,
    parentRoundId,
    status,
    category: categorizeActionStatus(status),
    action,
    summary: `CLOSEOUT ${status.toUpperCase().replace(/_/g, " ")}: ${candidateSummary}`,
    projectedAt,
    runId,
    acceptedSendIsNotAck: true,
    isCloseoutAck: false,
    approvalGated: approvalRequired === true,
    approvalObtained: approvalObtained === true,
    candidateEvaluation,
  };
}

// ── Status formatting for operator display ───────────────────────

/**
 * Format an auto-closeout status projection into a human-readable Terminal Brief line.
 *
 * @param projection — The status projection to format.
 * @returns A single-line string suitable for operator display.
 */
export function formatAutoCloseoutStatusForTerminalBrief(
  projection: A2AAutoCloseoutStatusProjection,
): string {
  const statusLabel = formatStatusLabel(projection.status);
  const actionLabel = projection.action ?? "none";
  const line = [
    `[Auto-Closeout: ${statusLabel}]`,
    `${projection.parentRoundId}`,
    `action: ${actionLabel}`,
    projection.acceptedSendIsNotAck ? "non-ACK" : "",
    projection.approvalGated && projection.approvalObtained ? "approved" : "",
    projection.approvalGated && !projection.approvalObtained ? "pending-approval" : "",
  ]
    .filter(Boolean)
    .join(" — ");

  return line;
}

function formatStatusLabel(status: A2AAutoCloseoutActionStatus): string {
  switch (status) {
    case "draft_ready": return "DRAFT READY";
    case "comment_only_ready": return "COMMENT READY";
    case "comment_and_close_requires_approval": return "APPROVAL REQUIRED";
    case "blocked": return "BLOCKED";
    case "executed": return "EXECUTED";
    case "noop": return "NO-OP";
    case "failed": return "FAILED";
  }
}
