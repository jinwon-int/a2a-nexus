// A2A/A2AD execution-policy evaluator (#555).
//
// The intent router (a2a-intent-router.ts) detects when a request must run on the
// A2A/A2AD execution lane. This module turns that signal into a fail-closed
// authorization decision for repo/GitHub write actions: in an `a2a_required`
// context, a direct write is allowed only when it is backed by a finalizer
// decision that explicitly authorizes the requested action and carries the
// required round provenance.
//
// This is pure decision logic with no I/O. Wiring it in front of the actual
// gh/GitHub-API and repo-patch call sites (so unauthorized writes are physically
// blocked) is tracked separately, because that step changes the behavior of live
// write paths.

import { routeA2AIntent, type A2AIntentRouterInput } from "./a2a-intent-router.js";

/** Repo/GitHub write actions that an A2A/A2AD execution context must gate. */
export const A2A_GUARDED_ACTIONS = [
  "repo_patch",
  "pr_create",
  "pr_merge",
  "issue_close",
  "issue_closeout_comment",
] as const;

export type A2AGuardedAction = (typeof A2A_GUARDED_ACTIONS)[number];

/** Execution lanes a finalizer decision may declare. "direct" is not a lane. */
export const A2A_EXECUTION_LANES = ["a2a", "a2ad"] as const;

export type A2AExecutionLane = (typeof A2A_EXECUTION_LANES)[number];

/**
 * Provenance that a finalizer decision must carry to authorize a guarded action.
 * Mirrors the provenance schema required by #555.
 */
export interface A2AFinalizerDecision {
  finalizerDecisionId: string;
  finalizerOwner: string;
  parentRoundId: string;
  brokerOfRecordId: string;
  executionLane: A2AExecutionLane;
  /** Guarded actions this decision explicitly authorizes. Empty = authorize nothing. */
  allowedActions: readonly A2AGuardedAction[];
  /** Worker evidence ids that substantively back this decision. */
  workerEvidenceIds?: readonly string[];
}

export interface A2AExecutionPolicyInput {
  /** The originating request text or structured intent-router input. */
  intent: string | A2AIntentRouterInput;
  /** The guarded write action the caller wants to perform. */
  requestedAction: A2AGuardedAction;
  /** Finalizer decision backing the action, if any. */
  finalizerDecision?: A2AFinalizerDecision;
  /**
   * Evidence ids that are wrapper-only / source-blocked and therefore must not
   * count as substantive worker evidence.
   */
  wrapperOnlyEvidenceIds?: readonly string[];
}

export interface A2AExecutionPolicyResult {
  allowed: boolean;
  executionContext: "none" | "a2a_required";
  /** Machine-readable blocker codes; empty when allowed. */
  blockers: string[];
}

const REQUIRED_PROVENANCE_FIELDS = [
  "finalizerDecisionId",
  "finalizerOwner",
  "parentRoundId",
  "brokerOfRecordId",
] as const;

const A2A_EXECUTION_LANE_SET: ReadonlySet<string> = new Set(A2A_EXECUTION_LANES);

/** A non-empty trimmed string id, or undefined for any other value. */
function normalizeEvidenceId(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * Decide whether a guarded write action may proceed. Fails closed: when the
 * intent routes to `a2a_required`, the action is denied unless a finalizer
 * decision authorizes exactly that action with complete round provenance and
 * (when the lane requires it) substantive worker evidence. Non-A2A contexts are
 * allowed — this gate constrains the A2A lane, it does not govern ordinary work.
 */
export function evaluateA2AExecutionPolicy(input: A2AExecutionPolicyInput): A2AExecutionPolicyResult {
  const routed = routeA2AIntent(input.intent);

  if (routed.executionContext !== "a2a_required") {
    return { allowed: true, executionContext: "none", blockers: [] };
  }

  const blockers: string[] = [];
  const decision = input.finalizerDecision;

  if (!decision) {
    blockers.push("a2a_required_action_without_finalizer_decision");
    return { allowed: false, executionContext: "a2a_required", blockers };
  }

  for (const field of REQUIRED_PROVENANCE_FIELDS) {
    const value = decision[field];
    if (typeof value !== "string" || value.trim().length === 0) {
      blockers.push(`missing_finalizer_provenance:${field}`);
    }
  }

  // executionLane must be a real A2A/A2AD lane, not merely a non-empty string,
  // so a decision claiming e.g. "direct" cannot authorize an A2A-required write.
  if (typeof decision.executionLane !== "string" || !A2A_EXECUTION_LANE_SET.has(decision.executionLane)) {
    blockers.push("invalid_finalizer_provenance:executionLane");
  }

  // Fail closed on malformed shapes rather than throwing, since the evaluator may
  // be fed runtime JSON at the wiring step.
  if (!Array.isArray(decision.allowedActions) || !decision.allowedActions.includes(input.requestedAction)) {
    blockers.push(`action_not_in_allowed_actions:${input.requestedAction}`);
  }

  if (routed.requiresWorkerEvidence) {
    const wrapperOnly = new Set(
      (Array.isArray(input.wrapperOnlyEvidenceIds) ? input.wrapperOnlyEvidenceIds : [])
        .map(normalizeEvidenceId)
        .filter((id): id is string => id !== undefined),
    );
    const substantive = (Array.isArray(decision.workerEvidenceIds) ? decision.workerEvidenceIds : [])
      .map(normalizeEvidenceId)
      .filter((id): id is string => id !== undefined && !wrapperOnly.has(id));
    if (substantive.length === 0) {
      blockers.push("no_substantive_worker_evidence");
    }
  }

  return { allowed: blockers.length === 0, executionContext: "a2a_required", blockers };
}

/** Thrown by runGuardedGitHubAction when the execution policy denies a guarded write. */
export class A2AExecutionPolicyDenied extends Error {
  readonly requestedAction: A2AGuardedAction;
  readonly blockers: string[];
  constructor(requestedAction: A2AGuardedAction, blockers: string[]) {
    super(`a2a_execution_policy_denied: ${requestedAction} blocked (${blockers.join(", ") || "no reason"})`);
    this.name = "A2AExecutionPolicyDenied";
    this.requestedAction = requestedAction;
    this.blockers = blockers;
  }
}

/**
 * Run a guarded repo/GitHub write action only if the A2A execution policy allows
 * it (#555 item 4). Fails closed: when the policy denies the action, the `action`
 * thunk is NOT invoked and {@link A2AExecutionPolicyDenied} is thrown with the
 * blocker codes; when allowed, the action runs and its result is returned.
 *
 * This is the gating primitive callers wrap around a `gh`/GitHub-API or repo-patch
 * operation. Adding the primitive changes no existing call site — wiring it in
 * front of a specific live write path is a separate, behavior-changing step.
 */
export async function runGuardedGitHubAction<T>(
  input: A2AExecutionPolicyInput,
  action: () => T | Promise<T>,
): Promise<T> {
  const decision = evaluateA2AExecutionPolicy(input);
  if (!decision.allowed) {
    throw new A2AExecutionPolicyDenied(input.requestedAction, decision.blockers);
  }
  return action();
}
